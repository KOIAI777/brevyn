import { useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { FilePreview, WorkspaceFileKind, WorkspaceFileNode } from "@/types/domain";
import { findFileNode, findFileNodeByPath } from "@/lib/workspace-files";
import { errorMessage } from "@/hooks/workspaceFileUtils";

const FILE_PREVIEW_CACHE_LIMIT = 30;
const FILE_PREVIEW_CACHE_TTL_MS = 10 * 60 * 1000;
const filePreviewCache = new Map<string, { preview: FilePreview; cachedAt: number }>();
export type ParsedPreviewResult = { ok: boolean; message?: string };
export type FilePreviewLoadingFile = {
  id: string;
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  sourcePath?: string;
};

export function useFilePreviewState({
  mountedRef,
  activeCourseIdRef,
  activeCourseScopeKeyRef,
  activeThreadIdRef,
  fileTreeRef,
  sessionFilesRef,
  refreshCourseTree,
  onError,
}: {
  mountedRef: MutableRefObject<boolean>;
  activeCourseIdRef: MutableRefObject<string>;
  activeCourseScopeKeyRef: MutableRefObject<string>;
  activeThreadIdRef: MutableRefObject<string>;
  fileTreeRef: MutableRefObject<WorkspaceFileNode[]>;
  sessionFilesRef: MutableRefObject<WorkspaceFileNode[]>;
  refreshCourseTree: (courseId: string) => Promise<WorkspaceFileNode[] | null>;
  onError: (message: string) => void;
}) {
  const selectedFileIdRef = useRef("");
  const selectedFileVersionRef = useRef("");
  const selectedFileSourcePathRef = useRef("");
  const filePreviewRef = useRef<FilePreview | null>(null);
  const filePreviewRequestRef = useRef(0);
  const autoRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selectedFileId, setSelectedFileId] = useState("");
  const [filePreview, setFilePreview] = useState<FilePreview | null>(null);
  const [filePreviewLoading, setFilePreviewLoading] = useState(false);
  const [filePreviewLoadingFile, setFilePreviewLoadingFile] = useState<FilePreviewLoadingFile | null>(null);

  selectedFileIdRef.current = selectedFileId;
  filePreviewRef.current = filePreview;

  function commitSelectedFileId(fileId: string) {
    selectedFileIdRef.current = fileId;
    setSelectedFileId(fileId);
  }

  function commitFilePreview(preview: FilePreview | null) {
    filePreviewRef.current = preview;
    setFilePreview(preview);
  }

  function clearPreviewState() {
    if (autoRefreshTimerRef.current) {
      clearTimeout(autoRefreshTimerRef.current);
      autoRefreshTimerRef.current = null;
    }
    filePreviewRequestRef.current += 1;
    commitSelectedFileId("");
    selectedFileVersionRef.current = "";
    selectedFileSourcePathRef.current = "";
    commitFilePreview(null);
    setFilePreviewLoading(false);
    setFilePreviewLoadingFile(null);
  }

  async function loadPreviewForFile(file: WorkspaceFileNode, options: {
    sourcePath?: string;
    errorFallback?: string;
    force?: boolean;
    preserveOnError?: boolean;
  } = {}): Promise<boolean> {
    const requestId = filePreviewRequestRef.current + 1;
    const courseScopeAtRequest = activeCourseScopeKeyRef.current;
    const threadIdAtRequest = options.sourcePath ? activeThreadIdRef.current : "";
    const cacheKey = filePreviewCacheKey(file, {
      courseScopeKey: courseScopeAtRequest,
      sourcePath: options.sourcePath,
      threadId: threadIdAtRequest,
    });
    const shouldCachePreview = shouldUseMemoryPreviewCache(file.kind);
    const cachedPreview = shouldCachePreview && !options.force ? readFilePreviewCache(cacheKey) : undefined;
    filePreviewRequestRef.current = requestId;
    commitSelectedFileId(file.id);
    selectedFileSourcePathRef.current = options.sourcePath || "";
    onError("");
    if (file.kind === "folder") {
      commitFilePreview(null);
      setFilePreviewLoading(false);
      setFilePreviewLoadingFile(null);
      return false;
    }
    if (cachedPreview) {
      selectedFileVersionRef.current = file.updatedAt || "";
      commitFilePreview(cachedPreview);
      setFilePreviewLoading(false);
      setFilePreviewLoadingFile(null);
      return true;
    }
    setFilePreviewLoading(true);
    setFilePreviewLoadingFile(loadingFileFromNode(file, options.sourcePath));
    try {
      const preview = options.sourcePath && threadIdAtRequest
        ? await window.brevyn.app.previewWorkspacePath({ threadId: threadIdAtRequest, path: options.sourcePath })
        : await window.brevyn.files.preview(file.id);
      if (!mountedRef.current || filePreviewRequestRef.current !== requestId || selectedFileIdRef.current !== file.id) return false;
      if (options.sourcePath ? activeThreadIdRef.current !== threadIdAtRequest : activeCourseScopeKeyRef.current !== courseScopeAtRequest) return false;
      onError("");
      if (options.preserveOnError && !isUsableRefreshedPreview(preview)) {
        setFilePreviewLoading(false);
        setFilePreviewLoadingFile(null);
        onError(preview?.summary || options.errorFallback || "文件已更新，但预览刷新失败。");
        return false;
      }
      if (preview && shouldCachePreview) {
        writeFilePreviewCache(cacheKey, preview);
        if (!options.sourcePath) {
          writeFilePreviewCache(sourcePreviewCacheKey(courseScopeAtRequest, file.id, file.updatedAt), preview);
        }
      }
      selectedFileVersionRef.current = file.updatedAt || "";
      commitFilePreview(preview);
      setFilePreviewLoading(false);
      setFilePreviewLoadingFile(null);
      return Boolean(preview);
    } catch (error) {
      if (!mountedRef.current || filePreviewRequestRef.current !== requestId) return false;
      setFilePreviewLoading(false);
      setFilePreviewLoadingFile(null);
      if (!options.preserveOnError) commitFilePreview(null);
      onError(errorMessage(error, options.errorFallback || "Failed to preview file."));
      return false;
    }
  }

  async function selectFile(file: WorkspaceFileNode): Promise<boolean> {
    return loadPreviewForFile(file);
  }

  async function selectSessionFile(file: WorkspaceFileNode): Promise<boolean> {
    const sourcePath = file.sourcePath || file.path;
    return loadPreviewForFile(file, { sourcePath, errorFallback: "Failed to preview session file." });
  }

  async function previewSourceFile(fileId: string): Promise<boolean> {
    const requestId = filePreviewRequestRef.current + 1;
    const courseScopeAtRequest = activeCourseScopeKeyRef.current;
    const file = findFileNode(fileTreeRef.current, fileId);
    const fileVersion = file?.updatedAt || "";
    const cacheKey = sourcePreviewCacheKey(courseScopeAtRequest, fileId, fileVersion);
    if (filePreviewRef.current?.id === fileId && selectedFileVersionRef.current === fileVersion) {
      commitSelectedFileId(fileId);
      return true;
    }
    const cachedPreview = readFilePreviewCache(cacheKey);
    filePreviewRequestRef.current = requestId;
    commitSelectedFileId(fileId);
    selectedFileSourcePathRef.current = "";
    onError("");
    if (cachedPreview) {
      selectedFileVersionRef.current = fileVersion;
      commitFilePreview(cachedPreview);
      setFilePreviewLoading(false);
      setFilePreviewLoadingFile(null);
      return true;
    }
    setFilePreviewLoading(true);
    setFilePreviewLoadingFile({ id: fileId, name: "原文预览", path: "", kind: "text" });
    try {
      const preview = await window.brevyn.files.preview(fileId);
      if (!mountedRef.current || filePreviewRequestRef.current !== requestId || selectedFileIdRef.current !== fileId) return false;
      if (activeCourseScopeKeyRef.current !== courseScopeAtRequest) return false;
      onError("");
      if (preview) writeFilePreviewCache(cacheKey, preview);
      selectedFileVersionRef.current = fileVersion;
      commitFilePreview(preview);
      setFilePreviewLoading(false);
      setFilePreviewLoadingFile(null);
      return Boolean(preview);
    } catch (error) {
      if (!mountedRef.current || filePreviewRequestRef.current !== requestId) return false;
      setFilePreviewLoading(false);
      setFilePreviewLoadingFile(null);
      commitFilePreview(null);
      onError(errorMessage(error, "无法打开原文预览。"));
      return false;
    }
  }

  async function previewParsedFile(file: { id: string; updatedAt?: string }): Promise<ParsedPreviewResult> {
    const requestId = filePreviewRequestRef.current + 1;
    const courseScopeAtRequest = activeCourseScopeKeyRef.current;
    const currentFile = findFileNode(fileTreeRef.current, file.id);
    const fileVersion = file.updatedAt || currentFile?.updatedAt || "";
    const cacheKey = `parsed:${courseScopeAtRequest}:${file.id}:${fileVersion}`;
    const cachedPreview = readFilePreviewCache(cacheKey);
    filePreviewRequestRef.current = requestId;
    commitSelectedFileId(`${file.id}:parsed`);
    selectedFileVersionRef.current = fileVersion;
    selectedFileSourcePathRef.current = "";
    onError("");
    if (cachedPreview) {
      commitFilePreview(cachedPreview);
      setFilePreviewLoading(false);
      setFilePreviewLoadingFile(null);
      return { ok: true };
    }
    setFilePreviewLoading(true);
    setFilePreviewLoadingFile({ id: file.id, name: "解析文本", path: "", kind: "markdown" });
    try {
      const preview = await window.brevyn.files.parsedPreview(file.id);
      if (!mountedRef.current || filePreviewRequestRef.current !== requestId || selectedFileIdRef.current !== `${file.id}:parsed`) return { ok: false };
      if (activeCourseScopeKeyRef.current !== courseScopeAtRequest) return { ok: false };
      onError("");
      if (preview) writeFilePreviewCache(cacheKey, preview);
      commitFilePreview(preview);
      setFilePreviewLoading(false);
      setFilePreviewLoadingFile(null);
      return { ok: Boolean(preview) };
    } catch (error) {
      const message = errorMessage(error, "无法打开解析文本。");
      if (!mountedRef.current || filePreviewRequestRef.current !== requestId) return { ok: false, message };
      setFilePreviewLoading(false);
      setFilePreviewLoadingFile(null);
      commitFilePreview(null);
      return { ok: false, message };
    }
  }

  async function previewWorkspacePath(filePath: string, options: { silent?: boolean } = {}): Promise<boolean> {
    const courseId = activeCourseIdRef.current;
    const courseScopeAtRequest = activeCourseScopeKeyRef.current;
    let nextCourseFile = findFileNodeByPath(fileTreeRef.current, filePath);
    let nextSessionFile = findFileNodeByPath(sessionFilesRef.current, filePath);
    if (!nextCourseFile && !nextSessionFile && courseId) {
      const latestTree = await refreshCourseTree(courseId);
      if (!latestTree) return false;
      nextCourseFile = findFileNodeByPath(latestTree, filePath);
      nextSessionFile = findFileNodeByPath(sessionFilesRef.current, filePath);
    }
    if (activeCourseScopeKeyRef.current !== courseScopeAtRequest) return false;
    if (!nextCourseFile && !nextSessionFile) {
      const threadIdAtRequest = activeThreadIdRef.current;
      if (!threadIdAtRequest) {
        if (!options.silent) onError(`没有在当前文件浏览器里找到这个文件：${filePath}`);
        return false;
      }
      const requestId = filePreviewRequestRef.current + 1;
      const cacheKey = `thread-path:${threadIdAtRequest}:${filePath}`;
      const shouldCachePreview = shouldUseMemoryPreviewCache(fileKindForPath(filePath));
      const cachedPreview = shouldCachePreview ? readFilePreviewCache(cacheKey) : undefined;
      filePreviewRequestRef.current = requestId;
      selectedFileSourcePathRef.current = filePath;
      selectedFileVersionRef.current = "";
      try {
        if (cachedPreview) {
          commitSelectedFileId(cachedPreview.id);
          commitFilePreview(cachedPreview);
          setFilePreviewLoading(false);
          setFilePreviewLoadingFile(null);
          return true;
        }
        setFilePreviewLoading(true);
        setFilePreviewLoadingFile(loadingFileFromPath(filePath));
        const preview = await window.brevyn.app.previewWorkspacePath({ threadId: threadIdAtRequest, path: filePath });
        if (!mountedRef.current || filePreviewRequestRef.current !== requestId || activeThreadIdRef.current !== threadIdAtRequest) return false;
        if (!preview) {
          setFilePreviewLoading(false);
          setFilePreviewLoadingFile(null);
          commitFilePreview(null);
          if (!options.silent) onError(`没有在当前文件浏览器里找到这个文件：${filePath}`);
          return false;
        }
        commitSelectedFileId(preview.id);
        onError("");
        if (shouldCachePreview) writeFilePreviewCache(cacheKey, preview);
        commitFilePreview(preview);
        setFilePreviewLoading(false);
        setFilePreviewLoadingFile(null);
        return true;
      } catch (error) {
        if (!mountedRef.current || filePreviewRequestRef.current !== requestId || activeThreadIdRef.current !== threadIdAtRequest) return false;
        setFilePreviewLoading(false);
        setFilePreviewLoadingFile(null);
        commitFilePreview(null);
        if (!options.silent) onError(errorMessage(error, "Failed to preview workspace file."));
        return false;
      }
    }
    return nextSessionFile ? selectSessionFile(nextSessionFile) : selectFile(nextCourseFile!);
  }

  function refreshSelectedPreviewIfChanged(nextFiles: WorkspaceFileNode[]): void {
    const selectedId = selectedFileIdRef.current;
    if (!selectedId) return;
    const parsedPreview = selectedId.endsWith(":parsed");
    const sourceFileId = parsedPreview ? selectedId.slice(0, -":parsed".length) : selectedId;
    const selectedSourcePath = selectedFileSourcePathRef.current;
    const nextFile = findFileNode(nextFiles, sourceFileId)
      || (selectedSourcePath ? findFileNodeByPath(nextFiles, selectedSourcePath) : null);
    if (!nextFile || nextFile.kind === "folder") return;
    const currentVersion = selectedFileVersionRef.current;
    if (!currentVersion && !selectedSourcePath) {
      selectedFileVersionRef.current = nextFile.updatedAt || "";
      return;
    }
    if (!nextFile.updatedAt || nextFile.updatedAt === currentVersion) return;

    if (autoRefreshTimerRef.current) clearTimeout(autoRefreshTimerRef.current);
    autoRefreshTimerRef.current = setTimeout(() => {
      autoRefreshTimerRef.current = null;
      const latestFiles = [...fileTreeRef.current, ...sessionFilesRef.current];
      const latestFile = findFileNode(latestFiles, sourceFileId)
        || (selectedSourcePath ? findFileNodeByPath(latestFiles, selectedSourcePath) : null);
      if (!latestFile || latestFile.updatedAt === selectedFileVersionRef.current) return;
      invalidateFilePreviewCache(sourceFileId, selectedSourcePath);
      if (parsedPreview) {
        void previewParsedFile({ id: sourceFileId, updatedAt: latestFile.updatedAt });
        return;
      }
      void loadPreviewForFile(latestFile, {
        sourcePath: selectedSourcePath || undefined,
        force: true,
        preserveOnError: true,
        errorFallback: "文件已更新，但预览刷新失败。",
      });
    }, 500);
  }

  return {
    selectedFileId,
    selectedFileIdRef,
    filePreview,
    filePreviewRef,
    filePreviewLoading,
    filePreviewLoadingFile,
    filePreviewRequestRef,
    commitSelectedFileId,
    clearPreviewState,
    setFilePreview: commitFilePreview,
    setFilePreviewLoading,
    selectFile,
    selectSessionFile,
    previewSourceFile,
    previewParsedFile,
    previewWorkspacePath,
    refreshSelectedPreviewIfChanged,
  };
}

