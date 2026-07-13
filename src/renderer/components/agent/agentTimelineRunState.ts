import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentPermissionMode } from "@/types/domain";
import { recordCreatedAtMs } from "@/lib/agent-timeline-identity";
import {
  assistantBlocks,
  assistantText,
  isUserInputMessage,
  isRuntimeRecord,
  isStreamEventRecord,
  latestTurnBounds,
  recordKey,
  streamThinkingDelta,
  streamTextDelta,
  thinkingTextForMessage,
  toolResultBlocks,
  userText,
  type AgentTimelineRecord,
  type RunSummary,
} from "@/components/agent/agentTimelineModel";
import { stringValue } from "@/components/agent/tool-cards/toolModel";
import { formatAgentUserError } from "../../../shared/agent-error-format";

export function processStateKey(summary: RunSummary | null, userIndex: number | undefined, records: AgentTimelineRecord[], recordIndex: number): string {
  if (summary?.runId) return `run-${summary.runId}`;
  if (userIndex !== undefined && records[userIndex]) return `turn-${recordKey(records[userIndex])}`;
  const record = records[recordIndex];
  if (record) return `record-${recordKey(record)}`;
  return `record-${recordIndex}`;
}

export function latestRunSummary(records: AgentTimelineRecord[], nowMs: number, active: boolean): RunSummary | null {
  const bounds = latestTurnBounds(records);
  if (!bounds) return active ? { runId: "active", label: "Thinking", running: true, status: "running" } : null;

  return runSummaryForUserIndex(records, bounds.userIndex, nowMs, active);
}

export function runSummaryForUserIndex(records: AgentTimelineRecord[], userIndex: number, nowMs: number, active: boolean): RunSummary | null {
  const user = records[userIndex];
  if (!user || isRuntimeRecord(user) || (user as SDKMessage).type !== "user") return null;
  const result = resultForUserIndex(records, userIndex);
  const runStart = latestRunStart(records, userIndex);
  const lifecycle = latestRunLifecycle(records, userIndex);
  const retry = latestRunRetry(records, userIndex);
  const latestBounds = latestTurnBounds(records);
  const isLatestTurn = latestBounds?.userIndex === userIndex;
  const startMs = recordCreatedAtMs(user) ?? nowMs;
  const finishMs = lifecycle?.createdAtMs ?? (result.record ? recordCreatedAtMs(result.record) ?? nowMs : nowMs);
  const running = !lifecycle && !result.record && active && isLatestTurn;
  const runId = runStart?.runId || stringValue((user as { uuid?: unknown }).uuid, `turn-${userIndex}`);
  const permissionMode = runStart?.permissionMode;
  const elapsedMs = Math.max(0, finishMs - startMs);
  const duration = formatDuration(elapsedMs);
  const resultSubtype = result.record ? String((result.record as { subtype?: unknown }).subtype || "") : "";
  const status = lifecycle?.status ?? statusFromResultSubtype(resultSubtype, running);
  const detail = normalizedRunDetail(lifecycle?.detail ?? resultDetail(result.record));
  const hasActivity = eventsSinceStart(records, userIndex);
  if (status === "running") {
    if (retry) {
      return {
        runId,
        label: retryRunLabel(retry, nowMs),
        running: true,
        status,
        permissionMode,
        detail: formatAgentUserError(retry.reason),
        startedAtMs: startMs,
        hasActivity,
        retryAttempt: retry.retryAttempt,
        retryMaxRetries: retry.maxRetries,
        retryUntilMs: retry.createdAtMs + retry.delayMs,
      };
    }
    const showProcessed = elapsedMs >= 1000 && hasActivity;
    return { runId, label: showProcessed ? `已处理 ${duration}` : "Thinking", running: true, status, permissionMode, startedAtMs: startMs, hasActivity };
  }
  if (status === "stopped") return { runId, label: `已停止 · ${duration}`, running: false, status, permissionMode, detail, startedAtMs: startMs, finishedAtMs: finishMs, hasActivity };
  if (status === "failed") return { runId, label: `运行失败 · ${duration}`, running: false, status, permissionMode, detail, startedAtMs: startMs, finishedAtMs: finishMs, hasActivity };
  if (status === "interrupted") return { runId, label: `已中断 · ${duration}`, running: false, status, permissionMode, detail, startedAtMs: startMs, finishedAtMs: finishMs, hasActivity };
  return { runId, label: `已处理 ${duration}`, running: false, status: "completed", permissionMode, detail, startedAtMs: startMs, finishedAtMs: finishMs, hasActivity };
}

export function latestAssistantTextIndex(records: AgentTimelineRecord[]): number | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || isRuntimeRecord(record) || isStreamEventRecord(record)) continue;
    if ((record as SDKMessage).type === "assistant" && assistantText(record as SDKMessage).trim()) return index;
  }
  return undefined;
}

export function hasRenderableAssistantContent(records: AgentTimelineRecord[]): boolean {
  return records.some((record) => {
    if (!record || isRuntimeRecord(record)) return false;
    if (isStreamEventRecord(record)) return Boolean(streamTextDelta(record).trim() || streamThinkingDelta(record).trim());
    if ((record as SDKMessage).type !== "assistant") return false;
    const message = record as SDKMessage;
    if (thinkingTextForMessage(message)) return true;
    return assistantBlocks(message).some((block) => {
      if (block.type === "text") return block.text.trim().length > 0;
      return block.name !== "TodoWrite";
    });
  });
}

export function ownerUserInputIndexes(records: AgentTimelineRecord[]): number[] {
  const owners: number[] = [];
  let currentOwner = -1;
  for (let index = 0; index < records.length; index += 1) {
    owners[index] = currentOwner;
    const record = records[index];
    if (!record || isRuntimeRecord(record) || (record as SDKMessage).type !== "user") continue;
    if (!isUserInputMessage(record as SDKMessage)) continue;
    currentOwner = index;
  }
  return owners;
}

