/**
 * Magpie 面板样式。
 *
 * ## 为什么用 `<style>` 注入而不是 CSS 文件
 *
 * 客户端 bundle 是 esbuild 打成 CJS 的单个 `.js`（见 `scripts/build-client.mjs`），
 * 没有 CSS 加载器。把样式写成模板字符串、运行时注入 `<style>` 是这类插件的
 * 通行做法。
 *
 * ## 为什么必须幂等
 *
 * DSH 的 `patchReload: "live"` 会在配置变更时**重建**插件 fiber —— 同一个
 * 页面生命周期里 `apply()` 可能被调用多次。不做判重就会堆出 N 份重复样式，
 * 且卸载时无法确定该删哪一份。
 *
 * ## 为什么类名都带 `dim-mp-` 前缀
 *
 * 面板渲染在宿主页面里，样式是**全局**的。没有命名空间隔离（不是 CSS Module）
 * 时，一个 `.card` 会污染整个 DSH 界面。前缀是唯一的防线。
 *
 * ## ⚠️ 模板字符串里不能出现反引号
 *
 * `STYLES` 是模板字符串，注释里若写反引号会**提前闭合**，后续内容变成
 * 语法垃圾 —— 报错位置会指向几百行之后，极难定位。
 *
 * @module magpie/client/styles
 */

/** 样式元素的 id —— 幂等注入的判据。 */
const STYLE_ELEMENT_ID = 'dsh-magpie-panel-styles'

/**
 * 全部样式。
 *
 * 配色取自 DSH 主题变量（`--dsw-alias-*`，**注意是 `dsw` 不是 `dsh`**），
 * 每个都带兜底值：插件可能在没有主题的上下文里渲染（如设置弹层）。
 */
const STYLES = `
/* ── 容器 ────────────────────────────────────────────────────────────── */

.dim-mp-panelHost {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  /* ⚠️ 必须给最小高度 —— settings.section 槽位的宿主容器高度是 auto
   * （由内容撑开），height:100% 在这里退化成 auto，iframe 就只剩
   * 浏览器默认的 150px，下方留一大片空白。 */
  min-height: 600px;
  box-sizing: border-box;
  /* main 槽宿主只给顶部 28px 标题带，左右下不留白；iframe 要铺满其余空间。 */
  padding: 0;
  background: var(--dsw-alias-bg-layer-3, #ffffff);
}

/* ── iframe ──────────────────────────────────────────────────────────── */

.dim-mp-frame {
  display: block;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 600px;
  border: 0;
  background: var(--dsw-alias-bg-layer-3, #ffffff);
}

/* ── 加载态 ──────────────────────────────────────────────────────────── */

.dim-mp-loading {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 24px;
  text-align: center;
}

.dim-mp-spinner {
  width: 28px;
  height: 28px;
  border: 2.5px solid var(--dsw-alias-border-default, #e5e5e5);
  border-top-color: #1677ff;
  border-radius: 50%;
  animation: dim-mp-spin 0.8s linear infinite;
}

@keyframes dim-mp-spin {
  to {
    transform: rotate(360deg);
  }
}

.dim-mp-loadingTitle {
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-text-primary, #1f2329);
}

.dim-mp-loadingHint {
  max-width: 460px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--dsw-alias-text-tertiary, #8a919c);
}

/* ── 错误态 ──────────────────────────────────────────────────────────── */

.dim-mp-error {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  margin: auto;
  max-width: 560px;
  padding: 24px;
  border: 1px solid #ffccc7;
  border-radius: 8px;
  background: #fff2f0;
}

.dim-mp-errorTitle {
  font-size: 14px;
  font-weight: 600;
  color: #cf1322;
}

.dim-mp-errorMessage {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  color: #a8071a;
  word-break: break-word;
}

.dim-mp-errorHint {
  font-size: 12px;
  line-height: 1.7;
  color: var(--dsw-alias-text-secondary, #5c6370);
}

.dim-mp-btn {
  padding: 5px 14px;
  border: 1px solid var(--dsw-alias-border-default, #e5e5e5);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-3, #ffffff);
  color: var(--dsw-alias-text-primary, #1f2329);
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.dim-mp-btn:hover {
  border-color: #1677ff;
  color: #1677ff;
}

.dim-mp-btn:focus-visible {
  outline: 2px solid #1677ff;
  outline-offset: 1px;
}

/* 底部统计条上的「Magpie」按钮 —— 点击开小窗。
 *
 * ⚠️ margin-left:auto 是**必须的**，用来把按钮推到统计条最右边。
 *
 * DSH 的统计条容器是 display:flex; justify-content:center; gap:12px
 * （app.asar 里的 .GRgSLq_dock 类），而 ContextMeter（那个 12% 圆环）
 * 是**硬编码在 renderSlot() 后面的兄弟节点**，不在槽位里 —— 所以无论
 * order 多大，Magpie 都排不到它右边。margin-left:auto 会吸收左侧
 * 的剩余空间，把按钮和 ContextMeter 一起推到右端，视觉上就脱离了
 * 「夹在两个统计项中间」的位置。
 */
.dim-mp-dockBtn {
  display: inline-flex;
  align-items: center;
  margin-left: auto;
  gap: 5px;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-text-secondary, #5c6370);
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  cursor: pointer;
  transition:
    color 0.12s ease,
    background-color 0.12s ease,
    border-color 0.12s ease;
}

.dim-mp-dockBtn:hover:not(:disabled) {
  border-color: var(--dsw-alias-border-default, #e5e5e5);
  background: var(--dsw-alias-bg-layer-2, #fafbfc);
  color: #1677ff;
}

.dim-mp-dockBtn:disabled {
  cursor: default;
  opacity: 0.6;
}

.dim-mp-dockBtn:focus-visible {
  outline: 2px solid #1677ff;
  outline-offset: 1px;
}

.dim-mp-dockBtn.isError {
  color: #cf1322;
}

.dim-mp-dockDot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

/* ── 小窗浮层 ──
 *
 * ⚠️ 不能用 window.open()：Electron 会把它交给系统浏览器
 * （DSH 映射成 shell.openExternal）。这里自己画一层 fixed 浮层。
 *
 * z-index 取 2147483000 而不是常见的 1000 —— DSH 自己的弹层（设置、
 * 模型选择器）动辄到 10000 以上，小一点就被压在下面。
 */
.dim-mp-dockOverlay {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  padding: 0 24px 96px;
  background: rgb(0 0 0 / 12%);
}

.dim-mp-dockWindow {
  display: flex;
  flex-direction: column;
  width: 440px;
  height: 520px;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-default, #e5e5e5);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3, #fff);
  box-shadow: 0 12px 40px rgb(0 0 0 / 18%);
}

.dim-mp-dockFrame {
  display: block;
  flex: 1 1 auto;
  width: 100%;
  border: 0;
}
`

/**
 * 幂等地注入样式。
 *
 * 可以在任何时机调用：已注入时直接返回，没有 `document`（服务端渲染 /
 * 测试环境）时静默跳过。
 *
 * @returns {void}
 */
export function installMagpieStyles() {
  if (typeof document === 'undefined') {
    return
  }
  if (document.getElementById(STYLE_ELEMENT_ID) !== null) {
    return
  }
  const element = document.createElement('style')
  element.id = STYLE_ELEMENT_ID
  element.textContent = STYLES
  document.head.appendChild(element)
}
