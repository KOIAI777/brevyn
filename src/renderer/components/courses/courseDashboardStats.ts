import type { BrevynTask, Course, FileStats, Thread, WorkspaceFileNode } from "@/types/domain";

const DEFAULT_ACTIVITY_WEEK_COUNT = 16;
const MAX_ACTIVITY_WEEK_COUNT = 30;

export type TaskCard = {
  task: BrevynTask;
  fileCount: number;
  threadCount: number;
  lastTouchedTime: number;
  sortTime: number;
  lastTouchedLabel: string;
};

export type ActivityDay = {
  dateKey: string;
  label: string;
  weekdayLabel: string;
  monthLabel: string;
  shortMonthLabel: string;
  fileEvents: number;
  sessionEvents: number;
  score: number;
};

export type ActivityWeek = {
  id: string;
  label: string;
  weekLabel: string;
  monthLabel: string;
  shortMonthLabel: string;
  days: ActivityDay[];
};

export type LectureWeek = {
  id: string;
  label: string;
  files: WorkspaceFileNode[];
  indexedCount: number;
  latestTime: number;
  latestLabel: string;
};

export type CourseCard = {
  course: Course;
  taskCount: number;
  fileCount: number;
  threadCount: number;
  lastActivityTime: number;
  lastActivityLabel: string;
};

export type RecentTaskCard = {
  task: BrevynTask;
  courseId: string;
  courseName: string;
  fileCount: number;
  threadCount: number;
  lastTouchedTime: number;
  lastTouchedLabel: string;
};

export type CourseDashboardStats = {
  courseThreads: Thread[];
  courseFiles: WorkspaceFileNode[];
  taskCards: TaskCard[];
  recentTask?: TaskCard;
  activityDays: ActivityDay[];
  activityScore: number;
  draftFiles: WorkspaceFileNode[];
  lectureFiles: WorkspaceFileNode[];
  lectureWeeks: LectureWeek[];
  filesTouchedThisWeek: number;
  activeTasks: number;
  courseFileCount: number;
  sectionCount: number;
  threadsWithMessages: number;
  taskMaterialCount: number;
  submittedCount: number;
};

export type SemesterDashboardStats = {
  visibleCourses: Course[];
  semesterThreads: Thread[];
  semesterFiles: WorkspaceFileNode[];
  allTasks: BrevynTask[];
  activityDays: ActivityDay[];
  activityScore: number;
  courseCards: CourseCard[];
  recentTask: RecentTaskCard | null;
  homeThread?: Thread;
  quietCourses: number;
  emptyCourseCount: number;
  fileCount: number;
  threadsWithMessages: number;
  lectureFileCount: number;
};

export function buildCourseDashboardStats({
  activityWeekCount,
  course,
  tasks,
  threads,
  files,
  stats,
}: {
  activityWeekCount?: number;
  course: Course;
  tasks: BrevynTask[];
  threads: Thread[];
  files: WorkspaceFileNode[];
  stats?: FileStats | null;
}): CourseDashboardStats {
  const courseThreads = threads.filter((thread) => thread.courseId === course.id && !thread.archivedAt);
  const courseFiles = flattenFiles(files);
  const taskCards = buildTaskCards(tasks, courseThreads, courseFiles);
  const activityDays = buildActivityDays(courseThreads, courseFiles, activityWeekCount);
  const draftFiles = courseFiles.filter(isDraftFile);
  const lectureFiles = courseFiles.filter((file) => file.sectionKind === "lecture");
  return {
    courseThreads,
    courseFiles,
    taskCards,
    recentTask: taskCards[0],
    activityDays,
    activityScore: sumActivityScore(activityDays),
    draftFiles,
    lectureFiles,
    lectureWeeks: buildLectureWeeks(lectureFiles),
    filesTouchedThisWeek: courseFiles.filter((file) => isWithinDays(file.updatedAt, 7)).length,
    activeTasks: taskCards.filter((task) => task.threadCount > 0 || task.fileCount > 0).length,
    courseFileCount: stats?.totalFiles ?? courseFiles.length,
    sectionCount: stats?.sectionCount ?? 0,
    threadsWithMessages: courseThreads.filter((thread) => !thread.isDraft).length,
    taskMaterialCount: countSectionFiles(courseFiles, "materials"),
    submittedCount: countSectionFiles(courseFiles, "submitted"),
  };
}

