import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { BrevynAgentRuntimeEvent, ModelProviderConfig } from "@/types/domain";
import { approvalResolutionMap, assistantText, groupIntoTurns, isRuntimeRecord, latestTurnBounds, normalizeTimelineRecords, recordKey, splitTimelineRecords, streamTextDelta, timelineRecordIdentity, type AgentTimelineRecord } from "./agentTimelineModel";
import { defaultContextUsage, latestContextUsage, shouldAutoCompactContext } from "./agentTimelineContextUsage";
import { inferContextWindowTokens, withInferredContextWindow } from "../../../shared/model-context-window";
import { buildTimelineViewGroups, buildTimelineViewItems, stabilizeTimelineViewGroups, type AgentTimelineViewGroup, type AgentTimelineViewItem } from "./useAgentTimelineState";
import { appendAgentLiveMessage, appendAgentRuntimeEvent, clearAgentLiveRecords, clearAllAgentLiveRecords, flushAgentLiveRecords, getAgentLiveRecords, getAgentLiveRunning } from "@/lib/agent-live-store";
import { getToolPhrase } from "@/components/agent/tool-cards/toolModel";

(globalThis as unknown as { window: { requestAnimationFrame: (callback: () => void) => number; cancelAnimationFrame: (id: number) => void } }).window = {
  requestAnimationFrame(callback: () => void) {
    callback();
    return 1;
  },
  cancelAnimationFrame() {
    return undefined;
  },
};

function userText(content: string, uuid: string): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
    parent_tool_use_id: null,
    session_id: "session_fixture",
    uuid,
    _createdAt: 1,
  } as unknown as SDKMessage;
}

function assistant(content: unknown[], uuid: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: uuid,
      type: "message",
      role: "assistant",
      model: "deepseek-v4-pro",
      content,
    },
    parent_tool_use_id: null,
    session_id: "session_fixture",
    uuid,
    _createdAt: 2,
  } as unknown as SDKMessage;
}

function assistantWithoutModel(content: unknown[], uuid: string): SDKMessage {
  return {
    type: "assistant",
    message: {
      id: uuid,
      type: "message",
      role: "assistant",
      content,
    },
    parent_tool_use_id: null,
    session_id: "session_fixture",
    uuid,
    _createdAt: 2,
  } as unknown as SDKMessage;
}

function toolResult(toolUseId: string, content: string, uuid: string): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        is_error: false,
      }],
    },
    parent_tool_use_id: null,
    session_id: "session_fixture",
    uuid,
    _createdAt: 3,
  } as unknown as SDKMessage;
}

function runStarted(modelId: string, runId: string): AgentTimelineRecord {
  return {
    kind: "runtime",
    event: {
      type: "run_started",
      runId,
      threadId: "thread_fixture",
      permissionMode: "auto",
      providerId: "provider_fixture",
      modelId,
      createdAt: "2026-05-16T00:00:00.000Z",
    },
  } as AgentTimelineRecord;
}

function runCompleted(runId: string): AgentTimelineRecord {
  return {
    kind: "runtime",
    event: {
      type: "run_completed",
      runId,
      threadId: "thread_fixture",
      createdAt: "2026-05-16T00:00:02.000Z",
    },
  } as AgentTimelineRecord;
}

function contextUsageUpdated(
  overrides: Partial<Extract<BrevynAgentRuntimeEvent, { type: "context_usage_updated" }>["snapshot"]> = {},
): AgentTimelineRecord {
  const createdAt = overrides.createdAt ?? "2026-05-16T00:00:01.000Z";
  return {
    kind: "runtime",
    event: {
      type: "context_usage_updated",
      snapshot: {
        threadId: "thread_fixture",
        runId: "run_fixture",
        modelId: "claude-sonnet-4-6",
        usedTokens: 120_000,
        maxTokens: 1_000_000,
        percentage: 12,
        createdAt,
        ...overrides,
      },
      createdAt,
    },
  } as AgentTimelineRecord;
}

function approvalRequested(runId: string, requestId: string, toolUseId: string): AgentTimelineRecord {
  return {
    kind: "runtime",
    event: {
      type: "approval_requested",
      request: {
        requestId,
        threadId: "thread_fixture",
        runId,
        toolName: "Bash",
        toolUseId,
        input: { command: "rm -rf tmp" },
        createdAt: "2026-05-16T00:00:01.000Z",
      },
      createdAt: "2026-05-16T00:00:01.000Z",
    },
  } as AgentTimelineRecord;
}

function approvalResolved(runId: string, requestId: string): AgentTimelineRecord {
  return {
    kind: "runtime",
    event: {
      type: "approval_resolved",
      runId,
      threadId: "thread_fixture",
      requestId,
      decision: "allow",
      createdAt: "2026-05-16T00:00:02.000Z",
    },
  } as AgentTimelineRecord;
}

function result(uuid: string): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1000,
    num_turns: 1,
    result: "Workspace summary",
    session_id: "session_fixture",
    uuid,
    _createdAt: 4,
  } as unknown as SDKMessage;
}

function stoppedResult(uuid: string): SDKMessage {
  return {
    ...result(uuid),
    subtype: "stopped_by_user",
    is_error: true,
    result: "Agent run stopped.",
  } as unknown as SDKMessage;
}

function systemCompact(subtype: "compacting" | "compact_boundary" | "compact_failed", uuid: string, message?: string): SDKMessage {
  return {
    type: "system",
    subtype,
    message,
    session_id: "session_fixture",
    uuid,
    _createdAt: 3,
  } as unknown as SDKMessage;
}

function systemPermissionDenied(uuid: string): SDKMessage {
  return {
    type: "system",
    subtype: "permission_denied",
    tool_name: "Bash",
    tool_use_id: "tool_denied",
    message: "Permission denied.",
    decision_reason: "The command looked risky.",
    session_id: "session_fixture",
    uuid,
    _createdAt: 3,
  } as unknown as SDKMessage;
}

function streamEvent(delta: unknown, uuid: string, index?: number): SDKMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      ...(index === undefined ? {} : { index }),
      delta,
    },
    session_id: "session_fixture",
    uuid,
    _createdAt: 3,
  } as unknown as SDKMessage;
}

function streamEventAt(delta: unknown, uuid: string, createdAt: number, index?: number): SDKMessage {
  return {
    ...streamEvent(delta, uuid, index),
    _createdAt: createdAt,
  } as unknown as SDKMessage;
}

function streamToolStart(index: number, block: unknown, uuid: string): SDKMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_start",
      index,
      content_block: block,
    },
    session_id: "session_fixture",
    uuid,
    _createdAt: 3,
  } as unknown as SDKMessage;
}

function streamToolInput(index: number, partialJson: string, uuid: string): SDKMessage {
  return {
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partialJson },
    },
    session_id: "session_fixture",
    uuid,
    _createdAt: 3,
  } as unknown as SDKMessage;
}

function viewItem(record: AgentTimelineRecord, index: number): AgentTimelineViewItem {
  const type = (record as { type?: unknown }).type;
  return {
    record,
    displayKind: type === "user" ? "user-message" : type === "assistant" ? "assistant-final" : "hidden",
    assistantContent: type === "assistant" ? "Assistant text" : undefined,
    stoppedByUser: false,
    processSummary: null,
    processEvents: [],
    processExpanded: false,
    processLockedOpen: false,
    processCollapsible: false,
    processKey: `record-${index}`,
    defaultCollapsed: true,
  };
}

function viewItems(records: AgentTimelineRecord[]): AgentTimelineViewItem[] {
  return buildTimelineViewItems(records, {
    forceProcessOpen: false,
    ownerUserIndexByRecordIndex: records.map(() => 0),
    processCollapsedByKey: {},
    resolvedApprovals: new Map(),
    resolvedExitPlans: new Map(),
    resolvedQuestions: new Map(),
    runSummary: null,
    runSummaryByUserIndex: new Map(),
  });
}

function firstToolEvent(turn: Extract<AgentTimelineViewGroup, { type: "assistant-turn" }> | undefined) {
  const entry = turn?.entries[0];
  if (!entry) return undefined;
  if (entry.type === "tool-group") return entry.toolEvents[0];
  const event = entry.item.processEvents[0];
  return event?.kind === "tool_use" ? event : undefined;
}

const records: AgentTimelineRecord[] = [
  userText("Inspect the workspace and summarize it.", "user_1"),
  assistant([
    { type: "thinking", thinking: "I should inspect the current directory first." },
    { type: "text", text: "I will check the workspace structure first." },
    { type: "tool_use", id: "tool_pwd", name: "Bash", input: { command: "pwd" } },
  ], "assistant_1"),
  toolResult("tool_pwd", "/Users/koi/.brevyn-dev/semesters/semester-fixture", "tool_result_1"),
  assistant([
    { type: "thinking", thinking: "Now I should list the files." },
    { type: "tool_use", id: "tool_glob", name: "Glob", input: { pattern: "**/*" } },
  ], "assistant_2"),
  toolResult("tool_glob", "threads/thread-fixture.jsonl", "tool_result_2"),
  assistant([
    { type: "text", text: "The workspace contains a threads folder with one JSONL timeline file." },
  ], "assistant_final"),
  result("result_1"),
];

const bounds = latestTurnBounds(records);
assert.equal(bounds?.userIndex, 0);
assert.equal(bounds?.resultIndex, 6);

const sdkOrderGroups = buildTimelineViewGroups(records, records.map(viewItem), { activeModelId: "deepseek-v4-pro" });
assert.deepEqual(sdkOrderGroups.map((group) => group.type), ["user", "assistant-turn"]);
const sdkOrderItems = sdkOrderGroups[1]?.type === "assistant-turn" ? sdkOrderGroups[1].items : [];
assert.deepEqual(
  sdkOrderItems.map((item) => item.displayKind),
  ["thinking", "assistant-final", "tool-use", "thinking", "tool-use", "assistant-final"],
);
assert.match(sdkOrderItems[0]?.assistantContent || "", /inspect the current directory/);
assert.match(sdkOrderItems[1]?.assistantContent || "", /workspace structure/);
const pwdTool = sdkOrderItems[2]?.processEvents[0];
assert.equal(pwdTool?.kind, "tool_use");
assert.equal(pwdTool?.kind === "tool_use" ? pwdTool.tool.name : "", "Bash");
assert.equal(pwdTool?.kind === "tool_use" ? pwdTool.result?.content : "", "/Users/koi/.brevyn-dev/semesters/semester-fixture");
const globTool = sdkOrderItems[4]?.processEvents[0];
assert.equal(globTool?.kind, "tool_use");
assert.equal(globTool?.kind === "tool_use" ? globTool.tool.name : "", "Glob");
assert.equal(globTool?.kind === "tool_use" ? globTool.result?.content : "", "threads/thread-fixture.jsonl");
assert.equal(sdkOrderItems[5]?.assistantContent, "The workspace contains a threads folder with one JSONL timeline file.");

const hostedSearchRecords: AgentTimelineRecord[] = [
  userText("Search today's AI news.", "user_search"),
  streamEvent({ type: "thinking_delta", thinking: "I should search the web first." }, "thinking_search"),
  assistant([
    {
      type: "server_tool_use",
      id: "web_search_1",
      name: "WebSearch",
      input: { hosted: true, status: "completed", query: "AI news today" },
    },
    {
      type: "text",
      text: "Here are the latest AI stories.",
      citations: [{
        type: "web_search_result_location",
        url: "https://openai.com/news",
        title: "OpenAI News",
      }],
    },
  ], "assistant_search"),
  result("result_search"),
];

