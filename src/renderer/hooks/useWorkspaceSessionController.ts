import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Course, BrevynTask, GitStatus, SemesterWorkspace, SkillItem, Thread, ThreadWorkflow } from "@/types/domain";
import { markAgentThreadStatusSeen } from "@/lib/agent-live-store";

export const SEMESTER_HOME_COURSE_ID = "semester-home";
const LAST_WORKSPACE_THREAD_STORAGE_KEY = "brevyn.workspace.lastThreadId";
const LAST_WORKSPACE_THREAD_BY_SEMESTER_PREFIX = "brevyn.workspace.lastThreadId.";

interface UseWorkspaceSessionControllerArgs {
  onClearFiles: () => void;
  onReloadCourseFiles: (courseId: string) => void;
  onRefreshAgentProviders: () => void;
}

export type SettingsPage = "general" | "providers" | "semesters" | "archive" | "skills" | "mcp" | "about";

export function useWorkspaceSessionController({
  onClearFiles,
  onReloadCourseFiles,
  onRefreshAgentProviders,
}: UseWorkspaceSessionControllerArgs) {
  const mountedRef = useRef(true);
  const activeCourseIdRef = useRef("");
  const workspaceReloadRequestRef = useRef(0);
  const onClearFilesRef = useRef(onClearFiles);
  const onReloadCourseFilesRef = useRef(onReloadCourseFiles);
  const onRefreshAgentProvidersRef = useRef(onRefreshAgentProviders);

  const [courses, setCourses] = useState<Course[]>([]);
  const [semesters, setSemesters] = useState<SemesterWorkspace[]>([]);
  const [semester, setSemester] = useState<SemesterWorkspace | null>(null);
  const [tasksByCourse, setTasksByCourse] = useState<Record<string, BrevynTask[]>>({});
  const [threads, setThreads] = useState<Thread[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [activeCourseId, setActiveCourseId] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>();
  const [activeThreadId, setActiveThreadId] = useState("");
  const [bootState, setBootState] = useState<"loading" | "ready" | "error">("loading");
  const [bootError, setBootError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");

  activeCourseIdRef.current = activeCourseId;
  onClearFilesRef.current = onClearFiles;
  onReloadCourseFilesRef.current = onReloadCourseFiles;
  onRefreshAgentProvidersRef.current = onRefreshAgentProviders;

  const emptyThreadIds = useMemo(() => new Set(threads.filter(isDraftThread).map((thread) => thread.id)), [threads]);
  const activeCourse = useMemo(() => courses.find((course) => course.id === activeCourseId), [courses, activeCourseId]);
  const courseTasks = activeCourse ? tasksByCourse[activeCourse.id] || [] : [];
  const activeTask = useMemo(() => courseTasks.find((task) => task.id === activeTaskId), [courseTasks, activeTaskId]);
  const activeThread = useMemo(() => threads.find((thread) => thread.id === activeThreadId), [threads, activeThreadId]);
  const workspaceScope = useMemo(() => describeWorkspaceScope(activeCourse, activeTask, activeThread), [activeCourse, activeTask, activeThread]);
  const needsSemesterSelection = !semester && semesters.length > 0;
  const noActiveSemesters = !semester && semesters.length === 0 && threads.length === 0;

  const commitActiveCourseId = useCallback((courseId: string) => {
    activeCourseIdRef.current = courseId;
    setActiveCourseId(courseId);
  }, []);

  const commitActiveThreadId = useCallback((threadId: string, semesterId?: string, options: { persist?: boolean } = {}) => {
    const shouldPersist = options.persist ?? true;
    setActiveThreadId(threadId);
    if (shouldPersist) writeStoredWorkspaceThreadId(threadId, semesterId);
  }, []);

  const loadWorkspaceExtras = useCallback(async () => {
    try {
      const [skillList, git] = await Promise.all([
        window.brevyn.skills.list(),
        window.brevyn.git.status(),
      ]);
      if (!mountedRef.current) return;
      setSkills(skillList);
      setGitStatus(git);
    } catch (error) {
      console.warn("[workspace] Failed to load non-critical workspace metadata", error);
    }
  }, []);

  const bootstrap = useCallback(async (isCancelled: () => boolean = () => false) => {
    if (!mountedRef.current || isCancelled()) return;
    setBootState("loading");
    setBootError("");
    setWorkspaceError("");
    try {
      const [semesterList, currentSemester, courseList] = await Promise.all([
        window.brevyn.semester.list(),
        window.brevyn.semester.current(),
        window.brevyn.courses.list(),
      ]);
      const [taskEntries, threadList] = await Promise.all([
        Promise.all(courseList.map(async (course) => [course.id, await window.brevyn.tasks.list(course.id)] as const)),
        window.brevyn.threads.list(),
      ]);

      if (!mountedRef.current || isCancelled()) return;
      const nextTasksByCourse = Object.fromEntries(taskEntries);
      const visibleThreads = filterThreadsForSemester(dedupeThreads(threadList), currentSemester?.id);
      const selection = pickWorkspaceSelection(
        courseList,
        nextTasksByCourse,
        visibleThreads,
        undefined,
        readStoredWorkspaceThreadId(currentSemester?.id),
      );

      setSemesters(semesterList);
      setSemester(currentSemester);
      setCourses(courseList);
      setTasksByCourse(nextTasksByCourse);
      setThreads(visibleThreads);

      commitActiveCourseId(selection.courseId);
      setActiveTaskId(selection.taskId);
      commitActiveThreadId(selection.threadId, currentSemester?.id, { persist: Boolean(selection.threadId) });
      if (!selection.courseId) onClearFilesRef.current();
      setBootState("ready");
      onRefreshAgentProvidersRef.current();
      void loadWorkspaceExtras();
    } catch (error) {
      if (!mountedRef.current || isCancelled()) return;
      setBootError(errorMessage(error, "Failed to load workspace."));
      setBootState("error");
    }
  }, [commitActiveCourseId, commitActiveThreadId, loadWorkspaceExtras]);

  const reloadWorkspace = useCallback(async (preferredThreadId?: string): Promise<boolean> => {
    const requestId = workspaceReloadRequestRef.current + 1;
    workspaceReloadRequestRef.current = requestId;
    setWorkspaceError("");
    try {
      const [semesterList, currentSemester, courseList, threadList] = await Promise.all([
        window.brevyn.semester.list(),
        window.brevyn.semester.current(),
        window.brevyn.courses.list(),
        window.brevyn.threads.list(),
      ]);
      const taskEntries = await Promise.all(courseList.map(async (course) => [course.id, await window.brevyn.tasks.list(course.id)] as const));

      if (!mountedRef.current || workspaceReloadRequestRef.current !== requestId) return false;

      const visibleThreads = filterThreadsForSemester(dedupeThreads(threadList), currentSemester?.id);
      if (!mountedRef.current || workspaceReloadRequestRef.current !== requestId) return false;
      const nextTasksByCourse = Object.fromEntries(taskEntries);
      const selection = pickWorkspaceSelection(
        courseList,
        nextTasksByCourse,
        visibleThreads,
        {
          courseId: activeCourseIdRef.current,
          taskId: activeTaskId,
          threadId: activeThreadId,
        },
        preferredThreadId || readStoredWorkspaceThreadId(currentSemester?.id),
      );
      const previousCourseId = activeCourseIdRef.current;

      setSemesters(semesterList);
      setSemester(currentSemester);
      setCourses(courseList);
      setTasksByCourse(nextTasksByCourse);
      setThreads(visibleThreads);

      commitActiveCourseId(selection.courseId);
      setActiveTaskId(selection.taskId);
      commitActiveThreadId(selection.threadId, currentSemester?.id);
      if (!selection.courseId) onClearFilesRef.current();
      else if (previousCourseId === selection.courseId) onReloadCourseFilesRef.current(selection.courseId);
      void loadWorkspaceExtras();
      return true;
    } catch (error) {
      if (mountedRef.current && workspaceReloadRequestRef.current === requestId) {
        setWorkspaceError(errorMessage(error, "Failed to reload workspace."));
      }
      return false;
    }
  }, [activeTaskId, activeThreadId, commitActiveCourseId, commitActiveThreadId, loadWorkspaceExtras]);

  useEffect(() => {
    let cancelled = false;
    mountedRef.current = true;
    void bootstrap(() => cancelled);
    return () => {
      cancelled = true;
      mountedRef.current = false;
    };
  }, [bootstrap]);

  const selectSemester = useCallback(async (semesterId: string) => {
    setWorkspaceError("");
    try {
      await window.brevyn.semester.select(semesterId);
      await reloadWorkspace();
    } catch (error) {
      if (mountedRef.current) setWorkspaceError(errorMessage(error, "Failed to switch semester."));
    }
  }, [reloadWorkspace]);

  const refreshThreads = useCallback(async (): Promise<Thread[]> => {
    try {
      const next = await window.brevyn.threads.list();
      const deduped = filterThreadsForSemester(dedupeThreads(next), semester?.id);
      if (mountedRef.current) setThreads(deduped);
      return deduped;
    } catch (error) {
      if (mountedRef.current) setWorkspaceError(errorMessage(error, "Failed to refresh sessions."));
      throw error;
    }
  }, [semester?.id]);

  const markThreadHasMessages = useCallback((threadId: string) => {
    const timestamp = new Date().toISOString();
    setThreads((current) => current.map((thread) => {
      if (thread.id !== threadId) return thread;
      return {
        ...thread,
        isDraft: false,
        messageCount: Math.max(1, thread.messageCount || 0),
        lastMessageAt: thread.lastMessageAt || timestamp,
        updatedAt: timestamp,
      };
    }));
  }, []);

  const threadTitleForScope = useCallback((courseId: string, taskId?: string): string => {
    const task = taskId ? (tasksByCourse[courseId] || []).find((item) => item.id === taskId) : undefined;
    const course = courses.find((item) => item.id === courseId);
    return task ? `${task.title} session` : course?.workspaceKind === "semester_home" ? "学期会话" : "Task session";
  }, [courses, tasksByCourse]);

  const findEmptyThreadForScope = useCallback((courseId: string, taskId?: string): Thread | undefined => {
    const candidates = threads.filter((thread) => threadBelongsToSemester(thread, semester?.id) && thread.courseId === courseId && (thread.taskId || undefined) === (taskId || undefined));
    return [...candidates].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).find(isDraftThread);
  }, [semester?.id, threads]);

  const createThread = useCallback(async (courseId = activeCourse?.id || "", taskId?: string): Promise<Thread | undefined> => {
    if (!courseId) return undefined;
    if (courseId !== SEMESTER_HOME_COURSE_ID && !taskId) {
      setWorkspaceError("Create sessions from a task, not the course container.");
      return undefined;
    }
    setWorkspaceError("");
    try {
      const emptyThread = findEmptyThreadForScope(courseId, taskId);
      if (emptyThread) {
        commitActiveCourseId(emptyThread.courseId);
        setActiveTaskId(emptyThread.taskId);
        commitActiveThreadId(emptyThread.id, emptyThread.semesterId || semester?.id);
        return emptyThread;
      }
      const thread = await window.brevyn.threads.create({
        courseId,
        taskId,
        title: threadTitleForScope(courseId, taskId),
        isDraft: true,
      });
      if (!threadBelongsToSemester(thread, semester?.id)) throw new Error("Created session does not belong to the selected semester.");
      setThreads((current) => dedupeThreads([thread, ...current]));
      commitActiveCourseId(thread.courseId);
      setActiveTaskId(thread.taskId);
      commitActiveThreadId(thread.id, thread.semesterId || semester?.id);
      return thread;
    } catch (error) {
      setWorkspaceError(errorMessage(error, "Create session failed."));
      return undefined;
    }
  }, [activeCourse?.id, commitActiveCourseId, commitActiveThreadId, findEmptyThreadForScope, semester?.id, threadTitleForScope]);

  const forkThread = useCallback(async (threadId: string, upToMessageUuid: string): Promise<Thread | null> => {
    setWorkspaceError("");
    try {
      const forked = await window.brevyn.threads.fork({ threadId, upToMessageUuid });
      if (!threadBelongsToSemester(forked, semester?.id)) throw new Error("Forked session does not belong to the selected semester.");
      setThreads((current) => dedupeThreads([forked, ...current]));
      commitActiveCourseId(forked.courseId);
      setActiveTaskId(forked.taskId);
      commitActiveThreadId(forked.id, forked.semesterId || semester?.id);
      if (forked.courseId) onReloadCourseFilesRef.current(forked.courseId);
      return forked;
    } catch (error) {
      setWorkspaceError(errorMessage(error, "Fork session failed."));
      return null;
    }
  }, [commitActiveCourseId, commitActiveThreadId, semester?.id]);

  const archiveThread = useCallback(async (thread: Thread) => {
    setWorkspaceError("");
    try {
      if (isDraftThread(thread)) {
        setWorkspaceError("空会话不需要归档；继续使用它，或者等有内容后再归档。");
        return;
      }
      await window.brevyn.threads.archive(thread.id);
      await refreshThreads();
      if (thread.id !== activeThreadId) return;

      const courseStillExists = courses.some((course) => course.id === thread.courseId);
      const taskStillExists = !thread.taskId || (tasksByCourse[thread.courseId] || []).some((task) => task.id === thread.taskId);
      commitActiveCourseId(courseStillExists ? thread.courseId : "");
      setActiveTaskId(courseStillExists && taskStillExists ? thread.taskId : undefined);
      commitActiveThreadId("", thread.semesterId || semester?.id);
    } catch (error) {
      setWorkspaceError(errorMessage(error, "Archive session failed."));
    }
  }, [activeThreadId, commitActiveCourseId, commitActiveThreadId, courses, refreshThreads, semester?.id, tasksByCourse]);

  const archiveTask = useCallback(async (task: BrevynTask): Promise<void> => {
    setWorkspaceError("");
    try {
      await window.brevyn.tasks.archive(task.id);
      await reloadWorkspace();
    } catch (error) {
      setWorkspaceError(errorMessage(error, "归档任务失败。"));
      throw error;
    }
  }, [reloadWorkspace]);

  const renameThread = useCallback(async (thread: Thread, title: string): Promise<void> => {
    setWorkspaceError("");
    try {
      const updated = await window.brevyn.threads.rename({ threadId: thread.id, title });
      setThreads((current) => dedupeThreads(current.map((item) => (item.id === updated.id ? updated : item))));
    } catch (error) {
      setWorkspaceError(errorMessage(error, "Rename session failed."));
      throw error;
    }
  }, []);

  const updateThreadWorkflow = useCallback(async (threadId: string, workflow?: ThreadWorkflow): Promise<Thread> => {
    const updated = await window.brevyn.threads.updateWorkflow({ threadId, workflow });
    setThreads((current) => dedupeThreads(current.map((item) => (item.id === updated.id ? updated : item))));
    return updated;
  }, []);

  const applyThreadUpdate = useCallback((thread: Thread): void => {
    if (!threadBelongsToSemester(thread, semester?.id)) return;
    setThreads((current) => dedupeThreads(current.map((item) => (item.id === thread.id ? thread : item))));
  }, [semester?.id]);

  const selectCourseHome = useCallback((courseId: string) => {
    commitActiveCourseId(courseId);
    setActiveTaskId(undefined);
    commitActiveThreadId("", semester?.id);
  }, [commitActiveCourseId, commitActiveThreadId, semester?.id]);

  const selectTask = useCallback((courseId: string, taskId: string) => {
    const thread = threads.find((item) => threadBelongsToSemester(item, semester?.id) && item.courseId === courseId && item.taskId === taskId);
    if (!thread) {
      void createThread(courseId, taskId);
      return;
    }
    commitActiveCourseId(courseId);
    setActiveTaskId(taskId);
    markAgentThreadStatusSeen(thread.id);
    commitActiveThreadId(thread.id, semester?.id);
  }, [commitActiveCourseId, commitActiveThreadId, createThread, semester?.id, threads]);

  const selectThread = useCallback((thread: Thread) => {
    if (!threadBelongsToSemester(thread, semester?.id)) {
      setWorkspaceError("This session belongs to a different semester. Select that semester first.");
      return;
    }
    setWorkspaceError("");
    commitActiveCourseId(thread.courseId);
    setActiveTaskId(thread.taskId);
    markAgentThreadStatusSeen(thread.id);
    commitActiveThreadId(thread.id, thread.semesterId || semester?.id);
  }, [commitActiveCourseId, commitActiveThreadId, semester?.id]);

  const handleCourseCreated = useCallback((course: Course) => {
    setCourses((current) => (current.some((item) => item.id === course.id) ? current : [...current, course]));
    setTasksByCourse((current) => ({ ...current, [course.id]: current[course.id] || [] }));
  }, []);

  const handleCourseUpdated = useCallback((course: Course) => {
    setCourses((current) => current.map((item) => (item.id === course.id ? course : item)));
  }, []);

  const handleTaskCreated = useCallback((task: BrevynTask) => {
    setTasksByCourse((current) => ({
      ...current,
      [task.courseId]: [...(current[task.courseId] || []), task],
    }));
    onReloadCourseFilesRef.current(task.courseId);
  }, []);

  const handleTaskUpdated = useCallback((task: BrevynTask) => {
    setTasksByCourse((current) => ({
      ...current,
      [task.courseId]: (current[task.courseId] || []).map((item) => (item.id === task.id ? task : item)),
    }));
    onReloadCourseFilesRef.current(task.courseId);
  }, []);

  const applyTaskUpdate = useCallback((task: BrevynTask) => {
    if (!semester?.id || task.semesterId !== semester.id) return;
    setTasksByCourse((current) => {
      const tasks = current[task.courseId] || [];
      if (!tasks.some((item) => item.id === task.id)) return current;
      return {
        ...current,
        [task.courseId]: tasks.map((item) => (item.id === task.id ? task : item)),
      };
    });
  }, [semester?.id]);

  return {
    courses,
    semesters,
    semester,
    tasksByCourse,
    threads,
    skills,
    setSkills,
    gitStatus,
    activeCourseId,
    activeTaskId,
    activeThreadId,
    activeCourse,
    activeTask,
    activeThread,
    workspaceScope,
    needsSemesterSelection,
    noActiveSemesters,
    emptyThreadIds,
    bootState,
    bootError,
    workspaceError,
    setWorkspaceError,
    bootstrap,
    reloadWorkspace,
    selectSemester,
    refreshThreads,
    markThreadHasMessages,
    createThread,
    forkThread,
    archiveThread,
    archiveTask,
    renameThread,
    updateThreadWorkflow,
    applyThreadUpdate,
    selectCourseHome,
    selectTask,
    selectThread,
    handleCourseCreated,
    handleCourseUpdated,
    handleTaskCreated,
    handleTaskUpdated,
    applyTaskUpdate,
  };
}

function describeWorkspaceScope(course?: Course, task?: BrevynTask, thread?: Thread): string {
  if (task || thread?.taskId) return "Task workspace shared across sessions";
  if (course?.workspaceKind === "semester_home" || thread?.threadType === "semester_home") return "Semester workspace";
  if (course) return "Course workspace";
  return "Workspace scope pending";
}

function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "").trim();
  return message.trim() || fallback;
}

