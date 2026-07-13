import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { copyFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { posix as pathPosix } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import AdmZip from "adm-zip";
import { DOMParser } from "@xmldom/xmldom";
import mammoth from "mammoth";
import type {
  CourseFileSection,
  DeleteFileInput,
  EmbeddingIndexHealth,
  ExternalSource,
  ExternalSourceAddFilesInput,
  ExternalSourceAddResult,
  ExternalSourceAddUrlInput,
  ExternalSourceListInput,
  FileImportInput,
  FileImportResult,
  FilePreview,
  OfficeRenderSurfacePreview,
  SpreadsheetPreview,
  SpreadsheetPreviewCell,
  SpreadsheetPreviewRow,
  SpreadsheetPreviewSheet,
  FileStats,
  IndexActiveSemesterResult,
  IndexingJob,
  ModelProviderConfig,
  RagSearchResult,
  SourceCandidate,
  SourceCandidateAcceptResult,
  SourceCandidateListInput,
  SourceCandidateProposeInput,
  SourceCandidateProposeResult,
  WorkspaceFileKind,
  WorkspaceFileNode,
} from "../../types/domain";
import { embeddingProviderFingerprint } from "../../shared/embedding-provider-fingerprint";
import type { IndexingTaskInsert, IndexingTaskRecord, IndexingWorkerResult } from "../indexing";
import type { SQLiteBusinessStore } from "../storage";
import {
  lectureWeekFolderName,
  lectureWeekNumberFromFolderName,
  normalizedWeekNumber,
  semesterLectureWeekNumbers,
} from "../../shared/semester-weeks";
import { recordCleanupFailure, type CleanupFailure } from "./cleanup-log";
import type { ProviderService } from "./provider-service";
import type { RagIndexService, RagSearchOptions } from "./rag-index-service";
import { searchHybridRag } from "./rag-search-orchestrator";
import {
  cloneFile,
  cloneFiles,
  ensureCourseFolderInTree,
  ensureFolderChild,
  ensureTargetFolderInTree,
  flattenFiles,
  formatSize,
  kindForPath,
  removeFileFromTree,
  removeTaskFromTree,
} from "./workspace-file-tree";
import {
  SEMESTER_HOME_COURSE_ID,
  ensureCourseWorkspaceDir,
  courseWorkspaceDir,
  ensureSemesterSharedDirs,
  ensureImportTargetDir,
  isPathInside,
  sanitizeFsSegment,
  semesterWorkspaceDir,
  taskBucketLabel,
  taskWorkspaceDirForTask,
  taskTypeLabel,
} from "./workspace-paths";
import {
  activeCourseScopeOrThrow,
  archivedCourseIdsForSemester,
  currentActiveSemester,
  currentActiveSemesterId,
  isCourseArchived,
  isCurrentSemesterArchived,
  taskInCourseOrThrow,
} from "./workspace-state";
import { workspaceDirectoryPreviewUrl, workspaceFilePreviewUrl } from "./workspace-file-preview-protocol";
import { convertOfficeDocumentToPdf } from "./libreoffice-runtime";
import { importDelimitedArtifact } from "../office-importers/delimited-importer";
import { importXlsxArtifact } from "../office-importers/xlsx-importer";
import type { BrevynOfficeArtifact, BrevynOfficeRenderSurface, BrevynWorksheetCell, BrevynWorksheetModel } from "../office-model/schema";

const require = createRequire(__filename);
const now = () => new Date().toISOString();
const INDEXING_INGEST_LOCK_MS = 5 * 60_000;
const INDEXING_TASK_MAX_ATTEMPTS = 5;
const MAX_IMPORT_FILE_BYTES = 50 * 1024 * 1024;
const MAX_PREVIEW_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_WEB_SOURCE_BYTES = 5 * 1024 * 1024;
const WEB_SOURCE_FETCH_TIMEOUT_MS = 20_000;
const SOURCE_CANDIDATE_ACCEPTING_TIMEOUT_MS = 2 * 60_000;
const MAX_LECTURE_WEEK_FOLDERS = 30;
const PREVIEW_CACHE_DIR = ".preview-cache";
const AGENT_WORKSPACE_MEMORY_FILE = "CLAUDE.md";
const EXTERNAL_SOURCES_FOLDER = "External Sources";
const PARSED_DOCUMENTS_FOLDER = "Parsed";

interface PdfPreviewSemanticUnit {
  id: string;
  page: number;
  title?: string;
  sourceLabel?: string;
  text: string;
  bbox?: { x: number; y: number; width: number; height: number };
}

export interface FileServiceOptions {
  rootDataDir: string;
  businessStore: SQLiteBusinessStore;
  providers: ProviderService;
  ragIndex: RagIndexService;
}

type ImportedIndexingResult = { job: IndexingJob | null; notice?: string; error?: string };

function normalizeImportedIndexingResult(result: ImportedIndexingResult): ImportedIndexingResult {
  if (result.error || result.notice || !result.job) return result;
  if (result.job.status === "failed" || result.job.status === "idle") {
    return { ...result, error: result.job.error };
  }
  return result;
}

export class FileService {
  constructor(private readonly options: FileServiceOptions) {}

  async searchRag(query: string, courseId?: string, options: RagSearchOptions & { limit?: number } = {}): Promise<RagSearchResult[]> {
    try {
      if (isCurrentSemesterArchived(this.options.businessStore)) return [];
      if (courseId && courseId !== SEMESTER_HOME_COURSE_ID && isCourseArchived(this.options.businessStore, courseId)) return [];
      const semesterId = currentActiveSemesterId(this.options.businessStore);
      if (!semesterId) return [];
      const archivedCourseIds = archivedCourseIdsForSemester(this.options.businessStore, semesterId);
      return await searchHybridRag({
        semesterId,
        query,
        courseId: courseId && courseId !== SEMESTER_HOME_COURSE_ID ? courseId : undefined,
        maxResults: options.limit,
        excludeCourseIds: archivedCourseIds,
        options,
        vectorSearch: (searchQuery, searchSemesterId, searchCourseId, maxResults, excludedCourseIds, searchOptions) =>
          this.options.ragIndex.search(searchQuery, searchSemesterId, searchCourseId, maxResults, excludedCourseIds, searchOptions),
        textSearch: (input) => this.options.businessStore.searchRagTextChunks(input),
      });
    } catch (error) {
      console.warn("[rag] Search failed", error);
      throw error;
    }
  }

  listFiles(courseId?: string): WorkspaceFileNode[] {
    if (isCurrentSemesterArchived(this.options.businessStore)) return [];
    if (courseId && courseId !== SEMESTER_HOME_COURSE_ID && isCourseArchived(this.options.businessStore, courseId)) return [];
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return [];
    if (!courseId || courseId === SEMESTER_HOME_COURSE_ID) {
      const semesterRoots = this.viewCourseRoots(SEMESTER_HOME_COURSE_ID, semesterId);
      const semesterRoot = semesterRoots[0];
      if (!semesterRoot) return [];
      const semesterClone = cloneFile(semesterRoot);
      const archivedCourseIds = new Set(archivedCourseIdsForSemester(this.options.businessStore, semesterId));
      const courseRoots = this.options.businessStore.listWorkspaceFiles(semesterId)
        .filter((file) => file.courseId !== SEMESTER_HOME_COURSE_ID && !archivedCourseIds.has(file.courseId) && file.kind === "folder");
      const visibleCourseRoots = cloneFiles(courseRoots);
      this.hideArchivedTaskNodes(visibleCourseRoots, semesterId);
      return [
        {
          ...semesterClone,
          children: [...(semesterClone.children || []), ...visibleCourseRoots],
        },
      ];
    }
    return cloneFiles(this.viewCourseRoots(courseId, semesterId));
  }

  fileStats(courseId?: string): FileStats {
    const scope: FileStats["scope"] = !courseId || courseId === SEMESTER_HOME_COURSE_ID ? "semester" : "course";
    const effectiveCourseId = scope === "course" ? courseId : undefined;
    const files = scope === "semester" ? this.listFiles(SEMESTER_HOME_COURSE_ID) : this.listFiles(effectiveCourseId);
    const leafFiles = flattenFiles(files);
    const sections = this.courseFileSections(scope === "semester" ? SEMESTER_HOME_COURSE_ID : courseId || SEMESTER_HOME_COURSE_ID);
    const byKind: Record<WorkspaceFileKind, number> = leafFiles.reduce(
      (counts, file) => {
        counts[file.kind] = (counts[file.kind] || 0) + 1;
        return counts;
      },
      {
        folder: 0,
        pdf: 0,
        docx: 0,
        pptx: 0,
        spreadsheet: 0,
        image: 0,
        markdown: 0,
        code: 0,
        text: 0,
        unknown: 0,
      },
    );
    return {
      semesterId: currentActiveSemesterId(this.options.businessStore),
      courseId: effectiveCourseId,
      scope,
      totalFiles: leafFiles.length,
      sectionCount: sections.length,
      sections: sections.map((section) => ({
        id: section.id,
        kind: section.kind,
        title: section.title,
        fileCount: section.files.length,
      })),
      byKind,
    };
  }

  async previewFile(fileId: string): Promise<FilePreview | null> {
    const { file, semesterId } = this.guardFileAccess(fileId, "accessing");
    if (file.kind === "folder") return null;
    this.assertFileSourceInsideWorkspace(file, semesterId);
    return this.previewSourcePath({
      id: file.id,
      title: file.name,
      displayPath: file.path,
      sourcePath: file.sourcePath,
      kind: file.kind,
      metadata: {
        size: file.sizeLabel || "unknown",
        updated: file.updatedAt,
        courseId: file.courseId,
      },
    });
  }

  async previewParsedFile(fileId: string): Promise<FilePreview | null> {
    const { file, semesterId } = this.guardFileAccess(fileId, "accessing parsed text");
    if (file.kind === "folder") return null;
    this.assertFileSourceInsideWorkspace(file, semesterId);
    if (!file.sourcePath) throw new Error("文件源路径不可用。");
    const contentPath = join(parsedDocumentDirForSource(file.sourcePath, file.id), "content.md");
    if (!existsSync(contentPath)) throw new Error("尚未生成解析文本，请先索引文件。");
    return this.previewSourcePath({
      id: `${file.id}:parsed`,
      title: `${file.name} · 解析文本`,
      displayPath: `${file.path} · Parsed/content.md`,
      sourcePath: contentPath,
      kind: "markdown",
      metadata: {
        size: formatSize(statSync(contentPath).size),
        source: file.name,
        courseId: file.courseId,
      },
    });
  }

  async previewWorkspacePath(sourcePath: string, displayPath = sourcePath): Promise<FilePreview | null> {
    if (!existsSync(sourcePath) || statSync(sourcePath).isDirectory()) return null;
    return this.previewSourcePath({
      id: sourcePath,
      title: basename(sourcePath),
      displayPath,
      sourcePath,
      kind: kindForPath(sourcePath),
      metadata: {
        size: formatSize(statSync(sourcePath).size),
        updated: statSync(sourcePath).mtime.toISOString(),
      },
    });
  }

  private async previewSourcePath(input: {
    id: string;
    title: string;
    displayPath: string;
    sourcePath?: string;
    kind: WorkspaceFileKind;
    metadata: Record<string, string | number | boolean>;
  }): Promise<FilePreview> {
    const fileUrl = input.sourcePath && existsSync(input.sourcePath) ? workspaceFilePreviewUrl(input.sourcePath) : undefined;
    const derivedPaths = previewDerivedDocumentPaths(input.sourcePath, input.id);
    const common = {
      id: input.id,
      title: input.title,
      path: input.displayPath,
      sourcePath: input.sourcePath,
      kind: input.kind,
      fileUrl,
      metadata: {
        ...input.metadata,
        ...derivedPaths.metadata,
      },
      artifactPath: derivedPaths.artifactPath,
      semanticUnitsPath: derivedPaths.semanticUnitsPath,
    };
    if (input.kind === "markdown") {
      const content = readPreviewSource(input.sourcePath);
      return {
        ...common,
        mimeType: "text/markdown",
        summary: "Loaded from a Markdown source file.",
        content: content || `# ${input.title.replace(/\.md$/i, "")}\n\n（没有可用内容。）`,
      };
    }
    if (input.kind === "code") {
      const content = readPreviewSource(input.sourcePath);
      return {
        ...common,
        mimeType: "text/typescript",
        summary: "已从代码源文件加载。",
        content: content || `// 没有可用的代码内容。`,
      };
    }
    if (input.kind === "text") {
      const content = readPreviewSource(input.sourcePath);
      return {
        ...common,
        mimeType: "text/plain",
        summary: "已从文本源文件加载。",
        content: content || "（没有可用的文本内容。）",
      };
    }
    if (input.kind === "pdf") {
      const preview = preparePdfCanvasPreview(this.options.rootDataDir, input.sourcePath, input.title, input.id);
      return {
        ...common,
        mimeType: "application/pdf",
        previewUrl: preview.previewUrl,
        summary: preview.summary,
      };
    }
    if (input.kind === "pptx") {
      const renderedPdf = await prepareOfficePdfCanvasPreview(this.options.rootDataDir, input.sourcePath, input.title, {
        viewMode: "deck",
        speakerNotes: extractPptxSpeakerNotes(input.sourcePath),
        semanticUnits: readPreviewSemanticUnits(input.sourcePath, input.id, "slide"),
      });
      if (renderedPdf.previewUrl) {
        return {
          ...common,
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          previewUrl: renderedPdf.previewUrl,
          summary: renderedPdf.summary,
          metadata: {
            ...common.metadata,
            officePreviewMode: "high-fidelity-pdf",
          },
        };
      }
      return {
        ...common,
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        summary: renderedPdf.summary,
        content: "PPTX 高保真预览生成失败。请确认 LibreOffice runtime 可用后重试。",
        metadata: {
          ...common.metadata,
          officePreviewMode: "preview-failed",
        },
      };
    }
    if (input.kind === "docx") {
      const renderedPdf = await prepareOfficePdfCanvasPreview(this.options.rootDataDir, input.sourcePath, input.title);
      const extracted = await previewDocxHtml(input.sourcePath);
      return {
        ...common,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        previewUrl: renderedPdf.previewUrl,
        summary: renderedPdf.previewUrl ? renderedPdf.summary : `${renderedPdf.summary} ${extracted.summary}`,
        content: extracted.content,
        html: extracted.html,
        metadata: {
          ...common.metadata,
          officePreviewMode: renderedPdf.previewUrl ? "high-fidelity-pdf" : "basic-html",
        },
      };
    }
    if (input.kind === "spreadsheet") {
      const extracted = await previewSpreadsheetPreview(input.sourcePath);
      return {
        ...common,
        mimeType: spreadsheetMimeType(input.sourcePath),
        summary: extracted.summary,
        content: extracted.content,
        html: extracted.html,
        spreadsheet: extracted.spreadsheet,
        metadata: {
          ...common.metadata,
          officePreviewMode: extracted.spreadsheet ? "structured-workbook" : "basic-html",
        },
      };
    }
    if (input.kind === "image") {
      return {
        ...common,
        mimeType: imageMimeType(input.sourcePath || input.title),
        summary: fileUrl ? "正在预览工作区中的原始图片文件。" : "图片源文件不可用于预览。",
      };
    }
    return {
      ...common,
      summary: "暂不支持预览此文件类型。",
    };
  }

  async importFiles(input: FileImportInput): Promise<FileImportResult> {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    activeCourseScopeOrThrow(this.options.businessStore, input.courseId, semesterId);
    const sourcePaths = input.sourcePaths || [];
    if (sourcePaths.length === 0) {
      return { files: [], tree: this.listFiles(input.courseId), indexingJob: null };
    }

    const importSources = await this.statImportSources(sourcePaths);
    const timestamp = now();
    const roots = this.writableCourseRoots(input.courseId, semesterId);
    const root = roots[0];
    if (!root) throw new Error("课程文件树不可用。");
    const task = input.targetSection === "task" ? taskInCourseOrThrow(this.options.businessStore, input.taskId, input.courseId, semesterId) : undefined;
    const semester = this.options.businessStore.getSemester(semesterId);
    const allowedLectureWeeks = lectureWeekNumbersForFolders(semester);
    const weekNumber = input.targetSection === "lecture" ? normalizedWeekNumber(input.weekNumber, allowedLectureWeeks) : undefined;
    if (input.targetSection === "lecture" && input.weekNumber !== undefined && !weekNumber) {
      throw new Error("选择的课件周次不在当前学期范围内。请刷新后重新选择周次。");
    }
    const targetInput: FileImportInput = input.targetSection === "lecture" ? { ...input, weekNumber } : input;
    const targetFolder = ensureTargetFolderInTree(root, targetInput, task, timestamp);
    const managedTargetDir = this.ensureImportTargetDir(targetInput);
    const copiedPaths: string[] = [];
    try {
      const importedFiles: WorkspaceFileNode[] = [];
      for (const source of importSources) {
        const sourcePath = source.sourcePath;
        const managedPath = uniqueFilePath(managedTargetDir, basename(sourcePath));
        await copyFile(sourcePath, managedPath);
        copiedPaths.push(managedPath);
        const name = basename(managedPath);
        const file: WorkspaceFileNode = {
          id: `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          semesterId,
          courseId: input.courseId,
          taskId: input.targetSection === "task" ? input.taskId : undefined,
          taskType: input.targetSection === "task" ? task?.taskType : undefined,
          taskFileBucket: input.targetSection === "task" ? input.taskFileBucket || "materials" : undefined,
          sectionKind: targetInput.targetSection,
          weekNumber,
          sourcePath: managedPath,
          name,
          path: `${targetFolder.path}/${name}`,
          kind: kindForPath(managedPath),
          sizeLabel: formatSize(source.size),
          ragEligible: true,
          sourceKind: "user_import",
          updatedAt: timestamp,
        };
        targetFolder.children = [...(targetFolder.children || []), file];
        importedFiles.push(file);
      }
      this.persistWorkspaceFilesForCourse(input.courseId, roots, semesterId);
      const sectionId = this.sectionIdForImport(targetInput);
      let indexingJob: IndexingJob | null = null;
      let indexingError: string | undefined;
      let indexingNotice: string | undefined;
      try {
        const indexingResult = this.indexImportedFiles(input.courseId, sectionId, importedFiles);
        indexingJob = indexingResult.job;
        indexingError = indexingResult.error;
        indexingNotice = indexingResult.notice;
      } catch (error) {
        indexingError = errorMessage(error);
        console.warn("[indexing] Failed to create indexing job after import", error);
      }
      return {
        files: cloneFiles(importedFiles),
        tree: this.listFiles(input.courseId),
        indexingJob,
        indexingError,
        indexingNotice,
      };
    } catch (error) {
      for (const copiedPath of copiedPaths) this.safeRm(copiedPath, `[files] Failed to clean copied file ${copiedPath}`);
      throw error;
    }
  }

  listExternalSources(input: ExternalSourceListInput): ExternalSource[] {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return [];
    activeCourseScopeOrThrow(this.options.businessStore, input.courseId, semesterId);
    return this.options.businessStore.listExternalSources({
      semesterId,
      courseId: input.courseId,
      taskId: input.taskId,
    });
  }

  async addExternalSourceUrl(input: ExternalSourceAddUrlInput): Promise<ExternalSourceAddResult> {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    activeCourseScopeOrThrow(this.options.businessStore, input.courseId, semesterId);
    const targetTask = input.scope === "task" ? taskInCourseOrThrow(this.options.businessStore, input.taskId, input.courseId, semesterId) : undefined;
    const url = normalizeExternalSourceUrl(input.url);
    const duplicateSource = this.findDuplicateExternalWebSource(semesterId, input.courseId, targetTask?.id, input.scope, url);
    if (duplicateSource) {
      throw new Error(`这个网页已经在${duplicateSource.scope === "task" ? "当前作业" : "当前课程"}的外部来源里。`);
    }
    const timestamp = now();
    const sourceId = externalSourceId();
    const sourceDir = this.ensureExternalSourceDir(semesterId, input.courseId, targetTask?.id, sourceId, input.title || url.hostname);
    const source: ExternalSource = {
      id: sourceId,
      semesterId,
      courseId: input.courseId,
      taskId: targetTask?.id,
      scope: input.scope,
      kind: "web",
      title: input.title?.trim() || url.hostname,
      url: url.toString(),
      status: "processing",
      addedBy: input.addedBy === "agent" ? "agent" : "user",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.options.businessStore.saveExternalSource(source);

    try {
      const fetched = await fetchExternalWebSource(url);
      const title = input.title?.trim() || fetched.title || url.hostname;
      const originalPath = join(sourceDir, "original.html");
      const markdownPath = join(sourceDir, "content.md");
      writeFileSync(originalPath, fetched.html, "utf8");
      writeFileSync(markdownPath, markdownForWebSource({ title, url: url.toString(), text: fetched.text }), "utf8");
      const file = this.registerExternalWorkspaceFile({
        semesterId,
        courseId: input.courseId,
        taskId: targetTask?.id,
        scope: input.scope,
        sourceId,
        title,
        sourcePath: markdownPath,
        timestamp,
      });
      const readySource = this.options.businessStore.saveExternalSource({
        ...source,
        title,
        originalPath,
        markdownPath,
        workspaceFileId: file.id,
        summary: summarizeText(fetched.text),
        status: "ready",
        updatedAt: now(),
      });
      const indexingResult = normalizeImportedIndexingResult(this.indexImportedFiles(input.courseId, sectionIdForExternalSource(input.courseId, input.scope, targetTask?.id), [file]));
      const saved = indexingResult.error
        ? this.options.businessStore.updateExternalSourceStatus(sourceId, "failed", indexingResult.error) || { ...readySource, status: "failed" as const, error: indexingResult.error }
        : readySource;
      return {
        sources: [saved],
        tree: this.listFiles(input.courseId),
        indexingJob: indexingResult.job,
        indexingError: indexingResult.error,
        indexingNotice: indexingResult.notice,
      };
    } catch (error) {
      const message = userFacingWebSourceError(error);
      this.safeRm(sourceDir, `[external-sources] Failed to clean source folder ${sourceDir}`);
      const failed = this.options.businessStore.updateExternalSourceStatus(sourceId, "failed", message) || { ...source, status: "failed" as const, error: message };
      return {
        sources: [failed],
        tree: this.listFiles(input.courseId),
        indexingJob: null,
        indexingError: message,
      };
    }
  }

  async addExternalSourceFiles(input: ExternalSourceAddFilesInput & { sourcePaths: string[] }): Promise<ExternalSourceAddResult> {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    activeCourseScopeOrThrow(this.options.businessStore, input.courseId, semesterId);
    const targetTask = input.scope === "task" ? taskInCourseOrThrow(this.options.businessStore, input.taskId, input.courseId, semesterId) : undefined;
    const importSources = await this.statImportSources(input.sourcePaths || []);
    if (importSources.length === 0) return { sources: [], tree: this.listFiles(input.courseId), indexingJob: null };

    const timestamp = now();
    const files: WorkspaceFileNode[] = [];
    const sources: ExternalSource[] = [];
    const copiedPaths: string[] = [];
    try {
      for (const importSource of importSources) {
        const sourceId = externalSourceId();
        const title = basename(importSource.sourcePath);
        const sourceDir = this.ensureExternalSourceDir(semesterId, input.courseId, targetTask?.id, sourceId, title);
        const originalPath = uniqueFilePath(sourceDir, title);
        await copyFile(importSource.sourcePath, originalPath);
        copiedPaths.push(originalPath);
        const file = this.registerExternalWorkspaceFile({
          semesterId,
          courseId: input.courseId,
          taskId: targetTask?.id,
          scope: input.scope,
          sourceId,
          title: basename(originalPath),
          sourcePath: originalPath,
          timestamp,
          size: importSource.size,
        });
        const source = this.options.businessStore.saveExternalSource({
          id: sourceId,
          semesterId,
          courseId: input.courseId,
          taskId: targetTask?.id,
          scope: input.scope,
          kind: "file",
          title: basename(originalPath),
          originalPath,
          workspaceFileId: file.id,
          status: "ready",
          addedBy: "user",
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        files.push(file);
        sources.push(source);
      }
      const indexingResult = normalizeImportedIndexingResult(this.indexImportedFiles(input.courseId, sectionIdForExternalSource(input.courseId, input.scope, targetTask?.id), files));
      const resultSources = indexingResult.error
        ? sources.map((source) => this.options.businessStore.updateExternalSourceStatus(source.id, "failed", indexingResult.error) || { ...source, status: "failed" as const, error: indexingResult.error })
        : sources;
      return {
        sources: resultSources,
        tree: this.listFiles(input.courseId),
        indexingJob: indexingResult.job,
        indexingError: indexingResult.error,
        indexingNotice: indexingResult.notice,
      };
    } catch (error) {
      for (const copiedPath of copiedPaths) this.safeRm(copiedPath, `[external-sources] Failed to clean copied file ${copiedPath}`);
      throw error;
    }
  }

  async retryExternalSource(sourceId: string): Promise<ExternalSourceAddResult> {
    const source = this.options.businessStore.getExternalSource(sourceId);
    if (!source) throw new Error("外部来源不存在。");
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId || source.semesterId !== semesterId) throw new Error("请先切换到这个来源所属的学期。");
    activeCourseScopeOrThrow(this.options.businessStore, source.courseId, semesterId);
    if (source.scope === "task") taskInCourseOrThrow(this.options.businessStore, source.taskId, source.courseId, semesterId);

    if (source.workspaceFileId) {
      const file = this.options.businessStore.getWorkspaceFile(source.workspaceFileId);
      if (!file && source.kind !== "web") throw new Error("来源文件记录不可用。请移除后重新添加。");
      if (file) {
        const job = this.retryIndexingFile(file.id);
        const updatedSource = job.status === "failed" || job.status === "idle"
          ? this.options.businessStore.updateExternalSourceStatus(source.id, "failed", job.error) || { ...source, status: "failed" as const, error: job.error, updatedAt: now() }
          : source.status === "failed"
          ? this.options.businessStore.updateExternalSourceStatus(source.id, "ready") || { ...source, status: "ready" as const, error: undefined, updatedAt: now() }
          : source;
        return {
          sources: [updatedSource],
          tree: this.listFiles(source.courseId),
          indexingJob: job,
          indexingError: job.status === "failed" ? job.error : undefined,
        };
      }
    }

    if (source.kind !== "web" || !source.url) {
      throw new Error("这个外部文件缺少本地源文件。请移除后重新添加。");
    }
    return this.retryExternalWebSource(source);
  }

  async deleteExternalSource(sourceId: string): Promise<boolean> {
    const source = this.options.businessStore.getExternalSource(sourceId);
    if (!source) return false;
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId || source.semesterId !== semesterId) throw new Error("请先切换到这个来源所属的学期。");
    activeCourseScopeOrThrow(this.options.businessStore, source.courseId, semesterId);
    if (source.workspaceFileId) {
      const activeJobs = this.options.businessStore.activeIndexingJobsForFiles([source.workspaceFileId]);
      for (const job of activeJobs) this.options.businessStore.cancelIndexingJob(job.id);
      await this.deleteRagChunksForFile(source.workspaceFileId);
      const roots = this.loadCourseRoots(source.courseId, semesterId);
      removeFileFromTree(roots, source.workspaceFileId);
      this.persistWorkspaceFilesForCourse(source.courseId, roots, semesterId);
    }
    if (source.originalPath) this.safeRm(dirname(source.originalPath), `[external-sources] Failed to remove source folder ${dirname(source.originalPath)}`);
    else if (source.markdownPath) this.safeRm(dirname(source.markdownPath), `[external-sources] Failed to remove source folder ${dirname(source.markdownPath)}`);
    this.options.businessStore.deleteExternalSource(sourceId);
    return true;
  }

  private async retryExternalWebSource(source: ExternalSource): Promise<ExternalSourceAddResult> {
    const url = normalizeExternalSourceUrl(source.url || "");
    const timestamp = now();
    const sourceDir = this.ensureExternalSourceDir(source.semesterId, source.courseId, source.taskId, source.id, source.title || url.hostname);
    const processing = this.options.businessStore.saveExternalSource({
      ...source,
      status: "processing",
      error: undefined,
      updatedAt: timestamp,
    });
    try {
      const fetched = await fetchExternalWebSource(url);
      const title = source.title?.trim() || fetched.title || url.hostname;
      const originalPath = join(sourceDir, "original.html");
      const markdownPath = join(sourceDir, "content.md");
      writeFileSync(originalPath, fetched.html, "utf8");
      writeFileSync(markdownPath, markdownForWebSource({ title, url: url.toString(), text: fetched.text }), "utf8");
      const file = this.registerExternalWorkspaceFile({
        semesterId: source.semesterId,
        courseId: source.courseId,
        taskId: source.taskId,
        scope: source.scope,
        sourceId: source.id,
        title,
        sourcePath: markdownPath,
        timestamp,
      });
      const saved = this.options.businessStore.saveExternalSource({
        ...processing,
        title,
        originalPath,
        markdownPath,
        workspaceFileId: file.id,
        summary: summarizeText(fetched.text),
        status: "ready",
        error: undefined,
        updatedAt: now(),
      });
      const indexingResult = normalizeImportedIndexingResult(this.indexImportedFiles(source.courseId, sectionIdForExternalSource(source.courseId, source.scope, source.taskId), [file]));
      const finalSource = indexingResult.error
        ? this.options.businessStore.updateExternalSourceStatus(source.id, "failed", indexingResult.error) || { ...saved, status: "failed" as const, error: indexingResult.error }
        : saved;
      return {
        sources: [finalSource],
        tree: this.listFiles(source.courseId),
        indexingJob: indexingResult.job,
        indexingError: indexingResult.error,
        indexingNotice: indexingResult.notice,
      };
    } catch (error) {
      const message = userFacingWebSourceError(error);
      this.safeRm(sourceDir, `[external-sources] Failed to clean retried source folder ${sourceDir}`);
      const failed = this.options.businessStore.updateExternalSourceStatus(source.id, "failed", message) || {
        ...source,
        status: "failed" as const,
        error: message,
        updatedAt: now(),
      };
      return {
        sources: [failed],
        tree: this.listFiles(source.courseId),
        indexingJob: null,
        indexingError: message,
      };
    }
  }

  listSourceCandidates(input: SourceCandidateListInput): SourceCandidate[] {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return [];
    activeCourseScopeOrThrow(this.options.businessStore, input.courseId, semesterId);
    const candidates = this.options.businessStore.listSourceCandidates({
      semesterId,
      courseId: input.courseId,
      taskId: input.taskId,
      threadId: input.threadId,
      statuses: input.statuses,
    });
    return candidates.map((candidate) => this.recoverStaleSourceCandidate(candidate));
  }

  proposeSourceCandidate(input: SourceCandidateProposeInput): SourceCandidateProposeResult {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    activeCourseScopeOrThrow(this.options.businessStore, input.courseId, semesterId);
    const targetTask = input.scope === "task" ? taskInCourseOrThrow(this.options.businessStore, input.taskId, input.courseId, semesterId) : undefined;
    const url = normalizeExternalSourceUrl(input.url);
    const duplicateSource = this.findDuplicateExternalWebSource(semesterId, input.courseId, targetTask?.id, input.scope, url);
    if (duplicateSource) {
      return {
        status: "existing_source",
        message: "这个来源已经在资料库里。",
      };
    }

    const normalizedUrl = normalizedExternalSourceUrlKey(url);
    const existingCandidate = this.options.businessStore.findSourceCandidateByNormalizedUrl({
      semesterId,
      courseId: input.courseId,
      taskId: targetTask?.id,
      scope: input.scope,
      normalizedUrl,
      statuses: ["pending", "accepting", "failed"],
    });
    const timestamp = now();
    const candidate: SourceCandidate = {
      id: existingCandidate?.id || sourceCandidateId(),
      semesterId,
      courseId: input.courseId,
      taskId: targetTask?.id,
      threadId: input.threadId,
      scope: input.scope,
      url: url.toString(),
      normalizedUrl,
      title: input.title.trim() || url.hostname,
      siteName: input.siteName?.trim() || url.hostname,
      snippet: input.snippet?.trim() || undefined,
      reason: input.reason.trim() || "这个来源可能对当前学习任务有帮助。",
      status: existingCandidate?.status === "accepted" ? "accepted" : "pending",
      externalSourceId: existingCandidate?.externalSourceId,
      error: undefined,
      proposedBy: "agent",
      createdAt: existingCandidate?.createdAt || timestamp,
      updatedAt: timestamp,
    };
    const saved = this.options.businessStore.saveSourceCandidate(candidate);
    return {
      candidate: saved,
      status: existingCandidate ? "updated" : "created",
      message: existingCandidate ? "候选来源已更新，等待用户确认。" : "候选来源已提交给用户确认。",
    };
  }

  async acceptSourceCandidate(candidateId: string): Promise<SourceCandidateAcceptResult> {
    const candidate = this.options.businessStore.getSourceCandidate(candidateId);
    if (!candidate) throw new Error("候选来源不存在。");
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId || candidate.semesterId !== semesterId) throw new Error("请先切换到这个候选来源所属的学期。");
    activeCourseScopeOrThrow(this.options.businessStore, candidate.courseId, semesterId);
    if (candidate.scope === "task") taskInCourseOrThrow(this.options.businessStore, candidate.taskId, candidate.courseId, semesterId);

    if (candidate.status === "accepted" && candidate.externalSourceId) {
      return { candidate };
    }
    this.options.businessStore.updateSourceCandidateStatus(candidate.id, "accepting");
    try {
      const externalSourceResult = await this.addExternalSourceUrl({
        courseId: candidate.courseId,
        taskId: candidate.taskId,
        scope: candidate.scope,
        url: candidate.url,
        title: candidate.title,
        addedBy: "agent",
      });
      const failedSource = externalSourceResult.sources.find((source) => source.status === "failed");
      if (failedSource) {
        this.removeFailedCandidateExternalSource(failedSource.id);
        throw new Error(failedSource.error || "来源加入失败。");
      }
      const source = externalSourceResult.sources[0];
      const accepted = this.options.businessStore.updateSourceCandidateStatus(candidate.id, "accepted", { externalSourceId: source?.id }) || candidate;
      return { candidate: accepted, externalSourceResult };
    } catch (error) {
      const failed = this.options.businessStore.updateSourceCandidateStatus(candidate.id, "failed", { error: errorMessage(error) }) || {
        ...candidate,
        status: "failed" as const,
        error: errorMessage(error),
        updatedAt: now(),
      };
      return { candidate: failed };
    }
  }

  rejectSourceCandidate(candidateId: string): SourceCandidate {
    const candidate = this.options.businessStore.getSourceCandidate(candidateId);
    if (!candidate) throw new Error("候选来源不存在。");
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId || candidate.semesterId !== semesterId) throw new Error("请先切换到这个候选来源所属的学期。");
    activeCourseScopeOrThrow(this.options.businessStore, candidate.courseId, semesterId);
    return this.options.businessStore.updateSourceCandidateStatus(candidate.id, "rejected") || { ...candidate, status: "rejected", updatedAt: now() };
  }

  private recoverStaleSourceCandidate(candidate: SourceCandidate): SourceCandidate {
    if (candidate.status !== "accepting") return candidate;
    const updatedAtMs = Date.parse(candidate.updatedAt);
    if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < SOURCE_CANDIDATE_ACCEPTING_TIMEOUT_MS) return candidate;
    return this.options.businessStore.updateSourceCandidateStatus(candidate.id, "failed", { error: "上次加入来源中断了，可以重试。" }) || {
      ...candidate,
      status: "failed",
      error: "上次加入来源中断了，可以重试。",
      updatedAt: now(),
    };
  }

  private removeFailedCandidateExternalSource(sourceId: string): void {
    const source = this.options.businessStore.getExternalSource(sourceId);
    if (!source || source.status !== "failed") return;
    if (source.originalPath) this.safeRm(dirname(source.originalPath), `[external-sources] Failed to remove failed candidate source folder ${dirname(source.originalPath)}`);
    else if (source.markdownPath) this.safeRm(dirname(source.markdownPath), `[external-sources] Failed to remove failed candidate source folder ${dirname(source.markdownPath)}`);
    this.options.businessStore.deleteExternalSource(sourceId);
  }

  private findDuplicateExternalWebSource(semesterId: string, courseId: string, taskId: string | undefined, scope: "task" | "course", url: URL): ExternalSource | undefined {
    const normalizedUrl = normalizedExternalSourceUrlKey(url);
    return this.options.businessStore.listExternalSources({
      semesterId,
      courseId,
      taskId: scope === "task" ? taskId : undefined,
    }).find((source) =>
      source.kind === "web"
      && source.scope === scope
      && source.status !== "failed"
      && Boolean(source.url)
      && safeNormalizedExternalSourceUrlKey(source.url || "") === normalizedUrl,
    );
  }

  fileSourcePath(fileId: string): string | undefined {
    const { file, semesterId } = this.guardFileAccess(fileId, "accessing");
    this.assertFileSourceInsideWorkspace(file, semesterId);
    return file.sourcePath;
  }

  fileOpenPath(fileId: string): string | undefined {
    const { file, semesterId } = this.guardFileAccess(fileId, "accessing");
    if (file.sourcePath) {
      this.assertFileSourceInsideWorkspace(file, semesterId);
      return file.sourcePath;
    }
    const resolved = this.managedFolderOpenPath(file, semesterId);
    if (!resolved) return undefined;
    if (!isPathInside(resolved.path, resolved.allowedRoot)) {
      throw new Error(`Refusing to access folder outside the workspace: ${resolved.path}`);
    }
    mkdirSync(resolved.path, { recursive: true });
    return resolved.path;
  }

  async renameFile(fileId: string, nextName: string): Promise<{ courseId: string; tree: WorkspaceFileNode[] }> {
    const { file, semesterId } = this.guardFileAccess(fileId, "renaming");
    const affectedFileIds = this.localFileIdsForMutation(file, semesterId);
    const sourcePath = this.mutableSourcePath(file, semesterId, "rename");
    if (affectedFileIds.some((id) => this.options.businessStore.hasActiveFileIndexing(id))) {
      throw new Error("Wait for indexing to finish before renaming this file.");
    }
    const safeName = sanitizeFsSegment(nextName);
    if (safeName !== nextName.trim()) throw new Error("File name contains unsupported characters.");
    const targetPath = join(dirname(sourcePath), safeName);
    if (targetPath === sourcePath) return { courseId: file.courseId, tree: this.listFiles(file.courseId) };
    if (existsSync(targetPath)) throw new Error(`"${safeName}" already exists.`);
    renameSync(sourcePath, targetPath);
    await this.deleteRagChunksForFiles(affectedFileIds);
    this.syncManagedDiskFiles(file.courseId, semesterId);
    return { courseId: file.courseId, tree: this.listFiles(file.courseId) };
  }

  async deleteFile(input: string | DeleteFileInput): Promise<{ courseId: string; tree: WorkspaceFileNode[] }> {
    const fileId = typeof input === "string" ? input : input.fileId;
    const forceCancelIndexing = typeof input === "string" ? false : input.forceCancelIndexing === true;
    const { file, semesterId } = this.guardFileAccess(fileId, "deleting");
    const affectedFileIds = this.localFileIdsForMutation(file, semesterId);
    const activeJobs = this.options.businessStore.activeIndexingJobsForFiles(affectedFileIds);
    if (activeJobs.length > 0) {
      if (!forceCancelIndexing) {
        throw new Error("这个文件正在进入知识库。请先取消索引，或选择取消索引并删除。");
      }
      for (const job of activeJobs) {
        this.options.businessStore.cancelIndexingJob(job.id);
      }
    }
    const courseId = file.courseId;
    const sourcePath = this.mutableSourcePath(file, semesterId, "delete");

    const roots = this.loadCourseRoots(courseId, semesterId);
    removeFileFromTree(roots, fileId);
    this.persistWorkspaceFilesForCourse(courseId, roots, semesterId);

    if (sourcePath && existsSync(sourcePath)) {
      this.safeRm(sourcePath, `[files] Failed to remove source ${sourcePath}`, {
        scope: "file",
        operation: "delete_file_source",
        targetId: fileId,
        path: sourcePath,
      });
    }
    if (sourcePath) {
      const parsedDir = parsedDocumentDirForSource(sourcePath, fileId);
      this.safeRm(parsedDir, `[files] Failed to remove parsed document cache for ${sourcePath}`, {
        scope: "file",
        operation: "delete_parsed_document",
        targetId: fileId,
        path: parsedDir,
      });
    }
    await this.deleteRagChunksForFiles(affectedFileIds);
    return { courseId, tree: this.listFiles(courseId) };
  }

  private localFileIdsForMutation(file: WorkspaceFileNode, semesterId: string): string[] {
    if (file.kind !== "folder") return [file.id];
    const roots = this.loadCourseRoots(file.courseId, semesterId);
    const folder = findFileNodeById(roots, file.id);
    if (!folder) return [];
    return flattenFiles([folder]).filter((child) => Boolean(child.sourcePath)).map((child) => child.id);
  }

  private mutableSourcePath(file: WorkspaceFileNode, semesterId: string, operation: "delete" | "rename"): string {
    if (!file.sourcePath) throw new Error(`This workspace folder is managed by Brevyn and cannot be ${operation === "delete" ? "deleted" : "renamed"} here.`);
    if (!existsSync(file.sourcePath)) throw new Error("文件源路径不可用。");
    const allowedRoot = file.courseId === SEMESTER_HOME_COURSE_ID
      ? join(semesterWorkspaceDir(this.options.rootDataDir, semesterId), "Semester shared")
      : courseWorkspaceDir(this.options.rootDataDir, semesterId, file.courseId);
    this.assertFileSourceInsideWorkspace(file, semesterId, allowedRoot);
    return file.sourcePath;
  }

  private guardFileAccess(fileId: string, operation: string): { file: WorkspaceFileNode; semesterId: string } {
    const file = this.options.businessStore.getWorkspaceFile(fileId);
    if (!file) throw new Error(`File not found: ${fileId}`);
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId || file.semesterId !== semesterId) {
      throw new Error(`Select this file's semester before ${operation} it.`);
    }
    activeCourseScopeOrThrow(this.options.businessStore, file.courseId, semesterId);
    return { file, semesterId };
  }

  private assertFileSourceInsideWorkspace(file: WorkspaceFileNode, semesterId: string, allowedRoot = this.allowedSourceRoot(file.courseId, semesterId)): void {
    if (file.sourcePath && existsSync(file.sourcePath) && !isPathInside(file.sourcePath, allowedRoot)) {
      throw new Error(`Refusing to access file outside the workspace: ${file.sourcePath}`);
    }
  }

  private allowedSourceRoot(courseId: string, semesterId: string): string {
    return courseId === SEMESTER_HOME_COURSE_ID
      ? join(semesterWorkspaceDir(this.options.rootDataDir, semesterId), "Semester shared")
      : courseWorkspaceDir(this.options.rootDataDir, semesterId, courseId);
  }

  private managedFolderOpenPath(file: WorkspaceFileNode, semesterId: string): { path: string; allowedRoot: string } | undefined {
    if (file.kind !== "folder") return undefined;
    if (file.courseId === SEMESTER_HOME_COURSE_ID) {
      const semesterDir = ensureSemesterSharedDirs(this.options.rootDataDir, semesterId);
      const semesterSharedDir = join(semesterDir, "Semester shared");
      if (file.sectionKind === "course_shared" || file.name === "Semester shared" || file.path.endsWith("/Semester shared")) {
        return { path: semesterSharedDir, allowedRoot: semesterDir };
      }
      return { path: semesterDir, allowedRoot: semesterDir };
    }

    const courseDir = ensureCourseWorkspaceDir(this.options.rootDataDir, semesterId, file.courseId);
    if (isExternalSourcesFolder(file)) {
      if (file.taskId) {
        const task = taskInCourseOrThrow(this.options.businessStore, file.taskId, file.courseId, semesterId);
        return { path: join(taskWorkspaceDirForTask(courseDir, task), EXTERNAL_SOURCES_FOLDER), allowedRoot: courseDir };
      }
      return { path: join(courseDir, EXTERNAL_SOURCES_FOLDER), allowedRoot: courseDir };
    }
    if (isCourseRootFolder(file)) return { path: courseDir, allowedRoot: courseDir };
    if (file.sectionKind === "course_shared" || file.name === "Course shared") {
      return { path: join(courseDir, "Course shared"), allowedRoot: courseDir };
    }
    if (file.sectionKind === "lecture" || file.name === "Lecture") {
      const weekNumber = file.weekNumber || lectureWeekNumberFromFolderName(file.name);
      const lectureDir = join(courseDir, "Lecture");
      return { path: weekNumber ? join(lectureDir, lectureWeekFolderName(weekNumber)) : lectureDir, allowedRoot: courseDir };
    }
    if (file.sectionKind === "task" || file.taskId || file.name === "Task") {
      if (!file.taskId) return { path: join(courseDir, "Task"), allowedRoot: courseDir };
      const task = taskInCourseOrThrow(this.options.businessStore, file.taskId, file.courseId, semesterId);
      const taskDir = taskWorkspaceDirForTask(courseDir, task);
      if (file.taskFileBucket) return { path: join(taskDir, taskBucketLabel(file.taskFileBucket)), allowedRoot: courseDir };
      return { path: taskDir, allowedRoot: courseDir };
    }
    return undefined;
  }

  private async statImportSources(sourcePaths: string[]): Promise<Array<{ sourcePath: string; size: number }>> {
    const sources: Array<{ sourcePath: string; size: number }> = [];
    for (const sourcePath of sourcePaths) {
      const stats = await stat(sourcePath);
      if (!stats.isFile()) {
        throw new Error(`"${basename(sourcePath)}" is not a regular file.`);
      }
      if (stats.size > MAX_IMPORT_FILE_BYTES) {
        throw new Error(`"${basename(sourcePath)}" is ${formatSize(stats.size)}. File imports are limited to ${formatSize(MAX_IMPORT_FILE_BYTES)} per file.`);
      }
      sources.push({ sourcePath, size: stats.size });
    }
    return sources;
  }

  courseFileSections(courseId: string): CourseFileSection[] {
    if (isCurrentSemesterArchived(this.options.businessStore)) return [];
    if (courseId !== SEMESTER_HOME_COURSE_ID && isCourseArchived(this.options.businessStore, courseId)) return [];
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return [];
    this.refreshIndexingJobs();
    if (courseId === SEMESTER_HOME_COURSE_ID) {
      const leafFiles = this.semesterSharedFiles(semesterId);
      const provider = this.embeddingProvider();
      return [
        {
          id: `${courseId}:shared`,
          courseId,
          kind: "course_shared",
          title: "学期资料",
          indexingStatus: this.indexingStatusForSection(courseId, `${courseId}:shared`, leafFiles),
          embeddingModel: provider?.selectedModel,
          files: leafFiles,
        },
      ];
    }

    const files = this.listFiles(courseId);
    const tasks = this.options.businessStore.listTasks(semesterId, courseId);
    const provider = this.embeddingProvider();
    const embeddingModel = provider?.selectedModel;
    const leafFiles = flattenFiles(files);
    const lectureFiles = leafFiles.filter((file) => file.sectionKind === "lecture");
    const lectureSection: CourseFileSection = {
      id: `${courseId}:lecture`,
      courseId,
      kind: "lecture",
      title: "Lecture",
      indexingStatus: this.indexingStatusForSection(courseId, `${courseId}:lecture`, lectureFiles),
      embeddingModel,
      files: lectureFiles,
    };
    const taskSections: CourseFileSection[] = tasks.map((task) => ({
      id: `${courseId}:task-${task.id}`,
      courseId,
      kind: "task",
      title: `${taskTypeLabel(task.taskType)} / ${task.title}`,
      taskId: task.id,
      taskType: task.taskType,
      icon: task.icon,
      indexingStatus: this.indexingStatusForSection(courseId, `${courseId}:task-${task.id}`, leafFiles.filter((file) => file.taskId === task.id)),
      embeddingModel,
      files: leafFiles.filter((file) => file.taskId === task.id),
    }));
    const sharedFiles = leafFiles.filter((file) => file.sectionKind === "course_shared" || (!file.taskId && file.sectionKind !== "lecture"));

    return [
      {
        id: `${courseId}:shared`,
        courseId,
        kind: "course_shared",
        title: "Course shared",
        indexingStatus: this.indexingStatusForSection(courseId, `${courseId}:shared`, sharedFiles),
        embeddingModel,
        files: sharedFiles,
      },
      lectureSection,
      ...taskSections,
    ];
  }

  private semesterSharedFiles(semesterId: string): WorkspaceFileNode[] {
    const root = this.viewCourseRoots(SEMESTER_HOME_COURSE_ID, semesterId)[0];
    if (!root) return [];
    const sharedFolder = (root.children || []).find((file) => file.kind === "folder" && file.sectionKind === "course_shared");
    return sharedFolder ? flattenFiles([sharedFolder]) : [];
  }

  indexCourseFiles(courseId: string, sectionId?: string): IndexingJob {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) throw new Error("请先选择学期，再索引文件。");
    activeCourseScopeOrThrow(this.options.businessStore, courseId, semesterId);
    const activeJob = this.activeBlockingIndexingJobForRequest(semesterId, courseId, sectionId);
    if (activeJob) return { ...activeJob };
    const sections = this.courseFileSections(courseId);
    const files = sectionId ? sections.find((section) => section.id === sectionId)?.files || [] : sections.flatMap((section) => section.files);
    const provider = this.embeddingProvider();
    const localFiles = flattenFiles(files).filter(isIndexableWorkspaceFile);
    return this.createIndexingJobForFiles({
      semesterId,
      courseId,
      sectionId,
      files: localFiles,
      provider,
    });
  }

  private indexImportedFiles(courseId: string, sectionId: string | undefined, files: WorkspaceFileNode[]): ImportedIndexingResult {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) throw new Error("请先选择学期，再索引文件。");
    activeCourseScopeOrThrow(this.options.businessStore, courseId, semesterId);
    const provider = this.embeddingProvider();
    const localFiles = flattenFiles(files).filter(isIndexableWorkspaceFile);
    const activeJob = this.options.businessStore.activeIndexingJobForSection(semesterId, courseId, sectionId);
    if (activeJob) {
      if (localFiles.length === 0) {
        return {
          job: activeJob,
          notice: "这个分区已有索引任务在进行中；本次导入没有新的可索引文件。",
        };
      }
      if (embeddingJobMatchesProvider(activeJob, provider)) {
        const tasks = this.indexingTasksForFiles({
          jobId: activeJob.id,
          semesterId,
          courseId,
          sectionId,
          files: localFiles,
          provider,
        });
        const appendedJob = this.options.businessStore.appendIndexingTasksToJob(activeJob.id, tasks) || activeJob;
        return {
          job: appendedJob,
          notice: `这个分区已有索引任务在进行中，已把 ${localFiles.length} 个新文件追加到当前队列。`,
        };
      }
      return {
        job: activeJob,
        error: "这个分区已有索引任务在进行中，但当前选择的向量服务商或模型和该任务不一致。文件已导入，但不会自动排队；请等待当前任务完成后再重新索引。",
      };
    }
    const wholeCourseActiveJob = this.activeIndexingJobForWholeCourse(semesterId, courseId);
    if (wholeCourseActiveJob) {
      return {
        job: wholeCourseActiveJob,
        error: "这门课正在进行全量索引。文件已导入，但不会自动排队；请等待全量索引完成后再重新索引。",
      };
    }
    return normalizeImportedIndexingResult({
      job: this.createIndexingJobForFiles({
        semesterId,
        courseId,
        sectionId,
        files: localFiles,
        provider,
      }),
    });
  }

  private createIndexingJobForFiles(input: {
    semesterId: string;
    courseId: string;
    sectionId?: string;
    files: WorkspaceFileNode[];
    provider?: ModelProviderConfig;
  }): IndexingJob {
    const { semesterId, courseId, sectionId, provider } = input;
    const localFiles = input.files.filter(isIndexableWorkspaceFile);
    const timestamp = now();
    const hasFiles = localFiles.length > 0;
    const hasProvider = Boolean(provider?.selectedModel);
    let status: IndexingJob["status"];
    let stage: string;
    let progress: number;
    let error: string | undefined;
    if (!hasFiles) {
      status = "idle";
      stage = "empty";
      progress = 0;
      error = "这个分区没有可用于索引的本地源文件。";
    } else if (!hasProvider) {
      status = "failed";
      stage = "no_provider";
      progress = 0;
      error = "No embedding provider configured. Open Settings -> Providers and enable an OpenAI-compatible embedding provider.";
    } else {
      status = "queued";
      stage = "queued";
      progress = 0;
      error = undefined;
    }
    const job: IndexingJob = {
      id: `index-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      semesterId,
      courseId,
      sectionId,
      status,
      stage,
      embeddingModel: provider?.selectedModel || "(none)",
      embeddingProviderFingerprint: provider ? embeddingProviderFingerprint(provider) : undefined,
      indexedFiles: 0,
      totalFiles: localFiles.length,
      completedFiles: 0,
      progress,
      error,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const tasks = status === "queued" ? this.indexingTasksForFiles({
      jobId: job.id,
      semesterId,
      courseId,
      sectionId,
      files: localFiles,
      provider,
    }) : [];
    const created = this.options.businessStore.createIndexingJob(job, tasks);
    this.refreshIndexingJobs();
    return { ...created };
  }

  private indexingTasksForFiles(input: {
    jobId: string;
    semesterId: string;
    courseId: string;
    sectionId?: string;
    files: WorkspaceFileNode[];
    provider?: ModelProviderConfig;
  }): IndexingTaskInsert[] {
    const { jobId, semesterId, courseId, sectionId, files, provider } = input;
    const timestamp = Date.now().toString(36);
    return files.map((file, index) => {
      const fileCourseId = file.courseId || courseId;
      return {
        id: `idx-task-${jobId}-${timestamp}-${index + 1}-${Math.random().toString(36).slice(2, 7)}`,
        jobId,
        semesterId,
        courseId: fileCourseId,
        sectionId,
        fileId: file.id,
        kind: "parse_chunk",
        maxAttempts: INDEXING_TASK_MAX_ATTEMPTS,
        payload: {
          semesterId,
          courseId: fileCourseId,
          sectionId,
          fileId: file.id,
          taskId: file.taskId,
          name: file.name,
          path: file.path,
          sourcePath: file.sourcePath,
          kind: file.kind,
          weekNumber: file.weekNumber,
          taskFileBucket: file.taskFileBucket,
          embeddingProvider: provider ? embeddingProviderSnapshot(provider) : undefined,
        },
      };
    });
  }

  async reindexCourseFiles(courseId: string, sectionId?: string): Promise<IndexingJob> {
    await this.options.ragIndex.rebuildOutdatedSchemaForExplicitReindex();
    return this.indexCourseFiles(courseId, sectionId);
  }

  retryIndexingFile(fileId: string): IndexingJob {
    const { file, semesterId } = this.guardFileAccess(fileId, "re-indexing");
    if (file.kind === "folder") throw new Error("Folders cannot be indexed directly. Choose a file instead.");
    if (!file.sourcePath) throw new Error("No local source path is available for this file. Re-import the file before indexing.");
    if (isAgentWorkspaceControlFile(file)) throw new Error("Brevyn workspace memory files are visible to the Agent but are not indexed by RAG.");
    if (!isRagEligibleWorkspaceFile(file)) throw new Error("这个文件还没有加入课程资料库，不能进入 RAG 索引。请通过上传入口导入，或先显式加入索引。");
    if (!existsSync(file.sourcePath)) throw new Error("文件源路径不可用。请重新导入这个文件。");
    this.assertFileSourceInsideWorkspace(file, semesterId);
    if (this.options.businessStore.hasActiveFileIndexing(file.id)) {
      throw new Error("This file is already being indexed.");
    }
    const provider = this.embeddingProvider();
    const sectionId = sectionIdForFile(file);
    const activeJob = this.options.businessStore.activeIndexingJobForSection(semesterId, file.courseId, sectionId);
    if (activeJob) {
      if (!embeddingJobMatchesProvider(activeJob, provider)) {
        throw new Error("这个分区已有索引任务在进行中，但当前选择的向量服务商或模型和该任务不一致。请等待当前任务完成后再重新索引。");
      }
      const tasks = this.indexingTasksForFiles({
        jobId: activeJob.id,
        semesterId,
        courseId: file.courseId,
        sectionId,
        files: [file],
        provider,
      });
      return this.options.businessStore.appendIndexingTasksToJob(activeJob.id, tasks) || activeJob;
    }
    const wholeCourseActiveJob = this.activeIndexingJobForWholeCourse(semesterId, file.courseId);
    if (wholeCourseActiveJob) {
      throw new Error("这门课正在进行全量索引。请等待全量索引完成后再重新索引这个文件。");
    }
    return this.createIndexingJobForFiles({
      semesterId,
      courseId: file.courseId,
      sectionId,
      files: [file],
      provider,
    });
  }

  async indexActiveSemesterCourses(): Promise<IndexActiveSemesterResult> {
    await this.options.ragIndex.rebuildOutdatedSchemaForExplicitReindex();
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) throw new Error("请先选择学期，再索引文件。");
    const courses = new Map<string, string>([[SEMESTER_HOME_COURSE_ID, "学期总览"]]);
    for (const course of this.options.businessStore.listCourses(semesterId)) {
      if (course.id !== SEMESTER_HOME_COURSE_ID && !course.archivedAt) courses.set(course.id, course.name || course.code || course.id);
    }
    const jobs: IndexingJob[] = [];
    const failures: IndexActiveSemesterResult["failures"] = [];
    for (const [courseId, courseName] of courses) {
      try {
        jobs.push(this.indexCourseFiles(courseId));
      } catch (error) {
        failures.push({ courseId, courseName, message: errorMessage(error) });
      }
    }
    return { jobs, failures };
  }

  listIndexingJobs(courseId?: string): IndexingJob[] {
    if (isCurrentSemesterArchived(this.options.businessStore)) return [];
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return [];
    const archivedCourseIds = new Set(archivedCourseIdsForSemester(this.options.businessStore, semesterId));
    return latestIndexingJobsByScope(this.options.businessStore.listIndexingJobs(semesterId, courseId).filter((job) => !archivedCourseIds.has(job.courseId)));
  }

  embeddingIndexHealth(courseId?: string): EmbeddingIndexHealth {
    const provider = this.embeddingProvider();
    const emptyHealth = (): EmbeddingIndexHealth => ({
      state: "empty",
      embeddingConfigured: Boolean(provider?.selectedModel),
      embeddingModel: provider?.selectedModel || undefined,
      totalFiles: 0,
      indexedFiles: 0,
      readyFiles: 0,
      staleFiles: 0,
      unindexedFiles: 0,
    });
    if (isCurrentSemesterArchived(this.options.businessStore)) return emptyHealth();
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return emptyHealth();
    if (courseId && courseId !== SEMESTER_HOME_COURSE_ID && isCourseArchived(this.options.businessStore, courseId)) return emptyHealth();

    const files = uniqueFilesById(flattenFiles(this.listFiles(courseId)).filter(isIndexableWorkspaceFile));
    if (files.length === 0) return emptyHealth();
    const completedIndexing = this.options.businessStore.latestCompletedIndexingRecords(semesterId, courseId);
    const currentFingerprint = provider?.selectedModel ? embeddingProviderFingerprint(provider) : undefined;
    let readyFiles = 0;
    let staleFiles = 0;
    let unindexedFiles = 0;
    for (const file of files) {
      const completed = completedIndexing.get(file.id);
      if (completed) {
        if (currentFingerprint && completed.fingerprint === currentFingerprint && completedIndexingCoversCurrentSource(file, completed.completedAt)) readyFiles += 1;
        else staleFiles += 1;
      } else if (file.indexedAt) {
        staleFiles += 1;
      } else {
        unindexedFiles += 1;
      }
    }
    const indexedFiles = readyFiles + staleFiles;
    const embeddingConfigured = Boolean(currentFingerprint);
    const state: EmbeddingIndexHealth["state"] = indexedFiles === 0
      ? "empty"
      : embeddingConfigured && readyFiles === files.length
        ? "ready"
        : "needs_rebuild";
    return {
      state,
      embeddingConfigured,
      embeddingModel: provider?.selectedModel || undefined,
      totalFiles: files.length,
      indexedFiles,
      readyFiles,
      staleFiles,
      unindexedFiles,
    };
  }

  cancelIndexingJob(jobId: string): IndexingJob | null {
    const job = this.options.businessStore.cancelIndexingJob(jobId);
    return job ? { ...job } : null;
  }

  claimNextIndexingTask(workerId: string, lockMs: number): IndexingTaskRecord | null {
    return this.options.businessStore.claimNextIndexingTask(workerId, lockMs);
  }

  recoverExpiredIndexingTasks(currentWorkerId?: string): void {
    this.options.businessStore.recoverExpiredIndexingTasks(currentWorkerId);
  }

  async completeIndexingTask(taskId: string, result: IndexingWorkerResult, workerId?: string, lockedUntil?: string): Promise<IndexingJob | null> {
    let task = this.options.businessStore.getIndexingTask(taskId);
    if (!task) return null;
    let lease = workerId ? { workerId, lockedUntil } : undefined;
    if (lease && (task.status !== "running" || task.lockedBy !== lease.workerId || task.lockedUntil !== lease.lockedUntil)) {
      return this.options.businessStore.getIndexingJob(task.jobId);
    }
    const job = this.options.businessStore.getIndexingJob(task.jobId);
    if (job?.status === "cancelled") {
      return this.options.businessStore.completeIndexingTask(taskId, result, lease);
    }
    if (lease) {
      const extendedTask = this.options.businessStore.extendIndexingTaskLease(taskId, lease, INDEXING_INGEST_LOCK_MS);
      if (!extendedTask?.lockedBy || !extendedTask.lockedUntil) return this.options.businessStore.getIndexingJob(task.jobId);
      task = extendedTask;
      lease = { workerId: extendedTask.lockedBy, lockedUntil: extendedTask.lockedUntil };
    }
    const leaseCurrent = () => !lease || this.options.businessStore.isIndexingTaskLeaseCurrent(taskId, lease);
    result = this.persistDerivedMarkdownForIndexingTask(task, result);
    let ingested: boolean;
    try {
      ingested = await this.options.ragIndex.ingestTask(task, result, leaseCurrent);
    } catch (error) {
      return this.options.businessStore.failIndexingTask(taskId, errorMessage(error), lease);
    }
    if (!ingested || !leaseCurrent()) return this.options.businessStore.getIndexingJob(task.jobId);
    return this.options.businessStore.completeIndexingTask(taskId, result, lease);
  }

  failIndexingTask(taskId: string, message: string, workerId?: string, lockedUntil?: string): IndexingJob | null {
    return this.options.businessStore.failIndexingTask(taskId, message, workerId ? { workerId, lockedUntil } : undefined);
  }

  private persistDerivedMarkdownForIndexingTask(task: IndexingTaskRecord, result: IndexingWorkerResult): IndexingWorkerResult {
    const markdown = typeof result.derivedMarkdown === "string" ? result.derivedMarkdown.trim() : "";
    const sourcePath = result.sourcePath || task.payload.sourcePath;
    if (!markdown || !sourcePath) return stripDerivedMarkdown(result);
    try {
      if (!existsSync(sourcePath)) return stripDerivedMarkdown(result);
      const outputDir = parsedDocumentDirForSource(sourcePath, task.payload.fileId);
      mkdirSync(join(outputDir, "assets"), { recursive: true });
      const contentPath = join(outputDir, "content.md");
      const metadataPath = join(outputDir, "metadata.json");
      const artifactPath = join(outputDir, "artifact.json");
      const semanticUnitsPath = join(outputDir, "semantic-units.jsonl");
      writeFileSync(contentPath, `${markdown}\n`, "utf8");
      const officeArtifact = isRecord(result.officeArtifact) ? result.officeArtifact : undefined;
      if (officeArtifact) {
        writeFileSync(artifactPath, `${JSON.stringify(officeArtifact, null, 2)}\n`, "utf8");
        const semanticUnits = Array.isArray(officeArtifact.semanticUnits) ? officeArtifact.semanticUnits : [];
        writeFileSync(semanticUnitsPath, semanticUnits.map((unit) => JSON.stringify(unit)).join("\n") + (semanticUnits.length > 0 ? "\n" : ""), "utf8");
      }
      const sourceStats = statSync(sourcePath);
      const timestamp = now();
      writeFileSync(metadataPath, `${JSON.stringify({
        fileId: task.payload.fileId,
        courseId: task.payload.courseId,
        sectionId: task.payload.sectionId,
        taskId: task.payload.taskId,
        sourceName: task.payload.name,
        sourcePath,
        sourceSha256: sha256File(sourcePath),
        sourceSize: sourceStats.size,
        sourceUpdatedAt: sourceStats.mtime.toISOString(),
        parser: String(result.metadata?.parser || "unknown"),
        parserModel: String(result.metadata?.documentParseModel || result.metadata?.ocrModel || ""),
        mode: String(result.metadata?.documentParseMode || ""),
        coverageStatus: String(result.metadata?.coverageStatus || ""),
        charCount: markdown.length,
        chunkCount: result.chunkCount,
        artifactPath: officeArtifact ? artifactPath : undefined,
        semanticUnitsPath: officeArtifact ? semanticUnitsPath : undefined,
        artifactId: String(result.metadata?.artifactId || ""),
        artifactSchemaVersion: Number(result.metadata?.artifactSchemaVersion || 0),
        createdAt: timestamp,
        updatedAt: timestamp,
      }, null, 2)}\n`, "utf8");
      return stripDerivedMarkdown({
        ...result,
        metadata: {
          ...(result.metadata || {}),
          derivedMarkdownPath: contentPath,
          derivedMetadataPath: metadataPath,
          derivedArtifactPath: officeArtifact ? artifactPath : "",
          derivedSemanticUnitsPath: officeArtifact ? semanticUnitsPath : "",
        },
      });
    } catch (error) {
      return stripDerivedMarkdown({
        ...result,
        warnings: [...result.warnings, `解析文本保存失败：${errorMessage(error)}`],
      });
    }
  }

  syncActiveSemesterDiskFiles(): boolean {
    if (isCurrentSemesterArchived(this.options.businessStore)) return false;
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return false;
    let changed = this.syncManagedDiskFiles(SEMESTER_HOME_COURSE_ID, semesterId);
    for (const course of this.options.businessStore.listCourses(semesterId)) {
      if (course.id === SEMESTER_HOME_COURSE_ID || course.archivedAt) continue;
      changed = this.syncManagedDiskFiles(course.id, semesterId) || changed;
    }
    return changed;
  }

  private viewCourseRoots(courseId: string, semesterId: string): WorkspaceFileNode[] {
    const roots = this.loadCourseRoots(courseId, semesterId);
    const semester = this.options.businessStore.getSemester(semesterId);
    const course = courseId === SEMESTER_HOME_COURSE_ID ? undefined : this.options.businessStore.getCourse(courseId);
    if (!semester || (courseId !== SEMESTER_HOME_COURSE_ID && (!course || course.semesterId !== semesterId))) return [];
    if (courseId === SEMESTER_HOME_COURSE_ID) ensureSemesterSharedDirs(this.options.rootDataDir, semesterId);
    const before = JSON.stringify(roots);
    ensureCourseFolderInTree({
      roots,
      courseId,
      semester,
      course,
      tasks: courseId === SEMESTER_HOME_COURSE_ID ? [] : this.options.businessStore.listTasks(semesterId, courseId),
      timestamp: now(),
    });
    if (courseId !== SEMESTER_HOME_COURSE_ID) this.pruneEmptyLectureWeekFolders(roots);
    if (before !== JSON.stringify(roots)) this.persistWorkspaceFilesForCourse(courseId, roots, semesterId);
    this.hideArchivedTaskNodes(roots, semesterId, courseId);
    return roots;
  }

  private writableCourseRoots(courseId: string, semesterId: string): WorkspaceFileNode[] {
    const roots = this.loadCourseRoots(courseId, semesterId);
    const semester = this.options.businessStore.getSemester(semesterId);
    const course = courseId === SEMESTER_HOME_COURSE_ID ? undefined : this.options.businessStore.getCourse(courseId);
    if (!semester || (courseId !== SEMESTER_HOME_COURSE_ID && (!course || course.semesterId !== semesterId))) return [];
    ensureCourseFolderInTree({
      roots,
      courseId,
      semester,
      course,
      tasks: courseId === SEMESTER_HOME_COURSE_ID ? [] : this.options.businessStore.listTasks(semesterId, courseId),
      timestamp: now(),
    });
    if (courseId !== SEMESTER_HOME_COURSE_ID) this.pruneEmptyLectureWeekFolders(roots);
    return roots;
  }

  private loadCourseRoots(courseId: string, semesterId: string): WorkspaceFileNode[] {
    return cloneFiles(this.options.businessStore.listWorkspaceFiles(semesterId, courseId).filter((file) => file.kind === "folder"));
  }

  private hideArchivedTaskNodes(roots: WorkspaceFileNode[], semesterId: string, courseId?: string): void {
    const courseIds = courseId
      ? [courseId]
      : Array.from(new Set(roots.map((root) => root.courseId).filter((id): id is string => Boolean(id && id !== SEMESTER_HOME_COURSE_ID))));
    for (const id of courseIds) {
      for (const task of this.options.businessStore.listArchivedTasks(semesterId, id)) {
        removeTaskFromTree(roots, task.id);
      }
    }
  }

  private syncManagedDiskFiles(courseId: string, semesterId: string): boolean {
    const roots = this.writableCourseRoots(courseId, semesterId);
    const root = roots[0];
    if (!root) return false;
    const before = JSON.stringify(roots);
    const timestamp = now();
    let changed = false;

    if (courseId === SEMESTER_HOME_COURSE_ID) {
      const sharedFolder = ensureTargetFolderInTree(root, { courseId, targetSection: "course_shared" }, undefined, timestamp);
      changed = this.syncDiskFolder(sharedFolder, join(semesterWorkspaceDir(this.options.rootDataDir, semesterId), "Semester shared"), {
        courseId,
        sectionKind: "course_shared",
      }, timestamp) || changed;
    } else {
      const courseDir = courseWorkspaceDir(this.options.rootDataDir, semesterId, courseId);
      this.ensureLectureWeekDirs(courseDir, semesterId);
      changed = this.syncDiskFolder(
        ensureTargetFolderInTree(root, { courseId, targetSection: "course_shared" }, undefined, timestamp),
        join(courseDir, "Course shared"),
        { courseId, sectionKind: "course_shared" },
        timestamp,
      ) || changed;
      changed = this.syncDiskFolder(
        ensureTargetFolderInTree(root, { courseId, targetSection: "lecture" }, undefined, timestamp),
        join(courseDir, "Lecture"),
        { courseId, sectionKind: "lecture" },
        timestamp,
      ) || changed;
      for (const task of this.options.businessStore.listTasks(semesterId, courseId)) {
        const taskDir = taskWorkspaceDirForTask(courseDir, task);
        for (const bucket of ["materials", "drafts", "submitted"] as const) {
          const bucketFolder = ensureTargetFolderInTree(root, {
            courseId,
            targetSection: "task",
            taskId: task.id,
            taskFileBucket: bucket,
          }, task, timestamp);
          changed = this.syncDiskFolder(bucketFolder, join(taskDir, taskBucketLabel(bucket)), {
            courseId,
            taskId: task.id,
            taskType: task.taskType,
            taskFileBucket: bucket,
            sectionKind: "task",
          }, timestamp) || changed;
        }
        const taskFolder = findTaskFolderNode(root, task.id);
        if (taskFolder) {
          changed = this.syncAgentWorkspaceMemoryFile(taskFolder, join(taskDir, AGENT_WORKSPACE_MEMORY_FILE), {
            courseId,
            taskId: task.id,
            taskType: task.taskType,
            sectionKind: "task",
          }, timestamp) || changed;
        }
      }
    }

    changed = changed || before !== JSON.stringify(roots);
    if (changed) this.persistWorkspaceFilesForCourse(courseId, roots, semesterId);
    return changed;
  }

  private syncDiskFolder(
    parent: WorkspaceFileNode,
    dir: string,
    metadata: Pick<WorkspaceFileNode, "courseId" | "taskId" | "taskType" | "taskFileBucket" | "sectionKind" | "weekNumber">,
    timestamp: string,
  ): boolean {
    if (!existsSync(dir)) return false;
    let changed = false;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    const visibleEntries = entries
      .filter((entry) => !entry.name.startsWith("."))
      .filter((entry) => entry.name !== PARSED_DOCUMENTS_FOLDER)
      .filter((entry) => !this.shouldHideEmptyLectureWeekDir(metadata, dir, entry))
      .sort((a, b) => a.name.localeCompare(b.name));
    const visibleNames = new Set(visibleEntries.map((entry) => entry.name));
    parent.children ||= [];
    for (let index = parent.children.length - 1; index >= 0; index -= 1) {
      const child = parent.children[index];
      if (!visibleNames.has(child.name)) {
        parent.children.splice(index, 1);
        changed = true;
      }
    }
    for (const entry of visibleEntries) {
      if (entry.name.startsWith(".")) continue;
      const sourcePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const childCount = parent.children.length;
        const childMetadata = this.metadataForDiskChild(metadata, entry.name);
        const folder = ensureFolderChild(parent, entry.name, { ...childMetadata, sourcePath }, timestamp);
        changed = parent.children.length !== childCount || this.syncDiskFolder(folder, sourcePath, childMetadata, timestamp) || changed;
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      let updatedAt = timestamp;
      try {
        const stats = statSync(sourcePath);
        size = stats.size;
        updatedAt = stats.mtime.toISOString();
      } catch {
        // Best effort: if stat races with an external write, keep the file visible and let preview handle errors.
      }
      const existing = parent.children.find((child) => child.kind !== "folder" && (child.sourcePath === sourcePath || child.name === entry.name));
      const next = {
        semesterId: parent.semesterId,
        ...metadata,
        sourcePath,
        name: entry.name,
        path: `${parent.path}/${entry.name}`,
        kind: kindForPath(sourcePath),
        sizeLabel: formatSize(size),
        updatedAt,
      };
      if (existing) {
        const before = JSON.stringify(existing);
        Object.assign(existing, next);
        changed = before !== JSON.stringify(existing) || changed;
      } else {
        parent.children.push({
          id: `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          ...next,
          ragEligible: false,
          sourceKind: "disk_discovered",
        });
        changed = true;
      }
    }
    return changed;
  }

  private syncAgentWorkspaceMemoryFile(
    parent: WorkspaceFileNode,
    sourcePath: string,
    metadata: Pick<WorkspaceFileNode, "courseId" | "taskId" | "taskType" | "taskFileBucket" | "sectionKind" | "weekNumber">,
    timestamp: string,
  ): boolean {
    parent.children ||= [];
    const existingIndex = parent.children.findIndex((child) => child.kind !== "folder" && child.name === AGENT_WORKSPACE_MEMORY_FILE);
    if (!existsSync(sourcePath)) {
      if (existingIndex < 0) return false;
      parent.children.splice(existingIndex, 1);
      return true;
    }
    let size = 0;
    let updatedAt = timestamp;
    try {
      const stats = statSync(sourcePath);
      if (!stats.isFile()) return false;
      size = stats.size;
      updatedAt = stats.mtime.toISOString();
    } catch {
      return false;
    }
    const next = {
      semesterId: parent.semesterId,
      ...metadata,
      sourcePath,
      name: AGENT_WORKSPACE_MEMORY_FILE,
      path: `${parent.path}/${AGENT_WORKSPACE_MEMORY_FILE}`,
      kind: kindForPath(sourcePath),
      sizeLabel: formatSize(size),
      updatedAt,
    };
    if (existingIndex >= 0) {
      const existing = parent.children[existingIndex];
      const before = JSON.stringify(existing);
      Object.assign(existing, next);
      return before !== JSON.stringify(existing);
    }
    parent.children.push({
      id: `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      ...next,
    });
    return true;
  }

  private metadataForDiskChild(
    metadata: Pick<WorkspaceFileNode, "courseId" | "taskId" | "taskType" | "taskFileBucket" | "sectionKind" | "weekNumber">,
    name: string,
  ): Pick<WorkspaceFileNode, "courseId" | "taskId" | "taskType" | "taskFileBucket" | "sectionKind" | "weekNumber"> {
    if (metadata.sectionKind !== "lecture" || metadata.weekNumber) return metadata;
    return { ...metadata, weekNumber: lectureWeekNumberFromFolderName(name) };
  }

  private shouldHideEmptyLectureWeekDir(
    metadata: Pick<WorkspaceFileNode, "courseId" | "taskId" | "taskType" | "taskFileBucket" | "sectionKind" | "weekNumber">,
    dir: string,
    entry: Dirent<string>,
  ): boolean {
    if (metadata.sectionKind !== "lecture" || metadata.weekNumber || !entry.isDirectory()) return false;
    if (!lectureWeekNumberFromFolderName(entry.name)) return false;
    return !hasVisibleDiskEntries(join(dir, entry.name));
  }

  private ensureLectureWeekDirs(courseDir: string, semesterId: string): void {
    const semester = this.options.businessStore.getSemester(semesterId);
    for (const weekNumber of lectureWeekNumbersForFolders(semester)) {
      mkdirSync(join(courseDir, "Lecture", lectureWeekFolderName(weekNumber)), { recursive: true });
    }
  }

  private pruneEmptyLectureWeekFolders(nodes: WorkspaceFileNode[], insideLectureRoot = false): boolean {
    let changed = false;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      const emptyLectureWeek = node.kind === "folder" &&
        insideLectureRoot &&
        Boolean(lectureWeekNumberFromFolderName(node.name)) &&
        (node.children?.length || 0) === 0;
      if (emptyLectureWeek) {
        nodes.splice(index, 1);
        changed = true;
        continue;
      }
      if (node.children && this.pruneEmptyLectureWeekFolders(node.children, node.sectionKind === "lecture" && !node.weekNumber)) changed = true;
    }
    return changed;
  }

  private persistWorkspaceFilesForCourse(courseId: string, roots: WorkspaceFileNode[], semesterId = currentActiveSemesterId(this.options.businessStore)): void {
    if (!semesterId) return;
    this.options.businessStore.saveWorkspaceFilesForScope(semesterId, courseId, roots);
  }

  private ensureImportTargetDir(input: FileImportInput): string {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    return ensureImportTargetDir(this.options.rootDataDir, semesterId, input, (taskId) => this.options.businessStore.getTask(taskId) || undefined);
  }

  private ensureExternalSourceDir(semesterId: string, courseId: string, taskId: string | undefined, sourceId: string, title: string): string {
    const safeLeaf = `${sourceId}__${sanitizeFsSegment(title || "source")}`;
    const dir = taskId
      ? join(courseWorkspaceDir(this.options.rootDataDir, semesterId, courseId), "Task", this.externalTaskFolderName(courseId, taskId), EXTERNAL_SOURCES_FOLDER, safeLeaf)
      : join(courseWorkspaceDir(this.options.rootDataDir, semesterId, courseId), EXTERNAL_SOURCES_FOLDER, safeLeaf);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private externalTaskFolderName(courseId: string, taskId: string): string {
    const course = this.options.businessStore.getCourse(courseId);
    const task = this.options.businessStore.getTask(taskId);
    if (!course || !task) throw new Error("外部来源所属任务不存在。");
    const courseDir = courseWorkspaceDir(this.options.rootDataDir, task.semesterId || currentActiveSemesterId(this.options.businessStore), courseId);
    return basename(taskWorkspaceDirForTask(courseDir, task));
  }

  private registerExternalWorkspaceFile(input: {
    semesterId: string;
    courseId: string;
    taskId?: string;
    scope: "task" | "course";
    sourceId: string;
    title: string;
    sourcePath: string;
    timestamp: string;
    size?: number;
  }): WorkspaceFileNode {
    const roots = this.writableCourseRoots(input.courseId, input.semesterId);
    const root = roots[0];
    if (!root) throw new Error("课程文件树不可用。");
    const parent = input.scope === "task" && input.taskId
      ? this.ensureTaskExternalFolder(root, input.courseId, input.taskId, input.timestamp)
      : ensureFolderChild(root, EXTERNAL_SOURCES_FOLDER, {
          courseId: input.courseId,
          sectionKind: "course_shared",
          sourceKind: "user_import",
          ragEligible: true,
        }, input.timestamp);
    const stats = statSync(input.sourcePath);
    const file: WorkspaceFileNode = {
      id: `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      semesterId: input.semesterId,
      courseId: input.courseId,
      taskId: input.scope === "task" ? input.taskId : undefined,
      taskFileBucket: input.scope === "task" ? "materials" : undefined,
      sectionKind: input.scope === "task" ? "task" : "course_shared",
      sourcePath: input.sourcePath,
      name: basename(input.sourcePath),
      displayName: input.title,
      path: `${parent.path}/${basename(input.sourcePath)}`,
      kind: kindForPath(input.sourcePath),
      sizeLabel: formatSize(input.size ?? stats.size),
      ragEligible: true,
      sourceKind: "user_import",
      updatedAt: input.timestamp,
    };
    parent.children = [...(parent.children || []), file];
    this.persistWorkspaceFilesForCourse(input.courseId, roots, input.semesterId);
    return file;
  }

  private ensureTaskExternalFolder(root: WorkspaceFileNode, courseId: string, taskId: string, timestamp: string): WorkspaceFileNode {
    const task = taskInCourseOrThrow(this.options.businessStore, taskId, courseId, root.semesterId);
    const taskFolder = findTaskFolderNode(root, taskId);
    const parent = taskFolder || ensureFolderChild(
      ensureFolderChild(root, "Task", { sectionKind: "task" }, timestamp),
      `${taskId}__${sanitizeFsSegment(task.title)}`,
      { courseId, taskId, taskType: task.taskType, sectionKind: "task", displayName: task.title },
      timestamp,
    );
    return ensureFolderChild(parent, EXTERNAL_SOURCES_FOLDER, {
      courseId,
      taskId,
      taskType: task.taskType,
      taskFileBucket: "materials",
      sectionKind: "task",
      sourceKind: "user_import",
      ragEligible: true,
    }, timestamp);
  }

  private sectionIdForImport(input: FileImportInput): string | undefined {
    if (input.targetSection === "course_shared") return `${input.courseId}:shared`;
    if (input.targetSection === "lecture") return `${input.courseId}:lecture`;
    if (input.targetSection === "task" && input.taskId) return `${input.courseId}:task-${input.taskId}`;
    return undefined;
  }

  private indexingStatusForSection(courseId: string, sectionId: string, files: WorkspaceFileNode[] = []): IndexingJob["status"] {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    if (!semesterId) return "idle";
    const job = this.options.businessStore.listIndexingJobs(semesterId, courseId).find((item) => item.sectionId === sectionId);
    if (job && isActiveIndexingJob(job)) return job.status;
    const indexableFiles = flattenFiles(files).filter(isIndexableWorkspaceFile);
    if (indexableFiles.length === 0) return "idle";
    if (indexableFiles.every((file) => file.indexingStatus === "indexed" || Boolean(file.indexedAt))) return "indexed";
    if (indexableFiles.some((file) => file.indexingStatus === "failed")) return "failed";
    if (indexableFiles.some((file) => file.indexingStatus === "cancelled")) return "cancelled";
    if (job?.status === "failed" || job?.status === "cancelled") return job.status;
    return "idle";
  }

  private embeddingProvider(): ModelProviderConfig | undefined {
    return this.options.providers.embeddingProvider();
  }

  private activeBlockingIndexingJobForRequest(semesterId: string, courseId: string, sectionId?: string): IndexingJob | null {
    const activeJobs = this.options.businessStore.listIndexingJobs(semesterId, courseId).filter(isActiveIndexingJob);
    if (!sectionId) return activeJobs[0] || null;
    return activeJobs.find((job) => !job.sectionId || job.sectionId === sectionId) || null;
  }

  private activeIndexingJobForWholeCourse(semesterId: string, courseId: string): IndexingJob | null {
    return this.options.businessStore.activeIndexingJobForSection(semesterId, courseId);
  }

  private refreshIndexingJobs(): IndexingJob[] {
    const semesterId = currentActiveSemesterId(this.options.businessStore);
    return semesterId ? this.options.businessStore.listIndexingJobs(semesterId) : [];
  }

  private async deleteRagChunksForFile(fileId: string): Promise<void> {
    try {
      await this.options.ragIndex.deleteChunksByFile(fileId);
    } catch (error) {
      console.warn(`[rag] Failed to delete chunks for file ${fileId}`, error);
      recordCleanupFailure(this.options.rootDataDir, {
        scope: "rag",
        operation: "delete_chunks_by_file",
        targetId: fileId,
        message: errorMessage(error),
      });
    }
  }

  private async deleteRagChunksForFiles(fileIds: string[]): Promise<void> {
    for (const fileId of new Set(fileIds)) {
      await this.deleteRagChunksForFile(fileId);
    }
  }

  private safeRm(path: string, message: string, failure?: Omit<CleanupFailure, "message">): void {
    if (!existsSync(path)) return;
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      console.warn(message, error);
      if (failure) {
        recordCleanupFailure(this.options.rootDataDir, {
          ...failure,
          message: errorMessage(error),
        });
      }
    }
  }
}

