import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type * as ClaudeAgentSdk from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  BrevynTask,
  Course,
  CourseTaskDocument,
  CourseTaskInfo,
  CourseTaskRequirement,
  CourseTaskRubricCriterion,
  CourseTaskSourceAnchor,
  CourseFileSectionKind,
  RagSearchResult,
  SemesterWorkspace,
  SourceCandidateProposeInput,
  SourceCandidateProposeResult,
  Thread,
  WorkspaceFileNode,
} from "../../types/domain";
import type { SQLiteBusinessStore } from "../storage";
import { getBrevynAppVersion } from "../app-version";
import { flattenFiles } from "../services/workspace-file-tree";
import { inspectLibreOfficeRuntime } from "../services/libreoffice-runtime";
import {
  SEMESTER_HOME_COURSE_ID,
  TASK_FILE_BUCKETS,
  courseWorkspaceDir,
  sanitizeFsSegment,
  semesterWorkspaceDir,
  taskBucketLabel,
  taskWorkspaceDirForTask,
} from "../services/workspace-paths";
import { BREVYN_MCP_SERVER, getBrevynMcpTool } from "../../shared/brevyn-mcp-catalog";
import { mergeAgentCourseTaskInfo } from "../../shared/course-task-info";

const PARSED_DOCUMENTS_FOLDER = "Parsed";
const AGENT_WORKSPACE_MEMORY_FILE = "CLAUDE.md";

export interface BrevynMcpContext {
  thread: Thread;
  semester: SemesterWorkspace;
  course: Course | null;
  task: BrevynTask | null;
  cwd: string;
}

export interface BrevynMcpServerOptions {
  sdk: ClaudeSdkRuntime;
  rootDataDir: string;
  businessStore: SQLiteBusinessStore;
  ragSearch?: (input: { query: string; courseId?: string; taskId?: string; sectionKind?: CourseFileSectionKind; limit?: number }) => Promise<RagSearchResult[]>;
  proposeExternalSource?: (input: SourceCandidateProposeInput) => SourceCandidateProposeResult;
  onTaskUpdated?: (task: BrevynTask) => void;
  context: BrevynMcpContext;
}

type ClaudeSdkRuntime = typeof ClaudeAgentSdk;

const SECTION_SCHEMA = z.enum(["course_shared", "lecture", "task"]);
const SOURCE_SCOPE_SCHEMA = z.enum(["task", "course"]);
const TASK_REQUIREMENT_CATEGORY_SCHEMA = z.enum(["limit", "format", "reference", "submission", "prohibition", "other"]);
const TASK_DOCUMENT_ROLE_SCHEMA = z.enum(["brief", "rubric", "supporting", "draft", "submission"]);
const TASK_SOURCE_ANCHOR_SCHEMA = z.object({
  fileId: z.string().min(1).describe("Visible Brevyn file id returned by list_course_files."),
  sourceLabel: z.string().optional().describe("Human-readable page, slide, section, or table label."),
  page: z.number().int().min(1).optional(),
  slide: z.number().int().min(1).optional(),
  sheet: z.string().optional(),
  range: z.string().optional(),
  semanticUnitId: z.string().optional(),
  bbox: z.string().optional(),
});
const DEFAULT_PARSED_FILE_MAX_CHARS = 60000;

