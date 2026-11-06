/**
 * magpie 网关的 {@link LlmAdapter} 实现。
 *
 * ## 职责
 *
 * 把 DSH 的 `GenerateOptions` 翻译成一次 `POST /v1/chat/completions`
 * （`stream:true`），再把 magpie 的 SSE 增量翻译回 DSH 的
 * {@link StreamChunk} 词汇。
 *
 * ## 为什么是「动态」适配器
 *
 * magpie 的模型目录是**运行时**拼出来的：20 个模型的 id、上下文窗口、
 * 思考档位、是否支持图片全都来自 `GET /v1/models`，且会随用户在 magpie
 * 里增删 provider 而变。把目录**硬编码**进插件（像 `cordis.patch.yml` 里
 * 原来那段 `llm-pi-ai` 配置那样）意味着每加一个上游都要改配置重启。
 * 因此：
 *
 * - `listModels()` 走 {@link ModelCatalog}（带 TTL 缓存）；
 * - `resolveModel()` 也从同一份目录取元数据；
 * - 未收录的 id **不报错**（历史会话里可能存着已被删掉的模型），
 *   退化成最小信息让请求照发，由 magpie 自己给出可读错误。
 *
 * ## 块索引分配
 *
 * DSH 的流式协议要求 `block-start` → `*-delta`* → `block-end`，
 * 每块有稳定 `index`。magpie 的增量**没有块概念**，只有
 * `reasoning_content` / `content` / `tool_calls[i]` 三条互不同步的流，
 * 且**同一个 chunk 可以同时携带两条**（实测，见 `types.ts`）。
 * 因此本模块负责在不丢失内容的前提下分配索引：
 *
 * | 块类型 | 索引分配时机 |
 * |---|---|
 * | `reasoning` | 第一个 `reasoning_content` 增量到达时，取最小可用索引 |
 * | `text` | 第一个 `content` 增量到达时（此时先关闭 reasoning 块） |
 * | `tool-call` | 每个 magpie 的 `tool_calls[i].index` 各占一个索引 |
 *
 * 关闭时机：块类型切换时关闭「不可能再增长」的前序块
 * （reasoning → text → tool-call 是单调推进的），其余在流结束时统一关闭。
 * 这样即使上游在正文中间插入工具调用（不合法但会发生），
 * 也不会出现「往已关闭块里追加增量」而被装配器丢弃。
 *
 * @module dsh-magpie/adapter
 */

