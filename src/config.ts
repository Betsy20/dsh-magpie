/**
 * 插件配置：Schemastery schema + 归一化。
 *
 * ## 为什么必须是 schemastery schema（而不是裸对象或普通函数）
 *
 * 宿主的 `SettingsForms.describe()` 会对**每个**已注册项调用 `schema.toJSON()`。
 * 传入裸函数（`(value) => ...`）会让它抛
 * `TypeError: ... .toJSON is not a function`，进而使**所有**依赖 settings 的界面
 * （模型设置页、sidebar 的 `settings.get` / `shell.get`）全部失败 ——
 * 一个 provider 插件的配置写法能拖垮整个设置面。
 *
 * ## 字段的可写性
 *
 * 只有标记 `.volatile()` 的字段会投影进设置表单（DSH 0.1.7-rc.1 起的规则），
 * 其余字段是只读文档。这里所有业务字段都是可写的 —— 用户理应能在界面上改
 * 网关地址，而不必去手改 YAML。
 *
 * @module dsh-magpie/config
 */

import Schema from '@deepseek-ai/schemastery'
import { API_KEY_ENV, DEFAULT_API_KEY, DEFAULT_BASE_URL } from './product.js'

/** 插件配置的**归一化后**形态（所有字段都有值）。 */
export interface MagpieOptions {
  /** 网关根地址，**不带** `/v1`（本插件自己拼路径）。 */
  readonly baseURL: string
  /**
   * 直接写死的 API key。留空时按 {@link apiKeyEnv} 读环境变量，
   * 再退到 magpie 出厂值 `magpie`。
   */
  readonly apiKey: string
  /** 读取 API key 的环境变量名。 */
  readonly apiKeyEnv: string
  /** 非流式请求（目录、额度、用量）的超时，毫秒。 */
  readonly requestTimeoutMs: number
  /** 流式请求的**空闲**超时（两个 chunk 之间的最长间隔），毫秒。 */
  readonly streamIdleTimeoutMs: number
  /** 模型目录缓存存活时间，毫秒。0 表示每次都重新拉。 */
  readonly catalogTtlMs: number
  /** 模型 id 白名单（glob）。非空时**只有**命中的模型进目录。 */
  readonly modelInclude: readonly string[]
  /** 模型 id 黑名单（glob）。命中的模型不进目录（白名单优先于黑名单）。 */
  readonly modelExclude: readonly string[]
  /** 是否把 magpie 标记为「已在 Jet Hub 关闭」的模型也放进目录。 */
  readonly includeDisabledModels: boolean
  /**
   * 是否给每个请求带上 `X-Magpie-Session`。
   *
   * magpie 用这个 header 做**会话粘性路由**（同一个会话固定打同一个上游账号，
   * 提升 prompt cache 命中率）。DSH 的 `GenerateOptions.sessionId` 是
   * Agent 生命周期内的稳定身份，正好可以映射过去。
   */
  readonly sessionHeader: boolean
  /**
   * 是否在面板里嵌入 magpie **原版** Web UI。
   *
   * 见 `web-bridge.ts` 的长注释：官方 `magpie web` 把整个 App 窗口用 HTTP
   * 提供出来，本插件用 iframe 原样嵌入，而不是自造一套摹本页签。
   * 关掉后只剩模型选择能力，没有一个可看的界面。
   */
  readonly webEnabled: boolean
  /** magpie 可执行文件路径或 PATH 里的名字。 */
  readonly magpieBinary: string
  /** 原版 Web UI 的监听地址。 */
  readonly webHost: string
  /** 原版 Web UI 的首选端口；被占用时自动向后找空闲端口。 */
  readonly webPort: number
  /**
   * 固定的 `MAGPIE_WEB_KEY`。
   *
   * ⚠️ 必须 16 位以上、只含 `[A-Za-z0-9._~-]`，否则 magpie 拒绝启动。
   * 固定（而不是每次随机）是为了让 iframe 的 URL 在多次启动间保持稳定 ——
   * 否则用户浏览器里的 magpie 登录态每次都丢。
   */
  readonly webKey: string
}

