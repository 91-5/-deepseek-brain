import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { judgeLoginState, CHAT_INPUT_SELECTOR } from './login-state.js';
import { profileSeeded } from './lazy-start.js';
import { DEFAULT_SESSIONS_FILE, loadSessionSnapshot, saveSessionSnapshot, } from '../core/session/store.js';
import { resolveChromeExecutable, chromeNotFoundMessage, chromeCandidates } from './chrome-detect.js';
const CHAT_URL = 'https://chat.deepseek.com/';
const SESSION_URL_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROGRESS_LOG_MS = 30000;
/** teardown 时 browser.close() 的上限：超过就放弃 close，直接 taskkill 杀树 */
const CLOSE_TIMEOUT_MS = 3000;
/** /health 的 error 字段长度上限，见 clipForHealth */
const HEALTH_ERROR_MAX = 200;
/**
 * 把失败原因裁到 /health 能安全回显的长度。
 *
 * 失败原因里可能带本地路径、选择器名、甚至带查询串的 URL，而 `/health` 是
 * **无认证**的本地探针——完整回显等于把内部结构信息摊给任何能连上这个端口的人。
 * 评审（COND-3）把这条判为非阻塞，因为只监听 127.0.0.1；这里做的是把
 * 「非阻塞」变成「默认就截断」，而不是依赖部署细节。
 *
 * **只在出口裁**：`lastStartError` 本身保留全文，本地日志与排障不受影响。
 * 内存里留全文、对外给摘要——两者需求不同，不该共用一个变量。
 *
 * **将来若要把裁剪后的值写回，请另建一个 `healthErrorView` 变量，不要污染
 * `lastStartError`。**（评审 COND-2 的提醒）当前设计没有反噬路径，但那是因为
 * `clipForHealth` 是模块私有函数、只被 `idle()` 读、`lastStartError` 只被
 * `startBridge()` 写——这是**当前代码的巧合，不是防御性设计**：哪天有人顺手
 * 把裁剪值赋回去，或某条日志路径改读 `lastStartError`，本地日志就会静默变成
 * 截断后的摘要，排障时看到的就不再是真实原因。独立变量能让这种误用在类型上
 * 就暴露出来，而不是靠 review 抓住。
 */
function clipForHealth(message) {
    if (message.length <= HEALTH_ERROR_MAX)
        return message;
    const dropped = message.length - HEALTH_ERROR_MAX;
    return `${message.slice(0, HEALTH_ERROR_MAX)}…(+${dropped} chars)`;
}
/** 页内探针：包裹 XHR，捕获 /chat/completion 的 body 与流式 responseText。
 *  幂等：重复注入（整页刷新后 framenavigated 重注）不会双重包裹
 *
 *  export 只是为了让测试能在沙箱里跑**这段真实脚本**；不影响页面侧语义。*/
export const PROBE = `(() => {
  if (window.__probeInstalled) return 'probe-ok'
  window.__probeInstalled = true;
  window.__comp = window.__comp || [];
  const oOpen = XMLHttpRequest.prototype.open;
  const oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m, u, ...r) { this.__u = u; return oOpen.call(this, m, u, ...r); };
  XMLHttpRequest.prototype.send = function(b, ...r) {
    try {
      if (/completion/.test(this.__u || '')) {
        const entry = { url: this.__u, body: b, t0: Date.now(), status: null, resp: '', done: false };
        window.__comp.push(entry);
        // 增量累积：progress 给的是 responseText 全量快照，逐次整份复制是 O(n^2)。
        // startsWith 守卫不可省：重定向/重试时 responseText 可能整体换掉，
        // 无守卫的 slice(prev.length) 会切出中段并追加进已累积正文（脏数据）。
        // 语义等价于 src/transports/tail.ts 的 appendTail。
        const merge = function(prev, next) {
          return (next.length > prev.length && next.startsWith(prev)) ? prev + next.slice(prev.length) : next;
        };
        this.addEventListener('progress', () => { entry.resp = merge(entry.resp, this.responseText); });
        this.addEventListener('loadend', () => { entry.status = this.status; entry.done = true; entry.resp = merge(entry.resp, this.responseText); });
      }
    } catch (e) {}
    return oSend.call(this, b, ...r);
  };
  return 'probe-ok';
})()`;
/**
 * 从持久化快照里挑可续接的 DeepSeek 会话：仅当**恰好一个**可用条目时才深链恢复。
 * 多会话并存时返回 null——v0.1 单 brain 假设，宁可开新会话（delta 自带上下文）
 * 也不把 A 会话的轮次打进 B 会话的网页聊天造成串台。
 */
export function pickResumeEntry(snapshot) {
    let best = null;
    for (const [key, rec] of Object.entries(snapshot)) {
        const chatSessionId = sanitizeChatSessionId(rec?.chatSessionId);
        if (!chatSessionId)
            continue;
        if (best)
            return null;
        best = { key, chatSessionId, sentCount: rec.sentCount };
    }
    return best;
}
/** 纯函数：__comp 长度超过发送前基线 → 新请求下标（= preLen）；否则 -1（尚未捕获到请求）。
 *  防止点击未触发请求时误读上一轮已完成 entry（会静默返回旧答案并屏蔽 no_request 检测） */
