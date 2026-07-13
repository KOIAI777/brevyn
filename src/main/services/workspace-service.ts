import { createInterface } from "node:readline";
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  ArchivedCourseScope,
  ArchivedTaskScope,
  ArchivedThreadScope,
  Course,
  CourseTaskInfo,
  CourseTaskSourceAnchor,
  CreateCourseInput,
  CreateSemesterInput,
  CreateTaskInput,
  CreateThreadInput,
  ForkThreadInput,
  GitStatus,
  SemesterWorkspace,
  Thread,
  BrevynTask,
  UpdateCourseInput,
  UpdateTaskInput,
  WorkspaceFileNode,
} from "../../types/domain";
import type { SQLiteBusinessStore } from "../storage";
import { recordCleanupFailure, type CleanupFailure } from "./cleanup-log";
import type { RagIndexService } from "./rag-index-service";
import {
  cloneFiles,
  ensureCourseFolderInTree,
  flattenFiles,
  normalizeCourses,
} from "./workspace-file-tree";
import {
  DEFAULT_TASK_TYPE,
  SEMESTER_HOME_COURSE_ID,
  courseWorkspaceDir,
  ensureCourseWorkspaceDir,
  ensureSemesterSharedDirs,
  ensureTaskWorkspaceDir,
  ensureThreadMessagesDir,
  sanitizeFsSegment,
  semesterWorkspaceDir,
  taskWorkspaceDirForTask,
  threadMessagesPath,
} from "./workspace-paths";
import { matchCourseIcon } from "../../shared/course-icon-matcher";
import { matchTaskIcon } from "../../shared/task-icon-matcher";
import {
  activeCourseInSemesterOrThrow,
  currentActiveSemester,
  currentActiveSemesterId,
  isCourseArchived,
  isCurrentSemesterArchived,
  isSemesterArchived,
} from "./workspace-state";

const now = () => new Date().toISOString();
const colorPattern = /^#[0-9a-f]{6}$/i;
const courseIconKeys = new Set([
  "graduation-cap",
  "book-open",
  "scale",
  "landmark",
  "briefcase",
  "file-text",
  "gavel",
  "library",
  "microscope",
  "calculator",
  "globe",
  "presentation",
  "square-pen",
  "clipboard-list",
]);

function normalizeCourseColor(value: string, fallback: string): string {
  const color = value.trim();
  if (!color) return fallback;
  if (!colorPattern.test(color)) throw new Error("Course color must be a hex color like #2563eb.");
  return color.toLowerCase();
}

function normalizeCourseIcon(value: string): Course["icon"] {
  if (!courseIconKeys.has(value)) throw new Error("Course icon is not supported.");
  return value as Course["icon"];
}

export interface WorkspaceServiceOptions {
  rootDataDir: string;
  businessStore: SQLiteBusinessStore;
  ragIndex: RagIndexService;
}

export class WorkspaceService {
  constructor(private readonly options: WorkspaceServiceOptions) {}

  listSemesters(): SemesterWorkspace[] {
    return this.options.businessStore.listSemesters()
      .filter((semester) => !semester.archivedAt)
      .map((semester) => ({ ...semester }))
      .sort((a, b) => Date.parse(b.startsAt || b.recognizedAt || "") - Date.parse(a.startsAt || a.recognizedAt || ""));
  }

  listArchivedSemesters(): SemesterWorkspace[] {
    return this.options.businessStore.listSemesters()
      .filter((semester) => Boolean(semester.archivedAt))
      .map((semester) => ({ ...semester }))
      .sort((a, b) => Date.parse(b.archivedAt || "") - Date.parse(a.archivedAt || ""));
  }

  currentSemester(): SemesterWorkspace | null {
    const semester = currentActiveSemester(this.options.businessStore);
    return semester ? { ...semester } : null;
  }

  createSemester(input: CreateSemesterInput): SemesterWorkspace {
    const timestamp = now();
    const term = input.term.trim() || "New Semester";
    const semester: SemesterWorkspace = {
      id: entityId("semester"),
      semesterNo: input.semesterNo?.trim() || term,
      term,
      folderName: sanitizeFsSegment(input.folderName?.trim() || term),
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      weekCount: input.weekCount,
      source: "manual",
      recognizedAt: timestamp,
    };
    const roots = this.buildCourseRoots(SEMESTER_HOME_COURSE_ID, semester.id, semester, undefined, []);
    try {
      ensureSemesterSharedDirs(this.options.rootDataDir, semester.id);
      this.options.businessStore.saveSemesterWithWorkspaceFiles(semester, roots, true);
      return { ...semester };
    } catch (error) {
      this.deleteSemesterDir(semester.id);
      throw error;
    }
  }

  selectSemester(semesterId: string): SemesterWorkspace {
    const semester = this.options.businessStore.getSemester(semesterId);
    if (!semester) throw new Error(`Semester not found: ${semesterId}`);
    if (semester.archivedAt) throw new Error(`Semester is archived: ${semester.term}`);
    this.options.businessStore.setCurrentSemester(semester.id);
    return { ...semester };
  }

