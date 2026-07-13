import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrevynTask, Course, IndexingJob, SemesterWorkspace, Thread } from "../../types/domain";
import type { IndexingTaskInsert, IndexingWorkerResult } from "../indexing";
import { SQLiteBusinessStore } from "./sqlite-business-store";

const require = createRequire(__filename);

runStorageRoundTripTest();
runCleanBaselineResetTest();

console.log("sqlite-business-store tests passed");

function runStorageRoundTripTest(): void {
  const tempDir = mkdtempSync(join(tmpdir(), "brevyn-business-store-"));
  const store = new SQLiteBusinessStore(join(tempDir, "business.sqlite"));

  try {
    store.saveSemester(testSemester());
    store.saveCourse(testCourse());
    const task = testTask();
    store.saveTask(task);

    assert.equal(store.listTasks("semester_test", "course_test").length, 1);
    const archivedTask = store.archiveTask(task.id, "2026-05-25T00:00:00.000Z");
    assert.equal(archivedTask?.archivedAt, "2026-05-25T00:00:00.000Z");
    assert.equal(store.listTasks("semester_test", "course_test").length, 0);
    assert.equal(store.listArchivedTasks("semester_test", "course_test").length, 1);
    const restoredTask = store.restoreTask(task.id);
    assert.equal(restoredTask?.archivedAt, undefined);
    assert.equal(store.listTasks("semester_test", "course_test").length, 1);
    const renamedTask = store.updateTask({ id: task.id, title: "Final Essay", taskType: "Essay" });
    assert.equal(renamedTask?.id, task.id);
    assert.equal(renamedTask?.title, "Final Essay");
    assert.equal(renamedTask?.taskType, "Essay");
    assert.equal(store.getTask(task.id)?.title, "Final Essay");
    const taskWithInfo = store.updateTask({
      id: task.id,
      dueAt: "2026-06-01T23:59:00+08:00",
      summary: "Submit a referenced final essay.",
      info: {
        deliverable: "Final essay",
        requirements: [{
          id: "requirement_1",
          category: "limit",
          text: "1,500 words",
          source: { fileId: "brief-file", fileName: "brief.pdf", page: 1 },
        }, {
          id: "requirement_user_1",
          category: "format",
          text: "Use a readable 12-point font",
        }],
        rubricCriteria: [{
          id: "rubric_user_1",
          title: "Organization",
          points: 20,
        }],
        documents: [{ fileId: "brief-file", fileName: "brief.pdf", role: "brief" }],
        extractedAt: "2026-05-25T00:00:06.000Z",
        updatedBy: "agent",
      },
    });
    assert.equal(taskWithInfo?.info?.requirements[0]?.text, "1,500 words");
    assert.equal(taskWithInfo?.info?.requirements[1]?.source, undefined);
    assert.equal(store.getTask(task.id)?.info?.rubricCriteria[0]?.title, "Organization");
    assert.equal(store.getTask(task.id)?.info?.documents[0]?.role, "brief");

    const thread = testThread();
    store.saveThread(thread);
    store.recordThreadMessage(thread.id, "2026-05-25T00:00:01.000Z");
    store.recordThreadMessage(thread.id, "2026-05-25T00:00:02.000Z");

    assert.equal(store.renameThreadAutomatically(thread.id, "Should Not Apply"), null);

    const updated = store.renameThreadAutomatically(thread.id, "宏观经济研读", "2026-05-25T00:00:03.000Z", {
      allowAfterFirstMessage: true,
    });
    assert.equal(updated?.title, "宏观经济研读");
    assert.equal(updated?.titleSource, "auto");
    const withSdkSession = store.updateThreadSdkSessionId(thread.id, "sdk-session-123");
    assert.equal(withSdkSession?.sdkSessionId, "sdk-session-123");
    assert.equal(store.getThread(thread.id)?.sdkSessionId, "sdk-session-123");
    const clearedSdkSession = store.updateThreadSdkSessionId(thread.id, undefined);
    assert.equal(clearedSdkSession?.sdkSessionId, undefined);
    assert.equal(store.getThread(thread.id)?.sdkSessionId, undefined);

    const manualThread = testThread("thread_manual");
    store.saveThread(manualThread);
    store.renameThread(manualThread.id, "用户自定义标题");
    assert.equal(
      store.renameThreadAutomatically(manualThread.id, "Should Not Override", "2026-05-25T00:00:04.000Z", {
        allowAfterFirstMessage: true,
      }),
      null,
    );

    const indexingJob = testIndexingJob();
    store.createIndexingJob(indexingJob, [testIndexingTask("idx-task-1", indexingJob.id, "file-a")]);
    const appendedJob = store.appendIndexingTasksToJob(indexingJob.id, [
      testIndexingTask("idx-task-duplicate-existing", indexingJob.id, "file-a"),
      testIndexingTask("idx-task-2", indexingJob.id, "file-b"),
      testIndexingTask("idx-task-duplicate-incoming", indexingJob.id, "file-b"),
    ]);
    assert.equal(appendedJob?.totalFiles, 2);
    store.completeIndexingTask("idx-task-1", testIndexingResult("file-a"));
    store.completeIndexingTask("idx-task-2", testIndexingResult("file-b"));
    const completedIndexing = store.latestCompletedIndexingRecords("semester_test", "course_test");
    assert.equal(completedIndexing.get("file-a")?.fingerprint, "provider-test|openai_embedding|custom-openai|openai_compatible|https://embedding.example/v1|text-embedding-test");
    assert.equal(completedIndexing.get("file-b")?.fingerprint, "provider-test|openai_embedding|custom-openai|openai_compatible|https://embedding.example/v1|text-embedding-test");
    assert.ok(Date.parse(completedIndexing.get("file-a")?.completedAt || "") > 0);
    assert.equal(store.latestCompletedIndexingRecords("semester_test", "other-course").size, 0);
    const cancelledJob: IndexingJob = {
      ...indexingJob,
      id: "index_cancelled",
      embeddingProviderFingerprint: "provider-new|openai_embedding|custom-openai|openai_compatible|https://embedding.example/v2|text-embedding-new",
      createdAt: "2026-05-25T00:00:05.000Z",
      updatedAt: "2026-05-25T00:00:05.000Z",
    };
    store.createIndexingJob(cancelledJob, [testIndexingTask("idx-task-cancelled", cancelledJob.id, "file-a")]);
    store.cancelIndexingJob(cancelledJob.id);
    assert.equal(
      store.latestCompletedIndexingRecords("semester_test", "course_test").get("file-a")?.fingerprint,
      indexingJob.embeddingProviderFingerprint,
      "a cancelled rebuild must not replace the last usable index fingerprint",
    );

    store.upsertRagTextChunks([
      {
        id: "file-a:0",
        semesterId: "semester_test",
        courseId: "course_test",
        sectionId: "course_test:shared",
        fileId: "file-a",
        fileName: "rubric.pdf",
        filePath: "/course/rubric.pdf",
        sourcePath: "/tmp/rubric.pdf",
        kind: "pdf",
        weekNumber: -1,
        taskFileBucket: "",
        chunkIndex: 0,
        chunkCount: 1,
        title: "Essay rubric",
        citation: "rubric.pdf · page 1",
        text: "The assessment rubric explains word count and deadline requirements.",
        parser: "test",
        coverageStatus: "complete",
        ocrApplied: false,
        sourceLabel: "page 1",
        sectionType: "chart",
        sectionTitle: "Assessment rubric",
        sectionIndex: 1,
        chunkInSection: 1,
        chunksInSection: 1,
        semanticUnitId: "artifact-1:sheet-1:chart-1:unit",
        elementIds: "artifact-1:sheet-1:chart-1",
        createdAt: "2026-05-25T00:00:00.000Z",
        updatedAt: "2026-05-25T00:00:00.000Z",
      },
    ]);
    const ragMatches = store.searchRagTextChunks({ query: "rubric deadline", semesterId: "semester_test", courseId: "course_test" });
    assert.equal(ragMatches.length, 1);
    assert.equal(ragMatches[0].fileId, "file-a");
    assert.deepEqual(ragMatches[0].elementIds, ["artifact-1:sheet-1:chart-1"]);
    store.deleteRagTextChunksByFile("file-a");
    assert.equal(store.searchRagTextChunks({ query: "rubric", semesterId: "semester_test", courseId: "course_test" }).length, 0);
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function runCleanBaselineResetTest(): void {
  const tempDir = mkdtempSync(join(tmpdir(), "brevyn-business-store-reset-"));
  const dbPath = join(tempDir, "business.sqlite");

  createLegacyBusinessDatabase(dbPath);
  const store = new SQLiteBusinessStore(dbPath);

  try {
    assert.equal(store.status().schemaVersion, 1);
    assert.equal(currentMigrationName(dbPath), "business_schema_v1_clean_baseline");
    assert.equal(store.listSemesters().length, 0);
    assert.equal(tableExists(dbPath, "reference_items"), false);
    assert.equal(tableExists(dbPath, "semesters"), true);

    store.saveSemester(testSemester());
    assert.equal(store.listSemesters().length, 1);
  } finally {
    store.close();
  }

  const retainedStore = new SQLiteBusinessStore(dbPath);
  try {
    assert.equal(retainedStore.listSemesters().length, 1);
  } finally {
    retainedStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function createLegacyBusinessDatabase(dbPath: string): void {
  const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => SQLiteDatabaseSync };
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      create table schema_migrations (
        version integer primary key,
        name text not null,
        applied_at text not null
      );
      insert into schema_migrations(version, name, applied_at)
      values (1, 'business_schema_v1_legacy', '2026-05-25T00:00:00.000Z');

      create table semesters (
        id text primary key,
        semester_no text not null,
        term text not null,
        folder_name text not null,
        source text not null,
        raw_json text not null default '{}',
        created_at text not null,
        updated_at text not null
      );
      insert into semesters(id, semester_no, term, folder_name, source, raw_json, created_at, updated_at)
      values ('old_semester', 'old', 'Old Term', 'Old Term', 'manual', '{}', '2026-05-25T00:00:00.000Z', '2026-05-25T00:00:00.000Z');

      create table reference_items (
        id text primary key,
        title text not null
      );
      insert into reference_items(id, title) values ('old_reference', 'Old reference');
    `);
  } finally {
    db.close();
  }
}

function tableExists(dbPath: string, tableName: string): boolean {
  const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => SQLiteDatabaseSync };
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    const row = db.prepare("select name from sqlite_master where type = 'table' and name = ?").get(tableName);
    return Boolean(row);
  } finally {
    db.close();
  }
}

function currentMigrationName(dbPath: string): string | undefined {
  const sqlite = require("node:sqlite") as { DatabaseSync: new (path: string) => SQLiteDatabaseSync };
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    const row = db.prepare("select name from schema_migrations order by version desc limit 1").get() as { name?: string } | undefined;
    return row?.name;
  } finally {
    db.close();
  }
}

type SQLiteStatementSync = {
  get: (...params: unknown[]) => unknown;
};

type SQLiteDatabaseSync = {
  close: () => void;
  exec: (sql: string) => void;
  prepare: (sql: string) => SQLiteStatementSync;
};

function testThread(id = "thread_title_race"): Thread {
  return {
    id,
    semesterId: "semester_test",
    courseId: "course_test",
    threadType: "task",
    title: "学期会话",
    titleSource: "default",
    isDraft: true,
    messageCount: 1,
    createdAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
  };
}

function testSemester(): SemesterWorkspace {
  return {
    id: "semester_test",
    semesterNo: "test",
    term: "Test Term",
    folderName: "Test Term",
    source: "manual",
  };
}

function testCourse(): Course {
  return {
    id: "course_test",
    semesterId: "semester_test",
    name: "Test Course",
    code: "TEST100",
    term: "Test Term",
    instructor: "",
    color: "#d8c7a1",
    description: "",
  };
}

function testTask(): BrevynTask {
  return {
    id: "task_test",
    semesterId: "semester_test",
    courseId: "course_test",
    title: "Reading response",
    taskType: "作业",
    status: "not_started",
    summary: "",
  };
}

function testIndexingJob(): IndexingJob {
  return {
    id: "index_test",
    semesterId: "semester_test",
    courseId: "course_test",
    sectionId: "course_test:shared",
    status: "queued",
    stage: "queued",
    embeddingModel: "text-embedding-test",
    embeddingProviderFingerprint: "provider-test|openai_embedding|custom-openai|openai_compatible|https://embedding.example/v1|text-embedding-test",
    indexedFiles: 0,
    totalFiles: 1,
    completedFiles: 0,
    progress: 0,
    createdAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
  };
}

function testIndexingResult(fileId: string): IndexingWorkerResult {
  return {
    fileId,
    sourcePath: `/tmp/${fileId}.pdf`,
    chunkCount: 1,
    charCount: 12,
    byteCount: 12,
    sample: "test content",
    warnings: [],
    chunks: ["test content"],
  };
}

function testIndexingTask(id: string, jobId: string, fileId: string): IndexingTaskInsert {
  return {
    id,
    jobId,
    semesterId: "semester_test",
    courseId: "course_test",
    sectionId: "course_test:shared",
    fileId,
    kind: "parse_chunk",
    payload: {
      semesterId: "semester_test",
      courseId: "course_test",
      sectionId: "course_test:shared",
      fileId,
      name: `${fileId}.pdf`,
      path: `/course/${fileId}.pdf`,
      sourcePath: `/tmp/${fileId}.pdf`,
      kind: "pdf",
    },
  };
}
