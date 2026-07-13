import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  FileCheck2,
  FileText,
  ListChecks,
  Loader2,
  Pencil,
  RefreshCw,
  Scale,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type {
  BrevynTask,
  CourseTaskDocument,
  CourseTaskRequirement,
  CourseTaskRubricCriterion,
  CourseTaskSourceAnchor,
  TaskStatus,
} from "@/types/domain";
import { useFilePathPreviewHandler, type FilePreviewLocationTarget } from "@/components/chat/FilePathChip";
import { cx } from "@/lib/cn";

export const ORGANIZE_COURSE_TASK_INFO_REQUEST = "请整理并更新当前课程任务信息。";

export const ORGANIZE_COURSE_TASK_INFO_PROMPT = [
  ORGANIZE_COURSE_TASK_INFO_REQUEST,
  "先用 course_structure 确认当前 courseId 和 taskId。用 list_course_files 分别检查三个明确范围：当前 taskId、当前 courseId 的 course_shared、当前 courseId 的 lecture。不要读取其他任务的材料。找到作业说明、Rubric 与相关资料。",
  "对权威候选文件使用 read_parsed_file 读完整内容；如需定位具体要求，可先用 rag_search 辅助发现。",
  "确认截止时间、交付形式、硬性要求、格式与引用要求、禁止事项和评分维度后，调用 update_course_task_info 写入。",
  "每条要求和评分维度都必须带真实 fileId 来源；不确定的信息不要猜，也不要替我把任务状态标为已完成。",
].join("\n");

