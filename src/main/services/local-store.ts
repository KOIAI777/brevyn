import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import AdmZip from "adm-zip";
import type {
  AgentAttachment,
  AgentAttachmentDataInput,
  Course,
  CourseFileSection,
  ArchivedCourseScope,
  ArchivedThreadScope,
  AgentApprovalInput,
  AgentAskUserResponseInput,
  AgentExitPlanResponseInput,
  AgentQueueMessageInput,
  AgentRunInput,
  AgentRunResult,
  AgentGatewayStatus,
  AppCodeThemePreference,
  AppThemePreference,
  BrevynAgentEvent,
  BrevynAgentTimelineRecord,
  BrevynUsageMetadata,
  DeleteFileInput,
  EmbeddingIndexHealth,
  ExternalSource,
  ExternalSourceAddFilesInput,
  ExternalSourceAddResult,
  ExternalSourceAddUrlInput,
  ExternalSourceListInput,
  CreateCourseInput,
  CreateSemesterInput,
  CreateTaskInput,
  CreateThreadInput,
  ForkThreadInput,
  FileImportInput,
  FileImportResult,
  FilePreview,
  FileStats,
  GitStatus,
  IndexActiveSemesterResult,
  IndexingJob,
  LocalModelUsageModelSummary,
  LocalModelUsageRecord,
  LocalModelUsageSummary,
  LocalModelUsageTotals,
  ModelProviderConfig,
  ProviderDraftInput,
  ProviderModel,
  ProviderSaveResult,
  ProviderTestResult,
  RagSearchResult,
  RecognizedAcademicCalendar,
  RecognizedCourseTimetable,
  RenameThreadInput,
  SemesterWorkspace,
  SourceCandidate,
  SourceCandidateAcceptResult,
  SourceCandidateListInput,
  SourceCandidateProposeInput,
  SourceCandidateProposeResult,
  SkillImportInput,
  SkillItem,
  SkillLibrarySettings,
  SkillUpdateInput,
  SkillWriteInput,
  TaskStatus,
  Thread,
  TimetableEvent,
  TimetableRangeQuery,
  UpdateThreadWorkflowInput,
  UserProfileSettings,
  UserProfileUpdateInput,
  VisionRecognitionInput,
  BrevynTask,
  UpdateCourseInput,
  UpdateTaskInput,
  ArchivedTaskScope,
  WorkspaceMemoryFileContent,
  WorkspaceMemoryFileKind,
  WorkspaceMemoryFileNode,
  WorkspaceMemoryReadInput,
  WorkspaceMemoryScopeOption,
  WorkspaceMemorySummary,
  WorkspaceMemoryWriteInput,
  WorkspaceFileNode,
} from "../../types/domain";
import { AgentEventBus, AgentGatewayService, AgentOrchestrator, AgentSessionStore, AskUserService, ClaudeSdkAdapter, ExitPlanService, PermissionService, PromptBuilder } from "../agent";
import type { IndexingTaskRecord, IndexingWorkerResult } from "../indexing";
import { firstDefaultSkillSourceDir, SkillFileStore } from "../skills/skill-file-store";
import { BUILTIN_SKILL_BLUEPRINTS } from "../skills/skill-registry";
import { SQLiteBusinessStore } from "../storage";
import { FileService } from "./file-service";
import { AppSettingsStore } from "./app-settings-store";
import { broadcastSourceCandidatesChanged } from "../ipc/source-candidates-ipc";
import { DocumentParseService } from "./document-parse-service";
import { ProviderConfigStore } from "./provider-config-store";
import { ProviderSecretStore } from "./provider-secret-store";
import { ProviderService, envApiKeyForProvider } from "./provider-service";
import { ProviderTransactionStore } from "./provider-transaction-store";
import { schedulePreviewCacheCleanup } from "./preview-cache-cleanup";
import { RagIndexService, type RagSearchOptions } from "./rag-index-service";
import { VisionRecognitionService } from "./vision-recognition-service";
import { WorkspaceService } from "./workspace-service";
import { archivedCourseIdsForSemester, currentActiveSemesterId, isCurrentSemesterArchived } from "./workspace-state";
import { ensureAgentProjectScaffold, ensureAgentWorkspaceMemoryScaffold, ensureSemesterSharedDirs, ensureTaskWorkspaceDir, isPathInside, sanitizeFsSegment, workspacePathForThread } from "./workspace-paths";
import { formatSize, kindForPath } from "./workspace-file-tree";

export { SEMESTER_HOME_COURSE_ID } from "./workspace-paths";

const MAX_AGENT_ATTACHMENT_DATA_BYTES = 100 * 1024 * 1024;
const MAX_WORKSPACE_MEMORY_BYTES = 1024 * 1024;
const MAX_WORKSPACE_MEMORY_TREE_DEPTH = 4;

interface LocalStoreOptions {
  isPackaged?: boolean;
}

export class LocalStore {
  private readonly rootDataDir: string;
  private readonly ragIndex: RagIndexService;
  private readonly skillFiles: SkillFileStore;
  private readonly providers: ProviderService;
  private readonly vision: VisionRecognitionService;
  private readonly workspace: WorkspaceService;
  private readonly files: FileService;
  readonly documentParser: DocumentParseService;
  private readonly agent: AgentOrchestrator;
  private readonly appSettings: AppSettingsStore;
  private readonly agentGateway: AgentGatewayService;
  private readonly agentSessions: AgentSessionStore;

