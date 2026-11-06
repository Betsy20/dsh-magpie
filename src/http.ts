/**
 * Magpie 网关的 HTTP 传输层。
 *
 * 三件事，每件都有明确的存在理由：
 * 1. **统一发头** —— `attributionHeaders()` 是宿主的硬性要求（每个 provider
 *    请求都必须带），`Authorization` 与 `X-Magpie-Session` 的组装也在这里，
 *    避免每个调用点各写一遍。
 * 2. **错误归一化** —— magpie 转发上游错误，形态五花八门（`{error:{message}}`
 *    / `{error:"文案"}` / `{message}` / `{detail}` / 非 JSON 的纯文本）
 *    ⇒ 集中一个 `describeErrorBody()` 出口，任何新形态只改一处。
 * 3. **超时与取消** —— 用 `AbortSignal.any([signal, AbortSignal.timeout(ms)])`
 *    把调用方取消与超时合并成**一个**信号，超时与取消在语义上不可混淆
 *    （取消要归 `aborted`，超时要归 `TIMEOUT`），因此这里只做信号合成，
 *    分类交给调用方看 `signal.aborted`。
 *
 * @module dsh-magpie/http
 */

import { attributionHeaders, LlmError, type ProviderRequestId } from '@deepseek-ai/dsh-llm'
import { LOG_PREFIX } from './product.js'
import type { MagpieOptions } from './config.js'
import type { WireErrorBody } from './types.js'

/**
 * 一次失败的网关调用。
 *
 * 继承 `LlmError` 而不是自造错误类，是为了让 `LlmRuntime.adapterStream()`
 * 的 `normalizeLlmFailure()` 能原样取出 `code` / `status` /
 * `providerRetryAfterMs` —— 自造类的这些字段会被当成 `UNKNOWN`，
 * 于是 429 不再重试、配额耗尽不再提示。
 */
export class MagpieHttpError extends LlmError {
  /** HTTP 状态码；纯传输故障（DNS / 连接被拒）时为 `undefined`。 */
  readonly status: number | undefined
  /** 原始响应体文本（截断到 8 KiB，够看清错误，也不会把日志撑爆）。 */
  readonly body: string

  constructor(
    message: string,
    code: string,
    options: {
      status?: number
      body?: string
      providerRetryAfterMs?: number
      /**
       * 上游（或网关）给的请求 ID。
       *
       * 类型是 brand 过的 `ProviderRequestId` —— `LlmError` 只认这个。
       * 调用方通常拿到的是裸 `string`（HTTP 头的值），所以这里直接
       * 用构造签名兜住，免得到处 `as`。
       */
      requestId?: ProviderRequestId
      cause?: unknown
    } = {},
  ) {
    super(message, code, {
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.providerRetryAfterMs === undefined
        ? {}
        : { providerRetryAfterMs: options.providerRetryAfterMs }),
      ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    })
    this.status = options.status
    this.body = options.body ?? ''
  }
}

/**
 * 从响应体里提取**人类可读**的错误描述。
 *
 * ## 为什么需要这么多条腿
 *
 * magpie 是**转发**网关，错误体的形状由上游 provider 决定。实测与历史工程
 *（`C:/Users/Betsy/.dsh/plugin-src/dsh-providers-hub/src/openai-compat.ts:440`）
 * 里出现过至少五种：
 *
 * | 形态 | 例子 |
 * |---|---|
 * | `{error:{message}}` | OpenAI 标准 |
 * | `{error:"文案"}` | Cline 的地域限制 |
 * | `{message}` / `{msg}` | 部分国产上游 |
 * | `{detail}` / `{detail:{message}}` | 代理层包装 |
 * | `{code,message}` | 业务码 + 文案 |
 *
 * 只认其中一条时，其余形态会退化成「整段裸 JSON」，用户完全无法据此行动。
 *
 * @param text - 原始响应体文本。
 * @returns 可读错误描述；无法解析时返回原文（截断）。
 */
