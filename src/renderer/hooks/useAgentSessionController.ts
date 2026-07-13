import { useCallback, useEffect, useRef, useState } from "react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentAttachment,
  AgentPermissionMode,
  BrevynAgentRuntimeEvent,
  BrevynAgentSessionRecord,
  BrevynAgentTimelineRecord,
  BrevynTask,
  ModelProviderConfig,
  Thread,
} from "@/types/domain";
import {
  agentRuntimeEventThreadId,
  appendAgentLiveMessage,
  appendAgentRuntimeEvent,
  clearAgentLiveRecords,
  clearAllAgentLiveRecords,
  flushAgentLiveRecords,
  markAgentThreadStatusSeen,
  removeAgentLiveMessage,
  setAgentLiveRunning,
  setAgentThreadListStatus,
} from "@/lib/agent-live-store";
import { cleanAgentErrorMessage, formatAgentUserError } from "../../shared/agent-error-format";

const AGENT_MODEL_STORAGE_PREFIX = "brevyn.agent.modelSelection.";
const AGENT_ERROR_DEDUPE_MS = 2500;

interface UseAgentSessionControllerArgs {
  activeThreadId: string;
  onThreadHasMessages: (threadId: string) => void;
  onThreadUpdated?: (thread: Thread) => void;
  onTaskUpdated?: (task: BrevynTask) => void;
}

export interface AgentProviderSelection {
  providerId?: string;
  modelId?: string;
}

export interface AgentRunForThreadOptions {
  suppressActiveRunError?: boolean;
  displayPrompt?: string;
  skipAutoTitle?: boolean;
}