  constructor(
    private readonly filePath: string,
    private readonly businessStore: SQLiteBusinessStore,
    providerConfigs: ProviderConfigStore,
    providerSecrets?: ProviderSecretStore,
    _options: LocalStoreOptions = {},
  ) {
    this.rootDataDir = dirname(this.filePath);
    this.appSettings = new AppSettingsStore(join(this.rootDataDir, "app-settings.json"));
    this.agentGateway = new AgentGatewayService({
      enabled: this.appSettings.get().agentGateway.openAiResponsesEnabled,
    });
    this.providers = new ProviderService(providerConfigs, providerSecrets, new ProviderTransactionStore(join(this.rootDataDir, "provider-transactions.json")));
    this.skillFiles = new SkillFileStore(this.rootDataDir);
    this.skillFiles.ensureDefaultSkillTemplates(BUILTIN_SKILL_BLUEPRINTS);
    const defaultSkillSource = firstDefaultSkillSourceDir(bundledDefaultSkillDirs(this.rootDataDir));
    if (defaultSkillSource) this.skillFiles.syncDefaultSkillFolders(defaultSkillSource);
    this.skillFiles.ensureNativePluginManifest();
    this.ragIndex = new RagIndexService({
      dbPath: join(this.rootDataDir, "indexes", "rag"),
      resolveEmbeddingProvider: () => this.providers.embeddingProvider(),
      resolveApiKey: (provider) => this.providers.apiKey(provider.id) || envApiKeyForProvider(provider),
      textIndex: businessStore,
    });
    this.workspace = new WorkspaceService({
      rootDataDir: this.rootDataDir,
      businessStore,
      ragIndex: this.ragIndex,
    });
    this.vision = new VisionRecognitionService({
      rootDataDir: this.rootDataDir,
      businessStore,
      providers: this.providers,
    });
    this.files = new FileService({
      rootDataDir: this.rootDataDir,
      businessStore,
      providers: this.providers,
      ragIndex: this.ragIndex,
    });
    this.documentParser = new DocumentParseService({
      rootDataDir: this.rootDataDir,
      providers: this.providers,
    });
    this.agentSessions = new AgentSessionStore(this.rootDataDir);
    const agentEventBus = new AgentEventBus();
    this.agent = new AgentOrchestrator({
      rootDataDir: this.rootDataDir,
      businessStore,
      providers: this.providers,
      skillFiles: this.skillFiles,
      sessions: this.agentSessions,
      eventBus: agentEventBus,
      promptBuilder: new PromptBuilder(),
      permissions: new PermissionService(),
      askUsers: new AskUserService(),
      exitPlans: new ExitPlanService(),
      sdk: new ClaudeSdkAdapter(),
      gateway: this.agentGateway,
      ragSearch: (input) => this.searchRag(input.query, input.courseId, input),
      proposeExternalSource: (input) => this.proposeSourceCandidate(input),
    });
    void this.agentGateway.syncConfiguredState().catch((error) => {
      console.warn("[agent-gateway] Failed to sync configured state", error);
    });
    schedulePreviewCacheCleanup(this.rootDataDir);
  }

  dataRoot(): string {
    return this.rootDataDir;
  }

  listSemesters(): SemesterWorkspace[] {
    return this.workspace.listSemesters();
  }

  listArchivedSemesters(): SemesterWorkspace[] {
    return this.workspace.listArchivedSemesters();
  }

  currentSemester(): SemesterWorkspace | null {
    return this.workspace.currentSemester();
  }

  createSemester(input: CreateSemesterInput): SemesterWorkspace {
    return this.workspace.createSemester(input);
  }

  selectSemester(semesterId: string): SemesterWorkspace {
    const semester = this.workspace.selectSemester(semesterId);
    this.syncActiveSemesterDiskFiles();
    return semester;
  }

  archiveSemester(semesterId: string): SemesterWorkspace {
    return this.workspace.archiveSemester(semesterId);
  }

  restoreSemester(semesterId: string): SemesterWorkspace {
    return this.workspace.restoreSemester(semesterId);
  }

  deleteSemester(semesterId: string): Promise<boolean> {
    return this.workspace.deleteSemester(semesterId);
  }

  listCourses(): Course[] {
    return this.workspace.listCourses();
  }

  listCoursesForArchive(scope?: ArchivedCourseScope): Course[] {
    return this.workspace.listCoursesForArchive(scope);
  }

  listArchivedCourses(scope?: ArchivedCourseScope): Course[] {
    return this.workspace.listArchivedCourses(scope);
  }

  createCourse(input: CreateCourseInput): Course {
    return this.workspace.createCourse(input);
  }

  updateCourse(input: UpdateCourseInput): Course {
    return this.workspace.updateCourse(input);
  }

  archiveCourse(courseId: string): Course {
    return this.workspace.archiveCourse(courseId);
  }

  restoreCourse(courseId: string): Course {
    return this.workspace.restoreCourse(courseId);
  }

  deleteCourse(courseId: string): Promise<boolean> {
    return this.workspace.deleteCourse(courseId);
  }

  listTasks(courseId: string): BrevynTask[] {
    return this.workspace.listTasks(courseId);
  }

  listArchivedTasks(scope?: ArchivedTaskScope): BrevynTask[] {
    return this.workspace.listArchivedTasks(scope);
  }

  createTask(input: CreateTaskInput): BrevynTask {
    return this.workspace.createTask(input);
  }

  updateTask(input: UpdateTaskInput): BrevynTask {
    return this.workspace.updateTask(input);
  }

  archiveTask(taskId: string): BrevynTask {
    return this.workspace.archiveTask(taskId);
  }

  restoreTask(taskId: string): BrevynTask {
    return this.workspace.restoreTask(taskId);
  }

  deleteTask(taskId: string): Promise<boolean> {
    return this.workspace.deleteTask(taskId);
  }

  listThreads(courseId?: string): Thread[] {
    return this.workspace.listThreads(courseId);
  }

  listArchivedThreads(scope?: ArchivedThreadScope): Thread[] {
    return this.workspace.listArchivedThreads(scope);
  }

  createThread(input: CreateThreadInput): Thread {
    return this.workspace.createThread(input);
  }

  async forkThread(input: ForkThreadInput): Promise<Thread> {
    return await this.workspace.forkThread(input);
  }

  renameThread(input: RenameThreadInput): Thread {
    return this.workspace.renameThread(input.threadId, input.title);
  }

  updateThreadWorkflow(input: UpdateThreadWorkflowInput): Thread {
    return this.workspace.updateThreadWorkflow(input.threadId, input.workflow);
  }

  archiveThread(threadId: string): boolean {
    return this.workspace.archiveThread(threadId);
  }

  restoreThread(threadId: string): Thread {
    return this.workspace.restoreThread(threadId);
  }

  deleteThread(threadId: string): boolean {
    return this.workspace.deleteThread(threadId);
  }

  gitStatus(): GitStatus {
    return this.workspace.gitStatus();
  }

  async searchRag(query: string, courseId?: string, options?: RagSearchOptions & { limit?: number }): Promise<RagSearchResult[]> {
    return await this.files.searchRag(query, courseId, options);
  }