import {
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ToolCallId,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type ModelModality,
  type PreparedAdapterCall,
  type ResolvedRetryPolicy,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { ModelCatalog } from './catalog.js'
import { resolveApiKey, type MagpieOptions } from './config.js'
import { requestStream, type RequestContext } from './http.js'
import { toWireMessages } from './messages.js'
import { DISPLAY_NAME, LOG_PREFIX, PROVIDER } from './product.js'
import { parseSse, parseSseJson } from './sse.js'
import type {
  WireChatRequest,
  WireErrorBody,
  WireStreamChunk,
  WireToolCallDelta,
  WireUsage,
} from './types.js'

/**
 * 适配器依赖。
 *
 * 全部经构造函数注入而非直接 `ctx` —— 本类是**纯逻辑**，
 * 不碰 cordis 生命周期，因此可以脱离宿主单测（`tests/adapter.spec.ts`）。
 */
export interface MagpieAdapterOptions {
  /** 模型目录（带缓存）。 */
  readonly catalog: ModelCatalog
  /** 读当前配置（每次调用都读，热重载才生效）。 */
  readonly options: () => MagpieOptions
  /**
   * 图片读取器（`ctx.attachments.readImage` 的桥接）。
   *
   * `undefined` 表示宿主没装附件服务 —— 此时收到图片只会得到占位文本，
   * **不会**让请求失败。
   */
  readonly readImage?: ((attachment: unknown) => Promise<string>) | undefined
  /** 日志出口。 */
  readonly logger?: { warn(message: string): void } | undefined
}

/**
 * 一个正在累积的工具调用块。
 *
 * `name` 可能一直是 `undefined`（上游在首个片段里给 name，但格式错误的
 * 流可能从头到尾都不给），因此在 `block-end` 时要用兜底名。
 */
interface ToolCallState {
  /** DSH 侧块索引。 */
  readonly blockIndex: number
  /** 上游给的 call id（首个片段携带，之后省略）。 */
  readonly id: string
  /** 工具名（首个片段携带）。 */
  name: string | undefined
  /** 累积的原始 JSON 字符串。 */
  readonly arguments: string[]
}

/** 流式状态机。 */
interface StreamState {
  /** 下一个可用块索引。 */
  nextIndex: number
  /** reasoning 块的索引（未出现时 `undefined`）。 */
  reasoningIndex: number | undefined
  /** reasoning 块是否已关闭。 */
  reasoningClosed: boolean
  /** text 块的索引（未出现时 `undefined`）。 */
  textIndex: number | undefined
  /** text 块是否已关闭。 */
  textClosed: boolean
  /** 按 magpie 的 `tool_calls[].index` 索引。 */
  readonly toolCalls: Map<number, ToolCallState>
  /** 是否收到过任何内容（用于判 `EMPTY_RESPONSE`）。 */
  sawContent: boolean
  /**
   * 是否出现过工具调用。
   *
   * 必须单独记：{@link closeToolCalls} 会把 `toolCalls` 清空，而
   * `finish_reason` 的判定在关闭之后 —— 只看 map 大小会恒为 0。
   */
  sawToolCall: boolean
  /** 上游给的 `finish_reason`。 */
  finishReason: string | undefined
  /** 上游给的 usage。 */
  usage: TokenUsage | undefined
}

/**
 * magpie 适配器。
 *
 * 一个实例服务一个 provider 路由（`magpie`）。
 */
export class MagpieAdapter extends LlmAdapter {
  constructor(private readonly deps: MagpieAdapterOptions) {
    super()
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * @param provider - 注册时传入的路由名。
   * @returns 显示元数据（`id` 必须等于 `provider`，否则宿主抛 `INVALID_ADAPTER`）。
   */
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: DISPLAY_NAME }
  }

  /**
   * 声明重试策略。
   *
   * ⚠️ **声明即替换默认集**。宿主默认的
   * `['EMPTY_RESPONSE','RATE_LIMIT','SERVER','TIMEOUT','TRANSPORT']`
   * 已经是对的（magpie 会把上游的 429 / 5xx 原样透传），因此这里显式
   * 保留全部五项 —— 少写 `RATE_LIMIT` 会让 429 从「重试 5 次」变成
   * 「立刻失败」，而订阅型上游的限流恰恰是最常见、最值得重试的错误。
   *
   * @param _provider - 路由名（本适配器只有一套策略）。
   * @returns 不可变重试策略。
   */
  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return Object.freeze({
      mode: 'normal' as const,
      maxRetries: 5,
      retryableCodes: Object.freeze([
        'EMPTY_RESPONSE',
        'RATE_LIMIT',
        'SERVER',
        'TIMEOUT',
        'TRANSPORT',
      ]),
      initialDelayMs: 2000,
      maxDelayMs: 10_000,
      jitterRatio: 0.25,
    }) satisfies ResolvedRetryPolicy
  }

  /**
   * 列出 magpie 目录里的全部模型。
   *
   * @param provider - 路由名（写进每条的 `provider` 字段）。
   * @returns 模型目录（`LlmModelInfo` 子集，不含 context / reasoning）。
   */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const snapshot = await this.deps.catalog.get()
    return snapshot.models.map((model) => ({
      provider,
      id: model.id,
      name: model.name,
      ...(model.description === undefined ? {} : { description: model.description }),
      ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
    }))
  }

  /**
   * 解析一个模型的全部元数据。
   *
   * 未收录的 id **不抛错**：历史会话里可能存着已被删除的模型，抛错会让
   * 整个会话无法继续。退化成最小信息，把「模型不存在」留给 magpie 用
   * 它自己的可读错误说明。
   *
   * @param provider - 路由名。
   * @param model - 精确模型 id。
   * @param _signal - 取消信号（本实现是内存查找，忽略）。
   * @returns 解析后的模型信息。
   */
  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const snapshot = await this.deps.catalog.get()
    const entry = snapshot.models.find((candidate) => candidate.id === model)
    if (entry !== undefined) return { ...entry, provider }

    this.deps.logger?.warn(
      `${LOG_PREFIX} 模型 ${model} 不在 magpie 目录里（可能是已删除的上游）；`
        + '将按最小信息发起请求，由 magpie 给出具体错误。',
    )
    return { provider, id: model, name: model }
  }

  /**
   * 绑定「模型元数据」与「请求派发」到同一份目录代际。
   *
   * 覆写基类默认实现是**必须的**：基类会分别调 `resolveModel()` 与
   * `stream()`，而 `stream()` 内部又要再查一次目录 —— 若两次之间目录
   * 被刷新，就会出现「用一个模型的 image 能力去序列化另一个模型的请求」
   * 这种错配。
   *
   * @param provider - 路由名。
   * @param model - 精确模型 id。
   * @param signal - 取消信号。
   * @returns 模型元数据 + 绑定的派发函数。
   */
  override async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<PreparedAdapterCall> {
    const resolved = await this.resolveModel(provider, model, signal)
    return {
      model: resolved,
      stream: (options: GenerateOptions) => this.stream(options, resolved),
    }
  }

  /**
   * 流式执行一次模型调用。
   *
   * @param options - 完整请求。
   * @param prepared - 已解析的模型元数据（`prepareCall()` 传入）。
   *   直接调 `stream()` 时缺省，退化为现场解析。
   * @returns DSH 流式块。
   */
  override async *stream(
    options: GenerateOptions,
    prepared?: LlmResolvedModelInfo,
  ): AsyncIterable<StreamChunk> {
    const resolved =
      prepared ?? (await this.resolveModel(options.provider, options.model, options.signal))
    const settings = this.deps.options()

    // ---- 1. 组装请求 ----------------------------------------------------
    // 只有模型声明支持图片时才接图片读取器：否则 `toWireMessages` 会把
    // 图片降级成占位文本（那是**正确**行为，而不是「读不到就报错」）。
    const supportsImage = resolved.inputModalities?.includes('image' satisfies ModelModality) === true
    const messages = await toWireMessages(options.messages, {
      system: options.system,
      readImage: supportsImage ? this.deps.readImage : undefined,
    })

    const body: WireChatRequest = {
      model: options.model,
      messages,
      stream: true,
      // 让 magpie 在最后一个 chunk 里带上 usage。实测 magpie **忽略**这个
      // 开关（无论传不传都发 usage），但显式声明是 OpenAI 协议的正确用法，
      // 也让将来换成真网关时不会静默丢掉 token 统计。
      stream_options: { include_usage: true },
      ...(options.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: String(options.reasoningEffort) }),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
      ...(options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop }),
      ...(options.tools === undefined || options.tools.length === 0
        ? {}
        : {
            tools: options.tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }),
    }

    const context: RequestContext = {
      options: settings,
      apiKey: resolveApiKey(settings),
      sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
      signal: options.signal,
      logger: this.deps.logger,
    }

    // ---- 2. 发请求 ------------------------------------------------------
    // 请求失败（连不上 / 非 2xx）在这里就抛：`adapterStream` 会把它包成
    // 终态 `finish` 块，DSH 的重试策略据此决定是否重发。
    const response = await requestStream(context, '/v1/chat/completions', body)
    const responseBody = response.body
    if (responseBody === null) {
      throw new LlmError(
        `${LOG_PREFIX} 网关返回了空响应体（HTTP ${response.status}）`,
        EMPTY_RESPONSE_CODE,
      )
    }

    // ---- 3. 消费 SSE ----------------------------------------------------
    const state: StreamState = {
      nextIndex: 0,
      reasoningIndex: undefined,
      reasoningClosed: false,
      textIndex: undefined,
      textClosed: false,
      toolCalls: new Map(),
      sawContent: false,
      sawToolCall: false,
      finishReason: undefined,
      usage: undefined,
    }
    /** 各块已累积的文本（用于 `block-end` 时组装最终块）。 */
    const reasoningText: string[] = []
    const textText: string[] = []

    for await (const event of parseSse(responseBody, {
      idleTimeoutMs: settings.streamIdleTimeoutMs,
      signal: options.signal,
    })) {
      const parsed = parseSseJson(event.data)
      if (parsed === undefined) continue
      if (parsed === 'done') break

      const chunk = parsed as WireStreamChunk

      // magpie 在 HTTP 200 的流里内嵌错误的形态：必须显式识别，
      // 否则会被当成「空增量」静默跳过，用户看到的是「模型没回话」。
      if (chunk.error !== undefined && chunk.error !== null) {
        throw new LlmError(
          `${LOG_PREFIX} 流内错误：${describeChunkError(chunk.error)}`,
          'SERVER',
        )
      }

      for (const choice of chunk.choices ?? []) {
        const delta = choice.delta
        if (delta !== undefined) {
          // ---- reasoning ----
          const reasoning = delta.reasoning_content
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            if (state.reasoningIndex === undefined) {
              state.reasoningIndex = state.nextIndex++
              yield { type: 'block-start', index: state.reasoningIndex, blockType: 'reasoning' }
            }
            state.sawContent = true
            reasoningText.push(reasoning)
            yield { type: 'reasoning-delta', index: state.reasoningIndex, text: reasoning }
          }

          // ---- text ----
          const text = delta.content
          if (typeof text === 'string' && text.length > 0) {
            // 正文开始意味着思考结束：先关 reasoning 块。不关也不会错，
            // 但会让 UI 的「思考中」状态一直挂到流结束。
            for (const closed of closeReasoning(state, reasoningText)) yield closed
            if (state.textIndex === undefined) {
              state.textIndex = state.nextIndex++
              yield { type: 'block-start', index: state.textIndex, blockType: 'text' }
            }
            state.sawContent = true
            textText.push(text)
            yield { type: 'text-delta', index: state.textIndex, text }
          }

          // ---- tool calls ----
          for (const call of delta.tool_calls ?? []) {
            state.sawContent = true
            state.sawToolCall = true
            for (const closed of closeReasoning(state, reasoningText)) yield closed
            for (const closed of closeText(state, textText)) yield closed
            const opened = openToolCall(state, call)
            if (opened.start !== undefined) yield opened.start
            yield opened.delta
          }
        }

        if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
          state.finishReason = choice.finish_reason
        }
      }

      if (chunk.usage !== undefined && chunk.usage !== null) {
        state.usage = toTokenUsage(chunk.usage)
      }
    }

    // ---- 4. 收尾 --------------------------------------------------------
    // 一条内容都没有：上游给了「空完成」。报 `EMPTY_RESPONSE` 让 DSH 重试 ——
    // 静默结束会让这一轮既没有回复也没有错误，用户只看到界面卡住。
    if (!state.sawContent) {
      throw new LlmError(
        `${LOG_PREFIX} 模型 ${options.model} 返回了空响应（finish_reason=${state.finishReason ?? 'none'}）`,
        EMPTY_RESPONSE_CODE,
      )
    }

    for (const closed of closeReasoning(state, reasoningText)) yield closed
    for (const closed of closeText(state, textText)) yield closed
    for (const closed of closeToolCalls(state)) yield closed

    if (state.usage !== undefined) yield { type: 'usage', usage: state.usage }

    yield { type: 'finish', reason: toFinishReason(state) }
  }
}

