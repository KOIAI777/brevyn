import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, ClipboardCheck, Copy, FileSearch, Minimize2, RotateCw, ShieldCheck, X } from "lucide-react";
import { AgentImageAttachmentPreview, isAgentImageAttachment } from "@/components/agent/AgentImageAttachmentPreview";
import { Markdownish } from "@/components/chat/Markdownish";
import { FileTypeBadge, FileTypeIcon } from "@/components/files/FileTypeIcon";
import { useFilePathPreviewHandler, type FilePreviewLocationTarget } from "@/components/chat/FilePathChip";
import type { AgentAttachment } from "@/types/domain";
import type { AnswerEvidenceSource } from "@/components/agent/ragEvidence";
import { parseQuotedSelections, QuotedSelectionChip } from "@/components/agent/quotedSelection";

export function CompactContextNote({ state, message }: { state: "compacting" | "complete" | "failed"; message?: string }) {
  const compacting = state === "compacting";
  const failed = state === "failed";
  return (
    <div className="flex w-full items-center gap-3 py-3">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-border/70 to-border/25" />
      <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] ${
        compacting
          ? "brevyn-status-pill-warning"
          : failed
            ? "brevyn-status-pill-danger"
            : "brevyn-status-pill-success"
      }`}>
        {failed ? <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> : <Minimize2 className="h-3.5 w-3.5 shrink-0" />}
        <span className={`font-semibold ${compacting ? "taskagent-sweep-text" : ""}`}>
          {compacting ? "正在压缩上下文" : failed ? "上下文压缩失败" : "上下文已压缩"}
        </span>
        {failed && message ? <span className="max-w-[28rem] truncate opacity-75">{message}</span> : null}
      </div>
      <div className="h-px flex-1 bg-gradient-to-r from-border/25 via-border/70 to-transparent" />
    </div>
  );
}

export function RetryRuntimeNote({
  attempt,
  maxRetries,
  reason,
  delayMs,
}: {
  attempt: number;
  maxRetries: number;
  reason: string;
  delayMs: number;
}) {
  const waitSeconds = Math.max(0, Math.ceil(delayMs / 1000));
  return (
    <div className="flex justify-start px-1 py-1">
      <div className="brevyn-status-pill-warning inline-flex max-w-2xl items-center gap-2 rounded-full px-3 py-1.5 text-[11px]">
        <RotateCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
        <span className="font-semibold">正在重试 {attempt}/{maxRetries}</span>
        {waitSeconds > 0 && <span className="opacity-70">{waitSeconds}s 后重连</span>}
        {reason.trim() && <span className="max-w-md truncate opacity-60">· {reason.trim()}</span>}
      </div>
    </div>
  );
}

export function PromptTooLongCard({ message, onCompact }: { message: string; onCompact: () => void }) {
  return (
    <div className="flex justify-start">
      <div className="brevyn-status-card-warning w-full max-w-xl rounded-2xl p-4 text-sm text-foreground">
        <div className="flex items-start gap-3">
          <div className="brevyn-status-icon-warning mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
            <Minimize2 className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">上下文太长，需要压缩</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              当前会话已经接近或超过模型上下文限制。先压缩上下文后，Brevyn 会把旧对话折叠成摘要再继续。
            </p>
            {message.trim() && (
              <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-muted-foreground/82" title={message}>
                {message}
              </p>
            )}
            <button
              type="button"
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-xl bg-[hsl(var(--status-warning))] px-3 text-[11px] font-semibold text-background transition hover:brightness-95"
              onClick={onCompact}
            >
              <Minimize2 className="h-3.5 w-3.5" />
              压缩上下文
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ProviderErrorCard({ message }: { message: string }) {
  const trimmed = message.trim();
  if (!trimmed) return null;
  return (
    <div className="flex justify-start">
      <div className="brevyn-status-card-danger w-full max-w-2xl rounded-2xl p-4 text-sm text-foreground">
        <div className="flex items-start gap-3">
          <div className="brevyn-status-icon-danger mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold">Provider 返回错误</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              这是模型服务商返回的原始错误，Brevyn 已停止本轮输出。
            </p>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[hsl(var(--status-danger)/0.2)] bg-background/62 p-2.5 text-[11px] leading-5 text-foreground">
              {trimmed}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}

export function UserMessageBubble({
  content,
  threadId,
  attachments = [],
}: {
  content: string;
  threadId?: string;
  attachments?: AgentAttachment[];
}) {
  const { quotes, text } = parseQuotedSelections(content);
  if (!text.trim() && attachments.length === 0 && quotes.length === 0) return null;
  return (
    <div className="group/message flex min-w-0 justify-end">
      <div className="flex min-w-0 max-w-[76%] flex-col items-end">
        <div className="min-w-0 max-w-full overflow-hidden rounded-[1.35rem] bg-[hsl(var(--surface-warm)/0.9)] px-4 py-3 text-sm leading-6 text-foreground transition-colors duration-200">
          {quotes.length > 0 && (
            <div className="mb-2 flex flex-wrap justify-end gap-1.5">
              {quotes.map((quote, index) => (
                <QuotedSelectionChip key={`${quote.kind}:${quote.path || quote.filename}:${index}`} quote={quote} />
              ))}
            </div>
          )}
          {text.trim() && (
            <div data-quote-message-role="user">
              <Markdownish content={text} threadId={threadId} />
            </div>
          )}
          {attachments.length > 0 && <MessageAttachments attachments={attachments} threadId={threadId} />}
        </div>
        {text.trim() && <MessageCopyAction content={text} align="right" />}
      </div>
    </div>
  );
}

function MessageAttachments({ attachments, threadId }: { attachments: AgentAttachment[]; threadId?: string }) {
  const onPreviewFilePath = useFilePathPreviewHandler();
  const imageAttachments = attachments.filter(isAgentImageAttachment);
  const fileAttachments = attachments.filter((attachment) => !isAgentImageAttachment(attachment));

  async function openAttachment(attachment: AgentAttachment) {
    if (onPreviewFilePath) {
      await onPreviewFilePath(attachment.path);
      return;
    }
    if (!threadId) return;
    await window.brevyn.app.openWorkspacePath({ threadId, path: attachment.path });
  }

  return (
    <div className="mt-2 space-y-2">
      {imageAttachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {imageAttachments.map((attachment) => (
            <AgentImageAttachmentPreview
              key={attachment.id || attachment.path}
              attachment={attachment}
              variant="message"
              onOpen={() => openAttachment(attachment)}
            />
          ))}
        </div>
      )}
      {fileAttachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {fileAttachments.map((attachment) => (
            <button
              key={attachment.id || attachment.path}
              type="button"
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border/70 bg-background/72 px-2 py-1 text-[11px] font-medium text-foreground shadow-sm transition hover:bg-accent/65"
              title={attachment.path}
              onClick={() => void openAttachment(attachment)}
            >
              <FileTypeIcon name={attachment.name} size={15} />
              <span className="max-w-48 truncate">{attachment.name}</span>
              <FileTypeBadge name={attachment.name} kind={attachment.kind} />
              {attachment.sizeLabel && <span className="text-[10px] text-muted-foreground">{attachment.sizeLabel}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ResolvedRuntimeNote({
  tone,
  label,
  detail,
}: {
  tone: "approved" | "denied";
  label: string;
  detail: string;
}) {
  const approved = tone === "approved";
  return (
    <div className="flex justify-start">
      <div className={`inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-[11px] ${
        approved
          ? "brevyn-status-pill-success"
          : "brevyn-status-pill-warning"
      }`}>
        {approved ? <ShieldCheck className="h-3.5 w-3.5 shrink-0" /> : <X className="h-3.5 w-3.5 shrink-0" />}
        <span className="shrink-0 font-semibold">{label}</span>
        <span className="min-w-0 truncate text-muted-foreground" title={detail}>{detail}</span>
      </div>
    </div>
  );
}

function MessageCopyAction({ content, align }: { content: string; align: "left" | "right" }) {
  const [copied, setCopied] = useState(false);
  const trimmedContent = content.trim();

  async function handleCopy() {
    if (!trimmedContent) return;
    try {
      await navigator.clipboard.writeText(trimmedContent);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("[AgentMessageParts] Failed to copy message:", error);
    }
  }

  return (
    <div className={`mt-1.5 flex ${align === "right" ? "justify-end" : "justify-start"}`}>
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/65 opacity-70 transition hover:bg-accent/65 hover:text-foreground hover:opacity-100 focus-visible:bg-accent focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover/message:opacity-100"
        aria-label={copied ? "Message copied" : "Copy message"}
        title={copied ? "已复制" : "复制"}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function AssistantTextBubble({
  content,
  threadId,
  streaming = false,
  copyable = true,
  copyContent,
  evidence,
  onRequestAcademicCheck,
}: {
  content: string;
  threadId?: string;
  streaming?: boolean;
  stoppedByUser?: boolean;
  copyable?: boolean;
  copyContent?: string;
  evidence?: AnswerEvidenceSource[];
  onRequestAcademicCheck?: () => void;
}) {
  const displayContent = content.replace(/\u0000/g, "");
  if (!displayContent.trim()) return null;
  return (
    <div className="group/message flex min-w-0 w-full justify-start">
      <div
        className="min-w-0 w-full max-w-full overflow-hidden py-1 text-sm leading-6 text-foreground [contain:layout_paint_style]"
        data-thread-id={threadId}
        data-streaming={streaming ? "true" : "false"}
      >
        <div data-quote-message-role="assistant">
          <Markdownish content={displayContent} threadId={threadId} streaming={streaming} />
        </div>
        {!streaming && evidence && evidence.length > 0 && (
          <AnswerEvidenceStrip
            content={displayContent}
            sources={evidence}
            onRequestAcademicCheck={onRequestAcademicCheck}
          />
        )}
        {!streaming && copyable && <MessageCopyAction content={copyContent || content} align="left" />}
      </div>
    </div>
  );
}

function AnswerEvidenceStrip({
  content,
  sources,
  onRequestAcademicCheck,
}: {
  content: string;
  sources: AnswerEvidenceSource[];
  onRequestAcademicCheck?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const onPreviewFilePath = useFilePathPreviewHandler();
  const hitCount = sources.reduce((total, source) => total + Math.max(1, source.count), 0);
  const previewLabels = sources.slice(0, 3).map((source) => source.label).join("、");
  const canCheckAcademicGrounding = Boolean(onRequestAcademicCheck && isWritingLikeAnswer(content));

  async function openSource(source: AnswerEvidenceSource) {
    const path = source.sourcePath || source.path || source.citation || "";
    if ((!path && !source.fileId) || !onPreviewFilePath) return;
    const target: FilePreviewLocationTarget = {
      fileId: source.fileId || undefined,
      path: source.path || undefined,
      sourcePath: source.sourcePath || source.path || undefined,
      citation: source.citation || undefined,
      sourceLabel: source.sourceLabel || source.label || undefined,
      sectionType: source.sectionType || undefined,
      semanticUnitId: source.semanticUnitId || undefined,
      elementIds: source.elementIds,
      page: source.page,
      slide: source.slide,
      sheet: source.sheet || undefined,
      range: source.range || undefined,
      bbox: source.bbox || undefined,
      text: source.snippets[0]?.text || source.text || undefined,
    };
    await onPreviewFilePath(target);
  }

  return (
    <div className="mt-3 max-w-full overflow-hidden rounded-[1.15rem] border border-border/78 bg-[hsl(var(--card)/0.72)] text-xs text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--background)/0.55)]">
      <div className="flex min-w-0 items-center gap-3 px-4 py-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[0.9rem] bg-foreground/[0.07] text-foreground/78 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
          <FileSearch className="h-5 w-5" />
        </div>
        <button
          type="button"
          className="min-w-0 flex-1 text-left focus-visible:outline-none"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[15px] font-semibold text-foreground">本回答已引用课程资料</span>
            <span className="shrink-0 text-[12px] font-medium text-[hsl(var(--status-success))]">{sources.length} 份</span>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-[12px]">
            <span className="shrink-0 text-muted-foreground">{hitCount} 个证据片段</span>
            {previewLabels && (
              <>
                <span className="h-1 w-1 shrink-0 rounded-full bg-muted-foreground/35" />
                <span className="min-w-0 truncate text-muted-foreground/82" title={previewLabels}>{previewLabels}</span>
              </>
            )}
          </div>
        </button>
        <button
          type="button"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[0.85rem] border border-border/72 bg-background/54 px-3 text-[12px] font-semibold text-foreground/82 transition hover:bg-accent/72 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
        >
          {expanded ? "收起" : "查看"}
          <ChevronDown className={`h-3.5 w-3.5 transition ${expanded ? "rotate-180" : ""}`} />
        </button>
        {canCheckAcademicGrounding && (
          <button
            type="button"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[0.85rem] bg-foreground px-3 text-[12px] font-semibold text-background transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
            onClick={() => onRequestAcademicCheck?.()}
          >
            <ClipboardCheck className="h-3.5 w-3.5" />
            检查依据
          </button>
        )}
      </div>

      {expanded && (
        <div className="space-y-1.5 border-t border-border/58 bg-background/18 px-3 py-3">
          {sources.map((source, index) => {
            const canOpen = Boolean((source.sourcePath || source.path || source.citation || source.fileId) && onPreviewFilePath);
            const snippet = source.snippets[0] ?? source;
            return (
              <div key={source.key} className="rounded-[0.9rem] bg-background/46 px-3 py-2.5 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.42)]">
                <div className="flex min-w-0 items-start gap-2">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[10px] font-semibold text-foreground/72">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      className={`max-w-full truncate text-left text-[12px] font-semibold text-foreground/82 ${canOpen ? "hover:underline" : "cursor-default"}`}
                      title={source.sourcePath || source.path || source.citation || source.label}
                      disabled={!canOpen}
                      onClick={() => void openSource(source)}
                    >
                      {source.label}
                    </button>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span>{sectionLabel(source.sectionKind)}</span>
                      <span className="h-1 w-1 rounded-full bg-muted-foreground/35" />
                      <span>{chunkLabel(snippet)}</span>
                      {source.count > 1 && (
                        <>
                          <span className="h-1 w-1 rounded-full bg-muted-foreground/35" />
                          <span>{source.count} 个命中片段</span>
                        </>
                      )}
                      <span className="h-1 w-1 rounded-full bg-muted-foreground/35" />
                      <span>{scoreLabel(source.score)}</span>
                    </div>
                    {snippet.text && (
                      <p className="mt-1 line-clamp-2 break-words text-[11px] leading-5 text-muted-foreground/88">
                        {snippet.text}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function isWritingLikeAnswer(content: string): boolean {
  const text = content.toLowerCase();
  if (content.trim().length >= 900) return true;
  return [
    "outline",
    "essay",
    "speech",
    "draft",
    "paragraph",
    "argument",
    "counter-argument",
    "大纲",
    "演讲",
    "草稿",
    "作文",
    "文章",
    "段落",
    "论点",
    "反方",
    "反驳",
  ].some((keyword) => text.includes(keyword));
}

function sectionLabel(sectionKind?: string): string {
  if (sectionKind === "lecture") return "课件";
  if (sectionKind === "course_shared") return "课程资料";
  if (sectionKind === "task") return "当前作业";
  return "课程材料";
}

function chunkLabel(item: Pick<AnswerEvidenceSource, "chunkIndex" | "chunkCount" | "citation" | "sourceLabel" | "page" | "slide" | "sheet" | "range">): string {
  if (typeof item.slide === "number" && item.slide > 0) return `幻灯片 ${Math.floor(item.slide)}`;
  if (typeof item.page === "number" && item.page > 0) return `第 ${Math.floor(item.page)} 页`;
  if (item.sheet && item.range) return `${item.sheet} · ${item.range}`;
  if (item.sheet) return item.sheet;
  if (item.sourceLabel) return item.sourceLabel;
  if (typeof item.chunkIndex === "number" && typeof item.chunkCount === "number") return `片段 ${item.chunkIndex + 1}/${item.chunkCount}`;
  if (typeof item.chunkIndex === "number") return `片段 ${item.chunkIndex + 1}`;
  return item.citation || "证据片段";
}

function scoreLabel(score?: number): string {
  if (typeof score !== "number") return "相关";
  const value = Math.round(score * 100);
  if (value >= 78) return "高度相关";
  if (value >= 62) return "相关";
  return `${value}%`;
}

export function StreamingMarkdownish({
  content,
  threadId,
  streaming: _streaming = false,
}: {
  content: string;
  threadId?: string;
  streaming?: boolean;
}) {
  const displayContent = content.replace(/\u0000/g, "");
  if (!displayContent.trim()) return null;
  return <Markdownish content={displayContent} threadId={threadId} streaming={_streaming} />;
}
