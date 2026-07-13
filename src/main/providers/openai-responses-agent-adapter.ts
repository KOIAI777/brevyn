import type { AgentProviderKind, ModelProviderConfig, ProviderModel } from "../../types/domain";
import { withInferredContextWindow } from "../../shared/model-context-window";
import type { AgentProviderAdapter, ProviderHttpRequest } from "./types";
import { normalizeBaseUrl } from "./url-utils";

export class OpenAIResponsesAgentAdapter implements AgentProviderAdapter {
  constructor(readonly providerKind: AgentProviderKind = "openai-responses-agent") {}

  buildModelListRequest(provider: ModelProviderConfig, apiKey: string): ProviderHttpRequest {
    return {
      url: `${apiBaseUrl(provider)}/models`,
      init: {
        method: "GET",
        headers: headers(apiKey),
      },
    };
  }

  buildConnectionTestRequest(provider: ModelProviderConfig, apiKey: string): ProviderHttpRequest {
    return {
      url: `${apiBaseUrl(provider)}/responses`,
      init: {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify({
          model: provider.selectedModel || "gpt-5.5",
          input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
          max_output_tokens: 1,
          stream: false,
        }),
      },
    };
  }

  buildTitleRequest(provider: ModelProviderConfig, apiKey: string, prompt: string): ProviderHttpRequest {
    return {
      url: `${apiBaseUrl(provider)}/responses`,
      init: {
        method: "POST",
        headers: headers(apiKey),
        body: JSON.stringify({
          model: provider.selectedModel || "gpt-5.5",
          input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          max_output_tokens: 50,
          stream: false,
        }),
      },
    };
  }

  buildSdkEnv(): Record<string, string> {
    throw new Error("OpenAI Responses agent providers must be accessed through the local Anthropic gateway.");
  }

  parseModelList(payload: unknown): ProviderModel[] {
    const data = payload && typeof payload === "object"
      ? (payload as { data?: Array<{ id?: string; name?: string; context_window?: unknown; contextWindow?: unknown; context_length?: unknown; max_context_tokens?: unknown }> }).data
      : undefined;
    return (data || [])
      .flatMap((item) => {
        const id = (item.id || "").trim();
        if (!id) return [];
        const contextWindowTokens = positiveInteger(item.context_window ?? item.contextWindow ?? item.context_length ?? item.max_context_tokens);
        return [withInferredContextWindow({
          id,
          name: item.name || id,
          enabled: false,
          contextWindowTokens,
          contextWindowSource: contextWindowTokens ? "provider" : undefined,
        })];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  parseTitleResponse(payload: unknown): string | null {
    const response = payload && typeof payload === "object"
      ? payload as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }
      : undefined;
    if (response?.output_text) return response.output_text;
    for (const item of response?.output || []) {
      const text = item.content?.find((part) => (part.type === "output_text" || part.type === "text") && part.text)?.text;
      if (text) return text;
    }
    return null;
  }
}

function apiBaseUrl(provider: ModelProviderConfig): string {
  const normalized = normalizeBaseUrl(provider.baseUrl) || "https://api.openai.com/v1";
  const stripped = normalized
    .replace(/\/responses$/, "")
    .replace(/\/chat\/completions$/, "")
    .replace(/\/models$/, "");
  return /\/v\d+(?:\/|$)/.test(stripped) ? stripped : `${stripped}/v1`;
}

function headers(apiKey: string): Record<string, string> {
  return {
    "authorization": `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : undefined;
}
