/**
 * 插件配置：Schemastery schema + 归一化。
 *
 * ## 为什么必须是 schemastery schema（而不是裸对象或普通函数）
 *
 * 宿主的 `SettingsForms.describe()` 会对**每个**已注册项调用 `schema.toJSON()`。
 * 传入裸函数（`(value) => ...`）会让它抛
 * `TypeError: ... .toJSON is not a function`，进而使**所有**依赖 settings 的界面
 * （模型设置页、sidebar 的 `settings.get` / `shell.get`）全部失败 ——
 * 一个插件的配置写法能拖垮整个设置面。
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
import { isVolatile } from '@deepseek-ai/cosmokit'
import { DEFAULT_BASE_URL } from './product.js'

/** 插件配置的**归一化后**形态（所有字段都有值）。 */
export interface MagpieOptions {
  /** 网关根地址，**不带** `/v1`。 */
  readonly baseURL: string
  /**
   * 是否在面板里嵌入 magpie **原版** Web UI。
   *
   * 见 `web-bridge.ts` 的长注释：官方 `magpie web` 把整个 App 窗口用 HTTP
   * 提供出来，本插件用 iframe 原样嵌入，而不是自造一套摹本页签。
   */
  readonly webEnabled: boolean
  /**
   * 插件加载时是否自动拉起网关。
   *
   * 为什么需要这个：插件一开始假设「网关已经在跑」，但用户装完插件第一次
   * 打开 DSH 时网关通常没起 —— 面板一片红。让用户自己去开 magpie 是
   * 没必要的摩擦。
   *
   * 打开后，`apply()` 会在后台起一个 `magpie serve --web=<port>` 进程
   * （**一个进程同时提供网关和 Web UI**），插件卸载时连进程树一起收掉。
   * 关掉则回到「只当客户端」——适合网关跑在另一台机器上的场景。
   */
  readonly autoStartGateway: boolean
  /**
   * 缺少 magpie 二进制时是否自动下载。
   *
   * 打开后，插件启动时会检查 `~/.dsh/magpie/bin/magpie[.exe]`，没有就
   * 从 GitHub Releases 下 `magpie-cli-<os>-<arch>`（~69 MB）。
   *
   * 关掉则只做查找（配置 → 插件自带 → 系统安装 → PATH），全都没有就报错。
   * 适合「公司网络挡了 GitHub」或「想自己管二进制」的场景。
   */
  readonly autoDownloadMagpie: boolean
  /** magpie 可执行文件路径或 PATH 里的名字。 */
  readonly magpieBinary: string
  /** 原版 Web UI 的监听地址。 */
  readonly webHost: string
  /** 原版 Web UI 的首选端口；被占用时自动向后找空闲端口。 */
  readonly webPort: number
  /**
   * 代理（DSH iframe 直接加载的那个）的首选端口。
   *
   * ⚠️ **必须固定**，不能用 `listen(0)` 让系统随机分配。
   *
   * 面板 iframe 的 `src` 在渲染时就定下来了；magpie 自己重启（更新、崩溃、
   * 被安全软件拦）时代理会重建一次。端口如果是随机的，重建后 URL 就变了，
   * 而 iframe 还是旧的那个 —— 页面里所有 `/api/*` 请求全部
   * `ERR_CONNECTION_REFUSED`，用户看到的就是「面板一片白 + 控制台刷红」。
   *
   * 固定端口后，magpie 重启只是代理背后换了上游，iframe 的地址不变，刷新
   * 即可恢复。
   */
  readonly proxyPort: number
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
 * 代理端口的出厂默认值。
 *
 * ## 为什么是 3590
 *
 * magpie 默认 web 端口是 3480，而 `magpie serve --web=host:port` 在端口被
 * 占时会**自己向上找**，最多试 24 个（见 `web-bridge.ts` 的
 * `DEFAULT_PORT_ATTEMPTS`）—— 也就是 **3480–3503**。
 *
 * 3590 = 3480 + 110，稳稳落在这个扫描区间**之外**。
 *
 * ## ⚠️ 为什么不能是 3490（旧值）
 *
 * 3490 落在 3480–3503 **里面**。用户机器上只要同时跑着 11 个以上 magpie
 * 实例（或别的服务占了那几个端口），magpie 自己就会把 3490 抢走，代理
 * 再 `listen` 就 `EADDRINUSE`，`ensure()` 直接失败。
 *
 * 旧注释写的「避开 magpie 可能用掉的 3481–3489」是**错的** —— 扫描上界
 * 是 `3480 + 24 - 1 = 3503`，不是 3489。
 */
export const DEFAULT_PROXY_PORT = 3590

/** 出厂默认值。 */
export const DEFAULT_OPTIONS: MagpieOptions = Object.freeze({
  baseURL: DEFAULT_BASE_URL,
  webEnabled: true,
  autoStartGateway: true,
  autoDownloadMagpie: true,
  magpieBinary: 'magpie',
  webHost: '127.0.0.1',
  webPort: 3480,
  // 3590 在 magpie 的 3480–3503 扫描区间之外，见 DEFAULT_PROXY_PORT 的注释。
  proxyPort: DEFAULT_PROXY_PORT,
  // 21 位，只含字母/数字/`-`，满足 magpie 的 `[A-Za-z0-9._~-]{16,}` 要求。
  webKey: 'dsh-magpie-panel-2026',
})

/**
 * 插件 Config schema。
 *
 * 设置表单的命名空间就是 cordis 条目 id（`magpie`，见 `index.ts` 的
 * `export const name`），与 `package.json` 的 `name` 必须一致 —— 不一致时
 * 设置页读不到本插件的配置。
 */
export const Config = Schema.object({
  baseURL: Schema.string()
    .default(DEFAULT_BASE_URL)
    .description('Magpie 网关根地址，不带 /v1。默认 http://127.0.0.1:3425')
    .volatile(),

  webEnabled: Schema.boolean()
    .default(true)
    .description('面板里嵌入 magpie 原版 Web UI（magpie web），而不是自造页签')
    .volatile(),

  autoStartGateway: Schema.boolean()
    .default(true)
    .description('插件加载时自动起 magpie serve 网关；关掉则假定网关已在别处运行')
    .volatile(),

  autoDownloadMagpie: Schema.boolean()
    .default(true)
    .description('缺少 magpie 二进制时自动从 GitHub 下载（~69 MB）；关掉则只用已找到的')
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

  proxyPort: Schema.number()
    .default(DEFAULT_PROXY_PORT)
    .description('代理首选端口（固定，避免 magpie 重启后面板 iframe 地址失效）；被占用时向后找')
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

  /**
   * 取出字段的**原始值**。
   *
   * cordis 用 `Config` schema 解析配置后，`.volatile()` 标记的字段会被
   * `Schema.resolve` 包成 `{ get(): T }` 引用（见 schemastery 的
   * `Schema.resolve` 与 cosmokit 的 `createVolatile`）—— 这是为了让运行中的
   * 插件能感知配置热更新。
   *
   * ⚠️ 不解包的话 `typeof value` 永远是 `'object'`，下面三个类型守卫会
   * **全部**走 fallback 分支，用户配置被静默丢弃（`webPort: 4000` 变成
   * `3480`，关掉自动下载也没用）。
   *
   * ⚠️ `isVolatile` 在 `@deepseek-ai/cosmokit`，**不在** schemastery ——
   * 后者只 `export { Schema as default }`。
   */
  const read = (key: keyof MagpieOptions): unknown => {
    const value = raw[key]
    return isVolatile(value) ? value.get() : value
  }

  const string = (key: keyof MagpieOptions, fallback: string): string => {
    const value = read(key)
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
  }
  /**
   * 端口必须落在 `1..65535`。
   *
   * 只判正数不够：`findFreePort()` 在 `port > 65_535` 时直接 `break`，
   * 抛出来的错只会显示一个不完整的区间，排查成本高。
   */
  const port = (key: keyof MagpieOptions, fallback: number): number => {
    const value = read(key)
    if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
    if (value < 1 || value > 65_535) return fallback
    return value
  }
  const boolean = (key: keyof MagpieOptions, fallback: boolean): boolean => {
    const value = read(key)
    return typeof value === 'boolean' ? value : fallback
  }

  return Object.freeze({
    // 去掉尾部斜杠：`baseURL + '/v1/models'` 否则会拼出 `//v1/models`。
    baseURL: trimTrailingSlash(string('baseURL', DEFAULT_OPTIONS.baseURL)),
    webEnabled: boolean('webEnabled', DEFAULT_OPTIONS.webEnabled),
    autoStartGateway: boolean('autoStartGateway', DEFAULT_OPTIONS.autoStartGateway),
    autoDownloadMagpie: boolean('autoDownloadMagpie', DEFAULT_OPTIONS.autoDownloadMagpie),
    magpieBinary: string('magpieBinary', DEFAULT_OPTIONS.magpieBinary),
    webHost: string('webHost', DEFAULT_OPTIONS.webHost),
    webPort: port('webPort', DEFAULT_OPTIONS.webPort),
    proxyPort: port('proxyPort', DEFAULT_OPTIONS.proxyPort),
    webKey: string('webKey', DEFAULT_OPTIONS.webKey),
  })
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
