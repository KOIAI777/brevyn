import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentAttachment, AgentPermissionMode, BrevynAgentTimelineRecord, ModelProviderConfig, Thread } from "@/types/domain";
import { useAgentTimelineRecords } from "@/components/agent/useAgentTimelineRecords";
import {
  approvalResolutionMap,
  exitPlanResolutionMap,
  isCompactCommandMessage,
  latestTurnBounds,
  questionResolutionMap,
  type AgentTimelineRecord,
  type AgentTodoItem,
  type ContextUsage,
  type RunSummary,
} from "@/components/agent/agentTimelineModel";
import {
  autoCompactThresholdPercent,
  defaultContextUsage,
  isCompactingContext,
  latestContextUsage,
} from "@/components/agent/agentTimelineContextUsage";
import { latestTaskProgressList } from "@/components/agent/agentTimelineTodoModel";
import {
  hasRenderableAssistantContent,
  latestAssistantTextIndex,
  latestRunSummary,
  ownerUserInputIndexes,
  runSummaryForUserIndex,
} from "@/components/agent/agentTimelineRunState";
import {
  buildTimelineViewGroups,
  buildTimelineViewItems,
  stabilizeTimelineViewGroups,
} from "@/components/agent/agentTimelineViewModel";
import type { AgentTimelineViewGroup } from "@/components/agent/agentTimelineViewTypes";

export {
  type AgentTimelineDisplayKind,
  type AgentTimelineToolGroupSummary,
  type AgentTimelineTurnEntry,
  type AgentTimelineViewGroup,
  type AgentTimelineViewItem,
} from "@/components/agent/agentTimelineViewTypes";
export { buildTimelineViewGroups, buildTimelineViewItems, stabilizeTimelineViewGroups } from "@/components/agent/agentTimelineViewModel";
export { autoCompactThresholdPercent, shouldAutoCompactContext } from "@/components/agent/agentTimelineContextUsage";

export interface AgentTimelinePanelState {
  timelineRecords: AgentTimelineRecord[];
  timelineGroups: AgentTimelineViewGroup[];
  runSummary: RunSummary | null;
  todos: AgentTodoItem[];
  contextUsage: ContextUsage | null;
  effectiveRunning: boolean;
  effectiveCompacting: boolean;
  activeProvider?: ModelProviderConfig;
  autoCompactThresholdPercent: number;
  scrollTransitioning: boolean;
  toggleProcessCollapsed: (key: string, defaultCollapsed: boolean, lockedOpen: boolean) => void;
  handleCompact: () => Promise<void>;
}

export interface UseAgentTimelinePanelStateArgs {
  thread: Thread;
  records: BrevynAgentTimelineRecord[];
  running: boolean;
  agentProviders: ModelProviderConfig[];
  activeProviderId: string;
  onRun: (prompt: string, permissionMode?: AgentPermissionMode, attachments?: AgentAttachment[], providerSelection?: { providerId?: string; modelId?: string }, mentionedSkills?: string[]) => Promise<void>;
}

