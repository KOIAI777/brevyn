import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type {
  Course,
  FileImportInput,
  SemesterWorkspace,
  TaskFileBucket,
  TaskType,
  Thread,
  BrevynTask,
} from "../../types/domain";
import { lectureWeekFolderName, normalizedWeekNumber } from "../../shared/semester-weeks";

export const SEMESTER_HOME_COURSE_ID = "semester-home";

export const DEFAULT_TASK_TYPE = "Assignment";

const TASK_FILE_BUCKET_LABELS: Record<TaskFileBucket, string> = {
  materials: "Materials",
  drafts: "Drafts",
  submitted: "Submitted",
};

export const TASK_FILE_BUCKETS: TaskFileBucket[] = ["materials", "drafts", "submitted"];

export interface AgentProjectScaffold {
  sessionDir: string;
  sessionContextDir: string;
  sessionPlanDir: string;
  sessionPlanRelativeDir: string;
  autoMemoryDir: string;
  projectSettingsPath: string;
}

export interface AgentWorkspaceMemoryScaffold {
  autoMemoryDir: string;
  projectSettingsPath: string;
}

/**
 * Render a user-defined task type as a folder-safe label.
 * Empty / whitespace falls back to DEFAULT_TASK_TYPE.
 */
export function taskTypeLabel(taskType: TaskType): string {
  const trimmed = (taskType || "").trim();
  return trimmed ? sanitizeFsSegment(trimmed) : DEFAULT_TASK_TYPE;
}

export function taskBucketLabel(bucket: TaskFileBucket): string {
  return TASK_FILE_BUCKET_LABELS[bucket] || "Materials";
}

export function folderNameForCourse(course: Course, semester?: SemesterWorkspace): string {
  if (course.workspaceKind === "semester_home" || course.id === SEMESTER_HOME_COURSE_ID) {
    return semester?.folderName || course.term || "Semester";
  }
  return course.name || "Course";
}

