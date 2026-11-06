/**
 * DSH 插件入口：把 magpie 网关注册成一个 LLM provider。
 *
 * ## 形状
 *
 * cordis 插件是**四个具名导出**（不能有 `default`）：
 *
 * ```ts
 * export const name = 'magpie'        // = package.json 的 name，也是 cordis.patch.yml 的 name
 * export const inject = ['llm']       // 只有 llm；connection 走惰性注入（见下）
 * export const Config = Schema.object({ ... })
 * export function apply(ctx, config) { ... }
 * ```
 *
 * ⚠️ **`default` 导出会让插件静默失效**：Loader 取 `default` 时拿不到本模块的
 * `name` / `inject`，fiber 会以空 inject 列表激活，第一次读 `ctx.llm` 就抛
 * `cannot get property "llm" without inject`。
 *
 * ## 为什么 `connection` 不进静态 `inject`
 *
 * `connection` 服务只由 Web bundle（`@deepseek-ai/dsh-client-connection`）提供，
 * headless / CLI profile 里**不存在**。静态列它会让本插件在那些 profile 里
 * 永久 pending，整个 profile 启动失败并报
 * `plugin tree failed to load: 1 entry did not activate`。
 * 面板 RPC 因此走 {@link Context.inject} 的**惰性**注入：有 connection 就挂，
 * 没有就安静跳过 —— 模型能力与 UI 通道彻底解耦。
 *
 * ## provider id
 *
 * 固定为 `magpie`（见 `product.ts` 的 {@link PROVIDER}）。⚠️ 同一个 provider
 * 只能有一个 adapter，重复注册会抛 `LlmError` code `DUPLICATE_ADAPTER` 并让
 * profile 启动失败 —— 因此安装本插件时**必须**把 profile 里原有的
 * `@deepseek-ai/dsh-llm-pi-ai` 的 `magpie` provider 段注释掉。
 *
 * @module dsh-magpie
 */

import type { Context } from '@deepseek-ai/cordis'
// ⚠️ schemastery 是 **default 导出**（`export default Schema`），不是命名导出。
//    写成 `import { Schema }` 会得到 `TS2614: has no exported member 'Schema'`，
//    而由于它只是**类型**层面失败（运行时 `undefined`），忘记看 tsc 输出的话
//    会在插件激活时以 `Schema is not a function` 崩在 profile 启动阶段。
import Schema from '@deepseek-ai/schemastery'

import { MagpieAdapter } from './adapter.js'
import { ModelCatalog } from './catalog.js'
import { MagpieAdminClient, toSnapshotModel, type SnapshotModel } from './admin.js'
import { resolveApiKey, resolveOptions, type MagpieOptions } from './config.js'
import { describeSource, resolveMagpieBinary } from './binary.js'
import { ensureMagpieBinary } from './download.js'
import { LOG_PREFIX, PROVIDER } from './product.js'
import type { RequestContext } from './http.js'
import { MagpieWebBridge } from './web-bridge.js'

/** 面板 RPC 的 HTTP 路径（POST）。 */
export const PANEL_API_PATH = '/api/magpie'

/** 面板 RPC 的通道名（`payload.method` 的命名空间）。 */
const PANEL_ENDPOINT = 'magpie'

/**
 * 插件 Config schema。
 *
 * ⚠️ **必须是 schemastery schema**：`SettingsForms.describe()` 会对每一项调
 * `schema.toJSON()`，传裸函数（`(value) => ...`）会让它抛
 * `TypeError: … .toJSON is not a function`，进而使**所有**依赖 settings 的
 * 界面（模型设置页、sidebar 的 settings.get/shell.get）全部失败。
 *
 * ⚠️ `.volatile()` 只能加在**字段**上，**不能**加在顶层 `Schema.object(...)`：
 * `SchemaOutput<T, M> = M extends 'volatile' ? Volatile<T | undefined> : …`，
 * 加在顶层会让 `config.baseURL` 直接报 `Property 'baseURL' does not exist on
 * type 'Volatile<…> | undefined'`。
 *
 * 字段语义见 {@link MagpieOptions}。
 */
