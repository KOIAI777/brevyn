import { useSyncExternalStore } from "react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { timelineRecordIdentity, timelineRecordRenderKey } from "@/lib/agent-timeline-identity";
import type { BrevynAgentRuntimeEvent, BrevynAgentTimelineRecord } from "@/types/domain";

interface LiveStreamState {
  runId: string;
  segment: number;
  blocks: Map<string, SDKMessage>;
  textByKey: Map<string, string>;
  inputByKey: Map<string, string>;
}

export type AgentThreadListStatusKind = "idle" | "running" | "completed" | "failed" | "stopped" | "interrupted";

export interface AgentThreadListStatus {
  kind: AgentThreadListStatusKind;
  updatedAtMs: number;
  seen: boolean;
}

const EMPTY_RECORDS: BrevynAgentTimelineRecord[] = [];
const EMPTY_THREAD_LIST_STATUSES = new Map<string, AgentThreadListStatus>();

let liveRecordsByThread = new Map<string, BrevynAgentTimelineRecord[]>();
let liveRunningByThread = new Map<string, boolean>();
let threadListStatusByThread = new Map<string, AgentThreadListStatus>();
let pendingRecordsByThread = new Map<string, BrevynAgentTimelineRecord[]>();
let liveStreamStateByThread = new Map<string, LiveStreamState>();
let pendingFlushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();
let liveSequence = 0;

export function appendAgentLiveRecords(threadId: string, records: BrevynAgentTimelineRecord[]): void {
  if (!threadId || records.length === 0) return;
  const normalized = records.flatMap((record) => {
    const liveRecord = prepareLiveRecord(record);
    return liveRecord ? [liveRecord] : [];
  });
  if (normalized.length === 0) return;
  const current = pendingRecordsByThread.get(threadId) || EMPTY_RECORDS;
  pendingRecordsByThread.set(threadId, [...current, ...normalized]);
  scheduleAgentLiveRecordsFlush();
}

export function appendAgentLiveMessage(threadId: string, message: SDKMessage, options?: { modelId?: string }): boolean {
  if (isStreamEventMessage(message)) {
    const liveStreamRecord = prepareLiveStreamRecord(threadId, message, options);
    if (!liveStreamRecord) return false;
    appendAgentLiveRecords(threadId, [liveStreamRecord]);
    return true;
  }
  if (isToolResultMessage(message)) advanceLiveStreamSegment(threadId);
  const liveMessage = prepareLiveMessage(message, options);
  if (!liveMessage) return false;
  appendAgentLiveRecords(threadId, [liveMessage]);
  return true;
}

export function removeAgentLiveMessage(threadId: string, uuid: string): void {
  if (!threadId || !uuid) return;
  const pending = pendingRecordsByThread.get(threadId) || EMPTY_RECORDS;
  if (pending.length > 0) {
    const nextPending = pending.filter((record) => recordUuid(record) !== uuid);
    if (nextPending.length === 0) pendingRecordsByThread.delete(threadId);
    else if (nextPending.length !== pending.length) pendingRecordsByThread.set(threadId, nextPending);
  }

  const current = liveRecordsByThread.get(threadId) || EMPTY_RECORDS;
  if (current.length === 0) return;
  const nextRecords = current.filter((record) => recordUuid(record) !== uuid);
  if (nextRecords.length === current.length) return;
  const next = new Map(liveRecordsByThread);
  if (nextRecords.length === 0) next.delete(threadId);
  else next.set(threadId, nextRecords);
  liveRecordsByThread = next;
  emitAgentLiveRecordsChanged();
}

