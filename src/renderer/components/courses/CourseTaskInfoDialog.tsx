import { ClipboardCheck, FileCheck2, Loader2, Plus, Save, Trash2, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  BrevynTask,
  CourseTaskDocument,
  CourseTaskRequirement,
  CourseTaskRubricCriterion,
  TaskStatus,
} from "@/types/domain";
import { CourseTaskStatusIcon, taskSourceLabel } from "@/components/courses/CourseTaskInfo";
import { courseTaskInfoContent, courseTaskInfoManualFields, manualFieldsAfterTaskInfoEdit } from "../../../shared/course-task-info";
import { cx } from "@/lib/cn";

const STATUS_OPTIONS: Array<{ value: TaskStatus; label: string }> = [
  { value: "not_started", label: "未开始" },
  { value: "in_progress", label: "进行中" },
  { value: "due_soon", label: "即将截止" },
  { value: "done", label: "已完成" },
];

const REQUIREMENT_CATEGORY_OPTIONS: Array<{ value: CourseTaskRequirement["category"]; label: string }> = [
  { value: "limit", label: "数量与限制" },
  { value: "format", label: "格式" },
  { value: "reference", label: "引用" },
  { value: "submission", label: "提交" },
  { value: "prohibition", label: "禁止事项" },
  { value: "other", label: "其他" },
];

type TaskInfoDraft = {
  status: TaskStatus;
  dueAt: string;
  summary: string;
  deliverable: string;
  requirements: CourseTaskRequirement[];
  rubricCriteria: CourseTaskRubricCriterion[];
  documents: CourseTaskDocument[];
};

