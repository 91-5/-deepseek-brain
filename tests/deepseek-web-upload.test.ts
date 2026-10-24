import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Browser, Page } from 'puppeteer-core'
import { createWebBridge } from '../src/transports/deepseek-web.js'
import { loadConfig } from '../src/config.js'
import type { GenerateChunk, GenerateRequest } from '../src/core/types.js'

/**
 * 上传阶段的**时序与不变量**回归（Acceptance A8）。
 *
 * ## 这个文件锁死哪三件事
 *
 * 1. 带图请求：`uploadFile` 必须在 `Input.insertText` **之前**发生。反了就意味着
 *    「先把文字打进去、再贴附件」，两者的顺序在 DeepSeek 的发送动作里是有语义的。
 * 2. 纯文本请求：`uploadFile` **一次都不能被调用**。多加一次空上传会凭空多出一个
 *    round trip，更糟的是可能让输入区混进上一轮的残留附件。
 * 3. `uploadFile` 抛错时：**绝不能继续**到 `insertText` 之后（即绝不静默降级成纯文本）。
 *    这是本卡最重要的一条——见 uploadImages 的注释。
 *
 * ## 为什么用 timeoutMs 制造终局而不是造一个完整 SSE 流
 *
 * `generate()` 的收尾依赖真实的 SSE 旁路（`__comp`），伪造整条流等于把被测目标
 * 换成 fake。这里改用极短超时让循环自然走到 `timeout:` 出口——**该出口不触发
 * `dumpDom`**，所以不会往工作树里写 `logs/dom-*.html`（pack 测试与 A11 都依赖工作树干净）。
 *
 * ## 明确不证明（避免越界引用）
 *
 * - 不证明真实 Chrome 上的上传能成功（那由 A9 真机实测覆盖）
 * - 不证明 `img[src^="blob:"]` 选择器的选取正确性（同上）
 * - 不证明 SSE 解析、会话恢复、单飞锁——本文件全部绕开
 * - fake page 只 stub 被走到的路径；将来代码路径变了就让它响亮地失败，
 *   而不是用一个「什么都能接」的 fake 把回归吞掉
 */

const cfg = loadConfig({})
type Bridge = ReturnType<typeof createWebBridge> & { start(): Promise<void> }

interface Trace {
  calls: string[]
  /** uploadFile 是否被调用、传了几个路径 */
  uploads: number[]
}

function makeFakePage(trace: Trace, opts: { failUpload?: boolean }): Page {
  let compLen = 0 // 第一次读返回 0（preLen），之后返回 1 让 resolveEntryIndex 命中 0
  const fake = {
    url: () => 'about:blank',
    content: async () => '<html></html>',
    on: () => {},
    goto: async () => {},
    bringToFront: async () => { trace.calls.push('bringToFront') },
    waitForSelector: async () => ({
      click: async () => { trace.calls.push('textarea.click') },
    }),
    mainFrame: () => ({}),
    evaluate: async (fn: unknown, _arg?: unknown) => {
      const src = typeof fn === 'function' ? fn.toString() : ''
      if (src.includes('__comp.length')) {
        const v = compLen
        compLen = 1
        return v
      }
      if (src.includes('querySelectorAll')) return 0 // 附件预览计数
      if (src.includes('done')) return { done: false, status: null, resp: '' } // entry 状态
      return null // PROBE 等其它 evaluate
    },
    waitForFunction: async () => { trace.calls.push('waitForFunction'); return undefined },
    $: async (sel: string) => {
      trace.calls.push('$')
      return {
        evaluate: async () => 'input', // tagName 判型
        uploadFile: async (...paths: string[]) => {
          trace.calls.push('uploadFile')
          trace.uploads.push(paths.length)
          if (opts.failUpload) throw new Error('simulated-upload-failure')
        },
      }
    },
    createCDPSession: async () => ({
      send: async (method: string) => { trace.calls.push(`cdp.${method}`) },
    }),
    click: async () => { trace.calls.push('click') },
    close: async () => {},
  }
  return fake as unknown as Page
}

function makeBridge(trace: Trace, opts: { failUpload?: boolean } = {}): Bridge {
  const page = makeFakePage(trace, opts)
  const browser = {
    pages: async () => [] as Page[],
    newPage: async () => page,
    isConnected: () => true,
    close: async () => {},
  } as unknown as Browser
  return createWebBridge(cfg, {
    sessionsFile: path.join(os.tmpdir(), `dsb-upload-sessions-${process.pid}.json`),
    browserFactory: async () => browser,
  }) as Bridge
}