export function appendAgentRuntimeEvent(event: BrevynAgentRuntimeEvent): string {
  const threadId = agentRuntimeEventThreadId(event);
  if (!threadId) return "";
  if (event.type === "run_started") {
    resetLiveStreamState(threadId, event.runId);
    setAgentThreadListStatus(threadId, "running", { updatedAtMs: eventCreatedAtMs(event) });
    setAgentLiveRunning(threadId, true);
  }
  if (event.type === "run_retrying") {
    removeLiveRetryRecord(threadId, event.runId, { silent: true });
  }
  if (event.type === "run_retry_cleared") {
    removeLiveRetryRecord(threadId, event.runId);
    return threadId;
  }
  if (isTerminalRuntimeEvent(event)) {
    removeLiveRetryRecord(threadId, "runId" in event ? event.runId : undefined, { silent: true });
    if (!terminalEventMatchesLiveRun(threadId, event.runId)) return threadId;
    setAgentThreadListStatus(threadId, terminalThreadListStatusKind(event), { updatedAtMs: eventCreatedAtMs(event) });
    appendAgentLiveRecords(threadId, [{ kind: "runtime", event }]);
    setAgentLiveRunning(threadId, false);
    flushAgentLiveRecords(threadId);
    return threadId;
  }
  appendAgentLiveRecords(threadId, [{ kind: "runtime", event }]);
  return threadId;
}

export function flushAgentLiveRecords(threadId?: string): void {
  if (threadId) {
    flushAgentLiveThread(threadId);
    return;
  }
  if (pendingFlushTimer !== null) {
    clearLiveFlushTimer(pendingFlushTimer);
    pendingFlushTimer = null;
  }
  if (pendingRecordsByThread.size === 0) return;
  const threadIds = [...pendingRecordsByThread.keys()];
  for (const pendingThreadId of threadIds) flushAgentLiveThread(pendingThreadId, { silent: true });
  emitAgentLiveRecordsChanged();
}

export function clearAgentLiveRecords(threadId: string, options?: { preserveStoppedRuns?: boolean }): void {
  if (!threadId) return;
  const pending = pendingRecordsByThread.get(threadId) || EMPTY_RECORDS;
  pendingRecordsByThread.delete(threadId);
  const current = liveRecordsByThread.get(threadId) || EMPTY_RECORDS;
  const merged = options?.preserveStoppedRuns && pending.length > 0
    ? appendUniqueRecords(current, pending)
    : current;
  const preserved = options?.preserveStoppedRuns ? stoppedRunLiveRecords(merged) : EMPTY_RECORDS;
  liveStreamStateByThread.delete(threadId);
  if (!liveRecordsByThread.has(threadId) && preserved.length === 0) return;
  const next = new Map(liveRecordsByThread);
  if (preserved.length > 0) next.set(threadId, preserved);
  else next.delete(threadId);
  liveRecordsByThread = next;
  emitAgentLiveRecordsChanged();
}

export function setAgentLiveRunning(threadId: string, running: boolean): void {
  if (!threadId) return;
  if (liveRunningByThread.get(threadId) === running) return;
  const next = new Map(liveRunningByThread);
  if (running) next.set(threadId, true);
  else next.delete(threadId);
  liveRunningByThread = next;
  emitAgentLiveRecordsChanged();
}

export function useAgentLiveRunning(threadId: string): boolean {
  return useSyncExternalStore(
    subscribeAgentLiveRecords,
    () => getAgentLiveRunning(threadId),
    () => false,
  );
}

export function clearAllAgentLiveRecords(): void {
  const hadState = liveRecordsByThread.size > 0 || liveRunningByThread.size > 0 || pendingRecordsByThread.size > 0 || threadListStatusByThread.size > 0;
  if (pendingFlushTimer !== null) {
    clearLiveFlushTimer(pendingFlushTimer);
    pendingFlushTimer = null;
  }
  pendingRecordsByThread = new Map();
  liveRunningByThread = new Map();
  threadListStatusByThread = new Map();
  liveRecordsByThread = new Map();
  liveStreamStateByThread = new Map();
  if (hadState) emitAgentLiveRecordsChanged();
}

export function getAgentLiveRecords(threadId: string): BrevynAgentTimelineRecord[] {
  if (!threadId) return EMPTY_RECORDS;
  return liveRecordsByThread.get(threadId) || EMPTY_RECORDS;
}

export function getAgentLiveRunning(threadId: string): boolean {
  if (!threadId) return false;
  return liveRunningByThread.get(threadId) ?? false;
}

export function getAgentThreadListStatuses(): ReadonlyMap<string, AgentThreadListStatus> {
  return threadListStatusByThread;
}

