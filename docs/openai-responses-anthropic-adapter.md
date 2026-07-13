# OpenAI Responses to Anthropic Adapter Design

更新时间：2026-05-14

## 结论

Brevyn 如果要让 **OpenAI Responses API** 服务商接入当前 Agent runtime，核心不是把 provider 字段改成 OpenAI，而是增加一层独立的协议转换 adapter：

```text
Claude Agent SDK
  -> Anthropic Messages request
  -> Local Anthropic Gateway
  -> OpenAI Responses upstream
  -> Anthropic Messages / Anthropic SSE response
  -> Claude Agent SDK
```

第一版不要直接改 `ClaudeSdkAdapter` 的流式解析，也不要把转换逻辑塞进 `ProviderService`、`VisionRecognitionService` 或 renderer timeline。协议转换应该是 main process 的纯运行时能力，单独放在 `src/main/protocols/`。

## 背景

当前状态：

- Agent runtime 使用 `@anthropic-ai/claude-agent-sdk`。
- Agent provider 目前只支持 `protocol: "anthropic_messages"`。
- Vision provider 已支持 `openai_responses`，但只是视觉识别服务里的局部请求/文本解析，不是通用 Agent 协议转换。
- Claude Agent SDK 需要 Anthropic-compatible endpoint，所以 OpenAI Responses 不能直接作为 SDK base URL 使用。

cc-switch 的经验：

- 它不是简单替换字段名，而是实现了 `Anthropic Messages <-> OpenAI Responses` 的完整 adapter。
- 流式转换需要状态机，维护 `content index`、打开的 block、tool call id 映射、usage 和 stop reason。
- 最值得借鉴的是 Responses SSE 到 Anthropic SSE 的转换，而不是 Codex OAuth 的特殊逻辑。

## 设计目标

1. OpenAI Responses provider 可以作为 Agent provider 使用。
2. Claude Agent SDK 无感知，仍然请求 Anthropic `/messages`。
3. 协议转换独立、可测试、可复用。
4. 支持非流式和流式。
5. 支持 text、thinking、tool_use、tool_result、image、usage。
6. 不影响现有 Anthropic/DeepSeek/Kimi provider。
7. 不把协议事件直接暴露给 renderer，renderer 仍消费 SDK/agent timeline 事件。

## 非目标

- 不实现 Codex OAuth / ChatGPT consumer backend 的特殊协议。
- 不在第一版做 provider failover 网关。
- 不实现 OpenAI Chat Completions 到 Anthropic 的 Agent 接入。
- 不替换 Claude Agent SDK。
- 不让 renderer 直接请求 OpenAI Responses。

## 模块拆分

建议新增：

```text
src/main/protocols/
  anthropic-types.ts
  openai-responses-types.ts
  protocol-adapter.ts
  openai-responses-anthropic-adapter.ts
  openai-responses-anthropic-stream.ts
  sse.ts

src/main/agent/
  local-anthropic-gateway.ts

src/main/providers/
  openai-responses-agent-adapter.ts
```

现有文件需要最小改动：

```text
src/types/domain.ts
src/main/providers/types.ts
src/main/providers/index.ts
src/main/agent/claude-sdk-adapter.ts
src/main/agent/agent-orchestrator.ts
src/main/services/provider-service.ts
src/renderer/components/settings/SettingsDialog.tsx
```

## 分层职责

### Provider Adapter

负责服务商配置，不负责消息协议语义。

职责：

- base URL normalization
- API key headers
- model list request
- connection test request
- SDK env 构建

新增 `OpenAIResponsesAgentAdapter`：

```ts
export class OpenAIResponsesAgentAdapter implements AgentProviderAdapter {
  readonly providerKind = "custom-openai-responses-agent";

  buildModelListRequest(provider, apiKey) {}
  buildConnectionTestRequest(provider, apiKey) {}
  buildSdkEnv(provider, apiKey) {}
  parseModelList(payload) {}
}
```

`buildSdkEnv()` 不把 OpenAI URL 直接给 SDK，而是返回本地 gateway 地址：

```ts
{
  ANTHROPIC_API_KEY: "<local-gateway-token>",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:<port>"
}
```

真实 OpenAI API key 只留在 main process，由 gateway 使用。

### Protocol Adapter

负责协议转换，不关心 provider 存储和 UI。

接口建议：

