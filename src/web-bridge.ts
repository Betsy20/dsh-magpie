/**
 * magpie 原版 Web UI 的进程桥 + 认证代理。
 *
 * ## 为什么需要它
 *
 * magpie 的界面是 Wails 桌面窗口（HTML 里的 `--wails-draggable:drag` 暴露了
 * 身份），DSH 面板是浏览器上下文，两者**唯一**的合法接缝是 `magpie web` ——
 * 官方把整个 App 窗口用 HTTP 提供出来的那个命令：
 *
 * ```
 * magpie web [--addr host:port] [--lan] [--no-open] [--gateway]
 *             the app's window in a browser, with the gateway
 * ```
 *
 * ## 为什么不自己画面板
 *
 * 自造一套「概览 / 模型 / 额度 / 用量 / 路由」页签，无论多精致，都只是原版的
 * **拙劣摹本**：magpie 的 Agents / Sessions / Library / 路由组 / 账号管理每天
 * 都在变，摹本永远落后。iframe 原版页面则**零维护**跟上每一次上游更新
 * —— 用户要的也正是「原版」。
 *
 * ## 为什么必须走代理（本文件的核心）
 *
 * `magpie web` 的认证是 **cookie**：访问 `/?k=<MAGPIE_WEB_KEY>` 时 303 重定向
 * 到 `/` 并 `Set-Cookie: magpie_web_<port>=<token>; Path=/; SameSite=Lax`。
 *
 * 直接 iframe 嵌入会失败，原因是 **DSH 自己的启动 cookie 把 `127.0.0.1` 的
 * cookie 配额撑满了**（`dsh-auth-cookie-guard` 的源码注释里写着
 * `Cookie` header alone is 16184 bytes），浏览器驱逐了 magpie 的 cookie。
 * magpie 的登录页原话：
 *
 * > This browser sent no sign-in cookie for this address. A browser keeps cookies
 * > per host, not per port, so another service on this host's other ports can take
 * > it away: by clearing its site data (a sign-out often does), or by filling the
 * > host's cookie limit.
 *
 * 所以本桥起一个**同进程的反向代理**：由它在每个转发的请求上注入
 * `Cookie` 头，iframe 完全不需要浏览器保存任何 cookie。
 *
 * ```
 * DSH 面板 (127.0.0.1:63234)
 *   └── iframe src="http://127.0.0.1:<proxyPort>/"
 *         └── 代理（本文件）── 注入 Cookie ──> magpie web (127.0.0.1:<magpiePort>)
 * ```
 *
 * 代理**剥离**上游的 `Set-Cookie`，避免污染 DSH 的 cookie 池。
 *
 * ## 生命周期
 *
 * `magpie web` 是**独立进程**，本桥负责：
 * - 首次 {@link MagpieWebBridge.ensure | ensure()} 时 spawn，带固定
 *   `MAGPIE_WEB_KEY`（否则每次运行 key 都变）
 * - 从 stdout 解析 `● magpie web on http://…` 拿到**带 key 的** URL
 * - 用该 URL 登录一次，取到 cookie
 * - 起代理，把带 cookie 的请求转给 magpie web
 * - 插件卸载（{@link MagpieWebBridge.dispose | dispose()}）时杀掉子进程并关代理
 *
 * ## 为什么固定 key 而不是解析随机 key
 *
 * magpie 默认每次运行生成新 key（`a new key each run`）。若每次都解析新 URL，
 * iframe 的 `src` 会变，用户浏览器里的 magpie 登录态每次都没了。固定 key
 * （`MAGPIE_WEB_KEY`，官方要求 16+ 个 `[A-Za-z0-9._~-]`）让 URL 稳定，
 * 面板刷新后仍是同一个会话。
 *
 * ## 为什么 --no-open
 *
 * 不加 `--no-open` 时 magpie 会调用系统浏览器打开页面 —— 插件启动面板不该
 * 弹出一个外部窗口。
 *
 * @module dsh-magpie/web-bridge
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'

import { probeGateway } from './gateway.js'

/**
 * stdout 里启动完成的标志行。
 *
 * 实测形状（注意开头的 `●` 是 U+25CF，magpie 用它做状态点）：
 * ```
 * ● magpie web on http://127.0.0.1:3481/?k=magpie-panel-key
 *   the link carries MAGPIE_WEB_KEY · gateway http://127.0.0.1:3425 · Ctrl-C to stop
 * ```
 */
