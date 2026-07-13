import { useState } from "react";
import { Check, ChevronDown, ChevronUp, Circle, ListTodo, Loader2, Square } from "lucide-react";
import type { AgentTodoItem } from "@/components/agent/agentTimelineModel";

export function TodoDock({ todos, running }: { todos: AgentTodoItem[]; running: boolean }) {
  const [open, setOpen] = useState(false);
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const focusedTodo = running
    ? todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending") ?? todos.at(-1)
    : todos.at(-1);
  const pending = todos.length - completed;
  const focusedText = focusedTodo?.status === "in_progress" && focusedTodo.activeContent
    ? focusedTodo.activeContent
    : focusedTodo?.content;
  return (
    <div className="brevyn-composer-tray pointer-events-auto w-full overflow-hidden rounded-2xl">
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-220 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="px-3 pb-3 pt-2">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-foreground">任务进度</p>
                <p className="text-[11px] text-muted-foreground">{completed}/{todos.length} 已完成</p>
              </div>
            </div>
            <div className="max-h-40 space-y-1 overflow-y-auto pr-1 brevyn-scrollbar">
              {todos.map((todo, index) => (
                <TodoRow key={`${todo.content}-${index}`} todo={todo} running={running} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <button
        type="button"
        className="brevyn-task-progress-button flex h-9 w-full items-center gap-2 px-3 text-[11px] transition hover:brightness-[0.985]"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-label="切换任务进度"
      >
        {running ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[hsl(var(--status-warning))]" /> : completed === todos.length ? <Check className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--status-success))]" /> : <ListTodo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
        <span className="shrink-0 font-semibold text-foreground">任务进度</span>
        <span className="shrink-0 font-semibold text-foreground">{completed}/{todos.length}</span>
        <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
          {focusedText || `${pending} 项待处理`}
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronUp className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </button>
    </div>
  );
}

function TodoRow({ todo, running }: { todo: AgentTodoItem; running: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-xl px-2 py-1.5 text-[11px] transition ${
        todo.status === "in_progress" && running ? "bg-[hsl(var(--foreground)/0.065)] text-foreground" : "text-muted-foreground"
      }`}
    >
      {todo.status === "completed" ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-[hsl(var(--status-success))]" />
      ) : todo.status === "in_progress" && running ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[hsl(var(--status-warning))]" />
      ) : todo.status === "in_progress" ? (
        <Square className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      ) : (
        <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
      )}
      <span className={`${todo.status === "completed" ? "line-through opacity-70" : ""} truncate`}>
        {todo.status === "in_progress" && todo.activeContent ? todo.activeContent : todo.content}
      </span>
    </div>
  );
}
