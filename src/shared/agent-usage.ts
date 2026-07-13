import type {
  BrevynUsageMetadata,
  BrevynUsageProviderProtocol,
  ModelProviderConfig,
} from "../types/domain";
import { resolveModelContextWindow } from "./model-context-window";

export interface BrevynUsageSource {
  providerProtocol: BrevynUsageProviderProtocol;
  providerId?: string;
  modelId?: string;
  provider?: Pick<ModelProviderConfig, "id" | "protocol" | "selectedModel" | "models">;
}

export function brevynUsageFromAnthropicUsage(usage: unknown, source: BrevynUsageSource): BrevynUsageMetadata | undefined {
  const object = recordOf(usage);
  const inputTokens = tokenNumber(object.input_tokens);
  const outputTokens = tokenNumber(object.output_tokens);
  const cacheReadTokens = tokenNumber(object.cache_read_input_tokens);
  const cacheCreationTokens = tokenNumber(object.cache_creation_input_tokens);
  if (inputTokens <= 0 && outputTokens <= 0 && cacheReadTokens <= 0 && cacheCreationTokens <= 0) return undefined;
  return completeUsage({
    providerProtocol: source.providerProtocol,
    providerId: source.providerId || source.provider?.id,
    modelId: source.modelId || source.provider?.selectedModel,
    inputTokens,
    outputTokens: outputTokens || undefined,
    cacheReadTokens: cacheReadTokens || undefined,
    cacheCreationTokens: cacheCreationTokens || undefined,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    contextInputTokens: inputTokens + cacheReadTokens + cacheCreationTokens,
    raw: Object.keys(object).length > 0 ? object : undefined,
  }, source);
}

export function brevynUsageFromResponsesUsage(usage: unknown, source: BrevynUsageSource): BrevynUsageMetadata | undefined {
  const object = recordOf(usage);
  const inputDetails = recordOf(object.input_tokens_details);
  const promptDetails = recordOf(object.prompt_tokens_details);
  const outputDetails = recordOf(object.output_tokens_details);
  const completionDetails = recordOf(object.completion_tokens_details);
  const inputTokens = tokenNumber(object.input_tokens) || tokenNumber(object.prompt_tokens);
  const outputTokens = tokenNumber(object.output_tokens) || tokenNumber(object.completion_tokens);
  const cacheReadTokens = tokenNumber(inputDetails.cached_tokens) || tokenNumber(promptDetails.cached_tokens);
  const reasoningTokens = tokenNumber(outputDetails.reasoning_tokens) || tokenNumber(completionDetails.reasoning_tokens);
  const totalTokens = tokenNumber(object.total_tokens) || tokenNumber(object.total);
  if (inputTokens <= 0 && outputTokens <= 0 && totalTokens <= 0) return undefined;
  return completeUsage({
    providerProtocol: "openai_responses",
    providerId: source.providerId || source.provider?.id,
    modelId: source.modelId || source.provider?.selectedModel,
    inputTokens,
    outputTokens: outputTokens || undefined,
    cacheReadTokens: cacheReadTokens || undefined,
    cacheCreationTokens: 0,
    reasoningTokens: reasoningTokens || undefined,
    totalTokens: totalTokens || inputTokens + outputTokens,
    contextInputTokens: inputTokens,
    raw: Object.keys(object).length > 0 ? object : undefined,
  }, source);
}

export function mergeBrevynUsage(
  usage: BrevynUsageMetadata | undefined,
  source: BrevynUsageSource,
): BrevynUsageMetadata | undefined {
  if (!usage) return undefined;
  return completeUsage({
    ...usage,
    providerProtocol: usage.providerProtocol || source.providerProtocol,
    providerId: usage.providerId || source.providerId || source.provider?.id,
    modelId: usage.modelId || source.modelId || source.provider?.selectedModel,
  }, source);
}

export function mergeModelUsageContextWindow(
  usage: BrevynUsageMetadata | undefined,
  modelUsage: unknown,
  source: BrevynUsageSource,
): BrevynUsageMetadata | undefined {
  if (!usage) return undefined;
  const modelWindow = brevynUsageFromModelUsage(modelUsage, source);
  if (!modelWindow?.contextWindow) return usage;
  return {
    ...usage,
    contextWindow: modelWindow.contextWindow,
    contextWindowSource: modelWindow.contextWindowSource,
  };
}

export function brevynUsageFromModelUsage(modelUsage: unknown, source: BrevynUsageSource): BrevynUsageMetadata | undefined {
  const object = recordOf(modelUsage);
  let selected: BrevynUsageMetadata | undefined;
  let selectedContextInputTokens = 0;
  for (const [modelId, value] of Object.entries(object)) {
    const usage = recordOf(value);
    const inputTokens = tokenNumber(usage.inputTokens);
    const outputTokens = tokenNumber(usage.outputTokens);
    const cacheReadTokens = tokenNumber(usage.cacheReadInputTokens);
    const cacheCreationTokens = tokenNumber(usage.cacheCreationInputTokens);
    const contextInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
    if (contextInputTokens <= selectedContextInputTokens) continue;
    selectedContextInputTokens = contextInputTokens;
    selected = completeUsage({
      providerProtocol: source.providerProtocol,
      providerId: source.providerId || source.provider?.id,
      modelId: modelId || source.modelId || source.provider?.selectedModel,
      inputTokens,
      outputTokens: outputTokens || undefined,
      cacheReadTokens: cacheReadTokens || undefined,
      cacheCreationTokens: cacheCreationTokens || undefined,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
      contextInputTokens,
      contextWindow: tokenNumber(usage.contextWindow) || undefined,
      contextWindowSource: tokenNumber(usage.contextWindow) ? "model_config" : undefined,
      raw: Object.keys(usage).length > 0 ? usage : undefined,
    }, source);
  }
  return selected;
}

export function tokenNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function completeUsage(usage: BrevynUsageMetadata, source: BrevynUsageSource): BrevynUsageMetadata {
  const provider = source.provider;
  const modelId = usage.modelId || source.modelId || provider?.selectedModel;
  const resolvedWindow = usage.contextWindow
    ? { contextWindow: usage.contextWindow, contextWindowSource: usage.contextWindowSource || ("model_config" as const) }
    : resolveModelContextWindow({ modelId, provider });
  return {
    ...usage,
    providerId: usage.providerId || source.providerId || provider?.id,
    modelId,
    contextInputTokens: usage.contextInputTokens ?? usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheCreationTokens || 0),
    contextWindow: resolvedWindow.contextWindow,
    contextWindowSource: resolvedWindow.contextWindowSource,
  };
}