export function CourseTaskInfoDialog({
  task,
  onSaved,
  onClose,
}: {
  task: BrevynTask;
  onSaved: (task: BrevynTask) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstInputRef = useRef<HTMLInputElement>(null);
  const [mounted, setMounted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<TaskInfoDraft>(() => taskInfoDraft(task));
  const initialRevisionRef = useRef(taskInfoRevision(task));
  const contentChangedElsewhere = initialRevisionRef.current !== taskInfoRevision(task);
  const titleId = useId();

  useEffect(() => {
    setMounted(true);
    const frame = window.requestAnimationFrame(() => firstInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose, saving]);

  function updateRequirement(index: number, update: Partial<CourseTaskRequirement>) {
    setDraft((current) => ({
      ...current,
      requirements: current.requirements.map((item, itemIndex) => itemIndex === index
        ? { ...item, ...update, source: undefined }
        : item),
    }));
  }

  function updateRubricCriterion(index: number, update: Partial<CourseTaskRubricCriterion>) {
    setDraft((current) => ({
      ...current,
      rubricCriteria: current.rubricCriteria.map((item, itemIndex) => itemIndex === index
        ? { ...item, ...update, source: undefined }
        : item),
    }));
  }

  async function save() {
    if (saving) return;
    const emptyRequirement = draft.requirements.find((item) => !item.text.trim());
    if (emptyRequirement) {
      setError("请填写或删除空白要求。");
      return;
    }
    const emptyCriterion = draft.rubricCriteria.find((item) => !item.title.trim());
    if (emptyCriterion) {
      setError("请填写或删除空白评分维度。");
      return;
    }
    const dueAt = dueAtFromLocalInput(draft.dueAt);
    if (draft.dueAt && !dueAt) {
      setError("Deadline 格式无效，请重新选择。");
      return;
    }

    setSaving(true);
    setError("");
    try {
      const info = taskInfoUpdateFromDraft(draft, task);
      const updated = await window.brevyn.tasks.update({
        id: task.id,
        status: draft.status,
        dueAt: dueAt || null,
        summary: draft.summary.trim(),
        ...(info !== undefined ? { info } : {}),
      });
      onSaved(updated);
      onClose();
    } catch (saveError) {
      setError(errorMessage(saveError, "课程任务信息保存失败。"));
    } finally {
      setSaving(false);
    }
  }

  function handleDialogKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") return;
    const focusable = focusableElements(dialogRef.current);
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[95] flex items-center justify-center bg-foreground/24 p-3 backdrop-blur-sm md:p-6"
      onMouseDown={() => !saving && onClose()}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          "brevyn-floating-surface flex max-h-[calc(100vh-1.5rem)] w-full max-w-[56rem] flex-col overflow-hidden rounded-[var(--radius-window)] text-foreground transition duration-150 ease-out md:max-h-[calc(100vh-3rem)]",
          mounted ? "translate-y-0 scale-100 opacity-100" : "translate-y-2 scale-[0.99] opacity-0",
        )}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-border/55 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-muted text-muted-foreground">
              <ClipboardCheck className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 id={titleId} className="text-sm font-semibold">编辑课程任务信息</h2>
              <p className="mt-1 truncate text-[11px] text-muted-foreground">{task.title}</p>
            </div>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-45"
            onClick={onClose}
            disabled={saving}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 brevyn-scrollbar">
          <section>
            <SectionHeading title="基本信息" description="这些字段会同步显示在课程 Dashboard 和任务会话。" />
            <div className="mt-3 grid gap-4 md:grid-cols-2">
              <div>
                <FieldLabel>任务状态</FieldLabel>
                <div className="mt-1 grid grid-cols-2 gap-1 rounded-[var(--radius-control)] bg-muted/58 p-1 sm:grid-cols-4 md:grid-cols-2 xl:grid-cols-4">
                  {STATUS_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={cx(
                        "inline-flex h-8 items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] px-2 text-[11px] font-medium transition",
                        draft.status === option.value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setDraft((current) => ({ ...current, status: option.value }))}
                    >
                      <CourseTaskStatusIcon status={option.value} className="h-3 w-3" />
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <FieldLabel>Deadline</FieldLabel>
                <div className="relative mt-1">
                  <input
                    type="datetime-local"
                    value={draft.dueAt}
                    onChange={(event) => setDraft((current) => ({ ...current, dueAt: event.target.value }))}
                    className={`${fieldClassName} pr-9`}
                  />
                  {draft.dueAt && (
                    <button
                      type="button"
                      className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                      onClick={() => setDraft((current) => ({ ...current, dueAt: "" }))}
                      title="清除 Deadline"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
              <label className="block md:col-span-2">
                <FieldLabel>交付形式</FieldLabel>
                <input
                  ref={firstInputRef}
                  value={draft.deliverable}
                  onChange={(event) => setDraft((current) => ({ ...current, deliverable: event.target.value }))}
                  placeholder="例如：1,500 字 Essay、3-5 分钟演讲"
                  maxLength={240}
                  className={`mt-1 ${fieldClassName}`}
                />
              </label>
              <label className="block md:col-span-2">
                <FieldLabel>任务摘要</FieldLabel>
                <textarea
                  value={draft.summary}
                  onChange={(event) => setDraft((current) => ({ ...current, summary: event.target.value }))}
                  placeholder="概括这项任务需要完成什么。"
                  maxLength={1200}
                  rows={3}
                  className={`mt-1 ${textAreaClassName}`}
                />
              </label>
            </div>
          </section>

          <section className="mt-6 border-t border-border/55 pt-5">
            <div className="flex items-center justify-between gap-3">
              <SectionHeading title="关键要求" description="字数、格式、引用、提交方式和禁止事项。" />
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-background px-3 text-[11px] font-semibold text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.55)] transition hover:bg-accent hover:text-foreground"
                onClick={() => setDraft((current) => ({
                  ...current,
                  requirements: [...current.requirements, newRequirement()],
                }))}
              >
                <Plus className="h-3.5 w-3.5" />
                添加要求
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {draft.requirements.length > 0 ? draft.requirements.map((requirement, index) => (
                <div key={requirement.id} className="rounded-[var(--radius-card)] border border-border/55 bg-background/52 p-3">
                  <div className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_2rem]">
                    <select
                      value={requirement.category}
                      onChange={(event) => updateRequirement(index, { category: event.target.value as CourseTaskRequirement["category"] })}
                      aria-label="要求类别"
                      className={fieldClassName}
                    >
                      {REQUIREMENT_CATEGORY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    <input
                      value={requirement.text}
                      onChange={(event) => updateRequirement(index, { text: event.target.value })}
                      placeholder="输入一条明确要求"
                      maxLength={800}
                      className={fieldClassName}
                    />
                    <button
                      type="button"
                      className="flex h-9 w-8 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setDraft((current) => ({ ...current, requirements: current.requirements.filter((_, itemIndex) => itemIndex !== index) }))}
                      title="删除要求"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <ProvenanceLine source={requirement.source} />
                </div>
              )) : <EmptyListText>尚未填写要求。</EmptyListText>}
            </div>
          </section>

          <section className="mt-6 border-t border-border/55 pt-5">
            <div className="flex items-center justify-between gap-3">
              <SectionHeading title="Rubric" description="记录评分维度、分值和评价说明。" />
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] bg-background px-3 text-[11px] font-semibold text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.55)] transition hover:bg-accent hover:text-foreground"
                onClick={() => setDraft((current) => ({
                  ...current,
                  rubricCriteria: [...current.rubricCriteria, newRubricCriterion()],
                }))}
              >
                <Plus className="h-3.5 w-3.5" />
                添加维度
              </button>
            </div>
            <div className="mt-3 space-y-2">
              {draft.rubricCriteria.length > 0 ? draft.rubricCriteria.map((criterion, index) => (
                <div key={criterion.id} className="rounded-[var(--radius-card)] border border-border/55 bg-background/52 p-3">
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_6.5rem_2rem]">
                    <input
                      value={criterion.title}
                      onChange={(event) => updateRubricCriterion(index, { title: event.target.value })}
                      placeholder="评分维度"
                      maxLength={240}
                      className={fieldClassName}
                    />
                    <div className="relative">
                      <input
                        type="number"
                        min={0}
                        step="0.5"
                        value={criterion.points ?? ""}
                        onChange={(event) => updateRubricCriterion(index, { points: optionalNumber(event.target.value) })}
                        placeholder="分值"
                        className={`${fieldClassName} pr-6`}
                      />
                      <span className="pointer-events-none absolute right-2 top-2.5 text-[10px] text-muted-foreground">分</span>
                    </div>
                    <button
                      type="button"
                      className="flex h-9 w-8 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setDraft((current) => ({ ...current, rubricCriteria: current.rubricCriteria.filter((_, itemIndex) => itemIndex !== index) }))}
                      title="删除评分维度"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <textarea
                    value={criterion.description || ""}
                    onChange={(event) => updateRubricCriterion(index, { description: event.target.value })}
                    placeholder="评分说明（可选）"
                    maxLength={1200}
                    rows={2}
                    className={`mt-2 ${textAreaClassName}`}
                  />
                  <ProvenanceLine source={criterion.source} />
                </div>
              )) : <EmptyListText>尚未填写评分维度。</EmptyListText>}
            </div>
          </section>

          <section className="mt-6 border-t border-border/55 pt-5">
            <SectionHeading title="已核对资料" description="来源由 Agent 整理流程维护，手动编辑不会伪造文件引用。" />
            <div className="mt-3 flex flex-wrap gap-2">
              {draft.documents.length > 0 ? draft.documents.map((document) => (
                <div key={`${document.fileId}:${document.role}`} className="flex min-w-0 max-w-full items-center gap-2 rounded-[var(--radius-control)] bg-muted/55 px-2.5 py-2 text-[10px] text-muted-foreground">
                  <FileCheck2 className="h-3 w-3 shrink-0" />
                  <span className="truncate text-foreground">{document.fileName}</span>
                  <span className="shrink-0">{documentRoleLabel(document.role)}</span>
                </div>
              )) : <EmptyListText>当前没有已核对的来源文件。</EmptyListText>}
            </div>
          </section>
        </div>

        <footer className="flex shrink-0 items-center justify-between gap-3 border-t border-border/55 bg-card/82 px-5 py-3">
          <div className="min-w-0 flex-1 text-[11px] text-destructive">
            {contentChangedElsewhere ? "任务信息刚刚在其他位置更新，请关闭后重新打开再编辑。" : error}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="h-8 rounded-[var(--radius-control)] px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-45"
              onClick={onClose}
              disabled={saving || contentChangedElsewhere}
            >
              取消
            </button>
            <button
              type="button"
              className="brevyn-primary-button inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-45"
              onClick={() => void save()}
              disabled={saving}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {saving ? "正在保存" : "保存"}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