  archiveSemester(semesterId: string): SemesterWorkspace {
    const selectedSemesterId = this.options.businessStore.currentSemesterId() || "";
    const semester = this.options.businessStore.getSemester(semesterId);
    if (!semester) throw new Error(`Semester not found: ${semesterId}`);
    if (semester.archivedAt) return { ...semester };
    const archivedAt = now();
    const archived = this.options.businessStore.archiveSemester(semesterId, archivedAt) || semester;
    if (selectedSemesterId === semesterId) {
      this.options.businessStore.setCurrentSemester(null);
    }
    return { ...archived };
  }

  restoreSemester(semesterId: string): SemesterWorkspace {
    const semester = this.options.businessStore.getSemester(semesterId);
    if (!semester) throw new Error(`Semester not found: ${semesterId}`);
    const restored = this.options.businessStore.restoreSemester(semesterId) || semester;
    return { ...restored };
  }

  async deleteSemester(semesterId: string): Promise<boolean> {
    const selectedSemesterId = this.options.businessStore.currentSemesterId() || "";
    const semester = this.options.businessStore.getSemester(semesterId);
    if (!semester) throw new Error(`Semester not found: ${semesterId}`);
    if (!semester.archivedAt) throw new Error("Archive the semester before deleting it permanently.");
    if (this.options.businessStore.hasActiveSemesterIndexing(semesterId)) {
      throw new Error("Wait for indexing to finish before deleting this semester.");
    }
    const threads = this.options.businessStore.listThreads(semesterId);
    const deleted = this.options.businessStore.deleteSemesterDeep(semesterId);
    if (!deleted) return false;
    if (selectedSemesterId === semesterId) {
      this.options.businessStore.setCurrentSemester(null);
    }
    this.deleteThreadMessageFiles(threads);
    this.deleteSemesterDir(semesterId);
    await this.deleteRagChunksForSemester(semesterId);
    return true;
  }

  listCourses(): Course[] {
    const semester = currentActiveSemester(this.options.businessStore);
    if (!semester) return [];
    return normalizeCourses(this.options.businessStore.listCourses(semester.id), semester).filter((course) => course.id === SEMESTER_HOME_COURSE_ID || !course.archivedAt);
  }

  listCoursesForArchive(scope?: ArchivedCourseScope): Course[] {
    const semester = scope?.semesterId
      ? this.options.businessStore.getSemester(scope.semesterId)
      : currentActiveSemester(this.options.businessStore);
    if (!semester) return [];
    return normalizeCourses(this.options.businessStore.listCourses(semester.id), semester)
      .filter((course) => course.id !== SEMESTER_HOME_COURSE_ID)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listArchivedCourses(scope?: ArchivedCourseScope): Course[] {
    const semester = scope?.semesterId
      ? this.options.businessStore.getSemester(scope.semesterId)
      : currentActiveSemester(this.options.businessStore);
    if (!semester) return [];
    return normalizeCourses(this.options.businessStore.listCourses(semester.id), semester)
      .filter((course) => course.id !== SEMESTER_HOME_COURSE_ID && Boolean(course.archivedAt))
      .sort((a, b) => Date.parse(b.archivedAt || "") - Date.parse(a.archivedAt || ""));
  }

  listTasks(courseId: string): BrevynTask[] {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId || isCourseArchived(this.options.businessStore, courseId) || isCurrentSemesterArchived(this.options.businessStore)) return [];
    return this.options.businessStore.listTasks(semesterId, courseId);
  }

  listArchivedTasks(scope?: ArchivedTaskScope): BrevynTask[] {
    const semesterId = scope?.semesterId || currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return [];
    const semester = this.options.businessStore.getSemester(semesterId);
    if (!semester) return [];
    if (scope?.courseId) {
      const course = this.options.businessStore.getCourse(scope.courseId);
      if (!course || course.semesterId !== semesterId) return [];
    }
    return this.options.businessStore.listArchivedTasks(semesterId, scope?.courseId);
  }

