import type { FormEvent } from "react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Plus, Presentation, Send, Square, X } from "lucide-react";
import type { AgentAttachment, AgentPermissionMode, ContextAnchor, ModelProviderConfig, SkillItem, ThreadWorkflow, WorkspaceFileNode } from "@/types/domain";
import type { AgentTodoItem, ContextUsage } from "@/components/agent/agentTimelineModel";
import type { QueuedAgentMessage } from "@/components/agent/agentComposerTypes";
import { AttachmentChip } from "@/components/agent/AgentAttachmentChips";
import { AgentImageAttachmentPreview, isAgentImageAttachment } from "@/components/agent/AgentImageAttachmentPreview";
import { ContextUsageButton } from "@/components/agent/AgentContextUsageButton";
import {
  buildPromptWithMentions,
  flattenMentionableFiles,
  flattenMentionableSkills,
  MentionedFileChips,
  skillSlugsForPrompt,
  type MentionedSkill,
} from "@/components/agent/AgentMentionPicker";
import { AgentRichPromptInput } from "@/components/agent/AgentRichPromptInput";
import { AgentProviderPicker, parseProviderModelValue } from "@/components/agent/AgentProviderPicker";
import { QueuedMessageDock } from "@/components/agent/AgentQueuedMessageDock";
import { TodoDock } from "@/components/agent/AgentTodoDock";
import { useAgentAttachmentsState } from "@/components/agent/useAgentAttachmentsState";
import { CHAT_BODY_WIDTH_CLASS } from "@/components/agent/agentLayout";
import { agentAttachmentsForRun, clearPendingAgentAttachmentData, deletePersistedAgentAttachments, persistAgentAttachments } from "@/components/agent/agentAttachmentPersistence";
import { promptWithQuotedSelection, QuotedSelectionChip, stripQuotedSelections } from "@/components/agent/quotedSelection";

interface AgentComposerProps {
  todos: AgentTodoItem[];
  queuedMessages: QueuedAgentMessage[];
  sendingQueuedMessageIds: string[];
  queueToastMessage: string;
  running: boolean;
  permissionMode: AgentPermissionMode;
  contextUsage: ContextUsage | null;
  autoCompactThresholdPercent: number;
  compacting: boolean;
  threadId: string;
  agentProviders: ModelProviderConfig[];
  activeProviderId: string;
  files: WorkspaceFileNode[];
  skills: SkillItem[];
  starterDraft?: AgentStarterDraft | null;
  workflow?: ThreadWorkflow;
  quotedSelections?: ContextAnchor[];
  onHeightChange?: (height: number) => void;
  onSetPermissionMode: (mode: AgentPermissionMode) => void;
  onRemoveQuotedSelection?: (quoteId?: string) => void;
  onRestoreQuotedSelection?: (quote: ContextAnchor) => void;
  onExitWorkflow?: () => void;
  onStartWorkflow?: (workflow: ThreadWorkflow) => void;
  onRun: (prompt: string, permissionMode?: AgentPermissionMode, attachments?: AgentAttachment[], providerSelection?: { providerId?: string; modelId?: string }, mentionedSkills?: string[]) => Promise<void>;
  onQueueMessage: (message: QueuedAgentMessage) => void;
  onSendQueuedMessage: (messageId: string) => void;
  onDeleteQueuedMessage: (messageId: string) => void;
  onStop: () => Promise<void>;
  onCompact: () => void;
  onSelectProvider: (providerId: string) => Promise<void>;
}

export interface AgentStarterDraft {
  id: string;
  prompt: string;
  skillSlug?: string;
}

interface ComposerDraft {
  promptValue: string;
  mentionedFiles: WorkspaceFileNode[];
  mentionedSkills: MentionedSkill[];
}

const emptyComposerDraft: ComposerDraft = {
  promptValue: "",
  mentionedFiles: [],
  mentionedSkills: [],
};

