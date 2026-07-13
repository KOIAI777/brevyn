import type { Course, SemesterWorkspace, BrevynTask } from "../../types/domain";
import type { SQLiteBusinessStore } from "../storage";
import { SEMESTER_HOME_COURSE_ID } from "./workspace-paths";

export function currentActiveSemester(businessStore: SQLiteBusinessStore): SemesterWorkspace | null {
  const currentId = businessStore.currentSemesterId() || "";
  if (!currentId) return null;
  const current = businessStore.getSemester(currentId);
  return current && !current.archivedAt ? current : null;
}

export function currentActiveSemesterId(businessStore: SQLiteBusinessStore): string {
  return currentActiveSemester(businessStore)?.id || "";
}

export function isSemesterArchived(businessStore: SQLiteBusinessStore, semesterId?: string): boolean {
  if (!semesterId) return false;
  return Boolean(businessStore.getSemester(semesterId)?.archivedAt);
}

export function isCurrentSemesterArchived(businessStore: SQLiteBusinessStore): boolean {
  const semesterId = businessStore.currentSemesterId() || "";
  return isSemesterArchived(businessStore, semesterId);
}

export function isCourseArchived(businessStore: SQLiteBusinessStore, courseId: string): boolean {
  if (courseId === SEMESTER_HOME_COURSE_ID) return isCurrentSemesterArchived(businessStore);
  const course = businessStore.getCourse(courseId);
  if (!course) return false;
  return Boolean(course.archivedAt || isSemesterArchived(businessStore, course.semesterId));
}

export function archivedCourseIdsForSemester(businessStore: SQLiteBusinessStore, semesterId: string): string[] {
  if (!semesterId) return [];
  return businessStore.listCourses(semesterId)
    .filter((course) => Boolean(course.archivedAt))
    .map((course) => course.id);
}

export function activeCourseOrThrow(businessStore: SQLiteBusinessStore, courseId: string): Course {
  const course = businessStore.getCourse(courseId);
  if (!course) throw new Error(`Course not found: ${courseId}`);
  if (course.archivedAt || isSemesterArchived(businessStore, course.semesterId)) {
    throw new Error("Restore this course before using it.");
  }
  return course;
}

export function activeCourseScopeOrThrow(businessStore: SQLiteBusinessStore, courseId: string, semesterId: string): Course | null {
  if (!semesterId) throw new Error("请先选择学期，再使用课程。");
  if (courseId === SEMESTER_HOME_COURSE_ID) {
    if (isSemesterArchived(businessStore, semesterId)) throw new Error("Restore this semester before using the home workspace.");
    return null;
  }
  return activeCourseInSemesterOrThrow(businessStore, courseId, semesterId);
}

export function activeCourseInSemesterOrThrow(businessStore: SQLiteBusinessStore, courseId: string, semesterId: string): Course {
  if (!semesterId) throw new Error("请先选择学期，再使用课程。");
  const course = businessStore.getCourse(courseId);
  if (!course) throw new Error(`Course not found: ${courseId}`);
  if (course.semesterId !== semesterId) throw new Error("Course does not belong to the current semester.");
  if (course.archivedAt || isSemesterArchived(businessStore, course.semesterId)) {
    throw new Error("Restore this course before using it.");
  }
  return course;
}

export function taskInCourseOrThrow(businessStore: SQLiteBusinessStore, taskId: string | undefined, courseId: string, semesterId: string): BrevynTask {
  if (!taskId) throw new Error("请先选择任务，再使用任务工作区。");
  const task = businessStore.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  if (task.courseId !== courseId) throw new Error("Task does not belong to this course.");
  if (!task.semesterId || task.semesterId !== semesterId) throw new Error("Task does not belong to the current semester.");
  if (task.archivedAt) throw new Error("Restore this task before using it.");
  return task;
}