export function useAgentTimelineState({
  thread,
  records,
  running,
  agentProviders,
  activeProviderId,
  onRun,
}: UseAgentTimelinePanelStateArgs): AgentTimelinePanelState {
  const [processCollapsedByKey, setProcessCollapsedByKey] = useState<Record<string, boolean>>({});
  const [compactInFlightAfterCount, setCompactInFlightAfterCount] = useState<number | null>(null);
  const [scrollTransitioningCooldown, setScrollTransitioningCooldown] = useState(false);
  const wasRunningRef = useRef(false);
  const stableHistoryGroupsRef = useRef<{ threadId: string; groups: AgentTimelineViewGroup[] } | null>(null);
  const stableLiveTailGroupsRef = useRef<{ threadId: string; groups: AgentTimelineViewGroup[] } | null>(null);

  const activeProviderSelection = useMemo(() => parseProviderModelSelection(activeProviderId), [activeProviderId]);
  const activeProvider = useMemo(
    () => agentProviders.find((provider) => provider.id === activeProviderSelection.providerId),
    [activeProviderSelection.providerId, agentProviders],
  );
  const activeModelId = activeProviderSelection.modelId || activeProvider?.selectedModel;
  const compactInFlight = compactInFlightAfterCount !== null;
  const {
    effectiveRunning,
    historyRecords,
    liveTailRecords,
    liveRunning,
    timelineRecords,
  } = useAgentTimelineRecords({ threadId: thread.id, records, running });
  const scrollWasRunningRef = useRef(effectiveRunning);
  const needsInstantResize = !running && liveRunning;
  const scrollTransitioning = needsInstantResize || scrollTransitioningCooldown;
  const runSummary = useMemo(() => latestRunSummary(timelineRecords, Date.now(), effectiveRunning), [effectiveRunning, timelineRecords]);
  const todos = useMemo(() => latestTaskProgressList(timelineRecords), [timelineRecords]);
  const contextUsage = useMemo(
    () => latestContextUsage(timelineRecords, { activeProvider, providers: agentProviders, activeModelId }) ?? defaultContextUsage(activeModelId, activeProvider),
    [activeModelId, activeProvider, agentProviders, timelineRecords],
  );
  const compacting = useMemo(() => isCompactingContext(records), [records]);
  const effectiveCompacting = compacting || compactInFlight;
  const autoCompactThreshold = autoCompactThresholdPercent(activeProvider);
  const historyRunSummary = useMemo(
    () => latestRunSummary(historyRecords, Date.now(), false),
    [historyRecords],
  );
  const liveTailEffectiveRunning = effectiveRunning && liveTailRecords.length > 0;
  const liveTailRunSummary = useMemo(
    () => liveTailRecords.length > 0
      ? latestRunSummary(liveTailRecords, Date.now(), liveTailEffectiveRunning) ?? runSummary
      : null,
    [liveTailEffectiveRunning, liveTailRecords, runSummary],
  );
  const liveTailForceProcessOpen = liveTailEffectiveRunning && !hasRenderableAssistantContent(liveTailRecords);
  const builtHistoryGroups = useMemo(
    () => buildTimelineGroupsForRecords(historyRecords, {
      effectiveRunning: false,
      forceProcessOpen: false,
      processCollapsedByKey,
      runSummary: historyRunSummary,
    }),
    [historyRecords, historyRunSummary, processCollapsedByKey],
  );
  const builtLiveTailGroups = useMemo(
    () => buildTimelineGroupsForRecords(liveTailRecords, {
      effectiveRunning: liveTailEffectiveRunning,
      forceProcessOpen: liveTailForceProcessOpen,
      processCollapsedByKey,
      runSummary: liveTailRunSummary,
    }),
    [liveTailEffectiveRunning, liveTailForceProcessOpen, liveTailRecords, liveTailRunSummary, processCollapsedByKey],
  );
  const timelineGroups = useMemo(() => {
    const previousHistory = stableHistoryGroupsRef.current?.threadId === thread.id
      ? stableHistoryGroupsRef.current.groups
      : [];
    const previousLiveTail = stableLiveTailGroupsRef.current?.threadId === thread.id
      ? stableLiveTailGroupsRef.current.groups
      : [];
    const historyGroups = stabilizeTimelineViewGroups(previousHistory, builtHistoryGroups);
    const liveTailGroups = stabilizeTimelineViewGroups(previousLiveTail, builtLiveTailGroups);
    stableHistoryGroupsRef.current = { threadId: thread.id, groups: historyGroups };
    stableLiveTailGroupsRef.current = { threadId: thread.id, groups: liveTailGroups };
    return appendLiveTailGroups(historyGroups, liveTailGroups);
  }, [builtHistoryGroups, builtLiveTailGroups, thread.id]);

  useEffect(() => {
    setProcessCollapsedByKey({});
    setScrollTransitioningCooldown(false);
    scrollWasRunningRef.current = false;
    stableHistoryGroupsRef.current = null;
    stableLiveTailGroupsRef.current = null;
  }, [thread.id]);

  useEffect(() => {
    if (wasRunningRef.current && !effectiveRunning) setProcessCollapsedByKey({});
    wasRunningRef.current = effectiveRunning;
  }, [effectiveRunning]);

  useEffect(() => {
    if (scrollWasRunningRef.current && !effectiveRunning) {
      setScrollTransitioningCooldown(true);
    }
    scrollWasRunningRef.current = effectiveRunning;
  }, [effectiveRunning]);

  useEffect(() => {
    if (needsInstantResize) return;
    const timer = window.setTimeout(() => setScrollTransitioningCooldown(false), 150);
    return () => window.clearTimeout(timer);
  }, [needsInstantResize]);

  useEffect(() => {
    if (compactInFlightAfterCount === null || records.length <= compactInFlightAfterCount) return;
    const bounds = latestTurnBounds(records);
    if (!bounds) return;
    if (!isCompactCommandMessage(bounds.user)) {
      setCompactInFlightAfterCount(null);
      return;
    }
    const summary = latestRunSummary(timelineRecords, Date.now(), effectiveRunning);
    if (summary && summary.status !== "running") setCompactInFlightAfterCount(null);
  }, [compactInFlightAfterCount, effectiveRunning, records, timelineRecords]);

  const handleCompact = useCallback(async () => {
    if (effectiveRunning || effectiveCompacting) return;
    setCompactInFlightAfterCount(records.length);
    try {
      await onRun("/compact", "auto", undefined, activeProviderSelection);
    } catch (compactError) {
      setCompactInFlightAfterCount(null);
      console.error("[AgentThreadPanel] Failed to compact context:", compactError);
    }
  }, [activeProviderSelection, effectiveCompacting, effectiveRunning, onRun, records.length]);

  const toggleProcessCollapsed = useCallback((key: string, defaultCollapsed: boolean, lockedOpen: boolean) => {
    if (lockedOpen) return;
    setProcessCollapsedByKey((current) => ({
      ...current,
      [key]: !(current[key] ?? defaultCollapsed),
    }));
  }, []);

  return {
    timelineRecords,
    timelineGroups,
    runSummary,
    todos,
    contextUsage,
    effectiveRunning,
    effectiveCompacting,
    activeProvider,
    autoCompactThresholdPercent: autoCompactThreshold,
    scrollTransitioning,
    toggleProcessCollapsed,
    handleCompact,
  };
}

