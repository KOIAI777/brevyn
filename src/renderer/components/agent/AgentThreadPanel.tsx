import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Check, ChevronDown, ClipboardCheck, Copy, FileText, GitBranch, Loader2, Presentation, ShieldAlert } from "lucide-react";
import { type AgentAttachment, type AgentPermissionMode, type BrevynAgentTimelineRecord, type BrevynTask, type ContextAnchor, type ModelProviderConfig, type SkillItem, type Thread, type WorkspaceFileNode } from "../../../types/domain";
import brevynAppIconUrl from "@/assets/brevyn-app-icon.png";
import { AgentComposer, type AgentStarterDraft } from "@/components/agent/AgentComposer";
import { AssistantTextBubble, CompactContextNote, PromptTooLongCard, ProviderErrorCard, ResolvedRuntimeNote, RetryRuntimeNote, StreamingMarkdownish, UserMessageBubble } from "@/components/agent/AgentMessageParts";
import { ProcessTimelinePanel as BaseProcessTimelinePanel } from "@/components/agent/AgentProcessTimeline";
import { UserMessageNavigator, type UserMessageNavItem } from "@/components/agent/UserMessageNavigator";
import { FilePathPreviewProvider, type FilePathPreviewHandler } from "@/components/chat/FilePathChip";
import type { ProcessEvent, RunSummary } from "@/components/agent/agentTimelineModel";
import {
  exitPlanSummary,
  isRuntimeRecord,
  messageAttachments,
  userText,
} from "@/components/agent/agentTimelineModel";
import { useAgentThreadPanelState } from "@/components/agent/useAgentThreadPanelState";
import { useAgentScrollState } from "@/components/agent/useAgentScrollState";
import type { AgentTimelineTurnEntry, AgentTimelineViewItem } from "@/components/agent/useAgentTimelineState";
import type { AgentRunForThreadOptions } from "@/hooks/useAgentSessionController";
import { AgentThreadIdContext } from "@/components/agent/AgentThreadContext";
import { ApprovalCard, AskUserCard, ExitPlanCard } from "@/components/agent/AgentRuntimeCards";
import { ToolGlyph, ToolTitle, ToolUseCard } from "@/components/agent/AgentToolRenderers";
import { ModelProviderIcon } from "@/lib/model-provider-logo";
import { CHAT_BODY_WIDTH_CLASS } from "@/components/agent/agentLayout";
import { createQuotedMessageSelection, MAX_QUOTED_SELECTION_CHARS } from "@/components/agent/quotedSelection";
import { CourseTaskInfoPanel } from "@/components/courses/CourseTaskInfo";

interface AgentThreadPanelProps {
  thread: Thread;
  task?: BrevynTask;
  records: BrevynAgentTimelineRecord[];
  loading: boolean;
  running: boolean;
  taskInfoRunning: boolean;
  error?: string;
  onRun: (prompt: string, permissionMode?: AgentPermissionMode, attachments?: AgentAttachment[], providerSelection?: { providerId?: string; modelId?: string }, mentionedSkills?: string[]) => Promise<void>;
  onRunForThread: (threadId: string, prompt: string, permissionMode?: AgentPermissionMode, attachments?: AgentAttachment[], providerSelection?: { providerId?: string; modelId?: string }, mentionedSkills?: string[], options?: AgentRunForThreadOptions) => Promise<boolean>;
  onUpdateThreadWorkflow: (threadId: string, workflow?: Thread["workflow"]) => Promise<Thread>;
  onForkThread: (threadId: string, upToMessageUuid: string) => Promise<Thread | null>;
  onStop: () => Promise<void>;
  onApprove: (requestId: string) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
  onAnswerQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
  onResolveExitPlan: (requestId: string, decision: "approve" | "deny", feedback?: string) => Promise<void>;
  agentProviders: ModelProviderConfig[];
  activeProviderId: string;
  onSelectProvider: (providerId: string) => Promise<void>;
  files: WorkspaceFileNode[];
  skills: SkillItem[];
  quotedSelections?: ContextAnchor[];
  onRemoveQuotedSelection?: (quoteId?: string) => void;
  onRestoreQuotedSelection?: (quote: ContextAnchor) => void;
  onPreviewFilePath?: FilePathPreviewHandler;
  onEditTaskInfo: (task: BrevynTask) => void;
  onOrganizeTaskInfo: (task: BrevynTask) => void;
}

