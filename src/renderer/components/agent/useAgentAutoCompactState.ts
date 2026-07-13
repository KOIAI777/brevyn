import { useEffect, useRef } from "react";
import type { BrevynAgentTimelineRecord, ModelProviderConfig } from "@/types/domain";
import { isCompactCommandMessage, latestTurnBounds, type ContextUsage } from "@/components/agent/agentTimelineModel";
import { autoCompactThresholdPercent, shouldAutoCompactContext } from "@/components/agent/useAgentTimelineState";

export function useAgentAutoCompactState({
  threadId,
  records,
  queuedMessageCount,
  loading,
  error,
  activeProvider,
  contextUsage,
  effectiveRunning,
  effectiveCompacting,
  handleCompact,
}: {
  threadId: string;
  records: BrevynAgentTimelineRecord[];
  queuedMessageCount: number;
  loading: boolean;
  error?: string;
  activeProvider?: ModelProviderConfig;
  contextUsage: ContextUsage | null;
  effectiveRunning: boolean;
  effectiveCompacting: boolean;
  handleCompact: () => Promise<void>;
}): void {
  const autoCompactKeyRef = useRef("");
  const wasRunningRef = useRef(false);

  useEffect(() => {
    autoCompactKeyRef.current = "";
    wasRunningRef.current = false;
  }, [threadId]);

  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = effectiveRunning;
    if (!wasRunning) return;
    if (effectiveRunning || effectiveCompacting || loading || error || queuedMessageCount > 0) return;
    if (!activeProvider || !shouldAutoCompactContext(contextUsage, activeProvider)) return;
    const bounds = latestTurnBounds(records);
    if (!bounds || !bounds.result || isCompactCommandMessage(bounds.user)) return;
    const threshold = autoCompactThresholdPercent(activeProvider);
    const contextInputTokens = contextUsage?.contextInputTokens ?? contextUsage?.inputTokens ?? 0;
    const key = [
      threadId,
      records.length,
      contextInputTokens,
      contextUsage?.contextWindow ?? 0,
      threshold,
    ].join(":");
    if (autoCompactKeyRef.current === key) return;
    autoCompactKeyRef.current = key;
    void handleCompact();
  }, [activeProvider, contextUsage, effectiveCompacting, effectiveRunning, error, handleCompact, loading, queuedMessageCount, records, threadId]);
}