```ts
export interface AnthropicProtocolAdapter {
  anthropicToProviderRequest(input: {
    body: AnthropicMessagesRequest;
    provider: ModelProviderConfig;
    apiKey: string;
  }): Promise<ProviderHttpRequest>;

  providerJsonToAnthropic(body: unknown): AnthropicMessagesResponse;

  providerStreamToAnthropicSse(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
}
```

第一版只实现：

```ts
OpenAIResponsesAnthropicAdapter
```

### Local Anthropic Gateway

负责承接 Claude Agent SDK。

职责：

- 启动本地 HTTP server。
- 暴露 Anthropic-compatible `/messages`。
- 校验本地 token，避免被其他进程误用。
- 读取当前 run 绑定的 provider。
- 调用 protocol adapter 转换 request。
- fetch 上游 OpenAI Responses。
- 按 `stream` 返回 Anthropic JSON 或 Anthropic SSE。
- 支持 abort signal。

Gateway 不做业务：

- 不写 JSONL。
- 不构造 timeline。
- 不判断权限。
- 不做 UI 状态。

## 数据模型调整

当前：

```ts
export type AgentProtocol = "anthropic_messages";
export type AgentProviderKind =
  | "anthropic"
  | "deepseek"
  | "bailian-anthropic"
  | "kimi-api"
  | "kimi-coding"
  | "custom-anthropic";
```

建议改为：

```ts
export type AgentProtocol =
  | "anthropic_messages"
  | "openai_responses";

export type AgentProviderKind =
  | "anthropic"
  | "deepseek"
  | "bailian-anthropic"
  | "kimi-api"
  | "kimi-coding"
  | "custom-anthropic"
  | "openai-responses-agent"
  | "custom-openai-responses-agent";
```

新增 preset：

```ts
"openai-responses-agent": {
  kind: "openai-responses-agent",
  purpose: "agent",
  label: "OpenAI Responses",
  adapterKind: "openai_responses",
  protocol: "openai_responses",
  baseUrl: "https://api.openai.com/v1",
  authMode: "bearer",
}
```

设置页中 Agent provider 支持选择：

- Anthropic Messages
- OpenAI Responses

但运行时仍由 Claude SDK 统一驱动。

## 请求转换

### Anthropic request

输入示例：

```json
{
  "model": "gpt-5.5",
  "system": "You are helpful.",
  "max_tokens": 4096,
  "stream": true,
  "messages": [
    {
      "role": "user",
      "content": "Hello"
    }
  ],
  "tools": [
    {
      "name": "Read",
      "description": "Read a file",
      "input_schema": {
        "type": "object",
        "properties": {
          "file_path": { "type": "string" }
        }
      }
    }
  ]
}
```

### Responses request

转换结果：

```json
{
  "model": "gpt-5.5",
  "instructions": "You are helpful.",
  "max_output_tokens": 4096,
  "stream": true,
  "input": [
    {
      "role": "user",
      "content": [
        {
          "type": "input_text",
          "text": "Hello"
        }
      ]
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "Read",
      "description": "Read a file",
      "parameters": {
        "type": "object",
        "properties": {
          "file_path": { "type": "string" }
        }
      }
    }
  ]
}
```

字段映射：

| Anthropic | OpenAI Responses |
| --- | --- |
| `system` string | `instructions` |
| `system[] text` | `instructions` joined by blank lines |
| `messages[].content text` user | `input[].content[].input_text` |
| `messages[].content text` assistant | `input[].content[].output_text` |
| `image.source.base64` | `input_image.image_url` data URL |
| `tool_use` | top-level `function_call` input item |
| `tool_result` | top-level `function_call_output` input item |
| `max_tokens` | `max_output_tokens` |
| `temperature` | `temperature` |
| `top_p` | `top_p` |
| `tools[].input_schema` | `tools[].parameters` |
| `tool_choice.auto` | `tool_choice: "auto"` |
| `tool_choice.any` | `tool_choice: "required"` |
| `tool_choice.none` | `tool_choice: "none"` |
| forced `tool_choice` | `{ type: "function", name }` |
| `thinking` request blocks | drop in first version |
| `stop_sequences` | drop in first version |

注意：

- `tool_use` 和 `tool_result` 不能留在 message content 里，Responses 更适合把它们提升成 `input` 的顶层 item。
- tool arguments 要稳定 JSON 序列化，避免同一请求 cache key 因字段顺序变化而不同。
- 对 `Read` 这类工具可保留 cc-switch 的兼容清洗策略，例如移除空 `pages: ""`。

