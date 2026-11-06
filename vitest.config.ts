/**
 * vitest 配置。
 *
 * ## 为什么单独一份而不是全塞进 `package.json`
 *
 * ① 需要 `poolOptions` 覆盖：本机 PATH 上的 node 是 v24.15.0，跑 vitest 会
 *    让 worker 进程以 `ERR_IPC_CHANNEL_CLOSED` 崩掉（`Error: Channel closed`，
 *    来自 tinypool，**没有失败用例、没有汇总行**，看起来像被更新进来的测试有
 *    bug）。构建/测试一律走 DSH 自带的 v24.21.0。
 * ② `include` 要把 `tests/**` 与 `src/**` 都覆盖到（后者是给将来就地写的
 *    `*.spec.ts` 留的口子）。
 *
 * @see https://vitest.dev/config/
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'src/**/*.spec.ts'],
    environment: 'node',
    globals: false,
    // 本项目没有需要浏览器环境的组件，纯 Node 即可。
    // 关闭并发写盘竞争：build 与测试可能同时跑。
    pool: 'threads',
    reporters: ['default'],
    // ⚠️ 不要开 `test.chaiConfig`/自定义 matcher —— 全部断言只用 vitest 内置，
    //    减少「测试能过但生产挂」的假绿面。
  },
})