export function useAgentSessionController({
  activeThreadId,
  onThreadHasMessages,
  onThreadUpdated,
  onTaskUpdated,
}: UseAgentSessionControllerArgs) {
  const mountedRef = useRef(true);
  const activeThreadIdRef = useRef(activeThreadId);
  const agentLoadRequestRef = useRef(0);
  const runningRef = useRef(false);
  const runInFlightByThreadRef = useRef<Set<string>>(new Set());
  const activeRunIdByThreadRef = useRef<Map<string, string>>(new Map());
  const selectedAgentModelRef = useRef("");
  const runModelSelectionByThreadRef = useRef<Map<string, string>>(new Map());
  const onThreadHasMessagesRef = useRef(onThreadHasMessages);
  const onThreadUpdatedRef = useRef(onThreadUpdated);
  const onTaskUpdatedRef = useRef(onTaskUpdated);
  const lastErrorRef = useRef<{ message: string; shownAt: number }>({ message: "", shownAt: 0 });

  const [records, setRecords] = useState<BrevynAgentTimelineRecord[]>([]);
  const [recordsThreadId, setRecordsThreadId] = useState("");
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [providers, setProviders] = useState<ModelProviderConfig[]>([]);
  const [selectedModel, setSelectedModel] = useState("");

  activeThreadIdRef.current = activeThreadId;
  selectedAgentModelRef.current = selectedModel;
  onThreadHasMessagesRef.current = onThreadHasMessages;
  onThreadUpdatedRef.current = onThreadUpdated;
  onTaskUpdatedRef.current = onTaskUpdated;

  const setAgentError = useCallback((value: string) => {
    const message = value ? formatAgentUserError(value) : "";
    if (!message) {
      lastErrorRef.current = { message: "", shownAt: 0 };
      setError("");
      return;
    }
    const now = Date.now();
    if (lastErrorRef.current.message === message && now - lastErrorRef.current.shownAt < AGENT_ERROR_DEDUPE_MS) return;
    lastErrorRef.current = { message, shownAt: now };
    setError(message);
  }, []);

  const loadMessages = useCallback(async (threadId: string, options: { expectedRunId?: string; skipRunStateUpdate?: boolean } = {}): Promise<boolean> => {
    const requestId = agentLoadRequestRef.current + 1;
    agentLoadRequestRef.current = requestId;
    setLoading(true);
    setAgentError("");
    try {
      const nextRecords = await window.brevyn.agent.messages(threadId);
      if (!mountedRef.current || agentLoadRequestRef.current !== requestId || activeThreadIdRef.current !== threadId) return false;
      setRecords(nextRecords);
      setRecordsThreadId(threadId);
      const openRun = hasOpenAgentRun(nextRecords);
      if (openRun) {
        setAgentThreadListStatus(threadId, "running", {
          updatedAtMs: Date.now(),
          seen: threadId === activeThreadIdRef.current,
        });
      }
      if (!options.skipRunStateUpdate && shouldApplyRunStateForLoad(activeRunIdByThreadRef.current, threadId, options.expectedRunId)) {
        runningRef.current = openRun;
        setRunning(openRun);
        setAgentLiveRunning(threadId, openRun);
        if (!openRun) {
          activeRunIdByThreadRef.current.delete(threadId);
          clearAgentLiveRecords(threadId, { preserveStoppedRuns: true });
        }
      }
      return true;
    } catch (loadError) {
      if (mountedRef.current && agentLoadRequestRef.current === requestId) {
        setAgentError(errorMessage(loadError, "Failed to load agent timeline."));
        setRecords([]);
        setRecordsThreadId(threadId);
        if (!options.skipRunStateUpdate && shouldApplyRunStateForLoad(activeRunIdByThreadRef.current, threadId, options.expectedRunId)) {
          activeRunIdByThreadRef.current.delete(threadId);
          runningRef.current = false;
          setRunning(false);
          setAgentLiveRunning(threadId, false);
        }
      }
      return false;
    } finally {
      if (agentLoadRequestRef.current === requestId) setLoading(false);
    }
  }, [setAgentError]);

  const refreshProviders = useCallback(async (preferredSelection?: string) => {
    try {
      const providerList = await window.brevyn.providers.list();
      if (!mountedRef.current) return;
      const agents = providerList.filter((provider) => provider.purpose === "agent");
      setProviders(agents);
      const storedSelection = readStoredAgentModelSelection(activeThreadIdRef.current);
      setSelectedModel((current) => {
        const nextSelection = validAgentModelSelection(agents, preferredSelection || storedSelection || current);
        if (preferredSelection && nextSelection === preferredSelection) writeStoredAgentModelSelection(activeThreadIdRef.current, nextSelection);
        return nextSelection;
      });
    } catch {
      if (mountedRef.current) setProviders([]);
    }
  }, []);

  const selectProvider = useCallback(async (providerSelection: string) => {
    setAgentError("");
    const nextSelection = validAgentModelSelection(providers, providerSelection || selectedAgentModelRef.current);
    setSelectedModel(nextSelection);
    writeStoredAgentModelSelection(activeThreadIdRef.current, nextSelection);
  }, [providers, setAgentError]);

  const runForThread = useCallback(async (
    threadId: string,
    prompt: string,
    permissionMode: AgentPermissionMode = "auto",
    attachments?: AgentAttachment[],
    providerSelection?: AgentProviderSelection,
    mentionedSkills?: string[],
    options?: AgentRunForThreadOptions,
  ): Promise<boolean> => {
    if (!threadId) return false;
    const isActiveThread = threadId === activeThreadIdRef.current;
    if ((isActiveThread && runningRef.current) || runInFlightByThreadRef.current.has(threadId)) return false;
    if (isActiveThread) {
      setAgentError("");
      setRecordsThreadId(threadId);
      runningRef.current = true;
      setRunning(true);
    }
    runInFlightByThreadRef.current.add(threadId);
    setAgentLiveRunning(threadId, true);
    setAgentThreadListStatus(threadId, "running", { updatedAtMs: Date.now(), seen: isActiveThread });
    const runSelection = agentModelSelectionFromProviderSelection(providerSelection) || selectedAgentModelRef.current;
    if (runSelection) runModelSelectionByThreadRef.current.set(threadId, runSelection);
    const userMessageId = createUserMessageId();
    const displayPrompt = options?.displayPrompt?.trim() || prompt;
    activeRunIdByThreadRef.current.set(threadId, `pending:${userMessageId}`);
    appendAgentLiveMessage(threadId, liveUserMessage(displayPrompt, attachments, userMessageId));
    flushAgentLiveRecords(threadId);
    onThreadHasMessagesRef.current(threadId);
    try {
      const result = await window.brevyn.agent.run({
        threadId,
        prompt,
        displayPrompt,
        skipAutoTitle: options?.skipAutoTitle,
        uuid: userMessageId,
        permissionMode,
        attachments,
        providerId: providerSelection?.providerId,
        modelId: providerSelection?.modelId,
        mentionedSkills,
      });
      if (result.runId) activeRunIdByThreadRef.current.set(threadId, result.runId);
      return true;
    } catch (runError) {
      removeAgentLiveMessage(threadId, userMessageId);
      activeRunIdByThreadRef.current.delete(threadId);
      const message = errorMessage(runError, "Failed to start agent run.");
      const runStillActive = isAgentRunStillActiveMessage(message);
      if (isActiveThread) {
        runningRef.current = runStillActive;
        setRunning(runStillActive);
      }
      runInFlightByThreadRef.current.delete(threadId);
      setAgentLiveRunning(threadId, runStillActive);
      setAgentThreadListStatus(threadId, runStillActive ? "running" : "failed", { updatedAtMs: Date.now(), seen: isActiveThread });
      const suppressError = options?.suppressActiveRunError && runStillActive;
      if (isActiveThread && !suppressError) setAgentError(message);
      throw new Error(message);
    } finally {
      runInFlightByThreadRef.current.delete(threadId);
    }
  }, [setAgentError]);

  const run = useCallback(async (
    prompt: string,
    permissionMode: AgentPermissionMode = "auto",
    attachments?: AgentAttachment[],
    providerSelection?: AgentProviderSelection,
    mentionedSkills?: string[],
  ): Promise<void> => {
    const started = await runForThread(activeThreadIdRef.current, prompt, permissionMode, attachments, providerSelection, mentionedSkills);
    if (!started) {
      const message = runningRef.current
        ? "An agent run is already active for this thread."
        : "Agent run did not start.";
      setAgentError(message);
      throw new Error(message);
    }
  }, [runForThread, setAgentError]);

  const stop = useCallback(async (): Promise<void> => {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    try {
      await window.brevyn.agent.stop(threadId);
      runningRef.current = false;
      setRunning(false);
      setAgentLiveRunning(threadId, false);
      flushAgentLiveRecords(threadId);
    } catch (stopError) {
      setAgentError(errorMessage(stopError, "Failed to stop agent run."));
    }
  }, [setAgentError]);

  const approve = useCallback(async (requestId: string): Promise<void> => {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    try {
      await window.brevyn.agent.approve({ threadId, requestId });
    } catch (approveError) {
      setAgentError(errorMessage(approveError, "Failed to approve tool call."));
    }
  }, [setAgentError]);

  const reject = useCallback(async (requestId: string): Promise<void> => {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    try {
      await window.brevyn.agent.reject({ threadId, requestId });
    } catch (rejectError) {
      setAgentError(errorMessage(rejectError, "Failed to deny tool call."));
    }
  }, [setAgentError]);

  const answerQuestion = useCallback(async (requestId: string, answers: Record<string, string>): Promise<void> => {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    try {
      await window.brevyn.agent.answerQuestion({ threadId, requestId, answers });
    } catch (answerError) {
      setAgentError(errorMessage(answerError, "Failed to answer agent question."));
    }
  }, [setAgentError]);

  const resolveExitPlan = useCallback(async (requestId: string, decision: "approve" | "deny", feedback?: string): Promise<void> => {
    const threadId = activeThreadIdRef.current;
    if (!threadId) return;
    try {
      await window.brevyn.agent.resolveExitPlan({ threadId, requestId, decision, feedback });
    } catch (resolveError) {
      setAgentError(errorMessage(resolveError, "Failed to resolve plan request."));
    }
  }, [setAgentError]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runInFlightByThreadRef.current.clear();
      activeRunIdByThreadRef.current.clear();
      clearAllAgentLiveRecords();
    };
  }, []);

  useEffect(() => {
    const unsubscribe = window.brevyn.agent.onEvent((event) => {
      if (event.kind === "thread_updated") {
        onThreadUpdatedRef.current?.(event.thread);
        return;
      }
      if (event.kind === "task_updated") {
        onTaskUpdatedRef.current?.(event.task);
        return;
      }
      const eventThreadId = event.kind === "sdk_message" ? event.threadId : agentRuntimeEventThreadId(event.event);
      if (!eventThreadId) return;

      if (event.kind === "sdk_message") {
        const appended = appendAgentLiveMessage(eventThreadId, event.message, { modelId: modelIdFromSelection(runModelSelectionByThreadRef.current.get(eventThreadId) || selectedAgentModelRef.current) });
        if (event.message.type === "result") {
          const resultStatus = threadListStatusFromResultMessage(event.message);
          setAgentThreadListStatus(eventThreadId, resultStatus, { updatedAtMs: Date.now(), seen: eventThreadId === activeThreadIdRef.current });
          setAgentLiveRunning(eventThreadId, false);
          flushAgentLiveRecords(eventThreadId);
        }
        if (!appended) return;
        if (isLiveStreamEventMessage(event.message)) return;

        onThreadHasMessagesRef.current(eventThreadId);
        if (event.message.type === "result" && eventThreadId === activeThreadIdRef.current) {
          void loadMessages(eventThreadId, { skipRunStateUpdate: true });
          const subtype = String((event.message as { subtype?: unknown }).subtype || "");
          if (subtype && subtype !== "success" && subtype !== "stopped_by_user" && subtype !== "interrupted") {
            setAgentError(resultErrorMessage(event.message));
          }
        }
        return;
      }

      if (event.event.type === "run_started") {
        activeRunIdByThreadRef.current.set(eventThreadId, event.event.runId);
        const runSelection = agentModelSelectionFromProviderSelection({ providerId: event.event.providerId, modelId: event.event.modelId });
        if (runSelection) runModelSelectionByThreadRef.current.set(eventThreadId, runSelection);
      } else if (isTerminalRuntimeEvent(event.event)) {
        const shouldApplyTerminalState = shouldApplyRunStateForRunId(activeRunIdByThreadRef.current, eventThreadId, event.event.runId);
        if (shouldApplyTerminalState) {
          activeRunIdByThreadRef.current.delete(eventThreadId);
          runModelSelectionByThreadRef.current.delete(eventThreadId);
          runInFlightByThreadRef.current.delete(eventThreadId);
          setAgentLiveRunning(eventThreadId, false);
          flushAgentLiveRecords(eventThreadId);
        }
      }

      appendAgentRuntimeEvent(event.event);
      if (eventThreadId !== activeThreadIdRef.current) return;
      if (event.event.type === "run_started") {
        runInFlightByThreadRef.current.delete(eventThreadId);
        runningRef.current = true;
        setRunning(true);
        setAgentError("");
      } else if (isTerminalRuntimeEvent(event.event)) {
        if (!shouldApplyRunStateForRunId(activeRunIdByThreadRef.current, eventThreadId, event.event.runId) && activeRunIdByThreadRef.current.has(eventThreadId)) return;
        activeRunIdByThreadRef.current.delete(eventThreadId);
        runInFlightByThreadRef.current.delete(eventThreadId);
        runningRef.current = false;
        setRunning(false);
        setAgentLiveRunning(eventThreadId, false);
        markAgentThreadStatusSeen(eventThreadId);
        flushAgentLiveRecords(eventThreadId);
        if (event.event.type === "run_failed") setAgentError(event.event.error);
      }
    });
    return unsubscribe;
  }, [loadMessages, setAgentError]);

  useEffect(() => {
    if (!activeThreadId) {
      setSelectedModel("");
      return;
    }
    setSelectedModel(validAgentModelSelection(providers, readStoredAgentModelSelection(activeThreadId)));
  }, [activeThreadId, providers]);

  useEffect(() => {
    if (!activeThreadId) {
      agentLoadRequestRef.current += 1;
      setRecords([]);
      setRecordsThreadId("");
      setLoading(false);
      runningRef.current = false;
      setRunning(false);
      setAgentError("");
      return;
    }
    void loadMessages(activeThreadId);
  }, [activeThreadId, loadMessages, setAgentError]);

  return {
    records: recordsThreadId === activeThreadId ? records : [],
    loading: loading || recordsThreadId !== activeThreadId,
    running,
    error,
    providers,
    selectedProviderId: validAgentModelSelection(providers, selectedModel),
    refreshProviders,
    selectProvider,
    run,
    runForThread,
    stop,
    approve,
    reject,
    answerQuestion,
    resolveExitPlan,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  const message = cleanAgentErrorMessage(raw);
  return formatAgentUserError(message || fallback);
}