/**
 * 关闭 reasoning 块（若开着）。
 *
 * @param state - 流状态（原地更新）。
 * @param parts - 已累积的思考文本。
 * @returns 需要发出的块（`block-end` 或空）。
 */
function* closeReasoning(state: StreamState, parts: readonly string[]): Generator<StreamChunk> {
  if (state.reasoningIndex === undefined || state.reasoningClosed) return
  state.reasoningClosed = true
  yield {
    type: 'block-end',
    index: state.reasoningIndex,
    block: { type: 'reasoning', text: parts.join('') },
  }
}

/**
 * 关闭 text 块（若开着）。
 *
 * @param state - 流状态（原地更新）。
 * @param parts - 已累积的正文。
 * @returns 需要发出的块。
 */
function* closeText(state: StreamState, parts: readonly string[]): Generator<StreamChunk> {
  if (state.textIndex === undefined || state.textClosed) return
  state.textClosed = true
  yield {
    type: 'block-end',
    index: state.textIndex,
    block: { type: 'text', text: parts.join('') },
  }
}

/**
 * 关闭全部未关闭的工具调用块。
 *
 * 工具名缺失时用 `unknown_tool` 兜底：`block-end` 的 `ToolCallBlock`
 * 要求 `name` 是非空字符串，用空串会让装配器产出无法执行的调用，
 * 而一个明确叫「未知工具」的调用至少能让模型看到错误并重试。
 *
 * @param state - 流状态。
 * @returns 需要发出的块。
 */
