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
import { createPortal } from 'react-dom'

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
        h('br'),
        h('br'),
        '如果这是第一次运行插件，宿主可能正在下载 magpie 二进制（约 69 MB），需要几分钟。',
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
 * 底部统计条上的「Magpie」按钮 —— 点击开小窗。
 *
 * ## 槽位契约（`conversation.composer.dock`，list + 会话作用域）
 *
 * 官方用它渲染两个统计 pill：`activity`（order 0，轮次数 / 步骤数 / 输出
 * 速度）与 `usage`（order 1，token 总量 / 缓存命中）。我们注册 order 2，
 * 排在它们右侧。
 *
 * ## ⚠️ 为什么开真窗口而不是 iframe
 *
 * 侧边栏「Magpie」入口里已经有一个 iframe 展示**主窗口**（完整页面，带
 * magpie 自己的侧边栏）。小窗是 magpie 托盘图标那个 440×520 的紧凑形态，
 * 它的价值就在于「浮在外面随时能看一眼」—— 塞回侧边栏里反而失去意义。
 *
 * ## ⚠️ 必须在点击时才请求 URL
 *
 * `web.dockUrl` 会 spawn `magpie web`（首次 20–30 秒）。如果在渲染期就调，
 * 每次打开会话都会卡住整个输入区；而用户很可能根本不点这个按钮。
 *
 * @param {{ rpcCall?: Function }} props - 由槽位 `inject` 提供。
 * @returns {import('react').ReactElement | null} 按钮。
 */
