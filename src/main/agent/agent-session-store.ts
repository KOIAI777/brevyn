import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrevynAgentRuntimeEvent, BrevynAgentTimelineRecord, Thread } from "../../types/domain";
import { threadMessagesPath } from "../services/workspace-paths";

export class AgentSessionStore {
  constructor(private readonly rootDataDir: string) {}

  append(thread: Thread, record: BrevynAgentTimelineRecord): void {
    const filePath = this.pathForThread(thread);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(record)}\n`, { flag: "a", mode: 0o600 });
  }

  read(thread: Thread): BrevynAgentTimelineRecord[] {
    const filePath = this.pathForThread(thread);
    if (!existsSync(filePath)) return [];
    const records: BrevynAgentTimelineRecord[] = [];
    const content = readFileSync(filePath, "utf8");
    for (const [index, line] of content.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const record = parseEventLine(line);
        if (!isLegacyControlRecord(record)) records.push(record);
      } catch {
        records.push(sessionCorruptedMessage(thread.id, filePath, index + 1));
      }
    }
    return records;
  }

  reconcileInterruptedRuns(thread: Thread): void {
    const records = this.read(thread);
    const openRunId = latestOpenRunId(records);
    if (!openRunId) return;
    const reason = "Brevyn closed before this run wrote a terminal event.";
    this.append(thread, {
      kind: "runtime",
      event: {
        type: "run_interrupted",
        runId: openRunId,
        threadId: thread.id,
        reason,
        createdAt: now(),
      },
    });
    this.append(thread, interruptedResultMessage(reason));
  }

  pathForThread(thread: Pick<Thread, "id" | "semesterId">): string {
    if (!thread.semesterId) {
      throw new Error(`Cannot resolve agent session path: thread ${thread.id} has no semester scope.`);
    }
    return threadMessagesPath(this.rootDataDir, thread.semesterId, thread.id);
  }
}

function parseEventLine(line: string): BrevynAgentTimelineRecord {
  return JSON.parse(line) as BrevynAgentTimelineRecord;
}

function isLegacyControlRecord(record: unknown): boolean {
  return Boolean(record && typeof record === "object" && (record as { kind?: unknown }).kind === "control");
}

function sessionCorruptedMessage(threadId: string, filePath: string, lineNumber: number): BrevynAgentTimelineRecord {
  return {
    type: "system",
    subtype: "session_corrupted",
    thread_id: threadId,
    filePath,
    lineNumber,
    _createdAt: Date.now(),
  } as unknown as BrevynAgentTimelineRecord;
}

function latestOpenRunId(records: BrevynAgentTimelineRecord[]): string | undefined {
  const terminalTypes = new Set<BrevynAgentRuntimeEvent["type"]>(["run_completed", "run_stopped", "run_failed", "run_interrupted"]);
  const terminalRunIds = new Set<string>();
  for (const record of records) {
    if (!isRuntimeRecord(record)) continue;
    const { event } = record;
    if (terminalTypes.has(event.type) && "runId" in event) terminalRunIds.add(event.runId);
  }
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || !isRuntimeRecord(record)) continue;
    const { event } = record;
    if (event.type === "run_started" && !terminalRunIds.has(event.runId)) return event.runId;
  }
  return undefined;
}

function isRuntimeRecord(record: BrevynAgentTimelineRecord): record is Extract<BrevynAgentTimelineRecord, { kind: "runtime" }> {
  return Boolean(record && typeof record === "object" && "kind" in record && record.kind === "runtime");
}

function interruptedResultMessage(message: string): BrevynAgentTimelineRecord {
  return {
    type: "result",
    subtype: "interrupted",
    is_error: true,
    api_error_status: null,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 0,
    result: message,
    stop_reason: "error",
    session_id: "",
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    errors: [message],
    _createdAt: Date.now(),
  } as unknown as BrevynAgentTimelineRecord;
}

function now(): string {
  return new Date().toISOString();
}
