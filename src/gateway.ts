/**
 * magpie 网关的存活探测。
 *
 * ## 为什么需要它
 *
 * 插件最初假设「网关已经在跑」。但用户装完插件后第一次打开 DSH 时，网关
 * 通常还没起 —— 面板一片红，模型选择器是空的。让用户自己去开 magpie 是
 * 没必要的摩擦，所以插件要能**自己拉起网关**（见 `web-bridge.ts`）。
 *
 * 拉起之前必须先知道「现在到底有没有」，否则会起两个进程抢同一个端口。
 * 本模块只做这一件事：**问一句，别猜**。
 *
 * ## 为什么用 `/api/hello` 而不是 TCP 探测
 *
 * TCP 连得上不代表那是 magpie —— 3425 端口可能被别的进程占用（比如上一版
 * 没退干净的 magpie）。`/api/hello` 会返回 `{"name":"magpie","version":"…"}`，
 * 只有真 magpie 才认这个形状。误判成「网关在跑」比误判成「没跑」更糟：
 * 前者会让插件跳过启动、然后所有请求 404，用户看到的是一个永远空的面板。
 *
 * @module dsh-magpie/gateway
 */

/** 一次探测的结果。 */
export interface GatewayProbe {
  /** 网关是否可用（`/api/hello` 返回了合法的 magpie 响应）。 */
  readonly reachable: boolean
  /** 网关版本号（`reachable` 为 `false` 时是 `undefined`）。 */
  readonly version: string | undefined
}

/** `/api/hello` 的响应形状。 */
interface HelloBody {
  readonly name?: string
  readonly version?: string
}

/** 单次探测的默认超时。本机环回，2 秒已经很宽松。 */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000

/** 轮询等待的默认间隔。 */
const DEFAULT_POLL_INTERVAL_MS = 250

/**
 * 探测一次网关是否在线。
 *
 * **永不抛错** —— 网络错误、超时、非法 JSON 都归入 `{ reachable: false }`。
 * 调用方只关心「能不能用」，不关心「为什么不能用」。
 *
 * @param baseURL - 网关根地址，如 `http://127.0.0.1:3425`（**不带** `/v1`）。
 * @param timeoutMs - 超时毫秒数。
 * @returns 探测结果。
 */
export async function probeGateway(
  baseURL: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<GatewayProbe> {
  try {
    const response = await fetch(`${baseURL}/api/hello`, {
      signal: AbortSignal.timeout(timeoutMs),
      // 探测不带凭据：`/api/hello` 是公开的，带上只会把 key 泄进本来不需要它的路径。
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      return { reachable: false, version: undefined }
    }
    const body = (await response.json()) as HelloBody
    // 只认 `name === 'magpie'`，避免把别的服务的 200 当成网关。
    if (body.name !== 'magpie') {
      return { reachable: false, version: undefined }
    }
    return {
      reachable: true,
      version: typeof body.version === 'string' ? body.version : undefined,
    }
  } catch {
    // 超时 / 连接被拒 / DNS 失败 / 响应不是 JSON —— 全归「不可用」。
    return { reachable: false, version: undefined }
  }
}

/**
 * 轮询等待网关上线。
 *
 * 用于「刚 spawn 了 `magpie serve`，等它真的能服务请求」这个场景。为什么
 * 不用 stdout 判断就绪：`magpie serve` 的 `● magpie gateway on …` 那一行
 * 打印时监听器可能还没 accept 第一个连接（实测有几十毫秒的窗口），直接发
 * 请求会偶发 `ECONNREFUSED`。轮询到真能应答为止才是可靠的。
 *
 * @param baseURL - 网关根地址。
 * @param timeoutMs - 总超时。
 * @param intervalMs - 轮询间隔。
 * @param signal - 外部取消信号（面板关闭时别继续等）。
 * @returns 最后一次探测的结果（超时则是 `{ reachable: false }`）。
 */
export async function waitForGateway(
  baseURL: string,
  timeoutMs: number,
  intervalMs: number = DEFAULT_POLL_INTERVAL_MS,
  signal?: AbortSignal,
): Promise<GatewayProbe> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const probe = await probeGateway(baseURL)
    if (probe.reachable) {
      return probe
    }
    if (signal?.aborted === true) {
      return { reachable: false, version: undefined }
    }
    if (Date.now() >= deadline) {
      return probe
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs)
      // 取消时提前唤醒，别让调用方多等一个 interval。
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
  }
}
