import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import type {
  Course,
  CourseFileSectionKind,
  ExternalSource,
  ExternalSourceStatus,
  IndexingJob,
  SemesterWorkspace,
  TaskStatus,
  TaskType,
  Thread,
  TimetableEvent,
  TimetableEventKind,
  TimetableEventSource,
  UpdateTaskInput,
  BrevynTask,
  FileIndexingStatus,
  SourceCandidate,
  SourceCandidateStatus,
  WorkspaceFileKind,
  WorkspaceFileNode,
} from "../../types/domain";
import type { IndexingTaskInsert, IndexingTaskRecord, IndexingWorkerResult } from "../indexing";
import { DEFAULT_TASK_TYPE, SEMESTER_HOME_COURSE_ID } from "../services/workspace-paths";

type SQLiteStatementSync = {
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
  run: (...params: unknown[]) => unknown;
};

type SQLiteDatabaseSync = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SQLiteStatementSync;
};

type SQLiteModule = {
  DatabaseSync: new (path: string) => SQLiteDatabaseSync;
};

export interface BusinessStoreStatus {
  dbPath: string;
  schemaVersion: number;
}

type Row = Record<string, unknown>;
type IndexingTaskLease = { workerId: string; lockedUntil?: string };

export interface RagTextIndexChunk {
  id: string;
  semesterId: string;
  courseId: string;
  sectionId: string;
  fileId: string;
  taskId?: string;
  fileName: string;
  filePath: string;
  sourcePath: string;
  kind: WorkspaceFileKind;
  weekNumber: number;
  taskFileBucket: string;
  chunkIndex: number;
  chunkCount: number;
  title: string;
  citation: string;
  text: string;
  parser: string;
  coverageStatus: string;
  ocrApplied: boolean;
  sourceLabel: string;
  sectionType: string;
  sectionTitle: string;
  sectionIndex: number;
  chunkInSection: number;
  chunksInSection: number;
  artifactId?: string;
  semanticUnitId?: string;
  elementIds?: string;
  page?: number;
  slide?: number;
  sheet?: string;
  range?: string;
  bbox?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RagTextSearchInput {
  query: string;
  semesterId: string;
  courseId?: string;
  taskId?: string;
  sectionKind?: CourseFileSectionKind;
  limit?: number;
}

export interface RagTextSearchResult {
  id: string;
  semesterId: string;
  courseId: string;
  sectionId: string;
  fileId: string;
  taskId?: string;
  fileName: string;
  filePath: string;
  sourcePath?: string;
  title: string;
  citation: string;
  text: string;
  chunkIndex?: number;
  chunkCount?: number;
  sourceLabel?: string;
  sectionType?: string;
  sectionTitle?: string;
  artifactId?: string;
  semanticUnitId?: string;
  elementIds?: string[];
  page?: number;
  slide?: number;
  sheet?: string;
  range?: string;
  bbox?: string;
  rank: number;
}

const require = createRequire(__filename);
const BUSINESS_SCHEMA_VERSION = 1;
const BUSINESS_SCHEMA_NAME = "business_schema_v1_clean_baseline";
const DEFAULT_INDEXING_TASK_MAX_ATTEMPTS = 5;
const now = () => new Date().toISOString();

export class SQLiteBusinessStore {
  private readonly db: SQLiteDatabaseSync;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = openDatabase(dbPath);
    this.db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
    this.migrate();
  }

  status(): BusinessStoreStatus {
    return {
      dbPath: this.dbPath,
      schemaVersion: this.schemaVersion(),
    };
  }

  currentSemesterId(): string | null {
    return this.loadAppState().currentSemesterId || null;
  }

  currentSemester(): SemesterWorkspace | null {
    const currentId = this.currentSemesterId();
    return currentId ? this.getSemester(currentId) : null;
  }

  listSemesters(): SemesterWorkspace[] {
    return this.all("select * from semesters order by starts_at desc, recognized_at desc").map(rowToSemester);
  }

  getSemester(semesterId: string): SemesterWorkspace | null {
    const row = this.db.prepare("select * from semesters where id = ?").get(semesterId) as Row | undefined;
    return row ? rowToSemester(row) : null;
  }

  firstActiveSemester(): SemesterWorkspace | null {
    const row = this.db.prepare("select * from semesters where archived_at is null order by starts_at desc, recognized_at desc limit 1").get() as Row | undefined;
    return row ? rowToSemester(row) : null;
  }

  listCourses(semesterId?: string): Course[] {
    if (semesterId) return this.all("select * from courses where semester_id = ? order by name", semesterId).map(rowToCourse);
    return this.all("select * from courses order by name").map(rowToCourse);
  }

  getCourse(courseId: string): Course | null {
    const row = this.db.prepare("select * from courses where id = ?").get(courseId) as Row | undefined;
    return row ? rowToCourse(row) : null;
  }

  countCourses(semesterId: string): number {
    const row = this.db.prepare("select count(*) as count from courses where semester_id = ?").get(semesterId) as Row | undefined;
    return numberValue(row?.count) || 0;
  }

  listTasks(semesterId?: string, courseId?: string): BrevynTask[] {
    const where: string[] = [];
    const params: unknown[] = [];
    where.push("archived_at is null");
    if (semesterId) {
      where.push("semester_id = ?");
      params.push(semesterId);
    }
    if (courseId) {
      where.push("course_id = ?");
      params.push(courseId);
    }
    const sql = `select * from tasks${where.length ? ` where ${where.join(" and ")}` : ""} order by updated_at desc`;
    return this.all(sql, ...params).map(rowToTask);
  }

  listArchivedTasks(semesterId: string, courseId?: string): BrevynTask[] {
    const where = ["semester_id = ?", "archived_at is not null"];
    const params: unknown[] = [semesterId];
    if (courseId) {
      where.push("course_id = ?");
      params.push(courseId);
    }
    return this.all(
      `select * from tasks
       where ${where.join(" and ")}
       order by archived_at desc, updated_at desc`,
      ...params,
    ).map(rowToTask);
  }

  getTask(taskId: string): BrevynTask | null {
    const row = this.db.prepare("select * from tasks where id = ?").get(taskId) as Row | undefined;
    return row ? rowToTask(row) : null;
  }

  hasActiveTaskIndexing(taskId: string, courseId: string): boolean {
    const sectionId = `${courseId}:task-${taskId}`;
    const sectionRow = this.db
      .prepare(
        `select 1
         from indexing_jobs
         where course_id = ?
           and section_id = ?
           and status in ('queued', 'indexing')
         limit 1`,
      )
      .get(courseId, sectionId) as Row | undefined;
    if (sectionRow) return true;

    const fileRow = this.db
      .prepare(
        `select 1
         from indexing_tasks
         join indexing_jobs on indexing_jobs.id = indexing_tasks.job_id
         join workspace_files on workspace_files.id = indexing_tasks.file_id
         where workspace_files.task_id = ?
           and indexing_tasks.status in ('queued', 'running')
           and indexing_jobs.status in ('queued', 'indexing')
         limit 1`,
      )
      .get(taskId) as Row | undefined;
    return Boolean(fileRow);
  }

  hasActiveCourseIndexing(courseId: string): boolean {
    const jobRow = this.db
      .prepare(
        `select 1
         from indexing_jobs
         where course_id = ?
           and status in ('queued', 'indexing')
         limit 1`,
      )
      .get(courseId) as Row | undefined;
    if (jobRow) return true;

    const taskRow = this.db
      .prepare(
        `select 1
         from indexing_tasks
         join indexing_jobs on indexing_jobs.id = indexing_tasks.job_id
         where indexing_tasks.course_id = ?
           and indexing_tasks.status in ('queued', 'running')
           and indexing_jobs.status in ('queued', 'indexing')
         limit 1`,
      )
      .get(courseId) as Row | undefined;
    return Boolean(taskRow);
  }

  hasActiveSemesterIndexing(semesterId: string): boolean {
    const jobRow = this.db
      .prepare(
        `select 1
         from indexing_jobs
         where semester_id = ?
           and status in ('queued', 'indexing')
         limit 1`,
      )
      .get(semesterId) as Row | undefined;
    if (jobRow) return true;

    const taskRow = this.db
      .prepare(
        `select 1
         from indexing_tasks
         join indexing_jobs on indexing_jobs.id = indexing_tasks.job_id
         where indexing_tasks.semester_id = ?
           and indexing_tasks.status in ('queued', 'running')
           and indexing_jobs.status in ('queued', 'indexing')
         limit 1`,
      )
      .get(semesterId) as Row | undefined;
    return Boolean(taskRow);
  }

  hasActiveFileIndexing(fileId: string): boolean {
    const row = this.db
      .prepare(
        `select 1
         from indexing_tasks
         join indexing_jobs on indexing_jobs.id = indexing_tasks.job_id
         where indexing_tasks.file_id = ?
           and indexing_tasks.status in ('queued', 'running')
           and indexing_jobs.status in ('queued', 'indexing')
         limit 1`,
      )
      .get(fileId) as Row | undefined;
    return Boolean(row);
  }

