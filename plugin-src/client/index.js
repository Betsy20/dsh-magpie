/**
 * Magpie 面板客户端插件入口。
 *
 * ## 注册三处槽位
 *
 * 1. `main`（keyed，key = `magpie`）—— 中央主面板的 Magpie 页渲染体。
 *    **无条件**注册：它只提供渲染体，不是入口。入口切走之后，用户仍可能把
 *    面板停在 Magpie 上，少了这个 key 宿主 `layout.selectPanel('magpie')`
 *    会抛「未注册的 panel」。
 * 2. `sidebar.panellist`（list）—— 主导航里「Magpie」那一行。
 * 3. `settings.section` —— 设置弹层里的 Magpie 整页。
 *
 * 三处**渲染的是同一个 `MagpiePanel` 组件、同一份 `rpcCall`**，不存在两套实现。
 *
 * ## 为什么 `inject` 里带 `connection`
 *
 * `connection.rpc.call()` 是调宿主 RPC 的唯一通道。没有它，面板连一个字节都
 * 拉不到 —— 这是**硬依赖**（与 `dsh-providers-hub` 的用法一致）。
 *
 * ## 为什么包错误边界
 *
 * 槽位渲染没有隔离：`MagpiePanel` 里任何一处抛错都会让 React 卸载整棵子树，
 * 在设置弹层里表现为「整个设置页白屏、切页无效、只能重启」。两处注册各包一层
 * 边界（label 不同，便于区分是哪一块坏了）。
 *
 * ## 不要在 `apply()` 里 `await` 任何网络
 *
 * `apply()` 是**同步**的，宿主在它返回后立刻认为插件就绪。任何 `await` 都会
 * 让插件在启动期间处于「已激活但没注册槽位」的中间态 —— 用户恰好在这时打开
 * 设置页就会看到空白。数据拉取一律交给组件的 `useEffect`。
 *
 * @module magpie/client
 */

import * as React from 'react'

import { withErrorBoundary } from './error-boundary.js'
import { MagpieDockButton, MagpiePanel, MagpieSidebarIcon } from './panel.js'
import { callMagpieRpc } from './rpc.js'
import { installMagpieStyles } from './styles.js'

/**
 * 客户端插件的 cordis 条目 id。
 *
 * ⚠️ 与 `package.json` 的 `dsh.client` 无关 —— `dsh.client` 只声明「本包有
 * 客户端产物、需要哪些宿主 bundle 先到」。真正的注册 id 是 esbuild 产物里
 * `window.__ModuleLoader__.load({ id })` 的那个 `id`，由
 * `scripts/build-client.mjs` 从 `package.json` 的 `name` 注入。
 */
export const name = 'magpie-client'

/**
 * 依赖的宿主服务。
 *
 * - `slots` —— 注册面板渲染体与导航行的入口。
 * - `connection` —— `rpc.call()` 调宿主 RPC 的通道。
 *
 * ⚠️ **不要**在这里列 `layout` / `modelDirectories` / `sessions` 这类本插件
 * 用不到的服务：`inject` 是**硬依赖**，任何一项在某个 profile 里缺失，整条
 * 插件都不激活（表现为「装了但什么都不显示」）。需要可选服务时用
 * `ctx.inject(['layout'], (scoped) => …)` 拿作用域副本。
 */
export const inject = ['slots', 'connection']

/** 三处槽位共用的 key / id。 */
const PANEL_KEY = 'magpie'

/** 侧栏行的排序权重（与 Jet Hub 的 20、插件市场的更高值错开）。 */
const SIDEBAR_ORDER = 60

/** 设置节的排序权重。 */
const SETTINGS_ORDER = 60

/**
 * 底部统计条上的排序权重 —— **排到最尾部**。
 *
 * ## 为什么是 1000 而不是 2
 *
 * 官方那两个 pill 是 `activity`（order 0，轮次/步骤/速度）与 `usage`
 * （order 1，token/缓存命中），但这条统计条上还有**别的东西**：DSH 内置的
 * `ContextMeter`（上下文用量圆环，截图里那个 `10%`）注册在更靠右的位置。
 *
 * 最初我们写 `order: 2`，结果按钮被插在 `usage` 和 `ContextMeter` **中间**
 * —— 用户要求「移动尾部，而不是插入中间」。DSH 生态里 `order: 100` 已经
 * 是常用的大值（内置组件大量使用），所以取 `1000` 确保排在所有内置条目
 * 之后：以后 DSH 再加新的统计 pill 也不会被我们挤到左边。
 */
const DOCK_ORDER = 1000

const h = React.createElement

/**
 * ⚠️ **模块级常量**：`withErrorBoundary` 每次调用都产生一个新的类，写在
 * `inject` 回调里会让每次重渲染都换组件类型 ⇒ React 卸载重挂整棵子树。
 */
const MagpiePanelForMain = withErrorBoundary(MagpiePanel, { label: 'Magpie 面板' })

/** 与 `MagpiePanelForMain` 分开两个常量，让兜底文案能区分是哪一处坏了。 */
const MagpiePanelForSettings = withErrorBoundary(MagpiePanel, { label: 'Magpie 设置页' })

/**
 * 底部按钮同样要包错误边界 —— 它渲染在 composer 里，一处抛错会把整个输入区
 * 一起带走（用户就再也没法发消息了）。
 */
const MagpieDockButtonForDock = withErrorBoundary(MagpieDockButton, { label: 'Magpie 底部按钮' })

/**
 * 构造 `rpcCall` 闭包。
 *
 * ⚠️ 每次调用都从 `ctx.connection` **重新取**，不在 `apply()` 里提前捕获：
 * 连接服务在插件激活期间可能被替换（profile 切换、重连），提前捕获会一直用
 * 那个已经失效的实例。
 *
 * @param {any} ctx - 客户端插件上下文。
 * @returns {(method: string, payload?: unknown, signal?: AbortSignal) => Promise<unknown>}
 */
function makeRpcCall(ctx) {
  return (method, payload, signal) => callMagpieRpc(ctx.connection, method, payload, signal)
}

/**
 * 插件入口。
 *
 * @param {any} ctx - 客户端插件上下文（需要 `slots` 与 `connection`）。
 * @returns {void}
 */
export function apply(ctx) {
  // 样式注入幂等，放在最前面 —— 即使后面某处注册失败，面板至少样式是对的。
  installMagpieStyles()

  // ── 入口一：中央主面板的渲染体（无条件） ──
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_KEY,
        inject: () => ({ rpcCall: makeRpcCall(ctx) }),
      },
      MagpiePanelForMain,
    ),
  )

  // ── 入口二：主导航里的一行 ──
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_KEY,
        order: SIDEBAR_ORDER,
        label: () => 'Magpie',
      },
      MagpieSidebarIcon,
    ),
  )

  // ── 入口三：设置弹层里的一节 ──
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: PANEL_KEY,
        order: SETTINGS_ORDER,
        label: () => 'Magpie',
        inject: () => ({ rpcCall: makeRpcCall(ctx) }),
      },
      MagpiePanelForSettings,
    ),
  )

  // ── 入口四：底部统计条上的按钮（点击开小窗） ──
  //
  // 这个槽是 **list + 会话作用域**（`conversation.composer.dock`），官方在
  // 这里渲染 `activity`（order 0）与 `usage`（order 1）两个统计 pill。
  // 我们只提供渲染体，不需要 `sessionId`，所以 `inject` 直接给 `rpcCall`。
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        id: PANEL_KEY,
        order: DOCK_ORDER,
        inject: () => ({ rpcCall: makeRpcCall(ctx) }),
      },
      MagpieDockButtonForDock,
    ),
  )
}
