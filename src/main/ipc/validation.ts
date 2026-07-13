import type {
  ArchivedCourseScope,
  ArchivedTaskScope,
  ArchivedThreadScope,
  AgentAttachment,
  AgentAskUserResponseInput,
  AgentApprovalInput,
  AgentExitPlanResponseInput,
  AgentPermissionMode,
  AgentQueueMessageInput,
  AgentRunInput,
  CourseIconKey,
  CourseTaskDocument,
  CourseTaskInfo,
  CourseTaskRequirement,
  CourseTaskRubricCriterion,
  CourseTaskSourceAnchor,
  ForkThreadInput,
  CreateCourseInput,
  CreateSemesterInput,
  CreateTaskInput,
  CreateThreadInput,
  DeleteFileInput,
  FileImportInput,
  RecognizedAcademicCalendar,
  RecognizedCalendarEvent,
  RecognizedCourseSchedule,
  RecognizedCourseSession,
  RecognizedCourseTimetable,
  RenameThreadInput,
  SkillImportInput,
  SkillLibrarySettings,
  SkillUpdateInput,
  SkillWriteInput,
  TaskIconKey,
  TimetableRangeQuery,
  UpdateCourseInput,
  UpdateTaskInput,
  UpdateThreadWorkflowInput,
  VisionRecognitionInput,
  WeekdayKey,
} from "../../types/domain";

export function requireString(value: unknown, label: string): string {
  const text = stringValue(value).trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

export function optionalString(value: unknown): string | undefined {
  const text = stringValue(value).trim();
  return text || undefined;
}

function optionalIntegerInRange(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(numeric)) return undefined;
  const integer = Math.trunc(numeric);
  if (integer < min || integer > max) return undefined;
  return integer;
}

export function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function normalizeCreateSemesterInput(value: unknown): CreateSemesterInput {
  const input = requireObject(value, "Semester input");
  return {
    term: stringValue(input.term),
    folderName: optionalString(input.folderName),
    semesterNo: optionalString(input.semesterNo),
    startsAt: optionalString(input.startsAt),
    endsAt: optionalString(input.endsAt),
    weekCount: optionalIntegerInRange(input.weekCount, 1, 30),
  };
}

export function normalizeCreateCourseInput(value: unknown): CreateCourseInput {
  const input = requireObject(value, "Course input");
  return {
    name: stringValue(input.name),
    code: stringValue(input.code),
    instructor: optionalString(input.instructor),
    meetingTime: optionalString(input.meetingTime),
    location: optionalString(input.location),
    color: optionalString(input.color),
    description: optionalString(input.description),
  };
}

export function normalizeUpdateCourseInput(value: unknown): UpdateCourseInput {
  const input = requireObject(value, "Course update input");
  return {
    id: requireString(input.id, "Course id"),
    code: input.code === undefined ? undefined : stringValue(input.code),
    instructor: input.instructor === undefined ? undefined : stringValue(input.instructor),
    meetingTime: input.meetingTime === null ? null : input.meetingTime === undefined ? undefined : stringValue(input.meetingTime),
    location: input.location === null ? null : input.location === undefined ? undefined : stringValue(input.location),
    color: input.color === undefined ? undefined : stringValue(input.color),
    icon: input.icon === undefined ? undefined : normalizeCourseIcon(input.icon),
  };
}

function normalizeCourseIcon(value: unknown): CourseIconKey {
  const icon = requireString(value, "Course icon");
  if (!COURSE_ICON_KEYS.has(icon as CourseIconKey)) throw new Error("Course icon is not supported.");
  return icon as CourseIconKey;
}

function normalizeTaskIcon(value: unknown): TaskIconKey {
  const icon = requireString(value, "Task icon");
  if (!TASK_ICON_KEYS.has(icon as TaskIconKey)) throw new Error("Task icon is not supported.");
  return icon as TaskIconKey;
}