function appendLiveTailGroups(
  historyGroups: AgentTimelineViewGroup[],
  liveTailGroups: AgentTimelineViewGroup[],
): AgentTimelineViewGroup[] {
  if (liveTailGroups.length === 0) return historyGroups;
  const historyKeys = new Set(historyGroups.map((group) => group.key));
  const filteredLiveTailGroups = liveTailGroups.filter((group) => (
    !historyKeys.has(group.key) || isRunningTimelineGroup(group)
  ));
  return filteredLiveTailGroups.length > 0 ? [...historyGroups, ...filteredLiveTailGroups] : historyGroups;
}

function isRunningTimelineGroup(group: AgentTimelineViewGroup): boolean {
  if (group.type === "assistant-turn") {
    return Boolean(group.processItem?.processSummary?.running || group.items.some((item) => item.processSummary?.running));
  }
  return Boolean(group.item.processSummary?.running);
}

function buildTimelineGroupsForRecords(
  records: AgentTimelineRecord[],
  options: {
    effectiveRunning: boolean;
    forceProcessOpen: boolean;
    processCollapsedByKey: Record<string, boolean>;
    runSummary: RunSummary | null;
  },
): AgentTimelineViewGroup[] {
  if (records.length === 0) return [];
  const resolvedApprovals = approvalResolutionMap(records);
  const resolvedQuestions = questionResolutionMap(records);
  const resolvedExitPlans = exitPlanResolutionMap(records);
  const ownerUserIndexByRecordIndex = ownerUserInputIndexes(records);
  const runSummaryByUserIndex = new Map<number, RunSummary | null>();
  for (const ownerUserIndex of ownerUserIndexByRecordIndex) {
    if (ownerUserIndex < 0 || runSummaryByUserIndex.has(ownerUserIndex)) continue;
    runSummaryByUserIndex.set(ownerUserIndex, runSummaryForUserIndex(records, ownerUserIndex, Date.now(), options.effectiveRunning));
  }
  const stoppedAssistantIndex = options.runSummary?.status === "stopped" ? latestAssistantTextIndex(records) : undefined;
  const items = buildTimelineViewItems(records, {
    forceProcessOpen: options.forceProcessOpen,
    ownerUserIndexByRecordIndex,
    processCollapsedByKey: options.processCollapsedByKey,
    resolvedApprovals,
    resolvedExitPlans,
    resolvedQuestions,
    runSummary: options.runSummary,
    runSummaryByUserIndex,
    stoppedAssistantIndex,
  });
  return buildTimelineViewGroups(records, items, {
    effectiveRunning: options.effectiveRunning,
    forceProcessOpen: options.forceProcessOpen,
    runSummary: options.runSummary,
    processCollapsedByKey: options.processCollapsedByKey,
  });
}

function parseProviderModelSelection(value: string): { providerId?: string; modelId?: string } {
  const [providerId, modelId] = value.split("::");
  if (!providerId || !modelId) return {};
  return {
    providerId: decodeURIComponent(providerId),
    modelId: decodeURIComponent(modelId),
  };
}