export function CourseTaskInfoSummary({
  task,
  compact = false,
  singleLine = false,
}: {
  task: BrevynTask;
  compact?: boolean;
  singleLine?: boolean;
}) {
  const info = task.info;
  const sourceCount = taskInfoSourceCount(task);
  const deadline = taskDeadlinePresentation(task);

  if (compact) {
    return (
      <div className={cx(
        "flex min-w-0 items-center gap-x-3 gap-y-1.5",
        singleLine ? "flex-nowrap" : "flex-wrap",
      )}>
        <TaskStatusPill status={task.status} compact />
        <div className="flex min-w-0 items-center gap-1.5 text-[10px]">
          <CalendarClock className={cx("h-3 w-3 shrink-0", deadline.toneClass)} />
          <span className="text-muted-foreground">Deadline</span>
          <span className={cx("max-w-[11rem] truncate font-semibold", deadline.toneClass)} title={deadline.fullLabel}>
            {deadline.shortLabel}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <TaskFact label="任务状态"><TaskStatusPill status={task.status} /></TaskFact>
      <TaskFact label="Deadline" toneClass={deadline.toneClass}>{deadline.shortLabel}</TaskFact>
      <TaskFact label="资料依据">{info ? sourceCount > 0 ? `${sourceCount} 份已核对` : "仅手动填写" : "尚未整理"}</TaskFact>
    </div>
  );
}

export function CourseTaskInfoPanel({
  task,
  running,
  onEdit,
  onOrganize,
}: {
  task: BrevynTask;
  running: boolean;
  onEdit: () => void;
  onOrganize: () => void;
}) {
  const info = task.info;
  const onPreviewFilePath = useFilePathPreviewHandler();
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const requirements = prioritizeRequirements(info?.requirements || []);
  const rubricCriteria = info?.rubricCriteria || [];
  const sourceCount = taskInfoSourceCount(task);
  const deadline = taskDeadlinePresentation(task);
  const deadlineDate = taskDeadlineDateParts(task.dueAt);
  const updated = info?.extractedAt ? relativeTimeLabel(info.extractedAt) : "尚未整理";
  const rubricPoints = rubricCriteria.reduce((sum, criterion) => sum + (criterion.points || 0), 0);

  async function openSource(source: CourseTaskSourceAnchor, text?: string) {
    if (!onPreviewFilePath) return;
    const target: FilePreviewLocationTarget = {
      fileId: source.fileId,
      sourceLabel: source.sourceLabel,
      semanticUnitId: source.semanticUnitId,
      page: source.page,
      slide: source.slide,
      sheet: source.sheet,
      range: source.range,
      bbox: source.bbox,
      text,
    };
    await onPreviewFilePath(target);
  }

  async function openDocument(document: CourseTaskDocument) {
    if (!onPreviewFilePath) return;
    await onPreviewFilePath({
      fileId: document.fileId,
      sourceLabel: document.sourceLabel,
    });
  }

  return (
    <section className="w-full overflow-hidden rounded-[var(--radius-panel)] bg-card/82 text-left shadow-[var(--shadow-panel)] backdrop-blur-xl">
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="flex min-w-0 items-start gap-3">
          <div className={cx(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)]",
            taskStatusIconSurfaceClass(task.status),
          )}>
            <CourseTaskStatusIcon status={task.status} className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-xs font-semibold text-foreground">课程任务</span>
              <span className="truncate text-[10px] text-muted-foreground">{task.title}</span>
            </div>
            <div className="mt-1 text-[10px] leading-4 text-muted-foreground">
              {info ? `${info.updatedBy === "user" ? "手动" : "Agent"} 更新于 ${updated}` : "尚未从课程资料整理"}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 text-[11px] font-semibold text-muted-foreground transition hover:bg-accent hover:text-foreground"
            onClick={onEdit}
            title="手动编辑课程任务信息"
          >
            <Pencil className="h-3.5 w-3.5" />
            编辑
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-foreground px-3 text-[11px] font-semibold text-background transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={onOrganize}
            disabled={running}
            title={info ? "重新阅读课程资料并更新任务信息" : "阅读课程资料并整理任务信息"}
          >
            <RefreshCw className={cx("h-3.5 w-3.5", running && "animate-spin")} />
            {running ? "正在整理" : info ? "重新整理" : "整理任务信息"}
          </button>
        </div>
      </header>

      <div className="grid gap-5 px-5 pb-5 pt-2 md:grid-cols-[minmax(0,1fr)_14rem] md:items-end">
          <div className="flex min-h-[7.5rem] min-w-0 flex-col justify-end md:pr-5">
            <TaskStatusPill status={task.status} />
            <h3 className="mt-3 max-w-3xl text-[20px] font-semibold leading-7 text-foreground">
              {info?.deliverable || "尚未确认交付形式"}
            </h3>
          </div>
          <DeadlineFolio deadline={deadline} date={deadlineDate} />
      </div>

      {info ? (
        <>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 border-t border-border/48 px-5 py-3 text-left text-[11px] transition hover:bg-accent/28"
            onClick={() => setDetailsExpanded((current) => !current)}
            aria-expanded={detailsExpanded}
          >
            <span className="flex min-w-0 items-center gap-2 font-semibold text-foreground">
              <ListChecks className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              任务详情
              <span className="truncate text-[10px] font-normal text-muted-foreground">
                {`${requirements.length} 项要求 · ${rubricCriteria.length} 项 Rubric · ${sourceCount > 0 ? `${sourceCount} 份来源` : "手动填写"}`}
              </span>
            </span>
            <ChevronDown className={cx("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", detailsExpanded && "rotate-180")} />
          </button>

          <div className={cx(
            "grid transition-[grid-template-rows] duration-300 ease-out",
            detailsExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )} aria-hidden={!detailsExpanded}>
            <div className="min-h-0 overflow-hidden">
            <div className="border-t border-border/48">
              {taskSummaryText(task) && (
                <div className="px-5 py-4">
                  <div className="text-[10px] font-semibold text-foreground">任务摘要</div>
                  <p className="mt-1.5 text-[11px] leading-5 text-muted-foreground">{taskSummaryText(task)}</p>
                </div>
              )}

              <div className={cx(
                "grid px-5 py-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)]",
                taskSummaryText(task) && "border-t border-border/48",
              )}>
                <TaskInfoSection
                  icon={<ListChecks className="h-3.5 w-3.5" />}
                  title="关键要求"
                  meta={`${requirements.length} 项`}
                  className="py-4 lg:pr-5"
                >
                  {requirements.length > 0 ? (
                    <div className="mt-2">
                      {requirements.map((requirement) => (
                        <RequirementRow key={requirement.id} requirement={requirement} onOpenSource={openSource} />
                      ))}
                    </div>
                  ) : <EmptySectionText>尚未记录关键要求。</EmptySectionText>}
                </TaskInfoSection>

                <TaskInfoSection
                  icon={<Scale className="h-3.5 w-3.5" />}
                  title="评分重点"
                  meta={rubricPoints > 0 ? `${rubricCriteria.length} 项 · ${formatPoints(rubricPoints)}` : `${rubricCriteria.length} 项`}
                  className="border-t border-border/48 py-4 lg:border-l lg:border-t-0 lg:pl-5"
                >
                  {rubricCriteria.length > 0 ? (
                    <div className="mt-2">
                      {rubricCriteria.map((criterion) => (
                        <RubricRow key={criterion.id} criterion={criterion} onOpenSource={openSource} />
                      ))}
                    </div>
                  ) : <EmptySectionText>尚未记录评分维度。</EmptySectionText>}
                </TaskInfoSection>
              </div>

              <div className="border-t border-border/48 px-5 py-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-1 text-[10px] font-semibold text-foreground">来源资料</span>
                  {info.documents.length > 0 ? info.documents.map((document) => (
                    <button
                      key={`${document.fileId}:${document.role}`}
                      type="button"
                      className="group/source inline-flex h-7 min-w-0 max-w-[16rem] items-center gap-1.5 rounded-[var(--radius-control)] bg-background/65 px-2.5 text-[10px] text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)] transition hover:bg-accent hover:text-foreground disabled:cursor-default"
                      onClick={() => void openDocument(document)}
                      disabled={!onPreviewFilePath}
                      title={`打开 ${document.fileName}`}
                    >
                      <FileText className="h-3 w-3 shrink-0" />
                      <span className="truncate">{document.fileName}</span>
                      <span className="shrink-0 text-[9px] text-muted-foreground">{documentRoleLabel(document.role)}</span>
                      <ChevronRight className="h-3 w-3 shrink-0 opacity-0 transition group-hover/source:opacity-100" />
                    </button>
                  )) : <span className="text-[10px] text-muted-foreground">暂无已核对文件</span>}
                </div>
              </div>
            </div>
            </div>
          </div>
        </>
      ) : (
        <div className="px-5 py-5">
          <div className="flex items-start gap-2.5 text-[11px] leading-5 text-muted-foreground">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--status-warning))]" />
            <span>先整理课程资料，或点击“编辑”手动填写 Deadline、要求和 Rubric。</span>
          </div>
        </div>
      )}
    </section>
  );
}

