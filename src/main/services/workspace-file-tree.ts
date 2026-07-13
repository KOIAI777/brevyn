import { extname } from "node:path";
import type {
  Course,
  FileImportInput,
  SemesterWorkspace,
  TaskType,
  BrevynTask,
  WorkspaceFileNode,
} from "../../types/domain";
import { lectureWeekFolderName, normalizedWeekNumber } from "../../shared/semester-weeks";
import {
  DEFAULT_TASK_TYPE,
  SEMESTER_HOME_COURSE_ID,
  TASK_FILE_BUCKETS,
  folderNameForCourse,
  sanitizeFsSegment,
  taskBucketLabel,
  taskFolderName,
  taskFolderPrefix,
} from "./workspace-paths";

export function cloneFile(file: WorkspaceFileNode): WorkspaceFileNode {
  return {
    ...file,
    children: file.children ? cloneFiles(file.children) : undefined,
  };
}

export function cloneFiles(files: WorkspaceFileNode[]): WorkspaceFileNode[] {
  return files.map((file) => cloneFile(file));
}

export function flattenFiles(files: WorkspaceFileNode[]): WorkspaceFileNode[] {
  return files.flatMap((file) => (file.kind === "folder" ? flattenFiles(file.children || []) : [file]));
}

export function removeFileFromTree(files: WorkspaceFileNode[], fileId: string): boolean {
  for (const file of files) {
    if (!file.children) continue;
    const index = file.children.findIndex((child) => child.id === fileId);
    if (index >= 0) {
      file.children.splice(index, 1);
      return true;
    }
    if (removeFileFromTree(file.children, fileId)) return true;
  }
  return false;
}

export function removeTaskFromTree(files: WorkspaceFileNode[], taskId: string): boolean {
  let changed = false;
  for (let index = files.length - 1; index >= 0; index--) {
    const file = files[index];
    if (file.taskId === taskId) {
      files.splice(index, 1);
      changed = true;
      continue;
    }
    if (!file.children || file.children.length === 0) continue;
    if (removeTaskFromTree(file.children, taskId)) changed = true;
    if (file.sectionKind === "task" && !file.taskId && file.children.length === 0) {
      files.splice(index, 1);
      changed = true;
    }
  }
  return changed;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function kindForPath(filePath: string): WorkspaceFileNode["kind"] {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx" || ext === ".doc") return "docx";
  if (ext === ".pptx" || ext === ".ppt") return "pptx";
  if ([".xlsx", ".xls", ".csv", ".tsv"].includes(ext)) return "spreadsheet";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(ext)) return "image";
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".cpp", ".c", ".h", ".css", ".html", ".json"].includes(ext)) return "code";
  if ([".txt", ".rtf"].includes(ext)) return "text";
  return "unknown";
}

export function semesterHomeCourse(semester?: SemesterWorkspace | null): Course {
  return {
    id: SEMESTER_HOME_COURSE_ID,
    semesterId: semester?.id,
    name: "学期总览",
    code: semester?.semesterNo || "SEMESTER",
    term: semester?.term || "Spring 2026",
    instructor: "学期工作区",
    workspaceKind: "semester_home",
    color: "#111827",
    description: "学期级工作区，可查看所有课程文件，并把工作分流到课程或任务空间。",
  };
}

export function normalizeCourses(courses: Course[], semester?: SemesterWorkspace | null): Course[] {
  const realCourses = courses
    .filter((course) => course.id !== SEMESTER_HOME_COURSE_ID)
    .filter((course) => !semester?.id || course.semesterId === semester.id)
    .map((course) => ({ ...course, semesterId: course.semesterId || semester?.id, workspaceKind: course.workspaceKind || "course" }));
  if (!semester) return realCourses;
  const home = semesterHomeCourse(semester);
  return [{ ...home, code: semester.semesterNo || home.code, term: semester.term || home.term, workspaceKind: "semester_home" }, ...realCourses];
}

export function ensureCourseFolderInTree({
  roots,
  courseId,
  semester,
  course,
  tasks,
  timestamp,
}: {
  roots: WorkspaceFileNode[];
  courseId: string;
  semester?: SemesterWorkspace | null;
  course?: Course | null;
  tasks?: BrevynTask[];
  timestamp: string;
}): WorkspaceFileNode {
  const effectiveCourse = courseId === SEMESTER_HOME_COURSE_ID ? semesterHomeCourse(semester) : course;
  const semesterId = semester?.id || effectiveCourse?.semesterId || "";
  const folderName = effectiveCourse ? folderNameForCourse(effectiveCourse, semester || undefined) : "Course";
  let root = roots.find((file) => file.courseId === courseId && file.semesterId === semesterId && file.kind === "folder");
  if (!root) {
    root = {
      id: `folder-${semesterId}-${courseId}`,
      semesterId,
      courseId,
      name: folderName,
      path: folderName,
      kind: "folder",
      updatedAt: timestamp,
      children: [],
    };
    roots.push(root);
  }
  root.name = folderName;
  root.path = folderName;
  root.children ||= [];
  if (courseId === SEMESTER_HOME_COURSE_ID) {
    ensureFolderPath(root, [{ name: "Semester shared", extra: { sectionKind: "course_shared" } }], timestamp);
  } else {
    ensureFolderPath(root, [{ name: "Course shared", extra: { sectionKind: "course_shared" } }], timestamp);
    ensureFolderPath(root, [{ name: "Lecture", extra: { sectionKind: "lecture" } }], timestamp);
    for (const task of tasks || []) {
      const taskFolder = ensureTaskWorkspace(root, task, timestamp);
      ensureTaskBucketFolders(taskFolder, courseId, task.id, task.taskType, timestamp);
    }
  }
  rebaseChildPaths(root);
  return root;
}