function resultForUserIndex(records: AgentTimelineRecord[], userIndex: number): { record?: SDKMessage; index?: number } {
  const nextUserIndex = nextUserInputIndex(records, userIndex);
  const endIndex = nextUserIndex ?? records.length;
  for (let index = userIndex + 1; index < endIndex; index += 1) {
    const record = records[index];
    if (!record || isRuntimeRecord(record) || isStreamEventRecord(record)) continue;
    if ((record as SDKMessage).type === "result") return { record: record as SDKMessage, index };
  }
  return {};
}

function nextUserInputIndex(records: AgentTimelineRecord[], afterIndex: number): number | undefined {
  for (let index = afterIndex + 1; index < records.length; index += 1) {
    const record = records[index];
    if (!record || isRuntimeRecord(record) || isStreamEventRecord(record)) continue;
    if ((record as SDKMessage).type === "user" && isUserInputMessage(record as SDKMessage)) return index;
  }
  return undefined;
}

function latestRunStart(records: AgentTimelineRecord[], userIndex: number): { runId: string; permissionMode?: AgentPermissionMode } | null {
  const endIndex = nextUserInputIndex(records, userIndex) ?? records.length;
  for (let index = userIndex; index < endIndex; index += 1) {
    const record = records[index];
    if (!record || !isRuntimeRecord(record) || record.event.type !== "run_started") continue;
    return { runId: record.event.runId, permissionMode: record.event.permissionMode };
  }
  return null;
}

function latestRunLifecycle(records: AgentTimelineRecord[], userIndex: number): { status: RunSummary["status"]; detail?: string; createdAtMs?: number } | null {
  let runId = "";
  let runStartIndex = -1;
  const endIndex = nextUserInputIndex(records, userIndex) ?? records.length;
  for (let index = userIndex; index < endIndex; index += 1) {
    const record = records[index];
    if (!record || !isRuntimeRecord(record) || record.event.type !== "run_started") continue;
    runId = record.event.runId;
    runStartIndex = index;
    break;
  }
  if (!runId) return null;

  for (let index = runStartIndex + 1; index < endIndex; index += 1) {
    const record = records[index];
    if (!record || !isRuntimeRecord(record) || !("runId" in record.event) || record.event.runId !== runId) continue;
    if (record.event.type === "run_completed") return { status: "completed", createdAtMs: recordCreatedAtMs(record) };
    if (record.event.type === "run_stopped") return { status: "stopped", detail: record.event.reason, createdAtMs: recordCreatedAtMs(record) };
    if (record.event.type === "run_failed") return { status: "failed", detail: record.event.error, createdAtMs: recordCreatedAtMs(record) };
    if (record.event.type === "run_interrupted") return { status: "interrupted", detail: record.event.reason, createdAtMs: recordCreatedAtMs(record) };
  }
  return null;
}

function latestRunRetry(records: AgentTimelineRecord[], userIndex: number): { retryAttempt: number; maxRetries: number; reason: string; delayMs: number; createdAtMs: number } | null {
  const runStart = latestRunStart(records, userIndex);
  if (!runStart) return null;
  const endIndex = nextUserInputIndex(records, userIndex) ?? records.length;
  let latest: { retryAttempt: number; maxRetries: number; reason: string; delayMs: number; createdAtMs: number } | null = null;
  for (let index = userIndex + 1; index < endIndex; index += 1) {
    const record = records[index];
    if (!record || !isRuntimeRecord(record) || record.event.type !== "run_retrying" || record.event.runId !== runStart.runId) continue;
    latest = {
      retryAttempt: record.event.retryAttempt,
      maxRetries: record.event.maxRetries,
      reason: record.event.reason,
      delayMs: record.event.delayMs,
      createdAtMs: recordCreatedAtMs(record) ?? Date.now(),
    };
  }
  return latest;
}

function retryRunLabel(retry: { retryAttempt: number; maxRetries: number; delayMs: number; createdAtMs: number }, nowMs: number): string {
  const remainingMs = Math.max(0, retry.createdAtMs + retry.delayMs - nowMs);
  const suffix = remainingMs > 0 ? ` · ${Math.ceil(remainingMs / 1000)}s 后重连` : "";
  return `正在重试 ${retry.retryAttempt}/${retry.maxRetries}${suffix}`;
}

function statusFromResultSubtype(subtype: string, running: boolean): RunSummary["status"] {
  if (running) return "running";
  if (subtype === "success") return "completed";
  if (subtype === "stopped_by_user") return "stopped";
  if (subtype === "interrupted") return "interrupted";
  if (subtype) return "failed";
  return "completed";
}

function resultDetail(result?: SDKMessage): string | undefined {
  if (!result) return undefined;
  const errors = (result as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    const first = errors.find((item) => typeof item === "string" && item.trim());
    if (typeof first === "string") return first;
  }
  const text = (result as { result?: unknown }).result;
  return typeof text === "string" && text.trim() ? text : undefined;
}

function normalizedRunDetail(detail?: string): string | undefined {
  const text = detail?.trim();
  if (!text || text === "Agent run stopped.") return undefined;
  return formatAgentUserError(text);
}

function eventsSinceStart(records: AgentTimelineRecord[], userIndex: number): boolean {
  const endIndex = nextUserInputIndex(records, userIndex) ?? records.length;
  for (let index = userIndex + 1; index < endIndex; index += 1) {
    const record = records[index];
    if (isRuntimeRecord(record)) continue;
    if ((record as SDKMessage).type === "assistant" || (record as SDKMessage).type === "stream_event") return true;
  }
  return false;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}