function DeadlineFolio({
  deadline,
  date,
}: {
  deadline: ReturnType<typeof taskDeadlinePresentation>;
  date: ReturnType<typeof taskDeadlineDateParts>;
}) {
  return (
    <div className="border-t border-border/48 pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-1">
      <div className="flex items-center justify-between gap-3 text-[9px] font-semibold text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <CalendarClock className={cx("h-3.5 w-3.5", deadline.toneClass)} />
          DEADLINE
        </span>
        {date && <span className="tabular-nums">{date.year}</span>}
      </div>

      {date ? (
        <div className="mt-3">
          <div className="flex items-end gap-3">
            <span className={cx("text-[42px] font-semibold leading-none tabular-nums", deadline.toneClass)}>{date.day}</span>
            <div className="pb-0.5 text-[10px] leading-4 text-muted-foreground">
              <div className="font-semibold text-foreground">{date.month}</div>
              <div>{date.weekday}</div>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/42 pt-2.5">
            <span className="text-[11px] font-semibold tabular-nums text-foreground">{date.time}</span>
            <span className={cx("text-[10px] font-semibold", deadline.toneClass)}>{deadline.shortLabel}</span>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <div className="flex items-end gap-3">
            <span className={cx("text-[42px] font-semibold leading-none tabular-nums", deadline.toneClass)}>--</span>
            <div className="pb-0.5 text-[10px] leading-4 text-muted-foreground">
              <div className={cx("font-semibold", deadline.toneClass)}>待确认</div>
              <div>未填写日期</div>
            </div>
          </div>
          <div className="mt-3 border-t border-border/42 pt-2.5 text-[10px] leading-4 text-muted-foreground">{deadline.detail}</div>
        </div>
      )}
    </div>
  );
}