export function markAgentThreadStatusSeen(threadId: string): void {
  if (!threadId) return;
  const current = threadListStatusByThread.get(threadId);
  if (!current || current.seen) return;
  const next = new Map(threadListStatusByThread);
  next.set(threadId, { ...current, seen: true });
  threadListStatusByThread = next;
  emitAgentLiveRecordsChanged();
}

export function useAgentThreadListStatuses(): ReadonlyMap<string, AgentThreadListStatus> {
  return useSyncExternalStore(
    subscribeAgentLiveRecords,
    () => getAgentThreadListStatuses(),
    () => EMPTY_THREAD_LIST_STATUSES,
  );
}

export function useAgentLiveRecords(threadId: string): BrevynAgentTimelineRecord[] {
  return useSyncExternalStore(
    subscribeAgentLiveRecords,
    () => getAgentLiveRecords(threadId),
    () => EMPTY_RECORDS,
  );
}

function subscribeAgentLiveRecords(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emitAgentLiveRecordsChanged(): void {
  for (const listener of listeners) listener();
}

function scheduleAgentLiveRecordsFlush(): void {
  if (pendingFlushTimer !== null) return;
  pendingFlushTimer = setLiveFlushTimer(() => {
    pendingFlushTimer = null;
    flushAgentLiveRecords();
  }, 16);
}

function setLiveFlushTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  return globalThis.setTimeout(callback, delayMs);
}

function clearLiveFlushTimer(timer: ReturnType<typeof setTimeout>): void {
  globalThis.clearTimeout(timer);
}

function flushAgentLiveThread(threadId: string, options?: { silent?: boolean }): void {
  const pending = pendingRecordsByThread.get(threadId) || EMPTY_RECORDS;
  if (pending.length === 0) return;
  pendingRecordsByThread.delete(threadId);

  const current = liveRecordsByThread.get(threadId) || EMPTY_RECORDS;
  const merged = appendUniqueRecords(current, pending);
  if (merged === current) return;

  const next = new Map(liveRecordsByThread);
  next.set(threadId, merged);
  liveRecordsByThread = next;
  if (!options?.silent) emitAgentLiveRecordsChanged();
}

function appendUniqueRecords(current: BrevynAgentTimelineRecord[], pending: BrevynAgentTimelineRecord[]): BrevynAgentTimelineRecord[] {
  const indexByKey = new Map<string, number>();
  current.forEach((record, index) => {
    const key = liveRecordKey(record);
    if (key) indexByKey.set(key, index);
  });
  let changed = false;
  const next = [...current];
  for (const record of pending) {
    const key = liveRecordKey(record);
    const existingIndex = key ? indexByKey.get(key) : undefined;
    if (existingIndex !== undefined) {
      if (next[existingIndex] !== record) {
        next[existingIndex] = record;
        changed = true;
      }
      continue;
    }
    if (key) indexByKey.set(key, next.length);
    next.push(record);
    changed = true;
  }
  return changed ? next : current;
}

function stoppedRunLiveRecords(records: BrevynAgentTimelineRecord[]): BrevynAgentTimelineRecord[] {
  const preserved: BrevynAgentTimelineRecord[] = [];
  let runRecords: BrevynAgentTimelineRecord[] = [];
  let runHasStoppedContent = false;

  function finishRun(terminal?: "run_stopped" | "stopped_result") {
    if (terminal && runHasStoppedContent) preserved.push(...runRecords);
    runRecords = [];
    runHasStoppedContent = false;
  }

  for (const record of records) {
    if (isRuntimeLiveRecord(record) && record.event.type === "run_started") {
      finishRun();
      runRecords = [record];
      continue;
    }

    if (runRecords.length > 0) {
      runRecords.push(record);
      if (isStoppedContentLiveRecord(record)) runHasStoppedContent = true;
      if (isStoppedResultLiveRecord(record)) {
        finishRun("stopped_result");
        continue;
      }
      if (isRuntimeLiveRecord(record) && isTerminalRuntimeEvent(record.event)) {
        finishRun(record.event.type === "run_stopped" ? "run_stopped" : undefined);
      }
    }
  }

  finishRun();
  return preserved;
}

