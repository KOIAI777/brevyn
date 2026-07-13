import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BookMarked, ChevronLeft, ChevronRight, FolderOpen, Loader2, Paperclip, Upload, X } from "lucide-react";
import type { BrevynTask, ContextAnchor, Course, FilePreview, FileStats, SemesterWorkspace, WorkspaceFileNode } from "@/types/domain";
import type { FilePreviewLoadingFile, ParsedPreviewResult } from "@/hooks/useFilePreviewState";
import type { FilePreviewLocationTarget } from "@/components/chat/FilePathChip";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { cx } from "@/lib/cn";
import { SourcesRail } from "@/components/sources/SourcesRail";
import { FileContextMenu, fileDisplayName, type FileContextMenuAction, type FileContextMenuState } from "./FileContextMenu";
import { FilePreviewPane } from "./FilePreviewPane";
import { FileTreeNode } from "./FileTreeNode";

export type FileRailViewMode = "context" | "tree" | "sources";

const COMPACT_BROWSER_LAYOUT_WIDTH = 680;

export function FileBrowserRail({
  semester,
  course,
  activeTask,
  stats,
  files,
  sessionFiles,
  loading,
  selectedFileId,
  activeTab,
  preview,
  previewTarget,
  previewLoading,
  previewLoadingFile,
  threadId,
  onSelectFile,
  onPreviewParsedFile,
  onPreviewSourceFile,
  onPreviewParsedFileById,
  onSelectSessionFile,
  onAddQuotedSelection,
  onActiveTabChange,
  onOpenUpload,
}: {
  semester?: SemesterWorkspace | null;
  course?: Course;
  activeTask?: BrevynTask;
  stats?: FileStats | null;
  files: WorkspaceFileNode[];
  sessionFiles?: WorkspaceFileNode[];
  loading?: boolean;
  selectedFileId: string;
  activeTab: FileRailViewMode;
  preview: FilePreview | null;
  previewTarget?: FilePreviewLocationTarget | null;
  previewLoading?: boolean;
  previewLoadingFile?: FilePreviewLoadingFile | null;
  threadId?: string;
  onSelectFile: (file: WorkspaceFileNode) => void;
  onPreviewParsedFile?: (file: WorkspaceFileNode) => void;
  onPreviewSourceFile?: (fileId: string) => Promise<boolean> | boolean;
  onPreviewParsedFileById?: (fileId: string) => Promise<ParsedPreviewResult> | ParsedPreviewResult;
  onSelectSessionFile?: (file: WorkspaceFileNode) => void;
  onAddQuotedSelection?: (quote: ContextAnchor) => void;
  onActiveTabChange: (mode: FileRailViewMode) => void;
  onOpenUpload: () => void;
}) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [browserCollapsed, setBrowserCollapsed] = useState(() => readStoredBrowserCollapsed());
  const [compactBrowserLayout, setCompactBrowserLayout] = useState(false);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => new Set());
  const [expandedEmptyFolderIds, setExpandedEmptyFolderIds] = useState<Set<string>>(() => new Set());
  const [menu, setMenu] = useState<FileContextMenuState | null>(null);
  const [renameFile, setRenameFile] = useState<WorkspaceFileNode | null>(null);
  const [actionError, setActionError] = useState("");
  const { confirm, confirmDialog } = useConfirmDialog();
  const uploadDisabled = !course || Boolean(course.archivedAt);
  const uploadTitle = !course ? "请先选择课程再管理文件" : course.archivedAt ? "请先恢复课程再管理文件" : "打开我的课程";
  const collapseScopeKey = useMemo(() => fileCollapseScopeKey(course?.id, activeTask?.id), [activeTask?.id, course?.id]);
  const contextSections = useMemo(() => buildContextSections(files, course, activeTask), [activeTask, course, files]);
  const courseFileCount = useMemo(
    () => stats?.totalFiles ?? files.reduce((count, node) => count + countLeafFiles(node), 0),
    [files, stats?.totalFiles],
  );

  useEffect(() => {
    setCollapsedFolderIds(readStoredCollapsedFolderIds(collapseScopeKey));
    setExpandedEmptyFolderIds(new Set());
  }, [collapseScopeKey]);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const updateLayout = () => setCompactBrowserLayout(rail.clientWidth < COMPACT_BROWSER_LAYOUT_WIDTH);
    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(rail);
    return () => observer.disconnect();
  }, []);

  const toggleFolder = useCallback((folderId: string) => {
    setCollapsedFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      storeCollapsedFolderIds(collapseScopeKey, next);
      return next;
    });
  }, [collapseScopeKey]);
  const toggleEmptyFolder = useCallback((folderId: string) => {
    setExpandedEmptyFolderIds((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);
  const selectFileForPreview = useCallback((file: WorkspaceFileNode) => {
    onSelectFile(file);
    if (compactBrowserLayout) setBrowserCollapsed(true);
  }, [compactBrowserLayout, onSelectFile]);
  const selectSessionFileForPreview = useCallback((file: WorkspaceFileNode) => {
    (onSelectSessionFile || onSelectFile)(file);
    if (compactBrowserLayout) setBrowserCollapsed(true);
  }, [compactBrowserLayout, onSelectFile, onSelectSessionFile]);
  const previewParsedFile = useCallback((file: WorkspaceFileNode) => {
    onPreviewParsedFile?.(file);
    if (compactBrowserLayout) setBrowserCollapsed(true);
  }, [compactBrowserLayout, onPreviewParsedFile]);
  const toggleBrowserCollapsed = useCallback(() => {
    setBrowserCollapsed((current) => {
      const next = !current;
      storeBrowserCollapsed(next);
      return next;
    });
  }, []);
  const contextMenuForFile = useCallback((event: MouseEvent, file: WorkspaceFileNode) => {
    event.preventDefault();
    setMenu({
      file,
      anchor: {
        left: event.clientX,
        right: event.clientX,
        top: event.clientY,
        bottom: event.clientY,
      },
    });
  }, []);
  const ignoreSessionContextMenu = useCallback((event: MouseEvent) => {
    event.preventDefault();
  }, []);
  const refreshSelectedFile = (file: WorkspaceFileNode) => {
    if (selectedFileId === file.id) onSelectFile(file);
  };

  async function handleContextAction(action: FileContextMenuAction, file: WorkspaceFileNode) {
    setActionError("");
    try {
      if (action === "open") {
        await window.brevyn.files.open(file.id);
        return;
      }
      if (action === "reveal") {
        await window.brevyn.files.reveal(file.id);
        return;
      }
      if (action === "copyPath") {
        await navigator.clipboard.writeText(file.sourcePath || file.path);
        return;
      }
      if (action === "copyName") {
        await navigator.clipboard.writeText(fileDisplayName(file));
        return;
      }
      if (action === "previewParsed") {
        previewParsedFile(file);
        return;
      }
      if (action === "retryIndex") {
        await window.brevyn.files.retryIndex(file.id);
        refreshSelectedFile({ ...file, indexingStatus: "queued", indexingError: undefined, indexingWarning: undefined });
        return;
      }
      if (action === "rename") {
        setRenameFile(file);
        return;
      }
      const name = fileDisplayName(file);
      const ok = await confirm({
        title: `删除“${name}”？`,
        message: file.kind === "folder" ? "这个文件夹及其中所有内容都会从工作区移除。" : "这个文件会从工作区移除。",
        confirmLabel: "删除",
        cancelLabel: "取消",
        tone: "danger",
      });
      if (!ok) return;
      try {
        await window.brevyn.files.delete(file.id);
      } catch (deleteError) {
        if (!isActiveIndexingDeleteError(deleteError)) throw deleteError;
        const forceDelete = await confirm({
          title: "取消索引并删除？",
          message: "这个项目正在进入课程知识库。取消后会停止相关索引任务，并删除本地副本和已生成的知识库片段。",
          confirmLabel: "取消索引并删除",
          cancelLabel: "保留文件",
          tone: "danger",
        });
        if (!forceDelete) return;
        await window.brevyn.files.delete({ fileId: file.id, forceCancelIndexing: true });
      }
    } catch (error) {
      setActionError(errorMessage(error, "文件操作失败。"));
    }
  }

  return (
    <div ref={railRef} className="relative flex min-h-0 flex-1 flex-col">
      {confirmDialog}
      <FileContextMenu state={menu} onAction={handleContextAction} onClose={() => setMenu(null)} />
      {renameFile && (
        <RenameFileDialog
          file={renameFile}
          onClose={() => setRenameFile(null)}
          onRename={async (name) => {
            setActionError("");
            try {
              await window.brevyn.files.rename({ fileId: renameFile.id, name });
              setRenameFile(null);
              refreshSelectedFile({ ...renameFile, name });
            } catch (error) {
              setActionError(error instanceof Error ? error.message : "重命名失败。");
              throw error;
            }
          }}
        />
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-muted-foreground">
              {course?.name || "工作区"} · {courseFileCount} 个文件
            </div>
            {actionError && <div className="mt-1 truncate text-[10px] text-red-600" title={actionError}>{actionError}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {loading && files.length > 0 && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            {stats && (
              <span className="rounded-md bg-muted px-1.5 py-1 text-[10px] text-muted-foreground" title={`${stats.sectionCount} 个分区`}>
                {stats.sectionCount}
              </span>
            )}
            <button
              type="button"
              className={cx(
                "inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background/70 text-muted-foreground transition hover:bg-accent hover:text-foreground",
                !browserCollapsed && "bg-accent text-foreground",
              )}
              onClick={toggleBrowserCollapsed}
              title={browserCollapsed ? "显示资料浏览" : "隐藏资料浏览"}
              aria-label={browserCollapsed ? "显示资料浏览" : "隐藏资料浏览"}
              aria-pressed={!browserCollapsed}
            >
              {browserCollapsed ? <ChevronLeft className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border bg-background/70 text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
              disabled={uploadDisabled}
              onClick={onOpenUpload}
              title={uploadTitle}
              aria-label={uploadTitle}
            >
              <Upload className="h-3 w-3" />
            </button>
          </div>
        </div>
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
              <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
                <FilePreviewPane
                  preview={preview}
                  previewTarget={previewTarget}
                  loading={previewLoading}
                  loadingFile={previewLoadingFile}
                  threadId={threadId}
                  onAddQuotedSelection={onAddQuotedSelection}
                  onPreviewSourceFile={onPreviewSourceFile}
                  onPreviewParsedFile={onPreviewParsedFileById}
                />
              </div>
              <div
                className={cx(
                  compactBrowserLayout
                    ? "absolute inset-y-0 right-0 z-30 w-[18rem] max-w-full overflow-hidden border-l bg-background shadow-[-18px_0_36px_rgba(0,0,0,0.16)] transition-transform duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]"
                    : "relative min-h-0 shrink-0 overflow-hidden transition-[width] duration-[420ms] ease-[cubic-bezier(0.22,1,0.36,1)]",
                  compactBrowserLayout
                    ? browserCollapsed ? "pointer-events-none translate-x-full" : "translate-x-0"
                    : browserCollapsed ? "w-0" : "w-[18rem]",
                )}
                aria-hidden={browserCollapsed}
              >
                <aside className={cx(
                  "absolute inset-y-0 right-0 flex min-h-0 flex-col bg-background/96",
                  compactBrowserLayout ? "w-full" : "w-[18rem] border-l bg-background/24",
                )}>
                  <div className="space-y-2 border-b px-2.5 py-2">
                    <div className="px-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">浏览资料</div>
                    <div className="grid grid-cols-3 gap-1">
                      <FileRailViewButton active={activeTab === "context"} icon={<FolderOpen className="h-3.5 w-3.5" />} label="上下文语义" onClick={() => onActiveTabChange("context")} />
                      <FileRailViewButton active={activeTab === "tree"} icon={<Paperclip className="h-3.5 w-3.5" />} label="文件树" onClick={() => onActiveTabChange("tree")} />
                      <FileRailViewButton active={activeTab === "sources"} icon={<BookMarked className="h-3.5 w-3.5" />} label="参考资料" onClick={() => onActiveTabChange("sources")} />
                    </div>
                  </div>
                  <div className={cx(
                    "min-h-0 flex-1",
                    activeTab === "sources" ? "flex overflow-hidden" : "overflow-y-auto p-2 brevyn-scrollbar",
                  )}>
                    {activeTab === "sources" ? (
                      <SourcesRail
                        embedded
                        semester={semester}
                        course={course}
                        activeTask={activeTask}
                        files={files}
                        onPreviewFile={selectFileForPreview}
                      />
                    ) : activeTab === "context" ? (
                      <SessionFilesSection
                        sessionFiles={sessionFiles}
                        selectedFileId={selectedFileId}
                        collapsedFolderIds={collapsedFolderIds}
                        expandedEmptyFolderIds={expandedEmptyFolderIds}
                        onSelectFile={selectSessionFileForPreview}
                        onToggleFolder={toggleFolder}
                        onToggleEmptyFolder={toggleEmptyFolder}
                        onContextMenu={ignoreSessionContextMenu}
                      />
                    ) : null}
                    {activeTab !== "sources" && loading && files.length === 0 ? (
                      <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed bg-background/60 px-3 py-5 text-center text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        正在加载课程文件...
                      </div>
                    ) : activeTab !== "sources" && files.length === 0 ? (
                      <div className="rounded-lg border border-dashed bg-background/60 px-3 py-5 text-center text-xs text-muted-foreground">还没有课程文件。</div>
                    ) : activeTab === "context" ? (
                      <ContextFileSections
                        sections={contextSections}
                        selectedFileId={selectedFileId}
                        collapsedFolderIds={collapsedFolderIds}
                        expandedEmptyFolderIds={expandedEmptyFolderIds}
                        onSelectFile={selectFileForPreview}
                        onToggleFolder={toggleFolder}
                        onToggleEmptyFolder={toggleEmptyFolder}
                        onContextMenu={contextMenuForFile}
                      />
                    ) : activeTab === "tree" ? (
                      <div className="space-y-0.5">
                        {files.map((file) => (
                          <FileTreeNode
                            key={file.id}
                            node={file}
                            level={0}
                            selectedFileId={selectedFileId}
                            collapsedFolderIds={collapsedFolderIds}
                            expandedEmptyFolderIds={expandedEmptyFolderIds}
                            onSelect={selectFileForPreview}
                            onToggleFolder={toggleFolder}
                            onToggleEmptyFolder={toggleEmptyFolder}
                            onContextMenu={contextMenuForFile}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </aside>
              </div>
            </div>
      </div>
    </div>
  );
}

type ContextFileSection = {
  id: string;
  title: string;
  subtitle: string;
  emptyLabel: string;
  nodes: WorkspaceFileNode[];
};

const FILE_RAIL_BROWSER_COLLAPSED_KEY = "brevyn.files.rail.browserCollapsed";
const FILE_RAIL_COLLAPSED_FOLDERS_PREFIX = "brevyn.files.rail.collapsedFolders";

function FileRailViewButton({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className={cx(
        "inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded-md px-1.5 text-[10px] font-medium transition",
        active ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      onClick={onClick}
      title={label}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function SessionFilesSection({
  sessionFiles,
  selectedFileId,
  collapsedFolderIds,
  expandedEmptyFolderIds,
  onSelectFile,
  onToggleFolder,
  onToggleEmptyFolder,
  onContextMenu,
}: {
  sessionFiles?: WorkspaceFileNode[];
  selectedFileId: string;
  collapsedFolderIds: Set<string>;
  expandedEmptyFolderIds: Set<string>;
  onSelectFile: (file: WorkspaceFileNode) => void;
  onToggleFolder: (folderId: string) => void;
  onToggleEmptyFolder: (folderId: string) => void;
  onContextMenu: (event: MouseEvent, file: WorkspaceFileNode) => void;
}) {
  const count = (sessionFiles || []).reduce((total, node) => total + countLeafFiles(node), 0);

  return (
    <section className="mb-3 space-y-1.5">
      <div className="flex min-w-0 items-center justify-between gap-2 px-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold text-foreground">
          <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">会话文件</span>
        </div>
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{count}</span>
      </div>
      {sessionFiles && sessionFiles.length > 0 ? (
        <div className="space-y-0.5">
          {sessionFiles.map((file) => (
            <FileTreeNode
              key={file.id}
              node={file}
              level={0}
              selectedFileId={selectedFileId}
              collapsedFolderIds={collapsedFolderIds}
              expandedEmptyFolderIds={expandedEmptyFolderIds}
              onSelect={onSelectFile}
              onToggleFolder={onToggleFolder}
              onToggleEmptyFolder={onToggleEmptyFolder}
              onContextMenu={onContextMenu}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-dashed bg-card/45 px-3 py-3 text-center text-[11px] leading-5 text-muted-foreground">
          在对话中添加附件后，会显示在这里。
        </div>
      )}
    </section>
  );
}

function ContextFileSections({
  sections,
  selectedFileId,
  collapsedFolderIds,
  expandedEmptyFolderIds,
  onSelectFile,
  onToggleFolder,
  onToggleEmptyFolder,
  onContextMenu,
}: {
  sections: ContextFileSection[];
  selectedFileId: string;
  collapsedFolderIds: Set<string>;
  expandedEmptyFolderIds: Set<string>;
  onSelectFile: (file: WorkspaceFileNode) => void;
  onToggleFolder: (folderId: string) => void;
  onToggleEmptyFolder: (folderId: string) => void;
  onContextMenu: (event: MouseEvent, file: WorkspaceFileNode) => void;
}) {
  return (
    <div className="space-y-3">
      {sections.map((section) => {
        const fileCount = section.nodes.reduce((count, node) => count + countLeafFiles(node), 0);
        return (
          <section key={section.id} className="space-y-1.5">
            <div className="flex min-w-0 items-center gap-2 px-1">
              <div className="h-px flex-1 bg-border/70" />
              <div className="min-w-0 text-center">
                <div className="truncate text-[11px] font-semibold text-foreground">{section.title}</div>
                <div className="truncate text-[10px] text-muted-foreground">
                  {section.subtitle} · {fileCount} 个文件
                </div>
              </div>
              <div className="h-px flex-1 bg-border/70" />
            </div>
            {section.nodes.length > 0 ? (
              <div className="space-y-0.5">
                {section.nodes.map((file) => (
                  <FileTreeNode
                    key={file.id}
                    node={file}
                    level={0}
                    selectedFileId={selectedFileId}
                    collapsedFolderIds={collapsedFolderIds}
                    expandedEmptyFolderIds={expandedEmptyFolderIds}
                    onSelect={onSelectFile}
                    onToggleFolder={onToggleFolder}
                    onToggleEmptyFolder={onToggleEmptyFolder}
                    onContextMenu={onContextMenu}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-dashed bg-background/55 px-3 py-3 text-center text-[11px] leading-5 text-muted-foreground">
                {section.emptyLabel}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function buildContextSections(files: WorkspaceFileNode[], course?: Course, activeTask?: BrevynTask): ContextFileSection[] {
  const roots = courseRootChildren(files);
  const sharedFolder = roots.find((node) => node.kind === "folder" && node.sectionKind === "course_shared");
  const lectureFolder = roots.find((node) => node.kind === "folder" && node.sectionKind === "lecture");
  const taskFolders = findTaskFolders(roots);

  if (course?.workspaceKind === "semester_home") {
    const semesterSharedNodes = visibleChildren(sharedFolder);
    const courseRoots = roots.filter((node) => node.kind === "folder" && node.courseId !== course.id && node.sectionKind !== "course_shared");
    return [
      {
        id: "semester-shared",
        title: "学期资料",
        subtitle: "当前学期",
        emptyLabel: "还没有学期资料。",
        nodes: semesterSharedNodes,
      },
      {
        id: "semester-courses",
        title: "课程文件",
        subtitle: "当前学期",
        emptyLabel: "当前学期还没有课程文件。",
        nodes: courseRoots,
      },
    ];
  }

  if (activeTask) {
    const activeTaskFolder = taskFolders.find((node) => node.taskId === activeTask.id);
    return [
      {
        id: `task-${activeTask.id}`,
        title: activeTask.title || "当前任务",
        subtitle: "当前任务文件",
        emptyLabel: "这个任务还没有材料、草稿或提交文件。",
        nodes: visibleChildren(activeTaskFolder),
      },
      {
        id: "course-shared",
        title: "课程共享",
        subtitle: course?.name || "当前课程",
        emptyLabel: "还没有课程共享文件。",
        nodes: visibleChildren(sharedFolder),
      },
      {
        id: "lecture",
        title: "课件",
        subtitle: "Lecture",
        emptyLabel: "还没有课件文件。",
        nodes: visibleChildren(lectureFolder),
      },
    ];
  }

  return [
    {
      id: "course-shared",
      title: "课程共享",
      subtitle: course?.name || "当前课程",
      emptyLabel: "还没有课程共享文件。",
      nodes: visibleChildren(sharedFolder),
    },
    {
      id: "lecture",
      title: "课件",
      subtitle: "Lecture",
      emptyLabel: "还没有课件文件。",
      nodes: visibleChildren(lectureFolder),
    },
    {
      id: "tasks",
      title: "任务文件",
      subtitle: "按任务分组",
      emptyLabel: "当前课程还没有任务文件。",
      nodes: taskFolders,
    },
  ];
}

function courseRootChildren(files: WorkspaceFileNode[]): WorkspaceFileNode[] {
  if (files.length === 1 && files[0]?.kind === "folder") return files[0].children || [];
  return files;
}

function visibleChildren(node?: WorkspaceFileNode): WorkspaceFileNode[] {
  return node?.children || [];
}

function findTaskFolders(nodes: WorkspaceFileNode[]): WorkspaceFileNode[] {
  const result: WorkspaceFileNode[] = [];
  for (const node of nodes) {
    if (node.kind === "folder" && node.taskId && !node.taskFileBucket) result.push(node);
    if (node.children) result.push(...findTaskFolders(node.children));
  }
  return result;
}

function readStoredBrowserCollapsed(): boolean {
  try {
    return window.localStorage.getItem(FILE_RAIL_BROWSER_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function storeBrowserCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(FILE_RAIL_BROWSER_COLLAPSED_KEY, collapsed ? "true" : "false");
  } catch {
    // View preference storage is best effort only.
  }
}

function fileCollapseScopeKey(courseId?: string, taskId?: string): string {
  return `${FILE_RAIL_COLLAPSED_FOLDERS_PREFIX}:${courseId || "workspace"}:${taskId || "course"}`;
}

function readStoredCollapsedFolderIds(scopeKey: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(scopeKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : []);
  } catch {
    return new Set();
  }
}

function storeCollapsedFolderIds(scopeKey: string, folderIds: Set<string>): void {
  try {
    window.localStorage.setItem(scopeKey, JSON.stringify(Array.from(folderIds)));
  } catch {
    // View preference storage is best effort only.
  }
}

function RenameFileDialog({
  file,
  onClose,
  onRename,
}: {
  file: WorkspaceFileNode;
  onClose: () => void;
  onRename: (name: string) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(file.name);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();
  const unchanged = trimmed === file.name;
  const canSave = Boolean(trimmed) && !unchanged && !saving;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function submit() {
    if (!canSave) return;
    setSaving(true);
    setError("");
    try {
      await onRename(trimmed);
    } catch (renameError) {
      setError(renameError instanceof Error ? renameError.message : "重命名失败。");
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-foreground/20 p-6 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className="w-full max-w-sm rounded-xl border border-border/80 bg-card text-foreground shadow-2xl ring-1 ring-border/70"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">重命名</div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{fileDisplayName(file)}</div>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 items-center justify-center rounded-md border bg-background/70 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            onClick={onClose}
            title="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 px-4 py-4">
          <input
            ref={inputRef}
            className="h-9 w-full rounded-md border bg-background px-3 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {error && <div className="rounded-md bg-red-50 px-3 py-2 text-[11px] leading-4 text-red-700">{error}</div>}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center rounded-md border bg-card px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={onClose}
            >
              取消
            </button>
            <button
              type="button"
              className={cx("inline-flex h-8 items-center rounded-md bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90", !canSave && "cursor-not-allowed opacity-55")}
              disabled={!canSave}
              onClick={() => void submit()}
            >
              {saving ? "正在保存..." : "重命名"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function countLeafFiles(node: WorkspaceFileNode): number {
  if (node.kind !== "folder") return 1;
  return (node.children || []).reduce((count, child) => count + countLeafFiles(child), 0);
}

function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "").trim();
  return message || fallback;
}

function isActiveIndexingDeleteError(error: unknown): boolean {
  const message = errorMessage(error, "");
  return message.includes("正在进入知识库") || message.includes("Wait for indexing to finish before deleting this file");
}