export const Config = Schema.object({
  baseURL: Schema.string()
    .description('magpie 网关地址（默认 http://127.0.0.1:3425）')
    .default('http://127.0.0.1:3425')
    .volatile(),
  apiKey: Schema.string()
    .description('网关 API key；留空则读环境变量 MAGPIE_GATEWAY_KEY，再退回 "magpie"')
    .role('secret')
    .default('')
    .volatile(),
  apiKeyEnv: Schema.string()
    .description('apiKey 为空时要读的环境变量名')
    .default('MAGPIE_GATEWAY_KEY')
    .volatile(),
  requestTimeoutMs: Schema.number()
    .description('模型目录 / 管理 API 的单次请求超时（毫秒）')
    .default(10_000)
    .volatile(),
  streamIdleTimeoutMs: Schema.number()
    .description('流式响应的空闲超时（毫秒）；深度思考模型长推理时不要调得太小')
    .default(600_000)
    .volatile(),
  catalogTtlMs: Schema.number()
    .description('模型目录缓存有效期（毫秒）')
    .default(60_000)
    .volatile(),
  modelInclude: Schema.array(Schema.string())
    .description('只暴露匹配这些 glob 的模型（空 = 全部）')
    .default([])
    .volatile(),
  modelExclude: Schema.array(Schema.string())
    .description('隐藏匹配这些 glob 的模型')
    .default([])
    .volatile(),
  includeDisabledModels: Schema.boolean()
    .description('是否暴露已在 Jet Hub 关闭的模型')
    .default(true)
    .volatile(),
  sessionHeader: Schema.boolean()
    .description('是否把 DSH 会话 id 通过 X-Magpie-Session 头传给网关')
    .default(true)
    .volatile(),
})

/** cordis 条目 id。**必须**与 `package.json` 的 `name` 及 `cordis.patch.yml` 的 `name` 一致。 */
export const name = 'magpie'

/**
 * 静态依赖。
 *
 * ⚠️ 只列 `llm`。`connection` 见模块头的说明。
 */
export const inject = ['llm']

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
 * 造一个「把附件读成 data URL」的函数。
 *
 * ## 为什么不能静态 import 附件类型
 *
 * `@deepseek-ai/dsh-attachment` 只是 `@deepseek-ai/dsh-llm` 的
 * **devDependency** —— 运行时由宿主提供，但**没有**可被插件引用的类型入口。
 * 因此这里按结构化类型收窄到只用到的那一个方法（与 `dsh-providers-hub` 的
 * `makeReadImage` 同款）。
 *
 * ## 失败语义
 *
 * 抛错而不是返回占位文本：调用方（`messages.ts` 的 `resolveImageUrl`）会
 * 捕获并降级成 `[图片：当前请求未能内联该附件]`。这样「图片读不出来」不会
 * 让整轮对话失败，但历史里能看出发生了什么。
 *
 * @param ctx - 插件上下文。
 * @returns 附件 → `data:<mediaType>;base64,<…>`。
 */
function makeReadImage(ctx: Context): (attachment: unknown) => Promise<string> {
  return async (attachment: unknown): Promise<string> => {
    const attachments = ctx.get('attachments') as
      | {
          readImage?: (
            ref: never,
          ) => Promise<{ data: Uint8Array; ref: { mediaType: string } }>
        }
      | undefined
    if (typeof attachments?.readImage !== 'function') {
      throw new Error('附件服务（attachments）不可用，无法内联图片')
    }
    const stored = await attachments.readImage(attachment as never)
    return `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString('base64')}`
  }
}

/**
 * 构造请求上下文（管理面与对话面共用同一套头）。
 *
 * @param options - 已解析的配置。
 * @param sessionId - 当前 DSH 会话 id（可空）。
 * @param signal - 取消信号（可空）。
 * @param logger - 日志接口。
 * @returns 请求上下文。
 */
function makeContext(
  options: MagpieOptions,
  sessionId: string | undefined,
  signal: AbortSignal | undefined,
  logger: { warn(message: string): void },
): RequestContext {
  return {
    options,
    // ⚠️ 必须走 `resolveApiKey`（配置 → 环境变量 → 出厂值三级兜底），
    //    直接用 `options.apiKey` 会在用户留空时发出 `Bearer ` 空头。
    apiKey: resolveApiKey(options),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(signal === undefined ? {} : { signal }),
    logger,
  }
}

/**
 * 把目录快照转成面板模型列表。
 *
 * @param models - `ModelCatalog` 给出的模型条目。
 * @returns 面板用的精简结构。
 */