const hostedSearchGroups = buildTimelineViewGroups(hostedSearchRecords, hostedSearchRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const hostedSearchItems = hostedSearchGroups[1]?.type === "assistant-turn" ? hostedSearchGroups[1].items : [];
assert.deepEqual(hostedSearchItems.map((item) => item.displayKind), ["thinking", "tool-use", "assistant-final"]);
assert.match(hostedSearchItems[0]?.assistantContent || "", /search the web/);
const hostedSearchTool = hostedSearchItems[1]?.processEvents?.find((event) => event.kind === "tool_use");
assert.equal(hostedSearchTool?.kind, "tool_use");
assert.equal(hostedSearchTool?.kind === "tool_use" ? hostedSearchTool.tool.name : "", "WebSearch");
assert.equal(hostedSearchTool?.kind === "tool_use" ? hostedSearchTool.result?.isError : true, false);
assert.deepEqual(hostedSearchTool?.kind === "tool_use" ? (hostedSearchTool.result?.content as { links?: unknown[] }).links : [], [{
  title: "OpenAI News",
  url: "https://openai.com/news",
}]);
assert.equal(hostedSearchItems[2]?.assistantContent, "Here are the latest AI stories.");

const singleReadToolRecords: AgentTimelineRecord[] = [
  userText("Read one file.", "user_single_read_tool"),
  assistant([
    { type: "tool_use", id: "tool_single_read", name: "Read", input: { file_path: "notes/week-1.md" } },
    { type: "text", text: "I read it." },
  ], "assistant_single_read_tool"),
  toolResult("tool_single_read", "notes", "tool_single_read_result"),
  result("result_single_read_tool"),
];
const singleReadToolGroups = buildTimelineViewGroups(singleReadToolRecords, singleReadToolRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const singleReadToolTurn = singleReadToolGroups[1]?.type === "assistant-turn" ? singleReadToolGroups[1] : undefined;
assert.deepEqual(singleReadToolTurn?.entries.map((entry) => entry.type), ["tool-group", "item"]);
assert.equal(singleReadToolTurn?.entries[0]?.type === "tool-group" ? singleReadToolTurn.entries[0].summary.parts.join(" ") : "", "已读取 week-1.md");

const failedReadToolRecords: AgentTimelineRecord[] = [
  userText("Read a missing file.", "user_failed_read_tool"),
  assistant([
    { type: "tool_use", id: "tool_failed_read", name: "Read", input: { file_path: "missing.md" } },
    { type: "tool_use", id: "tool_success_read", name: "Read", input: { file_path: "ok.md" } },
    { type: "text", text: "One file was missing." },
  ], "assistant_failed_read_tool"),
  {
    type: "user",
    message: {
      role: "user",
      content: [{
        type: "tool_result",
        tool_use_id: "tool_failed_read",
        content: "ENOENT",
        is_error: true,
      }],
    },
    parent_tool_use_id: null,
    session_id: "session_fixture",
    uuid: "tool_failed_read_result",
    _createdAt: 3,
  } as unknown as SDKMessage,
  toolResult("tool_success_read", "ok", "tool_success_read_result"),
  result("result_failed_read_tool"),
];
const failedReadToolGroups = buildTimelineViewGroups(failedReadToolRecords, failedReadToolRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const failedReadToolTurn = failedReadToolGroups[1]?.type === "assistant-turn" ? failedReadToolGroups[1] : undefined;
assert.equal(failedReadToolTurn?.entries[0]?.type === "tool-group" ? failedReadToolTurn.entries[0].summary.parts.join(" ") : "", "已探索 1 个文件 1 个失败");

const consecutiveToolRecords: AgentTimelineRecord[] = [
  userText("Inspect with several tools.", "user_consecutive_tools"),
  assistant([
    { type: "tool_use", id: "tool_consecutive_pwd", name: "Bash", input: { command: "pwd" } },
    { type: "tool_use", id: "tool_consecutive_glob", name: "Glob", input: { pattern: "**/*" } },
    { type: "tool_use", id: "tool_consecutive_read", name: "Read", input: { file_path: "README.md" } },
    { type: "text", text: "I inspected the workspace." },
  ], "assistant_consecutive_tools"),
  toolResult("tool_consecutive_pwd", "/tmp/workspace", "tool_consecutive_pwd_result"),
  toolResult("tool_consecutive_glob", "README.md", "tool_consecutive_glob_result"),
  toolResult("tool_consecutive_read", "# README", "tool_consecutive_read_result"),
  result("result_consecutive_tools"),
];
const consecutiveToolGroups = buildTimelineViewGroups(consecutiveToolRecords, consecutiveToolRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const consecutiveToolItems = consecutiveToolGroups[1]?.type === "assistant-turn" ? consecutiveToolGroups[1].items : [];
const consecutiveToolTurn = consecutiveToolGroups[1]?.type === "assistant-turn" ? consecutiveToolGroups[1] : undefined;
assert.deepEqual(consecutiveToolItems.map((item) => item.displayKind), ["tool-use", "tool-use", "tool-use", "assistant-final"]);
assert.deepEqual(consecutiveToolTurn?.entries.map((entry) => entry.type), ["tool-group", "item"]);
assert.equal(consecutiveToolTurn?.entries[0]?.key, "tool-tool_consecutive_pwd");
assert.equal(consecutiveToolTurn?.entries[0]?.type === "tool-group" ? consecutiveToolTurn.entries[0].summary.parts.join(" ") : "", "已探索 2 个文件 已运行 1 条命令");
assert.deepEqual(
  consecutiveToolItems.slice(0, 3).map((item) => item.processEvents[0]?.kind === "tool_use" ? item.processEvents[0].tool.name : ""),
  ["Bash", "Glob", "Read"],
);
assert.equal(consecutiveToolItems[3]?.assistantContent, "I inspected the workspace.");

const skillToolRecords: AgentTimelineRecord[] = [
  userText("Use the PDF skill.", "user_skill_tool"),
  assistant([
    { type: "tool_use", id: "tool_skill_pdf", name: "Skill", input: { skill: "brevyn-global-skills:pdf" } },
    { type: "tool_use", id: "tool_skill_bash", name: "Bash", input: { command: "python3 extract.py" } },
    { type: "text", text: "PDF extracted." },
  ], "assistant_skill_tool"),
  toolResult("tool_skill_pdf", "Launching skill: brevyn-global-skills:pdf", "tool_skill_pdf_result"),
  toolResult("tool_skill_bash", "extracted text", "tool_skill_bash_result"),
  result("result_skill_tool"),
];
const skillToolGroups = buildTimelineViewGroups(skillToolRecords, skillToolRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const skillToolTurn = skillToolGroups[1]?.type === "assistant-turn" ? skillToolGroups[1] : undefined;
assert.deepEqual(skillToolTurn?.entries.map((entry) => entry.type), ["tool-group", "item"]);
assert.equal(skillToolTurn?.entries[0]?.type === "tool-group" ? skillToolTurn.entries[0].summary.parts.join(" ") : "", "已运行 1 条命令 已使用 1 个技能");
assert.equal(skillToolTurn?.entries[0]?.type === "tool-group" ? skillToolTurn.entries[0].summary.iconToolName : "", "Bash");

const fragmentedThinkingRecords: AgentTimelineRecord[] = [
  userText("Inspect workspace.", "user_fragmented_thinking"),
  streamEvent({ type: "thinking_delta", thinking: "I " }, "thinking_fragment_1"),
  streamEvent({ type: "thinking_delta", thinking: "should " }, "thinking_fragment_2"),
  streamEvent({ type: "thinking_delta", thinking: "inspect " }, "thinking_fragment_3"),
  streamEvent({ type: "thinking_delta", thinking: "the " }, "thinking_fragment_4"),
  streamEvent({ type: "thinking_delta", thinking: "workspace." }, "thinking_fragment_5"),
  assistant([{ type: "text", text: "Workspace inspected." }], "assistant_fragmented_thinking"),
  result("result_fragmented_thinking"),
];
const fragmentedThinkingGroups = buildTimelineViewGroups(fragmentedThinkingRecords, fragmentedThinkingRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const fragmentedThinkingItems = fragmentedThinkingGroups[1]?.type === "assistant-turn" ? fragmentedThinkingGroups[1].items : [];
assert.deepEqual(fragmentedThinkingItems.map((item) => item.displayKind), ["thinking", "assistant-final"]);
assert.equal(fragmentedThinkingItems[0]?.assistantContent, "I should inspect the workspace.");

assert.equal(recordKey(records[0]!, 0), recordKey(records[0]!, 99));
assert.equal(
  timelineRecordIdentity({ kind: "runtime", event: { type: "run_started", threadId: "thread_fixture", runId: "run_fixture", permissionMode: "auto", createdAt: "2026-05-16T00:00:00.000Z" } } as AgentTimelineRecord),
  timelineRecordIdentity({ kind: "runtime", event: { type: "run_started", threadId: "thread_fixture", runId: "run_fixture", permissionMode: "auto", createdAt: "2026-05-16T00:00:00.000Z" } } as AgentTimelineRecord),
);

const duplicateThinkingRecords: AgentTimelineRecord[] = [
  userText("Think, then answer.", "user_duplicate_thinking"),
  streamEvent({ type: "thinking_delta", thinking: "I should inspect the request first." }, "live_duplicate_thinking"),
  assistant([
    { type: "thinking", thinking: "I should inspect the request first." },
    { type: "text", text: "Done." },
  ], "assistant_duplicate_thinking"),
  result("result_duplicate_thinking"),
];
const duplicateThinkingGroups = buildTimelineViewGroups(duplicateThinkingRecords, duplicateThinkingRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const duplicateThinkingItems = duplicateThinkingGroups[1]?.type === "assistant-turn" ? duplicateThinkingGroups[1].items : [];
assert.deepEqual(duplicateThinkingItems.map((item) => item.displayKind), ["thinking", "assistant-final"]);
assert.equal(duplicateThinkingItems[0]?.assistantContent, "I should inspect the request first.");

const liveMergeRecords = normalizeTimelineRecords(
  [
    userText("Stream an answer.", "user_stream"),
    assistant([{ type: "text", text: "Hello world" }], "assistant_stream_final"),
  ],
  [
    userText("Stream an answer.", "user_stream"),
    streamEvent({ type: "text_delta", text: "Hello " }, "stream_1"),
    streamEvent({ type: "text_delta", text: "world" }, "stream_2"),
    assistant([{ type: "text", text: "Hello world" }], "assistant_stream_final"),
  ],
);
assert.equal(liveMergeRecords.filter((record) => (record as SDKMessage).type === "user").length, 1);
assert.equal(liveMergeRecords.filter((record) => (record as SDKMessage).type === "assistant").length, 1);
assert.equal(liveMergeRecords.filter((record) => (record as SDKMessage).type === "stream_event").length, 2);

const persistedAssistantToReplace = assistant([{ type: "text", text: "Persisted answer." }], "assistant_replace_live");
const liveAssistantReplacement = assistant([{ type: "text", text: "Live answer replacement." }], "assistant_replace_live");
const liveReplacementRecords = normalizeTimelineRecords(
  [userText("Replace assistant.", "user_replace_live"), persistedAssistantToReplace],
  [liveAssistantReplacement],
);
assert.equal(liveReplacementRecords[1], liveAssistantReplacement);
assert.equal(assistantText(liveReplacementRecords[1] as SDKMessage), "Live answer replacement.");

const nextRunAfterTerminalRecords = normalizeTimelineRecords(
  [
    userText("Previous turn.", "user_previous_terminal"),
    assistant([{ type: "text", text: "Previous answer." }], "assistant_previous_terminal"),
    result("result_previous_terminal"),
    runCompleted("run_previous_terminal"),
  ],
  [
    userText("Next turn.", "user_next_live"),
    runStarted("deepseek-v4-pro", "run_next_live"),
  ],
);
assert.deepEqual(
  nextRunAfterTerminalRecords.map((record) => isRuntimeRecord(record) ? record.event.type : (record as SDKMessage).uuid),
  [
    "user_previous_terminal",
    "assistant_previous_terminal",
    "result_previous_terminal",
    "run_completed",
    "user_next_live",
    "run_started",
  ],
);
const liveStreamAfterTerminalRecords = normalizeTimelineRecords(
  [
    userText("Previous terminal turn.", "user_previous_terminal_stream"),
    assistant([{ type: "text", text: "Previous terminal answer." }], "assistant_previous_terminal_stream"),
    result("result_previous_terminal_stream"),
    runCompleted("run_previous_terminal_stream"),
  ],
  [
    streamEventAt({ type: "text_delta", text: "Next live answer." }, "stream_after_terminal", Date.parse("2026-05-16T00:00:03.000Z")),
  ],
);
assert.deepEqual(
  liveStreamAfterTerminalRecords.map((record) => isRuntimeRecord(record) ? record.event.type : (record as SDKMessage).uuid),
  [
    "user_previous_terminal_stream",
    "assistant_previous_terminal_stream",
    "result_previous_terminal_stream",
    "run_completed",
    "stream_after_terminal",
  ],
);
const liveNextTurnStreamRecords = normalizeTimelineRecords(
  [
    userText("Old question.", "user_old_tail"),
    assistant([{ type: "text", text: "Old answer." }], "assistant_old_tail"),
    result("result_old_tail"),
    runCompleted("run_old_tail"),
  ],
  [
    userText("New question.", "user_new_tail"),
    runStarted("deepseek-v4-pro", "run_new_tail"),
    streamEventAt({ type: "text_delta", text: "New streamed answer." }, "stream_new_tail", Date.parse("2026-05-16T00:00:04.000Z")),
  ],
);
assert.deepEqual(
  liveNextTurnStreamRecords.map((record) => isRuntimeRecord(record) ? record.event.type : (record as SDKMessage).uuid),
  [
    "user_old_tail",
    "assistant_old_tail",
    "result_old_tail",
    "run_completed",
    "user_new_tail",
    "run_started",
    "stream_new_tail",
  ],
);
const liveNextTurnGroups = buildTimelineViewGroups(liveNextTurnStreamRecords, liveNextTurnStreamRecords.map(viewItem), {
  effectiveRunning: true,
  runSummary: { runId: "run_new_tail", label: "Thinking", running: true, status: "running" },
});
const liveNextAssistantTurns = liveNextTurnGroups.filter((group): group is Extract<AgentTimelineViewGroup, { type: "assistant-turn" }> => group.type === "assistant-turn");
assert.equal(liveNextAssistantTurns.length, 2);
assert.equal(liveNextAssistantTurns[0]?.items.find((item) => item.displayKind === "assistant-final")?.assistantContent, "Old answer.");
assert.equal(liveNextAssistantTurns[1]?.items.find((item) => item.displayKind === "assistant-final")?.assistantContent, "New streamed answer.");
const nextRunSummary = { runId: "run_next_live", label: "Thinking", running: true, status: "running" as const };
const nextRunGroups = buildTimelineViewGroups(
  nextRunAfterTerminalRecords,
  nextRunAfterTerminalRecords.map(viewItem),
  { effectiveRunning: true, runSummary: nextRunSummary },
);
const nextRunLastGroup = nextRunGroups.at(-1);
assert.equal(nextRunLastGroup?.type, "assistant-turn");
assert.equal(nextRunLastGroup?.type === "assistant-turn" ? nextRunLastGroup.processItem?.processSummary?.runId : "", "run_next_live");

const streamFinalGroups = buildTimelineViewGroups(liveMergeRecords, liveMergeRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const streamFinalItems = streamFinalGroups[1]?.type === "assistant-turn" ? streamFinalGroups[1].items : [];
assert.deepEqual(streamFinalItems.map((item) => item.displayKind), ["assistant-final"]);
assert.equal(streamFinalItems[0]?.assistantContent, "Hello world");
assert.equal((streamFinalItems[0]?.record as SDKMessage | undefined)?.type, "assistant");

const mismatchedStreamIndexRecords: AgentTimelineRecord[] = [
  userText("Stream text, then finalize with shifted block index.", "user_shifted_stream"),
  streamEvent({ type: "text_delta", text: "Hello " }, "stream_shifted_1", 0),
  streamEvent({ type: "text_delta", text: "world" }, "stream_shifted_2", 0),
  assistant([
    { type: "thinking", thinking: "Preparing." },
    { type: "text", text: "Hello world" },
  ], "assistant_shifted_stream_final"),
];
const mismatchedStreamIndexGroups = buildTimelineViewGroups(mismatchedStreamIndexRecords, mismatchedStreamIndexRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const mismatchedStreamIndexItems = mismatchedStreamIndexGroups[1]?.type === "assistant-turn" ? mismatchedStreamIndexGroups[1].items : [];
assert.deepEqual(mismatchedStreamIndexItems.map((item) => item.displayKind), ["thinking", "assistant-final"]);
assert.equal(mismatchedStreamIndexItems[1]?.assistantContent, "Hello world");

const duplicateFinalRecords: AgentTimelineRecord[] = [
  userText("Avoid duplicate final text.", "user_duplicate_final"),
  assistant([{ type: "text", text: "好的，我来一步步完成这个任务。" }], "assistant_duplicate_final_live"),
  assistant([{ type: "text", text: "好的，我来一步步完成这个任务。" }], "assistant_duplicate_final_persisted"),
  streamEvent({ type: "text_delta", text: "好的，我来一步步完成这个任务。" }, "stream_duplicate_after_final", 0),
];
const duplicateFinalGroups = buildTimelineViewGroups(duplicateFinalRecords, duplicateFinalRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const duplicateFinalItems = duplicateFinalGroups[1]?.type === "assistant-turn" ? duplicateFinalGroups[1].items : [];
assert.deepEqual(duplicateFinalItems.map((item) => item.displayKind), ["assistant-final"]);
assert.equal(duplicateFinalItems[0]?.assistantContent, "好的，我来一步步完成这个任务。");

const runningStreamFinalGroups = buildTimelineViewGroups(liveMergeRecords, liveMergeRecords.map(viewItem), { activeModelId: "deepseek-v4-pro", effectiveRunning: true });
const runningStreamFinalItems = runningStreamFinalGroups[1]?.type === "assistant-turn" ? runningStreamFinalGroups[1].items : [];
assert.deepEqual(runningStreamFinalItems.map((item) => item.displayKind), ["assistant-final"]);
assert.equal(runningStreamFinalItems[0]?.assistantContent, "Hello world");

const runningMismatchedFinalRecords: AgentTimelineRecord[] = [
  userText("Stream, then final arrives early.", "user_running_mismatch"),
  streamEvent({ type: "text_delta", text: "中文流式段落。" }, "stream_running_mismatch", 2),
  assistant([
    { type: "text", text: "English final text should not render while running." },
    { type: "tool_use", id: "tool_running_mismatch", name: "Read", input: { file_path: "a.md" } },
    { type: "text", text: "中文流式段落。" },
  ], "assistant_running_mismatch"),
];
const runningMismatchedGroups = buildTimelineViewGroups(runningMismatchedFinalRecords, runningMismatchedFinalRecords.map(viewItem), { activeModelId: "deepseek-v4-pro", effectiveRunning: true });
const runningMismatchedItems = runningMismatchedGroups[1]?.type === "assistant-turn" ? runningMismatchedGroups[1].items : [];
assert.deepEqual(runningMismatchedItems.map((item) => item.displayKind), ["assistant-final", "tool-use", "assistant-final"]);
assert.equal(runningMismatchedItems[2]?.assistantContent, "中文流式段落。");

const streamBeforeToolRecords = normalizeTimelineRecords(
  [
    userText("Narrate, run a tool, then conclude.", "user_stream_tool_order"),
    assistant([
      { type: "text", text: "I will inspect the workspace first." },
      { type: "tool_use", id: "tool_stream_order_pwd", name: "Bash", input: { command: "pwd" } },
      { type: "text", text: "The workspace path is available now." },
    ], "assistant_stream_tool_order"),
    toolResult("tool_stream_order_pwd", "/tmp/workspace", "tool_stream_order_pwd_result"),
  ],
  [
    streamEvent({ type: "text_delta", text: "I will inspect the workspace first." }, "stream_tool_order_text", 0),
    streamToolStart(1, { type: "tool_use", id: "tool_stream_order_pwd", name: "Bash", input: {} }, "stream_tool_order_start"),
  ],
);
const streamBeforeToolGroups = buildTimelineViewGroups(streamBeforeToolRecords, streamBeforeToolRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const streamBeforeToolItems = streamBeforeToolGroups[1]?.type === "assistant-turn" ? streamBeforeToolGroups[1].items : [];
assert.deepEqual(streamBeforeToolItems.map((item) => item.displayKind), ["assistant-final", "tool-use", "assistant-final"]);
assert.equal(streamBeforeToolItems[1]?.processEvents[0]?.kind === "tool_use" ? streamBeforeToolItems[1]?.processEvents[0]?.tool.name : "", "Bash");
assert.equal(streamBeforeToolItems[2]?.assistantContent, "The workspace path is available now.");

const shiftedToolIndexRecords = normalizeTimelineRecords(
  [
    userText("Read two files.", "user_shifted_tool_index"),
    assistant([
      { type: "text", text: "I will read both files." },
      { type: "tool_use", id: "tool_shifted_read_a", name: "Read", input: { file_path: "tool-group-a.md" } },
      { type: "tool_use", id: "tool_shifted_read_b", name: "Read", input: { file_path: "tool-group-b.md" } },
    ], "assistant_shifted_tool_index"),
    toolResult("tool_shifted_read_a", "a", "tool_shifted_read_a_result"),
    toolResult("tool_shifted_read_b", "b", "tool_shifted_read_b_result"),
  ],
  [
    streamToolStart(0, { type: "tool_use", id: "tool_shifted_read_a", name: "Read", input: {} }, "stream_shifted_tool_a"),
    streamToolInput(0, "{\"file_path\":\"tool-group-a.md\"}", "stream_shifted_tool_a_input"),
    streamToolStart(1, { type: "tool_use", id: "tool_shifted_read_b", name: "Read", input: {} }, "stream_shifted_tool_b"),
    streamToolInput(1, "{\"file_path\":\"tool-group-b.md\"}", "stream_shifted_tool_b_input"),
  ],
);
const shiftedToolIndexGroups = buildTimelineViewGroups(shiftedToolIndexRecords, shiftedToolIndexRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const shiftedToolIndexItems = shiftedToolIndexGroups[1]?.type === "assistant-turn" ? shiftedToolIndexGroups[1].items : [];
assert.deepEqual(shiftedToolIndexItems.map((item) => item.displayKind), ["assistant-final", "tool-use", "tool-use"]);
assert.deepEqual(
  shiftedToolIndexItems.filter((item) => item.displayKind === "tool-use").map((item) => item.processEvents[0]?.kind === "tool_use" ? item.processEvents[0].tool.id : ""),
  ["tool_shifted_read_a", "tool_shifted_read_b"],
);

const runningMultiReadGroups = buildTimelineViewGroups(
  [
    userText("Read two files.", "user_running_multi_read"),
    streamToolStart(0, { type: "tool_use", id: "tool_running_read_a", name: "Read", input: {} }, "stream_running_read_a"),
    streamToolInput(0, "{\"file_path\":\"alpha.md\"}", "stream_running_read_a_input"),
    streamToolStart(1, { type: "tool_use", id: "tool_running_read_b", name: "Read", input: {} }, "stream_running_read_b"),
    streamToolInput(1, "{\"file_path\":\"beta.md\"}", "stream_running_read_b_input"),
  ],
  [
    userText("Read two files.", "user_running_multi_read"),
    streamToolStart(0, { type: "tool_use", id: "tool_running_read_a", name: "Read", input: {} }, "stream_running_read_a"),
    streamToolInput(0, "{\"file_path\":\"alpha.md\"}", "stream_running_read_a_input"),
    streamToolStart(1, { type: "tool_use", id: "tool_running_read_b", name: "Read", input: {} }, "stream_running_read_b"),
    streamToolInput(1, "{\"file_path\":\"beta.md\"}", "stream_running_read_b_input"),
  ].map((record, index) => ({
    ...viewItem(record, index),
    processSummary: index === 0 ? null : { runId: "run_running_multi_read", label: "运行中", running: true, status: "running" as const },
  })),
  { activeModelId: "deepseek-v4-pro", effectiveRunning: true },
);
const runningMultiReadTurn = runningMultiReadGroups[1]?.type === "assistant-turn" ? runningMultiReadGroups[1] : undefined;
const runningMultiReadEntry = runningMultiReadTurn?.entries[0];
assert.equal(runningMultiReadEntry?.type === "tool-group" ? runningMultiReadEntry.summary.parts.join(" ") : "", "正在读取 beta.md");
assert.equal(runningMultiReadEntry?.type === "tool-group" ? runningMultiReadEntry.summary.running : false, true);

const outOfOrderRecords: AgentTimelineRecord[] = [
  assistant([{ type: "text", text: "This arrived before the user in live replay." }], "assistant_out_of_order"),
  userText("Keep the user as the turn boundary.", "user_out_of_order"),
];
const outOfOrderGroups = buildTimelineViewGroups(outOfOrderRecords, outOfOrderRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
assert.deepEqual(outOfOrderGroups.map((group) => group.type), ["user", "assistant-turn"]);
assert.equal(outOfOrderGroups[0]?.type === "user" ? outOfOrderGroups[0].item.record : null, outOfOrderRecords[1]);
assert.equal(outOfOrderGroups[1]?.type === "assistant-turn" ? outOfOrderGroups[1].items[0]?.record : null, outOfOrderRecords[0]);

const outOfOrderStreamRecords: AgentTimelineRecord[] = [
  streamEvent({ type: "text_delta", text: "Streaming before user replay settled." }, "stream_out_of_order"),
  userText("The stream still belongs below me.", "user_stream_out_of_order"),
];
const outOfOrderStreamGroups = buildTimelineViewGroups(outOfOrderStreamRecords, outOfOrderStreamRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
assert.deepEqual(outOfOrderStreamGroups.map((group) => group.type), ["user", "assistant-turn"]);
assert.equal(outOfOrderStreamGroups[0]?.type === "user" ? outOfOrderStreamGroups[0].item.record : null, outOfOrderStreamRecords[1]);
assert.equal(outOfOrderStreamGroups[1]?.type === "assistant-turn" ? outOfOrderStreamGroups[1].items[0]?.record : null, outOfOrderStreamRecords[0]);
assert.equal(outOfOrderStreamGroups[1]?.type === "assistant-turn" ? outOfOrderStreamGroups[1].items[0]?.assistantContent : "", "Streaming before user replay settled.");

const compactingBoundaryRecords: AgentTimelineRecord[] = [
  userText("Compact and continue.", "user_compacting_boundary"),
  assistant([{ type: "text", text: "Before compact." }], "assistant_before_compacting"),
  systemCompact("compacting", "system_compacting_boundary"),
  assistant([{ type: "text", text: "After compact." }], "assistant_after_compacting"),
];
const compactingBoundaryGroups = groupIntoTurns(compactingBoundaryRecords, "deepseek-v4-pro");
assert.deepEqual(compactingBoundaryGroups.map((group) => group.type), ["user", "assistant-turn", "system", "assistant-turn"]);
assert.deepEqual(
  compactingBoundaryGroups
    .filter((group) => group.type === "assistant-turn")
    .map((group) => group.assistantMessages.map((message) => assistantText(message)).join(" ")),
  ["Before compact.", "After compact."],
);

const compactStatusRecords: AgentTimelineRecord[] = [
  userText("/compact", "user_compact_status"),
  systemCompact("compacting", "system_compacting_status"),
  result("result_compact_status"),
  systemCompact("compact_boundary", "system_compact_complete_status"),
];
const compactStatusItems = viewItems(compactStatusRecords);
const compactStatusGroups = buildTimelineViewGroups(compactStatusRecords, compactStatusItems, { activeModelId: "deepseek-v4-pro" });
assert.deepEqual(compactStatusGroups.map((group) => group.type), ["system"]);
assert.equal(compactStatusGroups[0]?.type === "system" ? compactStatusGroups[0].item.displayKind : "", "compact-complete");
assert.equal(compactStatusGroups[0]?.key, "system-compact-0");

const compactFailedRecords: AgentTimelineRecord[] = [
  userText("/compact", "user_compact_failed_status"),
  systemCompact("compacting", "system_compacting_failed_status"),
  result("result_compact_failed_status"),
  systemCompact("compact_failed", "system_compact_failed_status", "Error during compaction: summarization produced empty response"),
];
const compactFailedItems = viewItems(compactFailedRecords);
const compactFailedGroups = buildTimelineViewGroups(compactFailedRecords, compactFailedItems, { activeModelId: "deepseek-v4-pro" });
assert.deepEqual(compactFailedGroups.map((group) => group.type), ["system"]);
assert.equal(compactFailedGroups[0]?.type === "system" ? compactFailedGroups[0].item.displayKind : "", "compact-failed");
assert.equal(compactFailedGroups[0]?.type === "system" ? compactFailedGroups[0].item.assistantContent : "", "Error during compaction: summarization produced empty response");
assert.equal(compactFailedGroups[0]?.key, "system-compact-0");

const thinkingOnlyStreamRecords: AgentTimelineRecord[] = [
  userText("Think first.", "user_thinking_stream_only"),
  streamEvent({ type: "thinking_delta", thinking: "I should inspect the request first." }, "thinking_stream_only"),
];
const thinkingOnlyStreamGroups = buildTimelineViewGroups(
  thinkingOnlyStreamRecords,
  thinkingOnlyStreamRecords.map(viewItem),
  { activeModelId: "deepseek-v4-pro", effectiveRunning: true, runSummary: { runId: "run_stream", label: "Thinking", running: true, status: "running" }, forceProcessOpen: true },
);
assert.deepEqual(thinkingOnlyStreamGroups.map((group) => group.type), ["user", "assistant-turn"]);
const thinkingOnlyTurn = thinkingOnlyStreamGroups[1]?.type === "assistant-turn" ? thinkingOnlyStreamGroups[1] : undefined;
assert.equal(thinkingOnlyTurn?.processItem?.displayKind, "process");
assert.deepEqual(thinkingOnlyTurn?.items.map((item) => item.displayKind), ["thinking"]);
assert.equal(thinkingOnlyTurn?.items[0]?.assistantContent, "I should inspect the request first.");

const stableRunSummary = { runId: "run_stable_completion", label: "已处理 1s", running: false, status: "completed" } as const;
const liveCompletionRecords: AgentTimelineRecord[] = [
  userText("Write a short answer.", "user_stable_completion"),
  runStarted("deepseek-v4-pro", stableRunSummary.runId),
  streamEvent({ type: "text_delta", text: "Final answer." }, "stream_stable_completion"),
];
const persistedCompletionRecords: AgentTimelineRecord[] = [
  userText("Write a short answer.", "user_stable_completion"),
  runStarted("deepseek-v4-pro", stableRunSummary.runId),
  assistant([{ type: "text", text: "Final answer." }], "assistant_stable_completion"),
  result("result_stable_completion"),
];
const stableTurnItems = (record: AgentTimelineRecord, index: number): AgentTimelineViewItem => ({
  ...viewItem(record, index),
  processSummary: stableRunSummary,
  processKey: `run-${stableRunSummary.runId}`,
});
const liveCompletionGroups = buildTimelineViewGroups(liveCompletionRecords, liveCompletionRecords.map(stableTurnItems), { runSummary: stableRunSummary });
const persistedCompletionGroups = buildTimelineViewGroups(persistedCompletionRecords, persistedCompletionRecords.map(stableTurnItems), { runSummary: stableRunSummary });
assert.equal(
  liveCompletionGroups[1]?.type === "assistant-turn" ? liveCompletionGroups[1].key : "",
  persistedCompletionGroups[1]?.type === "assistant-turn" ? persistedCompletionGroups[1].key : "missing",
);
assert.equal(
  liveCompletionGroups[1]?.type === "assistant-turn" ? liveCompletionGroups[1].entries[0]?.key : "",
  persistedCompletionGroups[1]?.type === "assistant-turn" ? persistedCompletionGroups[1].entries[0]?.key : "missing",
);
const rebuiltPersistedCompletionGroups = buildTimelineViewGroups(persistedCompletionRecords, persistedCompletionRecords.map(stableTurnItems), { runSummary: stableRunSummary });
const stabilizedPersistedCompletionGroups = stabilizeTimelineViewGroups(persistedCompletionGroups, rebuiltPersistedCompletionGroups);
assert.equal(stabilizedPersistedCompletionGroups[0], persistedCompletionGroups[0]);
assert.equal(stabilizedPersistedCompletionGroups[1], persistedCompletionGroups[1]);
const stabilizedLiveCompletionGroups = stabilizeTimelineViewGroups(persistedCompletionGroups, liveCompletionGroups);
assert.notEqual(stabilizedLiveCompletionGroups[1], persistedCompletionGroups[1]);

const overlappingLiveCompletionRecords: AgentTimelineRecord[] = [
  userText("Write a short answer.", "user_stable_completion"),
  runStarted("deepseek-v4-pro", stableRunSummary.runId),
  streamEvent({ type: "text_delta", text: "Final answer." }, "stream_stable_completion"),
  result("result_stable_completion"),
  { kind: "runtime", event: { type: "run_completed", runId: stableRunSummary.runId, threadId: "thread_fixture", createdAt: "2026-05-16T00:00:01.000Z" } } as AgentTimelineRecord,
];
const normalizedOverlappingCompletion = normalizeTimelineRecords(persistedCompletionRecords, overlappingLiveCompletionRecords);
assert.equal((normalizedOverlappingCompletion[0] as SDKMessage | undefined)?.type, "user");
assert.equal((normalizedOverlappingCompletion[1] as Extract<AgentTimelineRecord, { kind: "runtime" }> | undefined)?.kind, "runtime");
assert.equal((normalizedOverlappingCompletion[2] as SDKMessage | undefined)?.type, "assistant");
const splitOverlappingCompletion = splitTimelineRecords(persistedCompletionRecords, overlappingLiveCompletionRecords);
assert.equal(splitOverlappingCompletion.historyRecords.length, persistedCompletionRecords.length);
assert.equal(splitOverlappingCompletion.liveTailRecords.length, 1);
const settledLiveStreamCompletionRecords: AgentTimelineRecord[] = [
  userText("Write a short answer.", "user_stable_completion"),
  runStarted("deepseek-v4-pro", stableRunSummary.runId),
  streamEvent({ type: "text_delta", text: "Final answer." }, `live-stream:${stableRunSummary.runId}:0:0:text`),
  result("result_stable_completion"),
  runCompleted(stableRunSummary.runId),
];
const splitSettledLiveStreamCompletion = splitTimelineRecords(persistedCompletionRecords, settledLiveStreamCompletionRecords);
assert.equal(splitSettledLiveStreamCompletion.historyRecords.length, persistedCompletionRecords.length);
assert.equal(splitSettledLiveStreamCompletion.liveTailRecords.length, 0);
const prefixLiveCompletionRecords: AgentTimelineRecord[] = [
  userText("Write a short answer.", "user_stable_completion"),
  runStarted("deepseek-v4-pro", stableRunSummary.runId),
  streamEvent({ type: "text_delta", text: "Final" }, "stream_stable_completion_prefix"),
];
const splitPrefixCompletion = splitTimelineRecords(persistedCompletionRecords, prefixLiveCompletionRecords);
assert.equal(splitPrefixCompletion.liveTailRecords.length, 1);
const normalizedOverlappingGroups = buildTimelineViewGroups(
  normalizedOverlappingCompletion,
  normalizedOverlappingCompletion.map(stableTurnItems),
  { runSummary: stableRunSummary },
);
assert.equal(
  persistedCompletionGroups[1]?.type === "assistant-turn" ? persistedCompletionGroups[1].key : "",
  normalizedOverlappingGroups[1]?.type === "assistant-turn" ? normalizedOverlappingGroups[1].key : "missing",
);
assert.equal(
  persistedCompletionGroups[1]?.type === "assistant-turn" ? persistedCompletionGroups[1].entries[0]?.key : "",
  normalizedOverlappingGroups[1]?.type === "assistant-turn" ? normalizedOverlappingGroups[1].entries[0]?.key : "missing",
);

const runStartAttachedRecords: AgentTimelineRecord[] = [
  userText("Attach run start to assistant turn.", "user_run_start_attached"),
  runStarted("deepseek-v4-pro", "run_start_attached"),
  assistant([{ type: "text", text: "Answer after run start." }], "assistant_run_start_attached"),
];
const runStartAttachedSummary = { runId: "run_start_attached", label: "已处理 1s", running: false, status: "completed" } as const;
const runStartAttachedItems = buildTimelineViewItems(runStartAttachedRecords, {
  forceProcessOpen: false,
  ownerUserIndexByRecordIndex: [0, 0, 0],
  processCollapsedByKey: {},
  resolvedApprovals: new Map(),
  resolvedExitPlans: new Map(),
  resolvedQuestions: new Map(),
  runSummary: runStartAttachedSummary,
  runSummaryByUserIndex: new Map([[0, runStartAttachedSummary]]),
});
const runStartAttachedGroups = buildTimelineViewGroups(runStartAttachedRecords, runStartAttachedItems, {
  runSummary: runStartAttachedSummary,
});
assert.deepEqual(runStartAttachedGroups.map((group) => group.type), ["user", "assistant-turn"]);
assert.equal(runStartAttachedGroups[1]?.type === "assistant-turn" ? runStartAttachedGroups[1].processItem?.processKey : "", "run-run_start_attached");

const approvalRunId = "run_approval_live_merge";
const approvalRequestId = "approval_live_merge";
const approvalToolUseId = "tool_approval_live_merge";
const approvalPersistedRecords: AgentTimelineRecord[] = [
  userText("Run a risky command.", "user_approval_live_merge"),
  runStarted("deepseek-v4-pro", approvalRunId),
  streamToolStart(0, { type: "tool_use", id: approvalToolUseId, name: "Bash", input: { command: "rm -rf tmp" } }, "stream_approval_tool_start"),
  approvalRequested(approvalRunId, approvalRequestId, approvalToolUseId),
];
const approvalMergedRecords = normalizeTimelineRecords(
  approvalPersistedRecords,
  [approvalResolved(approvalRunId, approvalRequestId)],
);
const approvalMergedItems = buildTimelineViewItems(approvalMergedRecords, {
  forceProcessOpen: false,
  ownerUserIndexByRecordIndex: approvalMergedRecords.map((_, index) => index === 0 ? -1 : 0),
  processCollapsedByKey: {},
  resolvedApprovals: approvalResolutionMap(approvalMergedRecords),
  resolvedExitPlans: new Map(),
  resolvedQuestions: new Map(),
  runSummary: { runId: approvalRunId, label: "运行中", running: true, status: "running" },
  runSummaryByUserIndex: new Map([[0, { runId: approvalRunId, label: "运行中", running: true, status: "running" }]]),
});
const approvalMergedGroups = buildTimelineViewGroups(approvalMergedRecords, approvalMergedItems, {
  effectiveRunning: true,
  runSummary: { runId: approvalRunId, label: "运行中", running: true, status: "running" },
});
assert.equal(approvalMergedItems.some((item) => item.displayKind === "approval-request"), false);
assert.equal(
  approvalMergedGroups.filter((group) => group.type === "assistant-turn").length,
  1,
);

const liveToolRecords: AgentTimelineRecord[] = [
  userText("Run pwd.", "user_live_tool"),
  streamToolStart(0, { type: "tool_use", id: "tool_live_pwd", name: "Bash", input: {} }, "stream_tool_start"),
  streamToolInput(0, "{\"command\":\"pwd\"}", "stream_tool_input"),
];
const liveToolGroups = buildTimelineViewGroups(
  liveToolRecords,
  liveToolRecords.map(viewItem),
  { activeModelId: "deepseek-v4-pro", effectiveRunning: true, runSummary: { runId: "run_live_tool", label: "已处理 1s", running: true, status: "running" } },
);
const liveToolItems = liveToolGroups[1]?.type === "assistant-turn" ? liveToolGroups[1].items : [];
assert.equal(liveToolGroups[1]?.type === "assistant-turn" ? liveToolGroups[1].processItem?.displayKind : undefined, "process");
assert.deepEqual(liveToolItems.map((item) => item.displayKind), ["tool-use"]);
const liveToolEvent = liveToolItems[0]?.processEvents[0];
assert.equal(liveToolEvent?.kind, "tool_use");
assert.equal(liveToolEvent?.kind === "tool_use" ? liveToolEvent.tool.name : "", "Bash");
assert.equal(liveToolEvent?.kind === "tool_use" ? (liveToolEvent.tool.input as { command?: string }).command : "", "pwd");

const livePartialInputGroups = buildTimelineViewGroups(
  [
    userText("Read a file.", "user_live_partial_input"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_partial_read", name: "Read", input: {} }, "stream_tool_partial_start"),
    streamToolInput(0, "{\"file_path\":\"notes", "stream_tool_partial_input"),
  ],
  [
    userText("Read a file.", "user_live_partial_input"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_partial_read", name: "Read", input: {} }, "stream_tool_partial_start"),
    streamToolInput(0, "{\"file_path\":\"notes", "stream_tool_partial_input"),
  ].map(viewItem),
  { activeModelId: "deepseek-v4-pro", effectiveRunning: true },
);
const livePartialTurn = livePartialInputGroups[1]?.type === "assistant-turn" ? livePartialInputGroups[1] : undefined;
const livePartialEvent = firstToolEvent(livePartialTurn);
assert.equal((livePartialEvent?.tool.input as { file_path?: string } | undefined)?.file_path, undefined);
assert.equal((livePartialEvent?.tool.input as { _partialInput?: boolean } | undefined)?._partialInput, undefined);
assert.equal(livePartialEvent?.tool.name, "Read");

const liveCompleteInputGroups = buildTimelineViewGroups(
  [
    userText("Read a file.", "user_live_complete_input"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_complete_read", name: "Read", input: {} }, "stream_tool_complete_start"),
    streamToolInput(0, "{\"file_path\":\"debate-guidelines.pdf\"}", "stream_tool_complete_input"),
  ],
  [
    userText("Read a file.", "user_live_complete_input"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_complete_read", name: "Read", input: {} }, "stream_tool_complete_start"),
    streamToolInput(0, "{\"file_path\":\"debate-guidelines.pdf\"}", "stream_tool_complete_input"),
  ].map(viewItem),
  { activeModelId: "deepseek-v4-pro", effectiveRunning: true },
);
const liveCompleteTurn = liveCompleteInputGroups[1]?.type === "assistant-turn" ? liveCompleteInputGroups[1] : undefined;
const liveCompleteInput = firstToolEvent(liveCompleteTurn)?.tool.input as { file_path?: string; _partialInput?: boolean } | undefined ?? {};
assert.equal(liveCompleteInput.file_path, "debate-guidelines.pdf");
assert.equal(liveCompleteInput._partialInput, undefined);

const liveWritePartialInputGroups = buildTimelineViewGroups(
  [
    userText("Write a long file.", "user_live_write_partial_input"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_partial_write", name: "Write", input: {} }, "stream_tool_partial_write_start"),
    streamToolInput(0, "{\"file_path\":\"draft.md\",\"content\":\"", "stream_tool_partial_write_path"),
    streamToolInput(0, "x".repeat(10000), "stream_tool_partial_write_content"),
  ],
  [
    userText("Write a long file.", "user_live_write_partial_input"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_partial_write", name: "Write", input: {} }, "stream_tool_partial_write_start"),
    streamToolInput(0, "{\"file_path\":\"draft.md\",\"content\":\"", "stream_tool_partial_write_path"),
    streamToolInput(0, "x".repeat(10000), "stream_tool_partial_write_content"),
  ].map(viewItem),
  { activeModelId: "deepseek-v4-pro", effectiveRunning: true },
);
const liveWritePartialTurn = liveWritePartialInputGroups[1]?.type === "assistant-turn" ? liveWritePartialInputGroups[1] : undefined;
const liveWritePartialInput = firstToolEvent(liveWritePartialTurn)?.tool.input as { file_path?: string; content?: string } | undefined ?? {};
assert.equal(liveWritePartialInput.file_path, "draft.md");
assert.equal(liveWritePartialInput.content, undefined);

const liveWriteCompleteInputGroups = buildTimelineViewGroups(
  [
    userText("Write a file.", "user_live_write_complete_input"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_complete_write", name: "Write", input: {} }, "stream_tool_complete_write_start"),
    streamToolInput(0, "{\"file_path\":\"draft.md\",\"content\":\"hello\\nworld\"}", "stream_tool_complete_write_input"),
  ],
  [
    userText("Write a file.", "user_live_write_complete_input"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_complete_write", name: "Write", input: {} }, "stream_tool_complete_write_start"),
    streamToolInput(0, "{\"file_path\":\"draft.md\",\"content\":\"hello\\nworld\"}", "stream_tool_complete_write_input"),
  ].map(viewItem),
  { activeModelId: "deepseek-v4-pro", effectiveRunning: true },
);
const liveWriteCompleteTurn = liveWriteCompleteInputGroups[1]?.type === "assistant-turn" ? liveWriteCompleteInputGroups[1] : undefined;
const liveWriteCompleteInput = firstToolEvent(liveWriteCompleteTurn)?.tool.input as { file_path?: string; content?: string } | undefined ?? {};
assert.equal(liveWriteCompleteInput.file_path, "draft.md");
assert.equal(liveWriteCompleteInput.content, undefined);

const liveEditPartialPathGroups = buildTimelineViewGroups(
  [
    userText("Edit a file.", "user_live_edit_partial_path"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_partial_edit", name: "Edit", input: {} }, "stream_tool_partial_edit_start"),
    streamToolInput(0, "{\"file_path\":\"draft.md", "stream_tool_partial_edit_path"),
  ],
  [
    userText("Edit a file.", "user_live_edit_partial_path"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_partial_edit", name: "Edit", input: {} }, "stream_tool_partial_edit_start"),
    streamToolInput(0, "{\"file_path\":\"draft.md", "stream_tool_partial_edit_path"),
  ].map(viewItem),
  { activeModelId: "deepseek-v4-pro", effectiveRunning: true },
);
const liveEditPartialPathTurn = liveEditPartialPathGroups[1]?.type === "assistant-turn" ? liveEditPartialPathGroups[1] : undefined;
const liveEditPartialPathInput = firstToolEvent(liveEditPartialPathTurn)?.tool.input as { file_path?: string; old_string?: string } | undefined ?? {};
assert.equal(liveEditPartialPathInput.file_path, undefined);
assert.equal(liveEditPartialPathInput.old_string, undefined);

const liveEditCompletePathGroups = buildTimelineViewGroups(
  [
    userText("Edit a file.", "user_live_edit_complete_path"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_complete_path_edit", name: "Edit", input: {} }, "stream_tool_complete_path_edit_start"),
    streamToolInput(0, "{\"file_path\":\"draft.md\",\"old_string\":\"", "stream_tool_complete_path_edit_path"),
  ],
  [
    userText("Edit a file.", "user_live_edit_complete_path"),
    streamToolStart(0, { type: "tool_use", id: "tool_live_complete_path_edit", name: "Edit", input: {} }, "stream_tool_complete_path_edit_start"),
    streamToolInput(0, "{\"file_path\":\"draft.md\",\"old_string\":\"", "stream_tool_complete_path_edit_path"),
  ].map(viewItem),
  { activeModelId: "deepseek-v4-pro", effectiveRunning: true },
);
const liveEditCompletePathTurn = liveEditCompletePathGroups[1]?.type === "assistant-turn" ? liveEditCompletePathGroups[1] : undefined;
const liveEditCompletePathInput = firstToolEvent(liveEditCompletePathTurn)?.tool.input as { file_path?: string; old_string?: string } | undefined ?? {};
assert.equal(liveEditCompletePathInput.file_path, "draft.md");
assert.equal(liveEditCompletePathInput.old_string, undefined);

const runningToolGroupTitleGroups = buildTimelineViewGroups(
  [
    userText("Read then edit.", "user_running_tool_group_title"),
    streamToolStart(0, { type: "tool_use", id: "tool_title_read", name: "Read", input: {} }, "stream_title_read_start"),
    streamToolInput(0, "{\"file_path\":\"old.md\"}", "stream_title_read_input"),
    streamToolStart(1, { type: "tool_use", id: "tool_title_edit", name: "Edit", input: {} }, "stream_title_edit_start"),
    streamToolInput(1, "{\"file_path\":\"draft.md\"}", "stream_title_edit_input"),
  ],
  [
    userText("Read then edit.", "user_running_tool_group_title"),
    streamToolStart(0, { type: "tool_use", id: "tool_title_read", name: "Read", input: {} }, "stream_title_read_start"),
    streamToolInput(0, "{\"file_path\":\"old.md\"}", "stream_title_read_input"),
    streamToolStart(1, { type: "tool_use", id: "tool_title_edit", name: "Edit", input: {} }, "stream_title_edit_start"),
    streamToolInput(1, "{\"file_path\":\"draft.md\"}", "stream_title_edit_input"),
  ].map(viewItem),
  { activeModelId: "deepseek-v4-pro", effectiveRunning: true },
);
const runningToolGroupTitleTurn = runningToolGroupTitleGroups[1]?.type === "assistant-turn" ? runningToolGroupTitleGroups[1] : undefined;
assert.equal(runningToolGroupTitleTurn?.entries[0]?.type === "tool-group" ? runningToolGroupTitleTurn.entries[0].summary.parts.join(" ") : "", "正在编辑 draft.md");

const streamToolWithResultOnlyRecords: AgentTimelineRecord[] = [
  userText("Read, then answer.", "user_stream_tool_result_only"),
  streamToolStart(0, { type: "tool_use", id: "tool_stream_read", name: "Read", input: {} }, "stream_tool_result_only_start"),
  streamToolInput(0, "{\"file_path\":\"notes.md\"}", "stream_tool_result_only_input"),
  toolResult("tool_stream_read", "note contents", "tool_stream_read_result"),
  assistant([{ type: "text", text: "I read the file." }], "assistant_stream_tool_result_only_final"),
  result("result_stream_tool_result_only"),
];
const streamToolWithResultOnlyGroups = buildTimelineViewGroups(streamToolWithResultOnlyRecords, streamToolWithResultOnlyRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
const streamToolWithResultOnlyItems = streamToolWithResultOnlyGroups[1]?.type === "assistant-turn" ? streamToolWithResultOnlyGroups[1].items : [];
assert.deepEqual(streamToolWithResultOnlyItems.map((item) => item.displayKind), ["tool-use", "assistant-final"]);
const streamToolWithResultOnlyEvent = streamToolWithResultOnlyItems[0]?.processEvents[0];
assert.equal(streamToolWithResultOnlyEvent?.kind, "tool_use");
assert.equal(streamToolWithResultOnlyEvent?.kind === "tool_use" ? streamToolWithResultOnlyEvent.result?.content : "", "note contents");
assert.equal(streamToolWithResultOnlyItems[0]?.assistantStreaming, false);

const interleavedThinkingToolRecords: AgentTimelineRecord[] = [
  userText("Think, use a tool, then think again.", "user_interleaved_thinking"),
  streamEvent({ type: "thinking_delta", thinking: "First thought. " }, "thinking_interleaved_1", 0),
  streamEvent({ type: "thinking_delta", thinking: "Still first." }, "thinking_interleaved_2", 0),
  streamToolStart(1, { type: "tool_use", id: "tool_interleaved_pwd", name: "Bash", input: {} }, "tool_interleaved_start"),
  streamToolInput(1, "{\"command\":\"pwd\"}", "tool_interleaved_input"),
  streamEvent({ type: "thinking_delta", thinking: "Second thought after the tool." }, "thinking_interleaved_3", 2),
];
const interleavedThinkingGroups = buildTimelineViewGroups(
  interleavedThinkingToolRecords,
  interleavedThinkingToolRecords.map(viewItem),
  { activeModelId: "deepseek-v4-pro", effectiveRunning: true, runSummary: { runId: "run_interleaved", label: "已处理 1s", running: true, status: "running" } },
);
const interleavedThinkingItems = interleavedThinkingGroups[1]?.type === "assistant-turn" ? interleavedThinkingGroups[1].items : [];
assert.deepEqual(interleavedThinkingItems.map((item) => item.displayKind), ["thinking", "tool-use", "thinking"]);
assert.equal(interleavedThinkingItems[0]?.assistantContent, "First thought. Still first.");
assert.equal(interleavedThinkingItems[2]?.assistantContent, "Second thought after the tool.");

const promptSuggestion = {
  type: "prompt_suggestion",
  suggestion: "Do something else",
  uuid: "prompt_suggestion_1",
} as unknown as SDKMessage;
const promptSuggestionRecords = normalizeTimelineRecords([userText("Hi.", "user_prompt_suggestion")], [promptSuggestion]);
assert.equal(promptSuggestionRecords.some((record) => (record as SDKMessage).type === "prompt_suggestion"), false);

const permissionDeniedRecords = normalizeTimelineRecords(
  [userText("Run a risky command.", "user_permission_denied"), systemPermissionDenied("permission_denied_1")],
  [],
);
assert.equal(permissionDeniedRecords.some((record) => (record as SDKMessage & { subtype?: unknown }).subtype === "permission_denied"), true);
const permissionDeniedGroups = groupIntoTurns(permissionDeniedRecords);
assert.equal(permissionDeniedGroups.some((group) => group.type === "system"), true);

const permissionDeniedTurnRecords: AgentTimelineRecord[] = [
  userText("Run a risky command.", "user_permission_denied_turn"),
  assistant([{ type: "tool_use", id: "tool_permission_denied_turn", name: "Bash", input: { command: "cat secret" } }], "assistant_permission_denied_tool"),
  systemPermissionDenied("permission_denied_turn"),
  toolResult("tool_permission_denied_turn", "Permission denied.", "permission_denied_tool_result"),
  assistant([{ type: "text", text: "I'll continue with a safer approach." }], "assistant_permission_denied_recovery"),
];
const permissionDeniedTurnItems = buildTimelineViewItems(permissionDeniedTurnRecords, {
  forceProcessOpen: false,
  ownerUserIndexByRecordIndex: permissionDeniedTurnRecords.map((_, index) => index === 0 ? -1 : 0),
  processCollapsedByKey: {},
  resolvedApprovals: new Map(),
  resolvedExitPlans: new Map(),
  resolvedQuestions: new Map(),
  runSummary: null,
  runSummaryByUserIndex: new Map(),
});
const permissionDeniedTurnGroups = buildTimelineViewGroups(permissionDeniedTurnRecords, permissionDeniedTurnItems);
assert.deepEqual(permissionDeniedTurnGroups.map((group) => group.type), ["user", "assistant-turn"]);
const permissionDeniedTurn = permissionDeniedTurnGroups[1]?.type === "assistant-turn" ? permissionDeniedTurnGroups[1] : undefined;
assert.deepEqual(permissionDeniedTurn?.entries.map((entry) => entry.type === "item" ? entry.item.displayKind : entry.type), ["tool-group", "permission-denied", "assistant-final"]);

const runModelRecords: AgentTimelineRecord[] = [
  userText("Use the selected model for this turn.", "user_run_model"),
  runStarted("claude-opus-4.7", "run_model_stable"),
  assistantWithoutModel([{ type: "text", text: "Model should come from run_started." }], "assistant_run_model"),
];
const runModelGroups = buildTimelineViewGroups(runModelRecords, runModelRecords.map(viewItem), { activeModelId: "gpt-5.5" });
assert.equal(runModelGroups.find((group) => group.type === "assistant-turn")?.model, "claude-opus-4.7");
const runModelGroupsAfterSwitch = buildTimelineViewGroups(runModelRecords, runModelRecords.map(viewItem), { activeModelId: "deepseek-v4-pro" });
assert.equal(runModelGroupsAfterSwitch.find((group) => group.type === "assistant-turn")?.model, "claude-opus-4.7");

const noModelFallbackRecords: AgentTimelineRecord[] = [
  userText("No model metadata yet.", "user_no_model_fallback"),
  assistantWithoutModel([{ type: "text", text: "Do not borrow the active model." }], "assistant_no_model_fallback"),
];
const noModelFallbackGroups = buildTimelineViewGroups(noModelFallbackRecords, noModelFallbackRecords.map(viewItem), { activeModelId: "gpt-5.5" });
assert.equal(noModelFallbackGroups.find((group) => group.type === "assistant-turn")?.model, "");

clearAllAgentLiveRecords();
assert.equal(appendAgentLiveMessage("thread_live", promptSuggestion), false);
assert.equal(getAgentLiveRecords("thread_live").length, 0);
assert.equal(appendAgentLiveMessage("thread_live", assistant([{ type: "text", text: "Live text" }], "assistant_live"), { modelId: "deepseek-v4-pro" }), true);
flushAgentLiveRecords("thread_live");
const liveAssistant = getAgentLiveRecords("thread_live")[0] as SDKMessage & { _createdAt?: unknown; _channelModelId?: unknown };
assert.equal(liveAssistant.type, "assistant");
assert.equal(typeof liveAssistant._createdAt, "number");
assert.equal(liveAssistant._channelModelId, "deepseek-v4-pro");

clearAllAgentLiveRecords();
assert.equal(appendAgentLiveMessage("thread_stream_coalesce", streamEvent({ type: "text_delta", text: "Hello " }, "stream_coalesce_1")), true);
assert.equal(appendAgentLiveMessage("thread_stream_coalesce", streamEvent({ type: "text_delta", text: "world" }, "stream_coalesce_2")), true);
flushAgentLiveRecords("thread_stream_coalesce");
const coalescedStream = getAgentLiveRecords("thread_stream_coalesce");
assert.equal(coalescedStream.length, 1);
assert.equal(streamTextDelta(coalescedStream[0]!), "Hello world");

clearAllAgentLiveRecords();
assert.equal(appendAgentLiveMessage("thread_stream_block_index", streamEvent({ type: "text_delta", text: "First block" }, "stream_block_0", 0)), true);
assert.equal(appendAgentLiveMessage("thread_stream_block_index", streamEvent({ type: "text_delta", text: "Second block" }, "stream_block_1", 1)), true);
flushAgentLiveRecords("thread_stream_block_index");
assert.equal(getAgentLiveRecords("thread_stream_block_index").length, 2);

clearAllAgentLiveRecords();
assert.equal(appendAgentLiveMessage("thread_live", userText("Keep optimistic user visible.", "live_user_before_run_started")), true);
flushAgentLiveRecords("thread_live");
appendAgentRuntimeEvent({ type: "run_started", threadId: "thread_live", runId: "run_live", permissionMode: "auto", createdAt: "2026-05-16T00:00:00.000Z" });
assert.equal(getAgentLiveRunning("thread_live"), true);
assert.equal((getAgentLiveRecords("thread_live")[0] as SDKMessage | undefined)?.uuid, "live_user_before_run_started");
appendAgentRuntimeEvent({ type: "run_completed", threadId: "thread_live", runId: "run_live", resultSubtype: "success", createdAt: "2026-05-16T00:00:01.000Z" });
assert.equal(getAgentLiveRunning("thread_live"), false);

clearAllAgentLiveRecords();
appendAgentRuntimeEvent({ type: "run_started", threadId: "thread_live_guard", runId: "run_old", permissionMode: "auto", createdAt: "2026-05-16T00:00:00.000Z" });
appendAgentRuntimeEvent({ type: "run_started", threadId: "thread_live_guard", runId: "run_new", permissionMode: "auto", createdAt: "2026-05-16T00:00:01.000Z" });
appendAgentRuntimeEvent({ type: "run_completed", threadId: "thread_live_guard", runId: "run_old", resultSubtype: "success", createdAt: "2026-05-16T00:00:02.000Z" });
assert.equal(getAgentLiveRunning("thread_live_guard"), true);
flushAgentLiveRecords("thread_live_guard");
assert.equal(getAgentLiveRecords("thread_live_guard").some((record) => isRuntimeRecord(record) && record.event.type === "run_completed" && record.event.runId === "run_old"), false);
appendAgentRuntimeEvent({ type: "run_completed", threadId: "thread_live_guard", runId: "run_new", resultSubtype: "success", createdAt: "2026-05-16T00:00:03.000Z" });
assert.equal(getAgentLiveRunning("thread_live_guard"), false);

clearAllAgentLiveRecords();
appendAgentRuntimeEvent({ type: "run_started", threadId: "thread_retry", runId: "run_retry", permissionMode: "auto", createdAt: "2026-05-16T00:00:00.000Z" });
appendAgentRuntimeEvent({ type: "run_retrying", threadId: "thread_retry", runId: "run_retry", retryAttempt: 1, maxRetries: 5, reason: "timeout", delayMs: 100, createdAt: "2026-05-16T00:00:01.000Z" });
flushAgentLiveRecords("thread_retry");
assert.equal(getAgentLiveRecords("thread_retry").filter(isRuntimeRetryingEvent).length, 1);
appendAgentRuntimeEvent({ type: "run_retrying", threadId: "thread_retry", runId: "run_retry", retryAttempt: 2, maxRetries: 5, reason: "timeout again", delayMs: 100, createdAt: "2026-05-16T00:00:02.000Z" });
flushAgentLiveRecords("thread_retry");
assert.deepEqual(
  getAgentLiveRecords("thread_retry")
    .filter(isRuntimeRetryingEvent)
    .map((record) => record.event.retryAttempt),
  [2],
);
appendAgentRuntimeEvent({ type: "run_retry_cleared", threadId: "thread_retry", runId: "run_retry", createdAt: "2026-05-16T00:00:03.000Z" });
assert.equal(getAgentLiveRecords("thread_retry").some(isRuntimeRetryingEvent), false);
appendAgentRuntimeEvent({ type: "run_retrying", threadId: "thread_retry", runId: "run_retry", retryAttempt: 3, maxRetries: 5, reason: "timeout final", delayMs: 100, createdAt: "2026-05-16T00:00:04.000Z" });
flushAgentLiveRecords("thread_retry");
appendAgentRuntimeEvent({ type: "run_failed", threadId: "thread_retry", runId: "run_retry", error: "failed", createdAt: "2026-05-16T00:00:05.000Z" });
assert.equal(getAgentLiveRecords("thread_retry").some(isRuntimeRetryingEvent), false);

clearAllAgentLiveRecords();
appendAgentRuntimeEvent({ type: "run_started", threadId: "thread_stopped_partial", runId: "run_stopped_partial", permissionMode: "auto", createdAt: "2026-05-16T00:00:00.000Z" });
assert.equal(appendAgentLiveMessage("thread_stopped_partial", streamEvent({ type: "text_delta", text: "Partial answer before stop." }, "stream_stopped_partial")), true);
assert.equal(appendAgentLiveMessage("thread_stopped_partial", stoppedResult("result_stopped_partial")), true);
flushAgentLiveRecords("thread_stopped_partial");
clearAgentLiveRecords("thread_stopped_partial", { preserveStoppedRuns: true });
assert.equal(getAgentLiveRecords("thread_stopped_partial").some((record) => (record as SDKMessage).type === "stream_event"), true);
appendAgentRuntimeEvent({ type: "run_stopped", threadId: "thread_stopped_partial", runId: "run_stopped_partial", reason: "Agent run stopped.", createdAt: "2026-05-16T00:00:01.000Z" });
flushAgentLiveRecords("thread_stopped_partial");
clearAgentLiveRecords("thread_stopped_partial", { preserveStoppedRuns: true });
assert.equal(getAgentLiveRecords("thread_stopped_partial").some((record) => (record as SDKMessage).type === "stream_event"), true);

clearAllAgentLiveRecords();
appendAgentRuntimeEvent({ type: "run_started", threadId: "thread_stopped_assistant", runId: "run_stopped_assistant", permissionMode: "auto", createdAt: "2026-05-16T00:00:00.000Z" });
assert.equal(appendAgentLiveMessage("thread_stopped_assistant", assistant([{ type: "text", text: "Assistant partial before stop." }], "assistant_stopped_partial")), true);
assert.equal(appendAgentLiveMessage("thread_stopped_assistant", stoppedResult("result_stopped_assistant")), true);
flushAgentLiveRecords("thread_stopped_assistant");
clearAgentLiveRecords("thread_stopped_assistant", { preserveStoppedRuns: true });
assert.equal(getAgentLiveRecords("thread_stopped_assistant").some((record) => (record as SDKMessage).type === "assistant"), true);

clearAllAgentLiveRecords();
appendAgentRuntimeEvent({ type: "run_started", threadId: "thread_completed_partial", runId: "run_completed_partial", permissionMode: "auto", createdAt: "2026-05-16T00:00:00.000Z" });
assert.equal(appendAgentLiveMessage("thread_completed_partial", streamEvent({ type: "text_delta", text: "Partial answer before completion." }, "stream_completed_partial")), true);
appendAgentRuntimeEvent({ type: "run_completed", threadId: "thread_completed_partial", runId: "run_completed_partial", createdAt: "2026-05-16T00:00:01.000Z" });
flushAgentLiveRecords("thread_completed_partial");
clearAgentLiveRecords("thread_completed_partial", { preserveStoppedRuns: true });
assert.equal(getAgentLiveRecords("thread_completed_partial").length, 0);

const stoppedStreamRecords: AgentTimelineRecord[] = [
  userText("Stop after some output.", "user_stopped_stream_view"),
  streamEvent({ type: "text_delta", text: "First partial " }, "stream_stopped_view_1"),
  streamEvent({ type: "text_delta", text: "and second partial." }, "stream_stopped_view_2"),
];
const stoppedStreamItems = stoppedStreamRecords.map((record, index) => ({
  ...viewItem(record, index),
  processSummary: index === 0 ? null : { runId: "run_stopped_view", label: "已停止", running: false, status: "stopped" as const },
}));
const stoppedStreamGroups = buildTimelineViewGroups(stoppedStreamRecords, stoppedStreamItems);
const stoppedStreamTurn = stoppedStreamGroups.find((group) => group.type === "assistant-turn");
const stoppedStreamText = stoppedStreamTurn?.type === "assistant-turn"
  ? stoppedStreamTurn.items.find((item) => item.displayKind === "assistant-final")
  : undefined;
assert.equal(stoppedStreamText?.assistantContent, "First partial and second partial.");
assert.equal(stoppedStreamText?.assistantStreaming, false);
assert.equal(stoppedStreamText?.stoppedByUser, true);

const completedStreamRecords: AgentTimelineRecord[] = [
  userText("Complete after streamed output.", "user_completed_stream_view"),
  streamEvent({ type: "text_delta", text: "Completed **markdown** output." }, "stream_completed_view"),
];
const completedStreamItems = completedStreamRecords.map((record, index) => ({
  ...viewItem(record, index),
  processSummary: index === 0 ? null : { runId: "run_completed_view", label: "已处理", running: false, status: "completed" as const },
}));
const completedStreamGroups = buildTimelineViewGroups(completedStreamRecords, completedStreamItems);
const completedStreamTurn = completedStreamGroups.find((group) => group.type === "assistant-turn");
const completedStreamText = completedStreamTurn?.type === "assistant-turn"
  ? completedStreamTurn.items.find((item) => item.displayKind === "assistant-final")
  : undefined;
assert.equal(completedStreamText?.assistantContent, "Completed **markdown** output.");
assert.equal(completedStreamText?.assistantStreaming, false);
assert.equal(completedStreamText?.stoppedByUser, false);

const claudeProvider = {
  id: "provider_claude",
  purpose: "agent",
  providerKind: "anthropic",
  adapterKind: "anthropic",
  name: "Claude",
  protocol: "anthropic_messages",
  baseUrl: "https://api.anthropic.com",
  apiKeyMasked: "",
  authMode: "api_key",
  selectedModel: "claude-sonnet-4-6",
  models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", enabled: true, contextWindowTokens: 1_000_000, contextWindowSource: "provider" }],
  enabled: true,
  autoCompactThresholdPercent: 80,
  createdAt: "2026-05-16T00:00:00.000Z",
  updatedAt: "2026-05-16T00:00:00.000Z",
} satisfies ModelProviderConfig;
const openAiProvider = {
  id: "provider_openai",
  purpose: "agent",
  providerKind: "openai-responses-agent",
  adapterKind: "openai_responses",
  name: "OpenAI Responses",
  protocol: "openai_responses",
  baseUrl: "https://api.openai.com/v1",
  apiKeyMasked: "",
  authMode: "bearer",
  selectedModel: "gpt-5.5",
  models: [{ id: "gpt-5.5", name: "GPT 5.5", enabled: true, contextWindowTokens: 258_000, contextWindowSource: "provider" }],
  enabled: true,
  autoCompactThresholdPercent: 80,
  createdAt: "2026-05-16T00:00:00.000Z",
  updatedAt: "2026-05-16T00:00:00.000Z",
} satisfies ModelProviderConfig;
const ignoredAssistantUsage = {
  ...assistant([{ type: "text", text: "SDK usage should not drive context" }], "assistant_usage_ignored"),
  _channelProviderId: "provider_claude",
  _channelModelId: "claude-sonnet-4-6",
  message: {
    role: "assistant",
    model: "claude-sonnet-4-6",
    content: [{ type: "text", text: "SDK usage should not drive context" }],
    usage: {
      input_tokens: 12_000,
      output_tokens: 800,
      cache_read_input_tokens: 300_000,
      cache_creation_input_tokens: 500,
    },
  },
} as unknown as SDKMessage;
const ignoredResultUsage = {
  ...result("result_usage_ignored"),
  _channelProviderId: "provider_claude",
  _channelModelId: "claude-sonnet-4-6",
  usage: {
    input_tokens: 9_000,
    output_tokens: 300,
    cache_read_input_tokens: 400_000,
    cache_creation_input_tokens: 0,
  },
  modelUsage: {
    "claude-sonnet-4-6": {
      inputTokens: 80_000,
      outputTokens: 2_000,
      cacheReadInputTokens: 500_000,
      cacheCreationInputTokens: 0,
      contextWindow: 1_000_000,
    },
  },
} as unknown as SDKMessage;
assert.equal(latestContextUsage([ignoredAssistantUsage, ignoredResultUsage], { providers: [claudeProvider], activeProvider: claudeProvider }), null);

const snapshotUsage = latestContextUsage(
  [userText("Read current context.", "user_context_snapshot"), ignoredAssistantUsage, contextUsageUpdated()],
  { providers: [claudeProvider], activeProvider: claudeProvider, activeModelId: "claude-sonnet-4-6" },
);
assert.equal(snapshotUsage?.source, "context_snapshot");
assert.equal(snapshotUsage?.providerId, "provider_claude");
assert.equal(snapshotUsage?.modelId, "claude-sonnet-4-6");
assert.equal(snapshotUsage?.contextInputTokens, 120_000);
assert.equal(snapshotUsage?.contextWindow, 1_000_000);
assert.equal(snapshotUsage?.remainingTokens, 880_000);
assert.equal(snapshotUsage?.percentage, 12);
assert.equal(snapshotUsage?.cacheReadTokens, 300_000);
assert.equal(snapshotUsage?.cacheCreationTokens, 500);
assert.equal(snapshotUsage?.cacheSampleCount, 1);
assert.equal(Math.round((snapshotUsage?.cacheHitRate ?? 0) * 100), 96);

const cacheWindowRecords: AgentTimelineRecord[] = [
  contextUsageUpdated(),
  ...Array.from({ length: 51 }, (_, index) => ({
    ...result(`cache_result_${index}`),
    _brevynUsage: {
      inputTokens: index === 0 ? 1000 : 10,
      outputTokens: 100_000,
      cacheReadTokens: index === 0 ? 0 : 30,
      cacheCreationTokens: 0,
    },
  } as unknown as SDKMessage)),
];
const cacheWindowUsage = latestContextUsage(cacheWindowRecords, { providers: [claudeProvider], activeProvider: claudeProvider });
assert.equal(cacheWindowUsage?.cacheSampleCount, 50);
assert.equal(cacheWindowUsage?.cacheReadTokens, 1500);
assert.equal(Math.round((cacheWindowUsage?.cacheHitRate ?? 0) * 100), 75);

const openAiCachedUsage = latestContextUsage(
  [
    contextUsageUpdated({ modelId: "gpt-5.5" }),
    {
      ...result("openai_cached_tokens"),
      usage: {
        input_tokens: 100,
        output_tokens: 100_000,
        input_tokens_details: {
          cached_tokens: 80,
        },
      },
    } as unknown as SDKMessage,
  ],
  { providers: [openAiProvider], activeProvider: openAiProvider },
);
assert.equal(openAiCachedUsage?.cacheReadTokens, 80);
assert.equal(Math.round((openAiCachedUsage?.cacheHitRate ?? 0) * 100), 80);

const inferredSnapshotUsage = latestContextUsage(
  [contextUsageUpdated({ modelId: "gpt-5.5", usedTokens: 25_000, maxTokens: undefined, rawMaxTokens: undefined, percentage: undefined })],
  { providers: [openAiProvider], activeProvider: openAiProvider },
);
assert.equal(inferredSnapshotUsage?.providerId, "provider_openai");
assert.equal(inferredSnapshotUsage?.contextInputTokens, 25_000);
assert.equal(inferredSnapshotUsage?.contextWindow, 258_000);

const rawWindowSnapshotUsage = latestContextUsage(
  [contextUsageUpdated({ usedTokens: 75_000, maxTokens: undefined, rawMaxTokens: 900_000 })],
  { providers: [claudeProvider], activeProvider: claudeProvider },
);
assert.equal(rawWindowSnapshotUsage?.contextWindow, 900_000);
assert.equal(rawWindowSnapshotUsage?.remainingTokens, 825_000);

const compactedUsage = latestContextUsage(
  [contextUsageUpdated(), systemCompact("compact_boundary", "usage_compact_boundary"), ignoredResultUsage],
  { providers: [claudeProvider], activeProvider: claudeProvider },
);
assert.equal(compactedUsage?.contextInputTokens, 120_000);

const failedCompactUsage = latestContextUsage(
  [contextUsageUpdated(), systemCompact("compact_failed", "usage_compact_failed", "Error during compaction: summarization produced empty response")],
  { providers: [claudeProvider], activeProvider: claudeProvider },
);
assert.equal(failedCompactUsage?.contextInputTokens, 120_000);

const refreshedAfterCompactUsage = latestContextUsage(
  [
    contextUsageUpdated({ usedTokens: 120_000 }),
    systemCompact("compact_boundary", "usage_compact_boundary_refresh"),
    contextUsageUpdated({ usedTokens: 32_000, createdAt: "2026-05-16T00:00:03.000Z" }),
  ],
  { providers: [claudeProvider], activeProvider: claudeProvider },
);
assert.equal(refreshedAfterCompactUsage?.contextInputTokens, 32_000);

const defaultUsage = defaultContextUsage("gpt-5.5", openAiProvider);
assert.equal(defaultUsage?.source, "default");
assert.equal(defaultUsage?.contextWindow, 258_000);
assert.equal(defaultContextUsage("gpt-5.4")?.contextWindow, 1_000_000);
assert.equal(defaultContextUsage("claude-opus-4.7")?.contextWindow, 1_000_000);
assert.equal(defaultContextUsage("claude-opus-4-20250514")?.contextWindow, 1_000_000);
assert.equal(defaultContextUsage("claude-opus-4-7[1m]")?.contextWindow, 1_000_000);
assert.equal(defaultContextUsage("claude-sonnet-5-latest")?.contextWindow, 1_000_000);
assert.equal(inferContextWindowTokens("GLM-5.2"), 1_000_000);
assert.equal(inferContextWindowTokens("glm-5.2"), 1_000_000);
assert.equal(inferContextWindowTokens("qwen3.7-max"), 1_000_000);
assert.equal(inferContextWindowTokens("minimax-m3"), 1_000_000);
assert.equal(inferContextWindowTokens("mimo-v2-pro"), 1_000_000);
assert.equal(inferContextWindowTokens("claude-haiku-4-20250514"), 200_000);
assert.deepEqual(
  withInferredContextWindow({
    id: "claude-opus-4.7",
    name: "Claude Opus 4.7",
    enabled: true,
    contextWindowTokens: 200_000,
    contextWindowSource: "inferred",
  }),
  {
    id: "claude-opus-4.7",
    name: "Claude Opus 4.7",
    enabled: true,
    contextWindowTokens: 1_000_000,
    contextWindowSource: "inferred",
  },
);
assert.equal(shouldAutoCompactContext({ inputTokens: 1_000, contextInputTokens: 1_000, contextWindowSource: "unknown" }, openAiProvider), false);

const runningWritePhrase = getToolPhrase(
  { type: "tool_use", id: "tool_write_running_stats", name: "Write", input: { file_path: "stats.md", content: "one\ntwo\nthree\nfour\nfive\nsix\nseven" } },
);
assert.equal(runningWritePhrase.diffLabel, "");

const completedWritePhrase = getToolPhrase(
  { type: "tool_use", id: "tool_write_stats", name: "Write", input: { file_path: "stats.md", content: "one\ntwo\nthree\nfour\nfive\nsix\nseven" } },
  {
    type: "tool_result",
    toolUseId: "tool_write_stats",
    content: "ok",
    isError: false,
    toolUseResult: {
      filePath: "stats.md",
      gitDiff: { filename: "stats.md", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "" },
    },
  },
);
assert.equal(completedWritePhrase.diffLabel, "+1");

const completedCreatedWritePhrase = getToolPhrase(
  { type: "tool_use", id: "tool_write_create_stats", name: "Write", input: { file_path: "created.md", content: "one\ntwo\nthree\nfour\nfive\nsix\nseven" } },
  {
    type: "tool_result",
    toolUseId: "tool_write_create_stats",
    content: "ok",
    isError: false,
    toolUseResult: {
      type: "create",
      filePath: "created.md",
      originalFile: null,
      content: "one\ntwo\nthree\nfour\nfive\nsix\nseven",
      gitDiff: { filename: "created.md", status: "added", additions: 7, deletions: 0, changes: 7, patch: "" },
    },
  },
);
assert.equal(completedCreatedWritePhrase.diffLabel, "+7");
assert.equal(completedCreatedWritePhrase.label, "已创建");

const completedCreatedWriteWithSdkContentPhrase = getToolPhrase(
  { type: "tool_use", id: "tool_write_create_no_stats", name: "Write", input: { file_path: "created.md", content: "one\ntwo\nthree\nfour\nfive\nsix\nseven" } },
  {
    type: "tool_result",
    toolUseId: "tool_write_create_no_stats",
    content: "ok",
    isError: false,
    toolUseResult: {
      type: "create",
      filePath: "created.md",
      originalFile: null,
      content: "one\ntwo\nthree\nfour\nfive\nsix\nseven",
    },
  },
);
assert.equal(completedCreatedWriteWithSdkContentPhrase.diffLabel, "+7");
assert.equal(completedCreatedWriteWithSdkContentPhrase.label, "已创建");

console.log("agentTimelineModel fixture tests passed");

type RuntimeRetryingRecord = Extract<AgentTimelineRecord, { kind: "runtime" }> & {
  event: Extract<BrevynAgentRuntimeEvent, { type: "run_retrying" }>;
};

function isRuntimeRetryingEvent(record: AgentTimelineRecord): record is RuntimeRetryingRecord {
  return Boolean(record && typeof record === "object" && "kind" in record && record.kind === "runtime" && record.event.type === "run_retrying");
}