## 非流式响应转换

### Responses response

```json
{
  "id": "resp_123",
  "model": "gpt-5.5",
  "status": "completed",
  "output": [
    {
      "type": "message",
      "content": [
        {
          "type": "output_text",
          "text": "Hello"
        }
      ]
    },
    {
      "type": "function_call",
      "call_id": "toolu_123",
      "name": "Read",
      "arguments": "{\"file_path\":\"/tmp/a.md\"}"
    }
  ],
  "usage": {
    "input_tokens": 10,
    "output_tokens": 20
  }
}
```

### Anthropic response

```json
{
  "id": "resp_123",
  "type": "message",
  "role": "assistant",
  "model": "gpt-5.5",
  "content": [
    {
      "type": "text",
      "text": "Hello"
    },
    {
      "type": "tool_use",
      "id": "toolu_123",
      "name": "Read",
      "input": {
        "file_path": "/tmp/a.md"
      }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 10,
    "output_tokens": 20
  }
}
```

字段映射：

| Responses | Anthropic |
| --- | --- |
| `id` | `id` |
| `model` | `model` |
| `output[].message.content[].output_text` | `content[].text` |
| `output[].message.content[].refusal` | `content[].text` |
| `output[].function_call` | `content[].tool_use` |
| `output[].reasoning.summary[].summary_text` | `content[].thinking` |
| `usage.input_tokens` | `usage.input_tokens` |
| `usage.output_tokens` | `usage.output_tokens` |
| `usage.prompt_tokens` | fallback `usage.input_tokens` |
| `usage.completion_tokens` | fallback `usage.output_tokens` |
| `usage.input_tokens_details.cached_tokens` | `usage.cache_read_input_tokens` |

`stop_reason` 映射：

| Responses status | has tool use | incomplete reason | Anthropic stop_reason |
| --- | --- | --- | --- |
| `completed` | true | any | `tool_use` |
| `completed` | false | any | `end_turn` |
| `incomplete` | false | `max_output_tokens` | `max_tokens` |
| `incomplete` | false | other | `end_turn` |

## 流式响应转换

OpenAI Responses SSE 是 named event 生命周期；Anthropic SSE 是 message/content block 生命周期。必须用状态机。

### 核心事件映射

```text
response.created
  -> event: message_start

response.content_part.added output_text/refusal
  -> event: content_block_start

response.output_text.delta
  -> event: content_block_delta { type: text_delta }

response.refusal.delta
  -> event: content_block_delta { type: text_delta }

response.output_text.done
  -> event: content_block_stop

response.output_item.added function_call
  -> event: content_block_start { type: tool_use }

response.function_call_arguments.delta
  -> event: content_block_delta { type: input_json_delta }

response.function_call_arguments.done
  -> event: content_block_stop

response.reasoning.delta
  -> event: content_block_start { type: thinking }
  -> event: content_block_delta { type: thinking_delta }

response.reasoning.done
  -> event: content_block_stop

response.completed
  -> close dangling content blocks
  -> event: message_delta
  -> event: message_stop
```

### 状态机需要维护

```ts
interface ResponsesToAnthropicSseState {
  messageId?: string;
  model?: string;
  messageStarted: boolean;
  hasToolUse: boolean;
  nextContentIndex: number;
  openIndices: Set<number>;
  indexByPartKey: Map<string, number>;
  currentTextIndex?: number;
  fallbackOpenIndex?: number;
  toolIndexByItemId: Map<string, number>;
  toolNameByIndex: Map<number, string>;
  toolArgsByIndex: Map<number, string>;
  lastToolIndex?: number;
}
```

为什么需要这些状态：

- Responses 事件可能用 `item_id`、`output_index`、`content_index` 标识内容块。
- Anthropic 需要稳定递增的 `index`。
- tool call arguments 可能分多段 delta 到达。
- thinking、text、tool 可能穿插出现。
- 上游有时会缺少某些 start/done 事件，所以 adapter 要 best-effort 补齐 `content_block_start` 或关闭 dangling block。

### Anthropic SSE 示例

```text
event: message_start
data: {"type":"message_start","message":{"id":"resp_1","type":"message","role":"assistant","model":"gpt-5.5","usage":{"input_tokens":0,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":20}}

event: message_stop
data: {"type":"message_stop"}
```