/** 消费 generate 直到它自然抛错；返回错误消息。断言只关心时序，不关心终局类型。 */
async function drain(bridge: Bridge, req: GenerateRequest): Promise<string> {
  try {
    for await (const _c of bridge.generate(req) as AsyncIterable<GenerateChunk>) { /* 忽略分片 */ }
    return ''
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

let LOG_DIR = ''
let IMG = ''

beforeAll(() => {
  // 护栏：万一 browserFactory 注入点失效，指一条不存在的 Chrome，避免真的拉进程
  process.env.CHROME_PATH = 'D:\\definitely-not-here\\chrome.exe'
  LOG_DIR = path.join(os.tmpdir(), `dsb-upload-logs-${process.pid}`)
  cfg.log.dir = LOG_DIR
  IMG = path.join(os.tmpdir(), `dsb-upload-probe-${process.pid}.png`)
  fs.writeFileSync(IMG, Buffer.from('89504e470d0a1a0a', 'hex'))
})

afterAll(() => {
  delete process.env.CHROME_PATH
  fs.rmSync(LOG_DIR, { recursive: true, force: true })
  try { fs.rmSync(IMG, { force: true }) } catch { /* ignore */ }
})

describe('上传阶段时序（A8）', () => {
  it('带图请求：uploadFile 在 Input.insertText 之前', async () => {
    const trace: Trace = { calls: [], uploads: [] }
    const bridge = makeBridge(trace)
    await bridge.start()
    await drain(bridge, { prompt: '这是什么', thinking: false, timeoutMs: 80, images: [IMG] })

    const uploadAt = trace.calls.indexOf('uploadFile')
    const insertAt = trace.calls.indexOf('cdp.Input.insertText')
    expect(uploadAt).toBeGreaterThanOrEqual(0)
    expect(insertAt).toBeGreaterThanOrEqual(0)
    expect(uploadAt).toBeLessThan(insertAt)
    expect(trace.uploads).toEqual([1]) // 传了 1 个路径
  })

  it('纯文本请求：uploadFile 一次都不被调用', async () => {
    const trace: Trace = { calls: [], uploads: [] }
    const bridge = makeBridge(trace)
    await bridge.start()
    await drain(bridge, { prompt: '纯文本', thinking: false, timeoutMs: 80 })

    expect(trace.calls).not.toContain('uploadFile')
    expect(trace.uploads).toEqual([])
    // 但正常发送链路必须还在
    expect(trace.calls).toContain('cdp.Input.insertText')
  })

  it('多图：一次 uploadFile 传全部路径', async () => {
    const trace: Trace = { calls: [], uploads: [] }
    const bridge = makeBridge(trace)
    await bridge.start()
    const img2 = IMG.replace('.png', '-2.png')
    fs.writeFileSync(img2, 'x')
    try {
      await drain(bridge, { prompt: '两张图', thinking: false, timeoutMs: 80, images: [IMG, img2] })
      expect(trace.uploads).toEqual([2])
    } finally {
      fs.rmSync(img2, { force: true })
    }
  })

  it('uploadFile 抛错时：绝不继续到 insertText（不静默降级成纯文本）', async () => {
    const trace: Trace = { calls: [], uploads: [] }
    const bridge = makeBridge(trace, { failUpload: true })
    await bridge.start()
    const msg = await drain(bridge, { prompt: '带图但上传会失败', thinking: false, timeoutMs: 80, images: [IMG] })

    expect(msg).toContain('upload_failed')
    // 最关键的一条：文本插入与发送都不得发生
    expect(trace.calls).not.toContain('cdp.Input.insertText')
    expect(trace.calls).not.toContain('click')
  })

  it('附件路径不存在时：抛 upload_failed 且不调用 uploadFile', async () => {
    const trace: Trace = { calls: [], uploads: [] }
    const bridge = makeBridge(trace)
    await bridge.start()
    const msg = await drain(bridge, {
      prompt: 'x',
      thinking: false,
      timeoutMs: 80,
      images: [path.join(os.tmpdir(), 'definitely-absent-file-xyz.png')],
    })

    expect(msg).toContain('upload_failed')
    expect(trace.calls).not.toContain('uploadFile')
    expect(trace.calls).not.toContain('cdp.Input.insertText')
  })

  it('相对路径被拒绝（puppeteer 要求远端 Chrome 必须绝对路径）', async () => {
    const trace: Trace = { calls: [], uploads: [] }
    const bridge = makeBridge(trace)
    await bridge.start()
    const msg = await drain(bridge, { prompt: 'x', thinking: false, timeoutMs: 80, images: ['relative/a.png'] })

    expect(msg).toContain('upload_failed')
    expect(msg).toContain('绝对')
    expect(trace.calls).not.toContain('uploadFile')
  })
})