  listFiles(courseId?: string): WorkspaceFileNode[] {
    return this.files.listFiles(courseId);
  }

  syncActiveSemesterDiskFiles(): boolean {
    return this.files.syncActiveSemesterDiskFiles();
  }

  fileStats(courseId?: string): FileStats {
    return this.files.fileStats(courseId);
  }

  previewFile(fileId: string): Promise<FilePreview | null> {
    return this.files.previewFile(fileId);
  }

  previewParsedFile(fileId: string): Promise<FilePreview | null> {
    return this.files.previewParsedFile(fileId);
  }

  async previewThreadWorkspacePath(threadId: string, requestedPath: string): Promise<FilePreview | null> {
    const targetPath = this.resolveThreadWorkspacePath(threadId, requestedPath);
    return this.files.previewWorkspacePath(targetPath, requestedPath);
  }

  importFiles(input: FileImportInput): Promise<FileImportResult> {
    return this.files.importFiles(input);
  }

  listExternalSources(input: ExternalSourceListInput): ExternalSource[] {
    return this.files.listExternalSources(input);
  }

  addExternalSourceUrl(input: ExternalSourceAddUrlInput): Promise<ExternalSourceAddResult> {
    return this.files.addExternalSourceUrl(input);
  }

  addExternalSourceFiles(input: ExternalSourceAddFilesInput & { sourcePaths: string[] }): Promise<ExternalSourceAddResult> {
    return this.files.addExternalSourceFiles(input);
  }

  retryExternalSource(sourceId: string): Promise<ExternalSourceAddResult> {
    return this.files.retryExternalSource(sourceId);
  }

  deleteExternalSource(sourceId: string): Promise<boolean> {
    return this.files.deleteExternalSource(sourceId);
  }

  listSourceCandidates(input: SourceCandidateListInput): SourceCandidate[] {
    return this.files.listSourceCandidates(input);
  }

  proposeSourceCandidate(input: SourceCandidateProposeInput): SourceCandidateProposeResult {
    const result = this.files.proposeSourceCandidate(input);
    if (result.candidate) {
      broadcastSourceCandidatesChanged({
        semesterId: result.candidate.semesterId,
        courseId: result.candidate.courseId,
        taskId: result.candidate.taskId,
        threadId: result.candidate.threadId,
        candidateId: result.candidate.id,
      });
    }
    return result;
  }

  acceptSourceCandidate(candidateId: string): Promise<SourceCandidateAcceptResult> {
    return this.files.acceptSourceCandidate(candidateId);
  }

  rejectSourceCandidate(candidateId: string): SourceCandidate {
    return this.files.rejectSourceCandidate(candidateId);
  }

  fileSourcePath(fileId: string): string | undefined {
    return this.files.fileSourcePath(fileId);
  }

  fileOpenPath(fileId: string): string | undefined {
    return this.files.fileOpenPath(fileId);
  }

  renameFile(fileId: string, name: string): Promise<{ courseId: string; tree: WorkspaceFileNode[] }> {
    return this.files.renameFile(fileId, name);
  }

  deleteFile(input: string | DeleteFileInput): Promise<{ courseId: string; tree: WorkspaceFileNode[] }> {
    return this.files.deleteFile(input);
  }

  courseFileSections(courseId: string): CourseFileSection[] {
    return this.files.courseFileSections(courseId);
  }

  indexCourseFiles(courseId: string, sectionId?: string): IndexingJob {
    return this.files.indexCourseFiles(courseId, sectionId);
  }

  reindexCourseFiles(courseId: string, sectionId?: string): Promise<IndexingJob> {
    return this.files.reindexCourseFiles(courseId, sectionId);
  }

  retryIndexingFile(fileId: string): IndexingJob {
    return this.files.retryIndexingFile(fileId);
  }

  indexActiveSemesterCourses(): Promise<IndexActiveSemesterResult> {
    return this.files.indexActiveSemesterCourses();
  }

  embeddingIndexHealth(courseId?: string): EmbeddingIndexHealth {
    return this.files.embeddingIndexHealth(courseId);
  }

  listIndexingJobs(courseId?: string): IndexingJob[] {
    return this.files.listIndexingJobs(courseId);
  }

  cancelIndexingJob(jobId: string): IndexingJob | null {
    return this.files.cancelIndexingJob(jobId);
  }

  claimNextIndexingTask(workerId: string, lockMs: number): IndexingTaskRecord | null {
    return this.files.claimNextIndexingTask(workerId, lockMs);
  }

  recoverExpiredIndexingTasks(currentWorkerId?: string): void {
    this.files.recoverExpiredIndexingTasks(currentWorkerId);
  }

  async completeIndexingTask(taskId: string, result: IndexingWorkerResult, workerId?: string, lockedUntil?: string): Promise<IndexingJob | null> {
    return await this.files.completeIndexingTask(taskId, result, workerId, lockedUntil);
  }

  failIndexingTask(taskId: string, message: string, workerId?: string, lockedUntil?: string): IndexingJob | null {
    return this.files.failIndexingTask(taskId, message, workerId, lockedUntil);
  }

  listSkills(): SkillItem[] {
    return mergeSkills(this.skillFiles.listSkills());
  }

  skillLibrarySettings(): SkillLibrarySettings {
    return this.appSettings.skillLibrary();
  }

  updateSkillLibrarySettings(settings: SkillLibrarySettings): SkillLibrarySettings {
    return this.appSettings.updateSkillLibrary(settings);
  }

  updateSkill(input: SkillUpdateInput): SkillItem {
    const skillId = requireNonEmptyString((input as Partial<SkillUpdateInput> | null | undefined)?.id, "Skill id");
    const fileSkill = this.skillFiles.toggleSkill(skillId, Boolean((input as Partial<SkillUpdateInput> | null | undefined)?.enabled));
    if (fileSkill) return fileSkill;
    throw new Error(`File skill not found: ${skillId}`);
  }

  readSkillContent(skillId: string): string {
    const id = requireNonEmptyString(skillId, "Skill id");
    const content = this.skillFiles.readSkillContent(id);
    if (content == null) throw new Error(`Skill content not found: ${id}`);
    return content;
  }

