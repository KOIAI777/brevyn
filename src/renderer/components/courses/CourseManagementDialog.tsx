import {
  AlertCircle,
  Archive,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Database,
  FileText,
  FolderOpen,
  Layers3,
  Loader2,
  NotebookTabs,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Course, CourseFileSection, EmbeddingIndexHealth, IndexingJob, RagSearchResult, SemesterWorkspace, TaskIconKey, TaskType, BrevynTask, WorkspaceFileNode } from "@/types/domain";
import { cx } from "@/lib/cn";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DropdownSelect, type DropdownOption } from "@/components/ui/DropdownSelect";
import { CourseIcon, COURSE_ICON_OPTIONS } from "@/components/courses/CourseIcon";
import { TaskIcon, TASK_ICON_OPTIONS, resolveTaskIcon } from "@/components/courses/TaskIcon";
import { FileIndexingBadge, IndexingStatusBadge } from "@/components/files/FileIndexingBadge";
import { VisionRecognitionImportButton } from "@/components/vision/VisionRecognitionImportDialog";
import { lectureWeekNumberFromPath, semesterLectureWeekNumbers } from "../../../shared/semester-weeks";

const DEFAULT_TASK_TYPE = "作业";
const TASK_TYPE_PRESETS: TaskType[] = ["作业", "Essay", "Presentation", "Exam", "Project"];
const RAG_RESULTS_PAGE_SIZE = 5;
const MAX_LECTURE_WEEK_OPTIONS = 30;
const COURSE_COLORS = ["#111827", "#2563eb", "#059669", "#dc2626", "#d97706", "#7c3aed", "#0891b2", "#be123c"];
const DEFAULT_COURSE_ICON: Course["icon"] = "graduation-cap";
const COURSE_ICON_OPTION_KEYS = new Set<Course["icon"]>(COURSE_ICON_OPTIONS.map((option) => option.key));
type CoursePanel = "files" | "indexing" | "search";
type AutoOpenLectureWeek = { sectionId: string; weekNumber: number; token: number };
type TaskIconDraft = TaskIconKey | "";

