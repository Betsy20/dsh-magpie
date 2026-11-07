/**
 * 产品身份常量。
 *
 * @module dsh-magpie/product
 */

/**
 * 网关默认地址。
 *
 * Magpie 是**本机**网关（`127.0.0.1:3425` 是它的出厂端口，见
 * `~/.config/magpie/settings.json` 的 `port`）。插件只做面板桥 ——
 * **不**注册 provider、**不**调 magpie 的 HTTP API，因此不需要 API key。
 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:3425'

/**
 * 日志前缀。所有 `ctx.logger` 调用都带它，便于在宿主日志里 grep 出本插件。
 */
export const LOG_PREFIX = '[magpie]'