const fieldClassName = "h-9 w-full rounded-[var(--radius-control)] border border-border/65 bg-background px-3 text-xs text-foreground outline-none transition placeholder:text-muted-foreground/70 focus:border-ring/45 focus:ring-2 focus:ring-ring/15";
const textAreaClassName = "w-full resize-y rounded-[var(--radius-control)] border border-border/65 bg-background px-3 py-2 text-xs leading-5 text-foreground outline-none transition placeholder:text-muted-foreground/70 focus:border-ring/45 focus:ring-2 focus:ring-ring/15";

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs font-semibold text-foreground">{title}</div>
      <div className="mt-1 text-[10px] leading-4 text-muted-foreground">{description}</div>
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <span className="block text-[10px] font-semibold text-muted-foreground">{children}</span>;
}

function ProvenanceLine({ source }: { source?: CourseTaskRequirement["source"] }) {
  return (
    <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[9px] leading-4 text-muted-foreground">
      <FileCheck2 className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate" title={taskSourceLabel(source)}>{taskSourceLabel(source)}</span>
    </div>
  );
}

function EmptyListText({ children }: { children: string }) {
  return <div className="py-3 text-[11px] text-muted-foreground">{children}</div>;
}

function taskInfoDraft(task: BrevynTask): TaskInfoDraft {
  return {
    status: task.status,
    dueAt: localDateTimeInput(task.dueAt),
    summary: task.summary === "Custom task created locally." ? "" : task.summary,
    deliverable: task.info?.deliverable || "",
    requirements: task.info?.requirements.map((item) => ({ ...item, source: item.source ? { ...item.source } : undefined })) || [],
    rubricCriteria: task.info?.rubricCriteria.map((item) => ({ ...item, source: item.source ? { ...item.source } : undefined })) || [],
    documents: task.info?.documents.map((item) => ({ ...item })) || [],
  };
}

