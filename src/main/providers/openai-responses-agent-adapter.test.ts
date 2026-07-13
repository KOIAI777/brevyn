import assert from "node:assert/strict";
import type { ModelProviderConfig } from "../../types/domain";
import { cleanGeneratedTitle } from "../agent/thread-title-service";
import { AnthropicAgentAdapter } from "./anthropic-agent-adapter";
import { OpenAIResponsesAgentAdapter } from "./openai-responses-agent-adapter";

const adapter = new OpenAIResponsesAgentAdapter();
const anthropicAdapter = new AnthropicAgentAdapter();
const deepseekAdapter = new AnthropicAgentAdapter("deepseek");

function provider(baseUrl: string): ModelProviderConfig {
  return {
    id: "provider_test",
    purpose: "agent",
    providerKind: "openai-responses-agent",
    adapterKind: "openai_responses",
    name: "OpenAI Responses Test",
    protocol: "openai_responses",
    baseUrl,
    apiKeyMasked: "",
    authMode: "bearer",
    models: [],
    selectedModel: "gpt-test",
    enabled: true,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}

function anthropicProvider(providerKind: ModelProviderConfig["providerKind"], selectedModel: string): ModelProviderConfig {
  return {
    id: "provider_anthropic_test",
    purpose: "agent",
    providerKind,
    adapterKind: "anthropic",
    name: "Anthropic Test",
    protocol: "anthropic_messages",
    baseUrl: providerKind === "deepseek" ? "https://api.deepseek.com/anthropic" : "https://api.anthropic.com",
    apiKeyMasked: "",
    authMode: "api_key",
    models: [{ id: selectedModel, name: selectedModel, enabled: true }],
    selectedModel,
    enabled: true,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
  };
}

assert.equal(
  adapter.buildModelListRequest(provider("https://api-cn.wenrugouai.cn"), "sk-test").url,
  "https://api-cn.wenrugouai.cn/v1/models",
);
assert.equal(
  adapter.buildModelListRequest(provider("https://api-cn.wenrugouai.cn/v1"), "sk-test").url,
  "https://api-cn.wenrugouai.cn/v1/models",
);
assert.equal(
  adapter.buildConnectionTestRequest(provider("https://api-cn.wenrugouai.cn/v1/responses"), "sk-test").url,
  "https://api-cn.wenrugouai.cn/v1/responses",
);
assert.equal(
  adapter.buildTitleRequest(provider("https://api-cn.wenrugouai.cn/v1/responses"), "sk-test", "title").url,
  "https://api-cn.wenrugouai.cn/v1/responses",
);
assert.equal(
  adapter.parseTitleResponse({
    output: [{ type: "message", content: [{ type: "output_text", text: "整理财报重点" }] }],
  }),
  "整理财报重点",
);
assert.equal(
  anthropicAdapter.parseTitleResponse({ content: [{ type: "text", text: "复习期末计划" }] }),
  "复习期末计划",
);
assert.equal(
  anthropicAdapter.parseTitleResponse({ choices: [{ message: { content: "宏观阅读计划" } }] }),
  "宏观阅读计划",
);
assert.equal(
  anthropicAdapter.parseTitleResponse({ content: [{ type: "thinking", thinking: "分析用户消息\n- 宏观阅读计划" }] }),
  "宏观阅读计划",
);
const deepseekTitleBody = JSON.parse(String(deepseekAdapter.buildTitleRequest(anthropicProvider("deepseek", "deepseek-v4-flash"), "sk-test", "title").init.body));
assert.deepEqual(deepseekTitleBody.thinking, { type: "disabled" });
assert.equal(cleanGeneratedTitle("「整理财报重点。」"), "整理财报重点");
assert.equal(cleanGeneratedTitle("这是一个超过二十个字符长度限制并应当被自动截断的标题"), "这是一个超过二十个字符长度限制并应当被自");

console.log("openai-responses-agent-adapter tests passed");
