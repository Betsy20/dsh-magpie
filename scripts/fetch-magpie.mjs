#!/usr/bin/env node
/**
 * 手动预下载 magpie 二进制。
 *
 * ```bash
 * node scripts/fetch-magpie.mjs            # 没有才下
 * node scripts/fetch-magpie.mjs --force    # 强制重下
 * ```
 *
 * ## 为什么只是个薄封装
 *
 * 下载逻辑在 `src/download.ts` 的 {@link ensureMagpieBinary} 里 —— 插件
 * 运行时用的就是它。这里**不重复实现**，只做命令行入口，好处是：
 *
 * - 只有一套下载代码（`.part` + rename + sha256 + 进度日志）；
 * - 手动跑出来的结果和插件跑出来的**必然一致**（同一个目标路径、
 *   同一套校验）；
 * - 不存在「脚本修好了但插件里还是老逻辑」这种漂移。
 *
 * ## 什么时候需要它
 *
 * 插件在第一次需要二进制时会**自动**下载，正常情况下你不需要手动跑这个。
 * 它存在的意义是：
 *
 * - **CI / 容器镜像**：构建时预先下好，避免首次启动等待；
 * - **网络受限**：想先确认能不能下通；
 * - **离线环境**：下好后把 `~/.dsh/magpie/` 整个目录打包带走。
 *
 * @module dsh-magpie/scripts/fetch-magpie
 */

import { ensureMagpieBinary } from '../lib/download.js'

const force = process.argv.includes('--force')

try {
  const result = await ensureMagpieBinary({
    force,
    logger: {
      debug: (message) => {
        console.log(message)
      },
      warn: (message) => {
        console.warn(message)
      },
    },
  })
  console.log('')
  console.log(
    result.downloaded
      ? `magpie ${result.version ?? '(版本未知)'} 已下载 → ${result.path}`
      : `magpie ${result.version ?? '(版本未知)'} 已存在 → ${result.path}`,
  )
} catch (error) {
  // ⚠️ 不 `process.exit(1)` —— 这个脚本可能被 `postinstall` 调用，失败
  //    不该让整个 `npm install` 挂掉。插件运行时会再试一次。
  console.warn('')
  console.warn(`[fetch-magpie] 失败：${error instanceof Error ? error.message : String(error)}`)
  console.warn('[fetch-magpie] 插件仍可用，只要 magpie 在 PATH 里，或用 magpieBinary 指定路径。')
}