export function describeErrorBody(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return '(empty response body)'
  let data: unknown
  try {
    data = JSON.parse(trimmed)
  } catch {
    // 非 JSON：SSE 风格的错误帧、纯文本 502 页等，原文即是信息。
    return truncate(trimmed)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return truncate(trimmed)

  const body = data as WireErrorBody
  const parts: string[] = []

  const nestedMessage = (value: unknown): string | undefined => {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (typeof value === 'object' && value !== null) {
      const inner = (value as WireErrorBody).message
      if (typeof inner === 'string' && inner.trim().length > 0) return inner.trim()
    }
    return undefined
  }

  const fromError = nestedMessage(body.error)
  if (fromError !== undefined) parts.push(fromError)

  if (typeof body.message === 'string' && body.message.trim().length > 0) parts.push(body.message.trim())
  if (typeof (body as { msg?: unknown }).msg === 'string') {
    const msg = (body as { msg: string }).msg.trim()
    if (msg.length > 0) parts.push(msg)
  }
  if (typeof body.code === 'string' || typeof body.code === 'number') {
    // 业务码本身不是描述，但「code=10605」对排查是必要的锚点。
    if (parts.length === 0) parts.push(`code=${String(body.code)}`)
  }
  const fromDetail = nestedMessage(body.detail)
  if (fromDetail !== undefined && !parts.includes(fromDetail)) parts.push(fromDetail)

  if (parts.length === 0) return truncate(trimmed)
  return truncate(parts.join(': '))
}

/**
 * 把 HTTP 状态码映射为宿主的 provider 中性错误码。
 *
 * 词汇表来自 `@deepseek-ai/dsh-llm` 的 `DEFAULT_RETRYABLE_CODES`
 * （`EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `TIMEOUT` / `TRANSPORT`）
 * 与几个专用码（`AUTH` / `INVALID_REQUEST` / `CONTEXT_WINDOW_EXCEEDED` /
 * `QUOTA` / `ACCOUNT_QUOTA`）。
 *
 * ⚠️ **401/403 先判**，恒归 `AUTH` —— 这条铁律来自 `dsh-providers-hub`
 * 的 2026-10-06 事故（raccoon / loomy「一个请求内 6 个号各被封 24h」）：
 * 网关侧故障常在报文里捎带余额提示，若让额度判据抢先，真凭据失效会被
 * 说成「额度用尽」，用户被引向「等额度恢复」而不是重新登录。
 *
 * @param status - HTTP 状态码。
 * @param detail - 已提取的可读错误描述（用于识别上下文超限与额度耗尽措辞）。
 * @returns 宿主能路由的错误码。
 */
export function httpErrorCode(status: number, detail: string): string {
  if (status === 401 || status === 403) return 'AUTH'

  // 额度耗尽：magpie 会把上游的 `insufficient quota` / `balance exhausted`
  // 原样转发。归 `QUOTA` 而不是 `RATE_LIMIT`，因为重试不会好转。
  if (/\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail)) return 'QUOTA'
  if (/\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail)) return 'QUOTA'
  if (/\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)) return 'QUOTA'

  if (status === 429) return 'RATE_LIMIT'

  if (status === 400 || status === 413 || status === 422) {
    // 上下文超限必须归 `CONTEXT_WINDOW_EXCEEDED`：宿主据此触发
    // `dsh-compaction` 自动压缩并重试。归成 `INVALID_REQUEST` 会让长会话
    // 在接近窗口上限时直接中断，用户只能手动开新会话。
    if (
      /\bcontext[\s_-]*(?:length|window)[\s_-]*(?:exceed|overflow|limit)/i.test(detail) ||
      /\b(?:maximum|max)\s+(?:allowed\s+)?context\s+(?:length|window)\b/i.test(detail) ||
      /\b(?:input|prompt|request|messages?)\b.{0,40}\b(?:too\s+(?:long|large)|exceed(?:s|ed)?|overflows?)\b.{0,40}\bcontext\b/i.test(
        detail,
      )
    ) {
      return 'CONTEXT_WINDOW_EXCEEDED'
    }
    return 'INVALID_REQUEST'
  }

  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * 读取 `Retry-After` 响应头（秒数或 HTTP 日期）为毫秒。
 *
 * @param response - 失败的响应。
 * @returns 毫秒延迟；缺失或无法解析时 `undefined`。
 */
export function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after')
  if (raw === null || raw.length === 0) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 600_000)
  const at = Date.parse(raw)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, Math.min(at - Date.now(), 600_000))
}

