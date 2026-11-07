/**
 * DSH 插件入口：把 magpie 原版 Web UI 嵌进 DSH 侧边栏。
 *
 * ## 这个插件**不**注册 provider
 *
 * DSH 接入 magpie 的模型**已经由 magpie 自己完成**，插件不需要重做：
 *
 * - `internal/agent/dsh.go`：`magpie dsh <model>` 会往
 *   `~/.dsh/profiles/<name>/cordis.patch.yml` 写一条 `llm-pi-ai` 条目，
 *   末尾带 `dshMark = "# magpie"` 标记；
 * - 那条目的 `models` 来自 `provider.CatalogFor("dsh")` —— 就是你在 magpie
 *   「Agents」页面挑选的可见模型（`magpie models dsh` 能原样列出，未挑的
 *   显示为 `17 taken out of dsh's list`）；
 * - 另有 drift 检查把被改坏的配置修回原样。
 *
 * ⇒ 插件只做一件官方没有的事：把 magpie 的原版 Web UI（`magpie web`）用
 * iframe 嵌进 DSH 的侧边栏与设置弹层。
 *
 * ## 形状
 *
 * cordis 插件是**四个具名导出**（不能有 `default`）：
 *
 * ```ts
 * export const name = 'magpie'
 * export const inject = []
 * export const Config = Schema.object({ ... })
 * export function apply(ctx, config) { ... }
 * ```
 *
 * ⚠️ **`default` 导出会让插件静默失效**：Loader 取 `default` 时拿不到本模块的
 * `name` / `inject`，fiber 会以空 inject 列表激活，第一次读服务就抛
 * `cannot get property "…" without inject`。
 *
 * @module dsh-magpie
 */

import type { Context } from '@deepseek-ai/cordis'

import { resolveOptions, type MagpieOptions } from './config.js'
import { describeSource, resolveMagpieBinary } from './binary.js'
import { dockWindowUrl, MagpieWebBridge } from './web-bridge.js'
import { ensureMagpieBinary } from './download.js'
import { LOG_PREFIX } from './product.js'

/** 面板 RPC 的 HTTP 路径（POST）。 */
export const PANEL_API_PATH = '/api/magpie'

/** 面板 RPC 的通道名（`payload.method` 的命名空间）。 */
const PANEL_ENDPOINT = 'magpie'

/**
 * 插件 Config schema。
 *
 * 定义在 `config.ts`（唯一真相源）—— 这里只做**重新导出**，因为 cordis
 * 从插件入口模块取 `Config`。
 */
export { Config } from './config.js'

/** cordis 条目 id。**必须**与 `package.json` 的 `name` 及 `cordis.patch.yml` 的 `name` 一致。 */
export const name = 'magpie'

/**
 * 静态依赖：**空**。
 *
 * ⚠️ 不要列 `llm` —— 本插件**不注册 provider**。DSH 接入 magpie 的模型
 * 已经由 magpie 自己完成（`internal/agent/dsh.go` 写的 `llm-pi-ai` 条目，
 * 带 `# magpie` 标记，`models` 来自 `provider.CatalogFor("dsh")`）。
 * 插件重复注册一个 provider 只会让模型选择器里出现两份同样的模型。
 *
 * ⚠️ 也**不要**列 `connection` —— 它只由 Web bundle 提供，headless / CLI
 * profile 里不存在，静态列会让插件永久 pending 并导致
 * `plugin tree failed to load: 1 entry did not activate`。
 * 面板通道走 `ctx.inject(['connection'], ...)` 运行时取，拿不到就安静跳过。
 */
export const inject: readonly string[] = []

/** 插件日志接口（cordis 的 `ctx.logger` 是可选服务，故全部 `?.`）。 */
interface MagpieLogger {
  debug?(message: string): void
  info?(message: string): void
  warn?(message: string): void
}

/**
 * 把 cordis 的可选 logger 归一化成**必填**的告警出口。
 *
 * ## 为什么不能直接把 `ctx.logger` 传下去
 *
 * `RequestContext.logger` 与 `MagpieAdapterOptions.logger` 都声明成
 * `{ warn(message: string): void }`（**必需**方法）—— 因为下游所有调用点都是
 * `context.logger.warn(…)` 这种直调。而 cordis 的 `ctx.logger` 在类型上是
 * `Logger | undefined`，且其 `warn` 本身也可能缺席（不同 profile 的 logger
 * 实现不同）。直接断言会让「logger 恰好缺 warn」变成运行时 `TypeError`。
 *
 * 这里给出一个**恒可用**的薄壳：缺什么就静默丢弃，绝不在日志路径上抛错。
 *
 * @param ctx - 插件上下文。
 * @returns 恒可用的 logger。
 */