  createTask(input: CreateTaskInput): BrevynTask {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) throw new Error("Select or recognize a semester before creating tasks.");
    const course = activeCourseInSemesterOrThrow(this.options.businessStore, input.courseId, semesterId);
    const task: BrevynTask = {
      id: entityId("task"),
      semesterId,
      courseId: input.courseId,
      title: input.title.trim() || "New Task",
      taskType: input.taskType?.trim() || DEFAULT_TASK_TYPE,
      icon: input.icon || matchTaskIcon({ title: input.title, taskType: input.taskType }),
      status: "not_started",
      summary: "",
    };
    const roots = this.loadCourseRoots(input.courseId, semesterId);
    ensureCourseFolderInTree({
      roots,
      courseId: input.courseId,
      semester: this.options.businessStore.getSemester(semesterId),
      course,
      tasks: [...this.options.businessStore.listTasks(semesterId, input.courseId), task],
      timestamp: now(),
    });
    try {
      ensureTaskWorkspaceDir(this.options.rootDataDir, semesterId, task);
      this.options.businessStore.saveTaskWithWorkspaceFiles(task, roots);
      return task;
    } catch (error) {
      this.deleteTaskDir(task);
      throw error;
    }
  }

  updateTask(input: UpdateTaskInput): BrevynTask {
    const task = this.options.businessStore.getTask(input.id);
    if (!task) throw new Error(`Task not found: ${input.id}`);
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId || task.semesterId !== semesterId) throw new Error("Select this task's semester before updating it.");
    activeCourseInSemesterOrThrow(this.options.businessStore, task.courseId, semesterId);
    if (task.archivedAt) throw new Error("Restore this task before updating it.");
    const nextInput = input.info
      ? { ...input, info: this.validateCourseTaskInfo(task, input.info) }
      : input;
    const updated = this.options.businessStore.updateTask(nextInput);
    if (!updated) throw new Error(`Task not found: ${input.id}`);
    return updated;
  }

  private validateCourseTaskInfo(task: BrevynTask, info: CourseTaskInfo): CourseTaskInfo {
    const resolveSource = (source?: CourseTaskSourceAnchor): CourseTaskSourceAnchor | undefined => {
      if (!source) return undefined;
      const file = this.requireCourseTaskInfoFile(task, source.fileId);
      return { ...source, fileId: file.id, fileName: file.name };
    };
    return {
      ...info,
      requirements: info.requirements.map((requirement) => ({
        ...requirement,
        source: resolveSource(requirement.source),
      })),
      rubricCriteria: info.rubricCriteria.map((criterion) => ({
        ...criterion,
        source: resolveSource(criterion.source),
      })),
      documents: info.documents.map((document) => {
        const file = this.requireCourseTaskInfoFile(task, document.fileId);
        return { ...document, fileId: file.id, fileName: file.name };
      }),
    };
  }

  private requireCourseTaskInfoFile(task: BrevynTask, fileId: string): WorkspaceFileNode {
    const file = this.options.businessStore.getWorkspaceFile(fileId);
    if (!file || file.kind === "folder") throw new Error(`课程任务信息来源文件不存在：${fileId}`);
    if (file.semesterId !== task.semesterId || file.courseId !== task.courseId) {
      throw new Error(`课程任务信息来源不属于当前课程：${file.name}`);
    }
    if (file.taskId && file.taskId !== task.id) {
      throw new Error(`课程任务信息来源属于另一个课程任务：${file.name}`);
    }
    return file;
  }

  archiveTask(taskId: string): BrevynTask {
    const task = this.options.businessStore.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.archivedAt) return { ...task };
    if (!task.semesterId) throw new Error("Task has no semester scope.");
    activeCourseInSemesterOrThrow(this.options.businessStore, task.courseId, task.semesterId);
    const archived = this.options.businessStore.archiveTask(task.id, now());
    if (!archived) throw new Error(`Task not found: ${taskId}`);
    return { ...archived };
  }

  restoreTask(taskId: string): BrevynTask {
    const task = this.options.businessStore.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (!task.semesterId) throw new Error("Task has no semester scope.");
    activeCourseInSemesterOrThrow(this.options.businessStore, task.courseId, task.semesterId);
    const restored = this.options.businessStore.restoreTask(task.id);
    if (!restored) throw new Error(`Task not found: ${taskId}`);
    return { ...restored };
  }

  async deleteTask(taskId: string): Promise<boolean> {
    const task = this.options.businessStore.getTask(taskId);
    if (!task) return false;
    if (!task.archivedAt) throw new Error("Archive the task before deleting it permanently.");
    const semesterId = task.semesterId;
    if (!semesterId) throw new Error("Task has no semester scope.");
    const course = this.options.businessStore.getCourse(task.courseId);
    if (!course || course.semesterId !== semesterId) throw new Error("Task does not belong to this course.");
    if (this.options.businessStore.hasActiveTaskIndexing(task.id, task.courseId)) {
      throw new Error("Wait for indexing to finish before deleting this task.");
    }
    const taskFileIds = flattenFiles(this.options.businessStore.listWorkspaceFiles(semesterId, task.courseId))
      .filter((file) => file.taskId === task.id)
      .map((file) => file.id);
    const threads = this.options.businessStore.listThreads(semesterId, task.courseId).filter((thread) => thread.taskId === task.id);
    const deleted = this.options.businessStore.deleteTaskDeep(task.id);
    if (!deleted) return false;
    this.deleteTaskDir(task);
    this.deleteThreadMessageFiles(threads);
    await this.deleteRagChunksForTask(semesterId, task.courseId, task.id, taskFileIds);
    return true;
  }

  createCourse(input: CreateCourseInput): Course {
    const semester = currentActiveSemester(this.options.businessStore);
    if (!semester) throw new Error("Select a semester before creating a course.");
    const name = input.name?.trim();
    const code = input.code?.trim();
    if (!name) throw new Error("Course name is required.");
    if (!code) throw new Error("Course code is required.");

    const existingCourseCount = this.options.businessStore.countCourses(semester.id);
    const course: Course = {
      id: entityId("course"),
      semesterId: semester.id,
      name,
      code,
      term: semester.term,
      instructor: input.instructor?.trim() || "",
      workspaceKind: "course",
      meetingTime: input.meetingTime?.trim() || undefined,
      location: input.location?.trim() || undefined,
      color: input.color?.trim() || pickCourseColor(existingCourseCount),
      icon: matchCourseIcon({ name, code }),
      description: input.description?.trim() || "",
    };
    const roots = this.buildCourseRoots(course.id, semester.id, semester, course, []);
    try {
      ensureCourseWorkspaceDir(this.options.rootDataDir, semester.id, course.id);
      this.options.businessStore.saveCourseWithWorkspaceFiles(course, roots);
      return course;
    } catch (error) {
      this.deleteCourseDir(course.id, semester.id);
      throw error;
    }
  }

  updateCourse(input: UpdateCourseInput): Course {
    const course = this.options.businessStore.getCourse(input.id);
    if (!course) throw new Error(`Course not found: ${input.id}`);
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId || course.semesterId !== semesterId) throw new Error("Select this course's semester before editing it.");
    if (course.archivedAt) throw new Error("Restore this course before editing it.");
    if (course.workspaceKind === "semester_home") throw new Error("Semester Home course details cannot be edited here.");

    const code = input.code === undefined ? course.code : input.code.trim();
    if (!code) throw new Error("Course code is required.");
    const next: Course = {
      ...course,
      code,
      instructor: input.instructor === undefined ? course.instructor : input.instructor.trim(),
      meetingTime: input.meetingTime === undefined ? course.meetingTime : input.meetingTime?.trim() || undefined,
      location: input.location === undefined ? course.location : input.location?.trim() || undefined,
      color: input.color === undefined ? course.color : normalizeCourseColor(input.color, course.color),
      icon: input.icon === undefined ? course.icon : normalizeCourseIcon(input.icon),
    };
    return this.options.businessStore.updateCourseDetails(next);
  }

  archiveCourse(courseId: string): Course {
    const course = this.options.businessStore.getCourse(courseId);
    if (!course) throw new Error(`Course not found: ${courseId}`);
    if (course.archivedAt) return { ...course };
    const archivedAt = now();
    const archived = this.options.businessStore.archiveCourse(courseId, archivedAt) || course;
    return { ...archived };
  }

  restoreCourse(courseId: string): Course {
    const course = this.options.businessStore.getCourse(courseId);
    if (!course) throw new Error(`Course not found: ${courseId}`);
    if (course.semesterId && isSemesterArchived(this.options.businessStore, course.semesterId)) {
      throw new Error("Restore the parent semester before restoring this course.");
    }
    const restored = this.options.businessStore.restoreCourse(courseId) || course;
    return { ...restored };
  }

  async deleteCourse(courseId: string): Promise<boolean> {
    const course = this.options.businessStore.getCourse(courseId);
    if (!course) throw new Error(`Course not found: ${courseId}`);
    if (!course.archivedAt) throw new Error("Archive the course before deleting it permanently.");
    if (this.options.businessStore.hasActiveCourseIndexing(courseId)) {
      throw new Error("Wait for indexing to finish before deleting this course.");
    }
    const semesterId = course.semesterId || currentActiveSemesterId(this.options.businessStore);
    const threads = this.options.businessStore.listThreads(semesterId, courseId);
    const deleted = this.options.businessStore.deleteCourseDeep(courseId);
    if (!deleted) return false;
    this.deleteCourseDir(courseId, semesterId);
    this.deleteThreadMessageFiles(threads);
    await this.deleteRagChunksForCourse(semesterId, courseId);
    return true;
  }

  listThreads(courseId?: string): Thread[] {
    if (isCurrentSemesterArchived(this.options.businessStore)) return [];
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return [];
    return this.options.businessStore.listThreads(semesterId, courseId)
      .filter((thread) => this.isThreadUsable(thread))
      .slice()
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  listArchivedThreads(scope?: ArchivedThreadScope): Thread[] {
    if (!scope?.semesterId && isCurrentSemesterArchived(this.options.businessStore)) return [];
    const semesterId = scope?.semesterId || currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return [];
    return this.options.businessStore.listArchivedThreads(semesterId, scope?.courseId)
      .sort((a, b) => Date.parse(b.archivedAt || b.updatedAt) - Date.parse(a.archivedAt || a.updatedAt));
  }

  createThread(input: CreateThreadInput): Thread {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    const task = this.assertThreadParentUsable({
      id: "new-thread",
      semesterId,
      courseId: input.courseId,
      taskId: input.taskId,
    });
    const thread: Thread = {
      id: entityId("thread"),
      semesterId,
      courseId: input.courseId,
      taskId: input.taskId,
      threadType: input.courseId === SEMESTER_HOME_COURSE_ID ? "semester_home" : "task",
      title: input.title || (task ? `${task.title} thread` : "新的学期会话"),
      titleSource: "default",
      isDraft: Boolean(input.isDraft),
      messageCount: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    ensureThreadMessagesDir(this.options.rootDataDir, semesterId);
    this.options.businessStore.saveThread(thread);
    return thread;
  }

  async forkThread(input: ForkThreadInput): Promise<Thread> {
    const sourceThread = this.assertThreadUsable(input.threadId);
    if (!sourceThread.semesterId) throw new Error(`Thread ${sourceThread.id} has no semester scope.`);
    if (!sourceThread.sdkSessionId) throw new Error("This thread does not have a Claude SDK session yet.");

    const forkTarget = await this.resolveForkTarget(sourceThread, input.upToMessageUuid);
    let forkSourceSdkSessionId = sourceThread.sdkSessionId;
    let effectiveUpToMessageUuid = input.upToMessageUuid;
    if (forkTarget) {
      effectiveUpToMessageUuid = forkTarget.effectiveUpToMessageUuid;
      if (forkTarget.effectiveSdkSessionId) forkSourceSdkSessionId = forkTarget.effectiveSdkSessionId;
      if (forkTarget.usedSidechainFallback) {
        console.log(`[workspace] Fork target ${input.upToMessageUuid} is sidechain output; using mainline assistant ${effectiveUpToMessageUuid}.`);
      }
      if (forkSourceSdkSessionId !== sourceThread.sdkSessionId) {
        console.log(`[workspace] Fork target belongs to SDK session ${forkSourceSdkSessionId}; current thread session is ${sourceThread.sdkSessionId}.`);
      }
    }

    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const cwd = this.resolveThreadWorkspacePath(sourceThread);
    let forkResult: Awaited<ReturnType<typeof sdk.forkSession>>;
    try {
      forkResult = await sdk.forkSession(forkSourceSdkSessionId, {
        upToMessageId: effectiveUpToMessageUuid,
        dir: cwd,
      });
    } catch (error) {
      console.warn("[workspace] forkSession with workspace dir failed; retrying with SDK global search.", error);
      forkResult = await sdk.forkSession(forkSourceSdkSessionId, {
        upToMessageId: effectiveUpToMessageUuid,
      });
    }

    const thread: Thread = {
      id: entityId("thread"),
      semesterId: sourceThread.semesterId,
      courseId: sourceThread.courseId,
      taskId: sourceThread.taskId,
      threadType: sourceThread.threadType,
      title: `${sourceThread.title} 分叉`,
      titleSource: "default",
      sdkSessionId: forkResult.sessionId,
      parentThreadId: sourceThread.id,
      rootThreadId: sourceThread.rootThreadId || sourceThread.id,
      forkFromMessageUuid: input.upToMessageUuid,
      forkSourceSdkSessionId,
      isDraft: false,
      messageCount: 0,
      createdAt: now(),
      updatedAt: now(),
    };

    ensureThreadMessagesDir(this.options.rootDataDir, sourceThread.semesterId);
    this.options.businessStore.saveThread(thread);
    const copied = await this.copyThreadMessages(sourceThread, thread, input.upToMessageUuid);
    const updatedThread = {
      ...thread,
      messageCount: copied.sdkMessageCount,
      lastMessageAt: copied.lastMessageAt,
      updatedAt: copied.lastMessageAt || thread.updatedAt,
    };
    this.options.businessStore.saveThread(updatedThread);
    return updatedThread;
  }

  private async resolveForkTarget(sourceThread: Thread, upToMessageUuid: string): Promise<ForkTargetResolution | null> {
    if (!sourceThread.semesterId) return null;
    const sourcePath = threadMessagesPath(this.options.rootDataDir, sourceThread.semesterId, sourceThread.id);
    if (!existsSync(sourcePath)) return null;
    const target = await findForkTargetInThreadMessages(sourcePath, upToMessageUuid);
    if (!target) throw new Error("未在会话历史中找到指定消息，无法分叉。");
    if (!target.isSidechain) {
      return {
        effectiveUpToMessageUuid: target.uuid,
        effectiveSdkSessionId: target.sessionId,
        usedSidechainFallback: false,
      };
    }
    if (!target.fallbackMainline) {
      throw new Error("选中的是工具或子任务过程消息，前面没有可分叉的主回复。");
    }
    return {
      effectiveUpToMessageUuid: target.fallbackMainline.uuid,
      effectiveSdkSessionId: target.fallbackMainline.sessionId,
      usedSidechainFallback: true,
    };
  }

  renameThread(threadId: string, title: string): Thread {
    const thread = this.assertThreadUsable(threadId);
    if (thread.archivedAt) throw new Error("Restore the thread before renaming it.");
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Thread title is required.");
    const updated = this.options.businessStore.renameThread(threadId, trimmed.slice(0, 100));
    if (!updated) throw new Error(`Thread not found: ${threadId}`);
    return updated;
  }

  updateThreadWorkflow(threadId: string, workflow: Thread["workflow"] | undefined): Thread {
    const thread = this.assertThreadUsable(threadId);
    if (thread.archivedAt) throw new Error("Restore the thread before updating workflow.");
    const updated = this.options.businessStore.updateThreadWorkflow(thread.id, workflow);
    if (!updated) throw new Error(`Thread not found: ${threadId}`);
    return updated;
  }

  archiveThread(threadId: string): boolean {
    const thread = this.options.businessStore.getThread(threadId);
    if (!thread || thread.archivedAt) return false;
    if (thread.isDraft) throw new Error("Empty draft sessions do not need to be archived.");
    return Boolean(this.options.businessStore.archiveThread(threadId, now()));
  }

  restoreThread(threadId: string): Thread {
    const thread = this.options.businessStore.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    this.assertThreadParentUsable(thread);
    const restored = this.options.businessStore.restoreThread(threadId);
    if (!restored) throw new Error(`Thread not found: ${threadId}`);
    return { ...restored };
  }

  deleteThread(threadId: string): boolean {
    const thread = this.options.businessStore.getThread(threadId);
    if (!thread) return false;
    if (!thread.archivedAt) throw new Error("Archive the thread before deleting it permanently.");
    const deleted = this.options.businessStore.deleteThread(threadId);
    if (deleted) this.deleteThreadMessageFiles([thread]);
    return deleted;
  }

  gitStatus(): GitStatus {
    return {
      root: process.cwd(),
      branch: "local/mock",
      changedFiles: 0,
      summary: "Git service stub is wired; real status will run through main-process GitService.",
    };
  }

  private assertThreadUsable(threadOrId: string | Thread): Thread {
    const thread = typeof threadOrId === "string" ? this.options.businessStore.getThread(threadOrId) : threadOrId;
    if (!thread) throw new Error(`Thread not found: ${threadOrId}`);
    if (thread.archivedAt) throw new Error("Restore the thread before using it.");
    this.assertThreadParentUsable(thread);
    return thread;
  }

  private assertThreadParentUsable(thread: Pick<Thread, "id" | "semesterId" | "courseId" | "taskId">): BrevynTask | null {
    if (!thread.semesterId) throw new Error(`Thread ${thread.id} has no semester scope.`);
    const semester = this.options.businessStore.getSemester(thread.semesterId);
    if (!semester) throw new Error(`Semester not found: ${thread.semesterId}`);
    if (semester.archivedAt) throw new Error("Restore this semester before using sessions.");

    if (thread.courseId === SEMESTER_HOME_COURSE_ID) {
      if (thread.taskId) throw new Error("Task sessions must belong to a course.");
      return null;
    }

    const course = this.options.businessStore.getCourse(thread.courseId);
    if (!course) throw new Error(`Course not found: ${thread.courseId}`);
    if (course.semesterId !== thread.semesterId) throw new Error("Thread course does not belong to this semester.");
    if (course.archivedAt) throw new Error("Restore this course before using sessions.");

    if (!thread.taskId) throw new Error("Create sessions from a task, not the course container.");
    const task = this.options.businessStore.getTask(thread.taskId);
    if (!task) throw new Error(`Task not found: ${thread.taskId}`);
    if (task.courseId !== thread.courseId) throw new Error("Task does not belong to this course.");
    if (!task.semesterId || task.semesterId !== thread.semesterId) throw new Error("Task does not belong to this semester.");
    if (task.archivedAt) throw new Error("Restore this task before using sessions.");
    return task;
  }

  private isThreadUsable(thread: Thread): boolean {
    try {
      this.assertThreadUsable(thread);
      return true;
    } catch {
      return false;
    }
  }

  private loadCourseRoots(courseId: string, semesterId: string): WorkspaceFileNode[] {
    return cloneFiles(this.options.businessStore.listWorkspaceFiles(semesterId, courseId).filter((file) => file.kind === "folder"));
  }

  private buildCourseRoots(
    courseId: string,
    semesterId: string,
    semester: SemesterWorkspace,
    course: Course | undefined,
    tasks: BrevynTask[],
  ): WorkspaceFileNode[] {
    const roots: WorkspaceFileNode[] = [];
    ensureCourseFolderInTree({
      roots,
      courseId,
      semester,
      course,
      tasks,
      timestamp: now(),
    });
    return roots;
  }

  private deleteCourseDir(courseId: string, semesterId?: string): void {
    if (!semesterId) return;
    const path = courseWorkspaceDir(this.options.rootDataDir, semesterId, courseId);
    this.safeRm(path, `[workspace] Failed to delete course directory ${courseId}`, {
      scope: "workspace",
      operation: "delete_course_dir",
      targetId: courseId,
      path,
    });
  }

  private deleteTaskDir(task: BrevynTask): void {
    const semesterId = task.semesterId || currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return;
    const courseDir = courseWorkspaceDir(this.options.rootDataDir, semesterId, task.courseId);
    const path = taskWorkspaceDirForTask(courseDir, task);
    this.safeRm(path, `[workspace] Failed to delete task directory ${task.id}`, {
      scope: "workspace",
      operation: "delete_task_dir",
      targetId: task.id,
      path,
    });
  }

  private deleteSemesterDir(semesterId: string): void {
    const path = semesterWorkspaceDir(this.options.rootDataDir, semesterId);
    this.safeRm(path, `[workspace] Failed to delete semester directory ${semesterId}`, {
      scope: "workspace",
      operation: "delete_semester_dir",
      targetId: semesterId,
      path,
    });
  }

  private deleteThreadMessageFiles(threads: Thread[]): void {
    for (const thread of threads) {
      if (!thread.semesterId) continue;
      const path = threadMessagesPath(this.options.rootDataDir, thread.semesterId, thread.id);
      this.safeRm(path, `[threads] Failed to delete messages for ${thread.id}`, {
        scope: "thread",
        operation: "delete_thread_messages",
        targetId: thread.id,
        path,
      });
    }
  }

  private resolveThreadWorkspacePath(thread: Thread): string {
    if (!thread.semesterId) throw new Error(`Thread ${thread.id} has no semester scope.`);
    if (thread.threadType === "semester_home" || thread.courseId === SEMESTER_HOME_COURSE_ID) {
      return join(ensureSemesterSharedDirs(this.options.rootDataDir, thread.semesterId), "Semester shared");
    }
    if (!thread.taskId) throw new Error("Create sessions from a task, not the course container.");
    const task = this.options.businessStore.getTask(thread.taskId);
    if (!task) throw new Error(`Task not found: ${thread.taskId}`);
    return ensureTaskWorkspaceDir(this.options.rootDataDir, thread.semesterId, task);
  }

  private async copyThreadMessages(sourceThread: Thread, destThread: Thread, upToMessageUuid: string): Promise<{ sdkMessageCount: number; lastMessageAt?: string }> {
    if (!sourceThread.semesterId || !destThread.semesterId) return { sdkMessageCount: 0 };
    const sourcePath = threadMessagesPath(this.options.rootDataDir, sourceThread.semesterId, sourceThread.id);
    if (!existsSync(sourcePath)) return { sdkMessageCount: 0 };
    const destPath = threadMessagesPath(this.options.rootDataDir, destThread.semesterId, destThread.id);
    mkdirSync(dirname(destPath), { recursive: true });
    const out = createWriteStream(destPath, { flags: "a", encoding: "utf8" });
    const rl = createInterface({ input: createReadStream(sourcePath), crlfDelay: Infinity });
    let sdkMessageCount = 0;
    let lastMessageAt: string | undefined;
    let reachedForkPoint = false;
    let pendingRunId = "";
    let copiedTerminal = false;
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        const record = safeJsonRecord(line);
        if (reachedForkPoint && isUserInputRecord(record)) {
          if (pendingRunId && !copiedTerminal) {
            await writeJsonlLine(out, completedRuntimeRecord(destThread.id, pendingRunId, lastMessageAt));
          }
          break;
        }
        if (!isRuntimeRecord(record)) {
          sdkMessageCount += 1;
          lastMessageAt = timestampFromRecord(record) || lastMessageAt;
        }
        const startedRunId = runStartedRecordId(record);
        if (startedRunId) {
          pendingRunId = startedRunId;
          copiedTerminal = false;
        }
        if (isRuntimeTerminalRecord(record)) {
          copiedTerminal = true;
          pendingRunId = "";
        }
        const rewritten = rewriteForkRecord(record, destThread.id);
        if (rewritten) await writeJsonlLine(out, rewritten);
        else await writeLine(out, line);
        if (recordUuid(record) === upToMessageUuid) reachedForkPoint = true;
        if (reachedForkPoint && isRuntimeTerminalRecord(record)) break;
      }
      await new Promise<void>((resolve) => out.end(resolve));
    } catch (error) {
      out.destroy();
      console.warn("[workspace] Failed to copy forked thread messages:", error);
    } finally {
      rl.close();
    }
    return { sdkMessageCount, lastMessageAt };
  }

  private async deleteRagChunksForCourse(semesterId: string, courseId: string): Promise<void> {
    try {
      await this.options.ragIndex.deleteChunksByCourse(semesterId, courseId);
    } catch (error) {
      console.warn(`[rag] Failed to delete chunks for course ${courseId}`, error);
      recordCleanupFailure(this.options.rootDataDir, {
        scope: "rag",
        operation: "delete_chunks_by_course",
        targetId: courseId,
        message: errorMessage(error),
      });
    }
  }

  private async deleteRagChunksForSemester(semesterId: string): Promise<void> {
    try {
      await this.options.ragIndex.deleteChunksBySemester(semesterId);
    } catch (error) {
      console.warn(`[rag] Failed to delete chunks for semester ${semesterId}`, error);
      recordCleanupFailure(this.options.rootDataDir, {
        scope: "rag",
        operation: "delete_chunks_by_semester",
        targetId: semesterId,
        message: errorMessage(error),
      });
    }
  }

  private async deleteRagChunksForTask(semesterId: string, courseId: string, taskId: string, fileIds: string[]): Promise<void> {
    try {
      await this.options.ragIndex.deleteChunksByTask(semesterId, courseId, taskId, fileIds);
    } catch (error) {
      console.warn(`[rag] Failed to delete chunks for task ${taskId}`, error);
      recordCleanupFailure(this.options.rootDataDir, {
        scope: "rag",
        operation: "delete_chunks_by_task",
        targetId: taskId,
        message: errorMessage(error),
      });
    }
  }

  private safeRm(path: string, message: string, failure?: Omit<CleanupFailure, "message">): void {
    if (!existsSync(path)) return;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      console.warn(message, error);
      if (failure) {
        recordCleanupFailure(this.options.rootDataDir, {
          ...failure,
          message: errorMessage(error),
        });
      }
    }
  }
}