export function ensureTargetFolderInTree(root: WorkspaceFileNode, input: FileImportInput, task: BrevynTask | undefined, timestamp: string): WorkspaceFileNode {
  if (root.courseId === SEMESTER_HOME_COURSE_ID) {
    return ensureFolderPath(root, [{ name: "Semester shared", extra: { sectionKind: "course_shared" } }], timestamp);
  }
  if (input.targetSection === "course_shared") {
    return ensureFolderPath(root, [{ name: "Course shared", extra: { sectionKind: "course_shared" } }], timestamp);
  }
  if (input.targetSection === "lecture") {
    const lectureFolder = ensureFolderPath(root, [{ name: "Lecture", extra: { sectionKind: "lecture" } }], timestamp);
    const weekNumber = normalizedWeekNumber(input.weekNumber);
    if (!weekNumber) return lectureFolder;
    return ensureFolderChild(
      lectureFolder,
      lectureWeekFolderName(weekNumber),
      { courseId: input.courseId, sectionKind: "lecture", weekNumber },
      timestamp,
    );
  }

  if (!task) throw new Error("请先选择任务，再导入到任务工作区。");
  const taskType = task.taskType || DEFAULT_TASK_TYPE;
  const taskFolder = ensureTaskWorkspace(root, task, timestamp);
  ensureTaskBucketFolders(taskFolder, input.courseId, input.taskId, taskType, timestamp);
  return ensureFolderChild(
    taskFolder,
    taskBucketLabel(input.taskFileBucket || "materials"),
    {
      courseId: input.courseId,
      taskId: input.taskId,
      taskType,
      taskFileBucket: input.taskFileBucket || "materials",
      sectionKind: "task",
    },
    timestamp,
  );
}

function ensureTaskWorkspace(root: WorkspaceFileNode, task: BrevynTask, timestamp: string): WorkspaceFileNode {
  const taskRoot = ensureFolderPath(root, [{ name: "Task", extra: { sectionKind: "task" } }], timestamp);
  return ensureFolderChild(
    taskRoot,
    resolveTaskFolderName(taskRoot, task),
    { sectionKind: "task", taskId: task.id, taskType: task.taskType, displayName: task.title },
    timestamp,
  );
}

function resolveTaskFolderName(taskRoot: WorkspaceFileNode, task: BrevynTask): string {
  const preferredName = taskFolderName(task);
  const prefix = taskFolderPrefix(task.id);
  const existingNames = (taskRoot.children || [])
    .filter((child) => child.kind === "folder" && child.name.startsWith(prefix))
    .map((child) => child.name)
    .sort();
  return existingNames.includes(preferredName) ? preferredName : existingNames[0] || preferredName;
}

function ensureTaskBucketFolders(
  taskFolder: WorkspaceFileNode,
  courseId: string,
  taskId: string | undefined,
  taskType: TaskType,
  timestamp: string,
): void {
  TASK_FILE_BUCKETS.forEach((bucket) => {
    ensureFolderChild(
      taskFolder,
      taskBucketLabel(bucket),
      {
        courseId,
        taskId,
        taskType,
        taskFileBucket: bucket,
        sectionKind: "task",
      },
      timestamp,
    );
  });
}

type FolderSegment = {
  name: string;
  extra?: Partial<WorkspaceFileNode>;
};

function ensureFolderPath(root: WorkspaceFileNode, segments: FolderSegment[], timestamp: string): WorkspaceFileNode {
  return segments.reduce((parent, segment) => ensureFolderChild(parent, segment.name, segment.extra || {}, timestamp), root);
}

export function ensureFolderChild(
  parent: WorkspaceFileNode,
  name: string,
  extra: Partial<WorkspaceFileNode> = {},
  timestamp: string,
): WorkspaceFileNode {
  parent.children ||= [];
  let child = parent.children.find((item) => item.kind === "folder" && item.name === name);
  if (!child) {
    child = {
      id: `folder-${parent.id}-${slugify(name)}`,
      semesterId: parent.semesterId,
      courseId: parent.courseId,
      name,
      path: `${parent.path}/${name}`,
      kind: "folder",
      updatedAt: timestamp,
      children: [],
    };
    parent.children.push(child);
  }
  child.semesterId = extra.semesterId || parent.semesterId;
  child.courseId = extra.courseId || parent.courseId;
  child.name = name;
  child.path = `${parent.path}/${name}`;
  child.kind = "folder";
  child.updatedAt ||= timestamp;
  child.children ||= [];
  Object.assign(child, withoutUndefined(extra));
  rebaseChildPaths(child);
  return child;
}

function rebaseChildPaths(folder: WorkspaceFileNode): void {
  for (const child of folder.children || []) {
    child.path = `${folder.path}/${child.name}`;
    if (child.kind === "folder") rebaseChildPaths(child);
  }
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function slugify(value: string): string {
  return sanitizeFsSegment(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "folder";
}