const READY_PATTERN = /magpie web on (https?:\/\/\S+)/u

/** 默认启动超时。magpie 首次启动要加载全部插件，20 秒是实测的宽松上界。 */
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000

/** 端口探测的默认尝试次数。 */
const DEFAULT_PORT_ATTEMPTS = 24

/**
 * 代理转发时必须**丢弃**的请求头。
 *
 * `host` 要换成上游的；`connection` / `content-length` 由 Node 的 http 客户端
 * 重新计算（原值会让上游读到错误的长度）；其余是 hop-by-hop 头，RFC 7230
 * 第 6.1 节明确要求代理不得转发。
 */
const DROPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
])

/**
 * 代理转发时必须**丢弃**的响应头。
 *
 * `set-cookie` 是核心：magpie 的 cookie 由代理在服务端注入，浏览器不需要也
 * 不应该保存它（保存了反而会占 DSH 的 cookie 配额）。
 *
 * ⚠️ **不能丢 `content-encoding` / `content-length`**：magpie 的响应是
 * gzip/br 压缩的，丢了 `content-encoding` 浏览器就不知道要解压，页面会显示成
 * 一堆乱码；丢了 `content-length` 则退化成 chunked，虽然能用但多一层开销。
 * 代理不修改响应体，所以这两个头原样透传是安全的。
 */