  writeSkillContent(input: SkillWriteInput): SkillItem {
    const skillId = requireNonEmptyString((input as Partial<SkillWriteInput> | null | undefined)?.id, "Skill id");
    const content = stringValue((input as Partial<SkillWriteInput> | null | undefined)?.content);
    if (!content.trim()) throw new Error("SKILL.md cannot be saved empty.");
    const updated = this.skillFiles.writeSkillContent(skillId, content);
    if (!updated) throw new Error(`Skill content not found: ${skillId}`);
    return updated;
  }

  importSkillFolder(input: SkillImportInput): SkillItem {
    if (!input.sourcePath?.trim()) throw new Error("Skill import requires a source folder.");
    return this.skillFiles.importSkillFolder(input.sourcePath, input.enabled ?? true);
  }

  skillFolderPath(skillId: string): string {
    const id = requireNonEmptyString(skillId, "Skill id");
    const dir = this.skillFiles.skillFolderPath(id);
    if (!dir) throw new Error(`Skill folder not found: ${id}`);
    return dir;
  }

  workspaceMemorySummary(scopeId?: string): WorkspaceMemorySummary {
    return this.buildWorkspaceMemorySummary(scopeId);
  }

  readWorkspaceMemoryFile(input: WorkspaceMemoryReadInput): WorkspaceMemoryFileContent {
    const kind = input.kind === "auto" ? "auto" : "claude";
    const summary = this.buildWorkspaceMemorySummary(input.scopeId);
    const info = kind === "claude"
      ? summary.claudeMd
      : memoryFileInfo("auto", resolveWorkspaceAutoMemoryPath(summary.autoMemoryDir, input.relativePath || "MEMORY.md"), normalizeMemoryRelativePath(input.relativePath || "MEMORY.md"));
    if (!info.exists) {
      return {
        ...info,
        content: "",
      };
    }
    if (info.size > MAX_WORKSPACE_MEMORY_BYTES) {
      throw new Error("记忆文件过大，暂不支持在设置里编辑。");
    }
    return {
      ...info,
      content: readFileSync(info.path, "utf8"),
    };
  }

  writeWorkspaceMemoryFile(input: WorkspaceMemoryWriteInput): WorkspaceMemoryFileContent {
    const kind = input.kind === "auto" ? "auto" : "claude";
    const content = stringValue(input.content);
    const byteLength = Buffer.byteLength(content, "utf8");
    if (byteLength > MAX_WORKSPACE_MEMORY_BYTES) {
      throw new Error("记忆内容过大，暂不支持保存。");
    }
    const summary = this.buildWorkspaceMemorySummary(input.scopeId);
    const info = kind === "claude"
      ? summary.claudeMd
      : memoryFileInfo("auto", resolveWorkspaceAutoMemoryPath(summary.autoMemoryDir, input.relativePath || "MEMORY.md"), normalizeMemoryRelativePath(input.relativePath || "MEMORY.md"));
    mkdirSync(dirname(info.path), { recursive: true });
    writeFileSync(info.path, content, "utf8");
    return this.readWorkspaceMemoryFile({ scopeId: input.scopeId, kind, relativePath: info.relativePath });
  }

  listProviders(): ModelProviderConfig[] {
    return this.providers.list().map((provider) => ({ ...provider }));
  }

  saveProvider(input: ProviderDraftInput): ProviderSaveResult {
    this.assertEmbeddingProviderMutable(input.purpose);
    return this.providers.save(input);
  }

  deleteProvider(providerId: string): boolean {
    const provider = this.providers.list().find((item) => item.id === providerId);
    this.assertEmbeddingProviderMutable(provider?.purpose);
    return this.providers.delete(providerId);
  }

  providerModels(providerId: string): Promise<ProviderModel[]> {
    return this.providers.models(providerId);
  }

  providerModelsFromDraft(input: ProviderDraftInput): Promise<ProviderModel[]> {
    return this.providers.modelsFromDraft(input);
  }

  testProvider(providerId: string): Promise<ProviderTestResult> {
    return this.providers.test(providerId);
  }

  testProviderDraft(input: ProviderDraftInput): Promise<ProviderTestResult> {
    return this.providers.testDraft(input);
  }

  hasActiveIndexingJobs(): boolean {
    const semesterId = currentActiveSemesterId(this.businessStore);
    return semesterId ? this.businessStore.hasActiveSemesterIndexing(semesterId) : false;
  }

  async recognizeAcademicCalendar(input: VisionRecognitionInput): Promise<RecognizedAcademicCalendar> {
    return await this.vision.recognizeAcademicCalendar(input);
  }

  async recognizeCourseTimetable(input: VisionRecognitionInput): Promise<RecognizedCourseTimetable> {
    return await this.vision.recognizeCourseTimetable(input);
  }

  importAcademicCalendar(input: RecognizedAcademicCalendar): RecognizedAcademicCalendar {
    return this.vision.importAcademicCalendar(input);
  }

  importCourseTimetable(input: RecognizedCourseTimetable): RecognizedCourseTimetable {
    return this.vision.importCourseTimetable(input);
  }

  providerApiKey(providerId: string): string | undefined {
    return this.providers.apiKey(providerId);
  }

  providerHasApiKey(providerId: string): boolean {
    return this.providers.hasApiKey(providerId);
  }

  providerSecretStorageAvailable(): boolean {
    return this.providers.secretStorageAvailable();
  }

  agentGatewayStatus(): AgentGatewayStatus {
    return this.agentGateway.getStatus();
  }

  async setAgentGatewayEnabled(enabled: boolean): Promise<AgentGatewayStatus> {
    this.appSettings.updateAgentGateway({ openAiResponsesEnabled: enabled });
    return await this.agentGateway.setEnabled(enabled);
  }

  profile(): UserProfileSettings {
    return this.appSettings.get().profile;
  }

  updateProfile(input: UserProfileUpdateInput): UserProfileSettings {
    return this.appSettings.updateProfile(input).profile;
  }

  themePreference(): AppThemePreference {
    return this.appSettings.get().appearance.themePreference;
  }

  updateThemePreference(preference: AppThemePreference): AppThemePreference {
    return this.appSettings.updateAppearance({ themePreference: preference }).appearance.themePreference;
  }

  codeThemePreference(): AppCodeThemePreference {
    return this.appSettings.get().appearance.codeThemePreference;
  }

