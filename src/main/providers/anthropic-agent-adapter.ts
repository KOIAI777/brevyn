import type { AgentProviderKind, ModelProviderConfig, ProviderModel } from "../../types/domain";
import { withInferredContextWindow } from "../../shared/model-context-window";
import type { AgentProviderAdapter, ProviderHttpRequest } from "./types";
import { normalizeAnthropicBaseUrlForSdk, normalizeAnthropicProviderBaseUrl } from "./url-utils";

const DEFAULT_ANTHROPIC_URL = "https://api.anthropic.com";

export class AnthropicAgentAdapter implements AgentProviderAdapter {
  constructor(readonly providerKind: AgentProviderKind = "anthropic") {}

  buildModelListRequest(provider: ModelProviderConfig, apiKey: string): ProviderHttpRequest {
    return {
      url: `${this.modelListBaseUrl(provider)}/models`,
      init: {
        method: "GET",
        headers: this.headers(apiKey, false),
      },
    };
  }

  buildConnectionTestRequest(provider: ModelProviderConfig, apiKey: string): ProviderHttpRequest {
    return {
      url: `${this.apiBaseUrl(provider)}/messages`,
      init: {
        method: "POST",
        headers: this.headers(apiKey, true),
        body: JSON.stringify({
          model: provider.selectedModel || defaultTestModel(this.providerKind),
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
    };
  }

  buildTitleRequest(provider: ModelProviderConfig, apiKey: string, prompt: string): ProviderHttpRequest {
    const model = provider.selectedModel || defaultTestModel(this.providerKind);
    const body: Record<string, unknown> = {
      model,
      max_tokens: 50,
      messages: [{ role: "user", content: prompt }],
    };
    if (shouldDisableThinkingForTitle(this.providerKind, model)) body.thinking = { type: "disabled" };
    return {
      url: `${this.apiBaseUrl(provider)}/messages`,
      init: {
        method: "POST",
        headers: this.headers(apiKey, true),
        body: JSON.stringify(body),
      },
    };
  }

  buildSdkEnv(provider: ModelProviderConfig, apiKey: string): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.providerKind === "kimi-coding") {
      env.ANTHROPIC_AUTH_TOKEN = apiKey;
      env.ANTHROPIC_CUSTOM_HEADERS = "User-Agent: KimiCLI/1.3";
    } else {
      env.ANTHROPIC_API_KEY = apiKey;
    }
    if (provider.baseUrl && provider.baseUrl !== DEFAULT_ANTHROPIC_URL) {
      env.ANTHROPIC_BASE_URL = normalizeAnthropicBaseUrlForSdk(provider.baseUrl);
    }
    return env;
  }

  parseModelList(payload: unknown): ProviderModel[] {
    const data = payload && typeof payload === "object" ? (payload as { data?: Array<{ id?: string; display_name?: string; name?: string }> }).data : undefined;
    return (data || [])
      .flatMap((item) => providerModelFromId(item.id || "", item.display_name || item.name));
  }

  parseTitleResponse(payload: unknown): string | null {
    const response = payload && typeof payload === "object"
      ? payload as {
        content?: Array<{ type?: string; text?: string; thinking?: string; reasoning?: string }>;
        choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string } }>;
      }
      : undefined;
    const choiceMessage = response?.choices?.find((choice) => choice.message?.content || choice.message?.reasoning_content || choice.message?.reasoning)?.message;
    if (choiceMessage?.content) return choiceMessage.content;
    if (choiceMessage?.reasoning_content) return titleFromThinking(choiceMessage.reasoning_content);
    if (choiceMessage?.reasoning) return titleFromThinking(choiceMessage.reasoning);

    const content = response?.content;
    const textBlock = content?.find((item) => (!item.type || item.type === "text") && item.text);
    if (textBlock?.text) return textBlock.text;
    const thinkingBlock = content?.find((item) => (item.type === "thinking" || item.thinking || item.reasoning) && (item.thinking || item.reasoning));
    const thinking = thinkingBlock?.thinking || thinkingBlock?.reasoning || "";
    return thinking ? titleFromThinking(thinking) : null;
  }

  private apiBaseUrl(provider: ModelProviderConfig): string {
    return normalizeAnthropicProviderBaseUrl(this.providerKind, provider.baseUrl);
  }

  private modelListBaseUrl(provider: ModelProviderConfig): string {
    const url = this.apiBaseUrl(provider);
    if (this.providerKind === "deepseek") return url.replace(/\/anthropic$/, "");
    return url;
  }

  private headers(apiKey: string, withContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
    };
    if (withContentType) headers["content-type"] = "application/json";
    if (this.providerKind === "kimi-coding") {
      headers.Authorization = `Bearer ${apiKey}`;
      headers["User-Agent"] = "KimiCLI/1.3";
      return headers;
    }
    headers["x-api-key"] = apiKey;
    headers.Authorization = `Bearer ${apiKey}`;
    return headers;
  }
}

function shouldDisableThinkingForTitle(providerKind: AgentProviderKind, modelId: string): boolean {
  const model = modelId.toLowerCase();
  if (model === "claude-mythos-preview" || model.startsWith("claude-mythos-preview-")) return false;
  if (providerKind === "kimi-api" || providerKind === "kimi-coding") return false;
  return providerKind === "anthropic" ||
    providerKind === "deepseek" ||
    model === "deepseek-v4" ||
    model.startsWith("deepseek-v4-") ||
    model.startsWith("claude-opus-4-") ||
    model.startsWith("claude-sonnet-4-");
}

function titleFromThinking(thinking: string): string | null {
  const lines = thinking.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";
  return lastLine.startsWith("- ") ? lastLine.slice(2).trim() : lastLine || null;
}

function defaultTestModel(providerKind: AgentProviderKind): string {
  if (providerKind === "deepseek") return "deepseek-v4-pro";
  if (providerKind === "bailian-anthropic") return "qwen-plus";
  if (providerKind === "kimi-api") return "kimi-k2.6";
  if (providerKind === "kimi-coding") return "kimi-for-coding";
  return "claude-sonnet-4-6";
}

function providerModelFromId(id: string, displayName?: string): ProviderModel[] {
  const modelId = id.trim();
  if (!modelId) return [];
  return [withInferredContextWindow({ id: modelId, name: displayName || modelId, enabled: false })];
}
