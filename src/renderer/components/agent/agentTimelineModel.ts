import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAskUserRequest, AgentAttachment, AgentExitPlanRequest, AgentPermissionMode, BrevynAgentTimelineRecord } from "@/types/domain";
import { recordCreatedAtMs, timelineRecordIdentity, timelineRecordRenderKey } from "@/lib/agent-timeline-identity";
import { recordObject, stringValue, type ToolResultBlock, type ToolUseBlock } from "@/components/agent/tool-cards/toolModel";
export { timelineRecordIdentity } from "@/lib/agent-timeline-identity";

export interface WebCitationLink {
  title: string;
  url: string;
}

export interface AgentTodoItem {
  id?: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeContent?: string;
}

export interface RunSummary {
  runId: string;
  label: string;
  running: boolean;
  status: "running" | "completed" | "stopped" | "failed" | "interrupted";
  permissionMode?: AgentPermissionMode;
  detail?: string;
  startedAtMs?: number;
  finishedAtMs?: number;
  hasActivity?: boolean;
  retryAttempt?: number;
  retryMaxRetries?: number;
  retryUntilMs?: number;
}

export interface ContextUsage {
  inputTokens: number;
  contextInputTokens?: number;
  contextWindow?: number;
  contextWindowSource?: "model_config" | "provider" | "user" | "inferred" | "unknown";
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheHitRate?: number;
  cacheSampleCount?: number;
  modelId?: string;
  providerId?: string;
  remainingTokens?: number;
  percentage?: number;
  source?: "context_snapshot" | "default";
}

export type ProcessEvent =
  { kind: "tool_use"; id: string; tool: ToolUseBlock; result?: ToolResultBlock; approvalDecision?: "allow" | "deny"; sourceIndex?: number };

export type AgentTimelineRecord = BrevynAgentTimelineRecord;

export interface AssistantTurnGroup {
  type: "assistant-turn";
  assistantMessages: SDKMessage[];
  turnRecords: Array<{ record: AgentTimelineRecord; index: number }>;
  model?: string;
  providerId?: string;
  createdAt?: number;
}

export type AgentMessageGroup =
  | { type: "user"; record: SDKMessage; index: number }
  | { type: "system"; record: SDKMessage; index: number }
  | { type: "runtime"; record: Extract<BrevynAgentTimelineRecord, { kind: "runtime" }>; index: number }
  | AssistantTurnGroup;

const PROMPT_TOO_LONG_PATTERNS = [
  "prompt is too long",
  "prompt_too_long",
  "input is too long",
  "context_length_exceeded",
  "maximum context length",
  "token limit",
  "exceeds the model",
] as const;