function RequirementRow({
  requirement,
  onOpenSource,
}: {
  requirement: CourseTaskRequirement;
  onOpenSource: (source: CourseTaskSourceAnchor, text?: string) => Promise<void>;
}) {
  return (
    <div className="border-b border-border/38 py-2.5 last:border-b-0">
      <div className="flex min-w-0 items-start gap-2">
        <RequirementCategoryBadge category={requirement.category} />
        <div className="min-w-0 flex-1 text-[11px] leading-5 text-foreground">{requirement.text}</div>
      </div>
      <SourceAction source={requirement.source} text={requirement.text} indent onOpenSource={onOpenSource} />
    </div>
  );
}

function RubricRow({
  criterion,
  onOpenSource,
}: {
  criterion: CourseTaskRubricCriterion;
  onOpenSource: (source: CourseTaskSourceAnchor, text?: string) => Promise<void>;
}) {
  return (
    <div className="border-b border-border/38 py-2.5 last:border-b-0">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1 text-[11px] font-medium leading-5 text-foreground">{criterion.title}</div>
        {criterion.points !== undefined && (
          <span className="shrink-0 rounded-[var(--radius-badge)] bg-muted/70 px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground">
            {formatPoints(criterion.points)}
          </span>
        )}
      </div>
      {criterion.description && <div className="mt-0.5 text-[10px] leading-4 text-muted-foreground">{criterion.description}</div>}
      <SourceAction source={criterion.source} text={[criterion.title, criterion.description].filter(Boolean).join(". ")} onOpenSource={onOpenSource} />
    </div>
  );
}

function SourceAction({
  source,
  text,
  indent = false,
  onOpenSource,
}: {
  source?: CourseTaskSourceAnchor;
  text?: string;
  indent?: boolean;
  onOpenSource: (source: CourseTaskSourceAnchor, text?: string) => Promise<void>;
}) {
  if (!source) {
    return (
      <div className={cx("mt-1.5 flex items-center gap-1.5 text-[9px] leading-4 text-muted-foreground", indent && "pl-[4.9rem]")}>
        <Pencil className="h-2.5 w-2.5 shrink-0" />
        手动添加
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cx("group/source mt-1.5 flex max-w-full items-center gap-1.5 text-left text-[9px] leading-4 text-muted-foreground transition hover:text-foreground", indent && "pl-[4.9rem]")}
      onClick={() => void onOpenSource(source, text)}
      title={`在预览中打开 ${taskSourceLabel(source)}`}
    >
      <FileCheck2 className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate underline-offset-2 group-hover/source:underline">{taskSourceLabel(source)}</span>
      <ChevronRight className="h-2.5 w-2.5 shrink-0 opacity-0 transition group-hover/source:opacity-100" />
    </button>
  );
}

