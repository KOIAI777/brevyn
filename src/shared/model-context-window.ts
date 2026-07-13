import type { BrevynUsageContextWindowSource, ModelProviderConfig, ProviderModel } from "../types/domain";

export interface ResolvedContextWindow {
  contextWindow?: number;
  contextWindowSource: BrevynUsageContextWindowSource;
}

export function resolveModelContextWindow(input: {
  modelId?: string;
  provider?: Pick<ModelProviderConfig, "models" | "selectedModel">;
  model?: ProviderModel;
}): ResolvedContextWindow {
  const modelId = normalizeModelId(input.modelId || input.model?.id || input.provider?.selectedModel || "");
  const configuredModel = input.model || modelFromProvider(input.provider, modelId);
  const configuredWindow = positiveInteger(configuredModel?.contextWindowTokens);
  const inferred = inferContextWindowTokens(modelId);
  if (configuredWindow && configuredModel?.contextWindowSource !== "inferred") {
    return {
      contextWindow: configuredWindow,
      contextWindowSource: configuredModel?.contextWindowSource || "model_config",
    };
  }
  if (inferred) {
    return {
      contextWindow: inferred,
      contextWindowSource: "inferred",
    };
  }

  return { contextWindowSource: "unknown" };
}

export function withInferredContextWindow(model: ProviderModel): ProviderModel {
  const existing = positiveInteger(model.contextWindowTokens);
  if (existing && model.contextWindowSource !== "inferred") return { ...model };
  const inferred = inferContextWindowTokens(model.id || model.name);
  return inferred
    ? { ...model, contextWindowTokens: inferred, contextWindowSource: "inferred" }
    : { ...model };
}

export function inferContextWindowTokens(modelId: string): number | undefined {
  const normalized = normalizeModelId(modelId);
  if (!normalized) return undefined;

  if (isKnownOneMillionModel(normalized)) return 1_000_000;
  if (isClaudeOneMillionModel(normalized)) return 1_000_000;
  if (normalized.includes("claude") || normalized.includes("haiku")) return 200_000;

  if (normalized.includes("gpt-5.4")) return 1_000_000;
  if (normalized.includes("gpt-5.5")) return 258_000;
  if (
    normalized.includes("gpt-5")
    || normalized.includes("gpt-4.1")
    || normalized.includes("gpt-4o")
    || normalized.includes("o3")
    || normalized.includes("o4")
  ) return 200_000;

  if (normalized.includes("kimi")) return 200_000;
  return undefined;
}

export function isOneMillionContextModel(modelId: string): boolean {
  const normalized = normalizeModelId(modelId);
  return isKnownOneMillionModel(normalized) || isClaudeOneMillionModel(normalized);
}

function isClaudeOneMillionModel(normalized: string): boolean {
  if (!normalized.includes("claude") || normalized.includes("haiku")) return false;
  if (normalized.includes("[1m]") || normalized.includes("1m")) return true;
  return [
    "claude-sonnet-4",
    "claude-sonnet-5",
    "claude-opus-4-6",
    "claude-opus-4.6",
    "claude-opus-4-7",
    "claude-opus-4.7",
    "claude-opus-4-8",
    "claude-opus-4.8",
    "claude-fable-5",
  ].some((pattern) => normalized.includes(pattern))
    || /claude-(?:sonnet|opus)-4(?:[.-]\d+)?(?:[-.\w[\]]*)?$/.test(normalized);
}

function isKnownOneMillionModel(normalized: string): boolean {
  return [
    "deepseek-v4",
    "mimo-v2.5",
    "mimo-v2-pro",
    "glm-5.2",
    "minimax-m3",
    "qwen3.7",
  ].some((pattern) => normalized.includes(pattern));
}

function modelFromProvider(
  provider: Pick<ModelProviderConfig, "models" | "selectedModel"> | undefined,
  modelId: string,
): ProviderModel | undefined {
  if (!provider) return undefined;
  const selected = modelId || provider.selectedModel;
  return provider.models.find((model) => model.id === selected);
}

function normalizeModelId(value: string): string {
  return value.trim().toLowerCase();
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