export function normalizeCreateTaskInput(value: unknown): CreateTaskInput {
  const input = requireObject(value, "Task input");
  return {
    courseId: requireString(input.courseId, "Course id"),
    title: stringValue(input.title),
    taskType: optionalString(input.taskType),
    icon: input.icon === undefined ? undefined : normalizeTaskIcon(input.icon),
  };
}

export function normalizeUpdateTaskInput(value: unknown): UpdateTaskInput {
  const input = requireObject(value, "Task update input");
  return {
    id: requireString(input.id, "Task id"),
    title: optionalString(input.title),
    taskType: optionalString(input.taskType),
    icon: input.icon === undefined ? undefined : normalizeTaskIcon(input.icon),
    dueAt: input.dueAt === null ? null : optionalString(input.dueAt),
    status: normalizeTaskStatus(input.status),
    summary: input.summary === undefined ? undefined : stringValue(input.summary),
    info: input.info === null ? null : input.info === undefined ? undefined : normalizeCourseTaskInfo(input.info),
  };
}

function normalizeCourseTaskInfo(value: unknown): CourseTaskInfo {
  const input = requireObject(value, "Course task info");
  return {
    deliverable: optionalString(input.deliverable)?.slice(0, 240),
    requirements: normalizeCourseTaskRequirements(input.requirements),
    rubricCriteria: normalizeCourseTaskRubricCriteria(input.rubricCriteria),
    documents: normalizeCourseTaskDocuments(input.documents),
    extractedAt: new Date().toISOString(),
    updatedBy: "user",
    manualFields: normalizeCourseTaskInfoManualFields(input.manualFields),
  };
}

function normalizeCourseTaskInfoManualFields(value: unknown): CourseTaskInfo["manualFields"] {
  if (!Array.isArray(value)) return undefined;
  return Array.from(new Set(value.filter((item): item is "summary" | "deliverable" => (
    item === "summary" || item === "deliverable"
  ))));
}

function normalizeCourseTaskRequirements(value: unknown): CourseTaskRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 80).flatMap((item, index) => {
    const input = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const text = optionalString(input.text)?.slice(0, 800);
    if (!text) return [];
    const category = normalizeCourseTaskRequirementCategory(input.category);
    return [{
      id: optionalString(input.id)?.slice(0, 160) || `requirement_user_${index + 1}`,
      category,
      text,
      source: normalizeCourseTaskSourceAnchor(input.source),
    }];
  });
}

function normalizeCourseTaskRubricCriteria(value: unknown): CourseTaskRubricCriterion[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).flatMap((item, index) => {
    const input = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const title = optionalString(input.title)?.slice(0, 240);
    if (!title) return [];
    const points = normalizeNumber(input.points);
    return [{
      id: optionalString(input.id)?.slice(0, 160) || `rubric_user_${index + 1}`,
      title,
      description: optionalString(input.description)?.slice(0, 1200),
      points: points !== undefined && points >= 0 ? points : undefined,
      source: normalizeCourseTaskSourceAnchor(input.source),
    }];
  });
}

function normalizeCourseTaskDocuments(value: unknown): CourseTaskDocument[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).flatMap((item) => {
    const input = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const fileId = optionalString(input.fileId);
    if (!fileId) return [];
    return [{
      fileId,
      fileName: optionalString(input.fileName) || "",
      role: normalizeCourseTaskDocumentRole(input.role),
      sourceLabel: optionalString(input.sourceLabel)?.slice(0, 240),
    }];
  });
}

function normalizeCourseTaskSourceAnchor(value: unknown): CourseTaskSourceAnchor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const fileId = optionalString(input.fileId);
  if (!fileId) return undefined;
  const page = normalizeNumber(input.page);
  const slide = normalizeNumber(input.slide);
  return {
    fileId,
    fileName: optionalString(input.fileName) || "",
    sourceLabel: optionalString(input.sourceLabel)?.slice(0, 240),
    page: page !== undefined && page >= 1 ? Math.trunc(page) : undefined,
    slide: slide !== undefined && slide >= 1 ? Math.trunc(slide) : undefined,
    sheet: optionalString(input.sheet)?.slice(0, 240),
    range: optionalString(input.range)?.slice(0, 240),
    semanticUnitId: optionalString(input.semanticUnitId)?.slice(0, 240),
    bbox: optionalString(input.bbox)?.slice(0, 1000),
  };
}