export function buildSemesterDashboardStats({
  activityWeekCount,
  homeCourse,
  courses,
  tasksByCourse,
  threads,
  files,
  stats,
}: {
  activityWeekCount?: number;
  homeCourse?: Course;
  courses: Course[];
  tasksByCourse: Record<string, BrevynTask[]>;
  threads: Thread[];
  files: WorkspaceFileNode[];
  stats?: FileStats | null;
}): SemesterDashboardStats {
  const visibleCourses = courses.filter((course) => course.workspaceKind !== "semester_home" && !course.archivedAt);
  const semesterThreads = threads.filter((thread) => !thread.archivedAt);
  const semesterFiles = flattenFiles(files);
  const allTasks = visibleCourses.flatMap((course) => tasksByCourse[course.id] || []);
  const activityDays = buildActivityDays(semesterThreads, semesterFiles, activityWeekCount);
  const courseCards = buildCourseCards(visibleCourses, tasksByCourse, semesterThreads, semesterFiles);
  const homeThread = [...semesterThreads]
    .filter((thread) => thread.courseId === homeCourse?.id && !thread.taskId)
    .sort((a, b) => safeTime(b.updatedAt) - safeTime(a.updatedAt))[0];
  return {
    visibleCourses,
    semesterThreads,
    semesterFiles,
    allTasks,
    activityDays,
    activityScore: sumActivityScore(activityDays),
    courseCards,
    recentTask: buildRecentTaskCard(allTasks, visibleCourses, semesterThreads, semesterFiles),
    homeThread,
    quietCourses: courseCards.filter((course) => !course.lastActivityTime || isOlderThanDays(course.lastActivityTime, 7)).length,
    emptyCourseCount: courseCards.filter((course) => course.fileCount === 0).length,
    fileCount: stats?.totalFiles ?? semesterFiles.length,
    threadsWithMessages: semesterThreads.filter((thread) => !thread.isDraft).length,
    lectureFileCount: semesterFiles.filter((file) => file.sectionKind === "lecture").length,
  };
}

export function buildActivityWeeks(days: ActivityDay[]): ActivityWeek[] {
  const weeks: ActivityWeek[] = [];
  for (let index = 0; index < days.length; index += 7) {
    const weekDays = days.slice(index, index + 7);
    if (weekDays.length === 0) continue;
    weeks.push({
      id: weekDays[0].dateKey,
      label: index + 7 >= days.length ? "本周" : `第 ${Math.floor(index / 7) + 1} 周`,
      weekLabel: `${Math.floor(index / 7) + 1}`,
      monthLabel: weekDays[0].monthLabel,
      shortMonthLabel: weekDays[0].shortMonthLabel,
      days: weekDays,
    });
  }
  return weeks;
}

export function buildActivityDays(threads: Thread[], files: WorkspaceFileNode[], weekCount = DEFAULT_ACTIVITY_WEEK_COUNT): ActivityDay[] {
  const days = lastNDays(normalizeActivityWeekCount(weekCount) * 7);
  const byDay = new Map(days.map((day) => [day.dateKey, { ...day, fileEvents: 0, sessionEvents: 0, score: 0 }]));
  for (const file of files) {
    const score = fileActivityScore(file);
    if (score <= 0) continue;
    const key = dateKey(file.updatedAt);
    const day = byDay.get(key);
    if (!day) continue;
    day.fileEvents += 1;
    day.score += score;
  }
  for (const thread of threads) {
    const score = threadActivityScore(thread);
    if (score <= 0) continue;
    const key = dateKey(thread.lastMessageAt || thread.updatedAt);
    const day = byDay.get(key);
    if (!day) continue;
    day.sessionEvents += 1;
    day.score += score;
  }
  return days.map((day) => byDay.get(day.dateKey) || day);
}

function normalizeActivityWeekCount(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_ACTIVITY_WEEK_COUNT;
  return Math.min(MAX_ACTIVITY_WEEK_COUNT, Math.max(1, Math.round(value)));
}

