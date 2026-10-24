import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  prepareContent,
  decodeDataUri,
  imageSourceOf,
  extensionForMime,
  UnsupportedImageSourceError,
} from '../src/server/multimodal.js'
import { currentTurnImages } from '../src/core/planner.js'
import type { OpenAIContentPart } from '../src/server/openai-types.js'
import type { OpenAIMessage } from '../src/types.js'

/** 1x1 PNG，字节数最小且能被浏览器识别 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR42mNk+M9Qz0AEYBxVSF+FjIwMAA0mAgHkf3c5AAAAAElFTkSuQmCC'

const pngUrl = `data:image/png;base64,${PNG_B64}`

describe('multimodal: 三种 content 方言都能解析出图片源', () => {
  it('image_url 对象形态（Chat Completions）', () => {
    const part: OpenAIContentPart = { type: 'image_url', image_url: { url: pngUrl, detail: 'auto' } }
    expect(imageSourceOf(part)).toBe(pngUrl)
  })

  it('image_url 裸字符串形态（LiteLLM 兼容位）', () => {
    const part = { type: 'image_url', image_url: pngUrl } as unknown as OpenAIContentPart
    expect(imageSourceOf(part)).toBe(pngUrl)
  })

  it('input_image 形态（Responses API）', () => {
    const part = { type: 'input_image', image_url: pngUrl } as unknown as OpenAIContentPart
    expect(imageSourceOf(part)).toBe(pngUrl)
  })

  it('image source 形态（Anthropic base64）', () => {
    const part = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: PNG_B64 },
    } as unknown as OpenAIContentPart
    expect(imageSourceOf(part)).toBe(`data:image/jpeg;base64,${PNG_B64}`)
  })

  it('无法识别图片源的 part 返回 null', () => {
    expect(imageSourceOf({ type: 'audio', data: 'x' } as unknown as OpenAIContentPart)).toBeNull()
  })
})

describe('multimodal: data URI 解码', () => {
  it('base64 图片解码出正确字节数', () => {
    const r = decodeDataUri(pngUrl)
    expect(r).not.toBeNull()
    expect(r!.mime).toBe('image/png')
    expect(r!.buf.length).toBeGreaterThan(0)
    expect(r!.buf.equals(Buffer.from(PNG_B64, 'base64'))).toBe(true)
  })

  it('非 base64 的 data URI（url-encoded SVG）也能解', () => {
    const r = decodeDataUri('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    expect(r).not.toBeNull()
    expect(r!.mime).toBe('image/svg+xml')
    expect(r!.buf.toString('utf-8')).toContain('<svg')
  })

  it('http(s) 远程 URL 返回 null（本 shim 不发外部请求）', () => {
    expect(decodeDataUri('https://example.com/a.png')).toBeNull()
  })

  it('空 payload 返回 null', () => {
    expect(decodeDataUri('data:image/png;base64,')).toBeNull()
  })

  it('media type → 扩展名映射', () => {
    expect(extensionForMime('image/png')).toBe('.png')
    expect(extensionForMime('IMAGE/JPEG')).toBe('.jpg')
    expect(extensionForMime('image/webp')).toBe('.webp')
    expect(extensionForMime('image/svg+xml')).toBe('.svg')
    expect(extensionForMime('application/pdf')).toBe('.pdf')
    expect(extensionForMime('image/unknown-xyz')).toBe('.bin')
  })
})

describe('multimodal: prepareContent 的纯文本零回归', () => {
  it('content 为字符串时原样返回，且不产生图片', () => {
    const r = prepareContent('hello')
    expect(r.text).toBe('hello')
    expect(r.images).toEqual([])
    expect(typeof r.cleanup).toBe('function')
    r.cleanup() // no-op 不应抛错
  })

  it('content 为 undefined / null 时安全', () => {
    expect(prepareContent(undefined).text).toBe('')
    expect(prepareContent(null).images).toEqual([])
  })
})

describe('multimodal: prepareContent 落盘', () => {
  it('text 与 image 混排：文本按顺序拼接，图片落盘为绝对路径', () => {
    const r = prepareContent([
      { type: 'text', text: '第一段' },
      { type: 'image_url', image_url: { url: pngUrl } },
      { type: 'text', text: '第二段' },
    ])
    try {
      expect(r.text).toBe('第一段\n第二段')
      expect(r.images).toHaveLength(1)
      expect(path.isAbsolute(r.images[0])).toBe(true)
      expect(r.images[0].endsWith('.png')).toBe(true)
      expect(fs.existsSync(r.images[0])).toBe(true)
      expect(fs.statSync(r.images[0]).size).toBeGreaterThan(0)
    } finally {
      r.cleanup()
    }
  })

  it('cleanup 后临时目录被删除', () => {
    const r = prepareContent([{ type: 'image_url', image_url: pngUrl }])
    const file = r.images[0]
    expect(fs.existsSync(file)).toBe(true)
    r.cleanup()
    expect(fs.existsSync(file)).toBe(false)
    // 幂等：重复 cleanup 不抛
    expect(() => r.cleanup()).not.toThrow()
  })

  it('多图各自落盘且文件名不冲突', () => {
    const r = prepareContent([
      { type: 'image_url', image_url: pngUrl },
      { type: 'image_url', image_url: pngUrl },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG_B64 } } as unknown as OpenAIContentPart,
    ])
    try {
      expect(r.images).toHaveLength(3)
      expect(new Set(r.images).size).toBe(3)
      expect(r.images[2].endsWith('.jpg')).toBe(true)
    } finally {
      r.cleanup()
    }
  })

  it('远程 URL 抛 UnsupportedImageSourceError 且 message 带 upload_failed: 前缀', () => {
    expect(() => prepareContent([{ type: 'image_url', image_url: { url: 'https://x/a.png' } }]))
      .toThrow(UnsupportedImageSourceError)
    try {
      prepareContent([{ type: 'image_url', image_url: { url: 'https://x/a.png' } }])
    } catch (e) {
      expect((e as Error).message.startsWith('upload_failed:')).toBe(true)
    }
  })

  it('落盘失败会清理已写出的目录（不留孤儿）', () => {
    // 用非法的父路径制造 mkdir 失败：把 tmpdir 指向一个文件
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsb-orphan-'))
    const fileAsDir = path.join(dir, 'not-a-dir')
    fs.writeFileSync(fileAsDir, 'x')
    const original = os.tmpdir
    // 测试用：临时替换 tmpdir 制造 mkdir 失败（os.tmpdir 在类型上是可写属性）
    os.tmpdir = () => fileAsDir
    try {
      expect(() => prepareContent([{ type: 'image_url', image_url: pngUrl }])).toThrow()
    } finally {
      os.tmpdir = original
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('planner: currentTurnImages 只取当前轮', () => {
  const mk = (role: OpenAIMessage['role'], images?: string[]): OpenAIMessage => ({ role, content: 'x', ...(images ? { images } : {}) })

  it('取最后一条 user 消息的图片', () => {
    expect(currentTurnImages([mk('user', ['/a.png']), mk('assistant'), mk('user', ['/b.png'])])).toEqual(['/b.png'])
  })

  it('历史图片不重传：只有旧 user 消息带图时返回 undefined', () => {
    expect(currentTurnImages([mk('user', ['/old.png']), mk('assistant'), mk('user')])).toBeUndefined()
  })

  it('无图片时返回 undefined（不触发上传分支）', () => {
    expect(currentTurnImages([mk('user')])).toBeUndefined()
  })

  it('空 delta 返回 undefined', () => {
    expect(currentTurnImages([])).toBeUndefined()
  })
})
