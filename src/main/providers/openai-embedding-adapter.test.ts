import assert from "node:assert/strict";
import type { ModelProviderConfig } from "../../types/domain";
import { OpenAIEmbeddingAdapter } from "./openai-embedding-adapter";

const adapter = new OpenAIEmbeddingAdapter();

function provider(baseUrl: string): ModelProviderConfig {
  return {
    id: "provider_embedding_test",
    purpose: "embedding",
    providerKind: "custom-openai",
    adapterKind: "openai_embedding",
    name: "Embedding Test",
    protocol: "openai_compatible",
    baseUrl,
    apiKeyMasked: "",
    authMode: "bearer",
    models: [],
    selectedModel: "text-embedding-test",
    enabled: true,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
}

assert.equal(
  adapter.buildModelListRequest(provider("https://api.example.com"), "sk-test").url,
  "https://api.example.com/v1/models",
);
assert.equal(
  adapter.buildEmbeddingRequest(provider("https://api.example.com"), "sk-test", ["hello"]).url,
  "https://api.example.com/v1/embeddings",
);
assert.equal(
  adapter.buildEmbeddingRequest(provider("https://api.example.com/v1"), "sk-test", ["hello"]).url,
  "https://api.example.com/v1/embeddings",
);
assert.equal(
  adapter.buildEmbeddingRequest(provider("https://dashscope.aliyuncs.com/compatible-mode/v1"), "sk-test", ["hello"]).url,
  "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
);
assert.equal(
  adapter.buildEmbeddingRequest(provider("https://api.example.com/v1/embeddings"), "sk-test", ["hello"]).url,
  "https://api.example.com/v1/embeddings",
);

console.log("openai embedding adapter tests passed");