function removeLiveRetryRecord(threadId: string, runId?: string, options?: { silent?: boolean }): void {
  const pending = pendingRecordsByThread.get(threadId) || EMPTY_RECORDS;
  if (pending.length > 0) {
    const nextPending = pending.filter((record) => !isRetryRecord(record, runId));
    if (nextPending.length === 0) pendingRecordsByThread.delete(threadId);
    else if (nextPending.length !== pending.length) pendingRecordsByThread.set(threadId, nextPending);
  }

  const current = liveRecordsByThread.get(threadId) || EMPTY_RECORDS;
  if (current.length === 0) return;
  const nextRecords = current.filter((record) => !isRetryRecord(record, runId));
  if (nextRecords.length === current.length) return;
  const next = new Map(liveRecordsByThread);
  if (nextRecords.length === 0) next.delete(threadId);
  else next.set(threadId, nextRecords);
  liveRecordsByThread = next;
  if (!options?.silent) emitAgentLiveRecordsChanged();
}

function isRetryRecord(record: BrevynAgentTimelineRecord, runId?: string): boolean {
  if (!isRuntimeLiveRecord(record) || record.event.type !== "run_retrying") return false;
  return !runId || record.event.runId === runId;
}

function liveRecordKey(record: BrevynAgentTimelineRecord): string {
  return timelineRecordIdentity(record);
}

function recordUuid(record: BrevynAgentTimelineRecord): string {
  if (!record || typeof record !== "object" || isRuntimeLiveRecord(record)) return "";
  const uuid = (record as { uuid?: unknown }).uuid;
  return typeof uuid === "string" ? uuid : "";
}

function prepareLiveRecord(record: BrevynAgentTimelineRecord): BrevynAgentTimelineRecord | null {
  if (isRuntimeLiveRecord(record)) return record;
  return prepareLiveMessage(record as SDKMessage);
}

function prepareLiveMessage(message: SDKMessage, options?: { modelId?: string }): SDKMessage | null {
  const record = message as SDKMessage & { type?: unknown; isReplay?: unknown; _createdAt?: unknown; _channelModelId?: unknown; _liveSeq?: unknown };
  if (record.isReplay === true) return null;
  if (record.type === "prompt_suggestion") return null;
  let next: SDKMessage & { _createdAt?: unknown; _channelModelId?: unknown; _renderId?: unknown; _liveSeq?: unknown } = message as SDKMessage & { _createdAt?: unknown; _channelModelId?: unknown; _renderId?: unknown; _liveSeq?: unknown };
  if (typeof next._createdAt !== "number") next = { ...next, _createdAt: Date.now() };
  if (typeof next._liveSeq !== "number") next = { ...next, _liveSeq: nextLiveSequence() };
  if (!(next as { _renderId?: unknown })._renderId) {
    next = { ...next, _renderId: timelineRecordRenderKey(next, "live") };
  }
  if (record.type === "assistant" && options?.modelId && !next._channelModelId) {
    next = { ...next, _channelModelId: options.modelId };
  }
  return next;
}

