import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
export interface Course {
  id: string;
  semesterId?: string;
  name: string;
  code: string;
  term: string;
  instructor: string;
  workspaceKind?: "semester_home" | "course";
  icon?: CourseIconKey;
  meetingTime?: string;
  location?: string;
  color: string;
  description: string;
  archivedAt?: string;
}

export type CourseIconKey =
  | "graduation-cap"
  | "book-open"
  | "scale"
  | "landmark"
  | "briefcase"
  | "file-text"
  | "gavel"
  | "library"
  | "microscope"
  | "calculator"
  | "globe"
  | "presentation"
  | "square-pen"
  | "clipboard-list";

export type TaskIconKey =
  | "task-check"
  | "essay-scroll"
  | "slides-screen"
  | "project-target"
  | "exam-clock"
  | "reading-notes"
  | "research-flask"
  | "code-braces"
  | "discussion-bubbles"
  | "idea-lightbulb";

export interface SemesterWorkspace {
  id: string;
  semesterNo: string;
  term: string;
  folderName: string;
  startsAt?: string;
  endsAt?: string;
  weekCount?: number;
  source: "manual" | "filesystem" | "vision";
  recognizedAt?: string;
  archivedAt?: string;
}

export interface CreateSemesterInput {
  term: string;
  folderName?: string;
  semesterNo?: string;
  startsAt?: string;
  endsAt?: string;
  weekCount?: number;
}

export interface CreateCourseInput {
  name: string;
  code: string;
  instructor?: string;
  meetingTime?: string;
  location?: string;
  color?: string;
  description?: string;
}

export interface UpdateCourseInput {
  id: string;
  code?: string;
  instructor?: string;
  meetingTime?: string | null;
  location?: string | null;
  color?: string;
  icon?: CourseIconKey;
}

export interface ArchivedCourseScope {
  semesterId?: string;
}

export interface ArchivedTaskScope {
  semesterId?: string;
  courseId?: string;
}

/**
 * Task type is user-defined free-form string (e.g. "assignment", "exam", "读书报告", "小组项目").
 * It's a business label for display, filtering, icons, and section titles.
 * Physical task workspace paths are keyed by task id:
 *   <courseDir>/Task/<taskId>__<taskTitle>/{Materials, Drafts, Submitted}
 */
export type TaskType = string;
export type TaskStatus = "not_started" | "in_progress" | "due_soon" | "done";
export type TaskFileBucket = "materials" | "drafts" | "submitted";
export type ThreadTitleSource = "default" | "auto" | "manual";

export type CourseTaskRequirementCategory = "limit" | "format" | "reference" | "submission" | "prohibition" | "other";
export type CourseTaskDocumentRole = "brief" | "rubric" | "supporting" | "draft" | "submission";

export interface CourseTaskSourceAnchor {
  fileId: string;
  fileName: string;
  sourceLabel?: string;
  page?: number;
  slide?: number;
  sheet?: string;
  range?: string;
  semanticUnitId?: string;
  bbox?: string;
}

export interface CourseTaskRequirement {
  id: string;
  category: CourseTaskRequirementCategory;
  text: string;
  source?: CourseTaskSourceAnchor;
}

export interface CourseTaskRubricCriterion {
  id: string;
  title: string;
  description?: string;
  points?: number;
  source?: CourseTaskSourceAnchor;
}

export interface CourseTaskDocument {
  fileId: string;
  fileName: string;
  role: CourseTaskDocumentRole;
  sourceLabel?: string;
}

export interface CourseTaskInfo {
  deliverable?: string;
  requirements: CourseTaskRequirement[];
  rubricCriteria: CourseTaskRubricCriterion[];
  documents: CourseTaskDocument[];
  extractedAt: string;
  updatedBy: "agent" | "user";
  manualFields?: CourseTaskInfoManualField[];
}

export type CourseTaskInfoManualField = "summary" | "deliverable";

export interface BrevynTask {
  id: string;
  semesterId?: string;
  courseId: string;
  title: string;
  taskType: TaskType;
  icon?: TaskIconKey;
  status: TaskStatus;
  dueAt?: string;
  summary: string;
  info?: CourseTaskInfo;
  archivedAt?: string;
}

