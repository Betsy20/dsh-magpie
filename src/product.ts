/**
 * Magpie 网关的产品身份常量。
 *
 * 这些值是**唯一真相源**：provider 路由名、设置页命名空间、User-Agent、
 * 日志前缀、面板标题全部从这里派生。散落成字面量会让「改一处、漏一处」
 * 成为必然（本项目前身的 `dsh-providers-hub` 就踩过：provider id 有 13 份
 * 副本，改 registry 时行为完全不变）。
 *
 * @module dsh-magpie/product
 */

/**
 * DSH 里的 provider 路由名。
 *
 * ## 为什么是 `magpie-direct` 而不是 `magpie`
 *
 * DSH 桌面版内置了 `@deepseek-ai/dsh-llm-pi-ai`，它**已经**占用 provider id
 * `magpie`，并且带一套「自愈」逻辑：只要 `cordis.patch.yml` 里找不到启用的
 * `llm-pi-ai` 条目，宿主就会在一个 live-reload 周期内把整段配置**追加回来**
 * （实测 25 秒内，47 行原样重现）。
 *
 * 而**同一个 provider id 只能挂一个 adapter** —— 重复注册抛
 * `LlmError` code `DUPLICATE_ADAPTER`，整个 profile 启动失败。
 *
 * 所以本插件不跟内置适配器抢 `magpie`，改用独立 id 与它**并存**：内置的
 * `magpie` 继续提供它那 3 个硬编码模型，本插件额外提供
 * {@link PROVIDER} 这条「动态发现」路由（模型目录来自网关 `/v1/models`，
 * 受 magpie 侧 `hiddenModels` 可见性配置影响）。
 *
 * 想只留一套，去 DSH 设置里关掉「Pi AI」插件即可。
 */
export const PROVIDER = 'magpie-direct'

/** 设置页与模型选择器里显示的 provider 名称。 */
export const DISPLAY_NAME = 'Magpie (直连)'

/**
 * 网关默认地址。
 *
 * Magpie 是**本机**网关（`127.0.0.1:3425` 是它的出厂端口，见
 * `~/.config/magpie/settings.json` 的 `port`）。插件只做客户端，不负责
 * 拉起 magpie 进程 —— 网关没跑时应给出可操作的报错，而不是自动 spawn。
 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3425'

/**
 * 默认读取 API key 的环境变量名。
 *
 * `~/.dsh/.env` 里只有一行 `MAGPIE_GATEWAY_KEY=magpie` —— 本机 magpie
 * 出厂即接受 `Authorization: Bearer magpie`，因此该值同时也是兜底默认。
 */
export const API_KEY_ENV = 'MAGPIE_GATEWAY_KEY'

/** 环境变量缺失时的兜底 key（magpie 出厂值）。 */
export const DEFAULT_API_KEY = 'magpie'

/**
 * 思考档位的**强弱序**（弱 → 强）。
 *
 * ⚠️ 为什么需要自己排一遍：magpie 的 `/v1/models` 会**原样透传**各上游
 * provider 自报的 `reasoning_levels`，而各家顺序并不统一 ——
 * `jet-hub-qoder/dfmodel` 返回的是 `["high","max","low","none"]`
 * （**乱序**）。DSH 的思考档位轴按 `efforts` 数组顺序渲染，乱序会让滑块
 * 从「高」往右滑到「最大」再跳回「低」。
 *
 * ⇒ 一律按本表排序后再交给宿主；表外的新档位追加到末尾（未知即最强之外，
 * 保守做法：不猜测它的强度位置，只保证不破坏已知轴）。
 */
export const REASONING_LADDER = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

/**
 * 档位 id 的人类可读名称。
 *
 * 表外 id 原样显示（magpie 若新增 `ultra` 之类，至少不会崩）。
 */
export const REASONING_LABELS: Readonly<Record<string, string>> = Object.freeze({
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
})

/**
 * 日志前缀。所有 `ctx.logger` 调用都带它，便于在宿主日志里 grep 出本插件。
 */
export const LOG_PREFIX = '[magpie]'