function toPanelModels(models: readonly unknown[]): SnapshotModel[] {
  return models.map((raw) => toSnapshotModel(raw as Parameters<typeof toSnapshotModel>[0]))
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
 * @param catalog - 模型目录。
 * @param options - 已解析配置。
 * @param logger - 日志接口。
 */
function registerPanelRpc(
  ctx: Context,
  catalog: ModelCatalog,
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

  const admin = new MagpieAdminClient()

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
      case 'panel.snapshot': {
        const context = makeContext(options, undefined, signal, logger)
        const snapshot = await catalog.get()
        return { ok: true, value: await admin.snapshot(context, toPanelModels(snapshot.models)) }
      }
      case 'catalog.refresh': {
        catalog.invalidate()
        const snapshot = await catalog.get()
        return {
          ok: true,
          value: {
            models: toPanelModels(snapshot.models),
            version: snapshot.gatewayVersion,
          },
        }
      }
      case 'gateway.version': {
        const context = makeContext(options, undefined, signal, logger)
        const hello = await admin.hello(context)
        return hello.ok
          ? { ok: true, value: { version: hello.data.version } }
          : { ok: false, error: hello.error }
      }
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
  // `ModelCatalog` 与 `MagpieAdapter` 都收 **getter** 而不是值 —— 配置热重载
  // （profile 的 `patchReload: "live"`）会重建插件 fiber，但同一 fiber 内也可能
  // 被 `catalog.refresh` 等方法重新读取；用 getter 保证「读到的永远是当前值」。
  const catalog = new ModelCatalog(
    () => makeContext(options, undefined, undefined, logger),
    () => options,
    logger,
  )
  const adapter = new MagpieAdapter({
    catalog,
    options: () => options,
    readImage: makeReadImage(ctx),
    logger,
  })

  // 原版 Web UI 的进程桥：默认**惰性**启动（第一次 `web.url` 才 spawn），
  // 因此不打开面板时不会平白多一个 magpie 进程。
  //
  // 二进制解析是异步的（可能要下载 69 MB），而 `apply()` 必须同步返回 ——
  // 所以这里只建一个「取桥」的闭包，真正的桥在第一次 `await` 时才创建。
  let bridgePromise: Promise<MagpieWebBridge> | undefined
  let bridgeInstance: MagpieWebBridge | undefined

  /**
   * 取（并首次创建）Web 桥。
   *
   * 解析顺序：配置里的绝对路径 → `~/.dsh/magpie/bin/` → 系统安装位置 → PATH；
   * 一个都没有且 `autoDownloadMagpie` 开着，就从 GitHub 下。
   */
  const getBridge = async (): Promise<MagpieWebBridge> => {
    if (bridgePromise !== undefined) return bridgePromise
    bridgePromise = (async (): Promise<MagpieWebBridge> => {
      let binary = await resolveMagpieBinary(options.magpieBinary)

      if (binary === undefined && options.autoDownloadMagpie) {
        logger.debug(`${LOG_PREFIX} 未找到 magpie 二进制，自动下载中（首次约 69 MB）…`)
        try {
          await ensureMagpieBinary({ logger })
          binary = await resolveMagpieBinary(options.magpieBinary)
        } catch (error) {
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

      const bridge = new MagpieWebBridge({
        binary: binary?.path,
        key: options.webKey,
        host: options.webHost,
        preferredPort: options.webPort,
        gatewayURL: options.baseURL,
        logger,
      })
      bridgeInstance = bridge
      return bridge
    })()
    return bridgePromise
  }

  // 插件 fiber 卸载时杀子进程，否则 `magpie serve` 会变成孤儿进程一直占端口。
  // ⚠️ 这里用 `bridgeInstance` 而不是 `bridgePromise` —— 卸载是同步的，
  //    不能 `await`；如果桥还没建出来，就没什么可关的。
  ctx.effect(() => () => {
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
      (bridge) =>
        bridge.ensure().then(
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
        ),
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error)
        logger.warn(`${LOG_PREFIX} 准备 magpie 二进制失败：${detail}`)
      },
    )
  }

  // ⚠️ `registerAdapter` 内部已经 `ctx.effect(...)`，插件 fiber 卸载时自动注销，
  //    这里**不要**再包一层 effect（双层释放会让 handle 第二次调用抛
  //    `REGISTRATION_DISPOSED`）。
  ctx.llm.registerAdapter([PROVIDER], adapter)
  logger.debug(`${LOG_PREFIX} 已注册 provider "${PROVIDER}"（${options.baseURL}）`)

  // 面板通道：只有 Web profile 里才存在 connection，其余 profile 安静跳过。
  ctx.inject(['connection'], (connectionCtx) => {
    registerPanelRpc(connectionCtx as Context, catalog, options, logger, getBridge)
  })
}
