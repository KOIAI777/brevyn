import { AlertCircle, FolderOpen, Loader2, RefreshCw, SquarePlus } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentAttachment, AgentPermissionMode, AppCodeThemePreference, AppTheme, AppThemeState, BrevynTask, ContextAnchor, FilePreview, UserProfileSettings, WorkspaceFileNode } from "@/types/domain";
import { CourseDashboard } from "@/components/courses/CourseDashboard";
import { ORGANIZE_COURSE_TASK_INFO_PROMPT, ORGANIZE_COURSE_TASK_INFO_REQUEST } from "@/components/courses/CourseTaskInfo";
import { SemesterDashboard } from "@/components/courses/SemesterDashboard";
import { WorkspaceOnboardingDashboard } from "@/components/courses/WorkspaceOnboardingDashboard";
import { AppTitleBar } from "@/components/shell/AppTitleBar";
import { TopBar } from "@/components/shell/TopBar";
import { WorkspaceDock } from "@/components/shell/WorkspaceDock";
import { WorkspaceSidebar } from "@/components/shell/WorkspaceSidebar";
import { useAgentSessionController, type AgentRunForThreadOptions } from "@/hooks/useAgentSessionController";
import { useWorkspaceLayoutState } from "@/hooks/useWorkspaceLayoutState";
import { useWorkspaceFilesState } from "@/hooks/useWorkspaceFilesState";
import type { FilePreviewLoadingFile, ParsedPreviewResult } from "@/hooks/useFilePreviewState";
import { SEMESTER_HOME_COURSE_ID, useWorkspaceSessionController } from "@/hooks/useWorkspaceSessionController";
import { useAppDialogState } from "@/hooks/useAppDialogState";
import { useWorkspacePreviewCoordinator } from "@/hooks/useWorkspacePreviewCoordinator";
import type { FileRailViewMode } from "@/components/files/FileBrowserRail";
import type { FilePathPreviewHandler, FilePreviewLocationTarget } from "@/components/chat/FilePathChip";
import { findFileNode } from "@/lib/workspace-files";
import { useAgentThreadListStatuses } from "@/lib/agent-live-store";

const AgentThreadPanel = lazy(() => import("@/components/agent/AgentThreadPanel").then((module) => ({ default: module.AgentThreadPanel })));
const CourseManagementDialog = lazy(() => import("@/components/courses/CourseManagementDialog").then((module) => ({ default: module.CourseManagementDialog })));
const CourseTaskInfoDialog = lazy(() => import("@/components/courses/CourseTaskInfoDialog").then((module) => ({ default: module.CourseTaskInfoDialog })));
const FileBrowserRail = lazy(() => import("@/components/files/FileBrowserRail").then((module) => ({ default: module.FileBrowserRail })));
const SettingsDialog = lazy(() => import("@/components/settings/SettingsDialog").then((module) => ({ default: module.SettingsDialog })));
const SourceCandidateToast = lazy(() => import("@/components/sources/SourceCandidateToast").then((module) => ({ default: module.SourceCandidateToast })));
const STARTUP_SPLASH_MIN_MS = import.meta.env.DEV ? 650 : 2400;
const STARTUP_SLOW_NOTICE_MS = 8_000;

function applyAppTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

function applyCodeTheme(preference: AppCodeThemePreference): void {
  document.documentElement.dataset.codeTheme = preference;
}

function applyFontSmoothing(enabled: boolean): void {
  document.documentElement.dataset.fontSmoothing = enabled ? "on" : "off";
}

function applyAppThemeState(state: AppThemeState): void {
  applyAppTheme(state.effective);
  applyCodeTheme(state.codeThemePreference);
  applyFontSmoothing(state.fontSmoothingEnabled);
  window.localStorage.setItem("brevyn.themePreference", state.preference);
  window.localStorage.setItem("brevyn.codeThemePreference", state.codeThemePreference);
  window.localStorage.setItem("brevyn.fontSmoothingEnabled", state.fontSmoothingEnabled ? "true" : "false");
}