const COURSE_COLOR_PALETTE = [
  "#2563eb",
  "#7c3aed",
  "#059669",
  "#dc2626",
  "#d97706",
  "#0891b2",
  "#db2777",
  "#65a30d",
];

function pickCourseColor(index: number): string {
  return COURSE_COLOR_PALETTE[index % COURSE_COLOR_PALETTE.length];
}

function entityId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function safeJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

interface ForkStoredMessageRef {
  uuid: string;
  sessionId?: string;
}

interface ForkTargetResolution {
  effectiveUpToMessageUuid: string;
  effectiveSdkSessionId?: string;
  usedSidechainFallback: boolean;
}

interface ForkTargetMessage extends ForkStoredMessageRef {
  isSidechain: boolean;
  fallbackMainline?: ForkStoredMessageRef;
}

async function findForkTargetInThreadMessages(filePath: string, upToMessageUuid: string): Promise<ForkTargetMessage | null> {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  let lastMainlineAssistant: ForkStoredMessageRef | undefined;
  let target: ForkTargetMessage | null = null;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const record = safeJsonRecord(line);
      const uuid = recordUuid(record);
      const sessionId = recordSessionId(record);
      const isMainlineAssistant = record?.type === "assistant" && Boolean(uuid) && !recordParentToolUseId(record);

      if (uuid === upToMessageUuid) {
        target = {
          uuid,
          sessionId,
          isSidechain: record?.type === "assistant" && Boolean(recordParentToolUseId(record)),
          fallbackMainline: lastMainlineAssistant,
        };
      }

      if (isMainlineAssistant && uuid) {
        lastMainlineAssistant = { uuid, sessionId };
      }
    }
  } finally {
    rl.close();
  }
  return target;
}