function isAgentRunStillActiveMessage(message: string): boolean {
  return message.includes("An agent run is already active for this thread") ||
    message.includes("当前会话已有任务正在运行");
}

function resultErrorMessage(message: BrevynAgentSessionRecord): string {
  const errors = (message as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    const first = errors.find((item) => typeof item === "string" && item.trim());
    if (typeof first === "string") return first;
  }
  const result = (message as { result?: unknown }).result;
  if (typeof result === "string" && result.trim()) return result;
  return "Agent run failed.";
}

function threadListStatusFromResultMessage(message: BrevynAgentSessionRecord): "completed" | "failed" | "stopped" | "interrupted" {
  const subtype = String((message as { subtype?: unknown }).subtype || "");
  if (subtype === "success" || !subtype) return "completed";
  if (subtype === "stopped_by_user") return "stopped";
  if (subtype === "interrupted") return "interrupted";
  return "failed";
}

function isLiveStreamEventMessage(message: BrevynAgentTimelineRecord): boolean {
  if ((message as { type?: unknown }).type !== "stream_event") return false;
  const event = (message as { event?: unknown }).event;
  if (!event || typeof event !== "object") return false;
  const type = (event as { type?: unknown }).type;
  return type === "content_block_delta" || type === "content_block_start" || type === "content_block_stop";
}