function readStoredWorkspaceThreadId(semesterId?: string): string {
  try {
    const semesterThreadId = semesterId ? window.localStorage.getItem(`${LAST_WORKSPACE_THREAD_BY_SEMESTER_PREFIX}${semesterId}`) : "";
    return semesterThreadId || window.localStorage.getItem(LAST_WORKSPACE_THREAD_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function writeStoredWorkspaceThreadId(threadId: string, semesterId?: string): void {
  try {
    if (!threadId) {
      window.localStorage.removeItem(LAST_WORKSPACE_THREAD_STORAGE_KEY);
      if (semesterId) window.localStorage.removeItem(`${LAST_WORKSPACE_THREAD_BY_SEMESTER_PREFIX}${semesterId}`);
      return;
    }
    window.localStorage.setItem(LAST_WORKSPACE_THREAD_STORAGE_KEY, threadId);
    if (semesterId) window.localStorage.setItem(`${LAST_WORKSPACE_THREAD_BY_SEMESTER_PREFIX}${semesterId}`, threadId);
  } catch {
    // Ignore storage failures; workspace selection still works in memory.
  }
}

function dedupeThreads(threads: Thread[]): Thread[] {
  const seen = new Set<string>();
  const result: Thread[] = [];
  for (const thread of threads) {
    if (seen.has(thread.id)) continue;
    seen.add(thread.id);
    result.push(thread);
  }
  return result;
}

function threadBelongsToSemester(thread: Thread, semesterId?: string) {
  return Boolean(semesterId && thread.semesterId === semesterId);
}

function filterThreadsForSemester(threads: Thread[], semesterId?: string) {
  return threads.filter((thread) => threadBelongsToSemester(thread, semesterId));
}

function isDraftThread(thread: Thread): boolean {
  return Boolean(thread.isDraft);
}

interface WorkspaceSelection {
  courseId: string;
  taskId?: string;
  threadId: string;
}

function pickWorkspaceSelection(
  courses: Course[],
  tasksByCourse: Record<string, BrevynTask[]>,
  threads: Thread[],
  current?: WorkspaceSelection,
  preferredThreadId?: string,
): WorkspaceSelection {
  const preferredThread = preferredThreadId ? validThreadSelection(threads.find((thread) => thread.id === preferredThreadId), courses, tasksByCourse) : undefined;
  if (preferredThread) return preferredThread;

  const currentThread = current?.threadId ? validThreadSelection(threads.find((thread) => thread.id === current.threadId), courses, tasksByCourse) : undefined;
  if (currentThread) return currentThread;

  if (current?.courseId && courses.some((course) => course.id === current.courseId)) {
    if (current.taskId && taskBelongsToCourse(tasksByCourse, current.courseId, current.taskId)) {
      return { courseId: current.courseId, taskId: current.taskId, threadId: "" };
    }
    if (!current.taskId) return { courseId: current.courseId, taskId: undefined, threadId: "" };
  }

  if (courses.some((course) => course.id === SEMESTER_HOME_COURSE_ID)) {
    return { courseId: SEMESTER_HOME_COURSE_ID, taskId: undefined, threadId: "" };
  }

  return {
    courseId: "",
    taskId: undefined,
    threadId: "",
  };
}

function validThreadSelection(thread: Thread | undefined, courses: Course[], tasksByCourse: Record<string, BrevynTask[]>): WorkspaceSelection | undefined {
  if (!thread || !courses.some((course) => course.id === thread.courseId)) return undefined;
  if (thread.taskId && !taskBelongsToCourse(tasksByCourse, thread.courseId, thread.taskId)) return undefined;
  return {
    courseId: thread.courseId,
    taskId: thread.taskId,
    threadId: thread.id,
  };
}

function taskBelongsToCourse(tasksByCourse: Record<string, BrevynTask[]>, courseId: string, taskId: string): boolean {
  return Boolean((tasksByCourse[courseId] || []).some((task) => task.id === taskId));
}
