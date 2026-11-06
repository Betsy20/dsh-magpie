/**
 * 模型目录：把 magpie 的 `/v1/models` 翻译成宿主能消费的
 * {@link LlmResolvedModelInfo}，并做缓存与过滤。
 *
 * ## 为什么不能「原样透传」
 *
 * 宿主的 `normalizeModelInfo()` 会**逐字段校验**，任何一条不合法都会抛
 * 带具体 code 的 `LlmError`（`INVALID_MODEL_CONTEXT` /
 * `INVALID_MODEL_MAX_TOKENS` / `INVALID_MODEL_REASONING`），而 magpie 的
 * 目录是**多上游拼接**的，字段质量参差（实测 20 条里 2 条缺
 * `max_output_tokens`、8 条 `reasoning_levels` 是空数组、2 条顺序乱掉）。
 * ⇒ 本模块是「脏数据 → 宿主不变量」的唯一收敛点。
 *
 * ## 缓存
 *
 * 目录变化不频繁，而模型选择器每次打开都会调 `listModels()`。
 * 缓存 TTL 由 `catalogTtlMs` 控制（默认 60 秒）。**并发去重**也是必须的：
 * 宿主会并行调 `listModels()` / `resolveModelInfo()`，没有 in-flight 去重时
 * 一次面板打开能打十几次网关卡。
 *
 * @module dsh-magpie/catalog
 */

import type { ModelModality } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId, type LlmModelInfo, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { MagpieOptions } from './config.js'
import { requestJson, type RequestContext } from './http.js'
import { LOG_PREFIX, REASONING_LABELS, REASONING_LADDER } from './product.js'
import type { WireModel, WireModelList } from './types.js'

/**
 * magpie 给「已在 Jet Hub 关闭」的模型打的标记。
 *
 * 实测：`jet-hub-buddy/deepseek-v4.1-flash` 的 `magpie_label` 是
 * `Deepseek-V4.1-Flash · 已在 Jet Hub 关闭 · CodeBuddy (腾讯)`。
 * 这些模型**仍在目录里**（magpie 不隐藏它们），但实际请求会被拒。
 * 默认仍收录（`includeDisabledModels: true`）—— 用户可能只想看目录，
 * 而宿主侧选择器本来就该显示真实状态；关掉它可以少一半噪音。
 */
const DISABLED_MARKER = '已在 Jet Hub 关闭'

/** 目录快照。 */
export interface CatalogSnapshot {
  /** 全部可用模型（已过滤、已排序）。 */
  readonly models: readonly LlmResolvedModelInfo[]
  /** 拉取时间（`Date.now()`）。 */
  readonly fetchedAt: number
  /** magpie 的版本号（`GET /api/hello` 的 `version`，拿不到时 `undefined`）。 */
  readonly gatewayVersion: string | undefined
}

/**
 * 模型目录缓存。
 *
 * 一个实例对应一个 provider（本项目只有一个 provider，故由插件持有一个单例）。
 */
export class ModelCatalog {
  private snapshot: CatalogSnapshot | undefined
  private inFlight: Promise<CatalogSnapshot> | undefined
  /** 上一次成功拉取时的配置指纹；配置变了就必然重拉。 */
  private fingerprint = ''

  constructor(
    private readonly context: () => RequestContext,
    private readonly options: () => MagpieOptions,
    private readonly logger: { warn(message: string): void },
  ) {}

  /**
   * 取目录（命中缓存则直接返回）。
   *
   * @param force - 忽略缓存强制重拉（设置页的「刷新」按钮用）。
   * @returns 目录快照。
   */
  async get(force = false): Promise<CatalogSnapshot> {
    const options = this.options()
    const fingerprint = JSON.stringify([
      options.baseURL,
      options.modelInclude,
      options.modelExclude,
      options.includeDisabledModels,
    ])

    const fresh =
      this.snapshot !== undefined &&
      fingerprint === this.fingerprint &&
      Date.now() - this.snapshot.fetchedAt < options.catalogTtlMs
    if (fresh && !force) return this.snapshot!

    // 并发去重：`force` 也复用 in-flight 请求 —— 连点两次刷新不应该打两个
    // 网关卡，且两个 promise 会给出一致结果。
    if (this.inFlight !== undefined) return this.inFlight

    this.inFlight = this.fetch(fingerprint).finally(() => {
      this.inFlight = undefined
    })
    return this.inFlight
  }