export function CourseManagementDialog({
  semester,
  courses,
  activeCourseId,
  onCourseCreated,
  onCourseUpdated,
  onTaskCreated,
  onTaskUpdated,
  onWorkspaceChanged,
  onClose,
}: {
  semester?: SemesterWorkspace | null;
  courses: Course[];
  activeCourseId: string;
  onCourseCreated: (course: Course) => void;
  onCourseUpdated: (course: Course) => void;
  onTaskCreated: (task: BrevynTask) => void;
  onTaskUpdated: (task: BrevynTask) => void;
  onWorkspaceChanged?: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [archivedCourses, setArchivedCourses] = useState<Course[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [viewingCourseId, setViewingCourseId] = useState(activeCourseId);
  const [courseBusyId, setCourseBusyId] = useState("");
  const [courseActionError, setCourseActionError] = useState("");
  const [courseActionNotice, setCourseActionNotice] = useState("");
  const [editingCourseDetails, setEditingCourseDetails] = useState(false);
  const [savingCourseDetails, setSavingCourseDetails] = useState(false);
  const [courseDetailsDraft, setCourseDetailsDraft] = useState({
    code: "",
    instructor: "",
    meetingTime: "",
    location: "",
    color: "#111827",
    icon: DEFAULT_COURSE_ICON,
  });
  const [coursePanel, setCoursePanel] = useState<CoursePanel>("files");

  useEffect(() => {
    setViewingCourseId(activeCourseId);
  }, [activeCourseId]);

  const archivedCourseIds = useMemo(() => new Set(archivedCourses.map((course) => course.id)), [archivedCourses]);
  const activeCourses = useMemo(() => courses.filter((course) => !course.archivedAt && !archivedCourseIds.has(course.id)), [archivedCourseIds, courses]);
  const displayedCourses = showArchived ? [...activeCourses, ...archivedCourses] : activeCourses;
  const activeCourse = displayedCourses.find((course) => course.id === viewingCourseId);
  const activeCourseArchived = Boolean(activeCourse?.archivedAt);
  const activeCourseIsSemesterHome = activeCourse?.workspaceKind === "semester_home";
  const courseReadOnlyReason = !activeCourse ? "请先选择课程。" : activeCourseArchived ? "请先恢复课程，再继续编辑。" : "";
  const [sections, setSections] = useState<CourseFileSection[]>([]);
  const [indexingSectionId, setIndexingSectionId] = useState("");
  const [indexingJobs, setIndexingJobs] = useState<IndexingJob[]>([]);
  const [indexHealth, setIndexHealth] = useState<EmbeddingIndexHealth | null>(null);
  const [loadingIndexingJobs, setLoadingIndexingJobs] = useState(false);
  const [ragQuery, setRagQuery] = useState("");
  const [ragResults, setRagResults] = useState<RagSearchResult[]>([]);
  const [ragSearching, setRagSearching] = useState(false);
  const [ragError, setRagError] = useState("");
  const [indexingNotice, setIndexingNotice] = useState<{ jobId: string; message: string } | null>(null);
  const [taskName, setTaskName] = useState("");
  const [taskType, setTaskType] = useState<TaskType>(DEFAULT_TASK_TYPE);
  const [taskIcon, setTaskIcon] = useState<TaskIconDraft>("");
  const [creatingTask, setCreatingTask] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [editingTaskId, setEditingTaskId] = useState("");
  const [taskEditDraft, setTaskEditDraft] = useState({ title: "", taskType: DEFAULT_TASK_TYPE as TaskType, icon: "" as TaskIconDraft });
  const [savingTaskId, setSavingTaskId] = useState("");
  const [archivingTaskId, setArchivingTaskId] = useState("");
  const [taskEditError, setTaskEditError] = useState("");
  const [newCourseName, setNewCourseName] = useState("");
  const [newCourseCode, setNewCourseCode] = useState("");
  const [newCourseInstructor, setNewCourseInstructor] = useState("");
  const [creatingCourse, setCreatingCourse] = useState(false);
  const [newCourseError, setNewCourseError] = useState("");
  const [showCreateCourse, setShowCreateCourse] = useState(false);
  const [uploadingSectionId, setUploadingSectionId] = useState("");
  const [autoOpenLectureWeek, setAutoOpenLectureWeek] = useState<AutoOpenLectureWeek | null>(null);
  const courseViewRequestRef = useRef(0);
  const ragSearchRequestRef = useRef(0);
  const seenIndexingFailuresRef = useRef(new Set<string>());
  const indexingFailureBaselineCourseRef = useRef("");
  const { confirm, confirmDialog } = useConfirmDialog();
  const canCreateCourse = Boolean(semester?.id);
  const lectureWeekOptions = useMemo(() => semesterWeekOptions(semester), [semester]);

  const existingTaskTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const section of sections) {
      if (section.kind !== "task" || !section.taskType) continue;
      seen.add(section.taskType);
    }
    return Array.from(seen);
  }, [sections]);
  const foundationSections = useMemo(() => sections.filter((section) => section.kind !== "task"), [sections]);
  const taskSections = useMemo(() => sections.filter((section) => section.kind === "task"), [sections]);
  const hasActiveIndexingJob = useMemo(() => indexingJobs.some((job) => job.status === "queued" || job.status === "indexing"), [indexingJobs]);
  const activeCourseMeta = activeCourse ? courseMetaItems(activeCourse) : [];

  useEffect(() => {
    void loadArchivedCourses();
  }, []);

  useEffect(() => {
    setRagResults([]);
    setRagError("");
    setIndexingNotice(null);
    seenIndexingFailuresRef.current.clear();
    indexingFailureBaselineCourseRef.current = "";
    ragSearchRequestRef.current += 1;
    setTaskError("");
    setEditingTaskId("");
    setTaskEditError("");
    setSavingTaskId("");
    setArchivingTaskId("");
    setTaskIcon("");
    setCourseActionError("");
    setEditingCourseDetails(false);
    resetCourseDetailsDraft(activeCourse);
    if (!activeCourse?.id) {
      courseViewRequestRef.current += 1;
      setSections([]);
      setIndexingJobs([]);
      setIndexHealth(null);
      setLoadingIndexingJobs(false);
      return;
    }
    void loadCourseView(activeCourse.id);
  }, [activeCourse?.id]);

  useEffect(() => {
    if (!activeCourse?.id) return;
    const timer = window.setInterval(() => {
      void loadCourseView(activeCourse.id, { showLoading: false });
    }, hasActiveIndexingJob ? 1600 : 5000);
    return () => window.clearInterval(timer);
  }, [activeCourse?.id, hasActiveIndexingJob]);

  useEffect(() => {
    const courseId = activeCourse?.id || "";
    if (!courseId) return;
    if (indexingFailureBaselineCourseRef.current !== courseId) {
      seenIndexingFailuresRef.current = new Set(indexingJobs.filter((job) => job.status === "failed").map((job) => job.id));
      indexingFailureBaselineCourseRef.current = courseId;
      return;
    }
    const failedJob = indexingJobs.find((job) => job.status === "failed" && job.error && !seenIndexingFailuresRef.current.has(job.id));
    if (!failedJob?.error) return;
    seenIndexingFailuresRef.current.add(failedJob.id);
    setIndexingNotice({ jobId: failedJob.id, message: failedJob.error });
  }, [activeCourse?.id, indexingJobs]);

  useEffect(() => {
    if (!indexingNotice) return;
    const timer = window.setTimeout(() => setIndexingNotice(null), 9000);
    return () => window.clearTimeout(timer);
  }, [indexingNotice]);

  useEffect(() => {
    if (!courseActionNotice) return;
    const timer = window.setTimeout(() => setCourseActionNotice(""), 7000);
    return () => window.clearTimeout(timer);
  }, [courseActionNotice]);

  async function loadArchivedCourses() {
    try {
      setArchivedCourses(await window.brevyn.courses.listArchived());
    } catch (error) {
      setArchivedCourses([]);
      setCourseActionError(errorMessage(error, "加载已归档课程失败。"));
    }
  }

  async function loadCourseView(courseId: string, options: { showLoading?: boolean } = {}): Promise<boolean> {
    const requestId = courseViewRequestRef.current + 1;
    courseViewRequestRef.current = requestId;
    if (options.showLoading !== false) setLoadingIndexingJobs(true);
    try {
      const [nextSections, nextIndexingJobs, nextIndexHealth] = await Promise.all([
        window.brevyn.files.sections(courseId),
        window.brevyn.files.indexingJobs(courseId),
        window.brevyn.files.indexHealth(courseId),
      ]);
      if (courseViewRequestRef.current !== requestId) return false;
      setSections((current) => reconcileCourseSections(current, nextSections));
      setIndexingJobs((current) => (areIndexingJobsEqual(current, nextIndexingJobs) ? current : nextIndexingJobs));
      setIndexHealth((current) => (areEmbeddingIndexHealthEqual(current, nextIndexHealth) ? current : nextIndexHealth));
      return true;
    } catch (error) {
      if (courseViewRequestRef.current === requestId) {
        setSections([]);
        setIndexingJobs([]);
        setIndexHealth(null);
        setCourseActionError(errorMessage(error, "加载课程视图失败。"));
      }
      return false;
    } finally {
      if (courseViewRequestRef.current === requestId) setLoadingIndexingJobs(false);
    }
  }

  async function createCourse() {
    if (!canCreateCourse) {
      setNewCourseError("请先选择或创建学期，再创建课程。");
      return;
    }
    const name = newCourseName.trim();
    const code = newCourseCode.trim();
    if (!name || !code) {
      setNewCourseError("课程名称和课程代码不能为空。");
      return;
    }
    setNewCourseError("");
    setCreatingCourse(true);
    try {
      const created = await window.brevyn.courses.create({
        name,
        code,
        instructor: newCourseInstructor.trim() || undefined,
      });
      onCourseCreated(created);
      setViewingCourseId(created.id);
      await loadArchivedCourses();
      setNewCourseName("");
      setNewCourseCode("");
      setNewCourseInstructor("");
      setShowCreateCourse(false);
      await loadCourseView(created.id);
    } catch (error) {
      setNewCourseError(error instanceof Error ? error.message : "创建课程失败。");
    } finally {
      setCreatingCourse(false);
    }
  }

  function resetCourseDetailsDraft(course?: Course) {
    setCourseDetailsDraft({
      code: course?.code || "",
      instructor: course?.instructor || "",
      meetingTime: course?.meetingTime || "",
      location: course?.location || "",
      color: course?.color || "#111827",
      icon: normalizeCourseIconDraft(course?.icon),
    });
  }

  async function saveCourseDetails() {
    if (!activeCourse?.id || activeCourseArchived || savingCourseDetails) return;
    setSavingCourseDetails(true);
    setCourseActionError("");
    try {
      const updated = await window.brevyn.courses.update({
        id: activeCourse.id,
        code: courseDetailsDraft.code,
        instructor: courseDetailsDraft.instructor,
        meetingTime: courseDetailsDraft.meetingTime || null,
        location: courseDetailsDraft.location || null,
        color: courseDetailsDraft.color,
        icon: courseDetailsDraft.icon,
      });
      onCourseUpdated(updated);
      resetCourseDetailsDraft(updated);
      setEditingCourseDetails(false);
    } catch (error) {
      setCourseActionError(errorMessage(error, "更新课程详情失败。"));
    } finally {
      setSavingCourseDetails(false);
    }
  }

  async function createTask() {
    if (creatingTask) return;
    if (!activeCourse?.id) {
      setTaskError(courseReadOnlyReason);
      return;
    }
    if (activeCourseArchived) {
      setTaskError(courseReadOnlyReason);
      return;
    }
    if (activeCourseIsSemesterHome) {
      setTaskError("学期总览只用于管理学期资料，请在具体课程下创建任务。");
      return;
    }
    const title = taskName.trim();
    if (!title) {
      setTaskError("任务名称不能为空。");
      return;
    }
    setCreatingTask(true);
    setTaskError("");
    try {
      const task = await window.brevyn.tasks.create({
        courseId: activeCourse.id,
        title,
        taskType,
        icon: resolveTaskIcon({ icon: taskIcon || undefined, title, taskType }),
      });
      onTaskCreated(task);
      setTaskName("");
      setTaskIcon("");
      await loadCourseView(activeCourse.id);
    } catch (error) {
      setTaskError(errorMessage(error, "创建任务失败。"));
    } finally {
      setCreatingTask(false);
    }
  }

  function startTaskEdit(section: CourseFileSection) {
    if (section.kind !== "task" || !section.taskId) return;
    setTaskEditError("");
    setEditingTaskId(section.taskId);
    setTaskEditDraft({
      title: taskNameFromSection(section),
      taskType: section.taskType || DEFAULT_TASK_TYPE,
      icon: resolveTaskIcon({ icon: section.icon, title: taskNameFromSection(section), taskType: section.taskType || DEFAULT_TASK_TYPE }),
    });
  }

  function cancelTaskEdit() {
    setEditingTaskId("");
    setTaskEditError("");
    setSavingTaskId("");
    setTaskEditDraft({ title: "", taskType: DEFAULT_TASK_TYPE, icon: "" });
  }

  async function saveTaskEdit() {
    if (!editingTaskId || savingTaskId) return;
    if (!activeCourse?.id) {
      setTaskEditError(courseReadOnlyReason);
      return;
    }
    if (activeCourseArchived) {
      setTaskEditError(courseReadOnlyReason);
      return;
    }
    const title = taskEditDraft.title.trim();
    const nextTaskType = taskEditDraft.taskType.trim() || DEFAULT_TASK_TYPE;
    if (!title) {
      setTaskEditError("作业名称不能为空。");
      return;
    }
    setSavingTaskId(editingTaskId);
    setTaskEditError("");
    try {
      const updated = await window.brevyn.tasks.update({
        id: editingTaskId,
        title,
        taskType: nextTaskType,
        icon: resolveTaskIcon({ icon: taskEditDraft.icon || undefined, title, taskType: nextTaskType }),
      });
      onTaskUpdated(updated);
      setEditingTaskId("");
      setTaskEditDraft({ title: "", taskType: DEFAULT_TASK_TYPE, icon: "" });
      await loadCourseView(activeCourse.id);
    } catch (error) {
      setTaskEditError(errorMessage(error, "更新课程作业失败。"));
    } finally {
      setSavingTaskId("");
    }
  }

  async function archiveTask(section: CourseFileSection) {
    if (section.kind !== "task" || !section.taskId || archivingTaskId) return;
    if (!activeCourse?.id) {
      setTaskError(courseReadOnlyReason);
      return;
    }
    if (activeCourseArchived) {
      setTaskError(courseReadOnlyReason);
      return;
    }
    const ok = await confirm({
      title: `归档「${displaySectionTitle(section)}」？`,
      message: "归档后会从课程作业隐藏，文件和索引不会删除；之后可在归档页恢复或永久删除。",
      confirmLabel: "归档",
      cancelLabel: "保留",
    });
    if (!ok) return;

    setArchivingTaskId(section.taskId);
    setTaskError("");
    try {
      await window.brevyn.tasks.archive(section.taskId);
      if (editingTaskId === section.taskId) cancelTaskEdit();
      await loadCourseView(activeCourse.id);
      await onWorkspaceChanged?.();
    } catch (error) {
      setTaskError(errorMessage(error, "归档课程作业失败。"));
    } finally {
      setArchivingTaskId("");
    }
  }

  async function indexAllSections() {
    await runIndexing("all");
  }

  async function indexSection(sectionId: string) {
    await runIndexing(sectionId, sectionId);
  }

  async function runIndexing(indicatorId: string, sectionId?: string) {
    if (!activeCourse?.id) {
      setCourseActionError(courseReadOnlyReason);
      return;
    }
    if (activeCourseArchived) return;
    const existingActiveJob = findActiveIndexingJob(indexingJobs, sectionId);
    setIndexingSectionId(indicatorId);
    setCourseActionError("");
    try {
      await window.brevyn.files.index(activeCourse.id, sectionId);
      setRagError("");
      await loadCourseView(activeCourse.id);
      if (existingActiveJob) {
        setCourseActionError(sectionId && existingActiveJob.sectionId
          ? "这个分区已有索引任务在进行中，已打开现有进度，不会重复创建任务。"
          : "这门课已有索引任务在进行中，已打开现有进度，不会重复创建任务。");
      }
    } catch (error) {
      setCourseActionError(errorMessage(error, "启动索引失败。"));
    } finally {
      setIndexingSectionId("");
    }
  }

  async function uploadToSection(section: CourseFileSection, weekNumber?: number) {
    if (!activeCourse?.id) {
      setCourseActionError(courseReadOnlyReason);
      return;
    }
    if (activeCourseArchived) return;
    setUploadingSectionId(section.id);
    setCourseActionError("");
    try {
      const result = await window.brevyn.files.import({
        courseId: activeCourse.id,
        targetSection: section.kind,
        weekNumber: section.kind === "lecture" ? weekNumber : undefined,
        taskId: section.taskId,
        taskFileBucket: section.kind === "task" ? "materials" : undefined,
      });
      await loadCourseView(activeCourse.id);
      if (section.kind === "lecture" && weekNumber && result.files.length > 0) {
        setAutoOpenLectureWeek({ sectionId: section.id, weekNumber, token: Date.now() });
      }
      if (result.indexingError) {
        setCourseActionError(`已导入 ${result.files.length} 个文件，但索引未排队：${result.indexingError}`);
      } else if (result.indexingNotice) {
        setCourseActionError(result.indexingNotice);
      }
    } catch (error) {
      setCourseActionError(errorMessage(error, "导入文件失败。"));
    } finally {
      setUploadingSectionId("");
    }
  }

  async function cancelIndexing(jobId: string) {
    if (!activeCourse?.id) {
      setCourseActionError(courseReadOnlyReason);
      return;
    }
    setCourseActionError("");
    try {
      await window.brevyn.files.cancelIndexing(jobId);
      await loadCourseView(activeCourse.id);
    } catch (error) {
      setCourseActionError(errorMessage(error, "取消索引失败。"));
    }
  }

  async function searchRag() {
    if (!activeCourse?.id) {
      setRagError(courseReadOnlyReason);
      setRagResults([]);
      return;
    }
    if (activeCourseArchived) {
      setRagError(courseReadOnlyReason);
      setRagResults([]);
      return;
    }
    const query = ragQuery.trim();
    if (!query) return;
    const courseId = activeCourse.id;
    const requestId = ragSearchRequestRef.current + 1;
    ragSearchRequestRef.current = requestId;
    setRagSearching(true);
    setRagError("");
    try {
      const results = await window.brevyn.rag.search(query, courseId);
      if (ragSearchRequestRef.current !== requestId) return;
      setRagResults(results);
    } catch (error) {
      if (ragSearchRequestRef.current !== requestId) return;
      setRagError(errorMessage(error, "向量搜索失败。"));
      setRagResults([]);
    } finally {
      if (ragSearchRequestRef.current === requestId) setRagSearching(false);
    }
  }

  async function archiveCourse(course: Course) {
    const ok = await confirm({
      title: `归档「${course.name}」？`,
      message: "课程会从主工作区隐藏，恢复后可再次显示。",
      confirmLabel: "归档",
      cancelLabel: "保留",
    });
    if (!ok) return;
    setCourseBusyId(course.id);
    setCourseActionError("");
    try {
      await window.brevyn.courses.archive(course.id);
      await loadArchivedCourses();
      onWorkspaceChanged?.();
    } catch (reason) {
      setCourseActionError(errorMessage(reason, "归档课程失败。"));
    } finally {
      setCourseBusyId("");
    }
  }

  async function restoreCourse(course: Course) {
    setCourseBusyId(course.id);
    setCourseActionError("");
    try {
      const restored = await window.brevyn.courses.restore(course.id);
      await loadArchivedCourses();
      onCourseCreated(restored);
      setViewingCourseId(restored.id);
      onWorkspaceChanged?.();
    } catch (reason) {
      setCourseActionError(errorMessage(reason, "恢复课程失败。"));
    } finally {
      setCourseBusyId("");
    }
  }

  async function deleteCourse(course: Course) {
    if (!course.archivedAt) {
      setCourseActionError("请先归档课程，再永久删除。");
      return;
    }
    const ok = await confirm({
      title: `永久删除「${course.name}」？`,
      message: "这会删除该课程的所有文件和索引数据。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setCourseBusyId(course.id);
    setCourseActionError("");
    try {
      await window.brevyn.courses.delete(course.id);
      await loadArchivedCourses();
      onWorkspaceChanged?.();
    } catch (reason) {
      setCourseActionError(errorMessage(reason, "删除课程失败。"));
    } finally {
      setCourseBusyId("");
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/18 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {confirmDialog}
      {indexingNotice && (
        <div className="pointer-events-auto absolute left-1/2 top-5 z-[60] w-[min(620px,calc(100vw-40px))] -translate-x-1/2 rounded-[var(--radius-panel)] border border-red-200 bg-red-50/95 px-4 py-3 text-red-800 shadow-[0_18px_54px_rgba(127,29,29,0.18)] ring-1 ring-white/60 backdrop-blur-xl">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold">向量服务商错误</div>
              <div className="mt-1 max-h-24 overflow-y-auto break-words pr-1 text-[11px] leading-5 brevyn-scrollbar">{indexingNotice.message}</div>
            </div>
            <button
              type="button"
              className="shrink-0 rounded-[var(--radius-control)] p-1 text-red-700/70 transition hover:bg-red-100 hover:text-red-900"
              onClick={() => setIndexingNotice(null)}
              title="关闭"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
      <div className="brevyn-window-surface brevyn-dialog-window flex flex-col overflow-hidden">
        <div className="drag-region flex items-center justify-between bg-[hsl(var(--surface-chrome))] px-4 py-3 shadow-[inset_0_-1px_0_hsl(var(--border)/0.62)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <NotebookTabs className="h-4 w-4" />
              我的课程
            </div>
            <div className="truncate text-[11px] text-muted-foreground">课程、资料、任务</div>
          </div>
          <button
            type="button"
            className="no-drag flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] bg-card text-muted-foreground shadow-sm ring-1 ring-black/[0.06] transition hover:bg-background hover:text-foreground active:scale-[0.98]"
            onClick={onClose}
            title="关闭我的课程"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-4 overflow-hidden p-4 md:grid-cols-[320px_1fr]">
          <aside className="min-h-0 space-y-3 overflow-y-auto pr-1 brevyn-scrollbar">
            <section className="rounded-[var(--radius-card)] bg-background/70 p-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
              <button
                type="button"
                className="flex w-full items-center justify-between rounded-[var(--radius-control)] px-2 py-1.5 text-left text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
                onClick={() => setShowArchived((value) => !value)}
              >
                <span className="font-medium text-foreground">课程</span>
                <span className="rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[10px]">
                  {showArchived ? "含归档" : `${archivedCourses.length} 归档`}
                </span>
              </button>
            </section>
            {courseActionError && (
              <div className="flex gap-1.5 rounded-[var(--radius-control)] bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0 break-words">{courseActionError}</span>
              </div>
            )}
            {courseActionNotice && (
              <div className="flex gap-1.5 rounded-[var(--radius-control)] bg-emerald-50 px-2 py-1.5 text-[11px] leading-4 text-emerald-900">
                <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" />
                <span className="min-w-0 break-words">{courseActionNotice}</span>
              </div>
            )}
            <section className="space-y-2">
              {displayedCourses.map((course) => (
                <CourseListItem
                  key={course.id}
                  course={course}
                  active={course.id === viewingCourseId && !course.archivedAt}
                  busy={courseBusyId === course.id}
                  onSelect={() => !course.archivedAt && setViewingCourseId(course.id)}
                  onArchive={() => void archiveCourse(course)}
                  onRestore={() => void restoreCourse(course)}
                  onDelete={() => void deleteCourse(course)}
                />
              ))}
            </section>

            <section className="rounded-[var(--radius-card)] bg-background/70 p-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
              {!showCreateCourse ? (
                <button
                  type="button"
                  className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[var(--radius-control)] border bg-card px-3 text-xs font-medium text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => setShowCreateCourse(true)}
                  disabled={!canCreateCourse}
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加课程
                </button>
              ) : (
                <div className="p-1">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold">
                      <Plus className="h-3.5 w-3.5" />
                      添加课程
                    </div>
                    <button
                      type="button"
                      className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-accent hover:text-foreground"
                      onClick={() => setShowCreateCourse(false)}
                      title="收起添加课程"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <label className="mb-2 block space-y-1 text-[11px] text-muted-foreground">
                    <span>名称</span>
                    <input
                      className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring/20"
                      value={newCourseName}
                      onChange={(event) => setNewCourseName(event.target.value)}
                      placeholder="例如：宪法学"
                    />
                  </label>
                  <label className="mb-2 block space-y-1 text-[11px] text-muted-foreground">
                    <span>代码</span>
                    <input
                      className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring/20"
                      value={newCourseCode}
                      onChange={(event) => setNewCourseCode(event.target.value)}
                      placeholder="例如：LAW 200"
                    />
                  </label>
                  <label className="mb-2 block space-y-1 text-[11px] text-muted-foreground">
                    <span>教师（可选）</span>
                    <input
                      className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring/20"
                      value={newCourseInstructor}
                      onChange={(event) => setNewCourseInstructor(event.target.value)}
                      placeholder="例如：Prof. Lee"
                    />
                  </label>
                  {newCourseError && <div className="mb-2 rounded-[var(--radius-control)] bg-amber-50 px-2 py-1 text-[11px] text-amber-900">{newCourseError}</div>}
                  {!canCreateCourse && !newCourseError && (
                    <div className="mb-2 rounded-[var(--radius-control)] bg-muted/55 px-2 py-1 text-[11px] leading-5 text-muted-foreground">
                      请先选择或创建学期，再添加课程。
                    </div>
                  )}
                  <button
                    type="button"
                    className="mt-1 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-foreground px-3 text-xs font-medium text-background transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={createCourse}
                    disabled={creatingCourse || !canCreateCourse}
                  >
                    {creatingCourse ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                    {creatingCourse ? "正在添加..." : "添加课程"}
                  </button>
                  <VisionRecognitionImportButton
                    kind="course_timetable"
                    className="mt-2 w-full"
                    onImported={async (draft) => {
                      const importedCourses = draft.kind === "course_timetable" ? draft.applied?.courses || [] : [];
                      for (const importedCourse of importedCourses) {
                        if (courses.some((course) => course.id === importedCourse.id)) onCourseUpdated(importedCourse);
                        else onCourseCreated(importedCourse);
                      }
                      if (importedCourses[0]?.id) {
                        setViewingCourseId(importedCourses[0].id);
                        setShowCreateCourse(false);
                        setCourseActionNotice(`已导入 ${importedCourses.length} 门课程，已打开「${importedCourses[0].name}」。`);
                      }
                      await onWorkspaceChanged?.();
                      await loadArchivedCourses();
                      if (importedCourses[0]?.id) await loadCourseView(importedCourses[0].id);
                      else if (activeCourse?.id) await loadCourseView(activeCourse.id);
                    }}
                  />
                </div>
              )}
            </section>
          </aside>

          <section className="flex min-h-0 flex-col overflow-hidden rounded-[var(--radius-card)] bg-background/70 p-4 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-base font-semibold">{activeCourse?.name || "未选择课程"}</div>
                {activeCourseMeta.length > 0 && (
                  <div className="mt-2 flex max-w-full flex-wrap gap-1.5">
                    {activeCourseMeta.map((item) => (
                      <span key={item} className="max-w-[14rem] truncate rounded-[var(--radius-badge)] bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {item}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {coursePanel !== "files" && (
                  <CoursePanelIconButton
                    active={false}
                    icon={<FolderOpen className="h-3.5 w-3.5" />}
                    label="返回课程资料"
                    description="查看这门课程的资料与作业文件。"
                    onClick={() => setCoursePanel("files")}
                  />
                )}
                <CoursePanelIconButton
                  active={coursePanel === "indexing"}
                  icon={<Database className="h-3.5 w-3.5" />}
                  label="课程向量索引"
                  description="查看索引状态，并重新构建整个课程的向量索引。"
                  onClick={() => setCoursePanel("indexing")}
                />
                <CoursePanelIconButton
                  active={coursePanel === "search"}
                  icon={<Search className="h-3.5 w-3.5" />}
                  label="搜索课程资料"
                  description="搜索这门课程中已建立索引的资料片段。"
                  onClick={() => setCoursePanel("search")}
                />
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border bg-card px-2.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => {
                    resetCourseDetailsDraft(activeCourse);
                    setEditingCourseDetails((value) => !value);
                  }}
                  disabled={!activeCourse?.id || activeCourseArchived || activeCourseIsSemesterHome || savingCourseDetails}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  编辑
                </button>
              </div>
            </div>
            {courseReadOnlyReason && (
              <div className="mt-3 flex gap-1.5 rounded-[var(--radius-control)] bg-amber-50 px-3 py-2 text-[11px] leading-4 text-amber-900">
                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{courseReadOnlyReason}</span>
              </div>
            )}
            {activeCourse && editingCourseDetails && !activeCourseArchived && (
              <section className="mt-3 rounded-[var(--radius-card)] bg-card p-3 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
                <div className="grid gap-2 md:grid-cols-2">
                  <label className="block space-y-1 text-[11px] text-muted-foreground">
                    <span>课程代码</span>
                    <input
                      className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20"
                      value={courseDetailsDraft.code}
                      onChange={(event) => setCourseDetailsDraft((current) => ({ ...current, code: event.target.value }))}
                    />
                  </label>
                  <label className="block space-y-1 text-[11px] text-muted-foreground">
                    <span>教师</span>
                    <input
                      className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20"
                      value={courseDetailsDraft.instructor}
                      onChange={(event) => setCourseDetailsDraft((current) => ({ ...current, instructor: event.target.value }))}
                    />
                  </label>
                  <label className="block space-y-1 text-[11px] text-muted-foreground">
                    <span>上课时间</span>
                    <input
                      className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20"
                      value={courseDetailsDraft.meetingTime}
                      onChange={(event) => setCourseDetailsDraft((current) => ({ ...current, meetingTime: event.target.value }))}
                    />
                  </label>
                  <label className="block space-y-1 text-[11px] text-muted-foreground">
                    <span>地点</span>
                    <input
                      className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20"
                      value={courseDetailsDraft.location}
                      onChange={(event) => setCourseDetailsDraft((current) => ({ ...current, location: event.target.value }))}
                    />
                  </label>
                </div>
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-6 gap-1.5">
                    {COURSE_ICON_OPTIONS.map(({ key, label, Icon }) => (
                      <button
                        key={key}
                        type="button"
                        className={cx(
                          "flex h-8 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground transition hover:bg-accent hover:text-foreground",
                          courseDetailsDraft.icon === key && "border-foreground/30 bg-muted text-foreground ring-1 ring-foreground/10",
                        )}
                        onClick={() => setCourseDetailsDraft((current) => ({ ...current, icon: key }))}
                        title={label}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                    {COURSE_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={cx("h-6 w-6 rounded-[var(--radius-badge)] border transition ring-offset-2 ring-offset-card", courseDetailsDraft.color === color && "ring-2 ring-foreground/30")}
                        style={{ backgroundColor: color }}
                        onClick={() => setCourseDetailsDraft((current) => ({ ...current, color }))}
                        title={color}
                      />
                    ))}
                    </div>
                    <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border bg-background px-2.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
                      onClick={() => {
                        resetCourseDetailsDraft(activeCourse);
                        setEditingCourseDetails(false);
                      }}
                      disabled={savingCourseDetails}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-foreground px-2.5 text-xs font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => void saveCourseDetails()}
                      disabled={savingCourseDetails || !courseDetailsDraft.code.trim()}
                    >
                      {savingCourseDetails ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      保存
                    </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden">
              {!activeCourse && (
                <div className="min-h-0 flex-1 rounded-[var(--radius-card)] border border-dashed bg-card px-4 py-10 text-center text-xs leading-5 text-muted-foreground">
                  从左侧选择一门课程。
                </div>
              )}

              {activeCourse && coursePanel === "files" && (
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain pr-1 [contain:layout_paint] [overflow-anchor:none] [scrollbar-gutter:stable] brevyn-scrollbar">
                  <CourseSectionGroupHeader
                    title={activeCourseIsSemesterHome ? "学期资料" : "课程资料"}
                  />
                  {foundationSections.map((section) => (
                    <SectionCard
                      key={section.id}
                      section={section}
                      indexing={indexingSectionId === section.id}
                      disabled={activeCourseArchived || Boolean(indexingSectionId)}
                      onIndex={() => void indexSection(section.id)}
                      onUpload={(weekNumber) => uploadToSection(section, weekNumber)}
                      uploading={uploadingSectionId === section.id}
                      lectureWeekOptions={section.kind === "lecture" ? lectureWeekOptions : []}
                      autoOpenWeek={section.kind === "lecture" && autoOpenLectureWeek?.sectionId === section.id ? autoOpenLectureWeek : null}
                      onFileDeleted={() => activeCourse?.id && void loadCourseView(activeCourse.id)}
                    />
                  ))}
                  {!activeCourseIsSemesterHome && (
                    <>
                      <CourseSectionGroupHeader
                        title="课程作业"
                      />
                      {taskSections.map((section) => (
                        <div key={section.id} className="space-y-2">
                          <SectionCard
                            section={section}
                            indexing={indexingSectionId === section.id}
                            disabled={activeCourseArchived || Boolean(indexingSectionId)}
                            editingTask={editingTaskId === section.taskId}
                            archivingTask={archivingTaskId === section.taskId}
                            onEditTask={() => startTaskEdit(section)}
                            onArchiveTask={() => void archiveTask(section)}
                            onIndex={() => void indexSection(section.id)}
                            onUpload={(weekNumber) => uploadToSection(section, weekNumber)}
                            uploading={uploadingSectionId === section.id}
                            onFileDeleted={() => activeCourse?.id && void loadCourseView(activeCourse.id)}
                          />
                          {editingTaskId === section.taskId && (
                            <InlineTaskEditCard
                              title={taskEditDraft.title}
                              taskType={taskEditDraft.taskType}
                              icon={taskEditDraft.icon || resolveTaskIcon({ title: taskEditDraft.title, taskType: taskEditDraft.taskType })}
                              saving={savingTaskId === editingTaskId}
                              error={taskEditError}
                              existingTaskTypes={existingTaskTypes}
                              disabled={activeCourseArchived}
                              onTitleChange={(title) => setTaskEditDraft((current) => ({ ...current, title }))}
                              onTaskTypeChange={(nextTaskType) => setTaskEditDraft((current) => ({ ...current, taskType: nextTaskType }))}
                              onIconChange={(icon) => setTaskEditDraft((current) => ({ ...current, icon }))}
                              onCancel={cancelTaskEdit}
                              onSave={() => void saveTaskEdit()}
                            />
                          )}
                        </div>
                      ))}
                      <InlineTaskCreateCard
                        taskName={taskName}
                        taskType={taskType}
                        icon={taskIcon || resolveTaskIcon({ title: taskName, taskType })}
                        creating={creatingTask}
                        error={taskError}
                        existingTaskTypes={existingTaskTypes}
                        empty={taskSections.length === 0}
                        disabled={!activeCourse?.id || activeCourseArchived}
                        onTaskNameChange={setTaskName}
                        onTaskTypeChange={setTaskType}
                        onIconChange={setTaskIcon}
                        onCreate={() => void createTask()}
                      />
                    </>
                  )}
                </div>
              )}

              {activeCourse && coursePanel === "indexing" && (
                <div className="min-h-0 flex-1 overflow-y-auto pr-1 brevyn-scrollbar">
                  <IndexingProgressPanel
                    jobs={indexingJobs}
                    health={indexHealth}
                    loading={loadingIndexingJobs}
                    sections={sections}
                    indexingAll={indexingSectionId === "all"}
                    disabled={!activeCourse?.id || activeCourseArchived || Boolean(indexingSectionId)}
                    onIndexAll={() => void indexAllSections()}
                    onRefresh={() => activeCourse?.id && void loadCourseView(activeCourse.id)}
                    onCancel={(jobId) => void cancelIndexing(jobId)}
                  />
                </div>
              )}

              {activeCourse && coursePanel === "search" && (
                <div className="min-h-0 flex-1 overflow-y-auto pr-1 brevyn-scrollbar">
                  <RagDebugPanel
                    query={ragQuery}
                    results={ragResults}
                    searching={ragSearching}
                    error={ragError}
                    onQueryChange={setRagQuery}
                    onSearch={() => void searchRag()}
                    disabled={!activeCourse?.id || activeCourseArchived}
                  />
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function CoursePanelIconButton({
  active,
  icon,
  label,
  description,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <span className="group relative inline-flex h-8 w-8 items-center justify-center">
      <button
        type="button"
        className={cx(
          "peer inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] transition",
          active ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
      >
        {icon}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-[1000] mt-2 w-56 rounded-[var(--radius-control)] bg-popover px-2.5 py-2 text-left text-popover-foreground opacity-0 shadow-lg ring-1 ring-border transition-opacity group-hover:opacity-100 peer-focus-visible:opacity-100"
      >
        <span className="block text-[11px] font-semibold leading-4">{label}</span>
        <span className="mt-0.5 block text-[10px] font-normal leading-4 text-muted-foreground">{description}</span>
      </span>
    </span>
  );
}

function courseMetaItems(course: Course): string[] {
  if (course.workspaceKind === "semester_home") return compactStrings([course.term]);
  return compactStrings([course.code, course.term, course.instructor, course.meetingTime, course.location]);
}

function normalizeCourseIconDraft(icon?: Course["icon"]): Course["icon"] {
  const aliased = icon === "library"
    ? DEFAULT_COURSE_ICON
    : icon === "file-text"
      ? "square-pen"
      : icon === "gavel"
        ? "scale"
        : icon;
  return COURSE_ICON_OPTION_KEYS.has(aliased) ? aliased : DEFAULT_COURSE_ICON;
}

function compactStrings(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function CourseListItem({
  course,
  active,
  busy,
  onSelect,
  onArchive,
  onRestore,
  onDelete,
}: {
  course: Course;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const isSemesterHome = course.workspaceKind === "semester_home";
  const selectable = !course.archivedAt;
  const iconStyle = isSemesterHome
    ? {
        color: "hsl(var(--status-info))",
        backgroundColor: "hsl(var(--status-info) / 0.13)",
        boxShadow: "inset 0 0 0 1px hsl(var(--status-info) / 0.18)",
      }
    : { color: course.color, backgroundColor: `${course.color}1f` };
  const detail = isSemesterHome
    ? "学期资料"
    : [course.code, course.instructor || course.meetingTime].filter(Boolean).join(" · ");

  return (
    <div
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      className={cx(
        "group/course flex w-full min-w-0 items-center gap-2 rounded-[var(--radius-card)] border px-3 py-2.5 text-left transition",
        course.archivedAt ? "bg-muted/45 text-muted-foreground" : "bg-background/70",
        selectable && "cursor-pointer",
        active ? "border-foreground/25 bg-accent/45 shadow-sm ring-1 ring-foreground/10" : "border-border/60 hover:bg-accent/55",
      )}
      onClick={() => {
        if (selectable) onSelect();
      }}
      onKeyDown={(event) => {
        if (!selectable) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)]" style={iconStyle}>
          <CourseIcon course={course} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="block truncate text-[13px] font-semibold">{course.name}</span>
            {isSemesterHome && <span className="shrink-0 rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[9px]">学期入口</span>}
            {course.archivedAt && <span className="shrink-0 rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[9px]">已归档</span>}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">{detail || course.term}</span>
        </span>
      </div>
      {!isSemesterHome && (
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover/course:opacity-100 group-focus-within/course:opacity-100">
          {course.archivedAt ? (
            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-card text-muted-foreground hover:bg-accent hover:text-foreground" title="恢复课程" disabled={busy} onClick={(event) => {
              event.stopPropagation();
              onRestore();
            }}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            </button>
          ) : (
            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-card text-muted-foreground hover:bg-accent hover:text-foreground" title="归档课程" disabled={busy} onClick={(event) => {
              event.stopPropagation();
              onArchive();
            }}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
            </button>
          )}
          <button type="button" className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-card text-muted-foreground hover:bg-red-50 hover:text-red-700" title={course.archivedAt ? "永久删除" : "请先归档再删除"} disabled={busy} onClick={(event) => {
            event.stopPropagation();
            onDelete();
          }}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

function CourseSectionGroupHeader({ title }: { title: string; detail?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 pb-1 pt-5 first:pt-0">
      <div className="min-w-0">
        <div className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</div>
      </div>
    </div>
  );
}

function TaskIconPicker({ value, disabled, onChange }: { value: TaskIconKey; disabled?: boolean; onChange: (value: TaskIconKey) => void }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[10px] font-medium text-muted-foreground">图标</span>
      {TASK_ICON_OPTIONS.map((option) => (
        <button
          key={option.key}
          type="button"
          className={cx(
            "flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border text-muted-foreground transition disabled:cursor-not-allowed disabled:opacity-45",
            option.key === value
              ? "border-foreground/30 bg-muted text-foreground ring-1 ring-foreground/10"
              : "border-border/70 bg-background hover:bg-accent hover:text-foreground",
          )}
          onClick={() => onChange(option.key)}
          disabled={disabled}
          title={option.label}
        >
          <TaskIcon task={{ icon: option.key }} className="h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

function InlineTaskCreateCard({
  taskName,
  taskType,
  icon,
  creating,
  error,
  existingTaskTypes,
  empty,
  disabled,
  onTaskNameChange,
  onTaskTypeChange,
  onIconChange,
  onCreate,
}: {
  taskName: string;
  taskType: TaskType;
  icon: TaskIconKey;
  creating: boolean;
  error: string;
  existingTaskTypes: string[];
  empty?: boolean;
  disabled?: boolean;
  onTaskNameChange: (value: string) => void;
  onTaskTypeChange: (value: TaskType) => void;
  onIconChange: (value: TaskIconKey) => void;
  onCreate: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const wasCreatingRef = useRef(false);
  const blocked = Boolean(disabled || creating);
  const taskTypeOptions = useMemo(() => Array.from(new Set([...TASK_TYPE_PRESETS, ...existingTaskTypes])).slice(0, 8), [existingTaskTypes]);

  useEffect(() => {
    if (error) setExpanded(true);
  }, [error]);

  useEffect(() => {
    if (creating) {
      wasCreatingRef.current = true;
      return;
    }
    if (!wasCreatingRef.current) return;
    wasCreatingRef.current = false;
    if (!error && !taskName.trim()) setExpanded(false);
  }, [creating, error, taskName]);

  if (!expanded) {
    if (empty) {
      return (
        <section className="rounded-[var(--radius-card)] border border-dashed bg-card/58 px-3 py-5 text-center">
          <div className="text-xs font-medium text-foreground">还没有课程作业。</div>
          <button
            type="button"
            className="mt-3 inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => setExpanded(true)}
            disabled={disabled}
          >
            <Plus className="h-3.5 w-3.5" />
            新建课程作业
          </button>
        </section>
      );
    }

    return (
      <button
        type="button"
        className="flex h-10 w-full items-center justify-center gap-1.5 rounded-[var(--radius-card)] bg-card/50 text-xs font-medium text-muted-foreground transition hover:bg-accent/65 hover:text-foreground active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => setExpanded(true)}
        disabled={disabled}
      >
        <Plus className="h-3.5 w-3.5" />
        新建课程作业
      </button>
    );
  }

  return (
    <section className="rounded-[var(--radius-card)] bg-card p-3 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.52)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Plus className="h-3.5 w-3.5" />
            新建课程作业
          </div>
        </div>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={() => setExpanded(false)}
          disabled={creating}
          title="收起"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {taskTypeOptions.map((item) => (
          <button
            key={item}
            type="button"
            className={cx(
              "rounded-[var(--radius-pill)] px-2.5 py-1 text-[10px] font-medium transition disabled:cursor-not-allowed disabled:opacity-45",
              item === taskType ? "bg-foreground text-background" : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={() => onTaskTypeChange(item)}
            disabled={blocked}
          >
            {item}
          </button>
        ))}
      </div>
      <TaskIconPicker value={icon} disabled={blocked} onChange={onIconChange} />

      <div className="grid gap-2 md:grid-cols-[10rem_minmax(0,1fr)_auto]">
        <label className="block space-y-1 text-[11px] text-muted-foreground">
          <span>类型</span>
          <input
            className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-55"
            value={taskType}
            onChange={(event) => onTaskTypeChange(event.target.value)}
            placeholder="作业"
            disabled={blocked}
          />
        </label>
        <label className="block space-y-1 text-[11px] text-muted-foreground">
          <span>名称</span>
          <input
            className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-55"
            value={taskName}
            onChange={(event) => onTaskNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (isComposingText(event)) return;
              if (event.key === "Enter" && !blocked && taskName.trim()) onCreate();
            }}
            placeholder="例如：Essay 1 / Final Presentation"
            disabled={blocked}
          />
        </label>
        <button
          type="button"
          className="mt-5 inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onCreate}
          disabled={blocked || !taskName.trim()}
        >
          {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          {creating ? "创建中" : "添加"}
        </button>
      </div>

      {error && <div className="mt-3 rounded-[var(--radius-control)] bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900">{error}</div>}
    </section>
  );
}

function InlineTaskEditCard({
  title,
  taskType,
  icon,
  saving,
  error,
  existingTaskTypes,
  disabled,
  onTitleChange,
  onTaskTypeChange,
  onIconChange,
  onCancel,
  onSave,
}: {
  title: string;
  taskType: TaskType;
  icon: TaskIconKey;
  saving: boolean;
  error: string;
  existingTaskTypes: string[];
  disabled?: boolean;
  onTitleChange: (value: string) => void;
  onTaskTypeChange: (value: TaskType) => void;
  onIconChange: (value: TaskIconKey) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const blocked = Boolean(disabled || saving);
  const taskTypeOptions = useMemo(() => Array.from(new Set([...TASK_TYPE_PRESETS, ...existingTaskTypes, taskType].filter(Boolean))).slice(0, 8), [existingTaskTypes, taskType]);

  return (
    <section className="rounded-[var(--radius-card)] bg-card p-3 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.48)]">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold">
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
          编辑课程作业
        </div>
        <button
          type="button"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onCancel}
          disabled={saving}
          title="取消"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {taskTypeOptions.map((item) => (
          <button
            key={item}
            type="button"
            className={cx(
              "rounded-[var(--radius-pill)] px-2.5 py-1 text-[10px] font-medium transition disabled:cursor-not-allowed disabled:opacity-45",
              item === taskType ? "bg-foreground text-background" : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            onClick={() => onTaskTypeChange(item)}
            disabled={blocked}
          >
            {item}
          </button>
        ))}
      </div>
      <TaskIconPicker value={icon} disabled={blocked} onChange={onIconChange} />

      <div className="grid gap-2 md:grid-cols-[10rem_minmax(0,1fr)_auto_auto]">
        <label className="block space-y-1 text-[11px] text-muted-foreground">
          <span>类型</span>
          <input
            className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-55"
            value={taskType}
            onChange={(event) => onTaskTypeChange(event.target.value)}
            placeholder="作业"
            disabled={blocked}
          />
        </label>
        <label className="block space-y-1 text-[11px] text-muted-foreground">
          <span>名称</span>
          <input
            className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-55"
            value={title}
            onChange={(event) => onTitleChange(event.target.value)}
            onKeyDown={(event) => {
              if (isComposingText(event)) return;
              if (event.key === "Enter" && !blocked && title.trim()) onSave();
            }}
            placeholder="例如：Essay 1 / Final Presentation"
            disabled={blocked}
          />
        </label>
        <button
          type="button"
          className="mt-5 inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border bg-background px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onCancel}
          disabled={saving}
        >
          取消
        </button>
        <button
          type="button"
          className="mt-5 inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onSave}
          disabled={blocked || !title.trim()}
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存
        </button>
      </div>

      {error && <div className="mt-3 rounded-[var(--radius-control)] bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900">{error}</div>}
    </section>
  );
}

function IndexingProgressPanel({
  jobs,
  health,
  loading,
  sections,
  indexingAll,
  disabled,
  onIndexAll,
  onRefresh,
  onCancel,
}: {
  jobs: IndexingJob[];
  health: EmbeddingIndexHealth | null;
  loading: boolean;
  sections: CourseFileSection[];
  indexingAll: boolean;
  disabled: boolean;
  onIndexAll: () => void;
  onRefresh: () => void;
  onCancel: (jobId: string) => void;
}) {
  const sectionTitles = new Map(sections.map((section) => [section.id, displaySectionTitle(section)]));
  const visibleJobs = latestIndexingJobsBySection(jobs);
  const activeCount = visibleJobs.filter((job) => job.status === "queued" || job.status === "indexing").length;
  const currentJobs = visibleJobs.filter((job) => job.status !== "cancelled");
  const historyJobs = visibleJobs.filter((job) => job.status === "cancelled");
  const reindexDisabled = disabled || Boolean(health && (!health.embeddingConfigured || health.totalFiles === 0));

  return (
    <section className="rounded-[var(--radius-card)] bg-card p-3 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold">
          <Database className="h-3.5 w-3.5" />
          <span className="truncate">索引</span>
          {activeCount > 0 && <span className="rounded-[var(--radius-badge)] bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">{activeCount} 个进行中</span>}
          {activeCount === 0 && health && <span className={cx("shrink-0 rounded-[var(--radius-badge)] px-1.5 py-0.5 text-[10px]", indexHealthTone(health))}>{indexHealthLabel(health)}</span>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="inline-flex" title={indexAllButtonTitle(health)}>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] bg-foreground px-2.5 text-[11px] font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onIndexAll}
              disabled={reindexDisabled}
              title={indexAllButtonTitle(health)}
            >
              {indexingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers3 className="h-3.5 w-3.5" />}
              <span className="whitespace-nowrap">重新索引当前课程</span>
            </button>
          </span>
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground transition hover:bg-accent hover:text-foreground"
            onClick={onRefresh}
            title="刷新索引任务"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {health && indexHealthNeedsAttention(health) && (
        <div className="mb-3 flex gap-2 rounded-[var(--radius-control)] border border-[hsl(var(--status-warning)/0.25)] bg-[hsl(var(--status-warning)/0.08)] px-2.5 py-2 text-[10px] leading-4 text-[hsl(var(--status-warning))]">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{indexHealthDescription(health, "当前课程")}</span>
        </div>
      )}

      {currentJobs.length === 0 ? (
        <div className="rounded-[var(--radius-control)] border border-dashed bg-background/60 px-3 py-4 text-center text-[11px] text-muted-foreground">暂无当前索引任务</div>
      ) : (
        <div className="space-y-2">
          {currentJobs.slice(0, 5).map((job) => <IndexingJobCard key={job.id} job={job} sectionTitles={sectionTitles} onCancel={onCancel} />)}
        </div>
      )}

      {historyJobs.length > 0 && (
        <details className="mt-2 text-[10px] text-muted-foreground">
          <summary className="cursor-pointer select-none py-1 hover:text-foreground">历史任务 · {historyJobs.length}</summary>
          <div className="mt-1 space-y-2">
            {historyJobs.map((job) => <IndexingJobCard key={job.id} job={job} sectionTitles={sectionTitles} onCancel={onCancel} />)}
          </div>
        </details>
      )}
    </section>
  );
}

function IndexingJobCard({
  job,
  sectionTitles,
  onCancel,
}: {
  job: IndexingJob;
  sectionTitles: Map<string, string>;
  onCancel: (jobId: string) => void;
}) {
  const progress = Math.max(0, Math.min(100, job.progress || 0));
  const cancellable = job.status === "queued" || job.status === "indexing";
  return (
    <div className="rounded-[var(--radius-control)] border bg-background/70 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-[11px] font-semibold text-foreground">{job.sectionId ? sectionTitles.get(job.sectionId) || "分区" : "全部分区"}</div>
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {job.indexedFiles}/{job.totalFiles ?? 0} 个文件 · {displayIndexingStage(job.stage || job.status)} · {formatJobTime(job.updatedAt)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className={cx("rounded-[var(--radius-badge)] px-1.5 py-0.5 text-[10px]", statusTone(job.status))}>{displayIndexingStatus(job.status)}</span>
          {cancellable && (
            <button
              type="button"
              className="flex h-6 w-6 items-center justify-center rounded-[var(--radius-control)] border bg-card text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={() => onCancel(job.id)}
              title="取消索引"
            >
              <CircleStop className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-[var(--radius-pill)] bg-muted">
        <div className={cx("h-full rounded-[var(--radius-pill)] transition-all duration-300", job.status === "failed" ? "bg-red-500" : "bg-foreground")} style={{ width: `${progress}%` }} />
      </div>
      {job.error && (
        <div className="mt-2 flex gap-1.5 rounded-[var(--radius-control)] bg-red-50 px-2 py-1.5 text-[10px] leading-4 text-red-700">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0 break-words">{job.error}</span>
        </div>
      )}
    </div>
  );
}

function indexHealthLabel(health: EmbeddingIndexHealth): string {
  if (!health.embeddingConfigured && health.totalFiles > 0) return "未配置 Embedding";
  if (health.state === "ready") return "索引可用";
  if (health.state === "needs_rebuild") return "需要重建";
  return "尚未索引";
}

function indexHealthTone(health: EmbeddingIndexHealth): string {
  if (health.state === "ready") return "bg-emerald-50 text-emerald-800";
  if (indexHealthNeedsAttention(health)) return "bg-amber-50 text-amber-800";
  return "bg-muted text-muted-foreground";
}

function indexHealthNeedsAttention(health: EmbeddingIndexHealth): boolean {
  return health.state === "needs_rebuild" || (!health.embeddingConfigured && health.totalFiles > 0);
}

function indexHealthDescription(health: EmbeddingIndexHealth, scopeLabel: string): string {
  if (!health.embeddingConfigured) return "当前没有启用 Embedding 服务商，无法建立或更新向量索引。";
  const details = [
    health.staleFiles > 0 ? `${health.staleFiles} 个资料使用旧配置` : "",
    health.unindexedFiles > 0 ? `${health.unindexedFiles} 个资料尚未索引` : "",
  ].filter(Boolean).join("，");
  return `${scopeLabel}${details ? `有${details}` : "的索引需要更新"}。`;
}

function indexAllButtonTitle(health: EmbeddingIndexHealth | null): string {
  if (health && !health.embeddingConfigured) return "请先在设置中启用 Embedding 服务商";
  if (health && health.totalFiles === 0) return "当前课程没有可索引资料";
  return "使用当前 Embedding 配置，重新构建当前课程全部资料的向量索引。";
}

function latestIndexingJobsBySection(jobs: IndexingJob[]): IndexingJob[] {
  const latest = new Map<string, IndexingJob>();
  for (const job of jobs) {
    const key = job.sectionId || `course:${job.courseId}:all`;
    const current = latest.get(key);
    if (!current || new Date(job.updatedAt).getTime() > new Date(current.updatedAt).getTime()) {
      latest.set(key, job);
    }
  }
  return Array.from(latest.values()).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

function findActiveIndexingJob(jobs: IndexingJob[], sectionId?: string): IndexingJob | undefined {
  return jobs.find((job) => {
    if (job.status !== "queued" && job.status !== "indexing") return false;
    if (!sectionId) return true;
    return !job.sectionId || job.sectionId === sectionId;
  });
}

function RagDebugPanel({
  query,
  results,
  searching,
  error,
  onQueryChange,
  onSearch,
  disabled,
}: {
  query: string;
  results: RagSearchResult[];
  searching: boolean;
  error: string;
  onQueryChange: (query: string) => void;
  onSearch: () => void;
  disabled?: boolean;
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(results.length / RAG_RESULTS_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visibleResults = results.slice(safePage * RAG_RESULTS_PAGE_SIZE, safePage * RAG_RESULTS_PAGE_SIZE + RAG_RESULTS_PAGE_SIZE);

  useEffect(() => {
    setPage(0);
  }, [query, results]);

  return (
    <section className="rounded-[var(--radius-card)] bg-card p-3 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
      <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
        <Search className="h-3.5 w-3.5" />
        向量搜索调试
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          onSearch();
        }}
      >
        <input
          className="h-8 min-w-0 flex-1 rounded-[var(--radius-control)] border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring/20"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索已索引片段"
          disabled={disabled}
        />
        <button
          type="submit"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || searching || !query.trim()}
          title="运行向量搜索"
        >
          {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
        </button>
      </form>

      {error && (
        <div className="mt-2 rounded-[var(--radius-control)] bg-red-50 px-2 py-1.5 text-[10px] leading-4 text-red-700">
          <div className="flex gap-1.5">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        </div>
      )}

      <div className="mt-2 max-h-[420px] space-y-2 overflow-y-auto pr-1 brevyn-scrollbar">
        {results.length === 0 ? (
          <div className="rounded-[var(--radius-control)] border border-dashed bg-background/60 px-3 py-4 text-center text-[11px] text-muted-foreground">
            {query.trim() ? "没有召回片段" : "请输入查询"}
          </div>
        ) : (
          visibleResults.map((result) => {
            const citation = result.citation || result.source;
            const displayCitation = compactRagCitation(citation);
            return (
            <div key={result.id} className="min-w-0 overflow-hidden rounded-[var(--radius-control)] border bg-background/70 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 truncate text-[11px] font-semibold" title={result.title}>{result.title}</div>
                <span className="shrink-0 rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{Math.round(result.score * 100)}%</span>
              </div>
              <div className="mt-1 line-clamp-3 min-w-0 break-words text-[11px] leading-5 text-muted-foreground">{result.excerpt}</div>
              <div className="mt-1 min-w-0 truncate text-[10px] text-muted-foreground/80" title={citation}>{displayCitation}</div>
            </div>
          );
          })
        )}
      </div>
      {results.length > RAG_RESULTS_PAGE_SIZE && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t pt-2 text-[10px] text-muted-foreground">
          <span>{results.length} 条结果 · 第 {safePage + 1}/{pageCount} 页</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-control)] border bg-background transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
              disabled={safePage === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              title="上一页"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-control)] border bg-background transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              title="下一页"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function compactRagCitation(citation: string): string {
  const value = citation.trim();
  if (!value) return "";
  const [pathPart, ...rest] = value.split(" · ");
  const normalized = pathPart.replace(/\\/g, "/");
  const semanticMatch = normalized.match(/(?:Course shared|Lecture|Materials|Drafts|Submitted)\/[^/]+$/);
  const compactPath = semanticMatch?.[0] || normalized.split("/").slice(-2).join("/");
  return [localizePathSegment(compactPath), ...rest].filter(Boolean).join(" · ");
}

type SectionCardProps = {
  section: CourseFileSection;
  indexing: boolean;
  disabled?: boolean;
  editingTask?: boolean;
  archivingTask?: boolean;
  onEditTask?: () => void;
  onArchiveTask?: () => void;
  onIndex: () => void;
  onUpload: (weekNumber?: number) => void;
  uploading: boolean;
  lectureWeekOptions?: DropdownOption[];
  autoOpenWeek?: AutoOpenLectureWeek | null;
  onFileDeleted: () => void;
};

const SectionCard = memo(function SectionCard({
  section,
  indexing,
  disabled,
  editingTask,
  archivingTask,
  onEditTask,
  onArchiveTask,
  onIndex,
  onUpload,
  uploading,
  lectureWeekOptions = [],
  autoOpenWeek,
  onFileDeleted,
}: SectionCardProps) {
  const SectionIcon = section.kind === "course_shared" ? FolderOpen : section.kind === "lecture" ? BookOpen : null;
  const [open, setOpen] = useState(false);
  const [openLectureWeeks, setOpenLectureWeeks] = useState<Record<string, boolean>>({});
  const [lectureWeekValue, setLectureWeekValue] = useState(lectureWeekOptions[0]?.value || "");
  const [deletingFileId, setDeletingFileId] = useState("");
  const [retryingFileId, setRetryingFileId] = useState("");
  const [fileActionError, setFileActionError] = useState("");
  const { confirm, confirmDialog } = useConfirmDialog();
  const visibleFiles = useMemo(() => section.files.filter(isRagEligibleFile), [section.files]);
  const lectureWeekGroups = useMemo(() => section.kind === "lecture" ? groupLectureFilesByWeek(visibleFiles) : [], [visibleFiles, section.kind]);
  const hasVisibleFiles = visibleFiles.length > 0;

  useEffect(() => {
    if (section.kind !== "lecture") return;
    if (lectureWeekOptions.some((option) => option.value === lectureWeekValue)) return;
    setLectureWeekValue(lectureWeekOptions[0]?.value || "");
  }, [lectureWeekOptions, lectureWeekValue, section.kind]);

  useEffect(() => {
    if (section.kind !== "lecture" || !autoOpenWeek) return;
    setOpen(true);
    setOpenLectureWeeks((current) => ({ ...current, [`week-${autoOpenWeek.weekNumber}`]: true }));
  }, [autoOpenWeek, section.kind]);

  async function deleteFile(fileId: string, fileName: string) {
    const ok = await confirm({
      title: `删除「${fileName}」？`,
      message: "本地文件副本将被移除。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setDeletingFileId(fileId);
    setFileActionError("");
    try {
      await window.brevyn.files.delete(fileId);
      onFileDeleted();
    } catch (error) {
      if (isActiveIndexingDeleteError(error)) {
        const forceDelete = await confirm({
          title: "取消索引并删除？",
          message: "这个文件正在进入课程知识库。取消后会停止相关索引任务，并删除本地副本和已生成的知识库片段。",
          confirmLabel: "取消索引并删除",
          cancelLabel: "保留文件",
          tone: "danger",
        });
        if (!forceDelete) return;
        try {
          await window.brevyn.files.delete({ fileId, forceCancelIndexing: true });
          onFileDeleted();
          return;
        } catch (forceError) {
          setFileActionError(errorMessage(forceError, "删除失败。"));
          return;
        }
      }
      setFileActionError(errorMessage(error, "删除失败。"));
    } finally {
      setDeletingFileId("");
    }
  }

  async function revealFile(fileId: string) {
    try {
      await window.brevyn.files.reveal(fileId);
    } catch (error) {
      setFileActionError(error instanceof Error ? error.message : "在访达中显示失败");
    }
  }

  async function retryFileIndex(fileId: string) {
    setRetryingFileId(fileId);
    setFileActionError("");
    try {
      await window.brevyn.files.retryIndex(fileId);
      onFileDeleted();
    } catch (error) {
      setFileActionError(error instanceof Error ? error.message : "重新索引失败");
    } finally {
      setRetryingFileId("");
    }
  }

  return (
    <div className="rounded-[var(--radius-card)] bg-card px-3 py-3 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
      {confirmDialog}
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={() => setOpen((value) => !value)}
        >
          <ChevronRight className={cx("mt-1 h-3.5 w-3.5 shrink-0 transition-transform text-muted-foreground", open && "rotate-90")} />
          {SectionIcon ? (
            <SectionIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <TaskIcon task={{ icon: section.icon, title: taskNameFromSection(section), taskType: section.taskType }} className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-sm font-semibold">{displaySectionTitle(section)}</div>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {visibleFiles.length} 个文件
            </div>
          </div>
        </button>
        <div className="flex shrink-0 items-center gap-1.5">
          <IndexingStatusBadge
            status={section.indexingStatus}
            label={displayIndexingStatus(section.indexingStatus)}
            title={sectionStatusTitle(section, visibleFiles)}
            description={sectionStatusDescription(section, visibleFiles)}
            rows={sectionStatusRows(section, visibleFiles)}
          />
          {section.kind === "task" && onEditTask && (
            <button
              type="button"
              className={cx(
                "flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
                editingTask && "bg-accent text-foreground",
              )}
              onClick={onEditTask}
              disabled={disabled}
              title="编辑课程作业"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          )}
          {section.kind === "task" && onArchiveTask && (
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              onClick={onArchiveTask}
              disabled={disabled || archivingTask}
              title="归档课程作业"
            >
              {archivingTask ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
            </button>
          )}
          {section.kind === "lecture" && lectureWeekOptions.length > 0 && (
            <DropdownSelect
              className="w-28"
              buttonClassName="h-7 bg-background text-[11px]"
              menuMinWidth={132}
              menuMaxVisibleItems={5}
              value={lectureWeekValue}
              options={lectureWeekOptions}
              ariaLabel="选择上传课件周次"
              onChange={setLectureWeekValue}
            />
          )}
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            onClick={() => onUpload(section.kind === "lecture" && lectureWeekValue ? Number(lectureWeekValue) : undefined)}
            disabled={disabled || uploading}
            title={`上传到${displaySectionTitle(section)}`}
          >
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          </button>
          <span className="group relative inline-flex h-7 w-7 items-center justify-center">
            <button
              type="button"
              className="peer flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              onClick={onIndex}
              disabled={disabled || !hasVisibleFiles}
              aria-label={hasVisibleFiles ? "重新索引此分区" : "此分区暂无可索引资料"}
            >
              {indexing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Layers3 className="h-3.5 w-3.5" />}
            </button>
            <span className="pointer-events-none absolute bottom-full right-0 z-[1000] mb-2 w-max max-w-64 rounded-[var(--radius-control)] bg-popover px-2.5 py-1.5 text-[11px] font-medium leading-4 text-popover-foreground opacity-0 shadow-lg ring-1 ring-border transition-opacity group-hover:opacity-100 peer-focus-visible:opacity-100">
              {hasVisibleFiles
                ? "使用当前 Embedding 配置，重新构建此分区全部资料的向量索引。"
                : "此分区暂无可索引资料。"}
            </span>
          </span>
        </div>
      </div>
      {open && !hasVisibleFiles && (
        <div className="mt-3 rounded-[var(--radius-control)] border border-dashed bg-background px-3 py-3 text-center text-[11px] text-muted-foreground">
          暂无可索引课程资料。点击上传按钮添加文件。
        </div>
      )}
      {open && hasVisibleFiles && (
        <div className="mt-3 space-y-1">
          {section.kind === "lecture" ? (
            lectureWeekGroups.map((group) => {
              const groupOpen = openLectureWeeks[group.id] ?? false;
              return (
                <div key={group.id} className="overflow-hidden rounded-[var(--radius-control)] border border-border/60 bg-background">
                  <button
                    type="button"
                    className="flex w-full min-w-0 items-center gap-2 px-2 py-2 text-left text-[12px] hover:bg-accent/60"
                    onClick={() => setOpenLectureWeeks((current) => ({ ...current, [group.id]: !(current[group.id] ?? false) }))}
                  >
                    <ChevronRight className={cx("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", groupOpen && "rotate-90")} />
                    <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium">{group.title}</span>
                    <span className="shrink-0 rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{group.files.length} 个文件</span>
                  </button>
                  {groupOpen && (
                    <div className="space-y-1 border-t bg-card/40 p-1.5">
                      {group.files.map((file) => (
                        <SectionFileRow
                          key={file.id}
                          file={file}
                          deleting={deletingFileId === file.id}
                          retrying={retryingFileId === file.id}
                          onReveal={() => void revealFile(file.id)}
                          onRetryIndex={() => void retryFileIndex(file.id)}
                          onDelete={() => void deleteFile(file.id, file.name)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            visibleFiles.map((file) => (
              <SectionFileRow
                key={file.id}
                file={file}
                deleting={deletingFileId === file.id}
                retrying={retryingFileId === file.id}
                onReveal={() => void revealFile(file.id)}
                onRetryIndex={() => void retryFileIndex(file.id)}
                onDelete={() => void deleteFile(file.id, file.name)}
              />
            ))
          )}
        </div>
      )}
      {fileActionError && <div className="mt-3 rounded-[var(--radius-control)] bg-amber-50 px-2 py-1.5 text-[10px] leading-4 text-amber-900">{fileActionError}</div>}
    </div>
  );
}, areSectionCardPropsEqual);

function statusTone(status: IndexingJob["status"]): string {
  if (status === "indexed") return "bg-emerald-50 text-emerald-800";
  if (status === "failed") return "bg-red-50 text-red-700";
  if (status === "cancelled") return "bg-muted text-muted-foreground";
  if (status === "queued") return "bg-amber-50 text-amber-700";
  if (status === "indexing") return "bg-blue-50 text-blue-700";
  return "bg-muted text-muted-foreground";
}

function sectionStatusTitle(section: CourseFileSection, files: WorkspaceFileNode[]): string {
  return `${displaySectionTitle(section)} · ${displayIndexingStatus(section.indexingStatus)}`;
}

function sectionStatusDescription(section: CourseFileSection, files: WorkspaceFileNode[]): string {
  const summary = sectionIndexingSummary(files);
  if (files.length === 0) return "这个分区还没有可索引文件。";
  if (section.indexingStatus === "indexing") return "正在把这个分区的文件写入课程知识库。";
  if (section.indexingStatus === "queued") return "这个分区已经进入索引队列。";
  if (section.indexingStatus === "failed") return summary.failed > 0 ? `${summary.failed} 个文件索引失败。` : "这个分区的索引任务失败。";
  if (section.indexingStatus === "cancelled") return "这个分区的索引任务已取消。";
  if (summary.partial > 0) return `${summary.partial} 个文件只完成了部分索引，悬停到具体文件可查看原因。`;
  if (summary.failed > 0) return `${summary.failed} 个文件索引失败，悬停到具体文件可查看原因。`;
  if (summary.indexed > 0) return `${summary.indexed} 个文件已进入课程知识库。`;
  return "这个分区暂无已完成的索引结果。";
}

function sectionStatusRows(section: CourseFileSection, files: WorkspaceFileNode[]): Array<{ label: string; value: string }> {
  const summary = sectionIndexingSummary(files);
  return [
    { label: "状态", value: displayIndexingStatus(section.indexingStatus) },
    { label: "文件", value: `${files.length} 个` },
    { label: "已索引", value: summary.indexed > 0 ? `${summary.indexed} 个` : "" },
    { label: "部分", value: summary.partial > 0 ? `${summary.partial} 个` : "" },
    { label: "失败", value: summary.failed > 0 ? `${summary.failed} 个` : "" },
    { label: "进行中", value: summary.active > 0 ? `${summary.active} 个` : "" },
  ];
}

function sectionIndexingSummary(files: WorkspaceFileNode[]): { indexed: number; partial: number; failed: number; active: number } {
  return files.reduce((summary, file) => {
    const status = file.indexingStatus || (file.indexedAt ? "indexed" : "idle");
    if (status === "indexed") summary.indexed += 1;
    else if (status === "partial" || status === "warning" || status === "skipped") summary.partial += 1;
    else if (status === "failed") summary.failed += 1;
    else if (status === "queued" || status === "indexing") summary.active += 1;
    return summary;
  }, { indexed: 0, partial: 0, failed: 0, active: 0 });
}

function displaySectionTitle(section: CourseFileSection): string {
  if (section.kind === "course_shared") return section.courseId === "semester-home" || section.title === "All semester files" ? "学期资料" : "共享资料";
  if (section.kind === "lecture") return section.weekNumber ? `第 ${section.weekNumber} 周课件` : "课件";
  if (section.kind === "task") {
    const title = localizeTaskSectionTitle(section.title);
    const bucketLabel = section.taskFileBucket ? taskBucketLabel(section.taskFileBucket) : "";
    return [title || section.taskType || "任务", bucketLabel].filter(Boolean).join(" · ");
  }
  return section.title;
}

function taskNameFromSection(section: CourseFileSection): string {
  const title = localizeTaskSectionTitle(section.title).trim();
  const separator = " / ";
  if (!title.includes(separator)) return title;
  return title.split(separator).slice(1).join(separator).trim() || title;
}

function isComposingText(event: KeyboardEvent<HTMLInputElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function reconcileCourseSections(current: CourseFileSection[], next: CourseFileSection[]): CourseFileSection[] {
  if (current.length === 0) return next;
  const previousById = new Map(current.map((section) => [section.id, section]));
  let changed = current.length !== next.length;
  const reconciled = next.map((nextSection, index) => {
    if (current[index]?.id !== nextSection.id) changed = true;
    const previousSection = previousById.get(nextSection.id);
    if (!previousSection) {
      changed = true;
      return nextSection;
    }
    const files = reconcileWorkspaceFiles(previousSection.files, nextSection.files);
    const section = files === nextSection.files ? nextSection : { ...nextSection, files };
    if (areCourseSectionsEqual(previousSection, section)) return previousSection;
    changed = true;
    return section;
  });
  return changed ? reconciled : current;
}

function reconcileWorkspaceFiles(current: WorkspaceFileNode[], next: WorkspaceFileNode[]): WorkspaceFileNode[] {
  if (current.length === 0) return next;
  const previousById = new Map(current.map((file) => [file.id, file]));
  let changed = current.length !== next.length;
  const reconciled = next.map((nextFile, index) => {
    if (current[index]?.id !== nextFile.id) changed = true;
    const previousFile = previousById.get(nextFile.id);
    if (!previousFile) {
      changed = true;
      return nextFile;
    }
    if (areWorkspaceFileNodesEqual(previousFile, nextFile)) return previousFile;
    changed = true;
    return nextFile;
  });
  return changed ? reconciled : current;
}

function areCourseSectionsEqual(a: CourseFileSection, b: CourseFileSection): boolean {
  return (
    a.id === b.id &&
    a.courseId === b.courseId &&
    a.kind === b.kind &&
    a.title === b.title &&
    a.taskType === b.taskType &&
    a.icon === b.icon &&
    a.taskFileBucket === b.taskFileBucket &&
    a.weekNumber === b.weekNumber &&
    a.taskId === b.taskId &&
    a.indexingStatus === b.indexingStatus &&
    a.embeddingModel === b.embeddingModel &&
    a.files === b.files
  );
}

function areWorkspaceFileNodesEqual(a: WorkspaceFileNode, b: WorkspaceFileNode): boolean {
  return (
    a.id === b.id &&
    a.semesterId === b.semesterId &&
    a.courseId === b.courseId &&
    a.taskId === b.taskId &&
    a.taskType === b.taskType &&
    a.taskFileBucket === b.taskFileBucket &&
    a.sectionKind === b.sectionKind &&
    a.weekNumber === b.weekNumber &&
    a.sourcePath === b.sourcePath &&
    a.name === b.name &&
    a.displayName === b.displayName &&
    a.path === b.path &&
    a.kind === b.kind &&
    a.sizeLabel === b.sizeLabel &&
    a.ragEligible === b.ragEligible &&
    a.sourceKind === b.sourceKind &&
    a.indexingStatus === b.indexingStatus &&
    a.indexingError === b.indexingError &&
    a.indexingWarning === b.indexingWarning &&
    a.indexingParser === b.indexingParser &&
    a.indexingParserDetail === b.indexingParserDetail &&
    a.indexedAt === b.indexedAt &&
    a.updatedAt === b.updatedAt &&
    a.children === b.children
  );
}

function areIndexingJobsEqual(a: IndexingJob[], b: IndexingJob[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (!areIndexingJobEqual(a[index], b[index])) return false;
  }
  return true;
}

function areEmbeddingIndexHealthEqual(a: EmbeddingIndexHealth | null, b: EmbeddingIndexHealth): boolean {
  return Boolean(
    a &&
    a.state === b.state &&
    a.embeddingConfigured === b.embeddingConfigured &&
    a.embeddingModel === b.embeddingModel &&
    a.totalFiles === b.totalFiles &&
    a.indexedFiles === b.indexedFiles &&
    a.readyFiles === b.readyFiles &&
    a.staleFiles === b.staleFiles &&
    a.unindexedFiles === b.unindexedFiles
  );
}

function areIndexingJobEqual(a: IndexingJob, b: IndexingJob): boolean {
  return (
    a.id === b.id &&
    a.semesterId === b.semesterId &&
    a.courseId === b.courseId &&
    a.sectionId === b.sectionId &&
    a.status === b.status &&
    a.stage === b.stage &&
    a.embeddingModel === b.embeddingModel &&
    a.embeddingProviderFingerprint === b.embeddingProviderFingerprint &&
    a.indexedFiles === b.indexedFiles &&
    a.totalFiles === b.totalFiles &&
    a.completedFiles === b.completedFiles &&
    a.progress === b.progress &&
    a.error === b.error &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt
  );
}

function areSectionCardPropsEqual(a: SectionCardProps, b: SectionCardProps): boolean {
  return (
    a.section === b.section &&
    a.indexing === b.indexing &&
    Boolean(a.disabled) === Boolean(b.disabled) &&
    Boolean(a.editingTask) === Boolean(b.editingTask) &&
    Boolean(a.archivingTask) === Boolean(b.archivingTask) &&
    a.onEditTask === b.onEditTask &&
    a.onArchiveTask === b.onArchiveTask &&
    a.uploading === b.uploading &&
    areDropdownOptionsEqual(a.lectureWeekOptions || [], b.lectureWeekOptions || []) &&
    areAutoOpenLectureWeeksEqual(a.autoOpenWeek || null, b.autoOpenWeek || null)
  );
}

function areSectionFileRowPropsEqual(a: SectionFileRowProps, b: SectionFileRowProps): boolean {
  return a.file === b.file && a.deleting === b.deleting && a.retrying === b.retrying;
}

function areDropdownOptionsEqual(a: DropdownOption[], b: DropdownOption[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].value !== b[index].value || a[index].label !== b[index].label) return false;
  }
  return true;
}

function areAutoOpenLectureWeeksEqual(a: AutoOpenLectureWeek | null, b: AutoOpenLectureWeek | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.sectionId === b.sectionId && a.weekNumber === b.weekNumber && a.token === b.token;
}

type SectionFileRowProps = {
  file: WorkspaceFileNode;
  deleting: boolean;
  retrying: boolean;
  onReveal: () => void;
  onRetryIndex: () => void;
  onDelete: () => void;
};

const SectionFileRow = memo(function SectionFileRow({
  file,
  deleting,
  retrying,
  onReveal,
  onRetryIndex,
  onDelete,
}: SectionFileRowProps) {
  const canRetryIndex = shouldOfferIndexRetry(file);
  return (
    <div className="flex min-h-10 items-center gap-2 rounded-[var(--radius-control)] border border-border/60 bg-background px-2 py-1.5 [contain:layout_paint_style]">
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-[12px]">{file.name}</span>
      <FileIndexingBadge file={file} />
      {file.sizeLabel && <span className="shrink-0 text-[10px] text-muted-foreground">{file.sizeLabel}</span>}
      <button
        type="button"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-badge)] text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onReveal}
        title="在访达中显示"
      >
        <FolderOpen className="h-3 w-3" />
      </button>
      {canRetryIndex && (
        <button
          type="button"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-badge)] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          onClick={onRetryIndex}
          disabled={retrying}
          title="重新索引此文件"
        >
          {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
        </button>
      )}
      <button
        type="button"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-badge)] text-muted-foreground hover:bg-red-50 hover:text-red-700 disabled:opacity-40"
        onClick={onDelete}
        disabled={deleting}
        title="删除文件"
      >
        {deleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
      </button>
    </div>
  );
}, areSectionFileRowPropsEqual);

function shouldOfferIndexRetry(file: WorkspaceFileNode): boolean {
  if (file.kind === "folder" || !file.sourcePath) return false;
  if (!isRagEligibleFile(file)) return false;
  const status = file.indexingStatus || "idle";
  return status === "failed" || status === "partial" || status === "warning" || status === "skipped" || status === "cancelled" || status === "idle";
}

function isRagEligibleFile(file: WorkspaceFileNode): boolean {
  if (file.ragEligible === true) return true;
  if (file.ragEligible === false) return false;
  return Boolean(file.indexedAt || (file.indexingStatus && file.indexingStatus !== "idle"));
}

function groupLectureFilesByWeek(files: WorkspaceFileNode[]): Array<{ id: string; title: string; weekNumber?: number; files: WorkspaceFileNode[] }> {
  const groups = new Map<string, { id: string; title: string; weekNumber?: number; files: WorkspaceFileNode[] }>();
  for (const file of files) {
    const weekNumber = file.weekNumber || lectureWeekNumberFromPath(file.path) || lectureWeekNumberFromPath(file.sourcePath || "");
    const id = weekNumber ? `week-${weekNumber}` : "unassigned";
    const title = weekNumber ? `Week ${weekNumber}` : "未归类课件";
    const group = groups.get(id) || { id, title, weekNumber, files: [] };
    group.files.push(file);
    groups.set(id, group);
  }
  return Array.from(groups.values())
    .map((group) => ({ ...group, files: [...group.files].sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => {
      if (a.weekNumber && b.weekNumber) return a.weekNumber - b.weekNumber;
      if (a.weekNumber) return -1;
      if (b.weekNumber) return 1;
      return a.title.localeCompare(b.title);
    });
}

function localizeTaskSectionTitle(title: string): string {
  const [type, ...rest] = title.split(" / ");
  if (rest.length === 0) return title === "Assignment" ? "作业" : title;
  return [type === "Assignment" ? "作业" : type, ...rest].join(" / ");
}

function taskBucketLabel(bucket: string): string {
  if (bucket === "materials") return "材料";
  if (bucket === "drafts") return "草稿";
  if (bucket === "submitted") return "已提交";
  return bucket;
}

function displayIndexingStatus(status: IndexingJob["status"]): string {
  if (status === "idle") return "空闲";
  if (status === "indexed") return "已索引";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "queued") return "排队中";
  if (status === "indexing") return "索引中";
  return status;
}

function displayIndexingStage(stage: string): string {
  const normalized = stage.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "queued") return "排队中";
  if (normalized === "indexing") return "索引中";
  if (normalized === "indexed") return "已索引";
  if (normalized === "idle") return "空闲";
  if (normalized === "failed") return "失败";
  if (normalized === "cancelled") return "已取消";
  return stage;
}

function localizePathSegment(value: string): string {
  return value
    .replace(/^Course shared\//, "课程共享/")
    .replace(/^Lecture\//, "课件/")
    .replace(/^Materials\//, "材料/")
    .replace(/^Drafts\//, "草稿/")
    .replace(/^Submitted\//, "已提交/");
}

function semesterWeekOptions(semester?: SemesterWorkspace | null): DropdownOption[] {
  return semesterLectureWeekNumbers(semester).slice(0, MAX_LECTURE_WEEK_OPTIONS).map((week) => ({
    value: String(week),
    label: `Week ${week}`,
    detail: `第 ${week} 周`,
  }));
}

function formatJobTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "").trim();
  return message || fallback;
}

function isActiveIndexingDeleteError(error: unknown): boolean {
  const message = errorMessage(error, "");
  return message.includes("正在进入知识库") || message.includes("Wait for indexing to finish before deleting this file");
}