## Local Gateway 设计

### 生命周期

`AgentOrchestrator` 启动 run 前：

1. 读取启用的 agent provider。
2. 如果 provider 是 `anthropic_messages`，沿用当前 SDK env。
3. 如果 provider 是 `openai_responses`，确保 `LocalAnthropicGateway` 已启动。
4. 为本次 run 注册 `gateway session`：
   - local token
   - provider id
   - api key
   - abort signal
5. `ClaudeSdkAdapter.buildEnv()` 返回 gateway base URL 和 local token。
6. run 结束后注销 gateway session。

### Gateway endpoint

支持：

```text
POST /messages
POST /v1/messages
```

因为不同 Anthropic client 可能拼接 `/v1/messages` 或 `/messages`。

### 认证

SDK 请求本地 gateway 时使用：

```text
x-api-key: <local-token>
authorization: Bearer <local-token>
```

Gateway 用 token 查 run session，再取真实 provider/apiKey。

真实 OpenAI key 不进入 Claude SDK env，也不写 JSONL。

### 错误映射

OpenAI upstream 错误统一转 Anthropic-compatible error：

```json
{
  "type": "error",
  "error": {
    "type": "api_error",
    "message": "Provider error ..."
  }
}
```

HTTP status 保留上游 status。对于 stream 中途错误，输出：

```text
event: error
data: {"type":"error","error":{"type":"stream_error","message":"..."}}
```

## Provider UI 方案

Agent 设置页新增 provider 类型：

- `Anthropic Messages`
- `OpenAI Responses`

OpenAI Responses Agent 表单字段：

- 名称
- Base URL
- API Key
- Model
- 启用模型列表
- 自动压缩阈值

提示文案：

```text
该服务商通过本地 Anthropic Gateway 接入 Claude Agent SDK。
Brevyn 会把 Anthropic Messages 自动转换为 OpenAI Responses。
```

不要在 UI 里暴露“proxy”、“SSE 状态机”这些实现细节。

## 实施阶段

### Phase 1: 纯 adapter 和单元测试

新增：

```text
src/main/protocols/openai-responses-anthropic-adapter.ts
src/main/protocols/openai-responses-anthropic-stream.ts
src/main/protocols/sse.ts
```

实现：

- `anthropicToOpenAiResponses()`
- `openAiResponsesToAnthropic()`
- `openAiResponsesSseToAnthropicSse()`

测试：

- simple text request
- system string / system array
- image input
- tool schema
- tool_use -> function_call
- tool_result -> function_call_output
- non-stream text response
- non-stream function_call response
- usage fallback
- streaming text delta
- streaming thinking delta
- streaming tool arguments delta
- interleaved text/tool/thinking
- dangling block close

完成标准：

- 不接 UI。
- 不改 SDK run 行为。
- 所有 adapter 测试通过。

### Phase 2: Local Anthropic Gateway

新增：

```text
src/main/agent/local-anthropic-gateway.ts
```

实现：

- start/stop server
- register/unregister run session
- token auth
- `/messages` handler
- stream forwarding
- abort forwarding

完成标准：

- 可以用一个本地脚本向 gateway 发 Anthropic request，实际打到 OpenAI Responses provider，返回 Anthropic JSON/SSE。
- 不接 Claude SDK。

### Phase 3: Agent provider 接入

修改：

```text
src/types/domain.ts
src/main/providers/types.ts
src/main/providers/index.ts
src/main/providers/openai-responses-agent-adapter.ts
src/main/agent/claude-sdk-adapter.ts
src/main/agent/agent-orchestrator.ts
```

实现：

- `AgentProtocol` 支持 `openai_responses`。
- provider preset 支持 OpenAI Responses Agent。
- `ClaudeSdkAdapter.buildEnv()` 能选择 gateway env。
- `AgentOrchestrator` 在 run lifecycle 注册 gateway session。

完成标准：

- 现有 Anthropic provider 不受影响。
- OpenAI Responses Agent provider 可以跑一次纯文本对话。

### Phase 4: Tools 和 timeline 压测

验证：

- Read/Glob/Bash/TodoWrite 工具调用。
- tool_use 和 tool_result 多轮闭环。
- thinking/text/tool 穿插顺序。
- 停止运行 abort。
- JSONL replay 不重复、不乱序。
- timeline 展开/折叠仍稳定。

完成标准：