  /**
   * 按模型 id 查一条（**只查缓存**，不触发网络）。
   *
   * `resolveModel()` 走这条路：宿主在流式调用前会先 `listModels()`，
   * 因此缓存通常已热；未命中时返回 `undefined` 由调用方决定是否重拉。
   *
   * @param model - 精确模型 id。
   * @returns 解析后的模型信息；未收录时 `undefined`。
   */
  peek(model: string): LlmResolvedModelInfo | undefined {
    return this.snapshot?.models.find((entry) => entry.id === model)
  }

  /** 丢弃缓存（配置变更时由插件调用）。 */
  invalidate(): void {
    this.snapshot = undefined
    this.inFlight = undefined
  }

  /**
   * 真正打网关。
   *
   * @param fingerprint - 本次拉取对应的配置指纹。
   * @returns 新快照。
   */
  private async fetch(fingerprint: string): Promise<CatalogSnapshot> {
    const context = this.context()
    const [list, version] = await Promise.all([
      requestJson<WireModelList>(context, '/v1/models'),
      this.probeVersion(context),
    ])

    const raw = Array.isArray(list.data) ? list.data : []
    if (raw.length === 0) {
      // 目录为空**不是**正常状态：magpie 至少有内置模型。把「空」暴露成
      // 告警，否则用户在模型选择器里看到空白列表会以为是 DSH 坏了。
      this.logger.warn(
        `${LOG_PREFIX} /v1/models 返回了空目录 —— 检查 magpie 是否已配置任何上游 provider（~/.config/magpie/settings.json）`,
      )
    }

    const options = this.options()
    const models = raw
      .filter((model): model is WireModel => typeof model?.id === 'string' && model.id.length > 0)
      .filter((model) => this.accept(model, options))
      .map((model) => toResolvedInfo(model))
      // 去重：magpie 理论上不会给重复 id，但「一个重复就让 listModels 抛
      // INVALID_CATALOG」的后果太重，这里按 id 保首条。
      .filter((model, index, all) => all.findIndex((entry) => entry.id === model.id) === index)

    this.snapshot = { models, fetchedAt: Date.now(), gatewayVersion: version }
    this.fingerprint = fingerprint
    return this.snapshot
  }