export function flattenFiles(nodes: WorkspaceFileNode[]): WorkspaceFileNode[] {
  const result: WorkspaceFileNode[] = [];
  for (const node of nodes) {
    if (node.kind !== "folder") result.push(node);
    if (node.children) result.push(...flattenFiles(node.children));
  }
  return result;
}

export function formatRelativeZh(value: string): string {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) return "";
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function buildTaskCards(tasks: BrevynTask[], threads: Thread[], files: WorkspaceFileNode[]): TaskCard[] {
  return tasks
    .map((task) => {
      const taskThreads = threads.filter((thread) => thread.taskId === task.id);
      const taskFiles = files.filter((file) => file.taskId === task.id);
      const latestThread = [...taskThreads].sort((a, b) => safeTime(b.updatedAt) - safeTime(a.updatedAt))[0];
      const latestFileTime = Math.max(0, ...taskFiles.map((file) => safeTime(file.updatedAt)));
      const dueTime = task.dueAt ? safeTime(task.dueAt) : 0;
      const lastTouchedTime = Math.max(safeTime(latestThread?.updatedAt), latestFileTime);
      return {
        task,
        fileCount: taskFiles.length,
        threadCount: taskThreads.length,
        lastTouchedTime,
        sortTime: lastTouchedTime || dueTime,
        lastTouchedLabel: lastTouchedTime > 0 ? formatRelativeZh(new Date(lastTouchedTime).toISOString()) : dueTime > 0 ? `截止 ${formatShortDate(task.dueAt || "")}` : "未开始",
      };
    })
    .sort((a, b) => b.sortTime - a.sortTime || a.task.title.localeCompare(b.task.title));
}

function buildLectureWeeks(files: WorkspaceFileNode[]): LectureWeek[] {
  const groups = new Map<string, WorkspaceFileNode[]>();
  for (const file of files) {
    const key = typeof file.weekNumber === "number" ? `week-${file.weekNumber}` : "unsorted";
    groups.set(key, [...(groups.get(key) || []), file]);
  }
  return Array.from(groups.entries())
    .map(([id, groupFiles]) => {
      const weekNumber = id.startsWith("week-") ? Number(id.replace("week-", "")) : null;
      const latestTime = Math.max(0, ...groupFiles.map((file) => safeTime(file.updatedAt)));
      return {
        id,
        label: typeof weekNumber === "number" && Number.isFinite(weekNumber) ? `第 ${weekNumber} 周` : "未分周课件",
        files: groupFiles,
        indexedCount: groupFiles.filter((file) => file.indexedAt || file.indexingStatus === "indexed" || file.indexingStatus === "partial").length,
        latestTime,
        latestLabel: latestTime > 0 ? formatRelativeZh(new Date(latestTime).toISOString()) : "暂无活动",
      };
    })
    .sort((a, b) => lectureWeekSortValue(a.id) - lectureWeekSortValue(b.id));
}

function buildCourseCards(courses: Course[], tasksByCourse: Record<string, BrevynTask[]>, threads: Thread[], files: WorkspaceFileNode[]): CourseCard[] {
  return courses
    .map((course) => {
      const courseTasks = tasksByCourse[course.id] || [];
      const courseThreads = threads.filter((thread) => thread.courseId === course.id);
      const courseFiles = files.filter((file) => file.courseId === course.id);
      const lastActivityTime = Math.max(
        0,
        ...courseThreads.map((thread) => safeTime(thread.updatedAt)),
        ...courseFiles.map((file) => safeTime(file.updatedAt)),
      );
      return {
        course,
        taskCount: courseTasks.length,
        fileCount: courseFiles.length,
        threadCount: courseThreads.length,
        lastActivityTime,
        lastActivityLabel: lastActivityTime > 0 ? formatRelativeZh(new Date(lastActivityTime).toISOString()) : "暂无活动",
      };
    })
    .sort((a, b) => b.lastActivityTime - a.lastActivityTime || a.course.name.localeCompare(b.course.name));
}

