import { buildSystemPrompt } from './protocol/system-prompt.js';
import { parseModelOutput } from './protocol/parser.js';
import { renderToolResult } from './protocol/tool-result.js';
import { newMessagesSince } from './session/manager.js';
import { openDefaultSessionStore } from './session/store.js';
import { prefixHashStrategy } from './session/strategy.js';
import { buildCompactPrompt, totalTokens } from './compaction/index.js';
const FENCE_OPEN = '```tool_call';
const FIX_HINT = '格式不正确。请严格按协议重新输出一个 ```tool_call 代码块，内含一个合法 JSON 对象：{"tool":"<工具名>","arguments":{...}}。';
export class FormatGiveUpError extends Error {
    constructor() { super('format_give_up: 模型连续输出无法解析的工具调用'); this.name = 'FormatGiveUpError'; }
}
/**
 * 新会话 key 首次出现（首轮或进程重启后的续轮）时，assistant 消息是模型自己的回复、
 * DeepSeek 网页会话里必然已存在，视作已发送；无 assistant 则从头发送。
 * 有 entry 时以 entry.sentCount 为准（正常单进程流）。
 */
function initialSentCount(messages) {
    return messages.map(m => m.role).lastIndexOf('assistant') + 1;
}
/**
 * sentCount 钳制：OpenCode 历史回退/取消时持久化 sentCount 可能超过当前 messages 长度，
 * 裸 slice 会得空 delta（整轮只发 system prompt → 垃圾回答）。钳到最后一条 user 消息下标，
 * 保证 delta 至少包含触发本轮的那条 user 消息（N3）。
 */
export function clampSentCount(stored, messages) {
    const lastUser = messages.map(m => m.role).lastIndexOf('user');
    return Math.min(stored, lastUser < 0 ? messages.length : lastUser);
}
/** tool_call_id → 工具名：从历史 assistant.tool_calls 建表，渲染工具结果时报真名（T6①） */
function toolNameMap(messages) {
    const names = new Map();
    for (const m of messages) {
        if (m.role === 'assistant' && m.tool_calls) {
            for (const tc of m.tool_calls)
                if (tc.function?.name)
                    names.set(tc.id, tc.function.name);
        }
    }
    return names;
}
/** delta 只取 user/tool 消息：assistant 的历史动作网页会话里模型自己已见过 */
function buildPrompt(delta, tools, withFixHint, toolMaxChars, toolNames) {
    const sys = buildSystemPrompt(tools);
    const parts = [sys];
    for (const m of delta) {
        if (m.role === 'tool') {
            const name = toolNames.get(m.tool_call_id ?? '') ?? m.tool_call_id ?? 'unknown';
            parts.push(renderToolResult(name, m.content, toolMaxChars));
        }
        else
            parts.push(`[${m.role}] ${m.content}`);
    }
    if (withFixHint)
        parts.push(FIX_HINT);
    return parts.join('\n\n');
}
/**
 * 只取 delta 中**最后一条 user 消息**携带的图片。
 *
 * v1 边界（sir 2026-10-24 拍板）：历史轮次的图片不重传。DeepSeek 网页会话自身已持有
 * 那些附件，重传只会反复堆附件并撞上未知的上游上限，且没有任何正确性收益。
 *
 * 取 `delta` 而非全量 `messages`：`delta` 已经是「本轮真正要发出去的新内容」，
 * 压缩（compaction）路径下 delta 会被替换成一条无图的摘要消息，于是自然返回
 * `undefined` —— 摘要不看图，符合预期，不需要额外分支。
 */
export function currentTurnImages(delta) {
    for (let i = delta.length - 1; i >= 0; i--) {
        const m = delta[i];
        if (m.role === 'user') {
            return m.images && m.images.length > 0 ? m.images : undefined;
        }
    }
    return undefined;
}
export async function runAgentTurn(opts) {
    const { messages, tools, transport, config } = opts;
    const deps = opts.deps ?? {};
    const keyStrategy = deps.keyStrategy ?? prefixHashStrategy;
    const key = keyStrategy(messages);
    const sessions = deps.store ?? openDefaultSessionStore();
    /**
     * compaction 阈值优先级（**不要**改成读 transport.getCapabilities().maxContextTokens）：
     *   1. deps.threshold        —— 复用方显式注入，最高优先
     *   2. COMPACT_THRESHOLD env —— 由 loadConfig 读入 config.compactTokenThreshold
     *   3. config 的默认值 40000  —— v0.1 起未变，行为基线
     *
     * 为什么不接 maxContextTokens：那是「模型宣称能吃多少」的**能力信息**，
     * 由外部知识填写、未经本地实测，且是估算口径的上限而非安全余量。
     * 若用它当阈值（本项目曾计划如此），触发点会从 4 万推到 6.4 万；
     * 一旦真实网页版上下文墙低于 64000，就会在撞墙前**不再 compaction、直接溢出**——
     * 那是行为回归，不是重构。maxContextTokens 仅作为对外暴露的能力信息供第三方参考。
     */
    const threshold = deps.threshold ?? config.compactTokenThreshold;
    const stored = sessions.get(key) ?? { chatSessionId: null, sentCount: initialSentCount(messages) };
    const entry = { chatSessionId: stored.chatSessionId, sentCount: clampSentCount(stored.sentCount, messages) };
    const delta = newMessagesSince(messages, entry.sentCount)
        .filter(m => m.role === 'user' || m.role === 'tool');
    let sendDelta = delta;
    if (delta.length > 0 && totalTokens(messages) > threshold) {
        await transport.newChat();
        let summary = '';
        for await (const c of transport.generate({
            prompt: buildCompactPrompt(messages),
            thinking: false,
            timeoutMs: config.timeoutMs,
        })) {
            if (c.content)
                summary += c.content;
        }
        sendDelta = [{ role: 'user', content: `【进展摘要】${summary}\n请在此基础上继续完成原任务。` }];
        sessions.set(key, { chatSessionId: null, sentCount: clampSentCount(0, sendDelta) });
    }
    let content = '', reasoning = '', usageTokens = 0;
    for (let attempt = 0; attempt <= config.maxFormatRetries; attempt++) {
        content = '';
        reasoning = '';
        const iter = transport.generate({
            prompt: buildPrompt(sendDelta, tools, attempt > 0, config.toolResultMaxChars, toolNameMap(messages)),
            thinking: config.thinking,
            timeoutMs: config.thinking ? config.thinkingTimeoutMs : config.timeoutMs,
            images: currentTurnImages(sendDelta),
        });
        for await (const chunk of iter) {
            if (chunk.reasoning)
                reasoning += chunk.reasoning;
            if (chunk.content)
                content += chunk.content;
            usageTokens += Math.ceil(((chunk.reasoning ?? '') + (chunk.content ?? '')).length / 2);
        }
        const parsed = parseModelOutput(content, tools);
        if (parsed.kind === 'tool_call') {
            const tc = { id: `call_${Date.now().toString(36)}`, name: parsed.tool, arguments: parsed.arguments };
            sessions.set(key, { chatSessionId: transport.lastChatSessionId(), sentCount: messages.length });
            const visible = content.replace(parsed.raw, '').trim();
            return { content: visible || '（调用工具）', reasoning, toolCall: tc, usageTokens };
        }
        if (!content.includes(FENCE_OPEN)) {
            sessions.set(key, { chatSessionId: transport.lastChatSessionId(), sentCount: messages.length });
            return { content, reasoning, usageTokens };
        }
        if (attempt === config.maxFormatRetries)
            break;
    }
    throw new FormatGiveUpError();
}