function* closeToolCalls(state: StreamState): Generator<StreamChunk> {
  for (const call of state.toolCalls.values()) {
    yield {
      type: 'block-end',
      index: call.blockIndex,
      block: {
        type: 'tool-call',
        id: ToolCallId(call.id),
        name: call.name !== undefined && call.name.length > 0 ? call.name : 'unknown_tool',
        arguments: call.arguments.join(''),
      },
    }
  }
  state.toolCalls.clear()
}

/**
 * 处理一个工具调用增量。
 *
 * 首次见到某个 `index` 时分配块并发出 `block-start`；后续增量只发
 * `tool-call-delta`。`id` 与 `name` 只在首个片段上出现，因此必须在
 * 状态里记住 —— `tool-call-delta` 的 `id` 字段每次都是必填的。
 *
 * @param state - 流状态（原地更新）。
 * @param call - 上游增量。
 * @returns 可选的首块声明，以及必发的增量。
 */
function openToolCall(
  state: StreamState,
  call: WireToolCallDelta,
): { start: StreamChunk | undefined; delta: StreamChunk } {
  const wireIndex = typeof call.index === 'number' ? call.index : 0
  let toolCall = state.toolCalls.get(wireIndex)

  if (toolCall === undefined) {
    const blockIndex = state.nextIndex++
    // 上游没给 id 时自造一个**稳定**的 id：同一 index 的后续增量必须
    // 复用同一个 id，否则装配器会把一次调用拆成多个。
    const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : `magpie_call_${wireIndex}`
    toolCall = {
      blockIndex,
      id,
      name: typeof call.function?.name === 'string' ? call.function.name : undefined,
      arguments: [],
    }
    state.toolCalls.set(wireIndex, toolCall)
    const name = toolCall.name
    const fragment = call.function?.arguments
    if (typeof fragment === 'string' && fragment.length > 0) toolCall.arguments.push(fragment)
    return {
      start: { type: 'block-start', index: blockIndex, blockType: 'tool-call' },
      delta: {
        type: 'tool-call-delta',
        index: blockIndex,
        id: ToolCallId(id),
        ...(name === undefined ? {} : { name }),
        argumentsDelta: typeof fragment === 'string' ? fragment : '',
      },
    }
  }

  // 后续片段：偶尔会补发 name（上游 bug），补上而不是丢掉。
  if (toolCall.name === undefined && typeof call.function?.name === 'string') {
    toolCall.name = call.function.name
  }
  const fragment = call.function?.arguments
  if (typeof fragment === 'string' && fragment.length > 0) toolCall.arguments.push(fragment)
  return {
    start: undefined,
    delta: {
      type: 'tool-call-delta',
      index: toolCall.blockIndex,
      id: ToolCallId(toolCall.id),
      ...(typeof call.function?.name === 'string' ? { name: call.function.name } : {}),
      argumentsDelta: typeof fragment === 'string' ? fragment : '',
    },
  }
}