function isRuntimeRecord(record: Record<string, unknown> | null): boolean {
  return record?.kind === "runtime";
}

function rewriteForkRecord(record: Record<string, unknown> | null, threadId: string): Record<string, unknown> | null {
  if (!record || !isRuntimeRecord(record)) return record;
  const event = record.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return record;
  const nextEvent = { ...event as Record<string, unknown> };
  if ("threadId" in nextEvent) nextEvent.threadId = threadId;
  if (nextEvent.type === "context_usage_updated") {
    const snapshot = nextEvent.snapshot;
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      nextEvent.snapshot = { ...snapshot as Record<string, unknown>, threadId };
    }
  }
  return { ...record, event: nextEvent };
}

function runStartedRecordId(record: Record<string, unknown> | null): string {
  if (!record || record.kind !== "runtime") return "";
  const event = record.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return "";
  const type = (event as { type?: unknown }).type;
  if (type !== "run_started") return "";
  const runId = (event as { runId?: unknown }).runId;
  return typeof runId === "string" ? runId : "";
}

function isRuntimeTerminalRecord(record: Record<string, unknown> | null): boolean {
  if (!record || record.kind !== "runtime") return false;
  const event = record.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const type = (event as { type?: unknown }).type;
  return type === "run_completed" || type === "run_stopped" || type === "run_failed" || type === "run_interrupted";
}

