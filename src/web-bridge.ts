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
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib'

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

/**
 * 注入到 magpie web 页面里的脚本 —— 把「桌面专属」按钮的点击转发给 DSH。
 *
 * ## 为什么需要
 *
 * 原版 magpie 的 `?mode=panel` 是**桌面 App（Wails）的小窗模式**，它把
 * 三个按钮的点击全部交给 Go 后端的桌面进程 RPC：
 *
 * ```js
 * function openSettings() {
 *   if (mode !== "window") { api("window/main?view=settings", {}); return; }
 *   show("settings");
 * }
 * $("#open").onclick     = () => api("window/main", {});
 * $("#openMain").onclick = () => api("window/main", {});
 * $("#quit").onclick     = () => api("window/quit", {});
 * ```
 *
 * `/api/window/*` 在浏览器里**根本不存在**（那是 Wails 的私有通道），
 * 所以三个按钮点了完全没反应。
 *
 * ## 做法
 *
 * 在 `app.js` **之后**再跑一段脚本，用 `capture` 阶段抢先拦住点击
 * （`stopImmediatePropagation`），然后 `postMessage` 给父窗口 ——
 * 我们的 `MagpieDockWindow` 会监听并接管：
 *
 * | 按钮 | 我们的行为 |
 * | --- | --- |
 * | `#openMain` | 切到完整页面（去掉 `?mode=panel`） |
 * | `#prefs` | 切到完整页面并打开设置 |
 * | `#quit` | 关闭小窗 |
 *
 * ⚠️ 必须用 `capture: true` —— `app.js` 给这些按钮赋的是 `onclick` 属性，
 * 冒泡阶段会被它先执行。
 */