export function resolveEntryIndex(currentLen, preLen) {
    return currentLen > preLen ? preLen : -1;
}
/** done 后的状态判定：HTTP≥400 或 status===0（网络中止时 loadend 也置 done）→ 传输错误 */
export function completionError(status) {
    if (status === null)
        return null;
    if (status === 0)
        return 'transport_error: completion aborted (network interrupted)';
    if (status >= 400)
        return `transport_error: completion HTTP ${status}${status === 401 || status === 403 ? ' (login expired?)' : ''}`;
    return null;
}
/** connect 重试：Chrome 冷启动可能超过固定 sleep，最多 attempts 次、间隔 delayMs（T8①） */
export async function retryConnect(fn, attempts = 15, delayMs = 1000) {
    let lastErr = new Error('retryConnect: no attempts');
    for (let i = 0; i < attempts; i++) {
        try {
            return await fn();
        }
        catch (e) {
            lastErr = e;
            if (i < attempts - 1)
                await sleep(delayMs);
        }
    }
    throw lastErr;
}
export function chatUrlFor(chatSessionId) {
    return `https://chat.deepseek.com/a/chat/s/${chatSessionId}`;
}
/** 只有形如 UUID 的 chatSessionId 才允许拼进 URL（防路径/查询注入） */
export function sanitizeChatSessionId(v) {
    return typeof v === 'string' && SESSION_URL_RE.test(v) ? v : null;
}
/** 纯函数：有可续接会话 → 深链；否则首页。无浏览器即可单测 */
export function resolveStartUrl(entry) {
    return entry ? chatUrlFor(entry.chatSessionId) : CHAT_URL;
}
/**
 * DeepSeek 网页 SSE 分流（协议实测修订，2026-09-30 首跑抓包）：
 * - JSON-Patch 增量流：带 p/o 的行是操作，**无 p/o 的行是上一个 content 路径的延续**（只有 v）
 * - `response/fragments` 的数组快照出现 type="RESPONSE" 的 fragment 是思考→答案的判别标志
 * - elapsed_secs（字符串!/status/usage BATCH 都是元数据，不进正文
 * - 答案 fragment 创建时的 content 快照是前缀，后续 -1/content 增量接续（去重防叠字）
 */
export function bucketSSE(sse) {
    let reasoning = '', content = '';
    let lastPath = '';
    let inAnswer = false;
    let answerSeed = '';
    for (const line of sse.split('\n')) {
        if (!line.startsWith('data:'))
            continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]')
            continue;
        let obj;
        try {
            obj = JSON.parse(payload);
        }
        catch {
            continue;
        }
        const hasOp = obj.p !== undefined || obj.o !== undefined;
        if (hasOp)
            lastPath = String(obj.p ?? '');
        if (hasOp && lastPath === 'response/fragments') {
            // 数组快照：{"id":3,"type":"RESPONSE","content":"我是"} —— 答案 fragment 诞生（v 可能是原生数组或 JSON 字符串）
            let arr = obj.v;
            if (typeof arr === 'string') {
                try {
                    arr = JSON.parse(arr);
                }
                catch {
                    arr = null;
                }
            }
            if (Array.isArray(arr)) {
                const resp = arr.filter(f => f?.type === 'RESPONSE').at(-1);
                if (resp) {
                    inAnswer = true;
                    answerSeed = resp.content ?? '';
                }
            }
            continue;
        }
        if (!/\/content$/.test(lastPath))
            continue; // elapsed_secs/status/response(BATCH usage) 等元数据
        if (typeof obj.v !== 'string')
            continue;
        if (inAnswer)
            content += obj.v;
        else
            reasoning += obj.v;
    }
    if (inAnswer && answerSeed && !content.startsWith(answerSeed))
        content = answerSeed + content;
    return { reasoning, content };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
/**
 * debug 级输出闸门：LOG_LEVEL=debug（CLI --verbose）才打。
 *
 * 刻意只有一个函数、只有一层判断——不给这个项目造日志框架。
 * 挂上来的都是「每次尝试都打一遍」的恢复诊断；状态变更的解释
 * （DOM 快照、丢弃过期会话条目等）仍留在 info，默认输出一行未减。
 */
