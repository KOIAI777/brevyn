import type { AgentAttachment, AgentPermissionMode, BrevynAgentTimelineRecord, ModelProviderConfig, Thread } from "@/types/domain";
import { useAgentAutoCompactState } from "@/components/agent/useAgentAutoCompactState";
import { useAgentPanelPreferencesState } from "@/components/agent/useAgentPanelPreferencesState";
import { useAgentQueueState } from "@/components/agent/useAgentQueueState";
import { useAgentTimelineState } from "@/components/agent/useAgentTimelineState";
import { parseProviderModelValue } from "@/components/agent/AgentProviderPicker";
import type { AgentTimelineRecord, AgentTodoItem, ContextUsage, RunSummary } from "@/components/agent/agentTimelineModel";
import type { QueuedAgentMessage } from "@/components/agent/agentComposerTypes";
import type { AgentRunForThreadOptions } from "@/hooks/useAgentSessionController";

export interface AgentThreadPanelState {
  permissionMode: AgentPermissionMode;
  timelineRecords: AgentTimelineRecord[];
  timelineGroups: ReturnType<typeof useAgentTimelineState>["timelineGroups"];
  runSummary: RunSummary | null;
  todos: AgentTodoItem[];
  contextUsage: ContextUsage | null;
  effectiveRunning: boolean;
  effectiveCompacting: boolean;
  queuedMessages: QueuedAgentMessage[];
  sendingQueuedMessageIds: string[];
  queueToastMessage: string;
  autoCompactThresholdPercent: number;
  scrollTransitioning: boolean;
  setPermissionMode: (mode: AgentPermissionMode) => void;
  handleCompact: () => Promise<void>;
  queueMessage: (message: QueuedAgentMessage) => void;
  deleteQueuedMessage: (messageId: string) => void;
  sendQueuedMessage: (messageId: string) => Promise<void>;
  toggleProcessCollapsed: (key: string, defaultCollapsed: boolean, lockedOpen: boolean) => void;
}

interface UseAgentThreadPanelStateArgs {
  thread: Thread;
  records: BrevynAgentTimelineRecord[];
  loading: boolean;
  running: boolean;
  error?: string;
  agentProviders: ModelProviderConfig[];
  activeProviderId: string;
  onRun: (prompt: string, permissionMode?: AgentPermissionMode, attachments?: AgentAttachment[], providerSelection?: { providerId?: string; modelId?: string }, mentionedSkills?: string[]) => Promise<void>;
  onRunForThread: (threadId: string, prompt: string, permissionMode?: AgentPermissionMode, attachments?: AgentAttachment[], providerSelection?: { providerId?: string; modelId?: string }, mentionedSkills?: string[], options?: AgentRunForThreadOptions) => Promise<boolean>;
  onAutoQueuedRunStarted?: (threadId: string) => void;
}

export function useAgentThreadPanelState({
  thread,
  records,
  loading,
  running,
  error,
  agentProviders,
  activeProviderId,
  onRun,
  onRunForThread,
  onAutoQueuedRunStarted,
}: UseAgentThreadPanelStateArgs): AgentThreadPanelState {
  const timelineState = useAgentTimelineState({
    thread,
    records,
    running,
    agentProviders,
    activeProviderId,
    onRun,
  });
  const preferencesState = useAgentPanelPreferencesState(thread.id);
  const queueState = useAgentQueueState({
    threadId: thread.id,
    effectiveRunning: timelineState.effectiveRunning,
    runSummary: timelineState.runSummary,
    currentPermissionMode: preferencesState.permissionMode,
    currentProviderSelection: parseProviderModelValue(activeProviderId),
    onRunForThread,
    onAutoRunStarted: onAutoQueuedRunStarted,
  });

  useAgentAutoCompactState({
    threadId: thread.id,
    records,
    queuedMessageCount: queueState.queuedMessages.length,
    loading,
    error,
    activeProvider: timelineState.activeProvider,
    contextUsage: timelineState.contextUsage,
    effectiveRunning: timelineState.effectiveRunning,
    effectiveCompacting: timelineState.effectiveCompacting,
    handleCompact: timelineState.handleCompact,
  });

  return {
    ...preferencesState,
    ...timelineState,
    ...queueState,
  };
}
