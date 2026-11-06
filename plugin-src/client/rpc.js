/**
 * Magpie 面板的 RPC 封装。
 *
 * ## 协议
 *
 * 宿主侧（`src/index.ts` 的 `registerPanelRpc`）用
 * `ctx.connection.fetch.register({ path: '/api/magpie' })` 注册了一个 HTTP POST 端点，
 * 它接受 DSH 的标准 RPC 信封：
 *
 * ```json
 * { "type": "client-request", "rpcId": "…", "method": "magpie",
 *   "payload": { "method": "panel.snapshot", "payload": { … } } }
 * ```
 *
 * 响应是 `{ "type": "server-response", "rpcId": "…", "result": <handleMethod 的返回值> }`。
 * 这层信封由 `connection.rpc.call()` 在客户端解包，因此本文件拿到的就是
 * `handleMethod` 的**裸返回值**。
 *
 * ## 返回值契约（**必须**严格遵守）
 *
 * `connection.rpc.call()` 的返回值形状是 `{ ok: boolean, value?, error? }`，
 * **不是**宿主 `handleMethod` 的裸返回值。`@deepseek-ai/dsh-client-connection`
 * 在把响应交回调用方之前会校验 `result.ok` 是不是布尔：
 *
 * - 宿主返回裸对象（没有 `ok` 字段）⇒ 抛
 *   `connection: invalid server-response result`，界面上就是一条红色错误条；
 * - 宿主返回 `{ ok: true, value }` ⇒ 这里拿到的就是 `{ ok: true, value }`；
 * - 宿主返回 `{ ok: false, error }` ⇒ 这里拿到的就是 `{ ok: false, error }`。
 *
 * ⇒ 宿主侧 `handleMethod` **每个**分支都必须包成上面两种形状之一，
 * 本文件的 `unwrapMagpieResult` 再把它拆成「返回值 / 抛异常」。
 *
 * @module magpie/client/rpc
 */

/** 宿主侧注册的 RPC 端点名（= `src/index.ts` 的 `PANEL_ENDPOINT`）。 */
export const PANEL_ENDPOINT = 'magpie'

/** 宿主侧注册的 HTTP 路径（= `src/index.ts` 的 `PANEL_API_PATH`）。 */
export const PANEL_API_PATH = '/api/magpie'

/**
 * 调用一个 Magpie 面板方法。
 *
 * @param {any} connection - `ctx.connection`（DSH 客户端连接服务）。
 * @param {string} method - 方法名，如 `panel.snapshot`。
 * @param {unknown} [payload] - 方法载荷。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<unknown>} 宿主侧 `handleMethod` 的返回值。
 */
export function callMagpieRpc(connection, method, payload, signal) {
  if (connection === undefined || connection === null) {
    return Promise.reject(new Error('Magpie 面板不可用：connection 服务缺失。'))
  }
  const rpc = connection.rpc
  if (rpc === undefined || rpc === null || typeof rpc.call !== 'function') {
    return Promise.reject(new Error('Magpie 面板不可用：connection.rpc.call 缺失。'))
  }
  // mountPoint = '/api'，endpoint = 'magpie' —— 与宿主 `fetch.register({ path: '/api/magpie' })` 对应。
  return rpc.call('/api', PANEL_ENDPOINT, { method, payload }, signal)
}

/**
 * 把宿主侧的 `{ ok, value?, error? }` 信封拆成「返回值 / 抛异常」。
 *
 * ⚠️ 三个分支都必须处理，不能只认 `ok === false`：
 * - `ok === true`  ⇒ 取 `value`（宿主侧成功分支的载荷）；
 * - `ok === false` ⇒ 抛 `Error`，`code` 取自 `error.code`；
 * - 其它（`ok` 不是布尔）⇒ 视为协议违例，抛错并带上原始值摘要。
 *
 * 最后那个分支是**防御性**的：如果宿主侧某个方法忘了包信封，
 * 宁可在客户端给出「宿主返回了非法形状」的可读错误，也不要静默返回 `undefined`
 * 让面板显示成空数据。
 *
 * @param {unknown} result - `callMagpieRpc` 的返回值。
 * @returns {unknown} 成功时的 `value`。
 * @throws {Error} 失败时抛出。
 */
export function unwrapMagpieResult(result) {
  if (result === null || typeof result !== 'object') {
    throw new Error(`Magpie 面板收到非法响应：${describeValue(result)}`)
  }
  const envelope = /** @type {{ ok?: unknown, value?: unknown, error?: { code?: unknown, message?: unknown } }} */ (
    result
  )
  if (envelope.ok === true) return envelope.value
  if (envelope.ok === false) {
    const message =
      typeof envelope.error?.message === 'string' && envelope.error.message.length > 0
        ? envelope.error.message
        : 'Magpie 面板请求失败。'
    const error = new Error(message)
    if (typeof envelope.error?.code === 'string') error.code = envelope.error.code
    throw error
  }
  throw new Error(`Magpie 面板收到非法响应（缺少 ok 字段）：${describeValue(result)}`)
}

/**
 * 给错误信息用的值摘要 —— 只取前 120 字符，避免把整棵快照打进控制台。
 *
 * @param {unknown} value - 任意值。
 * @returns {string} 摘要文本。
 */
function describeValue(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  try {
    const text = JSON.stringify(value)
    if (typeof text !== 'string') return String(value)
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  } catch {
    return String(value)
  }
}

/**
 * 一步到位：调用 + 解包。
 *
 * @param {any} connection - `ctx.connection`。
 * @param {string} method - 方法名。
 * @param {unknown} [payload] - 方法载荷。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<unknown>} 成功值。
 */
export async function requestMagpie(connection, method, payload, signal) {
  return unwrapMagpieResult(await callMagpieRpc(connection, method, payload, signal))
}
