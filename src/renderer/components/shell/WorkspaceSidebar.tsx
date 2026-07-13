import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Archive, Check, ChevronRight, CircleAlert, CloudDownload, Loader2, NotebookTabs, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RefreshCw, Settings } from "lucide-react";
import type { Course, Thread, BrevynTask, UserProfileSettings } from "@/types/domain";
import type { UpdaterStatus } from "@/types/domain";
import { cx } from "@/lib/cn";
import { useAgentThreadListStatuses, type AgentThreadListStatus } from "@/lib/agent-live-store";
import { profileDisplayName, UserAvatar } from "@/lib/user-profile";
import { formatRelative } from "@/lib/workspace-files";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CourseIcon } from "@/components/courses/CourseIcon";
import { TaskTypeIcon } from "@/components/shell/TaskTypeIcon";

const SIDEBAR_THREAD_PREVIEW_LIMIT = 5;

export function WorkspaceSidebar({
  collapsed,
  courses,
  tasksByCourse,
  threads,
  activeCourseId,
  activeTaskId,
  activeThreadId,
  emptyThreadIds,
  width,
  resizing,
  profile,
  onToggle,
  onSelectHome,
  onSelectTask,
  onSelectThread,
  onArchiveThread,
  onArchiveTask,
  onRenameThread,
  onCreateThread,
  onOpenCourses,
  onOpenSettings,
  onResizeStart,
}: {
  collapsed: boolean;
  courses: Course[];
  tasksByCourse: Record<string, BrevynTask[]>;
  threads: Thread[];
  activeCourseId: string;
  activeTaskId?: string;
  activeThreadId: string;
  emptyThreadIds: Set<string>;
  width: number;
  resizing: boolean;
  profile: UserProfileSettings;
  onToggle: () => void;
  onSelectHome: (courseId: string) => void;
  onSelectTask: (courseId: string, taskId: string) => void;
  onSelectThread: (thread: Thread) => void;
  onArchiveThread: (thread: Thread) => void;
  onArchiveTask: (task: BrevynTask) => Promise<void> | void;
  onRenameThread: (thread: Thread, title: string) => Promise<void>;
  onCreateThread: (courseId?: string, taskId?: string) => void;
  onOpenCourses: () => void;
  onOpenSettings: () => void;
  onResizeStart: (event: ReactPointerEvent) => void;
}) {
  const [openCourses, setOpenCourses] = useState<Record<string, boolean>>({});
  const [openTasks, setOpenTasks] = useState<Record<string, boolean>>({});
  const [expandedThreadGroups, setExpandedThreadGroups] = useState<Record<string, boolean>>({});
  const [homeOpen, setHomeOpen] = useState(true);
  const [threadMenu, setThreadMenu] = useState<ThreadContextMenuState | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState("");
  const [archivingTaskId, setArchivingTaskId] = useState("");
  const { confirm, confirmDialog } = useConfirmDialog();
  const threadStatuses = useAgentThreadListStatuses();
  const recentThreads = sortThreadsForSidebar(threads, threadStatuses).slice(0, 8);
  const homeCourse = courses.find((course) => course.workspaceKind === "semester_home");
  const courseList = courses.filter((course) => course.workspaceKind !== "semester_home");
  const canCreateThread = activeCourseId === homeCourse?.id || Boolean(activeTaskId);
  const homeCourseLabel = homeCourse ? semesterHomeDisplayName(homeCourse.name) : "";
  const toggleHomeOpen = () => setHomeOpen((value) => !value);
  const toggleThreadGroupExpanded = (groupKey: string) => {
    setExpandedThreadGroups((current) => ({ ...current, [groupKey]: !current[groupKey] }));
  };

  async function archiveTaskFromSidebar(task: BrevynTask) {
    const ok = await confirm({
      title: `归档「${task.title}」？`,
      message: "该任务和它的会话会从侧边栏隐藏，文件不会删除。你可以在我的课程里恢复。",
      confirmLabel: "归档",
      cancelLabel: "保留",
    });
    if (!ok) return;
    setArchivingTaskId(task.id);
    try {
      await onArchiveTask(task);
    } catch {
      // Workspace controller surfaces the error in the main shell banner.
    } finally {
      setArchivingTaskId("");
    }
  }

  if (collapsed) {
    return (
      <aside className="brevyn-panel-surface flex w-14 shrink-0 flex-col items-center overflow-hidden py-2 transition-[width,opacity,transform] duration-200">
        {confirmDialog}
        <button className="no-drag flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]" onClick={onToggle} title="Expand sidebar">
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <div className="my-2 h-px w-8 bg-border" />
        <SidebarUpdateControl compact />
        <button className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40" onClick={() => onCreateThread(activeCourseId, activeTaskId)} title="New thread" disabled={!canCreateThread}>
          <Plus className="h-4 w-4" />
        </button>
        <div className="mt-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {recentThreads.map((thread, index) => (
            <CollapsedThreadButton
              key={thread.id}
              thread={thread}
              index={index}
              active={thread.id === activeThreadId}
              status={threadStatuses.get(thread.id)}
              onClick={() => onSelectThread(thread)}
              onContextMenu={(event) => {
                event.preventDefault();
                setThreadMenu({
                  thread,
                  anchor: anchorFromElement(event.currentTarget),
                });
              }}
            />
          ))}
        </div>
        <ThreadContextMenu
          state={threadMenu}
          onClose={() => setThreadMenu(null)}
          onRename={(thread) => setRenamingThreadId(thread.id)}
        />
        <div className="my-2 h-px w-8 bg-border" />
        <button className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]" onClick={onOpenCourses} title="我的课程">
          <NotebookTabs className="h-4 w-4" />
        </button>
        <button className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]" onClick={onOpenSettings} title="设置">
          <Settings className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside
      data-workspace-sidebar
      className={cx(
        "brevyn-panel-surface group/sidebar relative flex shrink-0 flex-col overflow-hidden will-change-[width] transition-[width,opacity,transform] duration-200",
        resizing && "select-none ring-2 ring-ring/20 transition-none",
      )}
      style={{ width }}
    >
      {confirmDialog}
      <button
        type="button"
        className="absolute right-0 top-0 z-10 h-full w-3 cursor-col-resize touch-none bg-transparent focus:outline-none"
        aria-label="Resize workspace sidebar"
        onPointerDown={onResizeStart}
      >
        <span className={cx("absolute right-0 top-3 h-[calc(100%-1.5rem)] w-px rounded-full bg-foreground/20 opacity-0 transition-opacity duration-150 group-hover/sidebar:opacity-100", resizing && "opacity-100")} />
      </button>
      <div className="drag-region flex items-center gap-2 bg-card/70 px-3 py-3 shadow-[inset_0_-1px_0_hsl(var(--border)/0.45)]">
        <button
          type="button"
        className="no-drag group/profile flex min-w-0 flex-1 items-center gap-2.5 rounded-[var(--radius-card)] bg-background/58 px-2.5 py-2 text-left shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.045)] transition-colors duration-150 hover:bg-accent/35 active:scale-[0.99]"
          onClick={onOpenSettings}
          title="打开账号设置"
        >
          <span className="relative shrink-0">
            <UserAvatar profile={profile} size="sm" className="rounded-[var(--radius-avatar)] shadow-none transition-transform duration-150 group-hover/profile:scale-[1.03]" />
            <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-background bg-[hsl(var(--status-success))]" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold leading-4 text-foreground">{profileDisplayName(profile)}</div>
            <div className="truncate text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/80">Workspace</div>
          </div>
        </button>
        <SidebarUpdateControl />
        <button className="no-drag shrink-0 rounded-[var(--radius-control)] bg-background/48 p-1.5 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.045)] transition-colors hover:bg-accent/60 hover:text-foreground active:scale-[0.98]" onClick={onToggle} title="Collapse sidebar">
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2.5 brevyn-scrollbar">
        {homeCourse && (
          <div className="mb-2">
            <HomeCourseSidebarSection
              homeCourse={homeCourse}
              homeCourseLabel={homeCourseLabel}
              homeOpen={homeOpen}
              threads={threads}
              activeCourseId={activeCourseId}
              activeThreadId={activeThreadId}
              expandedThreadGroups={expandedThreadGroups}
              threadStatuses={threadStatuses}
              emptyThreadIds={emptyThreadIds}
              renamingThreadId={renamingThreadId}
              onSelectHome={onSelectHome}
              onToggleHomeOpen={toggleHomeOpen}
              onCreateThread={onCreateThread}
              onToggleThreadGroupExpanded={toggleThreadGroupExpanded}
              onSelectThread={onSelectThread}
              onArchiveThread={onArchiveThread}
              onRenameThread={onRenameThread}
              onStartEditing={setRenamingThreadId}
              onEditingDone={() => setRenamingThreadId("")}
              onOpenThreadMenu={(event, thread) => {
                event.preventDefault();
                setThreadMenu({ thread, anchor: anchorFromElement(event.currentTarget) });
              }}
            />
          </div>
        )}

        {courseList.map((course) => {
          const courseTasks = tasksByCourse[course.id] || [];
          const courseOpen = openCourses[course.id] ?? course.id === activeCourseId;
          const toggleCourseOpen = () => setOpenCourses((current) => ({ ...current, [course.id]: !courseOpen }));

          return (
            <div key={course.id} className="mb-2">
              <div className="flex items-center gap-1">
                <button
                  className={cx(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-xs transition-colors active:scale-[0.99]",
                    course.id === activeCourseId && !activeTaskId ? "bg-foreground/[0.07] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.055)]" : "text-foreground hover:bg-accent/65",
                  )}
                  title={courseOpen ? `Collapse ${course.name}` : `Expand ${course.name}`}
                  onClick={() => {
                    onSelectHome(course.id);
                    toggleCourseOpen();
                  }}
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-badge)]" style={{ color: course.color, backgroundColor: `${course.color}1f`, boxShadow: `inset 0 0 0 1px ${course.color}33` }}>
                    <CourseIcon course={course} className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{course.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {course.code} · {course.term}
                    </span>
                  </span>
                </button>
              </div>

              <SidebarCollapse open={courseOpen} className="ml-5 mt-1">
                <div className="space-y-1 rounded-[var(--radius-control)] bg-background/28 p-1">
                  {courseTasks.map((task) => {
                    const taskOpen = openTasks[task.id] ?? task.id === activeTaskId;
                    const taskActive = task.id === activeTaskId;
                    const toggleTaskOpen = () => setOpenTasks((current) => ({ ...current, [task.id]: !(current[task.id] ?? task.id === activeTaskId) }));
                    const taskThreads = sortThreadsForSidebar(
                      threads.filter((thread) => thread.courseId === course.id && thread.taskId === task.id),
                      threadStatuses,
                    );
                    const taskThreadGroupKey = threadGroupKey("task", task.id);
                    return (
                      <div key={task.id} className="group/task">
                        <div className="flex items-center gap-1">
                          <div
                            className={cx(
                              "flex min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-control)] transition-colors",
                              taskActive
                                ? "bg-foreground/[0.07] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.055)]"
                                : "text-muted-foreground hover:bg-accent hover:text-foreground",
                            )}
                          >
                            <button
                              type="button"
                              className="flex h-7 w-5 shrink-0 items-center justify-center rounded-[var(--radius-badge)] text-current/70 transition hover:bg-background/55 hover:text-current active:scale-[0.98]"
                              title={taskOpen ? `Collapse ${task.title}` : `Expand ${task.title}`}
                              onClick={toggleTaskOpen}
                            >
                              <ChevronRight className={cx("h-3 w-3 transition-transform", taskOpen && "rotate-90")} />
                            </button>
                            <button
                              className="flex min-w-0 flex-1 items-center gap-1 rounded-[var(--radius-control)] px-0.5 py-1.5 text-left text-[11px] transition active:scale-[0.99]"
                              onClick={() => {
                                onSelectTask(course.id, task.id);
                                toggleTaskOpen();
                              }}
                            >
                              <TaskTypeIcon task={task} />
                              <span className="min-w-0 flex-1 truncate">{task.title}</span>
                              <SessionCount count={taskThreads.length} />
                            </button>
                          </div>
                          <button
                            type="button"
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-badge)] text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]"
                            title="New task session"
                            onClick={() => onCreateThread(course.id, task.id)}
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-badge)] text-muted-foreground opacity-0 transition group-hover/task:opacity-100 hover:bg-accent hover:text-foreground active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
                            title="归档任务"
                            disabled={archivingTaskId === task.id}
                            onClick={() => void archiveTaskFromSidebar(task)}
                          >
                            <Archive className="h-3 w-3" />
                          </button>
                        </div>
                        <SidebarCollapse open={taskOpen && taskThreads.length > 0} className="mt-1">
                          <div className="space-y-0.5 rounded-[var(--radius-badge)] bg-card/45 p-1">
                            <SidebarThreadList
                              threads={taskThreads}
                              compact
                              activeThreadId={activeThreadId}
                              expanded={Boolean(expandedThreadGroups[taskThreadGroupKey])}
                              statuses={threadStatuses}
                              emptyThreadIds={emptyThreadIds}
                              renamingThreadId={renamingThreadId}
                              onToggleExpanded={() => toggleThreadGroupExpanded(taskThreadGroupKey)}
                              onSelectThread={onSelectThread}
                              onArchiveThread={onArchiveThread}
                              onRenameThread={onRenameThread}
                              onStartEditing={setRenamingThreadId}
                              onEditingDone={() => setRenamingThreadId("")}
                              onContextMenu={(event, thread) => {
                                event.preventDefault();
                                setThreadMenu({ thread, anchor: anchorFromElement(event.currentTarget) });
                              }}
                            />
                          </div>
                        </SidebarCollapse>
                      </div>
                    );
                  })}
                </div>
              </SidebarCollapse>
            </div>
          );
        })}
      </div>

      <div className="px-3 pb-3 pt-2 shadow-[inset_0_1px_0_hsl(var(--border)/0.45)]">
        <div className="space-y-1.5">
          <SidebarFooterButton icon={<NotebookTabs className="h-4 w-4" />} label="我的课程" onClick={onOpenCourses} />
          <SidebarFooterButton icon={<Settings className="h-4 w-4" />} label="设置" onClick={onOpenSettings} />
        </div>
      </div>
      <ThreadContextMenu
        state={threadMenu}
        onClose={() => setThreadMenu(null)}
        onRename={(thread) => setRenamingThreadId(thread.id)}
      />
    </aside>
  );
}

