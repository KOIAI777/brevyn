import assert from "node:assert/strict";
import type { ModelProviderConfig } from "../types/domain";
import { embeddingProviderFingerprint } from "./embedding-provider-fingerprint";

const provider = testProvider();
const fingerprint = embeddingProviderFingerprint(provider);

assert.equal(
  embeddingProviderFingerprint({ ...provider, name: "Renamed", apiKeyMasked: "sk-new", updatedAt: "2026-07-10T01:00:00.000Z" }),
  fingerprint,
  "display and secret metadata must not invalidate an embedding index",
);
assert.notEqual(
  embeddingProviderFingerprint({ ...provider, selectedModel: "text-embedding-v2" }),
  fingerprint,
  "changing the embedding model must invalidate the index",
);
assert.notEqual(
  embeddingProviderFingerprint({ ...provider, baseUrl: "https://embedding.example/v2" }),
  fingerprint,
  "changing the embedding endpoint must invalidate the index",
);

console.log("embedding provider fingerprint tests passed");

function testProvider(): ModelProviderConfig {
  return {
    id: "provider-test",
    purpose: "embedding",
    providerKind: "custom-openai",
    adapterKind: "openai_embedding",
    name: "Test Embedding",
    protocol: "openai_compatible",
    baseUrl: "https://embedding.example/v1",
    apiKeyMasked: "sk-old",
    authMode: "api_key",
    models: [{ id: "text-embedding-v1", name: "Embedding V1", enabled: true }],
    selectedModel: "text-embedding-v1",
    enabled: true,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}
