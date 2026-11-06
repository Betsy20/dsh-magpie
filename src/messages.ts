/**
 * DSH 对话历史 → magpie（OpenAI chat-completions）线格式。
 *
 * ## 这一层的职责边界
 *
 * 宿主的 `adapterStream()` 已经替我们做了三件事：文件块投影成文本
 * （`projectFilesToText`）、不支持图片的模型把图片降级成占位符
 * （`projectImagesForTextModel`）、developer 消息按工具更新能力过滤
 * （`projectToolUpdates`）。本模块**只负责剩下的、协议层面的硬要求**：
 *
 * 1. **工具调用配对**。历史里出现「有调用没结果」或「有结果没调用」时，
 *    上游会 400。DSH 的历史在正常路径下是配对的，但中断/压缩/回放都会
 *    留下孤儿 —— 必须在发请求前剔除，**而不是指望上游容忍**。
 * 2. **`content` 的三态**。assistant 正文为空且有工具调用时必须 `null`；
 *    user 纯文本必须是**字符串**（不是 parts）；只有含图片时才升级为
 *    parts 数组。三条都是实测会 400 的点，见下面各函数的注释。
 * 3. **工具结果里的图片提升**。`role:'tool'` 的 `content` 只能是字符串，
 *    且必须紧跟其 assistant `tool_calls`；图片只能进 user 消息。
 * 4. **system 消息归并**。DSH 把系统提示放在 `options.system`（渲染后的
 *    字符串），历史里也可能有 `role:'system'`。magpie 只认消息数组里的
 *    system，因此要按「options.system 在前、历史的 system 依次在后」拼。
 *
 * ## 为什么不是纯函数
 *
 * 图片要读字节。宿主只给「附件引用」，真实字节在附件服务里
 * （`ctx.attachments.readImage`），读是异步的 —— 所以本模块导出的是
 * `async` 函数而不是 `serialize()`。
 *
 * @module dsh-magpie/messages
 */

import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm'
import type {
  WireAssistantMessage,
  WireChatMessage,
  WireContentPart,
  WireSystemMessage,
  WireToolCall,
  WireToolMessage,
  WireUserMessage,
} from './types.js'

/**
 * 读取一张图片为 data URL。
 *
 * @param attachment - DSH 的附件引用（对本模块是不透明对象）。
 * @returns `data:<mediaType>;base64,<...>`。
 */
export type ImageReader = (attachment: unknown) => Promise<string>

/** 序列化选项。 */
export interface SerializeOptions {
  /**
   * 渲染后的系统提示（`GenerateOptions.system`）。
   *
   * 与历史里的 `role:'system'` 消息**会拼在一起**：前者在前。
   */
  readonly system?: string | undefined
  /**
   * 图片读取器。
   *
   * `undefined` 表示「该模型不支持图片输入」—— 此时图片块降级为
   * {@link IMAGE_PLACEHOLDER} 文本，而不是静默丢弃（静默丢弃会让模型
   * 在完全不知道有图的情况下作答，用户会误判成模型能力问题）。
   */
  readonly readImage?: ImageReader | undefined
}

/** 图片无法内联时给模型看的占位文本。 */
const IMAGE_PLACEHOLDER = '[图片：当前请求未能内联该附件]'

/** 工具结果为空时的兜底文本（`role:'tool'` 的 `content` 不能是空串）。 */
const EMPTY_TOOL_RESULT = '(no output)'

/** 一段已归一化的历史消息（工具结果已提升为一等 `role:'tool'`）。 */
interface NormalizedMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly blocks: readonly ContentBlock[]
  /** 仅 `role:'tool'` 有值。 */
  readonly toolCallId?: string
  /** 仅 `role:'tool'` 有值。 */
  readonly isError?: boolean
}

/**
 * 旧协议里的 `tool-result` 内容块。
 *
 * DSH 0.1.7 之前，工具结果是 user 消息里的一种内容块，而不是一等
 * `role:'tool'` 消息。跨版本升级的会话里两者都可能出现，所以适配器
 * 必须能认出来。它**不在** {@link ContentBlock} 联合里（该联合只描述
 * 当前协议），因此单独声明。
 */
interface LegacyToolResultBlock {
  readonly type: 'tool-result'
  readonly toolCallId?: unknown
  readonly content?: unknown
}

/**
 * 把 DSH 历史序列化成 magpie 的请求消息数组。
 *
 * @param messages - `GenerateOptions.messages`（可能混合新旧两代消息形状）。
 * @param options - 序列化选项。
 * @returns 可直接放进 `WireChatRequest.messages` 的数组。
 */
