import { ToolDetailsShell } from "@/components/agent/tool-cards/shared";
import type { ToolCardHelpers, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/types";
import { getParsedToolResult, recordObject, stringValue } from "@/components/agent/tool-cards/toolModel";

export function isTodoTool(toolName: string): boolean {
  return toolName === "TodoRead" || toolName === "TodoWrite";
}

export function TodoResultDetails({
  toolUse,
  result,
}: {
  toolUse: ToolUseBlock;
  result?: ToolResultBlock;
} & ToolCardHelpers) {
  const inputTodos = todoItemsFromInput(toolUse.input);
  const outputTodos = result && !result.isError ? todoItemsFromOutput(result) : [];
  const todos = inputTodos.length > 0 ? inputTodos : outputTodos;
  const counts = todoCounts(todos);

  return (
    <ToolDetailsShell className="px-3 py-2">
      <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
        <span>待办 {counts.pending}</span>
        <span>进行中 {counts.inProgress}</span>
        <span>已完成 {counts.completed}</span>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-muted-foreground">
        任务面板已同步，工具卡不重复展开完整 JSON。
      </p>
    </ToolDetailsShell>
  );
}

interface TodoSummary {
  content: string;
  status: string;
}

function todoItemsFromInput(input: unknown): TodoSummary[] {
  const data = recordObject(input);
  const todos = Array.isArray(data.todos) ? data.todos : [];
  return todos.map((item) => todoSummary(item)).filter((item) => item.content || item.status);
}

function todoItemsFromOutput(result: ToolResultBlock): TodoSummary[] {
  const root = getParsedToolResult(result);
  const data = recordObject(root);
  const todos = Array.isArray(data.todos) ? data.todos : Array.isArray(root) ? root : [];
  return todos.map((item) => todoSummary(item)).filter((item) => item.content || item.status);
}

function todoSummary(item: unknown): TodoSummary {
  const data = recordObject(item);
  return {
    content: stringValue(data.content ?? data.title ?? data.text, ""),
    status: stringValue(data.status, ""),
  };
}

function todoCounts(todos: TodoSummary[]): { pending: number; inProgress: number; completed: number } {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const todo of todos) {
    if (todo.status === "completed") completed += 1;
    else if (todo.status === "in_progress") inProgress += 1;
    else pending += 1;
  }
  return { pending, inProgress, completed };
}
