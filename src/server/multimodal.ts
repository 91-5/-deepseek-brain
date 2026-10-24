import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { OpenAIContentPart } from './openai-types.js'

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
export class UnsupportedImageSourceError extends Error {
  constructor(detail: string) {
    super(`upload_failed: ${detail}`)
    this.name = 'UnsupportedImageSourceError'
  }
}

/** media type → 落盘扩展名。未知类型退 `.bin`，不猜。 */
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/tiff': '.tiff',
  'application/pdf': '.pdf',
}

/** 供测试与排障：把 media type 映射成落盘扩展名 */
export function extensionForMime(mime: string): string {
  return MIME_EXT[mime.toLowerCase().trim()] ?? '.bin'
}

/**
 * 解 `data:<mime>[;base64],<payload>`。
 *
 * 非 base64 的 data URI（`data:image/svg+xml,<url-encoded>`）也接受——SVG 常被这样内联，
 * 拒掉会让一类合法输入无谓失败。非 data URI（`http(s)://…`）返回 `null`，
 * 由调用方转成 UnsupportedImageSourceError：**本 shim 刻意不开远程抓取的 SSRF 面**。
 */
export function decodeDataUri(url: string): { mime: string; buf: Buffer } | null {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const header = url.slice('data:'.length, comma)
  const payload = url.slice(comma + 1)
  const isBase64 = /;\s*base64\s*$/i.test(header)
  const mime = header.split(';')[0]?.trim() || 'application/octet-stream'
  try {
    const buf = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf-8')
    if (buf.length === 0) return null
    return { mime, buf }
  } catch {
    return null
  }
}

/**
 * 从 content part 里取出图片源字符串，兼容三种方言。
 *
 * 三种方言的依据见 `openai-types.ts` 顶部注释（LiteLLM 的
 * `_IMAGE_CONTENT_PART_TYPES`）。`image_url` 同时接受**裸字符串**与**对象**形态。
 */
export function imageSourceOf(part: OpenAIContentPart): string | null {
  if (!part || typeof part !== 'object') return null
  const p = part as { type?: string; image_url?: unknown; source?: unknown }

  if (p.type === 'image_url' || p.type === 'input_image') {
    const v = p.image_url
    if (typeof v === 'string') return v
    if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') {
      return (v as { url: string }).url
    }
    return null
  }

  if (p.type === 'image') {
    // Anthropic 风格优先：source.data 是裸 base64，没有 data: 前缀
    const src = p.source as { type?: string; media_type?: string; data?: string } | undefined
    if (src && typeof src.data === 'string' && src.data.length > 0) {
      const mt = typeof src.media_type === 'string' && src.media_type ? src.media_type : 'image/png'
      return `data:${mt};base64,${src.data}`
    }
    const v = p.image_url
    if (typeof v === 'string') return v
    if (v && typeof v === 'object' && typeof (v as { url?: unknown }).url === 'string') {
      return (v as { url: string }).url
    }
    return null
  }

  return null
}

export interface PreparedContent {
  /** 拼好的纯文本（原顺序），直接喂给 planner 的 buildPrompt */
  text: string
  /** 落盘后的**绝对路径**，交给 transport 上传 */
  images: string[]
  /** 幂等清理；无图时是 no-op */
  cleanup: () => void
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
export function prepareContent(content: string | OpenAIContentPart[] | null | undefined): PreparedContent {
  if (content == null) return { text: '', images: [], cleanup: () => {} }
  if (typeof content === 'string') {
    return { text: content, images: [], cleanup: () => {} }
  }
  if (!Array.isArray(content)) {
    // 形状意外的 content（例如数字）——宁可当文本兜底，也不静默丢内容
    return { text: String(content), images: [], cleanup: () => {} }
  }

  const texts: string[] = []
  const decoded: Array<{ mime: string; buf: Buffer }> = []

  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    if ((part as { type?: string }).type === 'text') {
      const t = (part as { text?: unknown }).text
      if (typeof t === 'string') texts.push(t)
      continue
    }
    const src = imageSourceOf(part)
    if (src == null) {
      // 既不是 text 也没有可识别的图片源：跳过而不是抛错——上游可能塞了
      // 别的扩展 part（如 audio），拒整条请求过于激进
      continue
    }
    const parsed = decodeDataUri(src)
    if (!parsed) {
      throw new UnsupportedImageSourceError(
        '仅支持 data: URI 形式的图片；远程 http(s) URL 不被支持（不发外部请求）',
      )
    }
    decoded.push(parsed)
  }

  const text = texts.join('\n')
  if (decoded.length === 0) return { text, images: [], cleanup: () => {} }

  const dir = path.join(os.tmpdir(), 'deepseek-brain-uploads', crypto.randomBytes(8).toString('hex'))
  const cleanup = () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不该影响主流程 */
    }
  }

  const images: string[] = []
  try {
    fs.mkdirSync(dir, { recursive: true })
    decoded.forEach((img, i) => {
      const file = path.join(dir, `${i}${extensionForMime(img.mime)}`)
      fs.writeFileSync(file, img.buf)
      if (!path.isAbsolute(file)) throw new UnsupportedImageSourceError(`临时文件路径非绝对: ${file}`)
      images.push(file)
    })
  } catch (e) {
    cleanup()
    throw e
  }

  return { text, images, cleanup }
}