export function groupIntoTurns(records: AgentTimelineRecord[], sessionModelId?: string): AgentMessageGroup[] {
  const groups: AgentMessageGroup[] = [];
  let currentTurn: AssistantTurnGroup | null = null;
  let leadingTurn: AssistantTurnGroup | null = null;
  let pendingRunStart: Extract<BrevynAgentTimelineRecord, { kind: "runtime" }> | null = null;
  let seenUserInput = false;

  const flushTurn = (): void => {
    if (currentTurn && currentTurn.turnRecords.length > 0) {
      groups.push(currentTurn);
    }
    currentTurn = null;
  };

  records.forEach((record, index) => {
    if (isRuntimeRecord(record)) {
      if (currentTurn) {
        applyRuntimeTurnMeta(currentTurn, record, sessionModelId);
        currentTurn.turnRecords.push({ record, index });
      }
      else if (!seenUserInput) {
        leadingTurn = leadingTurn ?? emptyAssistantTurn(sessionModelId);
        applyRuntimeTurnMeta(leadingTurn, record, sessionModelId);
        leadingTurn.turnRecords.push({ record, index });
      } else {
        if (record.event.type === "run_started") {
          pendingRunStart = record;
          return;
        }
        groups.push({ type: "runtime", record, index });
      }
      return;
    }

    if (!isRuntimeRecord(record) && (record as SDKMessage).type === "stream_event") {
      if (!currentTurn) {
        currentTurn = !seenUserInput ? leadingTurn ?? emptyAssistantTurn(sessionModelId) : emptyAssistantTurn(sessionModelId);
        if (!seenUserInput) leadingTurn = currentTurn;
        applyPendingRunStart(currentTurn);
      }
      if (currentTurn) currentTurn.turnRecords.push({ record, index });
      return;
    }

    const message = record as SDKMessage;
    if (message.type === "user") {
      if (isUserInputMessage(message)) {
        if (seenUserInput) flushTurn();
        else currentTurn = null;
        pendingRunStart = null;
        groups.push({ type: "user", record: message, index });
        seenUserInput = true;
        if (leadingTurn && leadingTurn.turnRecords.length > 0) {
          currentTurn = leadingTurn;
          leadingTurn = null;
        }
      } else if (currentTurn) {
        currentTurn.turnRecords.push({ record: message, index });
      }
      return;
    }

    if (message.type === "assistant") {
      if ((message as { isReplay?: unknown }).isReplay === true) return;
      const messageModel = stringValue(recordObject(messageContentEnvelope(message)).model ?? (message as { _channelModelId?: unknown })._channelModelId, "");
      const messageProviderId = stringValue((message as { _channelProviderId?: unknown })._channelProviderId, "");
      if (!currentTurn) {
        currentTurn = !seenUserInput ? leadingTurn ?? emptyAssistantTurn(sessionModelId) : emptyAssistantTurn(sessionModelId);
        if (!seenUserInput) leadingTurn = currentTurn;
        applyPendingRunStart(currentTurn);
        currentTurn.model = currentTurn.model || messageModel || sessionModelId || "";
        currentTurn.providerId = currentTurn.providerId || messageProviderId || "";
        currentTurn.createdAt = currentTurn.createdAt ?? recordCreatedAtMs(message);
        currentTurn.assistantMessages.push(message);
        currentTurn.turnRecords.push({ record: message, index });
      } else {
        currentTurn.model = currentTurn.model || messageModel || sessionModelId || "";
        currentTurn.providerId = currentTurn.providerId || messageProviderId || "";
        currentTurn.createdAt = currentTurn.createdAt ?? recordCreatedAtMs(message);
        currentTurn.assistantMessages.push(message);
        currentTurn.turnRecords.push({ record: message, index });
      }
      return;
    }

    if (message.type === "system") {
      const subtype = stringValue((message as { subtype?: unknown }).subtype, "");
      if (subtype === "permission_denied" && currentTurn) {
        currentTurn.turnRecords.push({ record: message, index });
      } else if (subtype === "compact_boundary" || subtype === "compacting" || subtype === "compact_failed" || subtype === "permission_denied") {
        flushTurn();
        groups.push({ type: "system", record: message, index });
      } else if (currentTurn) {
        currentTurn.turnRecords.push({ record: message, index });
      }
      return;
    }

    if ((message as { type?: unknown }).type === "prompt_suggestion") return;
    if (currentTurn) currentTurn.turnRecords.push({ record: message, index });
  });

  flushTurn();
  return groups;

  function applyPendingRunStart(turn: AssistantTurnGroup): void {
    if (!pendingRunStart) return;
    applyRuntimeTurnMeta(turn, pendingRunStart, sessionModelId);
    pendingRunStart = null;
  }
}

function emptyAssistantTurn(sessionModelId?: string): AssistantTurnGroup {
  return {
    type: "assistant-turn",
    assistantMessages: [],
    turnRecords: [],
    model: sessionModelId || "",
  };
}

function applyRuntimeTurnMeta(turn: AssistantTurnGroup, record: Extract<BrevynAgentTimelineRecord, { kind: "runtime" }>, sessionModelId?: string): void {
  if (record.event.type !== "run_started") return;
  turn.model = turn.model || stringValue(record.event.modelId, sessionModelId || "");
  turn.providerId = turn.providerId || stringValue(record.event.providerId, "");
  turn.createdAt = turn.createdAt ?? recordCreatedAtMs(record);
}

export function latestTurnBounds(records: AgentTimelineRecord[]): { user: SDKMessage; userIndex: number; result?: SDKMessage; resultIndex?: number } | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || isRuntimeRecord(record) || isStreamEventRecord(record)) continue;
    if ((record as SDKMessage).type !== "user" || toolResultBlocks(record as SDKMessage).length > 0) continue;
    const resultIndex = records.findIndex((candidate, candidateIndex) => (
      candidateIndex > index
        && !isRuntimeRecord(candidate)
        && !isStreamEventRecord(candidate)
        && (candidate as SDKMessage).type === "result"
    ));
    const result = resultIndex >= 0 ? records[resultIndex] as SDKMessage : undefined;
    return { user: record as SDKMessage, userIndex: index, result, resultIndex: resultIndex >= 0 ? resultIndex : undefined };
  }
  return null;
}