  updateCodeThemePreference(preference: AppCodeThemePreference): AppCodeThemePreference {
    return this.appSettings.updateAppearance({ codeThemePreference: preference }).appearance.codeThemePreference;
  }

  fontSmoothingEnabled(): boolean {
    return this.appSettings.get().appearance.fontSmoothingEnabled;
  }

  updateFontSmoothingEnabled(enabled: boolean): boolean {
    return this.appSettings.updateAppearance({ fontSmoothingEnabled: enabled }).appearance.fontSmoothingEnabled;
  }

  listTimetableEvents(query: TimetableRangeQuery): TimetableEvent[] {
    if (isCurrentSemesterArchived(this.businessStore)) return [];
    const semesterId = currentActiveSemesterId(this.businessStore);
    if (!semesterId) return [];
    const archivedCourseIds = new Set(archivedCourseIdsForSemester(this.businessStore, semesterId));
    const start = Date.parse(query.rangeStart);
    const end = Date.parse(query.rangeEnd);
    return this.businessStore.listTimetableEvents(semesterId)
      .filter((event) => {
        if (event.courseId && archivedCourseIds.has(event.courseId)) return false;
        const startsAt = Date.parse(event.startsAt);
        const endsAt = Date.parse(event.endsAt || event.startsAt);
        const inRange = startsAt <= end && endsAt >= start;
        if (!inRange) return false;
        if (query.courseId && event.courseId && event.courseId !== query.courseId) return false;
        if ((event.kind === "school_event" || event.kind === "school_week") && query.includeSchoolEvents === false) return false;
        if (event.kind === "deadline" && query.includeDeadlines === false) return false;
        return true;
      })
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  }

  agentMessages(threadId: string): BrevynAgentTimelineRecord[] {
    return this.agent.messages(threadId);
  }

  agentUsageSummary(): LocalModelUsageSummary {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const last7DaysStart = new Date(now);
    last7DaysStart.setDate(last7DaysStart.getDate() - 6);
    last7DaysStart.setHours(0, 0, 0, 0);
    const last30DaysStart = new Date(now);
    last30DaysStart.setDate(last30DaysStart.getDate() - 29);
    last30DaysStart.setHours(0, 0, 0, 0);

    const totals = emptyUsageTotals();
    const today = emptyUsageTotals();
    const last7Days = emptyUsageTotals();
    const last30Days = emptyUsageTotals();
    const records: LocalModelUsageRecord[] = [];
    const modelStats = new Map<string, LocalModelUsageModelSummary>();
    const threadIds = new Set<string>();
    let firstUsedAt: string | undefined;
    let lastUsedAt: string | undefined;

    for (const thread of this.businessStore.listThreads()) {
      let threadHasUsage = false;
      let timeline: BrevynAgentTimelineRecord[] = [];
      try {
        timeline = this.agentSessions.read(thread);
      } catch (error) {
        console.warn("[local-usage] Failed to read agent session", thread.id, error);
        continue;
      }
      for (const record of timeline) {
        const usage = localUsageFromRecord(record);
        if (!usage) continue;
        const createdAt = recordTimestamp(record);
        const createdAtIso = createdAt ? new Date(createdAt).toISOString() : "";
        const providerId = stringFromRecord(recordObject(record)._channelProviderId) || usage.providerId;
        const modelId = usage.modelId || stringFromRecord(recordObject(record)._channelModelId) || "Unknown model";
        const entryTotals = usageTotalsFromMetadata(usage);

        addUsageTotals(totals, entryTotals);
        if (createdAt) {
          if (createdAt >= todayStart.getTime()) addUsageTotals(today, entryTotals);
          if (createdAt >= last7DaysStart.getTime()) addUsageTotals(last7Days, entryTotals);
          if (createdAt >= last30DaysStart.getTime()) addUsageTotals(last30Days, entryTotals);
          if (!firstUsedAt || createdAt < Date.parse(firstUsedAt)) firstUsedAt = createdAtIso;
          if (!lastUsedAt || createdAt > Date.parse(lastUsedAt)) lastUsedAt = createdAtIso;
        }

        threadHasUsage = true;
        const statKey = `${providerId || ""}:${modelId}`;
        const stat = modelStats.get(statKey) || {
          modelId,
          providerId,
          requestCount: 0,
          lastUsedAt: undefined,
          ...emptyUsageTotals(),
        };
        stat.requestCount += 1;
        addUsageTotals(stat, entryTotals);
        if (createdAt && (!stat.lastUsedAt || createdAt > Date.parse(stat.lastUsedAt))) stat.lastUsedAt = createdAtIso;
        modelStats.set(statKey, stat);

        records.push({
          id: `${thread.id}:${records.length}`,
          threadId: thread.id,
          threadTitle: thread.title,
          modelId,
          providerId,
          createdAt: createdAtIso,
          ...entryTotals,
        });
      }
      if (threadHasUsage) threadIds.add(thread.id);
    }

    records.sort((a, b) => Date.parse(b.createdAt || "0") - Date.parse(a.createdAt || "0"));
    const models = [...modelStats.values()]
      .sort((a, b) => b.totalTokens - a.totalTokens || b.requestCount - a.requestCount || a.modelId.localeCompare(b.modelId));

    return {
      generatedAt: now.toISOString(),
      totals,
      today,
      last7Days,
      last30Days,
      requestCount: records.length,
      threadCount: threadIds.size,
      modelCount: models.length,
      firstUsedAt,
      lastUsedAt,
      models: models.slice(0, 12),
      recentRecords: records.slice(0, 80),
    };
  }

  runAgent(input: AgentRunInput): Promise<AgentRunResult> {
    return this.agent.run(input);
  }

  queueAgentMessage(input: AgentQueueMessageInput): Promise<string> {
    return this.agent.queueMessage(input);
  }

  async saveAgentAttachmentPaths(threadId: string, sourcePaths: string[]): Promise<AgentAttachment[]> {
    const targetDir = this.threadSessionDir(threadId);
    const attachments: AgentAttachment[] = [];
    for (const sourcePath of sourcePaths) {
      if (!existsSync(sourcePath) || statSync(sourcePath).isDirectory()) continue;
      const targetPath = uniqueAttachmentPath(targetDir, basename(sourcePath));
      await copyFile(sourcePath, targetPath);
      attachments.push(this.attachmentForPath(threadId, targetPath));
    }
    return attachments;
  }

