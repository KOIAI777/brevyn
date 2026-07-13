import {
  Archive,
  BookOpen,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ActionButton } from "@/components/settings/shared/SettingsControls";
import { errorMessage } from "@/components/settings/shared/settingsErrors";
import { cx } from "@/lib/cn";
import type { BrevynTask, Course, SemesterWorkspace, Thread } from "../../../../types/domain";
import {
  ArchiveActionButton,
  ArchiveCheckbox,
  ArchiveMetric,
  ArchivePanel,
  ArchivedTaskRow,
  ArchivedThreadRow,
} from "./ArchiveRows";
import { shortId } from "./archiveFormatters";

const SEMESTER_HOME_COURSE_ID = "semester-home";

interface ArchiveSemesterGroup {
  semester: SemesterWorkspace;
  courses: Course[];
  archivedCourses: Course[];
  archivedTasks: BrevynTask[];
  archivedThreads: Thread[];
}

interface ArchiveCourseEntry {
  courseId: string;
  course?: Course;
  tasks: BrevynTask[];
  threads: Thread[];
}

interface ArchiveDisplayGroup extends ArchiveSemesterGroup {
  semesterVisible: boolean;
  homeThreads: Thread[];
  courseEntries: ArchiveCourseEntry[];
}

type ArchiveFilter = "all" | "semesters" | "courses" | "tasks" | "sessions";
type ArchiveSelectionKind = "semester" | "course" | "task" | "thread";
type ArchiveSelectionKey = `${ArchiveSelectionKind}:${string}`;

interface ArchiveSelectionTarget {
  key: ArchiveSelectionKey;
  kind: ArchiveSelectionKind;
  id: string;
  label: string;
  semesterId: string;
  courseId?: string;
}

const ARCHIVE_PAGE_SIZE = 5;
const archiveFilters: Array<{ value: ArchiveFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "semesters", label: "学期" },
  { value: "courses", label: "课程" },
  { value: "tasks", label: "任务" },
  { value: "sessions", label: "会话" },
];

