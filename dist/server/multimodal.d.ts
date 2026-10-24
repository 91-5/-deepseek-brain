import type { OpenAIContentPart } from './openai-types.js';
/**
 * 客户端给的图片源无法处理（非 data URI、缺 data、格式非法）。
 *
 * 单独建类而不是就地 `throw new Error`：`http.ts` 要据此把 HTTP 状态码分成
 * **400（客户端给的请求体不对）** 与 **502（浏览器/上游失败）**。混在一起会让
 * 客户端把「我传错了」误读成「服务挂了」而去盲目重试。
 *
 * message 统一带 `upload_failed:` 前缀，与既有 `no_request_after_send:` /
 * `ui_changed:` 的风格保持一致，便于日志 grep。
 */
export declare class UnsupportedImageSourceError extends Error {
    constructor(detail: string);
}
/** 供测试与排障：把 media type 映射成落盘扩展名 */
export declare function extensionForMime(mime: string): string;
/**
 * 解 `data:<mime>[;base64],<payload>`。
 *
 * 非 base64 的 data URI（`data:image/svg+xml,<url-encoded>`）也接受——SVG 常被这样内联，
 * 拒掉会让一类合法输入无谓失败。非 data URI（`http(s)://…`）返回 `null`，
 * 由调用方转成 UnsupportedImageSourceError：**本 shim 刻意不开远程抓取的 SSRF 面**。
 */
export declare function decodeDataUri(url: string): {
    mime: string;
    buf: Buffer;
} | null;
/**
 * 从 content part 里取出图片源字符串，兼容三种方言。
 *
 * 三种方言的依据见 `openai-types.ts` 顶部注释（LiteLLM 的
 * `_IMAGE_CONTENT_PART_TYPES`）。`image_url` 同时接受**裸字符串**与**对象**形态。
 */
export declare function imageSourceOf(part: OpenAIContentPart): string | null;
export interface PreparedContent {
    /** 拼好的纯文本（原顺序），直接喂给 planner 的 buildPrompt */
    text: string;
    /** 落盘后的**绝对路径**，交给 transport 上传 */
    images: string[];
    /** 幂等清理；无图时是 no-op */
    cleanup: () => void;
}
/**
 * 把 OpenAI 的 `content`（字符串或 part 数组）规整成「纯文本 + 绝对路径图片列表」。
 *
 * 图片必须落盘再交给 transport，理由有二：
 * 1. puppeteer `uploadFile()` 只认**路径**，且连远端 Chrome 时必须绝对路径
 *    （官方文档 Remarks 明确写了）；
 * 2. base64 串若拼进 prompt 会直接撑爆网页版上下文。
 *
 * 任何一步失败都会先清掉已经写出的临时目录再抛错，避免留垃圾（A11 验收项）。
 */
export declare function prepareContent(content: string | OpenAIContentPart[] | null | undefined): PreparedContent;