  saveAgentAttachmentData(input: AgentAttachmentDataInput): AgentAttachment {
    const estimatedBytes = Math.floor(input.data.length * 0.75);
    if (estimatedBytes > MAX_AGENT_ATTACHMENT_DATA_BYTES) {
      throw new Error(`"${input.name}" is ${formatSize(estimatedBytes)}. Agent attachments are limited to ${formatSize(MAX_AGENT_ATTACHMENT_DATA_BYTES)} per file.`);
    }
    const targetDir = this.threadSessionDir(input.threadId);
    const targetPath = uniqueAttachmentPath(targetDir, input.name);
    writeFileSync(targetPath, Buffer.from(input.data, "base64"));
    return this.attachmentForPath(input.threadId, targetPath, input.mediaType);
  }

  deleteAgentAttachment(threadId: string, requestedPath: string): boolean {
    const targetPath = this.resolveThreadWorkspacePath(threadId, requestedPath);
    const attachmentDir = this.threadAttachmentDir(threadId);
    if (!isPathInside(targetPath, attachmentDir)) {
      throw new Error("Only current session attachments can be removed from the composer.");
    }
    if (!existsSync(targetPath)) return false;
    rmSync(targetPath, { force: true });
    return true;
  }

  listAgentSessionFiles(threadId: string): WorkspaceFileNode[] {
    const sessionDir = this.threadSessionDir(threadId);
    return listSessionFileNodes(sessionDir, sessionDir, this.requireThread(threadId));
  }

  stopAgent(threadId: string): boolean {
    return this.agent.stop(threadId);
  }

  stopAllAgents(): void {
    this.agent.stopAll();
  }

  approveAgent(input: AgentApprovalInput): boolean {
    return this.agent.approve(input);
  }

  rejectAgent(input: AgentApprovalInput): boolean {
    return this.agent.reject(input);
  }

  answerAgentQuestion(input: AgentAskUserResponseInput): boolean {
    return this.agent.answerQuestion(input);
  }

  resolveAgentExitPlan(input: AgentExitPlanResponseInput): boolean {
    return this.agent.resolveExitPlan(input);
  }

  onAgentEvent(listener: (event: BrevynAgentEvent) => void): () => void {
    return this.agent.onEvent(listener);
  }

  resolveThreadWorkspacePath(threadId: string, requestedPath: string): string {
    const thread = this.requireThread(threadId);
    const cwd = workspacePathForThread(this.rootDataDir, thread, (taskId) => this.businessStore.getTask(taskId) || undefined);
    const target = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(cwd, requestedPath);
    if (!isPathInside(target, cwd)) {
      throw new Error("File references can only open paths inside the current workspace.");
    }
    return target;
  }

  private requireThread(threadId: string): Thread {
    const thread = this.businessStore.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
  }

  private assertEmbeddingProviderMutable(purpose?: string): void {
    if (purpose !== "embedding") return;
    if (this.hasActiveIndexingJobs()) {
      throw new Error("当前有向量索引任务正在进行。请等待完成或取消后，再切换、保存或删除 Embedding 配置。");
    }
  }

  private threadAttachmentDir(threadId: string): string {
    return this.threadSessionDir(threadId);
  }

  private threadSessionDir(threadId: string): string {
    const thread = this.requireThread(threadId);
    const cwd = workspacePathForThread(this.rootDataDir, thread, (taskId) => this.businessStore.getTask(taskId) || undefined);
    return ensureAgentProjectScaffold(cwd, thread.id).sessionDir;
  }

  private buildWorkspaceMemorySummary(scopeId?: string): WorkspaceMemorySummary {
    const semester = this.currentSemester();
    if (!semester) {
      throw new Error("请先创建或选择一个学期。");
    }
    const scopes = this.workspaceMemoryScopes(semester);
    const selectedScope = scopes.find((scope) => scope.id === scopeId) || scopes[0];
    const workspacePath = this.workspacePathForMemoryScope(semester.id, selectedScope);
    mkdirSync(workspacePath, { recursive: true });
    const scaffold = ensureAgentWorkspaceMemoryScaffold(workspacePath);
    const claudePath = join(workspacePath, "CLAUDE.md");
    const autoIndexPath = join(scaffold.autoMemoryDir, "MEMORY.md");
    return {
      enabled: true,
      scopeId: selectedScope.id,
      scopeKind: selectedScope.kind,
      scopeName: selectedScope.label,
      workspacePath,
      autoMemoryDir: scaffold.autoMemoryDir,
      claudeMd: memoryFileInfo("claude", claudePath, "CLAUDE.md"),
      autoMemoryIndex: memoryFileInfo("auto", autoIndexPath, "MEMORY.md"),
      autoMemoryFiles: buildWorkspaceAutoMemoryTree(scaffold.autoMemoryDir),
      scopes,
    };
  }

  private workspaceMemoryScopes(semester: SemesterWorkspace): WorkspaceMemoryScopeOption[] {
    const courses = new Map(
      this.businessStore
        .listCourses(semester.id)
        .filter((course) => !course.archivedAt)
        .map((course) => [course.id, course.name || course.code || course.id]),
    );
    const taskScopes = this.businessStore
      .listTasks(semester.id)
      .filter((task) => !task.archivedAt)
      .map((task) => {
        const courseName = courses.get(task.courseId);
        return {
          id: `task:${task.id}`,
          kind: "task" as const,
          label: task.title || "未命名任务",
          detail: courseName || "任务记忆",
        };
      })
      .sort((a, b) => {
        const detailCompare = (a.detail || "").localeCompare(b.detail || "", "zh-Hans-CN", { numeric: true });
        if (detailCompare !== 0) return detailCompare;
        return a.label.localeCompare(b.label, "zh-Hans-CN", { numeric: true });
      });
    return [
      {
        id: "semester",
        kind: "semester" as const,
        label: `${semester.term} · 学期共享`,
        detail: "学期总览记忆",
      },
      ...taskScopes,
    ];
  }

