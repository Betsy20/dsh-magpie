/**
 * Magpie 网关的产品身份常量。
 *
 * 这些值是**唯一真相源**：日志前缀、面板标题、思考档位轴全部从这里派生。
 * 散落成字面量会让「改一处、漏一处」成为必然。
 *
 * @module dsh-magpie/product
 */

/**
 * 网关默认地址。
 *
 * Magpie 是**本机**网关（`127.0.0.1:3425` 是它的出厂端口，见
 * `~/.config/magpie/settings.json` 的 `port`）。插件只做面板桥，
 * **不**注册 provider、**不**拉起 magpie 进程 —— 那两件事分别由 magpie
 * 自己的 `llm-pi-ai` 条目和用户自己负责。
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