export function MagpieDockButton({ rpcCall }) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState(null)
  /** `null` = 小窗关闭；否则是要嵌进浮层的地址。 */
  const [url, setUrl] = React.useState(null)

  const open = React.useCallback(() => {
    if (typeof rpcCall !== 'function' || busy) {
      return
    }
    setBusy(true)
    setError(null)
    rpcCall('web.dockUrl')
      .then(unwrapMagpieResult)
      .then((value) => {
        const next =
          value !== null && typeof value === 'object' && typeof value.url === 'string' ? value.url : ''
        if (next.length === 0) {
          throw new Error('宿主没有返回小窗地址。')
        }
        setUrl(next)
      })
      .catch((reason) => {
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        setBusy(false)
      })
  }, [rpcCall, busy])

  const close = React.useCallback(() => {
    setUrl(null)
  }, [])

  // Esc 关闭 —— 浮层盖住了整个界面，没有快捷键就只能点那个小叉。
  React.useEffect(() => {
    if (url === null) {
      return undefined
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setUrl(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [url])

  const label = busy ? 'Magpie 启动中…' : error === null ? 'Magpie' : 'Magpie 打不开'

  return h(
    React.Fragment,
    null,
    h(
      'button',
      {
        type: 'button',
        className: 'dim-mp-dockBtn' + (error === null ? '' : ' isError'),
        onClick: open,
        disabled: busy,
        title: error === null ? '打开 magpie 小窗' : `打开失败：${error}`,
      },
      h('span', { className: 'dim-mp-dockDot', 'aria-hidden': 'true' }),
      label,
    ),
    url === null
      ? null
      : // ⚠️ 必须用 portal 挂到 document.body。
        //    composer 的祖先链上有 `transform` / `contain`，会让
        //    `position: fixed` 退化成 `absolute` —— 浮层就成了流内元素，
        //    把底部统计条顶起来。portal 直接挂到 body，彻底脱离那层布局。
        createPortal(h(MagpieDockWindow, { url, onClose: close }), document.body),
  )
}

/**
 * 小窗浮层本体。
 *
 * ## ⚠️ 为什么是 `position: fixed` 浮层而不是 `window.open`
 *
 * Electron 的 `window.open` 会被宿主接走并交给**系统浏览器**（DSH 把它映射成
 * `shell.openExternal`）—— 点一下按钮就跳到浏览器新标签页，完全脱离 DSH。
 * 这里要的是「在 DSH 里浮一个小窗」，所以自己画一层 fixed 定位的浮层，里面
 * 仍旧是 iframe。
 *
 * ## 为什么盖满全屏
 *
 * 只盖住右下角会让浮层下面**还能点到** composer 的按钮，用户会以为点到了但
 * 没反应。半透明遮罩 + 点击关闭是最省心的交互。
 *
 * @param {{ url: string, onClose: () => void }} props - `url` 是小窗地址。
 * @returns {import('react').ReactElement} 浮层。
 */
/**
 * 让侧边栏里的 Magpie 完整页面切到某一页。
 *
 * ## 为什么不能直接调 `show()`
 *
 * 完整页面是**另一个 iframe**（{@link MagpiePanel} 渲染的），和小窗不同源
 * 上下文 —— 拿不到它的 `window`。只能 `postMessage`。
 *
 * ## 为什么要轮询
 *
 * 刚点完侧边栏那一行时，`iframe` 可能还没挂载、或者还在加载 HTML ——
 * 此时 `contentWindow` 是 `null`（或还没有我们的注入脚本）。轮询几次，
 * 拿到就停。
 *
 * @param view - magpie 的页面 id（`agents` / `usage` / `routing` / `settings` …）。
 */
function showMagpiePage(view) {
  let tries = 0
  const tick = () => {
    tries += 1
    // `.dim-mp-frame` 是 MagpiePanel 的 iframe —— 只有侧边栏的完整页面
    // 用它；小窗的是 `.dim-mp-dockFrame`，不会误伤。
    const frame = document.querySelector('iframe.dim-mp-frame')
    const target = frame?.contentWindow
    if (target !== null && target !== undefined) {
      try {
        target.postMessage({ source: 'dsh-magpie-host', kind: 'show', view }, '*')
        return
      } catch {
        // 跨源时可能抛 —— 继续重试没有意义，交给下一轮。
      }
    }
    // 最多约 3 秒（20 × 150ms），超过就放弃 —— 页面根本没开的话，
    // 静默失败比无限重试好。
    if (tries < 20) {
      setTimeout(tick, 150)
    }
  }
  // 第一轮也延迟，等 React 把侧边栏那一行渲染出来。
  setTimeout(tick, 150)
}

function MagpieDockWindow({ url, onClose }) {
  // 代理注入了脚本（`src/web-bridge.ts` 的 INJECTED_HTML_SCRIPT），它把
  // `api("window/...")` 这类 **Wails 桌面 RPC** 全部转成这里的消息。
  //
  // ## 为什么要包装 `api()` 而不是逐个拦按钮
  //
  // 原版 magpie 的 `?mode=panel` 是桌面 App（Wails）的小窗模式，它把
  // 「打开主窗口」「设置」「退出」以及「打开用量」「打开路由」这些按钮的
  // 点击全部交给 Go 后端的桌面进程 —— 浏览器里 `/api/window/*` 根本不存在，
  // 点了完全没反应。后两个按钮还是**动态生成、没有 id** 的，只能靠文本
  // 匹配（会随语言变）。它们唯一的共同点是都调 `api("window/main?...")`。
  //
  // 所以我们接管成 DSH 自己的行为：
  // - `window/main` = 跳转到侧边栏的 Magpie 完整页面（**不是**在小窗里换
  //   src —— 那只是把 440px 的浮层塞成完整布局，用户要的是回到主界面），
  //   带了 `view` 就再切到那一页；
  // - `window/quit` = 关闭小窗。
  React.useEffect(() => {
    const onMessage = (event) => {
      const data = event.data
      if (data === null || typeof data !== 'object' || data.source !== 'dsh-magpie') {
        return
      }
      const kind = data.kind
      if (kind === 'quit') {
        onClose()
        return
      }
      if (kind !== 'main') {
        return
      }
      const view = typeof data.view === 'string' ? data.view : ''
      // 侧边栏那一行是 DSH 自己渲染的（`sidebar.panellist` 槽位），点击
      // 由它接管。`data-magpie-sidebar` 是我们挂在图标上的锚点，往上找
      // 最近的可点击祖先 —— 不同版本的 DSH 可能用 `button` / `li` / `a`。
      const anchor = document.querySelector('[data-magpie-sidebar]')
      const row = anchor?.closest('button, li, a, [role="button"], [tabindex]') ?? anchor
      row?.click()
      onClose()
      if (view.length > 0) {
        // 完整页面挂载后才切页 —— 刚点完侧边栏时 iframe 可能还在加载，
        // 直接 postMessage 会丢。轮询几次，拿到就停。
        showMagpiePage(view)
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
    }
  }, [onClose])

  return h(
    'div',
    { className: 'dim-mp-dockOverlay', onClick: onClose, role: 'presentation' },
    h(
      'div',
      {
        className: 'dim-mp-dockWindow',
        onClick: (event) => {
          // 点浮层内部不该关闭 —— 否则在 iframe 里选文字都会被当成「点外面」。
          event.stopPropagation()
        },
        role: 'dialog',
        'aria-label': 'Magpie 小窗',
      },
      h('iframe', {
        className: 'dim-mp-dockFrame',
        src: url,
        title: 'Magpie 小窗',
        allow: 'clipboard-read; clipboard-write',
        referrerPolicy: 'no-referrer',
      }),
    ),
  )
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
  //
  // ⚠️ `data-magpie-sidebar` 是给 {@link MagpieDockWindow} 用的锚点：小窗里
  //    点「打开主窗口」时，它靠这个选择器找到侧边栏这一行并 `click()`。
  return h(
    'svg',
    {
      width: px,
      height: px,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': 'true',
      focusable: 'false',
      'data-magpie-sidebar': '',
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