function prepareLiveStreamRecord(threadId: string, message: SDKMessage, options?: { modelId?: string }): SDKMessage | null {
  const record = message as SDKMessage & { isReplay?: unknown };
  if (record.isReplay === true) return null;

  const event = recordObject((message as { event?: unknown }).event);
  const eventType = stringValue(event.type, "");
  if (eventType !== "content_block_start" && eventType !== "content_block_delta") return null;

  const index = streamEventIndex(event);
  const state = liveStreamState(threadId);

  if (eventType === "content_block_start") {
    const block = recordObject(event.content_block);
    const blockType = stringValue(block.type, "");
    if (blockType !== "tool_use" && blockType !== "server_tool_use") return null;
    const key = streamBlockKey(state, index, "tool-start");
    const existing = state.blocks.get(key);
    const next = withLiveStreamMetadata(message, key, existing, options);
    state.blocks.set(key, next);
    return next;
  }

  const delta = recordObject(event.delta);
  const deltaType = stringValue(delta.type, "");
  if (deltaType === "text_delta") {
    const text = typeof delta.text === "string" ? delta.text : "";
    if (!text) return null;
    const key = streamBlockKey(state, index, "text");
    const nextText = `${state.textByKey.get(key) || ""}${text}`;
    state.textByKey.set(key, nextText);
    const existing = state.blocks.get(key);
    const next = withLiveStreamMetadata(rewriteStreamDelta(message, { type: "text_delta", text: nextText }), key, existing, options);
    state.blocks.set(key, next);
    return next;
  }

  if (deltaType === "thinking_delta") {
    const thinking = typeof delta.thinking === "string" ? delta.thinking : "";
    if (!thinking) return null;
    const key = streamBlockKey(state, index, "thinking");
    const nextThinking = `${state.textByKey.get(key) || ""}${thinking}`;
    state.textByKey.set(key, nextThinking);
    const existing = state.blocks.get(key);
    const next = withLiveStreamMetadata(rewriteStreamDelta(message, { type: "thinking_delta", thinking: nextThinking }), key, existing, options);
    state.blocks.set(key, next);
    return next;
  }

  if (deltaType === "input_json_delta") {
    const partialJson = stringValue(delta.partial_json, "");
    if (!partialJson) return null;
    const key = streamBlockKey(state, index, "tool-input");
    const nextInput = `${state.inputByKey.get(key) || ""}${partialJson}`;
    state.inputByKey.set(key, nextInput);
    const existing = state.blocks.get(key);
    const next = withLiveStreamMetadata(rewriteStreamDelta(message, { type: "input_json_delta", partial_json: nextInput }), key, existing, options);
    state.blocks.set(key, next);
    return next;
  }

  return null;
}

function rewriteStreamDelta(message: SDKMessage, delta: Record<string, unknown>): SDKMessage {
  const event = recordObject((message as { event?: unknown }).event);
  return {
    ...message,
    event: {
      ...event,
      delta,
    },
  } as unknown as SDKMessage;
}

function withLiveStreamMetadata(message: SDKMessage, key: string, existing?: SDKMessage, options?: { modelId?: string }): SDKMessage {
  const previous = existing as (SDKMessage & { _createdAt?: unknown; _channelModelId?: unknown; _renderId?: unknown; _liveSeq?: unknown }) | undefined;
  const next = message as SDKMessage & { uuid?: unknown; _createdAt?: unknown; _channelModelId?: unknown; _renderId?: unknown; _liveSeq?: unknown };
  return {
    ...next,
    uuid: streamRecordUuid(key),
    _createdAt: typeof previous?._createdAt === "number"
      ? previous._createdAt
      : typeof next._createdAt === "number" ? next._createdAt : Date.now(),
    _liveSeq: typeof previous?._liveSeq === "number" ? previous._liveSeq : nextLiveSequence(),
    _renderId: typeof previous?._renderId === "string" ? previous._renderId : `live-stream:${key}`,
    _channelModelId: typeof previous?._channelModelId === "string" ? previous._channelModelId : typeof next._channelModelId === "string" ? next._channelModelId : options?.modelId,
  } as unknown as SDKMessage;
}

function liveStreamState(threadId: string): LiveStreamState {
  const existing = liveStreamStateByThread.get(threadId);
  if (existing) return existing;
  const next: LiveStreamState = {
    runId: "run",
    segment: 0,
    blocks: new Map(),
    textByKey: new Map(),
    inputByKey: new Map(),
  };
  liveStreamStateByThread.set(threadId, next);
  return next;
}

function resetLiveStreamState(threadId: string, runId: string): void {
  liveStreamStateByThread.set(threadId, {
    runId,
    segment: 0,
    blocks: new Map(),
    textByKey: new Map(),
    inputByKey: new Map(),
  });
}

function advanceLiveStreamSegment(threadId: string): void {
  const state = liveStreamStateByThread.get(threadId);
  if (!state) return;
  state.segment += 1;
}

function streamBlockKey(state: LiveStreamState, index: number, kind: "text" | "thinking" | "tool-start" | "tool-input"): string {
  return `${state.runId}:${state.segment}:${index}:${kind}`;
}

function streamRecordUuid(key: string): string {
  return `live-stream:${key}`;
}

