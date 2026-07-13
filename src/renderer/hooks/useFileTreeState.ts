import { useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { FileStats, WorkspaceFileNode } from "@/types/domain";
import { errorMessage } from "@/hooks/workspaceFileUtils";

export function useFileTreeState({
  mountedRef,
  activeCourseIdRef,
  activeCourseScopeKeyRef,
  activeThreadIdRef,
  onError,
}: {
  mountedRef: MutableRefObject<boolean>;
  activeCourseIdRef: MutableRefObject<string>;
  activeCourseScopeKeyRef: MutableRefObject<string>;
  activeThreadIdRef: MutableRefObject<string>;
  onError: (message: string) => void;
}) {
  const fileTreeRef = useRef<WorkspaceFileNode[]>([]);
  const sessionFilesRef = useRef<WorkspaceFileNode[]>([]);
  const fileLoadRequestRef = useRef(0);
  const sessionLoadRequestRef = useRef(0);
  const [fileTree, setFileTree] = useState<WorkspaceFileNode[]>([]);
  const [sessionFiles, setSessionFiles] = useState<WorkspaceFileNode[]>([]);
  const [fileStats, setFileStats] = useState<FileStats | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);

  fileTreeRef.current = fileTree;
  sessionFilesRef.current = sessionFiles;

  function clearTreeState() {
    fileLoadRequestRef.current += 1;
    setFilesLoading(false);
    fileTreeRef.current = [];
    setFileTree([]);
    setFileStats(null);
  }

  function isLatestFileLoad(requestId: number, courseId: string, scopeKey: string) {
    return mountedRef.current && fileLoadRequestRef.current === requestId && activeCourseIdRef.current === courseId && activeCourseScopeKeyRef.current === scopeKey;
  }

  async function refreshCourseTree(courseId: string): Promise<WorkspaceFileNode[] | null> {
    const scopeKey = activeCourseScopeKeyRef.current;
    try {
      const latestTree = await window.brevyn.files.tree(courseId);
      if (!mountedRef.current || activeCourseIdRef.current !== courseId || activeCourseScopeKeyRef.current !== scopeKey) return null;
      setFileTree(latestTree);
      fileTreeRef.current = latestTree;
      return latestTree;
    } catch (error) {
      if (mountedRef.current) onError(errorMessage(error, "Failed to refresh files before preview."));
      return null;
    }
  }

  function clearSessionFiles() {
    sessionLoadRequestRef.current += 1;
    sessionFilesRef.current = [];
    setSessionFiles([]);
  }

  async function loadSessionFiles(threadId: string): Promise<WorkspaceFileNode[] | null> {
    const requestId = sessionLoadRequestRef.current + 1;
    sessionLoadRequestRef.current = requestId;
    try {
      const files = await window.brevyn.attachments.list(threadId);
      if (!mountedRef.current || sessionLoadRequestRef.current !== requestId || activeThreadIdRef.current !== threadId) return null;
      sessionFilesRef.current = files;
      setSessionFiles(files);
      return files;
    } catch (error) {
      if (mountedRef.current && sessionLoadRequestRef.current === requestId && activeThreadIdRef.current === threadId) {
        onError(errorMessage(error, "Failed to load session files."));
      }
      return null;
    }
  }

  return {
    fileTree,
    fileTreeRef,
    sessionFiles,
    sessionFilesRef,
    fileStats,
    filesLoading,
    fileLoadRequestRef,
    setFileTree,
    setFileStats,
    setSessionFiles,
    setFilesLoading,
    clearTreeState,
    clearSessionFiles,
    isLatestFileLoad,
    refreshCourseTree,
    loadSessionFiles,
  };
}