function normalizeCourseTaskRequirementCategory(value: unknown): CourseTaskRequirement["category"] {
  if (value === "limit" || value === "format" || value === "reference" || value === "submission" || value === "prohibition") return value;
  return "other";
}

function normalizeCourseTaskDocumentRole(value: unknown): CourseTaskDocument["role"] {
  if (value === "brief" || value === "rubric" || value === "draft" || value === "submission") return value;
  return "supporting";
}

export function normalizeCreateThreadInput(value: unknown): CreateThreadInput {
  const input = requireObject(value, "Thread input");
  return {
    courseId: requireString(input.courseId, "Course id"),
    taskId: optionalString(input.taskId),
    title: optionalString(input.title),
    isDraft: input.isDraft === undefined ? undefined : Boolean(input.isDraft),
    parentThreadId: optionalString(input.parentThreadId),
    rootThreadId: optionalString(input.rootThreadId),
    forkFromMessageUuid: optionalString(input.forkFromMessageUuid),
    forkSourceSdkSessionId: optionalString(input.forkSourceSdkSessionId),
  };
}

export function normalizeForkThreadInput(value: unknown): ForkThreadInput {
  const input = requireObject(value, "Thread fork input");
  return {
    threadId: requireString(input.threadId, "Thread id"),
    upToMessageUuid: requireString(input.upToMessageUuid, "Message uuid"),
  };
}

export function normalizeRenameThreadInput(value: unknown): RenameThreadInput {
  const input = requireObject(value, "Thread rename input");
  return {
    threadId: requireString(input.threadId, "Thread id"),
    title: requireString(input.title, "Thread title"),
  };
}

export function normalizeArchivedCourseScope(value: unknown): ArchivedCourseScope | undefined {
  if (value === undefined || value === null) return undefined;
  const input = requireObject(value, "Archived course scope");
  return { semesterId: optionalString(input.semesterId) };
}

export function normalizeArchivedTaskScope(value: unknown): ArchivedTaskScope | undefined {
  if (value === undefined || value === null) return undefined;
  const input = requireObject(value, "Archived task scope");
  return {
    semesterId: optionalString(input.semesterId),
    courseId: optionalString(input.courseId),
  };
}

export function normalizeArchivedThreadScope(value: unknown): ArchivedThreadScope | undefined {
  if (value === undefined || value === null) return undefined;
  const input = requireObject(value, "Archived thread scope");
  return {
    semesterId: optionalString(input.semesterId),
    courseId: optionalString(input.courseId),
  };
}

export function normalizeFileImportInput(value: unknown): FileImportInput {
  const input = requireObject(value, "File import input");
  const sourcePaths = Array.isArray(input.sourcePaths)
    ? input.sourcePaths.flatMap((item) => {
        const path = optionalString(item);
        return path ? [path] : [];
      })
    : undefined;
  return {
    courseId: requireString(input.courseId, "Course id"),
    targetSection: normalizeTargetSection(input.targetSection),
    sourcePaths,
    weekNumber: normalizeNumber(input.weekNumber),
    taskId: optionalString(input.taskId),
    taskFileBucket: normalizeTaskFileBucket(input.taskFileBucket),
  };
}

export function normalizeDeleteFileInput(value: unknown): DeleteFileInput {
  if (typeof value === "string") {
    return { fileId: requireString(value, "File id") };
  }
  const input = requireObject(value, "File delete input");
  return {
    fileId: requireString(input.fileId, "File id"),
    forceCancelIndexing: input.forceCancelIndexing === true,
  };
}