export async function toWireMessages(
  messages: readonly RequestMessage[],
  options: SerializeOptions = {},
): Promise<WireChatMessage[]> {
  const normalized = normalizeMessages(messages)

  // ---- 1. system 归并 ----------------------------------------------------
  // `options.system` 是宿主渲染好的完整提示；历史里的 system 消息是同一次
  // 交互的补充（例如压缩后的摘要指令）。两者都在时用 `\n\n` 连接 ——
  // 那是 markdown 段落边界，模型对它的理解最稳。
  const systemParts: string[] = []
  if (typeof options.system === 'string' && options.system.length > 0) {
    systemParts.push(options.system)
  }
  for (const message of normalized) {
    if (message.role !== 'system') continue
    const text = blocksToText(message.blocks)
    if (text.length > 0) systemParts.push(text)
  }

  const wire: WireChatMessage[] = []
  if (systemParts.length > 0) {
    wire.push({ role: 'system', content: systemParts.join('\n\n') } satisfies WireSystemMessage)
  }

  // ---- 2. 工具调用配对 ---------------------------------------------------
  const pairing = resolveToolPairing(normalized)

  // ---- 3. 逐条转换 -------------------------------------------------------
  // 工具结果里被提升出来的图片，必须**跟着其后第一条 user 消息一起发**：
  // 单独成条会让上游把图当成「无提问的图」（实测部分上游会直接过滤掉），
  // 而 `role:'tool'` 里又放不下（该角色 content 只能是字符串）。
  let pendingToolImages: WireContentPart[] = []

  for (const message of normalized) {
    if (message.role === 'system') continue

    if (message.role === 'assistant') {
      // 图片必须在 assistant **之前**发出，否则会漂到产生它们的工具调用
      // 之后，与调用脱节。
      flushPendingImages(wire, pendingToolImages)
      pendingToolImages = []
      wire.push(await toAssistantMessage(message, pairing, options))
      continue
    }

    if (message.role === 'tool') {
      const callId = message.toolCallId ?? ''
      if (!pairing.keepResultIds.has(callId)) continue
      const { text, images } = await splitBlocks(message.blocks, options)
      pendingToolImages.push(...images)
      wire.push({
        role: 'tool',
        tool_call_id: callId,
        // `content` 不能是空串：有些上游会回 `content is required`。
        content: text.length > 0 ? text : EMPTY_TOOL_RESULT,
      } satisfies WireToolMessage)
      continue
    }

    // ---- user ----
    const { text, images } = await splitBlocks(message.blocks, options)
    const allImages = [...pendingToolImages, ...images]
    pendingToolImages = []
    wire.push(toUserMessage(text, allImages))
  }

  // 尾巴上的挂起图片（历史以工具结果结束）不能在最后凭空造一条 user 消息
  // 吗？——**可以也必须**：丢掉它等于静默丢图。但只在真有图时才造。
  flushPendingImages(wire, pendingToolImages)

  return wire
}

/**
 * 把挂起的工具结果图片发成一条 user 消息。
 *
 * @param wire - 目标数组（原地追加）。
 * @param images - 待发图片（为空时什么都不做）。
 */
function flushPendingImages(wire: WireChatMessage[], images: readonly WireContentPart[]): void {
  if (images.length === 0) return
  wire.push({ role: 'user', content: [...images] } satisfies WireUserMessage)
}

/**
 * 组装一条 assistant 消息。
 *
 * 三态 `content` 是这里的核心：
 * - 有正文 → 字符串；
 * - 无正文、有工具调用 → `null`（**OpenAI 规范**，发空串会被判非法）；
 * - 无正文、无工具调用 → 空串（历史里的空 assistant 消息必须保留，
 *   否则会破坏 user/assistant 交替）。
 *
 * @param message - 归一化后的消息。
 * @param pairing - 工具配对结果。
 * @param options - 序列化选项。
 * @returns 线格式 assistant 消息。
 */