  private workspacePathForMemoryScope(semesterId: string, scope: WorkspaceMemoryScopeOption): string {
    if (scope.kind === "task") {
      const taskId = scope.id.startsWith("task:") ? scope.id.slice("task:".length) : "";
      const task = taskId ? this.businessStore.getTask(taskId) : null;
      if (!task || task.archivedAt || task.semesterId !== semesterId) {
        throw new Error("记忆作用域不可用。");
      }
      return ensureTaskWorkspaceDir(this.rootDataDir, semesterId, task);
    }
    const workspaceRoot = ensureSemesterSharedDirs(this.rootDataDir, semesterId);
    return join(workspaceRoot, "Semester shared");
  }

  private attachmentForPath(threadId: string, filePath: string, mediaType?: string): AgentAttachment {
    const stats = statSync(filePath);
    return {
      id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      threadId,
      name: basename(filePath),
      kind: kindForPath(filePath),
      mimeType: mediaType,
      size: stats.size,
      sizeLabel: formatSize(stats.size),
      path: filePath,
      createdAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    let closeError: unknown;
    try {
      this.stopAllAgents();
    } catch (error) {
      closeError = error;
    }

    try {
      await this.ragIndex.close();
    } catch (error) {
      if (!closeError) closeError = error;
    }

    try {
      await this.agentGateway.close();
    } catch (error) {
      if (!closeError) closeError = error;
    }

    try {
      this.businessStore.close();
    } catch (error) {
      if (!closeError) {
        closeError = error;
      } else {
        console.warn("[local-store] Failed to close SQLite store after RAG close failure", error);
      }
    }

    if (closeError) throw closeError;
  }

}

function bundledDefaultSkillDirs(rootDataDir: string): string[] {
  const dirs = [
    process.env.BREVYN_DEFAULT_SKILLS_DIR,
    join(process.cwd(), "default-skills"),
    join(__dirname, "default-skills"),
    join(__dirname, "resources", "default-skills"),
    extractedBundledDefaultSkillDir(rootDataDir),
    join(process.resourcesPath || "", "default-skills"),
  ].filter((dir): dir is string => Boolean(dir));
  return Array.from(new Set(dirs.map((dir) => resolve(dir))));
}

function extractedBundledDefaultSkillDir(rootDataDir: string): string | undefined {
  const archive = bundledDefaultSkillArchivePath();
  if (!archive) return undefined;
  const extractRoot = join(rootDataDir, "bundled-default-skills");
  const extractedDir = join(extractRoot, "default-skills");
  const markerPath = join(extractRoot, ".default-skills-archive.json");
  try {
    const stats = statSync(archive);
    const marker = {
      archive: resolve(archive),
      mtimeMs: stats.mtimeMs,
      size: stats.size,
    };
    if (existsSync(extractedDir) && archiveMarkerMatches(markerPath, marker)) return extractedDir;

    rmSync(extractRoot, { recursive: true, force: true });
    mkdirSync(extractedDir, { recursive: true });
    extractZipSafely(archive, extractedDir);
    writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf8");
    return extractedDir;
  } catch (error) {
    console.warn("[skills] Failed to extract bundled default skills", error);
    return undefined;
  }
}

function bundledDefaultSkillArchivePath(): string | undefined {
  const candidates = [
    process.env.BREVYN_DEFAULT_SKILLS_ARCHIVE,
    join(process.resourcesPath || "", "default-skills.zip"),
    join(process.cwd(), "dist", "default-skills.zip"),
    join(__dirname, "default-skills.zip"),
  ].filter((path): path is string => Boolean(path));
  return candidates.map((path) => resolve(path)).find((path) => existsSync(path));
}

function archiveMarkerMatches(markerPath: string, marker: { archive: string; mtimeMs: number; size: number }): boolean {
  if (!existsSync(markerPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<typeof marker>;
    return parsed.archive === marker.archive && parsed.mtimeMs === marker.mtimeMs && parsed.size === marker.size;
  } catch {
    return false;
  }
}

function extractZipSafely(archivePath: string, targetDir: string): void {
  const zip = new AdmZip(archivePath);
  const targetRoot = resolve(targetDir);
  for (const entry of zip.getEntries()) {
    const entryTarget = resolve(targetRoot, entry.entryName);
    if (!isPathInside(entryTarget, targetRoot)) {
      throw new Error(`Invalid default skill archive entry: ${entry.entryName}`);
    }
  }
  zip.extractAllTo(targetRoot, true);
}

function mergeSkills(skills: SkillItem[]): SkillItem[] {
  const seen = new Set<string>();
  const merged: SkillItem[] = [];
  for (const skill of skills) {
    if (seen.has(skill.id)) continue;
    seen.add(skill.id);
    merged.push({ ...skill });
  }
  return merged;
}

function requireNonEmptyString(value: unknown, label: string): string {
  const text = stringValue(value).trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function uniqueAttachmentPath(dir: string, fileName: string): string {
  mkdirSync(dir, { recursive: true });
  const safeName = sanitizeFsSegment(fileName || "attachment");
  const extension = extname(safeName);
  const baseName = extension ? safeName.slice(0, -extension.length) : safeName;
  let candidate = join(dir, safeName);
  let index = 2;
  while (existsSync(candidate)) {
    candidate = join(dir, `${baseName} (${index})${extension}`);
    index += 1;
  }
  return candidate;
}

function emptyUsageTotals(): LocalModelUsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    contextInputTokens: 0,
  };
}

function addUsageTotals(target: LocalModelUsageTotals, source: LocalModelUsageTotals): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheCreationTokens += source.cacheCreationTokens;
  target.reasoningTokens += source.reasoningTokens;
  target.totalTokens += source.totalTokens;
  target.contextInputTokens += source.contextInputTokens;
}

function usageTotalsFromMetadata(usage: BrevynUsageMetadata): LocalModelUsageTotals {
  const inputTokens = positiveNumber(usage.inputTokens);
  const outputTokens = positiveNumber(usage.outputTokens);
  const cacheReadTokens = positiveNumber(usage.cacheReadTokens);
  const cacheCreationTokens = positiveNumber(usage.cacheCreationTokens);
  const reasoningTokens = positiveNumber(usage.reasoningTokens);
  const totalTokens = positiveNumber(usage.totalTokens) || inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
  const contextInputTokens = positiveNumber(usage.contextInputTokens) || inputTokens + cacheReadTokens + cacheCreationTokens;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens,
    totalTokens,
    contextInputTokens,
  };
}