function compareThreadsByUpdatedAtDesc(a: Thread, b: Thread): number {
  const aTime = Date.parse(a.updatedAt);
  const bTime = Date.parse(b.updatedAt);
  const safeATime = Number.isFinite(aTime) ? aTime : 0;
  const safeBTime = Number.isFinite(bTime) ? bTime : 0;
  return safeBTime - safeATime;
}

function sortThreadsForSidebar(threads: Thread[], statuses: ReadonlyMap<string, AgentThreadListStatus>): Thread[] {
  return [...threads].sort((a, b) => {
    const draftDiff = threadDraftSortRank(a) - threadDraftSortRank(b);
    if (draftDiff !== 0) return draftDiff;
    const priorityDiff = threadStatusSortRank(statuses.get(a.id)) - threadStatusSortRank(statuses.get(b.id));
    if (priorityDiff !== 0) return priorityDiff;
    return compareThreadsByUpdatedAtDesc(a, b);
  });
}

function threadDraftSortRank(thread: Thread): number {
  return thread.isDraft ? 0 : 1;
}

function threadGroupKey(scope: "course" | "task", id: string): string {
  return `${scope}:${id}`;
}

type HomeCourseSidebarSectionProps = {
  homeCourse: Course;
  homeCourseLabel: string;
  homeOpen: boolean;
  threads: Thread[];
  activeCourseId: string;
  activeThreadId: string;
  expandedThreadGroups: Record<string, boolean>;
  threadStatuses: ReadonlyMap<string, AgentThreadListStatus>;
  emptyThreadIds: Set<string>;
  renamingThreadId: string;
  onSelectHome: (courseId: string) => void;
  onToggleHomeOpen: () => void;
  onCreateThread: (courseId?: string, taskId?: string) => void;
  onToggleThreadGroupExpanded: (groupKey: string) => void;
  onSelectThread: (thread: Thread) => void;
  onArchiveThread: (thread: Thread) => void;
  onRenameThread: (thread: Thread, title: string) => Promise<void>;
  onStartEditing: (threadId: string) => void;
  onEditingDone: () => void;
  onOpenThreadMenu: (event: MouseEvent<HTMLElement>, thread: Thread) => void;
};