export interface Thread {
  id: string;
  semesterId?: string;
  courseId: string;
  taskId?: string;
  threadType: "semester_home" | "task";
  title: string;
  titleSource?: ThreadTitleSource;
  titleGeneratedAt?: string;
  sdkSessionId?: string;
  parentThreadId?: string;
  rootThreadId?: string;
  forkFromMessageUuid?: string;
  forkSourceSdkSessionId?: string;
  isDraft?: boolean;
  messageCount?: number;
  lastMessageAt?: string;
  workflow?: ThreadWorkflow;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export type ThreadWorkflow = PptThreadWorkflow;

export type ThreadWorkflowPhase = "planning" | "awaiting_confirmation" | "generating" | "done";

export interface PptThreadWorkflow {
  type: "ppt";
  skillSlug: string;
  phase: ThreadWorkflowPhase;
  startedAt: number;
  updatedAt: number;
}

export interface CreateThreadInput {
  courseId: string;
  taskId?: string;
  title?: string;
  isDraft?: boolean;
  parentThreadId?: string;
  rootThreadId?: string;
  forkFromMessageUuid?: string;
  forkSourceSdkSessionId?: string;
}

export interface RenameThreadInput {
  threadId: string;
  title: string;
}

export interface UpdateThreadWorkflowInput {
  threadId: string;
  workflow?: ThreadWorkflow;
}

export interface ForkThreadInput {
  threadId: string;
  upToMessageUuid: string;
}

export interface ArchivedThreadScope {
  semesterId?: string;
  courseId?: string;
}

export interface CreateTaskInput {
  courseId: string;
  title: string;
  taskType?: TaskType;
  icon?: TaskIconKey;
}

export interface UpdateTaskInput {
  id: string;
  title?: string;
  taskType?: TaskType;
  icon?: TaskIconKey;
  status?: TaskStatus;
  dueAt?: string | null;
  summary?: string;
  info?: CourseTaskInfo | null;
}

export type SkillResourceKind = "reference" | "script" | "asset" | "template" | "example" | "agent_config" | "other";

export interface SkillResource {
  kind: SkillResourceKind;
  name: string;
  relativePath: string;
  size: number;
  sizeLabel: string;
}

export interface SkillItem {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  version: string;
  category?: string;
  icon?: string;
  triggers?: string[];
  tags?: string[];
  scopes?: string[];
  allowedTools?: string[];
  instructions?: string;
  resources?: SkillResource[];
  slug?: string;
  sourcePath?: string;
}

export interface SkillCategory {
  id: string;
  name: string;
  system?: boolean;
}

export interface SkillLibrarySettings {
  categories: SkillCategory[];
  assignments: Record<string, string>;
}

export interface SkillUpdateInput {
  id: string;
  enabled: boolean;
}

export interface SkillWriteInput {
  id: string;
  content: string;
}

export interface SkillImportInput {
  sourcePath?: string;
  enabled?: boolean;
}

export interface RagSearchResult {
  id: string;
  courseId: string;
  fileId?: string;
  fileName?: string;
  title: string;
  source: string;
  sourcePath?: string;
  citation: string;
  excerpt: string;
  score: number;
  path?: string;
  sectionKind?: CourseFileSectionKind;
  taskId?: string;
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
}

export interface GitStatus {
  root: string;
  branch: string;
  changedFiles: number;
  summary: string;
}

export type WorkspaceFileKind =
  | "folder"
  | "pdf"
  | "docx"
  | "pptx"
  | "spreadsheet"
  | "image"
  | "markdown"
  | "code"
  | "text"
  | "unknown";

export interface WorkspaceFileNode {
  id: string;
  semesterId: string;
  courseId: string;
  taskId?: string;
  taskType?: TaskType;
  taskFileBucket?: TaskFileBucket;
  sectionKind?: CourseFileSectionKind;
  weekNumber?: number;
  sourcePath?: string;
  name: string;
  displayName?: string;
  path: string;
  kind: WorkspaceFileKind;
  sizeLabel?: string;
  /**
   * Only files explicitly imported or user-approved for course knowledge should
   * enter RAG. Disk-discovered / Agent-created files can still be visible.
   */
  ragEligible?: boolean;
  sourceKind?: "user_import" | "disk_discovered" | "agent_generated" | "system";
  indexingStatus?: FileIndexingStatus;
  indexingProgress?: number;
  indexingError?: string;
  indexingWarning?: string;
  indexingParser?: string;
  indexingParserDetail?: string;
  indexingUpdatedAt?: string;
  indexedAt?: string;
  updatedAt: string;
  children?: WorkspaceFileNode[];
}

export interface FilePreview {
  id: string;
  title: string;
  path: string;
  sourcePath?: string;
  kind: WorkspaceFileKind;
  mimeType?: string;
  fileUrl?: string;
  previewUrl?: string;
  content?: string;
  html?: string;
  summary?: string;
  presentation?: PresentationPreview;
  spreadsheet?: SpreadsheetPreview;
  metadata?: Record<string, string | number | boolean>;
  artifactPath?: string;
  semanticUnitsPath?: string;
}

export interface PresentationPreview {
  renderEngine: "brevyn-svg-v1";
  width: number;
  height: number;
  slideCount: number;
  renderedSlideCount: number;
  unsupportedCount: number;
  slides: PresentationPreviewSlide[];
}

export interface PresentationPreviewSlide {
  index: number;
  title?: string;
  text: string;
  previewUrl: string;
  unsupportedCount: number;
}

export interface SpreadsheetPreview {
  renderEngine: "brevyn-workbook-v1";
  sheetCount: number;
  renderedSheetCount: number;
  maxRows: number;
  maxColumns: number;
  truncated: boolean;
  sheets: SpreadsheetPreviewSheet[];
}

export interface SpreadsheetPreviewSheet {
  index: number;
  name: string;
  totalRows: number;
  totalColumns: number;
  renderedRows: number;
  renderedColumns: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
  columns?: SpreadsheetPreviewColumn[];
  rows: SpreadsheetPreviewRow[];
  mergedCells?: SpreadsheetPreviewMergedCell[];
  freezePanes?: SpreadsheetPreviewFreezePanes;
  charts?: SpreadsheetPreviewChart[];
  shapes?: SpreadsheetPreviewShape[];
  hyperlinks?: SpreadsheetPreviewHyperlink[];
  comments?: SpreadsheetPreviewComment[];
  tables?: SpreadsheetPreviewTable[];
  namedRanges?: SpreadsheetPreviewNamedRange[];
  render?: OfficeRenderSurfacePreview;
}

export interface SpreadsheetPreviewColumn {
  index: number;
  name: string;
  widthPx: number;
  hidden?: boolean;
}

export interface SpreadsheetPreviewRow {
  number: number;
  heightPx?: number;
  hidden?: boolean;
  cells: string[];
  cellObjects?: SpreadsheetPreviewCell[];
}

export interface SpreadsheetPreviewCell {
  ref: string;
  row: number;
  column: number;
  text: string;
  formula?: string;
  style?: SpreadsheetPreviewCellStyle;
  hyperlink?: SpreadsheetPreviewHyperlink;
  commentIds?: string[];
}

export interface SpreadsheetPreviewCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number;
  fontColor?: string;
  fillColor?: string;
  borderColor?: string;
  borderTop?: boolean;
  borderRight?: boolean;
  borderBottom?: boolean;
  borderLeft?: boolean;
  horizontalAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  wrapText?: boolean;
  numberFormat?: string;
}