function isTerminalRunEvent(type: string): boolean {
  return type === "run_completed" || type === "run_stopped" || type === "run_failed" || type === "run_interrupted";
}

function isTerminalRuntimeEvent(event: BrevynAgentRuntimeEvent): event is Extract<BrevynAgentRuntimeEvent, { type: "run_completed" | "run_stopped" | "run_failed" | "run_interrupted" }> {
  return isTerminalRunEvent(event.type);
}

function shouldApplyRunStateForLoad(activeRunIds: Map<string, string>, threadId: string, expectedRunId?: string): boolean {
  if (!expectedRunId) return true;
  return shouldApplyRunStateForRunId(activeRunIds, threadId, expectedRunId);
}

function shouldApplyRunStateForRunId(activeRunIds: Map<string, string>, threadId: string, runId: string): boolean {
  const activeRunId = activeRunIds.get(threadId);
  return !activeRunId || activeRunId === runId;
}

function hasOpenAgentRun(records: BrevynAgentTimelineRecord[]): boolean {
  const terminalRunIds = new Set<string>();
  for (const record of records) {
    if (!isAgentRuntimeRecord(record)) continue;
    if (isTerminalRunEvent(record.event.type) && "runId" in record.event) terminalRunIds.add(record.event.runId);
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || !isAgentRuntimeRecord(record)) continue;
    if (record.event.type === "run_started" && !terminalRunIds.has(record.event.runId)) return true;
  }
  return false;
}

