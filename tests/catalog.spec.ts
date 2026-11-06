/**
 * `src/catalog.ts` 的单元测试 —— 模型目录翻译与 glob 过滤。
 *
 * ## 为什么这一层最值得测
 *
 * 这里每条分支都对应宿主 `normalizeModelInfo` / `resolveCallWithInfo` 的一条
 * **硬校验**，违反就抛（`INVALID_MODEL_CONTEXT` / `INVALID_MODEL_MAX_TOKENS` /
 * `INVALID_MODEL_REASONING` / `UNSUPPORTED_REASONING_EFFORT`），表现是整个
 * profile 起不来。而 magpie 的 20 个模型恰好把「`reasoning_levels` 为空」
 * 「`max_output_tokens` 缺失」「层级乱序」这些边界都覆盖到了。
 *
 * @module tests/catalog
 */

import { describe, expect, it } from 'vitest'

import { globMatch, toResolvedInfo } from '../src/catalog.js'
import type { WireModel } from '../src/types.js'

/**
 * 造一条线格式模型（只填测试关心的字段）。
 *
 * @param patch - 覆盖字段。
 * @returns 线格式模型。
 */
function model(patch: Partial<WireModel> = {}): WireModel {
  return { id: 'wps-lingxi/deepseek-v4.1-flash', object: 'model', ...patch } as WireModel
}

describe('globMatch', () => {
  it('完全相等的字面量命中', () => {
    expect(globMatch('group/group', 'group/group')).toBe(true)
    expect(globMatch('group/group', 'group/other')).toBe(false)
  })

  it('没有通配符时不做前缀/子串匹配', () => {
    expect(globMatch('group', 'group/group')).toBe(false)
    expect(globMatch('group/group', 'group')).toBe(false)
  })

  it('* 匹配任意（含斜杠与空串）', () => {
    expect(globMatch('group/*', 'group/group')).toBe(true)
    expect(globMatch('group/*', 'group/jet-hub-deepseek-v4.1-flash')).toBe(true)
    expect(globMatch('*', 'jet-hub-qiniu/deepseek/deepseek-v4.1-flash-1017')).toBe(true)
    expect(globMatch('group/*', 'group/')).toBe(true)
    expect(globMatch('group/*', 'other/group')).toBe(false)
  })

  it('? 匹配恰好一个字符', () => {
    expect(globMatch('grou?/group', 'group/group')).toBe(true)
    // 'grou?' 是 5 字符模式，'group' 是 5 字符 —— '?' 吃掉 'p'，命中。
    expect(globMatch('grou?', 'group')).toBe(true)
    expect(globMatch('grou?', 'grou')).toBe(false)
  })

  it('中间的 * 也能命中', () => {
    expect(globMatch('jet-hub-*/dfmodel', 'jet-hub-qoder/dfmodel')).toBe(true)
    expect(globMatch('jet-hub-*/dfmodel', 'jet-hub-qoder/other')).toBe(false)
  })

  it('正则元字符被转义，不产生注入', () => {
    // 若 `.` 被当成通配符，`group.group` 会命中 `groupXgroup`。
    expect(globMatch('group.group', 'groupXgroup')).toBe(false)
    expect(globMatch('group.group', 'group.group')).toBe(true)
    // 括号/加号不该让正则编译失败。
    expect(() => globMatch('a(b+c)[d]', 'a(b+c)[d]')).not.toThrow()
    expect(globMatch('a(b+c)[d]', 'a(b+c)[d]')).toBe(true)
  })
})