function HomeCourseSidebarSection({
  homeCourse,
  homeCourseLabel,
  homeOpen,
  threads,
  activeCourseId,
  activeThreadId,
  expandedThreadGroups,
  threadStatuses,
  emptyThreadIds,
  renamingThreadId,
  onSelectHome,
  onToggleHomeOpen,
  onCreateThread,
  onToggleThreadGroupExpanded,
  onSelectThread,
  onArchiveThread,
  onRenameThread,
  onStartEditing,
  onEditingDone,
  onOpenThreadMenu,
}: HomeCourseSidebarSectionProps) {
  const homeThreadGroupKey = threadGroupKey("course", homeCourse.id);
  const homeThreads = sortThreadsForSidebar(threads.filter((thread) => thread.courseId === homeCourse.id), threadStatuses);

  return (
    <>
      <div className="flex items-center gap-1">
        <button
          className={cx(
            "flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-left text-xs transition-colors active:scale-[0.99]",
            homeCourse.id === activeCourseId ? "bg-foreground/[0.07] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.055)]" : "text-foreground hover:bg-accent/65",
          )}
          title={homeOpen ? `收起${homeCourseLabel}` : `展开${homeCourseLabel}`}
          onClick={() => {
            onSelectHome(homeCourse.id);
            onToggleHomeOpen();
          }}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-badge)] bg-foreground text-background">
            <NotebookTabs className="h-3.5 w-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold">{homeCourseLabel}</span>
            <span className="block truncate text-[10px] text-muted-foreground">学期资料</span>
          </span>
        </button>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-card/70 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.04)] transition hover:bg-accent hover:text-foreground active:scale-[0.98]"
          title="新建学期会话"
          onClick={() => onCreateThread(homeCourse.id)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <SidebarCollapse open={homeOpen} className="ml-7 mt-1">
        <div className="space-y-1 rounded-[var(--radius-control)] bg-background/28 p-1">
          <SidebarThreadList
            threads={homeThreads}
            activeThreadId={activeThreadId}
            expanded={Boolean(expandedThreadGroups[homeThreadGroupKey])}
            statuses={threadStatuses}
            emptyThreadIds={emptyThreadIds}
            renamingThreadId={renamingThreadId}
            onToggleExpanded={() => onToggleThreadGroupExpanded(homeThreadGroupKey)}
            onSelectThread={onSelectThread}
            onArchiveThread={onArchiveThread}
            onRenameThread={onRenameThread}
            onStartEditing={onStartEditing}
            onEditingDone={onEditingDone}
            onContextMenu={onOpenThreadMenu}
          />
        </div>
      </SidebarCollapse>
    </>
  );
}