export function normalizeSkillImportInput(value: unknown): SkillImportInput {
  const input = value === undefined || value === null ? {} : requireObject(value, "Skill import input");
  return {
    sourcePath: optionalString(input.sourcePath),
    enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
  };
}

export function normalizeSkillLibrarySettings(value: unknown): SkillLibrarySettings {
  const input = requireObject(value, "Skill library settings");
  const categories = Array.isArray(input.categories)
    ? input.categories.flatMap((raw) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const category = raw as Record<string, unknown>;
        const name = stringValue(category.name).trim().slice(0, 24);
        const id = normalizeSkillCategoryId(category.id || name);
        return id && name ? [{ id, name, system: Boolean(category.system) }] : [];
      })
    : [];
  const assignments: Record<string, string> = {};
  const rawAssignments = input.assignments && typeof input.assignments === "object" && !Array.isArray(input.assignments)
    ? input.assignments as Record<string, unknown>
    : {};
  for (const [skillId, categoryId] of Object.entries(rawAssignments)) {
    const normalizedSkillId = skillId.trim();
    const normalizedCategoryId = normalizeSkillCategoryId(categoryId);
    if (normalizedSkillId && normalizedCategoryId) assignments[normalizedSkillId] = normalizedCategoryId;
  }
  return { categories, assignments };
}

export function normalizeSkillUpdateInput(value: unknown): SkillUpdateInput {
  const input = requireObject(value, "Skill update input");
  return {
    id: requireString(input.id, "Skill id"),
    enabled: Boolean(input.enabled),
  };
}

export function normalizeSkillWriteInput(value: unknown): SkillWriteInput {
  const input = requireObject(value, "Skill write input");
  return {
    id: requireString(input.id, "Skill id"),
    content: stringValue(input.content),
  };
}

export function normalizeTimetableRangeQuery(value: unknown): TimetableRangeQuery {
  const input = requireObject(value, "Timetable range query");
  return {
    viewMode: input.viewMode === "month" || input.viewMode === "year" ? input.viewMode : "week",
    rangeStart: requireString(input.rangeStart, "Range start"),
    rangeEnd: requireString(input.rangeEnd, "Range end"),
    courseId: optionalString(input.courseId),
    includeSchoolEvents: input.includeSchoolEvents === undefined ? undefined : Boolean(input.includeSchoolEvents),
    includeDeadlines: input.includeDeadlines === undefined ? undefined : Boolean(input.includeDeadlines),
  };
}

export function normalizeAgentRunInput(value: unknown): AgentRunInput {
  const input = requireObject(value, "Agent run input");
  const prompt = stringValue(input.prompt).trim();
  const attachments = normalizeAgentAttachments(input.attachments);
  if (!prompt && !attachments?.length) throw new Error("Prompt or attachment is required.");
  return {
    threadId: requireString(input.threadId, "Thread id"),
    prompt,
    displayPrompt: optionalString(input.displayPrompt),
    skipAutoTitle: input.skipAutoTitle === true,
    uuid: optionalString(input.uuid),
    permissionMode: normalizeAgentPermissionMode(input.permissionMode),
    providerId: optionalString(input.providerId),
    modelId: optionalString(input.modelId),
    attachments,
    mentionedSkills: normalizeStringArray(input.mentionedSkills),
  };
}

function normalizeAgentPermissionMode(value: unknown): AgentPermissionMode {
  if (value === "bypassPermissions" || value === "plan" || value === "auto") return value;
  return "auto";
}

export function normalizeAgentQueueMessageInput(value: unknown): AgentQueueMessageInput {
  const input = requireObject(value, "Agent queue message input");
  const prompt = stringValue(input.prompt).trim();
  const attachments = normalizeAgentAttachments(input.attachments);
  if (!prompt && !attachments?.length) throw new Error("Prompt or attachment is required.");
  return {
    threadId: requireString(input.threadId, "Thread id"),
    prompt,
    uuid: optionalString(input.uuid),
    interrupt: input.interrupt === undefined ? undefined : Boolean(input.interrupt),
    attachments,
    mentionedSkills: normalizeStringArray(input.mentionedSkills),
  };
}

