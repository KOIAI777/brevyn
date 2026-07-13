import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BrevynAgentTimelineRecord } from "@/types/domain";

export type AgentTimelineIdentityRecord = BrevynAgentTimelineRecord;

const renderIdCache = new WeakMap<object, string>();
let renderIdCounter = 0;

export function recordCreatedAtMs(record: unknown): number | undefined {
  if (isRuntimeRecord(record)) {
    const parsed = Date.parse(record.event.createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  const createdAt = (record as { _createdAt?: unknown })._createdAt;
  if (typeof createdAt === "number") return createdAt;
  const timestamp = (record as { timestamp?: unknown }).timestamp;
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function timelineRecordIdentity(record: AgentTimelineIdentityRecord): string {
  if (isRuntimeRecord(record)) {
    return `runtime:${record.event.type}:${runtimeIdentityPayload(record.event)}:${stableRecordSignature(record.event)}`;
  }
  const maybeUuid = (record as { uuid?: unknown }).uuid;
  if (typeof maybeUuid === "string" && maybeUuid.trim()) return `uuid:${maybeUuid.trim()}`;
  const message = record as SDKMessage;
  return `${message.type}:${recordCreatedAtMs(message) ?? ""}:${stableRecordSignature(message)}`;
}

export function timelineRecordRenderKey(record: AgentTimelineIdentityRecord, prefix = "record"): string {
  if (isRuntimeRecord(record)) {
    return `runtime:${record.event.type}:${runtimeIdentityPayload(record.event)}`;
  }
  const maybeUuid = (record as { uuid?: unknown }).uuid;
  if (typeof maybeUuid === "string" && maybeUuid.trim()) return `uuid:${maybeUuid.trim()}`;
  const explicitRenderId = (record as { _renderId?: unknown })._renderId;
  if (typeof explicitRenderId === "string" && explicitRenderId.trim()) return explicitRenderId.trim();
  if (record && typeof record === "object") {
    if (!renderIdCache.has(record)) renderIdCache.set(record, `${prefix}-${++renderIdCounter}`);
    return renderIdCache.get(record)!;
  }
  return `${prefix}-${++renderIdCounter}`;
}

function isRuntimeRecord(record: unknown): record is Extract<BrevynAgentTimelineRecord, { kind: "runtime" }> {
  return Boolean(record && typeof record === "object" && "kind" in record && record.kind === "runtime");
}

function runtimeIdentityPayload(event: object): string {
  const payload = recordObject(event);
  const runId = stringValue(payload.runId, "");
  const requestId = stringValue(payload.requestId, "");
  const detail = stringValue(payload.reason ?? payload.error, "");
  const createdAt = stringValue(payload.createdAt, "");
  return [runId, requestId, detail, createdAt].filter(Boolean).join(":");
}

function stableRecordSignature(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (!json) return "";
    return hashString(json);
  } catch {
    return hashString(String(value));
  }
}

function hashString(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}
