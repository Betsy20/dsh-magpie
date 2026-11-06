/**
 * 错误边界：把「渲染期异常」收敛成一个可读的提示块。
 *
 * ## 为什么必须有
 *
 * 槽位渲染没有隔离。`MagpiePanel` 里任何一处抛错（数据形状变了、字段是
 * `undefined`、格式化函数踩到 `null`），React 会认为**整棵子树**出错并卸载它 ——
 * 在设置弹层里表现为「整个设置页白屏、切页无效、只能重启」；在 `main` 槽里
 * 表现为「中央面板直接清空」。两种症状都远超「某个数字没显示出来」。
 *
 * 包一层边界后，坏掉的只是这一个面板，用户还能切走、还能看日志里的 label。
 *
 * ## 为什么是类组件
 *
 * `componentDidCatch` / `getDerivedStateFromError` 只有类组件有，函数组件没有
 * 对应 hook。别改成函数式 —— 那样异常会继续上抛。
 *
 * ## 组件身份
 *
 * `withErrorBoundary` 每次调用都产生一个**新的类**。调用方必须把它写在
 * **模块级**（`const X = withErrorBoundary(...)`），不能在 `inject` 回调或
 * `render` 里新建 —— 否则每次重渲染都换类型，React 会卸载重挂整棵子树，
 * 面板里的页签选中态、滚动位置全部丢失。
 *
 * @module magpie/client/error-boundary
 */

import * as React from 'react'

/**
 * 给组件包一层错误边界。
 *
 * @template {Record<string, unknown>} P
 * @param {React.ComponentType<P>} Component - 被保护的组件。
 * @param {{ label: string }} options - `label` 会出现在兜底文案与控制台日志里，
 *   用来区分「哪一块坏了」（同一插件注册了多处槽位，共用一份兜底会让排查失去方向）。
 * @returns {React.ComponentType<P>} 带边界的包装组件。
 */
export function withErrorBoundary(Component, { label }) {
  return class MagpieErrorBoundary extends React.Component {
    /**
     * @param {P} props
     */
    constructor(props) {
      super(props)
      /** @type {{ error: Error | null }} */
      this.state = { error: null }
    }

    /**
     * 把异常转成 state —— 这是 React 渲染兜底 UI 的唯一通道。
     *
     * @param {Error} error
     * @returns {{ error: Error }}
     */
    static getDerivedStateFromError(error) {
      return { error }
    }

    /**
     * 记录到控制台。**不要**在这里调 `setState`（已经在渲染兜底了）。
     *
     * @param {Error} error
     * @param {React.ErrorInfo} info
     */
    componentDidCatch(error, info) {
      console.error(`[magpie] ${label}渲染异常`, error, info?.componentStack ?? '')
    }

    render() {
      const error = this.state.error
      if (error !== null) {
        return React.createElement(
          'div',
          { className: 'dim-mp-panelHost', 'data-plugin': 'dsh-magpie' },
          React.createElement(
            'div',
            { className: 'dim-mp-error' },
            React.createElement('div', { className: 'dim-mp-errorTitle' }, `${label}渲染失败`),
            error instanceof Error ? error.message : String(error),
          ),
          React.createElement(
            'div',
            { style: { marginTop: 12, fontSize: 12, opacity: 0.7 } },
            '其余功能不受影响。可切到其它页签，或查看开发者控制台里的完整堆栈。',
          ),
        )
      }
      return React.createElement(Component, this.props)
    }
  }
}
