import { Check, RotateCcw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { cx } from "@/lib/cn";
import type { BrevynTask, Thread } from "../../../../types/domain";
import { displayArchivedTaskStatus, formatArchiveDate, shortId } from "./archiveFormatters";

export function ArchiveMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <span className="font-medium text-foreground">{value}</span>
      <span> {label.toLowerCase()}</span>
    </div>
  );
}

export function ArchivePanel({ icon, title, count, children }: { icon: ReactNode; title: string; count: number; children: ReactNode }) {
  return (
    <section className="rounded-lg border bg-background/65 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold">
          {icon}
          {title}
        </div>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{count}</span>
      </div>
      {children}
    </section>
  );
}

export function ArchivedThreadRow({
  thread,
  restoreBlocked,
  busyKey,
  selected,
  onSelect,
  onRestore,
  onDelete,
}: {
  thread: Thread;
  restoreBlocked: boolean;
  busyKey: string;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background/80 px-3 py-2">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <ArchiveCheckbox checked={selected} label={`选择会话 ${thread.title}`} onChange={onSelect} />
        <div className="min-w-0">
          <div className="break-words text-xs font-medium leading-5" title={thread.title}>{thread.title}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {thread.threadType === "semester_home" ? "主页会话" : `任务会话 · ${shortId(thread.taskId || thread.id)}`} · 归档于 {formatArchiveDate(thread.archivedAt)}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <ArchiveActionButton
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          label="恢复"
          disabled={restoreBlocked}
          busy={busyKey === `thread:restore:${thread.id}`}
          onClick={onRestore}
        />
        <ArchiveActionButton
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label="删除"
          danger
          busy={busyKey === `thread:delete:${thread.id}`}
          onClick={onDelete}
        />
      </div>
    </div>
  );
}

export function ArchivedTaskRow({
  task,
  restoreBlocked,
  busyKey,
  selected,
  onSelect,
  onRestore,
  onDelete,
}: {
  task: BrevynTask;
  restoreBlocked: boolean;
  busyKey: string;
  selected: boolean;
  onSelect: (checked: boolean) => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background/80 px-3 py-2">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <ArchiveCheckbox checked={selected} label={`选择任务 ${task.title}`} onChange={onSelect} />
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="break-words text-xs font-medium leading-5" title={task.title}>{task.title}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{task.taskType}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{displayArchivedTaskStatus(task.status)}</span>
          </div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            任务 · {shortId(task.id)} · 归档于 {formatArchiveDate(task.archivedAt)}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <ArchiveActionButton
          icon={<RotateCcw className="h-3.5 w-3.5" />}
          label="恢复"
          disabled={restoreBlocked}
          busy={busyKey === `task:restore:${task.id}`}
          onClick={onRestore}
        />
        <ArchiveActionButton
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label="删除"
          danger
          busy={busyKey === `task:delete:${task.id}`}
          onClick={onDelete}
        />
      </div>
    </div>
  );
}

export function ArchiveCheckbox({ checked, label, onChange }: { checked: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={checked}
      className={cx(
        "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition",
        checked ? "border-foreground/30 bg-foreground text-background shadow-sm" : "border-border bg-background text-transparent hover:border-foreground/30 hover:bg-accent",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!checked);
      }}
    >
      <Check className="h-3.5 w-3.5" />
    </button>
  );
}

export function ArchiveActionButton({
  icon,
  label,
  onClick,
  disabled,
  busy,
  danger,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[10px] font-medium transition disabled:cursor-not-allowed disabled:opacity-45",
        danger ? "bg-card text-muted-foreground hover:bg-red-50 hover:text-red-700" : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      disabled={disabled || busy}
      onClick={onClick}
    >
      {icon}
      {busy ? "处理中..." : label}
    </button>
  );
}
