/**
 * Magpie 网关的**线格式**类型（wire types）。
 *
 * 全部取自真实抓包，不是按 OpenAI 规范推测：
 * - 模型目录：`GET /v1/models`（`D:/dsh-build/magpie-probe/models.json`，20 条）
 * - 流式对话：`POST /v1/chat/completions`（`stream:true`，
 *   `D:/dsh-build/magpie-probe/tools.json`）
 * - 管理接口：`/v1/magpie/{quotas,usage,limit}`（2026-11-06 实测）
 *
 * ⚠️ 这些类型**刻意宽松**：magpie 会把各上游 provider 的自报字段原样透传，
 * 同一个字段在不同 provider 下的形态并不一致（`max_output_tokens` 在 qoder
 * 两个模型上就缺失）。因此除「协议必需」外一律 `| undefined` + 可选，
 * 由 `catalog.ts` 集中做兜底，而不是靠类型系统假装它一定存在。
 *
 * @module dsh-magpie/types
 */

// #region 模型目录 -----------------------------------------------------------

/** 模型的可输入/输出模态。magpie 只声明 `text` 与 `image`。 */
export type WireModality = 'text' | 'image' | string

/** `GET /v1/models` 的单条模型。 */
export interface WireModel {
  /** 路由 id，**可含一个或多个斜杠**（如 `jet-hub-modelscope/deepseek-ai/DeepSeek-V4.1-Flash-1017`）。 */
  id: string
  object?: string
  /** 短名，如 `DeepSeek V4.1 Flash`。 */
  display_name?: string
  /** 长名（带 provider 归属），如 `DeepSeek V4.1 Flash · WPS 灵犀 Lingxi`。 */
  magpie_label?: string
  /** 上游 provider 标识，如 `wps-lingxi`。 */
  owned_by?: string
  type?: string
  created?: number
  created_at?: string
  context_length?: number
  context_window?: number
  max_input_tokens?: number
  max_output_tokens?: number
  modalities?: {
    input?: WireModality[]
    output?: WireModality[]
  }
  /** 该模型支持的思考档位**id 列表**（可能是乱序的，见 `REASONING_LADDER`）。 */
  reasoning_levels?: string[]
  /** 同上的结构化形态；`reasoning_levels` 缺失时用它兜底。 */
  supported_reasoning_levels?: Array<{ effort?: string }>
  reasoning?: boolean
  tool_call?: boolean
  supported_parameters?: string[]
  native_endpoints?: string[]
  pricing?: Record<string, string>
}

/** `GET /v1/models` 的响应信封。 */
export interface WireModelList {
  object?: string
  data?: WireModel[]
  first_id?: string
  last_id?: string
  has_more?: boolean
}

// #endregion

// #region 请求体 -------------------------------------------------------------

/** 请求里的 `image_url` 内容段。 */
export interface WireImagePart {
  type: 'image_url'
  image_url: {
    /** `data:<mediaType>;base64,<...>`。**不接受**裸 http URL（见 `messages.ts` 注释）。 */
    url: string
  }
}

/** 请求里的 `text` 内容段。 */
export interface WireTextPart {
  type: 'text'
  text: string
}

/** 请求里 `content` 的 parts 形态。 */
export type WireContentPart = WireTextPart | WireImagePart

/** 请求里的 assistant 消息上的工具调用。 */
export interface WireToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    /** **JSON 字符串**（不是对象）。流式累积完成后再发出去时同样是字符串。 */
    arguments: string
  }
}

/** 请求里的 assistant 消息。 */
export interface WireAssistantMessage {
  role: 'assistant'
  /** ⚠️ 有工具调用且正文为空时**必须是 `null`**；发空串会被上游判为非法。 */
  content: string | null
  /** 思维链回放（DeepSeek/灵犀系）。仅在该适配器同时拥有历史 provider 时才有值。 */
  reasoning_content?: string
  tool_calls?: WireToolCall[]
}

/** 请求里的 system 消息。 */
export interface WireSystemMessage {
  role: 'system'
  content: string
}

/** 请求里的 user 消息。 */
export interface WireUserMessage {
  role: 'user'
  /**
   * ⚠️ **纯文本必须是字符串**，不能包成 `[{type:'text',…}]` ——
   * 部分上游会对 parts 形态的纯文本回 `model_param_invalid` 400。
   * 只有含图片时才升级为 parts 数组。
   */
  content: string | WireContentPart[]
}

/** 请求里的 tool 结果消息。 */
export interface WireToolMessage {
  role: 'tool'
  /** 对应 assistant 消息里 `tool_calls[].id`。 */
  tool_call_id: string
  /** 只能是字符串；工具结果里的图片必须提升为**其后的独立 user 消息**。 */
  content: string
}