function nextUserInputIndex(records: AgentTimelineRecord[], afterIndex: number): number | undefined {
  for (let index = afterIndex + 1; index < records.length; index += 1) {
    const candidate = records[index];
    if (!candidate || isRuntimeRecord(candidate) || isStreamEventRecord(candidate)) continue;
    if ((candidate as SDKMessage).type === "user" && isUserInputMessage(candidate as SDKMessage)) return index;
  }
  return undefined;
}

export function isUserInputMessage(message: SDKMessage): boolean {
  if ((message as { parent_tool_use_id?: unknown }).parent_tool_use_id) return false;
  if ((message as { isSynthetic?: unknown }).isSynthetic === true) return false;
  if (toolResultBlocks(message).length > 0) return false;
  return userText(message).trim().length > 0 || messageAttachments(message).length > 0;
}

export function assistantText(record: SDKMessage): string {
  return assistantBlocks(record).flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
}

export function agentErrorMessage(record: SDKMessage): string {
  const error = recordObject((record as { error?: unknown }).error);
  return stringValue(error.message, "");
}

export function isPromptTooLongMessage(record: SDKMessage): boolean {
  const errorCode = stringValue((record as { _errorCode?: unknown })._errorCode, "");
  const errorType = stringValue(recordObject((record as { error?: unknown }).error).errorType, "");
  if (errorCode === "prompt_too_long" || errorType === "prompt_too_long") return true;
  const text = `${assistantText(record)} ${agentErrorMessage(record)}`.toLowerCase();
  return PROMPT_TOO_LONG_PATTERNS.some((pattern) => text.includes(pattern));
}

export function thinkingTextForMessage(record: SDKMessage): string {
  const content = messageContent(record);
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    const item = recordObject(block);
    if (item.type !== "thinking") return [];
    return stringValue(item.thinking ?? item.text ?? item.content, "");
  }).join("\n").trim();
}

export function assistantBlocks(record: SDKMessage): Array<{ type: "text"; text: string; citations?: unknown[] } | ToolUseBlock> {
  const content = messageContent(record);
  if (!Array.isArray(content)) return [];
  const blocks: Array<{ type: "text"; text: string; citations?: unknown[] } | ToolUseBlock> = [];
  for (const block of content) {
    const item = recordObject(block);
    if (item.type === "text" && typeof item.text === "string") {
      const citations = Array.isArray(item.citations) ? item.citations : Array.isArray(item.annotations) ? item.annotations : undefined;
      blocks.push(citations ? { type: "text", text: item.text, citations } : { type: "text", text: item.text });
      continue;
    }
    if (item.type === "tool_use") {
      blocks.push({
        type: "tool_use",
        id: stringValue(item.id, "tool"),
        name: stringValue(item.name, "tool"),
        input: item.input,
      });
      continue;
    }
    if (item.type === "server_tool_use") {
      blocks.push({
        type: "tool_use",
        id: stringValue(item.id, "server-tool"),
        name: stringValue(item.name, "ServerTool"),
        input: { ...recordObject(item.input), hosted: true },
      });
    }
  }
  return blocks;
}

export function toolResultBlocks(record: SDKMessage): ToolResultBlock[] {
  const content = messageContent(record);
  if (!Array.isArray(content)) return [];
  const rawResult = (record as { toolUseResult?: unknown; tool_use_result?: unknown }).toolUseResult
    ?? (record as { tool_use_result?: unknown }).tool_use_result;
  return content.flatMap((block) => {
    const item = recordObject(block);
    if (item.type !== "tool_result") return [];
    const resultContent = item.content ?? item;
    return [{
      type: "tool_result" as const,
      toolUseId: stringValue(item.tool_use_id, "tool"),
      content: resultContent,
      isError: item.is_error === true,
      contentText: typeof resultContent === "string" ? resultContent : undefined,
      rawResult,
      toolUseResult: rawResult,
    }];
  });
}

export function userText(record: SDKMessage): string {
  const content = messageContent(record);
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    const item = recordObject(block);
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
}