describe('toResolvedInfo', () => {
  it('contextWindow 按 context_window → context_length → max_input_tokens 兜底', () => {
    expect(toResolvedInfo(model({ context_window: 1048576 })).context).toEqual({ contextWindow: 1048576 })
    expect(toResolvedInfo(model({ context_length: 1000000 })).context).toEqual({ contextWindow: 1000000 })
    expect(toResolvedInfo(model({ max_input_tokens: 65536 })).context).toEqual({ contextWindow: 65536 })
    // 前者优先
    expect(toResolvedInfo(model({ context_window: 100, context_length: 200 })).context).toEqual({ contextWindow: 100 })
  })

  it('全部分量都缺失时不声明 context（宿主按未知处理）', () => {
    // 声明 `contextWindow: 0` 会抛 INVALID_MODEL_CONTEXT，整个 profile 起不来。
    expect(toResolvedInfo(model()).context).toBeUndefined()
    expect(toResolvedInfo(model({ context_window: 0, context_length: -1 })).context).toBeUndefined()
  })

  it('max_output_tokens 缺失时不声明 defaultMaxTokens', () => {
    // `jet-hub-qoder/dfmodel` 与 `jet-hub-qodercn/dfmodel` 就是这种形态。
    expect(toResolvedInfo(model({ max_output_tokens: undefined })).defaultMaxTokens).toBeUndefined()
    expect(toResolvedInfo(model({ max_output_tokens: 393216 })).defaultMaxTokens).toBe(393216)
  })

  it('reasoning_levels 为空数组时整个 reasoning 字段不出现', () => {
    // 声明空 efforts 会抛 INVALID_MODEL_REASONING。8 个模型是这种形态。
    expect(toResolvedInfo(model({ reasoning_levels: [] })).reasoning).toBeUndefined()
  })

  it('reasoning_levels 缺失时退回 supported_reasoning_levels[].effort', () => {
    const info = toResolvedInfo(
      model({
        reasoning_levels: undefined,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      }),
    )
    expect(info.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high'])
  })

  it('乱序的 reasoning_levels 被按强弱重排', () => {
    // `jet-hub-qoder/dfmodel` 实测返回 [high, max, low, none]。
    const info = toResolvedInfo(model({ reasoning_levels: ['high', 'max', 'low', 'none'] }))
    expect(info.reasoning?.efforts.map((effort) => effort.id)).toEqual(['none', 'low', 'high', 'max'])
  })

  it('defaultEffort 取中位而不是最强', () => {
    // 取最强（max）会让每次调用都跑满推理预算，TTFT 与成本都翻倍。
    // 3 档取 efforts[1] = 中间那档；4 档同样取 efforts[1]（偏下的中位）。
    const info = toResolvedInfo(model({ reasoning_levels: ['low', 'high', 'max'] }))
    expect(info.reasoning?.defaultEffort).toBe('high')
    const even = toResolvedInfo(model({ reasoning_levels: ['none', 'low', 'high', 'max'] }))
    expect(even.reasoning?.defaultEffort).toBe('low')
  })

  it('未知层级的 id 排在末尾但仍保留', () => {
    const info = toResolvedInfo(model({ reasoning_levels: ['high', 'zzz', 'low'] }))
    expect(info.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high', 'zzz'])
  })

  it('每个 effort 都带非空 name（宿主会校验）', () => {
    const info = toResolvedInfo(model({ reasoning_levels: ['low', 'high', 'max'] }))
    for (const effort of info.reasoning?.efforts ?? []) {
      expect(typeof effort.name).toBe('string')
      expect(effort.name.length).toBeGreaterThan(0)
    }
  })

  it('inputModalities 只在 magpie 声明时出现', () => {
    expect(toResolvedInfo(model({ modalities: { input: ['text', 'image'], output: ['text'] } })).inputModalities).toEqual([
      'text',
      'image',
    ])
    // 声明「只支持文本」与「未知」是两件事：后者不该让宿主主动把图降级。
    expect(toResolvedInfo(model({ modalities: undefined })).inputModalities).toBeUndefined()
  })

  it('未知模态被过滤掉', () => {
    expect(
      toResolvedInfo(model({ modalities: { input: ['text', 'audio'] as never, output: ['text'] } })).inputModalities,
    ).toEqual(['text'])
  })

  it('显示名优先 magpie_label（能区分同名不同上游）', () => {
    // 20 个模型里有 14 个的 display_name 都叫 "Deepseek-V4.1-Flash"。
    const info = toResolvedInfo(
      model({ display_name: 'Deepseek-V4.1-Flash', magpie_label: 'Deepseek-V4.1-Flash · CodeBuddy (腾讯)' }),
    )
    expect(info.name).toBe('Deepseek-V4.1-Flash · CodeBuddy (腾讯)')
  })

  it('没有 magpie_label 时用 display_name · owned_by 拼', () => {
    const info = toResolvedInfo(model({ display_name: 'DeepSeek V4.1 Flash', owned_by: 'wps-lingxi' }))
    expect(info.name).toBe('DeepSeek V4.1 Flash · wps-lingxi')
  })

  it('全空时显示名退回 id（保证非空）', () => {
    const info = toResolvedInfo(model({ display_name: undefined, magpie_label: undefined, owned_by: undefined }))
    expect(info.name).toBe('wps-lingxi/deepseek-v4.1-flash')
  })

  it('description 与 name 相同时不重复给出', () => {
    const info = toResolvedInfo(model({ display_name: 'A', magpie_label: 'A · B', owned_by: 'B' }))
    expect(info.description).toBeUndefined()
  })

  it('id 原样保留（含多斜杠）', () => {
    const id = 'jet-hub-qiniu/deepseek/deepseek-v4.1-flash-1017'
    expect(toResolvedInfo(model({ id })).id).toBe(id)
  })
})