/**
 * 出厂默认值。
 *
 * ⚠️ 这里的数字都是**实测**得出的，不是拍脑袋：
 * - `requestTimeoutMs: 10_000` —— 本机 `GET /v1/models` 首字节 ~50ms，
 *   10 秒足够覆盖冷启动与上游抖动；再长会让「网关没跑」的判定拖到用户放弃。
 * - `streamIdleTimeoutMs: 600_000` —— 与既有 `llm-pi-ai` 配置里的
 *   `streamIdleTimeoutMs` 同值。深度思考模型在长上下文下首次出 token 可能
 *   超过 60 秒（实测 `reasoning_effort: max` 时有 3 分钟量级的样本）。
 * - `catalogTtlMs: 60_000` —— 目录变化不频繁，一分钟的陈旧窗口可接受，
 *   同时避免每次打开模型选择器都打一次网关卡。
 */
export const DEFAULT_OPTIONS: MagpieOptions = Object.freeze({
  baseURL: DEFAULT_BASE_URL,
  apiKey: '',
  apiKeyEnv: API_KEY_ENV,
  requestTimeoutMs: 10_000,
  streamIdleTimeoutMs: 600_000,
  catalogTtlMs: 60_000,
  modelInclude: Object.freeze([]),
  modelExclude: Object.freeze([]),
  includeDisabledModels: true,
  sessionHeader: true,
  webEnabled: true,
  magpieBinary: 'magpie',
  webHost: '127.0.0.1',
  webPort: 3480,
  // 21 位，只含字母/数字/`-`，满足 magpie 的 `[A-Za-z0-9._~-]{16,}` 要求。
  webKey: 'dsh-magpie-panel-2026',
})

/**
 * 插件 Config schema。
 *
 * `id: magpie` 与 {@link PROVIDER} 一致 —— DSH 0.1.7-rc.1 起设置表单的
 * 命名空间就是 profile 条目 id，两者不一致时设置页读不到本插件的配置。
 */
export const Config = Schema.object({
  baseURL: Schema.string()
    .default(DEFAULT_BASE_URL)
    .description('Magpie 网关根地址，不带 /v1。默认 http://127.0.0.1:3425')
    .volatile(),

  apiKey: Schema.string()
    .default('')
    .description('直接写死的网关 key。留空则读下面的环境变量，再退到 magpie 出厂值。')
    .role('secret')
    .volatile(),

  apiKeyEnv: Schema.string()
    .default(API_KEY_ENV)
    .description('读取网关 key 的环境变量名（~/.dsh/.env 里配 MAGPIE_GATEWAY_KEY=magpie）')
    .volatile(),

  requestTimeoutMs: Schema.number()
    .default(10_000)
    .description('非流式请求超时（毫秒）：模型目录、额度、用量')
    .volatile(),

  streamIdleTimeoutMs: Schema.number()
    .default(600_000)
    .description('流式请求空闲超时（毫秒）：两个 chunk 之间的最长间隔')
    .volatile(),

  catalogTtlMs: Schema.number()
    .default(60_000)
    .description('模型目录缓存存活时间（毫秒）。0 表示每次都重新拉')
    .volatile(),

  modelInclude: Schema.array(Schema.string())
    .default([])
    .description('模型 id 白名单（glob）。非空时只有命中的模型进目录')
    .volatile(),

  modelExclude: Schema.array(Schema.string())
    .default([])
    .description('模型 id 黑名单（glob）。命中的模型不进目录；白名单优先')
    .volatile(),

  includeDisabledModels: Schema.boolean()
    .default(true)
    .description('是否收录 magpie 标记为「已在 Jet Hub 关闭」的模型')
    .volatile(),

  sessionHeader: Schema.boolean()
    .default(true)
    .description('是否发送 X-Magpie-Session（会话粘性路由，提升 prompt cache 命中率）')
    .volatile(),

  webEnabled: Schema.boolean()
    .default(true)
    .description('面板里嵌入 magpie 原版 Web UI（magpie web），而不是自造页签')
    .volatile(),

  magpieBinary: Schema.string()
    .default('magpie')
    .description('magpie 可执行文件路径；留 magpie 表示用 PATH 里的那个')
    .volatile(),

  webHost: Schema.string()
    .default('127.0.0.1')
    .description('原版 Web UI 监听地址，默认只在本机可访问')
    .volatile(),

  webPort: Schema.number()
    .default(3480)
    .description('原版 Web UI 首选端口；被占用时自动向后找空闲端口')
    .volatile(),

  webKey: Schema.string()
    .default('dsh-magpie-panel-2026')
    .description('固定的 MAGPIE_WEB_KEY（16 位以上，只含字母数字 - . _ ~）')
    .role('secret')
    .volatile(),
})

