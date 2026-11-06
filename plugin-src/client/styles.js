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
  min-height: 0;
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
  min-height: 0;
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
