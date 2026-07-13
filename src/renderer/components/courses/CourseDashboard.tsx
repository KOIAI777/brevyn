import { ArrowRight, BarChart3, BookOpen, CalendarClock, ClipboardCheck, Loader2, Pencil, Plus, Sparkles } from "lucide-react";
import { useMemo, type CSSProperties } from "react";
import type { BrevynTask, Course, FileStats, SemesterWorkspace, Thread, WorkspaceFileNode } from "@/types/domain";
import { CourseIcon } from "@/components/courses/CourseIcon";
import { TaskTypeIcon } from "@/components/shell/TaskTypeIcon";
import { cx } from "@/lib/cn";
import { CourseTaskInfoSummary } from "@/components/courses/CourseTaskInfo";
import {
  buildActivityWeeks,
  buildCourseDashboardStats,
  type ActivityDay,
  type TaskCard,
} from "@/components/courses/courseDashboardStats";

export function CourseDashboard({
  course,
  semester,
  tasks,
  threads,
  stats,
  files,
  onOpenTasks,
  onSelectTask,
  onCreateThread,
  onEditTaskInfo,
  onOrganizeTaskInfo,
  organizingTaskIds,
  busyTaskIds,
}: {
  course: Course;
  semester?: SemesterWorkspace | null;
  tasks: BrevynTask[];
  threads: Thread[];
  stats?: FileStats | null;
  files: WorkspaceFileNode[];
  onOpenTasks: () => void;
  onSelectTask: (courseId: string, taskId: string) => void;
  onCreateThread: (courseId?: string, taskId?: string) => void;
  onEditTaskInfo: (task: BrevynTask) => void;
  onOrganizeTaskInfo: (task: BrevynTask) => void;
  organizingTaskIds: ReadonlySet<string>;
  busyTaskIds: ReadonlySet<string>;
}) {
  const dashboardStats = useMemo(
    () => buildCourseDashboardStats({ activityWeekCount: semester?.weekCount, course, tasks, threads, files, stats }),
    [course, files, semester?.weekCount, stats, tasks, threads],
  );
  const {
    activityDays,
    courseFileCount,
    courseThreads,
    draftFiles,
    filesTouchedThisWeek,
    lectureFiles,
    recentTask,
    taskCards,
  } = dashboardStats;
  const courseColor = course.color || "#2563eb";

  if (tasks.length === 0) {
    return (
      <EmptyCourseTaskStart
        course={course}
        semester={semester}
        courseColor={courseColor}
        courseFileCount={courseFileCount}
        courseThreadsCount={courseThreads.length}
        lectureFileCount={lectureFiles.length}
        onOpenTasks={onOpenTasks}
      />
    );
  }

  const recommendation = buildCourseRecommendation({
    draftFilesCount: draftFiles.length,
    filesTouchedThisWeek,
    lectureFilesCount: lectureFiles.length,
    recentTask,
    taskCards,
  });

  function openCourseRecommendation() {
    if (recommendation.kind === "task" && recommendation.task) {
      openTask(recommendation.task, course.id, onSelectTask, onCreateThread);
      return;
    }
    onOpenTasks();
  }

  return (
    <div className="brevyn-dashboard-background brevyn-dashboard-scroll brevyn-scrollbar">
      <div className="brevyn-dashboard-shell">
        <section className="brevyn-hero-surface">
          <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_21rem] xl:gap-5 xl:p-5 2xl:grid-cols-[minmax(0,1fr)_23rem]">
            <div className="min-w-0 py-1">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-panel)]"
                  style={{ color: courseColor, backgroundColor: `${courseColor}18`, boxShadow: `inset 0 0 0 1px ${courseColor}30` }}
                >
                  <CourseIcon course={course} className="h-5 w-5" />
                </span>
                <div className="min-w-0">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    <span className="truncate">{semester?.term || course.term || "当前学期"}</span>
                    {course.code && <span className="rounded-[var(--radius-badge)] bg-muted px-2 py-0.5 text-[10px] normal-case tracking-normal">{course.code}</span>}
                  </div>
                  <div className="mt-1 truncate text-sm font-semibold tracking-[-0.02em] text-foreground">{course.name}</div>
                </div>
              </div>
              <h2 className="mt-4 max-w-2xl text-[clamp(1.85rem,3.4vw,3rem)] font-semibold leading-[1] tracking-[-0.064em] text-foreground">在这门课程继续。</h2>
              <p className="mt-3 max-w-xl text-[13px] leading-6 text-muted-foreground">
                从作业、课件或会话开始，继续处理这门课里还没弄清的问题、正在准备的草稿和需要完成的任务。
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="inline-flex h-10 max-w-[24rem] items-center gap-2 rounded-[var(--radius-control)] bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 active:scale-[0.98]"
                  onClick={openCourseRecommendation}
                  title={recommendation.title}
                >
                  <span className="truncate">{recommendation.actionLabel}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                </button>
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border bg-background/75 px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]"
                  onClick={onOpenTasks}
                >
                  <Plus className="h-3.5 w-3.5" />
                  新建课程作业
                </button>
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border bg-background/75 px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]"
                  onClick={onOpenTasks}
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  课程资料
                </button>
              </div>
            </div>
            <button
              type="button"
              className="group flex min-w-0 flex-col justify-between rounded-[var(--radius-panel)] bg-background/58 p-3.5 text-left shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.055)] transition hover:bg-accent/36 active:scale-[0.995]"
              onClick={openCourseRecommendation}
            >
              <div>
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  <Sparkles className="h-4 w-4" />
                  推荐入口
                </div>
                <div className="mt-3 text-base font-semibold leading-6 tracking-[-0.035em] text-foreground">{recommendation.title}</div>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">{recommendation.description}</p>
              </div>
              <div className="mt-4 flex items-center justify-between gap-3 pt-2">
                <div className="min-w-0 truncate text-[11px] text-muted-foreground">{recommendation.reason}</div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
              </div>
            </button>
          </div>
        </section>

        <section className="brevyn-soft-section p-3.5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 text-sm font-semibold">
                <ClipboardCheck className="h-4 w-4" />
                课程任务信息
              </div>
              <p className="mt-1 text-xs text-muted-foreground">查看每个任务的 Deadline、要求、Rubric 和资料状态。</p>
            </div>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-background/72 px-3 text-xs font-medium text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.52)] transition hover:bg-accent hover:text-foreground"
              onClick={onOpenTasks}
            >
              <Plus className="h-3.5 w-3.5" />
              新建课程作业
            </button>
          </div>

          {taskCards.length > 0 ? (
            <div className="grid gap-2 md:grid-cols-2">
              {taskCards.map((task) => (
                <div
                  key={task.task.id}
                  className="brevyn-quiet-card group min-w-0 p-3 text-left transition"
                >
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-3 text-left active:scale-[0.995]"
                    onClick={() => openTask(task, course.id, onSelectTask, onCreateThread)}
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-card/78">
                      <TaskTypeIcon task={task.task} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold text-foreground">{task.task.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span>{task.fileCount} 个文件</span>
                        <span>·</span>
                        <span>{task.threadCount} 个会话</span>
                        <span>·</span>
                        <span>{task.lastTouchedLabel}</span>
                      </div>
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
                  </button>
                  <div className="mt-2.5 border-t border-border/38 pt-2.5">
                    <CourseTaskInfoSummary task={task.task} compact />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] bg-background/72 px-2.5 text-[10px] font-semibold text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)] transition hover:bg-accent hover:text-foreground"
                        onClick={() => onEditTaskInfo(task.task)}
                      >
                        <Pencil className="h-3 w-3" />
                        编辑
                      </button>
                      <button
                        type="button"
                        className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] bg-background/72 px-2.5 text-[10px] font-semibold text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)] transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
                        onClick={() => onOrganizeTaskInfo(task.task)}
                        disabled={busyTaskIds.has(task.task.id)}
                      >
                        {busyTaskIds.has(task.task.id)
                          ? <Loader2 className="h-3 w-3 animate-spin" />
                          : <ClipboardCheck className="h-3 w-3" />}
                        {organizingTaskIds.has(task.task.id)
                          ? "正在启动"
                          : busyTaskIds.has(task.task.id)
                            ? "Agent 运行中"
                            : task.task.info ? "重新整理" : "整理任务信息"}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-[var(--radius-card)] bg-background/48 px-4 py-8 text-center text-xs leading-5 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.28)]">
              还没有课程作业。先为下一份 essay、展示或复习目标创建一个入口。
            </div>
          )}
        </section>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,min(26vw,23rem))]">
          <section className="brevyn-soft-section min-w-0 p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <BarChart3 className="h-4 w-4" />
                  学习记录
                </div>
                <p className="mt-1 text-xs text-muted-foreground">资料和会话留下的推进记录。</p>
              </div>
            </div>
            <ActivityHeatmap days={activityDays} />
          </section>

          <section className="brevyn-soft-section min-w-0 p-3.5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4" />
              课程概况
            </div>
            <div className="mt-4 grid gap-2 text-xs">
              <CourseSummaryLine label="课程作业" value={`${tasks.length} 个`} hint={`${taskCards.length} 个可继续入口`} />
              <CourseSummaryLine label="课件" value={`${lectureFiles.length} 个`} hint={`本周更新 ${filesTouchedThisWeek} 个文件`} />
              <CourseSummaryLine label="草稿" value={`${draftFiles.length} 个`} hint={draftFiles.length > 0 ? "有正在沉淀的内容" : "暂无草稿"} />
              <CourseSummaryLine label="会话" value={`${courseThreads.length} 个`} hint="围绕这门课展开" />
            </div>
          </section>
        </div>

      </div>
    </div>
  );
}