/** 请求体里的一条消息。 */
export type WireChatMessage =
  | WireSystemMessage
  | WireUserMessage
  | WireAssistantMessage
  | WireToolMessage

/** `POST /v1/chat/completions` 的请求体。 */
export interface WireChatRequest {
  model: string
  messages: WireChatMessage[]
  stream: boolean
  /** 只有 `stream:true` 时才该出现；magpie 靠它把 usage 塞进独立 chunk。 */
  stream_options?: { include_usage?: boolean }
  /** 思考档位（`none|minimal|low|medium|high|xhigh|max`）。模型不支持时不能发。 */
  reasoning_effort?: string
  temperature?: number
  max_tokens?: number
  stop?: string[]
  tools?: Array<{
    type: 'function'
    function: {
      name: string
      description: string
      parameters: Record<string, unknown>
    }
  }>
  tool_choice?: 'auto' | 'none'
  /** 会话归属（magpie 用于路由组粘性与用量统计）。 */
  user?: string
}

// #endregion

// #region 流式对话 -----------------------------------------------------------

/** 流式增量里的一个 tool call 片段。 */
export interface WireToolCallDelta {
  /** 第几个 tool call；多轮并行调用时用于区分累积目标。 */
  index?: number
  /** **只在首个片段上出现**，后续片段省略。 */
  id?: string
  type?: string
  function?: {
    /** **只在首个片段上出现**。 */
    name?: string
    /** 逐片段累积的**原始 JSON 字符串**（不是对象）。 */
    arguments?: string
  }
}

/** 流式增量的 `delta`。 */
export interface WireDelta {
  role?: string
  /** 正文增量。可能缺失、可能是空串。 */
  content?: string | null
  /** 思维链增量（DeepSeek/灵犀系）。 */
  reasoning_content?: string | null
  /** 工具调用增量。**同一个 delta 可与 `reasoning_content` 同时出现**（实测）。 */
  tool_calls?: WireToolCallDelta[]
}

/** 流式响应里的一个 `choices[]` 元素。 */
export interface WireStreamChoice {
  index?: number
  delta?: WireDelta
  /** 只在**最后一个**内容片段上非 null：`stop` / `length` / `tool_calls` / `content_filter`。 */
  finish_reason?: string | null
  logprobs?: unknown
}

/** token 用量。字段名是 OpenAI 的 snake_case。 */
export interface WireUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: {
    cached_tokens?: number
  }
  completion_tokens_details?: {
    reasoning_tokens?: number
  }
}

/** `POST /v1/chat/completions` 的流式响应体（每个 `data:` 行解析后的对象）。 */
export interface WireStreamChunk {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: WireStreamChoice[]
  /**
   * ⚠️ 用量出现在**独立的一个 chunk** 里（该 chunk 的 `choices` 是空数组），
   * 位置在 `finish_reason` 那个 chunk **之后**、`data: [DONE]` 之前。
   */
  usage?: WireUsage | null
  /** magpie 在流内传递错误的形态（HTTP 200 + 内嵌 error）。 */
  error?: WireErrorBody
}

/** 非流式响应体（`stream:false` 时用，测试与「探测模型可用性」会走这条路）。 */
export interface WireCompletion {
  id?: string
  object?: string
  created?: number
  model?: string
  choices?: Array<{
    index?: number
    message?: WireDelta & { tool_calls?: WireToolCallDelta[] }
    finish_reason?: string | null
  }>
  usage?: WireUsage | null
  error?: WireErrorBody
}

/** 错误体。magpie 转发上游错误，形态有三种（见 `errorMessageOf`）。 */
export interface WireErrorBody {
  message?: string
  type?: string
  code?: string | number
  param?: unknown
  /** 有些上游把它包在 `error` 里再套一层。 */
  error?: WireErrorBody | string
  /** 部分上游用 `detail` 承载真实原因。 */
  detail?: unknown
}

// #endregion

// #region 管理接口 -----------------------------------------------------------

/** `GET /v1/magpie/quotas` 的一条额度记录。 */
export interface WireQuota {
  provider?: string
  name?: string
  kind?: string
  plan?: string
  user?: string
  windows?: Array<{
    name?: string
    used?: number
    remaining?: number
    resetsAt?: string
    display?: string
    amount?: number
    limit?: number
    unit?: string
  }>
  balance?: string
  readAt?: string
  until?: string
  alias?: string
}

/** `GET /v1/magpie/quotas` 的响应信封。 */
export interface WireQuotaList {
  data?: WireQuota[]
}

/** `GET /v1/magpie/usage` 的时间序列点。 */
export interface WireUsageSeriesPoint {
  label?: string
  time?: string
  calls?: number
  errors?: number
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
  cost?: number
  unpriced?: number
}

