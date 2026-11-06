/**
 * 端到端冒烟：用一个**假 ctx** 直接驱动插件，验证「注册 → 目录 → 流式」全链路。
 *
 * ## 为什么需要它
 *
 * 装进 profile 再重启 GUI 的成本很高（要中断会话、翻 stderr 找 `N entry did
 * not activate`），而 90% 的集成失败**不需要**真实宿主就能复现：
 * `registerAdapter` 没被调用、目录是空的、chunk 序列不合规 —— 这些在这里
 * 几秒就能看出来。
 *
 * ⚠️ 本脚本会**真的连网关**（默认 `http://127.0.0.1:3425`）。magpie 没跑时
 * 会在「目录」那步就失败，属于预期内的环境问题，不是代码问题。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/smoke.mjs                    # 只拉目录
 * node scripts/smoke.mjs --stream           # 再跑一次流式对话
 * node scripts/smoke.mjs --stream --model group/group
 * ```
 *
 * @module scripts/smoke
 */

import { apply, Config, inject, name } from '../lib/index.js'
import { PROVIDER as P } from '../lib/product.js'

/** 从 argv 里取 `--key value` 或 `--flag`。 */
function arg(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  const next = process.argv[index + 1]
  return next === undefined || next.startsWith('--') ? true : next
}

const model = typeof arg('--model') === 'string' ? arg('--model') : 'group/group'
const wantStream = arg('--stream') === true
const wantTools = arg('--tools') === true

/** 收集到的已注册 adapter。 */
const registrations = []

/**
 * 极简的假 ctx：只实现 `apply` 真正用到的四个成员。
 *
 * ⚠️ `inject` 故意**不**回调 —— 模拟 headless profile（没有 `connection`），
 * 验证「面板通道缺席时插件仍能正常激活」这条主路径。
 */
const ctx = {
  llm: {
    registerAdapter(providers, adapter) {
      registrations.push({ providers, adapter })
      const dispose = () => {}
      dispose.replace = () => {}
      return dispose
    },
  },
  logger: {
    debug: (message) => console.log(`  [debug] ${message}`),
    info: (message) => console.log(`  [info] ${message}`),
    warn: (message) => console.warn(`  [warn] ${message}`),
  },
  get: () => undefined,
  inject: () => {},
}

console.log(`== 1. 元数据 ==`)
console.log(`  name   = ${JSON.stringify(name)}`)
console.log(`  inject = ${JSON.stringify(inject)}`)
console.log(`  Config 字段 = ${Object.keys(Config.toJSON()).join(', ')}`)

console.log(`\n== 2. apply(ctx) ==`)
apply(ctx)
if (registrations.length !== 1) {
  console.error(`❌ 期望 1 次 registerAdapter，实际 ${String(registrations.length)} 次`)
  process.exit(1)
}
const [registration] = registrations
const adapter = registration.adapter
console.log(`  provider = ${JSON.stringify(registration.providers)}`)
console.log(`  providerInfo = ${JSON.stringify(adapter.providerInfo(P))}`)
console.log(`  retryPolicy = ${JSON.stringify(adapter.providerRetryPolicy(P))}`)

console.log(`\n== 3. listModels ==`)
const models = await adapter.listModels(P)
console.log(`  共 ${String(models.length)} 个模型`)
for (const entry of models) {
  console.log(`    ${entry.id}`)
  console.log(`      name=${entry.name} modalities=${JSON.stringify(entry.inputModalities ?? null)}`)
}

console.log(`\n== 4. resolveModel ==`)
const resolved = await adapter.resolveModel(P, model)
console.log(`  ${JSON.stringify({ ...resolved, provider: undefined, id: resolved.id }, null, 2)}`)

if (!wantStream) {
  console.log('\n（加 --stream 可继续跑流式对话）')
  process.exit(0)
}

console.log(`\n== 5. 流式对话（model = ${model}）==`)
const prepared = await adapter.prepareCall(P, model)
const chunks = []
const started = Date.now()
for await (const chunk of prepared.stream({
  provider: P,
  model,
  reasoningEffort: undefined,
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: wantTools ? '北京现在天气怎么样？请调用工具查询。' : '用一句话说明你是谁。',
        },
      ],
    },
  ],
  system: wantTools ? '你必须调用提供的工具来回答，不要自己编造。' : '你是一个简洁的助手。',
  ...(wantTools
    ? {
        tools: [
          {
            name: 'get_weather',
            description: '查询指定城市的当前天气',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string', description: '城市名' } },
              required: ['city'],
            },
          },
        ],
      }
    : {}),
  maxTokens: 256,
})) {
  chunks.push(chunk)
  const elapsed = String(Date.now() - started).padStart(6)
  switch (chunk.type) {
    case 'text-delta':
      process.stdout.write(`  ${elapsed}ms text#${String(chunk.index)} ${JSON.stringify(chunk.text)}\n`)
      break
    case 'reasoning-delta':
      process.stdout.write(`  ${elapsed}ms reason#${String(chunk.index)} ${JSON.stringify(chunk.text)}\n`)
      break
    case 'tool-call-delta':
      process.stdout.write(
        `  ${elapsed}ms tool#${String(chunk.index)} ${chunk.name ?? ''} ${JSON.stringify(chunk.argumentsDelta)}\n`,
      )
      break
    case 'block-start':
      process.stdout.write(`  ${elapsed}ms ▶ block-start #${String(chunk.index)} ${chunk.blockType}\n`)
      break
    case 'block-end':
      process.stdout.write(`  ${elapsed}ms ◀ block-end   #${String(chunk.index)} ${chunk.block.type}\n`)
      break
    case 'usage':
      process.stdout.write(`  ${elapsed}ms usage ${JSON.stringify(chunk.usage)}\n`)
      break
    case 'finish':
      process.stdout.write(`  ${elapsed}ms finish ${JSON.stringify(chunk.reason)}\n`)
      break
    default:
      process.stdout.write(`  ${elapsed}ms ??? ${JSON.stringify(chunk)}\n`)
  }
}

console.log(`\n== 6. 校验 ==`)
const types = chunks.map((chunk) => chunk.type)
const problems = []
if (types.at(-1) !== 'finish') problems.push('最后一个 chunk 不是 finish')
if (types.filter((type) => type === 'finish').length !== 1) problems.push('finish 出现次数不为 1')
const usageIndex = types.lastIndexOf('usage')
const finishIndex = types.lastIndexOf('finish')
if (usageIndex !== -1 && finishIndex !== -1 && usageIndex > finishIndex) {
  problems.push('usage 出现在 finish 之后')
}
const openBlocks = new Set()
for (const [index, chunk] of chunks.entries()) {
  if (chunk.type === 'block-start') openBlocks.add(chunk.index)
  else if (chunk.type === 'block-end') {
    if (!openBlocks.delete(chunk.index)) problems.push(`chunk#${String(index)} 关闭了未打开的块 ${String(chunk.index)}`)
  } else if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
    if (!openBlocks.has(chunk.index)) problems.push(`chunk#${String(index)} 向未打开的块 ${String(chunk.index)} 写 delta`)
  }
}
if (problems.length === 0) {
  console.log(`  ✅ 序列合规（${String(chunks.length)} 个 chunk）`)
} else {
  for (const problem of problems) console.error(`  ❌ ${problem}`)
  process.exit(1)
}