function TaskInfoSection({
  icon,
  title,
  meta,
  className,
  children,
}: {
  icon: ReactNode;
  title: string;
  meta: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cx("min-w-0", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
          <span className="text-muted-foreground">{icon}</span>
          {title}
        </div>
        <span className="text-[9px] text-muted-foreground">{meta}</span>
      </div>
      {children}
    </section>
  );
}

function RequirementCategoryBadge({ category }: { category: CourseTaskRequirement["category"] }) {
  const label = requirementCategoryLabel(category);
  return (
    <span className={cx(
      "mt-0.5 inline-flex w-[4.4rem] shrink-0 justify-center rounded-[var(--radius-badge)] px-1.5 py-0.5 text-[9px] font-medium",
      category === "prohibition"
        ? "bg-[hsl(var(--status-warning)/0.12)] text-[hsl(var(--status-warning))]"
        : category === "submission"
          ? "bg-primary/10 text-primary"
          : category === "limit"
            ? "bg-[hsl(var(--status-info)/0.12)] text-[hsl(var(--status-info))]"
            : "bg-muted/72 text-muted-foreground",
    )}>
      {label}
    </span>
  );
}

function TaskStatusPill({ status, compact = false }: { status: TaskStatus; compact?: boolean }) {
  const style = taskStatusStyle(status);
  return (
    <span className={cx(
      "inline-flex shrink-0 self-start items-center gap-1.5 rounded-[var(--radius-pill)] font-semibold",
      compact ? "px-1.5 py-0.5 text-[9px]" : "px-2 py-1 text-[10px]",
      style.className,
    )}>
      <CourseTaskStatusIcon status={status} className={compact ? "h-2.5 w-2.5" : "h-3 w-3"} />
      {taskStatusLabel(status)}
    </span>
  );
}

export function CourseTaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  if (status === "in_progress") return <Loader2 className={cx(className, "animate-spin")} />;
  if (status === "due_soon") return <CircleAlert className={className} />;
  if (status === "done") return <Check className={className} />;
  return <Circle className={className} />;
}

function TaskFact({ label, toneClass, children }: { label: string; toneClass?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[9px] font-semibold text-muted-foreground">{label}</div>
      <div className={cx("mt-1 text-[11px] font-semibold text-foreground", toneClass)}>{children}</div>
    </div>
  );
}

function EmptySectionText({ children }: { children: string }) {
  return <div className="py-4 text-[10px] text-muted-foreground">{children}</div>;
}

export function taskSourceLabel(source?: CourseTaskSourceAnchor): string {
  if (!source) return "手动添加";
  const explicitLocation = cleanSourceLocation(source.fileName, source.sourceLabel);
  const location = explicitLocation
    || (source.page ? `第 ${source.page} 页` : "")
    || (source.slide ? `第 ${source.slide} 张幻灯片` : "")
    || ([source.sheet, source.range].filter(Boolean).join(" "));
  return [source.fileName, location].filter(Boolean).join(" · ");
}

function cleanSourceLocation(fileName: string, sourceLabel?: string): string {
  const label = sourceLabel?.trim() || "";
  if (!label) return "";
  if (!label.toLocaleLowerCase().startsWith(fileName.trim().toLocaleLowerCase())) return label;
  return label.slice(fileName.trim().length).replace(/^[\s,·:;\-–—]+/, "").trim();
}

function prioritizeRequirements(requirements: CourseTaskRequirement[]): CourseTaskRequirement[] {
  const priority: Record<CourseTaskRequirement["category"], number> = {
    limit: 0,
    prohibition: 1,
    submission: 2,
    format: 3,
    reference: 4,
    other: 5,
  };
  return requirements.map((requirement, index) => ({ requirement, index }))
    .sort((left, right) => priority[left.requirement.category] - priority[right.requirement.category] || left.index - right.index)
    .map(({ requirement }) => requirement);
}

function requirementCategoryLabel(category: CourseTaskRequirement["category"]): string {
  if (category === "limit") return "硬性限制";
  if (category === "format") return "格式";
  if (category === "reference") return "引用";
  if (category === "submission") return "提交";
  if (category === "prohibition") return "禁止事项";
  return "其他";
}

function taskStatusStyle(status: TaskStatus): { className: string } {
  if (status === "in_progress") return { className: "bg-primary/10 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.18)]" };
  if (status === "due_soon") return { className: "bg-[hsl(var(--status-warning)/0.11)] text-[hsl(var(--status-warning))] shadow-[inset_0_0_0_1px_hsl(var(--status-warning)/0.18)]" };
  if (status === "done") return { className: "bg-[hsl(var(--status-info)/0.12)] text-[hsl(var(--status-info))] shadow-[inset_0_0_0_1px_hsl(var(--status-info)/0.2)]" };
  return { className: "bg-muted/72 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]" };
}

