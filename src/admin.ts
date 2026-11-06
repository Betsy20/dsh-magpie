/**
 * magpie 管理 API 的类型化客户端。
 *
 * ## 职责边界
 *
 * 本模块**只做管理面**（额度 / 用量 / 限流 / 路由 / 并发 / 健康），
 * 不参与对话链路 —— 对话走 {@link MagpieAdapter}。两者共用
 * {@link RequestContext}（也就是同一套鉴权头、同一个取消信号），
 * 但互不依赖：面板挂掉不影响模型可用性。
 *
 * ## 为什么所有方法都「不抛」
 *
 * 管理面全是**装饰性**的：额度查不到、用量面板加载失败，都不该让
 * 用户的会话中断。因此每个方法都返回
 * `{ ok: true, data } | { ok: false, error }` 而不是抛异常 ——
 * 调用方（面板 / 工具）只需渲染 `error.message`，不必包 try/catch。
 * 唯一的例外是 {@link MagpieAdminClient.snapshot}：它把多个端点
 * 合并成一次快照，本身也不会抛。
 *
 * ## 端点来源
 *
 * 全部实测自 magpie v0.12.6（`D:/dsh-build/specs/magpie-api.md`
 * 的 C 章）。⚠️ 这些是**非公开**端点（magpie 的 README 明确说不接受
 * PR），升级后可能变；因此每个方法都做了缺字段兜底，字段缺失时
 * 退化成「空列表 / 0」而不是 `undefined` 冒到 UI 上。
 *
 * @module dsh-magpie/client
 */

import { requestJson, type RequestContext } from './http.js'
import type {
  WireConcurrency,
  WireHello,
  WireKeyList,
  WireLimit,
  WireQuotaList,
  WireRouteEvent,
  WireRouteSnapshot,
  WireStatusline,
  WireTagList,
  WireUsageReport,
  WireUsageRequestPage,
} from './types.js'

/** 管理调用的统一结果。 */
export type AdminResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: AdminError }

/** 管理调用失败信息。 */
export interface AdminError {
  /** 面向用户的一句话（已是中文，可直接渲染）。 */
  readonly message: string
  /** 机器可判的失败码（`AUTH` / `TIMEOUT` / `TRANSPORT` / `HTTP_404` …）。 */
  readonly code: string
  /** HTTP 状态码（纯传输故障时为 `undefined`）。 */
  readonly status?: number
}

/**
 * 面板一次性需要的全部数据。
 *
 * 用**一个**快照对象而不是 N 个独立请求，是因为面板挂载时会并发拉
 * 6~7 个端点；分开做的话每个都要处理 loading / error 态，UI 代码会
 * 膨胀成 7 份几乎相同的分支。
 */
export interface MagpieSnapshot {
  /** 网关是否可达（`/api/hello` 成功即视为可达）。 */
  readonly reachable: boolean
  /** 网关版本（来自 `/api/hello`）；不可达时为 `undefined`。 */
  readonly version: string | undefined
  /** 模型目录（`/v1/models`）。 */
  readonly models: readonly SnapshotModel[]
  /** 额度（`/v1/magpie/quotas`）。 */
  readonly quotas: readonly SnapshotQuota[]
  /** 用量汇总（`/v1/magpie/usage`）。 */
  readonly usage: SnapshotUsage | undefined
  /** 限流状态（`/v1/magpie/limit`）。 */
  readonly limit: SnapshotLimit | undefined
  /** 并发（`/v1/magpie/concurrency`）。 */
  readonly concurrency: SnapshotConcurrency | undefined
  /** 最近的路由事件（`/v1/magpie/route-events/snapshot`）。 */
  readonly routes: readonly SnapshotRoute[]
  /** 各端点失败的明细（键是端点路径，值是失败信息）。 */
  readonly failures: Readonly<Record<string, AdminError>>
}

/** 快照里的模型条目（只保留面板要展示的字段）。 */
export interface SnapshotModel {
  readonly id: string
  readonly name: string
  readonly ownedBy: string | undefined
  readonly contextWindow: number | undefined
  readonly maxOutputTokens: number | undefined
  readonly reasoningLevels: readonly string[]
  readonly supportsImage: boolean
  readonly disabled: boolean
}

/** 快照里的额度条目。 */
export interface SnapshotQuota {
  readonly provider: string
  readonly name: string
  readonly kind: string | undefined
  readonly plan: string | undefined
  readonly balance: string | undefined
  readonly until: string | undefined
  readonly windows: readonly SnapshotQuotaWindow[]
}