export const AgentComposer = memo(function AgentComposer({
  todos,
  queuedMessages,
  sendingQueuedMessageIds,
  queueToastMessage,
  running,
  permissionMode,
  contextUsage,
  autoCompactThresholdPercent,
  compacting,
  threadId,
  agentProviders,
  activeProviderId,
  files,
  skills,
  starterDraft,
  workflow,
  quotedSelections = [],
  onHeightChange,
  onSetPermissionMode,
  onRemoveQuotedSelection,
  onRestoreQuotedSelection,
  onExitWorkflow,
  onStartWorkflow,
  onRun,
  onQueueMessage,
  onSendQueuedMessage,
  onDeleteQueuedMessage,
  onStop,
  onCompact,
  onSelectProvider,
}: AgentComposerProps) {
  const [promptValue, setPromptValue] = useState("");
  const [mentionedFiles, setMentionedFiles] = useState<WorkspaceFileNode[]>([]);
  const [mentionedSkills, setMentionedSkills] = useState<MentionedSkill[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  const promptValueRef = useRef(promptValue);
  const threadIdRef = useRef(threadId);
  const draftThreadIdRef = useRef(threadId);
  const composerDraftsRef = useRef<Record<string, ComposerDraft>>({});
  const {
    pendingAttachments,
    draggingFiles,
    attachmentToastMessage,
    setDraggingFiles,
    pickAttachments,
    removeAttachment,
    restoreAttachments,
    clearAttachments,
    handlePaste,
    handleDrop,
  } = useAgentAttachmentsState({ threadId, running });
  const mentionableFiles = useMemo(() => flattenMentionableFiles(files), [files]);
  const mentionableSkills = useMemo(() => flattenMentionableSkills(skills), [skills]);
  const promptText = promptValue.trim();
  const hasMentionedSkills = mentionedSkills.length > 0;
  const hasQuotedSelections = quotedSelections.length > 0;
  const canSubmit = Boolean(promptText || pendingAttachments.length > 0 || hasMentionedSkills || hasQuotedSelections);
  const canQueueWhileRunning = canSubmit && pendingAttachments.length === 0;
  const pendingImageAttachments = pendingAttachments.filter(isAgentImageAttachment);
  const pendingFileAttachments = pendingAttachments.filter((attachment) => !isAgentImageAttachment(attachment));
  promptValueRef.current = promptValue;
  threadIdRef.current = threadId;

  useEffect(() => {
    const form = formRef.current;
    if (!form || !onHeightChange) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      onHeightChange(Math.ceil(form.getBoundingClientRect().height));
    };
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(measure);
    };
    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(form);
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [onHeightChange]);

  useLayoutEffect(() => {
    const previousThreadId = draftThreadIdRef.current;
    if (previousThreadId === threadId) return;
    composerDraftsRef.current = {
      ...composerDraftsRef.current,
      [previousThreadId]: { promptValue, mentionedFiles, mentionedSkills },
    };
    const draft = composerDraftsRef.current[threadId] || emptyComposerDraft;
    draftThreadIdRef.current = threadId;
    setPromptValue(draft.promptValue);
    setMentionedFiles(draft.mentionedFiles);
    setMentionedSkills(draft.mentionedSkills);
  }, [threadId]);

  useEffect(() => {
    if (!starterDraft) return;
    const nextPrompt = promptWithSkillTokens(starterDraft.prompt, starterDraft.skillSlug ? [starterDraft.skillSlug] : undefined);
    setPromptValue(nextPrompt);
    setMentionedSkills(skillMentionsFromSlugs(starterDraft.skillSlug ? [starterDraft.skillSlug] : undefined, mentionableSkills));
  }, [mentionableSkills, starterDraft]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const effectiveMentionedSkills = skillMentionsFromPrompt(promptText, mentionableSkills);
    const mentionedSkillSlugs = skillSlugsForPrompt(effectiveMentionedSkills);
    if (mentionedSkillSlugs.includes("ppt-master") && workflow?.type !== "ppt") {
      onStartWorkflow?.(pptWorkflow("ppt-master"));
    }
    const prompt = buildPromptWithMentions(promptText, mentionedFiles, effectiveMentionedSkills);
    const fallbackPrompt = mentionedSkillSlugs.length > 0 ? "请使用已选择的 Skill。" : hasQuotedSelections ? "请根据引用内容继续。" : "";
    const finalPrompt = promptWithQuotedSelection(prompt || fallbackPrompt, quotedSelections);
    if (!prompt && pendingAttachments.length === 0 && mentionedSkillSlugs.length === 0 && !hasQuotedSelections) return;

    if (running) {
      if (pendingAttachments.length > 0) return;
      onQueueMessage({
        id: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        prompt: finalPrompt,
        permissionMode,
        providerSelection: parseProviderModelValue(activeProviderId),
        mentionedSkills: mentionedSkillSlugs,
        quotedSelections: quotedSelections.length > 0 ? quotedSelections : undefined,
        quotedSelection: quotedSelections[0],
        createdAt: Date.now(),
      });
      setPromptValue("");
      setMentionedFiles([]);
      setMentionedSkills([]);
      onRemoveQuotedSelection?.();
      return;
    }

    const submittedThreadId = threadId;
    const submittedPromptValue = promptValue;
    const submittedMentionedFiles = mentionedFiles;
    const submittedMentionedSkills = mentionedSkills;
    const submittedQuotedSelections = quotedSelections;
    setPromptValue("");
    setMentionedFiles([]);
    setMentionedSkills([]);
    onRemoveQuotedSelection?.();
    const attachments = clearAttachments();
    let persistedAttachments: AgentAttachment[] = [];
    try {
      persistedAttachments = await persistAgentAttachments(submittedThreadId, attachments);
      await onRun(finalPrompt, permissionMode, agentAttachmentsForRun(persistedAttachments), parseProviderModelValue(activeProviderId), mentionedSkillSlugs);
      clearPendingAgentAttachmentData(attachments);
    } catch (error) {
      if (persistedAttachments.length > 0) void deletePersistedAgentAttachments(persistedAttachments);
      if (threadIdRef.current === submittedThreadId) {
        restoreAttachments(attachments);
        if (!promptValueRef.current.trim()) {
          setPromptValue(submittedPromptValue);
          setMentionedFiles(submittedMentionedFiles);
          setMentionedSkills(submittedMentionedSkills);
          submittedQuotedSelections.forEach((quote) => onRestoreQuotedSelection?.(quote));
        }
      } else {
        composerDraftsRef.current = {
          ...composerDraftsRef.current,
          [submittedThreadId]: {
            promptValue: submittedPromptValue,
            mentionedFiles: submittedMentionedFiles,
            mentionedSkills: submittedMentionedSkills,
          },
        };
        restoreAttachments(attachments, submittedThreadId);
        submittedQuotedSelections.forEach((quote) => onRestoreQuotedSelection?.(quote));
      }
      console.error("[AgentComposer] Failed to start agent run:", error);
    }
  }

  function handlePromptChange(value: string) {
    setPromptValue(value);
    setMentionedSkills(skillMentionsFromPrompt(value, mentionableSkills));
  }

  return (
    <form
      ref={formRef}
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 min-w-0 overflow-x-hidden px-5 pb-6 pt-3"
      style={{ paddingRight: "calc(1.25rem + 10px)" }}
      onSubmit={handleSubmit}
    >
      <div className={`${CHAT_BODY_WIDTH_CLASS} flex min-w-0 flex-col gap-2`}>
        {(queueToastMessage || attachmentToastMessage) && <QueueToast message={queueToastMessage || attachmentToastMessage} />}
        {todos.length > 0 && <TodoDock todos={todos} running={running} />}
        {workflow?.type === "ppt" && (
          <div className="pointer-events-auto flex min-w-0 items-center gap-2 rounded-[var(--radius-control)] border border-primary/18 bg-primary/8 px-3 py-2 text-[12px] text-foreground shadow-sm">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Presentation className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate">
              <span className="font-semibold">PPT 制作中</span>
              <span className="text-muted-foreground"> · /{workflow.skillSlug || "ppt-master"} · {workflowPhaseLabel(workflow.phase)}</span>
            </span>
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-2 text-[11px] font-semibold text-muted-foreground transition hover:bg-background/80 hover:text-foreground"
              onClick={onExitWorkflow}
            >
              <X className="h-3.5 w-3.5" />
              退出
            </button>
          </div>
        )}
        {queuedMessages.length > 0 && (
          <QueuedMessageDock
            messages={queuedMessages}
            sendingMessageIds={sendingQueuedMessageIds}
            running={running}
            onSend={onSendQueuedMessage}
            onDelete={onDeleteQueuedMessage}
            onEdit={(message) => {
              onDeleteQueuedMessage(message.id);
              setPromptValue(promptWithSkillTokens(stripQuotedSelections(message.prompt), message.mentionedSkills));
              setMentionedSkills(skillMentionsFromSlugs(message.mentionedSkills, mentionableSkills));
              const messageQuotes = message.quotedSelections || (message.quotedSelection ? [message.quotedSelection] : []);
              messageQuotes.forEach((quote) => onRestoreQuotedSelection?.(quote));
            }}
          />
        )}
        <div
          className={`pointer-events-auto relative w-full min-w-0 rounded-[1.65rem] p-3 [backface-visibility:hidden] [transform:translateZ(0)] ${
            draggingFiles
              ? "brevyn-composer-surface-dragging"
              : "brevyn-composer-surface"
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setDraggingFiles(true);
          }}
          onDragLeave={() => setDraggingFiles(false)}
          onDrop={handleDrop}
        >
          {(pendingAttachments.length > 0 || hasQuotedSelections) && (
            <div className="mb-2 space-y-2">
              {pendingImageAttachments.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {pendingImageAttachments.map((attachment) => (
                    <AgentImageAttachmentPreview
                      key={attachment.id}
                      attachment={attachment}
                      variant="composer"
                      removable
                      onRemove={() => void removeAttachment(attachment)}
                    />
                  ))}
                </div>
              )}
              {pendingFileAttachments.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {pendingFileAttachments.map((attachment) => (
                    <AttachmentChip
                      key={attachment.id}
                      attachment={attachment}
                      removable
                      onRemove={() => void removeAttachment(attachment)}
                    />
                  ))}
                </div>
              )}
              {hasQuotedSelections && (
                <div className="flex flex-wrap gap-1.5">
                  {quotedSelections.map((quote) => (
                    <QuotedSelectionChip key={quote.id} quote={quote} removable onRemove={() => onRemoveQuotedSelection?.(quote.id)} />
                  ))}
                </div>
              )}
              {running && (
                <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
                  当前回复完成后即可发送附件。
                </p>
              )}
            </div>
          )}
          <AgentRichPromptInput
            value={promptValue}
            skills={mentionableSkills}
            files={mentionableFiles}
            placeholder={running ? "输入补充消息，先加入待确认..." : "Ask Brevyn about this thread..."}
            onChange={handlePromptChange}
            onSubmit={() => formRef.current?.requestSubmit()}
            onPaste={handlePaste}
            onMentionFile={(file) => setMentionedFiles((current) => current.some((item) => item.id === file.id) ? current : [...current, file])}
          />
          <MentionedFileChips
            files={mentionedFiles}
            onRemove={(fileId) => setMentionedFiles((current) => current.filter((item) => item.id !== fileId))}
          />
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 shrink items-center gap-1.5">
              <button
                type="button"
                onClick={() => void pickAttachments()}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition hover:bg-accent hover:text-foreground"
                aria-label="Add context"
                title={running ? "添加附件；当前回复完成后可发送" : "Add attachment"}
              >
                <Plus className="h-4.5 w-4.5" />
              </button>
            </div>

            <div className="flex min-w-0 shrink-0 items-center gap-1.5">
              <ContextUsageButton
                usage={contextUsage}
                autoCompactThresholdPercent={autoCompactThresholdPercent}
                compacting={compacting}
                compactDisabled={running || !contextUsage || (contextUsage.contextInputTokens ?? contextUsage.inputTokens) <= 0}
                onCompact={onCompact}
              />
              <AgentProviderPicker
                running={running}
                permissionMode={permissionMode}
                agentProviders={agentProviders}
                activeProviderId={activeProviderId}
                onSetPermissionMode={onSetPermissionMode}
                onSelectProvider={onSelectProvider}
              />
              {running ? (
                canQueueWhileRunning ? (
                  <button
                    type="submit"
                    className="brevyn-composer-send inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-45"
                    aria-label="Queue message"
                    title="加入待确认"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="brevyn-composer-send inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition hover:scale-[1.03]"
                    onClick={() => void onStop()}
                    aria-label="Stop agent run"
                  >
                    <Square className="h-4 w-4 fill-current" />
                  </button>
                )
              ) : (
                <button
                  type="submit"
                  className="brevyn-composer-send inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition hover:scale-[1.03] disabled:cursor-not-allowed disabled:opacity-45"
                  aria-label="Send message"
                >
                  <Send className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}, areAgentComposerPropsEqual);

function QueueToast({ message }: { message: string }) {
  return (
    <div className="pointer-events-none flex justify-center">
      <div className="brevyn-composer-toast rounded-full px-3 py-1.5 text-[11px] font-medium">
        {message}
      </div>
    </div>
  );
}

function areAgentComposerPropsEqual(previous: AgentComposerProps, next: AgentComposerProps): boolean {
  return previous.todos === next.todos
    && previous.queuedMessages === next.queuedMessages
    && previous.sendingQueuedMessageIds === next.sendingQueuedMessageIds
    && previous.queueToastMessage === next.queueToastMessage
    && previous.running === next.running
    && previous.permissionMode === next.permissionMode
    && previous.contextUsage === next.contextUsage
    && previous.autoCompactThresholdPercent === next.autoCompactThresholdPercent
    && previous.compacting === next.compacting
    && previous.threadId === next.threadId
    && previous.agentProviders === next.agentProviders
    && previous.activeProviderId === next.activeProviderId
    && previous.files === next.files
    && previous.skills === next.skills
    && previous.starterDraft === next.starterDraft
    && previous.workflow === next.workflow
    && previous.quotedSelections === next.quotedSelections
    && previous.onHeightChange === next.onHeightChange
    && previous.onSetPermissionMode === next.onSetPermissionMode
    && previous.onRemoveQuotedSelection === next.onRemoveQuotedSelection
    && previous.onRestoreQuotedSelection === next.onRestoreQuotedSelection
    && previous.onExitWorkflow === next.onExitWorkflow
    && previous.onStartWorkflow === next.onStartWorkflow
    && previous.onRun === next.onRun
    && previous.onQueueMessage === next.onQueueMessage
    && previous.onSendQueuedMessage === next.onSendQueuedMessage
    && previous.onDeleteQueuedMessage === next.onDeleteQueuedMessage
    && previous.onStop === next.onStop
    && previous.onCompact === next.onCompact
    && previous.onSelectProvider === next.onSelectProvider;
}

function workflowPhaseLabel(phase: ThreadWorkflow["phase"]): string {
  if (phase === "awaiting_confirmation") return "等待确认";
  if (phase === "generating") return "生成中";
  if (phase === "done") return "已生成";
  return "规划中";
}

function pptWorkflow(skillSlug: string): ThreadWorkflow {
  const now = Date.now();
  return {
    type: "ppt",
    skillSlug,
    phase: "planning",
    startedAt: now,
    updatedAt: now,
  };
}

function skillMentionsFromSlugs(slugs: string[] | undefined, skills: MentionedSkill[]): MentionedSkill[] {
  if (!slugs?.length) return [];
  const bySlug = new Map(skills.map((skill) => [skill.slug, skill]));
  return slugs.flatMap((slug) => {
    const skill = bySlug.get(slug);
    return skill ? [skill] : [];
  });
}

function skillMentionsFromPrompt(prompt: string, skills: MentionedSkill[]): MentionedSkill[] {
  const slugs = [
    ...prompt.matchAll(/(?:^|\s)\/skill:([^\s/]+)(?=\s|$)/g),
    ...prompt.matchAll(/(?:^|\s)\/([^:\s/]+)(?=\s|$)/g),
  ].map((match) => match[1]).filter(Boolean);
  return skillMentionsFromSlugs(slugs, skills);
}

function promptWithSkillTokens(prompt: string, slugs: string[] | undefined): string {
  if (!slugs?.length) return prompt;
  const prefix = slugs.map((slug) => `/${slug}`).join(" ");
  return [prefix, prompt].filter(Boolean).join(" ");
}