export function messageAttachments(message: SDKMessage): AgentAttachment[] {
  const attachments = (message as unknown as { _attachments?: unknown })._attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const value = item as Partial<AgentAttachment>;
    if (!value.path || !value.name) return [];
    return [{
      id: value.id || value.path,
      threadId: value.threadId || "",
      name: value.name,
      kind: value.kind || "unknown",
      mimeType: value.mimeType,
      size: typeof value.size === "number" ? value.size : 0,
      sizeLabel: value.sizeLabel || "",
      path: value.path,
      sourcePath: value.sourcePath,
      createdAt: value.createdAt || "",
    }];
  });
}

export function isCompactCommandMessage(record: SDKMessage): boolean {
  return record.type === "user" && userText(record).trim() === "/compact";
}

export function messageContent(record: SDKMessage): unknown {
  return messageContentEnvelope(record).content;
}

export function messageContentEnvelope(record: SDKMessage): Record<string, unknown> {
  return recordObject((record as { message?: unknown }).message);
}

export function exitPlanSummary(request: AgentExitPlanRequest): string {
  if (request.allowedPrompts.length === 0) return "退出计划模式继续执行";
  return request.allowedPrompts
    .map((prompt) => `${prompt.tool}: ${prompt.prompt}`)
    .join(", ");
}