export function debugLog(level, ...args) {
    if (level === 'debug')
        console.log(...args);
}
export function createSseCursor() {
    return {
        offset: 0,
        lastLine: '',
        committed: { reasoning: '', content: '', lastPath: '', inAnswer: false, answerSeed: '' },
        reasoning: '',
        content: '',
    };
}
/** 单行解析：把一条 SSE 行应用到 state 上（与 bucketSSE 内联逻辑逐字对应）。 */
function applyLine(line, s) {
    if (!line.startsWith('data:'))
        return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]')
        return;
    let obj;
    try {
        obj = JSON.parse(payload);
    }
    catch {
        return;
    }
    const hasOp = obj.p !== undefined || obj.o !== undefined;
    if (hasOp)
        s.lastPath = String(obj.p ?? '');
    if (hasOp && s.lastPath === 'response/fragments') {
        let arr = obj.v;
        if (typeof arr === 'string') {
            try {
                arr = JSON.parse(arr);
            }
            catch {
                arr = null;
            }
        }
        if (Array.isArray(arr)) {
            const resp = arr.filter(f => f?.type === 'RESPONSE').at(-1);
            if (resp) {
                s.inAnswer = true;
                s.answerSeed = resp.content ?? '';
            }
        }
        return;
    }
    if (!/\/content$/.test(s.lastPath))
        return;
    if (typeof obj.v !== 'string')
        return;
    if (s.inAnswer)
        s.content += obj.v;
    else
        s.reasoning += obj.v;
}
function seedFix(s) {
    const content = (s.inAnswer && s.answerSeed && !s.content.startsWith(s.answerSeed))
        ? s.answerSeed + s.content : s.content;
    return { reasoning: s.reasoning, content };
}
export function feedSse(cursor, full) {
    // 非前缀延伸 → 整体重解析。比对「上一条提交的整行」而不是整份前缀：
    // O(行长) 而非 O(全长)，重定向/重试会同时改掉这条行，足以识别。
    if (cursor.offset > full.length
        || (cursor.offset > 0 && full.slice(cursor.offset - cursor.lastLine.length, cursor.offset) !== cursor.lastLine)) {
        cursor.offset = 0;
        cursor.lastLine = '';
        cursor.committed = { reasoning: '', content: '', lastPath: '', inAnswer: false, answerSeed: '' };
    }
    const rest = full.slice(cursor.offset);
    const parts = rest.split('\n');
    const tail = parts.pop() ?? ''; // 未见 \n 的半行
    for (const line of parts) {
        if (line === '')
            continue;
        applyLine(line, cursor.committed);
        cursor.lastLine = line;
        cursor.offset += line.length + 1;
    }
    // 半行暂解析到副本上：结果进视图，但不写回 committed（下一拍它会更完整）。
    const viewState = { ...cursor.committed };
    if (tail !== '')
        applyLine(tail, viewState);
    const v = seedFix(viewState);
    cursor.reasoning = v.reasoning;
    cursor.content = v.content;
    return v;
}
const SELECTORS_PATH = fileURLToPath(new URL('../../selectors.json', import.meta.url));
/**
 * 附件相关选择器的内置默认值。
 *
 * 为什么给默认值而不是把新键设成必填：`selectors.json` 是**用户可改**的文件
 * （DOM 改版时的唯一逃生口，README 明确让用户改它）。已发布的旧配置里没有
 * `fileInput` / `imagePreview`，若设成必填会因为缺键直接崩在启动路径上——
 * 这会把「加个可选功能」变成「旧用户升级即坏」。
 * 2026-10-24 真机实测这两个选择器有效，缺键走默认即是最优路径。
 */