function buildRecentTaskCard(tasks: BrevynTask[], courses: Course[], threads: Thread[], files: WorkspaceFileNode[]): RecentTaskCard | null {
  const courseNameById = new Map(courses.map((course) => [course.id, course.name]));
  const cards = tasks
    .map((task) => {
      const taskThreads = threads.filter((thread) => thread.taskId === task.id);
      const taskFiles = files.filter((file) => file.taskId === task.id);
      const lastTouchedTime = Math.max(
        0,
        ...taskThreads.map((thread) => safeTime(thread.updatedAt)),
        ...taskFiles.map((file) => safeTime(file.updatedAt)),
      );
      return {
        task,
        courseId: task.courseId,
        courseName: courseNameById.get(task.courseId) || "未知课程",
        fileCount: taskFiles.length,
        threadCount: taskThreads.length,
        lastTouchedTime,
        lastTouchedLabel: lastTouchedTime > 0 ? formatRelativeZh(new Date(lastTouchedTime).toISOString()) : "暂无活动",
      };
    })
    .filter((task) => task.lastTouchedTime > 0)
    .sort((a, b) => b.lastTouchedTime - a.lastTouchedTime);
  return cards[0] || null;
}

function lastNDays(count: number): ActivityDay[] {
  const today = startOfLocalDay(new Date());
  const currentWeekStart = startOfWeek(today);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(currentWeekStart);
    date.setDate(currentWeekStart.getDate() - (count - 7) + index);
    return {
      dateKey: dateKey(date.toISOString()),
      label: formatShortDate(date.toISOString()),
      weekdayLabel: formatWeekdayZh(date),
      monthLabel: `${date.getMonth() + 1}月`,
      shortMonthLabel: `${date.getMonth() + 1}`,
      fileEvents: 0,
      sessionEvents: 0,
      score: 0,
    };
  });
}

function countSectionFiles(files: WorkspaceFileNode[], bucket: "materials" | "drafts" | "submitted"): number {
  return files.filter((file) => file.taskFileBucket === bucket || file.path.toLowerCase().includes(`/${bucket}/`)).length;
}

function isDraftFile(file: WorkspaceFileNode): boolean {
  return file.taskFileBucket === "drafts" || file.path.toLowerCase().includes("/drafts/");
}

function isSubmittedFile(file: WorkspaceFileNode): boolean {
  return file.taskFileBucket === "submitted" || file.path.toLowerCase().includes("/submitted/");
}

function isMaterialFile(file: WorkspaceFileNode): boolean {
  return file.taskFileBucket === "materials" || file.path.toLowerCase().includes("/materials/");
}

function fileActivityScore(file: WorkspaceFileNode): number {
  if (file.sourceKind === "system") return 0;
  if (isSubmittedFile(file)) return 4;
  if (isDraftFile(file)) return 3;
  if (isMaterialFile(file) || file.sectionKind === "lecture" || file.sectionKind === "course_shared") return 1;
  if (file.sourceKind === "agent_generated") return 2;
  return 1;
}

function threadActivityScore(thread: Thread): number {
  const messageCount = thread.messageCount ?? 0;
  if (messageCount <= 0) return 0;
  return thread.isDraft ? 1 : 2;
}

function isWithinDays(value: string, days: number): boolean {
  const time = safeTime(value);
  if (!time) return false;
  return Date.now() - time <= days * 24 * 60 * 60 * 1000;
}

function sumActivityScore(days: ActivityDay[]): number {
  return days.reduce((sum, day) => sum + day.score, 0);
}

function isOlderThanDays(timestamp: number, days: number): boolean {
  return Date.now() - timestamp > days * 24 * 60 * 60 * 1000;
}

function dateKey(value: string): string {
  const date = startOfLocalDay(new Date(value));
  if (!Number.isFinite(date.getTime())) return "";
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfWeek(date: Date): Date {
  const result = startOfLocalDay(date);
  const day = result.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  result.setDate(result.getDate() + mondayOffset);
  return result;
}

function safeTime(value?: string): number {
  const time = value ? Date.parse(value) : 0;
  return Number.isFinite(time) ? time : 0;
}

function formatShortDate(value: string): string {
  const time = safeTime(value);
  if (!time) return "";
  return new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function lectureWeekSortValue(id: string): number {
  if (id === "unsorted") return Number.MAX_SAFE_INTEGER;
  const value = Number(id.replace("week-", ""));
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function formatWeekdayZh(date: Date): string {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()] || "";
}
