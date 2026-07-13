import type { AgentProviderKind, EmbeddingProviderKind, ModelProviderConfig } from "../../types/domain";
import { AnthropicAgentAdapter } from "./anthropic-agent-adapter";
import { OpenAIEmbeddingAdapter } from "./openai-embedding-adapter";
import { OpenAIResponsesAgentAdapter } from "./openai-responses-agent-adapter";
import type { AgentProviderAdapter, EmbeddingProviderAdapter } from "./types";

const agentAdapters = new Map<AgentProviderKind, AgentProviderAdapter>([
  ["anthropic", new AnthropicAgentAdapter("anthropic")],
  ["deepseek", new AnthropicAgentAdapter("deepseek")],
  ["bailian-anthropic", new AnthropicAgentAdapter("bailian-anthropic")],
  ["kimi-api", new AnthropicAgentAdapter("kimi-api")],
  ["kimi-coding", new AnthropicAgentAdapter("kimi-coding")],
  ["custom-anthropic", new AnthropicAgentAdapter("custom-anthropic")],
  ["openai-responses-agent", new OpenAIResponsesAgentAdapter("openai-responses-agent")],
]);

const embeddingAdapters = new Map<EmbeddingProviderKind, EmbeddingProviderAdapter>([
  ["openai", new OpenAIEmbeddingAdapter("openai")],
  ["qwen", new OpenAIEmbeddingAdapter("qwen")],
  ["doubao", new OpenAIEmbeddingAdapter("doubao")],
  ["zhipu", new OpenAIEmbeddingAdapter("zhipu")],
  ["minimax", new OpenAIEmbeddingAdapter("minimax")],
  ["custom-openai", new OpenAIEmbeddingAdapter("custom-openai")],
]);

export function getAgentProviderAdapter(provider: ModelProviderConfig): AgentProviderAdapter {
  const adapter = agentAdapters.get(provider.providerKind as AgentProviderKind);
  if (!adapter) throw new Error(`Unsupported agent provider: ${provider.providerKind}`);
  return adapter;
}

export function getEmbeddingProviderAdapter(provider: ModelProviderConfig): EmbeddingProviderAdapter {
  const adapter = embeddingAdapters.get(provider.providerKind as EmbeddingProviderKind);
  if (!adapter) throw new Error(`Unsupported embedding provider: ${provider.providerKind}`);
  return adapter;
}

export type { AgentProviderAdapter, EmbeddingProviderAdapter, ProviderHttpRequest } from "./types";
export { normalizeAnthropicBaseUrlForSdk, normalizeBaseUrl } from "./url-utils";