function completedRuntimeRecord(threadId: string, runId: string, timestamp?: string): Record<string, unknown> {
  return {
    kind: "runtime",
    event: {
      type: "run_completed",
      runId,
      threadId,
      createdAt: timestamp || new Date().toISOString(),
    },
  };
}

async function writeLine(out: ReturnType<typeof createWriteStream>, line: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    out.write(`${line}\n`, (error) => error ? reject(error) : resolve());
  });
}

async function writeJsonlLine(out: ReturnType<typeof createWriteStream>, record: Record<string, unknown>): Promise<void> {
  await writeLine(out, JSON.stringify(record));
}

function isUserInputRecord(record: Record<string, unknown> | null): boolean {
  if (!record || record.type !== "user") return false;
  return !recordHasToolResult(record) && Boolean(userRecordText(record).trim());
}

function recordHasToolResult(record: Record<string, unknown>): boolean {
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return false;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "tool_result"));
}

function userRecordText(record: Record<string, unknown>): string {
  const message = record.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (!block || typeof block !== "object") return "";
    const text = (block as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("\n");
}

function recordUuid(record: Record<string, unknown> | null): string | undefined {
  const value = record?.uuid;
  return typeof value === "string" ? value : undefined;
}

function recordSessionId(record: Record<string, unknown> | null): string | undefined {
  const value = record?.session_id;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function recordParentToolUseId(record: Record<string, unknown> | null): string | undefined {
  const value = record?.parent_tool_use_id;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestampFromRecord(record: Record<string, unknown> | null): string | undefined {
  const createdAt = record?._createdAt;
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) return new Date(createdAt).toISOString();
  if (typeof createdAt === "string" && createdAt.trim()) {
    const parsed = Date.parse(createdAt);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown cleanup failure");
}