function makeLogger(ctx: Context): { debug(message: string): void; warn(message: string): void } {
  const raw = ctx.logger as MagpieLogger | undefined
  return {
    debug: (message: string): void => {
      raw?.debug?.(message)
    },
    warn: (message: string): void => {
      raw?.warn?.(message)
    },
  }
}

/**
 * 注册面板 RPC 端点。
 *
 * 协议与 `dsh-providers-hub` 的 Jet Hub 通道一致：
 * - 请求：`{ type: 'client-request', rpcId, method: '<endpoint>', payload: { method, … } }`
 * - 响应：`{ type: 'server-response', rpcId, result }`
 *
 * ⚠️ 出错时**必须**回规范的 `{ ok: false, error: { code, message } }` 而不是裸
 * 500 文本 —— 客户端的 `unwrapRpcResult` 只认这个形状，否则表现为「点了没反应」。
 *
 * @param ctx - 插件上下文（已含 connection）。
 * @param options - 已解析配置。
 * @param logger - 日志接口。
 * @param getBridge - 惰性取的 Web 桥。
 */
function registerPanelRpc(
  ctx: Context,
  options: MagpieOptions,
  logger: { debug(message: string): void; warn(message: string): void },
  /**
   * 惰性取的 Web 桥。
   *
   * 为什么是函数而不是实例：二进制解析可能要**下载**（首次 ~69 MB），
   * 而 `apply()` 必须同步返回。所以桥在第一次真正需要时才创建，
   * 这里只拿到一个「取桥」的函数。
   */
  getBridge: () => Promise<MagpieWebBridge>,
): void {
  const connection = (ctx as unknown as { connection?: { fetch?: { register?: unknown } } })
    .connection
  const fetchService = connection?.fetch as
    | { register?: (route: unknown) => unknown }
    | undefined
  if (typeof fetchService?.register !== 'function') {
    logger.debug(`${LOG_PREFIX} connection.fetch 不可用，面板 RPC 未注册`)
    return
  }

  /**
   * 分发一个面板方法。
   *
   * ## ⚠️ 每个分支都必须返回 `{ ok: true, value }` / `{ ok: false, error }`
   *
   * 这是 `connection.rpc.call()` 的**返回值契约**，不是可以商量的风格问题：
   * 客户端 `@deepseek-ai/dsh-client-connection` 在把响应交回调用方之前会校验
   * `result.ok` 是不是布尔。宿主返回裸对象（没有 `ok` 字段）时它抛
   * `connection: invalid server-response result` —— 界面上就是一条红色错误条，
   * 而且**没有任何堆栈指向宿主**，极难定位（本插件踩过这个坑）。
   *
   * ⇒ 所以这里**不允许**有任何 `return <裸值>` 的分支，包括 `default`。
   */
  async function handleMethod(
    method: string,
    payload: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    switch (method) {
      case 'web.url': {
        // 面板 iframe 的 src。首次调用会 spawn `magpie web`（20–30 秒），
        // 之后走缓存。失败必须是 `{ ok: false, error }` —— 见本函数头注释。
        if (!options.webEnabled) {
          return {
            ok: false,
            error: {
              code: 'magpie/web-disabled',
              message: '原版 Web UI 已在设置里关闭（webEnabled: false）。',
            },
          }
        }
        try {
          const handle = await (await getBridge()).ensure()
          return { ok: true, value: { url: handle.url, port: handle.port } }
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'magpie/web-unavailable',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }
      case 'web.dockUrl': {
        // 小窗 URL（`?mode=panel`）—— composer 输入框右侧那个按钮点开
        // 的弹窗用。和 `web.url` 共用同一个 `magpie web` 实例，只是路径不
        // 一样，所以不会多起进程。
        if (!options.webEnabled) {
          return {
            ok: false,
            error: {
              code: 'magpie/web-disabled',
              message: '原版 Web UI 已在设置里关闭（webEnabled: false）。',
            },
          }
        }
        try {
          const handle = await (await getBridge()).ensure()
          return { ok: true, value: { url: dockWindowUrl(options.webHost, handle.port) } }
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'magpie/web-unavailable',
              message: error instanceof Error ? error.message : String(error),
            },
          }
        }
      }
      default:
        // ⚠️ 必须让未知方法可辨（而不是静默 200），否则客户端拼错方法名时
        //    只会看到「面板空白」，没有任何线索。
        return {
          ok: false,
          error: { code: 'magpie/unknown-method', message: `未知方法：${method}` },
        }
    }
  }

  /**
   * 统一的 RPC 响应包装。
   *
   * ⚠️ 失败分支要补一个空的 `details: {}` —— 这是 `dsh-providers-hub` 的
   * `reply()` 同款处理：客户端的错误渲染器会读 `error.details` 做展开面板，
   * 缺字段时部分版本会直接抛 `Cannot read properties of undefined`，
   * 把「一个可读的 RPC 错误」变成「面板白屏」。
   */
  function reply(rpcId: string, result: unknown): Response {
    const value =
      typeof result === 'object' &&
      result !== null &&
      (result as Record<string, unknown>).ok === false
        ? {
            ...(result as Record<string, unknown>),
            error: {
              ...((result as Record<string, unknown>).error as Record<string, unknown>),
              details: {},
            },
          }
        : result
    return Response.json({ type: 'server-response', rpcId, result: value })
  }

  fetchService.register({
    path: PANEL_API_PATH,
    methods: ['POST'],
    requestBody: 'buffered' as const,
    async fetch(request: Request): Promise<Response> {
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405 })
      }
      const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let message: Record<string, unknown>
      try {
        message = (await request.json()) as Record<string, unknown>
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const call = message.payload as Record<string, unknown> | undefined
      if (
        message.type !== 'client-request' ||
        typeof message.rpcId !== 'string' ||
        message.method !== PANEL_ENDPOINT ||
        call === undefined ||
        typeof call.method !== 'string'
      ) {
        return reply(rpcId, {
          ok: false,
          error: { code: 'magpie/bad-request', message: '非法的 Magpie 面板请求。' },
        })
      }
      try {
        return reply(
          rpcId,
          await handleMethod(call.method, call.payload, request.signal as AbortSignal),
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        logger?.warn?.(`${LOG_PREFIX} ${String(call.method)} 失败：${detail}`)
        return reply(rpcId, {
          ok: false,
          error: { code: 'magpie/handler-failed', message: detail },
        })
      }
    },
  })
}

