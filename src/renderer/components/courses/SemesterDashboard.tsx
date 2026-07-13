import { ArrowRight, BarChart3, CalendarDays, MessageSquare, NotebookTabs, Sparkles } from "lucide-react";
import { useMemo } from "react";
import type { BrevynTask, Course, FileStats, SemesterWorkspace, Thread, WorkspaceFileNode } from "@/types/domain";
import { CourseIcon } from "@/components/courses/CourseIcon";
import { ActivityHeatmap } from "@/components/courses/CourseDashboard";
import { buildSemesterDashboardStats, type CourseCard, type RecentTaskCard } from "@/components/courses/courseDashboardStats";
import { VisionRecognitionImportButton } from "@/components/vision/VisionRecognitionImportDialog";

export function SemesterDashboard({
  semester,
  homeCourse,
  courses,
  tasksByCourse,
  threads,
  stats,
  files,
  onOpenHomeSession,
  onOpenCourses,
  onWorkspaceChanged,
  onSelectCourse,
  onSelectTask,
}: {
  semester?: SemesterWorkspace | null;
  homeCourse?: Course;
  courses: Course[];
  tasksByCourse: Record<string, BrevynTask[]>;
  threads: Thread[];
  stats?: FileStats | null;
  files: WorkspaceFileNode[];
  onOpenHomeSession: () => void;
  onOpenCourses: () => void;
  onWorkspaceChanged?: () => Promise<void> | void;
  onSelectCourse: (courseId: string) => void;
  onSelectTask: (courseId: string, taskId: string) => void;
}) {
  const dashboardStats = useMemo(
    () => buildSemesterDashboardStats({ activityWeekCount: semester?.weekCount, homeCourse, courses, tasksByCourse, threads, files, stats }),
    [courses, files, homeCourse, semester?.weekCount, stats, tasksByCourse, threads],
  );
  const {
    visibleCourses,
    semesterThreads,
    allTasks,
    activityDays,
    courseCards,
    recentTask,
    homeThread,
    quietCourses,
    emptyCourseCount,
    fileCount,
    threadsWithMessages,
  } = dashboardStats;

  if (courseCards.length === 0) {
    return (
      <EmptySemesterCourseStart
        semester={semester}
        homeCourse={homeCourse}
        onOpenCourses={onOpenCourses}
        onOpenHomeSession={onOpenHomeSession}
        onWorkspaceChanged={onWorkspaceChanged}
      />
    );
  }

  const recommendation = buildSemesterRecommendation({
    allTasks,
    courseCards,
    homeThread,
    recentTask,
    visibleCourses,
  });

  function openRecommendation() {
    if (recommendation.kind === "task" && recommendation.courseId && recommendation.taskId) {
      onSelectTask(recommendation.courseId, recommendation.taskId);
      return;
    }
    if (recommendation.kind === "course" && recommendation.courseId) {
      onSelectCourse(recommendation.courseId);
      return;
    }
    if (recommendation.kind === "create_task") {
      onOpenCourses();
      return;
    }
    onOpenHomeSession();
  }

  return (
    <div className="brevyn-dashboard-background brevyn-dashboard-scroll brevyn-scrollbar">
      <div className="brevyn-dashboard-shell">
        <section className="brevyn-hero-surface">
          <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_21rem] xl:gap-5 xl:p-5 2xl:grid-cols-[minmax(0,1fr)_23rem]">
            <div className="min-w-0 py-1">
              <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                <CalendarDays className="h-4 w-4" />
                {semester?.term || homeCourse?.term || "当前学期"}
                {semester?.semesterNo && <span className="rounded-[var(--radius-badge)] bg-muted px-2 py-0.5 text-[10px] normal-case tracking-normal">Semester {semester.semesterNo}</span>}
              </div>
              <h2 className="mt-4 max-w-2xl text-[clamp(1.85rem,3.4vw,3rem)] font-semibold leading-[1] tracking-[-0.064em] text-foreground">把今天放回学期里。</h2>
              <p className="mt-3 max-w-xl text-[13px] leading-6 text-muted-foreground">
                课程、资料、作业和会话会在这里汇合。先继续一个具体入口，其余记录会自然沉淀。
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="inline-flex h-10 max-w-[24rem] items-center gap-2 rounded-[var(--radius-control)] bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 active:scale-[0.98]"
                  onClick={openRecommendation}
                  title={recommendation.title}
                >
                  <span className="truncate">{recommendation.actionLabel}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0" />
                </button>
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border bg-background/75 px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]"
                  onClick={onOpenHomeSession}
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  询问本学期
                </button>
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-control)] border bg-background/75 px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]"
                  onClick={onOpenCourses}
                >
                  <NotebookTabs className="h-3.5 w-3.5" />
                  我的课程
                </button>
              </div>
            </div>
            <button
              type="button"
              className="group flex min-w-0 flex-col justify-between rounded-[var(--radius-panel)] bg-background/58 p-3.5 text-left shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.055)] transition hover:bg-accent/36 active:scale-[0.995]"
              onClick={openRecommendation}
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
                <NotebookTabs className="h-4 w-4" />
                课程空间
              </div>
              <p className="mt-1 text-xs text-muted-foreground">从课程进入资料、作业和会话。</p>
            </div>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-background/72 px-3 text-xs font-medium text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.52)] transition hover:bg-accent hover:text-foreground"
              onClick={onOpenCourses}
            >
              我的课程
            </button>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {courseCards.map((course) => (
              <button
                key={course.course.id}
                type="button"
                className="brevyn-quiet-card group flex min-w-0 items-center gap-3 p-3 text-left transition active:scale-[0.995]"
                onClick={() => onSelectCourse(course.course.id)}
              >
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)]"
                  style={{ color: course.course.color, backgroundColor: `${course.course.color}18` }}
                >
                  <CourseIcon course={course.course} className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-semibold text-foreground">{course.course.name}</div>
                  <div className="mt-1 truncate text-[10px] text-muted-foreground">{courseCourseHint(course)}</div>
                </div>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </section>

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,min(26vw,23rem))]">
          <section className="brevyn-soft-section min-w-0 p-3.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <BarChart3 className="h-4 w-4" />
                  学习记录
                </div>
                <p className="mt-1 text-xs text-muted-foreground">按学期周数显示资料和会话活动。</p>
              </div>
            </div>
            <ActivityHeatmap days={activityDays} />
          </section>

          <section className="brevyn-soft-section min-w-0 p-3.5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4" />
              学期概况
            </div>
            <div className="mt-4 grid gap-2 text-xs">
              <SemesterSummaryRow label="课程" value={`${visibleCourses.length} 门`} hint={`${quietCourses} 门本周较安静`} />
              <SemesterSummaryRow label="课程作业" value={`${allTasks.length} 个`} hint={recentTask ? "最近有推进" : "等待创建"} />
              <SemesterSummaryRow label="资料" value={`${fileCount} 个`} hint={`${emptyCourseCount} 门课程暂无文件`} />
              <SemesterSummaryRow label="会话" value={`${semesterThreads.length} 个`} hint={`${threadsWithMessages} 个已有消息`} />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