function taskInfoUpdateFromDraft(draft: TaskInfoDraft, task: BrevynTask): BrevynTask["info"] | null | undefined {
  const deliverable = draft.deliverable.trim() || undefined;
  const requirements = draft.requirements.map((item) => ({ ...item, text: item.text.trim() }));
  const rubricCriteria = draft.rubricCriteria.map((item) => ({
    ...item,
    title: item.title.trim(),
    description: item.description?.trim() || undefined,
  }));
  const manualFields = manualFieldsAfterTaskInfoEdit(task, draft.summary, draft.deliverable);
  const content = { deliverable, requirements, rubricCriteria, documents: draft.documents };
  const manualFieldsChanged = JSON.stringify(manualFields) !== JSON.stringify(courseTaskInfoManualFields(task));
  if (JSON.stringify(content) === JSON.stringify(courseTaskInfoContent(task.info)) && !manualFieldsChanged) return undefined;
  if (!deliverable && requirements.length === 0 && rubricCriteria.length === 0 && draft.documents.length === 0 && manualFields.length === 0) return null;
  return {
    deliverable,
    requirements,
    rubricCriteria,
    documents: draft.documents,
    extractedAt: new Date().toISOString(),
    updatedBy: "user",
    manualFields,
  };
}

function taskInfoRevision(task: BrevynTask): string {
  return JSON.stringify({
    dueAt: task.dueAt,
    status: task.status,
    summary: task.summary,
    info: task.info,
  });
}

function newRequirement(): CourseTaskRequirement {
  return { id: userItemId("requirement"), category: "other", text: "" };
}

function newRubricCriterion(): CourseTaskRubricCriterion {
  return { id: userItemId("rubric"), title: "" };
}

function userItemId(kind: "requirement" | "rubric"): string {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  return `${kind}_user_${random}`;
}

function localDateTimeInput(value?: string): string {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function dueAtFromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function documentRoleLabel(role: CourseTaskDocument["role"]): string {
  if (role === "brief") return "任务说明";
  if (role === "rubric") return "Rubric";
  if (role === "draft") return "草稿";
  if (role === "submission") return "提交文件";
  return "补充资料";
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
  )).filter((element) => !element.hasAttribute("disabled") && element.tabIndex !== -1);
}

function errorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.trim() || fallback;
}