/**
 * magpie 的 `finish_reason` → DSH 的终态原因。
 *
 * 映射表（magpie 用 **snake_case**，DSH 用 **kebab-case**，别抄错）：
 *
 * | magpie | DSH |
 * |---|---|
 * | `tool_calls` | `tool-calls` |
 * | `length` | `max-tokens` |
 * | `stop` | `stop` |
 * | `content_filter` | `stop`（DSH 没有对应概念，且内容确实结束了） |
 * | 缺失 | 有工具调用则 `tool-calls`，否则 `stop` |
 *
 * ⚠️ **有工具调用时必须报 `tool-calls`**：报 `stop` 会让 DSH 认为本轮
 * 正常结束而不去执行工具，模型就会反复重发同样的调用直到步数耗尽。
 * 反过来，**没有**工具调用时绝不能报 `tool-calls` —— 那会让宿主空执行
 * 一次不存在的调用。
 *
 * @param state - 流状态。
 * @returns 终态原因。
 */
function toFinishReason(state: StreamState): FinishReason {
  switch (state.finishReason) {
    case 'tool_calls':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      // `stop` / `content_filter` / 缺失 / 未知值：靠「是否真的有调用」
      // 决定，而不是靠上游那个可能说谎的字符串。
      return state.sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' }
  }
}

