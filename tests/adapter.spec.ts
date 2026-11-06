/**
 * `src/adapter.ts` 的单元测试 —— 重点是 `TokenUsage` 换算。
 *
 * ## 为什么专门测这一个函数
 *
 * 宿主的 `TokenUsage` 是**互斥计数**（`inputTokens` 只含未命中缓存的部分），
 * 而 OpenAI 兼容协议的 `prompt_tokens` 是**总量**。差值是一个减法，做错了
 * 不会抛异常、不会失败任何请求，只会让用量面板上的输入 token 数悄悄偏大。
 * 这种错只有单测能抓住。
 *
 * @module tests/adapter
 */

import { describe, expect, it } from 'vitest'

import { __toTokenUsageForTest as toTokenUsage } from '../src/adapter.js'
import type { WireUsage } from '../src/types.js'

describe('toTokenUsage', () => {
  it('无缓存时 inputTokens 就是 prompt_tokens', () => {
    const usage = toTokenUsage({ prompt_tokens: 34, completion_tokens: 64, total_tokens: 98 } as WireUsage)
    expect(usage).toEqual({ inputTokens: 34, outputTokens: 64, totalTokens: 98 })
  })

  it('有缓存时从 prompt_tokens 里扣掉缓存部分（互斥计数）', () => {
    // 1000 总输入里有 800 命中缓存 → 宿主侧只报 200 输入 + 800 缓存读。
    // 若不减，宿主的「输入 token」会凭空多 800，成本页与上下文预算全错。
    const usage = toTokenUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 800 },
    } as WireUsage)
    expect(usage).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      totalTokens: 1050,
      cacheReadTokens: 800,
    })
  })

  it('cached_tokens 为 0 时不出现 cacheReadTokens', () => {
    // 宿主把「未声明」与「0」分开看：前者未知，后者确定没命中。
    const usage = toTokenUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 0 },
    } as WireUsage)
    expect(usage.cacheReadTokens).toBeUndefined()
  })

  it('cached_tokens > prompt_tokens 时 inputTokens 夹到 0（不报负数）', () => {
    // 某些上游会把两次请求的缓存拼在一起上报，减出负数会让宿主的用量校验抛错。
    const usage = toTokenUsage({
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 900 },
    } as WireUsage)
    expect(usage.inputTokens).toBe(0)
    expect(usage.cacheReadTokens).toBe(900)
  })

  it('reasoning_tokens 只在大于 0 时出现', () => {
    const withReasoning = toTokenUsage({
      prompt_tokens: 34,
      completion_tokens: 64,
      total_tokens: 98,
      completion_tokens_details: { reasoning_tokens: 64 },
    } as WireUsage)
    expect(withReasoning.reasoningTokens).toBe(64)

    const withoutReasoning = toTokenUsage({
      prompt_tokens: 34,
      completion_tokens: 64,
      completion_tokens_details: { reasoning_tokens: 0 },
    } as WireUsage)
    expect(withoutReasoning.reasoningTokens).toBeUndefined()
  })

  it('缺失字段按 0 兜底且不抛错', () => {
    // 流式响应的 usage 块偶发只有部分字段。
    expect(toTokenUsage({} as WireUsage)).toEqual({ inputTokens: 0, outputTokens: 0 })
    expect(toTokenUsage({ prompt_tokens: undefined } as WireUsage)).toEqual({ inputTokens: 0, outputTokens: 0 })
  })

  it('total_tokens 缺失时不声明', () => {
    const usage = toTokenUsage({ prompt_tokens: 1, completion_tokens: 2 } as WireUsage)
    expect(usage.totalTokens).toBeUndefined()
  })
})