/**
 * 插件激活入口。
 *
 * 做的事只有三件：建目录、建适配器、注册路由。**不**做任何网络 I/O ——
 * 模型目录是惰性拉的（首次 `listModels()` 或 `resolveModel()` 触发），
 * 因此 magpie 没跑时 DSH 也能正常启动（只是模型列表为空）。
 *
 * @param ctx - 插件上下文。
 * @param config - 原始配置（可能来自 `cordis.patch.yml` 的 `config:` 块，也可能为空）。
 */
export function apply(ctx: Context, config?: unknown): void {
  const options = resolveOptions(config)
  const logger = makeLogger(ctx)

  // 原版 Web UI 的进程桥：默认**惰性**启动（第一次 `web.url` 才 spawn），
  // 因此不打开面板时不会平白多一个 magpie 进程。
  //
  // 二进制解析是异步的（可能要下载 69 MB），而 `apply()` 必须同步返回 ——
  // 所以这里只建一个「取桥」的闭包，真正的桥在第一次 `await` 时才创建。
  let bridgePromise: Promise<MagpieWebBridge> | undefined
  let bridgeInstance: MagpieWebBridge | undefined
  /**
   * 插件生命周期信号。
   *
   * 下载可能持续几分钟（69 MB），插件卸载时必须能中断 —— 否则 DSH 退出后
   * 还有一个进程在往 `~/.dsh/magpie/bin/` 里写文件。
   */
  const lifecycle = new AbortController()

  /**
   * 每个 `await` 之后重新确认插件还活着。
   *
   * ## ⚠️ 为什么必须有
   *
   * 卸载是**同步**的（`ctx.effect` 的清理函数），但 `getBridge()` 里有多次
   * `await`（解析二进制、下载 69 MB、两次解析）—— 卸载可能发生在任意两次
   * 之间。不检查的话：`bridgeInstance` 那时还是 `undefined`，清理函数
   * 什么也没关；随后异步流程继续 `new MagpieWebBridge(...)`，`autoStartGateway`
   * 的 `.then` 再去 `ensure()` spawn `magpie serve` —— **插件已卸载，
   * magpie 子进程和 HTTP 代理仍在跑**。
   */
  const assertAlive = (): void => {
    if (lifecycle.signal.aborted) {
      throw new Error('插件已卸载')
    }
  }

  /**
   * 取（并首次创建）Web 桥。
   *
   * 解析顺序：配置里的绝对路径 → `~/.dsh/magpie/bin/` → 系统安装位置 → PATH；
   * 一个都没有且 `autoDownloadMagpie` 开着，就从 GitHub 下。
   */
  const getBridge = async (): Promise<MagpieWebBridge> => {
    if (bridgePromise !== undefined) return bridgePromise
    bridgePromise = (async (): Promise<MagpieWebBridge> => {
      assertAlive()
      let binary = await resolveMagpieBinary(options.magpieBinary)
      assertAlive()

      if (binary === undefined && options.autoDownloadMagpie) {
        logger.debug(`${LOG_PREFIX} 未找到 magpie 二进制，自动下载中（首次约 69 MB）…`)
        try {
          await ensureMagpieBinary({ logger, signal: lifecycle.signal })
          binary = await resolveMagpieBinary(options.magpieBinary)
          assertAlive()
        } catch (error) {
          // 卸载打断的不算「下载失败」—— 直接抛出去，别刷 warn。
          if (lifecycle.signal.aborted) {
            throw error
          }
          // 下载失败不算致命：用户可能就想连另一台机器上的网关。
          logger.warn(
            `${LOG_PREFIX} 自动下载 magpie 失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      if (binary !== undefined) {
        logger.debug(
          `${LOG_PREFIX} 使用 magpie 二进制：${binary.path}（${describeSource(binary.source)}）`,
        )
      }

      assertAlive()
      const bridge = new MagpieWebBridge({
        binary: binary?.path,
        key: options.webKey,
        host: options.webHost,
        preferredPort: options.webPort,
        gatewayURL: options.baseURL,
        logger,
      })
      bridgeInstance = bridge
      // 构造是同步的，但两次 `await` 之间卸载可能已经发生 —— 立刻关掉，
      // 别让 `autoStartGateway` 拿着它去 spawn。
      if (lifecycle.signal.aborted) {
        bridge.dispose()
        throw new Error('插件已卸载')
      }
      return bridge
    })().catch((error: unknown) => {
      // ⚠️ 失败的 Promise 不能留在缓存里 —— 否则后续每次 `web.url` 都拿到
      //    同一个 rejected Promise，用户关掉再打开面板也永远等不到重试机会。
      //    `getBridge` 的前提是「失败一次可以再来一次」。
      bridgePromise = undefined
      throw error
    })
    return bridgePromise
  }

  // 插件 fiber 卸载时杀子进程，否则 `magpie serve` 会变成孤儿进程一直占端口。
  // ⚠️ 这里用 `bridgeInstance` 而不是 `bridgePromise` —— 卸载是同步的，
  //    不能 `await`；如果桥还没建出来，就没什么可关的。
  ctx.effect(() => () => {
    // 先中断可能正在进行的下载，再关桥 —— 顺序反了的话下载会继续跑到
    // 下一个 chunk 才停。
    lifecycle.abort()
    bridgeInstance?.dispose()
  })

  // 自动拉起网关。
  //
  // ## 为什么放在 `apply()` 而不是等面板打开
  //
  // 插件提供的是**模型**，不只是面板。用户打开 DSH 后第一件事往往是选模型
  // 发消息 —— 如果网关要等面板打开才有，那第一次发消息就会 502。
  //
  // ## 为什么不 `await`
  //
  // `apply()` 是同步的，而且 cordis 会等它返回才认为插件激活完成。真要等
  // `magpie serve` 就绪（冷启动实测 3–8 秒，插件多的时候十几秒）会拖慢
  // DSH 启动，还可能触发 fiber 超时。所以这里**后台跑**：成功/失败都只写
  // 日志，模型目录本身是惰性拉的，网关晚几秒就绪不影响正确性。
  //
  // ## 为什么失败不抛
  //
  // 网关起不来（二进制不在 PATH、端口全被占、被安全软件拦）不应该让整个
  // 插件失效 —— 用户可能就是想连另一台机器上的网关。降级成一条 warn。
  if (options.autoStartGateway) {
    void getBridge().then(
      (bridge) => {
        // 桥 resolve 之后、`ensure()` 之前可能已经卸载了 —— 这时再去
        // spawn 就是孤儿进程。
        if (lifecycle.signal.aborted) {
          return
        }
        return bridge.ensure().then(
          (handle) => {
            logger.debug(
              `${LOG_PREFIX} 网关已就绪：${options.baseURL}（Web UI 代理 ${handle.url}）`,
            )
          },
          (error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error)
            logger.warn(
              `${LOG_PREFIX} 自动启动网关失败：${detail}；` +
                `如果网关跑在别处，把 autoStartGateway 关掉即可`,
            )
          },
        )
      },
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        logger.warn(`${LOG_PREFIX} 准备 magpie 二进制失败：${detail}`)
      },
    )
  }

  // 面板通道：只有 Web profile 里才存在 connection，其余 profile 安静跳过。
  ctx.inject(['connection'], (connectionCtx) => {
    registerPanelRpc(connectionCtx as Context, options, logger, getBridge)
  })
}