/** 额度窗口。 */
export interface SnapshotQuotaWindow {
  readonly name: string
  readonly used: number | undefined
  readonly limit: number | undefined
  readonly remaining: number | undefined
  readonly display: string | undefined
  readonly resetsAt: string | undefined
}

/** 用量汇总（字段名保持 magpie 的 snake_case 语义，但转成 camelCase）。 */
export interface SnapshotUsage {
  readonly period: string | undefined
  readonly since: string | undefined
  readonly calls: number
  readonly errors: number
  readonly retried: number
  readonly loops: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly reasoning: number
  readonly cost: number
  readonly credits: number
  readonly unpriced: number
  readonly series: readonly SnapshotUsagePoint[]
}

/** 用量曲线上的一个点。 */
export interface SnapshotUsagePoint {
  readonly label: string
  readonly time: string | undefined
  readonly calls: number
  readonly errors: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cost: number
}

/** 限流状态。 */
export interface SnapshotLimit {
  readonly key: string
  readonly limited: boolean
  readonly expires: string | undefined
}

/** 并发状态。 */
export interface SnapshotConcurrency {
  readonly requests: number
  readonly tools: number
  readonly waiting: number
  readonly active: readonly SnapshotActiveRequest[]
  readonly providers: readonly SnapshotProviderLoad[]
}

/** 一条进行中的请求。 */
export interface SnapshotActiveRequest {
  readonly id: number | string
  readonly agent: string | undefined
  readonly model: string | undefined
  readonly provider: string | undefined
  readonly session: string | undefined
  readonly started: string | undefined
  readonly ms: number | undefined
  readonly phase: string | undefined
}

/** 单个 provider 账号的负载。 */
export interface SnapshotProviderLoad {
  readonly account: string
  readonly busy: number
  readonly waiting: number
  readonly limit: number | undefined
}

/** 一条路由事件。 */
export interface SnapshotRoute {
  readonly id: string
  readonly time: string | undefined
  readonly agent: string | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly attempt: number | undefined
  readonly fallback: boolean
  readonly phase: string | undefined
}

// #region 内部工具

/**
 * 把一次管理调用包成 {@link AdminResult}。
 *
 * @param path - 端点路径（用于失败信息里的文案）。
 * @param run - 真正的调用。
 * @returns 成功或失败，**永不抛**。
 */
async function attempt<T>(path: string, run: () => Promise<T>): Promise<AdminResult<T>> {
  try {
    return { ok: true, data: await run() }
  } catch (error) {
    return { ok: false, error: toAdminError(path, error) }
  }
}

/**
 * 把任意异常归一成 {@link AdminError}。
 *
 * @param path - 端点路径。
 * @param error - 捕获到的异常。
 * @returns 归一后的失败信息。
 */
function toAdminError(path: string, error: unknown): AdminError {
  const record = error as { message?: unknown; code?: unknown; status?: unknown } | null
  const message =
    typeof record?.message === 'string' && record.message.length > 0
      ? record.message
      : `请求 ${path} 失败`
  const code = typeof record?.code === 'string' && record.code.length > 0 ? record.code : 'UNKNOWN'
  return typeof record?.status === 'number'
    ? { message, code, status: record.status }
    : { message, code }
}

/** 安全取数：非有限数一律归 0（面板不该显示 `NaN`）。 */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 安全取字符串。 */
function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 安全取字符串数组。 */
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

// #endregion

/**
 * magpie 管理 API 客户端。
 *
 * 无状态：所有方法都接受一个 {@link RequestContext}（内含 baseURL、
 * API key、取消信号），因此同一个实例可以服务多个会话。
 */
export class MagpieAdminClient {
  /**
   * `GET /api/hello` —— 网关存活探测。
   *
   * magpie 有**两套**版本号：`/api/hello` 的 `0.1.2971`（构建号）与
   * `/api/version` 的 `0.12.6`（语义版本）。面板展示用前者
   * （`magpie --version` 输出的也是它）。
   */
  async hello(context: RequestContext): Promise<AdminResult<WireHello>> {
    return attempt('/api/hello', () => requestJson<WireHello>(context, '/api/hello'))
  }

  /** `GET /api/version` —— 语义版本。 */
  async version(context: RequestContext): Promise<AdminResult<{ version: string }>> {
    return attempt('/api/version', () =>
      requestJson<{ version: string }>(context, '/api/version'),
    )
  }