type SemesterRecommendationKind = "task" | "course" | "create_task" | "semester_session";

type SemesterRecommendation = {
  kind: SemesterRecommendationKind;
  title: string;
  description: string;
  reason: string;
  actionLabel: string;
  courseId?: string;
  taskId?: string;
};

function buildSemesterRecommendation({
  allTasks,
  courseCards,
  homeThread,
  recentTask,
  visibleCourses,
}: {
  allTasks: BrevynTask[];
  courseCards: CourseCard[];
  homeThread?: Thread;
  recentTask: RecentTaskCard | null;
  visibleCourses: Course[];
}): SemesterRecommendation {
  const courseNameById = new Map(visibleCourses.map((course) => [course.id, course.name]));
  const urgentTask = allTasks
    .map((task) => ({ task, score: taskUrgencyScore(task) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || (a.task.dueAt || "").localeCompare(b.task.dueAt || ""))[0]?.task;

  if (urgentTask) {
    const courseName = courseNameById.get(urgentTask.courseId) || "课程作业";
    const dueText = formatDueText(urgentTask.dueAt);
    return {
      kind: "task",
      title: urgentTask.title,
      description: `${courseName}${dueText ? ` · ${dueText}` : ""}`,
      reason: dueText || taskStatusText(urgentTask.status),
      actionLabel: `处理 ${urgentTask.title}`,
      courseId: urgentTask.courseId,
      taskId: urgentTask.id,
    };
  }

  if (recentTask) {
    return {
      kind: "task",
      title: recentTask.task.title,
      description: `${recentTask.courseName} · ${recentTask.fileCount} 个文件 · ${recentTask.threadCount} 个会话`,
      reason: `最近推进于 ${recentTask.lastTouchedLabel}`,
      actionLabel: `继续 ${recentTask.task.title}`,
      courseId: recentTask.courseId,
      taskId: recentTask.task.id,
    };
  }

  if (allTasks.length === 0) {
    const activeCourse = courseCards[0];
    return {
      kind: "create_task",
      title: "把课程变成具体任务",
      description: activeCourse ? `${activeCourse.course.name} 已经就位，可以先创建 essay、exam 或 project 空间。` : "课程已经就位，可以先创建第一个课程作业空间。",
      reason: `${visibleCourses.length} 门课程已就位`,
      actionLabel: "创建课程作业",
    };
  }

  if (homeThread) {
    return {
      kind: "semester_session",
      title: "继续整理本学期",
      description: "打开学期会话，把课程、资料和待办重新排成下一步。",
      reason: `学期会话更新于 ${formatDashboardRelative(homeThread.updatedAt)}`,
      actionLabel: "继续学期会话",
    };
  }

  const activeCourse = courseCards[0];
  if (activeCourse) {
    return {
      kind: "course",
      title: activeCourse.course.name,
      description: "这门课最近有活动，可以从课程空间继续整理资料和作业。",
      reason: activeCourse.lastActivityLabel,
      actionLabel: `打开 ${activeCourse.course.name}`,
      courseId: activeCourse.course.id,
    };
  }

  return {
    kind: "semester_session",
    title: "规划本周",
    description: "还没有明显的下一步。先用学期会话把本周要做的事情排出来。",
    reason: "没有正在推进的课程作业",
    actionLabel: "规划本周",
  };
}

function SemesterSummaryRow({ label, value, hint }: { label: string; value: string; hint: string }) {
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

function courseCourseHint(course: CourseCard): string {
  if (course.taskCount > 0) return `${course.taskCount} 个课程作业 · ${course.lastActivityLabel}`;
  if (course.fileCount > 0) return `${course.fileCount} 个资料 · 可以创建作业`;
  if (course.threadCount > 0) return `${course.threadCount} 个会话 · ${course.lastActivityLabel}`;
  return "等待资料和课程作业";
}

function taskUrgencyScore(task: BrevynTask): number {
  if (task.archivedAt || task.status === "done") return 0;
  let score = task.status === "due_soon" ? 90 : task.status === "in_progress" ? 42 : 0;
  const days = daysUntil(task.dueAt);
  if (days === null) return score;
  if (days < 0) score += 100;
  else if (days === 0) score += 95;
  else if (days <= 2) score += 82;
  else if (days <= 7) score += 60;
  else if (days <= 14) score += 20;
  return score;
}

function formatDueText(value?: string): string {
  const days = daysUntil(value);
  if (days === null) return "";
  if (days < 0) return `已过截止 ${Math.abs(days)} 天`;
  if (days === 0) return "今天截止";
  if (days === 1) return "明天截止";
  if (days <= 7) return `${days} 天后截止`;
  return `截止 ${formatShortDate(value || "")}`;
}

function taskStatusText(status: BrevynTask["status"]): string {
  if (status === "due_soon") return "即将截止";
  if (status === "in_progress") return "正在推进";
  if (status === "done") return "已完成";
  return "尚未开始";
}

function daysUntil(value?: string): number | null {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(timestamp);
  due.setHours(0, 0, 0, 0);
  return Math.ceil((due.getTime() - today.getTime()) / 86400000);
}

function formatDashboardRelative(value?: string): string {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "未知时间";
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function formatShortDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function EmptySemesterCourseStart({
  semester,
  homeCourse,
  onOpenCourses,
  onOpenHomeSession,
  onWorkspaceChanged,
}: {
  semester?: SemesterWorkspace | null;
  homeCourse?: Course;
  onOpenCourses: () => void;
  onOpenHomeSession: () => void;
  onWorkspaceChanged?: () => Promise<void> | void;
}) {
  return (
    <div className="brevyn-dashboard-background brevyn-dashboard-scroll brevyn-scrollbar">
      <div className="brevyn-dashboard-shell brevyn-empty-dashboard-shell">
        <section className="brevyn-hero-surface">
          <div className="brevyn-empty-dashboard-watermark pointer-events-none absolute -bottom-12 right-8 select-none font-semibold leading-none tracking-[-0.08em] text-foreground/5">
            02
          </div>
          <header className="relative z-[1] flex items-center justify-between gap-4 border-b border-border/50 px-5 py-4">
            <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <CalendarDays className="h-4 w-4" />
              <span className="truncate">{semester?.term || homeCourse?.term || "当前学期"}</span>
              {semester?.semesterNo && <span className="rounded-[var(--radius-badge)] bg-muted px-2 py-0.5 text-[10px] normal-case tracking-normal">Semester {semester.semesterNo}</span>}
            </div>
            <span className="shrink-0 rounded-[var(--radius-badge)] bg-muted px-2 py-1 text-[10px] font-semibold text-muted-foreground">
              0 门课程
            </span>
          </header>

          <div className="brevyn-empty-dashboard-stage relative z-[1]">
            <div className="flex min-w-0 flex-col justify-center">
              <div className="inline-flex w-fit items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                <CalendarDays className="h-4 w-4" />
                课程
              </div>
              <h2 className="brevyn-empty-dashboard-title mt-4 text-foreground">
                让课程就位。
              </h2>
              <p className="brevyn-empty-dashboard-description mt-3.5 text-muted-foreground">
                上传课表，或手动添加课程。每门课程都会成为一个独立工作区，资料、作业和会话会在对应课程下继续展开。
              </p>

              <div className="mt-6 grid max-w-2xl grid-cols-3 divide-x divide-border/50 border-y border-border/55 text-xs">
                <EmptyCourseMilestone index="01" title="手动添加" text="适合先建一门课" />
                <EmptyCourseMilestone index="02" title="课表识别" text="适合批量导入" />
                <EmptyCourseMilestone index="03" title="课程作业" text="在课程里创建任务空间" />
              </div>
            </div>

            <aside className="brevyn-empty-dashboard-side flex items-center">
              <div className="w-full overflow-hidden rounded-[var(--radius-panel)] bg-background/68 shadow-[0_18px_40px_hsl(var(--foreground)/0.055),inset_0_0_0_1px_hsl(var(--foreground)/0.055)]">
                <div className="border-b border-border/50 px-4 py-3">
                  <div className="text-[13px] font-semibold text-foreground">添加课程</div>
                  <p className="mt-1 text-[11px] leading-5 text-muted-foreground">选择一种开始方式。</p>
                </div>
                <button
                  type="button"
                  className="group flex w-full items-center justify-between gap-5 px-4 py-4 text-left transition hover:bg-accent/45 active:scale-[0.995]"
                  onClick={onOpenCourses}
                >
                  <span className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-foreground text-background">
                      <NotebookTabs className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold tracking-[-0.02em] text-foreground">手动添加课程</span>
                      <span className="mt-1 block text-xs leading-5 text-muted-foreground">输入课程名称，创建课程空间。</span>
                    </span>
                  </span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-foreground" />
                </button>

                <div className="mx-4 h-px bg-border/45" />

                <div className="flex items-center justify-between gap-5 px-5 py-4">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-muted text-muted-foreground">
                      <Sparkles className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold tracking-[-0.02em] text-foreground">从课表识别</div>
                      <div className="mt-1 text-xs leading-5 text-muted-foreground">上传课表截图，批量生成课程，导入前可以确认。</div>
                    </div>
                  </div>
                  <VisionRecognitionImportButton
                    kind="course_timetable"
                    className="!h-9 !shrink-0 !rounded-[var(--radius-control)] !border-border/60 !bg-card !px-3 !text-foreground hover:!bg-accent"
                    onImported={async () => {
                      await onWorkspaceChanged?.();
                    }}
                  />
                </div>

                <button
                  type="button"
                  className="flex w-full items-center justify-center gap-1.5 border-t border-border/45 px-4 py-3 text-xs font-medium text-muted-foreground transition hover:bg-accent/35 hover:text-foreground active:scale-[0.99]"
                  onClick={onOpenHomeSession}
                >
                  跳过课程，打开学期会话
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </aside>
          </div>
        </section>
      </div>
    </div>
  );
}

function EmptyCourseMilestone({ index, title, text }: { index: string; title: string; text: string }) {
  return (
    <div className="min-w-0 px-4 py-3 first:pl-0 last:pr-0">
      <div className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">{index}</div>
      <div className="mt-2 text-sm font-semibold tracking-[-0.02em] text-foreground">{title}</div>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{text}</p>
    </div>
  );
}