/**
 * 把用户配置归一化成完整选项。
 *
 * ⚠️ 逐个字段兜底而不是 `{ ...DEFAULT_OPTIONS, ...config }`：后者在字段被
 * 显式写成 `undefined` 时会把默认值**覆盖成 undefined**（对象展开不跳过
 * 显式 undefined），而 YAML/JSON 里缺字段与写 `null` 都常见。
 *
 * @param config - 宿主传入的原始配置（可能缺字段、可能含 null）。
 * @returns 完整、已冻结的选项。
 */
export function resolveOptions(config: unknown): MagpieOptions {
  const raw = (typeof config === 'object' && config !== null ? config : {}) as Record<string, unknown>

  const string = (key: keyof MagpieOptions, fallback: string): string => {
    const value = raw[key]
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
  }
  const positiveNumber = (key: keyof MagpieOptions, fallback: number, allowZero = false): number => {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    if (value < 0) return fallback
    if (value === 0 && !allowZero) return fallback
    return Math.floor(value)
  }
  const boolean = (key: keyof MagpieOptions, fallback: boolean): boolean => {
    const value = raw[key]
    return typeof value === 'boolean' ? value : fallback
  }
  const stringList = (key: keyof MagpieOptions, fallback: readonly string[]): readonly string[] => {
    const value = raw[key]
    if (!Array.isArray(value)) return fallback
    const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    return Object.freeze(items)
  }

  return Object.freeze({
    // 去掉尾部斜杠：`baseURL + '/v1/models'` 否则会拼出 `//v1/models`。
    // 绝大多数网关容忍双斜杠，但 magpie 的路由是精确匹配，不容忍。
    baseURL: trimTrailingSlash(string('baseURL', DEFAULT_OPTIONS.baseURL)),
    apiKey: string('apiKey', ''),
    apiKeyEnv: string('apiKeyEnv', DEFAULT_OPTIONS.apiKeyEnv),
    requestTimeoutMs: positiveNumber('requestTimeoutMs', DEFAULT_OPTIONS.requestTimeoutMs),
    streamIdleTimeoutMs: positiveNumber('streamIdleTimeoutMs', DEFAULT_OPTIONS.streamIdleTimeoutMs),
    catalogTtlMs: positiveNumber('catalogTtlMs', DEFAULT_OPTIONS.catalogTtlMs, true),
    modelInclude: stringList('modelInclude', DEFAULT_OPTIONS.modelInclude),
    modelExclude: stringList('modelExclude', DEFAULT_OPTIONS.modelExclude),
    includeDisabledModels: boolean('includeDisabledModels', DEFAULT_OPTIONS.includeDisabledModels),
    sessionHeader: boolean('sessionHeader', DEFAULT_OPTIONS.sessionHeader),
    webEnabled: boolean('webEnabled', DEFAULT_OPTIONS.webEnabled),
    magpieBinary: string('magpieBinary', DEFAULT_OPTIONS.magpieBinary),
    webHost: string('webHost', DEFAULT_OPTIONS.webHost),
    webPort: positiveNumber('webPort', DEFAULT_OPTIONS.webPort),
    webKey: string('webKey', DEFAULT_OPTIONS.webKey),
  })
}

/**
 * 解析出实际使用的 API key。
 *
 * 优先级：配置里的 `apiKey` → 环境变量 `apiKeyEnv` → 出厂值 `magpie`。
 *
 * ⚠️ **不能因为环境变量缺失就抛错**：magpie 的出厂 key 就是字面量
 * `magpie`，本机 `~/.dsh/.env` 也正是这么配的（`MAGPIE_GATEWAY_KEY=magpie`）。
 * 在「网关本身不校验强 key」的部署里抛错只会让插件无法启动，
 * 而真正的鉴权失败会在第一次请求时给出准确报错。
 *
 * @param options - 归一化后的选项。
 * @returns 可直接放进 `Authorization: Bearer <key>` 的字符串。
 */
export function resolveApiKey(options: MagpieOptions): string {
  if (options.apiKey.length > 0) return options.apiKey
  const fromEnv = process.env[options.apiKeyEnv]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return DEFAULT_API_KEY
}

/**
 * 去掉末尾斜杠。
 *
 * @param url - 任意 URL 文本。
 * @returns 去掉全部尾随 `/` 的同一段文本。
 */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