function localUsageFromRecord(record: BrevynAgentTimelineRecord): BrevynUsageMetadata | null {
  const usage = recordObject(recordObject(record)._brevynUsage);
  if (Object.keys(usage).length === 0) return null;
  const inputTokens = positiveNumber(usage.inputTokens);
  const outputTokens = positiveNumber(usage.outputTokens);
  const cacheReadTokens = positiveNumber(usage.cacheReadTokens);
  const cacheCreationTokens = positiveNumber(usage.cacheCreationTokens);
  const totalTokens = positiveNumber(usage.totalTokens);
  if (inputTokens <= 0 && outputTokens <= 0 && cacheReadTokens <= 0 && cacheCreationTokens <= 0 && totalTokens <= 0) return null;
  return {
    providerProtocol: usage.providerProtocol === "openai_responses" ? "openai_responses" : "anthropic_messages",
    providerId: stringFromRecord(usage.providerId),
    modelId: stringFromRecord(usage.modelId),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    reasoningTokens: positiveNumber(usage.reasoningTokens),
    totalTokens,
    contextInputTokens: positiveNumber(usage.contextInputTokens),
  };
}

function recordTimestamp(record: BrevynAgentTimelineRecord): number | undefined {
  if (isRuntimeTimelineRecord(record)) {
    const parsed = Date.parse(record.event.createdAt);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const object = recordObject(record);
  if (typeof object._createdAt === "number" && Number.isFinite(object._createdAt)) return object._createdAt;
  if (typeof object.timestamp === "string") {
    const parsed = Date.parse(object.timestamp);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRuntimeTimelineRecord(record: BrevynAgentTimelineRecord): record is Extract<BrevynAgentTimelineRecord, { kind: "runtime" }> {
  return Boolean(record && typeof record === "object" && "kind" in record && record.kind === "runtime");
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function stringFromRecord(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listSessionFileNodes(dir: string, rootDir: string, thread: Thread): WorkspaceFileNode[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== ".DS_Store")
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const sourcePath = join(dir, entry.name);
      const stats = statSync(sourcePath);
      const relativePath = sourcePath.slice(rootDir.length).replace(/^\/+/, "");
      const path = relativePath || entry.name;
      const common = {
        id: `session-file:${thread.id}:${path}`,
        semesterId: thread.semesterId || "",
        courseId: thread.courseId,
        taskId: thread.taskId,
        name: entry.name,
        displayName: entry.name,
        path,
        sourcePath,
        sizeLabel: entry.isDirectory() ? undefined : formatSize(stats.size),
        updatedAt: stats.mtime.toISOString(),
      };
      if (entry.isDirectory()) {
        return [{
          ...common,
          kind: "folder" as const,
          children: listSessionFileNodes(sourcePath, rootDir, thread),
        }];
      }
      return [{
        ...common,
        kind: kindForPath(sourcePath),
      }];
    });
}

function memoryFileInfo(kind: WorkspaceMemoryFileKind, path: string, relativePath: string): WorkspaceMemorySummary["claudeMd"] {
  if (!existsSync(path)) {
    return {
      kind,
      relativePath,
      path,
      exists: false,
      size: 0,
    };
  }
  const stats = statSync(path);
  return {
    kind,
    relativePath,
    path,
    exists: stats.isFile(),
    size: stats.isFile() ? stats.size : 0,
    updatedAt: stats.mtime.toISOString(),
  };
}

function buildWorkspaceAutoMemoryTree(rootDir: string, currentDir = rootDir, depth = 0): WorkspaceMemoryFileNode[] {
  if (depth > MAX_WORKSPACE_MEMORY_TREE_DEPTH || !existsSync(currentDir)) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const nodes: WorkspaceMemoryFileNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(currentDir, entry.name);
    const relativePath = relative(rootDir, path).split(/[\\/]/).join("/");
    if (entry.isDirectory()) {
      nodes.push({
        relativePath,
        name: entry.name,
        type: "directory",
        children: buildWorkspaceAutoMemoryTree(rootDir, path, depth + 1),
      });
      continue;
    }
    if (!entry.isFile()) continue;
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      continue;
    }
    if (isLikelyBinaryMemoryFile(path, size)) continue;
    nodes.push({
      relativePath,
      name: entry.name,
      type: "file",
      size,
    });
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    if (a.relativePath === "MEMORY.md") return -1;
    if (b.relativePath === "MEMORY.md") return 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
  });
  return nodes;
}

function resolveWorkspaceAutoMemoryPath(memoryDir: string, relativePath: string): string {
  const normalized = normalizeMemoryRelativePath(relativePath);
  const resolved = resolve(memoryDir, normalized);
  const relativeResolved = relative(memoryDir, resolved);
  if (relativeResolved === "" || relativeResolved.startsWith("..") || isAbsolute(relativeResolved)) {
    throw new Error("记忆文件路径不可用。");
  }

  const memoryRealDir = existsSync(memoryDir) ? realpathSync(memoryDir) : memoryDir;
  let probe = resolved;
  while (probe !== memoryDir && !existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (existsSync(probe)) {
    const realProbe = realpathSync(probe);
    const realRelative = relative(memoryRealDir, realProbe);
    if (realRelative.startsWith("..") || isAbsolute(realRelative)) {
      throw new Error("记忆文件路径不可用。");
    }
  }

  return resolved;
}

function normalizeMemoryRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").trim();
  if (!normalized || normalized === "." || normalized.includes("\0") || normalized.startsWith("/")) {
    throw new Error("记忆文件路径不可用。");
  }
  return normalized.split("/").filter(Boolean).join("/");
}

function isLikelyBinaryMemoryFile(path: string, size: number): boolean {
  if (size > MAX_WORKSPACE_MEMORY_BYTES) return true;
  const extension = extname(path).toLowerCase();
  if ([".md", ".markdown", ".txt", ".json", ".yaml", ".yml"].includes(extension)) return false;
  return true;
}

export function createLocalStore(rootDataPath: string, options: LocalStoreOptions = {}): LocalStore {
  return new LocalStore(
    join(rootDataPath, "brevyn-state.json"),
    new SQLiteBusinessStore(join(rootDataPath, "indexes", "brevyn.sqlite")),
    new ProviderConfigStore(join(rootDataPath, "provider-profiles.json")),
    new ProviderSecretStore(join(rootDataPath, "provider-secrets.json")),
    options,
  );
}