export function ArchiveSettingsPage({ onWorkspaceChanged }: { onWorkspaceChanged?: () => Promise<void> | void }) {
  const [groups, setGroups] = useState<ArchiveSemesterGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ArchiveFilter>("all");
  const [page, setPage] = useState(1);
  const [openSemesters, setOpenSemesters] = useState<Record<string, boolean>>({});
  const [openCourses, setOpenCourses] = useState<Record<string, boolean>>({});
  const [selectedKeys, setSelectedKeys] = useState<Set<ArchiveSelectionKey>>(() => new Set());
  const { confirm, confirmDialog } = useConfirmDialog();

  useEffect(() => {
    void loadArchive();
  }, []);

  useEffect(() => {
    setPage(1);
    setSelectedKeys(new Set());
  }, [filter, groups.length, query]);

  async function loadArchive() {
    setLoading(true);
    setError("");
    try {
      const [activeSemesters, archivedSemesters] = await Promise.all([
        window.brevyn.semester.list(),
        window.brevyn.semester.listArchived(),
      ]);
      const semesters = [...activeSemesters, ...archivedSemesters].sort(compareSemestersForArchive);
      const nextGroups = await Promise.all(
        semesters.map(async (item) => {
          const [courses, archivedCourses, archivedTasks, archivedThreads] = await Promise.all([
            window.brevyn.courses.listForArchive({ semesterId: item.id }),
            window.brevyn.courses.listArchived({ semesterId: item.id }),
            window.brevyn.tasks.listArchived({ semesterId: item.id }),
            window.brevyn.threads.listArchived({ semesterId: item.id }),
          ]);
          return { semester: item, courses, archivedCourses, archivedTasks, archivedThreads };
        }),
      );
      setGroups(nextGroups.filter((group) => group.semester.archivedAt || group.archivedCourses.length > 0 || group.archivedTasks.length > 0 || group.archivedThreads.length > 0));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  async function afterMutation() {
    await loadArchive();
    await onWorkspaceChanged?.();
  }

  async function restoreSemester(semester: SemesterWorkspace) {
    setBusyKey(`semester:restore:${semester.id}`);
    setError("");
    try {
      await window.brevyn.semester.restore(semester.id);
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "恢复学期失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function deleteSemester(semester: SemesterWorkspace) {
    const ok = await confirm({
      title: `永久删除“${semester.term}”？`,
      message: "这会删除所有课程、文件、会话和索引数据。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setBusyKey(`semester:delete:${semester.id}`);
    setError("");
    try {
      await window.brevyn.semester.delete(semester.id);
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "删除学期失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function restoreCourse(course: Course, semesterArchived: boolean) {
    if (semesterArchived) {
      setError("请先恢复父级学期，再恢复这门课程。");
      return;
    }
    setBusyKey(`course:restore:${course.id}`);
    setError("");
    try {
      await window.brevyn.courses.restore(course.id);
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "恢复课程失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function deleteCourse(course: Course) {
    const ok = await confirm({
      title: `永久删除“${course.name}”？`,
      message: "这会删除所有文件、会话和索引数据。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setBusyKey(`course:delete:${course.id}`);
    setError("");
    try {
      await window.brevyn.courses.delete(course.id);
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "删除课程失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function restoreTask(task: BrevynTask, blocked: boolean) {
    if (blocked) {
      setError("请先恢复父级学期或课程，再恢复这个任务。");
      return;
    }
    setBusyKey(`task:restore:${task.id}`);
    setError("");
    try {
      await window.brevyn.tasks.restore(task.id);
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "恢复任务失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function deleteTask(task: BrevynTask) {
    const ok = await confirm({
      title: `永久删除“${task.title}”？`,
      message: "这会删除该任务的文件夹、会话、文件记录、时间表关联和 RAG 索引。删除后无法恢复。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setBusyKey(`task:delete:${task.id}`);
    setError("");
    try {
      await window.brevyn.tasks.delete(task.id);
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "删除任务失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function restoreThread(thread: Thread, blocked: boolean) {
    if (blocked) {
      setError("请先恢复父级学期或课程，再恢复这个会话。");
      return;
    }
    setBusyKey(`thread:restore:${thread.id}`);
    setError("");
    try {
      await window.brevyn.threads.restore(thread.id);
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "恢复会话失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function deleteThread(thread: Thread) {
    const ok = await confirm({
      title: `删除已归档会话“${thread.title}”？`,
      message: "这会永久删除该归档会话。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setBusyKey(`thread:delete:${thread.id}`);
    setError("");
    try {
      await window.brevyn.threads.delete(thread.id);
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "删除会话失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function bulkDeleteSelected(targets: ArchiveSelectionTarget[]) {
    const selectedTargets = compactArchiveSelection(targets.filter((target) => selectedKeys.has(target.key)));
    if (selectedTargets.length === 0) return;
    const ok = await confirm({
      title: `批量删除 ${selectedTargets.length} 项归档内容？`,
      message: "这会永久删除所选学期、课程或会话，删除后无法恢复。",
      confirmLabel: "批量删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setBusyKey("archive:bulk-delete");
    setError("");
    try {
      for (const target of selectedTargets) {
        if (target.kind === "semester") {
          await window.brevyn.semester.delete(target.id);
        } else if (target.kind === "course") {
          await window.brevyn.courses.delete(target.id);
        } else if (target.kind === "task") {
          await window.brevyn.tasks.delete(target.id);
        } else {
          await window.brevyn.threads.delete(target.id);
        }
      }
      setSelectedKeys(new Set());
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "批量删除失败。"));
    } finally {
      setBusyKey("");
    }
  }

  const archivedSemesterCount = groups.filter((group) => group.semester.archivedAt).length;
  const archivedCourseCount = groups.reduce((count, group) => count + group.archivedCourses.length, 0);
  const archivedTaskCount = groups.reduce((count, group) => count + group.archivedTasks.length, 0);
  const archivedThreadCount = groups.reduce((count, group) => count + group.archivedThreads.length, 0);
  const filteredGroups = useMemo(() => filterArchiveGroups(groups, query, filter), [filter, groups, query]);
  const totalPages = Math.max(1, Math.ceil(filteredGroups.length / ARCHIVE_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStart = (safePage - 1) * ARCHIVE_PAGE_SIZE;
  const visibleGroups = filteredGroups.slice(pageStart, pageStart + ARCHIVE_PAGE_SIZE);
  const visibleStart = filteredGroups.length === 0 ? 0 : pageStart + 1;
  const visibleEnd = Math.min(filteredGroups.length, pageStart + ARCHIVE_PAGE_SIZE);
  const allSelectableTargets = useMemo(() => archiveSelectionTargets(filteredGroups), [filteredGroups]);
  const visibleSelectableTargets = useMemo(() => archiveSelectionTargets(visibleGroups), [visibleGroups]);
  const selectedTargets = useMemo(() => allSelectableTargets.filter((target) => selectedKeys.has(target.key)), [allSelectableTargets, selectedKeys]);
  const deleteTargetCount = useMemo(() => compactArchiveSelection(selectedTargets).length, [selectedTargets]);
  const selectedCount = selectedTargets.length;
  const visibleSelectedCount = visibleSelectableTargets.filter((target) => selectedKeys.has(target.key)).length;
  const allVisibleSelected = visibleSelectableTargets.length > 0 && visibleSelectedCount === visibleSelectableTargets.length;

  function toggleSemesterOpen(semesterId: string) {
    setOpenSemesters((current) => ({ ...current, [semesterId]: current[semesterId] === false }));
  }

  function toggleCourseOpen(courseKey: string) {
    setOpenCourses((current) => ({ ...current, [courseKey]: current[courseKey] === false }));
  }

  function toggleSelection(key: ArchiveSelectionKey, selected?: boolean) {
    setSelectedKeys((current) => {
      const next = new Set(current);
      const shouldSelect = selected ?? !next.has(key);
      if (shouldSelect) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function toggleVisibleSelection() {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const target of visibleSelectableTargets) next.delete(target.key);
      } else {
        for (const target of visibleSelectableTargets) next.add(target.key);
      }
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {confirmDialog}
      <section className="rounded-lg border bg-background/70 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Archive className="h-4 w-4" />
              归档中心
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              恢复已归档的学期、课程、任务和会话。永久删除只对已归档内容开放。
            </div>
          </div>
          <ActionButton icon={<RefreshCw className={cx("h-3.5 w-3.5", loading && "animate-spin")} />} label="刷新" onClick={() => void loadArchive()} disabled={loading} />
        </div>
        <div className="mt-3 grid gap-2 text-[11px] text-muted-foreground md:grid-cols-4">
          <ArchiveMetric label="学期" value={archivedSemesterCount} />
          <ArchiveMetric label="课程" value={archivedCourseCount} />
          <ArchiveMetric label="任务" value={archivedTaskCount} />
          <ArchiveMetric label="会话" value={archivedThreadCount} />
        </div>
        <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
          <label className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              className="h-9 w-full rounded-md border bg-card pl-8 pr-3 text-xs text-foreground outline-none transition focus:ring-2 focus:ring-ring/20"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="筛选已归档的学期、课程、任务或会话"
            />
          </label>
          <div className="flex shrink-0 flex-wrap gap-1">
            {archiveFilters.map((item) => (
              <button
                key={item.value}
                type="button"
                className={cx(
                  "h-8 rounded-md border px-2.5 text-[11px] font-medium transition",
                  filter === item.value ? "border-foreground/25 bg-foreground text-background" : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                onClick={() => setFilter(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        {error && <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900">{error}</div>}
      </section>

      {loading ? (
        <div className="rounded-lg border border-dashed bg-background/55 px-4 py-10 text-center text-xs text-muted-foreground">正在加载归档内容...</div>
      ) : groups.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-background/55 px-4 py-10 text-center text-xs text-muted-foreground">暂无已归档的学期、课程、任务或会话。</div>
      ) : filteredGroups.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-background/55 px-4 py-10 text-center text-xs text-muted-foreground">没有符合筛选条件的归档内容。</div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>显示 {visibleStart}-{visibleEnd} / 共 {filteredGroups.length}</span>
            <div className="flex flex-wrap items-center gap-1">
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md border bg-card px-2 text-[10px] font-medium transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                disabled={visibleSelectableTargets.length === 0 || busyKey === "archive:bulk-delete"}
                onClick={toggleVisibleSelection}
              >
                {allVisibleSelected ? "取消当前页" : "选择当前页"}
              </button>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md border bg-card px-2 text-[10px] font-medium transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                disabled={selectedCount === 0 || busyKey === "archive:bulk-delete"}
                onClick={() => setSelectedKeys(new Set())}
              >
                清空选择
              </button>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md border bg-card px-2 text-[10px] font-medium text-muted-foreground transition hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={selectedCount === 0 || busyKey === "archive:bulk-delete"}
                onClick={() => void bulkDeleteSelected(allSelectableTargets)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {busyKey === "archive:bulk-delete" ? "删除中..." : `批量删除${deleteTargetCount ? ` ${deleteTargetCount}` : ""}`}
              </button>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md border bg-card px-2 text-[10px] font-medium transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                disabled={safePage <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                上一页
              </button>
              <span className="rounded-md bg-muted px-2 py-1 text-[10px]">{safePage}/{totalPages}</span>
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md border bg-card px-2 text-[10px] font-medium transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                disabled={safePage >= totalPages}
                onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              >
                下一页
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          {visibleGroups.map((group) => {
            const semesterArchived = Boolean(group.semester.archivedAt);
            const homeThreads = group.homeThreads;
            const courseEntries = group.courseEntries;
            const semesterOpen = openSemesters[group.semester.id] !== false;
            const semesterKey = archiveSelectionKey("semester", group.semester.id);
            return (
              <section key={group.semester.id} className="overflow-hidden rounded-lg border bg-background/70">
                <div className={cx("flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3", semesterArchived ? "bg-muted/45" : "bg-card/70")}>
                  <div className="flex min-w-0 flex-1 items-start gap-2">
                    {semesterArchived && group.semesterVisible && (
                      <ArchiveCheckbox
                        checked={selectedKeys.has(semesterKey)}
                        label={`选择学期 ${group.semester.term}`}
                        onChange={(checked) => toggleSelection(semesterKey, checked)}
                      />
                    )}
                    <button
                      type="button"
                      className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                      title={semesterOpen ? "折叠学期" : "展开学期"}
                      onClick={() => toggleSemesterOpen(group.semester.id)}
                    >
                      <ChevronDown className={cx("h-3.5 w-3.5 transition-transform duration-150", !semesterOpen && "-rotate-90")} />
                    </button>
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="min-w-0 max-w-full break-words text-sm font-semibold leading-5" title={group.semester.term}>{group.semester.term}</span>
                        <span className={cx("rounded px-1.5 py-0.5 text-[9px] uppercase", semesterArchived ? "bg-amber-50 text-amber-800" : "bg-emerald-50 text-emerald-700")}>
                          {semesterArchived ? "已归档学期" : "活跃学期"}
                        </span>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {group.semester.semesterNo} · {group.archivedCourses.length} 门已归档课程 · {group.archivedTasks.length} 个已归档任务 · {group.archivedThreads.length} 个已归档会话
                      </div>
                    </div>
                  </div>
                  {semesterArchived && group.semesterVisible && (
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <ArchiveActionButton
                        icon={<RotateCcw className="h-3.5 w-3.5" />}
                        label="恢复学期"
                        busy={busyKey === `semester:restore:${group.semester.id}`}
                        onClick={() => void restoreSemester(group.semester)}
                      />
                      <ArchiveActionButton
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        label="删除"
                        danger
                        busy={busyKey === `semester:delete:${group.semester.id}`}
                        onClick={() => void deleteSemester(group.semester)}
                      />
                    </div>
                  )}
                </div>

                <div className={cx("grid transition-[grid-template-rows] duration-200 ease-out", semesterOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                  <div className="min-h-0 overflow-hidden">
                <div className="space-y-3 p-4">
                  {semesterArchived && (
                    <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-900">
                      该学期已归档。请先恢复学期，再恢复其下课程或会话。
                    </div>
                  )}

                  {homeThreads.length > 0 && (
                    <section className="rounded-lg border bg-background/65 p-3">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs font-semibold">
                          <MessageSquare className="h-3.5 w-3.5" />
                          主页会话
                        </div>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{homeThreads.length}</span>
                      </div>
                      <div className="space-y-2">
                        {homeThreads.map((thread) => (
                          <ArchivedThreadRow
                            key={thread.id}
                            thread={thread}
                            restoreBlocked={semesterArchived}
                            busyKey={busyKey}
                            selected={selectedKeys.has(archiveSelectionKey("thread", thread.id))}
                            onSelect={(checked) => toggleSelection(archiveSelectionKey("thread", thread.id), checked)}
                            onRestore={() => void restoreThread(thread, semesterArchived)}
                            onDelete={() => void deleteThread(thread)}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  {courseEntries.length > 0 && (
                    <ArchivePanel icon={<BookOpen className="h-3.5 w-3.5" />} title="课程" count={courseEntries.length}>
                      <div className="space-y-2">
                        {courseEntries.map((entry) => {
                          const courseArchived = Boolean(entry.course?.archivedAt);
                          const restoreBlocked = semesterArchived || courseArchived;
                          const archivedTaskIds = new Set(entry.tasks.map((task) => task.id));
                          const courseOpenKey = `${group.semester.id}:${entry.courseId}`;
                          const courseOpen = openCourses[courseOpenKey] !== false;
                          const courseKey = archiveSelectionKey("course", entry.courseId);
                          return (
                            <div key={entry.courseId} className="rounded-lg border bg-card p-3">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="flex min-w-0 flex-1 items-start gap-2">
                                  {entry.course && courseArchived && (
                                    <ArchiveCheckbox
                                      checked={selectedKeys.has(courseKey)}
                                      label={`选择课程 ${entry.course.name}`}
                                      onChange={(checked) => toggleSelection(courseKey, checked)}
                                    />
                                  )}
                                  <button
                                    type="button"
                                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
                                    title={courseOpen ? "折叠课程" : "展开课程"}
                                    onClick={() => toggleCourseOpen(courseOpenKey)}
                                  >
                                    <ChevronDown className={cx("h-3.5 w-3.5 transition-transform duration-150", !courseOpen && "-rotate-90")} />
                                  </button>
                                  <div className="min-w-0">
                                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                                      <span className="min-w-0 max-w-full break-words text-xs font-semibold leading-5" title={entry.course?.name || entry.courseId}>{entry.course?.name || `课程 ${shortId(entry.courseId)}`}</span>
                                      {entry.course?.code && <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{entry.course.code}</span>}
                                      {courseArchived ? (
                                        <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">已归档课程</span>
                                      ) : entry.course ? (
                                        <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] uppercase text-emerald-700">活跃课程</span>
                                      ) : null}
                                    </div>
                                    <div className="mt-1 text-[11px] text-muted-foreground">
                                      {entry.tasks.length} 个已归档任务 · {entry.threads.length} 个已归档会话 · {entry.course ? entry.course.instructor || "无教师信息" : "课程元数据未加载"}
                                    </div>
                                  </div>
                                </div>
                                {entry.course && courseArchived && (
                                  <div className="flex shrink-0 flex-wrap gap-2">
                                    <ArchiveActionButton
                                      icon={<RotateCcw className="h-3.5 w-3.5" />}
                                      label="恢复课程"
                                      disabled={semesterArchived}
                                      busy={busyKey === `course:restore:${entry.course.id}`}
                                      onClick={() => void restoreCourse(entry.course as Course, semesterArchived)}
                                    />
                                    <ArchiveActionButton
                                      icon={<Trash2 className="h-3.5 w-3.5" />}
                                      label="删除"
                                      danger
                                      busy={busyKey === `course:delete:${entry.course.id}`}
                                      onClick={() => void deleteCourse(entry.course as Course)}
                                    />
                                  </div>
                                )}
                              </div>

                              {(entry.tasks.length > 0 || entry.threads.length > 0) && (
                                <div className={cx("grid transition-[grid-template-rows] duration-200 ease-out", courseOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}>
                                  <div className="min-h-0 overflow-hidden">
                                    <div className="mt-3 space-y-2">
                                      {entry.tasks.map((task) => (
                                        <ArchivedTaskRow
                                          key={task.id}
                                          task={task}
                                          restoreBlocked={restoreBlocked}
                                          busyKey={busyKey}
                                          selected={selectedKeys.has(archiveSelectionKey("task", task.id))}
                                          onSelect={(checked) => toggleSelection(archiveSelectionKey("task", task.id), checked)}
                                          onRestore={() => void restoreTask(task, restoreBlocked)}
                                          onDelete={() => void deleteTask(task)}
                                        />
                                      ))}
                                      {entry.threads.map((thread) => {
                                        const threadRestoreBlocked = restoreBlocked || Boolean(thread.taskId && archivedTaskIds.has(thread.taskId));
                                        return (
                                          <ArchivedThreadRow
                                            key={thread.id}
                                            thread={thread}
                                            restoreBlocked={threadRestoreBlocked}
                                            busyKey={busyKey}
                                            selected={selectedKeys.has(archiveSelectionKey("thread", thread.id))}
                                            onSelect={(checked) => toggleSelection(archiveSelectionKey("thread", thread.id), checked)}
                                            onRestore={() => void restoreThread(thread, threadRestoreBlocked)}
                                            onDelete={() => void deleteThread(thread)}
                                          />
                                        );
                                      })}
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </ArchivePanel>
                  )}
                </div>
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function filterArchiveGroups(groups: ArchiveSemesterGroup[], query: string, filter: ArchiveFilter): ArchiveDisplayGroup[] {
  const normalizedQuery = normalizeArchiveQuery(query);
  const hasQuery = normalizedQuery.length > 0;

  return groups
    .map((group) => {
      const semesterArchived = Boolean(group.semester.archivedAt);
      const semesterMatches = semesterArchived && archiveTextMatches(
        [group.semester.term, group.semester.semesterNo, group.semester.id],
        normalizedQuery,
      );
      const semesterVisible = (filter === "all" || filter === "semesters") && semesterArchived && (!hasQuery || semesterMatches);
      const includeSessions = filter === "all" || filter === "sessions";
      const includeTasks = filter === "all" || filter === "tasks";
      const includeCourses = filter === "all" || filter === "courses" || filter === "tasks" || filter === "sessions";
      const homeThreads = includeSessions
        ? group.archivedThreads
          .filter((thread) => thread.courseId === SEMESTER_HOME_COURSE_ID)
          .filter((thread) => !hasQuery || archiveThreadMatches(thread, normalizedQuery))
        : [];
      const courseEntries = includeCourses
        ? archiveCourseEntries(group)
          .map((entry) => filterArchiveCourseEntry(entry, normalizedQuery, filter, hasQuery, includeTasks, includeSessions))
          .filter((entry): entry is ArchiveCourseEntry => Boolean(entry))
        : [];

      return {
        ...group,
        semesterVisible,
        homeThreads,
        courseEntries,
      };
    })
    .filter((group) => group.semesterVisible || group.homeThreads.length > 0 || group.courseEntries.length > 0);
}

function filterArchiveCourseEntry(entry: ArchiveCourseEntry, query: string, filter: ArchiveFilter, hasQuery: boolean, includeTasks: boolean, includeSessions: boolean): ArchiveCourseEntry | null {
  const courseMatches = archiveTextMatches(
    [entry.course?.name, entry.course?.code, entry.course?.instructor, entry.courseId],
    query,
  );
  const matchingTasks = includeTasks ? entry.tasks.filter((task) => archiveTaskMatches(task, query)) : [];
  const matchingThreads = entry.threads.filter((thread) => archiveThreadMatches(thread, query));

  const scopedEntry = {
    ...entry,
    tasks: includeTasks ? entry.tasks : [],
    threads: includeSessions ? entry.threads : [],
  };

  if (filter === "tasks") {
    if (!hasQuery) return entry.tasks.length ? { ...entry, tasks: entry.tasks, threads: [] } : null;
    return matchingTasks.length ? { ...entry, tasks: matchingTasks, threads: [] } : null;
  }

  if (filter === "sessions") {
    if (!hasQuery) return entry.threads.length ? { ...entry, tasks: [], threads: entry.threads } : null;
    return matchingThreads.length ? { ...entry, tasks: [], threads: matchingThreads } : null;
  }

  if (filter === "courses") {
    return !hasQuery || courseMatches ? { ...entry, tasks: [], threads: [] } : null;
  }

  if (!hasQuery) return scopedEntry;
  if (courseMatches) return scopedEntry;
  if (matchingTasks.length || matchingThreads.length) return { ...entry, tasks: matchingTasks, threads: matchingThreads };
  return null;
}

function archiveTaskMatches(task: BrevynTask, query: string): boolean {
  return archiveTextMatches([task.title, task.taskType, task.status, task.dueAt, task.id, task.courseId], query);
}

function archiveThreadMatches(thread: Thread, query: string): boolean {
  return archiveTextMatches([thread.title, thread.taskId, thread.id, thread.threadType], query);
}

function archiveTextMatches(values: Array<string | number | undefined>, query: string): boolean {
  if (!query) return true;
  return values.some((value) => String(value ?? "").toLowerCase().includes(query));
}

function normalizeArchiveQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function archiveCourseEntries(group: ArchiveSemesterGroup): ArchiveCourseEntry[] {
  const entries = new Map<string, ArchiveCourseEntry>();
  const coursesById = new Map(group.courses.map((course) => [course.id, course]));
  for (const course of group.archivedCourses) {
    entries.set(course.id, { courseId: course.id, course, tasks: [], threads: [] });
  }
  for (const task of group.archivedTasks) {
    const existing = entries.get(task.courseId) || { courseId: task.courseId, course: coursesById.get(task.courseId), tasks: [], threads: [] };
    existing.tasks.push(task);
    entries.set(task.courseId, existing);
  }
  for (const thread of group.archivedThreads) {
    if (thread.courseId === SEMESTER_HOME_COURSE_ID) continue;
    const existing = entries.get(thread.courseId) || { courseId: thread.courseId, course: coursesById.get(thread.courseId), tasks: [], threads: [] };
    existing.threads.push(thread);
    entries.set(thread.courseId, existing);
  }
  return Array.from(entries.values()).sort((a, b) => (a.course?.name || a.courseId).localeCompare(b.course?.name || b.courseId));
}

function archiveSelectionKey(kind: ArchiveSelectionKind, id: string): ArchiveSelectionKey {
  return `${kind}:${id}`;
}

function archiveSelectionTargets(groups: ArchiveDisplayGroup[]): ArchiveSelectionTarget[] {
  return groups.flatMap((group) => {
    const targets: ArchiveSelectionTarget[] = [];
    if (group.semesterVisible && group.semester.archivedAt) {
      targets.push({
        key: archiveSelectionKey("semester", group.semester.id),
        kind: "semester",
        id: group.semester.id,
        label: group.semester.term,
        semesterId: group.semester.id,
      });
    }
    for (const thread of group.homeThreads) {
      targets.push({
        key: archiveSelectionKey("thread", thread.id),
        kind: "thread",
        id: thread.id,
        label: thread.title,
        semesterId: group.semester.id,
        courseId: SEMESTER_HOME_COURSE_ID,
      });
    }
    for (const entry of group.courseEntries) {
      if (entry.course?.archivedAt) {
        targets.push({
          key: archiveSelectionKey("course", entry.course.id),
          kind: "course",
          id: entry.course.id,
          label: entry.course.name,
          semesterId: group.semester.id,
          courseId: entry.course.id,
        });
      }
      for (const thread of entry.threads) {
        targets.push({
          key: archiveSelectionKey("thread", thread.id),
          kind: "thread",
          id: thread.id,
          label: thread.title,
          semesterId: group.semester.id,
          courseId: entry.courseId,
        });
      }
      for (const task of entry.tasks) {
        targets.push({
          key: archiveSelectionKey("task", task.id),
          kind: "task",
          id: task.id,
          label: task.title,
          semesterId: group.semester.id,
          courseId: task.courseId,
        });
      }
    }
    return targets;
  });
}

function compactArchiveSelection(targets: ArchiveSelectionTarget[]): ArchiveSelectionTarget[] {
  const selectedSemesterIds = new Set(targets.filter((target) => target.kind === "semester").map((target) => target.semesterId));
  const selectedCourseIds = new Set(targets.filter((target) => target.kind === "course").map((target) => target.courseId).filter(Boolean));
  return targets.filter((target) => {
    if (target.kind === "semester") return true;
    if (selectedSemesterIds.has(target.semesterId)) return false;
    if ((target.kind === "task" || target.kind === "thread") && target.courseId && selectedCourseIds.has(target.courseId)) return false;
    return true;
  });
}

function compareSemestersForArchive(a: SemesterWorkspace, b: SemesterWorkspace): number {
  const aTime = Date.parse(a.archivedAt || a.startsAt || a.recognizedAt || "");
  const bTime = Date.parse(b.archivedAt || b.startsAt || b.recognizedAt || "");
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}