  /** `GET /v1/magpie/quotas` —— 各 provider 账号的额度。 */
  async quotas(context: RequestContext): Promise<AdminResult<WireQuotaList>> {
    return attempt('/v1/magpie/quotas', () =>
      requestJson<WireQuotaList>(context, '/v1/magpie/quotas'),
    )
  }

  /**
   * `GET /v1/magpie/usage` —— 用量汇总。
   *
   * ⚠️ 该端点默认返回 30 天 + 按天分桶的完整序列（实测 **162 KB**）。
   * 面板只需要最近几个点，但序列化成本已经在响应里了 —— 若将来
   * 变成性能问题，可改走 `/v1/magpie/statusline`（4 KB 纯文本）。
   */
  async usage(context: RequestContext): Promise<AdminResult<WireUsageReport>> {
    return attempt('/v1/magpie/usage', () =>
      requestJson<WireUsageReport>(context, '/v1/magpie/usage'),
    )
  }

  /** `GET /v1/magpie/usage/requests` —— 逐请求明细（实测 177 KB）。 */
  async usageRequests(
    context: RequestContext,
    query: { limit?: number; cursor?: string } = {},
  ): Promise<AdminResult<WireUsageRequestPage>> {
    const params = new URLSearchParams()
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    if (query.cursor !== undefined) params.set('cursor', query.cursor)
    const suffix = params.size > 0 ? `?${params.toString()}` : ''
    return attempt('/v1/magpie/usage/requests', () =>
      requestJson<WireUsageRequestPage>(context, `/v1/magpie/usage/requests${suffix}`),
    )
  }

  /**
   * `GET /v1/magpie/limit` —— 当前 key 的限流状态。
   *
   * 基础只有 `{key, limited}` 两个键；被限制时才会追加
   * `heldTo` / `quotas` / `models` / `quotaProviders` 等字段。
   */
  async limit(context: RequestContext): Promise<AdminResult<WireLimit>> {
    return attempt('/v1/magpie/limit', () =>
      requestJson<WireLimit>(context, '/v1/magpie/limit'),
    )
  }

  /** `GET /v1/magpie/concurrency` —— 并发与排队。 */
  async concurrency(context: RequestContext): Promise<AdminResult<WireConcurrency>> {
    return attempt('/v1/magpie/concurrency', () =>
      requestJson<WireConcurrency>(context, '/v1/magpie/concurrency'),
    )
  }

  /**
   * `GET /v1/magpie/route-events/snapshot` —— 最近的路由决策。
   *
   * ⚠️ `/v1/magpie/route-events`（不带 `cursor`）会返回 **409 +
   * `{"error":"snapshot_required"}`**，且那里 `error` 是**字符串**而不是
   * 对象 —— 全仓唯一的异形。快照端点没有这个问题。
   */
  async routeSnapshot(context: RequestContext): Promise<AdminResult<WireRouteSnapshot>> {
    return attempt('/v1/magpie/route-events/snapshot', () =>
      requestJson<WireRouteSnapshot>(context, '/v1/magpie/route-events/snapshot'),
    )
  }

  /**
   * `GET /v1/magpie/route` —— 单次请求的路由明细。
   *
   * ⚠️ **必须**给 `session`（或 `X-Magpie-Session` 头），否则 400。
   */
  async route(
    context: RequestContext,
    query: { session: string; after?: number; wait?: number },
  ): Promise<AdminResult<WireRouteEvent>> {
    const params = new URLSearchParams({ session: query.session })
    if (query.after !== undefined) params.set('after', String(query.after))
    if (query.wait !== undefined) params.set('wait', String(query.wait))
    return attempt('/v1/magpie/route', () =>
      requestJson<WireRouteEvent>(context, `/v1/magpie/route?${params.toString()}`),
    )
  }

  /** `GET /v1/magpie/keys` —— 已命名的 API key 列表。 */
  async keys(context: RequestContext): Promise<AdminResult<WireKeyList>> {
    return attempt('/v1/magpie/keys', () =>
      requestJson<WireKeyList>(context, '/v1/magpie/keys'),
    )
  }

  /** `GET /api/tags` —— 模型标签（用于分组展示）。 */
  async tags(context: RequestContext): Promise<AdminResult<WireTagList>> {
    return attempt('/api/tags', () => requestJson<WireTagList>(context, '/api/tags'))
  }