type SidebarThreadListProps = {
  threads: Thread[];
  compact?: boolean;
  activeThreadId: string;
  expanded: boolean;
  statuses: ReadonlyMap<string, AgentThreadListStatus>;
  emptyThreadIds: Set<string>;
  renamingThreadId: string;
  onToggleExpanded: () => void;
  onSelectThread: (thread: Thread) => void;
  onArchiveThread: (thread: Thread) => void;
  onRenameThread: (thread: Thread, title: string) => Promise<void>;
  onStartEditing: (threadId: string) => void;
  onEditingDone: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, thread: Thread) => void;
};

function SidebarThreadList({
  threads,
  compact = false,
  activeThreadId,
  expanded,
  statuses,
  emptyThreadIds,
  renamingThreadId,
  onToggleExpanded,
  onSelectThread,
  onArchiveThread,
  onRenameThread,
  onStartEditing,
  onEditingDone,
  onContextMenu,
}: SidebarThreadListProps) {
  const visibleThreads = visibleSidebarThreads(threads, activeThreadId, expanded);
  const showToggle = threads.length > SIDEBAR_THREAD_PREVIEW_LIMIT;

  return (
    <>
      {visibleThreads.map((thread) => (
        <ThreadButton
          key={thread.id}
          thread={thread}
          compact={compact}
          active={thread.id === activeThreadId}
          status={statuses.get(thread.id)}
          editing={renamingThreadId === thread.id}
          onClick={() => onSelectThread(thread)}
          canArchive={!emptyThreadIds.has(thread.id)}
          onStartEditing={() => onStartEditing(thread.id)}
          onArchive={() => onArchiveThread(thread)}
          onRename={onRenameThread}
          onEditingDone={onEditingDone}
          onContextMenu={(event) => onContextMenu(event, thread)}
        />
      ))}
      {showToggle && (
        <button
          type="button"
          className="flex h-7 w-full items-center rounded-[var(--radius-control)] px-3 text-left text-[11px] font-semibold text-muted-foreground/78 transition hover:bg-accent/55 hover:text-foreground active:scale-[0.99]"
          title={expanded ? "折叠会话列表" : "展开全部会话"}
          aria-expanded={expanded}
          onClick={onToggleExpanded}
        >
          {expanded ? "折叠显示" : "展开显示"}
        </button>
      )}
    </>
  );
}

