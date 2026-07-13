import type { ModelProviderConfig } from "../types/domain";

export function embeddingProviderFingerprint(provider: ModelProviderConfig): string {
  return [
    provider.id,
    provider.adapterKind,
    provider.providerKind,
    provider.protocol,
    provider.baseUrl,
    provider.selectedModel,
  ].join("|");
}