export function singleLine(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

export function normalizeTimelineRecords(
  records: BrevynAgentTimelineRecord[],
  liveRecords: BrevynAgentTimelineRecord[],
): AgentTimelineRecord[] {
  return splitTimelineRecords(records, liveRecords).timelineRecords;
}

export interface SplitTimelineRecords {
  historyRecords: AgentTimelineRecord[];
  liveTailRecords: AgentTimelineRecord[];
  timelineRecords: AgentTimelineRecord[];
}

export function splitTimelineRecords(
  records: BrevynAgentTimelineRecord[],
  liveRecords: BrevynAgentTimelineRecord[],
): SplitTimelineRecords {
  const usedLiveIdentities = new Set<string>();
  const liveRecordsByIdentity = new Map<string, BrevynAgentTimelineRecord>();
  for (const record of liveRecords) {
    const identity = timelineRecordIdentity(record);
    if (identity && !liveRecordsByIdentity.has(identity)) liveRecordsByIdentity.set(identity, record);
  }

  const historyRecords: BrevynAgentTimelineRecord[] = [];
  for (const record of records) {
    const identity = timelineRecordIdentity(record);
    const liveRecord = identity ? liveRecordsByIdentity.get(identity) : undefined;
    if (identity && liveRecord) {
      historyRecords.push(liveRecord);
      usedLiveIdentities.add(identity);
      continue;
    }
    historyRecords.push(record);
  }
  const settledHistoryRunIds = settledRunIdsForRecords(historyRecords);

  const liveTailRecords: BrevynAgentTimelineRecord[] = [];
  for (const record of liveRecords) {
    const identity = timelineRecordIdentity(record);
    if (identity && usedLiveIdentities.has(identity)) continue;
    if (isSettledLiveTailRecord(record, settledHistoryRunIds)) continue;
    liveTailRecords.push(record);
    if (identity) usedLiveIdentities.add(identity);
  }

  const normalizedHistoryRecords = normalizeTimelineSourceRecords(historyRecords);
  const normalizedLiveTailRecords = normalizeTimelineSourceRecords(liveTailRecords);

  return {
    historyRecords: normalizedHistoryRecords,
    liveTailRecords: normalizedLiveTailRecords,
    timelineRecords: appendLiveTailRecords(normalizedHistoryRecords, normalizedLiveTailRecords),
  };
}

function appendLiveTailRecords(
  historyRecords: AgentTimelineRecord[],
  liveTailRecords: AgentTimelineRecord[],
): AgentTimelineRecord[] {
  if (liveTailRecords.length === 0) return historyRecords;
  if (historyRecords.length === 0) return liveTailRecords;
  return [...historyRecords, ...liveTailRecords];
}

function normalizeTimelineSourceRecords(sourceRecords: BrevynAgentTimelineRecord[]): AgentTimelineRecord[] {
  const normalized: AgentTimelineRecord[] = [];
  const seenRecords = new Set<string>();

  for (const record of sourceRecords) {
    const identity = timelineRecordIdentity(record);
    if (identity) {
      if (seenRecords.has(identity)) continue;
      seenRecords.add(identity);
    }
    if (isHiddenSystemRecord(record)) continue;
    if (!isRuntimeRecord(record) && (record as SDKMessage).type === "prompt_suggestion") continue;
    normalized.push(record);
  }

  return normalized;
}

function settledRunIdsForRecords(records: BrevynAgentTimelineRecord[]): Set<string> {
  const settledRunIds = new Set<string>();
  let currentRunId = "";

  for (const record of records) {
    if (isRuntimeRecord(record)) {
      const event = record.event;
      if (event.type === "run_started") {
        currentRunId = event.runId;
        continue;
      }
      if (isTerminalRunEventType(event.type) && "runId" in event) {
        settledRunIds.add(event.runId);
        if (currentRunId === event.runId) currentRunId = "";
      }
      continue;
    }

    const message = record as SDKMessage;
    if (message.type === "user" && isUserInputMessage(message)) {
      currentRunId = "";
      continue;
    }
    if (message.type === "result" && currentRunId) settledRunIds.add(currentRunId);
  }

  return settledRunIds;
}

function isSettledLiveTailRecord(record: BrevynAgentTimelineRecord, settledRunIds: Set<string>): boolean {
  const runId = liveRecordRunId(record);
  if (!runId || !settledRunIds.has(runId)) return false;
  if (isStreamEventRecord(record)) return true;
  return isRuntimeRecord(record) && isTerminalRunEventType(record.event.type);
}

function liveRecordRunId(record: BrevynAgentTimelineRecord): string {
  if (isRuntimeRecord(record) && "runId" in record.event) return record.event.runId;
  if (!isStreamEventRecord(record)) return "";
  const uuid = (record as { uuid?: unknown }).uuid;
  if (typeof uuid !== "string") return "";
  const prefix = "live-stream:";
  if (!uuid.startsWith(prefix)) return "";
  return uuid.slice(prefix.length).split(":")[0] || "";
}

function isTerminalRunEventType(type: string): boolean {
  return type === "run_completed" || type === "run_stopped" || type === "run_failed" || type === "run_interrupted";
}

export function recordKey(record: AgentTimelineRecord, _index?: number): string {
  return timelineRecordRenderKey(record, String((record as { type?: unknown }).type || "record"));
}

export function isRuntimeRecord(record: unknown): record is Extract<BrevynAgentTimelineRecord, { kind: "runtime" }> {
  return Boolean(record && typeof record === "object" && "kind" in record && record.kind === "runtime");
}

function isHiddenSystemRecord(record: BrevynAgentTimelineRecord): boolean {
  if (isRuntimeRecord(record) || (record as SDKMessage).type !== "system") return false;
  const subtype = stringValue((record as { subtype?: unknown }).subtype, "");
  return subtype !== "compacting" && subtype !== "compact_boundary" && subtype !== "compact_failed" && subtype !== "permission_denied";
}

export function streamTextDelta(record: BrevynAgentTimelineRecord): string {
  return streamTextDeltaBlock(record)?.text || "";
}

export function streamTextDeltaBlock(record: BrevynAgentTimelineRecord): { index: number; text: string } | null {
  if (isRuntimeRecord(record) || (record as SDKMessage).type !== "stream_event") return null;
  const event = recordObject((record as { event?: unknown }).event);
  if (event.type !== "content_block_delta") return null;
  const delta = recordObject(event.delta);
  return delta.type === "text_delta" && typeof delta.text === "string"
    ? { index: streamEventIndex(event), text: delta.text }
    : null;
}

export function streamThinkingDelta(record: BrevynAgentTimelineRecord): string {
  return streamThinkingDeltaBlock(record)?.text || "";
}

export function streamThinkingDeltaBlock(record: BrevynAgentTimelineRecord): { index: number; text: string } | null {
  if (isRuntimeRecord(record) || (record as SDKMessage).type !== "stream_event") return null;
  const event = recordObject((record as { event?: unknown }).event);
  if (event.type !== "content_block_delta") return null;
  const delta = recordObject(event.delta);
  return delta.type === "thinking_delta" && typeof delta.thinking === "string"
    ? { index: streamEventIndex(event), text: delta.thinking }
    : null;
}

export function streamToolUseStart(record: BrevynAgentTimelineRecord): { index: number; tool: ToolUseBlock } | null {
  if (isRuntimeRecord(record) || (record as SDKMessage).type !== "stream_event") return null;
  const event = recordObject((record as { event?: unknown }).event);
  if (event.type !== "content_block_start") return null;
  const block = recordObject(event.content_block);
  const type = stringValue(block.type, "");
  if (type !== "tool_use" && type !== "server_tool_use") return null;
  const id = stringValue(block.id, `stream-tool-${streamEventIndex(event)}`);
  const name = type === "server_tool_use" ? "WebSearch" : stringValue(block.name, "Tool");
  return {
    index: streamEventIndex(event),
    tool: {
      type: "tool_use",
      id,
      name,
      input: recordObject(block.input),
    },
  };
}

export function streamToolInputDelta(record: BrevynAgentTimelineRecord): { index: number; partialJson: string } | null {
  if (isRuntimeRecord(record) || (record as SDKMessage).type !== "stream_event") return null;
  const event = recordObject((record as { event?: unknown }).event);
  if (event.type !== "content_block_delta") return null;
  const delta = recordObject(event.delta);
  if (delta.type !== "input_json_delta") return null;
  const partialJson = stringValue(delta.partial_json, "");
  return partialJson ? { index: streamEventIndex(event), partialJson } : null;
}

function streamEventIndex(event: Record<string, unknown>): number {
  const index = Number(event.index);
  return Number.isFinite(index) ? index : 0;
}

export function isStreamEventRecord(record: unknown): record is SDKMessage {
  return Boolean(record && !isRuntimeRecord(record) && (record as { type?: unknown }).type === "stream_event");
}

export function approvalResolutionMap(records: BrevynAgentTimelineRecord[]): Map<string, "allow" | "deny"> {
  const map = new Map<string, "allow" | "deny">();
  for (const record of records) {
    if (isRuntimeRecord(record) && record.event.type === "approval_resolved") {
      map.set(record.event.requestId, record.event.decision);
    }
  }
  return map;
}

export function approvalDecision(record: AgentTimelineRecord, decisions: Map<string, "allow" | "deny">): "allow" | "deny" | undefined {
  if (!isRuntimeRecord(record) || record.event.type !== "approval_requested") return undefined;
  return decisions.get(record.event.request.requestId);
}

export function questionResolutionMap(records: BrevynAgentTimelineRecord[]): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  for (const record of records) {
    if (isRuntimeRecord(record) && record.event.type === "ask_user_resolved") {
      map.set(record.event.requestId, record.event.answers);
    }
  }
  return map;
}