export function normalizeUpdateThreadWorkflowInput(value: unknown): UpdateThreadWorkflowInput {
  const input = requireObject(value, "Thread workflow input");
  return {
    threadId: requireString(input.threadId, "Thread id"),
    workflow: normalizeThreadWorkflow(input.workflow),
  };
}

function normalizeThreadWorkflow(value: unknown): UpdateThreadWorkflowInput["workflow"] {
  if (value === undefined || value === null) return undefined;
  const input = requireObject(value, "Thread workflow");
  if (input.type !== "ppt") throw new Error("Unsupported thread workflow type.");
  const phase = input.phase === "awaiting_confirmation" || input.phase === "generating" || input.phase === "done" ? input.phase : "planning";
  const nowMs = Date.now();
  const startedAt = typeof input.startedAt === "number" && Number.isFinite(input.startedAt) ? input.startedAt : nowMs;
  const updatedAt = typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt) ? input.updatedAt : nowMs;
  return {
    type: "ppt",
    skillSlug: optionalString(input.skillSlug) || "ppt-master",
    phase,
    startedAt,
    updatedAt,
  };
}

export function normalizeVisionRecognitionInput(value: unknown): VisionRecognitionInput {
  const input = requireObject(value, "Vision recognition input");
  return {
    sourcePath: requireString(input.sourcePath, "Image path"),
    apply: input.apply === undefined ? undefined : Boolean(input.apply),
    providerId: optionalString(input.providerId),
    modelId: optionalString(input.modelId),
  };
}

export function normalizeRecognizedAcademicCalendar(value: unknown): RecognizedAcademicCalendar {
  const input = requireObject(value, "Academic calendar recognition result");
  return {
    kind: "academic_calendar",
    sourcePath: requireString(input.sourcePath, "Image path"),
    providerName: optionalString(input.providerName) || "Vision",
    modelId: optionalString(input.modelId) || "vision-model",
    semester: input.semester ? normalizeCreateSemesterInput(input.semester) : undefined,
    events: normalizeRecognizedCalendarEvents(input.events),
    warnings: normalizeStringArray(input.warnings),
  };
}

export function normalizeRecognizedCourseTimetable(value: unknown): RecognizedCourseTimetable {
  const input = requireObject(value, "Course timetable recognition result");
  return {
    kind: "course_timetable",
    sourcePath: requireString(input.sourcePath, "Image path"),
    providerName: optionalString(input.providerName) || "Vision",
    modelId: optionalString(input.modelId) || "vision-model",
    semesterLabel: optionalString(input.semesterLabel),
    courses: normalizeRecognizedCourses(input.courses),
    warnings: normalizeStringArray(input.warnings),
  };
}

function normalizeRecognizedCalendarEvents(value: unknown): RecognizedCalendarEvent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const input = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const title = optionalString(input.title);
    const startsAt = optionalString(input.startsAt);
    if (!title || !startsAt) return [];
    return [{
      title,
      startsAt,
      endsAt: optionalString(input.endsAt),
      notes: optionalString(input.notes),
      confidence: normalizeNumber(input.confidence),
    }];
  });
}

function normalizeRecognizedCourses(value: unknown): RecognizedCourseSchedule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const input = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const code = optionalString(input.code);
    const name = optionalString(input.name);
    if (!code || !name) return [];
    return [{
      code,
      name,
      section: optionalString(input.section),
      category: optionalString(input.category),
      icon: input.icon === undefined ? undefined : normalizeCourseIcon(input.icon),
      instructor: optionalString(input.instructor),
      units: normalizeNumber(input.units),
      sessions: normalizeRecognizedSessions(input.sessions),
      confidence: normalizeNumber(input.confidence),
    }];
  });
}