type CourseRecommendationKind = "task" | "materials";

type CourseRecommendation = {
  kind: CourseRecommendationKind;
  title: string;
  description: string;
  reason: string;
  actionLabel: string;
  task?: TaskCard;
};

function buildCourseRecommendation({
  draftFilesCount,
  filesTouchedThisWeek,
  lectureFilesCount,
  recentTask,
  taskCards,
}: {
  draftFilesCount: number;
  filesTouchedThisWeek: number;
  lectureFilesCount: number;
  recentTask?: TaskCard;
  taskCards: TaskCard[];
}): CourseRecommendation {
  const urgentTask = taskCards
    .map((task) => ({ task, score: courseTaskUrgencyScore(task) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.task.lastTouchedTime - a.task.lastTouchedTime)[0]?.task;

  if (urgentTask) {
    const dueText = formatCourseDueText(urgentTask.task.dueAt);
    return {
      kind: "task",
      title: urgentTask.task.title,
      description: `${dueText || courseTaskStatusText(urgentTask.task.status)} · ${urgentTask.fileCount} 个文件 · ${urgentTask.threadCount} 个会话`,
      reason: urgentTask.lastTouchedTime > 0 ? `最近推进于 ${urgentTask.lastTouchedLabel}` : "需要安排下一步",
      actionLabel: `处理 ${urgentTask.task.title}`,
      task: urgentTask,
    };
  }

  if (recentTask) {
    return {
      kind: "task",
      title: recentTask.task.title,
      description: `${recentTask.fileCount} 个文件 · ${recentTask.threadCount} 个会话`,
      reason: `最近推进于 ${recentTask.lastTouchedLabel}`,
      actionLabel: `继续 ${recentTask.task.title}`,
      task: recentTask,
    };
  }

  if (lectureFilesCount > 0 || draftFilesCount > 0) {
    return {
      kind: "materials",
      title: "整理课程资料",
      description: `${lectureFilesCount} 个课件文件 · ${draftFilesCount} 个草稿文件`,
      reason: filesTouchedThisWeek > 0 ? `本周更新 ${filesTouchedThisWeek} 个文件` : "资料已经就位",
      actionLabel: "打开课程资料",
    };
  }

  return {
    kind: "task",
    title: taskCards[0]?.task.title || "选择课程作业",
    description: "选择一个课程作业，让资料、草稿和会话围绕它继续沉淀。",
    reason: "暂无明显优先级",
    actionLabel: taskCards[0] ? `打开 ${taskCards[0].task.title}` : "打开课程作业",
    task: taskCards[0],
  };
}

function CourseSummaryLine({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/38 py-2 first:border-t-0 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-foreground">{label}</div>
        <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{hint}</div>
      </div>
      <div className="shrink-0 text-xs font-semibold text-foreground">{value}</div>
    </div>
  );
}

function courseTaskUrgencyScore(task: TaskCard): number {
  if (task.task.archivedAt || task.task.status === "done") return 0;
  let score = task.task.status === "due_soon" ? 90 : task.task.status === "in_progress" ? 42 : 0;
  const days = courseDaysUntil(task.task.dueAt);
  if (days !== null) {
    if (days < 0) score += 100;
    else if (days === 0) score += 95;
    else if (days <= 2) score += 82;
    else if (days <= 7) score += 60;
    else if (days <= 14) score += 20;
  }
  if (task.lastTouchedTime > 0) score += 8;
  if (task.fileCount > 0) score += 4;
  if (task.threadCount > 0) score += 4;
  return score;
}

function formatCourseDueText(value?: string): string {
  const days = courseDaysUntil(value);
  if (days === null) return "";
  if (days < 0) return `已过截止 ${Math.abs(days)} 天`;
  if (days === 0) return "今天截止";
  if (days === 1) return "明天截止";
  if (days <= 7) return `${days} 天后截止`;
  return `截止 ${formatCourseShortDate(value || "")}`;
}

function courseTaskStatusText(status: BrevynTask["status"]): string {
  if (status === "due_soon") return "即将截止";
  if (status === "in_progress") return "正在推进";
  if (status === "done") return "已完成";
  return "尚未开始";
}

function courseDaysUntil(value?: string): number | null {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(timestamp);
  due.setHours(0, 0, 0, 0);
  return Math.ceil((due.getTime() - today.getTime()) / 86400000);
}

function formatCourseShortDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function EmptyCourseTaskStart({
  course,
  semester,
  courseColor,
  courseFileCount,
  courseThreadsCount,
  lectureFileCount,
  onOpenTasks,
}: {
  course: Course;
  semester?: SemesterWorkspace | null;
  courseColor: string;
  courseFileCount: number;
  courseThreadsCount: number;
  lectureFileCount: number;
  onOpenTasks: () => void;
}) {
  return (
    <div className="brevyn-dashboard-background brevyn-dashboard-scroll brevyn-scrollbar">
      <div className="brevyn-dashboard-shell brevyn-empty-dashboard-shell">
        <section className="brevyn-hero-surface">
          <div className="brevyn-empty-dashboard-watermark pointer-events-none absolute -bottom-12 right-8 select-none font-semibold leading-none tracking-[-0.08em] text-foreground/5">
            03
          </div>

          <header className="relative z-[1] flex items-center justify-between gap-4 border-b border-border/50 px-5 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)]"
                style={{ color: courseColor, backgroundColor: `${courseColor}18`, boxShadow: `inset 0 0 0 1px ${courseColor}30` }}
              >
                <CourseIcon course={course} className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[13px] font-semibold tracking-[-0.02em] text-foreground">{course.name}</span>
                  {course.code && (
                    <span className="shrink-0 rounded-[var(--radius-badge)] bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      {course.code}
                    </span>
                  )}
                </div>
                <div className="mt-1 truncate text-[11px] text-muted-foreground">{semester?.term || course.term || "当前学期"}</div>
              </div>
            </div>
            <span className="shrink-0 rounded-[var(--radius-badge)] bg-muted px-2 py-1 text-[10px] font-semibold text-muted-foreground">
              0 个课程作业
            </span>
          </header>

          <div className="brevyn-empty-dashboard-stage relative z-[1]">
            <div className="flex min-w-0 flex-col justify-center">
              <div className="inline-flex w-fit items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                <CalendarClock className="h-4 w-4" />
                课程作业
              </div>
              <h2 className="brevyn-empty-dashboard-title mt-4 text-foreground">
                让任务就位。
              </h2>
              <p className="brevyn-empty-dashboard-description mt-3.5 text-muted-foreground">
                课程是工作区，课程作业是具体目标。为 essay、project、exam 或复习计划建立一个作业空间，资料、草稿和会话会围绕它继续沉淀。
              </p>

              <div className="mt-6 grid max-w-2xl grid-cols-3 divide-x divide-border/50 border-y border-border/55 text-xs">
                <EmptyTaskMilestone index="01" title="要求" text="放入 brief 与 rubric" />
                <EmptyTaskMilestone index="02" title="资料" text="收集 readings 与 notes" />
                <EmptyTaskMilestone index="03" title="会话" text="围绕目标推进" />
              </div>
            </div>

            <aside className="brevyn-empty-dashboard-side flex items-center">
              <div className="w-full overflow-hidden rounded-[var(--radius-panel)] bg-background/68 shadow-[0_18px_40px_hsl(var(--foreground)/0.055),inset_0_0_0_1px_hsl(var(--foreground)/0.055)]">
                <div className="border-b border-border/50 px-4 py-3">
                  <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
                    <Sparkles className="h-4 w-4" />
                    创建课程作业
                  </div>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                    先从名称开始。图标、截止日期和资料可以稍后补充。
                  </p>
                </div>

                <button
                  type="button"
                  className="group flex w-full items-center justify-between gap-5 px-4 py-4 text-left transition hover:bg-accent/45 active:scale-[0.995]"
                  onClick={onOpenTasks}
                >
                  <span className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-foreground text-background">
                      <Plus className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold tracking-[-0.02em] text-foreground">新建课程作业</span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">为这门课创建 essay、项目、考试或复习入口。</span>
                    </span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
                </button>

                <div className="mx-4 h-px bg-border/45" />

                <div className="px-4 py-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">课程空间</div>
                  <div className="mt-3 grid gap-2 text-xs">
                    <CourseTaskSpaceRow label="课程资料" value={`${courseFileCount} 个文件`} />
                    <CourseTaskSpaceRow label="课件" value={`${lectureFileCount} 个文件`} />
                    <CourseTaskSpaceRow label="会话" value={`${courseThreadsCount} 个`} />
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </section>
      </div>
    </div>
  );
}

function EmptyTaskMilestone({ index, title, text }: { index: string; title: string; text: string }) {
  return (
    <div className="min-w-0 px-4 py-3 first:pl-0 last:pr-0">
      <div className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">{index}</div>
      <div className="mt-2 text-sm font-semibold tracking-[-0.02em] text-foreground">{title}</div>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{text}</p>
    </div>
  );
}

function CourseTaskSpaceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/40 py-2 first:border-t-0 first:pt-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground">{value}</span>
    </div>
  );
}