function uniqueFilePath(dir: string, fileName: string): string {
  const safeName = sanitizeFsSegment(fileName);
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

function externalSourceId(): string {
  return `source-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sourceCandidateId(): string {
  return `candidate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sectionIdForExternalSource(courseId: string, scope: "task" | "course", taskId?: string): string | undefined {
  if (scope === "task" && taskId) return `${courseId}:task-${taskId}`;
  return `${courseId}:shared`;
}

function normalizeExternalSourceUrl(value: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("请输入网页链接。");
  let url: URL;
  try {
    url = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error("这个网页链接格式不正确。请粘贴完整的网址。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只支持 http 或 https 网页链接。");
  url.hash = "";
  return url;
}

async function fetchExternalWebSource(url: URL): Promise<{ title: string; html: string; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_SOURCE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "user-agent": "Brevyn/0.1 ExternalSourceFetcher",
      },
    });
    if (!response.ok) throw new Error(webSourceHttpError(response.status));
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("text/plain") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("这个链接不是可直接解析的网页。PDF、Word 或 PPT 请用“文件”添加。");
    }
    const raw = await response.text();
    const html = raw.slice(0, MAX_WEB_SOURCE_BYTES);
    const title = decodeHtmlEntities(extractTitle(html));
    const text = extractReadableText(html);
    if (!text.trim()) throw new Error("没有从网页中提取到可用正文。可以改用浏览器保存 PDF，或复制正文为文本文件添加。");
    return { title, html, text };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("网页读取超时。这个网站响应太慢，稍后再试或改用文件添加。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedExternalSourceUrlKey(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.hash = "";
  normalized.hostname = normalized.hostname.toLowerCase();
  if ((normalized.protocol === "https:" && normalized.port === "443") || (normalized.protocol === "http:" && normalized.port === "80")) {
    normalized.port = "";
  }
  normalized.pathname = normalized.pathname.replace(/\/+$/, "") || "/";
  normalized.searchParams.sort();
  return normalized.toString();
}