function normalizeRecognizedSessions(value: unknown): RecognizedCourseSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const input = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const dayOfWeek = normalizeWeekday(input.dayOfWeek);
    const startTime = optionalString(input.startTime);
    const endTime = optionalString(input.endTime);
    if (!dayOfWeek || !startTime || !endTime) return [];
    return [{
      dayOfWeek,
      startTime,
      endTime,
      room: optionalString(input.room),
      weeks: optionalString(input.weeks),
      confidence: normalizeNumber(input.confidence),
    }];
  });
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = optionalString(item);
    return text ? [text] : [];
  });
}

function normalizeSkillCategoryId(value: unknown): string {
  return stringValue(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function normalizeWeekday(value: unknown): WeekdayKey | undefined {
  const text = optionalString(value)?.toLowerCase().slice(0, 3);
  return text && ["mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(text) ? text as WeekdayKey : undefined;
}

function normalizeAgentAttachments(value: unknown): AgentAttachment[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const input = item as Record<string, unknown>;
    const path = optionalString(input.path);
    const name = optionalString(input.name);
    if (!path || !name) return [];
    return [{
      id: optionalString(input.id) || `attachment-${index}`,
      threadId: optionalString(input.threadId) || "",
      name,
      kind: typeof input.kind === "string" ? input.kind as AgentAttachment["kind"] : "unknown",
      mimeType: optionalString(input.mimeType),
      size: typeof input.size === "number" ? input.size : 0,
      sizeLabel: optionalString(input.sizeLabel) || "",
      path,
      createdAt: optionalString(input.createdAt) || new Date().toISOString(),
    }];
  });
  return attachments.length > 0 ? attachments : undefined;
}

export function normalizeAgentApprovalInput(value: unknown): AgentApprovalInput {
  const input = requireObject(value, "Agent approval input");
  return {
    threadId: requireString(input.threadId, "Thread id"),
    requestId: requireString(input.requestId, "Approval request id"),
  };
}

export function normalizeAgentAskUserResponseInput(value: unknown): AgentAskUserResponseInput {
  const input = requireObject(value, "Agent question response input");
  const answersInput = requireObject(input.answers, "Agent question answers");
  const answers: Record<string, string> = {};
  for (const [key, answer] of Object.entries(answersInput)) {
    answers[key] = typeof answer === "string" ? answer : String(answer ?? "");
  }
  return {
    threadId: requireString(input.threadId, "Thread id"),
    requestId: requireString(input.requestId, "Question request id"),
    answers,
  };
}

export function normalizeAgentExitPlanResponseInput(value: unknown): AgentExitPlanResponseInput {
  const input = requireObject(value, "Agent exit plan response input");
  return {
    threadId: requireString(input.threadId, "Thread id"),
    requestId: requireString(input.requestId, "Exit plan request id"),
    decision: input.decision === "approve" ? "approve" : "deny",
    feedback: optionalString(input.feedback),
  };
}

function normalizeTaskStatus(value: unknown): UpdateTaskInput["status"] {
  return value === "not_started" || value === "in_progress" || value === "due_soon" || value === "done" ? value : undefined;
}

function normalizeTargetSection(value: unknown): FileImportInput["targetSection"] {
  if (value === "lecture" || value === "task") return value;
  return "course_shared";
}

function normalizeTaskFileBucket(value: unknown): FileImportInput["taskFileBucket"] {
  if (value === "drafts" || value === "submitted") return value;
  if (value === "materials") return value;
  return undefined;
}

function normalizeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

const COURSE_ICON_KEYS = new Set<CourseIconKey>([
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

const TASK_ICON_KEYS = new Set<TaskIconKey>([
  "task-check",
  "essay-scroll",
  "slides-screen",
  "project-target",
  "exam-clock",
  "reading-notes",
  "research-flask",
  "code-braces",
  "discussion-bubbles",
  "idea-lightbulb",
]);