async function toAssistantMessage(
  message: NormalizedMessage,
  pairing: ToolPairing,
  options: SerializeOptions,
): Promise<WireAssistantMessage> {
  const toolCalls: WireToolCall[] = []
  const reasoningParts: string[] = []
  const textParts: string[] = []

  for (const block of message.blocks) {
    switch (block.type) {
      case 'tool-call': {
        const id = String(block.id)
        // 只为「有结果」的调用发声明：孤儿调用会让上游等一个永远不来的
        // 结果，或直接 400。
        if (!pairing.keepCallIds.has(id)) continue
        toolCalls.push({
          id,
          type: 'function',
          function: { name: block.name, arguments: normalizeToolArguments(block.arguments) },
        })
        break
      }
      case 'reasoning':
        // 思维链回放：只有本适配器同时拥有历史 provider 时宿主才会给出
        // reasoning 块（`forAdapter` 已剔除其它 adapter 的 replayState），
        // 因此这里可以无条件回放。
        reasoningParts.push(block.text)
        break
      case 'text':
        textParts.push(block.text)
        break
      default:
        // `image` / `file` / `tool-addition` / `tool-removal` 在 assistant
        // 消息里没有线格式表示（`adapterStream` 已投影），跳过。
        break
    }
  }

  const text = textParts.join('')
  const reasoning = reasoningParts.join('')

  return {
    role: 'assistant',
    content: text.length === 0 && toolCalls.length > 0 ? null : text,
    ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}

/**
 * 组装一条 user 消息。
 *
 * ⚠️ **无图时必须保持字符串形态**：纯文本若被包装成
 * `[{type:'text', text}]`，部分上游会以 `model_param_invalid` 400 拒收
 * 整个请求（实测）。只有真的有图时才升级为 parts 数组。
 *
 * @param text - 已拼接的正文。
 * @param images - 图片段（含从工具结果提升来的）。
 * @returns 线格式 user 消息。
 */
function toUserMessage(text: string, images: readonly WireContentPart[]): WireUserMessage {
  if (images.length === 0) return { role: 'user', content: text }
  const parts: WireContentPart[] = [...images]
  // 图在前、文本在后：两种顺序实测都能被看到，但文本在后更贴近
  // 「先给材料、再给问题」的自然阅读顺序。
  if (text.length > 0) parts.push({ type: 'text', text })
  return { role: 'user', content: parts }
}

/**
 * 把内容块拆成「文本」与「图片段」。
 *
 * @param blocks - 内容块。
 * @param options - 序列化选项。
 * @returns 文本与图片段。
 */
async function splitBlocks(
  blocks: readonly ContentBlock[],
  options: SerializeOptions,
): Promise<{ text: string; images: WireContentPart[] }> {
  const textParts: string[] = []
  const images: WireContentPart[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        textParts.push(block.text)
        break
      case 'reasoning':
        // user/tool 消息里的 reasoning 没有线格式表示，但内容不该丢 ——
        // 折进正文，比静默丢弃安全。
        textParts.push(block.text)
        break
      case 'image': {
        const url = await resolveImageUrl(block, options)
        if (url === undefined) {
          textParts.push(IMAGE_PLACEHOLDER)
        } else {
          images.push({ type: 'image_url', image_url: { url } })
        }
        break
      }
      case 'file':
        // 正常路径下 `projectFilesToText` 已把它转成文本；走到这里说明
        // 调用方绕过了投影，只能尽力给出可读占位。
        textParts.push('[文件：该附件未能在本请求中展开]')
        break
      default:
        // `tool-call` / `tool-addition` / `tool-removal` 在 user 消息里没有
        // 线格式表示，跳过。
        break
    }
  }

  return { text: textParts.join(''), images }
}

/**
 * 把一张图片解析成 data URL。
 *
 * @param block - 图片块。
 * @param options - 序列化选项。
 * @returns data URL；无法内联时 `undefined`（由调用方写占位文本）。
 */
async function resolveImageUrl(
  block: Extract<ContentBlock, { type: 'image' }>,
  options: SerializeOptions,
): Promise<string | undefined> {
  // 已被宿主标记为「本次请求外移」的图片：字节不在，只有元数据。
  // 强行读会抛，且宿主本来就期望我们发占位。
  if (block.offloaded === true) return undefined
  if (options.readImage === undefined) return undefined
  try {
    return await options.readImage(block.attachment)
  } catch {
    // 读图失败**不能**让整条请求失败：一张图读不出来不该毁掉整个会话。
    // 降级成占位文本，模型与用户都能看到「这里本该有图」。
    return undefined
  }
}

/**
 * 拼接内容块里的全部文本（system 归并专用）。
 *
 * @param blocks - 内容块。
 * @returns 拼接后的文本。
 */
function blocksToText(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' || block.type === 'reasoning') parts.push(block.text)
  }
  return parts.join('')
}

/**
 * 保证工具调用的 `arguments` 是**合法 JSON 字符串**。
 *
 * 上游对 `arguments` 有两层要求：必须是字符串（不是对象），且必须是
 * 可解析的 JSON。历史上存入的值可能为空串（流式被中断）—— 空串会让
 * 上游解析失败并回 400。
 *
 * @param raw - 原始 `arguments` 字符串。
 * @returns 合法的 JSON 字符串。
 */
export function normalizeToolArguments(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return '{}'
  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    // 不是合法 JSON：**不要**尝试修复（那会把用户的半截数据变成
    // 看似合法的错值）。退化成空对象，让模型重新发起调用。
    return '{}'
  }
}