function safeNormalizedExternalSourceUrlKey(value: string): string {
  try {
    return normalizedExternalSourceUrlKey(normalizeExternalSourceUrl(value));
  } catch {
    return value.trim();
  }
}

function webSourceHttpError(status: number): string {
  if (status === 401 || status === 403) return "这个网页需要登录或没有公开访问权限。";
  if (status === 404) return "没有找到这个网页，请检查链接是否完整。";
  if (status === 408 || status === 429) return "这个网站暂时响应不过来，稍后再试。";
  if (status >= 500) return "这个网站服务器暂时不可用，稍后再试。";
  return `网页读取失败：HTTP ${status}`;
}

function userFacingWebSourceError(error: unknown): string {
  const message = errorMessage(error);
  if (!message) return "网页解析失败。请稍后再试，或改用文件添加。";
  if (
    message.includes("fetch failed")
    || message.includes("ENOTFOUND")
    || message.includes("ECONNREFUSED")
    || message.includes("ECONNRESET")
    || message.includes("EAI_AGAIN")
  ) {
    return "无法连接到这个网页。请检查网络、链接是否可访问，或稍后再试。";
  }
  if (message.includes("certificate") || message.includes("CERT_") || message.includes("SSL")) {
    return "这个网页的安全证书无法验证。请换一个可公开访问的链接，或改用文件添加。";
  }
  return message;
}

