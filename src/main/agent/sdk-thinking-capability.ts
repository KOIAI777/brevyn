import type { Options as ClaudeSdkOptions } from "@anthropic-ai/claude-agent-sdk";
import type { AgentProviderKind } from "../../types/domain";

type ClaudeSdkThinking = ClaudeSdkOptions["thinking"];
type ClaudeSdkEffort = ClaudeSdkOptions["effort"];

interface SdkThinkingRecommendation {
  thinking?: ClaudeSdkThinking;
  effort?: ClaudeSdkEffort;
}

export function recommendedSdkThinkingForModel(providerKind: AgentProviderKind, modelId: string): SdkThinkingRecommendation {
  const capability = detectSdkThinkingCapability(providerKind, modelId);
  if (capability === "adaptive-only" || capability === "adaptive-preferred") {
    return {
      thinking: { type: "adaptive" },
      effort: "high",
    };
  }
  return {};
}

type SdkThinkingCapability =
  | "adaptive-only"
  | "adaptive-preferred"
  | "manual-only"
  | "effort-based-max"
  | "none";

function detectSdkThinkingCapability(providerKind: AgentProviderKind, modelId: string): SdkThinkingCapability {
  if (startsModel(modelId, "deepseek-v4")) return "effort-based-max";
  if (providerKind === "deepseek") return "manual-only";
  if (providerKind === "kimi-api" || providerKind === "kimi-coding" || providerKind === "bailian-anthropic") return "none";
  if (providerKind === "openai-responses-agent") return "none";

  if (startsModel(modelId, "claude-mythos-preview")) return "adaptive-only";
  if (startsModel(modelId, "claude-opus-4-7")) return "adaptive-only";
  if (startsModel(modelId, "claude-opus-4-6") || startsModel(modelId, "claude-sonnet-5")) return "adaptive-preferred";

  return "manual-only";
}

function startsModel(modelId: string, prefix: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return normalized === prefix || normalized.startsWith(`${prefix}-`);
}