const INJECTED_HTML_SCRIPT = `<script>
(function () {
  if (window.__magpieDshBridge) return;
  window.__magpieDshBridge = true;
  // \`?mode=panel\` 是小窗（Wails 桌面 App 的紧凑形态），\`/\` 是完整页面。
  var isPanel = new URLSearchParams(location.search).get("mode") === "panel";

  /**
   * 父窗口的 origin。
   *
   * ⚠️ 不能用 \`"*"\` —— 那等于「任何窗口都能收」。iframe 和宿主**不同源**
   * （宿主是 DSH 的端口，我们是代理端口），所以不能省，但可以用
   * \`document.referrer\` 拿到宿主的源。拿不到时退回 \`"*"\`（功能优先）。
   */
  var parentOrigin = "*";
  try {
    if (document.referrer) {
      parentOrigin = new URL(document.referrer).origin;
    }
  } catch (e) {}

  /**
   * 把 \`window/*\` 这类「桌面窗口控制」的 RPC 转成宿主消息。
   *
   * ## ⚠️ 为什么 hook \`fetch()\` 而不是包装 \`api()\`
   *
   * \`api()\` 是 \`app.js\` 里的**顶层函数声明**（\`async function api(path, body,
   * heads, signal)\`，第 114 行），所有调用点（\`openSettings()\` 等）直接写
   * \`api(...)\` —— 那是**词法作用域**查找，根本不经过 \`window.api\` 属性。
   * 赋值 \`window.api = wrapped\` 对它们**完全无效**。
   *
   * 但 \`api()\` 内部最终走 \`await fetch("/api/" + path, ...)\` —— **全局
   * fetch**。hook 这一层，所有 \`api()\` 调用都会被拦到，包括以后 magpie
   * 新加的按钮。
   *
   * ## 为什么要接管的按钮没一个有稳定 id
   *
   * - \`app.js\` 的 \`#openMain\`（打开主窗口）、\`#prefs\`（设置）、\`#quit\`（退出）
   * - \`app.js\` 里 \`renderPanelUse\` 动态造的「打开用量」按钮
   * - \`plugins/routing/client.js\` 动态造的「打开路由」按钮
   *
   * 后两个连 id 都没有，只能靠文本匹配（会随语言变）。它们**唯一共同点**
   * 是都调 \`api("window/...", {})\` —— 而浏览器里没有 \`/api/window/*\` 这个
   * 端点（那是 Wails 的私有通道）。
   */
  var originalFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var prefix = "/api/window/";
    var at = url.indexOf(prefix);
    if (at < 0) {
      // 用 window 而不是 this —— 如果调用方是 const f = fetch; f(...)，
      // this 就是 undefined，originalFetch.apply(undefined, ...) 在严格
      // 模式下会抛 TypeError。api() 里是直接调用所以没事，但 hook 层
      // 不能假设调用方怎么写。
      return originalFetch.apply(window, arguments);
    }
    var rest = url.slice(at + prefix.length);
    var q = rest.indexOf("?");
    var action = q >= 0 ? rest.slice(0, q) : rest;
    var params = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : "");
    try {
      window.parent.postMessage({
        source: "dsh-magpie",
        kind: action,
        view: params.get("view") || "",
        tab: params.get("tab") || ""
      }, parentOrigin);
    } catch (e) {}
    // \`api()\` 对 204 直接 \`return null\`（见 app.js 的 \`if (res.status === 204)
    // return null;\`）—— 正是我们要的「这个 RPC 已经处理过了」语义。
    return Promise.resolve(new Response(null, { status: 204 }));
  };

  // 完整页面：接收宿主的「切到某页」指令。
  if (!isPanel) {
    window.addEventListener("message", function (event) {
      var data = event.data;
      if (!data || typeof data !== "object" || data.source !== "dsh-magpie-host") return;
      if (data.kind !== "show") return;
      var view = String(data.view || "");
      // 只允许 \`data-view\` 里真实存在的形态 —— 拦掉任何畸形输入。
      if (!/^[a-z0-9-]+$/.test(view)) return;
      // 设置页不是 \`#nav\` 里的一行，而是标题栏的齿轮。
      if (view === "settings") {
        var prefs = document.querySelector("#prefs");
        if (prefs) prefs.click();
        return;
      }
      // 其余页面点 \`#nav\` 里对应的按钮 —— \`show()\` 是内部函数，但导航
      // 按钮的点击就是它唯一的入口，比直接调内部函数稳（不依赖函数名）。
      // ⚠️ 用 \`CSS.escape\` 转义 —— 虽然上面已经白名单过，多一层防御。
      var escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(view)
        : view;
      var tab = document.querySelector('#nav button[data-view="' + escaped + '"]');
      if (tab) tab.click();
    });
  }
})();
</script>`

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
/**
 * 把「绑定地址」转成「可以拿来做 TCP 连接的地址」。
 *
 * ## 为什么需要区分
 *
 * `0.0.0.0` / `::` 是**通配绑定**地址，表示「所有网卡」。它们能 `listen`，
 * 但**不能用来建连** —— `fetch('http://0.0.0.0:3480')` 在部分平台上会
 * 直接失败（Windows 上通常连到 `127.0.0.1`，Linux 上则可能拒绝）。
 *
 * 所以转发给上游、拼 iframe URL 时都要换成回环地址。
 *
 * ## ⚠️ 代理本身永远只监听回环
 *
 * 见 {@link startProxy} 的 `listenHost` 参数 —— **不要**把 `webHost` 直接
 * 传进去。代理会在每个请求上注入 magpie 的登录 Cookie，一旦它监听
 * `0.0.0.0`，任何能访问该端口的局域网客户端都会自动获得 magpie 的登录态，
 * 管理界面完全敞开。绑定地址和连接地址必须解耦。
 *
 * @param host - 配置里的 `webHost`。
 * @returns 可以建连的地址（通配地址换成对应的回环地址）。
 */
function connectHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed === '' || trimmed === '0.0.0.0') {
    return '127.0.0.1'
  }
  if (trimmed === '::' || trimmed === '[::]') {
    return '::1'
  }
  return trimmed
}

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

        // HTML 要**缓冲**后注入脚本（见 INJECTED_HTML_SCRIPT）；其余资源
        // 继续走零拷贝 pipe。
        const contentType = responseHeaders['content-type']
        const isHtml =
          typeof contentType === 'string' && contentType.toLowerCase().includes('text/html')
        if (isHtml) {
          const chunks: Buffer[] = []
          upstreamResponse.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
          })
          // 客户端中途断开（刷新、切页、关面板）时把上游也断掉 —— 否则
          // 我们会继续把整个响应缓冲进内存，最后往一个已经消失的 socket 上
          // 写。非 HTML 分支靠 `pipe` 自动处理，HTML 分支要自己接。
          response.once('close', () => {
            if (!response.writableEnded) {
              upstreamResponse.destroy()
              upstream.destroy()
            }
          })
          upstreamResponse.once('end', () => {
            // 已经断开就别写了 —— `writeHead` 在 destroyed 的 response 上
            // 会抛 `ERR_STREAM_DESTROYED`，变成未捕获异常。
            if (response.destroyed) {
              return
            }
            let raw = Buffer.concat(chunks)
            // ⚠️ magpie 的 HTML 是 gzip/br 压缩的，直接在压缩字节上做字符串
            //    替换会得到乱码，而且浏览器拿到的是「解压后」的字节 —— 必须
            //    先解压，注入后再原样回填 content-encoding（这里直接去掉，
            //    让 Node 发未压缩的，省一次二次压缩）。
            const encoding = responseHeaders['content-encoding']
            const algorithm = typeof encoding === 'string' ? encoding.toLowerCase().trim() : ''
            try {
              if (algorithm === 'gzip' || algorithm === 'x-gzip') {
                raw = gunzipSync(raw)
              } else if (algorithm === 'br') {
                raw = brotliDecompressSync(raw)
              } else if (algorithm === 'deflate') {
                raw = inflateSync(raw)
              } else if (algorithm !== '' && algorithm !== 'identity') {
                // 不认识的编码（`zstd`、多值 `gzip, br` 之类）—— 不能瞎猜。
                throw new Error(`不支持的 content-encoding: ${algorithm}`)
              }
            } catch (error) {
              logger.warn(
                `[magpie] 解压 HTML 失败（${algorithm || 'identity'}）：` +
                  `${error instanceof Error ? error.message : String(error)}`,
              )
              // ⚠️ 必须中止 —— 此时 `raw` 还是**压缩字节**，`toString('utf8')`
              //    得到的是乱码，拼上注入脚本再重算 `content-length` 会让浏览器
              //    收到一坨垃圾（白屏），而错误只出现在 debug 日志里。
              response.destroy(error instanceof Error ? error : new Error(String(error)))
              return
            }
            // 只有**成功解压**后才删 `content-encoding` —— 解压失败已经 return，
            // 不会走到这里。
            if (algorithm !== '' && algorithm !== 'identity') {
              delete responseHeaders['content-encoding']
            }
            const html = raw.toString('utf8')
            const injected = html.includes('</body>')
              ? html.replace('</body>', `${INJECTED_HTML_SCRIPT}</body>`)
              : html + INJECTED_HTML_SCRIPT
            const body = Buffer.from(injected, 'utf8')
            // 长度变了，`content-length` 必须重算 —— 否则浏览器会截断。
            delete responseHeaders['content-length']
            responseHeaders['content-length'] = String(body.byteLength)
            response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders)
            response.end(body)
          })
          upstreamResponse.once('error', (error: Error) => {
            logger.debug(`[magpie] 上游 HTML 流错误：${error.message}`)
            response.destroy(error)
          })
          return
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

      // ⚠️ 用**升级后的两端 socket** 互相清理，不要用 `upstream`（那是
      //    `ClientRequest`）的 `'close'` —— 它在 `'upgrade'` 之后**立刻**
      //    触发（请求本身已经结束），会把刚建好的隧道当场销毁：magpie 的
      //    实时推送刚连上就断，页面看起来「加载了但一直不更新」。
      socket.once('close', () => {
        upstreamSocket.destroy()
      })
      upstreamSocket.once('close', () => {
        socket.destroy()
      })
      // `ECONNRESET` / `EPIPE` 在本地代理里是常态（刷新、重启上游），
      // 没有 error 监听会变成未捕获异常，把宿主进程带走。
      socket.once('error', () => {
        upstreamSocket.destroy()
      })
      upstreamSocket.once('error', () => {
        socket.destroy()
      })
    })
    upstream.on('error', () => {
      socket.destroy()
    })
    // ⚠️ 上游**拒绝**升级（返回 400/404 而不是 101）时 `'upgrade'` 不会
    //    触发，只会走 `'response'`。不处理的话浏览器会一直等在那个 socket
    //    上（表现为页面一直转圈），必须把响应原样回写再结束。
    upstream.on('response', (upstreamResponse) => {
      const lines = [
        `HTTP/1.1 ${String(upstreamResponse.statusCode ?? 502)} ${upstreamResponse.statusMessage ?? 'Bad Gateway'}`,
      ]
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        for (const item of toHeaderList(value)) {
          lines.push(`${name}: ${item}`)
        }
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
      upstreamResponse.pipe(socket)
      upstreamResponse.once('error', () => {
        socket.destroy()
      })
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
 * 主窗口 URL（`/`）—— 完整页面，带 magpie 自己的侧边栏。
 *
 * DSH 侧边栏「Magpie」入口打开的就是它，也是 {@link MagpieWebBridge.ensure}
 * 返回的默认地址。
 */
export function mainWindowUrl(host: string, port: number): string {
  // ⚠️ 过 connectHost —— 配置成 0.0.0.0 / :: 时 iframe 连不上。
  return `http://${connectHost(host)}:${String(port)}/`
}

/**
 * 小窗 URL（`/?mode=panel`）—— magpie 托盘图标点开的那个紧凑形态。
 *
 * 前端在 `internal/gui/assets/app.js:5` 读 `params.get("mode")`，`"panel"` 时
 * 切到只有四个页签（Agent / 额度 / 用量 / 路由）+ 底部按钮的布局，不渲染
 * 侧边栏。桌面 App 的小窗宽 440、高 520（`internal/gui/textsize.go:14`
 * 的 `panelWidth`），所以 DSH 这边用同尺寸浮层。
 */
export function dockWindowUrl(host: string, port: number): string {
  // ⚠️ 同 mainWindowUrl —— 过 connectHost。
  return `http://${connectHost(host)}:${String(port)}/?mode=panel`
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

  /** 最后一道兜底：`SIGKILL`（Windows 上等价于 `TerminateProcess`）。 */
  const fallback = (): void => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经退出了 */
    }
  }

  if (process.platform !== 'win32') {
    try {
      child.kill('SIGTERM')
    } catch {
      return
    }
    // ⚠️ 给 2 秒宽限再 `SIGKILL` —— `magpie serve` 在等网关释放时可能
    //    忽略 `SIGTERM`（它要等另一个 magpie 退出），不兜底会留下孤儿进程
    //    一直占着 3425/3480，下次 `ensure()` 再起一份就端口冲突。
    const timer = setTimeout(fallback, 2_000)
    timer.unref()
    child.once('exit', () => {
      clearTimeout(timer)
    })
    return
  }

  try {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    killer.once('error', fallback)
    // ⚠️ `taskkill` **正常启动**但退出码非 0（权限不足、PID 不存在、
    //    部分子进程结束不掉）也要兜底 —— 只监听 `'error'` 会漏掉这种。
    killer.once('close', (code) => {
      if (code !== 0) {
        fallback()
      }
    })
  } catch {
    fallback()
  }
}

