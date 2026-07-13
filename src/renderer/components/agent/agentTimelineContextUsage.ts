import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT,
  MAX_AUTO_COMPACT_THRESHOLD_PERCENT,
  MIN_AUTO_COMPACT_THRESHOLD_PERCENT,
  type BrevynAgentTimelineRecord,
  type ModelProviderConfig,
} from "../../../types/domain";
import { resolveModelContextWindow } from "../../../shared/model-context-window";
import {
  isRuntimeRecord,
  type ContextUsage,
} from "@/components/agent/agentTimelineModel";
import { recordObject, stringValue } from "@/components/agent/tool-cards/toolModel";

const CACHE_USAGE_SAMPLE_LIMIT = 50;

export interface ContextUsageOptions {
  activeProvider?: ModelProviderConfig;
  providers?: ModelProviderConfig[];
  activeModelId?: string;
}

export function autoCompactThresholdPercent(provider?: ModelProviderConfig): number {
  const value = provider?.autoCompactThresholdPercent;
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT;
  return clampNumber(value, MIN_AUTO_COMPACT_THRESHOLD_PERCENT, MAX_AUTO_COMPACT_THRESHOLD_PERCENT);
}

export function shouldAutoCompactContext(usage: ContextUsage | null, provider?: ModelProviderConfig): boolean {
  const contextInputTokens = usage?.contextInputTokens ?? usage?.inputTokens ?? 0;
  if (!usage?.contextWindow || contextInputTokens <= 0 || usage.contextWindowSource === "unknown") return false;
  return contextInputTokens / usage.contextWindow >= autoCompactThresholdPercent(provider) / 100;
}

export function defaultContextUsage(model?: string, provider?: ModelProviderConfig): ContextUsage | null {
  const resolved = resolveModelContextWindow({ modelId: model || provider?.selectedModel, provider });
  return resolved.contextWindow ? {
    inputTokens: 0,
    contextInputTokens: 0,
    contextWindow: resolved.contextWindow,
    contextWindowSource: resolved.contextWindowSource,
    modelId: model || provider?.selectedModel,
    providerId: provider?.id,
    source: "default",
  } : null;
}

export function latestContextUsage(records: BrevynAgentTimelineRecord[], options: ContextUsageOptions = {}): ContextUsage | null {
  let latest: ContextUsage | null = null;
  for (const record of records) {
    if (isRuntimeRecord(record)) {
      if (record.event.type === "context_usage_updated") {
        latest = contextUsageFromSnapshot(record.event.snapshot, options);
      }
      continue;
    }
  }
  const cacheStats = recentCacheUsageStats(records);
  if (latest && cacheStats) {
    latest = { ...latest, ...cacheStats };
  }
  return latest && ((latest.contextInputTokens ?? latest.inputTokens) > 0 || latest.contextWindow) ? latest : null;
}

export function isCompactingContext(records: BrevynAgentTimelineRecord[]): boolean {
  let compacting = false;
  for (const record of records) {
    if (isRuntimeRecord(record)) continue;
    if ((record as SDKMessage).type === "result") {
      compacting = false;
      continue;
    }
    if ((record as SDKMessage).type !== "system") continue;
    const subtype = stringValue((record as { subtype?: unknown }).subtype, "");
    if (subtype === "compacting") compacting = true;
    if (subtype === "compact_boundary" || subtype === "compact_failed") compacting = false;
  }
  return compacting;
}