function loadingFileFromNode(file: WorkspaceFileNode, sourcePath?: string): FilePreviewLoadingFile {
  return {
    id: file.id,
    name: file.name,
    path: file.path,
    sourcePath: sourcePath || file.sourcePath,
    kind: file.kind,
  };
}

function loadingFileFromPath(path: string): FilePreviewLoadingFile {
  return {
    id: path,
    name: path.split(/[\\/]/).pop() || path,
    path,
    sourcePath: path,
    kind: fileKindForPath(path),
  };
}

function fileKindForPath(path: string): WorkspaceFileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".pptx") || lower.endsWith(".ppt")) return "pptx";
  if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "docx";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls") || lower.endsWith(".csv")) return "spreadsheet";
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(lower)) return "image";
  if (/\.(md|markdown)$/i.test(lower)) return "markdown";
  if (/\.(js|ts|tsx|jsx|py|html|css|json|yaml|yml|sh)$/i.test(lower)) return "code";
  return "text";
}

function filePreviewCacheKey(file: WorkspaceFileNode, input: { courseScopeKey: string; sourcePath?: string; threadId?: string }): string {
  const sourcePath = input.sourcePath || file.sourcePath || file.path;
  const scope = input.threadId ? `thread:${input.threadId}` : `course:${input.courseScopeKey}`;
  return `${scope}:${file.id}:${sourcePath}:${file.updatedAt || ""}`;
}