  /** `GET /v1/magpie/statusline` —— 纯文本状态行（4 KB）。 */
  async statusline(context: RequestContext): Promise<AdminResult<WireStatusline>> {
    return attempt('/v1/magpie/statusline', () =>
      requestJson<WireStatusline>(context, '/v1/magpie/statusline'),
    )
  }

  /**
   * 拉取面板需要的全部数据。
   *
   * 6 个端点**并发**发起：串行的话最坏情况要 6 × 超时，面板会白屏
   * 一整分钟。任何一个失败都不影响其它端点（`failures` 里留明细）。
   *
   * ⚠️ `models` 不在这里拉 —— 它走 {@link ModelCatalog} 的缓存，
   * 否则面板一打开就会额外打一次 20 条模型的全量请求，而这份数据
   * adapter 已经在用，重复拉没有意义。调用方把目录传进来即可。
   *
   * @param context - 请求上下文。
   * @param models - 已由目录缓存提供的模型列表。
   * @returns 合并后的快照（**永不抛**）。
   */
  async snapshot(
    context: RequestContext,
    models: readonly SnapshotModel[],
  ): Promise<MagpieSnapshot> {
    const [hello, quotas, usage, limit, concurrency, routes] = await Promise.all([
      this.hello(context),
      this.quotas(context),
      this.usage(context),
      this.limit(context),
      this.concurrency(context),
      this.routeSnapshot(context),
    ])

    const failures: Record<string, AdminError> = {}
    if (!hello.ok) failures['/api/hello'] = hello.error
    if (!quotas.ok) failures['/v1/magpie/quotas'] = quotas.error
    if (!usage.ok) failures['/v1/magpie/usage'] = usage.error
    if (!limit.ok) failures['/v1/magpie/limit'] = limit.error
    if (!concurrency.ok) failures['/v1/magpie/concurrency'] = concurrency.error
    if (!routes.ok) failures['/v1/magpie/route-events/snapshot'] = routes.error

    return {
      reachable: hello.ok,
      version: hello.ok ? str(hello.data.version) : undefined,
      models,
      quotas: quotas.ok ? (quotas.data.data ?? []).map(toSnapshotQuota) : [],
      usage: usage.ok ? toSnapshotUsage(usage.data) : undefined,
      limit: limit.ok ? toSnapshotLimit(limit.data) : undefined,
      concurrency: concurrency.ok ? toSnapshotConcurrency(concurrency.data) : undefined,
      routes: routes.ok ? (routes.data.routes ?? []).map(toSnapshotRoute) : [],
      failures,
    }
  }
}

// #region 归一化（线格式 → 面板模型）

/** @param quota - 线格式额度。 @returns 面板模型。 */
function toSnapshotQuota(quota: {
  provider?: unknown
  name?: unknown
  kind?: unknown
  plan?: unknown
  balance?: unknown
  until?: unknown
  windows?: readonly unknown[]
}): SnapshotQuota {
  return {
    provider: str(quota.provider) ?? '',
    name: str(quota.name) ?? str(quota.provider) ?? '',
    kind: str(quota.kind),
    plan: str(quota.plan),
    balance: str(quota.balance),
    until: str(quota.until),
    windows: Array.isArray(quota.windows)
      ? quota.windows.map((raw) => {
          const window = raw as {
            name?: unknown
            used?: unknown
            limit?: unknown
            remaining?: unknown
            display?: unknown
            resetsAt?: unknown
          }
          return {
            name: str(window.name) ?? '',
            used: typeof window.used === 'number' ? window.used : undefined,
            limit: typeof window.limit === 'number' ? window.limit : undefined,
            remaining: typeof window.remaining === 'number' ? window.remaining : undefined,
            display: str(window.display),
            resetsAt: str(window.resetsAt),
          }
        })
      : [],
  }
}