- 能跑 workspace 检查 prompt。
- 能跑 todo list prompt。
- 能跑文件编辑 prompt。
- 运行停止后状态正确。

### Phase 5: Provider UI 和错误提示

修改：

```text
src/renderer/components/settings/SettingsDialog.tsx
src/main/services/provider-service.ts
```

实现：

- Agent provider 创建 OpenAI Responses 类型。
- 连接测试走 Responses。
- 模型列表走 `/models`，失败时不伪造模型。
- 错误 toast 直接展示 provider message。

完成标准：

- 用户可以在设置页配置、测试、启用 OpenAI Responses Agent provider。

## 测试 Prompt

基础流式：

```text
用一句话解释你现在能做什么。
```

thinking + 正文：

```text
先简短思考如何检查 workspace，再用中文总结你的计划。不要调用工具。
```

工具顺序：

```text
请连续使用 Bash pwd、Glob **/*、Read docs/architecture.md，然后总结 workspace。不要编辑文件。
```

todo list：

```text
创建一个 todo list：检查 workspace、总结发现、给出下一步计划。每完成一步就更新 todo list。不要编辑文件。
```

工具结果闭环：

```text
读取 docs/architecture.md，找出里面关于 provider 的设计，并用三点总结。不要编辑文件。
```

编辑压测：

```text
在临时草稿文件中写三行 smoke test 内容，然后把第二行改成 edited，最后总结修改了什么。
```

## 风险和处理

### 风险 1: Claude SDK 对 Anthropic SSE 格式很严格

处理：

- adapter 测试必须覆盖 `message_start`、`content_block_start`、`content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`。
- 所有 dangling block 在 `response.completed` 前关闭。

### 风险 2: 工具调用顺序乱

处理：

- 不能只用最后一个 tool index。
- 优先使用 `item_id` 映射。
- fallback 只在上游缺字段时使用。

### 风险 3: 多 run 并发串 provider

处理：

- gateway session 必须由 local token 定位 provider。
- 不使用全局 current provider。
- run 结束注销 token。

### 风险 4: API key 泄露

处理：

- Claude SDK env 只放 local token。
- OpenAI API key 只在 main process gateway 内使用。
- JSONL 不写真实 request headers。

### 风险 5: 旧 provider 被影响

处理：

- Anthropic provider 不经过 gateway。
- `openai_responses` provider 才走 gateway。
- 单元测试覆盖原 `AnthropicAgentAdapter.buildSdkEnv()`。

### 风险 6: Responses provider 不支持工具或 reasoning

处理：

- provider capability 后续显式配置：
  - `supportsTools`
  - `supportsReasoning`
  - `supportsVision`
  - `contextWindow`
- 第一版如果 provider 不支持工具，连接测试通过也要在 UI 标注限制。

## 推荐实现顺序

1. 先做 `src/main/protocols` 纯函数 adapter。
2. 再做 stream adapter 状态机。
3. 写单元测试锁住协议。
4. 做 local gateway。
5. 接 `ClaudeSdkAdapter.buildEnv()`。
6. 接 provider preset 和设置 UI。
7. 用真实 Agent prompt 压测。

不要反过来从 UI 或 provider 设置开始做。协议层没稳之前，UI 会让问题更难定位。

## 与现有架构关系

这套设计不替代现有 `AnthropicAgentAdapter`，而是新增一条 agent provider 协议路线：

```text
AnthropicAgentAdapter
  -> native Anthropic-compatible endpoint

OpenAIResponsesAgentAdapter
  -> LocalAnthropicGateway
  -> OpenAIResponsesAnthropicAdapter
  -> OpenAI Responses endpoint
```

Renderer timeline 不应该知道 provider 是 Anthropic 还是 OpenAI Responses。它只关心 SDK/agent event 是否按顺序出现。

## 最小可行版本

MVP 必须完成：

- Anthropic request 转 Responses request。
- Responses non-stream JSON 转 Anthropic JSON。
- Responses SSE 转 Anthropic SSE。
- Local gateway 单 provider 单 run。
- Claude SDK 通过 gateway 完成一次文本对话。
- 工具调用至少支持 Read/Glob/Bash/TodoWrite 的 request/response 循环。

MVP 可以暂缓：

- 多 provider failover。
- Codex OAuth 特殊字段。
- OpenAI Chat Completions。
- provider capability UI。
- 高级缓存参数。

