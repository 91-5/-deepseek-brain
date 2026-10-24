import type { AppConfig } from '../config.js';
import type { OpenAIMessage, ToolCall, ToolSpec } from '../types.js';
import type { Transport } from './types.js';
import { type SessionStore } from './session/store.js';
import type { SessionKeyStrategy } from './session/strategy.js';
export declare class FormatGiveUpError extends Error {
    constructor();
}
/**
 * planner 的可替换依赖。三项全部可选：不传时行为与 v0.1 完全一致
 * （默认 store 走环境变量、默认 key 策略是前缀哈希、默认阈值走 config）。
 *
 * - store：接管会话表存储。不传则每次调用按 env 现开一个默认 store。
 * - keyStrategy：接管「OpenCode 会话 → 后端会话」的映射规则。
 *   默认 prefixHashStrategy 与历史 .sessions.json 里的 key 逐位一致。
 * - threshold：compaction 触发阈值（估算 token 数）。
 */
export interface PlannerDeps {
    store?: SessionStore;
    keyStrategy?: SessionKeyStrategy;
    threshold?: number;
}
export interface TurnResult {
    content: string;
    reasoning: string;
    toolCall?: ToolCall;
    usageTokens: number;
}
/**
 * sentCount 钳制：OpenCode 历史回退/取消时持久化 sentCount 可能超过当前 messages 长度，
 * 裸 slice 会得空 delta（整轮只发 system prompt → 垃圾回答）。钳到最后一条 user 消息下标，
 * 保证 delta 至少包含触发本轮的那条 user 消息（N3）。
 */
export declare function clampSentCount(stored: number, messages: OpenAIMessage[]): number;
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
export declare function currentTurnImages(delta: OpenAIMessage[]): string[] | undefined;
export declare function runAgentTurn(opts: {
    messages: OpenAIMessage[];
    tools: ToolSpec[];
    transport: Transport;
    config: AppConfig;
    /** 可选的替换点；不传则全部走与 v0.1 一致的默认路径 */
    deps?: PlannerDeps;
}): Promise<TurnResult>;
