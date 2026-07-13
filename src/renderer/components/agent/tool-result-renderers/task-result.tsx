import { ToolDetailsShell } from "@/components/agent/tool-cards/shared";
import type { AgentTaskSummary, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/toolModel";
import {
  getParsedToolResult,
  getTaskFromResult,
  getTasksFromResult,
  isTaskTool,
  recordObject,
  stringValue,
  taskStatusLabel,
} from "@/components/agent/tool-cards/toolModel";
import type { ToolCardHelpers } from "@/components/agent/tool-cards/types";

export { isTaskTool };

export function TaskResultDetails({
  toolUse,
  result,
}: {
  toolUse: ToolUseBlock;
  result?: ToolResultBlock;
} & ToolCardHelpers) {
  if (!result) return <TaskInputSummary toolUse={toolUse} />;
  if (toolUse.name === "TaskList") return <TaskListDetails result={result} />;
  if (toolUse.name === "TaskUpdate") return <TaskUpdateDetails result={result} />;
  return <TaskSingleDetails result={result} emptyLabel={toolUse.name === "TaskGet" ? "没有找到任务。" : "任务已处理。"} />;
}

function TaskInputSummary({ toolUse }: { toolUse: ToolUseBlock }) {
  const input = recordObject(toolUse.input);
  const subject = stringValue(input.subject ?? input.taskId, "");
  const description = stringValue(input.description, "");
  return (
    <ToolDetailsShell className="px-3 py-2">
      <div className="space-y-1 text-[11px] leading-5 text-muted-foreground">
        {subject && <div><span className="text-foreground/80">任务</span> · {subject}</div>}
        {description && <div className="whitespace-pre-wrap">{description}</div>}
      </div>
    </ToolDetailsShell>
  );
}

function TaskSingleDetails({ result, emptyLabel }: { result: ToolResultBlock; emptyLabel: string }) {
  const task = getTaskFromResult(result);
  if (!task) {
    return (
      <ToolDetailsShell className="px-3 py-2 text-[11px] text-muted-foreground">
        {emptyLabel}
      </ToolDetailsShell>
    );
  }
  return (
    <ToolDetailsShell className="px-3 py-2">
      <TaskRow task={task} expanded />
    </ToolDetailsShell>
  );
}

function TaskUpdateDetails({ result }: { result: ToolResultBlock }) {
  const parsed = recordObject(getParsedToolResult(result));
  const success = parsed.success !== false;
  const taskId = stringValue(parsed.taskId, "");
  const fields = Array.isArray(parsed.updatedFields) ? parsed.updatedFields.flatMap((field) => typeof field === "string" ? [field] : []) : [];
  const statusChange = recordObject(parsed.statusChange);
  const from = stringValue(statusChange.from, "");
  const to = stringValue(statusChange.to, "");
  const error = stringValue(parsed.error, "");
  return (
    <ToolDetailsShell className="px-3 py-2">
      <div className="space-y-2 text-[11px] leading-5 text-muted-foreground">
        <div className="font-medium text-foreground/85">{success ? "任务已更新" : "任务更新失败"}{taskId ? ` · ${taskId}` : ""}</div>
        {from || to ? <div>状态：{taskStatusLabel(from)} → {taskStatusLabel(to)}</div> : null}
        {fields.length > 0 && <div>字段：{fields.join("、")}</div>}
        {error && <div className="text-red-500">{error}</div>}
      </div>
    </ToolDetailsShell>
  );
}

function TaskListDetails({ result }: { result: ToolResultBlock }) {
  const tasks = getTasksFromResult(result);
  if (tasks.length === 0) {
    return (
      <ToolDetailsShell className="px-3 py-2 text-[11px] text-muted-foreground">
        暂无任务。
      </ToolDetailsShell>
    );
  }
  return (
    <ToolDetailsShell className="divide-y divide-border/60">
      {tasks.map((task) => <TaskRow key={task.id || task.subject} task={task} />)}
    </ToolDetailsShell>
  );
}

function TaskRow({ task, expanded = false }: { task: AgentTaskSummary; expanded?: boolean }) {
  return (
    <div className="px-3 py-2 text-[11px] leading-5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-medium text-foreground/85">{task.subject || task.id || "未命名任务"}</span>
        {task.status && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{taskStatusLabel(task.status)}</span>}
        {task.owner && <span className="text-muted-foreground">负责人 {task.owner}</span>}
      </div>
      {expanded && task.description && <div className="mt-1 whitespace-pre-wrap text-muted-foreground">{task.description}</div>}
      {expanded && task.id && <div className="mt-1 font-mono text-[10px] text-muted-foreground/80">{task.id}</div>}
      {expanded && task.blockedBy && task.blockedBy.length > 0 && <div className="mt-1 text-muted-foreground">依赖：{task.blockedBy.join("、")}</div>}
      {expanded && task.blocks && task.blocks.length > 0 && <div className="mt-1 text-muted-foreground">阻塞：{task.blocks.join("、")}</div>}
    </div>
  );
}
