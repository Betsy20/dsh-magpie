/**
 * Magpie 面板：iframe 嵌入 **magpie 原版 Web UI**。
 *
 * ## 为什么是 iframe 而不是自己画
 *
 * 这个文件早先版本自造了「概览 / 模型 / 额度 / 用量 / 路由」五个页签，
 * 是对 magpie 原版界面的**拙劣摹本**。magpie 自己就有完整的 App 窗口
 * （`magpie web` 把整个 Wails 窗口用 HTTP 提供出来），里面包含
 * Agents、Sessions、Library、路由组、账号管理、设置 —— 摹本永远追不上。
 *
 * ⇒ 现在面板只做一件事：**把原版页面原封不动嵌进来**。
 *
 * ## 数据流
 *
 * ```
 * MagpiePanel 挂载
 *   → rpcCall('web.url')                       ← 宿主 src/index.ts 的 handleMethod
 *     → MagpieWebBridge.ensure()               ← 首次 spawn `magpie web`
 *       → 解析 stdout 拿带 key 的 URL
 *     ← { ok: true, value: { url, port } }
 *   → <iframe src={url}>                       ← 原版页面自己跑
 * ```
 *
 * 面板**不**再拉 `panel.snapshot` —— 原版页面自己会调管理 API，多拉一份
 * 只会让两边数据打架。
 *
 * ## 为什么 iframe 不设 sandbox
 *
 * `sandbox` 会隔离 origin，而 magpie 原版页面依赖 `localStorage` / cookie
 * 记住登录态与主题；加 sandbox 会让它每次都退回未登录状态。magpie 是
 * `127.0.0.1` 上的**本机可信服务**，同源嵌入没有额外风险。
 *
 * @module magpie/client/panel
 */

import * as React from 'react'

import { unwrapMagpieResult } from './rpc.js'

const h = React.createElement

/**
 * 加载中的占位屏。
 *
 * ⚠️ 首次打开面板要等 `magpie web` 启动（实测 5–20 秒，插件多时更久），
 * 所以这里必须给出**明确的进度说明**，不能只放一个转圈 —— 否则用户会
 * 以为面板坏了反复点。
 *
 * @returns {import('react').ReactElement} 占位元素。
 */
function LoadingScreen() {
  return h(
    'div',
    { className: 'dim-mp-panelHost' },
    h(
      'div',
      { className: 'dim-mp-loading' },
      h('div', { className: 'dim-mp-spinner', 'aria-hidden': 'true' }),
      h('div', { className: 'dim-mp-loadingTitle' }, '正在启动 magpie 原版界面…'),
      h(
        'div',
        { className: 'dim-mp-loadingHint' },
        '首次打开需要拉取全部插件与账号，通常几秒到半分钟。之后会走缓存，秒开。',
      ),
    ),
  )
}

/**
 * 启动失败的错误屏。
 *
 * 给的是**可操作**的信息：magpie 没装、没跑、配置里关掉了、端口被占 ——
 * 每一种都有明确的下一步，而不是一句「加载失败」。
 *
 * @param {{ message: string, onRetry: () => void }} props - 错误信息与重试回调。
 * @returns {import('react').ReactElement} 错误元素。
 */
function ErrorScreen({ message, onRetry }) {
  return h(
    'div',
    { className: 'dim-mp-panelHost' },
    h(
      'div',
      { className: 'dim-mp-error' },
      h('div', { className: 'dim-mp-errorTitle' }, '无法启动 magpie 原版界面'),
      h('div', { className: 'dim-mp-errorMessage' }, message),
      h(
        'div',
        { className: 'dim-mp-errorHint' },
        '请确认 magpie 已安装并在 PATH 里（或把「magpie 可执行文件」设成绝对路径），',
        '然后点下面的按钮重试。若设置里关掉了「嵌入原版 Web UI」，请先打开它。',
      ),
      h('button', { type: 'button', className: 'dim-mp-btn', onClick: onRetry }, '重试'),
    ),
  )
}

/**
 * 面板主体 —— 一个 iframe。
 *
 * 组件是**模块级常量**（在 `index.js` 里被 `withErrorBoundary` 包住），
 * 每次注册新建组件类型会让 React 卸载重挂整棵子树，iframe 会重新加载。
 *
 * @param {{ rpcCall?: (method: string, payload?: unknown, signal?: AbortSignal) => Promise<unknown> }} props
 *   `rpcCall` 由槽位注入，是 `(method, payload, signal) => connection.rpc.call(...)`。
 * @returns {import('react').ReactElement | null} 面板。
 */
export function MagpiePanel({ rpcCall }) {
  // 三态：loading（等宿主 spawn）/ ready（有 URL）/ error（拿不到 URL）。
  // 不用 `undefined` 表示 loading —— 那会和「还没开始」混淆。
  const [state, setState] = React.useState({ phase: 'loading' })
  // 重试计数：值变化会重新跑 effect。比在 effect 内部调用自身干净。
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    if (typeof rpcCall !== 'function') {
      setState({ phase: 'error', message: '面板不可用：rpcCall 缺失。' })
      return undefined
    }

    let cancelled = false
    const controller = new AbortController()
    setState({ phase: 'loading' })

    rpcCall('web.url', undefined, controller.signal)
      .then(unwrapMagpieResult)
      .then((value) => {
        if (cancelled) return
        const url =
          value !== null && typeof value === 'object' && typeof value.url === 'string'
            ? value.url
            : ''
        if (url.length === 0) {
          setState({ phase: 'error', message: '宿主没有返回原版 Web UI 的地址。' })
          return
        }
        setState({ phase: 'ready', url })
      })
      .catch((error) => {
        if (cancelled) return
        setState({
          phase: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [rpcCall, reloadToken])

  if (state.phase === 'loading') {
    return h(LoadingScreen, null)
  }
  if (state.phase === 'error') {
    return h(ErrorScreen, {
      message: state.message,
      onRetry: () => {
        setReloadToken((token) => token + 1)
      },
    })
  }

  return h('iframe', {
    className: 'dim-mp-frame',
    src: state.url,
    title: 'Magpie',
    // 不设 sandbox：原版页面依赖 localStorage / cookie 记住登录态与主题。
    // magpie 是本机 127.0.0.1 上的可信服务（见模块头注释）。
    allow: 'clipboard-read; clipboard-write',
    referrerPolicy: 'no-referrer',
  })
}

/**
 * 侧栏图标 —— 纯 SVG，`currentColor` 跟随主题。
 *
 * @param {{ size?: number }} props - `size` 是行高（像素），缺省 16。
 * @returns {import('react').ReactElement} 图标。
 */
export function MagpieSidebarIcon({ size }) {
  const px = typeof size === 'number' && size > 0 ? size : 16
  // 六边形 + 中心点：magpie 的 logo 是一只鸟的抽象，这里取它的几何骨架 ——
  // 比任何写实图形在小尺寸下都更稳。
  return h(
    'svg',
    {
      width: px,
      height: px,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    h('path', {
      d: 'M8 1.6 13.5 4.7v6.6L8 14.4 2.5 11.3V4.7L8 1.6Z',
      stroke: 'currentColor',
      strokeWidth: 1.35,
      strokeLinejoin: 'round',
    }),
    h('circle', { cx: 8, cy: 8, r: 1.7, fill: 'currentColor' }),
  )
}