export function questionAnswers(record: AgentTimelineRecord, answers: Map<string, Record<string, string>>): Record<string, string> | undefined {
  if (!isRuntimeRecord(record) || record.event.type !== "ask_user_requested") return undefined;
  return answers.get(record.event.request.requestId);
}

export function exitPlanResolutionMap(records: BrevynAgentTimelineRecord[]): Map<string, "approve" | "deny"> {
  const map = new Map<string, "approve" | "deny">();
  for (const record of records) {
    if (isRuntimeRecord(record) && record.event.type === "exit_plan_resolved") {
      map.set(record.event.requestId, record.event.decision);
    }
  }
  return map;
}

export function exitPlanDecision(record: AgentTimelineRecord, decisions: Map<string, "approve" | "deny">): "approve" | "deny" | undefined {
  if (!isRuntimeRecord(record) || record.event.type !== "exit_plan_requested") return undefined;
  return decisions.get(record.event.request.requestId);
}

export function defaultQuestionAnswers(request: AgentAskUserRequest): Record<string, string> {
  const result: Record<string, string> = {};
  request.questions.forEach((question, index) => {
    const firstOption = question.options[0]?.label;
    result[answerKey(question.question, index)] = firstOption || "";
  });
  return result;
}

export function answerKey(question: string, index: number): string {
  return question.trim() || `question_${index + 1}`;
}

export function nextQuestionAnswer(current: string, option: string, multiSelect: boolean): string {
  if (!multiSelect) return option;
  const selected = current.split(",").map((item) => item.trim()).filter(Boolean);
  const next = selected.includes(option) ? selected.filter((item) => item !== option) : [...selected, option];
  return next.join(", ");
}
