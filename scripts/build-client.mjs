#!/usr/bin/env node
/**
 * 把 `plugin-src/client/` 打成宿主的客户端模块。
 *
 * ## 产物形态
 *
 * DSH 的 Web 端用 `window.__ModuleLoader__.load({ id, factory })` 加载客户端
 * 插件。`factory` 收到的 `require` 是宿主提供的**受限** `require` —— 只有
 * `react` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives` 这几个能解析，
 * 其余一律抛错。因此 esbuild 必须把它们标成 `external`（产物里保留
 * `require("react")`），其余全部打包进来。
 *
 * ## ⚠️ `id` 必须等于 `package.json` 的 `name`
 *
 * 宿主按 `id` 把模块登记进插件表，`apply()` 的 `name` 与之无关。两者不一致时
 * 的表现是启动日志里一句 `N entry did not activate`，**然后插件被静默禁用** ——
 * 没有任何指向 `id` 与包名不等的提示。所以这里从 `package.json` 读，不硬编码。
 *
 * ## 为什么手写包裹而不是 `banner` / `footer`
 *
 * `banner` 时 esbuild 还不知道产物里有没有 `module.exports` 被引用；而
 * `window.__ModuleLoader__.load` 的 `factory` **必须**返回模块的导出对象。
 * 手写包裹最直白：先生成 CJS 正文，再套一层 `var module = { exports: {} }`。
 *
 * @module scripts/build-client
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const ENTRY = join(root, 'plugin-src', 'client', 'index.js')
const OUT_FILE = join(root, 'lib', 'client.js')

/**
 * 宿主能提供给客户端插件的模块。**不要**往里加东西 —— 每加一个都要宿主
 * 那边同步改 `__ModuleLoader__` 的 require 解析表，而那张表在 app.asar 里，
 * 改不了。缺依赖时正确做法是把代码打进产物（本文件默认行为）。
 */
const EXTERNALS = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

/** 生产构建时压缩（与 `dsh-providers-hub` 的判据一致）。 */
const PRODUCTION = process.env.NODE_ENV === 'production'

/**
 * 主流程。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const moduleId = pkg.name
  if (typeof moduleId !== 'string' || moduleId.length === 0) {
    throw new Error('package.json 缺少 name，无法确定客户端模块 id。')
  }

  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    // chrome100 是宿主 Electron 的内核下限；不要写 es2020 —— 会让 `??=`、
    // 静态块这些语法被降级，产物反而更大。
    target: ['chrome100'],
    charset: 'utf8',
    external: EXTERNALS,
    minify: PRODUCTION,
    legalComments: 'none',
    // 客户端产物里不需要 sourcemap（宿主不做异常符号化），但保留一份便于
    // 在生产环境用 devtools 断点。体积上 60KB 源码 → 约 20KB 的 map，可接受。
    sourcemap: false,
    logLevel: 'warning',
  })

  if (result.outputFiles.length === 0) {
    throw new Error('esbuild 没有产出任何文件。')
  }

  const body = result.outputFiles[0].text

  // 缩进正文，让它落在 factory 函数体里不显得突兀（也避免 ASI 边界问题）。
  const indented = body
    .split('\n')
    .map((line) => (line.length === 0 ? line : `  ${line}`))
    .join('\n')

  const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(moduleId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${indented}
    return module.exports;
  }
});
`

  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, wrapped, 'utf8')

  const kb = (Buffer.byteLength(wrapped, 'utf8') / 1024).toFixed(1)
  console.log(`[build-client] ${moduleId} → lib/client.js (${kb} KB${PRODUCTION ? ', minified' : ''})`)
}

main().catch((error) => {
  console.error('[build-client] 失败：', error)
  process.exitCode = 1
})
