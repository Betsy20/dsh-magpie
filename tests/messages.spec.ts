/**
 * `src/messages.ts` 的单元测试 —— DSH 消息模型 → OpenAI chat 线格式。
 *
 * ## 为什么这一层最值得测
 *
 * 序列化错了**不会抛异常**，只会让上游以 `model_param_invalid` 400 拒掉整个
 * 请求，或者让模型「看不见」工具结果。下面每条用例都对应一次实测踩过的坑
 * （见 `D:\dsh-build\specs\magpie-api.md` 与 `dsh-plugin-contract.md` §SSE/序列化）。
 *
 * @module tests/messages
 */

import { describe, expect, it } from 'vitest'

import { normalizeToolArguments, toWireMessages } from '../src/messages.js'
import type { RequestMessage } from '@deepseek-ai/dsh-llm'

/**
 * 造一条 DSH 消息（只填序列化用得上的三个字段）。
 *
 * @param role - 角色。
 * @param content - 内容块。
 * @param extra - `role: 'tool'` 时的 `toolCallId` 等。
 * @returns 消息。
 */
function message(role: string, content: readonly unknown[], extra: Record<string, unknown> = {}): RequestMessage {
  return { role, content, ...extra } as unknown as RequestMessage
}

describe('toWireMessages', () => {
  it('纯文本 user 消息保持字符串形态', async () => {
    // ⚠️ 这条是硬要求：把纯文本包成 `[{type:'text',…}]` 会被上游以
    //    `model_param_invalid` 400 拒收**整个请求**（实测）。
    const wire = await toWireMessages([message('user', [{ type: 'text', text: '你好' }])])
    expect(wire).toEqual([{ role: 'user', content: '你好' }])
  })

  it('多条 text 块直接拼接（同一段话被切碎的常见形态）', async () => {
    const wire = await toWireMessages([
      message('user', [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ]),
    ])
    expect(wire).toEqual([{ role: 'user', content: '第一段第二段' }])
  })

  it('system 选项被放在最前面', async () => {
    const wire = await toWireMessages([message('user', [{ type: 'text', text: 'hi' }])], {
      system: '你是助手',
    })
    expect(wire[0]).toEqual({ role: 'system', content: '你是助手' })
  })

  it('assistant 只有工具调用时 content 必须是 null', async () => {
    // ⚠️ 必须配一条工具结果：`resolveToolPairing` 是**双向交集**，没有结果的
    //    调用会被当孤儿剔除，那样就测不到这里的三态分支了。
    const wire = await toWireMessages([
      message('assistant', [{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{"city":"北京"}' }]),
      message('tool', [{ type: 'text', text: '晴' }], { toolCallId: 'call_1' }),
    ])
    expect(wire[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } }],
    })
  })

  it('assistant 同时有文本与工具调用时两者都保留', async () => {
    const wire = await toWireMessages([
      message('assistant', [
        { type: 'text', text: '我查一下' },
        { type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{}' },
      ]),
      message('tool', [{ type: 'text', text: '晴' }], { toolCallId: 'call_1' }),
    ])
    expect(wire[0]).toMatchObject({ role: 'assistant', content: '我查一下' })
    expect((wire[0] as { tool_calls?: unknown[] }).tool_calls).toHaveLength(1)
  })

  it('assistant 的 reasoning 块映射到 reasoning_content', async () => {
    // magpie 从 `delta.reasoning_content` 读思维链；回传时也要放回同名字段，
    // 否则多轮对话里模型会「忘记」自己想过什么。
    const wire = await toWireMessages([
      message('assistant', [
        { type: 'reasoning', text: '先看看天气' },
        { type: 'text', text: '好的' },
      ]),
    ])
    expect(wire[0]).toMatchObject({ role: 'assistant', content: '好的', reasoning_content: '先看看天气' })
  })

  it('工具结果映射成一等 role:tool 消息', async () => {
    const wire = await toWireMessages([
      message('assistant', [{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{}' }]),
      message('tool', [{ type: 'text', text: '晴 25 度' }], { toolCallId: 'call_1' }),
    ])
    expect(wire[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '晴 25 度' })
  })

  it('工具结果为空时兜底成 (no output)', async () => {
    // 空的 `content: ''` 会被部分上游拒收；给个占位让模型知道「调过了」。
    const wire = await toWireMessages([
      message('assistant', [{ type: 'tool-call', id: 'call_1', name: 'noop', arguments: '{}' }]),
      message('tool', [], { toolCallId: 'call_1' }),
    ])
    expect(wire[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '(no output)' })
  })

  it('孤儿工具结果（没有对应 tool-call）被丢弃', async () => {
    // 上下文被裁剪后常见：工具结果留着、调用被删了。原样发上去上游会 400。
    const wire = await toWireMessages([message('tool', [{ type: 'text', text: '结果' }], { toolCallId: 'call_x' })])
    expect(wire).toEqual([])
  })

  it('孤儿工具调用（没有对应结果）被剔除，但消息本身保留', async () => {
    // 中断/压缩后的历史常见：调用发出去了、结果没等到。原样发给上游会 400，
    // 所以 `tool_calls` 必须撤掉；assistant 消息本身留着以维持角色交替。
    const wire = await toWireMessages([
      message('user', [{ type: 'text', text: 'hi' }]),
      message('assistant', [{ type: 'tool-call', id: 'call_x', name: 'get_weather', arguments: '{}' }]),
    ])
    expect(wire).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
    ])
  })

  it('旧形态 type:tool-result 的块被提升为一等 tool 消息', async () => {
    // DSH 0.1.7 之前把工具结果塞在 user 消息的 content 块里。
    const wire = await toWireMessages([
      message('assistant', [{ type: 'tool-call', id: 'call_1', name: 'get_weather', arguments: '{}' }]),
      message('user', [
        { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: '晴' }] },
      ]),
    ])
    expect(wire[1]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '晴' })
  })

  it('图片在内联 reader 可用时升级成 image_url parts', async () => {
    const wire = await toWireMessages(
      [message('user', [{ type: 'text', text: '这是什么' }, { type: 'image', attachment: { id: 'a1' } }])],
      { readImage: async () => 'data:image/png;base64,AAAA' },
    )
    expect(wire[0]).toEqual({
      role: 'user',
      // 图在前、文本在后：「先给材料、再给问题」的自然阅读顺序。
      content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        { type: 'text', text: '这是什么' },
      ],
    })
  })

  it('图片 reader 抛错时降级成占位文本而不是整条失败', async () => {
    // 附件可能已被清理/权限不足。丢掉一张图，好过让整轮对话失败。
    const wire = await toWireMessages(
      [message('user', [{ type: 'text', text: '这是什么' }, { type: 'image', attachment: { id: 'a1' } }])],
      {
        readImage: async () => {
          throw new Error('附件不存在')
        },
      },
    )
    expect(wire[0]).toMatchObject({ role: 'user' })
    expect(JSON.stringify(wire[0])).toContain('图片')
  })

  it('offloaded 图片直接降级成占位文本（不去读）', async () => {
    let read = false
    const wire = await toWireMessages(
      [message('user', [{ type: 'image', attachment: { id: 'a1' }, offloaded: true }])],
      {
        readImage: async () => {
          read = true
          return 'data:image/png;base64,AAAA'
        },
      },
    )
    expect(read).toBe(false)
    expect(JSON.stringify(wire[0])).toContain('图片')
  })

  it('developer 消息被丢弃（magpie 不认识这个角色）', async () => {
    const wire = await toWireMessages([
      message('developer', [{ type: 'text', text: '内部指令' }]),
      message('user', [{ type: 'text', text: 'hi' }]),
    ])
    expect(wire).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('normalizeToolArguments', () => {
  it('空串兜底成 {}', () => {
    // magpie 的**首块** tool_call 只带 id/name，arguments 键完全缺失；拼起来
    // 就是空串。原样发回去会被上游判成非法 JSON。
    expect(normalizeToolArguments('')).toBe('{}')
    expect(normalizeToolArguments('   ')).toBe('{}')
  })

  it('合法 JSON 原样返回', () => {
    expect(normalizeToolArguments('{"city":"北京"}')).toBe('{"city":"北京"}')
  })

  it('非法 JSON 兜底成 {}', () => {
    expect(normalizeToolArguments('{坏')).toBe('{}')
  })
})