export function createBrevynMcpServer(options: BrevynMcpServerOptions): McpServerConfig {
  const { sdk } = options;
  return sdk.createSdkMcpServer({
    name: BREVYN_MCP_SERVER.name,
    version: getBrevynAppVersion(),
    tools: [
      sdk.tool(
        "course_structure",
        getBrevynMcpTool("course_structure").runtimeDescription,
        {
          courseId: z.string().optional().describe("Optional course id in the current semester. Omit to use the current agent scope."),
        },
        async (args) => brevynToolResult(courseStructure(options, args.courseId)),
        { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      ),
      sdk.tool(
        "list_course_files",
        getBrevynMcpTool("list_course_files").runtimeDescription,
        {
          courseId: z.string().optional().describe("Optional course id in the current semester. Omit to use the current agent scope."),
          sectionKind: SECTION_SCHEMA.optional().describe("Optional semantic section filter: course_shared, lecture, or task."),
          taskId: z.string().optional().describe("Optional task id filter. In a task workspace, omitted filters default to the current task."),
          limit: z.number().int().min(1).max(200).optional().describe("Maximum records to return. Defaults to 80, max 200."),
        },
        async (args) => brevynToolResult(listCourseFiles(options, args)),
        { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      ),
      sdk.tool(
        "get_file_record",
        getBrevynMcpTool("get_file_record").runtimeDescription,
        {
          fileId: z.string().min(1).describe("Brevyn workspace file id returned by list_course_files."),
        },
        async (args) => brevynToolResult(getFileRecord(options, args.fileId)),
        { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      ),
      sdk.tool(
        "read_parsed_file",
        getBrevynMcpTool("read_parsed_file").runtimeDescription,
        {
          fileId: z.string().min(1).describe("Brevyn workspace file id returned by list_course_files or get_file_record."),
          offset: z.number().int().min(0).optional().describe("Character offset to start reading from. Defaults to 0."),
          maxChars: z.number().int().min(1000).max(120000).optional().describe("Maximum characters to return. Defaults to 60000, max 120000."),
        },
        async (args) => brevynToolResult(readParsedFile(options, args)),
        { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      ),
      sdk.tool(
        "rag_search",
        getBrevynMcpTool("rag_search").runtimeDescription,
        {
          query: z.string().min(1).describe("Natural language search query for course materials."),
          courseId: z.string().optional().describe("Optional course id in the current semester. Omit to use the current agent scope."),
          taskId: z.string().optional().describe("Optional task id filter. Omit to search the current course across lectures, shared materials, and task files."),
          sectionKind: SECTION_SCHEMA.optional().describe("Optional semantic section filter: course_shared, lecture, or task."),
          limit: z.number().int().min(1).max(12).optional().describe("Maximum evidence chunks to return. Defaults to 6, max 12."),
        },
        async (args) => brevynToolResult(await ragSearch(options, args)),
        { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      ),
      sdk.tool(
        "update_course_task_info",
        getBrevynMcpTool("update_course_task_info").runtimeDescription,
        {
          summary: z.string().min(1).max(1200).describe("Concise task summary grounded in the inspected sources."),
          dueAt: z.string().optional().describe("Confirmed ISO-8601 deadline. Omit when the source does not establish one."),
          deliverable: z.string().max(240).optional().describe("Confirmed submission or assessment form, such as essay, speech, report, or exam."),
          requirements: z.array(z.object({
            category: TASK_REQUIREMENT_CATEGORY_SCHEMA,
            text: z.string().min(1).max(800),
            source: TASK_SOURCE_ANCHOR_SCHEMA,
          })).max(80).default([]),
          rubricCriteria: z.array(z.object({
            title: z.string().min(1).max(240),
            description: z.string().max(1200).optional(),
            points: z.number().min(0).optional(),
            source: TASK_SOURCE_ANCHOR_SCHEMA,
          })).max(40).default([]),
          documents: z.array(z.object({
            fileId: z.string().min(1),
            role: TASK_DOCUMENT_ROLE_SCHEMA,
            sourceLabel: z.string().optional(),
          })).max(40).default([]),
        },
        async (args) => brevynToolResult(updateCourseTaskInfo(options, args)),
        { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      ),
      sdk.tool(
        "office_runtime",
        getBrevynMcpTool("office_runtime").runtimeDescription,
        {
          prepare: z.boolean().optional().describe("Initialize the bundled runtime when needed. Defaults to true."),
          selfTest: z.boolean().optional().describe("Run a real HTML-to-PDF smoke test after initialization. Defaults to false."),
        },
        async (args) => brevynToolResult(await inspectLibreOfficeRuntime(options.rootDataDir, {
          prepare: args.prepare !== false,
          selfTest: args.selfTest === true,
        })),
        { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      ),
      sdk.tool(
        "propose_external_source",
        getBrevynMcpTool("propose_external_source").runtimeDescription,
        {
          url: z.string().min(1).describe("Public web URL to propose."),
          title: z.string().min(1).describe("Human-readable source title."),
          reason: z.string().min(1).describe("Why this source is useful for the current course or task."),
          snippet: z.string().optional().describe("Short relevant excerpt or summary."),
          siteName: z.string().optional().describe("Website or publisher name."),
          scope: SOURCE_SCOPE_SCHEMA.optional().describe("Save target if accepted. Defaults to task in a task thread, otherwise course."),
        },
        async (args) => brevynToolResult(proposeExternalSource(options, args)),
        { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
      ),
    ],
  });
}

function updateCourseTaskInfo(
  options: BrevynMcpServerOptions,
  args: {
    summary: string;
    dueAt?: string;
    deliverable?: string;
    requirements: Array<{ category: CourseTaskRequirement["category"]; text: string; source: Omit<CourseTaskSourceAnchor, "fileName"> }>;
    rubricCriteria: Array<{ title: string; description?: string; points?: number; source: Omit<CourseTaskSourceAnchor, "fileName"> }>;
    documents: Array<{ fileId: string; role: CourseTaskDocument["role"]; sourceLabel?: string }>;
  },
) {
  const task = requireCurrentTask(options);
  const dueAt = normalizeConfirmedDueAt(args.dueAt);
  const extractedRequirements = args.requirements.map((item) => ({
    id: taskInfoItemId("requirement", `${item.category}:${item.text}`),
    category: item.category,
    text: item.text.trim(),
    source: resolveTaskSourceAnchor(options, task, item.source),
  }));
  const requirements = uniqueTaskRequirements([
    ...extractedRequirements,
    ...(task.info?.requirements.filter((item) => !item.source) || []),
  ]);
  const extractedRubricCriteria = args.rubricCriteria.map((item) => ({
    id: taskInfoItemId("rubric", item.title),
    title: item.title.trim(),
    description: item.description?.trim() || undefined,
    points: item.points,
    source: resolveTaskSourceAnchor(options, task, item.source),
  }));
  const rubricCriteria = uniqueRubricCriteria([
    ...extractedRubricCriteria,
    ...(task.info?.rubricCriteria.filter((item) => !item.source) || []),
  ]);
  const documents = uniqueTaskDocuments(args.documents.map((item) => {
    const file = requireTaskInfoSourceFile(options, task, item.fileId);
    return {
      fileId: file.id,
      fileName: file.name,
      role: item.role,
      sourceLabel: item.sourceLabel?.trim() || undefined,
    };
  }));
  const extractedAt = new Date().toISOString();
  const merged = mergeAgentCourseTaskInfo(task, {
    summary: args.summary,
    dueAt,
    deliverable: args.deliverable,
    requirements,
    rubricCriteria,
    documents,
    extractedAt,
  });
  const sourceCount = taskInfoSourceCount(merged.info);
  if (sourceCount === 0) {
    throw new Error("课程任务信息至少需要一个当前课程中的真实来源文件。");
  }
  const updated = options.businessStore.updateTask({
    id: task.id,
    ...merged,
  });
  if (!updated) throw new Error(`Task not found: ${task.id}`);
  options.onTaskUpdated?.(updated);
  return {
    type: "course_task_info_updated",
    task: compactTask(updated),
    counts: {
      requirements: requirements.length,
      rubricCriteria: rubricCriteria.length,
      sources: sourceCount,
    },
  };
}

function courseStructure(options: BrevynMcpServerOptions, requestedCourseId?: string) {
  const { context } = options;
  const courseId = resolveCourseId(options, requestedCourseId);
  if (courseId === SEMESTER_HOME_COURSE_ID) {
    const semesterDir = semesterWorkspaceDir(options.rootDataDir, context.semester.id);
    const courses = options.businessStore.listCourses(context.semester.id)
      .filter((course) => course.id !== SEMESTER_HOME_COURSE_ID && !course.archivedAt)
      .map((course) => ({
        id: course.id,
        name: course.name,
        code: course.code,
        instructor: course.instructor,
        path: courseWorkspaceDir(options.rootDataDir, context.semester.id, course.id),
      }));
    return {
      scope: "semester_home",
      cwd: context.cwd,
      semester: compactSemester(context.semester),
      roots: [
        root("semester_shared", join(semesterDir, "Semester shared"), "Shared files for the whole semester."),
        root("courses", join(semesterDir, "courses"), "Container for course workspaces."),
        root("threads", join(semesterDir, "threads"), "Agent JSONL conversation logs."),
      ],
      courses,
    };
  }

  const course = requireCourseInSemester(options, courseId);
  const tasks = options.businessStore.listTasks(context.semester.id, course.id);
  const courseDir = courseWorkspaceDir(options.rootDataDir, context.semester.id, course.id);
  return {
    scope: context.task && context.task.courseId === course.id ? "task" : "course",
    cwd: context.cwd,
    semester: compactSemester(context.semester),
    course: compactCourse(course),
    currentTask: context.task && context.task.courseId === course.id ? compactTask(context.task) : null,
    roots: [
      root("course_shared", join(courseDir, "Course shared"), "Reusable files for this course."),
      root("lecture", join(courseDir, "Lecture"), "Lecture notes, slides, and class materials."),
      root("task_root", join(courseDir, "Task"), "Container for task workspaces."),
    ],
    tasks: tasks.map((task) => ({
      ...compactTask(task),
      path: taskWorkspaceDirForTask(courseDir, task),
    })),
    currentTaskBuckets: context.task && context.task.courseId === course.id
      ? taskBuckets(courseDir, context.task)
      : [],
  };
}

function listCourseFiles(
  options: BrevynMcpServerOptions,
  args: { courseId?: string; sectionKind?: CourseFileSectionKind; taskId?: string; limit?: number },
) {
  const courseId = resolveCourseId(options, args.courseId);
  if (courseId !== SEMESTER_HOME_COURSE_ID) requireCourseInSemester(options, courseId);
  const files = flattenFiles(options.businessStore.listWorkspaceFiles(options.context.semester.id, courseId));
  const taskId = resolveTaskFilter(options, courseId, args);
  const filtered = files
    .filter((file) => file.kind !== "folder")
    .filter((file) => !isAgentWorkspaceControlFile(file))
    .filter((file) => !args.sectionKind || file.sectionKind === args.sectionKind)
    .filter((file) => !taskId || file.taskId === taskId);
  const limit = args.limit || 80;
  const records = filtered.slice(0, limit).map((file) => compactFile(file));
  return {
    semesterId: options.context.semester.id,
    courseId,
    defaultedToCurrentTask: Boolean(!args.courseId && !args.sectionKind && !args.taskId && options.context.task && courseId === options.context.task.courseId),
    filters: {
      sectionKind: args.sectionKind || null,
      taskId: taskId || null,
    },
    count: records.length,
    totalMatched: filtered.length,
    truncated: filtered.length > records.length,
    groups: groupCompactFiles(records),
    files: records,
  };
}

function getFileRecord(options: BrevynMcpServerOptions, fileId: string) {
  const file = options.businessStore.getWorkspaceFile(fileId);
  if (!file) throw new Error(`File not found: ${fileId}`);
  assertFileVisibleInContext(options, file);
  return {
    semesterId: options.context.semester.id,
    file: compactFile(file),
  };
}

function readParsedFile(
  options: BrevynMcpServerOptions,
  args: { fileId: string; offset?: number; maxChars?: number },
) {
  const file = options.businessStore.getWorkspaceFile(args.fileId);
  if (!file) throw new Error(`File not found: ${args.fileId}`);
  assertFileVisibleInContext(options, file);
  if (file.kind === "folder") throw new Error("文件夹没有可读取的解析文本。");
  if (!file.sourcePath || !existsSync(file.sourcePath)) throw new Error("原始文件路径不可用，无法定位解析文本。");
  const parsedTextPath = parsedDocumentContentPath(file.sourcePath, file.id);
  if (!existsSync(parsedTextPath)) {
    throw new Error("这个文件尚未生成解析文本。请先在资料库中索引/解析该文件，或改用原文件对应的读取流程。");
  }
  const artifactPath = parsedDocumentArtifactPath(file.sourcePath, file.id);
  const semanticUnitsPath = parsedDocumentSemanticUnitsPath(file.sourcePath, file.id);
  const content = readFileSync(parsedTextPath, "utf8");
  const offset = args.offset || 0;
  const maxChars = args.maxChars || DEFAULT_PARSED_FILE_MAX_CHARS;
  const chunk = content.slice(offset, offset + maxChars);
  return {
    type: "parsed_file",
    semesterId: options.context.semester.id,
    file: compactFile(file),
    parsedTextPath,
    artifactPath: existsSync(artifactPath) ? artifactPath : undefined,
    semanticUnitsPath: existsSync(semanticUnitsPath) ? semanticUnitsPath : undefined,
    hasOfficeArtifact: existsSync(artifactPath),
    offset,
    maxChars,
    charCount: content.length,
    returnedChars: chunk.length,
    nextOffset: offset + chunk.length < content.length ? offset + chunk.length : null,
    truncated: offset + chunk.length < content.length,
    content: chunk,
  };
}

async function ragSearch(
  options: BrevynMcpServerOptions,
  args: { query: string; courseId?: string; taskId?: string; sectionKind?: CourseFileSectionKind; limit?: number },
) {
  if (!options.ragSearch) throw new Error("RAG search is not available in this Brevyn runtime.");
  const courseId = resolveCourseId(options, args.courseId);
  const searchCourseId = courseId === SEMESTER_HOME_COURSE_ID ? undefined : courseId;
  if (searchCourseId) {
    requireCourseInSemester(options, searchCourseId);
  }
  const taskId = searchCourseId ? resolveExplicitTaskFilter(options, searchCourseId, args.taskId) : undefined;
  const limit = args.limit || 6;
  const results = await options.ragSearch({
    query: args.query,
    courseId: searchCourseId,
    taskId,
    sectionKind: args.sectionKind,
    limit,
  });
  return {
    query: args.query,
    filters: {
      scope: searchCourseId ? "course" : "semester",
      courseId: searchCourseId || null,
      taskId: taskId || null,
      sectionKind: args.sectionKind || null,
      limit,
    },
    count: results.length,
    results: results.map(compactRagResult),
  };
}

function resolveExplicitTaskFilter(
  options: BrevynMcpServerOptions,
  courseId: string,
  taskId?: string,
): string | undefined {
  if (!taskId) return undefined;
  const task = options.businessStore.getTask(taskId);
  if (!task || task.semesterId !== options.context.semester.id || task.courseId !== courseId) {
    throw new Error(`Task ${taskId} does not belong to this course.`);
  }
  return task.id;
}

function proposeExternalSource(
  options: BrevynMcpServerOptions,
  args: { url: string; title: string; reason: string; snippet?: string; siteName?: string; scope?: "task" | "course" },
) {
  if (!options.proposeExternalSource) throw new Error("External source candidates are not available in this Brevyn runtime.");
  if (!options.context.course) throw new Error("候选来源需要在具体课程或作业会话里提交。");
  const scope = args.scope || (options.context.task ? "task" : "course");
  if (scope === "task" && !options.context.task) throw new Error("当前不是作业会话，不能提交到作业范围。");
  const result = options.proposeExternalSource({
    courseId: options.context.course.id,
    taskId: scope === "task" ? options.context.task?.id : undefined,
    threadId: options.context.thread.id,
    scope,
    url: args.url,
    title: args.title,
    reason: args.reason,
    snippet: args.snippet,
    siteName: args.siteName,
  });
  return {
    ...result,
    scope,
    course: compactCourse(options.context.course),
    task: scope === "task" && options.context.task ? compactTask(options.context.task) : null,
  };
}

function resolveCourseId(options: BrevynMcpServerOptions, requestedCourseId?: string): string {
  const requested = requestedCourseId?.trim();
  if (requested) {
    if (requested === SEMESTER_HOME_COURSE_ID) return SEMESTER_HOME_COURSE_ID;
    return requireCourseInSemester(options, requested).id;
  }
  return options.context.course?.id || SEMESTER_HOME_COURSE_ID;
}

function resolveTaskFilter(
  options: BrevynMcpServerOptions,
  courseId: string,
  args: { courseId?: string; sectionKind?: CourseFileSectionKind; taskId?: string },
): string | undefined {
  if (args.taskId) {
    const task = options.businessStore.getTask(args.taskId);
    if (!task || task.semesterId !== options.context.semester.id || task.courseId !== courseId) {
      throw new Error(`Task ${args.taskId} does not belong to this course.`);
    }
    return task.id;
  }
  if (!args.courseId && !args.sectionKind && options.context.task && options.context.task.courseId === courseId) {
    return options.context.task.id;
  }
  return undefined;
}

function requireCourseInSemester(options: BrevynMcpServerOptions, courseId: string): Course {
  const course = options.businessStore.getCourse(courseId);
  if (!course) throw new Error(`Course not found: ${courseId}`);
  if (course.semesterId !== options.context.semester.id) throw new Error(`Course ${courseId} is outside the current semester.`);
  if (course.archivedAt) throw new Error(`Course ${course.name} is archived.`);
  return course;
}

function assertFileVisibleInContext(options: BrevynMcpServerOptions, file: WorkspaceFileNode): void {
  if (file.semesterId !== options.context.semester.id) throw new Error("File is outside the current semester.");
  if (file.courseId !== SEMESTER_HOME_COURSE_ID) requireCourseInSemester(options, file.courseId);
  if (options.context.course && file.courseId !== options.context.course.id) {
    throw new Error("File is outside the current course.");
  }
}

function requireCurrentTask(options: BrevynMcpServerOptions): BrevynTask {
  const taskId = options.context.task?.id;
  if (!taskId) throw new Error("课程任务信息只能在具体任务会话中更新。");
  const task = options.businessStore.getTask(taskId);
  if (!task || task.archivedAt) throw new Error("当前课程任务不可用。");
  if (task.semesterId !== options.context.semester.id || task.courseId !== options.context.course?.id) {
    throw new Error("当前任务不属于这个课程会话。");
  }
  return task;
}

function requireTaskInfoSourceFile(options: BrevynMcpServerOptions, task: BrevynTask, fileId: string): WorkspaceFileNode {
  const file = options.businessStore.getWorkspaceFile(fileId);
  if (!file || file.kind === "folder") throw new Error(`任务信息来源文件不存在：${fileId}`);
  assertFileVisibleInContext(options, file);
  if (file.courseId !== task.courseId) throw new Error(`任务信息来源不属于当前课程：${file.name}`);
  if (file.taskId && file.taskId !== task.id) throw new Error(`任务信息来源属于另一个课程任务：${file.name}`);
  return file;
}

function resolveTaskSourceAnchor(
  options: BrevynMcpServerOptions,
  task: BrevynTask,
  source: Omit<CourseTaskSourceAnchor, "fileName">,
): CourseTaskSourceAnchor {
  const file = requireTaskInfoSourceFile(options, task, source.fileId);
  return {
    fileId: file.id,
    fileName: file.name,
    sourceLabel: source.sourceLabel?.trim() || undefined,
    page: source.page,
    slide: source.slide,
    sheet: source.sheet?.trim() || undefined,
    range: source.range?.trim() || undefined,
    semanticUnitId: source.semanticUnitId?.trim() || undefined,
    bbox: source.bbox?.trim() || undefined,
  };
}

function normalizeConfirmedDueAt(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) throw new Error("截止时间必须是有效的 ISO-8601 日期或日期时间。");
  return trimmed;
}

function taskInfoItemId(kind: "requirement" | "rubric", value: string): string {
  const normalized = value.trim().toLowerCase();
  let hash = 2166136261;
  for (let cursor = 0; cursor < normalized.length; cursor += 1) {
    hash ^= normalized.charCodeAt(cursor);
    hash = Math.imul(hash, 16777619);
  }
  return `${kind}_${(hash >>> 0).toString(36)}`;
}

function uniqueTaskRequirements(items: CourseTaskRequirement[]): CourseTaskRequirement[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.category}:${item.text.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueRubricCriteria(items: CourseTaskRubricCriterion[]): CourseTaskRubricCriterion[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueTaskDocuments(items: CourseTaskDocument[]): CourseTaskDocument[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.fileId}:${item.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function taskInfoSourceCount(info: CourseTaskInfo): number {
  return new Set([
    ...info.documents.map((document) => document.fileId),
    ...info.requirements.flatMap((requirement) => requirement.source?.fileId ? [requirement.source.fileId] : []),
    ...info.rubricCriteria.flatMap((criterion) => criterion.source?.fileId ? [criterion.source.fileId] : []),
  ]).size;
}

function compactSemester(semester: SemesterWorkspace) {
  return {
    id: semester.id,
    semesterNo: semester.semesterNo,
    term: semester.term,
    folderName: semester.folderName,
  };
}

function compactCourse(course: Course) {
  return {
    id: course.id,
    name: course.name,
    code: course.code,
    instructor: course.instructor,
  };
}

function compactTask(task: BrevynTask) {
  return {
    id: task.id,
    title: task.title,
    taskType: task.taskType,
    status: task.status,
    dueAt: task.dueAt,
    summary: task.summary,
    info: task.info ? {
      deliverable: task.info.deliverable,
      requirementCount: task.info.requirements.length,
      rubricCriteriaCount: task.info.rubricCriteria.length,
      sourceCount: taskInfoSourceCount(task.info),
      extractedAt: task.info.extractedAt,
      updatedBy: task.info.updatedBy,
    } : undefined,
  };
}

function taskBuckets(courseDir: string, task: BrevynTask) {
  const taskPath = taskWorkspaceDirForTask(courseDir, task);
  return TASK_FILE_BUCKETS.map((bucket) => ({
    bucket,
    label: taskBucketLabel(bucket),
    path: join(taskPath, taskBucketLabel(bucket)),
  }));
}

function compactFile(file: WorkspaceFileNode) {
  const readPath = file.sourcePath && existsSync(file.sourcePath) ? file.sourcePath : undefined;
  const parsedTextPath = readPath ? parsedDocumentContentPath(readPath, file.id) : undefined;
  const artifactPath = readPath ? parsedDocumentArtifactPath(readPath, file.id) : undefined;
  const semanticUnitsPath = readPath ? parsedDocumentSemanticUnitsPath(readPath, file.id) : undefined;
  const hasParsedText = Boolean(parsedTextPath && existsSync(parsedTextPath));
  const hasOfficeArtifact = Boolean(artifactPath && existsSync(artifactPath));
  return {
    fileId: file.id,
    name: file.name,
    kind: file.kind,
    path: file.path,
    readPath,
    parsedTextPath: hasParsedText ? parsedTextPath : undefined,
    artifactPath: hasOfficeArtifact ? artifactPath : undefined,
    semanticUnitsPath: semanticUnitsPath && existsSync(semanticUnitsPath) ? semanticUnitsPath : undefined,
    hasParsedText,
    hasOfficeArtifact,
    size: file.sizeLabel,
    updatedAt: file.updatedAt,
    courseId: file.courseId,
    taskId: file.taskId,
    sectionKind: file.sectionKind,
    taskFileBucket: file.taskFileBucket,
    weekNumber: file.weekNumber,
    sourceKind: file.sourceKind,
    indexingStatus: file.indexingStatus || (file.indexedAt ? "indexed" : "idle"),
    indexingError: file.indexingError,
    indexingWarning: file.indexingWarning,
    indexingParser: file.indexingParserDetail || file.indexingParser,
    indexedAt: file.indexedAt,
  };
}

type CompactFileRecord = ReturnType<typeof compactFile>;

function groupCompactFiles(files: CompactFileRecord[]) {
  const nonExternalFiles = files.filter((file) => !isExternalSourceRecord(file));
  const groups = [
    compactFileGroup("external_sources", "外部来源", files.filter(isExternalSourceRecord)),
    compactFileGroup("task_materials", "当前作业材料", nonExternalFiles.filter((file) => file.sectionKind === "task" && file.taskFileBucket === "materials")),
    compactFileGroup("task_drafts", "任务草稿", nonExternalFiles.filter((file) => file.sectionKind === "task" && file.taskFileBucket === "drafts")),
    compactFileGroup("task_submitted", "已提交文件", nonExternalFiles.filter((file) => file.sectionKind === "task" && file.taskFileBucket === "submitted")),
    compactFileGroup("course_shared", "课程共享", nonExternalFiles.filter((file) => file.sectionKind === "course_shared")),
    compactFileGroup("lecture", "课件", nonExternalFiles.filter((file) => file.sectionKind === "lecture")),
    compactFileGroup("other", "其他文件", nonExternalFiles.filter((file) => !isKnownGroupedFile(file))),
  ];
  return groups.filter((group) => group.count > 0);
}

function compactFileGroup(id: string, title: string, files: CompactFileRecord[]) {
  const indexedCount = files.filter((file) => file.indexingStatus === "indexed" || file.indexingStatus === "partial" || file.indexingStatus === "warning").length;
  const parsedTextCount = files.filter((file) => file.hasParsedText).length;
  return {
    id,
    title,
    count: files.length,
    indexedCount,
    parsedTextCount,
    files,
  };
}

function isKnownGroupedFile(file: CompactFileRecord): boolean {
  return file.sectionKind === "course_shared"
    || file.sectionKind === "lecture"
    || file.sectionKind === "task"
    || isExternalSourceRecord(file);
}

function isExternalSourceRecord(file: CompactFileRecord): boolean {
  return file.path.includes("/External Sources/") || Boolean(file.readPath?.includes("/External Sources/"));
}

function isAgentWorkspaceControlFile(file: WorkspaceFileNode): boolean {
  const values = [file.name, file.path, file.sourcePath].filter((value): value is string => Boolean(value));
  if (values.some((value) => basename(value).toLowerCase() === AGENT_WORKSPACE_MEMORY_FILE.toLowerCase())) return true;
  const logicalValues = [file.name, file.path].filter((value): value is string => Boolean(value));
  return logicalValues.some((value) => {
    const segments = value.replace(/\\/g, "/").split("/").filter(Boolean);
    return segments.some((segment) => segment === ".brevyn" || segment === ".context" || segment === ".claude");
  });
}

function parsedDocumentContentPath(sourcePath: string, fileId: string): string {
  return join(parsedDocumentDir(sourcePath, fileId), "content.md");
}

function parsedDocumentArtifactPath(sourcePath: string, fileId: string): string {
  return join(parsedDocumentDir(sourcePath, fileId), "artifact.json");
}

function parsedDocumentSemanticUnitsPath(sourcePath: string, fileId: string): string {
  return join(parsedDocumentDir(sourcePath, fileId), "semantic-units.jsonl");
}

function parsedDocumentDir(sourcePath: string, fileId: string): string {
  const sourceDir = dirname(sourcePath);
  const extension = extname(sourcePath);
  const stem = basename(sourcePath, extension) || basename(sourcePath) || "document";
  const shortId = fileId.replace(/^file-/, "").slice(0, 10) || "file";
  return join(sourceDir, PARSED_DOCUMENTS_FOLDER, sanitizeFsSegment(`${stem}-${shortId}`));
}

function compactRagResult(result: RagSearchResult) {
  return {
    fileId: result.fileId || "",
    fileName: result.fileName || result.title,
    path: result.path || result.source,
    sectionKind: result.sectionKind || null,
    taskId: result.taskId || null,
    chunkIndex: result.chunkIndex,
    chunkCount: result.chunkCount,
    sourcePath: result.sourcePath || "",
    sourceLabel: result.sourceLabel || "",
    sectionType: result.sectionType || "",
    sectionTitle: result.sectionTitle || "",
    artifactId: result.artifactId || "",
    semanticUnitId: result.semanticUnitId || "",
    elementIds: result.elementIds || [],
    page: result.page,
    slide: result.slide,
    sheet: result.sheet || "",
    range: result.range || "",
    bbox: result.bbox || "",
    score: result.score,
    citation: result.citation,
    text: result.excerpt,
  };
}

function root(purpose: string, path: string, description: string) {
  return { purpose, path, description, exists: existsSync(path) };
}

function brevynToolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: summarizeToolResultForModel(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function summarizeToolResultForModel(value: unknown): string {
  const data = recordOf(value);
  const scope = stringValue(data.scope, "");
  if (scope === "semester_home" || scope === "course" || scope === "task") return summarizeCourseStructure(data);
  if (data.type === "course_task_info_updated") return summarizeCourseTaskInfoUpdate(data);
  if (data.type === "parsed_file") return summarizeParsedFile(data);
  if (Array.isArray(data.files)) return summarizeCourseFiles(data);
  if (data.file) return summarizeFileRecord(data);
  if (Array.isArray(data.results)) return summarizeRagResults(data);
  if (data.status && data.message && (data.candidate || data.status === "existing_source")) return summarizeSourceCandidateProposal(data);
  return JSON.stringify(value);
}

function summarizeCourseTaskInfoUpdate(data: Record<string, unknown>): string {
  const task = recordOf(data.task);
  const counts = recordOf(data.counts);
  return [
    "Brevyn course task information updated:",
    `- Task: ${stringValue(task.title, "current task")}`,
    `- Deadline: ${stringValue(task.dueAt, "not confirmed")}`,
    `- Requirements: ${stringValue(counts.requirements, "0")}`,
    `- Rubric criteria: ${stringValue(counts.rubricCriteria, "0")}`,
    `- Sources: ${stringValue(counts.sources, "0")}`,
    "- The course dashboard and task workspace now use this saved information.",
  ].join("\n");
}

function summarizeParsedFile(data: Record<string, unknown>): string {
  const file = recordOf(data.file);
  const content = stringValue(data.content, "");
  const name = stringValue(file.name, "file");
  const offset = typeof data.offset === "number" ? data.offset : 0;
  const charCount = typeof data.charCount === "number" ? data.charCount : content.length;
  const returnedChars = typeof data.returnedChars === "number" ? data.returnedChars : content.length;
  const nextOffset = typeof data.nextOffset === "number" ? data.nextOffset : null;
  const truncated = data.truncated === true;
  const hasArtifact = Boolean(stringValue(data.artifactPath, ""));
  const hasSemanticUnits = Boolean(stringValue(data.semanticUnitsPath, ""));
  return [
    "Brevyn parsed Markdown:",
    `- File: ${name}`,
    `- Parsed path: ${stringValue(data.parsedTextPath, "")}`,
    stringValue(data.artifactPath, "") ? `- Office artifact: ${stringValue(data.artifactPath, "")}` : "",
    stringValue(data.semanticUnitsPath, "") ? `- Semantic units: ${stringValue(data.semanticUnitsPath, "")}` : "",
    hasArtifact || hasSemanticUnits ? "- Reading policy: this is the same parsed text used for RAG indexing; use it as the default readable source, then use Office artifact/semantic units to verify exact tables, charts, formulas, speaker notes, page/slide/sheet/range anchors, and citations." : "- Reading policy: this is the same parsed text used for RAG indexing; use it as the readable source for this indexed file.",
    `- Range: ${offset}-${offset + returnedChars} of ${charCount}${truncated ? ` (truncated, continue with offset ${nextOffset} to finish the file)` : " (complete)"}`,
    "",
    content,
  ].join("\n");
}

function summarizeSourceCandidateProposal(data: Record<string, unknown>): string {
  const candidate = recordOf(data.candidate);
  const title = stringValue(candidate.title, "external source");
  const status = stringValue(data.status, "created");
  const message = stringValue(data.message, "候选来源已提交给用户确认。");
  if (status === "existing_source") return `Brevyn source candidate: ${message}`;
  return [
    `Brevyn source candidate: ${message}`,
    `- Title: ${title}`,
    `- Scope: ${stringValue(data.scope, "course")}`,
    "- Next: Tell the user this source is waiting in the Brevyn confirmation card. Do not ask again whether to save it.",
  ].join("\n");
}

function summarizeCourseStructure(data: Record<string, unknown>): string {
  const lines = ["Brevyn course structure:"];
  const semester = recordOf(data.semester);
  const course = recordOf(data.course);
  const currentTask = recordOf(data.currentTask);
  lines.push(`- Scope: ${stringValue(data.scope, "unknown")}`);
  lines.push(`- CWD: ${stringValue(data.cwd, "")}`);
  const semesterLabel = [stringValue(semester.term, ""), stringValue(semester.folderName, "")].filter(Boolean).join(" / ");
  if (semesterLabel) lines.push(`- Semester: ${semesterLabel}`);
  const courseLabel = [stringValue(course.name, ""), stringValue(course.code, "")].filter(Boolean).join(" / ");
  if (courseLabel) lines.push(`- Course: ${courseLabel}`);
  const taskTitle = stringValue(currentTask.title, "");
  if (taskTitle) lines.push(`- Current task: ${taskTitle}`);
  const roots = arrayOfRecords(data.roots);
  if (roots.length > 0) {
    lines.push("- Roots:");
    for (const item of roots) {
      lines.push(`  - ${stringValue(item.purpose, "root")}: ${stringValue(item.path, "")}`);
    }
  }
  const courses = arrayOfRecords(data.courses);
  if (courses.length > 0) {
    lines.push(`- Active courses (${courses.length}): ${courses.map((item) => stringValue(item.name, "course")).join(", ")}`);
  }
  const tasks = arrayOfRecords(data.tasks);
  if (tasks.length > 0) {
    lines.push(`- Tasks (${tasks.length}): ${tasks.map((item) => stringValue(item.title, "task")).join(", ")}`);
  }
  return lines.join("\n");
}

function summarizeCourseFiles(data: Record<string, unknown>): string {
  const files = arrayOfRecords(data.files);
  const groups = arrayOfRecords(data.groups);
  const totalMatched = typeof data.totalMatched === "number" ? data.totalMatched : files.length;
  const lines = [
    `Brevyn file records: ${files.length}/${totalMatched} matched${data.truncated ? " (truncated)" : ""}.`,
  ];
  if (groups.length > 0) {
    for (const group of groups) {
      const title = stringValue(group.title, "Files");
      const groupFiles = arrayOfRecords(group.files);
      const indexedCount = typeof group.indexedCount === "number" ? group.indexedCount : 0;
      const parsedTextCount = typeof group.parsedTextCount === "number" ? group.parsedTextCount : 0;
      lines.push(`- ${title}: ${groupFiles.length} files, ${indexedCount} indexed, ${parsedTextCount} with parsed text`);
      for (const file of groupFiles.slice(0, 12)) {
        const name = stringValue(file.name, "file");
        const status = stringValue(file.indexingStatus, "idle");
        const parsed = file.hasParsedText === true ? ", parsed text ready" : "";
        const path = stringValue(file.readPath ?? file.path, "");
        lines.push(`  - ${name} (${status}${parsed})${path ? `: ${path}` : ""}`);
      }
      if (groupFiles.length > 12) lines.push(`  - ... ${groupFiles.length - 12} more`);
    }
  } else {
    for (const file of files.slice(0, 80)) {
      const name = stringValue(file.name, "file");
      const section = stringValue(file.sectionKind, "unknown");
      const status = stringValue(file.indexingStatus, "idle");
      const parsed = file.hasParsedText === true ? ", parsed text ready" : "";
      const path = stringValue(file.readPath ?? file.path, "");
      lines.push(`- ${name} [${section}, ${status}${parsed}]${path ? `: ${path}` : ""}`);
    }
  }
  return lines.join("\n");
}

function summarizeFileRecord(data: Record<string, unknown>): string {
  const file = recordOf(data.file);
  return [
    "Brevyn file record:",
    `- Name: ${stringValue(file.name, "file")}`,
    `- Section: ${stringValue(file.sectionKind, "unknown")}`,
    `- Path: ${stringValue(file.readPath ?? file.path, "")}`,
  ].join("\n");
}

function summarizeRagResults(data: Record<string, unknown>): string {
  const results = arrayOfRecords(data.results);
  const lines = [`Brevyn RAG results: ${results.length}`];
  const recommendedReads = recommendedRagReads(results);
  if (recommendedReads.length > 0) {
    lines.push("- Reading policy: treat these chunks as leads. For final answers, read the complete parsed Markdown for the top candidate files with read_parsed_file when available.");
    lines.push("- Recommended reads:");
    for (const item of recommendedReads) {
      lines.push(`  - ${item.fileName} (${item.fileId})${item.reason ? ` — ${item.reason}` : ""}`);
    }
  }
  for (const result of results) {
    const file = stringValue(result.fileName ?? result.path, "source");
    const text = stringValue(result.text, "").replace(/\s+/g, " ").trim();
    const anchors = ragAnchorLabel(result);
    const chunk = typeof result.chunkIndex === "number" && typeof result.chunkCount === "number"
      ? `chunk ${Number(result.chunkIndex) + 1}/${Number(result.chunkCount)}`
      : "";
    const score = typeof result.score === "number" ? `score ${Number(result.score).toFixed(2)}` : "";
    const suffix = [anchors, chunk, score].filter(Boolean).join(", ");
    lines.push(`- ${file}${suffix ? ` [${suffix}]` : ""}: ${text}`);
  }
  return lines.join("\n");
}

function recommendedRagReads(results: Array<Record<string, unknown>>): Array<{ fileId: string; fileName: string; reason: string }> {
  const byFile = new Map<string, { fileId: string; fileName: string; hits: number; bestScore: number; hasStructuredAnchor: boolean; smallChunkCount: boolean }>();
  for (const result of results) {
    const fileId = stringValue(result.fileId, "");
    if (!fileId) continue;
    const existing = byFile.get(fileId);
    const score = typeof result.score === "number" ? result.score : 0;
    const chunkCount = typeof result.chunkCount === "number" ? result.chunkCount : undefined;
    const next = existing || {
      fileId,
      fileName: stringValue(result.fileName ?? result.path, "source"),
      hits: 0,
      bestScore: 0,
      hasStructuredAnchor: false,
      smallChunkCount: false,
    };
    next.hits += 1;
    next.bestScore = Math.max(next.bestScore, score);
    next.hasStructuredAnchor = next.hasStructuredAnchor || hasRagStructuredAnchor(result);
    next.smallChunkCount = next.smallChunkCount || (typeof chunkCount === "number" && chunkCount <= 3);
    byFile.set(fileId, next);
  }
  return Array.from(byFile.values())
    .sort((left, right) => right.bestScore - left.bestScore || right.hits - left.hits)
    .slice(0, 3)
    .map((item) => ({
      fileId: item.fileId,
      fileName: item.fileName,
      reason: [
        item.hits > 1 ? `${item.hits} matching chunks` : "top match",
        item.smallChunkCount ? "small chunk count, full read is cheap" : "",
        item.hasStructuredAnchor ? "has page/slide/range anchor" : "",
      ].filter(Boolean).join("; "),
    }));
}

function ragAnchorLabel(result: Record<string, unknown>): string {
  const anchors = [
    typeof result.page === "number" ? `page ${result.page}` : "",
    typeof result.slide === "number" ? `slide ${result.slide}` : "",
    stringValue(result.sheet, ""),
    stringValue(result.range, ""),
    stringValue(result.sourceLabel, ""),
    stringValue(result.sectionType, ""),
  ].filter(Boolean);
  return anchors.join(", ");
}

function hasRagStructuredAnchor(result: Record<string, unknown>): boolean {
  return Boolean(
    stringValue(result.semanticUnitId, "")
      || stringValue(result.sourceLabel, "")
      || typeof result.page === "number"
      || typeof result.slide === "number"
      || stringValue(result.sheet, "")
      || stringValue(result.range, ""),
  );
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.flatMap((item) => {
    const record = recordOf(item);
    return Object.keys(record).length > 0 ? [record] : [];
  }) : [];
}

function stringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}