export function ActivityHeatmap({ days }: { days: ActivityDay[] }) {
  const weeks = buildActivityWeeks(days);
  const heatmapSizing = heatmapSizingForWeekCount(weeks.length);
  const heatmapColumnStyle: CSSProperties = {
    columnGap: `${heatmapSizing.columnGapRem}rem`,
    gridTemplateColumns: `repeat(${weeks.length}, ${heatmapSizing.cellSizeRem}rem)`,
  };
  const heatmapRowStyle: CSSProperties = {
    gridTemplateRows: `repeat(7, ${heatmapSizing.cellSizeRem}rem)`,
    rowGap: `${heatmapSizing.rowGapRem}rem`,
  };
  const heatmapCellStyle: CSSProperties = {
    height: `${heatmapSizing.cellSizeRem}rem`,
    width: `${heatmapSizing.cellSizeRem}rem`,
  };
  return (
    <div className="mt-4">
      <div className="overflow-visible pb-1">
        <div className="min-w-0">
          <div className="mb-1 grid pl-9" style={heatmapColumnStyle}>
            {weeks.map((week) => (
              <div key={week.id} className="truncate text-center text-[8px] font-medium text-muted-foreground" title={`${week.label} · ${week.monthLabel}`}>
                {week.weekLabel}
              </div>
            ))}
          </div>
          <div className="mb-1 grid pl-9" style={heatmapColumnStyle}>
            {weeks.map((week, index) => (
              <div key={`${week.id}-month`} className="truncate text-center text-[8px] text-muted-foreground/70">
                {index === 0 || week.monthLabel !== weeks[index - 1]?.monthLabel ? week.shortMonthLabel : ""}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-[1.75rem_minmax(0,1fr)] gap-2">
            <div className="grid text-right text-[9px] text-muted-foreground" style={heatmapRowStyle}>
              {["周一", "", "周三", "", "周五", "", "周日"].map((label, index) => (
                <div key={`${label}-${index}`} className="flex items-center justify-end">{label}</div>
              ))}
            </div>
            <div className="grid" style={heatmapColumnStyle}>
              {weeks.map((week) => (
                <div key={week.id} className="grid" style={heatmapRowStyle}>
                  {week.days.map((day) => (
                    <div
                      key={day.dateKey}
                      className="group/day relative"
                      style={heatmapCellStyle}
                    >
                      <div className={cx("rounded-[4px] border transition group-hover/day:scale-110", heatCellClass(day.score))} style={heatmapCellStyle} />
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-44 -translate-x-1/2 rounded-lg border border-border bg-card px-2.5 py-2 text-left text-[10px] leading-4 text-foreground opacity-0 shadow-xl ring-1 ring-border transition group-hover/day:opacity-100">
                        <div className="font-semibold">{day.weekdayLabel}，{day.label}</div>
                        <div className="mt-1 text-muted-foreground">更新 {day.fileEvents} 个文件</div>
                        <div className="text-muted-foreground">更新 {day.sessionEvents} 个会话</div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-[10px] text-muted-foreground">
        <span>每列代表一周 · 最近 {weeks.length} 周</span>
        <span className="flex items-center gap-1">
          <span>少</span>
          {[0, 1, 3, 6].map((score) => (
            <span key={score} className={cx("rounded border", heatCellClass(score))} style={heatmapCellStyle} />
          ))}
          <span>多</span>
        </span>
      </div>
    </div>
  );
}

function heatmapSizingForWeekCount(weekCount: number): { cellSizeRem: number; columnGapRem: number; rowGapRem: number } {
  if (weekCount <= 8) return { cellSizeRem: 1.32, columnGapRem: 0.5, rowGapRem: 0.42 };
  if (weekCount <= 16) return { cellSizeRem: 1.12, columnGapRem: 0.43, rowGapRem: 0.36 };
  if (weekCount <= 22) return { cellSizeRem: 0.94, columnGapRem: 0.36, rowGapRem: 0.3 };
  return { cellSizeRem: 0.75, columnGapRem: 0.32, rowGapRem: 0.25 };
}

export function MetricCard({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl border bg-background/65 px-3 py-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-[-0.03em] text-foreground">{value}</div>
      <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}

function heatCellClass(score: number): string {
  if (score >= 8) return "brevyn-activity-cell-4";
  if (score >= 5) return "brevyn-activity-cell-3";
  if (score >= 2) return "brevyn-activity-cell-2";
  if (score >= 1) return "brevyn-activity-cell-1";
  return "brevyn-activity-cell-0";
}

function openTask(task: TaskCard, courseId: string, onSelectTask: (courseId: string, taskId: string) => void, onCreateThread: (courseId?: string, taskId?: string) => void) {
  if (task.threadCount > 0) {
    onSelectTask(courseId, task.task.id);
    return;
  }
  onCreateThread(courseId, task.task.id);
}
