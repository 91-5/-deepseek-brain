/**
 * `bridge_idle` 与 `login_required` 的区分是这个联合类型里最容易被误读的一对。
 *
 * 懒启动下 Chrome 只在首个 chat 请求时才拉起，所以「还没启动」是**完全正常**的
 * 运行状态，而不是故障。此前 health 在 page 为 null 时一律返回
 * `login_required`，把「服务刚起还没被叫醒」「bridge 正在起」「页面在但确实没登录」
 * 三种截然不同的处境压成同一个信号——运维探针据此根本无法决定该等、该重试、
 * 还是该去登录，只能一律当成「未登录」处理。
 *
 * 判据：「bridge 起了吗」看 `page`/`browser` 是否就绪，「登录了吗」看页面内
 * 是否有聊天输入框。前者是**部署问题**，后者是**账号问题**，处置方式完全不同。
 */
export type HealthStatus = 'ok' | 'login_required' | 'ui_changed' | 'error' | 'bridge_idle';
/**
 * health() 的返回值。
 *
 * v0.2.0 起 health 从裸字符串改为带 loggedIn 的对象（spec §6.1）：CLI 需要在
 * 启动阶段**阻塞等待登录完成**才监听端口，只有 status 分不清「没登录」和
 * 「页面还没加载出来」，而这两种情况的正确处置完全不同。
 */
export interface Health {
    status: HealthStatus;
    /** 是否已鉴权成功。以聊天输入框是否渲染为主判据，见 transports/deepseek-web.ts */
    loggedIn: boolean;
    /**
     * 最近一次 bridge 启动失败的原始原因，**仅在 `bridge_idle` 时可能带上**。
     *
     * 为什么不是新状态值：状态是给调用方做**分支决策**的（该等 / 该重试 / 该登录），
     * 而失败原因不是分支维度。评审曾建议加 `bridge_error`，但那会破坏外部做
     * exhaustive switch 的消费者（OpenCode 等），为「多带一句解释」不值得。
     * 实测上更需要的是：失败路径会全量 teardown，于是 `bridge_idle` 说的就是
     * 「确实没东西在跑，下个请求会重试」这个真话，原因作为补充信息随行。
     *
     * 可选字段，老调用方与老测试的 `toEqual({status, loggedIn})` 形状不变。
     */
    error?: string;
}
export interface GenerateRequest {
    prompt: string;
    thinking: boolean;
    timeoutMs?: number;
    /**
     * 本轮要上传到网页版输入区的图片**绝对路径**（可为空）。
     *
     * 语义边界：这是「随这条 prompt 一起发出去的附件」，不是历史附件池。
     * 调用方（planner）只放当前轮 user 消息的图——历史图片网页会话自己已持有，
     * 重传只会反复堆附件并撞上未知的上游上限。
     */
    images?: string[];
}
export interface GenerateChunk {
    reasoning?: string;
    content?: string;
}
export interface Capabilities {
    /** 模型是否产出 reasoning_content 分流 */
    supportsThinking: boolean;
    /** 是否支持用 chatSessionId 深链恢复会话 */
    supportsResume: boolean;
    /** 上下文墙；compaction 阈值默认取此值 */
    maxContextTokens: number;
    /** token 估算器；默认取 core/session/manager.ts 的 chars/2 口径 */
    tokenEstimator?: (text: string) => number;
}
export interface Transport {
    generate(req: GenerateRequest): AsyncIterable<GenerateChunk>;
    newChat(): Promise<void>;
    health(): Promise<Health>;
    lastChatSessionId(): string | null;
    resetSession(): void;
    /** 中止当前进行中的生成；无进行中生成时为空操作 */
    cancel(): Promise<void>;
    getCapabilities(): Capabilities;
}
