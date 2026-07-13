import type { AgentProviderKind } from "../../types/domain";

export function normalizeBaseUrl(baseUrl?: string): string {
  return (baseUrl || "").trim().replace(/\/+$/, "");
}

export function normalizeOpenAICompatibleBaseUrl(baseUrl?: string): string {
  const normalized = normalizeBaseUrl(baseUrl)
    .replace(/\/embeddings$/, "")
    .replace(/\/models$/, "")
    .replace(/\/chat\/completions$/, "")
    .replace(/\/responses$/, "");
  if (!normalized) return "";
  return /\/v\d+(?:\/|$)/.test(normalized) ? normalized : `${normalized}/v1`;
}

export function normalizeAnthropicBaseUrl(baseUrl?: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/messages$/, "");
}

export function normalizeAnthropicBaseUrlForSdk(baseUrl?: string): string {
  return normalizeBaseUrl(baseUrl)
    .replace(/\/v\d+\/messages$/, "")
    .replace(/\/v\d+$/, "");
}

export function normalizeAnthropicProviderBaseUrl(providerKind: AgentProviderKind, baseUrl: string): string {
  void providerKind;
  return normalizeAnthropicBaseUrl(baseUrl);
}