function contextUsageFromSnapshot(
  snapshot: Extract<Extract<BrevynAgentTimelineRecord, { kind: "runtime" }>["event"], { type: "context_usage_updated" }>["snapshot"],
  options: ContextUsageOptions,
): ContextUsage | null {
  const modelId = snapshot.modelId || options.activeModelId || options.activeProvider?.selectedModel;
  const provider = providerForModel(modelId, options);
  const resolvedWindow = resolveModelContextWindow({ modelId, provider });
  const snapshotContextWindow = positiveToken(snapshot.maxTokens) || positiveToken(snapshot.rawMaxTokens);
  const contextWindow = snapshotContextWindow || resolvedWindow.contextWindow;
  const contextInputTokens = positiveToken(snapshot.usedTokens);
  if (!contextInputTokens && !contextWindow) return null;
  return {
    inputTokens: contextInputTokens,
    contextInputTokens,
    contextWindow,
    contextWindowSource: snapshotContextWindow ? "provider" : resolvedWindow.contextWindowSource,
    modelId,
    providerId: provider?.id,
    remainingTokens: contextWindow ? Math.max(0, contextWindow - contextInputTokens) : undefined,
    percentage: typeof snapshot.percentage === "number" && Number.isFinite(snapshot.percentage) ? snapshot.percentage : undefined,
    source: "context_snapshot",
  };
}

function providerForModel(modelId: string | undefined, options: ContextUsageOptions): ModelProviderConfig | undefined {
  if (modelId) {
    const provider = options.providers?.find((item) => item.models.some((model) => model.id === modelId));
    if (provider) return provider;
  }
  return options.activeProvider;
}

function recentCacheUsageStats(records: BrevynAgentTimelineRecord[]): Pick<ContextUsage, "cacheReadTokens" | "cacheCreationTokens" | "cacheHitRate" | "cacheSampleCount"> | null {
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let inputLikeTokens = 0;
  let sampleCount = 0;

  for (let index = records.length - 1; index >= 0 && sampleCount < CACHE_USAGE_SAMPLE_LIMIT; index -= 1) {
    const record = records[index];
    if (isRuntimeRecord(record)) continue;
    const usage = usageFromRecord(record as SDKMessage);
    if (!usage) continue;
    const denominator = usage.denominatorTokens;
    if (denominator <= 0) continue;
    sampleCount += 1;
    inputLikeTokens += denominator;
    cacheReadTokens += usage.cacheReadTokens;
    cacheCreationTokens += usage.cacheCreationTokens;
  }

  if (sampleCount === 0) return null;
  return {
    cacheReadTokens,
    cacheCreationTokens,
    cacheHitRate: inputLikeTokens > 0 ? cacheReadTokens / inputLikeTokens : undefined,
    cacheSampleCount: sampleCount,
  };
}

function usageFromRecord(record: SDKMessage): { denominatorTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null {
  const root = recordObject(record);
  const brevynUsage = usageNumbers(recordObject(root._brevynUsage));
  if (brevynUsage) return brevynUsage;

  const directUsage = usageNumbers(recordObject(root.usage));
  if (directUsage) return directUsage;

  const messageUsage = usageNumbers(recordObject(recordObject(root.message).usage));
  if (messageUsage) return messageUsage;

  return null;
}

function usageNumbers(usage: Record<string, unknown>): { denominatorTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null {
  if (Object.keys(usage).length === 0) return null;
  const inputDetails = recordObject(usage.input_tokens_details);
  const promptDetails = recordObject(usage.prompt_tokens_details);
  const cachedFromDetails = positiveToken(inputDetails.cached_tokens ?? promptDetails.cached_tokens);
  const inputTokens = positiveToken(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens);
  const cacheReadTokens = positiveToken(
    usage.cacheReadTokens
      ?? usage.cacheReadInputTokens
      ?? usage.cache_read_input_tokens
      ?? cachedFromDetails,
  );
  const cacheCreationTokens = positiveToken(
    usage.cacheCreationTokens
      ?? usage.cacheCreationInputTokens
      ?? usage.cache_creation_input_tokens,
  );
  const contextInputTokens = positiveToken(usage.contextInputTokens ?? usage.context_input_tokens);
  const denominatorTokens = contextInputTokens || (cachedFromDetails ? inputTokens : inputTokens + cacheReadTokens + cacheCreationTokens);
  if (denominatorTokens <= 0 && cacheReadTokens <= 0 && cacheCreationTokens <= 0) return null;
  return { denominatorTokens, cacheReadTokens, cacheCreationTokens };
}

function positiveToken(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