  activeIndexingJobsForFiles(fileIds: string[]): IndexingJob[] {
    const ids = [...new Set(fileIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.all(
      `select distinct indexing_jobs.*
       from indexing_jobs
       join indexing_tasks on indexing_tasks.job_id = indexing_jobs.id
       where indexing_tasks.file_id in (${placeholders})
         and indexing_tasks.status in ('queued', 'running')
         and indexing_jobs.status in ('queued', 'indexing')
       order by indexing_jobs.updated_at desc`,
      ...ids,
    ).map(rowToIndexingJob);
  }

  listThreads(semesterId?: string, courseId?: string): Thread[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (semesterId) {
      where.push("semester_id = ?");
      params.push(semesterId);
    }
    if (courseId) {
      where.push("course_id = ?");
      params.push(courseId);
    }
    const sql = `select * from threads${where.length ? ` where ${where.join(" and ")}` : ""} order by updated_at desc`;
    return this.all(sql, ...params).map(rowToThread);
  }

  listArchivedThreads(semesterId?: string, courseId?: string): Thread[] {
    return this.listThreads(semesterId, courseId)
      .filter((thread) => Boolean(thread.archivedAt))
      .sort((a, b) => Date.parse(b.archivedAt || b.updatedAt) - Date.parse(a.archivedAt || a.updatedAt));
  }

  getThread(threadId: string): Thread | null {
    const row = this.db.prepare("select * from threads where id = ?").get(threadId) as Row | undefined;
    return row ? rowToThread(row) : null;
  }

  listWorkspaceFiles(semesterId?: string, courseId?: string): WorkspaceFileNode[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (semesterId) {
      where.push("workspace_files.semester_id = ?");
      params.push(semesterId);
    }
    if (courseId) {
      where.push("workspace_files.course_id = ?");
      params.push(courseId);
    }
    const sql = `${workspaceFilesWithLatestIndexingSql()}${where.length ? ` where ${where.join(" and ")}` : ""} order by workspace_files.path, workspace_files.name`;
    return rowsToFileTree(this.all(sql, ...params));
  }

  getWorkspaceFile(fileId: string): WorkspaceFileNode | null {
    const row = this.db.prepare(`${workspaceFilesWithLatestIndexingSql()} where workspace_files.id = ?`).get(fileId) as Row | undefined;
    return row ? rowToWorkspaceFileNode(row) : null;
  }

  listTimetableEvents(semesterId?: string): TimetableEvent[] {
    if (semesterId) return this.all("select * from timetable_events where semester_id = ? order by starts_at", semesterId).map(rowToTimetableEvent);
    return this.all("select * from timetable_events order by starts_at").map(rowToTimetableEvent);
  }

  setCurrentSemester(semesterId: string | null): void {
    this.run(
      `insert or replace into app_state(key, value, updated_at)
       values (?, ?, ?)`,
      "current_semester_id",
      semesterId || "",
      now(),
    );
  }

  saveSemester(semester: SemesterWorkspace, select = true): SemesterWorkspace {
    this.insertSemester(semester);
    if (select) this.setCurrentSemester(semester.id);
    return semester;
  }

  saveSemesterWithWorkspaceFiles(semester: SemesterWorkspace, files: WorkspaceFileNode[], select = true): SemesterWorkspace {
    this.db.exec("begin immediate;");
    try {
      this.insertSemester(semester);
      if (select) this.setCurrentSemester(semester.id);
      this.run("delete from workspace_files where semester_id = ? and course_id = ?", semester.id, SEMESTER_HOME_COURSE_ID);
      for (const file of flattenFileTree(files)) this.insertFile(file.node, file.parentId);
      this.db.exec("commit;");
      return semester;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  archiveSemester(semesterId: string, archivedAt = now()): SemesterWorkspace | null {
    this.run("update semesters set archived_at = ?, updated_at = ? where id = ?", archivedAt, archivedAt, semesterId);
    const row = this.db.prepare("select * from semesters where id = ?").get(semesterId) as Row | undefined;
    return row ? rowToSemester(row) : null;
  }

  restoreSemester(semesterId: string): SemesterWorkspace | null {
    const timestamp = now();
    this.run("update semesters set archived_at = null, updated_at = ? where id = ?", timestamp, semesterId);
    const row = this.db.prepare("select * from semesters where id = ?").get(semesterId) as Row | undefined;
    return row ? rowToSemester(row) : null;
  }

  deleteSemesterDeep(semesterId: string): boolean {
    this.db.exec("begin immediate;");
    try {
      this.run("delete from rag_chunks_fts where semester_id = ?", semesterId);
      const courseRows = this.all("select id from courses where semester_id = ?", semesterId);
      for (const row of courseRows) this.deleteCourseRows(stringValue(row.id));
      this.run("delete from indexing_tasks where semester_id = ?", semesterId);
      this.run("delete from indexing_jobs where semester_id = ?", semesterId);
      this.run("delete from workspace_files where semester_id = ?", semesterId);
      this.run("delete from external_sources where semester_id = ?", semesterId);
      this.run("delete from source_candidates where semester_id = ?", semesterId);
      this.run("delete from threads where semester_id = ?", semesterId);
      this.run("delete from tasks where semester_id = ?", semesterId);
      this.run("delete from timetable_events where semester_id = ?", semesterId);
      const result = this.run("delete from semesters where id = ?", semesterId) as { changes?: number } | undefined;
      this.run("update app_state set value = '', updated_at = ? where key = 'current_semester_id' and value = ?", now(), semesterId);
      this.db.exec("commit;");
      return Number(result?.changes || 0) > 0;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  saveCourse(course: Course): Course {
    this.insertCourse(course);
    return course;
  }

  updateCourseDetails(course: Course): Course {
    const timestamp = now();
    this.run(
      `update courses
       set code = ?, instructor = ?, schedule_json = ?, raw_json = ?, updated_at = ?
       where id = ?`,
      course.code,
      course.instructor ?? null,
      json({ meetingTime: course.meetingTime, location: course.location }),
      json(course),
      timestamp,
      course.id,
    );
    const row = this.db.prepare("select * from courses where id = ?").get(course.id) as Row | undefined;
    if (!row) throw new Error(`Course not found: ${course.id}`);
    return rowToCourse(row);
  }

  saveCourseWithWorkspaceFiles(course: Course, files: WorkspaceFileNode[]): Course {
    this.db.exec("begin immediate;");
    try {
      this.insertCourse(course);
      this.run("delete from workspace_files where semester_id = ? and course_id = ?", course.semesterId ?? "", course.id);
      for (const file of flattenFileTree(files)) this.insertFile(file.node, file.parentId);
      this.db.exec("commit;");
      return course;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  archiveCourse(courseId: string, archivedAt = now()): Course | null {
    this.run("update courses set archived_at = ?, updated_at = ? where id = ?", archivedAt, archivedAt, courseId);
    const row = this.db.prepare("select * from courses where id = ?").get(courseId) as Row | undefined;
    return row ? rowToCourse(row) : null;
  }

  restoreCourse(courseId: string): Course | null {
    const timestamp = now();
    this.run("update courses set archived_at = null, updated_at = ? where id = ?", timestamp, courseId);
    const row = this.db.prepare("select * from courses where id = ?").get(courseId) as Row | undefined;
    return row ? rowToCourse(row) : null;
  }

  deleteCourseDeep(courseId: string): boolean {
    this.db.exec("begin immediate;");
    try {
      const deleted = this.deleteCourseRows(courseId);
      this.db.exec("commit;");
      return deleted;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  saveTask(task: BrevynTask): BrevynTask {
    this.insertTask(task);
    return task;
  }

  saveTaskWithWorkspaceFiles(task: BrevynTask, files: WorkspaceFileNode[]): BrevynTask {
    this.db.exec("begin immediate;");
    try {
      this.insertTask(task);
      this.run("delete from workspace_files where semester_id = ? and course_id = ? and task_id = ?", task.semesterId ?? "", task.courseId, task.id);
      for (const file of flattenFileTree(files)) this.insertFile(file.node, file.parentId);
      this.db.exec("commit;");
      return task;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  updateTask(input: UpdateTaskInput): BrevynTask | null {
    const row = this.db.prepare("select * from tasks where id = ?").get(input.id) as Row | undefined;
    if (!row) return null;

    const existing = rowToTask(row);
    const title = input.title === undefined ? existing.title : input.title.trim() || existing.title;
    const taskType = input.taskType === undefined ? existing.taskType : input.taskType.trim() || DEFAULT_TASK_TYPE;
    const icon = input.icon === undefined ? existing.icon : input.icon;
    const dueAt = input.dueAt === undefined ? existing.dueAt : input.dueAt?.trim() || undefined;
    const status = input.status ?? existing.status;
    const summary = input.summary === undefined ? existing.summary : input.summary;
    const info = input.info === undefined ? existing.info : input.info || undefined;
    const nextTask: BrevynTask = {
      ...existing,
      title,
      taskType,
      icon,
      dueAt,
      status,
      summary,
      info,
    };
    const timestamp = now();
    this.run(
      `update tasks
       set title = ?, task_type = ?, due_at = ?, status = ?, raw_json = ?, updated_at = ?
       where id = ?`,
      nextTask.title,
      nextTask.taskType,
      nextTask.dueAt ?? null,
      nextTask.status,
      json({ ...rawJson<Record<string, unknown>>(row.raw_json, {}), ...nextTask }),
      timestamp,
      input.id,
    );
    return this.getTask(input.id);
  }

  archiveTask(taskId: string, archivedAt = now()): BrevynTask | null {
    this.run("update tasks set archived_at = ?, updated_at = ? where id = ?", archivedAt, archivedAt, taskId);
    return this.getTask(taskId);
  }

  restoreTask(taskId: string): BrevynTask | null {
    const timestamp = now();
    this.run("update tasks set archived_at = null, updated_at = ? where id = ?", timestamp, taskId);
    return this.getTask(taskId);
  }

  deleteTaskDeep(taskId: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    const sectionId = `${task.courseId}:task-${task.id}`;
    this.db.exec("begin immediate;");
    try {
      this.run("delete from rag_chunks_fts where task_id = ? or section_id = ?", taskId, sectionId);
      this.run(
        `delete from indexing_tasks
         where section_id = ?
            or job_id in (select id from indexing_jobs where section_id = ?)
            or file_id in (select id from workspace_files where task_id = ?)`,
        sectionId,
        sectionId,
        taskId,
      );
      this.run("delete from indexing_jobs where section_id = ?", sectionId);
      this.run("delete from workspace_files where task_id = ?", taskId);
      this.run("delete from external_sources where task_id = ?", taskId);
      this.run("delete from source_candidates where task_id = ?", taskId);
      this.run("delete from threads where task_id = ?", taskId);
      this.run("delete from timetable_events where task_id = ?", taskId);
      const result = this.run("delete from tasks where id = ?", taskId) as { changes?: number } | undefined;
      this.db.exec("commit;");
      return Number(result?.changes || 0) > 0;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  saveThread(thread: Thread): Thread {
    this.insertThread(thread);
    return thread;
  }

  renameThread(threadId: string, title: string): Thread | null {
    const thread = this.getThread(threadId);
    if (!thread) return null;
    const updated = { ...thread, title, titleSource: "manual" as const, updatedAt: now() };
    this.insertThread(updated);
    return this.getThread(threadId);
  }

  renameThreadAutomatically(
    threadId: string,
    title: string,
    generatedAt = now(),
    options?: { allowAfterFirstMessage?: boolean },
  ): Thread | null {
    const thread = this.getThread(threadId);
    if (!thread || !canAutoRenameThread(thread, options)) return null;
    this.insertThread({
      ...thread,
      title,
      titleSource: "auto",
      titleGeneratedAt: generatedAt,
      updatedAt: generatedAt,
    });
    return this.getThread(threadId);
  }

  updateThreadSdkSessionId(threadId: string, sdkSessionId?: string): Thread | null {
    const thread = this.getThread(threadId);
    if (!thread) return null;
    this.insertThread({
      ...thread,
      sdkSessionId: sdkSessionId?.trim() || undefined,
      updatedAt: now(),
    });
    return this.getThread(threadId);
  }

  updateThreadWorkflow(threadId: string, workflow: Thread["workflow"] | undefined): Thread | null {
    const thread = this.getThread(threadId);
    if (!thread) return null;
    this.insertThread({
      ...thread,
      workflow,
      updatedAt: now(),
    });
    return this.getThread(threadId);
  }

  recordThreadMessage(threadId: string, timestamp = now()): Thread | null {
    const thread = this.getThread(threadId);
    if (!thread) return null;
    this.insertThread({
      ...thread,
      isDraft: false,
      messageCount: Math.max(0, thread.messageCount || 0) + 1,
      lastMessageAt: timestamp,
      updatedAt: timestamp,
    });
    return this.getThread(threadId);
  }

  archiveThread(threadId: string, archivedAt = now()): Thread | null {
    const thread = this.getThread(threadId);
    if (!thread) return null;
    this.insertThread({ ...thread, archivedAt, updatedAt: archivedAt });
    return this.getThread(threadId);
  }

  restoreThread(threadId: string): Thread | null {
    const thread = this.getThread(threadId);
    if (!thread) return null;
    const timestamp = now();
    const { archivedAt: _archivedAt, ...restored } = thread;
    this.insertThread({ ...restored, updatedAt: timestamp });
    return this.getThread(threadId);
  }

  deleteThread(threadId: string): boolean {
    const result = this.run("delete from threads where id = ?", threadId) as { changes?: number } | undefined;
    return Number(result?.changes || 0) > 0;
  }

  saveWorkspaceFilesForScope(semesterId: string, courseId: string, files: WorkspaceFileNode[]): void {
    this.db.exec("begin immediate;");
    try {
      this.run("delete from workspace_files where semester_id = ? and course_id = ?", semesterId, courseId);
      for (const file of flattenFileTree(files)) this.insertFile(file.node, file.parentId);
      this.db.exec("commit;");
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  listExternalSources(input: { semesterId?: string; courseId?: string; taskId?: string }): ExternalSource[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.semesterId) {
      where.push("semester_id = ?");
      params.push(input.semesterId);
    }
    if (input.courseId) {
      where.push("course_id = ?");
      params.push(input.courseId);
    }
    if (input.taskId) {
      where.push("(task_id = ? or task_id is null)");
      params.push(input.taskId);
    }
    const sql = `select * from external_sources${where.length ? ` where ${where.join(" and ")}` : ""} order by updated_at desc`;
    return this.all(sql, ...params).map(rowToExternalSource);
  }

  getExternalSource(sourceId: string): ExternalSource | null {
    const row = this.db.prepare("select * from external_sources where id = ?").get(sourceId) as Row | undefined;
    return row ? rowToExternalSource(row) : null;
  }

  saveExternalSource(source: ExternalSource): ExternalSource {
    this.insertExternalSource(source);
    const saved = this.getExternalSource(source.id);
    return saved || source;
  }

  updateExternalSourceStatus(sourceId: string, status: ExternalSourceStatus, error?: string): ExternalSource | null {
    const timestamp = now();
    this.run(
      `update external_sources
       set status = ?, error = ?, updated_at = ?
       where id = ?`,
      status,
      error ?? null,
      timestamp,
      sourceId,
    );
    return this.getExternalSource(sourceId);
  }

  deleteExternalSource(sourceId: string): ExternalSource | null {
    const source = this.getExternalSource(sourceId);
    if (!source) return null;
    this.run("delete from source_candidates where external_source_id = ?", sourceId);
    this.run("delete from external_sources where id = ?", sourceId);
    return source;
  }

  listSourceCandidates(input: { semesterId?: string; courseId?: string; taskId?: string; threadId?: string; statuses?: SourceCandidateStatus[] }): SourceCandidate[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (input.semesterId) {
      where.push("semester_id = ?");
      params.push(input.semesterId);
    }
    if (input.courseId) {
      where.push("course_id = ?");
      params.push(input.courseId);
    }
    if (input.taskId) {
      where.push("(task_id = ? or task_id is null)");
      params.push(input.taskId);
    }
    if (input.threadId) {
      where.push("(thread_id = ? or thread_id is null)");
      params.push(input.threadId);
    }
    if (input.statuses?.length) {
      where.push(`status in (${input.statuses.map(() => "?").join(", ")})`);
      params.push(...input.statuses);
    }
    const sql = `select * from source_candidates${where.length ? ` where ${where.join(" and ")}` : ""} order by updated_at desc`;
    return this.all(sql, ...params).map(rowToSourceCandidate);
  }

  getSourceCandidate(candidateId: string): SourceCandidate | null {
    const row = this.db.prepare("select * from source_candidates where id = ?").get(candidateId) as Row | undefined;
    return row ? rowToSourceCandidate(row) : null;
  }

  findSourceCandidateByNormalizedUrl(input: { semesterId: string; courseId: string; taskId?: string; scope: "task" | "course"; normalizedUrl: string; statuses?: SourceCandidateStatus[] }): SourceCandidate | null {
    const params: unknown[] = [
      input.semesterId,
      input.courseId,
      input.scope,
      input.normalizedUrl,
    ];
    const where = [
      "semester_id = ?",
      "course_id = ?",
      "scope = ?",
      "normalized_url = ?",
    ];
    if (input.scope === "task") {
      where.push("task_id = ?");
      params.push(input.taskId ?? "");
    } else {
      where.push("task_id is null");
    }
    if (input.statuses?.length) {
      where.push(`status in (${input.statuses.map(() => "?").join(", ")})`);
      params.push(...input.statuses);
    }
    const row = this.db.prepare(`select * from source_candidates where ${where.join(" and ")} order by updated_at desc limit 1`).get(...params) as Row | undefined;
    return row ? rowToSourceCandidate(row) : null;
  }

  saveSourceCandidate(candidate: SourceCandidate): SourceCandidate {
    this.insertSourceCandidate(candidate);
    return this.getSourceCandidate(candidate.id) || candidate;
  }

  updateSourceCandidate(candidate: SourceCandidate): SourceCandidate {
    this.insertSourceCandidate(candidate);
    return this.getSourceCandidate(candidate.id) || candidate;
  }

  updateSourceCandidateStatus(candidateId: string, status: SourceCandidateStatus, patch: Partial<Pick<SourceCandidate, "externalSourceId" | "error">> = {}): SourceCandidate | null {
    const timestamp = now();
    this.run(
      `update source_candidates
       set status = ?,
           external_source_id = coalesce(?, external_source_id),
           error = ?,
           updated_at = ?
       where id = ?`,
      status,
      patch.externalSourceId ?? null,
      patch.error ?? null,
      timestamp,
      candidateId,
    );
    return this.getSourceCandidate(candidateId);
  }

  saveTimetableEvent(event: TimetableEvent): TimetableEvent {
    this.insertTimetableEvent(event);
    return event;
  }

  saveTimetableEvents(events: TimetableEvent[]): TimetableEvent[] {
    this.db.exec("begin immediate;");
    try {
      for (const event of events) this.insertTimetableEvent(event);
      this.db.exec("commit;");
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
    return events;
  }

  replaceCourseSessionEvents(courseId: string, events: TimetableEvent[]): TimetableEvent[] {
    this.db.exec("begin immediate;");
    try {
      this.run("delete from timetable_events where course_id = ? and kind = 'course_session' and source = 'course'", courseId);
      for (const event of events) this.insertTimetableEvent(event);
      this.db.exec("commit;");
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
    return events;
  }

  replaceSchoolCalendarEvents(semesterId: string, events: TimetableEvent[]): TimetableEvent[] {
    this.db.exec("begin immediate;");
    try {
      this.run("delete from timetable_events where semester_id = ? and source = 'school_calendar'", semesterId);
      for (const event of events) this.insertTimetableEvent(event);
      this.db.exec("commit;");
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
    return events;
  }

  close(): void {
    this.db.close();
  }

  listIndexingJobs(semesterId?: string, courseId?: string): IndexingJob[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (semesterId) {
      where.push("semester_id = ?");
      params.push(semesterId);
    }
    if (courseId) {
      where.push("course_id = ?");
      params.push(courseId);
    }
    const sql = `select * from indexing_jobs${where.length ? ` where ${where.join(" and ")}` : ""} order by updated_at desc`;
    return this.all(sql, ...params).map(rowToIndexingJob);
  }

  latestCompletedIndexingRecords(semesterId: string, courseId?: string): Map<string, { fingerprint?: string; completedAt: string }> {
    const where = ["indexing_tasks.semester_id = ?", "indexing_tasks.status = 'done'"];
    const params: unknown[] = [semesterId];
    if (courseId) {
      where.push("indexing_tasks.course_id = ?");
      params.push(courseId);
    }
    const rows = this.all(
      `select indexing_tasks.file_id,
              indexing_tasks.updated_at as indexing_completed_at,
              indexing_jobs.embedding_provider_fingerprint
       from indexing_tasks
       join indexing_jobs on indexing_jobs.id = indexing_tasks.job_id
       where ${where.join(" and ")}
       order by indexing_tasks.updated_at desc, indexing_tasks.created_at desc, indexing_tasks.id desc`,
      ...params,
    );
    const records = new Map<string, { fingerprint?: string; completedAt: string }>();
    for (const row of rows) {
      const fileId = stringValue(row.file_id);
      const completedAt = stringValue(row.indexing_completed_at);
      if (!fileId || !completedAt || records.has(fileId)) continue;
      records.set(fileId, {
        fingerprint: nullableString(row.embedding_provider_fingerprint),
        completedAt,
      });
    }
    return records;
  }

  activeIndexingJobForSection(semesterId: string, courseId: string, sectionId?: string): IndexingJob | null {
    const row = sectionId
      ? this.db
          .prepare(
            `select *
             from indexing_jobs
             where semester_id = ?
               and course_id = ?
               and section_id = ?
               and status in ('queued', 'indexing')
             order by updated_at desc
             limit 1`,
          )
          .get(semesterId, courseId, sectionId) as Row | undefined
      : this.db
          .prepare(
            `select *
             from indexing_jobs
             where semester_id = ?
               and course_id = ?
               and section_id is null
               and status in ('queued', 'indexing')
             order by updated_at desc
             limit 1`,
          )
          .get(semesterId, courseId) as Row | undefined;
    return row ? rowToIndexingJob(row) : null;
  }

  createIndexingJob(job: IndexingJob, tasks: IndexingTaskInsert[]): IndexingJob {
    this.db.exec("begin immediate;");
    try {
      this.insertIndexingJob({
        ...job,
        totalFiles: job.totalFiles ?? tasks.length,
        indexedFiles: job.indexedFiles ?? 0,
        completedFiles: job.completedFiles ?? 0,
        progress: tasks.length > 0 ? job.progress : 100,
        stage: job.stage || (tasks.length > 0 ? "queued" : "empty"),
      });
      for (const task of tasks) this.insertIndexingTask(task);
      this.db.exec("commit;");
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
    return this.getIndexingJob(job.id) || job;
  }

  appendIndexingTasksToJob(jobId: string, tasks: IndexingTaskInsert[]): IndexingJob | null {
    if (tasks.length === 0) return this.getIndexingJob(jobId);
    this.db.exec("begin immediate;");
    try {
      const job = this.getIndexingJob(jobId);
      if (!job || job.status === "failed" || job.status === "cancelled" || job.status === "idle") {
        this.db.exec("commit;");
        return job;
      }
      const existingActiveFileIds = this.activeIndexingFileIdsForJob(jobId);
      for (const task of tasks) {
        if (existingActiveFileIds.has(task.fileId)) continue;
        existingActiveFileIds.add(task.fileId);
        this.insertIndexingTask({ ...task, jobId });
      }
      const updated = this.refreshIndexingJob(jobId);
      this.db.exec("commit;");
      return updated;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  private activeIndexingFileIdsForJob(jobId: string): Set<string> {
    return new Set(this.all(
      `select distinct file_id as fileId
       from indexing_tasks
       where job_id = ?
         and status in ('queued', 'running')`,
      jobId,
    ).flatMap((row) => {
      const fileId = typeof row.fileId === "string" ? row.fileId : "";
      return fileId ? [fileId] : [];
    }));
  }

  getIndexingTask(taskId: string): IndexingTaskRecord | null {
    const row = this.db.prepare("select * from indexing_tasks where id = ?").get(taskId) as Row | undefined;
    return row ? rowToIndexingTask(row) : null;
  }

  isIndexingTaskLeaseCurrent(taskId: string, lease: IndexingTaskLease): boolean {
    const row = this.db
      .prepare(
        `select 1
         from indexing_tasks
         where id = ?
           and status = 'running'
           and locked_by = ?
           and locked_until = ?
         limit 1`,
      )
      .get(taskId, lease.workerId, lease.lockedUntil ?? "") as Row | undefined;
    return Boolean(row);
  }

  extendIndexingTaskLease(taskId: string, lease: IndexingTaskLease, lockMs: number): IndexingTaskRecord | null {
    const timestamp = now();
    const lockedUntil = new Date(Date.now() + lockMs).toISOString();
    this.db.exec("begin immediate;");
    try {
      const result = this.run(
        `update indexing_tasks
         set locked_until = ?,
             updated_at = ?
         where id = ?
           and status = 'running'
           and locked_by = ?
           and locked_until = ?`,
        lockedUntil,
        timestamp,
        taskId,
        lease.workerId,
        lease.lockedUntil ?? "",
      ) as { changes?: number } | undefined;
      if (Number(result?.changes || 0) === 0) {
        this.db.exec("commit;");
        return null;
      }
      const task = this.getIndexingTask(taskId);
      this.db.exec("commit;");
      return task;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  claimNextIndexingTask(workerId: string, lockMs: number): IndexingTaskRecord | null {
    const timestamp = now();
    const lockedUntil = new Date(Date.now() + lockMs).toISOString();
    this.db.exec("begin immediate;");
    try {
      const row = this.db
        .prepare(
          `select indexing_tasks.*
           from indexing_tasks
           join indexing_jobs on indexing_jobs.id = indexing_tasks.job_id
           where indexing_tasks.status = 'queued'
             and indexing_tasks.next_run_at <= ?
             and indexing_jobs.status in ('queued', 'indexing')
           order by indexing_tasks.next_run_at asc, indexing_tasks.created_at asc
           limit 1`,
        )
        .get(timestamp) as Row | undefined;
      if (!row) {
        this.db.exec("commit;");
        return null;
      }
      this.run(
        `update indexing_tasks
         set status = 'running',
             attempts = attempts + 1,
             locked_by = ?,
             locked_until = ?,
             progress = 5,
             updated_at = ?
         where id = ?`,
        workerId,
        lockedUntil,
        timestamp,
        stringValue(row.id),
      );
      this.run(
        `update indexing_jobs
         set status = 'indexing',
             stage = ?,
             updated_at = ?
         where id = ? and status != 'cancelled'`,
        stringValue(row.kind),
        timestamp,
        stringValue(row.job_id),
      );
      const task = this.getIndexingTask(stringValue(row.id));
      this.db.exec("commit;");
      return task;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  recoverExpiredIndexingTasks(currentWorkerId?: string): void {
    const timestamp = now();
    this.db.exec("begin immediate;");
    try {
      this.run(
        `update indexing_tasks
         set status = 'queued',
             locked_by = null,
             locked_until = null,
             progress = 0,
             updated_at = ?
         where status = 'running'
           and locked_until is not null
           and locked_until < ?
           and (? is null or locked_by is null or locked_by != ?)`,
        timestamp,
        timestamp,
        currentWorkerId ?? null,
        currentWorkerId ?? null,
      );
      this.run(
        `update indexing_jobs
         set status = 'queued',
             stage = 'recovered',
             updated_at = ?
         where status = 'indexing'
           and exists (
             select 1 from indexing_tasks
             where indexing_tasks.job_id = indexing_jobs.id
               and indexing_tasks.status = 'queued'
           )`,
        timestamp,
      );
      this.db.exec("commit;");
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  completeIndexingTask(taskId: string, result: IndexingWorkerResult, lease?: IndexingTaskLease): IndexingJob | null {
    const timestamp = now();
    this.db.exec("begin immediate;");
    try {
      const task = this.getIndexingTask(taskId);
      if (!task) {
        this.db.exec("commit;");
        return null;
      }
      const job = this.getIndexingJob(task.jobId);
      if (job?.status === "cancelled") {
        this.run(
          `update indexing_tasks
           set status = 'cancelled', locked_by = null, locked_until = null, updated_at = ?
           where id = ?`,
          timestamp,
          taskId,
        );
        this.db.exec("commit;");
        return this.getIndexingJob(task.jobId);
      }
      const updateResult = this.run(
        `update indexing_tasks
         set status = 'done',
             locked_by = null,
             locked_until = null,
             progress = 100,
             error = null,
             payload_json = ?,
             updated_at = ?
         where id = ?
           ${lease ? "and status = 'running' and locked_by = ? and locked_until = ?" : ""}`,
        json({
          ...task.payload,
          result: {
            fileId: result.fileId,
            sourcePath: result.sourcePath,
            chunkCount: result.chunkCount,
            charCount: result.charCount,
            byteCount: result.byteCount,
            sample: result.sample,
            warnings: result.warnings,
            metadata: result.metadata,
          },
        }),
        timestamp,
        taskId,
        ...(lease ? [lease.workerId, lease.lockedUntil ?? ""] : []),
      );
      if (lease && Number((updateResult as { changes?: number } | undefined)?.changes || 0) === 0) {
        this.db.exec("commit;");
        return this.getIndexingJob(task.jobId);
      }
      this.run("update workspace_files set indexed_at = ?, updated_at = ? where id = ?", timestamp, timestamp, task.fileId);
      const updated = this.refreshIndexingJob(task.jobId);
      this.db.exec("commit;");
      return updated;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  failIndexingTask(taskId: string, message: string, lease?: IndexingTaskLease): IndexingJob | null {
    const timestamp = now();
    this.db.exec("begin immediate;");
    try {
      const task = this.getIndexingTask(taskId);
      if (!task) {
        this.db.exec("commit;");
        return null;
      }
      const retry = task.attempts < task.maxAttempts && shouldRetryIndexingError(message);
      const backoffMs = Math.min(120_000, 10_000 * Math.max(1, 2 ** Math.max(0, task.attempts - 1)));
      const updateResult = this.run(
        `update indexing_tasks
         set status = ?,
             locked_by = null,
             locked_until = null,
             next_run_at = ?,
             progress = 0,
             error = ?,
             updated_at = ?
         where id = ?
           ${lease ? "and status = 'running' and locked_by = ? and locked_until = ?" : ""}`,
        retry ? "queued" : "failed",
        retry ? new Date(Date.now() + backoffMs).toISOString() : timestamp,
        retry ? null : message,
        timestamp,
        taskId,
        ...(lease ? [lease.workerId, lease.lockedUntil ?? ""] : []),
      );
      if (lease && Number((updateResult as { changes?: number } | undefined)?.changes || 0) === 0) {
        this.db.exec("commit;");
        return this.getIndexingJob(task.jobId);
      }
      const updated = this.refreshIndexingJob(task.jobId);
      this.db.exec("commit;");
      return updated;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  cancelIndexingJob(jobId: string): IndexingJob | null {
    const timestamp = now();
    this.db.exec("begin immediate;");
    try {
      this.run(
        `update indexing_jobs
         set status = 'cancelled',
             stage = 'cancelled',
             updated_at = ?
         where id = ?`,
        timestamp,
        jobId,
      );
      this.run(
        `update indexing_tasks
         set status = 'cancelled',
             locked_by = null,
             locked_until = null,
             updated_at = ?
         where job_id = ? and status in ('queued', 'running')`,
        timestamp,
        jobId,
      );
      const job = this.getIndexingJob(jobId);
      this.db.exec("commit;");
      return job;
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  upsertRagTextChunks(chunks: RagTextIndexChunk[]): void {
    if (chunks.length === 0) return;
    this.db.exec("begin immediate;");
    try {
      for (const chunk of chunks) {
        this.run("delete from rag_chunks_fts where id = ?", chunk.id);
        this.run(
          `insert into rag_chunks_fts(
             id, semester_id, course_id, section_id, file_id, task_id,
             file_name, file_path, source_path, kind, week_number, task_file_bucket,
             chunk_index, chunk_count, title, citation, text, parser, coverage_status,
             ocr_applied, source_label, section_type, section_title, section_index,
             chunk_in_section, chunks_in_section, artifact_id, semantic_unit_id,
             element_ids, page, slide, sheet, range, bbox, created_at, updated_at
           )
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          chunk.id,
          chunk.semesterId,
          chunk.courseId,
          chunk.sectionId,
          chunk.fileId,
          chunk.taskId ?? "",
          chunk.fileName,
          chunk.filePath,
          chunk.sourcePath,
          chunk.kind,
          chunk.weekNumber,
          chunk.taskFileBucket,
          chunk.chunkIndex,
          chunk.chunkCount,
          chunk.title,
          chunk.citation,
          chunk.text,
          chunk.parser,
          chunk.coverageStatus,
          intBool(chunk.ocrApplied),
          chunk.sourceLabel,
          chunk.sectionType,
          chunk.sectionTitle,
          chunk.sectionIndex,
          chunk.chunkInSection,
          chunk.chunksInSection,
          chunk.artifactId ?? "",
          chunk.semanticUnitId ?? "",
          chunk.elementIds ?? "",
          chunk.page ?? -1,
          chunk.slide ?? -1,
          chunk.sheet ?? "",
          chunk.range ?? "",
          chunk.bbox ?? "",
          chunk.createdAt,
          chunk.updatedAt,
        );
      }
      this.db.exec("commit;");
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  deleteRagTextChunksByFile(fileId: string): void {
    this.run("delete from rag_chunks_fts where file_id = ?", fileId);
  }

  searchRagTextChunks(input: RagTextSearchInput): RagTextSearchResult[] {
    const query = fts5Query(input.query);
    if (!query) return [];
    const where = ["rag_chunks_fts match ?", "semester_id = ?"];
    const params: unknown[] = [query, input.semesterId];
    if (input.courseId) {
      where.push("course_id = ?");
      params.push(input.courseId);
    }
    if (input.taskId) {
      where.push("(task_id = ? or section_id = ?)");
      params.push(input.taskId, `${input.courseId || ""}:task-${input.taskId}`);
    }
    if (input.sectionKind && input.courseId) {
      if (input.sectionKind === "course_shared") {
        where.push("(section_id = ? or file_path like ? or file_path like ?)");
        params.push(`${input.courseId}:shared`, "%/Course shared/%", "%/Semester shared/%");
      } else if (input.sectionKind === "lecture") {
        where.push("(section_id = ? or file_path like ?)");
        params.push(`${input.courseId}:lecture`, "%/Lecture/%");
      } else {
        where.push("(section_id like ? or file_path like ?)");
        params.push(`${input.courseId}:task-%`, "%/Task/%");
      }
    }
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit || 24)));
    return this.all(
      `select id, semester_id, course_id, section_id, file_id, task_id,
              file_name, file_path, source_path, title, citation, text,
              chunk_index, chunk_count, source_label, section_type, section_title,
              artifact_id, semantic_unit_id, element_ids, page, slide, sheet, range, bbox,
              bm25(rag_chunks_fts) as rank
       from rag_chunks_fts
       where ${where.join(" and ")}
       order by rank
       limit ?`,
      ...params,
      limit,
    ).map(rowToRagTextSearchResult);
  }

  deleteRagTextChunksByCourse(semesterId: string, courseId: string): void {
    this.run("delete from rag_chunks_fts where semester_id = ? and course_id = ?", semesterId, courseId);
  }

  deleteRagTextChunksByTask(semesterId: string, courseId: string, taskId: string): void {
    const sectionId = `${courseId}:task-${taskId}`;
    this.run(
      `delete from rag_chunks_fts
       where semester_id = ?
         and course_id = ?
         and (task_id = ? or section_id = ?)`,
      semesterId,
      courseId,
      taskId,
      sectionId,
    );
  }

  deleteRagTextChunksBySemester(semesterId: string): void {
    this.run("delete from rag_chunks_fts where semester_id = ?", semesterId);
  }

  private deleteCourseRows(courseId: string): boolean {
    this.run("delete from rag_chunks_fts where course_id = ?", courseId);
    this.run("delete from indexing_tasks where course_id = ?", courseId);
    this.run("delete from indexing_jobs where course_id = ?", courseId);
    this.run("delete from workspace_files where course_id = ?", courseId);
    this.run("delete from external_sources where course_id = ?", courseId);
    this.run("delete from source_candidates where course_id = ?", courseId);
    this.run("delete from threads where course_id = ?", courseId);
    this.run("delete from tasks where course_id = ?", courseId);
    this.run("delete from timetable_events where course_id = ?", courseId);
    const result = this.run("delete from courses where id = ?", courseId) as { changes?: number } | undefined;
    return Number(result?.changes || 0) > 0;
  }

  private all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: unknown[]): unknown {
    return this.db.prepare(sql).run(...params);
  }

  private loadAppState(): { currentSemesterId?: string } {
    const rows = this.all("select key, value from app_state");
    const values = Object.fromEntries(rows.map((row) => [stringValue(row.key), stringValue(row.value)]));
    return { currentSemesterId: values.current_semester_id };
  }

  private insertSemester(semester: SemesterWorkspace): void {
    const timestamp = semester.recognizedAt || now();
    this.run(
      `insert or replace into semesters(id, semester_no, term, folder_name, starts_at, ends_at, recognized_at, source, archived_at, raw_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      semester.id,
      semester.semesterNo,
      semester.term,
      semester.folderName,
      semester.startsAt ?? null,
      semester.endsAt ?? null,
      semester.recognizedAt ?? null,
      semester.source,
      semester.archivedAt ?? null,
      json(semester),
      timestamp,
      timestamp,
    );
  }

  private insertCourse(course: Course): void {
    const timestamp = now();
    this.run(
      `insert or replace into courses(id, semester_id, code, name, instructor, schedule_json, folder_name, workspace_kind, archived_at, raw_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      course.id,
      course.semesterId ?? "",
      course.code,
      course.name,
      course.instructor ?? null,
      json({ meetingTime: course.meetingTime, location: course.location }),
      course.name,
      course.workspaceKind ?? "course",
      course.archivedAt ?? null,
      json(course),
      timestamp,
      timestamp,
    );
  }

  private insertTask(task: BrevynTask): void {
    const timestamp = now();
    this.run(
      `insert or replace into tasks(id, semester_id, course_id, title, task_type, due_at, status, archived_at, raw_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.semesterId ?? "",
      task.courseId,
      task.title,
      task.taskType,
      task.dueAt ?? null,
      task.status,
      task.archivedAt ?? null,
      json(task),
      timestamp,
      timestamp,
    );
  }

  private insertThread(thread: Thread): void {
    this.run(
      `insert or replace into threads(id, semester_id, course_id, task_id, title, status, archived_at, raw_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      thread.id,
      thread.semesterId ?? "",
      thread.courseId,
      thread.taskId ?? null,
      thread.title,
      "idle",
      thread.archivedAt ?? null,
      json(threadBusinessJson(thread)),
      thread.createdAt,
      thread.updatedAt,
    );
  }

  private insertFile(file: WorkspaceFileNode, parentId?: string): void {
    const raw = fileBusinessJson(file);
    this.run(
      `insert or replace into workspace_files(id, semester_id, course_id, task_id, parent_id, name, path, kind, mime_type, size_bytes, section_kind, week_number, task_file_bucket, source_path, indexed_at, raw_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      file.id,
      file.semesterId ?? "",
      file.courseId,
      file.taskId ?? null,
      parentId ?? null,
      file.name,
      file.path,
      file.kind,
      null,
      null,
      file.sectionKind ?? null,
      file.weekNumber ?? null,
      file.taskFileBucket ?? null,
      file.sourcePath ?? null,
      null,
      json(raw),
      file.updatedAt,
      file.updatedAt,
    );
  }

  private insertExternalSource(source: ExternalSource): void {
    this.run(
      `insert or replace into external_sources(
         id, semester_id, course_id, task_id, scope, kind, title, url,
         original_path, markdown_path, workspace_file_id, status, summary, error,
         added_by, raw_json, created_at, updated_at
       )
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      source.id,
      source.semesterId,
      source.courseId,
      source.taskId ?? null,
      source.scope,
      source.kind,
      source.title,
      source.url ?? null,
      source.originalPath ?? null,
      source.markdownPath ?? null,
      source.workspaceFileId ?? null,
      source.status,
      source.summary ?? null,
      source.error ?? null,
      source.addedBy,
      json(source),
      source.createdAt,
      source.updatedAt,
    );
  }

  private insertSourceCandidate(candidate: SourceCandidate): void {
    this.run(
      `insert or replace into source_candidates(
         id, semester_id, course_id, task_id, thread_id, scope, url, normalized_url,
         title, site_name, snippet, reason, status, external_source_id, error,
         proposed_by, raw_json, created_at, updated_at
       )
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      candidate.id,
      candidate.semesterId,
      candidate.courseId,
      candidate.taskId ?? null,
      candidate.threadId ?? null,
      candidate.scope,
      candidate.url,
      candidate.normalizedUrl ?? null,
      candidate.title,
      candidate.siteName ?? null,
      candidate.snippet ?? null,
      candidate.reason,
      candidate.status,
      candidate.externalSourceId ?? null,
      candidate.error ?? null,
      candidate.proposedBy,
      json(candidate),
      candidate.createdAt,
      candidate.updatedAt,
    );
  }

  private insertTimetableEvent(event: TimetableEvent): void {
    const timestamp = now();
    this.run(
      `insert or replace into timetable_events(id, semester_id, course_id, task_id, title, kind, source, starts_at, ends_at, location, notes, raw_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      event.id,
      event.semesterId ?? "",
      event.courseId ?? null,
      event.taskId ?? null,
      event.title,
      event.kind,
      event.source,
      event.startsAt,
      event.endsAt ?? null,
      event.location ?? null,
      event.notes ?? null,
      json(event),
      timestamp,
      timestamp,
    );
  }

  private insertIndexingJob(job: IndexingJob): void {
    this.run(
      `insert or replace into indexing_jobs(id, semester_id, course_id, section_id, status, stage, embedding_model, embedding_provider_fingerprint, indexed_files, total_files, completed_files, progress, error, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      job.id,
      job.semesterId ?? "",
      job.courseId,
      job.sectionId ?? null,
      job.status,
      job.stage ?? null,
      job.embeddingModel,
      job.embeddingProviderFingerprint ?? null,
      job.indexedFiles,
      job.totalFiles ?? job.indexedFiles ?? 0,
      job.completedFiles ?? job.indexedFiles ?? 0,
      job.progress,
      job.error ?? null,
      job.createdAt,
      job.updatedAt,
    );
  }

  private insertIndexingTask(task: IndexingTaskInsert): void {
    const timestamp = now();
    this.run(
      `insert into indexing_tasks(id, job_id, semester_id, course_id, section_id, file_id, kind, status, attempts, max_attempts, locked_by, locked_until, next_run_at, progress, error, payload_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, null, null, ?, 0, null, ?, ?, ?)`,
      task.id,
      task.jobId,
      task.semesterId ?? "",
      task.courseId,
      task.sectionId ?? null,
      task.fileId,
      task.kind,
      task.maxAttempts ?? DEFAULT_INDEXING_TASK_MAX_ATTEMPTS,
      task.nextRunAt ?? timestamp,
      json(task.payload),
      timestamp,
      timestamp,
    );
  }

  private insertIndexingTaskRecord(task: IndexingTaskRecord): void {
    this.run(
      `insert or replace into indexing_tasks(id, job_id, semester_id, course_id, section_id, file_id, kind, status, attempts, max_attempts, locked_by, locked_until, next_run_at, progress, error, payload_json, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id,
      task.jobId,
      task.semesterId ?? "",
      task.courseId,
      task.sectionId ?? null,
      task.fileId,
      task.kind,
      task.status,
      task.attempts,
      task.maxAttempts,
      task.lockedBy ?? null,
      task.lockedUntil ?? null,
      task.nextRunAt,
      task.progress,
      task.error ?? null,
      json(task.payload),
      task.createdAt,
      task.updatedAt,
    );
  }

  getIndexingJob(jobId: string): IndexingJob | null {
    const row = this.db.prepare("select * from indexing_jobs where id = ?").get(jobId) as Row | undefined;
    return row ? rowToIndexingJob(row) : null;
  }

  private refreshIndexingJob(jobId: string): IndexingJob | null {
    const current = this.getIndexingJob(jobId);
    if (!current) return null;
    if (current.status === "cancelled") return current;
    // Job was created in a terminal state (e.g. "failed" because no embedding provider was configured,
    // or "idle" because the section was empty). No tasks were ever inserted — don't recompute status,
    // it would otherwise flip to "indexed" because total === 0.
    if (current.status === "failed" || current.status === "idle") return current;

    const row = this.db
      .prepare(
        `select
           count(*) as total,
           sum(case when status = 'done' then 1 else 0 end) as done,
           sum(case when status = 'failed' then 1 else 0 end) as failed,
           sum(case when status = 'running' then 1 else 0 end) as running,
           sum(case when status = 'queued' then 1 else 0 end) as queued
         from indexing_tasks
         where job_id = ?`,
      )
      .get(jobId) as Row | undefined;
    const total = numberValue(row?.total) || 0;
    const done = numberValue(row?.done) || 0;
    const failed = numberValue(row?.failed) || 0;
    const running = numberValue(row?.running) || 0;
    const queued = numberValue(row?.queued) || 0;
    const status: IndexingJob["status"] =
      total === 0 ? "idle" : failed > 0 && running === 0 && queued === 0 ? "failed" : done >= total ? "indexed" : running > 0 ? "indexing" : "queued";
    const progress = total === 0 ? 0 : Math.max(0, Math.min(100, Math.round((done / total) * 100)));
    const failedRow = failed > 0 ? (this.db.prepare("select error from indexing_tasks where job_id = ? and status = 'failed' order by updated_at desc limit 1").get(jobId) as Row | undefined) : undefined;
    const timestamp = now();
    this.run(
      `update indexing_jobs
       set status = ?,
           stage = ?,
           indexed_files = ?,
           completed_files = ?,
           total_files = ?,
           progress = ?,
           error = ?,
           updated_at = ?
       where id = ?`,
      status,
      status === "indexed" ? "completed" : status === "failed" ? "failed" : running > 0 ? "parse_chunk" : "queued",
      done,
      done,
      total,
      progress,
      status === "failed" ? nullableString(failedRow?.error) ?? current.error ?? null : null,
      timestamp,
      jobId,
    );
    return this.getIndexingJob(jobId);
  }

  private schemaVersion(): number {
    const row = this.db.prepare("select max(version) as version from schema_migrations").get() as { version?: number } | undefined;
    return row?.version ?? 0;
  }

  private migrate(): void {
    this.ensureMigrationTable();
    if (!this.isCurrentBusinessSchema()) {
      this.resetBusinessSchema();
    }
    this.ensureCoreSchema();
    this.dropRetiredSchemas();
    this.ensureRagTextIndex();
    this.ensureIndexes();
    this.rebaselineSchemaMigration();
  }

  private isCurrentBusinessSchema(): boolean {
    const row = this.db.prepare("select version, name from schema_migrations order by version desc limit 1").get() as Row | undefined;
    return numberValue(row?.version) === BUSINESS_SCHEMA_VERSION && stringValue(row?.name) === BUSINESS_SCHEMA_NAME;
  }

  private ensureMigrationTable(): void {
    this.db.exec(`
      create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
    `);
  }

  private resetBusinessSchema(): void {
    this.db.exec("begin immediate;");
    try {
      this.db.exec(`
        drop table if exists rag_chunks_fts;
        drop table if exists indexing_tasks;
        drop table if exists indexing_jobs;
        drop table if exists timetable_events;
        drop table if exists workspace_files;
        drop table if exists external_sources;
        drop table if exists source_candidates;
        drop table if exists threads;
        drop table if exists tasks;
        drop table if exists courses;
        drop table if exists semesters;
        drop table if exists app_state;
        drop table if exists providers;
        drop table if exists reference_tag_links;
        drop table if exists reference_scopes;
        drop table if exists reference_creators;
        drop table if exists reference_tags;
        drop table if exists reference_items;
        drop table if exists tasks_without_workspace_path;
        drop table if exists threads_without_jsonl_path;
      `);
      this.db.exec("commit;");
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }

  private ensureCoreSchema(): void {
    this.db.exec(`
      begin;

      create table if not exists app_state (
        key text primary key,
        value text not null,
        updated_at text not null
      );

      create table if not exists semesters (
        id text primary key,
        semester_no text not null,
        term text not null,
        folder_name text not null,
        starts_at text,
        ends_at text,
        recognized_at text,
        source text not null,
        archived_at text,
        raw_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists courses (
        id text primary key,
        semester_id text not null references semesters(id) on delete cascade,
        code text not null,
        name text not null,
        instructor text,
        schedule_json text not null default '[]',
        folder_name text not null,
        workspace_kind text not null default 'course',
        archived_at text,
        raw_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists tasks (
        id text primary key,
        semester_id text not null references semesters(id) on delete cascade,
        course_id text not null references courses(id) on delete cascade,
        title text not null,
        task_type text not null,
        due_at text,
        status text not null default 'not_started',
        archived_at text,
        raw_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists threads (
        id text primary key,
        semester_id text not null references semesters(id) on delete cascade,
        course_id text not null,
        task_id text,
        title text not null,
        status text not null default 'idle',
        archived_at text,
        raw_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists workspace_files (
        id text primary key,
        semester_id text not null references semesters(id) on delete cascade,
        course_id text not null,
        task_id text,
        parent_id text,
        name text not null,
        path text not null,
        kind text not null,
        mime_type text,
        size_bytes integer,
        section_kind text,
        week_number integer,
        task_file_bucket text,
        source_path text,
        indexed_at text,
        raw_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists external_sources (
        id text primary key,
        semester_id text not null references semesters(id) on delete cascade,
        course_id text not null,
        task_id text,
        scope text not null,
        kind text not null,
        title text not null,
        url text,
        original_path text,
        markdown_path text,
        workspace_file_id text,
        status text not null,
        summary text,
        error text,
        added_by text not null,
        raw_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists source_candidates (
        id text primary key,
        semester_id text not null references semesters(id) on delete cascade,
        course_id text not null,
        task_id text,
        thread_id text,
        scope text not null,
        url text not null,
        normalized_url text,
        title text not null,
        site_name text,
        snippet text,
        reason text not null,
        status text not null,
        external_source_id text,
        error text,
        proposed_by text not null,
        raw_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists timetable_events (
        id text primary key,
        semester_id text not null references semesters(id) on delete cascade,
        course_id text,
        task_id text,
        title text not null,
        kind text not null,
        source text not null,
        starts_at text not null,
        ends_at text,
        location text,
        notes text,
        raw_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      create table if not exists indexing_jobs (
        id text primary key,
        semester_id text not null references semesters(id) on delete cascade,
        course_id text not null,
        section_id text,
        status text not null,
        stage text,
        embedding_model text not null,
        embedding_provider_fingerprint text,
        indexed_files integer not null default 0,
        total_files integer not null default 0,
        completed_files integer not null default 0,
        progress integer not null default 0,
        error text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists indexing_tasks (
        id text primary key,
        job_id text not null references indexing_jobs(id) on delete cascade,
        semester_id text not null,
        course_id text not null,
        section_id text,
        file_id text not null,
        kind text not null,
        status text not null,
        attempts integer not null default 0,
        max_attempts integer not null default 5,
        locked_by text,
        locked_until text,
        next_run_at text not null,
        progress integer not null default 0,
        error text,
        payload_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );

      commit;
    `);
  }

  private ensureIndexes(): void {
    this.db.exec(`
      create index if not exists idx_courses_semester on courses(semester_id);
      create index if not exists idx_tasks_course on tasks(course_id, archived_at, updated_at);
      create index if not exists idx_threads_scope on threads(semester_id, course_id, task_id);
      create index if not exists idx_threads_archived on threads(semester_id, course_id, archived_at, updated_at);
      create index if not exists idx_files_scope on workspace_files(semester_id, course_id, task_id, section_kind);
      create index if not exists idx_external_sources_scope on external_sources(semester_id, course_id, task_id, updated_at);
      create index if not exists idx_source_candidates_scope on source_candidates(semester_id, course_id, task_id, thread_id, status, updated_at);
      create index if not exists idx_source_candidates_url on source_candidates(semester_id, course_id, task_id, scope, normalized_url, status);
      create index if not exists idx_timetable_range on timetable_events(semester_id, starts_at, ends_at);
      create index if not exists idx_indexing_jobs_scope on indexing_jobs(semester_id, course_id, status);
      create index if not exists idx_indexing_tasks_ready on indexing_tasks(status, next_run_at, locked_until);
      create index if not exists idx_indexing_tasks_job on indexing_tasks(job_id, status);
      create index if not exists idx_indexing_tasks_file_history on indexing_tasks(file_id, status, updated_at);
    `);
  }

  private ensureRagTextIndex(): void {
    const existingColumns = this.tableColumns("rag_chunks_fts");
    if (existingColumns.size > 0 && !existingColumns.has("semantic_unit_id")) {
      this.db.exec("drop table if exists rag_chunks_fts;");
    }
    this.db.exec(`
      create virtual table if not exists rag_chunks_fts using fts5(
        id unindexed,
        semester_id unindexed,
        course_id unindexed,
        section_id unindexed,
        file_id unindexed,
        task_id unindexed,
        file_name,
        file_path,
        source_path,
        kind unindexed,
        week_number unindexed,
        task_file_bucket unindexed,
        chunk_index unindexed,
        chunk_count unindexed,
        title,
        citation,
        text,
        parser unindexed,
        coverage_status unindexed,
        ocr_applied unindexed,
        source_label,
        section_type unindexed,
        section_title,
        section_index unindexed,
        chunk_in_section unindexed,
        chunks_in_section unindexed,
        artifact_id unindexed,
        semantic_unit_id unindexed,
        element_ids unindexed,
        page unindexed,
        slide unindexed,
        sheet unindexed,
        range unindexed,
        bbox unindexed,
        created_at unindexed,
        updated_at unindexed,
        tokenize = 'unicode61'
      );
    `);
  }

  private dropRetiredSchemas(): void {
    this.db.exec(`
      drop table if exists providers;
      drop table if exists reference_tag_links;
      drop table if exists reference_scopes;
      drop table if exists reference_creators;
      drop table if exists reference_tags;
      drop table if exists reference_items;
      drop table if exists tasks_without_workspace_path;
      drop table if exists threads_without_jsonl_path;
    `);
  }

  private tableColumns(tableName: string): Set<string> {
    try {
      return new Set(this.all(`pragma table_info(${tableName})`).map((row) => stringValue(row.name)).filter(Boolean));
    } catch {
      return new Set();
    }
  }

  private rebaselineSchemaMigration(): void {
    const rows = this.all("select version, name from schema_migrations order by version");
    if (
      rows.length === 1 &&
      numberValue(rows[0].version) === BUSINESS_SCHEMA_VERSION &&
      stringValue(rows[0].name) === BUSINESS_SCHEMA_NAME
    ) {
      return;
    }
    this.db.exec("begin immediate;");
    try {
      this.run("delete from schema_migrations");
      this.run(
        "insert into schema_migrations(version, name, applied_at) values (?, ?, datetime('now'))",
        BUSINESS_SCHEMA_VERSION,
        BUSINESS_SCHEMA_NAME,
      );
      this.db.exec("commit;");
    } catch (error) {
      this.db.exec("rollback;");
      throw error;
    }
  }
}

function rowToSemester(row: Row): SemesterWorkspace {
  return {
    ...rawJson<SemesterWorkspace>(row.raw_json, {}),
    id: stringValue(row.id),
    semesterNo: stringValue(row.semester_no),
    term: stringValue(row.term),
    folderName: stringValue(row.folder_name),
    startsAt: nullableString(row.starts_at),
    endsAt: nullableString(row.ends_at),
    source: semesterSource(row.source),
    recognizedAt: nullableString(row.recognized_at),
    archivedAt: nullableString(row.archived_at),
  };
}

function rowToCourse(row: Row): Course {
  const schedule = rawJson<{ meetingTime?: string; location?: string }>(row.schedule_json, {});
  const raw = rawJson<Course>(row.raw_json, {});
  return {
    term: "",
    color: "#111827",
    description: "",
    ...raw,
    id: stringValue(row.id),
    semesterId: stringValue(row.semester_id),
    code: stringValue(row.code),
    name: stringValue(row.name),
    instructor: stringValue(row.instructor),
    workspaceKind: stringValue(row.workspace_kind) as Course["workspaceKind"],
    meetingTime: schedule.meetingTime,
    location: schedule.location,
    archivedAt: nullableString(row.archived_at),
  };
}

function rowToTask(row: Row): BrevynTask {
  const raw = rawJson<BrevynTask>(row.raw_json, {});
  return {
    summary: "",
    ...raw,
    id: stringValue(row.id),
    semesterId: stringValue(row.semester_id),
    courseId: stringValue(row.course_id),
    title: stringValue(row.title),
    taskType: stringValue(row.task_type) as TaskType,
    dueAt: nullableString(row.due_at),
    status: stringValue(row.status) as TaskStatus,
    archivedAt: nullableString(row.archived_at),
  };
}

function rowToThread(row: Row): Thread {
  const raw = rawJson<Partial<Thread>>(row.raw_json, {});
  const courseId = stringValue(row.course_id);
  const taskId = nullableString(row.task_id);
  return {
    ...raw,
    id: stringValue(row.id),
    semesterId: stringValue(row.semester_id),
    courseId,
    taskId,
    threadType: courseId === SEMESTER_HOME_COURSE_ID ? "semester_home" : "task",
    title: stringValue(row.title),
    sdkSessionId: nullableString(raw.sdkSessionId),
    isDraft: Boolean(raw.isDraft),
    messageCount: numberValue(raw.messageCount),
    lastMessageAt: nullableString(raw.lastMessageAt),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
    archivedAt: nullableString(row.archived_at) || raw.archivedAt,
  };
}

function threadBusinessJson(thread: Thread): Thread {
  return thread;
}

function canAutoRenameThread(thread: Thread, options?: { allowAfterFirstMessage?: boolean }): boolean {
  if (!options?.allowAfterFirstMessage && (thread.messageCount || 0) > 1) return false;
  if (thread.titleSource === "default") return true;
  if (thread.titleSource) return false;
  return isDefaultThreadTitle(thread.title);
}

function isDefaultThreadTitle(title: string): boolean {
  const normalized = title.trim();
  return normalized === "Home TaskAgent" ||
    normalized === "Home session" ||
    normalized === "学期总览" ||
    normalized === "学期会话" ||
    normalized === "新的学期会话" ||
    normalized === "Task session" ||
    normalized.endsWith(" session") ||
    normalized.endsWith(" thread");
}

function fileBusinessJson(file: WorkspaceFileNode): Partial<WorkspaceFileNode> {
  const {
    children: _children,
    indexingStatus: _indexingStatus,
    indexingProgress: _indexingProgress,
    indexingError: _indexingError,
    indexingWarning: _indexingWarning,
    indexingParser: _indexingParser,
    indexingParserDetail: _indexingParserDetail,
    indexingUpdatedAt: _indexingUpdatedAt,
    indexedAt: _indexedAt,
    ...raw
  } = file;
  return raw;
}

function rowsToFileTree(rows: Row[]): WorkspaceFileNode[] {
  const entries = rows.map((row) => {
    const node = rowToWorkspaceFileNode(row);
    return { node, parentId: nullableString(row.parent_id) };
  });
  const byId = new Map(entries.map((entry) => [entry.node.id, entry.node]));
  const roots: WorkspaceFileNode[] = [];
  for (const entry of entries) {
    const parent = entry.parentId ? byId.get(entry.parentId) : undefined;
    if (parent) {
      parent.children ||= [];
      parent.children.push(entry.node);
    } else {
      roots.push(entry.node);
    }
  }
  return roots;
}

function rowToWorkspaceFileNode(row: Row): WorkspaceFileNode {
  const raw = rawJson<WorkspaceFileNode>(row.raw_json, {});
  const indexing = fileIndexingStatusFromRow(row);
  return {
    ...raw,
    id: stringValue(row.id),
    semesterId: stringValue(row.semester_id),
    courseId: stringValue(row.course_id),
    taskId: nullableString(row.task_id),
    taskFileBucket: nullableString(row.task_file_bucket) as WorkspaceFileNode["taskFileBucket"],
    sectionKind: nullableString(row.section_kind) as WorkspaceFileNode["sectionKind"],
    weekNumber: positiveNumberValue(row.week_number),
    sourcePath: nullableString(row.source_path),
    name: stringValue(row.name),
    path: stringValue(row.path),
    kind: stringValue(row.kind) as WorkspaceFileKind,
    indexingStatus: indexing.status,
    indexingProgress: indexing.progress,
    indexingError: indexing.error,
    indexingWarning: indexing.warning,
    indexingParser: indexing.parser,
    indexingParserDetail: indexing.parserDetail,
    indexingUpdatedAt: indexing.updatedAt,
    indexedAt: nullableString(row.indexed_at),
    updatedAt: stringValue(row.updated_at),
    children: stringValue(row.kind) === "folder" ? [] : undefined,
  };
}

function rowToExternalSource(row: Row): ExternalSource {
  return {
    ...rawJson<ExternalSource>(row.raw_json, {}),
    id: stringValue(row.id),
    semesterId: stringValue(row.semester_id),
    courseId: stringValue(row.course_id),
    taskId: nullableString(row.task_id),
    scope: stringValue(row.scope) === "task" ? "task" : "course",
    kind: stringValue(row.kind) === "web" ? "web" : "file",
    title: stringValue(row.title),
    url: nullableString(row.url),
    originalPath: nullableString(row.original_path),
    markdownPath: nullableString(row.markdown_path),
    workspaceFileId: nullableString(row.workspace_file_id),
    status: externalSourceStatus(row.status),
    summary: nullableString(row.summary),
    error: nullableString(row.error),
    addedBy: stringValue(row.added_by) === "agent" ? "agent" : "user",
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function rowToSourceCandidate(row: Row): SourceCandidate {
  return {
    ...rawJson<SourceCandidate>(row.raw_json, {}),
    id: stringValue(row.id),
    semesterId: stringValue(row.semester_id),
    courseId: stringValue(row.course_id),
    taskId: nullableString(row.task_id),
    threadId: nullableString(row.thread_id),
    scope: stringValue(row.scope) === "course" ? "course" : "task",
    url: stringValue(row.url),
    normalizedUrl: nullableString(row.normalized_url),
    title: stringValue(row.title),
    siteName: nullableString(row.site_name),
    snippet: nullableString(row.snippet),
    reason: stringValue(row.reason),
    status: sourceCandidateStatus(row.status),
    externalSourceId: nullableString(row.external_source_id),
    error: nullableString(row.error),
    proposedBy: "agent",
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function externalSourceStatus(value: unknown): ExternalSourceStatus {
  const status = stringValue(value);
  if (status === "ready" || status === "failed") return status;
  return "processing";
}

function sourceCandidateStatus(value: unknown): SourceCandidateStatus {
  const status = stringValue(value);
  if (status === "accepting" || status === "accepted" || status === "rejected" || status === "failed") return status;
  return "pending";
}

function workspaceFilesWithLatestIndexingSql(): string {
  return `select workspace_files.*,
                 latest_task.status as indexing_task_status,
                 latest_task.progress as indexing_task_progress,
                 latest_task.error as indexing_task_error,
                 latest_task.payload_json as indexing_task_payload_json,
                 latest_task.updated_at as indexing_task_updated_at
          from workspace_files
          left join indexing_tasks latest_task
            on latest_task.id = (
              select id from indexing_tasks
              where indexing_tasks.file_id = workspace_files.id
              order by indexing_tasks.updated_at desc, indexing_tasks.created_at desc
              limit 1
            )`;
}

function fileIndexingStatusFromRow(row: Row): {
  status: FileIndexingStatus;
  progress?: number;
  error?: string;
  warning?: string;
  parser?: string;
  parserDetail?: string;
  updatedAt?: string;
} {
  if (stringValue(row.kind) === "folder") {
    return { status: "idle" };
  }
  const taskStatus = nullableString(row.indexing_task_status);
  const result = rawJson<{ result?: { chunkCount?: number; warnings?: string[]; metadata?: Record<string, unknown> } }>(row.indexing_task_payload_json, {});
  const warnings = Array.isArray(result.result?.warnings) ? result.result.warnings.filter(Boolean) : [];
  const metadata = result.result?.metadata || {};
  const coverageStatus = typeof metadata.coverageStatus === "string" ? metadata.coverageStatus : "";
  const parser = typeof metadata.parser === "string" ? metadata.parser : "";
  const parserDetail = indexingParserDetail(metadata);
  const progress = numberValue(row.indexing_task_progress);
  const updatedAt = nullableString(row.indexing_task_updated_at) || nullableString(row.indexed_at);
  if (taskStatus === "queued") return { status: "queued", progress, parser, parserDetail, updatedAt };
  if (taskStatus === "running") return { status: "indexing", progress, parser, parserDetail, updatedAt };
  if (taskStatus === "failed") return { status: "failed", progress, error: nullableString(row.indexing_task_error), parser, parserDetail, updatedAt };
  if (taskStatus === "cancelled") return { status: "cancelled", progress, parser, parserDetail, updatedAt };
  if (taskStatus === "done") {
    const chunkCount = result.result?.chunkCount || 0;
    const message = coverageWarningMessage(metadata, warnings);
    if (chunkCount === 0 && warnings.length > 0) {
      return { status: "skipped", progress: 100, warning: warnings[0], parser, parserDetail, updatedAt };
    }
    if (coverageStatus === "partial") {
      return { status: "partial", progress: 100, warning: message || warnings[0], parser, parserDetail, updatedAt };
    }
    return { status: "indexed", progress: 100, warning: message, parser, parserDetail, updatedAt };
  }
  return nullableString(row.indexed_at) ? { status: "indexed", progress: 100, parser, parserDetail, updatedAt } : { status: "idle", parser, parserDetail };
}

function coverageWarningMessage(metadata: Record<string, unknown>, warnings: string[]): string | undefined {
  const total = numberValue(metadata.sectionsTotal) || 0;
  const indexed = numberValue(metadata.sectionsIndexed) || 0;
  const empty = numberValue(metadata.sectionsEmpty) || 0;
  const failed = numberValue(metadata.sectionsFailed) || 0;
  const unit = typeof metadata.sectionUnit === "string" && metadata.sectionUnit.trim() ? metadata.sectionUnit.trim() : "个部分";
  const parts: string[] = [];
  if (total > 0 && indexed > 0) parts.push(`已索引 ${indexed}/${total} ${unit}`);
  if (failed > 0) parts.push(`${failed} ${unit}解析失败`);
  if (empty > 0) parts.push(`${empty} ${unit}没有可提取文字`);
  const truncated = metadata.truncated === true;
  if (truncated) parts.push("文本超过上限，已截断");
  const documentParseWarning = warnings.find((warning) => warning.includes("MinerU document parsing"));
  if (parts.length > 0) return [parts.join(" · "), documentParseWarning].filter(Boolean).join(" · ");
  if (documentParseWarning) return documentParseWarning;
  return warnings[0];
}

function indexingParserDetail(metadata: Record<string, unknown>): string | undefined {
  const parser = typeof metadata.parser === "string" ? metadata.parser.trim() : "";
  if (!parser) return undefined;
  const documentProvider = typeof metadata.documentParseProvider === "string" ? metadata.documentParseProvider.trim() : "";
  const documentModel = typeof metadata.documentParseModel === "string" ? metadata.documentParseModel.trim() : "";
  const ocrProvider = typeof metadata.ocrProvider === "string" ? metadata.ocrProvider.trim() : "";
  const ocrModel = typeof metadata.ocrModel === "string" ? metadata.ocrModel.trim() : "";
  if (documentProvider || documentModel) {
    return [parser, documentProvider, documentModel].filter(Boolean).join(" · ");
  }
  if (ocrProvider || ocrModel) {
    return [parser, ocrProvider, ocrModel].filter(Boolean).join(" · ");
  }
  return parser;
}

function shouldRetryIndexingError(message: string): boolean {
  const normalized = message.toLowerCase();
  if (!normalized.trim()) return false;
  if (
    normalized.includes("no embedding provider") ||
    normalized.includes("no api key") ||
    normalized.includes("api key is available") ||
    normalized.includes("embedding model is required") ||
    normalized.includes("invalid model") ||
    normalized.includes("model_not_found") ||
    normalized.includes("not found model") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("401") ||
    normalized.includes("403") ||
    normalized.includes("invalidparameter") ||
    normalized.includes("invalid parameter") ||
    normalized.includes("invalid_request") ||
    normalized.includes("unsupported") ||
    normalized.includes("legacy .doc") ||
    normalized.includes("legacy .ppt") ||
    normalized.includes("larger than")
  ) {
    return false;
  }
  return (
    normalized.includes("429") ||
    normalized.includes("408") ||
    normalized.includes("500") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504") ||
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enotfound") ||
    normalized.includes("network") ||
    normalized.includes("rate limit") ||
    normalized.includes("temporar") ||
    normalized.includes("overloaded") ||
    normalized.includes("try again") ||
    normalized.includes("terminated")
  );
}

function rowToTimetableEvent(row: Row): TimetableEvent {
  return {
    ...rawJson<TimetableEvent>(row.raw_json, {}),
    id: stringValue(row.id),
    semesterId: stringValue(row.semester_id),
    courseId: nullableString(row.course_id),
    taskId: nullableString(row.task_id),
    title: stringValue(row.title),
    kind: stringValue(row.kind) as TimetableEventKind,
    source: stringValue(row.source) as TimetableEventSource,
    startsAt: stringValue(row.starts_at),
    endsAt: nullableString(row.ends_at),
    location: nullableString(row.location),
    notes: nullableString(row.notes),
  };
}

function rowToIndexingJob(row: Row): IndexingJob {
  return {
    id: stringValue(row.id),
    semesterId: stringValue(row.semester_id),
    courseId: stringValue(row.course_id),
    sectionId: nullableString(row.section_id),
    status: stringValue(row.status) as IndexingJob["status"],
    stage: nullableString(row.stage),
    embeddingModel: stringValue(row.embedding_model),
    embeddingProviderFingerprint: nullableString(row.embedding_provider_fingerprint),
    indexedFiles: numberValue(row.indexed_files) || 0,
    totalFiles: numberValue(row.total_files) || 0,
    completedFiles: numberValue(row.completed_files) || 0,
    progress: numberValue(row.progress) || 0,
    error: nullableString(row.error),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function rowToIndexingTask(row: Row): IndexingTaskRecord {
  return {
    id: stringValue(row.id),
    jobId: stringValue(row.job_id),
    semesterId: stringValue(row.semester_id),
    courseId: stringValue(row.course_id),
    sectionId: nullableString(row.section_id),
    fileId: stringValue(row.file_id),
    kind: stringValue(row.kind) as IndexingTaskRecord["kind"],
    status: stringValue(row.status) as IndexingTaskRecord["status"],
    attempts: numberValue(row.attempts) || 0,
    maxAttempts: numberValue(row.max_attempts) || DEFAULT_INDEXING_TASK_MAX_ATTEMPTS,
    lockedBy: nullableString(row.locked_by),
    lockedUntil: nullableString(row.locked_until),
    nextRunAt: stringValue(row.next_run_at),
    progress: numberValue(row.progress) || 0,
    error: nullableString(row.error),
    payload: rawJson<IndexingTaskRecord["payload"]>(row.payload_json, {}) as IndexingTaskRecord["payload"],
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

function rowToRagTextSearchResult(row: Row): RagTextSearchResult {
  return {
    id: stringValue(row.id),
    semesterId: stringValue(row.semester_id),
    courseId: stringValue(row.course_id),
    sectionId: stringValue(row.section_id),
    fileId: stringValue(row.file_id),
    taskId: nullableString(row.task_id),
    fileName: stringValue(row.file_name),
    filePath: stringValue(row.file_path),
    sourcePath: nullableString(row.source_path),
    title: stringValue(row.title),
    citation: stringValue(row.citation),
    text: stringValue(row.text),
    chunkIndex: numberValue(row.chunk_index),
    chunkCount: numberValue(row.chunk_count),
    sourceLabel: nullableString(row.source_label),
    sectionType: nullableString(row.section_type),
    sectionTitle: nullableString(row.section_title),
    artifactId: nullableString(row.artifact_id),
    semanticUnitId: nullableString(row.semantic_unit_id),
    elementIds: objectAnchorElementIds(row.section_type, row.element_ids),
    page: positiveNumberValue(row.page),
    slide: positiveNumberValue(row.slide),
    sheet: nullableString(row.sheet),
    range: nullableString(row.range),
    bbox: nullableString(row.bbox),
    rank: numberValue(row.rank) ?? 0,
  };
}

function flattenFileTree(files: WorkspaceFileNode[], parentId?: string): Array<{ node: WorkspaceFileNode; parentId?: string }> {
  return files.flatMap((node) => [
    { node, parentId },
    ...flattenFileTree(node.children || [], node.id),
  ]);
}

function rawJson<T>(value: unknown, fallback: Partial<T>): Partial<T> {
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as Partial<T>;
  } catch {
    return fallback;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function nullableString(value: unknown): string | undefined {
  const text = stringValue(value);
  return text ? text : undefined;
}

function commaSeparatedStrings(value: unknown): string[] | undefined {
  const values = stringValue(value).split(",").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function objectAnchorElementIds(sectionType: unknown, value: unknown): string[] | undefined {
  const type = stringValue(sectionType);
  return type === "chart" || type === "shape" || type === "image" ? commaSeparatedStrings(value) : undefined;
}

function semesterSource(value: unknown): SemesterWorkspace["source"] {
  const source = stringValue(value);
  if (source === "vision") return "vision";
  return source === "filesystem" ? "filesystem" : "manual";
}

function numberValue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumberValue(value: unknown): number | undefined {
  const parsed = numberValue(value);
  return parsed && parsed > 0 ? parsed : undefined;
}

function intBool(value: boolean): number {
  return value ? 1 : 0;
}

function boolValue(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

function fts5Query(value: string): string {
  const terms = value
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, 12);
  return terms.map(quoteFts5Term).join(" OR ");
}

function quoteFts5Term(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function openDatabase(dbPath: string): SQLiteDatabaseSync {
  try {
    const sqlite = require("node:sqlite") as SQLiteModule;
    return new sqlite.DatabaseSync(dbPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`node:sqlite is unavailable in this Electron runtime: ${detail}`);
  }
}