function preferredRendererTheme(): AppTheme {
  const cachedPreference = window.localStorage.getItem("brevyn.themePreference");
  if (cachedPreference === "light" || cachedPreference === "dark") return cachedPreference;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function preferredRendererCodeTheme(): AppCodeThemePreference {
  const cachedPreference = window.localStorage.getItem("brevyn.codeThemePreference");
  if (cachedPreference === "brevyn" || cachedPreference === "github" || cachedPreference === "rose" || cachedPreference === "mono") return cachedPreference;
  return "brevyn";
}

function preferredRendererFontSmoothing(): boolean {
  return window.localStorage.getItem("brevyn.fontSmoothingEnabled") !== "false";
}

function quoteSelectionIdentity(quote: ContextAnchor): string {
  const source = quote.kind === "file" ? quote.filePath : `${quote.role}:${quote.label}`;
  return `${quote.kind}:${source}:${quote.text.trim()}`;
}

function readStoredFileRailActiveTab(): FileRailViewMode {
  try {
    const value = window.localStorage.getItem("brevyn.files.rail.viewMode");
    if (value === "tree" || value === "sources") return value;
    return "context";
  } catch {
    return "context";
  }
}

function storeFileRailActiveTab(tab: FileRailViewMode): void {
  try {
    window.localStorage.setItem("brevyn.files.rail.viewMode", tab);
  } catch {
    // Rail preference storage is best effort only.
  }
}

const MATERIALS_DOCK_TAB_STORAGE_KEY = "brevyn.workspaceDock.materialsOpen";

function readStoredMaterialsDockTabOpen(): boolean {
  try {
    return window.localStorage.getItem(MATERIALS_DOCK_TAB_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function storeMaterialsDockTabOpen(open: boolean): void {
  try {
    window.localStorage.setItem(MATERIALS_DOCK_TAB_STORAGE_KEY, open ? "true" : "false");
  } catch {
    // Dock tab storage is best effort only.
  }
}

interface WorkspaceDockEmptyTabState {
  id: string;
  kind: "empty";
}

interface WorkspaceDockMaterialsTabState {
  id: string;
  kind: "materials";
  viewMode: FileRailViewMode;
  selectedFileId: string;
  preview: FilePreview | null;
  previewTarget: FilePreviewLocationTarget | null;
  previewLoading: boolean;
  previewLoadingFile: FilePreviewLoadingFile | null;
}

type WorkspaceDockTabState = WorkspaceDockEmptyTabState | WorkspaceDockMaterialsTabState;

interface WorkspaceDockState {
  tabs: WorkspaceDockTabState[];
  activeTabId: string;
}

interface MaterialsPreviewRequest {
  selectedFileId: string;
  loading: boolean;
  loadingFile: FilePreviewLoadingFile | null;
  previewTarget?: FilePreviewLocationTarget | null;
  clearPreview?: boolean;
}

function createMaterialsDockTab(id: string): WorkspaceDockMaterialsTabState {
  return {
    id,
    kind: "materials",
    viewMode: readStoredFileRailActiveTab(),
    selectedFileId: "",
    preview: null,
    previewTarget: null,
    previewLoading: false,
    previewLoadingFile: null,
  };
}

function createInitialWorkspaceDockState(): WorkspaceDockState {
  const materialsOpen = readStoredMaterialsDockTabOpen();
  const tabs = materialsOpen ? [createMaterialsDockTab("materials-1")] : [];
  return {
    tabs,
    activeTabId: tabs[0]?.id || "",
  };
}

function createWorkspaceDockTabId(kind: "empty" | "materials"): string {
  return `${kind}-${crypto.randomUUID()}`;
}

function App() {
  const contentGridRef = useRef<HTMLDivElement | null>(null);
  const fileStateRef = useRef<ReturnType<typeof useWorkspaceFilesState> | null>(null);
  const agentSessionRef = useRef<ReturnType<typeof useAgentSessionController> | null>(null);
  const previewErrorTimeoutRef = useRef<number | null>(null);
  const previewErrorMessageRef = useRef("");
  const [quotedSelectionsByThread, setQuotedSelectionsByThread] = useState<Record<string, ContextAnchor[]>>({});
  const [editingTaskInfoId, setEditingTaskInfoId] = useState("");
  const organizingTaskIdsRef = useRef(new Set<string>());
  const [organizingTaskIds, setOrganizingTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [workspaceDockState, setWorkspaceDockState] = useState<WorkspaceDockState>(createInitialWorkspaceDockState);
  const workspaceDockStateRef = useRef(workspaceDockState);
  const previewRequestByDockTabRef = useRef(new Map<string, number>());
  const previewOwnerDockTabIdRef = useRef("");
  const [profile, setProfile] = useState<UserProfileSettings>({ displayName: "Brevyn User", avatarId: "🧑‍💻" });
  const [themeState, setThemeState] = useState<AppThemeState>({
    preference: "system",
    effective: preferredRendererTheme(),
    codeThemePreference: preferredRendererCodeTheme(),
    fontSmoothingEnabled: preferredRendererFontSmoothing(),
  });

  const dialogs = useAppDialogState();
  const layoutState = useWorkspaceLayoutState({ contentGridRef });
  workspaceDockStateRef.current = workspaceDockState;
  const commitWorkspaceDockState = useCallback((update: (current: WorkspaceDockState) => WorkspaceDockState) => {
    const next = update(workspaceDockStateRef.current);
    workspaceDockStateRef.current = next;
    setWorkspaceDockState(next);
    return next;
  }, []);
  const ensureActiveMaterialsDockTab = useCallback(() => {
    let materialsTabId = "";
    commitWorkspaceDockState((current) => {
      const activeTab = current.tabs.find((tab) => tab.id === current.activeTabId);
      if (activeTab?.kind === "materials") {
        materialsTabId = activeTab.id;
        return current;
      }
      if (activeTab?.kind === "empty") {
        materialsTabId = activeTab.id;
        return {
          tabs: current.tabs.map((tab) => tab.id === activeTab.id ? createMaterialsDockTab(tab.id) : tab),
          activeTabId: activeTab.id,
        };
      }
      materialsTabId = createWorkspaceDockTabId("materials");
      return {
        tabs: [...current.tabs, createMaterialsDockTab(materialsTabId)],
        activeTabId: materialsTabId,
      };
    });
    layoutState.setFileRailCollapsed(false);
    return materialsTabId;
  }, [commitWorkspaceDockState, layoutState.setFileRailCollapsed]);
  const openMaterialsDockTab = useCallback(() => {
    ensureActiveMaterialsDockTab();
  }, [ensureActiveMaterialsDockTab]);
  const addWorkspaceDockTab = useCallback(() => {
    const tabId = createWorkspaceDockTabId("empty");
    commitWorkspaceDockState((current) => ({
      tabs: [...current.tabs, { id: tabId, kind: "empty" }],
      activeTabId: tabId,
    }));
    layoutState.setFileRailCollapsed(false);
  }, [commitWorkspaceDockState, layoutState.setFileRailCollapsed]);
  const selectWorkspaceDockTab = useCallback((tabId: string) => {
    commitWorkspaceDockState((current) => current.tabs.some((tab) => tab.id === tabId)
      ? { ...current, activeTabId: tabId }
      : current);
  }, [commitWorkspaceDockState]);
  const closeWorkspaceDockTab = useCallback((tabId: string) => {
    previewRequestByDockTabRef.current.delete(tabId);
    if (previewOwnerDockTabIdRef.current === tabId) previewOwnerDockTabIdRef.current = "";
    commitWorkspaceDockState((current) => {
      const closingIndex = current.tabs.findIndex((tab) => tab.id === tabId);
      if (closingIndex < 0) return current;
      const tabs = current.tabs.filter((tab) => tab.id !== tabId);
      const nextActiveTab = tabs[Math.min(closingIndex, tabs.length - 1)];
      return {
        tabs,
        activeTabId: current.activeTabId === tabId ? (nextActiveTab?.id || "") : current.activeTabId,
      };
    });
  }, [commitWorkspaceDockState]);
  const updateMaterialsDockTab = useCallback((tabId: string, update: Partial<Omit<WorkspaceDockMaterialsTabState, "id" | "kind">>) => {
    commitWorkspaceDockState((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => tab.id === tabId && tab.kind === "materials"
        ? { ...tab, ...update }
        : tab),
    }));
  }, [commitWorkspaceDockState]);
  const selectFileRailActiveTab = useCallback((tab: FileRailViewMode) => {
    const activeTabId = workspaceDockStateRef.current.activeTabId;
    updateMaterialsDockTab(activeTabId, { viewMode: tab });
    storeFileRailActiveTab(tab);
  }, [updateMaterialsDockTab]);

  useEffect(() => {
    storeMaterialsDockTabOpen(workspaceDockState.tabs.some((tab) => tab.kind === "materials"));
  }, [workspaceDockState.tabs]);
  const workspace = useWorkspaceSessionController({
    onClearFiles: () => fileStateRef.current?.clearFileState(),
    onReloadCourseFiles: (courseId) => {
      void fileStateRef.current?.loadCourseFiles(courseId);
    },
    onRefreshAgentProviders: () => {
      void agentSessionRef.current?.refreshProviders();
    },
  });
  const agentThreadStatuses = useAgentThreadListStatuses();
  const runningTaskIds = useMemo(() => {
    const taskIds = new Set<string>();
    for (const thread of workspace.threads) {
      if (thread.taskId && agentThreadStatuses.get(thread.id)?.kind === "running") taskIds.add(thread.taskId);
    }
    return taskIds;
  }, [agentThreadStatuses, workspace.threads]);
  const busyTaskIds = useMemo(
    () => new Set([...runningTaskIds, ...organizingTaskIds]),
    [organizingTaskIds, runningTaskIds],
  );
  const editingTaskInfo = useMemo(() => {
    if (!editingTaskInfoId) return undefined;
    for (const tasks of Object.values(workspace.tasksByCourse)) {
      const task = tasks.find((item) => item.id === editingTaskInfoId);
      if (task) return task;
    }
    return undefined;
  }, [editingTaskInfoId, workspace.tasksByCourse]);
  const setPreviewWorkspaceError = useCallback((message: string) => {
    if (previewErrorTimeoutRef.current !== null) {
      window.clearTimeout(previewErrorTimeoutRef.current);
      previewErrorTimeoutRef.current = null;
    }
    if (!message) {
      const currentPreviewError = previewErrorMessageRef.current;
      if (currentPreviewError) {
        workspace.setWorkspaceError((current) => current === currentPreviewError ? "" : current);
        previewErrorMessageRef.current = "";
      }
      return;
    }
    previewErrorMessageRef.current = message;
    workspace.setWorkspaceError(message);
    previewErrorTimeoutRef.current = window.setTimeout(() => {
      workspace.setWorkspaceError((current) => current === message && previewErrorMessageRef.current === message ? "" : current);
      if (previewErrorMessageRef.current === message) previewErrorMessageRef.current = "";
      previewErrorTimeoutRef.current = null;
    }, 4200);
  }, [workspace.setWorkspaceError]);
  const fileState = useWorkspaceFilesState({
    semesterId: workspace.semester?.id || "",
    activeCourseId: workspace.activeCourseId,
    activeThreadId: workspace.activeThreadId,
    onError: workspace.setWorkspaceError,
    onPreviewError: setPreviewWorkspaceError,
  });
  const agentSession = useAgentSessionController({
    activeThreadId: workspace.activeThreadId,
    onThreadHasMessages: workspace.markThreadHasMessages,
    onThreadUpdated: workspace.applyThreadUpdate,
    onTaskUpdated: workspace.applyTaskUpdate,
  });
  const previewCoordinator = useWorkspacePreviewCoordinator({
    onRevealMaterials: openMaterialsDockTab,
    setFileRailActiveTab: selectFileRailActiveTab,
  });
  fileStateRef.current = fileState;
  agentSessionRef.current = agentSession;

  const runMaterialsPreview = useCallback(async <T,>(
    tabId: string,
    request: MaterialsPreviewRequest,
    operation: () => Promise<T>,
    succeeded: (result: T) => boolean,
  ): Promise<T> => {
    const requestId = (previewRequestByDockTabRef.current.get(tabId) || 0) + 1;
    previewRequestByDockTabRef.current.set(tabId, requestId);
    previewOwnerDockTabIdRef.current = tabId;
    updateMaterialsDockTab(tabId, {
      selectedFileId: request.selectedFileId,
      previewTarget: request.previewTarget ?? null,
      previewLoading: request.loading,
      previewLoadingFile: request.loadingFile,
      ...(request.clearPreview ? { preview: null } : {}),
    });
    const result = await operation();
    if (previewRequestByDockTabRef.current.get(tabId) !== requestId) return result;
    const currentFileState = fileStateRef.current;
    updateMaterialsDockTab(tabId, {
      selectedFileId: succeeded(result)
        ? (currentFileState?.selectedFileIdRef.current || request.selectedFileId)
        : request.selectedFileId,
      ...(succeeded(result) ? { preview: currentFileState?.filePreviewRef.current || null } : {}),
      previewLoading: false,
      previewLoadingFile: null,
    });
    return result;
  }, [updateMaterialsDockTab]);

  useEffect(() => {
    const ownerTabId = previewOwnerDockTabIdRef.current;
    if (!ownerTabId) return;
    commitWorkspaceDockState((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => {
        if (tab.kind !== "materials") return tab;
        const ownsPreviewRequest = tab.id === ownerTabId;
        const sharesCompletedPreview = !fileState.filePreviewLoading
          && Boolean(fileState.selectedFileId)
          && tab.selectedFileId === fileState.selectedFileId;
        if (!ownsPreviewRequest && !sharesCompletedPreview) return tab;
        return {
          ...tab,
          ...(ownsPreviewRequest ? {
            selectedFileId: fileState.selectedFileId,
            previewLoading: fileState.filePreviewLoading,
            previewLoadingFile: fileState.filePreviewLoadingFile,
          } : {}),
          ...(!fileState.filePreviewLoading ? { preview: fileState.filePreview } : {}),
        };
      }),
    }));
  }, [commitWorkspaceDockState, fileState.filePreview, fileState.filePreviewLoading, fileState.filePreviewLoadingFile, fileState.selectedFileId]);

  useEffect(() => {
    previewOwnerDockTabIdRef.current = "";
    previewRequestByDockTabRef.current.clear();
    commitWorkspaceDockState((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => tab.kind === "materials" ? {
        ...tab,
        selectedFileId: "",
        preview: null,
        previewTarget: null,
        previewLoading: false,
        previewLoadingFile: null,
      } : tab),
    }));
  }, [commitWorkspaceDockState, workspace.activeCourseId, workspace.activeThreadId, workspace.semester?.id]);

  const handleThemeStateChange = useCallback((state: AppThemeState) => {
    setThemeState(state);
    applyAppThemeState(state);
  }, []);

  useLayoutEffect(() => {
    let mounted = true;
    applyAppTheme(preferredRendererTheme());
    applyCodeTheme(preferredRendererCodeTheme());
    applyFontSmoothing(preferredRendererFontSmoothing());
    void window.brevyn.app.theme()
      .then((state) => {
        if (!mounted) return;
        handleThemeStateChange(state);
      })
      .catch(() => undefined);
    const unsubscribe = window.brevyn.app.onThemeChanged((state) => {
      if (!mounted) return;
      handleThemeStateChange(state);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [handleThemeStateChange]);

  useEffect(() => () => {
    if (previewErrorTimeoutRef.current !== null) {
      window.clearTimeout(previewErrorTimeoutRef.current);
      previewErrorTimeoutRef.current = null;
    }
    previewErrorMessageRef.current = "";
  }, []);

  useEffect(() => {
    let mounted = true;
    void window.brevyn.app.profile()
      .then((nextProfile) => {
        if (mounted) setProfile(nextProfile);
      })
      .catch(() => {
        if (mounted) setProfile({ displayName: "Brevyn User", avatarId: "🧑‍💻" });
      });
    return () => {
      mounted = false;
    };
  }, []);

  async function runAgent(prompt: string, permissionMode: AgentPermissionMode = "auto", attachments?: AgentAttachment[], providerSelection?: { providerId?: string; modelId?: string }, mentionedSkills?: string[]): Promise<void> {
    await agentSession.run(prompt, permissionMode, attachments, providerSelection, mentionedSkills);
  }

  async function runAgentForThread(threadId: string, prompt: string, permissionMode: AgentPermissionMode = "auto", attachments?: AgentAttachment[], providerSelection?: { providerId?: string; modelId?: string }, mentionedSkills?: string[], options?: AgentRunForThreadOptions): Promise<boolean> {
    return agentSession.runForThread(threadId, prompt, permissionMode, attachments, providerSelection, mentionedSkills, options);
  }

  async function stopAgent(): Promise<void> {
    await agentSession.stop();
  }

  async function approveAgent(requestId: string): Promise<void> {
    await agentSession.approve(requestId);
  }

  async function rejectAgent(requestId: string): Promise<void> {
    await agentSession.reject(requestId);
  }

  async function answerAgentQuestion(requestId: string, answers: Record<string, string>): Promise<void> {
    await agentSession.answerQuestion(requestId, answers);
  }

  async function resolveAgentExitPlan(requestId: string, decision: "approve" | "deny", feedback?: string): Promise<void> {
    await agentSession.resolveExitPlan(requestId, decision, feedback);
  }

  async function selectAgentProvider(providerSelection: string) {
    agentSession.selectProvider(providerSelection);
  }

  const openHomeSession = useCallback(() => {
    const homeThread = [...workspace.threads]
      .filter((thread) => thread.courseId === SEMESTER_HOME_COURSE_ID && !thread.taskId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
    if (homeThread) {
      workspace.selectThread(homeThread);
      return;
    }
    void workspace.createThread(SEMESTER_HOME_COURSE_ID);
  }, [workspace.createThread, workspace.selectThread, workspace.threads]);

  const organizeCourseTaskInfo = useCallback(async (task: BrevynTask) => {
    if (organizingTaskIdsRef.current.has(task.id) || runningTaskIds.has(task.id)) {
      workspace.setWorkspaceError("这个任务会话已有 Agent 正在运行，请完成后再整理任务信息。");
      return;
    }
    organizingTaskIdsRef.current.add(task.id);
    setOrganizingTaskIds(new Set(organizingTaskIdsRef.current));
    try {
      const existingThread = [...workspace.threads]
        .filter((thread) => thread.courseId === task.courseId && thread.taskId === task.id && !thread.archivedAt)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
      const thread = existingThread || await workspace.createThread(task.courseId, task.id);
      if (!thread) return;
      if (existingThread) workspace.selectThread(existingThread);
      const started = await agentSession.runForThread(
        thread.id,
        ORGANIZE_COURSE_TASK_INFO_PROMPT,
        "auto",
        undefined,
        undefined,
        undefined,
        { displayPrompt: ORGANIZE_COURSE_TASK_INFO_REQUEST, skipAutoTitle: true },
      );
      if (!started) workspace.setWorkspaceError("这个任务会话已有 Agent 正在运行，请完成后再整理任务信息。");
    } catch (error) {
      workspace.setWorkspaceError(error instanceof Error ? error.message : "课程任务信息整理失败。");
    } finally {
      organizingTaskIdsRef.current.delete(task.id);
      setOrganizingTaskIds(new Set(organizingTaskIdsRef.current));
    }
  }, [agentSession.runForThread, runningTaskIds, workspace.createThread, workspace.selectThread, workspace.setWorkspaceError, workspace.threads]);

  const previewInlineFilePath = useCallback<FilePathPreviewHandler>(async (target): Promise<void> => {
    const locationTarget = typeof target === "string" ? { path: target, sourcePath: target } : target;
    const filePath = locationTarget.sourcePath || locationTarget.path || locationTarget.citation || "";
    const tabId = ensureActiveMaterialsDockTab();
    const opened = await runMaterialsPreview(
      tabId,
      {
        selectedFileId: locationTarget.fileId || filePath,
        loading: Boolean(locationTarget.fileId || filePath),
        loadingFile: null,
      },
      () => locationTarget.fileId
        ? fileState.previewSourceFile(locationTarget.fileId)
        : filePath
          ? fileState.previewWorkspacePath(filePath)
          : Promise.resolve(false),
      Boolean,
    );
    if (opened) {
      updateMaterialsDockTab(tabId, { previewTarget: locationTarget });
    }
  }, [ensureActiveMaterialsDockTab, fileState.previewSourceFile, fileState.previewWorkspacePath, runMaterialsPreview, updateMaterialsDockTab]);
  const previewWorkspaceFileInDockTab = useCallback((tabId: string, file: WorkspaceFileNode, sessionFile = false) => {
    previewCoordinator.revealSelectedFile(file.kind === "folder" ? "folder" : "file");
    return runMaterialsPreview(
      tabId,
      {
        selectedFileId: file.id,
        loading: file.kind !== "folder",
        loadingFile: file.kind === "folder" ? null : previewLoadingFileFromNode(file, sessionFile),
        clearPreview: file.kind === "folder",
      },
      () => sessionFile ? fileState.selectSessionFile(file) : fileState.selectFile(file),
      Boolean,
    );
  }, [fileState.selectFile, fileState.selectSessionFile, previewCoordinator, runMaterialsPreview]);
  const previewParsedWorkspaceFileInDockTab = useCallback((tabId: string, file: { id: string; updatedAt?: string }) => {
    previewCoordinator.revealSelectedFile("file");
    return runMaterialsPreview(
      tabId,
      {
        selectedFileId: `${file.id}:parsed`,
        loading: true,
        loadingFile: { id: file.id, name: "解析文本", path: "", kind: "markdown" },
      },
      () => fileState.previewParsedFile(file),
      (result: ParsedPreviewResult) => result.ok,
    );
  }, [fileState.previewParsedFile, previewCoordinator, runMaterialsPreview]);
  const previewSourceFileInDockTab = useCallback((tabId: string, fileId: string) => runMaterialsPreview(
    tabId,
    {
      selectedFileId: fileId,
      loading: true,
      loadingFile: { id: fileId, name: "原文预览", path: "", kind: "text" },
    },
    () => fileState.previewSourceFile(fileId),
    Boolean,
  ), [fileState.previewSourceFile, runMaterialsPreview]);

  useEffect(() => {
    const tabId = workspaceDockStateRef.current.activeTabId;
    const tab = workspaceDockStateRef.current.tabs.find((item) => item.id === tabId);
    const currentFileState = fileStateRef.current;
    if (!tabId || tab?.kind !== "materials" || !tab.selectedFileId || !currentFileState) return;
    if (previewOwnerDockTabIdRef.current === tabId && currentFileState.selectedFileIdRef.current === tab.selectedFileId) return;

    const parsedPreview = tab.selectedFileId.endsWith(":parsed");
    const sourceFileId = parsedPreview ? tab.selectedFileId.slice(0, -":parsed".length) : tab.selectedFileId;
    const courseFile = findFileNode(currentFileState.fileTree, sourceFileId);
    const sessionFile = findFileNode(currentFileState.sessionFiles, sourceFileId);
    const file = courseFile || sessionFile;
    if (!file || file.kind === "folder") return;

    if (parsedPreview) {
      void runMaterialsPreview(
        tabId,
        {
          selectedFileId: tab.selectedFileId,
          loading: true,
          loadingFile: { id: file.id, name: "解析文本", path: file.path, kind: "markdown" },
          previewTarget: tab.previewTarget,
        },
        () => currentFileState.previewParsedFile(file),
        (result: ParsedPreviewResult) => result.ok,
      );
      return;
    }

    void runMaterialsPreview(
      tabId,
      {
        selectedFileId: file.id,
        loading: true,
        loadingFile: previewLoadingFileFromNode(file, Boolean(sessionFile)),
        previewTarget: tab.previewTarget,
      },
      () => sessionFile ? currentFileState.selectSessionFile(file) : currentFileState.selectFile(file),
      Boolean,
    );
  }, [runMaterialsPreview, workspaceDockState.activeTabId]);

  const activeQuotedSelections = workspace.activeThreadId ? quotedSelectionsByThread[workspace.activeThreadId] || [] : [];
  const addQuotedSelection = useCallback((quote: ContextAnchor) => {
    setQuotedSelectionsByThread((current) => {
      const existing = current[quote.threadId] || [];
      const alreadyAdded = existing.some((item) => quoteSelectionIdentity(item) === quoteSelectionIdentity(quote));
      if (alreadyAdded) return current;
      return {
        ...current,
        [quote.threadId]: [...existing, quote],
      };
    });
  }, []);
  const removeActiveQuotedSelection = useCallback((quoteId?: string) => {
    const threadId = workspace.activeThreadId;
    if (!threadId) return;
    setQuotedSelectionsByThread((current) => {
      const existing = current[threadId] || [];
      if (existing.length === 0) return current;
      const next = { ...current };
      if (!quoteId) {
        delete next[threadId];
        return next;
      }
      const remaining = existing.filter((quote) => quote.id !== quoteId);
      if (remaining.length > 0) next[threadId] = remaining;
      else delete next[threadId];
      return next;
    });
  }, [workspace.activeThreadId]);
  const activeWorkspaceDockTab = workspaceDockState.tabs.find((tab) => tab.id === workspaceDockState.activeTabId);
  const workspaceBooting = workspace.bootState === "loading";
  const showWorkspaceOnboarding = !workspaceBooting && (workspace.noActiveSemesters || workspace.needsSemesterSelection);

  useEffect(() => {
    if (workspace.bootState === "loading") {
      const timeout = window.setTimeout(() => {
        document.getElementById("brevyn-startup-splash")?.setAttribute("data-slow", "true");
      }, STARTUP_SLOW_NOTICE_MS);
      return () => window.clearTimeout(timeout);
    }
    const splash = document.getElementById("brevyn-startup-splash");
    if (!splash) return;
    const removeSplash = () => splash.remove();
    const hideSplash = () => {
      splash.dataset.state = "leaving";
      window.setTimeout(removeSplash, 320);
    };
    if (workspace.bootState === "error") {
      hideSplash();
      return;
    }
    const shownAt = typeof window.__BREVYN_STARTUP_SPLASH_SHOWN_AT__ === "number" ? window.__BREVYN_STARTUP_SPLASH_SHOWN_AT__ : Date.now();
    const delay = Math.max(0, STARTUP_SPLASH_MIN_MS - (Date.now() - shownAt));
    let firstFrame = 0;
    let secondFrame = 0;
    const timeout = window.setTimeout(() => {
      firstFrame = window.requestAnimationFrame(() => {
        secondFrame = window.requestAnimationFrame(hideSplash);
      });
    }, delay);
    return () => {
      window.clearTimeout(timeout);
      if (firstFrame) window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [workspace.bootState]);

  if (workspace.bootState === "error") {
    return <AppBootErrorScreen error={workspace.bootError} onRetry={() => void workspace.bootstrap()} />;
  }

  if (workspace.bootState === "loading") {
    return null;
  }

  return (
    <div className="brevyn-app-background flex h-full min-h-0 flex-col text-foreground">
      <AppTitleBar
        semester={workspace.semester}
        fileRailCollapsed={layoutState.fileRailCollapsed}
        onToggleFileRail={() => layoutState.setFileRailCollapsed((value) => !value)}
      />

      <div className="flex min-h-0 flex-1 gap-2 p-2">
        <WorkspaceSidebar
          collapsed={layoutState.sidebarCollapsed}
          width={layoutState.sidebarWidth}
          resizing={layoutState.sidebarResizing}
          profile={profile}
          courses={workspace.courses}
          tasksByCourse={workspace.tasksByCourse}
          threads={workspace.threads}
          activeCourseId={workspace.activeCourseId}
          activeTaskId={workspace.activeTask?.id}
          activeThreadId={workspace.activeThreadId}
          onToggle={() => layoutState.setSidebarCollapsed((value) => !value)}
          onSelectHome={workspace.selectCourseHome}
          onSelectTask={workspace.selectTask}
          onSelectThread={workspace.selectThread}
          onArchiveThread={(thread) => {
            void workspace.archiveThread(thread);
          }}
          onArchiveTask={workspace.archiveTask}
          emptyThreadIds={workspace.emptyThreadIds}
          onRenameThread={workspace.renameThread}
          onCreateThread={workspace.createThread}
          onOpenCourses={dialogs.openCourses}
          onOpenSettings={() => dialogs.openSettings()}
          onResizeStart={layoutState.startSidebarResize}
        />

        <div
          ref={contentGridRef}
          className={`grid min-h-0 min-w-0 flex-1 gap-0 ${layoutState.resizingRail || layoutState.windowResizing ? "" : "transition-[grid-template-columns] duration-[480ms] ease-[cubic-bezier(0.22,1,0.36,1)]"}`}
          style={{ gridTemplateColumns: layoutState.contentGridColumns }}
        >
          <main className="brevyn-panel-surface relative flex min-h-0 min-w-0 max-w-full flex-col overflow-hidden">
            <TopBar
              course={workspace.activeCourse}
              task={workspace.activeTask}
              thread={workspace.activeThread}
              workspaceScope={workspace.workspaceScope}
              taskInfoRunning={agentSession.running || Boolean(workspace.activeTask && busyTaskIds.has(workspace.activeTask.id))}
              onEditTaskInfo={(task) => setEditingTaskInfoId(task.id)}
              onOrganizeTaskInfo={(task) => void organizeCourseTaskInfo(task)}
            />
            <Suspense fallback={null}>
              <SourceCandidateToast
                course={workspace.activeCourse}
                activeTask={workspace.activeTask}
                activeThreadId={workspace.activeThreadId}
              />
            </Suspense>
            {workspace.workspaceError && (
              <div className="border-b border-[hsl(var(--status-warning)/0.22)] bg-[hsl(var(--status-warning)/0.11)] px-4 py-2 text-xs text-[hsl(var(--status-warning))]">
                {workspace.workspaceError}
              </div>
            )}

            <div className={`min-h-0 min-w-0 flex-1 overflow-hidden ${workspace.activeThread || (workspace.activeCourse && !workspace.activeTask) || showWorkspaceOnboarding ? "flex" : "flex items-center justify-center text-sm text-muted-foreground"}`}>
              {workspace.activeThread ? (
                <Suspense fallback={<PanelWarmupFallback label="Opening session" />}>
                  <AgentThreadPanel
                    thread={workspace.activeThread}
                    task={workspace.activeTask}
                    records={agentSession.records}
                    loading={agentSession.loading}
                    running={agentSession.running}
                    taskInfoRunning={agentSession.running || Boolean(workspace.activeTask && busyTaskIds.has(workspace.activeTask.id))}
                    error={agentSession.error}
                    onRun={runAgent}
                    onRunForThread={runAgentForThread}
                    onUpdateThreadWorkflow={workspace.updateThreadWorkflow}
                    onForkThread={workspace.forkThread}
                    onStop={stopAgent}
                    onApprove={approveAgent}
                    onReject={rejectAgent}
                    onAnswerQuestion={answerAgentQuestion}
                    onResolveExitPlan={resolveAgentExitPlan}
                    agentProviders={agentSession.providers}
                    activeProviderId={agentSession.selectedProviderId}
                    onSelectProvider={selectAgentProvider}
                    files={fileState.fileTree}
                    skills={workspace.skills}
                    quotedSelections={activeQuotedSelections}
                    onRemoveQuotedSelection={removeActiveQuotedSelection}
                    onRestoreQuotedSelection={addQuotedSelection}
                    onPreviewFilePath={previewInlineFilePath}
                    onEditTaskInfo={(task) => setEditingTaskInfoId(task.id)}
                    onOrganizeTaskInfo={(task) => void organizeCourseTaskInfo(task)}
                  />
                </Suspense>
              ) : workspace.activeCourse?.workspaceKind === "semester_home" ? (
                <SemesterDashboard
                  semester={workspace.semester}
                  homeCourse={workspace.activeCourse}
                  courses={workspace.courses}
                  tasksByCourse={workspace.tasksByCourse}
                  threads={workspace.threads}
                  stats={fileState.fileStats}
                  files={fileState.fileTree}
                  onOpenHomeSession={openHomeSession}
                  onOpenCourses={dialogs.openCourses}
                  onWorkspaceChanged={async () => {
                    await workspace.reloadWorkspace();
                  }}
                  onSelectCourse={workspace.selectCourseHome}
                  onSelectTask={workspace.selectTask}
                />
              ) : workspace.activeCourse?.workspaceKind === "course" && !workspace.activeTask ? (
                <CourseDashboard
                  course={workspace.activeCourse}
                  semester={workspace.semester}
                  tasks={workspace.tasksByCourse[workspace.activeCourse.id] || []}
                  threads={workspace.threads}
                  stats={fileState.fileStats}
                  files={fileState.fileTree}
                  onOpenTasks={dialogs.openCourses}
                  onSelectTask={workspace.selectTask}
                  onCreateThread={workspace.createThread}
                  onEditTaskInfo={(task) => setEditingTaskInfoId(task.id)}
                  onOrganizeTaskInfo={(task) => void organizeCourseTaskInfo(task)}
                  organizingTaskIds={organizingTaskIds}
                  busyTaskIds={busyTaskIds}
                />
              ) : showWorkspaceOnboarding ? (
                <WorkspaceOnboardingDashboard
                  mode={workspace.needsSemesterSelection ? "select-semester" : "no-semester"}
                  semesters={workspace.semesters}
                  onSelectSemester={workspace.selectSemester}
                  onOpenSemesterSettings={() => dialogs.openSettings("semesters")}
                  onOpenArchive={() => dialogs.openSettings("archive")}
                  onWorkspaceChanged={async () => {
                    await workspace.reloadWorkspace();
                  }}
                />
              ) : (
                <div className="flex flex-col items-center gap-3 text-center">
                  <div>
                    <p className="font-medium text-foreground">{workspace.threads.length === 0 ? "No active sessions yet." : "No session selected."}</p>
                    <p className="mt-1 text-xs text-muted-foreground">Workspace files are ready. Create a session when you want to start chatting.</p>
                  </div>
                  <button
                    type="button"
                    className="rounded-[var(--radius-control)] bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm ring-1 ring-black/[0.05] transition hover:bg-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={(!workspace.activeCourse?.id && !workspace.semester?.id) || Boolean(workspace.activeCourse && !workspace.activeTask)}
                    onClick={() => {
                      void workspace.createThread(workspace.activeCourse?.id || SEMESTER_HOME_COURSE_ID, workspace.activeTask?.id);
                    }}
                  >
                    {workspace.activeTask ? "Create task session" : !workspace.activeCourse ? "创建学期会话" : "Select a task to create session"}
                  </button>
                </div>
              )}
            </div>
          </main>

          <WorkspaceDock
            collapsed={layoutState.fileRailCollapsed}
            resizing={layoutState.resizingRail === "files"}
            width={layoutState.fileRailWidth}
            tabs={workspaceDockState.tabs.map((tab) => ({
              id: tab.id,
              label: tab.kind === "materials" ? "资料" : "新标签页",
              icon: tab.kind === "materials" ? FolderOpen : SquarePlus,
              closable: true,
            }))}
            activeTabId={workspaceDockState.activeTabId}
            onSelectTab={selectWorkspaceDockTab}
            onCloseTab={closeWorkspaceDockTab}
            onAddTab={addWorkspaceDockTab}
            onResizeStart={(event) => layoutState.startRailResize("files", event)}
          >
            {activeWorkspaceDockTab?.kind === "materials" ? (
              <Suspense fallback={<RailWarmupFallback />}>
                <FileBrowserRail
                  key={activeWorkspaceDockTab.id}
                  semester={workspace.semester}
                  course={workspace.activeCourse}
                  activeTask={workspace.activeTask}
                  stats={fileState.fileStats}
                  files={fileState.fileTree}
                  sessionFiles={fileState.sessionFiles}
                  loading={fileState.filesLoading}
                  selectedFileId={activeWorkspaceDockTab.selectedFileId}
                  activeTab={activeWorkspaceDockTab.viewMode}
                  preview={activeWorkspaceDockTab.preview}
                  previewTarget={activeWorkspaceDockTab.previewTarget}
                  previewLoading={activeWorkspaceDockTab.previewLoading}
                  previewLoadingFile={activeWorkspaceDockTab.previewLoadingFile}
                  threadId={workspace.activeThreadId}
                  onSelectFile={(file) => {
                    void previewWorkspaceFileInDockTab(activeWorkspaceDockTab.id, file);
                  }}
                  onPreviewParsedFile={(file) => {
                    void previewParsedWorkspaceFileInDockTab(activeWorkspaceDockTab.id, file);
                  }}
                  onPreviewSourceFile={(fileId) => previewSourceFileInDockTab(activeWorkspaceDockTab.id, fileId)}
                  onPreviewParsedFileById={(fileId) => previewParsedWorkspaceFileInDockTab(activeWorkspaceDockTab.id, { id: fileId })}
                  onSelectSessionFile={(file) => {
                    void previewWorkspaceFileInDockTab(activeWorkspaceDockTab.id, file, true);
                  }}
                  onAddQuotedSelection={addQuotedSelection}
                  onActiveTabChange={selectFileRailActiveTab}
                  onOpenUpload={() => {
                    if (workspace.activeCourse?.archivedAt) return;
                    dialogs.openCourses();
                  }}
                />
              </Suspense>
            ) : activeWorkspaceDockTab?.kind === "empty" ? (
              <WorkspaceDockEmptyState onOpenMaterials={openMaterialsDockTab} />
            ) : null}
          </WorkspaceDock>
        </div>
      </div>

      {dialogs.settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDialog
            initialPage={dialogs.settingsInitialPage}
            course={workspace.activeCourse}
            semester={workspace.semester}
            profile={profile}
            themeState={themeState}
            skills={workspace.skills}
            gitStatus={workspace.gitStatus}
            onProfileChange={setProfile}
            onThemeStateChange={handleThemeStateChange}
            onSkillsChange={workspace.setSkills}
            onWorkspaceChanged={async () => {
              await workspace.reloadWorkspace(workspace.activeThreadId);
              await agentSession.refreshProviders();
            }}
            onSelectSemester={workspace.selectSemester}
            onAgentProviderChanged={(providerSelection) => agentSession.refreshProviders(providerSelection)}
            onClose={() => {
              dialogs.closeSettings();
              void agentSession.refreshProviders();
            }}
          />
        </Suspense>
      )}
      {dialogs.coursesOpen && (
        <Suspense fallback={null}>
          <CourseManagementDialog
            semester={workspace.semester}
            courses={workspace.courses}
            activeCourseId={workspace.activeCourseId}
            onCourseCreated={workspace.handleCourseCreated}
            onCourseUpdated={workspace.handleCourseUpdated}
            onTaskCreated={workspace.handleTaskCreated}
            onTaskUpdated={workspace.handleTaskUpdated}
            onWorkspaceChanged={async () => {
              await workspace.reloadWorkspace();
            }}
            onClose={dialogs.closeCourses}
          />
        </Suspense>
      )}
      {editingTaskInfo && (
        <Suspense fallback={null}>
          <CourseTaskInfoDialog
            task={editingTaskInfo}
            onSaved={workspace.applyTaskUpdate}
            onClose={() => setEditingTaskInfoId("")}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;

function PanelWarmupFallback({ label }: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-foreground">
      <div className="flex items-center gap-2 rounded-[var(--radius-control)] bg-background/72 px-3 py-2 text-xs text-muted-foreground shadow-sm ring-1 ring-black/[0.04] dark:bg-white/[0.045] dark:ring-white/[0.06]">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {label}
      </div>
    </div>
  );
}

function RailWarmupFallback() {
  return (
    <div className="h-full w-full min-w-0 overflow-hidden">
      <div className="flex h-full min-h-0 flex-col p-3">
        <div className="h-4 w-20 rounded-full bg-muted/60" />
        <div className="mt-4 space-y-2">
          <div className="h-3 w-4/5 rounded-full bg-muted/45" />
          <div className="h-3 w-3/5 rounded-full bg-muted/35" />
        </div>
      </div>
    </div>
  );
}

function WorkspaceDockEmptyState({ onOpenMaterials }: { onOpenMaterials: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <button
        type="button"
        className="flex h-12 w-full max-w-sm items-center gap-3 rounded-md border border-border/70 bg-background/55 px-4 text-left text-sm font-medium text-foreground transition hover:bg-accent active:scale-[0.99]"
        onClick={onOpenMaterials}
      >
        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span>资料</span>
      </button>
    </div>
  );
}

function previewLoadingFileFromNode(file: WorkspaceFileNode, sessionFile: boolean): FilePreviewLoadingFile {
  return {
    id: file.id,
    name: file.name,
    path: file.path,
    sourcePath: sessionFile ? (file.sourcePath || file.path) : file.sourcePath,
    kind: file.kind,
  };
}

function AppBootErrorScreen({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="brevyn-app-background flex h-full min-h-screen items-center justify-center px-6 text-foreground">
      <div className="brevyn-window-surface w-full max-w-md p-6">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <AlertCircle className="h-4 w-4 text-[hsl(var(--status-warning))]" />
          Failed to load workspace
        </div>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Brevyn could not finish startup. Try again, and if it keeps happening we will need the error text below.
        </p>
        <div className="mt-4 rounded-[var(--radius-control)] bg-muted/35 px-3 py-2 text-[11px] leading-5 text-muted-foreground shadow-inner ring-1 ring-black/[0.04]">
          {error || "Unknown startup error."}
        </div>
        <button
          type="button"
          className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-foreground px-3 text-xs font-medium text-background transition hover:opacity-90 active:scale-[0.98]"
          onClick={onRetry}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
      </div>
    </div>
  );
}