/** 一次网关调用的公共参数。 */
export interface RequestContext {
  readonly options: MagpieOptions
  /** 构造 `Authorization` 用的 key。 */
  readonly apiKey: string
  /** 会话 id（`sessionHeader` 为真时写进 `X-Magpie-Session`）。 */
  readonly sessionId?: string | undefined
  /** 调用方取消信号。 */
  readonly signal?: AbortSignal | undefined
  /** 日志出口（仅用于非致命告警）。 */
  readonly logger?: { warn(message: string): void } | undefined
}

/**
 * 组装请求头。
 *
 * @param context - 调用上下文。
 * @param json - 是否声明 JSON 请求体（GET 不声明，避免某些代理把它当写请求）。
 * @returns 可直接交给 `fetch` 的 `Headers`。
 */
export function buildHeaders(context: RequestContext, json: boolean): Headers {
  // ⚠️ 宿主要求每个 provider 请求都带归属头。magpie 是本机网关，
  // 不存在华为 WAF 那种「按 UA 前缀拒发」的问题，故原样使用。
  const headers = new Headers(attributionHeaders())
  headers.set('authorization', `Bearer ${context.apiKey}`)
  headers.set('accept', json ? 'application/json' : 'text/event-stream')
  if (json) headers.set('content-type', 'application/json')
  if (context.options.sessionHeader && context.sessionId !== undefined && context.sessionId.length > 0) {
    // magpie 用这个 header 做会话粘性路由：同一会话固定打同一个上游账号，
    // 从而让上游的 prompt cache 真正命中（跨账号即失效）。
    headers.set('x-magpie-session', context.sessionId)
  }
  return headers
}

/**
 * 合成「调用方取消」与「超时」两个信号。
 *
 * @param signal - 调用方信号（可缺省）。
 * @param timeoutMs - 超时毫秒数；`0` 表示不超时。
 * @returns 合成信号，以及一个判断「是否由超时触发」的谓词。
 */
export function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; timedOut: () => boolean } {
  if (timeoutMs <= 0) return { signal, timedOut: () => false }
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return { signal: timeout, timedOut: () => timeout.aborted }
  // `AbortSignal.any` 在 Node 20.3+ / 24 上都可用；本插件 engines 要求 >=22.19。
  return { signal: AbortSignal.any([signal, timeout]), timedOut: () => timeout.aborted }
}

/**
 * 发一个非流式请求并解析 JSON。
 *
 * @param context - 调用上下文。
 * @param path - 以 `/` 开头的路径（如 `/v1/models`）。
 * @param init - 额外的 fetch 参数（method / body）。
 * @typeParam T - 期望的响应体类型（**不做运行时校验**，由调用方按 wire 类型兜底）。
 * @returns 解析后的响应体。
 * @throws MagpieHttpError 传输失败、超时或非 2xx。
 */
export async function requestJson<T>(
  context: RequestContext,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const url = `${context.options.baseURL}${path}`
  const { signal, timedOut } = combineSignals(context.signal, context.options.requestTimeoutMs)
  const headers = buildHeaders(context, init.body !== undefined)

  let response: Response
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    throw transportError(url, error, timedOut(), context.signal)
  }

  const text = await response.text()
  if (!response.ok) {
    const detail = describeErrorBody(text)
    const retryAfter = retryAfterMs(response)
    throw new MagpieHttpError(
      `${LOG_PREFIX} ${url} 返回 HTTP ${response.status}：${detail}`,
      httpErrorCode(response.status, detail),
      {
        status: response.status,
        body: truncate(text),
        ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
      },
    )
  }

  if (text.trim().length === 0) {
    // magpie 的管理接口在「无数据」时会回空体（而非 `{}`），
    // 调用方按可选字段处理即可。
    return {} as T
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new MagpieHttpError(
      `${LOG_PREFIX} ${url} 返回了无法解析的 JSON：${truncate(text, 200)}`,
      'SERVER',
      { status: response.status, body: truncate(text) },
    )
  }
}

/**
 * 发一个流式请求，返回原始 `Response`（由 `sse.ts` 消费）。
 *
 * @param context - 调用上下文。
 * @param path - 以 `/` 开头的路径。
 * @param body - JSON 请求体。
 * @returns 已确认 2xx 的响应。
 * @throws MagpieHttpError 传输失败、超时或非 2xx（**包括** HTTP 200 之外的一切）。
 */
