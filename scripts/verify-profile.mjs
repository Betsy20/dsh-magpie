#!/usr/bin/env node
/**
 * 装配校验：按 profile 的 `cordis.patch.yml` 逐项 import 插件包，检查导出契约。
 *
 * ## 为什么需要它
 *
 * 把插件装进 profile 后，唯一的「真机」验证方式是重启整个 Electron 应用 ——
 * 代价是中断会话、翻 stderr 找那行 `plugin tree failed to load: N entry did
 * not activate`（这行还不告诉你**哪一个** entry 挂了）。
 *
 * 而实际踩过的坑里，绝大多数**不需要**真宿主就能查出来：
 *
 * - 包名拼错 / 没做 junction → `ERR_MODULE_NOT_FOUND`
 * - 忘了 `export const name` → 宿主以空 inject 激活，首次读服务抛
 *   `cannot get property ... without inject`
 * - 同一段配置被写了两份（一次注释一次没注释）→ 看起来「改好了」其实没改
 * - `Config` 不是 schemastery → 所有依赖 settings 的界面全挂
 *
 * 本脚本把这几类问题在**几秒内**以可读的形式报出来。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/verify-profile.mjs                 # 校验 desktop profile
 * node scripts/verify-profile.mjs --profile web   # 换 profile
 * ```
 *
 * @module scripts/verify-profile
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_HOME = join(homedir(), '.dsh')

/** 从命令行取 `--profile <name>`，缺省 `desktop`。 */
function readProfileArg() {
  const index = process.argv.indexOf('--profile')
  return index === -1 ? 'desktop' : (process.argv[index + 1] ?? 'desktop')
}

/**
 * 提取 `- insert:` 下的 `{ id, name }` 对。
 *
 * ## 为什么不用 yaml 包
 *
 * 项目里没有可直接 require 的 `yaml` 依赖（它只挂在别的包的 node_modules
 * 下）。而 patch.yml 里**只需要**知道「哪些 `- insert:` 条目是生效的」，
 * 用缩进就能无歧义地切出来：
 *
 * - 顶格 `- insert:` 之后，紧接着的 `    - id: X`（4 空格）是条目起点
 * - `      name: Y`（6 空格）是条目名
 * - 任何顶格 `- ` 开头的行都意味着离开该 insert 块
 * - `#` 开头的行整行丢弃
 *
 * 之前用「全文正则找 `- id:`」的写法把 `config:` 里嵌套的模型清单
 * （`          - id: group/group`）也当成了插件条目，还漏掉了「同一条配置
 * 被写了两份」这种真实故障 —— 所以这里按缩进严格切。
 *
 * @param text - `cordis.patch.yml` 全文。
 * @returns `{ id, name }[]`；`name` 为空的条目会被丢弃。
 */