function visibleSidebarThreads(threads: Thread[], activeThreadId: string, expanded: boolean): Thread[] {
  if (expanded || threads.length <= SIDEBAR_THREAD_PREVIEW_LIMIT) return threads;

  const preview = threads.slice(0, SIDEBAR_THREAD_PREVIEW_LIMIT);
  if (preview.some((thread) => thread.id === activeThreadId)) return preview;

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) return preview;

  return [...preview, activeThread];
}

function threadStatusSortRank(status?: AgentThreadListStatus): number {
  if (!status) return 4;
  if (status.kind === "running") return 0;
  if (!status.seen && (status.kind === "failed" || status.kind === "interrupted")) return 1;
  if (!status.seen && status.kind === "completed") return 2;
  if (!status.seen && status.kind === "stopped") return 3;
  return 4;
}

function semesterHomeDisplayName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized || normalized === "home" || normalized === "home taskagent" || normalized === "home session") return "学期总览";
  return name;
}

function SidebarCollapse({ open, className, children }: { open: boolean; className?: string; children: ReactNode }) {
  return (
    <div
      aria-hidden={!open}
      className={cx(
        "grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out",
        open ? "grid-rows-[1fr] opacity-100" : "pointer-events-none grid-rows-[0fr] opacity-0",
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

function SessionCount({ count }: { count: number }) {
  return <span className="shrink-0 rounded-[var(--radius-badge)] bg-background/70 px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">{count}</span>;
}

function SidebarFooterButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex h-9 w-full items-center gap-2 rounded-[var(--radius-control)] px-2.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:scale-[0.98]"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-badge)] bg-background/55 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.04)]">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function SidebarUpdateControl({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.brevyn.updater
      .getStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => undefined);
    const unsubscribe = window.brevyn.updater.onStatusChanged((next) => {
      setStatus(next);
      if (next.status !== "checking" && next.status !== "downloading") setBusy(false);
    });
    void window.brevyn.updater.checkForUpdates().catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  if (!status || !visibleUpdateStatus(status)) return null;

  const progress = status.status === "downloading" ? clampProgress(status.progress.percent) : 0;
  const title = updateControlTitle(status);
  const available = status.status === "available";
  const downloaded = status.status === "downloaded";
  const disabled = busy || status.status === "downloading" || status.status === "checking";

  async function act() {
    if (!status) return;
    setBusy(true);
    try {
      if (status.status === "available") {
        await window.brevyn.updater.downloadUpdate();
      } else if (status.status === "downloaded") {
        await window.brevyn.updater.quitAndInstall();
      } else if (status.status === "error") {
        await window.brevyn.updater.checkForUpdates();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={cx(
        "no-drag shrink-0 rounded-[var(--radius-control)] transition-colors active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-75",
        compact ? "mb-1 flex h-9 w-9 items-center justify-center" : "flex h-8 items-center justify-center gap-1.5 px-2.5 text-[11px] font-semibold",
        available && "bg-primary text-primary-foreground shadow-[0_8px_18px_hsl(var(--primary)/0.2)] hover:bg-primary/90",
        status.status === "downloading" && "bg-primary/12 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.2)]",
        downloaded && "bg-foreground text-background shadow-[0_8px_18px_hsl(var(--foreground)/0.13)] hover:opacity-90",
        status.status === "error" && "bg-[hsl(var(--status-warning)/0.13)] text-[hsl(var(--status-warning))] shadow-[inset_0_0_0_1px_hsl(var(--status-warning)/0.24)] hover:bg-[hsl(var(--status-warning)/0.18)]",
      )}
      title={title}
      aria-label={title}
      onClick={() => void act()}
      disabled={disabled}
    >
      {status.status === "downloading" ? (
        <>
          <ProgressRing progress={progress} />
          {!compact ? <span>{Math.round(progress)}%</span> : null}
        </>
      ) : status.status === "downloaded" ? (
        <>
          <RefreshCw className="h-3.5 w-3.5" />
          {!compact ? <span>重启更新</span> : null}
        </>
      ) : status.status === "error" ? (
        <CircleAlert className="h-3.5 w-3.5" />
      ) : busy || status.status === "checking" ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <>
          <CloudDownload className="h-3.5 w-3.5" />
          {!compact ? <span>更新</span> : null}
        </>
      )}
    </button>
  );
}

function ProgressRing({ progress }: { progress: number }) {
  return (
    <span
      className="flex h-5 w-5 items-center justify-center rounded-full"
      style={{ background: `conic-gradient(hsl(var(--primary)) ${progress * 3.6}deg, hsl(var(--border) / 0.78) 0deg)` }}
      aria-hidden="true"
    >
      <span className="h-3 w-3 rounded-full bg-background shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.06)]" />
    </span>
  );
}

function visibleUpdateStatus(status: UpdaterStatus): boolean {
  return status.status === "available" || status.status === "downloading" || status.status === "downloaded" || status.status === "error";
}

function updateControlTitle(status: UpdaterStatus): string {
  if (status.status === "available") return `下载更新 ${status.version}`;
  if (status.status === "downloading") return `正在下载更新 ${Math.round(clampProgress(status.progress.percent))}%`;
  if (status.status === "downloaded") return `重启更新到 ${status.version}`;
  if (status.status === "error") return `更新检查失败：${status.error}`;
  return "检查更新";
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function CollapsedThreadButton({
  thread,
  index,
  active,
  status,
  onClick,
  onContextMenu,
}: {
  thread: Thread;
  index: number;
  active: boolean;
  status?: AgentThreadListStatus;
  onClick: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
}) {
  const visibleStatus = visibleThreadStatus(status);
  return (
    <button
      className={cx(
        "relative flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] text-[11px] font-semibold transition active:scale-[0.98]",
        active ? "bg-muted text-foreground ring-1 ring-black/[0.05]" : "bg-secondary/70 text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      title={threadStatusTitle(status) || thread.title}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {thread.title.slice(0, 1).toUpperCase() || index + 1}
      {visibleStatus === "running" && <Loader2 className="absolute -right-0.5 -top-0.5 h-3 w-3 animate-spin rounded-full bg-background text-primary" />}
      {visibleStatus === "completed" && <span className="absolute -right-0.5 -top-0.5 flex h-3 w-3 items-center justify-center rounded-full bg-[hsl(var(--status-info)/0.92)] text-[7px] text-background"><Check className="h-2 w-2" /></span>}
      {visibleStatus === "failed" && <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-[hsl(var(--status-warning))]" />}
    </button>
  );
}

type ThreadButtonProps = {
  thread: Thread;
  compact?: boolean;
  active: boolean;
  status?: AgentThreadListStatus;
  editing: boolean;
  canArchive: boolean;
  onClick: () => void;
  onStartEditing: () => void;
  onArchive: () => void;
  onRename: (thread: Thread, title: string) => Promise<void>;
  onEditingDone: () => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
};

function ThreadButton({ thread, compact = false, active, status, editing, canArchive, onClick, onStartEditing, onArchive, onRename, onEditingDone, onContextMenu }: ThreadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const skipNextBlurRef = useRef(false);
  const [draft, setDraft] = useState(thread.title);

  useEffect(() => {
    if (!editing) return;
    setDraft(thread.title);
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing, thread.title]);

  async function saveTitle(): Promise<void> {
    if (skipNextBlurRef.current) {
      skipNextBlurRef.current = false;
      return;
    }
    if (savingRef.current) return;
    const trimmed = draft.trim();
    if (!trimmed || trimmed === thread.title) {
      onEditingDone();
      return;
    }
    savingRef.current = true;
    try {
      await onRename(thread, trimmed);
      onEditingDone();
    } finally {
      savingRef.current = false;
    }
  }

  return (
    <div
      className={cx("group flex w-full min-w-0 items-center rounded-[var(--radius-control)] text-[11px] transition", active ? "bg-foreground/[0.07] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.055)]" : "text-muted-foreground hover:bg-accent hover:text-foreground")}
      title={thread.title}
      onContextMenu={onContextMenu}
    >
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          maxLength={100}
          className="ml-2.5 mr-1 my-1 min-w-0 flex-1 rounded-[var(--radius-badge)] bg-background/90 px-1.5 py-1 text-[11px] text-foreground outline-none ring-1 ring-black/[0.05] focus:bg-background focus:ring-primary/30"
          onChange={(event) => setDraft(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onBlur={() => void saveTitle()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void saveTitle();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              skipNextBlurRef.current = true;
              setDraft(thread.title);
              onEditingDone();
            }
          }}
        />
      ) : (
        <button
          type="button"
          className={cx("flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left", compact ? "pl-2 pr-1.5" : "pl-3 pr-2")}
          onClick={onClick}
        >
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          <ThreadStatusBadge status={status} fallback={formatRelative(thread.updatedAt)} />
        </button>
      )}
      {!editing && (
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-badge)] text-muted-foreground opacity-0 transition hover:bg-background hover:text-foreground focus:opacity-100 group-hover:opacity-70"
          title="Rename session"
          onClick={(event) => {
            event.stopPropagation();
            onStartEditing();
          }}
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
      {canArchive && (
        <button
          type="button"
          className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-badge)] text-muted-foreground opacity-0 transition hover:bg-background hover:text-foreground focus:opacity-100 group-hover:opacity-70"
          title="Archive session"
          onClick={(event) => {
            event.stopPropagation();
            onArchive();
          }}
        >
          <Archive className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function ThreadStatusBadge({ status, fallback }: { status?: AgentThreadListStatus; fallback: string }) {
  const visibleStatus = visibleThreadStatus(status);
  if (visibleStatus === "running") {
    return (
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-pill)] bg-primary/10 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.18)]" title="运行中" aria-label="运行中">
        <Loader2 className="h-3 w-3 animate-spin" />
      </span>
    );
  }
  if (visibleStatus === "completed") {
    return (
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-pill)] bg-[hsl(var(--status-info)/0.12)] text-[hsl(var(--status-info))] shadow-[inset_0_0_0_1px_hsl(var(--status-info)/0.2)]" title="已完成，打开后消失" aria-label="已完成">
        <Check className="h-3 w-3" />
      </span>
    );
  }
  if (visibleStatus === "failed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] bg-[hsl(var(--status-warning)/0.11)] px-1.5 py-0.5 text-[9px] font-medium text-[hsl(var(--status-warning))] shadow-[inset_0_0_0_1px_hsl(var(--status-warning)/0.18)]">
        <CircleAlert className="h-2.5 w-2.5" />
        异常
      </span>
    );
  }
  return <span className="shrink-0 text-[9px] text-muted-foreground/70">{fallback}</span>;
}

function visibleThreadStatus(status?: AgentThreadListStatus): "running" | "completed" | "failed" | undefined {
  if (!status) return undefined;
  if (status.kind === "running") return "running";
  if (status.seen) return undefined;
  if (status.kind === "completed") return "completed";
  if (status.kind === "failed" || status.kind === "interrupted") return "failed";
  return undefined;
}

function threadStatusTitle(status?: AgentThreadListStatus): string {
  const visibleStatus = visibleThreadStatus(status);
  if (visibleStatus === "running") return "运行中";
  if (visibleStatus === "completed") return "已完成，打开后消失";
  if (visibleStatus === "failed") return "运行异常，打开后消失";
  return "";
}

type ThreadContextMenuState = {
  thread: Thread;
  anchor: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  };
};

function ThreadContextMenu({
  state,
  onClose,
  onRename,
}: {
  state: ThreadContextMenuState | null;
  onClose: () => void;
  onRename: (thread: Thread) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: state?.anchor.right || 0, top: state?.anchor.top || 0 });

  useEffect(() => {
    if (!state) return;
    const frame = window.requestAnimationFrame(() => {
      const rect = menuRef.current?.getBoundingClientRect();
      const width = rect?.width || 170;
      const height = rect?.height || 92;
      const preferredLeft = state.anchor.right + 6;
      const fallbackLeft = state.anchor.left - width - 6;
      const left = preferredLeft + width <= window.innerWidth - 8 ? preferredLeft : fallbackLeft;
      setPosition({
        left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
        top: Math.max(8, Math.min(state.anchor.top - 4, window.innerHeight - height - 8)),
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [state]);

  useEffect(() => {
    if (!state) return;
    function close() {
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("pointerdown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, state]);

  if (!state) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="brevyn-popover-surface fixed z-[80] w-44 overflow-hidden rounded-[var(--radius-panel)] p-1.5 text-xs"
      style={{ left: position.left, top: position.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="border-b border-border/60 px-2 py-1.5">
        <div className="truncate text-[11px] font-medium text-foreground" title={state.thread.title}>
          {state.thread.title}
        </div>
        <div className="truncate text-[10px] text-muted-foreground">Session</div>
      </div>
      <button
        type="button"
        className="mt-1 flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-2 text-left text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]"
        onClick={() => {
          onRename(state.thread);
          onClose();
        }}
      >
        <Pencil className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Rename</span>
      </button>
    </div>,
    document.body,
  );
}

function anchorFromElement(element: HTMLElement): ThreadContextMenuState["anchor"] {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
  };
}