/**
 * 判断一个 PID 对应的进程是否还活着。
 *
 * ## 为什么需要这个
 *
 * `ensure()` 成功后会把句柄缓存进 `this.handle`，之后所有调用都直接返回
 * 缓存 —— 但 **magpie 进程可能已经死了**（被杀、崩溃、被安全软件拦）。
 * 这时代理还在监听，转发到死端口就报 `ECONNREFUSED 127.0.0.1:3480`，
 * 而 `ensure()` 因为句柄缓存「成功」返回，永远不会重试。
 *
 * ## 实现
 *
 * `process.kill(pid, 0)` 不发信号，只做**存在性检查**：
 * - 进程存在 → 正常返回
 * - 进程不存在 → 抛 `ESRCH`
 *
 * ⚠️ Windows 上 `ESRCH` 之外还可能抛 `EPERM`（进程存在但没权限），
 *    这种情况要算「活着」，否则会误判成死亡而重启进程。
 *
 * @param pid - 目标进程 ID。
 * @returns 进程是否还活着。
 */
function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // `EPERM` = 进程存在但没权限发信号 ⇒ 活着。
    return (error as NodeJS.ErrnoException).code === 'EPERM'
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
   * 启动代数 —— 每次 `start()` 自增，用来让**旧进程的 `exit` 监听**
   * 认出自己已经过期。
   *
   * ## ⚠️ 为什么不能只比 `this.child !== child`
   *
   * 这个比较在「旧进程退出 → 新进程启动」时是有效的，但**覆盖不了**
   * 「旧进程的 `exit` 事件在新进程启动之后才派发」这种时序：那时
   * `this.child` 已经是新进程了，旧监听看到不等就 `return` —— 这是对的。
   * 反过来，如果旧进程先退出、`discardHandle()` 把 `this.child` 清成
   * `undefined`，新进程又还没起来，那旧监听看到 `undefined !== child`
   * 也会 `return`，同样没问题。
   *
   * 真正需要 `generation` 的是**启动期**：见 `start()` 里对
   * `child.exitCode` 的检查。
   */
  private generation = 0

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
    // ⚠️ 除非**进程还活着**，否则不能信缓存 —— magpie 可能被杀/崩了，
    //    这时代理还在监听却转发到死端口（`ECONNREFUSED 127.0.0.1:3480`），
    //    而句柄缓存会让 `ensure()` 永远「成功」返回，不会重试。
    if (this.handle !== undefined && isProcessAlive(this.handle.pid)) {
      return this.handle
    }
    // 进程死了就丢掉残留的代理和句柄，走下面的重启路径。
    this.discardHandle()
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
    this.closeProxy()

    const child = this.child
    this.child = undefined
    this.handle = undefined
    if (child !== undefined) {
      stopProcessTree(child)
    }
  }

  /**
   * 丢掉一个**已经死了**的子进程留下的句柄和代理。
   *
   * 和 {@link dispose} 的区别：这里**不杀进程**（它已经没了），只做清理，
   * 让下一次 `ensure()` 走完整的重启路径。
   *
   * @private
   */
  private discardHandle(): void {
    this.closeProxy()
    this.child = undefined
    this.handle = undefined
  }

  /**
   * 关掉代理服务器（不碰子进程）。
   *
   * @private
   */
  private closeProxy(): void {
    const proxy = this.proxy
    this.proxy = undefined
    if (proxy === undefined) {
      return
    }
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

    // 这一轮启动的编号 —— 常驻 `exit` 监听靠它认出「我已经过期了」。
    const generation = ++this.generation

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

      const started = await startProxy(connectHost(host), upstreamPort, cookie, '127.0.0.1', logger)
      proxy = started.server
      this.proxy = proxy
      guard()

      // ⚠️ 返回 handle 之前最后确认一次进程还活着 —— 临时 `exit` 监听在
      //    `settle()` 里就被移除了，而 `await login()` / `await startProxy()`
      //    期间进程可能已经退出（`exit` 事件早已触发，之后注册的
      //    `once('exit')` 永远收不到）。这会让 `ensure()` 返回一个指向死端口
      //    的句柄，首次请求就 `ECONNREFUSED 127.0.0.1:3480`。
      if (child.exitCode !== null || !isProcessAlive(child.pid)) {
        throw new Error('magpie web 在启动过程中退出')
      }

      // 这里给的是**主窗口**（`/`）—— 完整页面，带 magpie 自己的侧边栏。
      //
      // magpie 的桌面 App 用两个窗口跑同一套前端：主窗口加载 `/`，托盘图标
      // 点开的小窗加载 `/?mode=panel`（见 `internal/gui/app.go` 的
      // `panelOptions`，`Width: panelWidth` = 440，`Height: 520`）。前端在
      // `app.js:5` 读 `params.get("mode")`。
      //
      // DSH 侧边栏里的「Magpie」入口要的是**完整页面**，所以这里用 `/`；
      // 小窗（`?mode=panel`）由 composer 输入框右侧的按钮另开一个弹窗，
      // 走 {@link dockWindowUrl} 这个独立方法。
      const url = mainWindowUrl(host, started.port)
      const handle: MagpieWebHandle = {
        url,
        port: started.port,
        upstreamPort,
        pid: child.pid,
      }
      this.handle = handle
      logger.debug(`[magpie] 代理就绪：${url} → ${host}:${String(upstreamPort)}`)

      // ⚠️ 常驻 exit 监听 —— `settle()` 在 resolve 时已经移除了**临时的**
      //    `onExit`（那个只负责把「启动期就失败」变成 reject）。这里补一个
      //    跑完全程的：magpie 之后任何时刻退出（被杀、崩溃、被安全软件
      //    拦），都要清掉句柄和代理，否则 `ensure()` 会一直返回死句柄，
      //    代理继续转发到死端口（`ECONNREFUSED 127.0.0.1:3480`）。
      child.once('exit', (code, signal) => {
        // 已经换过进程（或已被 dispose）就不归这个监听管了。
        if (this.generation !== generation || this.child !== child) {
          return
        }
        logger.warn(
          `[magpie] web 进程已退出（code=${String(code)}, signal=${String(signal)}），` +
            '下次打开面板会重新拉起',
        )
        this.discardHandle()
      })

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