export function AgentThreadPanel({
  thread,
  task,
  records,
  loading,
  running,
  taskInfoRunning,
  error,
  onRun,
  onRunForThread,
  onUpdateThreadWorkflow,
  onForkThread,
  onStop,
  onApprove,
  onReject,
  onAnswerQuestion,
  onResolveExitPlan,
  agentProviders,
  activeProviderId,
  onSelectProvider,
  files,
  skills,
  quotedSelections,
  onRemoveQuotedSelection,
  onRestoreQuotedSelection,
  onPreviewFilePath,
  onEditTaskInfo,
  onOrganizeTaskInfo,
}: AgentThreadPanelProps) {
  const [timelineReady, setTimelineReady] = useState(false);
  const [composerHeight, setComposerHeight] = useState(168);
  const [starterDraft, setStarterDraft] = useState<AgentStarterDraft | null>(null);
  const scrollApiRef = useRef({
    isFollowingOutput: true,
    scrollToBottom: (_behavior: ScrollBehavior) => {},
  });
  const handleAutoQueuedRunStarted = useCallback((targetThreadId: string) => {
    if (targetThreadId !== thread.id) return;
    if (!scrollApiRef.current.isFollowingOutput) return;
    window.requestAnimationFrame(() => scrollApiRef.current.scrollToBottom("auto"));
  }, [thread.id]);
  const {
    permissionMode,
    timelineRecords,
    timelineGroups,
    todos,
    contextUsage,
    effectiveRunning,
    effectiveCompacting,
    queuedMessages,
    sendingQueuedMessageIds,
    queueToastMessage,
    autoCompactThresholdPercent,
    scrollTransitioning,
    setPermissionMode,
    handleCompact,
    queueMessage,
    deleteQueuedMessage,
    sendQueuedMessage,
    toggleProcessCollapsed,
  } = useAgentThreadPanelState({
    thread,
    records,
    loading,
    running,
    error,
    agentProviders,
    activeProviderId,
    onRun,
    onRunForThread,
    onAutoQueuedRunStarted: handleAutoQueuedRunStarted,
  });
  useEffect(() => {
    setTimelineReady(false);
    setStarterDraft(null);
  }, [thread.id]);

  useEffect(() => {
    if (loading) {
      setTimelineReady(false);
      return;
    }
    if (timelineReady) return;
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      if (!cancelled) setTimelineReady(true);
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [loading, thread.id, timelineReady]);

  const handleRun = useCallback(async (
    prompt: string,
    nextPermissionMode: AgentPermissionMode = "auto",
    attachments?: AgentAttachment[],
    providerSelection?: { providerId?: string; modelId?: string },
    mentionedSkills?: string[],
  ): Promise<void> => {
    const shouldPushLayout = scrollApiRef.current.isFollowingOutput;
    const runPromise = onRun(prompt, nextPermissionMode, attachments, providerSelection, mentionedSkills);
    if (shouldPushLayout) {
      window.requestAnimationFrame(() => scrollApiRef.current.scrollToBottom("smooth"));
    }
    await runPromise;
  }, [onRun]);

  const handleScrollApiReady = useCallback((api: { isFollowingOutput: boolean; scrollToBottom: (behavior: ScrollBehavior) => void }) => {
    scrollApiRef.current = api;
  }, []);

  const handleToggleItemProcess = useCallback((item: AgentTimelineViewItem) => {
    toggleProcessCollapsed(item.processKey, item.defaultCollapsed, item.processLockedOpen);
  }, [toggleProcessCollapsed]);

  const handleCompactRequest = useCallback(() => {
    void handleCompact();
  }, [handleCompact]);

  const handleRequestAcademicCheck = useCallback(() => {
    void handleRun(academicGroundingCheckPrompt(), "auto");
  }, [handleRun]);

  const handleOrganizeTaskInfo = useCallback(() => {
    if (task) onOrganizeTaskInfo(task);
  }, [onOrganizeTaskInfo, task]);

  const handleEditTaskInfo = useCallback(() => {
    if (task) onEditTaskInfo(task);
  }, [onEditTaskInfo, task]);

  const handleApplyStarterDraft = useCallback((draft: Omit<AgentStarterDraft, "id">) => {
    setStarterDraft({
      id: `${thread.id}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      ...draft,
    });
    if (draft.skillSlug === "ppt-master") {
      void onUpdateThreadWorkflow(thread.id, pptWorkflow(draft.skillSlug, "planning"));
    }
    window.requestAnimationFrame(() => scrollApiRef.current.scrollToBottom("smooth"));
  }, [onUpdateThreadWorkflow, thread.id]);

  const handleExitWorkflow = useCallback(() => {
    void onUpdateThreadWorkflow(thread.id);
  }, [onUpdateThreadWorkflow, thread.id]);

  const handleStartWorkflow = useCallback((workflow: Thread["workflow"]) => {
    void onUpdateThreadWorkflow(thread.id, workflow);
  }, [onUpdateThreadWorkflow, thread.id]);

  return (
    <AgentThreadIdContext.Provider value={thread.id}>
    <FilePathPreviewProvider onPreviewFilePath={onPreviewFilePath}>
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[linear-gradient(180deg,hsl(var(--card)/0.92),hsl(var(--surface-warm)/0.84))]">
      <AgentTimelineScrollArea
        thread={thread}
        task={task}
        running={effectiveRunning || taskInfoRunning}
        loading={loading}
        timelineReady={timelineReady}
        scrollTransitioning={scrollTransitioning}
        timelineRecords={timelineRecords}
        timelineGroups={timelineGroups}
        agentProviders={agentProviders}
        onToggleItemProcess={handleToggleItemProcess}
        onApprove={onApprove}
        onReject={onReject}
        onAnswerQuestion={onAnswerQuestion}
        onResolveExitPlan={onResolveExitPlan}
        onCompact={handleCompactRequest}
        onForkThread={onForkThread}
        onRequestAcademicCheck={handleRequestAcademicCheck}
        onEditTaskInfo={handleEditTaskInfo}
        onOrganizeTaskInfo={handleOrganizeTaskInfo}
        skills={skills}
        onApplyStarterDraft={handleApplyStarterDraft}
        onScrollApiReady={handleScrollApiReady}
        onAddQuotedSelection={onRestoreQuotedSelection}
        bottomPadding={composerHeight + 24}
        scrollToBottomButtonBottom={composerHeight + 40}
      />

      {error && <div className="brevyn-status-card-warning px-5 py-2 text-xs text-foreground">{error}</div>}

      <AgentComposer
        todos={todos}
        queuedMessages={queuedMessages}
        sendingQueuedMessageIds={sendingQueuedMessageIds}
        queueToastMessage={queueToastMessage}
        running={effectiveRunning}
        permissionMode={permissionMode}
        contextUsage={contextUsage}
        autoCompactThresholdPercent={autoCompactThresholdPercent}
        compacting={effectiveCompacting}
        threadId={thread.id}
        agentProviders={agentProviders}
        activeProviderId={activeProviderId}
        onSetPermissionMode={setPermissionMode}
        onRun={handleRun}
        onQueueMessage={queueMessage}
        onSendQueuedMessage={sendQueuedMessage}
        onDeleteQueuedMessage={deleteQueuedMessage}
        onStop={onStop}
        onCompact={handleCompactRequest}
        onSelectProvider={onSelectProvider}
        files={files}
        skills={skills}
        starterDraft={starterDraft}
        workflow={thread.workflow}
        onExitWorkflow={handleExitWorkflow}
        onStartWorkflow={handleStartWorkflow}
        quotedSelections={quotedSelections}
        onRemoveQuotedSelection={onRemoveQuotedSelection}
        onRestoreQuotedSelection={onRestoreQuotedSelection}
        onHeightChange={setComposerHeight}
      />
    </section>
    </FilePathPreviewProvider>
    </AgentThreadIdContext.Provider>
  );
}

const AgentTimelineScrollArea = memo(function AgentTimelineScrollArea({
  thread,
  task,
  running,
  loading,
  timelineReady,
  scrollTransitioning,
  timelineRecords,
  timelineGroups,
  agentProviders,
  onToggleItemProcess,
  onApprove,
  onReject,
  onAnswerQuestion,
  onResolveExitPlan,
  onCompact,
  onForkThread,
  onRequestAcademicCheck,
  onEditTaskInfo,
  onOrganizeTaskInfo,
  skills,
  onApplyStarterDraft,
  onScrollApiReady,
  onAddQuotedSelection,
  bottomPadding,
  scrollToBottomButtonBottom,
}: {
  thread: Thread;
  task?: BrevynTask;
  running: boolean;
  loading: boolean;
  timelineReady: boolean;
  scrollTransitioning: boolean;
  timelineRecords: ReturnType<typeof useAgentThreadPanelState>["timelineRecords"];
  timelineGroups: ReturnType<typeof useAgentThreadPanelState>["timelineGroups"];
  agentProviders: ModelProviderConfig[];
  onToggleItemProcess: (item: AgentTimelineViewItem) => void;
  onApprove: (requestId: string) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
  onAnswerQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
  onResolveExitPlan: (requestId: string, decision: "approve" | "deny", feedback?: string) => Promise<void>;
  onCompact: () => void;
  onForkThread: (threadId: string, upToMessageUuid: string) => Promise<Thread | null>;
  onRequestAcademicCheck: () => void;
  onEditTaskInfo: () => void;
  onOrganizeTaskInfo: () => void;
  skills: SkillItem[];
  onApplyStarterDraft: (draft: Omit<AgentStarterDraft, "id">) => void;
  onScrollApiReady: (api: { isFollowingOutput: boolean; scrollToBottom: (behavior: ScrollBehavior) => void }) => void;
  onAddQuotedSelection?: (quote: ContextAnchor) => void;
  bottomPadding: number;
  scrollToBottomButtonBottom: number;
}) {
  const {
    scrollRef,
    contentRef,
    isFollowingOutput,
    scrollToBottom,
  } = useAgentScrollState(thread.id, {
    ready: !loading,
    transitioning: scrollTransitioning,
  });
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [messageSelectionPrompt, setMessageSelectionPrompt] = useState<MessageSelectionPromptState | null>(null);
  const userMessageNavItems = useMemo(() => {
    let userIndex = 0;
    return timelineGroups.flatMap((group): UserMessageNavItem[] => {
      if (group.type !== "user" || group.item.displayKind !== "user-message") return [];
      const message = group.item.record as SDKMessage;
      const preview = userNavigationPreview(userText(message), messageAttachments(message));
      if (!preview) return [];
      userIndex += 1;
      return [{
        id: userNavigationId(group.key),
        index: userIndex,
        preview,
      }];
    });
  }, [timelineGroups]);

  const handleScrollRef = useCallback((node: HTMLDivElement | null) => {
    setScrollElement(node);
    scrollRef(node);
  }, [scrollRef]);

  useEffect(() => {
    onScrollApiReady({ isFollowingOutput, scrollToBottom });
  }, [isFollowingOutput, onScrollApiReady, scrollToBottom]);

  const updateMessageSelectionPrompt = useCallback(() => {
    const container = scrollElement;
    if (!container || !onAddQuotedSelection) {
      setMessageSelectionPrompt(null);
      return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      setMessageSelectionPrompt(null);
      return;
    }
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode || !container.contains(anchorNode) || !container.contains(focusNode)) {
      setMessageSelectionPrompt(null);
      return;
    }
    const anchorRoleElement = closestQuoteMessageRoleElement(anchorNode);
    const focusRoleElement = closestQuoteMessageRoleElement(focusNode);
    if (!anchorRoleElement || anchorRoleElement !== focusRoleElement) {
      setMessageSelectionPrompt(null);
      return;
    }
    if (selectionHasInteractiveTarget(selection, anchorRoleElement)) {
      setMessageSelectionPrompt(null);
      return;
    }
    const text = selection.toString().replace(/\u00a0/g, " ").trim();
    if (!text) {
      setMessageSelectionPrompt(null);
      return;
    }
    const range = selection.getRangeAt(0);
    const rangeRect = range.getBoundingClientRect();
    if (!rangeRect.width && !rangeRect.height) {
      setMessageSelectionPrompt(null);
      return;
    }
    const role = anchorRoleElement.dataset.quoteMessageRole === "user" ? "user" : "assistant";
    const selectedText = text.slice(0, MAX_QUOTED_SELECTION_CHARS);
    const truncated = text.length > MAX_QUOTED_SELECTION_CHARS;
    const x = Math.min(Math.max(rangeRect.left + rangeRect.width / 2, 84), Math.max(84, window.innerWidth - 84));
    const y = Math.max(12, rangeRect.top - 44);
    setMessageSelectionPrompt({
      text: selectedText,
      role,
      truncated,
      x,
      y,
    });
  }, [onAddQuotedSelection, scrollElement]);

  useEffect(() => {
    if (!scrollElement || !onAddQuotedSelection) {
      setMessageSelectionPrompt(null);
      return undefined;
    }
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateMessageSelectionPrompt();
      });
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-quote-selection-action]")) return;
      setMessageSelectionPrompt(null);
    };
    scrollElement.addEventListener("mouseup", schedule);
    scrollElement.addEventListener("keyup", schedule);
    scrollElement.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("selectionchange", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scrollElement.removeEventListener("mouseup", schedule);
      scrollElement.removeEventListener("keyup", schedule);
      scrollElement.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("selectionchange", schedule);
    };
  }, [onAddQuotedSelection, scrollElement, updateMessageSelectionPrompt]);

  function addMessageSelectionToConversation() {
    if (!messageSelectionPrompt || !onAddQuotedSelection) return;
    onAddQuotedSelection(createQuotedMessageSelection({
      threadId: thread.id,
      text: messageSelectionPrompt.text,
      role: messageSelectionPrompt.role,
    }));
    setMessageSelectionPrompt(null);
    window.getSelection()?.removeAllRanges();
  }

  return (
    <>
      <div
        ref={handleScrollRef}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-5 pt-5 [overflow-anchor:none] [scrollbar-gutter:stable] brevyn-scrollbar"
        style={{ paddingBottom: bottomPadding }}
      >
        {messageSelectionPrompt && (
          <div
            className="fixed z-50 -translate-x-1/2"
            style={{ left: messageSelectionPrompt.x, top: messageSelectionPrompt.y }}
          >
            <button
              type="button"
              data-quote-selection-action
              className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border/70 bg-card/95 px-3 text-[12px] font-semibold text-foreground shadow-[0_12px_32px_rgba(35,31,24,0.18)] ring-1 ring-background/60 transition hover:-translate-y-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={addMessageSelectionToConversation}
              title={messageSelectionPrompt.truncated ? `已截断到 ${MAX_QUOTED_SELECTION_CHARS} 字` : "添加选中文本到对话"}
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              <span>添加到对话</span>
              {messageSelectionPrompt.truncated && <span className="text-[10px] text-muted-foreground">前 {MAX_QUOTED_SELECTION_CHARS} 字</span>}
            </button>
          </div>
        )}
        <div
          ref={contentRef}
          className={`min-h-full min-w-0 max-w-full ${timelineReady && !loading ? "opacity-100 transition-opacity duration-150" : "opacity-0"}`}
        >
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading session timeline
            </div>
          ) : timelineRecords.length === 0 ? (
            <EmptyThreadWelcome
              thread={thread}
              task={task}
              running={running}
              skills={skills}
              onApplyStarterDraft={onApplyStarterDraft}
              onEditTaskInfo={onEditTaskInfo}
              onOrganizeTaskInfo={onOrganizeTaskInfo}
            />
          ) : (
            <div className={`${CHAT_BODY_WIDTH_CLASS} flex min-w-0 flex-col gap-3`}>
              {timelineGroups.map((group) => (
                <div
                  key={group.key}
                  data-user-message-id={group.type === "user" ? userNavigationId(group.key) : undefined}
                  className="timeline-group min-w-0 w-full [contain:layout_paint_style]"
                >
                  <AgentTimelineGroup
                    group={group}
                    agentProviders={agentProviders}
                    onToggleItemProcess={onToggleItemProcess}
                    onApprove={onApprove}
                    onReject={onReject}
                    onAnswerQuestion={onAnswerQuestion}
                    onResolveExitPlan={onResolveExitPlan}
                    onCompact={onCompact}
                    onForkThread={onForkThread}
                    onRequestAcademicCheck={onRequestAcademicCheck}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <UserMessageNavigator
        key={thread.id}
        items={userMessageNavItems}
        scrollContainer={scrollElement}
        bottomOffset={scrollToBottomButtonBottom + 48}
        ready={timelineReady && !loading}
      />
      {!isFollowingOutput && (
        <button
          type="button"
          className="absolute right-8 z-30 inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/50 bg-card/95 text-muted-foreground shadow-[0_10px_28px_rgba(64,55,38,0.14)] ring-1 ring-border/50 transition hover:-translate-y-0.5 hover:bg-accent hover:text-foreground"
          style={{ bottom: scrollToBottomButtonBottom }}
          onClick={() => scrollToBottom("smooth")}
          title="回到底部"
          aria-label="回到底部"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      )}
    </>
  );
});

interface MessageSelectionPromptState {
  text: string;
  role: "user" | "assistant";
  truncated: boolean;
  x: number;
  y: number;
}

function closestQuoteMessageRoleElement(node: Node): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>("[data-quote-message-role]") || null;
}

function selectionHasInteractiveTarget(selection: Selection, root: HTMLElement): boolean {
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  if (!range) return false;
  const interactiveSelector = "button, input, textarea, select, [contenteditable='true'], [role='button'], a";
  const common = range.commonAncestorContainer instanceof HTMLElement
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  if (!common || !root.contains(common)) return false;
  if (common.closest(interactiveSelector)) return true;
  return Array.from(common.querySelectorAll(interactiveSelector)).some((node) => selection.containsNode(node, true));
}

function ProcessTimelinePanel({
  summary,
  expanded,
  lockedOpen,
  collapsible,
  onToggle,
}: {
  summary: RunSummary;
  expanded: boolean;
  lockedOpen: boolean;
  collapsible: boolean;
  onToggle: () => void;
}) {
  const displaySummary = useLiveRunSummary(summary);
  return (
    <BaseProcessTimelinePanel
      summary={displaySummary}
      expanded={expanded}
      lockedOpen={lockedOpen}
      collapsible={collapsible}
      onToggle={onToggle}
      runSummaryTone={runSummaryTone}
    />
  );
}

function useLiveRunSummary(summary: RunSummary): RunSummary {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!summary.running) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [summary.running, summary.runId]);

  if (!summary.running) return summary;
  if (summary.retryAttempt && summary.retryMaxRetries) {
    const remainingMs = Math.max(0, (summary.retryUntilMs ?? nowMs) - nowMs);
    const suffix = remainingMs > 0 ? ` · ${Math.ceil(remainingMs / 1000)}s 后重连` : "";
    return {
      ...summary,
      label: `正在重试 ${summary.retryAttempt}/${summary.retryMaxRetries}${suffix}`,
    };
  }
  if (!summary.startedAtMs || !summary.hasActivity || nowMs - summary.startedAtMs < 1000) return summary;
  return {
    ...summary,
    label: `已处理 ${formatRunDuration(nowMs - summary.startedAtMs)}`,
  };
}

function formatRunDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function userNavigationId(groupKey: string): string {
  return `user-nav-${groupKey}`;
}

function userNavigationPreview(value: string, attachments: AgentAttachment[] = []): string {
  const text = value
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/\s+/g, " ")
    .trim();
  const fallback = attachments.length > 0
    ? `附件：${attachments.map((attachment) => attachment.name).join("、")}`
    : "";
  const preview = text || fallback;
  if (preview.length <= 220) return preview;
  return `${preview.slice(0, 217)}...`;
}

function EmptyThreadWelcome({
  thread,
  task,
  running,
  skills,
  onApplyStarterDraft,
  onEditTaskInfo,
  onOrganizeTaskInfo,
}: {
  thread: Thread;
  task?: BrevynTask;
  running: boolean;
  skills: SkillItem[];
  onApplyStarterDraft: (draft: Omit<AgentStarterDraft, "id">) => void;
  onEditTaskInfo: () => void;
  onOrganizeTaskInfo: () => void;
}) {
  const welcome = homeWelcomeCopy(thread);
  const isHome = welcome.kind === "semester";
  const pptSkills = useMemo(() => pptStarterSkills(skills), [skills]);
  const defaultSkill = useMemo(() => defaultPptStarterSkill(pptSkills), [pptSkills]);
  const [showPptStarter, setShowPptStarter] = useState(false);
  const [showSkillPicker, setShowSkillPicker] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [skillCategory, setSkillCategory] = useState("all");
  const [selectedSkillSlug, setSelectedSkillSlug] = useState(() => defaultSkill?.slug || "");
  const [selectedPresetId, setSelectedPresetId] = useState("academic");

  useEffect(() => {
    if (selectedSkillSlug && pptSkills.some((skill) => skill.slug === selectedSkillSlug)) return;
    setSelectedSkillSlug(defaultSkill?.slug || "");
  }, [defaultSkill?.slug, pptSkills, selectedSkillSlug]);

  const selectedSkill = pptSkills.find((skill) => skill.slug === selectedSkillSlug) || defaultSkill;
  const selectedPreset = pptStarterPresets.find((preset) => preset.id === selectedPresetId) || pptStarterPresets[0];
  const skillCategories = useMemo(() => starterSkillCategories(pptSkills), [pptSkills]);
  const visibleSkills = useMemo(() => filterStarterSkills(pptSkills, skillQuery, skillCategory), [pptSkills, skillCategory, skillQuery]);

  function applyPptStarter() {
    onApplyStarterDraft({
      prompt: reportToPptStarterPrompt(selectedSkill?.slug || "ppt-master", selectedPreset),
      skillSlug: selectedSkill?.slug,
    });
    setShowPptStarter(false);
    setShowSkillPicker(false);
  }

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center py-12 text-center">
      <div className="flex h-24 w-24 items-center justify-center overflow-hidden rounded-[var(--radius-window)] bg-card shadow-[var(--shadow-panel)]">
        <img src={brevynAppIconUrl} alt="Brevyn" className="h-full w-full object-cover" />
      </div>
      <p className="mt-6 text-[15px] font-semibold tracking-[-0.02em] text-foreground">{welcome.greeting}</p>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{welcome.dateLabel}</p>
      {!isHome && task && (
        <div className="mt-6 w-full">
          <CourseTaskInfoPanel task={task} running={running} onEdit={onEditTaskInfo} onOrganize={onOrganizeTaskInfo} />
        </div>
      )}
      <div className="mt-3 w-full text-left">
        <button
          type="button"
          className="group flex w-full items-center gap-3 rounded-[var(--radius-panel)] border border-border/55 bg-background/68 p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/25 hover:bg-card hover:shadow-[0_14px_34px_rgba(64,55,38,0.12)]"
          onClick={() => setShowPptStarter((value) => !value)}
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-[hsl(var(--primary)/0.1)] text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.16)]">
            <Presentation className="h-4.5 w-4.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold tracking-[-0.01em] text-foreground">报告转 PPT</span>
            <span className="mt-1 block text-[12px] leading-5 text-muted-foreground">选择制作方式，先生成展示计划和素材清单。</span>
          </span>
          <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${showPptStarter ? "rotate-180" : ""}`} />
        </button>
        {showPptStarter && (
          <div className="mt-2 rounded-[var(--radius-panel)] border border-border/55 bg-card/92 p-3 shadow-[0_18px_44px_rgba(64,55,38,0.14)] ring-1 ring-background/70 backdrop-blur-xl">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                <span>制作方式</span>
              </div>
              {pptSkills.length > 1 && (
                <button
                  type="button"
                  className="h-7 rounded-[var(--radius-control)] px-2 text-[11px] font-semibold text-primary transition hover:bg-primary/10"
                  onClick={() => setShowSkillPicker((value) => !value)}
                >
                  {showSkillPicker ? "收起" : "更换"}
                </button>
              )}
            </div>

            {selectedSkill ? (
              <div className="mt-2 rounded-[var(--radius-control)] bg-background/72 px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_hsl(var(--border)/0.55)]">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="h-3 w-3" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] font-semibold text-foreground">{starterSkillDisplayName(selectedSkill)}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">/{selectedSkill.slug}</div>
                  </div>
                  {selectedSkill.category && <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{selectedSkill.category}</span>}
                </div>
              </div>
            ) : (
              <div className="mt-2 rounded-[var(--radius-control)] border border-dashed px-3 py-4 text-center text-[12px] text-muted-foreground">
                没有找到已启用的 Skill。可以先在设置里启用或导入。
              </div>
            )}

            <div className="mt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-muted-foreground">风格模板</span>
                <span className="text-[10px] text-muted-foreground">发送后先确认计划</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {pptStarterPresets.map((preset) => {
                  const active = preset.id === selectedPreset.id;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={`min-h-[58px] rounded-[var(--radius-control)] px-2.5 py-2 text-left transition ${
                        active
                          ? "bg-primary text-primary-foreground shadow-sm"
                          : "bg-background/62 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.48)] hover:bg-accent"
                      }`}
                      onClick={() => setSelectedPresetId(preset.id)}
                    >
                      <span className="flex items-center gap-1.5">
                        <span
                          className="h-2.5 w-2.5 shrink-0 rounded-full shadow-[inset_0_0_0_1px_rgba(255,255,255,0.45)]"
                          style={{ backgroundColor: preset.color }}
                        />
                        <span className="min-w-0 truncate text-[12px] font-semibold">{preset.name}</span>
                      </span>
                      <span className={`mt-1 block line-clamp-2 text-[10.5px] leading-4 ${active ? "text-primary-foreground/76" : "text-muted-foreground"}`}>
                        {preset.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {showSkillPicker && pptSkills.length > 0 && (
              <div className="mt-3 rounded-[var(--radius-control)] bg-background/48 p-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.45)]">
                <input
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.target.value)}
                  className="h-8 w-full rounded-[var(--radius-control)] border border-border/65 bg-card px-2.5 text-[12px] outline-none transition placeholder:text-muted-foreground/68 focus:border-primary/40 focus:ring-2 focus:ring-primary/12"
                  placeholder="搜索 Skill 名称、描述或触发词"
                />
                <div className="mt-2 flex gap-1 overflow-x-auto pb-1 brevyn-scrollbar">
                  {skillCategories.map((category) => (
                    <button
                      key={category.id}
                      type="button"
                      className={`h-7 shrink-0 rounded-full px-2.5 text-[11px] font-medium transition ${
                        skillCategory === category.id ? "bg-foreground text-background" : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
                      }`}
                      onClick={() => setSkillCategory(category.id)}
                    >
                      {category.name}
                    </button>
                  ))}
                </div>
                <div className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1 brevyn-scrollbar">
                  {visibleSkills.length > 0 ? visibleSkills.map((skill) => {
                    const active = skill.slug === selectedSkill?.slug;
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        className={`flex w-full items-center gap-2 rounded-[var(--radius-control)] px-2.5 py-2 text-left transition ${
                          active ? "bg-primary text-primary-foreground shadow-sm" : "hover:bg-accent"
                        }`}
                        onClick={() => {
                          setSelectedSkillSlug(skill.slug);
                          setShowSkillPicker(false);
                        }}
                      >
                        <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${active ? "border-primary-foreground/65" : "border-border"}`}>
                          {active && <Check className="h-3 w-3" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-semibold">{starterSkillDisplayName(skill)}</span>
                          <span className={`mt-0.5 block truncate text-[11px] ${active ? "text-primary-foreground/72" : "text-muted-foreground"}`}>
                            /{skill.slug}{skill.category ? ` · ${skill.category}` : ""}
                          </span>
                        </span>
                      </button>
                    );
                  }) : (
                    <div className="rounded-[var(--radius-control)] border border-dashed px-3 py-4 text-center text-[12px] text-muted-foreground">
                      没有匹配的 Skill。
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-[11px] leading-4 text-muted-foreground">会填入输入框，发送前可继续修改。</span>
              <button
                type="button"
                className="inline-flex h-8 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-foreground px-3 text-[12px] font-semibold text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
                onClick={applyPptStarter}
                disabled={!selectedSkill}
              >
                填入输入框
              </button>
            </div>
          </div>
        )}
      </div>
      <p className="mt-4 text-[11px] leading-5 text-muted-foreground">
        {welcome.promptHint}
      </p>
    </div>
  );
}

function homeWelcomeCopy(thread: Thread): { kind: "semester" | "task"; greeting: string; dateLabel: string; promptHint: string } {
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 5
    ? "夜深了，Brevyn 还在。"
    : hour < 12
      ? "早上好，今天从一个清晰的小目标开始。"
      : hour < 18
        ? "下午好，我们把学习进度往前推一点。"
        : "晚上好，适合收束、复盘和整理下一步。";
  const dateLabel = now.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const isHome = thread.threadType === "semester_home" || !thread.taskId;
  return {
    kind: isHome ? "semester" : "task",
    greeting,
    dateLabel,
    promptHint: isHome
      ? "可以直接输入，例如“今天先处理哪门课”或“帮我整理本周学习重点”。"
      : "可以直接输入，例如“先检查这份作业要求”或“帮我列出下一步写作计划”。",
  };
}

function pptStarterSkills(skills: SkillItem[]): Array<SkillItem & { slug: string }> {
  return skills
    .filter((skill): skill is SkillItem & { slug: string } => Boolean(skill.enabled && (skill.slug || skill.id)))
    .map((skill) => ({ ...skill, slug: skill.slug || skill.id.replace(/^file:/, "") }))
    .sort((left, right) => {
      if (left.slug === "ppt-master") return -1;
      if (right.slug === "ppt-master") return 1;
      const leftPpt = starterSkillScore(left);
      const rightPpt = starterSkillScore(right);
      if (leftPpt !== rightPpt) return rightPpt - leftPpt;
      return starterSkillDisplayName(left).localeCompare(starterSkillDisplayName(right), "zh-CN");
    });
}

function defaultPptStarterSkill(skills: Array<SkillItem & { slug: string }>): (SkillItem & { slug: string }) | undefined {
  return skills.find((skill) => skill.slug === "ppt-master") || skills.find((skill) => starterSkillScore(skill) > 0) || skills[0];
}

function starterSkillDisplayName(skill: Pick<SkillItem, "name" | "slug"> & { slug: string }): string {
  if (skill.slug === "ppt-master") return "PPT Master";
  return skill.name || skill.slug;
}

interface PptStarterPreset {
  id: string;
  name: string;
  description: string;
  color: string;
  templatePath?: string;
  styleInstruction: string;
}

const pptStarterPresets: PptStarterPreset[] = [
  {
    id: "academic",
    name: "学术答辩",
    description: "论文、课程汇报、研究进展",
    color: "#2563EB",
    templatePath: "${SKILL_DIR}/templates/layouts/academic_defense",
    styleInstruction: "使用学术答辩结构，重视研究问题、方法、结果、讨论和结论；图表需要清晰、克制、适合课堂或答辩展示。",
  },
  {
    id: "data",
    name: "数据报告",
    description: "统计结果、调研、业务分析",
    color: "#0F766E",
    styleInstruction: "使用 data-journalism 风格，优先把表格和数据结果转成清晰图表；每页保持一个主要数据观点，并标注数据含义。",
  },
  {
    id: "tech",
    name: "科技汇报",
    description: "系统、AI、产品技术方案",
    color: "#4F46E5",
    templatePath: "${SKILL_DIR}/templates/layouts/ai_ops",
    styleInstruction: "使用科技汇报结构，适合 AI、系统架构、产品方案和技术路线；可以使用深色或高对比科技视觉，但不要牺牲可读性。",
  },
  {
    id: "minimal",
    name: "极简专业",
    description: "通用课程展示和正式汇报",
    color: "#525252",
    styleInstruction: "使用 swiss-minimal 风格，版面留白充足、层级清楚、颜色克制；适合正式汇报和课程展示。",
  },
  {
    id: "medical",
    name: "医学学术",
    description: "医学论文、病例、科研展示",
    color: "#0891B2",
    templatePath: "${SKILL_DIR}/templates/layouts/medical_university",
    styleInstruction: "使用医学学术结构，强调研究背景、病例/样本、方法、结果和临床或科研意义；避免过度装饰。",
  },
  {
    id: "free",
    name: "自由设计",
    description: "按材料内容自行推荐方向",
    color: "#D97757",
    styleInstruction: "不预设固定模板。请根据材料内容提出 2-3 个合适风格方向，并推荐一个默认方案供我确认。",
  },
];

function reportToPptStarterPrompt(skillSlug: string, preset: PptStarterPreset): string {
  const isPptMaster = skillSlug === "ppt-master";
  const lines = [
    "帮我把报告/论文/课程作业做成 PPT。",
  ];

  if (isPptMaster) {
    lines.push(
      "请使用 ppt-master 的标准工作流，不要改用独立的一次性 python-pptx 脚本。",
      "开始前请先运行 ppt-master 的运行环境检查：`python3 ${SKILL_DIR}/scripts/preflight.py --json`。如果检查失败，请停止并告诉我缺少什么、怎么安装；不要继续生成 PPT。",
    );
    if (preset.templatePath) {
      lines.push(`我选择的风格模板是「${preset.name}」。请在 Step 3 使用这个模板目录：\`${preset.templatePath}\`。`);
    } else {
      lines.push(`我选择的风格方向是「${preset.name}」：${preset.styleInstruction}`);
    }
  } else {
    lines.push(`我选择的制作 Skill 是 /${skillSlug}。请优先遵循这个 Skill 的工作流。`);
    lines.push(`我选择的风格方向是「${preset.name}」：${preset.styleInstruction}`);
  }

  lines.push(
    isPptMaster
      ? "环境检查通过后，请询问我是要上传/补充材料，还是使用当前工作区/当前环境已有材料。"
      : "开始后，请先询问我是要上传/补充材料，还是使用当前工作区/当前环境已有材料。",
    "拿到材料后，请先阅读材料，识别展示主线和可复用图表/表格/数据结果，给我一份 PPT 计划、素材处理清单、页数建议、语言建议和风格确认。确认后再生成 PPTX。",
  );

  return lines.join("\n");
}

function pptWorkflow(skillSlug = "ppt-master", phase: NonNullable<Thread["workflow"]>["phase"] = "planning"): NonNullable<Thread["workflow"]> {
  const now = Date.now();
  return {
    type: "ppt",
    skillSlug,
    phase,
    startedAt: now,
    updatedAt: now,
  };
}

function starterSkillScore(skill: SkillItem & { slug: string }): number {
  const haystack = starterSkillSearchText(skill);
  if (skill.slug === "ppt-master") return 3;
  if (/ppt|pptx|slides?|presentation|deck|幻灯片/.test(haystack)) return 2;
  if (/汇报|展示|报告|论文/.test(haystack)) return 1;
  return 0;
}

function starterSkillCategories(skills: Array<SkillItem & { slug: string }>): Array<{ id: string; name: string }> {
  const categories = new Map<string, string>();
  categories.set("all", "全部");
  categories.set("ppt", "PPT 相关");
  for (const skill of skills) {
    const category = (skill.category || "未分类").trim() || "未分类";
    categories.set(category, category);
  }
  return [...categories.entries()].map(([id, name]) => ({ id, name }));
}

function filterStarterSkills(skills: Array<SkillItem & { slug: string }>, query: string, categoryId: string): Array<SkillItem & { slug: string }> {
  const normalizedQuery = query.trim().toLowerCase();
  return skills.filter((skill) => {
    if (categoryId === "ppt" && starterSkillScore(skill) <= 0) return false;
    if (categoryId !== "all" && categoryId !== "ppt" && (skill.category || "未分类").trim() !== categoryId) return false;
    if (!normalizedQuery) return true;
    return starterSkillSearchText(skill).includes(normalizedQuery);
  });
}

function starterSkillSearchText(skill: SkillItem & { slug: string }): string {
  return [
    skill.slug,
    skill.name,
    skill.description,
    skill.category,
    ...(skill.tags || []),
    ...(skill.triggers || []),
  ].join(" ").toLowerCase();
}

const AgentTimelineGroup = memo(function AgentTimelineGroup({
  group,
  agentProviders,
  onToggleItemProcess,
  onApprove,
  onReject,
  onAnswerQuestion,
  onResolveExitPlan,
  onCompact,
  onForkThread,
  onRequestAcademicCheck,
}: {
  group: ReturnType<typeof useAgentThreadPanelState>["timelineGroups"][number];
  agentProviders: ModelProviderConfig[];
  onToggleItemProcess: (item: AgentTimelineViewItem) => void;
  onApprove: (requestId: string) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
  onAnswerQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
  onResolveExitPlan: (requestId: string, decision: "approve" | "deny", feedback?: string) => Promise<void>;
  onCompact: () => void;
  onForkThread: (threadId: string, upToMessageUuid: string) => Promise<Thread | null>;
  onRequestAcademicCheck: () => void;
}) {
  if (group.type === "user") {
    return <UserTimelineGroup item={group.item} />;
  }

  if (group.type === "system") {
    return <SystemTimelineGroup item={group.item} />;
  }

  if (group.type === "runtime") {
    return (
      <RuntimeTimelineGroup
        item={group.item}
        onApprove={onApprove}
        onReject={onReject}
        onAnswerQuestion={onAnswerQuestion}
        onResolveExitPlan={onResolveExitPlan}
      />
    );
  }

  return (
    <AssistantTurnTimelineGroup
      items={group.items}
      entries={group.entries}
      collapsedVisibleEntryKeys={group.collapsedVisibleEntryKeys}
      processItem={group.processItem}
      model={group.model}
      providerId={group.providerId}
      createdAt={group.createdAt}
      agentProviders={agentProviders}
      onToggleItemProcess={onToggleItemProcess}
      onApprove={onApprove}
      onReject={onReject}
      onAnswerQuestion={onAnswerQuestion}
      onResolveExitPlan={onResolveExitPlan}
      onCompact={onCompact}
      onForkThread={onForkThread}
      onRequestAcademicCheck={onRequestAcademicCheck}
    />
  );
}, areAgentTimelineGroupPropsEqual);

function areAgentTimelineGroupPropsEqual(
  previous: {
    group: ReturnType<typeof useAgentThreadPanelState>["timelineGroups"][number];
    agentProviders: ModelProviderConfig[];
    onToggleItemProcess: (item: AgentTimelineViewItem) => void;
    onApprove: (requestId: string) => Promise<void>;
    onReject: (requestId: string) => Promise<void>;
    onAnswerQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
    onResolveExitPlan: (requestId: string, decision: "approve" | "deny", feedback?: string) => Promise<void>;
    onCompact: () => void;
    onForkThread: (threadId: string, upToMessageUuid: string) => Promise<Thread | null>;
    onRequestAcademicCheck: () => void;
  },
  next: {
    group: ReturnType<typeof useAgentThreadPanelState>["timelineGroups"][number];
    agentProviders: ModelProviderConfig[];
    onToggleItemProcess: (item: AgentTimelineViewItem) => void;
    onApprove: (requestId: string) => Promise<void>;
    onReject: (requestId: string) => Promise<void>;
    onAnswerQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
    onResolveExitPlan: (requestId: string, decision: "approve" | "deny", feedback?: string) => Promise<void>;
    onCompact: () => void;
    onForkThread: (threadId: string, upToMessageUuid: string) => Promise<Thread | null>;
    onRequestAcademicCheck: () => void;
  },
): boolean {
  return previous.group === next.group
    && previous.agentProviders === next.agentProviders
    && previous.onToggleItemProcess === next.onToggleItemProcess
    && previous.onApprove === next.onApprove
    && previous.onReject === next.onReject
    && previous.onAnswerQuestion === next.onAnswerQuestion
    && previous.onResolveExitPlan === next.onResolveExitPlan
    && previous.onCompact === next.onCompact
    && previous.onForkThread === next.onForkThread
    && previous.onRequestAcademicCheck === next.onRequestAcademicCheck;
}

function UserTimelineGroup({ item }: { item: AgentTimelineViewItem }) {
  const threadId = useContext(AgentThreadIdContext);
  if (item.displayKind !== "user-message") return null;
  const message = item.record as SDKMessage;
  return <UserMessageBubble content={userText(message)} threadId={threadId} attachments={messageAttachments(message)} />;
}

function SystemTimelineGroup({ item }: { item: AgentTimelineViewItem }) {
  if (item.displayKind === "compact-compacting") return <CompactContextNote state="compacting" />;
  if (item.displayKind === "compact-complete") return <CompactContextNote state="complete" />;
  if (item.displayKind === "compact-failed") return <CompactContextNote state="failed" message={item.assistantContent} />;
  if (item.displayKind === "permission-denied") return <PermissionDeniedNotice record={item.record as SDKMessage} />;
  return null;
}

function PermissionDeniedNotice({ record }: { record: SDKMessage }) {
  const data = record as unknown as {
    tool_name?: unknown;
    message?: unknown;
    decision_reason?: unknown;
    decision_reason_type?: unknown;
  };
  const toolName = typeof data.tool_name === "string" && data.tool_name.trim() ? data.tool_name.trim() : "工具";
  const message = typeof data.message === "string" && data.message.trim() ? data.message.trim() : "SDK 自动审批拒绝了这个操作。";
  const reason = typeof data.decision_reason === "string" && data.decision_reason.trim() ? data.decision_reason.trim() : "";

  return (
    <div className="brevyn-status-card-warning rounded-2xl p-4 text-xs text-foreground">
      <div className="flex items-start gap-3">
        <div className="brevyn-status-icon-warning mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl">
          <ShieldAlert className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">自动审批已拒绝操作</p>
          <p className="mt-1 leading-5 text-muted-foreground">工具：{toolName}</p>
          <p className="mt-1 break-words leading-5">{message}</p>
          {reason && <p className="mt-1 break-words leading-5 text-muted-foreground">说明：{reason}</p>}
        </div>
      </div>
    </div>
  );
}

function RuntimeTimelineGroup({
  item,
  onApprove,
  onReject,
  onAnswerQuestion,
  onResolveExitPlan,
}: {
  item: AgentTimelineViewItem;
  onApprove: (requestId: string) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
  onAnswerQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
  onResolveExitPlan: (requestId: string, decision: "approve" | "deny", feedback?: string) => Promise<void>;
}) {
  const { record, displayKind, approvalDecision, questionAnswers, exitPlanDecision } = item;

  if (!isRuntimeRecord(record)) return null;
  if (displayKind === "run-retrying" && record.event.type === "run_retrying") {
    return (
      <RetryRuntimeNote
        attempt={record.event.retryAttempt}
        maxRetries={record.event.maxRetries}
        reason={record.event.reason}
        delayMs={record.event.delayMs}
      />
    );
  }
  if (displayKind === "approval-request" && record.event.type === "approval_requested") {
    return (
      <ApprovalCard
        request={record.event.request}
        decision={approvalDecision}
        onApprove={onApprove}
        onReject={onReject}
      />
    );
  }
  if (displayKind === "question-resolved" && record.event.type === "ask_user_requested") {
    return (
      <ResolvedRuntimeNote
        tone="approved"
        label="已回答问题"
        detail={record.event.request.questions[0]?.question || "Brevyn question"}
      />
    );
  }
  if (displayKind === "question-request" && record.event.type === "ask_user_requested") {
    return (
      <AskUserCard
        request={record.event.request}
        resolvedAnswers={questionAnswers}
        onAnswer={onAnswerQuestion}
      />
    );
  }
  if (displayKind === "exit-plan-resolved" && record.event.type === "exit_plan_requested") {
    return (
      <ResolvedRuntimeNote
        tone={exitPlanDecision === "approve" ? "approved" : "denied"}
        label={exitPlanDecision === "approve" ? "已批准计划" : "已要求修改计划"}
        detail={exitPlanSummary(record.event.request)}
      />
    );
  }
  if (displayKind === "exit-plan-request" && record.event.type === "exit_plan_requested") {
    return (
      <ExitPlanCard
        request={record.event.request}
        decision={exitPlanDecision}
        onResolve={onResolveExitPlan}
      />
    );
  }
  return null;
}

function AssistantTurnTimelineGroup({
  items,
  entries,
  collapsedVisibleEntryKeys,
  processItem,
  model,
  providerId,
  createdAt,
  agentProviders,
  onToggleItemProcess,
  onApprove,
  onReject,
  onAnswerQuestion,
  onResolveExitPlan,
  onCompact,
  onForkThread,
  onRequestAcademicCheck,
}: {
  items: AgentTimelineViewItem[];
  entries: AgentTimelineTurnEntry[];
  collapsedVisibleEntryKeys: string[];
  processItem?: AgentTimelineViewItem;
  model?: string;
  providerId?: string;
  createdAt?: number;
  agentProviders: ModelProviderConfig[];
  onToggleItemProcess: (item: AgentTimelineViewItem) => void;
  onApprove: (requestId: string) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
  onAnswerQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
  onResolveExitPlan: (requestId: string, decision: "approve" | "deny", feedback?: string) => Promise<void>;
  onCompact: () => void;
  onForkThread: (threadId: string, upToMessageUuid: string) => Promise<Thread | null>;
  onRequestAcademicCheck: () => void;
}) {
  const showTimelineItems = processItem?.processExpanded ?? true;
  const stableBodyTextKeys = new Set(collapsedVisibleEntryKeys);
  const summary = processItem?.processSummary ?? [...items].reverse().find((item) => item.processSummary)?.processSummary ?? null;
  return (
    <div className="group/assistant-turn flex min-w-0 w-full max-w-full flex-col gap-3">
      {(processItem || entries.length > 0) && (
        <div className="flex min-w-0 flex-col">
          <AssistantTurnHeader model={model} providerId={providerId} agentProviders={agentProviders} />
          {processItem && (
            <AttachedProcess item={processItem} onToggle={() => onToggleItemProcess(processItem)} />
          )}
          {entries.map((entry, index) => {
            const keepVisibleWhenCollapsed = stableBodyTextKeys.has(entry.key);
            if (!showTimelineItems && !keepVisibleWhenCollapsed) return null;
            return (
              <TimelineItemsDrawer
                key={entry.key}
                open
                insetTop={Boolean(processItem) || index > 0}
              >
                <AssistantTurnRenderEntryView
                  entry={entry}
                  processItem={processItem}
                  onToggleItemProcess={onToggleItemProcess}
                  onApprove={onApprove}
                  onReject={onReject}
	                  onAnswerQuestion={onAnswerQuestion}
	                  onResolveExitPlan={onResolveExitPlan}
	                  onCompact={onCompact}
	                  onRequestAcademicCheck={onRequestAcademicCheck}
	                />
              </TimelineItemsDrawer>
            );
          })}
        </div>
      )}
      <AssistantTurnCopyAction items={items} summary={summary} createdAt={createdAt} onForkThread={onForkThread} />
    </div>
  );
}

function AssistantTurnHeader({
  model,
  providerId,
  agentProviders,
}: {
  model?: string;
  providerId?: string;
  agentProviders: ModelProviderConfig[];
}) {
  const modelId = (model || "").trim();
  if (!modelId) return null;
  const providerById = providerId ? agentProviders.find((item) => item.id === providerId) : undefined;
  const provider = providerById ?? agentProviders.find((item) => item.models.some((candidate) => candidate.id === modelId));
  const providerModel = provider?.models.find((candidate) => candidate.id === modelId);
  const modelLabel = providerModel?.name || modelId;
  return (
    <div className="mb-1 flex min-w-0 items-center gap-2 px-1 text-[11px] text-muted-foreground">
      <ModelProviderIcon modelId={modelId} baseUrl={provider?.baseUrl} providerKind={provider?.providerKind} title={modelLabel} className="h-7 w-7 rounded-[0.45rem]" />
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-[12px] font-semibold text-foreground/70" title={modelLabel}>{modelLabel}</span>
      </div>
    </div>
  );
}

function formatHeaderTime(timestampMs: number): string {
  return new Date(timestampMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function AssistantTurnRenderEntryView({
  entry,
  processItem,
  onToggleItemProcess,
  onApprove,
  onReject,
  onAnswerQuestion,
  onResolveExitPlan,
  onCompact,
  onRequestAcademicCheck,
}: {
  entry: AgentTimelineTurnEntry;
  processItem?: AgentTimelineViewItem;
  onToggleItemProcess: (item: AgentTimelineViewItem) => void;
  onApprove: (requestId: string) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
  onAnswerQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
  onResolveExitPlan: (requestId: string, decision: "approve" | "deny", feedback?: string) => Promise<void>;
  onCompact: () => void;
  onRequestAcademicCheck: () => void;
}) {
  const firstItem = entry.type === "tool-group" ? entry.items[0] : entry.item;
  if (!firstItem) return null;

  const rendered = entry.type === "tool-group" ? (
    <OrderedToolGroupEntry entry={entry} />
  ) : (
    <AssistantTurnEntry
      item={entry.item}
      onToggleProcess={() => onToggleItemProcess(processItem ?? entry.item)}
      onApprove={onApprove}
      onReject={onReject}
	      onAnswerQuestion={onAnswerQuestion}
	      onResolveExitPlan={onResolveExitPlan}
	      onCompact={onCompact}
	      onRequestAcademicCheck={onRequestAcademicCheck}
	    />
  );

  return (
    <div className="min-w-0 w-full max-w-full">
      {rendered}
    </div>
  );
}

function TimelineItemsDrawer({
  open,
  insetTop = false,
  unmountWhenClosed = false,
  children,
}: {
  open: boolean;
  insetTop?: boolean;
  unmountWhenClosed?: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (!unmountWhenClosed) return;
    const timeout = window.setTimeout(() => setMounted(false), 220);
    return () => window.clearTimeout(timeout);
  }, [open, unmountWhenClosed]);

  return (
    <div
      className={`${open ? "" : "pointer-events-none"} grid min-w-0 transition-all duration-200 ease-out`}
      style={{
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
      }}
      aria-hidden={!open}
      {...(!open ? { inert: "" } : {})}
    >
      <div
        className={`${insetTop ? "pt-2" : ""} flex min-h-0 min-w-0 flex-col gap-2 overflow-hidden`}
      >
        {open || mounted || !unmountWhenClosed ? children : null}
      </div>
    </div>
  );
}

function AssistantTurnEntry({
  item,
  onToggleProcess,
  onApprove,
  onReject,
  onAnswerQuestion,
  onResolveExitPlan,
  onCompact,
  onRequestAcademicCheck,
}: {
  item: AgentTimelineViewItem;
  onToggleProcess: () => void;
  onApprove: (requestId: string) => Promise<void>;
  onReject: (requestId: string) => Promise<void>;
  onAnswerQuestion: (requestId: string, answers: Record<string, string>) => Promise<void>;
  onResolveExitPlan: (requestId: string, decision: "approve" | "deny", feedback?: string) => Promise<void>;
  onCompact: () => void;
  onRequestAcademicCheck: () => void;
}) {
  const threadId = useContext(AgentThreadIdContext);
  const {
    record,
    displayKind,
    assistantContent,
    stoppedByUser,
    processSummary,
    processEvents,
  } = item;

  if (displayKind === "hidden" || displayKind === "user-message") return null;

  if (displayKind === "compact-compacting" || displayKind === "compact-complete" || displayKind === "compact-failed") {
    return <SystemTimelineGroup item={item} />;
  }

  if (displayKind === "permission-denied") {
    return <PermissionDeniedNotice record={record as SDKMessage} />;
  }

  if (isRuntimeRecord(record)) {
    return (
      <RuntimeTimelineGroup
        item={item}
        onApprove={onApprove}
        onReject={onReject}
        onAnswerQuestion={onAnswerQuestion}
        onResolveExitPlan={onResolveExitPlan}
      />
    );
  }

  if (displayKind === "process") {
    return <AttachedProcess item={item} onToggle={onToggleProcess} />;
  }

  if (displayKind === "thinking") {
    return (
      <div className="px-1 py-1 text-xs leading-5 text-foreground">
        <div className="brevyn-thinking-markdown opacity-95">
          <StreamingMarkdownish content={assistantContent || ""} threadId={threadId} streaming={item.assistantStreaming === true} />
        </div>
      </div>
    );
  }

  if (displayKind === "tool-use") {
    const event = processEvents.find((candidate): candidate is Extract<ProcessEvent, { kind: "tool_use" }> => candidate.kind === "tool_use");
    if (!event) return null;
    return <OrderedToolUseEntry event={event} />;
  }

  if (displayKind === "prompt-too-long") {
    return (
      <PromptTooLongCard message={assistantContent || ""} onCompact={onCompact} />
    );
  }

  if (displayKind === "provider-error") {
    return (
      <ProviderErrorCard message={assistantContent || processSummary?.detail || "Provider request failed."} />
    );
  }

  if (displayKind === "assistant-final") {
    return (
      <AssistantTextBubble
        content={assistantContent || ""}
        streaming={item.assistantStreaming === true}
        copyable={false}
        copyContent={assistantContent}
        threadId={threadId}
        stoppedByUser={stoppedByUser}
        evidence={item.answerEvidence}
        onRequestAcademicCheck={onRequestAcademicCheck}
      />
    );
  }

  return null;
}

function AssistantTurnCopyAction({
  items,
  summary,
  createdAt,
  onForkThread,
}: {
  items: AgentTimelineViewItem[];
  summary: RunSummary | null;
  createdAt?: number;
  onForkThread: (threadId: string, upToMessageUuid: string) => Promise<Thread | null>;
}) {
  const threadId = useContext(AgentThreadIdContext);
  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false);
  const running = items.some((item) => item.processSummary?.running);
  const durationLabel = assistantDurationLabel(summary);
  const timeLabel = createdAt ? formatHeaderTime(createdAt) : "";
  const content = items
    .filter((item) => item.displayKind === "assistant-final")
    .map((item) => item.assistantContent || "")
    .filter((text) => text.trim())
    .join("\n\n")
    .trim();
  const forkTargetUuid = latestAssistantMessageUuid(items);

  if (running || !content) return null;

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("[AgentThreadPanel] Failed to copy assistant turn:", error);
    }
  }

  async function handleFork() {
    if (!threadId || !forkTargetUuid || forking) return;
    setForking(true);
    try {
      await onForkThread(threadId, forkTargetUuid);
    } catch (error) {
      console.error("[AgentThreadPanel] Failed to fork assistant turn:", error);
    } finally {
      setForking(false);
    }
  }

  return (
    <div className="-mt-1 flex items-center justify-start gap-1.5 px-1 text-[11px] text-muted-foreground/55 opacity-0 transition-opacity group-hover/assistant-turn:opacity-100 focus-within:opacity-100">
      {durationLabel && <span className="select-none">{durationLabel}</span>}
      {durationLabel && timeLabel && <span className="select-none text-muted-foreground/35">·</span>}
      {timeLabel && <span className="select-none">{timeLabel}</span>}
      <button
        type="button"
        onClick={() => void handleFork()}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/65 transition hover:bg-accent/65 hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        aria-label={forking ? "Forking conversation" : "Fork conversation"}
        title={forkTargetUuid ? (forking ? "分叉中" : "从这里分叉") : "没有可分叉的消息"}
        disabled={!forkTargetUuid || forking}
      >
        <GitBranch className={`h-3.5 w-3.5 ${forking ? "animate-pulse" : ""}`} />
      </button>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/65 transition hover:bg-accent/65 hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
        aria-label={copied ? "Message copied" : "Copy assistant response"}
        title={copied ? "已复制" : "复制"}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function assistantDurationLabel(summary: RunSummary | null): string {
  const label = summary?.label.trim() || "";
  const match = label.match(/(\d+m\s+\d+s|\d+s)/);
  return match?.[1] || "";
}

function latestAssistantMessageUuid(items: AgentTimelineViewItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.displayKind === "process") continue;
    const record = item.record as { parent_tool_use_id?: unknown; type?: unknown; uuid?: unknown };
    if (record.type !== "assistant") continue;
    if (record.parent_tool_use_id) continue;
    if (typeof record.uuid === "string" && record.uuid.trim()) return record.uuid.trim();
  }
  return "";
}

const OrderedToolUseEntry = memo(function OrderedToolUseEntry({
  event,
  collapsed: controlledCollapsed,
  onToggleCollapsed,
}: {
  event: Extract<ProcessEvent, { kind: "tool_use" }>;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}) {
  const [internalCollapsed, setInternalCollapsed] = useState(true);
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const toggleCollapsed = onToggleCollapsed ?? (() => setInternalCollapsed((value) => !value));
  return (
    <ToolUseCard
      block={event.tool}
      result={event.result}
      collapsed={collapsed}
      onToggleCollapsed={toggleCollapsed}
    />
  );
}, areOrderedToolUseEntryPropsEqual);

const OrderedToolGroupEntry = memo(function OrderedToolGroupEntry({ entry }: { entry: Extract<AgentTimelineTurnEntry, { type: "tool-group" }> }) {
  const { collapsed, expandedToolIds, toggleCollapsed, toggleTool } = useToolGroupDisclosure(entry.key, entry.summary.running);

  return (
    <div className="min-w-0 px-1 py-0">
      <button
        type="button"
        className="inline-flex h-6 max-w-full items-center gap-2 rounded-md px-0.5 text-left text-[13px] font-semibold leading-none text-muted-foreground/80 transition hover:text-foreground"
        onClick={toggleCollapsed}
        title={collapsed ? "展开工具详情" : "折叠工具详情"}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <ToolGlyph toolName={entry.summary.iconToolName} className={`h-4 w-4 opacity-80 ${entry.summary.running ? "animate-pulse" : ""}`} />
        </span>
        <span className={`flex h-4 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap ${entry.summary.running ? "taskagent-sweep-text" : ""}`}>
          {entry.summary.parts.map((part) => (
            <span key={part} className="truncate leading-none">{part}</span>
          ))}
        </span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`} />
      </button>
      <TimelineItemsDrawer open={!collapsed} unmountWhenClosed>
        {entry.summary.running ? (
          <RunningToolGroupDetails events={entry.toolEvents} expandedToolIds={expandedToolIds} onToggleTool={toggleTool} />
        ) : (
          <div className="ml-6 flex min-w-0 flex-col gap-1">
            {entry.toolEvents.map((event) => (
              <OrderedToolUseEntry key={event.tool.id || event.id} event={event} collapsed={expandedToolIds[event.tool.id || event.id] !== true} onToggleCollapsed={() => toggleTool(event.tool.id || event.id)} />
            ))}
          </div>
        )}
      </TimelineItemsDrawer>
    </div>
  );
});

function useToolGroupDisclosure(groupKey: string, running: boolean): {
  collapsed: boolean;
  expandedToolIds: Record<string, boolean>;
  toggleCollapsed: () => void;
  toggleTool: (toolId: string) => void;
} {
  const [collapsed, setCollapsed] = useState(true);
  const [expandedToolIds, setExpandedToolIds] = useState<Record<string, boolean>>({});
  const [wasRunning, setWasRunning] = useState(running);

  useEffect(() => {
    setCollapsed(true);
    setExpandedToolIds({});
    setWasRunning(running);
  }, [groupKey]);

  useEffect(() => {
    if (wasRunning && !running) {
      setCollapsed(true);
      setExpandedToolIds({});
    }
    if (wasRunning !== running) setWasRunning(running);
  }, [running, wasRunning]);

  function toggleCollapsed() {
    setCollapsed((value) => !value);
  }

  function toggleTool(toolId: string) {
    setExpandedToolIds((current) => ({ ...current, [toolId]: !(current[toolId] === true) }));
  }

  return { collapsed, expandedToolIds, toggleCollapsed, toggleTool };
}

const RunningToolGroupDetails = memo(function RunningToolGroupDetails({
  events,
  expandedToolIds,
  onToggleTool,
}: {
  events: Extract<ProcessEvent, { kind: "tool_use" }>[];
  expandedToolIds: Record<string, boolean>;
  onToggleTool: (toolId: string) => void;
}) {
  return (
    <div className="ml-6 flex min-w-0 flex-col gap-1">
      {events.map((event) => {
        const toolId = event.tool.id || event.id;
        const running = !event.result;
        const failed = event.result?.isError === true;
        const expanded = expandedToolIds[toolId] === true;
        return (
          <div key={toolId} className="overflow-hidden rounded-md">
            <div
              role="button"
              tabIndex={0}
              className="flex w-full min-w-0 items-start justify-between gap-3 rounded-md px-2 py-1.5 text-left text-[11px] text-muted-foreground transition hover:bg-accent/30 hover:text-foreground"
              onClick={() => onToggleTool(toolId)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onToggleTool(toolId);
              }}
              title={expanded ? "折叠工具详情" : "展开工具详情"}
            >
              <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
                <ToolGlyph toolName={event.tool.name} result={event.result} className={`h-3.5 w-3.5 shrink-0 ${running ? "animate-pulse" : "opacity-70"}`} />
                <span className="min-w-0">
                  <ToolTitle toolName={event.tool.name} input={event.tool.input} result={event.result} isError={failed} />
                </span>
              </span>
              <span className={`inline-flex shrink-0 items-center gap-1.5 font-medium ${running ? "taskagent-sweep-text" : failed ? "text-destructive" : "text-muted-foreground/75"}`}>
                {failed ? "失败" : running ? "运行中" : "完成"}
                <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`} />
              </span>
            </div>
            <TimelineItemsDrawer open={expanded} unmountWhenClosed>
              <div className="px-1 pb-1">
                <OrderedToolUseEntry event={event} collapsed={false} onToggleCollapsed={() => onToggleTool(toolId)} />
              </div>
            </TimelineItemsDrawer>
          </div>
        );
      })}
    </div>
  );
}, areRunningToolGroupDetailsPropsEqual);

function areToolEventsEqual(
  previous: { event: Extract<ProcessEvent, { kind: "tool_use" }> },
  next: { event: Extract<ProcessEvent, { kind: "tool_use" }> },
): boolean {
  return previous.event.tool === next.event.tool
    && previous.event.result === next.event.result
    && previous.event.approvalDecision === next.event.approvalDecision;
}

function areOrderedToolUseEntryPropsEqual(
  previous: {
    event: Extract<ProcessEvent, { kind: "tool_use" }>;
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
  },
  next: {
    event: Extract<ProcessEvent, { kind: "tool_use" }>;
    collapsed?: boolean;
    onToggleCollapsed?: () => void;
  },
): boolean {
  return previous.collapsed === next.collapsed && areToolEventsEqual(previous, next);
}

function areRunningToolGroupDetailsPropsEqual(
  previous: {
    events: Extract<ProcessEvent, { kind: "tool_use" }>[];
    expandedToolIds: Record<string, boolean>;
  },
  next: {
    events: Extract<ProcessEvent, { kind: "tool_use" }>[];
    expandedToolIds: Record<string, boolean>;
  },
): boolean {
  if (previous.events.length !== next.events.length) return false;
  const sameEvents = previous.events.every((event, index) => {
    const nextEvent = next.events[index];
    return Boolean(nextEvent)
      && event.tool === nextEvent.tool
      && event.result === nextEvent.result
      && event.approvalDecision === nextEvent.approvalDecision;
  });
  if (!sameEvents) return false;
  const previousExpanded = Object.keys(previous.expandedToolIds);
  const nextExpanded = Object.keys(next.expandedToolIds);
  if (previousExpanded.length !== nextExpanded.length) return false;
  return previousExpanded.every((toolId) => previous.expandedToolIds[toolId] === next.expandedToolIds[toolId]);
}

function AttachedProcess({
  item,
  onToggle,
}: {
  item: AgentTimelineViewItem;
  onToggle: () => void;
}) {
  const { processSummary, processExpanded, processLockedOpen, processCollapsible } = item;

  if (item.displayKind === "process" && processSummary) {
    return (
      <ProcessTimelinePanel
        summary={processSummary}
        expanded={processExpanded}
        lockedOpen={processLockedOpen}
        collapsible={processCollapsible}
        onToggle={onToggle}
      />
    );
  }

  return null;
}

function academicGroundingCheckPrompt(): string {
  return [
    "请检查上一条回答的学术依据，不要重写正文。",
    "",
    "请先检索当前作业要求、rubric、课程资料和已纳入的外部来源，再判断上一条回答是否可靠。",
    "",
    "检查重点：",
    "1. 是否覆盖当前作业要求和评分标准。",
    "2. 哪些主要观点已经有课程资料或外部来源支持。",
    "3. 哪些观点缺少依据、需要补充资料或更谨慎表述。",
    "4. 如果是演讲/essay/outline，请检查反方回应、结构和证据是否匹配任务要求。",
    "",
    "输出格式：",
    "- 已有依据",
    "- 需要补充",
    "- 建议下一步",
  ].join("\n");
}

function runSummaryTone(status: RunSummary["status"]): { text: string; dot: string; detail: string } {
  if (status === "running") {
    return {
      text: "text-muted-foreground",
      dot: "bg-[hsl(var(--status-warning))]",
      detail: "brevyn-status-pill-warning",
    };
  }
  if (status === "completed") {
    return {
      text: "text-muted-foreground",
      dot: "bg-[hsl(var(--status-success))]",
      detail: "brevyn-status-pill-success",
    };
  }
  if (status === "stopped") {
    return {
      text: "text-muted-foreground",
      dot: "bg-stone-400",
      detail: "bg-[hsl(var(--foreground)/0.055)] text-muted-foreground",
    };
  }
  if (status === "interrupted") {
    return {
      text: "text-[hsl(var(--status-warning))]",
      dot: "bg-[hsl(var(--status-warning))]",
      detail: "brevyn-status-pill-warning",
    };
  }
  return {
    text: "text-[hsl(var(--status-danger))]",
    dot: "bg-[hsl(var(--status-danger))]",
    detail: "brevyn-status-pill-danger",
  };
}