const DROPPED_RESPONSE_HEADERS = new Set([
  'set-cookie',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** 日志接口（只用到两档，避免依赖具体 logger 实现）。 */
export interface WebBridgeLogger {
  debug(message: string): void
  warn(message: string): void
}

/** 构造参数。 */
export interface MagpieWebBridgeOptions {
  /**
   * 解析好的 magpie 可执行文件绝对路径。
   *
   * 由 `src/binary.ts` 的 {@link resolveMagpieBinary} 产出的 —— 它会依次
   * 找「配置指定 → 插件自带 → 系统安装 → PATH」。这里只接受**绝对路径**，
   * 因为 `spawn` 的相对路径会按 `process.cwd()` 解析，而 DSH 的 cwd 不是
   * 插件目录。
   *
   * `undefined` 表示一个都没找到；`start()` 会抛一条带安装指引的错误。
   */
  readonly binary: string | undefined
  /** 固定的 `MAGPIE_WEB_KEY`。 */
  readonly key: string
  /** 监听地址，默认 `127.0.0.1`。 */
  readonly host: string
  /** 首选端口；被占用时向后找空闲端口。 */
  readonly preferredPort: number
  /** 启动超时（毫秒）。 */
  readonly startupTimeoutMs?: number
  /**
   * 网关根地址（如 `http://127.0.0.1:3425`）。
   *
   * 只用于启动前探测一次、把「网关在不在」写进日志 —— `magpie serve --web`
   * 自己会处理端口占用，不依赖这个值。缺省时跳过探测。
   */
  readonly gatewayURL?: string
  /** 日志。 */
  readonly logger: WebBridgeLogger
}

/** 一个已就绪的 Web 服务句柄。 */
export interface MagpieWebHandle {
  /** 代理的完整 URL，可直接给 iframe 的 `src`（**不含** `?k=`，认证由代理注入）。 */
  readonly url: string
  /** 代理监听的端口。 */
  readonly port: number
  /** `magpie web` 自己监听的端口（调试用）。 */
  readonly upstreamPort: number
  /** 子进程 PID（spawn 失败时可能为空）。 */
  readonly pid: number | undefined
}

/**
 * 探测空闲端口。
 *
 * 为什么不直接 bind 0 让系统分配：`magpie web` 的 `--addr` 要显式端口，
 * 拿不到系统分配的那个值。所以从 `preferred` 开始逐个试探，找到能 bind
 * 的第一个（bind 成功后**立刻关闭**，把端口交还给 magpie）。
 *
 * @param host - 监听地址。
 * @param preferred - 起始端口。
 * @param attempts - 最多试几个。
 * @returns 可用的端口号。
 * @throws 全部被占用时抛错。
 */
async function findFreePort(
  host: string,
  preferred: number,
  attempts: number,
): Promise<number> {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferred + offset
    if (port > 65_535) {
      break
    }
    const free = await new Promise<boolean>((resolve) => {
      const server = createNetServer()
      server.once('error', () => {
        resolve(false)
      })
      server.once('listening', () => {
        server.close(() => {
          resolve(true)
        })
      })
      server.listen(port, host)
    })
    if (free) {
      return port
    }
  }
  throw new Error(`端口 ${preferred}–${preferred + attempts - 1} 全部被占用`)
}

/**
 * 从上游响应里把 `set-cookie` 头拍平成一个字符串数组。
 *
 * Node 的 `IncomingHttpHeaders` 对 `set-cookie` 给的是 `string[]`，其余是
 * `string`；这里的类型收窄避免调用方到处 `Array.isArray`。
 *
 * @param value - 原始头值。
 * @returns 头值数组。
 */
function toHeaderList(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

/**
 * 登录 magpie web，换取 Cookie 头。
 *
 * magpie 的认证流程：`GET /?k=<key>` 返回 303 且带 `Set-Cookie`。这里**不跟随**
 * 重定向（`redirect: 'manual'`），直接读那个 303 的 cookie。
 *
 * @param baseUrl - `magpie web` 的根地址，如 `http://127.0.0.1:3480`。
 * @param key - `MAGPIE_WEB_KEY`。
 * @param timeoutMs - 请求超时。
 * @returns 可直接放进 `Cookie` 请求头的字符串（`name=value`）。
 * @throws 上游没有返回 `set-cookie` 时。
 */
async function login(baseUrl: string, key: string, timeoutMs: number): Promise<string> {
  const response = await fetch(`${baseUrl}/?k=${encodeURIComponent(key)}`, {
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  })
  const cookies = toHeaderList(response.headers.getSetCookie?.() ?? undefined)
  const raw = cookies.length > 0 ? cookies[0] : response.headers.get('set-cookie')
  if (raw === null || raw === undefined || raw.length === 0) {
    throw new Error(
      `magpie web 登录失败（HTTP ${String(response.status)}，没有 Set-Cookie）`,
    )
  }
  // 只保留 `name=value` 那一段，后面的 Path/Max-Age 由代理自己控制。
  const first = raw.split(';')[0]
  if (first === undefined || !first.includes('=')) {
    throw new Error(`magpie web 返回了无法解析的 Set-Cookie：${raw.slice(0, 120)}`)
  }
  return first.trim()
}

/**
 * 起一个反向代理，把请求转发给 `magpie web` 并注入 cookie。
 *
 * **为什么必须用 `http.request` 而不是 `fetch`**：`fetch` 会把响应整体缓冲
 * （除非用 `body` 流），而 magpie 页面里有大量并发资源请求，缓冲会让首屏
 * 变慢；`http.request` 直接 `pipe` 是零拷贝的。另外 `fetch` 对 `Host` 头的
 * 处理也不够细。
 *
 * @param upstreamHost - `magpie web` 的地址。
 * @param upstreamPort - `magpie web` 的端口。
 * @param cookie - 要注入的 `Cookie` 头。
 * @param listenHost - 代理监听地址。
 * @param logger - 日志。
 * @returns 代理服务器与它实际监听的端口。
 */
async function startProxy(
  upstreamHost: string,
  upstreamPort: number,
  cookie: string,
  listenHost: string,
  logger: WebBridgeLogger,
): Promise<{ server: Server; port: number }> {
  const server = createHttpServer((request, response) => {
    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) {
        continue
      }
      headers[name] = value
    }
    headers['host'] = `${upstreamHost}:${String(upstreamPort)}`
    headers['cookie'] = cookie

    const upstream = httpRequest(
      {
        host: upstreamHost,
        port: upstreamPort,
        path: request.url ?? '/',
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders: Record<string, string | string[]> = {}
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
            continue
          }
          responseHeaders[name] = value
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
        upstreamResponse.pipe(response)

        // 客户端中途断开（刷新、切页、关面板）时把上游也断掉 —— 否则
        // magpie 会继续往一个已经消失的 socket 里写，白白占着连接。
        response.once('close', () => {
          if (!response.writableEnded) {
            upstreamResponse.destroy()
            upstream.destroy()
          }
        })
        // 上游响应流自己的错误（连接被重置、解压失败）不会触发 `response`
        // 的 `error`，必须单独接，否则会成为 unhandled error。
        upstreamResponse.once('error', (error: Error) => {
          logger.debug(`[magpie] 上游响应流错误：${error.message}`)
          response.destroy(error)
        })
      },
    )

    upstream.on('error', (error: Error) => {
      logger.warn(
        `[magpie] 代理转发失败（${request.method ?? 'GET'} ${request.url ?? '/'}）：${error.message}`,
      )
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      }
      response.end(`magpie 代理错误：${error.message}`)
    })

    // 请求体没发完客户端就断了（用户取消上传、浏览器关闭）—— 把上游也断掉。
    request.once('aborted', () => {
      upstream.destroy()
    })

    // 请求体直接流给上游（POST 表单 / 上传都走这条）。
    request.pipe(upstream)
  })

  // WebSocket 升级（magpie 的实时通道）：直接把 TCP 流对接过去。
  // 没有这一步时页面的实时刷新会静默失效，但静态资源不受影响。
  server.on('upgrade', (request, socket, head) => {
    const upstream = httpRequest({
      host: upstreamHost,
      port: upstreamPort,
      path: request.url ?? '/',
      method: request.method,
      headers: {
        ...request.headers,
        host: `${upstreamHost}:${String(upstreamPort)}`,
        cookie,
      },
    })
    upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${String(upstreamResponse.statusCode ?? 101)} ${upstreamResponse.statusMessage ?? 'Switching Protocols'}`]
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        for (const item of toHeaderList(value)) {
          lines.push(`${name}: ${item}`)
        }
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (upstreamHead.length > 0) {
        socket.write(upstreamHead)
      }
      if (head.length > 0) {
        upstreamSocket.write(head)
      }
      upstreamSocket.pipe(socket).pipe(upstreamSocket)
    })
    upstream.on('error', () => {
      socket.destroy()
    })
    // 任一端断开时把另一端的 socket 也关掉 —— 否则会留下半开的 TCP 连接，
    // 面板反复开关后句柄数只增不减。
    socket.once('close', () => {
      upstream.destroy()
    })
    upstream.once('close', () => {
      socket.destroy()
    })
    upstream.end()
  })

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, listenHost, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })

  return { server, port }
}

/**
 * 停掉子进程（Windows 上连**整棵进程树**）。
 *
 * ⚠️ `child.kill()` 在 Windows 上只给**直接**子进程发 `TerminateProcess`，
 * magpie 派生的孙进程会活下来占着端口 —— 下一次 `ensure()` 于是再 spawn
 * 一份，累积成「孤儿进程 + 端口被占」。`taskkill /T /F` 是唯一可靠的
 * 树清理方式，失败才退回 `kill()`。
 *
 * 故意不 `await`：清理路径上的延迟不该拖住调用方，而 `taskkill` 本身
 * 也是 fire-and-forget 语义。
 *
 * @param child - 要停掉的子进程。
 */
function stopProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) {
    return
  }

  const fallback = (): void => {
    try {
      child.kill()
    } catch {
      /* 已经退出了 */
    }
  }

  if (process.platform !== 'win32') {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已经退出了 */
    }
    return
  }

  try {
    spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).on('error', fallback)
  } catch {
    fallback()
  }
}

/**
 * `magpie web` 子进程 + 认证代理的管理器。
 *
 * 单例语义由调用方保证（插件里只建一个）。并发调用 {@link ensure} 会共享
 * 同一个启动 Promise，避免两个面板同时挂载时 spawn 出两个 magpie。
 */
export class MagpieWebBridge {
  private handle: MagpieWebHandle | undefined
  private starting: Promise<MagpieWebHandle> | undefined
  private child: ChildProcess | undefined
  private proxy: Server | undefined
  private disposed = false

  /**
   * @param options - 桥参数。
   */
  constructor(private readonly options: MagpieWebBridgeOptions) {}

  /**
   * 确保 `magpie web` 与代理都在跑，返回可直接嵌入的 URL。
   *
   * 幂等：已在跑时返回缓存的句柄；正在启动时共享同一个 Promise。
   *
   * @returns 已就绪的句柄。
   * @throws 启动超时、子进程提前退出、登录失败、或插件已卸载。
   */
  async ensure(): Promise<MagpieWebHandle> {
    if (this.disposed) {
      throw new Error('Web 桥已卸载')
    }
    if (this.handle !== undefined) {
      return this.handle
    }
    if (this.starting === undefined) {
      this.starting = this.start().finally(() => {
        this.starting = undefined
      })
    }
    return this.starting
  }

  /**
   * 停掉子进程与代理。
   *
   * Windows 上 `magpie web` 可能自己再拉子进程，所以用 `taskkill /T` 连同
   * 进程树一起杀；失败则退回 `kill()`。整个方法**不抛错**（清理路径上的
   * 异常不该掩盖真正的卸载原因）。
   */
  dispose(): void {
    this.disposed = true

    // 先关代理，再杀子进程 —— 顺序反了的话，正在转发的请求会先撞上
    // 连接被拒，日志里多出一堆噪声。
    const proxy = this.proxy
    this.proxy = undefined
    if (proxy !== undefined) {
      try {
        // `close()` 只停止接收新连接；已经建立的 keep-alive、SSE 流和
        // WebSocket 会一直挂着。`closeAllConnections()` 主动断掉它们
        // （Node 18.2+ 提供）。
        proxy.closeAllConnections?.()
        proxy.close()
      } catch (error) {
        this.options.logger.warn(
          `[magpie] 关闭代理失败：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const child = this.child
    this.child = undefined
    this.handle = undefined
    if (child !== undefined) {
      stopProcessTree(child)
    }
  }

  /**
   * 真正的启动流程：探测网关 → spawn `magpie serve --web` → 等就绪 → 登录 → 起代理。
   *
   * @returns 就绪句柄。
   */
  private async start(): Promise<MagpieWebHandle> {
    const { binary, host, key, logger } = this.options
    const timeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS

    // 二进制没找到就早点抛 —— 这里抛的错会出现在面板的红条上，比让
    // `spawn` 抛一个 `ENOENT` 再往上包装可读得多。
    if (binary === undefined) {
      throw new Error(
        '找不到 magpie 可执行文件。插件应该已经自动下载到 ~/.dsh/magpie/bin/ —— ' +
          '如果下载失败，手动装一个 magpie（https://github.com/yetone/magpie/releases），' +
          '或在设置里把 magpieBinary 指向它的绝对路径。',
      )
    }

    /**
     * 每个 `await` 之后重新确认插件还活着。
     *
     * ⚠️ `ensure()` 返回的 Promise 一旦开始就不会因为 `dispose()` 而中断 ——
     * 卸载可能发生在任意两个 `await` 之间。不检查的话 `start()` 会一路跑到底：
     * spawn 出 magpie、起好代理、最后把 `this.handle` 写回一个已经废弃的桥
     * 实例。结果是**插件已卸载，magpie 子进程和代理仍在跑**。
     */
    const guard = (): void => {
      if (this.disposed) {
        throw new Error('Web 桥已卸载')
      }
    }

    guard()
    const upstreamPort = await findFreePort(host, this.options.preferredPort, DEFAULT_PORT_ATTEMPTS)
    guard()

    // ⚠️ `MAGPIE_WEB_KEY` 必须 16+ 位、只含 [A-Za-z0-9._~-]，否则 magpie 会
    //    拒绝启动并打印用法。校验放在这里，比等 30 秒超时好定位。
    if (!/^[A-Za-z0-9._~-]{16,}$/u.test(key)) {
      throw new Error(
        'MAGPIE_WEB_KEY 不合法：需要 16 位以上，且只含字母、数字、- . _ ~',
      )
    }

    // 先看网关在不在。这不是「决定要不要启动」的开关（`magpie serve` 自己
    // 会处理端口占用），而是**日志与诊断**：面板卡住时，用户能一眼看出
    // 「网关早就跑着，卡的是 Web UI」还是「连网关都没起来」。
    const gatewayURL = this.options.gatewayURL
    if (gatewayURL !== undefined) {
      const probe = await probeGateway(gatewayURL)
      logger.debug(
        probe.reachable
          ? `[magpie] 网关已在线（${probe.version ?? '版本未知'}）：${gatewayURL}`
          : `[magpie] 网关未运行，将由 magpie serve 一并启动：${gatewayURL}`,
      )
    }

    logger.debug(`[magpie] 启动 magpie serve --web（${host}:${String(upstreamPort)}）`)

    // 为什么用 `serve --web=` 而不是 `web --addr`：
    // - `magpie web` 要求**已经有**一个 magpie 在服务网关，否则自己起一个
    //   但退出时不保证网关还在（实测杀掉 web 进程后网关也断了）。
    // - `magpie serve --web=` 是**一个进程同时提供网关 + Web UI**：
    //   网关端口空闲时它自己服务；已被别的实例占用时它只提供 Web UI
    //   （日志里那句 `another magpie serves the gateway there`）。
    //   两种情况下都恰好是我们要的行为，不需要分支。
    const child = spawn(
      binary,
      ['serve', `--web=${host}:${String(upstreamPort)}`],
      {
        env: { ...process.env, MAGPIE_WEB_KEY: key },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    this.child = child

    // 从这里开始进入「已经建起资源」的区域 —— 任何一步失败（含插件被卸载）
    // 都必须把 child / proxy 收干净，否则卸载后残留子进程与端口。
    let proxy: Server | undefined
    try {
      guard()

      await new Promise<void>((resolve, reject) => {
        let settled = false
        let buffered = ''

        const cleanup = (): void => {
          clearTimeout(timer)
          child.stdout?.off('data', onStdout)
          child.stderr?.off('data', onStderr)
          child.off('exit', onExit)
          child.off('error', onError)
        }

        const settle = (fn: () => void): void => {
          if (settled) {
            return
          }
          settled = true
          cleanup()
          fn()
        }

        const fail = (message: string): void => {
          settle(() => {
            this.child = undefined
            // ⚠️ 必须是**进程树** —— 只 `child.kill()` 会留下 magpie 派生的
            //    孙进程占着端口，下一次 `ensure()` 再 spawn 一份，越积越多。
            stopProcessTree(child)
            reject(new Error(message))
          })
        }

        const onStdout = (chunk: Buffer): void => {
          buffered += chunk.toString('utf8')
          const match = READY_PATTERN.exec(buffered)
          if (match?.[1] === undefined) {
            // 只保留尾部一段，防止长时间无匹配时无限增长。
            if (buffered.length > 8_192) {
              buffered = buffered.slice(-4_096)
            }
            return
          }
          settle(() => {
            logger.debug(`[magpie] magpie web 就绪：${match[0]}`)
            resolve()
          })
        }

        const onStderr = (chunk: Buffer): void => {
          const text = chunk.toString('utf8').trim()
          if (text.length > 0) {
            logger.debug(`[magpie] magpie web stderr: ${text.slice(0, 500)}`)
          }
        }

        const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
          fail(
            `magpie web 提前退出（code=${String(code)}, signal=${String(signal)}）` +
              (buffered.length > 0 ? `：${buffered.slice(-400)}` : ''),
          )
        }

        const onError = (error: Error): void => {
          fail(`无法启动 magpie web：${error.message}`)
        }

        const timer = setTimeout(() => {
          fail(`magpie web 在 ${String(timeoutMs)}ms 内没有就绪`)
        }, timeoutMs)
        // 超时定时器不该把进程吊住（Node 默认 30 秒就够，但显式一些更安全）。
        timer.unref?.()

        child.stdout?.on('data', onStdout)
        child.stderr?.on('data', onStderr)
        child.once('exit', onExit)
        child.once('error', onError)
      })

      guard()

      // 登录拿 cookie。magpie 的认证是 cookie 而不是每次带 key，所以这里
      // 只做一次，之后全部由代理注入。
      const cookie = await login(`http://${host}:${String(upstreamPort)}`, key, timeoutMs)
      guard()
      logger.debug(`[magpie] 已取得登录 cookie（${cookie.split('=')[0] ?? '?'}）`)

      const started = await startProxy(host, upstreamPort, cookie, host, logger)
      proxy = started.server
      this.proxy = proxy
      guard()

      const url = `http://${host}:${String(started.port)}/`
      const handle: MagpieWebHandle = {
        url,
        port: started.port,
        upstreamPort,
        pid: child.pid,
      }
      this.handle = handle
      logger.debug(`[magpie] 代理就绪：${url} → ${host}:${String(upstreamPort)}`)
      return handle
    } catch (error) {
      // 启动失败或插件已卸载：把这一轮建起来的资源全部收掉，不留残留。
      if (proxy !== undefined) {
        try {
          proxy.closeAllConnections?.()
          proxy.close()
        } catch {
          /* 已经关了 */
        }
        if (this.proxy === proxy) {
          this.proxy = undefined
        }
      }
      stopProcessTree(child)
      if (this.child === child) {
        this.child = undefined
      }
      this.handle = undefined
      throw error
    }
  }
}
