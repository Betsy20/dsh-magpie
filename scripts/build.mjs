/**
 * 宿主侧构建：`tsc -p tsconfig.json` → 复制非 TS 资源。
 *
 * ## 为什么不用 `tsc` 直接当 script
 *
 * ① 必须**显式**指定本地 `typescript/bin/tsc` 而不是 PATH 里的 `tsc`：
 *    本机 PATH 上的 node 是 `D:\nodejs\node.exe`（v24.15.0），跑 vitest 会
 *    `ERR_IPC_CHANNEL_CLOSED` 崩 worker；构建脚本一律用 `process.execPath`
 *    继承当前 node（DSH 自带 v24.21.0），避免「换个 shell 就换了个 node」。
 * ② `tsc` 不搬非 `.ts` 文件（wasm/yml/json），这里统一补上。
 *
 * ## 幂等性
 *
 * 可以反复跑；`lib/` 下的旧产物由 `tsc` 覆盖。**不**做 `rm -rf lib` —— 那会
 * 让「只在增量构建里出现的缺失」变成「每次都全量」，反而藏住问题。
 *
 * @module scripts/build
 */

import { spawnSync } from 'node:child_process'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDirectory, '..')

/** 需要原样搬进 `lib/` 的非 TS 资源（相对包根）。 */
const ASSETS = [
  // cordis 的 bundle patch 由宿主的 profile loader 直接按 `package.json` 的
  // `dsh.bundle.patch` 路径读取，**不**经 `exports` 映射，但 `files` 字段里
  // 列的是包根的 `cordis.patch.yml`，故无需复制。留此数组是为了将来加资源时
  // 有明确落点（例如 wasm），而不是临时在命令里手写 cp。
]

/**
 * 跑一次 `tsc`。
 *
 * @param {string} tsc - `tsc` 入口的绝对路径。
 * @returns {void} 失败即 `process.exit`。
 */
function runTsc(tsc) {
  const result = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.json'], {
    cwd: packageRoot,
    stdio: 'inherit',
  })
  if (result.error !== undefined) {
    console.error(`[build] 启动 tsc 失败：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[build] tsc 退出码 ${String(result.status)}`)
    process.exit(result.status ?? 1)
  }
}

/**
 * 把 {@link ASSETS} 里的文件复制到 `lib/`。
 *
 * @returns {Promise<void>} 复制失败即抛出。
 */
async function copyAssets() {
  for (const relative of ASSETS) {
    const from = resolve(packageRoot, relative)
    const to = resolve(packageRoot, 'lib', relative.replace(/^src\//, ''))
    await mkdir(dirname(to), { recursive: true })
    await copyFile(from, to)
    console.log(`[build] 复制 ${relative} → ${to}`)
  }
}

/**
 * 跑一次子构建脚本（`scripts/build-client.mjs`）。
 *
 * 为什么单开一个进程而不是 `import()`：`build-client.mjs` 在**模块顶层**就
 * `await main()` 并可能 `process.exitCode = 1`。同进程 `import()` 会把它的
 * 失败混进本进程的退出码判断里，还让「宿主侧构建成功 / 客户端构建失败」这种
 * 中间态无法区分。开子进程后，退出码是唯一判据，失败信息也留在它自己的输出里。
 *
 * @returns {void} 失败即 `process.exit`。
 */
function runClientBuild() {
  const result = spawnSync(process.execPath, [resolve(packageRoot, 'scripts', 'build-client.mjs')], {
    cwd: packageRoot,
    stdio: 'inherit',
  })
  if (result.error !== undefined) {
    console.error(`[build] 启动客户端构建失败：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`[build] 客户端构建退出码 ${String(result.status)}`)
    process.exit(result.status ?? 1)
  }
}

runTsc(resolve(packageRoot, 'node_modules/typescript/bin/tsc'))
await copyAssets()
runClientBuild()
console.log('[build] 构建完成（宿主侧 + 客户端）')