/** `GET /v1/magpie/usage` 的响应。 */
export interface WireUsageReport {
  period?: string
  since?: string
  calls?: number
  errors?: number
  retried?: number
  loops?: number
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
  cost?: number
  unpriced?: number
  credits?: number
  credited?: number
  timed?: number
  ttft_ms?: number
  decode_ms?: number
  decode_out?: number
  decode_n?: number
  bucket?: string
  series?: WireUsageSeriesPoint[]
}

/** `GET /v1/magpie/limit` 的响应。 */
export interface WireLimit {
  key?: string
  limited?: boolean
  /** 有有效期时出现。 */
  expires?: string
  /** 旧版本字段名（保留兼容）。 */
  resetAt?: string
  reason?: string
  /** 被限制时出现的子集：`["budget","models","accounts"]`。 */
  heldTo?: string[]
  /** 被限制时的额度明细。 */
  quotas?: Record<string, unknown>
  /** 被限制时的模型白名单/黑名单。 */
  models?: string[]
  /** 被限制时的 provider 列表。 */
  quotaProviders?: string[]
  /** issued key 的签发者限制。 */
  issuerLimits?: Record<string, unknown>
  /** 有 limit 时的限额详情。 */
  limit?: Record<string, unknown>
  /** 同上（复数形态）。 */
  limits?: Record<string, unknown>
}

/** `GET /api/hello` 的响应（magpie 的存活与版本探测）。 */
export interface WireHello {
  name?: string
  version?: string
}

/** `GET /v1/magpie/usage/requests` 的一页。 */
export interface WireUsageRequestPage {
  data?: WireUsageRequest[]
  /** 下一页游标；`undefined` 表示到底。 */
  cursor?: string
  has_more?: boolean
  object?: string
  total?: number
}

/** 单条请求用量。 */
export interface WireUsageRequest {
  id?: number | string
  time?: string
  agent?: string
  provider?: string
  model?: string
  purpose?: string
  account?: string
  callerKey?: string
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  reasoning?: number
  cost?: number
  credits?: number
  failed?: boolean
  retried?: boolean
  via?: string
  computer?: string
  route?: number
}

/**
 * `GET /v1/magpie/route-events/snapshot` 的响应。
 *
 * ⚠️ 这是 `/v1/magpie/route-events`（无 cursor 时 **409** +
 * `{"error":"snapshot_required"}`）的前置端点。那里 `error` 是**字符串**
 * 而不是对象 —— 全仓唯一的异形，所以本模块不用 `WireErrorBody` 描述它。
 */
export interface WireRouteSnapshot {
  active?: number
  /** 游标，格式 `<base32>:<seq>`。 */
  cursor?: string
  routes?: WireRouteEvent[]
}

/** 一条路由事件。 */
export interface WireRouteEvent {
  /** ⚠️ 字符串（trace 端点的同名字段是 number）。 */
  id?: string
  time?: string
  agent?: string
  provider?: string
  /** provider 侧裸模型名（**不是** `provider/model`）。 */
  model?: string
  attempt?: number
  fallback?: boolean
  /** 实测只有 `"attempt"`。 */
  phase?: string
  /** `/v1/magpie/route` 单次查询时才会出现的附加字段。 */
  order?: unknown
  tries?: unknown
  sentBy?: string
  firstReasoning?: number
  flow?: number
  served?: string
}

/** `GET /v1/magpie/concurrency` 的响应。 */
export interface WireConcurrency {
  object?: string
  active?: WireActiveRequest[]
  /** 键是 `"<provider>@<account>"`。 */
  data?: Record<string, { busy?: number; waiting?: number; limit?: number }>
  /** 进行中的模型请求数。 */
  requests?: number
  /** 进行中的工具调用数。 */
  tools?: number
  /** 排队等待数。 */
  waiting?: number
}

/** 一条进行中的请求。 */
export interface WireActiveRequest {
  id?: number | string
  agent?: string
  model?: string
  provider?: string
  session?: string
  started?: string
  ms?: number
  phase?: string
  route?: number
}

/** `GET /v1/magpie/keys` 的响应。 */
export interface WireKeyList {
  data?: WireApiKey[]
  object?: string
}

/** 一个已命名的 API key。 */
export interface WireApiKey {
  name?: string
  key?: string
  created?: string
  expires?: string
  provider?: string
  models?: string[]
  note?: string
}

/** `GET /api/tags` 的响应。 */
export interface WireTagList {
  data?: Array<{ tag?: string; models?: string[]; count?: number }>
  object?: string
}

/**
 * `GET /v1/magpie/statusline` 的响应。
 *
 * ⚠️ 实测是 `text/plain`（4414 字节），且 `?format=json` / `?format=text` /
 * 无参三者返回体**完全相同** —— 没有 JSON 形态。这里保留 `string` 类型，
 * 由调用方自行解析。
 */
export type WireStatusline = string

// #endregion