/** 工具配对结果。 */
interface ToolPairing {
  /** 既有调用又有结果的 call id。 */
  readonly keepCallIds: ReadonlySet<string>
  /** 同上（两个集合内容一致，分开存只是为了让调用点读起来更直白）。 */
  readonly keepResultIds: ReadonlySet<string>
}

/**
 * 计算「既有调用又有结果」的 call id 集合。
 *
 * ## 为什么必须剔除孤儿
 *
 * 两种孤儿都会让上游 400：
 * - **有调用没结果**（用户中断、工具抛未捕获异常、历史被截断）：
 *   OpenAI 兼容后端会等待该 call id 的结果，等不到就拒收整个请求；
 * - **有结果没调用**（历史被压缩切掉了 assistant 那一半）：
 *   `role:'tool'` 必须紧跟对应 `tool_calls`，找不到就是非法序列。
 *
 * 剔除是**有损**的（历史里少了一次调用），但比整条请求失败好，
 * 而且是唯一能让会话继续下去的做法。
 *
 * @param messages - 归一化后的历史。
 * @returns 保留的 call id 集合。
 */
function resolveToolPairing(messages: readonly NormalizedMessage[]): ToolPairing {
  const callIds = new Set<string>()
  const resultIds = new Set<string>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.blocks) {
        if (block.type === 'tool-call') callIds.add(String(block.id))
      }
      continue
    }
    if (message.role === 'tool' && message.toolCallId !== undefined) {
      resultIds.add(message.toolCallId)
    }
  }

  const keep = new Set<string>()
  for (const id of callIds) {
    if (resultIds.has(id)) keep.add(id)
  }
  return { keepCallIds: keep, keepResultIds: keep }
}

/**
 * 归一化消息形状。
 *
 * ## 为什么需要它
 *
 * DSH 0.1.7 把「工具结果」从 user 消息里的 `tool-result` 内容块改成了
 * 一等 `role:'tool'` 消息。本适配器只面向新形态，但**历史里可能两种都有**
 * （跨版本升级的会话），且压缩摘要等路径也可能产出旧形态。若不归一化，
 * `resolveToolPairing` 认不出旧形态的结果，会把对应的调用全部判成孤儿
 * 剔除 —— 工具调用就此从历史里消失，模型会反复重做同样的调用。
 *
 * @param messages - 原始历史。
 * @returns 归一化后的历史（工具结果已提升为 `role:'tool'`）。
 */
function normalizeMessages(messages: readonly RequestMessage[]): NormalizedMessage[] {
  const normalized: NormalizedMessage[] = []

  for (const raw of messages) {
    const message = raw as {
      readonly role?: string
      readonly content?: unknown
      readonly toolCallId?: unknown
      readonly isError?: unknown
    }
    const role = message.role
    const blocks = Array.isArray(message.content) ? (message.content as ContentBlock[]) : []

    // 新形态：一等 tool 消息。直接采用。
    if (role === 'tool') {
      normalized.push({
        role: 'tool',
        blocks,
        toolCallId: typeof message.toolCallId === 'string' ? message.toolCallId : '',
        ...(message.isError === true ? { isError: true } : {}),
      })
      continue
    }

    if (role !== 'user' && role !== 'assistant' && role !== 'system') continue

    // 旧形态：user 消息里内嵌 `tool-result` 块。提升成独立的 tool 消息，
    // 且**必须排在**该 user 消息的其余内容之前 —— 工具结果要尽可能
    // 贴近它的 assistant 调用。
    //
    // ⚠️ 类型上 `ContentBlock` 里没有 `'tool-result'` 这个成员（那是旧
    // 协议的形状），所以这里的类型谓词必须用**独立的局部结构**而不是
    // `ContentBlock & {...}` —— 后者是个不可能的交叉类型，会收窄成
    // `never`，`result.content` 直接编译不过。
    const legacyBlocks = blocks as unknown as readonly LegacyToolResultBlock[]
    const legacyResults = legacyBlocks.filter(
      (block): block is LegacyToolResultBlock => block.type === 'tool-result',
    )

    if (legacyResults.length > 0) {
      for (const result of legacyResults) {
        const inner = Array.isArray(result.content) ? (result.content as ContentBlock[]) : []
        normalized.push({
          role: 'tool',
          blocks: inner,
          toolCallId: typeof result.toolCallId === 'string' ? result.toolCallId : '',
        })
      }
    }

    const rest = blocks.filter((block) => (block as { type?: unknown }).type !== 'tool-result')
    if (rest.length > 0) {
      normalized.push({ role: role as 'system' | 'user' | 'assistant', blocks: rest })
    }
  }

  return normalized
}
