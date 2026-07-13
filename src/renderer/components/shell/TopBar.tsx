import { Pencil, RefreshCw } from "lucide-react";
import { CourseTaskInfoSummary } from "@/components/courses/CourseTaskInfo";
import type { Course, Thread, BrevynTask } from "@/types/domain";

export function TopBar({
  course,
  task,
  thread,
  workspaceScope,
  taskInfoRunning = false,
  onEditTaskInfo,
  onOrganizeTaskInfo,
}: {
  course?: Course;
  task?: BrevynTask;
  thread?: Thread;
  workspaceScope: string;
  taskInfoRunning?: boolean;
  onEditTaskInfo?: (task: BrevynTask) => void;
  onOrganizeTaskInfo?: (task: BrevynTask) => void;
}) {
  const title = task?.title || thread?.title || course?.name || "Brevyn";
  const taskDeliverable = task
    ? task.info?.deliverable || displayTaskSummary(task) || "尚未整理任务要求"
    : "";
  const subtitleParts = [
    task ? course?.name : undefined,
    thread?.title && thread.title !== title ? thread.title : undefined,
    task || thread?.taskId ? "Task workspace" : course?.workspaceKind === "semester_home" || thread?.threadType === "semester_home" ? "Semester workspace" : course ? "Course workspace" : workspaceScope,
  ].filter(Boolean);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 bg-card/75 px-4 backdrop-blur transition-colors duration-200">
      {task ? (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
            <div className="min-w-[4.5rem] max-w-[11rem] shrink truncate text-sm font-semibold text-foreground" title={title}>
              {title}
            </div>
            <span aria-hidden="true" className="h-4 w-px shrink-0 bg-border/70" />
            <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">课程任务信息</span>
            <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/88" title={taskDeliverable}>
              {taskDeliverable}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <CourseTaskInfoSummary task={task} compact singleLine />
            <span aria-hidden="true" className="h-4 w-px bg-border/60" />
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.96]"
              onClick={() => onEditTaskInfo?.(task)}
              disabled={!onEditTaskInfo}
              aria-label="编辑课程任务信息"
              title="编辑课程任务信息"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => onOrganizeTaskInfo?.(task)}
              disabled={!onOrganizeTaskInfo || taskInfoRunning}
              aria-label={task.info ? "重新整理课程任务信息" : "整理课程任务信息"}
              title={task.info ? "重新整理课程任务信息" : "整理课程任务信息"}
            >
              <RefreshCw className={`h-3.5 w-3.5 ${taskInfoRunning ? "animate-spin" : ""}`} />
            </button>
          </div>
        </>
      ) : (
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{title}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {subtitleParts.length > 0 ? subtitleParts.join(" · ") : "No active session"}
          </div>
        </div>
      )}
    </header>
  );
}

function displayTaskSummary(task: BrevynTask): string {
  const summary = task.summary.trim();
  return summary === "Custom task created locally." ? "" : summary;
}
