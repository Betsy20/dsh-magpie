/**
 * Server-Sent Events 解析。
 *
 * ## 为什么不用现成库
 *
 * 看起来「读 `data:` 行」很简单，但真正要处理的是**字节流语义**，不是行：
 * - `TextDecoder` 必须开 `{ stream: true }` 才能正确切分跨 chunk 的 UTF-8
 *   多字节字符（中文正文必然跨 chunk —— 一个汉字 3 字节，chunk 边界随机）。
 *   不开 streaming 时会出现「半个汉字」变成 U+FFFD，且**只在中文回答里偶发**。
 * - 换行有 `\r\n` / `\n` / `\r` 三种（本机 magpie 是 `\n`，但不能假设）。
 * - 一个事件可以有多行 `data:`，按规范以 `\n` 拼接。
 * - 注释行（以 `:` 开头）是心跳，必须丢弃而不是当数据。
 * - `[DONE]` 是**数据行的内容**，不是独立的控制帧。
 *
 * ## 空闲超时
 *
 * 深度思考模型在长篇推理时可能 60 秒不出一个 token，但**连接仍然健康**；
 * 而网关挂死时连接也会静静躺着。两者在 socket 层无法区分，只能用
 * 「两个 chunk 之间的最长间隔」这个**应用层**判据 —— 即
 * `streamIdleTimeoutMs`（默认 600 秒，与既有 `llm-pi-ai` 配置同值）。
 *
 * ## 状态机
 *
 * 逐行喂入 {@link SseDecoder}，它负责累积多行 `data:` 并在**空行**处
 * 产出一个事件。解码器是纯同步的，因此可以脱离流单独测试。
 *
 * @module dsh-magpie/sse
 */

/**
 * `reader.read()` 的返回形状。
 *
 * 不用全局的 `ReadableStreamReadResult`：`tsconfig` 里 `lib` 只有
 * `ES2023`，该名字来自 DOM/Web 全局声明，在纯 Node 工程里**不在作用域内**。
 * 从 `read` 的签名反推既准确又不会随 lib 配置漂移。
 */
type ReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>

/** 一个 SSE 事件。 */
export interface SseEvent {
  /** `event:` 字段；缺省时为空串（SSE 规范的默认事件类型）。 */
  readonly event: string
  /** `data:` 字段按 `\n` 拼接后的载荷（**不含**开头的 `data: ` 前缀）。 */
  readonly data: string
}

/** 解析器选项。 */
export interface SseOptions {
  /** 两个 chunk 之间的最长间隔，毫秒。`<= 0` 表示不设空闲超时。 */
  readonly idleTimeoutMs?: number
  /** 调用方取消信号。 */
  readonly signal?: AbortSignal | undefined
  /**
   * SSE 规范用空行分隔事件。有些网关（以及 magpie 的某些上游）会在
   * `data:` 之后**直接**跟下一行而省略空行 —— 此时若严格按规范等待空行，
   * 整个流会一直等到连接关闭才一次性吐出，表现为「回答卡住直到结束」。
   *
   * 打开这个开关后，**遇到新的 `data:` 行时先把上一条已完成的 data 作为
   * 事件吐出**（按行即事件）。magpie 实测是**规范**形态（有空行），
   * 因此默认关闭。
   */
  readonly lineDelimited?: boolean
}

/**
 * 同步的 SSE 行解码器。
 *
 * 用法：把解码后的文本按行喂给 {@link push}，它返回本次新产出的事件数组；
 * 流结束时调 {@link flush} 取走残留事件。
 */
export class SseDecoder {
  private buffer = ''
  private dataLines: string[] = []
  private eventName = ''
  private sawField = false

  constructor(private readonly lineDelimited = false) {}

  /**
   * 喂入一段**已解码**的文本。
   *
   * @param text - 解码后的文本片段（可以是以任意位置切开的一段）。
   * @returns 本次产出的事件（可能 0 个或多个）。
   */
  push(text: string): SseEvent[] {
    const events: SseEvent[] = []
    // 先把 `\r\n` 折成 `\n`；孤立的 `\r` 在下面按行处理时兜底。
    this.buffer += text.replace(/\r\n/g, '\n')

    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      this.consumeLine(line, events)
      index = this.buffer.indexOf('\n')
    }
    return events
  }

  /**
   * 流结束：把残留的半行与未闭合的事件吐出来。
   *
   * @returns 收尾事件（可能为空数组）。
   */
  flush(): SseEvent[] {
    const events: SseEvent[] = []
    if (this.buffer.length > 0) {
      // 没有以换行结尾的最后一行：有些网关在 `[DONE]` 之后直接关流。
      const line = this.buffer.replace(/\r$/, '')
      this.buffer = ''
      this.consumeLine(line, events)
    }
    const pending = this.takeEvent()
    if (pending !== undefined) events.push(pending)
    return events
  }

  /**
   * 处理一行。
   *
   * @param line - 一行（不含换行符）。
   * @param events - 产出事件的收集器。
   */
  private consumeLine(line: string, events: SseEvent[]): void {
    // 空行 = 事件分隔符。
    if (line.length === 0) {
      const event = this.takeEvent()
      if (event !== undefined) events.push(event)
      return
    }
    // 注释 / 心跳（`: keep-alive` 之类）。
    if (line.startsWith(':')) return

    const colon = line.indexOf(':')
    // 规范：无冒号的行是「字段名为整行、值为空串」。
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    // 规范：值前**只有一个**可选空格要去掉（多打的空格属于值）。
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data' && this.lineDelimited && this.dataLines.length > 0) {
      // 行即事件模式：上一条 data 先结账。
      const event = this.takeEvent()
      if (event !== undefined) events.push(event)
    }

    switch (field) {
      case 'data':
        this.dataLines.push(value)
        this.sawField = true
        break
      case 'event':
        this.eventName = value
        this.sawField = true
        break
      case 'id':
      case 'retry':
      case 'comment':
        // 本适配器不需要重连游标与重试间隔（重试由宿主的 retry policy 统一管），
        // 但见到它们说明「这是一个合法事件字段」，因此也标记。
        this.sawField = true
        break
      default:
        // 未知字段按规范忽略，但同样算「事件已开始」。
        this.sawField = true
        break
    }
  }

  /**
   * 取走当前累积的事件并复位。
   *
   * @returns 事件；未开始任何字段时 `undefined`。
   */
  private takeEvent(): SseEvent | undefined {
    if (!this.sawField) return undefined
    const event: SseEvent = { event: this.eventName, data: this.dataLines.join('\n') }
    this.dataLines = []
    this.eventName = ''
    this.sawField = false
    return event
  }
}