function extractTitle(html: string): string {
  return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
}

function extractReadableText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|header|footer|main|li|h[1-6]|blockquote|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(withoutNoise)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n\n")
    .slice(0, 250_000);
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const value = Number(code);
      return Number.isFinite(value) ? String.fromCharCode(value) : "";
    });
}

function markdownForWebSource(input: { title: string; url: string; text: string }): string {
  return `# ${input.title || "网页来源"}\n\n来源：${input.url}\n\n${input.text.trim()}\n`;
}

function summarizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

function hasVisibleDiskEntries(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some((entry) => !entry.name.startsWith("."));
  } catch {
    return false;
  }
}

function isCourseRootFolder(file: WorkspaceFileNode): boolean {
  return file.kind === "folder" && !file.sectionKind && !file.taskId && file.path === file.name;
}

function isExternalSourcesFolder(file: WorkspaceFileNode): boolean {
  return file.kind === "folder" && file.name === EXTERNAL_SOURCES_FOLDER;
}

function lectureWeekNumbersForFolders(semester: Parameters<typeof semesterLectureWeekNumbers>[0]): number[] {
  return semesterLectureWeekNumbers(semester).slice(0, MAX_LECTURE_WEEK_FOLDERS);
}

function findFileNodeById(nodes: WorkspaceFileNode[], fileId: string): WorkspaceFileNode | undefined {
  for (const node of nodes) {
    if (node.id === fileId) return node;
    const child = node.children ? findFileNodeById(node.children, fileId) : undefined;
    if (child) return child;
  }
  return undefined;
}