const DEFAULT_FILE_INPUT = 'input[type="file"]';
const DEFAULT_IMAGE_PREVIEW = 'img[src^="blob:"]';
/** 上传后等待附件预览出现的上限。实测 500ms 内完成，给足余量覆盖大图/慢网络。 */
const UPLOAD_TIMEOUT_MS = 15000;
let selectorsCache = null;
/** 界面语言兜底：selectors.json 的 newChat 不命中时依次尝试（2026-09-30 实测中文界面按钮文案为「开启新对话」） */
export const NEW_CHAT_FALLBACKS = ['::-p-text(开启新对话)', '::-p-text(New chat)'];
/** 从 ::-p-text(X) 选择器提取裸文本；非 p-text 选择器返回 null */
export function textFromPTextSelector(sel) {
    const m = sel.match(/^::-p-text\((.*)\)$/);
    return m ? m[1] : null;
}
function readSelectors() {
    if (!selectorsCache) {
        const raw = JSON.parse(fs.readFileSync(SELECTORS_PATH, 'utf-8'));
        selectorsCache = {
            ...raw,
            // 新键缺省走内置默认（见 DEFAULT_FILE_INPUT 注释）
            fileInput: raw.fileInput ?? DEFAULT_FILE_INPUT,
            imagePreview: raw.imagePreview ?? DEFAULT_IMAGE_PREVIEW,
        };
    }
    return selectorsCache;
}
export function createWebBridge(config, opts = {}) {
    const sessionsFile = opts.sessionsFile ?? process.env.SESSIONS_FILE ?? DEFAULT_SESSIONS_FILE;
    const browserFactory = opts.browserFactory;
    let browser = null;
    let page = null;
    /** 正在进行的 start()；用于让 start 幂等且并发安全（懒启动下首请求与 CLI 可能同时触发） */
    let starting = null;
    /**
     * 最近一次 bridge 启动失败的原始原因。**只用于可观测性**，不参与任何控制流。
     *
     * 失败路径会把 bridge 全量 teardown（见 teardownBridge），于是状态坍缩回
     * 「和冷启动一模一样」：health() 的 `!isBridgeAlive → bridge_idle` 这时说的是
     * 真话（确实没东西在跑，且下个请求会重拉）。但只报 bridge_idle 会让运维
     * 丢掉「上次到底为什么没起来」这个关键信息，只能去翻日志。
     *
     * 所以这里把原因**捎带**在 health 的可选字段里，而不新增一个状态值——
     * 状态是给调用方做分支决策的（「该等 / 该重试 / 该去登录」），而失败原因
     * 不是分支维度。新增状态值会破坏外部做 exhaustive switch 的消费者
     * （OpenCode 等），为「多一句解释」付这个代价不划算。
     *
     * 成功启动时清空；teardown 不碰它（清掉就等于把刚记下的原因又抹了）。
     */
    let lastStartError = null;
    let chromeProc = null;
    let generating = false;
    let chatSessionId = null;
    /** 进行中生成对应的 window.__comp 下标；-1 表示当前没有进行中的请求。
     *  提到闭包作用域是为了让 cancel() 能定位同一条 entry（与 generate 内取值完全一致）。 */
    let entryIndex = -1;
    /** JS 派发点击：::-p-text 命中的是嵌套 div 文本节点，CDP hit-test 不可点，
     *  locator.click() 会卡在 actionability 等待直到超时（2026-09-30 实测）；
     *  冒泡 MouseEvent 直接派发，SPA 的 React 合成事件正常响应。 */
    async function jsClickByText(text) {
        if (!page)
            throw new Error('bridge not started');
        return page.evaluate(t => {
            const els = [...document.querySelectorAll('div,button,span')].filter(el => (el.textContent ?? '').trim() === t);
            if (!els.length)
                return false;
            for (const el of els)
                el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return true;
        }, text);
    }
    async function ensureProfileDir() {
        const dest = path.resolve(config.browser.profileDir);
        fs.mkdirSync(dest, { recursive: true });
        if (!profileSeeded(dest)) {
            console.log('[web-bridge] fresh profile — first run needs manual login in the Chrome window');
        }
    }
    /** 选择器失效/UI 异常时把 DOM 快照落 logs/（design §4.3/§9） */
    async function dumpDom(reason) {
        if (!page)
            return;
        try {
            fs.mkdirSync(config.log.dir, { recursive: true });
            const f = path.join(config.log.dir, `dom-${reason}-${Date.now()}.html`);
            fs.writeFileSync(f, await page.content(), 'utf-8');
            console.log(`[web-bridge] DOM snapshot saved: ${f}`);
        }
        catch { /* 快照失败不掩盖原始错误 */ }
    }
    function dropPersistedEntry(key) {
        try {
            const snap = loadSessionSnapshot(sessionsFile);
            delete snap[key];
            saveSessionSnapshot(sessionsFile, snap);
            console.log(`[web-bridge] dropped stale session entry ${key}`);
        }
        catch (e) {
            console.log('[web-bridge] failed to drop stale session entry:', e instanceof Error ? e.message : e);
        }
    }
    async function launch() {
        // 测试注入点：给了 browserFactory 就整段跳过「解析可执行文件 + spawn 真 Chrome +
        // 连 CDP 端口」，连同下面的 retryConnect（最多 15 次 ×1s）一并绕开。
        // profile 目录也不建——它属于「起真浏览器」这一步，测试里起不来。
        // 早退**不设** lastStartError：注入是测试路径，不是启动失败。
        if (browserFactory) {
            browser = await browserFactory();
            return;
        }
        await ensureProfileDir();
        // 显式路径优先（--chrome-path / CHROME_PATH），否则自动探测。
        // 这里 spawn 的是解析出的可执行文件——puppeteer 侧只负责连 remote debugging 端口，
        // 不存在可传 executablePath 的 launch 调用，别照着文档去找那个参数。
        const chrome = resolveChromeExecutable(config.browser.executablePath);
        if (!chrome)
            throw new Error(chromeNotFoundMessage(chromeCandidates(process.env, process.platform)));
        chromeProc = spawn(chrome, [
            `--remote-debugging-port=${config.browser.debugPort}`,
            `--user-data-dir=${path.resolve(config.browser.profileDir)}`,
            '--no-first-run', '--no-default-browser-check',
            ...(config.browser.headless ? ['--headless=new'] : []),
        ], { detached: true, stdio: 'ignore' });
        browser = await retryConnect(() => puppeteer.connect({ browserURL: `http://127.0.0.1:${config.browser.debugPort}`, defaultViewport: null }));
    }
    /** 首页路径：导航 + 注入探针 + 从 URL 提取新会话 id */
    async function openHome() {
        if (!page)
            throw new Error('browser not launched');
        await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(2000);
        await page.evaluate(PROBE);
        const m = page.url().match(/\/a\/chat\/s\/([0-9a-f-]{36})/);
        if (m)
            chatSessionId = m[1];
    }
    /** 续接路径：深链到持久化的 chat URL；无效/加载失败 → 回退首页并清除该条目 */
    async function openResumed(resume) {
        if (!page)
            throw new Error('browser not launched');
        try {
            await page.goto(chatUrlFor(resume.chatSessionId), { waitUntil: 'domcontentloaded', timeout: 30000 });
            await sleep(2000);
            if (page.url().includes(`/a/chat/s/${resume.chatSessionId}`)) {
                chatSessionId = resume.chatSessionId;
                await page.evaluate(PROBE);
                debugLog(config.log.level, `[web-bridge] resumed session ${resume.chatSessionId} (sentCount=${resume.sentCount})`);
                return;
            }
            debugLog(config.log.level, `[web-bridge] resume target redirected to ${page.url()}`);
        }
        catch (e) {
            debugLog(config.log.level, '[web-bridge] resume navigation failed:', e instanceof Error ? e.message : e);
        }
        await dumpDom('resume-failed');
        dropPersistedEntry(resume.key);
        chatSessionId = null;
        await openHome();
    }
    async function openChatPage() {
        if (!browser)
            throw new Error('browser not launched');
        const pages = await browser.pages();
        page = pages.find(p => p.url().includes('chat.deepseek.com')) ?? await browser.newPage();
        // 整页刷新后新 document 的 XHR 包装丢失，framenavigated 重注（PROBE 幂等不会双裹）（N4）
        const p = page;
        p.on('framenavigated', frame => {
            if (frame === p.mainFrame())
                void p.evaluate(PROBE).catch(() => { });
        });
        const snap = loadSessionSnapshot(sessionsFile);
        const resumableCount = Object.values(snap).filter(r => sanitizeChatSessionId(r?.chatSessionId)).length;
        if (resumableCount > 1)
            console.log(`[web-bridge] ${resumableCount} resumable sessions; opening fresh chat to avoid context mixing`);
        const resume = pickResumeEntry(snap);
        if (resume)
            await openResumed(resume);
        else
            await openHome();
    }
    async function clickSend(sel) {
        if (!page)
            throw new Error('bridge not started');
        try {
            await page.click(sel);
        }
        catch {
            await dumpDom('selector-send');
            throw new Error('ui_changed: send selector not found');
        }
    }
    /**
     * 存活探测：browser 对象非 null **不等于** Chrome 还活着。
     *
     * Chrome 崩溃、被用户关窗、或休眠后被系统回收时，puppeteer 的 Browser /
     * Page 对象都不会自动置 null——它们只是变成了指向已死进程的陈旧句柄。
     * 于是 `if (browser) return` 会一路早退、`if (!page)` 也判定为「已就绪」，
     * shim 就此永久砖化：每个请求都 502，Chrome 再也不会被重新拉起，
     * 只能手动重启进程。对「常驻后台服务」这个定位来说这是硬伤。
     *
     * `isConnected()` 是 puppeteer 提供的存活判据，连接断开时返回 false。
     * 探测本身要吞异常：句柄已死时任何调用都可能抛，而抛异常在这里必须等价于
     * 「死了」——不能让它冒泡去打断调用方的正常流程。
     */
    function isBridgeAlive() {
        if (!browser)
            return false;
        try {
            return browser.isConnected();
        }
        catch {
            return false;
        }
    }
    /** Chrome 已死时把闭包状态清干净，让 startBridge 能重新走一遍 launch。 */
    function resetStaleBridge() {
        browser = null;
        page = null;
        chromeProc = null;
        chatSessionId = null;
    }
    /**
     * 杀掉 Chrome 进程树。stop() 与 teardownBridge() 共用。
     *
     * 只闭包外的进程处置，**不碰闭包变量**——两处对「要不要清 chatSessionId」的
     * 语义不同（stop 是有意停机，要保住会话 id 供下次深链恢复；teardown 是启动
     * 失败后的清理，跟着 resetStaleBridge 一起清），合在一起反而容易清错时机。
     */
    function killChromeTree() {
        if (chromeProc?.pid) {
            // Windows 下子 Chrome 进程可能残留持有 profile 锁，taskkill /T /F 杀整树保证可重启（N5）
            try {
                spawn('taskkill', ['/pid', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore' });
            }
            catch { /* taskkill 缺失时退回 chromeProc.kill */ }
        }
        chromeProc?.kill();
    }
    /**
     * 彻底拆掉一个「进程还活着但不可用」的 bridge：先 close，再杀进程树，最后清状态。
     *
     * 为什么必须真的 close 而不是只置 null：这种情况（browser connected 但 page
     * 为 null 或坏页）进程**还活着**，只置 null 会让每次重试都留下一个孤儿 Chrome，
     * 而它们还各自持有同一个 `.chrome-profile` 的锁——几次之后 Chrome 起不来了。
     *
     * close 必须带超时：puppeteer 对**已死连接**的 close() 没有超时保证，可能挂住。
     * 挂住会把 `starting` 这个单飞 promise 永久占住，于是后续所有请求都 join 在
     * 一个永不 settle 的 promise 上——比原 bug 更糟。超时后直接走 taskkill 杀树。
     */
    async function teardownBridge() {
        const b = browser;
        if (b) {
            try {
                await Promise.race([b.close(), sleep(CLOSE_TIMEOUT_MS)]);
            }
            catch { /* 已死或关闭失败：交给下面的 taskkill */ }
        }
        killChromeTree();
        browser = null;
        page = null;
        chromeProc = null;
        chatSessionId = null;
    }
    /**
     * 幂等启动：重复调用不重复拉 Chrome。懒启动下 CLI 与首个 generate 可能同时触发，
     * 故用 starting 复用同一个 promise 而不是各拉一个 Chrome。
     *
     * ## 为什么 `if (starting) return starting` 前面绝不能出现 await
     *
     * 「检查 starting → 赋值 starting」必须是一个**同步原子区**。一旦在这两步之间
     * 插入 await（哪怕只是一个 teardown），两个并发请求就会双双看到 starting=null，
     * 各自通过检查、各自 launch 一个 Chrome → 双进程 + 抢同一个 `.chrome-profile`
     * 的锁，之后谁也起不来。所以下面把复用判据、teardown、launch 全部包进 executor
     * 内部，赋值本身仍是同步的。
     *
     * ## 复用判据为什么必须同时看 page
     *
     * 只判「存活」不够：`openChatPage()` 里 `page = ...newPage()` 的赋值发生在
     * `goto`/`openHome()` **之前**，所以导航失败时 browser 仍 connected 而 page
     * 指向一个空白/坏页——`isBridgeAlive()` 为 true 让这里永久早退，之后每个请求
     * 都撞 generate 里的 `!page` 或等不到 textarea，502 且永不重试。这就是评审
     * COND-1 记录的「活着但起不来 → 永久 bridge_idle + 永久 502」。
     *
     * ## 失败即全量 teardown
     *
     * 抛错前把状态清回「和冷启动一样」，于是下一个请求一定会重试，而 health() 的
     * `!isBridgeAlive → bridge_idle` 此时是**真话**（确实没东西在跑），
     * 不再需要为「启动失败」单开一个状态值。失败原因记在 lastStartError 里，
     * 由 health() 捎带出去。
     */
    async function startBridge() {
        if (starting)
            return starting;
        starting = (async () => {
            try {
                // 同步区内二次判复用：外层那一行 await 之前就已判过一次，这里是 executor
                // 开始执行时的最新快照（两者之间只隔一个同步赋值，语义等价但更不易错读）
                if (isBridgeAlive() && page)
                    return;
                if (browser || page) {
                    if (isBridgeAlive())
                        await teardownBridge(); // 进程还活着：必须真关，否则每次重试泄漏一个 Chrome
                    else
                        resetStaleBridge(); // 进程已死：置 null 即可，不必等 close 超时
                }
                await launch();
                await openChatPage();
                lastStartError = null;
            }
            catch (err) {
                lastStartError = err instanceof Error ? err.message : String(err);
                await teardownBridge();
                throw err;
            }
        })();
        try {
            await starting;
        }
        finally {
            starting = null;
        }
    }
    /**
     * 把附件上传到网页版输入区，并等到前端确认收到。
     *
     * ## 为什么失败一律抛错、绝不静默降级
     *
     * 「上传失败就退化成只发文本」看起来友好，实际最危险：模型会在**没有图**的情况下
     * 正常作答，产出读起来通顺但完全对不上图的答案。用户很难发现少了图，只会觉得模型
     * 胡说。所以这里每条失败路径都抛 `upload_failed:`，让调用方拿到明确的 502。
     *
     * ## 为什么必须校验绝对路径
     *
     * puppeteer 官方文档 `ElementHandle.uploadFile()` 的 Remarks 明确写着：
     * 「For locals script connecting to remote chrome environments, paths must be absolute」。
     * 本 transport 正是用 `browserURL` 连**既有的** Chrome（不是自己 launch 的），
     * 相对路径会被按**Chrome 进程的 cwd** 解析，静默传错文件或传不进去。
     * 文档同时声明该方法**不校验文件是否存在**，所以存在性也得自己查。
     *
     * ## 完成信号
     *
     * 2026-10-24 真机实测：`uploadFile()` 后 `input.files` 被前端消费为 0，输入区出现
     * `img[src^="blob:"]` 预览，500ms 内稳定。因此用「预览数量达到 before + N」作为
     * 完成判据，比固定 sleep 可靠——慢网络/大图时不会误判为已完成。
     */
    async function uploadImages(images, sel) {
        if (!page)
            throw new Error('upload_failed: bridge not started');
        for (const p of images) {
            if (!path.isAbsolute(p))
                throw new Error(`upload_failed: 附件路径必须绝对: ${p}`);
            if (!fs.existsSync(p))
                throw new Error(`upload_failed: 附件不存在: ${p}`);
        }
        const handle = await page.$(sel.fileInput);
        if (!handle) {
            await dumpDom('no-file-input');
            throw new Error(`upload_failed: 未找到附件输入框（selector: ${sel.fileInput}）`);
        }
        /**
         * 选择器可能被用户改成命中非 input 的节点（selectors.json 是可改文件）。
         * 直接 cast 会让 uploadFile 在运行时抛一个难以定位的 puppeteer 内部错误，
         * 所以先做一次运行时判型，报错带 tagName 便于定位。
         */
        const tagName = await handle.evaluate((el) => el.tagName.toLowerCase());
        if (tagName !== 'input') {
            await dumpDom('file-input-not-input');
            throw new Error(`upload_failed: 选择器命中的不是 input，实际为 <${tagName}>（selector: ${sel.fileInput}）`);
        }
        const input = handle;
        const countPreviews = (s) => page.evaluate((q) => document.querySelectorAll(q).length, s);
        const before = await countPreviews(sel.imagePreview);
        try {
            await input.uploadFile(...images);
        }
        catch (e) {
            throw new Error(`upload_failed: uploadFile 调用失败: ${e instanceof Error ? e.message : String(e)}`);
        }
        try {
            await page.waitForFunction((s, want) => document.querySelectorAll(s).length >= want, { timeout: UPLOAD_TIMEOUT_MS, polling: 100 }, sel.imagePreview, before + images.length);
        }
        catch {
            await dumpDom('upload-timeout');
            throw new Error(`upload_failed: ${UPLOAD_TIMEOUT_MS}ms 内未观察到 ${images.length} 个附件预览（selector: ${sel.imagePreview}）`);
        }
    }
    return {
        async start() { await startBridge(); },
        async stop() {
            try {
                await browser?.close();
            }
            catch { /* detached chrome 不随连接关闭而退出 */ }
            killChromeTree();
            // 有意**不**清 chatSessionId：stop 是「先停后起」，会话 id 要留着供下次深链恢复。
            // 启动失败路径走 teardownBridge，那才是连会话 id 一起清。
            browser = null;
            page = null;
            chromeProc = null;
        },
        async *generate(req) {
            // (c) 懒启动：首个请求才拉起 Chrome。start() 幂等，重复调用无副作用。
            // 无条件走 startBridge()：复用决策只在它内部做一处。旧写法
            // `if (!isBridgeAlive()) await startBridge()` 漏掉了「browser 活着但 page
            // 是坏页」这一路——page 非 null，于是既不重拉、又必然等不到 textarea，
            // 15s 后 502 且永不重试（评审 COND-1）。判断散在两处就一定会漏掉一处。
            await startBridge();
            if (!page)
                throw new Error('bridge not started'); // start 失败兜底；同时让 TS 保住 null 收窄
            while (generating)
                await sleep(200); // 单飞锁：FIFO 等待
            generating = true;
            try {
                const sel = readSelectors();
                await page.bringToFront();
                const ta = await page.waitForSelector('textarea', { timeout: 15000 });
                await ta.click();
                /**
                 * 附件必须在 `insertText` **之前**就位：DeepSeek 的发送动作读取的是「输入区当前
                 * 状态」，先打字后贴附件会让两者在时间上竞争。上传失败在这里直接抛
                 * `upload_failed:`，绝不继续走「只发文本」——见 uploadImages 的注释。
                 */
                if (req.images && req.images.length > 0) {
                    await uploadImages(req.images, sel);
                }
                const preLen = await page.evaluate(() => window.__comp.length);
                const cdp = await page.createCDPSession();
                await cdp.send('Input.insertText', { text: req.prompt });
                await clickSend(sel.send);
                let t0 = Date.now();
                entryIndex = -1;
                let retried = false;
                let emittedC = 0, emittedR = 0;
                let lastProgress = Date.now();
                let lastLen = 0;
                const sseCursor = createSseCursor();
                const deadline = Date.now() + (req.timeoutMs ?? config.timeoutMs);
                while (Date.now() < deadline) {
                    if (entryIndex === -1) {
                        const len = await page.evaluate(() => window.__comp.length);
                        const idx = resolveEntryIndex(len, preLen);
                        if (idx < 0 && Date.now() - t0 > config.sendClickSettleMs) {
                            if (!retried) {
                                retried = true;
                                t0 = Date.now();
                                await clickSend(sel.send);
                                continue;
                            }
                            await dumpDom('no-request');
                            throw new Error('no_request_after_send: 点击后未捕获到请求，未重发');
                        }
                        if (idx >= 0)
                            entryIndex = idx;
                    }
                    if (entryIndex !== -1) {
                        const st = await page.evaluate(i => {
                            const e = window.__comp[i];
                            return e ? { done: e.done, status: e.status, resp: String(e.resp ?? '') } : null;
                        }, entryIndex);
                        if (st) {
                            // (b) 增量解析：只喂新增尾部，状态跨拍保留。轮询间隔 / emittedC 切片 /
                            // 流末那次权威整份解析都保持原样，时序与语义不变。
                            const b = feedSse(sseCursor, st.resp);
                            if (b.content.length > emittedC) {
                                yield { content: b.content.slice(emittedC) };
                                emittedC = b.content.length;
                            }
                            if (b.reasoning.length > emittedR) {
                                yield { reasoning: b.reasoning.slice(emittedR) };
                                emittedR = b.reasoning.length;
                            }
                            if (st.resp.length !== lastLen) {
                                lastLen = st.resp.length;
                                lastProgress = Date.now();
                            }
                            else if (Date.now() - lastProgress > PROGRESS_LOG_MS) {
                                lastProgress = Date.now();
                                console.log(`[web-bridge] generating... resp=${st.resp.length}B, waited ${Math.round((Date.now() - t0) / 1000)}s`);
                            }
                            if (st.done) {
                                const err = completionError(st.status);
                                if (err)
                                    throw new Error(err);
                                // 流结束兜底（只能在这里做：局部解析时 reasoning 还只是思考片段，
                                // 提前挪 content 会把思考当正文吐出去并顶高 emittedC 吞掉真答案）
                                const bf = bucketSSE(st.resp);
                                let outR = bf.reasoning, outC = bf.content;
                                if (!outC && outR) {
                                    outC = outR;
                                    outR = '';
                                }
                                if (outR.length > emittedR) {
                                    yield { reasoning: outR.slice(emittedR) };
                                    emittedR = outR.length;
                                }
                                if (outC.length > emittedC) {
                                    yield { content: outC.slice(emittedC) };
                                    emittedC = outC.length;
                                }
                                const m = page.url().match(/\/a\/chat\/s\/([0-9a-f-]{36})/);
                                if (m)
                                    chatSessionId = m[1];
                                return;
                            }
                        }
                    }
                    await sleep(400);
                }
                throw new Error('timeout: generation exceeded limit');
            }
            finally {
                generating = false;
                entryIndex = -1;
            }
        },
        /** harness 侧取消：把进行中那条 entry 标记为完成并清空 resp，
         *  generate 的轮询下一拍读到 done 即返回（不复用任何新的取值路径，只写 __comp[entryIndex]）。 */
        async cancel() {
            if (!page || entryIndex < 0)
                return;
            const i = entryIndex;
            await page.evaluate(idx => {
                const e = window.__comp[idx];
                if (e) {
                    e.done = true;
                    e.resp = '';
                }
            }, i);
        },
        getCapabilities() {
            return {
                supportsThinking: true,
                supportsResume: true,
                // 网页端不暴露模型规格；64000 取 DeepSeek 公开的 chat 上下文上限（V3/R1 同为 64K），
                // 并非本地实测值。compaction 阈值仍以 config.compactTokenThreshold 为准，两者独立。
                maxContextTokens: 64000,
                tokenEstimator: (t) => Math.ceil(t.length / 2),
            };
        },
        async newChat() {
            if (!page)
                throw new Error('bridge not started');
            // 界面语言兜底：selectors.json 为主，NEW_CHAT_FALLBACKS 双语候补（去重保序）
            let clicked = false;
            for (const sel of [...new Set([readSelectors().newChat, ...NEW_CHAT_FALLBACKS])]) {
                const text = textFromPTextSelector(sel);
                if (!text)
                    continue;
                try {
                    if (await jsClickByText(text)) {
                        clicked = true;
                        break;
                    }
                }
                catch { /* 选择器无效/语言不匹配：试下一个 */ }
            }
            if (!clicked) {
                await dumpDom('selector-newchat');
                throw new Error('ui_changed: newChat selector not found');
            }
            await sleep(1000);
            chatSessionId = null;
        },
        health() {
            return (async () => {
                /**
                 * (c) 懒启动下 Chrome 可能根本没起来。
                 *
                 * 这里**不返回 error**：error 的语义是「页面在但读取失败」，调用方
                 * （尤其 CLI 的阻塞登录循环）会把 error 当成需要重试或退出的坏状态。
                 *
                 * 也**不返回 login_required**：那是「页面在、确实没登录」的结论，
                 * 而此刻连页面都没有，判据根本没跑过——把它报成未登录，等于拿一个
                 * 未经检验的断言去覆盖「只是还没被叫醒」这个事实。此前就是这么写的，
                 * 后果是冷启动阶段 /health 永远报 login_required，运维探针无法区分
                 * 「服务没起」和「账号掉线」，只能一律去重新登录。
                 *
                 * 所以这里引入独立的 bridge_idle：它是**部署状态**而非账号状态，
                 * loggedIn 保持 false——bridge 没起时确实无从得知登录态，false 是诚实的值，
                 * 而非「已知未登录」的断言。
                 */
                // 没起起来的时候，把最近一次失败原因捎带出去：状态仍是 bridge_idle
                // （失败路径已全量 teardown，探针如实看到「没东西在跑，下个请求会重拉」），
                // 但运维不必翻日志就知道上次为什么没起来。不新增状态值，避免破坏外部
                // 做 exhaustive switch 的调用方；error 是可选字段，形状不变。
                const idle = () => (lastStartError
                    ? { status: 'bridge_idle', loggedIn: false, error: clipForHealth(lastStartError) }
                    : { status: 'bridge_idle', loggedIn: false });
                if (!isBridgeAlive())
                    return idle();
                // isBridgeAlive() 看的是 browser，page 是另一路状态：launch() 中途失败时
                // browser 可能已连上而 page 仍为 null。显式收窄既让 TS 认得，也避免下面
                // 两次 evaluate 在 null 上抛成 error（那会把「还没准备好」误报成故障）。
                if (!page)
                    return idle();
                try {
                    /**
                     * loggedIn 的主判据是「聊天输入框是否渲染」，不是正文文本。
                     *
                     * 旧实现先 `document.body.innerText.includes('登录')` 就报 login_required，
                     * 这是已记录的误报：页面加载早期正文里就可能出现「登录」二字（导航、
                     * 页脚、弹窗文案、甚至别人的提问），于是鉴权尚未完成时就被判成未登录。
                     * 反过来，输入框只在真正登录后的会话页才渲染——DeepSeek 未登录时
                     * 直接跳登录页，压根没有 textarea。这一条既不会误报，判据也更贴近
                     * 「能不能干活」：没有输入框就发不出任何请求。
                     *
                     * 不引入新选择器：复用 generate() 里既有的裸标签 'textarea'
                     * （deepseek-web.ts:319），与 selectors.json 的 send/newChat 无关。
                     */
                    const hasInput = await page.evaluate(s => !!document.querySelector(s), CHAT_INPUT_SELECTOR);
                    const txt = await page.evaluate(() => document.body.innerText || '');
                    return judgeLoginState({ hasInput, bodyText: txt });
                }
                catch {
                    return { status: 'error', loggedIn: false };
                }
            })();
        },
        lastChatSessionId() { return chatSessionId; },
        resetSession() { chatSessionId = null; },
    };
}