/**
 * magpie 的 usage → DSH 的 {@link TokenUsage}。
 *
 * ⚠️⚠️ **计数语义不同**：DSH 的 `inputTokens` 是 **DISJOINT** 的 ——
 * 只含**未命中缓存**的部分，命中部分单列在 `cacheReadTokens`。
 * magpie（OpenAI 形态）的 `prompt_tokens` 是**含缓存**的总量。
 * 直接照抄会让缓存命中率显示偏大、成本估算偏高。
 *
 * @param usage - 上游 usage。
 * @returns DSH usage（缺省字段不出现，而非填 0）。
 */
function toTokenUsage(usage: WireUsage): TokenUsage {
  const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0
  const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0
  const cachedTokens =
    typeof usage.prompt_tokens_details?.cached_tokens === 'number'
      ? usage.prompt_tokens_details.cached_tokens
      : 0
  const reasoningTokens =
    typeof usage.completion_tokens_details?.reasoning_tokens === 'number'
      ? usage.completion_tokens_details.reasoning_tokens
      : 0

  // `Math.max(0, …)` 不是防御性废话：某些上游会给出
  // `cached_tokens > prompt_tokens`（把两次请求的缓存拼在一起上报），
  // 减出负数会让宿主的用量校验抛错。
  const inputTokens = cachedTokens > 0 ? Math.max(0, promptTokens - cachedTokens) : promptTokens

  return {
    inputTokens,
    outputTokens: completionTokens,
    ...(typeof usage.total_tokens === 'number' ? { totalTokens: usage.total_tokens } : {}),
    ...(cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  }
}

/**
 * 从流内错误体里提取可读文本。
 *
 * @param error - magpie 内嵌错误体。
 * @returns 可读消息（保证非空）。
 */
function describeChunkError(error: NonNullable<WireStreamChunk['error']>): string {
  // 用局部变量而不是反复 `error.error.…`：可选属性的链式收窄在
  // `string | WireErrorBody | undefined` 这种联合上不可靠。
  const nested: unknown = error.error
  if (typeof nested === 'string' && nested.length > 0) return nested
  if (typeof nested === 'object' && nested !== null) {
    const message = (nested as WireErrorBody).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  if (typeof error.message === 'string' && error.message.length > 0) return error.message
  if (typeof error.code === 'string' && error.code.length > 0) return error.code
  return JSON.stringify(error)
}

/** 供测试与面板使用的 provider 常量重导出。 */
export { PROVIDER }

/**
 * 供测试使用的用量换算重导出。
 *
 * ## 为什么要暴露它
 *
 * 宿主的 `TokenUsage` 是**互斥计数**（`inputTokens` 只含未命中缓存的部分），
 * 而 OpenAI 兼容协议的 `prompt_tokens` 是**总量**。两者差一个 `cached_tokens`
 * 的减法，做错了不会报错，只会让用量面板上的输入 token 数悄悄偏大 ——
 * 这种错只有单测能抓住。
 */
export { toTokenUsage as __toTokenUsageForTest }