function isAgentRuntimeRecord(record: BrevynAgentTimelineRecord): record is Extract<BrevynAgentTimelineRecord, { kind: "runtime" }> {
  return Boolean(record && typeof record === "object" && "kind" in record && record.kind === "runtime");
}

function validAgentModelSelection(providers: ModelProviderConfig[], current: string): string {
  const options = agentModelSelectionOptions(providers);
  if (options.some((option) => option === current)) return current;
  return options[0] || "";
}

function agentModelSelectionOptions(providers: ModelProviderConfig[]): string[] {
  return providers
    .filter((provider) => provider.enabled)
    .flatMap((provider) => {
      const models = provider.models.filter((model) => model.enabled !== false);
      const selectedFirst = [
        ...models.filter((model) => model.id === provider.selectedModel),
        ...models.filter((model) => model.id !== provider.selectedModel),
      ];
      return selectedFirst.map((model) => agentModelSelectionValue(provider.id, model.id));
    });
}

function agentModelSelectionValue(providerId: string, modelId: string): string {
  return `${encodeURIComponent(providerId)}::${encodeURIComponent(modelId)}`;
}

function agentModelSelectionFromProviderSelection(selection?: AgentProviderSelection): string {
  if (!selection?.providerId || !selection.modelId) return "";
  return agentModelSelectionValue(selection.providerId, selection.modelId);
}

function modelIdFromSelection(value: string): string | undefined {
  const [, modelId] = value.split("::");
  return modelId ? decodeURIComponent(modelId) : undefined;
}

function readStoredAgentModelSelection(threadId: string): string {
  if (!threadId) return "";
  try {
    return window.localStorage.getItem(`${AGENT_MODEL_STORAGE_PREFIX}${threadId}`) || "";
  } catch {
    return "";
  }
}

function writeStoredAgentModelSelection(threadId: string, selection: string): void {
  if (!threadId || !selection) return;
  try {
    window.localStorage.setItem(`${AGENT_MODEL_STORAGE_PREFIX}${threadId}`, selection);
  } catch {
    // Model selection is a UI preference; provider defaults remain the fallback.
  }
}

function createUserMessageId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ? `msg_${randomId}` : `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function liveUserMessage(prompt: string, attachments: AgentAttachment[] | undefined, uuid: string): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: prompt,
    },
    ...(attachments && attachments.length > 0 ? { _attachments: attachments } : {}),
    parent_tool_use_id: null,
    uuid,
    session_id: "",
    _createdAt: Date.now(),
  } as unknown as SDKMessage;
}