function findTaskFolderNode(root: WorkspaceFileNode, taskId: string): WorkspaceFileNode | undefined {
  if (root.kind === "folder" && root.taskId === taskId && root.sectionKind === "task" && !root.taskFileBucket) return root;
  for (const child of root.children || []) {
    const match = findTaskFolderNode(child, taskId);
    if (match) return match;
  }
  return undefined;
}

function isIndexableWorkspaceFile(file: WorkspaceFileNode): boolean {
  return Boolean(file.sourcePath) && isRagEligibleWorkspaceFile(file) && !isAgentWorkspaceControlFile(file);
}

function isActiveIndexingJob(job: IndexingJob): boolean {
  return job.status === "queued" || job.status === "indexing";
}

function isRagEligibleWorkspaceFile(file: WorkspaceFileNode): boolean {
  if (file.ragEligible === true) return true;
  if (file.ragEligible === false) return false;
  return Boolean(file.indexedAt || (file.indexingStatus && file.indexingStatus !== "idle"));
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

function readPreviewSource(sourcePath?: string): string {
  if (!sourcePath || !existsSync(sourcePath)) return "";
  try {
    const stats = statSync(sourcePath);
    const bytesToRead = Math.min(stats.size, MAX_TEXT_PREVIEW_BYTES);
    const content = readFilePrefix(sourcePath, bytesToRead).toString("utf8");
    const preview = truncatePreviewText(content, 12000);
    return stats.size > MAX_TEXT_PREVIEW_BYTES
      ? `${preview}\n\n[仅预览前 ${formatSize(MAX_TEXT_PREVIEW_BYTES)}]`
      : preview;
  } catch {
    return "";
  }
}

function readFilePrefix(sourcePath: string, bytesToRead: number): Buffer {
  if (bytesToRead <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  let fd: number | undefined;
  try {
    fd = openSync(sourcePath, "r");
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
    return bytesRead === bytesToRead ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function truncatePreviewText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[已截断至 ${maxLength} 个字符]`;
}

async function previewDocxHtml(sourcePath?: string): Promise<{ summary: string; content: string; html?: string }> {
  if (!sourcePath || !existsSync(sourcePath)) {
    return { summary: "DOCX 源文件不可用于预览。", content: "" };
  }
  if (extname(sourcePath).toLowerCase() === ".doc") {
    return {
      summary: "旧版 .doc 文件需要用 Word/WPS/Office 打开才能完整预览。",
      content: "",
    };
  }
  try {
    const [htmlResult, textResult] = await Promise.all([
      mammoth.convertToHtml({ path: sourcePath }, {
        styleMap: [
          "p[style-name='Title'] => h1:fresh",
          "p[style-name='Subtitle'] => h2:fresh",
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
        ],
      }),
      mammoth.extractRawText({ path: sourcePath }),
    ]);
    const html = htmlResult.value.trim();
    return {
      summary: "已将 DOCX 渲染为文档预览。",
      content: truncatePreviewText(normalizePreviewText(textResult.value), 24000) || "（未找到可提取文本。）",
      html: html || undefined,
    };
  } catch (error) {
    return {
      summary: `DOCX 预览失败：${errorMessage(error)}`,
      content: "",
    };
  }
}

function preparePdfCanvasPreview(rootDataDir: string, sourcePath?: string, title = "PDF", fileId?: string): { summary: string; previewUrl?: string } {
  if (!sourcePath || !existsSync(sourcePath)) {
    return { summary: "PDF 源文件不可用于预览。" };
  }
  try {
    const stats = statSync(sourcePath);
    if (stats.size > MAX_PREVIEW_FILE_BYTES) {
      return { summary: `PDF 文件过大（${formatSize(stats.size)}），请用外部应用打开。` };
    }
    const previewUrl = writePdfPreviewBundle(rootDataDir, sourcePath, stats, title, {
      initialFitMode: "width",
      semanticUnits: readPdfPreviewSemanticUnits(sourcePath, fileId),
    });
    return {
      summary: "已生成 PDF 画布预览。",
      previewUrl,
    };
  } catch (error) {
    return {
      summary: `PDF 预览失败：${errorMessage(error)}`,
    };
  }
}

async function prepareOfficePdfCanvasPreview(
  rootDataDir: string,
  sourcePath?: string,
  title = "Office",
  options: { viewMode?: "document" | "deck"; speakerNotes?: Record<number, string>; semanticUnits?: PdfPreviewSemanticUnit[] } = {},
): Promise<{ summary: string; previewUrl?: string }> {
  if (!sourcePath || !existsSync(sourcePath)) {
    return { summary: "高保真预览生成失败，已切换为基础预览。" };
  }
  try {
    const stats = statSync(sourcePath);
    if (stats.size > MAX_PREVIEW_FILE_BYTES) {
      console.warn("[office-preview] Source file is too large for high fidelity preview", { sourcePath, size: stats.size });
      return { summary: "文件较大，已切换为基础预览。" };
    }
    const cacheKey = createHash("sha256")
      .update(`${sourcePath}\n${stats.size}\n${stats.mtimeMs}\n${title}`)
      .digest("hex")
      .slice(0, 20);
    const outputDir = join(rootDataDir, PREVIEW_CACHE_DIR, "office-pdf", cacheKey);
    mkdirSync(outputDir, { recursive: true });
    const expectedPdf = join(outputDir, `${basename(sourcePath).replace(/\.[^.]+$/u, "")}.pdf`);
    const cachedPdf = existsSync(expectedPdf) ? expectedPdf : newestPdfFile(outputDir);
    const converted = cachedPdf
      ? { ok: true as const, pdfPath: cachedPdf, runtime: undefined }
      : await convertOfficeDocumentToPdf({
        rootDataDir,
        sourcePath,
        outputDir,
      });
    if (!converted.ok) {
      console.warn("[office-preview] LibreOffice preview failed", { sourcePath, reason: converted.reason });
      return { summary: "高保真预览生成失败，已切换为基础预览。" };
    }
    return {
      summary: "已使用 LibreOffice 生成高保真预览。",
      previewUrl: writePdfPreviewBundle(rootDataDir, converted.pdfPath, statSync(converted.pdfPath), title, {
        viewMode: options.viewMode || "document",
        initialFitMode: "page",
        speakerNotes: options.speakerNotes,
        semanticUnits: options.semanticUnits,
      }),
    };
  } catch (error) {
    console.warn("[office-preview] High fidelity preview failed", { sourcePath, error: errorMessage(error) });
    return { summary: "高保真预览生成失败，已切换为基础预览。" };
  }
}

function writePdfPreviewBundle(
  rootDataDir: string,
  sourcePath: string,
  stats: Stats,
  title: string,
  options: { viewMode?: "document" | "deck"; initialFitMode?: "page" | "width"; speakerNotes?: Record<number, string>; semanticUnits?: PdfPreviewSemanticUnit[] } = {},
): string {
  const assets = ensurePdfPreviewAssets(rootDataDir);
  const speakerNotesFingerprint = JSON.stringify(options.speakerNotes || {});
  const semanticUnitsFingerprint = JSON.stringify(options.semanticUnits || []);
  const bundleHash = createHash("sha256")
    .update(`${sourcePath}\n${stats.size}\n${stats.mtimeMs}\n${title}\n${options.viewMode || "document"}\n${options.initialFitMode || "width"}\n${speakerNotesFingerprint}\n${semanticUnitsFingerprint}`)
    .digest("hex")
    .slice(0, 20);
  const bundleDir = join(rootDataDir, PREVIEW_CACHE_DIR, "pdf-viewer", bundleHash);
  mkdirSync(bundleDir, { recursive: true });
  const sourcePreviewPath = join(bundleDir, "source.pdf");
  const scriptPath = join(bundleDir, "pdf.min.mjs");
  const workerPath = join(bundleDir, "pdf.worker.min.mjs");
  const fontsDir = join(bundleDir, "standard_fonts");
  const htmlPath = join(bundleDir, "index.html");

  if (!existsSync(sourcePreviewPath) || statSync(sourcePreviewPath).size !== stats.size) {
    copyFileSync(sourcePath, sourcePreviewPath);
  }
  if (!existsSync(scriptPath)) copyFileSync(assets.pdfScriptPath, scriptPath);
  if (!existsSync(workerPath)) copyFileSync(assets.pdfWorkerPath, workerPath);
  if (!existsSync(fontsDir)) cpSync(assets.standardFontsDir, fontsDir, { recursive: true });
  const html = pdfCanvasPreviewDocument({
      title,
      fileUrl: "./source.pdf",
      pdfScriptUrl: "./pdf.min.mjs",
      pdfWorkerUrl: "./pdf.worker.min.mjs",
      standardFontDataUrl: "./standard_fonts/",
      viewMode: options.viewMode || "document",
      initialFitMode: options.initialFitMode || (options.viewMode === "deck" ? "page" : "width"),
      speakerNotes: options.speakerNotes,
      semanticUnits: options.semanticUnits,
  });
  if (!existsSync(htmlPath) || readFileSync(htmlPath, "utf8") !== html) {
    writeFileSync(htmlPath, html, "utf8");
  }
  return `${workspaceDirectoryPreviewUrl(bundleDir)}/index.html`;
}

function newestPdfFile(dir: string): string {
  if (!existsSync(dir)) return "";
  try {
    return readdirSync(dir)
      .filter((entry) => extname(entry).toLowerCase() === ".pdf")
      .map((entry) => join(dir, entry))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0] || "";
  } catch {
    return "";
  }
}

function ensurePdfPreviewAssets(rootDataDir: string): { pdfScriptPath: string; pdfWorkerPath: string; standardFontsDir: string } {
  const assetsDir = join(rootDataDir, PREVIEW_CACHE_DIR, "pdfjs");
  const standardFontsDir = join(assetsDir, "standard_fonts");
  const bundledAssetsDir = pdfPreviewAssetsDir();
  mkdirSync(assetsDir, { recursive: true });
  const pdfScriptPath = join(assetsDir, "pdf.min.mjs");
  const pdfWorkerPath = join(assetsDir, "pdf.worker.min.mjs");
  if (!existsSync(pdfScriptPath)) copyFileSync(resolvePdfPreviewAsset(bundledAssetsDir, "pdf.min.mjs", "pdfjs-dist/build/pdf.min.mjs"), pdfScriptPath);
  if (!existsSync(pdfWorkerPath)) copyFileSync(resolvePdfPreviewAsset(bundledAssetsDir, "pdf.worker.min.mjs", "pdfjs-dist/build/pdf.worker.min.mjs"), pdfWorkerPath);
  if (!existsSync(standardFontsDir)) {
    const bundledFontsDir = join(bundledAssetsDir, "standard_fonts");
    const sourceFontsDir = existsSync(bundledFontsDir)
      ? bundledFontsDir
      : join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
    cpSync(sourceFontsDir, standardFontsDir, { recursive: true });
  }
  return { pdfScriptPath, pdfWorkerPath, standardFontsDir };
}

function resolvePdfPreviewAsset(bundledAssetsDir: string, bundledName: string, packagePath: string): string {
  const bundledPath = join(bundledAssetsDir, bundledName);
  return existsSync(bundledPath) ? bundledPath : require.resolve(packagePath);
}

function pdfPreviewAssetsDir(): string {
  const packagedUnpackedDir = join(process.resourcesPath || "", "app.asar.unpacked", "dist", "pdfjs");
  if (existsSync(packagedUnpackedDir)) return packagedUnpackedDir;
  return join(__dirname, "pdfjs");
}

function writePreviewHtml(rootDataDir: string, html: string): string {
  const previewDir = join(rootDataDir, PREVIEW_CACHE_DIR, "html");
  mkdirSync(previewDir, { recursive: true });
  const hash = createHash("sha256").update(html).digest("hex").slice(0, 20);
  const htmlPath = join(previewDir, `preview-${hash}.html`);
  if (!existsSync(htmlPath)) writeFileSync(htmlPath, html, "utf8");
  return workspaceFilePreviewUrl(htmlPath);
}

function pdfCanvasPreviewDocument(input: {
  title: string;
  fileUrl: string;
  pdfScriptUrl: string;
  pdfWorkerUrl: string;
  standardFontDataUrl: string;
  viewMode: "document" | "deck";
  initialFitMode: "page" | "width";
  speakerNotes?: Record<number, string>;
  semanticUnits?: PdfPreviewSemanticUnit[];
}): string {
  const speakerNotesJson = escapeInlineJson(input.speakerNotes || {});
  const semanticUnitsJson = escapeInlineJson(input.semanticUnits || []);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapePreviewHtml(input.title)}</title>
    <style>
      * { box-sizing: border-box; }
      :root {
        color-scheme: light;
        --app-background: 48 33% 97%;
        --app-foreground: 60 3% 8%;
        --app-card: 45 43% 98%;
        --app-muted: 47 24% 91%;
        --app-muted-foreground: 42 8% 38%;
        --app-border: 43 20% 84%;
        --app-primary: 15 63% 60%;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", system-ui, sans-serif;
        background: hsl(var(--app-background));
        color: hsl(var(--app-foreground));
      }
      :root[data-theme="dark"] { color-scheme: dark; }
      html { width: 100%; height: 100%; min-width: 100%; overflow: auto; }
      body {
        margin: 0;
        width: 100%;
        min-width: 100%;
        min-height: 100vh;
        overflow: auto;
        background:
          radial-gradient(circle at 18% 0%, hsl(var(--app-card) / .72), transparent 28rem),
          hsl(var(--app-background));
      }
      #viewer { min-height: 100vh; }
      #thumbs { display: none; }
      #deck-main { min-width: 100%; min-height: 100vh; }
      #pages { display: flex; flex-direction: column; align-items: flex-start; gap: 14px; padding: 16px; min-width: 100%; }
      #speaker-notes { display: none; }
      .page-wrap { display: flex; justify-content: center; width: max(100%, var(--page-width)); }
      .page { position: relative; display: block; }
      .page[data-rendered="false"] {
        background: white;
        border-radius: 4px;
        box-shadow: 0 18px 48px rgba(31,41,51,.10), 0 1px 0 rgba(31,41,51,.06);
      }
      .page[data-highlighted="true"]::after {
        content: "";
        position: absolute;
        inset: -6px;
        border: 2px solid hsl(var(--app-primary));
        border-radius: 10px;
        box-shadow: 0 0 0 4px hsl(var(--app-primary) / .16);
        pointer-events: none;
        z-index: 3;
      }
      .semantic-highlight {
        position: absolute;
        border: 1px solid hsl(var(--app-primary) / .54);
        border-radius: 6px;
        background: hsl(var(--app-primary) / .12);
        box-shadow: 0 0 0 2px hsl(var(--app-primary) / .08);
        pointer-events: none;
        z-index: 4;
      }
      canvas { display: block; max-width: none; border-radius: 4px; background: white; box-shadow: 0 18px 48px rgba(31,41,51,.16), 0 1px 0 rgba(31,41,51,.08); }
      .textLayer {
        position: absolute;
        inset: 0;
        overflow: hidden;
        opacity: 1;
        line-height: 1;
        text-align: initial;
        text-size-adjust: none;
        forced-color-adjust: none;
        transform-origin: 0 0;
        z-index: 2;
      }
      .textLayer :is(span, br) {
        position: absolute;
        color: transparent;
        white-space: pre;
        cursor: text;
        transform-origin: 0% 0%;
      }
      .textLayer span.text-hit-highlight {
        border-radius: 3px;
        background: rgba(255, 214, 10, .34);
        box-shadow: 0 0 0 1px rgba(255, 180, 0, .18);
      }
      .textLayer ::selection {
        background: rgba(0, 122, 255, .66);
        color: transparent;
      }
      .textLayer span::selection {
        background: rgba(0, 122, 255, .66);
        color: transparent;
      }
      .textLayer span::-moz-selection {
        background: rgba(0, 122, 255, .66);
        color: transparent;
      }
      .loading, .error, .page-info { width: 100%; padding: 34px 18px; text-align: center; color: hsl(var(--app-muted-foreground)); font-size: 12px; line-height: 1.6; }
      .error { color: #b42318; }
      .page-info { padding-top: 0; font-size: 11px; }
      body[data-view-mode="deck"] { width: 100%; height: 100%; min-height: 0; overflow: hidden; background: hsl(var(--app-background)); }
      body[data-view-mode="deck"] #viewer {
        display: grid;
        grid-template-columns: 112px minmax(0, 1fr);
        height: 100%;
        min-height: 0;
        overflow: hidden;
        background: hsl(var(--app-background));
      }
      body[data-view-mode="deck"] #thumbs {
        display: block;
        min-height: 0;
        overflow-y: auto;
        border-right: 1px solid hsl(var(--app-border) / .72);
        background: hsl(var(--app-card) / .72);
        padding: 10px 6px;
      }
      body[data-view-mode="deck"] #deck-main {
        display: grid;
        grid-template-rows: minmax(0, 1fr) auto;
        min-width: 0;
        min-height: 0;
        height: 100%;
        overflow: hidden;
        background: hsl(var(--app-background));
      }
      body[data-view-mode="deck"] #pages {
        display: block;
        min-width: 0;
        height: auto;
        min-height: 0;
        overflow: auto;
        padding: 0;
        background: hsl(var(--app-muted) / .24);
        overscroll-behavior: contain;
      }
      body[data-view-mode="deck"] .page-wrap {
        display: flex;
        min-height: 100%;
        width: max(100%, calc(var(--page-width) + 32px));
        max-width: none;
        align-items: flex-start;
        justify-content: center;
        padding: 16px;
      }
      body[data-view-mode="deck"][data-fit-mode="page"] .page-wrap {
        align-items: center;
      }
      body[data-view-mode="deck"] canvas {
        border-radius: 8px;
        box-shadow: 0 24px 80px rgba(31,41,51,.16), 0 0 0 1px hsl(var(--app-border) / .7);
      }
      body[data-view-mode="deck"] #speaker-notes {
        display: block;
        height: clamp(96px, 15vh, 148px);
        min-height: 0;
        overflow: hidden;
        border-top: 1px solid hsl(var(--app-border) / .72);
        background: hsl(var(--app-card) / .82);
        padding: 12px 18px 14px;
      }
      .speaker-notes-inner {
        display: flex;
        width: min(74rem, 92%);
        height: 100%;
        min-height: 0;
        margin: 0 auto;
        flex-direction: column;
      }
      .speaker-notes-title {
        flex: 0 0 auto;
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0;
        color: hsl(var(--app-foreground));
      }
      .speaker-notes-body {
        min-height: 0;
        overflow: auto;
        padding-top: 6px;
        color: hsl(var(--app-muted-foreground));
        font-size: 12px;
        line-height: 1.55;
      }
      .thumb-button {
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        width: 100%;
        border: 0;
        border-radius: 10px;
        background: transparent;
        color: hsl(var(--app-muted-foreground));
        cursor: pointer;
        padding: 7px 4px;
        text-align: left;
        transition: background-color 140ms ease, color 140ms ease;
      }
      .thumb-button:hover { background: hsl(var(--app-muted) / .62); color: hsl(var(--app-foreground)); }
      .thumb-button[data-selected="true"] {
        background: hsl(var(--app-primary) / .08);
        color: hsl(var(--app-primary));
      }
      .thumb-index {
        position: absolute;
        left: 2px;
        top: 3px;
        z-index: 1;
        display: inline-flex;
        min-width: 18px;
        height: 18px;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: hsl(var(--app-card) / .9);
        color: hsl(var(--app-muted-foreground));
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
        box-shadow: 0 1px 4px rgba(31,41,51,.08);
      }
      .thumb-button[data-selected="true"] .thumb-index {
        background: hsl(var(--app-primary));
        color: hsl(var(--app-background));
      }
      .thumb-canvas-wrap {
        display: block;
        flex: 0 0 auto;
        max-width: 100%;
        overflow: hidden;
        border: 1px solid hsl(var(--app-border));
        border-radius: 8px;
        background: white;
        box-shadow: 0 8px 18px rgba(31,41,51,.08);
      }
      .thumb-button[data-selected="true"] .thumb-canvas-wrap {
        border-color: hsl(var(--app-primary));
        box-shadow: 0 0 0 2px hsl(var(--app-primary) / .24), 0 8px 18px rgba(31,41,51,.08);
      }
      .thumb-canvas-wrap canvas { width: 100%; height: auto; border-radius: 0; box-shadow: none; }
    </style>
  </head>
  <body data-view-mode="${input.viewMode}">
    <main id="viewer">
      <aside id="thumbs" aria-label="幻灯片列表"></aside>
      <section id="deck-main">
        <section id="pages"><div class="loading">正在加载 PDF...</div></section>
        <section id="speaker-notes" aria-label="演讲备注">
          <div class="speaker-notes-inner">
            <div class="speaker-notes-title">Speaker notes</div>
            <div class="speaker-notes-body">No speaker notes</div>
          </div>
        </section>
      </section>
    </main>
    <script type="module">
      const pages = document.getElementById("pages");
      const thumbs = document.getElementById("thumbs");
      const speakerNotesTitle = document.querySelector(".speaker-notes-title");
      const speakerNotesBody = document.querySelector(".speaker-notes-body");
      const viewMode = ${JSON.stringify(input.viewMode)};
      const speakerNotesByPage = ${speakerNotesJson};
      const semanticUnits = ${semanticUnitsJson};
      const steps = [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4];
      const defaultStepIndex = steps.indexOf(1);
      let stepIndex = defaultStepIndex;
      let customScale = null;
      let fitMode = ${JSON.stringify(input.initialFitMode)};
      let pdfDoc = null;
      let pdfjsLib = null;
      let pendingScrollTop = 0;
      let currentPage = 1;
      let resizeFrame = 0;
      let lastFitWidth = 0;
      let lastFitHeight = 0;
      let highlightedPage = 0;
      let pendingHighlight = null;
      let highlightTimer = null;
      let renderGeneration = 0;
      let initialFitComplete = false;
      let documentPageObserver = null;
      const documentRenderPromises = new Map();
      function notifyZoom() {
        window.parent.postMessage({ type: "pdf-zoom-changed", zoom: Math.round(currentScale() * 100), fitMode: fitMode || "custom" }, "*");
      }
      function notifyScroll() {
        window.parent.postMessage({ type: "pdf-scroll-changed", scrollTop: window.scrollY || document.documentElement.scrollTop || 0 }, "*");
      }
      function notifyPage() {
        window.parent.postMessage({ type: "pdf-page-changed", page: currentPage }, "*");
      }
      function updateSpeakerNotes() {
        if (viewMode !== "deck" || !speakerNotesTitle || !speakerNotesBody) return;
        const note = typeof speakerNotesByPage[currentPage] === "string" ? speakerNotesByPage[currentPage].trim() : "";
        speakerNotesTitle.textContent = "Speaker notes";
        speakerNotesBody.textContent = note || "No speaker notes";
        speakerNotesBody.dataset.empty = note ? "false" : "true";
      }
      function notifyLoaded() {
        if (!pdfDoc) return;
        window.parent.postMessage({ type: "pdf-loaded", pageCount: pdfDoc.numPages, page: currentPage, zoom: Math.round(currentScale() * 100), fitMode: fitMode || "custom" }, "*");
      }
      function notifyRendered() {
        window.parent.postMessage({ type: "pdf-rendered", page: currentPage, zoom: Math.round(currentScale() * 100), fitMode: fitMode || "custom" }, "*");
      }
      function applyPageHighlight(page) {
        highlightedPage = Math.max(1, Math.floor(Number(page) || 0));
        pages.querySelectorAll(".page").forEach((node) => {
          node.dataset.highlighted = node.dataset.page === String(highlightedPage) ? "true" : "false";
        });
      }
      function normalizeBbox(value) {
        if (!value) return null;
        let rect = value;
        if (typeof value === "string") {
          try {
            rect = JSON.parse(value);
          } catch {
            const parts = value.split(/[,\s]+/).map(Number).filter(Number.isFinite);
            if (parts.length >= 4) rect = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
          }
        }
        if (!rect || typeof rect !== "object") return null;
        const x = Number(rect.x ?? rect.left);
        const y = Number(rect.y ?? rect.top);
        const width = Number(rect.width ?? (Number(rect.right) - x));
        const height = Number(rect.height ?? (Number(rect.bottom) - y));
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
        return { x, y, width, height };
      }
      function bboxForHighlight(payload, unit) {
        return normalizeBbox(payload?.bbox) || normalizeBbox(unit?.bbox);
      }
      function createHighlightNode(pageNode, rect, pageViewport) {
        if (!pageNode || !rect || !pageViewport) return null;
        const pageWidth = pageViewport.width;
        const pageHeight = pageViewport.height;
        const normalized = rect.x >= 0 && rect.y >= 0 && rect.width <= 1.2 && rect.height <= 1.2 && rect.x <= 1.2 && rect.y <= 1.2;
        const left = normalized ? rect.x * pageWidth : rect.x;
        const top = normalized ? rect.y * pageHeight : rect.y;
        const width = normalized ? rect.width * pageWidth : rect.width;
        const height = normalized ? rect.height * pageHeight : rect.height;
        const node = document.createElement("div");
        node.className = "semantic-highlight";
        node.style.left = Math.max(0, left - 3) + "px";
        node.style.top = Math.max(0, top - 3) + "px";
        node.style.width = Math.max(8, width + 6) + "px";
        node.style.height = Math.max(8, height + 6) + "px";
        return node;
      }
      function clearSemanticHighlights() {
        if (highlightTimer) {
          window.clearTimeout(highlightTimer);
          highlightTimer = null;
        }
        pages.querySelectorAll(".semantic-highlight").forEach((node) => node.remove());
        pages.querySelectorAll(".text-hit-highlight").forEach((node) => node.classList.remove("text-hit-highlight"));
      }
      function matchingTextLayerSpans(pageNode, text) {
        const normalizedTarget = normalizeSemanticText(text).slice(0, 240);
        if (!pageNode || !normalizedTarget) return [];
        const spans = Array.from(pageNode.querySelectorAll(".textLayer span"));
        if (spans.length === 0) return [];
        const words = normalizedTarget.split(/\\s+/).filter((word) => word.length > 2).slice(0, 10);
        if (words.length === 0) return [];
        const matched = spans.filter((span) => {
          const spanText = normalizeSemanticText(span.textContent);
          return spanText && words.some((word) => spanText.includes(word));
        }).slice(0, 16);
        return matched;
      }
      function applyTextLayerHighlights(pageNode, text) {
        const matched = matchingTextLayerSpans(pageNode, text);
        if (matched.length === 0) return false;
        clearSemanticHighlights();
        matched.forEach((span) => span.classList.add("text-hit-highlight"));
        const first = matched[0];
        first?.scrollIntoView({ block: "center", inline: "nearest" });
        const page = Number(pageNode.dataset.page || 0);
        if (Number.isFinite(page) && page > 0) highlightedPage = page;
        return true;
      }
      function textRectForHighlight(pageNode, text) {
        const matched = matchingTextLayerSpans(pageNode, text);
        if (matched.length === 0) return null;
        const pageRect = pageNode.getBoundingClientRect();
        const rects = matched.map((span) => span.getBoundingClientRect()).filter((rect) => rect.width || rect.height);
        if (rects.length === 0) return null;
        const left = Math.min(...rects.map((rect) => rect.left)) - pageRect.left;
        const top = Math.min(...rects.map((rect) => rect.top)) - pageRect.top;
        const right = Math.max(...rects.map((rect) => rect.right)) - pageRect.left;
        const bottom = Math.max(...rects.map((rect) => rect.bottom)) - pageRect.top;
        return { x: left, y: top, width: right - left, height: bottom - top };
      }
      function applySemanticHighlight(payload, unit) {
        const page = Math.max(1, Math.floor(Number(unit?.page || payload?.page || 0)));
        if (!page) return false;
        const pageNode = pages.querySelector('.page[data-page="' + page + '"]');
        if (!pageNode) return false;
        if (applyTextLayerHighlights(pageNode, payload?.text || unit?.text || "")) return true;
        clearSemanticHighlights();
        const canvas = pageNode.querySelector("canvas");
        const pageViewport = canvas ? { width: canvas.clientWidth, height: canvas.clientHeight } : { width: pageNode.clientWidth, height: pageNode.clientHeight };
        let rect = bboxForHighlight(payload, unit);
        if (!rect) rect = textRectForHighlight(pageNode, payload?.text || unit?.text || "");
        const node = createHighlightNode(pageNode, rect, pageViewport);
        if (!node) return false;
        pageNode.appendChild(node);
        return true;
      }
      function applyTextFallbackHighlight(payload) {
        const text = payload?.text || "";
        if (!text) return false;
        for (const pageNode of Array.from(pages.querySelectorAll(".page"))) {
          if (applyTextLayerHighlights(pageNode, text)) return true;
          const rect = textRectForHighlight(pageNode, text);
          if (!rect) continue;
          clearSemanticHighlights();
          const canvas = pageNode.querySelector("canvas");
          const pageViewport = canvas ? { width: canvas.clientWidth, height: canvas.clientHeight } : { width: pageNode.clientWidth, height: pageNode.clientHeight };
          const node = createHighlightNode(pageNode, rect, pageViewport);
          if (!node) continue;
          pageNode.appendChild(node);
          pageNode.scrollIntoView({ block: "center" });
          const page = Number(pageNode.dataset.page || 0);
          if (Number.isFinite(page) && page > 0) highlightedPage = page;
          return true;
        }
        return false;
      }
      function normalizeSemanticText(value) {
        return String(value || "").replace(/\\s+/g, " ").trim().toLowerCase();
      }
      function semanticUnitForSelection(page, text) {
        const normalizedText = normalizeSemanticText(text);
        if (!page || !normalizedText) return null;
        const candidates = semanticUnits.filter((unit) => unit && Number(unit.page) === Number(page));
        if (candidates.length === 0) return null;
        let best = null;
        let bestScore = 0;
        for (const unit of candidates) {
          const unitText = normalizeSemanticText(unit.text);
          if (!unitText) continue;
          let score = 0;
          if (unitText.includes(normalizedText)) score = normalizedText.length / Math.max(unitText.length, 1) + 1;
          else if (normalizedText.includes(unitText.slice(0, Math.min(80, unitText.length)))) score = unitText.length / Math.max(normalizedText.length, 1);
          else {
            const selectedWords = new Set(normalizedText.split(/\\s+/).filter((word) => word.length > 2));
            const unitWords = new Set(unitText.split(/\\s+/).filter((word) => word.length > 2));
            let overlap = 0;
            selectedWords.forEach((word) => {
              if (unitWords.has(word)) overlap += 1;
            });
            score = overlap / Math.max(selectedWords.size, 1);
          }
          if (score > bestScore) {
            bestScore = score;
            best = unit;
          }
        }
        return bestScore >= 0.24 ? best : null;
      }
      function semanticUnitById(id) {
        if (!id) return null;
        return semanticUnits.find((unit) => unit && unit.id === id) || null;
      }
      function currentScale() {
        return customScale || steps[stepIndex];
      }
      function applyTheme(theme) {
        if (!theme || typeof theme !== "object") return;
        const root = document.documentElement;
        if (theme.mode === "dark" || theme.mode === "light") root.dataset.theme = theme.mode;
        const keys = ["background", "foreground", "card", "muted", "mutedForeground", "border", "primary"];
        for (const key of keys) {
          if (typeof theme[key] !== "string" || !theme[key].trim()) continue;
          const cssKey = key.replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
          root.style.setProperty("--app-" + cssKey, theme[key].trim());
        }
      }
      function stepIndexForZoom(zoom) {
        const target = Number(zoom) / 100;
        if (!Number.isFinite(target)) return stepIndex;
        let bestIndex = stepIndex;
        let bestDistance = Infinity;
        for (let index = 0; index < steps.length; index += 1) {
          const distance = Math.abs(steps[index] - target);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
          }
        }
        return bestIndex;
      }
      function fitViewportSize() {
        return {
          width: viewMode === "deck" ? pages.clientWidth : window.innerWidth,
          height: viewMode === "deck" ? pages.clientHeight : window.innerHeight,
        };
      }
      async function waitForStableFitViewport() {
        await new Promise((resolve) => {
          let settledTimer = 0;
          let timeoutTimer = 0;
          let observer = null;
          let finished = false;
          const finish = () => {
            if (finished) return;
            finished = true;
            if (settledTimer) window.clearTimeout(settledTimer);
            if (timeoutTimer) window.clearTimeout(timeoutTimer);
            observer?.disconnect();
            window.removeEventListener("resize", scheduleFinish);
            resolve();
          };
          const scheduleFinish = () => {
            const size = fitViewportSize();
            if (size.width < 240 || size.height < 180) return;
            if (settledTimer) window.clearTimeout(settledTimer);
            settledTimer = window.setTimeout(finish, 90);
          };
          if (typeof ResizeObserver !== "undefined") {
            observer = new ResizeObserver(scheduleFinish);
            observer.observe(viewMode === "deck" ? pages : document.documentElement);
          }
          window.addEventListener("resize", scheduleFinish);
          timeoutTimer = window.setTimeout(finish, 1000);
          scheduleFinish();
        });
      }
      async function scaleToFitWidth() {
        if (!pdfDoc) return { scale: currentScale(), ...fitViewportSize() };
        const page = await pdfDoc.getPage(viewMode === "deck" ? currentPage : 1);
        const viewport = page.getViewport({ scale: 1 });
        const size = fitViewportSize();
        const availableWidth = Math.max(240, size.width - 32);
        return {
          scale: Math.max(0.25, Math.min(4, availableWidth / viewport.width)),
          ...size,
        };
      }
      async function scaleToFitPage() {
        if (!pdfDoc) return { scale: currentScale(), ...fitViewportSize() };
        const page = await pdfDoc.getPage(viewMode === "deck" ? currentPage : 1);
        const viewport = page.getViewport({ scale: 1 });
        const size = fitViewportSize();
        const availableWidth = Math.max(240, size.width - 32);
        const availableHeight = Math.max(180, size.height - 32);
        return {
          scale: Math.max(0.25, Math.min(4, availableWidth / viewport.width, availableHeight / viewport.height)),
          ...size,
        };
      }
      async function applyFitMode(nextFitMode, keepScroll = false) {
        fitMode = nextFitMode;
        document.body.dataset.fitMode = nextFitMode;
        pendingScrollTop = keepScroll ? pendingScrollTop : viewMode === "deck" ? 0 : window.scrollY || document.documentElement.scrollTop || 0;
        const calculation = nextFitMode === "page" ? await scaleToFitPage() : await scaleToFitWidth();
        customScale = calculation.scale;
        stepIndex = stepIndexForZoom(customScale * 100);
        lastFitWidth = calculation.width;
        lastFitHeight = calculation.height;
        await renderAll();
        const currentSize = fitViewportSize();
        if (Math.abs(currentSize.width - lastFitWidth) >= 2 || Math.abs(currentSize.height - lastFitHeight) >= 2) {
          scheduleFitResize();
        }
      }
      async function setFitWidth() {
        await applyFitMode("width");
      }
      async function setFitPage() {
        await applyFitMode("page");
      }
      function clearFitMode() {
        fitMode = null;
        delete document.body.dataset.fitMode;
      }
      function scheduleFitResize() {
        if (!initialFitComplete || !fitMode || !pdfDoc) return;
        if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
        resizeFrame = window.requestAnimationFrame(() => {
          resizeFrame = 0;
          if (!fitMode || !pdfDoc) return;
          const { width: nextWidth, height: nextHeight } = fitViewportSize();
          if (Math.abs(nextWidth - lastFitWidth) < 2 && Math.abs(nextHeight - lastFitHeight) < 2) return;
          void applyFitMode(fitMode, true);
        });
      }
      function setCustomZoomFromPercent(zoom) {
        pendingScrollTop = viewMode === "deck" ? 0 : window.scrollY || document.documentElement.scrollTop || 0;
        clearFitMode();
        const target = Number(zoom) / 100;
        customScale = Number.isFinite(target) ? Math.max(0.25, Math.min(4, target)) : null;
        stepIndex = stepIndexForZoom(zoom);
      }
      async function renderTextLayer(page, pageNode, scale) {
        if (!pdfjsLib?.TextLayer) return;
        try {
          const textContent = await page.getTextContent();
          if (!textContent?.items?.length) return;
          const textLayer = document.createElement("div");
          textLayer.className = "textLayer";
          textLayer.style.setProperty("--scale-factor", String(scale));
          pageNode.appendChild(textLayer);
          const textViewport = page.getViewport({ scale });
          await new pdfjsLib.TextLayer({
            textContentSource: textContent,
            container: textLayer,
            viewport: textViewport,
          }).render();
        } catch (error) {
          console.warn("[pdf-preview] text layer failed", error);
        }
      }
      function disconnectDocumentPageObserver() {
        documentPageObserver?.disconnect();
        documentPageObserver = null;
      }
      async function buildDocumentPagePlaceholders(generation) {
        if (!pdfDoc || generation !== renderGeneration) return false;
        const scale = currentScale();
        const nextPages = [];
        for (let index = 1; index <= pdfDoc.numPages; index += 1) {
          const page = await pdfDoc.getPage(index);
          if (generation !== renderGeneration) return false;
          const viewport = page.getViewport({ scale });
          const pageNode = document.createElement("div");
          pageNode.className = "page";
          pageNode.dataset.page = String(index);
          pageNode.dataset.rendered = "false";
          pageNode.style.width = viewport.width + "px";
          pageNode.style.height = viewport.height + "px";
          if (highlightedPage === index) pageNode.dataset.highlighted = "true";
          const wrap = document.createElement("section");
          wrap.className = "page-wrap";
          wrap.dataset.page = String(index);
          wrap.style.setProperty("--page-width", viewport.width + "px");
          wrap.appendChild(pageNode);
          nextPages.push(wrap);
        }
        if (generation !== renderGeneration) return false;
        const info = document.createElement("div");
        info.className = "page-info";
        info.textContent = "共 " + pdfDoc.numPages + " 页";
        pages.replaceChildren(...nextPages, info);
        return true;
      }
      async function renderDocumentPage(pageNumber, generation = renderGeneration) {
        if (!pdfDoc || generation !== renderGeneration) return;
        const page = Math.max(1, Math.min(pdfDoc.numPages, Math.floor(Number(pageNumber) || 1)));
        const key = generation + ":" + page;
        const existingPromise = documentRenderPromises.get(key);
        if (existingPromise) return existingPromise;
        const pageNode = pages.querySelector('.page[data-page="' + page + '"]');
        if (!pageNode || pageNode.dataset.rendered === "true") return;

        const renderPromise = (async () => {
          const pdfPage = await pdfDoc.getPage(page);
          if (generation !== renderGeneration || !pageNode.isConnected) return;
          const dpr = window.devicePixelRatio || 1;
          const scale = currentScale();
          const viewport = pdfPage.getViewport({ scale: scale * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = (viewport.width / dpr) + "px";
          canvas.style.height = (viewport.height / dpr) + "px";
          await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          const renderedNode = document.createElement("div");
          renderedNode.className = "page";
          renderedNode.dataset.page = String(page);
          renderedNode.dataset.rendered = "true";
          renderedNode.style.width = (viewport.width / dpr) + "px";
          renderedNode.style.height = (viewport.height / dpr) + "px";
          renderedNode.appendChild(canvas);
          await renderTextLayer(pdfPage, renderedNode, scale);
          if (generation !== renderGeneration || !pageNode.isConnected) return;
          if (highlightedPage === page) renderedNode.dataset.highlighted = "true";
          pageNode.replaceWith(renderedNode);
          if (pendingHighlight) {
            const unit = typeof pendingHighlight.semanticUnitId === "string" ? semanticUnitById(pendingHighlight.semanticUnitId) : null;
            const targetPage = Math.floor(Number(unit?.page || pendingHighlight.page || 0));
            if (targetPage === page && !applySemanticHighlight(pendingHighlight, unit)) applyPageHighlight(page);
          }
        })().finally(() => {
          documentRenderPromises.delete(key);
        });
        documentRenderPromises.set(key, renderPromise);
        return renderPromise;
      }
      function observeDocumentPages(generation) {
        disconnectDocumentPageObserver();
        const wraps = Array.from(pages.querySelectorAll(".page-wrap"));
        if (typeof IntersectionObserver === "undefined") {
          wraps.forEach((wrap) => void renderDocumentPage(Number(wrap.dataset.page || 1), generation));
          return;
        }
        documentPageObserver = new IntersectionObserver((entries) => {
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            void renderDocumentPage(Number(entry.target.dataset.page || 1), generation);
          });
        }, { root: null, rootMargin: "1200px 0px", threshold: 0.01 });
        wraps.forEach((wrap) => documentPageObserver.observe(wrap));
      }
      function notifySelection() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
          window.parent.postMessage({ type: "pdf-selection-cleared" }, "*");
          return;
        }
        const text = selection.toString().replace(/\\u00a0/g, " ").trim();
        if (!text) {
          window.parent.postMessage({ type: "pdf-selection-cleared" }, "*");
          return;
        }
        const range = selection.getRangeAt(0);
        const pageNode = range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer.closest(".page")
          : range.commonAncestorContainer.parentElement?.closest(".page");
        if (!pageNode) {
          window.parent.postMessage({ type: "pdf-selection-cleared" }, "*");
          return;
        }
        const rect = range.getBoundingClientRect();
        const pageRect = pageNode.getBoundingClientRect();
        const pageNumber = Number(pageNode.dataset.page || 0);
        const semanticUnit = semanticUnitForSelection(pageNumber, text);
        if (!rect.width && !rect.height) {
          window.parent.postMessage({ type: "pdf-selection-cleared" }, "*");
          return;
        }
        window.parent.postMessage({
          type: "pdf-selection",
          text,
          page: Number(pageNode.dataset.page || 0),
          rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
          pageRect: {
            left: pageRect.left,
            top: pageRect.top,
            width: pageRect.width,
            height: pageRect.height,
          },
          semanticUnitId: semanticUnit?.id,
          sourceLabel: semanticUnit?.sourceLabel,
        }, "*");
      }
      async function renderAll() {
        if (!pdfDoc) return;
        const generation = ++renderGeneration;
        if (viewMode === "deck") {
          await renderDeckPage(generation);
          return;
        }
        disconnectDocumentPageObserver();
        documentRenderPromises.clear();
        if (!await buildDocumentPagePlaceholders(generation)) return;
        observeDocumentPages(generation);
        await renderDocumentPage(1, generation);
        if (generation !== renderGeneration) return;
        if (pendingHighlight) {
          const unit = typeof pendingHighlight.semanticUnitId === "string" ? semanticUnitById(pendingHighlight.semanticUnitId) : null;
          const targetPage = Math.floor(Number(unit?.page || pendingHighlight.page || 0));
          if (targetPage > 0) await renderDocumentPage(targetPage, generation);
          if (!applySemanticHighlight(pendingHighlight, unit)) applyTextFallbackHighlight(pendingHighlight);
        }
        notifyZoom();
        notifyRendered();
        if (pendingScrollTop > 0) {
          window.scrollTo({ top: pendingScrollTop });
          pendingScrollTop = 0;
        }
      }
      function updateThumbSelection() {
        if (!thumbs) return;
        thumbs.querySelectorAll(".thumb-button").forEach((button) => {
          button.dataset.selected = button.dataset.page === String(currentPage) ? "true" : "false";
        });
      }
      async function renderDeckThumbnails() {
        if (!pdfDoc || !thumbs) return;
        thumbs.innerHTML = "";
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        for (let index = 1; index <= pdfDoc.numPages; index += 1) {
          const page = await pdfDoc.getPage(index);
          const baseViewport = page.getViewport({ scale: 1 });
          const cssWidth = Math.max(78, Math.min(96, (thumbs.clientWidth || 112) - 18));
          const scale = cssWidth / baseViewport.width;
          const viewport = page.getViewport({ scale: scale * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = cssWidth + "px";
          canvas.style.height = (viewport.height / dpr) + "px";
          await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
          const button = document.createElement("button");
          button.type = "button";
          button.className = "thumb-button";
          button.dataset.page = String(index);
          button.dataset.selected = index === currentPage ? "true" : "false";
          button.title = "第 " + index + " 页";
          button.addEventListener("click", () => {
            currentPage = index;
            if (fitMode) {
              void applyFitMode(fitMode);
            } else {
              void renderDeckPage();
            }
          });
          const label = document.createElement("span");
          label.className = "thumb-index";
          label.textContent = String(index);
          const wrap = document.createElement("span");
          wrap.className = "thumb-canvas-wrap";
          wrap.style.width = cssWidth + "px";
          wrap.appendChild(canvas);
          button.appendChild(label);
          button.appendChild(wrap);
          thumbs.appendChild(button);
        }
      }
      async function renderDeckPage(generation = ++renderGeneration) {
        if (!pdfDoc) return;
        currentPage = Math.max(1, Math.min(pdfDoc.numPages, currentPage));
        const dpr = window.devicePixelRatio || 1;
        const scale = currentScale();
        const page = await pdfDoc.getPage(currentPage);
        const viewport = page.getViewport({ scale: scale * dpr });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = (viewport.width / dpr) + "px";
        canvas.style.height = (viewport.height / dpr) + "px";
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
        const pageNode = document.createElement("div");
        pageNode.className = "page";
        pageNode.dataset.page = String(currentPage);
        pageNode.style.width = (viewport.width / dpr) + "px";
        pageNode.style.height = (viewport.height / dpr) + "px";
        pageNode.appendChild(canvas);
        await renderTextLayer(page, pageNode, scale);
        if (highlightedPage === currentPage) pageNode.dataset.highlighted = "true";
        const wrap = document.createElement("section");
        wrap.className = "page-wrap";
        wrap.dataset.page = String(currentPage);
        const cssWidth = viewport.width / dpr;
        wrap.style.setProperty("--page-width", cssWidth + "px");
        wrap.appendChild(pageNode);
        if (generation !== renderGeneration) return;
        pages.replaceChildren(wrap);
        if (pendingHighlight) {
          const unit = typeof pendingHighlight.semanticUnitId === "string" ? semanticUnitById(pendingHighlight.semanticUnitId) : null;
          if (!applySemanticHighlight(pendingHighlight, unit)) applyTextFallbackHighlight(pendingHighlight);
        }
        pages.scrollTo({ top: 0, left: 0 });
        updateThumbSelection();
        updateSpeakerNotes();
        notifyZoom();
        notifyPage();
        notifyRendered();
      }
      let scrollTimer = null;
      window.addEventListener("scroll", () => {
        if (viewMode === "deck") return;
        if (scrollTimer) window.clearTimeout(scrollTimer);
        scrollTimer = window.setTimeout(notifyScroll, 80);
      }, { passive: true });
      window.addEventListener("message", (event) => {
        if (event.data?.type === "pdf-theme") {
          applyTheme(event.data.theme);
          return;
        }
        if (event.data?.type === "pdf-clear-selection") {
          window.getSelection()?.removeAllRanges();
          window.parent.postMessage({ type: "pdf-selection-cleared" }, "*");
          return;
        }
        if (event.data?.type === "pdf-scroll" && typeof event.data.scrollTop === "number") {
          pendingScrollTop = Math.max(0, event.data.scrollTop);
          window.scrollTo({ top: pendingScrollTop });
          return;
        }
        if (event.data?.type === "pdf-page" && typeof event.data.page === "number") {
          const page = Math.max(1, Math.floor(event.data.page));
          if (viewMode === "deck") {
            currentPage = page;
            if (fitMode) {
              void applyFitMode(fitMode);
            } else {
              void renderDeckPage();
            }
            return;
          }
          const target = pages.querySelector('[data-page="' + page + '"]');
          if (target) {
            target.scrollIntoView({ block: "start" });
            void renderDocumentPage(page);
            notifyScroll();
          }
          return;
        }
        if (event.data?.type === "pdf-highlight-page" && (
          typeof event.data.page === "number"
          || typeof event.data.semanticUnitId === "string"
          || typeof event.data.bbox === "string"
          || typeof event.data.text === "string"
        )) {
          pendingHighlight = event.data;
          const unit = typeof event.data.semanticUnitId === "string" ? semanticUnitById(event.data.semanticUnitId) : null;
          const rawPage = Number(unit?.page || event.data.page);
          if (!Number.isFinite(rawPage) || rawPage <= 0) {
            applyTextFallbackHighlight(event.data);
            return;
          }
          const page = Math.max(1, Math.floor(rawPage));
          highlightedPage = page;
          if (viewMode === "deck") {
            currentPage = page;
            void (fitMode ? applyFitMode(fitMode) : renderDeckPage()).then(() => {
              if (!applySemanticHighlight(event.data, unit)) applyPageHighlight(page);
            });
            return;
          }
          const target = pages.querySelector('[data-page="' + page + '"]');
          if (target) {
            target.scrollIntoView({ block: "center" });
            void renderDocumentPage(page).then(() => {
              if (!applySemanticHighlight(event.data, unit)) applyPageHighlight(page);
            });
            notifyScroll();
          }
          return;
        }
        if (event.data?.type !== "pdf-zoom") return;
        if (typeof event.data.zoom === "number") {
          setCustomZoomFromPercent(event.data.zoom);
          void renderAll();
          return;
        }
        if (event.data.direction === "fit-page") {
          void setFitPage();
          return;
        }
        if (event.data.direction === "fit-width") {
          void setFitWidth();
          return;
        }
        if (event.data.direction === "reset") {
          if (viewMode === "deck") {
            void setFitPage();
          } else {
            clearFitMode();
            customScale = null;
            stepIndex = defaultStepIndex;
            void renderAll();
          }
          return;
        }
        if (event.data.direction === "out" && stepIndex > 0) {
          clearFitMode();
          customScale = null;
          stepIndex -= 1;
          void renderAll();
          return;
        }
        if (event.data.direction === "in" && stepIndex < steps.length - 1) {
          clearFitMode();
          customScale = null;
          stepIndex += 1;
          void renderAll();
        }
      });
      window.addEventListener("resize", scheduleFitResize);
      document.addEventListener("pointerdown", (event) => {
        if (event.target instanceof Element && event.target.closest(".textLayer")) return;
        window.parent.postMessage({ type: "pdf-selection-cleared" }, "*");
      });
      document.addEventListener("mouseup", () => window.setTimeout(notifySelection, 0));
      document.addEventListener("keyup", () => window.setTimeout(notifySelection, 0));
      document.addEventListener("selectionchange", () => window.requestAnimationFrame(notifySelection));
      if (viewMode === "deck" && typeof ResizeObserver !== "undefined") {
        const resizeObserver = new ResizeObserver(scheduleFitResize);
        const viewer = document.getElementById("viewer");
        if (viewer) resizeObserver.observe(viewer);
      }
      try {
        pdfjsLib = await import(${JSON.stringify(input.pdfScriptUrl)});
        pdfjsLib.GlobalWorkerOptions.workerSrc = ${JSON.stringify(input.pdfWorkerUrl)};
        pdfDoc = await pdfjsLib.getDocument({
          url: ${JSON.stringify(input.fileUrl)},
          standardFontDataUrl: ${JSON.stringify(input.standardFontDataUrl)},
        }).promise;
        const thumbnailRender = viewMode === "deck" ? renderDeckThumbnails() : Promise.resolve();
        await waitForStableFitViewport();
        if (fitMode === "page") {
          await setFitPage();
        } else {
          await setFitWidth();
        }
        initialFitComplete = true;
        scheduleFitResize();
        if (viewMode === "deck") {
          updateSpeakerNotes();
        }
        notifyLoaded();
        await thumbnailRender;
        updateThumbSelection();
      } catch (error) {
        pages.textContent = "";
        const message = document.createElement("div");
        message.className = "error";
        message.textContent = "PDF 加载失败：" + (error?.message || String(error));
        pages.appendChild(message);
        window.parent.postMessage({ type: "pdf-error", message: message.textContent }, "*");
      }
    </script>
  </body>
</html>`;
}

const SPREADSHEET_MAX_SHEETS = 8;
const SPREADSHEET_MAX_ROWS = 120;
const SPREADSHEET_MAX_COLUMNS = 40;
async function previewSpreadsheetPreview(sourcePath?: string): Promise<{ summary: string; content: string; html?: string; spreadsheet?: SpreadsheetPreview }> {
  if (!sourcePath || !existsSync(sourcePath)) {
    return { summary: "表格源文件不可用于预览。", content: "" };
  }
  const extension = extname(sourcePath).toLowerCase();
  if (extension === ".csv" || extension === ".tsv") {
    return previewDelimitedSpreadsheet(sourcePath, extension === ".tsv" ? "\t" : ",");
  }
  if (extension === ".xls") {
    return { summary: "旧版 .xls 文件需要转换为 .xlsx 后才能完整预览。", content: "" };
  }
  try {
    const stats = statSync(sourcePath);
    const artifact = await importXlsxArtifact({
      sourcePath,
      byteCount: stats.size,
      maxSheets: SPREADSHEET_MAX_SHEETS,
      maxRowsPerSheet: SPREADSHEET_MAX_ROWS,
      maxColumns: SPREADSHEET_MAX_COLUMNS,
    });
    const workbook = artifact.workbook;
    const sheets: SpreadsheetPreviewSheet[] = workbook?.sheets.map(spreadsheetPreviewSheetFromArtifact) || [];
    if (sheets.length === 0) throw new Error("Invalid XLSX: no worksheet data resolved");
    const content = artifact.semanticUnits.length > 0
      ? artifact.semanticUnits.map((unit) => unit.markdown || unit.text).join("\n\n")
      : sheets.map((sheet) => [
        `工作表：${sheet.name}`,
        ...sheet.rows.map((row) => row.cells.map((cell) => cell == null ? "" : String(cell)).join("\t")),
      ].join("\n")).join("\n\n");
    const summary = [
      `正在预览 ${sheets.length} / ${workbook?.sheetCount || sheets.length} 个工作表。`,
      artifact.metadata.coverageStatus === "partial" || workbook?.truncated ? "已截断或跳过部分内容。" : "",
      "当前以工作簿表格视图预览，可切换工作表、搜索和引用选区。",
    ].filter(Boolean).join(" ");
    const spreadsheet = spreadsheetPreviewFromArtifact(artifact);
    return {
      summary,
      content: truncatePreviewText(content, 24000),
      html: renderSpreadsheetPreviewHtml(basename(sourcePath), sheets),
      spreadsheet,
    };
  } catch (error) {
    return {
      summary: `表格预览失败：${errorMessage(error)}`,
      content: "",
    };
  }
}

function spreadsheetPreviewSheetFromArtifact(sheet: BrevynWorksheetModel): SpreadsheetPreviewSheet {
  const rows = sheet.rows.map((row): SpreadsheetPreviewRow => {
    const values: string[] = [];
    for (const cell of row.cells) values[cell.column - 1] = spreadsheetCellDisplayText(cell);
    while (values.length > 0 && !values[values.length - 1]) values.pop();
    const cellObjects: SpreadsheetPreviewCell[] = row.cells.map((cell) => ({
      ref: cell.ref,
      row: cell.row,
      column: cell.column,
      text: spreadsheetCellDisplayText(cell),
      formula: cell.formula,
      style: cell.style,
      hyperlink: cell.hyperlink,
      commentIds: cell.commentIds,
    }));
    return {
      number: row.number,
      heightPx: row.heightPx,
      hidden: row.hidden,
      cells: values,
      cellObjects,
    };
  });
  return {
    index: sheet.index,
    name: sheet.name,
    totalRows: sheet.totalRows,
    totalColumns: sheet.totalColumns,
    renderedRows: sheet.renderedRows,
    renderedColumns: sheet.renderedColumns,
    truncatedRows: sheet.truncatedRows,
    truncatedColumns: sheet.truncatedColumns,
    columns: sheet.columns.map((column) => ({
      index: column.index,
      name: column.name,
      widthPx: column.widthPx,
      hidden: column.hidden,
    })),
    mergedCells: sheet.mergedCells.map((merge) => ({
      ref: merge.ref,
      startRow: merge.startRow,
      startColumn: merge.startColumn,
      endRow: merge.endRow,
      endColumn: merge.endColumn,
    })),
    freezePanes: sheet.freezePanes,
    rows,
    charts: sheet.charts.map((chart) => ({
      id: chart.id,
      index: chart.index,
      name: chart.name,
      title: chart.title,
      type: chart.type,
      subtype: chart.subtype,
      anchor: chart.anchor,
      sourceRefs: chart.sourceRefs,
      style: chart.style,
      series: chart.series.map((series) => ({
        name: series.name,
        categoryRef: series.categoryRef,
        valueRef: series.valueRef,
        xValueRef: series.xValueRef,
        yValueRef: series.yValueRef,
        bubbleSizeRef: series.bubbleSizeRef,
        categories: series.categories,
        values: series.values,
        xValues: series.xValues,
        yValues: series.yValues,
        bubbleSizes: series.bubbleSizes,
        rawValues: series.rawValues,
        color: series.color,
        pointColors: series.pointColors,
        chartType: series.chartType,
        axisGroup: series.axisGroup,
        marker: series.marker,
        smooth: series.smooth,
      })),
      render: officeRenderSurfacePreviewFromArtifact(chart.render),
    })),
    shapes: (sheet.shapes || []).map((shape) => ({
      id: shape.id,
      index: shape.index,
      name: shape.name,
      text: shape.text,
      shapeType: shape.shapeType,
      fillColor: shape.fillColor,
      lineColor: shape.lineColor,
      anchor: shape.anchor,
    })),
    hyperlinks: sheet.hyperlinks,
    comments: sheet.comments,
    tables: sheet.tables,
    namedRanges: sheet.namedRanges,
    render: officeRenderSurfacePreviewFromArtifact(sheet.render),
  };
}

function officeRenderSurfacePreviewFromArtifact(surface?: BrevynOfficeRenderSurface): OfficeRenderSurfacePreview | undefined {
  if (!surface) return undefined;
  return {
    id: surface.id,
    kind: surface.kind,
    role: surface.role,
    width: surface.width,
    height: surface.height,
    mediaType: surface.mediaType,
    data: surface.data,
    path: surface.path,
    engine: surface.engine,
    warnings: surface.warnings,
    targets: surface.targets?.map((target) => ({
      id: target.id,
      type: target.type,
      text: target.text,
      bbox: target.bbox,
      location: target.location,
      metadata: target.metadata,
    })),
  };
}

function spreadsheetCellDisplayText(cell: BrevynWorksheetCell): string {
  const text = cell.text.trim();
  if (text && !text.startsWith("=")) return cell.text;
  const rawValue = cell.rawValue?.trim();
  if (rawValue && !rawValue.startsWith("=")) return rawValue;
  return "";
}

function spreadsheetPreviewFromArtifact(artifact: BrevynOfficeArtifact): SpreadsheetPreview {
  const workbook = artifact.workbook;
  const sheets = workbook?.sheets.map(spreadsheetPreviewSheetFromArtifact) || [];
  return {
    renderEngine: "brevyn-workbook-v1",
    sheetCount: workbook?.sheetCount || sheets.length,
    renderedSheetCount: workbook?.renderedSheetCount || sheets.length,
    maxRows: workbook?.maxRows || SPREADSHEET_MAX_ROWS,
    maxColumns: workbook?.maxColumns || SPREADSHEET_MAX_COLUMNS,
    truncated: Boolean(workbook?.truncated),
    sheets,
  };
}

function previewDelimitedSpreadsheet(sourcePath: string, delimiter: "," | "\t"): { summary: string; content: string; html?: string; spreadsheet?: SpreadsheetPreview } {
  try {
    const stats = statSync(sourcePath);
    const artifact = importDelimitedArtifact({
      sourcePath,
      byteCount: stats.size,
      delimiter,
      maxRows: SPREADSHEET_MAX_ROWS,
      maxColumns: SPREADSHEET_MAX_COLUMNS,
      maxBytes: MAX_TEXT_PREVIEW_BYTES,
    });
    const workbook = artifact.workbook;
    const sheets = workbook?.sheets.map(spreadsheetPreviewSheetFromArtifact) || [];
    const spreadsheet = spreadsheetPreviewFromArtifact(artifact);
    const content = artifact.semanticUnits.length > 0
      ? artifact.semanticUnits.map((unit) => unit.markdown || unit.text).join("\n\n")
      : sheets.map((sheet) => sheet.rows.map((row) => row.cells.join("\t")).join("\n")).join("\n\n");
    return {
      summary: `正在预览 1 / 1 个工作表。${workbook?.truncated ? " 已截断部分行列。" : ""} 当前以工作簿表格视图预览，可搜索和引用选区。`,
      content: truncatePreviewText(content, 24000),
      html: renderSpreadsheetPreviewHtml(basename(sourcePath), sheets),
      spreadsheet,
    };
  } catch (error) {
    return {
      summary: `表格预览失败：${errorMessage(error)}`,
      content: "",
    };
  }
}

function renderSpreadsheetPreviewHtml(
  title: string,
  sheets: SpreadsheetPreviewSheet[],
): string {
  const sheetHtml = sheets.map((sheet) => {
    const columnCount = Math.max(sheet.totalColumns, ...sheet.rows.map((row) => row.cells.length), 1);
    const visibleColumnCount = Math.min(columnCount, SPREADSHEET_MAX_COLUMNS);
    const headerCells = Array.from({ length: visibleColumnCount }, (_, index) => `<th>${spreadsheetColumnName(index)}</th>`).join("");
    const rows = sheet.rows.map((row) => {
      const cells = Array.from({ length: visibleColumnCount }, (_, columnIndex) => {
        const value = row.cells[columnIndex];
        return `<td>${escapePreviewHtml(value == null ? "" : String(value))}</td>`;
      }).join("");
      return `<tr><th class="office-row-heading">${row.number}</th>${cells}</tr>`;
    }).join("");
    const table = rows
      ? `<div class="office-table-wrap"><table><thead><tr><th></th>${headerCells}</tr></thead><tbody>${rows}</tbody></table></div>`
      : `<div class="office-empty">这个工作表没有可预览的数据</div>`;
    const notice = sheet.truncatedRows || sheet.truncatedColumns ? `<div class="office-preview-notice">仅显示前 ${SPREADSHEET_MAX_ROWS} 行 × ${SPREADSHEET_MAX_COLUMNS} 列</div>` : "";
    return `<section class="office-sheet"><h3>${escapePreviewHtml(sheet.name)}</h3><div class="office-sheet-meta">${sheet.totalRows} 行 × ${sheet.totalColumns} 列</div>${notice}${table}</section>`;
  }).join("");
  return `<div class="office-preview office-preview-spreadsheet"><div class="office-preview-title">${escapePreviewHtml(title)}</div>${sheetHtml || `<div class="office-empty">这个表格没有可预览的数据</div>`}</div>`;
}

function spreadsheetColumnName(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function spreadsheetMimeType(sourcePath?: string): string {
  const extension = extname(sourcePath || "").toLowerCase();
  if (extension === ".csv") return "text/csv";
  if (extension === ".tsv") return "text/tab-separated-values";
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

function imageMimeType(sourcePath?: string): string {
  const extension = extname(sourcePath || "").toLowerCase();
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".bmp") return "image/bmp";
  return "image/png";
}

function parsePreviewXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

function getPreviewElementsByLocalName(root: Node, localName: string): Element[] {
  const result: Element[] = [];
  function walk(node: Node): void {
    const children = node.childNodes;
    if (!children) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children.item(index);
      if (child.nodeType === 1) {
        const element = child as Element;
        if (element.localName === localName || element.nodeName === localName) result.push(element);
      }
      walk(child);
    }
  }
  walk(root);
  return result;
}

function readZipText(zip: AdmZip, path: string): string | null {
  const entry = zip.getEntry(path);
  return entry ? entry.getData().toString("utf8") : null;
}

function normalizeZipTarget(baseDir: string, target: string): string {
  const normalizedTarget = target.replace(/\\/g, "/");
  if (normalizedTarget.startsWith("/")) return normalizedTarget.slice(1);
  return pathPosix.normalize(pathPosix.join(baseDir, normalizedTarget));
}

function parsePreviewRelationships(zip: AdmZip, relsPath: string, baseDir: string): Map<string, string> {
  const relsXml = readZipText(zip, relsPath);
  const rels = new Map<string, string>();
  if (!relsXml) return rels;
  const relsDoc = parsePreviewXml(relsXml);
  for (const rel of getPreviewElementsByLocalName(relsDoc, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) continue;
    rels.set(id, normalizeZipTarget(baseDir, target));
  }
  return rels;
}

function getPptxSlidePaths(zip: AdmZip): string[] {
  const presentationXml = readZipText(zip, "ppt/presentation.xml");
  const relationships = parsePreviewRelationships(zip, "ppt/_rels/presentation.xml.rels", "ppt");
  if (presentationXml) {
    const doc = parsePreviewXml(presentationXml);
    const slidePaths = getPreviewElementsByLocalName(doc, "sldId")
      .map((slide) => slide.getAttribute("r:id") || slide.getAttribute("id"))
      .map((relationshipId) => relationshipId ? relationships.get(relationshipId) : undefined)
      .filter((path): path is string => Boolean(path));
    if (slidePaths.length > 0) return slidePaths;
  }

  return zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((entryName) => /^ppt\/slides\/slide\d+\.xml$/.test(entryName))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)?.[1] || 0) - Number(b.match(/slide(\d+)\.xml$/)?.[1] || 0));
}