function parseInsertEntries(text) {
  const entries = []
  let current = null
  let inInsert = false
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*#/.test(rawLine)) continue
    const line = rawLine.trimEnd()
    if (line.length === 0) continue

    if (/^- insert:\s*$/.test(line)) {
      // 上一个 insert 块结束时必须把最后一个条目收进去 —— 否则每块
      // **最后一条**会被静默丢掉（正是靠这个 bug 才发现 magpie 没被解析出来）。
      if (current !== null) entries.push(current)
      inInsert = true
      current = null
      continue
    }
    // 任何其它顶格 `- ` 都是新的顶层条目，离开 insert 块。
    if (/^- /.test(line)) {
      if (current !== null) entries.push(current)
      inInsert = false
      current = null
      continue
    }
    if (!inInsert) continue

    const idMatch = /^ {4}- id: (.+)$/.exec(line)
    if (idMatch !== null) {
      if (current !== null) entries.push(current)
      current = { id: idMatch[1].replace(/^['"]|['"]$/g, '').trim(), name: '' }
      continue
    }
    const nameMatch = /^ {6}name: (.+)$/.exec(line)
    if (nameMatch !== null && current !== null) {
      current.name = nameMatch[1].replace(/^['"]|['"]$/g, '').trim()
    }
  }
  if (current !== null) entries.push(current)
  return entries.filter((entry) => entry.name.length > 0)
}

const profile = readProfileArg()
const profileDir = join(DSH_HOME, 'profiles', profile)
const patchPath = join(profileDir, 'cordis.patch.yml')

console.log(`\n=== 装配校验 · profile "${profile}" ===`)
console.log(`目录: ${profileDir}\n`)

let patchText
try {
  patchText = readFileSync(patchPath, 'utf8')
} catch (error) {
  console.error(`❌ 读不到 ${patchPath}\n   ${String(error)}`)
  process.exit(1)
}

const entries = parseInsertEntries(patchText)
console.log(`patch.yml 里共 ${entries.length} 条 insert 带 name:`)
for (const entry of entries) console.log(`  - ${entry.id.padEnd(26)} → ${entry.name}`)
console.log('')

const failures = []
const seenNames = new Map()

for (const entry of entries) {
  const label = `${entry.id} (${entry.name})`
  if (seenNames.has(entry.name)) {
    failures.push(`${label}: 重复 insert（同一包在 ${seenNames.get(entry.name)} 与 ${entry.id} 各注册一次）`)
    continue
  }

  let mod
  try {
    const packageJsonPath = join(profileDir, 'node_modules', entry.name, 'package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    const mainRelative = typeof packageJson.main === 'string' ? packageJson.main : 'index.js'
    const entryPath = join(profileDir, 'node_modules', entry.name, mainRelative)
    mod = await import(pathToFileURL(entryPath).href)
  } catch (error) {
    // `@deepseek-ai/*` 是 DSH **自带**的包（打包在 `app.asar` 里），profile
    // 的 `node_modules` 下根本没有 —— 宿主自己解析得到，不算装配问题。
    // 不跳过的话，第一个 MCP 条目会 ENOENT，后面同名的全部被判「重复
    // insert」，报出一串级联假象。
    if (entry.name.startsWith('@deepseek-ai/') && error?.code === 'ENOENT') {
      console.log(`  ⏭️  ${label}（宿主内置，跳过）`)
      continue
    }
    failures.push(`${label}: 无法加载 → ${error instanceof Error ? error.message : String(error)}`)
    continue
  }

  // ⚠️ 只有**加载成功**才记进 seenNames —— 否则第一个 ENOENT 会把后面
  //    同名的合法条目全部误判成「重复 insert」。
  seenNames.set(entry.name, entry.id)

  const problems = []
  // 宿主契约：必须有 name / inject / apply 三个具名导出。
  // 注意 `export const name` 是 **cordis 条目名**，与 patch.yml 的 `name:`
  // （npm 包名）不要求相同 —— 既有 `dsh-providers-hub` 导出的是
  // `codearts-auth` 就是反例。只要求非空。
  if (typeof mod.name !== 'string' || mod.name.length === 0) problems.push('缺少 export const name')
  if (!Array.isArray(mod.inject)) problems.push('缺少 export const inject（必须数组）')
  if (typeof mod.apply !== 'function') problems.push('缺少 export function apply')
  if (mod.default !== undefined) problems.push('存在 default 导出（会让 fiber 拿不到 name/inject）')
  if (mod.Config !== undefined && typeof mod.Config?.toJSON !== 'function') {
    problems.push('Config 不是 schemastery schema（没有 toJSON）')
  }

  if (problems.length > 0) {
    failures.push(`${label}:\n      ${problems.join('\n      ')}`)
    continue
  }
  const nameNote = mod.name === entry.name ? '' : `  (cordis 条目名 "${mod.name}")`
  console.log(`  ✅ ${label}${nameNote}`)
}

// 残留检查：注释掉的 llm-pi-ai 不该再出现在生效树里。
console.log('')
const commentedPiAiCount = (patchText.match(/^# - id: llm-pi-ai\b/gm) ?? []).length
if (commentedPiAiCount > 1) {
  failures.push(`llm-pi-ai 的注释副本有 ${commentedPiAiCount} 份 —— 手工改配置时容易只改一份，剩下一份看着像已停用其实没停用`)
} else {
  console.log(`  ✅ llm-pi-ai 注释副本 ${commentedPiAiCount} 份（无重复）`)
}

console.log('')
if (failures.length > 0) {
  console.error(`❌ ${failures.length} 处问题：\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('✅ 装配校验通过\n')