export async function requestStream(
  context: RequestContext,
  path: string,
  body: unknown,
): Promise<Response> {
  const url = `${context.options.baseURL}${path}`
  // ⚠️ 这个超时**只**管「拿到响应头」这一段，拿到之后必须撤掉。
  //
  // 不能把 `combineSignals(...)` 的 signal 直接交给 fetch 就不管：fetch 的
  // signal 在**响应体读取期间**同样生效，`requestTimeoutMs`（默认 10 秒）一到
  // 就会把整个流式响应中止 —— 实测报
  // `DOMException [TimeoutError]: The operation was aborted due to timeout`，
  // 而且长回复（深度思考）必然踩中。首字节之后的空闲超时由 `sse.ts` 逐块
  // 看门（`streamIdleTimeoutMs`），两段超时**职责不重叠**。
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, context.options.requestTimeoutMs)
  // `unref` 让这个定时器不阻止进程退出（CLI / 一次性脚本场景下很重要）。
  timer.unref?.()

  const signal =
    context.signal === undefined
      ? controller.signal
      : AbortSignal.any([context.signal, controller.signal])

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(context, true),
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    throw transportError(url, error, timedOut, context.signal)
  } finally {
    // 响应头已到（或请求已失败）：撤掉定时器，body 的读取不再受它约束。
    clearTimeout(timer)
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const detail = describeErrorBody(text)
    const retryAfter = retryAfterMs(response)
    throw new MagpieHttpError(
      `${LOG_PREFIX} ${url} 返回 HTTP ${response.status}：${detail}`,
      httpErrorCode(response.status, detail),
      {
        status: response.status,
        body: truncate(text),
        ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
      },
    )
  }
  return response
}

/**
 * 把 fetch 的抛错归一化为可路由的 `MagpieHttpError`。
 *
 * ## 为什么要区分「取消」与「超时」
 *
 * 两者在 `fetch` 看来都是 `AbortError`，但语义完全不同：
 * - **取消**（用户点了停止 / 会话被中断）⇒ `ABORTED`，**不得重试**；
 * - **超时**（网关卡住）⇒ `TIMEOUT`，**应当重试**（在 `DEFAULT_RETRYABLE_CODES` 里）。
 *
 * 判据是 `callerSignal.aborted`（调用方主动取消）而不是 `timedOut`：
 * 后者只在合成信号里成立，而 `fetch` 抛错时两者可能都已 abort，
 * 以「调用方是否先动手」为准更贴近用户意图。
 *
 * @param url - 请求地址（写进 message）。
 * @param error - `fetch` 抛出的值。
 * @param timedOut - 合成信号是否由超时触发。
 * @param callerSignal - 调用方原始信号。
 * @returns 归一化后的错误。
 */
function transportError(
  url: string,
  error: unknown,
  timedOut: boolean,
  callerSignal: AbortSignal | undefined,
): MagpieHttpError {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  if (callerSignal?.aborted === true) {
    return new MagpieHttpError(`${LOG_PREFIX} 请求已取消：${url}`, 'ABORTED', { cause: error })
  }
  if (timedOut) {
    return new MagpieHttpError(
      `${LOG_PREFIX} 请求超时：${url}（magpie 网关可能没在运行，检查 ~/.config/magpie/settings.json 的 port）`,
      'TIMEOUT',
      { cause: error },
    )
  }
  // 连接被拒 / DNS 失败 / TLS 失败：都是「网关不可达」，归 TRANSPORT（可重试）。
  return new MagpieHttpError(
    `${LOG_PREFIX} 无法连接 magpie 网关 ${url}：${text}。请确认 magpie 正在运行（默认端口 3425）`,
    'TRANSPORT',
    { cause: error },
  )
}

/**
 * 截断长文本，保留头尾。
 *
 * 只留头会让「栈底的真实原因」丢失，只留尾会丢掉「哪个请求失败」，
 * 因此两头都留。
 *
 * @param text - 原始文本。
 * @param max - 上限字符数。
 * @returns 截断后的文本。
 */
export function truncate(text: string, max = 8 * 1024): string {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${text.slice(0, head)}\n…（已截断 ${text.length - max} 字符）…\n${text.slice(text.length - tail)}`
}
