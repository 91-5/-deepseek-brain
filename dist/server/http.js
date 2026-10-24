import http from 'node:http';
import { runAgentTurn } from '../core/planner.js';
import { prepareContent, UnsupportedImageSourceError } from './multimodal.js';
/**
 * OpenAI 请求体 → 内部形态。
 *
 * 多模态处理交给 `multimodal.ts`：`content` 为 part 数组时拆成「纯文本 + 图片绝对路径」，
 * 纯字符串路径行为与改造前完全一致（回归由 A5 守护）。
 *
 * **任何一步抛错都要先清理已写出的临时文件再抛**——否则前面几条消息的图片目录会变成
 * 孤儿文件（A11 验收项盯的就是这个）。
 */
function toInternal(req) {
    const cleanups = [];
    const runCleanups = () => {
        for (const c of cleanups)
            c();
    };
    try {
        const messages = req.messages.map(m => {
            const prepared = prepareContent(m.content);
            if (prepared.images.length > 0)
                cleanups.push(prepared.cleanup);
            return {
                role: m.role,
                content: prepared.text,
                ...(prepared.images.length > 0 ? { images: prepared.images } : {}),
                tool_call_id: m.tool_call_id,
                tool_calls: m.tool_calls,
            };
        });
        const tools = (req.tools ?? []).map(t => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
        }));
        return { messages, tools, cleanup: runCleanups };
    }
    catch (e) {
        runCleanups();
        throw e;
    }
}
// transport 由 index.ts 注入（避免循环依赖）
let transportGetter = () => { throw new Error('transport not initialized'); };
export function setTransportGetter(fn) { transportGetter = fn; }
export function createHttpServer(config) {
    return http.createServer(async (req, res) => {
        // 客户端断连（OpenCode 取消/切会话）时 write 会 EPIPE、body 读取会报错——无监听会炸整个进程
        res.on('error', () => { });
        req.on('error', () => { });
        const url = new URL(req.url ?? '/', 'http://localhost');
        /**
         * 只读探针。**绝不能触发 Chrome 懒启动**：探活的调用方（OpenCode、重启脚本、
         * 用户自己 curl）不该把浏览器从被子里拽出来——那正是 Task 6 懒启动的要点。
         * transport.health() 自己在 page 为 null 时直接返回 bridge_idle，
         * 不经过 startBridge()/start()，所以这里只做转发，不补任何 start 调用。
         * transport 还没注入（getter 抛错）同样降级成 bridge_idle：
         * 「还没准备好」是正常状态，不该变成 500 让探针误判服务已挂，
         * 更不该报成 login_required——那是账号状态的断言，探针无权下这个结论。
         */
        if (req.method === 'GET' && url.pathname === '/health') {
            let health;
            try {
                health = await transportGetter().health();
            }
            catch {
                health = { status: 'bridge_idle', loggedIn: false };
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(health));
            return;
        }
        if (req.method === 'GET' && url.pathname === '/v1/models') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-web-brain', object: 'model', created: 0, owned_by: 'deepseek-brain' }] }));
            return;
        }
        if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'not found' } }));
            return;
        }
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', async () => {
            let parsed;
            try {
                parsed = JSON.parse(body);
            }
            catch {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'invalid json' } }));
                return;
            }
            let cleanup = () => { };
            try {
                const internal = toInternal(parsed);
                cleanup = internal.cleanup;
                const { messages, tools } = internal;
                const result = await runAgentTurn({ messages, tools, transport: transportGetter(), config });
                const id = `chatcmpl-${Date.now().toString(36)}`;
                const created = Math.floor(Date.now() / 1000);
                const toolCalls = result.toolCall
                    ? [{ id: result.toolCall.id, type: 'function', function: { name: result.toolCall.name, arguments: JSON.stringify(result.toolCall.arguments) } }]
                    : undefined;
                if (parsed.stream) {
                    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
                    const send = (delta, finish) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: parsed.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
                    if (result.reasoning)
                        send({ reasoning_content: result.reasoning }, null);
                    send({ content: result.content }, null);
                    if (toolCalls) {
                        send({ tool_calls: [{ index: 0, ...toolCalls[0] }] }, null);
                        send({}, 'tool_calls');
                    }
                    else {
                        send({}, 'stop');
                    }
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }
                const resp = {
                    id, object: 'chat.completion', created, model: parsed.model,
                    choices: [{
                            index: 0,
                            message: { role: 'assistant', content: result.content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
                            finish_reason: toolCalls ? 'tool_calls' : 'stop',
                        }],
                    usage: { total_tokens: result.usageTokens },
                };
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(resp));
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                if (res.headersSent) {
                    res.end();
                    return;
                } // 流式已发 200 后出错：断流比 ERR_HTTP_HEADERS_SENT 炸进程好（N2）
                /**
                 * 状态码分流：
                 * - UnsupportedImageSourceError → **400**：客户端给的请求体本身不对（非 data URI 等），
                 *   重试同一请求不会有不同结果，用 502 会让客户端误判成服务抖动而盲目重试。
                 * - 其余 → **502**：浏览器/上游失败（沿用改造前行为，零回归）。
                 */
                const status = e instanceof UnsupportedImageSourceError ? 400 : 502;
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: { message: msg } }));
            }
            finally {
                cleanup();
            }
        });
    });
}