function getPptxSlideText(zip: AdmZip, slidePath: string): string[] {
  const slideXml = readZipText(zip, slidePath);
  if (!slideXml) return [];
  const doc = parsePreviewXml(slideXml);
  return getPreviewElementsByLocalName(doc, "p")
    .map((paragraph) => getPreviewElementsByLocalName(paragraph, "t").map((node) => node.textContent || "").join("").trim())
    .filter(Boolean);
}

function extractPptxSpeakerNotes(sourcePath?: string): Record<number, string> {
  if (!sourcePath || !existsSync(sourcePath) || extname(sourcePath).toLowerCase() !== ".pptx") return {};
  try {
    const zip = new AdmZip(sourcePath);
    const slidePaths = getPptxSlidePaths(zip);
    const notes: Record<number, string> = {};
    slidePaths.forEach((slidePath, index) => {
      const slideNumber = Number(slidePath.match(/slide(\d+)\.xml$/)?.[1] || 0);
      if (!slideNumber) return;
      const relationships = parsePreviewRelationships(zip, `ppt/slides/_rels/slide${slideNumber}.xml.rels`, "ppt/slides");
      const notePath = Array.from(relationships.values()).find((target) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/u.test(target));
      if (!notePath) return;
      const noteText = getPptxSlideText(zip, notePath).join("\n");
      if (noteText.trim()) notes[index + 1] = normalizePreviewText(noteText);
    });
    return notes;
  } catch (error) {
    console.warn("[pptx-preview] Speaker notes extraction failed", { sourcePath, error: errorMessage(error) });
    return {};
  }
}

