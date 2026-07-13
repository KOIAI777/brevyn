import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentAttachment, AgentPermissionMode, BrevynAgentEvent } from "@/types/domain";
import type { QueuedAgentMessage } from "@/components/agent/agentComposerTypes";
import type { RunSummary } from "@/components/agent/agentTimelineModel";
import { agentRuntimeEventThreadId } from "@/lib/agent-live-store";
import type { AgentRunForThreadOptions } from "@/hooks/useAgentSessionController";

export interface AgentQueueState {
  queuedMessages: QueuedAgentMessage[];
  sendingQueuedMessageIds: string[];
  queueToastMessage: string;
  queueMessage: (message: QueuedAgentMessage) => void;
  deleteQueuedMessage: (messageId: string) => void;
  sendQueuedMessage: (messageId: string) => Promise<void>;
}

export function useAgentQueueState({
  threadId,
  effectiveRunning,
  runSummary,
  currentPermissionMode,
  currentProviderSelection,
  onRunForThread,
  onAutoRunStarted,
}: {
  threadId: string;
  effectiveRunning: boolean;
  runSummary: RunSummary | null;
  currentPermissionMode: AgentPermissionMode;
  currentProviderSelection?: { providerId?: string; modelId?: string };
  onRunForThread: (threadId: string, prompt: string, permissionMode?: AgentPermissionMode, attachments?: AgentAttachment[], providerSelection?: { providerId?: string; modelId?: string }, mentionedSkills?: string[], options?: AgentRunForThreadOptions) => Promise<boolean>;
  onAutoRunStarted?: (threadId: string) => void;
}): AgentQueueState {
  const queuedMessagesRef = useRef<QueuedAgentMessage[]>([]);
  const queuedMessagesByThreadRef = useRef<Record<string, QueuedAgentMessage[]>>({});
  const sendingQueuedMessageIdsByThreadRef = useRef<Record<string, string[]>>({});
  const wasRunningRef = useRef(false);
  const lastAutoSentRunIdRef = useRef("");
  const lastAutoSentRunIdByThreadRef = useRef<Record<string, string>>({});
  const autoSendInFlightRunIdByThreadRef = useRef<Record<string, string>>({});
  const autoSendTimerRef = useRef<number | null>(null);
  const autoSendTimersByThreadRef = useRef<Record<string, number>>({});
  const queueToastTimerRef = useRef<number | null>(null);
  const threadIdRef = useRef(threadId);
  const currentPermissionModeRef = useRef(currentPermissionMode);
  const currentProviderSelectionRef = useRef(currentProviderSelection);
  const [queuedMessagesByThread, setQueuedMessagesByThread] = useState<Record<string, QueuedAgentMessage[]>>({});
  const [sendingQueuedMessageIdsByThread, setSendingQueuedMessageIdsByThread] = useState<Record<string, string[]>>({});
  const [queueToastMessage, setQueueToastMessage] = useState("");

  const queuedMessages = queuedMessagesByThread[threadId] || [];
  const sendingQueuedMessageIds = sendingQueuedMessageIdsByThread[threadId] || [];
  threadIdRef.current = threadId;

  useEffect(() => {
    queuedMessagesRef.current = queuedMessages;
  }, [queuedMessages]);

  useEffect(() => {
    queuedMessagesByThreadRef.current = queuedMessagesByThread;
  }, [queuedMessagesByThread]);

  useEffect(() => {
    sendingQueuedMessageIdsByThreadRef.current = sendingQueuedMessageIdsByThread;
  }, [sendingQueuedMessageIdsByThread]);

  useEffect(() => {
    currentPermissionModeRef.current = currentPermissionMode;
    currentProviderSelectionRef.current = currentProviderSelection;
  }, [currentPermissionMode, currentProviderSelection]);

  useEffect(() => {
    lastAutoSentRunIdRef.current = "";
    wasRunningRef.current = effectiveRunning;
  }, [threadId]);

  useEffect(() => {
    const unsubscribe = window.brevyn.agent.onEvent((event) => {
      const completed = completedRunEvent(event);
      if (!completed) return;
      scheduleQueuedMessageAsNewRun(completed.threadId, completed.runId, "event");
    });
    return () => {
      unsubscribe();
      for (const timer of Object.values(autoSendTimersByThreadRef.current)) {
        window.clearTimeout(timer);
      }
      autoSendTimersByThreadRef.current = {};
      if (queueToastTimerRef.current !== null) {
        window.clearTimeout(queueToastTimerRef.current);
        queueToastTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = effectiveRunning;
    if (!wasRunning || effectiveRunning) return;
    if (runSummary?.status !== "completed" || !runSummary.runId) return;
    if (lastAutoSentRunIdRef.current === runSummary.runId) return;
    if (lastAutoSentRunIdByThreadRef.current[threadId] === runSummary.runId) return;
    const nextMessage = queuedMessagesRef.current[0];
    if (!nextMessage) return;
    if (autoSendTimerRef.current !== null) window.clearTimeout(autoSendTimerRef.current);
    autoSendTimerRef.current = window.setTimeout(() => {
      autoSendTimerRef.current = null;
      if (lastAutoSentRunIdRef.current === runSummary.runId) return;
      if (lastAutoSentRunIdByThreadRef.current[threadId] === runSummary.runId) return;
      const queuedMessage = queuedMessagesRef.current[0];
      if (!queuedMessage) return;
      if (!beginAutoSend(threadId, runSummary.runId)) return;
      void sendQueuedMessageAsNewRun(threadId, queuedMessage, "auto").then((started) => {
        finishAutoSend(threadId, runSummary.runId, started);
      });
    }, 180);
    return () => {
      if (autoSendTimerRef.current !== null) {
        window.clearTimeout(autoSendTimerRef.current);
        autoSendTimerRef.current = null;
      }
    };
  }, [effectiveRunning, runSummary?.runId, runSummary?.status]);

  function scheduleQueuedMessageAsNewRun(targetThreadId: string, completedRunId: string, source: "event"): void {
    if (!targetThreadId || !completedRunId) return;
    if (lastAutoSentRunIdByThreadRef.current[targetThreadId] === completedRunId) return;
    const existingTimer = autoSendTimersByThreadRef.current[targetThreadId];
    if (existingTimer !== undefined) window.clearTimeout(existingTimer);
    autoSendTimersByThreadRef.current = {
      ...autoSendTimersByThreadRef.current,
      [targetThreadId]: window.setTimeout(() => {
        const { [targetThreadId]: _timer, ...rest } = autoSendTimersByThreadRef.current;
        autoSendTimersByThreadRef.current = rest;
        if (lastAutoSentRunIdByThreadRef.current[targetThreadId] === completedRunId) return;
        const queuedMessage = queuedMessagesByThreadRef.current[targetThreadId]?.[0];
        if (!queuedMessage) return;
        if (!beginAutoSend(targetThreadId, completedRunId)) return;
        void sendQueuedMessageAsNewRun(targetThreadId, queuedMessage, "auto").then((started) => {
          finishAutoSend(targetThreadId, completedRunId, started);
        });
      }, source === "event" ? 220 : 180),
    };
  }

  function beginAutoSend(targetThreadId: string, completedRunId: string): boolean {
    if (lastAutoSentRunIdByThreadRef.current[targetThreadId] === completedRunId) return false;
    if (autoSendInFlightRunIdByThreadRef.current[targetThreadId] === completedRunId) return false;
    autoSendInFlightRunIdByThreadRef.current = {
      ...autoSendInFlightRunIdByThreadRef.current,
      [targetThreadId]: completedRunId,
    };
    return true;
  }

  function finishAutoSend(targetThreadId: string, completedRunId: string, started: boolean): void {
    const { [targetThreadId]: _inFlightRunId, ...rest } = autoSendInFlightRunIdByThreadRef.current;
    autoSendInFlightRunIdByThreadRef.current = rest;
    if (!started) return;
    lastAutoSentRunIdByThreadRef.current = {
      ...lastAutoSentRunIdByThreadRef.current,
      [targetThreadId]: completedRunId,
    };
    if (targetThreadId === threadIdRef.current) lastAutoSentRunIdRef.current = completedRunId;
  }

  function showQueueToast(message: string): void {
    if (queueToastTimerRef.current !== null) {
      window.clearTimeout(queueToastTimerRef.current);
      queueToastTimerRef.current = null;
    }
    setQueueToastMessage(message);
    queueToastTimerRef.current = window.setTimeout(() => {
      setQueueToastMessage("");
      queueToastTimerRef.current = null;
    }, 3800);
  }

  const queueMessage = useCallback((message: QueuedAgentMessage) => {
    setQueuedMessagesByThread((current) => ({
      ...current,
      [threadId]: [...(current[threadId] || []), message],
    }));
  }, [threadId]);

  const deleteQueuedMessage = useCallback((messageId: string) => {
    setQueuedMessagesByThread((current) => ({
      ...current,
      [threadId]: (current[threadId] || []).filter((message) => message.id !== messageId),
    }));
  }, [threadId]);

  function setQueuedMessageSending(targetThreadId: string, messageId: string, sending: boolean) {
    setSendingQueuedMessageIdsByThread((current) => {
      const currentIds = current[targetThreadId] || [];
      const nextIds = sending
        ? Array.from(new Set([...currentIds, messageId]))
        : currentIds.filter((id) => id !== messageId);
      return { ...current, [targetThreadId]: nextIds };
    });
  }

  function removeQueuedMessage(targetThreadId: string, messageId: string): QueuedAgentMessage | null {
    const currentQueue = queuedMessagesByThreadRef.current[targetThreadId] || [];
    const message = currentQueue.find((item) => item.id === messageId) || null;
    if (!message) return null;
    setQueuedMessagesByThread((current) => ({
      ...current,
      [targetThreadId]: (current[targetThreadId] || []).filter((item) => item.id !== messageId),
    }));
    return message;
  }

  async function sendQueuedMessageAsNewRun(targetThreadId: string, message: QueuedAgentMessage, source: "manual" | "auto", options: { ignoreSendingGuard?: boolean; finalizingFallback?: boolean } = {}): Promise<boolean> {
    if (!options.ignoreSendingGuard && sendingQueuedMessageIdsByThreadRef.current[targetThreadId]?.includes(message.id)) return false;
    setQueuedMessageSending(targetThreadId, message.id, true);
    try {
      const maxAttempts = source === "auto" ? 5 : options.finalizingFallback ? 4 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const started = await onRunForThread(
            targetThreadId,
            message.prompt,
            message.permissionMode ?? currentPermissionModeRef.current,
            undefined,
            message.providerSelection ?? currentProviderSelectionRef.current,
            message.mentionedSkills,
            { suppressActiveRunError: (source === "auto" || options.finalizingFallback) && attempt < maxAttempts },
          );
          if (!started) {
            if ((source === "auto" || options.finalizingFallback) && attempt < maxAttempts) {
              await delay(300 + attempt * 180);
              continue;
            }
            if (source === "auto" && targetThreadId === threadIdRef.current) {
              showQueueToast("待确认消息暂时没有发出，已保留在队列中。");
            } else if (options.finalizingFallback && targetThreadId === threadIdRef.current) {
              showQueueToast("上一轮正在收尾，待确认消息稍后自动发送。");
            }
            return false;
          }
          if (started) removeQueuedMessage(targetThreadId, message.id);
          if (started && source === "auto") onAutoRunStarted?.(targetThreadId);
          return started;
        } catch (error) {
          if ((source === "auto" || options.finalizingFallback) && isAgentRunStillActiveError(error) && attempt < maxAttempts) {
            await delay(300 + attempt * 180);
            continue;
          }
          throw error;
        }
      }
      return false;
    } catch (error) {
      if (options.finalizingFallback && isAgentRunStillActiveError(error)) {
        if (targetThreadId === threadIdRef.current) showQueueToast("上一轮正在收尾，待确认消息稍后自动发送。");
        return false;
      }
      console.error(source === "auto" ? "[AgentThreadPanel] Failed to auto-send queued message:" : "[AgentThreadPanel] Failed to start queued message:", error);
      if (targetThreadId === threadIdRef.current) {
        showQueueToast(source === "auto" ? "待确认消息自动发送失败，已保留在队列中。" : "待确认消息发送失败，请稍后再试。");
      }
      return false;
    } finally {
      setQueuedMessageSending(targetThreadId, message.id, false);
    }
  }

  const sendQueuedMessage = useCallback(async (messageId: string) => {
    const message = queuedMessagesRef.current.find((item) => item.id === messageId);
    if (!message) return;
    if (sendingQueuedMessageIdsByThread[threadId]?.includes(messageId)) return;
    if (effectiveRunning) {
      setQueuedMessageSending(threadId, messageId, true);
      try {
        await window.brevyn.agent.queueMessage({
          threadId,
          prompt: message.prompt,
          uuid: message.id,
          interrupt: true,
          mentionedSkills: message.mentionedSkills,
        });
        removeQueuedMessage(threadId, messageId);
      } catch (error) {
        if (isQueueMessageNoLongerActiveError(error)) {
          showQueueToast("上一轮正在收尾，正在作为下一轮发送。");
          await sendQueuedMessageAsNewRun(threadId, message, "manual", { ignoreSendingGuard: true, finalizingFallback: true });
          return;
        }
        console.error("[AgentThreadPanel] Failed to send queued message:", error);
        showQueueToast("待确认消息发送失败，请稍后再试。");
      } finally {
        setQueuedMessageSending(threadId, messageId, false);
      }
      return;
    }
    await sendQueuedMessageAsNewRun(threadId, message, "manual");
  }, [effectiveRunning, sendingQueuedMessageIdsByThread, threadId]);

  return {
    queuedMessages,
    sendingQueuedMessageIds,
    queueToastMessage,
    queueMessage,
    deleteQueuedMessage,
    sendQueuedMessage,
  };
}

function completedRunEvent(event: BrevynAgentEvent): { threadId: string; runId: string } | null {
  if (event.kind !== "brevyn_event" || event.event.type !== "run_completed") return null;
  const threadId = agentRuntimeEventThreadId(event.event);
  return threadId && event.event.runId ? { threadId, runId: event.event.runId } : null;
}

function isAgentRunStillActiveError(error: unknown): boolean {
  const message = errorText(error);
  return message.includes("An agent run is already active for this thread") ||
    message.includes("当前会话已有任务正在运行");
}

function isQueueMessageNoLongerActiveError(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return message.includes("no active claude sdk input channel is available") ||
    message.includes("no active agent run is available") ||
    message.includes("claude sdk query is already closed") ||
    message.includes("query closed before response received") ||
    message.includes("query is closed") ||
    message.includes("query already closed") ||
    message.includes("start a new run instead");
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error || "");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
