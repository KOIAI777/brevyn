import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  assistantBlocks,
  isRuntimeRecord,
  isStreamEventRecord,
  streamToolInputDelta,
  streamToolUseStart,
  toolResultBlocks,
  userText,
  type AgentTimelineRecord,
  type AgentTodoItem,
} from "@/components/agent/agentTimelineModel";
import { parsePartialToolInput } from "@/components/agent/agentTimelinePartialInput";
import { getTaskFromResult, recordObject, stringValue, type ToolResultBlock, type ToolUseBlock } from "@/components/agent/tool-cards/toolModel";

const TASK_PROGRESS_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);

export function latestTodoList(records: AgentTimelineRecord[]): AgentTodoItem[] {
  return latestTaskProgressList(records);
}

export function latestTaskProgressList(records: AgentTimelineRecord[]): AgentTodoItem[] {
  let latest: AgentTodoItem[] = [];
  let latestProgressUserInputIndex = -1;
  const latestUserInputIndex = lastUserInputIndex(records);
  const resultByToolUseId = toolResultsById(records);
  const taskItems = new Map<string, AgentTodoItem>();
  const streamTaskInputByBlockIndex = new Map<number, string>();
  const streamTaskToolByBlockIndex = new Map<number, ToolUseBlock>();
  for (const [index, record] of records.entries()) {
    if (isStreamEventRecord(record)) {
      const toolUse = streamToolUseStart(record);
      if (toolUse && TASK_PROGRESS_TOOLS.has(toolUse.tool.name)) {
        streamTaskToolByBlockIndex.set(toolUse.index, toolUse.tool);
        const applied = applyToolProgress(toolUse.tool, resultByToolUseId.get(toolUse.tool.id), taskItems);
        if (applied) {
          latest = applied;
          latestProgressUserInputIndex = ownerUserInputIndex(records, index);
        }
      }
      const inputDelta = streamToolInputDelta(record);
      const streamTool = inputDelta ? streamTaskToolByBlockIndex.get(inputDelta.index) : undefined;
      if (inputDelta && streamTool) {
        const previous = streamTaskInputByBlockIndex.get(inputDelta.index) || "";
        const nextInput = `${previous}${inputDelta.partialJson}`;
        streamTaskInputByBlockIndex.set(inputDelta.index, nextInput);
        const parsed = parsePartialToolInput(nextInput);
        const applied = applyToolProgress({ ...streamTool, input: parsed }, resultByToolUseId.get(streamTool.id), taskItems);
        if (applied) {
          latest = applied;
          latestProgressUserInputIndex = ownerUserInputIndex(records, index);
        }
      }
      continue;
    }
    if (isRuntimeRecord(record) || (record as SDKMessage).type !== "assistant") continue;
    for (const block of assistantBlocks(record as SDKMessage)) {
      if (block.type !== "tool_use" || !TASK_PROGRESS_TOOLS.has(block.name)) continue;
      const applied = applyToolProgress(block, resultByToolUseId.get(block.id), taskItems);
      if (!applied) continue;
      latest = applied;
      latestProgressUserInputIndex = ownerUserInputIndex(records, index);
    }
  }
  if (latest.length === 0) return [];
  const completed = latest.every((todo) => todo.status === "completed");
  if (completed && latestUserInputIndex > latestProgressUserInputIndex) return [];
  return latest;
}

function applyToolProgress(
  tool: ToolUseBlock,
  result: ToolResultBlock | undefined,
  taskItems: Map<string, AgentTodoItem>,
): AgentTodoItem[] | null {
  if (tool.name === "TodoWrite") {
    const todos = todosFromInput(tool.input);
    if (todos.length === 0) return null;
    for (const key of Array.from(taskItems.keys())) {
      if (key.startsWith("todo:")) taskItems.delete(key);
    }
    todos.forEach((todo, index) => {
      taskItems.set(`todo:${index}`, { ...todo, id: `todo:${index}` });
    });
    return Array.from(taskItems.values());
  }

  if (tool.name === "TaskCreate") {
    const input = recordObject(tool.input);
    const resultTask = getTaskFromResult(result);
    const taskId = resultTask?.id || stringValue(input.taskId ?? input.task_id ?? input.id, "") || tool.id;
    if (taskId !== tool.id) taskItems.delete(tool.id);
    const content = stringValue(
      input.subject ?? input.title ?? resultTask?.subject ?? input.description,
      "未命名任务",
    );
    taskItems.set(taskId, {
      id: taskId,
      content,
      status: "pending",
      activeContent: stringValue(input.activeForm ?? input.active_form, ""),
    });
    return Array.from(taskItems.values());
  }

  if (tool.name === "TaskUpdate") {
    const input = recordObject(tool.input);
    const taskId = stringValue(input.taskId ?? input.task_id ?? input.id, "");
    if (!taskId) return null;
    const status = normalizeTaskStatus(input.status);
    if (status === "deleted") {
      taskItems.delete(taskId);
      return Array.from(taskItems.values());
    }
    const existing = taskItems.get(taskId);
    taskItems.set(taskId, {
      id: taskId,
      content: stringValue(input.subject ?? input.title, existing?.content || `任务 #${taskId}`),
      status,
      activeContent: stringValue(input.activeForm ?? input.active_form, existing?.activeContent || ""),
    });
    return Array.from(taskItems.values());
  }

  return null;
}

function todosFromInput(input: unknown): AgentTodoItem[] {
  const todos = recordObject(input).todos;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((todo) => {
    const item = recordObject(todo);
    const content = stringValue(item.content ?? item.subject ?? item.title, "");
    if (!content) return [];
    const rawStatus = stringValue(item.status, "pending");
    const status = rawStatus === "completed" || rawStatus === "in_progress" ? rawStatus : "pending";
    return [{
      content,
      status,
      activeContent: stringValue(item.activeForm ?? item.active_form, ""),
    }];
  });
}

function normalizeTaskStatus(value: unknown): AgentTodoItem["status"] | "deleted" {
  const status = stringValue(value, "pending");
  if (status === "completed" || status === "complete" || status === "done") return "completed";
  if (status === "in_progress" || status === "running" || status === "active") return "in_progress";
  if (status === "deleted") return "deleted";
  return "pending";
}

function toolResultsById(records: AgentTimelineRecord[]): Map<string, ToolResultBlock> {
  const results = new Map<string, ToolResultBlock>();
  for (const record of records) {
    if (isRuntimeRecord(record) || isStreamEventRecord(record) || (record as SDKMessage).type !== "user") continue;
    for (const result of toolResultBlocks(record as SDKMessage)) {
      results.set(result.toolUseId, result);
    }
  }
  return results;
}

function lastUserInputIndex(records: AgentTimelineRecord[]): number {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || isRuntimeRecord(record) || (record as SDKMessage).type !== "user") continue;
    if (toolResultBlocks(record as SDKMessage).length || !userText(record as SDKMessage).trim()) continue;
    return index;
  }
  return -1;
}

function ownerUserInputIndex(records: AgentTimelineRecord[], beforeIndex: number): number {
  for (let index = beforeIndex - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (!record || isRuntimeRecord(record) || (record as SDKMessage).type !== "user") continue;
    if (toolResultBlocks(record as SDKMessage).length || !userText(record as SDKMessage).trim()) continue;
    return index;
  }
  return -1;
}