function normalizePreviewText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function escapePreviewHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function latestIndexingJobsByScope(jobs: IndexingJob[]): IndexingJob[] {
  const latest = new Map<string, IndexingJob>();
  for (const job of jobs) {
    const key = job.sectionId || `course:${job.courseId}:all`;
    const current = latest.get(key);
    if (!current || Date.parse(job.updatedAt) > Date.parse(current.updatedAt)) {
      latest.set(key, job);
    }
  }
  return Array.from(latest.values()).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function embeddingProviderSnapshot(provider: ModelProviderConfig): ModelProviderConfig {
  return {
    id: provider.id,
    purpose: provider.purpose,
    providerKind: provider.providerKind,
    adapterKind: provider.adapterKind,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKeyMasked: provider.apiKeyMasked,
    apiKeySecretRef: provider.apiKeySecretRef,
    authMode: provider.authMode,
    models: provider.models.filter((model) => model.id === provider.selectedModel),
    selectedModel: provider.selectedModel,
    enabled: provider.enabled,
    autoCompactThresholdPercent: provider.autoCompactThresholdPercent,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

function embeddingJobMatchesProvider(job: IndexingJob, provider?: ModelProviderConfig): provider is ModelProviderConfig {
  if (!provider?.selectedModel) return false;
  return job.embeddingProviderFingerprint === embeddingProviderFingerprint(provider);
}

function uniqueFilesById(files: WorkspaceFileNode[]): WorkspaceFileNode[] {
  return Array.from(new Map(files.map((file) => [file.id, file])).values());
}

function completedIndexingCoversCurrentSource(file: WorkspaceFileNode, completedAt: string): boolean {
  const completedAtMs = Date.parse(completedAt);
  if (!Number.isFinite(completedAtMs)) return false;
  let sourceUpdatedAtMs = Date.parse(file.updatedAt);
  if (file.sourcePath) {
    try {
      sourceUpdatedAtMs = statSync(file.sourcePath).mtimeMs;
    } catch {
      return false;
    }
  }
  return Number.isFinite(sourceUpdatedAtMs) && sourceUpdatedAtMs <= completedAtMs;
}

function sectionIdForFile(file: WorkspaceFileNode): string | undefined {
  if (file.sectionKind === "course_shared") return `${file.courseId}:shared`;
  if (file.sectionKind === "lecture") return `${file.courseId}:lecture`;
  if (file.sectionKind === "task" && file.taskId) return `${file.courseId}:task-${file.taskId}`;
  return undefined;
}

function parsedDocumentDirForSource(sourcePath: string, fileId: string): string {
  const sourceDir = dirname(sourcePath);
  const extension = extname(sourcePath);
  const stem = basename(sourcePath, extension) || basename(sourcePath) || "document";
  const shortId = fileId.replace(/^file-/, "").slice(0, 10) || "file";
  return join(sourceDir, PARSED_DOCUMENTS_FOLDER, sanitizeFsSegment(`${stem}-${shortId}`));
}

function previewDerivedDocumentPaths(sourcePath: string | undefined, fileId: string): { artifactPath?: string; semanticUnitsPath?: string; metadata?: Record<string, string | number | boolean> } {
  if (!sourcePath || !fileId.startsWith("file-") || fileId.includes(":")) return {};
  const parsedDir = parsedDocumentDirForSource(sourcePath, fileId);
  const artifactPath = join(parsedDir, "artifact.json");
  const semanticUnitsPath = join(parsedDir, "semantic-units.jsonl");
  const metadataPath = join(parsedDir, "metadata.json");
  const metadata: Record<string, string | number | boolean> = {};
  if (existsSync(metadataPath)) {
    try {
      const parsed = JSON.parse(readFileSync(metadataPath, "utf8")) as { artifactId?: unknown; artifactSchemaVersion?: unknown };
      if (typeof parsed.artifactId === "string" && parsed.artifactId) metadata.artifactId = parsed.artifactId;
      if (typeof parsed.artifactSchemaVersion === "number") metadata.artifactSchemaVersion = parsed.artifactSchemaVersion;
    } catch {
      // Preview sidecars are best-effort; stale metadata should not block file preview.
    }
  }
  return {
    artifactPath: existsSync(artifactPath) ? artifactPath : undefined,
    semanticUnitsPath: existsSync(semanticUnitsPath) ? semanticUnitsPath : undefined,
    metadata,
  };
}

function readPdfPreviewSemanticUnits(sourcePath: string | undefined, fileId: string | undefined): PdfPreviewSemanticUnit[] {
  return readPreviewSemanticUnits(sourcePath, fileId, "page");
}

function readPreviewSemanticUnits(sourcePath: string | undefined, fileId: string | undefined, locationKey: "page" | "slide"): PdfPreviewSemanticUnit[] {
  if (!sourcePath || !fileId || !fileId.startsWith("file-") || fileId.includes(":")) return [];
  const semanticUnitsPath = join(parsedDocumentDirForSource(sourcePath, fileId), "semantic-units.jsonl");
  if (!existsSync(semanticUnitsPath)) return [];
  try {
    return readFileSync(semanticUnitsPath, "utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        id?: unknown;
        text?: unknown;
        title?: unknown;
        sourceLabel?: unknown;
        location?: { page?: unknown; slide?: unknown };
        bbox?: unknown;
      })
      .map((unit): PdfPreviewSemanticUnit | null => {
        const page = Number(locationKey === "slide" ? unit.location?.slide : unit.location?.page);
        if (typeof unit.id !== "string" || !Number.isFinite(page) || page <= 0 || typeof unit.text !== "string" || !unit.text.trim()) return null;
        return {
          id: unit.id,
          page: Math.floor(page),
          title: typeof unit.title === "string" ? unit.title : undefined,
          sourceLabel: typeof unit.sourceLabel === "string" ? unit.sourceLabel : undefined,
          text: unit.text.slice(0, 4000),
          bbox: pdfPreviewSemanticBbox(unit.bbox),
        };
      })
      .filter((unit): unit is PdfPreviewSemanticUnit => Boolean(unit));
  } catch (error) {
    console.warn("[pdf-preview] Failed to read semantic units", { sourcePath, semanticUnitsPath, error: errorMessage(error) });
    return [];
  }
}

function pdfPreviewSemanticBbox(value: unknown): PdfPreviewSemanticUnit["bbox"] {
  if (!value || typeof value !== "object") return undefined;
  const rect = value as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
  const x = Number(rect.x);
  const y = Number(rect.y);
  const width = Number(rect.width);
  const height = Number(rect.height);
  if (![x, y, width, height].every(Number.isFinite)) return undefined;
  return { x, y, width, height };
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function stripDerivedMarkdown(result: IndexingWorkerResult): IndexingWorkerResult {
  if (result.derivedMarkdown === undefined) return result;
  const { derivedMarkdown: _derivedMarkdown, ...rest } = result;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown cleanup failure");
}