export function sanitizeFsSegment(value: string): string {
  const cleaned = value.replace(/[<>:"/\\|?*\x00-\x1F]/g, "-").replace(/\s+/g, " ").trim();
  const safe = cleaned
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.\./g, "-")
    .slice(0, 200);
  return safe || "workspace";
}

export function isPathInside(targetPath: string, parentPath: string): boolean {
  try {
    const target = realpathSync(targetPath);
    const parent = realpathSync(parentPath);
    return target === parent || target.startsWith(`${parent}${sep}`);
  } catch {
    const target = resolve(targetPath);
    const parent = resolve(parentPath);
    return target === parent || target.startsWith(`${parent}${sep}`);
  }
}

export function idPathSegment(id: string): string {
  const cleaned = id.trim().replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned || "id";
}

export function semesterWorkspaceDir(rootDataDir: string, semesterId: string): string {
  return join(rootDataDir, "semesters", semesterId);
}

export function ensureSemesterWorkspaceDir(rootDataDir: string, semesterId: string): string {
  const dir = semesterWorkspaceDir(rootDataDir, semesterId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureSemesterSharedDirs(rootDataDir: string, semesterId: string): string {
  const dir = ensureSemesterWorkspaceDir(rootDataDir, semesterId);
  mkdirSync(join(dir, "Semester shared"), { recursive: true });
  mkdirSync(join(dir, "courses"), { recursive: true });
  return dir;
}

export function threadMessagesDir(rootDataDir: string, semesterId: string): string {
  return join(semesterWorkspaceDir(rootDataDir, semesterId), "threads");
}

export function ensureThreadMessagesDir(rootDataDir: string, semesterId: string): string {
  const dir = threadMessagesDir(rootDataDir, semesterId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function threadMessagesPath(rootDataDir: string, semesterId: string, threadId: string): string {
  return join(threadMessagesDir(rootDataDir, semesterId), `${idPathSegment(threadId)}.jsonl`);
}

export function courseWorkspaceDir(rootDataDir: string, semesterId: string, courseId: string): string {
  return join(semesterWorkspaceDir(rootDataDir, semesterId), "courses", courseId);
}

export function ensureCourseWorkspaceDir(rootDataDir: string, semesterId: string, courseId: string): string {
  const dir = courseWorkspaceDir(rootDataDir, semesterId, courseId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "Course shared"), { recursive: true });
  mkdirSync(join(dir, "Lecture"), { recursive: true });
  mkdirSync(join(dir, "Task"), { recursive: true });
  return dir;
}

export function taskFolderPrefix(taskId: string): string {
  return `${idPathSegment(taskId)}__`;
}

export function taskFolderName(task: BrevynTask): string {
  return `${taskFolderPrefix(task.id)}${sanitizeFsSegment(task.title)}`;
}

export function taskWorkspaceDirForTask(courseDir: string, task: BrevynTask): string {
  return join(courseDir, resolveTaskRelativeWorkspacePath(courseDir, task));
}

function resolveTaskRelativeWorkspacePath(courseDir: string, task: BrevynTask): string {
  const taskRoot = join(courseDir, "Task");
  const preferredName = taskFolderName(task);
  if (!existsSync(taskRoot)) return join("Task", preferredName);

  try {
    const prefix = taskFolderPrefix(task.id);
    const matches = readdirSync(taskRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort();
    return join("Task", matches.includes(preferredName) ? preferredName : matches[0] || preferredName);
  } catch {
    return join("Task", preferredName);
  }
}

export function ensureTaskWorkspaceDir(rootDataDir: string, semesterId: string, task: BrevynTask): string {
  const courseDir = ensureCourseWorkspaceDir(rootDataDir, semesterId, task.courseId);
  const taskDir = taskWorkspaceDirForTask(courseDir, task);
  mkdirSync(taskDir, { recursive: true });
  for (const bucket of TASK_FILE_BUCKETS) {
    mkdirSync(join(taskDir, taskBucketLabel(bucket)), { recursive: true });
  }
  return taskDir;
}

/**
 * Resolve the agent workspace cwd for a given thread.
 *
 * - semester-home thread → Semester shared (course discovery must go through Brevyn metadata)
 * - task thread          → the specific task directory
 */
export function workspacePathForThread(
  rootDataDir: string,
  thread: Thread,
  resolveTask: (taskId: string) => BrevynTask | undefined,
): string {
  const semesterId = thread.semesterId;
  if (!semesterId) {
    throw new Error(`Cannot resolve workspace path: thread ${thread.id} has no semesterId`);
  }
  if (thread.threadType === "semester_home" || thread.courseId === SEMESTER_HOME_COURSE_ID) {
    return join(ensureSemesterSharedDirs(rootDataDir, semesterId), "Semester shared");
  }
  if (thread.taskId) {
    const task = resolveTask(thread.taskId);
    if (!task) {
      throw new Error(`Cannot resolve workspace path: thread ${thread.id} references missing task ${thread.taskId}`);
    }
    if (task.courseId !== thread.courseId) {
      throw new Error(`Cannot resolve workspace path: thread ${thread.id} task does not belong to course ${thread.courseId}`);
    }
    if (!task.semesterId || task.semesterId !== semesterId) {
      throw new Error(`Cannot resolve workspace path: thread ${thread.id} task does not belong to semester ${semesterId}`);
    }
    return ensureTaskWorkspaceDir(rootDataDir, semesterId, task);
  }
  throw new Error(`Cannot resolve workspace path: thread ${thread.id} is not bound to a task`);
}

export function threadSessionDirForThread(
  rootDataDir: string,
  thread: Thread,
  resolveTask: (taskId: string) => BrevynTask | undefined,
): string {
  return join(workspacePathForThread(rootDataDir, thread, resolveTask), ".brevyn", "sessions", idPathSegment(thread.id));
}

export function ensureThreadSessionDir(
  rootDataDir: string,
  thread: Thread,
  resolveTask: (taskId: string) => BrevynTask | undefined,
): string {
  const dir = threadSessionDirForThread(rootDataDir, thread, resolveTask);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureAgentProjectScaffold(cwd: string, threadId: string): AgentProjectScaffold {
  const sessionDir = join(cwd, ".brevyn", "sessions", idPathSegment(threadId));
  const sessionContextDir = join(sessionDir, ".context");
  const sessionPlanDir = join(sessionContextDir, "plan");
  mkdirSync(sessionPlanDir, { recursive: true });
  const sessionPlanRelativeDir = relative(cwd, sessionPlanDir).split(sep).join("/");
  const memoryScaffold = ensureAgentWorkspaceMemoryScaffold(cwd);

  return {
    sessionDir,
    sessionContextDir,
    sessionPlanDir,
    sessionPlanRelativeDir,
    autoMemoryDir: memoryScaffold.autoMemoryDir,
    projectSettingsPath: memoryScaffold.projectSettingsPath,
  };
}

export function ensureAgentWorkspaceMemoryScaffold(cwd: string): AgentWorkspaceMemoryScaffold {
  const projectSettingsDir = join(cwd, ".claude");
  const autoMemoryDir = join(projectSettingsDir, "memory");
  const projectSettingsPath = join(projectSettingsDir, "settings.json");
  mkdirSync(autoMemoryDir, { recursive: true });

  const existingSettings = readJsonObject(projectSettingsPath);
  writeFileSync(projectSettingsPath, `${JSON.stringify({
    ...existingSettings,
    autoMemoryEnabled: true,
    autoMemoryDirectory: autoMemoryDir,
    skipWebFetchPreflight: true,
  }, null, 2)}\n`, "utf8");

  return {
    autoMemoryDir,
    projectSettingsPath,
  };
}

function readJsonObject(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected a JSON object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid Claude project settings at ${filePath}: ${reason}`);
  }
}

export function ensureImportTargetDir(
  rootDataDir: string,
  semesterId: string,
  input: FileImportInput,
  resolveTask: (taskId: string) => BrevynTask | undefined,
): string {
  if (input.courseId === SEMESTER_HOME_COURSE_ID) {
    const dir = join(ensureSemesterWorkspaceDir(rootDataDir, semesterId), "Semester shared");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  const courseDir = ensureCourseWorkspaceDir(rootDataDir, semesterId, input.courseId);
  if (input.targetSection === "course_shared") {
    const dir = join(courseDir, "Course shared");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  if (input.targetSection === "lecture") {
    const weekNumber = normalizedWeekNumber(input.weekNumber);
    const dir = weekNumber ? join(courseDir, "Lecture", lectureWeekFolderName(weekNumber)) : join(courseDir, "Lecture");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  const task = input.taskId ? resolveTask(input.taskId) : undefined;
  if (!task) {
    throw new Error("Select a task before importing into a task workspace.");
  }
  const taskDir = taskWorkspaceDirForTask(courseDir, task);
  const bucketDir = join(taskDir, taskBucketLabel(input.taskFileBucket || "materials"));
  mkdirSync(bucketDir, { recursive: true });
  return bucketDir;
}