/** 空闲超时的哨兵值（避免用 Error 让 `instanceof` 跨模块失效）。 */
const IDLE_TIMEOUT: unique symbol = Symbol('magpie.sse.idle-timeout')

/**
 * 把 `ReadableStream<Uint8Array>` 解码成 SSE 事件序列。
 *
 * @param stream - 响应体字节流。
 * @param options - 空闲超时与取消。
 * @returns 事件异步生成器。
 */
export async function* parseSse(
  stream: ReadableStream<Uint8Array>,
  options: SseOptions = {},
): AsyncGenerator<SseEvent, void, undefined> {
  const idleTimeoutMs = options.idleTimeoutMs ?? 0
  const decoder = new TextDecoder('utf-8', { fatal: false })
  const reader = stream.getReader()
  const state = new SseDecoder(options.lineDelimited ?? false)

  try {
    while (true) {
      if (options.signal?.aborted === true) throw abortError()

      let chunk: ReadResult
      try {
        chunk = await readWithIdle(reader, idleTimeoutMs, options.signal)
      } catch (error) {
        if (error === IDLE_TIMEOUT) throw idleTimeoutError(idleTimeoutMs)
        throw error
      }

      if (chunk.done) {
        // 收尾：`decode()` 不带参数会把解码器里残留的不完整字节吐出来
        //（正常流不会有，但被截断的流会有）。
        for (const event of state.push(decoder.decode())) yield event
        for (const event of state.flush()) yield event
        return
      }

      // `{ stream: true }` 是**必须的**：跨 chunk 的多字节字符要等下一个
      // chunk 补齐，否则中文会变成 U+FFFD。
      for (const event of state.push(decoder.decode(chunk.value, { stream: true }))) yield event
    }
  } finally {
    // 主动取消底层流：`cancel()` 让上游停止拉取，否则断开后网关会一直写。
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/**
 * 带空闲超时地读一块。
 *
 * @param reader - 流读取器。
 * @param idleTimeoutMs - 空闲上限，`<= 0` 表示不限。
 * @param signal - 调用方取消信号。
 * @returns 读取结果。
 */
async function readWithIdle(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<ReadResult> {
  const reads: Promise<unknown>[] = [reader.read()]
  let timer: ReturnType<typeof setTimeout> | undefined

  if (idleTimeoutMs > 0) {
    reads.push(
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(IDLE_TIMEOUT), idleTimeoutMs)
        // 不让定时器把 Node 进程吊住（宿主可能随时退出）。
        timer.unref?.()
      }),
    )
  }
  if (signal !== undefined) reads.push(rejectOnAbort(signal))

  try {
    return (await Promise.race(reads)) as ReadResult
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 构造空闲超时错误。
 *
 * @param idleTimeoutMs - 配置的空闲上限。
 * @returns 带 `TIMEOUT` 码的错误（宿主会据此重试）。
 */
function idleTimeoutError(idleTimeoutMs: number): Error & { code: string } {
  const error = new Error(
    `[magpie] 流式响应空闲超时：${idleTimeoutMs}ms 内没有收到任何数据块`,
  ) as Error & { code: string }
  error.code = 'TIMEOUT'
  return error
}

/**
 * 构造「已被取消」的错误。
 *
 * @returns 带 `ABORTED` 码的错误。
 */
export function abortError(): Error & { code: string } {
  const error = new Error('[magpie] 请求已取消') as Error & { code: string }
  error.code = 'ABORTED'
  return error
}

/**
 * 把中止信号转成一个永不 resolve、只在 abort 时 reject 的 Promise。
 *
 * @param signal - 中止信号。
 * @returns 竞速用的 Promise。
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

/**
 * 解析一行 SSE 的 `data:` 载荷为 JSON 对象。
 *
 * @param data - 事件载荷（不含 `data: ` 前缀）。
 * @returns 解析结果；`[DONE]` 返回 `'done'`；空载荷返回 `undefined`。
 * @throws Error 载荷不是合法 JSON 时（说明网关回了非 SSE 的内容，
 *   需要暴露而非静默丢弃 —— 静默丢弃的表现是「模型一个字都没说」）。
 */
export function parseSseJson(data: string): unknown | 'done' | undefined {
  const trimmed = data.trim()
  if (trimmed === '[DONE]') return 'done'
  if (trimmed.length === 0) return undefined
  return JSON.parse(trimmed)
}
