export interface ToolSpec {
  name: string
  description: string
  parameters: unknown
}
export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /**
   * 本条消息携带的图片**绝对路径**。
   *
   * 为什么不塞进 `content`：下游 transport 只能通过 puppeteer 的 `uploadFile()`
   * 把文件送进网页版，那只认路径；而把 base64 拼进 prompt 会直接撑爆网页版上下文。
   * 路径必须绝对——puppeteer 官方文档明确「连远端 Chrome 时 paths must be absolute」。
   */
  images?: string[]
  tool_call_id?: string
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}
