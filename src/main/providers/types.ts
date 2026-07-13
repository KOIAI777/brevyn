import type { AgentProviderKind, EmbeddingProviderKind, ModelProviderConfig, ProviderModel } from "../../types/domain";

export interface ProviderHttpRequest {
  url: string;
  init: RequestInit;
}

export interface AgentProviderAdapter {
  readonly providerKind: AgentProviderKind;
  buildModelListRequest(provider: ModelProviderConfig, apiKey: string): ProviderHttpRequest;
  buildConnectionTestRequest(provider: ModelProviderConfig, apiKey: string): ProviderHttpRequest;
  buildTitleRequest(provider: ModelProviderConfig, apiKey: string, prompt: string): ProviderHttpRequest;
  buildSdkEnv(provider: ModelProviderConfig, apiKey: string): Record<string, string>;
  parseModelList(payload: unknown): ProviderModel[];
  parseTitleResponse(payload: unknown): string | null;
}

export interface EmbeddingProviderAdapter {
  readonly providerKind: EmbeddingProviderKind;
  embeddingBatchSize?(provider: ModelProviderConfig): number;
  buildModelListRequest(provider: ModelProviderConfig, apiKey: string): ProviderHttpRequest;
  buildEmbeddingRequest(provider: ModelProviderConfig, apiKey: string, input: string[]): ProviderHttpRequest;
  parseModelList(payload: unknown): ProviderModel[];
  parseEmbeddingResponse(payload: unknown): number[][];
}