  /**
   * 探测 magpie 版本（`GET /api/hello`）。
   *
   * 失败**不抛**：版本号只用于面板展示，拿不到不该让整个目录失败。
   *
   * @param context - 请求上下文。
   * @returns 版本号；失败时 `undefined`。
   */
  private async probeVersion(context: RequestContext): Promise<string | undefined> {
    try {
      const hello = await requestJson<{ version?: string }>(context, '/api/hello')
      return typeof hello.version === 'string' ? hello.version : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 判断一个模型是否进目录。
   *
   * @param model - 线格式模型。
   * @param options - 当前配置。
   * @returns 收录则真。
   */
  private accept(model: WireModel, options: MagpieOptions): boolean {
    const id = model.id
    if (!options.includeDisabledModels && (model.magpie_label ?? '').includes(DISABLED_MARKER)) {
      return false
    }
    // 白名单优先：非空时**只有**命中的进目录。
    if (options.modelInclude.length > 0 && !options.modelInclude.some((pattern) => globMatch(pattern, id))) {
      return false
    }
    if (options.modelExclude.some((pattern) => globMatch(pattern, id))) return false
    return true
  }
}

/** 只在 `listModels()` 里用到的轻量目录项（`LlmModelInfo` 不含 context/reasoning）。 */
export type CatalogEntry = LlmModelInfo

/**
 * 把一条线格式模型翻译成宿主的精确模型信息。
 *
 * ## 逐字段的兜底理由
 *
 * | 字段 | 实测问题 | 处置 |
 * |---|---|---|
 * | `context_length` / `context_window` / `max_input_tokens` | 三者总有一个存在，但不同上游不同 | 依次取第一个正整数 |
 * | `max_output_tokens` | `jet-hub-qoder/dfmodel` 与 `jet-hub-qodercn/dfmodel` **缺失** | 缺失时不设 `defaultMaxTokens`（**不要**编一个数） |
 * | `reasoning_levels` | 8 个模型是空数组；`jet-hub-qoder/*` 是 `[high,max,low,none]` 乱序 | 空则**完全不声明** `reasoning`；非空按 {@link REASONING_LADDER} 重排 |
 * | `modalities.input` | 只有 `[text]` 或 `[text,image]` | 无 `image` 时声明 `['text']`（宿主据此降级图片块） |
 *
 * ⚠️ **为什么 `reasoning_levels` 为空时必须不声明 `reasoning`**：
 * `normalizeModelInfo()` 对 `efforts.length === 0` 抛
 * `INVALID_MODEL_REASONING`，且 `resolveCallWithInfo()` 在
 * `reasoning === undefined` 而调用方传了 `reasoningEffort` 时抛
 * `UNSUPPORTED_REASONING_EFFORT`。两个方向都只有一个正确形态：
 * **要么给出非空 efforts，要么整个字段缺席**。
 *
 * @param model - 线格式模型。
 * @returns 宿主可直接使用的模型信息。
 */
export function toResolvedInfo(model: WireModel): LlmResolvedModelInfo {
  const contextWindow = firstPositiveInt(
    model.context_window,
    model.context_length,
    model.max_input_tokens,
  )
  const maxOutput = firstPositiveInt(model.max_output_tokens)
  const inputModalities = toInputModalities(model)
  const reasoning = toReasoning(model)

  return {
    provider: '',
    id: model.id,
    name: displayNameOf(model),
    ...(descriptionOf(model) === undefined ? {} : { description: descriptionOf(model)! }),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    // `contextWindow` 必须是**正整数**，否则宿主抛 INVALID_MODEL_CONTEXT。
    // 全部字段都缺失时只能不声明（此时宿主按「未知窗口」处理）。
    ...(contextWindow === undefined ? {} : { context: { contextWindow } }),
    ...(maxOutput === undefined ? {} : { defaultMaxTokens: maxOutput }),
    ...(reasoning === undefined ? {} : { reasoning }),
  }
}

/**
 * 选一个给人看的模型名。
 *
 * 优先 `display_name`（短、干净，如 `DeepSeek V4.1 Flash`），
 * 退回 `magpie_label`（带 provider 归属，能区分同名的不同上游 ——
 * 20 个模型里有 14 个的 `display_name` 都是 `Deepseek-V4.1-Flash`），
 * 最后退回 id。
 *
 * ⚠️ 但**短名会重名**：若只用 `display_name`，下拉列表里 14 个条目全叫
 * `Deepseek-V4.1-Flash`，用户根本无法分辨。因此：**短名 + 归属**拼起来。
 *
 * @param model - 线格式模型。
 * @returns 显示名（保证非空）。
 */
function displayNameOf(model: WireModel): string {
  // magpie 自己的标签最完整（含 provider 归属与「已在 Jet Hub 关闭」这类
  // 状态），有就用它 —— 短名会重名，14 个模型全叫 `Deepseek-V4.1-Flash`。
  const label = model.magpie_label?.trim()
  if (label !== undefined && label.length > 0) return label
  const short = model.display_name?.trim()
  const owner = model.owned_by?.trim()
  if (short !== undefined && short.length > 0) {
    if (owner === undefined || owner.length === 0) return short
    return `${short} · ${owner}`
  }
  return model.id
}

/**
 * 模型描述：只在它与显示名不同、且信息量更大时给出。
 *
 * @param model - 线格式模型。
 * @returns 描述文本；无额外信息时 `undefined`。
 */
function descriptionOf(model: WireModel): string | undefined {
  const label = model.magpie_label?.trim()
  const name = displayNameOf(model)
  if (label === undefined || label.length === 0 || label === name) return undefined
  return label
}

/**
 * 转换输入模态。
 *
 * @param model - 线格式模型。
 * @returns 宿主模态数组；magpie 未声明时 `undefined`（宿主按「未知」处理，
 *   与「明确只支持文本」不同 —— 后者会让宿主主动把图片降级成占位文本）。
 */
function toInputModalities(model: WireModel): readonly ModelModality[] | undefined {
  const declared = model.modalities?.input
  if (!Array.isArray(declared) || declared.length === 0) return undefined
  const modalities: ModelModality[] = []
  if (declared.includes('text')) modalities.push('text')
  if (declared.includes('image')) modalities.push('image')
  // 只声明了未知模态（如未来新增 audio）：不猜，交给宿主按未知处理。
  return modalities.length === 0 ? undefined : Object.freeze(modalities)
}

/**
 * 转换思考档位。
 *
 * @param model - 线格式模型。
 * @returns 宿主思考信息；该模型不支持思考时 `undefined`（**必须**是
 *   `undefined` 而不是空 `efforts`，见 {@link toResolvedInfo} 的注释）。
 */
function toReasoning(
  model: WireModel,
): { efforts: Array<{ id: ReturnType<typeof ReasoningEffortId>; name: string }>; defaultEffort?: ReturnType<typeof ReasoningEffortId> } | undefined {
  const declared = reasoningLevelsOf(model)
  if (declared.length === 0) return undefined

  const sorted = [...declared].sort((left, right) => rankOf(left) - rankOf(right))
  const efforts = sorted.map((id) => ({
    id: ReasoningEffortId(id),
    name: REASONING_LABELS[id] ?? id,
  }))

  // 默认档位：magpie 没有「默认」概念，选**中位**而不是最强 ——
  // 最强档（`max`）在深度思考模型上会让首 token 延迟到分钟级，
  // 用它当默认等于给每个新会话加一次漫长等待。中位是「有思考但不慢」。
  const defaultEffort = efforts[Math.floor((efforts.length - 1) / 2)]!.id

  return { efforts, defaultEffort }
}

/**
 * 取模模型声明的思考档位 id 列表。
 *
 * 两条腿：`reasoning_levels`（字符串数组，magpie 新版）与
 * `supported_reasoning_levels`（`[{effort}]`，OpenAI 兼容形态）。
 *
 * @param model - 线格式模型。
 * @returns 去重后的档位 id；该模型不支持思考时为空数组。
 */
function reasoningLevelsOf(model: WireModel): string[] {
  const fromLevels = Array.isArray(model.reasoning_levels)
    ? model.reasoning_levels.filter((level): level is string => typeof level === 'string' && level.length > 0)
    : []
  if (fromLevels.length > 0) return [...new Set(fromLevels)]

  const fromSupported = Array.isArray(model.supported_reasoning_levels)
    ? model.supported_reasoning_levels
        .map((entry) => (typeof entry?.effort === 'string' ? entry.effort : undefined))
        .filter((effort): effort is string => effort !== undefined && effort.length > 0)
    : []
  if (fromSupported.length > 0) return [...new Set(fromSupported)]

  // 两条腿都空：`reasoning: true` 也不足以声明档位 —— 宿主需要**具体的
  // 档位 id** 才能渲染滑块，凭空造一个 `medium` 会发出上游不认的值。
  return []
}

/**
 * 档位在强弱序里的位置。
 *
 * 表外 id 排到**末尾**（位置 = 表长），保守做法：不猜测它的强度，
 * 只保证已知档位的相对顺序不被破坏。
 *
 * @param id - 档位 id。
 * @returns 排序键。
 */
function rankOf(id: string): number {
  const index = REASONING_LADDER.indexOf(id as (typeof REASONING_LADDER)[number])
  return index === -1 ? REASONING_LADDER.length : index
}

/**
 * 取第一个正整数字段。
 *
 * @param values - 候选值（按优先级）。
 * @returns 第一个正整数；全部无效时 `undefined`。
 */
function firstPositiveInt(...values: Array<number | undefined>): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  }
  return undefined
}

/**
 * 极简 glob 匹配（`*` 任意长、`?` 单字符）。
 *
 * ## 为什么不用 `minimatch` / `picomatch`
 *
 * 依赖体积与供应链成本远超收益：本插件只需要在**模型 id** 上做过滤，
 * 而模型 id 的字符集是 `[a-z0-9/._-]`，没有 `{}`、`[]`、`!` 这些
 * 扩展语法的需求。三行正则足够，且**没有正则注入风险**
 * （用户提供的 pattern 里除 `*` `?` 外的所有字符都被转义）。
 *
 * @param pattern - glob 模式。
 * @param value - 待匹配的模型 id。
 * @returns 命中则真。
 */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true
  if (!pattern.includes('*') && !pattern.includes('?')) return false
  const source = pattern
    .split('')
    .map((char) => {
      if (char === '*') return '[^]*'
      if (char === '?') return '[^]'
      // 其余字符全部转义：用户输入里的 `.` `+` `(` 等不能当元字符。
      return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  return new RegExp(`^${source}$`).test(value)
}