function streamEventIndex(event: Record<string, unknown>): number {
  const index = Number(event.index);
  return Number.isFinite(index) ? index : 0;
}

function nextLiveSequence(): number {
  liveSequence += 1;
  return liveSequence;
}

function isStreamEventMessage(message: SDKMessage): boolean {
  return (message as { type?: unknown }).type === "stream_event";
}

function isToolResultMessage(message: SDKMessage): boolean {
  if ((message as { type?: unknown }).type !== "user") return false;
  const content = recordObject((message as { message?: unknown }).message).content;
  return Array.isArray(content) && content.some((block) => recordObject(block).type === "tool_result");
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function isRuntimeLiveRecord(record: BrevynAgentTimelineRecord): record is Extract<BrevynAgentTimelineRecord, { kind: "runtime" }> {
  return Boolean(record && typeof record === "object" && "kind" in record && record.kind === "runtime");
}

function isStoppedContentLiveRecord(record: BrevynAgentTimelineRecord): boolean {
  if (!record || typeof record !== "object" || isRuntimeLiveRecord(record)) return false;
  const type = (record as { type?: unknown }).type;
  if (type === "stream_event") return true;
  if (type !== "assistant") return false;
  const content = (record as { message?: { content?: unknown } }).message?.content;
  return Array.isArray(content) && content.some((block) => {
    if (!block || typeof block !== "object") return false;
    const item = block as { type?: unknown; text?: unknown; thinking?: unknown };
    return (item.type === "text" && typeof item.text === "string" && item.text.trim())
      || (item.type === "thinking" && typeof item.thinking === "string" && item.thinking.trim());
  });
}

function isStoppedResultLiveRecord(record: BrevynAgentTimelineRecord): boolean {
  if (!record || typeof record !== "object" || isRuntimeLiveRecord(record)) return false;
  return (record as { type?: unknown; subtype?: unknown }).type === "result"
    && (record as { subtype?: unknown }).subtype === "stopped_by_user";
}

export function agentRuntimeEventThreadId(event: BrevynAgentRuntimeEvent): string {
  if (event.type === "approval_requested" || event.type === "ask_user_requested" || event.type === "exit_plan_requested") {
    return event.request.threadId;
  }
  if (event.type === "context_usage_updated") {
    return event.snapshot.threadId;
  }
  return event.threadId;
}

function isTerminalRuntimeEvent(event: BrevynAgentRuntimeEvent): event is Extract<BrevynAgentRuntimeEvent, { type: "run_completed" | "run_stopped" | "run_failed" | "run_interrupted" }> {
  return event.type === "run_completed" || event.type === "run_stopped" || event.type === "run_failed" || event.type === "run_interrupted";
}

function terminalEventMatchesLiveRun(threadId: string, runId: string): boolean {
  const state = liveStreamStateByThread.get(threadId);
  return !state || state.runId === runId;
}

export function setAgentThreadListStatus(threadId: string, kind: AgentThreadListStatusKind, options?: { seen?: boolean; updatedAtMs?: number }): void {
  if (!threadId) return;
  const updatedAtMs = options?.updatedAtMs ?? Date.now();
  const seen = options?.seen ?? false;
  const current = threadListStatusByThread.get(threadId);
  if (current && current.kind === kind && current.seen === seen && current.updatedAtMs === updatedAtMs) return;
  const next = new Map(threadListStatusByThread);
  next.set(threadId, { kind, updatedAtMs, seen });
  threadListStatusByThread = next;
  emitAgentLiveRecordsChanged();
}

function terminalThreadListStatusKind(event: Extract<BrevynAgentRuntimeEvent, { type: "run_completed" | "run_stopped" | "run_failed" | "run_interrupted" }>): AgentThreadListStatusKind {
  if (event.type === "run_completed") return "completed";
  if (event.type === "run_failed") return "failed";
  if (event.type === "run_interrupted") return "interrupted";
  return "stopped";
}

function eventCreatedAtMs(event: BrevynAgentRuntimeEvent): number {
  const createdAt = "createdAt" in event ? Date.parse(event.createdAt) : NaN;
  return Number.isFinite(createdAt) ? createdAt : Date.now();
}
