import { useEffect, useLayoutEffect, useRef } from "react";
import type { FileImportInput, FileImportResult } from "@/types/domain";
import { findFileNode } from "@/lib/workspace-files";
import { useFilePreviewState } from "@/hooks/useFilePreviewState";
import { useFileTreeState } from "@/hooks/useFileTreeState";
import { errorMessage } from "@/hooks/workspaceFileUtils";

interface UseWorkspaceFilesStateArgs {
  semesterId: string;
  activeCourseId: string;
  activeThreadId: string;
  onError: (message: string) => void;
  onPreviewError?: (message: string) => void;
}

export function useWorkspaceFilesState({ semesterId, activeCourseId, activeThreadId, onError, onPreviewError }: UseWorkspaceFilesStateArgs) {
  const mountedRef = useRef(true);
  const activeCourseIdRef = useRef(activeCourseId);
  const activeCourseScopeKeyRef = useRef(courseScopeKey(semesterId, activeCourseId));
  const activeThreadIdRef = useRef(activeThreadId);

  activeCourseIdRef.current = activeCourseId;
  activeCourseScopeKeyRef.current = courseScopeKey(semesterId, activeCourseId);
  activeThreadIdRef.current = activeThreadId;

  const treeState = useFileTreeState({
    mountedRef,
    activeCourseIdRef,
    activeCourseScopeKeyRef,
    activeThreadIdRef,
    onError,
  });
  const previewState = useFilePreviewState({
    mountedRef,
    activeCourseIdRef,
    activeCourseScopeKeyRef,
    activeThreadIdRef,
    fileTreeRef: treeState.fileTreeRef,
    sessionFilesRef: treeState.sessionFilesRef,
    refreshCourseTree: treeState.refreshCourseTree,
    onError: onPreviewError || onError,
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    treeState.clearTreeState();
    previewState.clearPreviewState();
    if (!activeCourseId) {
      return;
    }
    void loadCourseFiles(activeCourseId, courseScopeKey(semesterId, activeCourseId));
  }, [semesterId, activeCourseId]);

  useEffect(() => {
    const unsubscribe = window.brevyn.files.onChanged(() => {
      const courseId = activeCourseIdRef.current;
      if (courseId) {
        void loadCourseFiles(courseId).then((loaded) => {
          if (loaded) previewState.refreshSelectedPreviewIfChanged([
            ...treeState.fileTreeRef.current,
            ...treeState.sessionFilesRef.current,
          ]);
        });
      }
      const threadId = activeThreadIdRef.current;
      if (threadId) {
        const selectedId = previewState.selectedFileIdRef.current;
        const selectedSourceId = sourceFileIdForPreview(selectedId);
        const selectedWasSessionFile = selectedSourceId ? findFileNode(treeState.sessionFilesRef.current, selectedSourceId) : null;
        void treeState.loadSessionFiles(threadId).then((files) => {
          if (!files) return;
          if (selectedWasSessionFile && !findFileNode(files, selectedSourceId)) {
            previewState.clearPreviewState();
            return;
          }
          previewState.refreshSelectedPreviewIfChanged([
            ...treeState.fileTreeRef.current,
            ...files,
          ]);
        });
      }
    });
    return unsubscribe;
  }, []);

  useLayoutEffect(() => {
    treeState.clearSessionFiles();
    previewState.clearPreviewState();
    if (!activeThreadId) {
      return;
    }
    void treeState.loadSessionFiles(activeThreadId);
  }, [activeThreadId]);

  function clearFileState() {
    treeState.clearTreeState();
    previewState.clearPreviewState();
  }

  async function loadCourseFiles(courseId: string, scopeKey = activeCourseScopeKeyRef.current): Promise<boolean> {
    const requestId = treeState.fileLoadRequestRef.current + 1;
    const selectedId = previewState.selectedFileIdRef.current;
    const selectedSourceId = sourceFileIdForPreview(selectedId);
    const selectedWasCourseFile = selectedSourceId ? findFileNode(treeState.fileTreeRef.current, selectedSourceId) : null;
    treeState.fileLoadRequestRef.current = requestId;
    treeState.setFilesLoading(true);
    try {
      const [tree, stats] = await Promise.all([window.brevyn.files.tree(courseId), window.brevyn.files.stats(courseId)]);
      if (!treeState.isLatestFileLoad(requestId, courseId, scopeKey)) return false;

      treeState.fileTreeRef.current = tree;
      treeState.setFileTree(tree);
      treeState.setFileStats(stats);
      if (selectedWasCourseFile && selectedId === previewState.selectedFileIdRef.current && !findFileNode(tree, selectedSourceId)) {
        previewState.clearPreviewState();
      }
      return true;
    } catch (error) {
      if (treeState.isLatestFileLoad(requestId, courseId, scopeKey)) {
        onError(errorMessage(error, "Failed to load course files."));
        treeState.clearTreeState();
        previewState.clearPreviewState();
      }
      return false;
    } finally {
      if (treeState.fileLoadRequestRef.current === requestId) treeState.setFilesLoading(false);
    }
  }

  async function importCourseFiles(input: FileImportInput): Promise<FileImportResult | null> {
    const targetCourseId = input.courseId;
    const targetScopeKey = activeCourseScopeKeyRef.current;
    onError("");
    try {
      const result = await window.brevyn.files.import(input);
      if (!mountedRef.current || activeCourseIdRef.current !== targetCourseId || activeCourseScopeKeyRef.current !== targetScopeKey) return result;

      const requestId = treeState.fileLoadRequestRef.current + 1;
      treeState.fileLoadRequestRef.current = requestId;
      const stats = await window.brevyn.files.stats(targetCourseId);
      if (!treeState.isLatestFileLoad(requestId, targetCourseId, targetScopeKey)) return result;
      treeState.fileTreeRef.current = result.tree;
      treeState.setFileTree(result.tree);
      treeState.setFileStats(stats);
      return result;
    } catch (error) {
      const message = errorMessage(error, "Failed to import files.");
      if (mountedRef.current) onError(message);
      throw new Error(message);
    }
  }

  return {
    fileTree: treeState.fileTree,
    sessionFiles: treeState.sessionFiles,
    fileStats: treeState.fileStats,
    filesLoading: treeState.filesLoading,
    selectedFileId: previewState.selectedFileId,
    selectedFileIdRef: previewState.selectedFileIdRef,
    filePreview: previewState.filePreview,
    filePreviewRef: previewState.filePreviewRef,
    filePreviewLoading: previewState.filePreviewLoading,
    filePreviewLoadingFile: previewState.filePreviewLoadingFile,
    clearFileState,
    loadCourseFiles,
    loadSessionFiles: treeState.loadSessionFiles,
    selectFile: previewState.selectFile,
    selectSessionFile: previewState.selectSessionFile,
    previewSourceFile: previewState.previewSourceFile,
    previewParsedFile: previewState.previewParsedFile,
    previewWorkspacePath: previewState.previewWorkspacePath,
    importCourseFiles,
  };
}

function courseScopeKey(semesterId: string, courseId: string) {
  return `${semesterId}:${courseId}`;
}

function sourceFileIdForPreview(selectedFileId: string): string {
  return selectedFileId.endsWith(":parsed") ? selectedFileId.slice(0, -":parsed".length) : selectedFileId;
}