function sourcePreviewCacheKey(courseScopeKey: string, fileId: string, updatedAt: string): string {
  return `source:${courseScopeKey}:${fileId}:${updatedAt || "unknown"}`;
}

function readFilePreviewCache(key: string): FilePreview | undefined {
  const value = filePreviewCache.get(key);
  if (!value) return undefined;
  if (Date.now() - value.cachedAt > FILE_PREVIEW_CACHE_TTL_MS) {
    filePreviewCache.delete(key);
    return undefined;
  }
  filePreviewCache.delete(key);
  filePreviewCache.set(key, value);
  return value.preview;
}

function writeFilePreviewCache(key: string, preview: FilePreview): void {
  filePreviewCache.delete(key);
  filePreviewCache.set(key, { preview, cachedAt: Date.now() });
  while (filePreviewCache.size > FILE_PREVIEW_CACHE_LIMIT) {
    const oldest = filePreviewCache.keys().next().value;
    if (!oldest) break;
    filePreviewCache.delete(oldest);
  }
}

function invalidateFilePreviewCache(fileId: string, sourcePath = ""): void {
  const marker = `:${fileId}:`;
  for (const key of filePreviewCache.keys()) {
    if (key.includes(marker) || (sourcePath && key.includes(sourcePath))) filePreviewCache.delete(key);
  }
}

function isUsableRefreshedPreview(preview: FilePreview | null): boolean {
  if (!preview) return false;
  if (preview.kind === "pdf" || preview.kind === "pptx") return Boolean(preview.previewUrl);
  if (preview.kind === "docx") return Boolean(preview.previewUrl || preview.html || preview.content);
  if (preview.kind === "spreadsheet") return Boolean(preview.spreadsheet || preview.html || preview.content);
  return true;
}

function shouldUseMemoryPreviewCache(kind: WorkspaceFileKind): boolean {
  return kind !== "folder";
}