export interface SpreadsheetPreviewMergedCell {
  ref: string;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export interface SpreadsheetPreviewFreezePanes {
  frozenRows: number;
  frozenColumns: number;
  topLeftCell?: string;
}

export type SpreadsheetPreviewChartType =
  | "bar"
  | "line"
  | "pie"
  | "doughnut"
  | "scatter"
  | "area"
  | "radar"
  | "bubble"
  | "stock"
  | "surface"
  | "treemap"
  | "sunburst"
  | "histogram"
  | "boxWhisker"
  | "waterfall"
  | "unknown";
export type SpreadsheetPreviewChartLegendPosition = "right" | "left" | "top" | "bottom" | "none";

export interface SpreadsheetPreviewChartStyle {
  grouping?: "clustered" | "stacked" | "percentStacked" | "standard";
  barDirection?: "bar" | "col";
  legendPosition?: SpreadsheetPreviewChartLegendPosition;
  dataLabels?: {
    showSeriesName?: boolean;
    showCategoryName?: boolean;
    showValue?: boolean;
    showPercent?: boolean;
    position?: string;
  };
  holeSize?: number;
  gapWidth?: number;
  firstSliceAngle?: number;
  axis?: {
    valueMin?: number;
    valueMax?: number;
    majorUnit?: number;
    categoryTitle?: string;
    valueTitle?: string;
    numberFormat?: string;
  };
}

export interface SpreadsheetPreviewChart {
  id: string;
  index: number;
  name: string;
  title: string;
  type: SpreadsheetPreviewChartType;
  subtype?: string;
  anchor?: SpreadsheetPreviewDrawingAnchor;
  sourceRefs: string[];
  series: SpreadsheetPreviewChartSeries[];
  style?: SpreadsheetPreviewChartStyle;
  render?: OfficeRenderSurfacePreview;
}

export interface SpreadsheetPreviewDrawingAnchor {
  fromRow?: number;
  fromColumn?: number;
  toRow?: number;
  toColumn?: number;
  widthPx?: number;
  heightPx?: number;
}

export interface SpreadsheetPreviewChartSeries {
  name: string;
  categoryRef?: string;
  valueRef?: string;
  xValueRef?: string;
  yValueRef?: string;
  bubbleSizeRef?: string;
  categories: string[];
  values: number[];
  xValues?: number[];
  yValues?: number[];
  bubbleSizes?: number[];
  rawValues: string[];
  color?: string;
  pointColors?: string[];
  chartType?: SpreadsheetPreviewChartType;
  axisGroup?: "primary" | "secondary";
  marker?: {
    symbol?: string;
    size?: number;
  };
  smooth?: boolean;
}

export interface SpreadsheetPreviewShape {
  id: string;
  index: number;
  name: string;
  text: string;
  shapeType?: string;
  fillColor?: string;
  lineColor?: string;
  anchor?: SpreadsheetPreviewDrawingAnchor;
}

export interface SpreadsheetPreviewHyperlink {
  id: string;
  ref: string;
  target?: string;
  location?: string;
  display?: string;
  tooltip?: string;
}

export interface SpreadsheetPreviewComment {
  id: string;
  ref: string;
  author?: string;
  text: string;
}

export interface SpreadsheetPreviewTable {
  id: string;
  name: string;
  displayName?: string;
  ref: string;
  columns: string[];
  totalsRowShown?: boolean;
}

export interface SpreadsheetPreviewNamedRange {
  id: string;
  name: string;
  ref: string;
  sheet?: string;
  hidden?: boolean;
}

export interface OfficeRenderSurfacePreview {
  id: string;
  kind: "svg" | "png" | "pdf" | "html";
  role: "sheet" | "chart" | "page" | "slide" | "thumbnail";
  width: number;
  height: number;
  mediaType: string;
  data?: string;
  path?: string;
  engine: string;
  warnings?: string[];
  targets?: OfficeRenderTargetPreview[];
}

export interface OfficeRenderTargetPreview {
  id: string;
  type: "cell" | "chart" | "text" | "image" | "shape";
  text?: string;
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  location: {
    page?: number;
    slide?: number;
    sheet?: string;
    range?: string;
    row?: number;
    column?: number;
    sectionPath?: string[];
    objectPath?: string;
  };
  metadata?: Record<string, string | number | boolean>;
}

export interface OpenPathOption {
  id: string;
  label: string;
  kind: "default" | "finder" | "terminal" | "editor" | "office" | "viewer" | "application";
  appPath?: string;
  iconDataUrl?: string;
}

export interface FileSectionStat {
  id: string;
  kind: CourseFileSectionKind;
  title: string;
  fileCount: number;
}

export interface FileStats {
  semesterId: string;
  courseId?: string;
  scope: "semester" | "course";
  totalFiles: number;
  sectionCount: number;
  sections: FileSectionStat[];
  byKind: Record<WorkspaceFileKind, number>;
}

export type TimetableViewMode = "week" | "month" | "year";
export type TimetableEventKind = "course_session" | "deadline" | "school_week" | "school_event";
export type TimetableEventSource = "manual" | "course" | "school_calendar";

export interface TimetableRangeQuery {
  viewMode: TimetableViewMode;
  rangeStart: string;
  rangeEnd: string;
  courseId?: string;
  includeSchoolEvents?: boolean;
  includeDeadlines?: boolean;
}

export interface TimetableEvent {
  id: string;
  semesterId?: string;
  title: string;
  kind: TimetableEventKind;
  source: TimetableEventSource;
  startsAt: string;
  endsAt?: string;
  courseId?: string;
  taskId?: string;
  location?: string;
  notes?: string;
  confidence?: number;
}

export type VisionRecognitionKind = "academic_calendar" | "course_timetable";
export type WeekdayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export interface VisionRecognitionInput {
  sourcePath: string;
  apply?: boolean;
  providerId?: string;
  modelId?: string;
}

export interface RecognizedCalendarEvent {
  title: string;
  startsAt: string;
  endsAt?: string;
  notes?: string;
  confidence?: number;
}

export interface RecognizedAcademicCalendar {
  kind: "academic_calendar";
  sourcePath: string;
  providerName: string;
  modelId: string;
  semester?: CreateSemesterInput;
  events: RecognizedCalendarEvent[];
  warnings: string[];
  applied?: {
    semester?: SemesterWorkspace;
    events: TimetableEvent[];
  };
}

export interface RecognizedCourseSession {
  dayOfWeek: WeekdayKey;
  startTime: string;
  endTime: string;
  room?: string;
  weeks?: string;
  confidence?: number;
}

export interface RecognizedCourseSchedule {
  code: string;
  name: string;
  section?: string;
  category?: string;
  icon?: CourseIconKey;
  instructor?: string;
  units?: number;
  sessions: RecognizedCourseSession[];
  confidence?: number;
}

export interface RecognizedCourseTimetable {
  kind: "course_timetable";
  sourcePath: string;
  providerName: string;
  modelId: string;
  semesterLabel?: string;
  courses: RecognizedCourseSchedule[];
  warnings: string[];
  applied?: {
    courses: Course[];
    events: TimetableEvent[];
  };
}

export type CourseFileSectionKind = "course_shared" | "lecture" | "task";
export type IndexingStatus = "idle" | "queued" | "indexing" | "indexed" | "failed" | "cancelled";
export type FileIndexingStatus = IndexingStatus | "partial" | "warning" | "skipped";

export interface CourseFileSection {
  id: string;
  courseId: string;
  kind: CourseFileSectionKind;
  title: string;
  taskType?: TaskType;
  icon?: TaskIconKey;
  taskFileBucket?: TaskFileBucket;
  weekNumber?: number;
  taskId?: string;
  indexingStatus: IndexingStatus;
  embeddingModel?: string;
  files: WorkspaceFileNode[];
}

export interface IndexingJob {
  id: string;
  semesterId?: string;
  courseId: string;
  sectionId?: string;
  status: IndexingStatus;
  stage?: string;
  embeddingModel: string;
  embeddingProviderFingerprint?: string;
  indexedFiles: number;
  totalFiles?: number;
  completedFiles?: number;
  progress: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export type EmbeddingIndexHealthState = "empty" | "ready" | "needs_rebuild";

export interface EmbeddingIndexHealth {
  state: EmbeddingIndexHealthState;
  embeddingConfigured: boolean;
  embeddingModel?: string;
  totalFiles: number;
  indexedFiles: number;
  readyFiles: number;
  staleFiles: number;
  unindexedFiles: number;
}

export interface IndexActiveSemesterFailure {
  courseId: string;
  courseName: string;
  message: string;
}

export interface IndexActiveSemesterResult {
  jobs: IndexingJob[];
  failures: IndexActiveSemesterFailure[];
}

export interface FileImportInput {
  courseId: string;
  targetSection: CourseFileSectionKind;
  sourcePaths?: string[];
  weekNumber?: number;
  taskId?: string;
  taskFileBucket?: TaskFileBucket;
}

export interface FileImportResult {
  files: WorkspaceFileNode[];
  tree: WorkspaceFileNode[];
  indexingJob: IndexingJob | null;
  indexingError?: string;
  indexingNotice?: string;
}

export interface DeleteFileInput {
  fileId: string;
  forceCancelIndexing?: boolean;
}

export type ExternalSourceKind = "web" | "file";
export type ExternalSourceScope = "task" | "course";
export type ExternalSourceStatus = "processing" | "ready" | "failed";

export interface ExternalSource {
  id: string;
  semesterId: string;
  courseId: string;
  taskId?: string;
  scope: ExternalSourceScope;
  kind: ExternalSourceKind;
  title: string;
  url?: string;
  originalPath?: string;
  markdownPath?: string;
  workspaceFileId?: string;
  status: ExternalSourceStatus;
  summary?: string;
  error?: string;
  addedBy: "user" | "agent";
  createdAt: string;
  updatedAt: string;
}

export interface ExternalSourceListInput {
  courseId: string;
  taskId?: string;
}

export interface ExternalSourceAddUrlInput {
  courseId: string;
  taskId?: string;
  scope: ExternalSourceScope;
  url: string;
  title?: string;
  addedBy?: "user" | "agent";
}

export interface ExternalSourceAddFilesInput {
  courseId: string;
  taskId?: string;
  scope: ExternalSourceScope;
}

export interface ExternalSourceAddResult {
  sources: ExternalSource[];
  tree: WorkspaceFileNode[];
  indexingJob: IndexingJob | null;
  indexingError?: string;
  indexingNotice?: string;
}

export type SourceCandidateStatus = "pending" | "accepting" | "accepted" | "rejected" | "failed";

export interface SourceCandidate {
  id: string;
  semesterId: string;
  courseId: string;
  taskId?: string;
  threadId?: string;
  scope: ExternalSourceScope;
  url: string;
  normalizedUrl?: string;
  title: string;
  siteName?: string;
  snippet?: string;
  reason: string;
  status: SourceCandidateStatus;
  externalSourceId?: string;
  error?: string;
  proposedBy: "agent";
  createdAt: string;
  updatedAt: string;
}

export interface SourceCandidateListInput {
  courseId: string;
  taskId?: string;
  threadId?: string;
  statuses?: SourceCandidateStatus[];
}

export interface SourceCandidateProposeInput {
  courseId: string;
  taskId?: string;
  threadId?: string;
  scope: ExternalSourceScope;
  url: string;
  title: string;
  siteName?: string;
  snippet?: string;
  reason: string;
}

export interface SourceCandidateProposeResult {
  candidate?: SourceCandidate;
  status: "created" | "updated" | "existing_source";
  message: string;
}

export interface SourceCandidateAcceptResult {
  candidate: SourceCandidate;
  externalSourceResult?: ExternalSourceAddResult;
}

export interface SourceCandidateChangedEvent {
  semesterId?: string;
  courseId?: string;
  taskId?: string;
  threadId?: string;
  candidateId?: string;
}

export type ProviderPurpose = "agent" | "embedding" | "vision" | "ocr";
export type AgentProtocol = "anthropic_messages" | "openai_responses";
export type EmbeddingProtocol = "openai_compatible";
export type VisionProtocol = "anthropic_messages" | "openai_compatible" | "openai_responses";
export type OcrProtocol = "anthropic_messages" | "openai_compatible" | "openai_responses";
export type ProviderProtocol = AgentProtocol | EmbeddingProtocol | VisionProtocol | OcrProtocol;
export type ProviderAdapterKind = "anthropic" | "openai_embedding" | "openai_chat_completions" | "openai_responses";
export type AgentProviderKind = "anthropic" | "deepseek" | "bailian-anthropic" | "kimi-api" | "kimi-coding" | "custom-anthropic" | "openai-responses-agent";
export type EmbeddingProviderKind = "openai" | "qwen" | "doubao" | "zhipu" | "minimax" | "custom-openai";
export type VisionProviderKind = "vision-bailian-openai" | "vision-custom-openai" | "vision-custom-anthropic" | "vision-openai-responses" | "vision-custom-openai-responses";
export type OcrProviderKind = "ocr-custom-openai" | "ocr-custom-anthropic" | "ocr-openai-responses";
export type ProviderKind = AgentProviderKind | EmbeddingProviderKind | VisionProviderKind | OcrProviderKind;
export type ProviderAuthMode = "api_key" | "auth_token" | "bearer";

export interface ProviderModel {
  id: string;
  name: string;
  enabled: boolean;
  supportsVision?: boolean;
  contextWindowTokens?: number;
  contextWindowSource?: "provider" | "user" | "inferred";
}

export interface ProviderPreset {
  kind: ProviderKind;
  purpose: ProviderPurpose;
  label: string;
  adapterKind: ProviderAdapterKind;
  protocol: ProviderProtocol;
  baseUrl: string;
  authMode: ProviderAuthMode;
  models?: readonly ProviderModel[];
}

export const AGENT_PROVIDER_PRESETS = {
  anthropic: {
    kind: "anthropic",
    purpose: "agent",
    label: "Anthropic",
    adapterKind: "anthropic",
    protocol: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    authMode: "api_key",
  },
  deepseek: {
    kind: "deepseek",
    purpose: "agent",
    label: "DeepSeek",
    adapterKind: "anthropic",
    protocol: "anthropic_messages",
    baseUrl: "https://api.deepseek.com/anthropic",
    authMode: "api_key",
    models: [
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", enabled: true },
      { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", enabled: true },
    ],
  },
  "bailian-anthropic": {
    kind: "bailian-anthropic",
    purpose: "agent",
    label: "Bailian Anthropic",
    adapterKind: "anthropic",
    protocol: "anthropic_messages",
    baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic/v1",
    authMode: "api_key",
  },
  "kimi-api": {
    kind: "kimi-api",
    purpose: "agent",
    label: "Kimi API",
    adapterKind: "anthropic",
    protocol: "anthropic_messages",
    baseUrl: "https://api.moonshot.cn/anthropic",
    authMode: "api_key",
    models: [{ id: "kimi-k2.6", name: "Kimi K2.6", enabled: true }],
  },
  "kimi-coding": {
    kind: "kimi-coding",
    purpose: "agent",
    label: "Kimi for Coding",
    adapterKind: "anthropic",
    protocol: "anthropic_messages",
    baseUrl: "https://api.kimi.com/coding/v1",
    authMode: "bearer",
    models: [{ id: "kimi-for-coding", name: "Kimi for Coding", enabled: true }],
  },
  "custom-anthropic": {
    kind: "custom-anthropic",
    purpose: "agent",
    label: "Custom Anthropic",
    adapterKind: "anthropic",
    protocol: "anthropic_messages",
    baseUrl: "",
    authMode: "api_key",
  },
  "openai-responses-agent": {
    kind: "openai-responses-agent",
    purpose: "agent",
    label: "OpenAI Responses",
    adapterKind: "openai_responses",
    protocol: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
    authMode: "bearer",
  },
} as const satisfies Record<AgentProviderKind, ProviderPreset>;

export const EMBEDDING_PROVIDER_PRESETS = {
  openai: {
    kind: "openai",
    purpose: "embedding",
    label: "OpenAI",
    adapterKind: "openai_embedding",
    protocol: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    authMode: "bearer",
  },
  qwen: {
    kind: "qwen",
    purpose: "embedding",
    label: "Qwen",
    adapterKind: "openai_embedding",
    protocol: "openai_compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    authMode: "bearer",
  },
  doubao: {
    kind: "doubao",
    purpose: "embedding",
    label: "Doubao",
    adapterKind: "openai_embedding",
    protocol: "openai_compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    authMode: "bearer",
  },
  zhipu: {
    kind: "zhipu",
    purpose: "embedding",
    label: "Zhipu AI",
    adapterKind: "openai_embedding",
    protocol: "openai_compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    authMode: "bearer",
  },
  minimax: {
    kind: "minimax",
    purpose: "embedding",
    label: "MiniMax",
    adapterKind: "openai_embedding",
    protocol: "openai_compatible",
    baseUrl: "https://api.minimax.chat/v1",
    authMode: "bearer",
  },
  "custom-openai": {
    kind: "custom-openai",
    purpose: "embedding",
    label: "Custom OpenAI Compatible",
    adapterKind: "openai_embedding",
    protocol: "openai_compatible",
    baseUrl: "",
    authMode: "bearer",
  },
} as const satisfies Record<EmbeddingProviderKind, ProviderPreset>;

export const VISION_PROVIDER_PRESETS = {
  "vision-bailian-openai": {
    kind: "vision-bailian-openai",
    purpose: "vision",
    label: "Bailian OpenAI Vision",
    adapterKind: "openai_chat_completions",
    protocol: "openai_compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    authMode: "bearer",
  },
  "vision-custom-openai": {
    kind: "vision-custom-openai",
    purpose: "vision",
    label: "Custom OpenAI-compatible Vision",
    adapterKind: "openai_chat_completions",
    protocol: "openai_compatible",
    baseUrl: "",
    authMode: "bearer",
  },
  "vision-custom-anthropic": {
    kind: "vision-custom-anthropic",
    purpose: "vision",
    label: "Custom Anthropic Vision",
    adapterKind: "anthropic",
    protocol: "anthropic_messages",
    baseUrl: "",
    authMode: "api_key",
  },
  "vision-openai-responses": {
    kind: "vision-openai-responses",
    purpose: "vision",
    label: "OpenAI Responses Vision",
    adapterKind: "openai_responses",
    protocol: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
    authMode: "bearer",
  },
  "vision-custom-openai-responses": {
    kind: "vision-custom-openai-responses",
    purpose: "vision",
    label: "Custom OpenAI Responses Vision",
    adapterKind: "openai_responses",
    protocol: "openai_responses",
    baseUrl: "",
    authMode: "bearer",
  },
} as const satisfies Record<VisionProviderKind, ProviderPreset>;

export const OCR_PROVIDER_PRESETS = {
  "ocr-custom-openai": {
    kind: "ocr-custom-openai",
    purpose: "ocr",
    label: "Custom OpenAI-compatible OCR",
    adapterKind: "openai_chat_completions",
    protocol: "openai_compatible",
    baseUrl: "",
    authMode: "bearer",
  },
  "ocr-custom-anthropic": {
    kind: "ocr-custom-anthropic",
    purpose: "ocr",
    label: "Custom Anthropic OCR",
    adapterKind: "anthropic",
    protocol: "anthropic_messages",
    baseUrl: "",
    authMode: "api_key",
  },
  "ocr-openai-responses": {
    kind: "ocr-openai-responses",
    purpose: "ocr",
    label: "OpenAI Responses OCR",
    adapterKind: "openai_responses",
    protocol: "openai_responses",
    baseUrl: "https://api.openai.com/v1",
    authMode: "bearer",
  },
} as const satisfies Record<OcrProviderKind, ProviderPreset>;

export const PROVIDER_PRESETS = {
  ...AGENT_PROVIDER_PRESETS,
  ...EMBEDDING_PROVIDER_PRESETS,
  ...VISION_PROVIDER_PRESETS,
  ...OCR_PROVIDER_PRESETS,
} as const satisfies Record<ProviderKind, ProviderPreset>;

export const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 77.5;
export const MIN_AUTO_COMPACT_THRESHOLD_PERCENT = 50;
export const MAX_AUTO_COMPACT_THRESHOLD_PERCENT = 95;

export interface ModelProviderConfig {
  id: string;
  purpose: ProviderPurpose;
  providerKind: ProviderKind;
  adapterKind: ProviderAdapterKind;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKeyMasked: string;
  apiKeySecretRef?: string;
  authMode: ProviderAuthMode;
  models: ProviderModel[];
  selectedModel: string;
  enabled: boolean;
  autoCompactThresholdPercent?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderDraftInput {
  id?: string;
  purpose: ProviderPurpose;
  providerKind: ProviderKind;
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  clearApiKey?: boolean;
  authMode: ProviderAuthMode;
  models?: ProviderModel[];
  selectedModel: string;
  enabled?: boolean;
  autoCompactThresholdPercent?: number;
}

export interface ProviderSaveResult {
  provider: ModelProviderConfig;
  embeddingIndexMayBeStale: boolean;
}

export interface ProviderDeleteInput {
  id: string;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  message: string;
}

export type AgentPermissionMode = "auto" | "bypassPermissions" | "plan";

export type BrevynUsageProviderProtocol = "anthropic_messages" | "openai_responses";
export type BrevynUsageContextWindowSource = "model_config" | "provider" | "user" | "inferred" | "unknown";

export interface BrevynUsageMetadata {
  providerProtocol: BrevynUsageProviderProtocol;
  providerId?: string;
  modelId?: string;
  inputTokens: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  contextInputTokens?: number;
  contextWindow?: number;
  contextWindowSource?: BrevynUsageContextWindowSource;
  raw?: unknown;
}

export interface LocalModelUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  contextInputTokens: number;
}

export interface LocalModelUsageModelSummary extends LocalModelUsageTotals {
  modelId: string;
  providerId?: string;
  requestCount: number;
  lastUsedAt?: string;
}

export interface LocalModelUsageRecord extends LocalModelUsageTotals {
  id: string;
  threadId: string;
  threadTitle: string;
  modelId: string;
  providerId?: string;
  createdAt: string;
}

export interface LocalModelUsageSummary {
  generatedAt: string;
  totals: LocalModelUsageTotals;
  today: LocalModelUsageTotals;
  last7Days: LocalModelUsageTotals;
  last30Days: LocalModelUsageTotals;
  requestCount: number;
  threadCount: number;
  modelCount: number;
  firstUsedAt?: string;
  lastUsedAt?: string;
  models: LocalModelUsageModelSummary[];
  recentRecords: LocalModelUsageRecord[];
}

export interface BrevynContextUsageSnapshot {
  threadId: string;
  runId: string;
  modelId?: string;
  usedTokens: number;
  maxTokens?: number;
  rawMaxTokens?: number;
  percentage?: number;
  categories?: Array<{
    name: string;
    tokens: number;
    color?: string;
    isDeferred?: boolean;
  }>;
  createdAt: string;
}

export interface ContextAnchorBase {
  id: string;
  threadId: string;
  text: string;
  capturedAt: number;
}

export interface FileContextAnchor extends ContextAnchorBase {
  kind: "file";
  filePath: string;
  fileName: string;
  fileId?: string;
  page?: number;
  slide?: number;
  sheet?: string;
  range?: string;
  semanticUnitId?: string;
  bbox?: string;
  sourceLabel?: string;
}

export interface MessageContextAnchor extends ContextAnchorBase {
  kind: "message";
  role: "user" | "assistant";
  label: string;
  messageId?: string;
}

export type ContextAnchor = FileContextAnchor | MessageContextAnchor;

export interface AgentAttachment {
  id: string;
  threadId: string;
  name: string;
  kind: WorkspaceFileKind;
  mimeType?: string;
  size: number;
  sizeLabel: string;
  path: string;
  createdAt: string;
  pending?: boolean;
  sourcePath?: string;
  persistedFromPending?: boolean;
}

export interface AgentAttachmentDataInput {
  threadId: string;
  name: string;
  mediaType?: string;
  data: string;
}

export interface AgentRunInput {
  threadId: string;
  prompt: string;
  displayPrompt?: string;
  skipAutoTitle?: boolean;
  uuid?: string;
  permissionMode?: AgentPermissionMode;
  providerId?: string;
  modelId?: string;
  attachments?: AgentAttachment[];
  mentionedSkills?: string[];
}

export interface AgentQueueMessageInput {
  threadId: string;
  prompt: string;
  uuid?: string;
  interrupt?: boolean;
  attachments?: AgentAttachment[];
  mentionedSkills?: string[];
}

export interface AgentApprovalInput {
  threadId: string;
  requestId: string;
}

export type AgentApprovalDecision = "allow" | "deny";
export type AgentExitPlanDecision = "approve" | "deny";
export type AgentRunTerminalStatus = "completed" | "stopped" | "failed" | "interrupted";

export interface AgentExitPlanAllowedPrompt {
  tool: "Bash";
  prompt: string;
}

export interface AgentExitPlanRequest {
  requestId: string;
  threadId: string;
  runId: string;
  toolInput: Record<string, unknown>;
  allowedPrompts: AgentExitPlanAllowedPrompt[];
  createdAt: string;
}

export interface AgentExitPlanResponseInput {
  threadId: string;
  requestId: string;
  decision: AgentExitPlanDecision;
  feedback?: string;
}

export interface AgentAskUserQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AgentAskUserQuestion {
  question: string;
  header?: string;
  options: AgentAskUserQuestionOption[];
  multiSelect?: boolean;
}

export interface AgentAskUserRequest {
  requestId: string;
  threadId: string;
  runId: string;
  questions: AgentAskUserQuestion[];
  toolInput: Record<string, unknown>;
  createdAt: string;
}

export interface AgentAskUserResponseInput {
  threadId: string;
  requestId: string;
  answers: Record<string, string>;
}

export interface AgentApprovalRequest {
  requestId: string;
  threadId: string;
  runId: string;
  toolName: string;
  toolUseId: string;
  input: unknown;
  riskLevel?: "normal" | "dangerous";
  title?: string;
  displayName?: string;
  description?: string;
  createdAt: string;
}

export type BrevynAgentRuntimeEvent =
  | { type: "run_started"; runId: string; threadId: string; permissionMode?: AgentPermissionMode; providerId?: string; modelId?: string; providerProtocol?: AgentProtocol; createdAt: string }
  | { type: "run_retrying"; runId: string; threadId: string; retryAttempt: number; maxRetries: number; reason: string; delayMs: number; createdAt: string }
  | { type: "run_retry_cleared"; runId: string; threadId: string; createdAt: string }
  | { type: "context_usage_updated"; snapshot: BrevynContextUsageSnapshot; createdAt: string }
  | { type: "run_completed"; runId: string; threadId: string; resultSubtype?: string; createdAt: string }
  | { type: "run_stopped"; runId: string; threadId: string; reason?: string; createdAt: string }
  | { type: "run_failed"; runId: string; threadId: string; error: string; createdAt: string }
  | { type: "run_interrupted"; runId: string; threadId: string; reason: string; createdAt: string }
  | { type: "plan_mode_entered"; runId: string; threadId: string; createdAt: string }
  | { type: "exit_plan_requested"; request: AgentExitPlanRequest; createdAt: string }
  | { type: "exit_plan_resolved"; runId: string; threadId: string; requestId: string; decision: AgentExitPlanDecision; feedback?: string; createdAt: string }
  | { type: "approval_requested"; request: AgentApprovalRequest; createdAt: string }
  | { type: "approval_resolved"; runId: string; threadId: string; requestId: string; decision: AgentApprovalDecision; createdAt: string }
  | { type: "ask_user_requested"; request: AgentAskUserRequest; createdAt: string }
  | { type: "ask_user_resolved"; runId: string; threadId: string; requestId: string; answers: Record<string, string>; createdAt: string };

export type BrevynAgentSessionRecord = SDKMessage;

export type BrevynAgentTimelineRecord =
  | BrevynAgentSessionRecord
  | { kind: "runtime"; event: BrevynAgentRuntimeEvent };

export type BrevynAgentEvent =
  | { kind: "sdk_message"; threadId: string; message: SDKMessage }
  | { kind: "brevyn_event"; event: BrevynAgentRuntimeEvent }
  | { kind: "thread_updated"; thread: Thread }
  | { kind: "task_updated"; task: BrevynTask };

export interface AgentRunResult {
  runId: string;
}

export interface UpdaterDownloadProgress {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export interface GitHubReleaseAsset {
  name: string;
  browserDownloadUrl: string;
  size: number;
}

export interface GitHubRelease {
  id: number;
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string;
  prerelease: boolean;
  draft: boolean;
  assets: GitHubReleaseAsset[];
}

export interface GitHubReleaseListOptions {
  perPage?: number;
  page?: number;
  includePrerelease?: boolean;
}

export type UpdaterStatus =
  | { status: "idle"; currentVersion: string; supported: boolean }
  | { status: "unsupported"; currentVersion: string; supported: false; reason: string }
  | { status: "checking"; currentVersion: string; supported: boolean }
  | { status: "available"; currentVersion: string; supported: boolean; version: string; releaseNotes?: string }
  | { status: "downloading"; currentVersion: string; supported: boolean; version: string; progress: UpdaterDownloadProgress }
  | { status: "downloaded"; currentVersion: string; supported: boolean; version: string; dismissed?: boolean }
  | { status: "not-available"; currentVersion: string; supported: boolean }
  | { status: "error"; currentVersion: string; supported: boolean; error: string };

export interface AppSettings {
  agentGateway: {
    openAiResponsesEnabled: boolean;
  };
  appearance: {
    themePreference: AppThemePreference;
    codeThemePreference: AppCodeThemePreference;
    fontSmoothingEnabled: boolean;
  };
  profile: UserProfileSettings;
  skillLibrary: SkillLibrarySettings;
}

export interface UserProfileSettings {
  displayName: string;
  /** Emoji string or data:image URL. Legacy fixed avatar ids are still accepted. */
  avatarId: string;
}

export interface UserProfileUpdateInput {
  displayName?: string;
  avatarId?: string;
}

export type AppTheme = "light" | "dark";
export type AppThemePreference = "system" | AppTheme;
export type AppCodeThemePreference = "brevyn" | "github" | "rose" | "mono";

export interface AppThemeState {
  preference: AppThemePreference;
  effective: AppTheme;
  codeThemePreference: AppCodeThemePreference;
  fontSmoothingEnabled: boolean;
}

export interface AgentGatewayStatus {
  enabled: boolean;
  state: "disabled" | "starting" | "running" | "stopping" | "failed";
  url?: string;
  activeRuns: number;
  error?: string;
}

export interface AppDiagnostics {
  generatedAt: string;
  app: {
    name: string;
    version: string;
    packaged: boolean;
  };
  runtime: {
    platform: string;
    arch: string;
    osRelease: string;
    electron: string;
    chrome: string;
    node: string;
    v8: string;
  };
  paths: {
    userData: string;
    dataRoot: string;
  };
  skills: {
    total: number;
    enabled: number;
  };
  theme: AppThemeState;
}

export type WorkspaceMemoryFileKind = "claude" | "auto";
export type WorkspaceMemoryScopeKind = "semester" | "task";

export interface WorkspaceMemoryScopeOption {
  id: string;
  kind: WorkspaceMemoryScopeKind;
  label: string;
  detail?: string;
}

export interface WorkspaceMemoryFileInfo {
  kind: WorkspaceMemoryFileKind;
  relativePath: string;
  path: string;
  exists: boolean;
  size: number;
  updatedAt?: string;
}

export interface WorkspaceMemoryFileNode {
  relativePath: string;
  name: string;
  type: "file" | "directory";
  size?: number;
  children?: WorkspaceMemoryFileNode[];
}

export interface WorkspaceMemorySummary {
  enabled: boolean;
  scopeId: string;
  scopeKind: WorkspaceMemoryScopeKind;
  scopeName: string;
  workspacePath: string;
  autoMemoryDir: string;
  claudeMd: WorkspaceMemoryFileInfo;
  autoMemoryIndex: WorkspaceMemoryFileInfo;
  autoMemoryFiles: WorkspaceMemoryFileNode[];
  scopes: WorkspaceMemoryScopeOption[];
}

export interface WorkspaceMemoryFileContent extends WorkspaceMemoryFileInfo {
  content: string;
}

export interface WorkspaceMemoryReadInput {
  scopeId?: string;
  kind: WorkspaceMemoryFileKind;
  relativePath?: string;
}

export interface WorkspaceMemoryWriteInput {
  scopeId?: string;
  kind: WorkspaceMemoryFileKind;
  relativePath?: string;
  content: string;
}

export interface BrevynAPI {
  semester: {
    list: () => Promise<SemesterWorkspace[]>;
    listArchived: () => Promise<SemesterWorkspace[]>;
    current: () => Promise<SemesterWorkspace | null>;
    create: (input: CreateSemesterInput) => Promise<SemesterWorkspace>;
    select: (semesterId: string) => Promise<SemesterWorkspace>;
    archive: (semesterId: string) => Promise<SemesterWorkspace>;
    restore: (semesterId: string) => Promise<SemesterWorkspace>;
    delete: (semesterId: string) => Promise<boolean>;
  };
  courses: {
    list: () => Promise<Course[]>;
    listForArchive: (scope?: ArchivedCourseScope) => Promise<Course[]>;
    listArchived: (scope?: ArchivedCourseScope) => Promise<Course[]>;
    create: (input: CreateCourseInput) => Promise<Course>;
    update: (input: UpdateCourseInput) => Promise<Course>;
    archive: (courseId: string) => Promise<Course>;
    restore: (courseId: string) => Promise<Course>;
    delete: (courseId: string) => Promise<boolean>;
  };
  tasks: {
    list: (courseId: string) => Promise<BrevynTask[]>;
    listArchived: (scope?: ArchivedTaskScope) => Promise<BrevynTask[]>;
    create: (input: CreateTaskInput) => Promise<BrevynTask>;
    update: (input: UpdateTaskInput) => Promise<BrevynTask>;
    archive: (taskId: string) => Promise<BrevynTask>;
    restore: (taskId: string) => Promise<BrevynTask>;
    delete: (taskId: string) => Promise<boolean>;
  };
  threads: {
    list: (courseId?: string) => Promise<Thread[]>;
    listArchived: (scope?: ArchivedThreadScope) => Promise<Thread[]>;
    create: (input: CreateThreadInput) => Promise<Thread>;
    fork: (input: ForkThreadInput) => Promise<Thread>;
    rename: (input: RenameThreadInput) => Promise<Thread>;
    updateWorkflow: (input: UpdateThreadWorkflowInput) => Promise<Thread>;
    archive: (threadId: string) => Promise<boolean>;
    restore: (threadId: string) => Promise<Thread>;
    delete: (threadId: string) => Promise<boolean>;
  };
  skills: {
    list: () => Promise<SkillItem[]>;
    update: (input: SkillUpdateInput) => Promise<SkillItem>;
    librarySettings: () => Promise<SkillLibrarySettings>;
    updateLibrarySettings: (settings: SkillLibrarySettings) => Promise<SkillLibrarySettings>;
    readContent: (skillId: string) => Promise<string>;
    writeContent: (input: SkillWriteInput) => Promise<SkillItem>;
    importFolder: (input: SkillImportInput) => Promise<SkillItem>;
    openFolder: (skillId: string) => Promise<void>;
  };
  memory: {
    summary: (scopeId?: string) => Promise<WorkspaceMemorySummary>;
    readFile: (input: WorkspaceMemoryReadInput) => Promise<WorkspaceMemoryFileContent>;
    writeFile: (input: WorkspaceMemoryWriteInput) => Promise<WorkspaceMemoryFileContent>;
  };
  rag: {
    search: (query: string, courseId?: string) => Promise<RagSearchResult[]>;
  };
  git: {
    status: () => Promise<GitStatus>;
  };
  files: {
    tree: (courseId?: string) => Promise<WorkspaceFileNode[]>;
    preview: (fileId: string) => Promise<FilePreview | null>;
    parsedPreview: (fileId: string) => Promise<FilePreview | null>;
    import: (input: FileImportInput) => Promise<FileImportResult>;
    sections: (courseId: string) => Promise<CourseFileSection[]>;
    stats: (courseId?: string) => Promise<FileStats>;
    index: (courseId: string, sectionId?: string) => Promise<IndexingJob>;
    retryIndex: (fileId: string) => Promise<IndexingJob>;
    indexActiveSemester: () => Promise<IndexActiveSemesterResult>;
    indexHealth: (courseId?: string) => Promise<EmbeddingIndexHealth>;
    indexingJobs: (courseId?: string) => Promise<IndexingJob[]>;
    cancelIndexing: (jobId: string) => Promise<IndexingJob | null>;
    open: (fileId: string) => Promise<void>;
    rename: (input: { fileId: string; name: string }) => Promise<{ courseId: string; tree: WorkspaceFileNode[] }>;
    delete: (input: string | DeleteFileInput) => Promise<{ courseId: string; tree: WorkspaceFileNode[] }>;
    reveal: (fileId: string) => Promise<void>;
    onChanged: (callback: () => void) => () => void;
  };
  externalSources: {
    list: (input: ExternalSourceListInput) => Promise<ExternalSource[]>;
    addUrl: (input: ExternalSourceAddUrlInput) => Promise<ExternalSourceAddResult>;
    addFiles: (input: ExternalSourceAddFilesInput) => Promise<ExternalSourceAddResult>;
    retry: (sourceId: string) => Promise<ExternalSourceAddResult>;
    delete: (sourceId: string) => Promise<boolean>;
  };
  sourceCandidates: {
    list: (input: SourceCandidateListInput) => Promise<SourceCandidate[]>;
    accept: (candidateId: string) => Promise<SourceCandidateAcceptResult>;
    reject: (candidateId: string) => Promise<SourceCandidate>;
    onChanged: (callback: (event: SourceCandidateChangedEvent) => void) => () => void;
  };
  providers: {
    list: () => Promise<ModelProviderConfig[]>;
    save: (input: ProviderDraftInput) => Promise<ProviderSaveResult>;
    delete: (providerId: string) => Promise<boolean>;
    decryptApiKey: (providerId: string) => Promise<string>;
    models: (input: string | ProviderDraftInput) => Promise<ProviderModel[]>;
    test: (input: string | ProviderDraftInput) => Promise<ProviderTestResult>;
    embeddingMutable: () => Promise<boolean>;
  };
  vision: {
    pickImage: () => Promise<string | null>;
    previewImage: (sourcePath: string) => Promise<string>;
    recognizeAcademicCalendar: (input: VisionRecognitionInput) => Promise<RecognizedAcademicCalendar>;
    recognizeCourseTimetable: (input: VisionRecognitionInput) => Promise<RecognizedCourseTimetable>;
    importAcademicCalendar: (input: RecognizedAcademicCalendar) => Promise<RecognizedAcademicCalendar>;
    importCourseTimetable: (input: RecognizedCourseTimetable) => Promise<RecognizedCourseTimetable>;
  };
  timetable: {
    range: (query: TimetableRangeQuery) => Promise<TimetableEvent[]>;
  };
  agent: {
    messages: (threadId: string) => Promise<BrevynAgentTimelineRecord[]>;
    usageSummary: () => Promise<LocalModelUsageSummary>;
    run: (input: AgentRunInput) => Promise<AgentRunResult>;
    queueMessage: (input: AgentQueueMessageInput) => Promise<string>;
    stop: (threadId: string) => Promise<boolean>;
    approve: (input: AgentApprovalInput) => Promise<boolean>;
    reject: (input: AgentApprovalInput) => Promise<boolean>;
    answerQuestion: (input: AgentAskUserResponseInput) => Promise<boolean>;
    resolveExitPlan: (input: AgentExitPlanResponseInput) => Promise<boolean>;
    onEvent: (callback: (event: BrevynAgentEvent) => void) => () => void;
  };
  agentGateway: {
    status: () => Promise<AgentGatewayStatus>;
    setEnabled: (enabled: boolean) => Promise<AgentGatewayStatus>;
  };
  attachments: {
    pick: (threadId: string) => Promise<AgentAttachment[]>;
    list: (threadId: string) => Promise<WorkspaceFileNode[]>;
    savePaths: (input: { threadId: string; paths: string[] }) => Promise<AgentAttachment[]>;
    saveData: (input: AgentAttachmentDataInput) => Promise<AgentAttachment>;
    delete: (input: { threadId: string; path: string }) => Promise<boolean>;
    pathForFile: (file: File) => string;
  };
  updater: {
    checkForUpdates: () => Promise<void>;
    downloadUpdate: () => Promise<void>;
    getStatus: () => Promise<UpdaterStatus>;
    listReleases: (options?: GitHubReleaseListOptions) => Promise<GitHubRelease[]>;
    getReleaseByTag: (tag: string) => Promise<GitHubRelease | null>;
    onStatusChanged: (callback: (status: UpdaterStatus) => void) => () => void;
    dismissDownloaded: () => Promise<UpdaterStatus>;
    quitAndInstall: () => Promise<void>;
  };
  app: {
    profile: () => Promise<UserProfileSettings>;
    updateProfile: (input: UserProfileUpdateInput) => Promise<UserProfileSettings>;
    diagnostics: () => Promise<AppDiagnostics>;
    theme: () => Promise<AppThemeState>;
    updateThemePreference: (preference: AppThemePreference) => Promise<AppThemeState>;
    updateCodeThemePreference: (preference: AppCodeThemePreference) => Promise<AppThemeState>;
    updateFontSmoothing: (enabled: boolean) => Promise<AppThemeState>;
    onThemeChanged: (callback: (theme: AppThemeState) => void) => () => void;
    openExternal: (url: string) => Promise<void>;
    revealPath: (path: string) => Promise<void>;
    openPathWith: (input: { path: string; optionId: string; appPath?: string }) => Promise<void>;
    openPathOptions: (path: string) => Promise<OpenPathOption[]>;
    openWorkspacePath: (input: { threadId: string; path: string }) => Promise<void>;
    previewWorkspacePath: (input: { threadId: string; path: string }) => Promise<FilePreview | null>;
  };
}