function taskStatusIconSurfaceClass(status: TaskStatus): string {
  if (status === "in_progress") return "brevyn-status-icon-info shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.18)]";
  if (status === "due_soon") return "brevyn-status-icon-warning shadow-[inset_0_0_0_1px_hsl(var(--status-warning)/0.18)]";
  if (status === "done") return "brevyn-status-icon-success shadow-[inset_0_0_0_1px_hsl(var(--status-success)/0.18)]";
  return "bg-background text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.52)]";
}

function taskStatusLabel(status: TaskStatus): string {
  if (status === "in_progress") return "进行中";
  if (status === "due_soon") return "即将截止";
  if (status === "done") return "已完成";
  return "未开始";
}

function taskDeadlinePresentation(task: BrevynTask): { shortLabel: string; fullLabel: string; detail: string; toneClass: string } {
  const timestamp = Date.parse(task.dueAt || "");
  if (!Number.isFinite(timestamp)) {
    return {
      shortLabel: "待确认",
      fullLabel: "Deadline 待确认",
      detail: task.status === "due_soon" ? "状态为即将截止，但尚未填写日期" : "请手动填写或重新整理课程资料",
      toneClass: task.status === "due_soon" ? "text-[hsl(var(--status-warning))]" : "text-foreground",
    };
  }
  const date = new Date(timestamp);
  const fullLabel = date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const exactLabel = date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const days = deadlineDays(task.dueAt);
  if (days !== null && days < 0 && task.status !== "done") {
    return { shortLabel: `已逾期 ${Math.abs(days)} 天`, fullLabel, detail: exactLabel, toneClass: "text-destructive" };
  }
  if (days === 0) return { shortLabel: "今天截止", fullLabel, detail: exactLabel, toneClass: "text-[hsl(var(--status-warning))]" };
  if (days === 1) return { shortLabel: "明天截止", fullLabel, detail: exactLabel, toneClass: "text-[hsl(var(--status-warning))]" };
  if (days !== null && days <= 7 && task.status !== "done") {
    return { shortLabel: `${days} 天后截止`, fullLabel, detail: exactLabel, toneClass: "text-[hsl(var(--status-warning))]" };
  }
  return { shortLabel: exactLabel, fullLabel, detail: days !== null && days > 7 ? `还有 ${days} 天` : "已记录", toneClass: "text-foreground" };
}

function taskDeadlineDateParts(value?: string): { year: string; month: string; day: string; weekday: string; time: string } | null {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  return {
    year: String(date.getFullYear()),
    month: date.toLocaleDateString("zh-CN", { month: "long" }),
    day: String(date.getDate()).padStart(2, "0"),
    weekday: date.toLocaleDateString("zh-CN", { weekday: "long" }),
    time: date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }),
  };
}

function taskInfoSourceCount(task: BrevynTask): number {
  const info = task.info;
  return new Set([
    ...(info?.documents.map((document) => document.fileId) || []),
    ...(info?.requirements.flatMap((requirement) => requirement.source?.fileId ? [requirement.source.fileId] : []) || []),
    ...(info?.rubricCriteria.flatMap((criterion) => criterion.source?.fileId ? [criterion.source.fileId] : []) || []),
  ]).size;
}

function taskSummaryText(task: BrevynTask): string {
  const summary = task.summary.trim();
  return summary === "Custom task created locally." ? "" : summary;
}

function deadlineDays(value?: string): number | null {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(timestamp);
  due.setHours(0, 0, 0, 0);
  return Math.ceil((due.getTime() - today.getTime()) / 86400000);
}

function relativeTimeLabel(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "刚刚";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatPoints(points: number): string {
  return `${Number.isInteger(points) ? points : points.toFixed(1)} 分`;
}

function documentRoleLabel(role: CourseTaskDocument["role"]): string {
  if (role === "brief") return "任务说明";
  if (role === "rubric") return "Rubric";
  if (role === "draft") return "草稿";
  if (role === "submission") return "提交文件";
  return "补充资料";
}
