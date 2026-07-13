import type { EmbeddingProviderKind, ModelProviderConfig, ProviderModel } from "../../types/domain";
import type { EmbeddingProviderAdapter, ProviderHttpRequest } from "./types";
import { normalizeOpenAICompatibleBaseUrl } from "./url-utils";

export class OpenAIEmbeddingAdapter implements EmbeddingProviderAdapter {
  constructor(readonly providerKind: EmbeddingProviderKind = "openai") {}

  embeddingBatchSize(provider: ModelProviderConfig): number {
    const model = provider.selectedModel.toLowerCase();
    const baseUrl = provider.baseUrl.toLowerCase();
    if (this.providerKind === "qwen" || baseUrl.includes("dashscope.aliyuncs.com") || model.includes("text-embedding-v4")) {
      return 10;
    }
    return 24;
  }

  buildModelListRequest(provider: ModelProviderConfig, apiKey: string): ProviderHttpRequest {
    return {
      url: `${normalizeOpenAICompatibleBaseUrl(provider.baseUrl)}/models`,
      init: {
        method: "GET",
        headers: this.authHeaders(provider, apiKey, false),
      },
    };
  }

  buildEmbeddingRequest(provider: ModelProviderConfig, apiKey: string, input: string[]): ProviderHttpRequest {
    return {
      url: `${normalizeOpenAICompatibleBaseUrl(provider.baseUrl)}/embeddings`,
      init: {
        method: "POST",
        headers: this.authHeaders(provider, apiKey, true),
        body: JSON.stringify({
          input,
          model: provider.selectedModel,
          encoding_format: "float",
        }),
      },
    };
  }

  parseModelList(payload: unknown): ProviderModel[] {
    const data = payload && typeof payload === "object" ? (payload as { data?: Array<{ id?: string; display_name?: string; name?: string }> }).data : undefined;
    const models = (data || [])
      .flatMap((item) => providerModelFromId(item.id || "", item.display_name || item.name));
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
  }

  parseEmbeddingResponse(payload: unknown): number[][] {
    const data = payload && typeof payload === "object"
      ? (payload as { data?: Array<{ embedding?: unknown; index?: number }> }).data
      : undefined;
    const vectors = (data || [])
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((item) => Array.isArray(item.embedding) ? item.embedding as number[] : []);
    for (const vector of vectors) {
      if (vector.length === 0 || vector.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
        throw new Error("Embedding endpoint returned an invalid embedding payload.");
      }
    }
    return vectors;
  }

  private authHeaders(provider: ModelProviderConfig, apiKey: string, withContentType: boolean): Record<string, string> {
    const headers: Record<string, string> = provider.authMode === "api_key"
      ? { "x-api-key": apiKey }
      : { authorization: `Bearer ${apiKey}` };
    return withContentType ? { ...headers, "content-type": "application/json" } : headers;
  }
}

function providerModelFromId(id: string, displayName?: string): ProviderModel[] {
  const modelId = id.trim();
  if (!modelId) return [];
  return [{ id: modelId, name: displayName || modelId, enabled: true }];
}