/** @param report - 线格式用量。 @returns 面板模型。 */
function toSnapshotUsage(report: {
  period?: unknown
  since?: unknown
  calls?: unknown
  errors?: unknown
  retried?: unknown
  loops?: unknown
  input?: unknown
  output?: unknown
  cache_read?: unknown
  cache_write?: unknown
  reasoning?: unknown
  cost?: unknown
  credits?: unknown
  unpriced?: unknown
  series?: readonly unknown[]
}): SnapshotUsage {
  return {
    period: str(report.period),
    since: str(report.since),
    calls: num(report.calls),
    errors: num(report.errors),
    retried: num(report.retried),
    loops: num(report.loops),
    input: num(report.input),
    output: num(report.output),
    cacheRead: num(report.cache_read),
    cacheWrite: num(report.cache_write),
    reasoning: num(report.reasoning),
    cost: num(report.cost),
    credits: num(report.credits),
    unpriced: num(report.unpriced),
    series: Array.isArray(report.series)
      ? report.series.map((raw) => {
          const point = raw as {
            label?: unknown
            time?: unknown
            calls?: unknown
            errors?: unknown
            input?: unknown
            output?: unknown
            cache_read?: unknown
            cost?: unknown
          }
          return {
            label: str(point.label) ?? '',
            time: str(point.time),
            calls: num(point.calls),
            errors: num(point.errors),
            input: num(point.input),
            output: num(point.output),
            cacheRead: num(point.cache_read),
            cost: num(point.cost),
          }
        })
      : [],
  }
}

/** @param limit - 线格式限流。 @returns 面板模型。 */
function toSnapshotLimit(limit: {
  key?: unknown
  limited?: unknown
  expires?: unknown
}): SnapshotLimit {
  return {
    key: str(limit.key) ?? '',
    limited: limit.limited === true,
    expires: str(limit.expires),
  }
}

/** @param payload - 线格式并发。 @returns 面板模型。 */
function toSnapshotConcurrency(payload: WireConcurrency): SnapshotConcurrency {
  const providers: SnapshotProviderLoad[] = []
  const data = payload.data
  if (data !== undefined && data !== null && typeof data === 'object') {
    for (const [account, raw] of Object.entries(data)) {
      const load = raw as { busy?: unknown; waiting?: unknown; limit?: unknown }
      providers.push({
        account,
        busy: num(load.busy),
        waiting: num(load.waiting),
        limit: typeof load.limit === 'number' ? load.limit : undefined,
      })
    }
  }
  return {
    requests: num(payload.requests),
    tools: num(payload.tools),
    waiting: num(payload.waiting),
    active: (payload.active ?? []).map((raw) => ({
      id: typeof raw.id === 'number' ? raw.id : String(raw.id ?? ''),
      agent: str(raw.agent),
      model: str(raw.model),
      provider: str(raw.provider),
      session: str(raw.session),
      started: str(raw.started),
      ms: typeof raw.ms === 'number' ? raw.ms : undefined,
      phase: str(raw.phase),
    })),
    providers,
  }
}

/** @param route - 线格式路由事件。 @returns 面板模型。 */
function toSnapshotRoute(route: {
  id?: unknown
  time?: unknown
  agent?: unknown
  provider?: unknown
  model?: unknown
  attempt?: unknown
  fallback?: unknown
  phase?: unknown
}): SnapshotRoute {
  return {
    id: str(route.id) ?? '',
    time: str(route.time),
    agent: str(route.agent),
    provider: str(route.provider),
    model: str(route.model),
    attempt: typeof route.attempt === 'number' ? route.attempt : undefined,
    fallback: route.fallback === true,
    phase: str(route.phase),
  }
}

// #endregion

/** 把线格式模型归一成面板模型（供 adapter 的目录复用）。 */
export function toSnapshotModel(model: {
  id?: unknown
  display_name?: unknown
  magpie_label?: unknown
  owned_by?: unknown
  context_window?: unknown
  context_length?: unknown
  max_input_tokens?: unknown
  max_output_tokens?: unknown
  reasoning_levels?: unknown
  supported_reasoning_levels?: unknown
  modalities?: { input?: unknown }
}): SnapshotModel {
  const firstPositive = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
    }
    return undefined
  }
  const levels = strings(model.reasoning_levels)
  if (levels.length === 0 && Array.isArray(model.supported_reasoning_levels)) {
    for (const raw of model.supported_reasoning_levels) {
      const effort = str((raw as { effort?: unknown }).effort)
      if (effort !== undefined) levels.push(effort)
    }
  }
  return {
    id: str(model.id) ?? '',
    name: str(model.magpie_label) ?? str(model.display_name) ?? str(model.id) ?? '',
    ownedBy: str(model.owned_by),
    contextWindow: firstPositive(
      model.context_window,
      model.context_length,
      model.max_input_tokens,
    ),
    maxOutputTokens: firstPositive(model.max_output_tokens),
    reasoningLevels: levels,
    supportsImage: strings(model.modalities?.input).includes('image'),
    disabled: (str(model.magpie_label) ?? '').includes('已在 Jet Hub 关闭'),
  }
}
