/**
 * `src/sse.ts` 的单元测试。
 *
 * ## 为什么这几条值得测
 *
 * SSE 解析是**最容易静默出错**的一层：写错了不会抛异常，只会少几个字符、
 * 多一个空 chunk，或者把 `[DONE]` 当成 JSON 解析失败。而 magpie 的流式响应
 * 恰好有几个真实边界（跨字节的多字节 UTF-8、`data:` 后的空格、空行分隔），
 * 全都来自实测抓包。
 *
 * @module tests/sse
 */

import { describe, expect, it } from 'vitest'

import { SseDecoder, parseSse, parseSseJson } from '../src/sse.js'

/**
 * 造一个只吐固定字节块的 `ReadableStream`。
 *
 * @param chunks - 依次入队的 `Uint8Array`。
 * @returns 流。
 */
function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

/**
 * 把字符串切成**按字节**的块（用于验证多字节字符跨 chunk 的处理）。
 *
 * @param text - 源文本。
 * @param size - 每块字节数。
 * @returns 块列表。
 */
function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text)
  const out: Uint8Array[] = []
  for (let index = 0; index < bytes.length; index += size) {
    out.push(bytes.subarray(index, index + size))
  }
  return out
}

describe('SseDecoder', () => {
  it('按空行切分事件，并剥掉 data: 后的单个空格', () => {
    const decoder = new SseDecoder()
    const events = decoder.push('data: {"a":1}\n\ndata: {"b":2}\n\n')
    expect(events).toEqual([
      { event: '', data: '{"a":1}' },
      { event: '', data: '{"b":2}' },
    ])
  })

  it('跨 push 的半个事件不会提前吐出', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: {"a"')).toEqual([])
    expect(decoder.push(':1}\n\n')).toEqual([{ event: '', data: '{"a":1}' }])
  })

  it('多行 data 用换行拼接（SSE 规范）', () => {
    const decoder = new SseDecoder()
    const events = decoder.push('data: line1\ndata: line2\n\n')
    expect(events).toEqual([{ event: '', data: 'line1\nline2' }])
  })

  it('带 event: 名字的事件会保留名字', () => {
    const decoder = new SseDecoder()
    const events = decoder.push('event: ping\ndata: {}\n\n')
    expect(events).toEqual([{ event: 'ping', data: '{}' }])
  })

  it('忽略注释行（以冒号开头）与空 data 行', () => {
    const decoder = new SseDecoder()
    const events = decoder.push(': keep-alive\n\ndata: x\n\n')
    expect(events).toEqual([{ event: '', data: 'x' }])
  })

  it('CRLF 换行也能正确切分', () => {
    const decoder = new SseDecoder()
    const events = decoder.push('data: {"a":1}\r\n\r\n')
    expect(events).toEqual([{ event: '', data: '{"a":1}' }])
  })

  it('flush 吐出尾部残留（无结尾空行）', () => {
    const decoder = new SseDecoder()
    expect(decoder.push('data: tail')).toEqual([])
    expect(decoder.flush()).toEqual([{ event: '', data: 'tail' }])
  })
})

describe('parseSse', () => {
  it('逐事件产出，并在 [DONE] 后正常结束', async () => {
    const body = 'data: {"i":0}\n\ndata: {"i":1}\n\ndata: [DONE]\n\n'
    const seen: string[] = []
    for await (const event of parseSse(streamOf([new TextEncoder().encode(body)]))) {
      seen.push(event.data)
    }
    expect(seen).toEqual(['{"i":0}', '{"i":1}', '[DONE]'])
  })

  it('多字节 UTF-8 被切成多个字节块时不会乱码', async () => {
    // 中文 + emoji：每个字符 3~4 字节，切成 1 字节块必然跨 chunk。
    const text = 'data: {"t":"北京🌤"}\n\n'
    const seen: string[] = []
    for await (const event of parseSse(streamOf(byteChunks(text, 1)))) seen.push(event.data)
    expect(seen).toEqual(['{"t":"北京🌤"}'])
  })

  it('空流不产出任何事件', async () => {
    const seen: string[] = []
    for await (const event of parseSse(streamOf([]))) seen.push(event.data)
    expect(seen).toEqual([])
  })

  it('调用方 abort 时抛 ABORTED 错误', async () => {
    const controller = new AbortController()
    controller.abort()
    const body = 'data: x\n\n'
    await expect(async () => {
      for await (const _event of parseSse(streamOf([new TextEncoder().encode(body)]), {
        signal: controller.signal,
      })) {
        // 不应产出
      }
    }).rejects.toMatchObject({ code: 'ABORTED' })
  })

  it('空闲超时抛 TIMEOUT 错误', async () => {
    // 永不 close、也永不产出的流 —— 模拟上游卡住。
    const stalled = new ReadableStream<Uint8Array>({ start() {} })
    await expect(async () => {
      for await (const _event of parseSse(stalled, { idleTimeoutMs: 20 })) {
        // 不应产出
      }
    }).rejects.toMatchObject({ code: 'TIMEOUT' })
  })
})

describe('parseSseJson', () => {
  it('把 [DONE] 识别成哨兵', () => {
    expect(parseSseJson('[DONE]')).toBe('done')
    expect(parseSseJson(' [DONE] ')).toBe('done')
  })

  it('空串返回 undefined', () => {
    expect(parseSseJson('')).toBeUndefined()
    expect(parseSseJson('   ')).toBeUndefined()
  })

  it('解析合法 JSON', () => {
    expect(parseSseJson('{"a":[1,2]}')).toEqual({ a: [1, 2] })
  })

  it('非法 JSON 抛错而不是静默丢弃', () => {
    // 上游偶发会把 HTML 错误页/日志行当成 `data:` 发过来。静默丢弃的表现是
    // 「模型一个字都没说」，用户完全无从排查；所以这里**刻意**抛错，由
    // `adapter.stream` 转成终态 error 块。
    expect(() => parseSseJson('not json')).toThrow()
  })
})
