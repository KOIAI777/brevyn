import { AlertCircle, CheckCircle2, Clock3, Loader2, MinusCircle, XCircle } from "lucide-react";
import { createPortal } from "react-dom";
import { memo, useEffect, useRef, useState } from "react";
import type { FileIndexingStatus, WorkspaceFileNode } from "@/types/domain";
import { cx } from "@/lib/cn";
import { useAnchoredPopover } from "@/components/agent/useAnchoredPopover";

type IndexingStatusBadgeRow = {
  label: string;
  value: string;
};

type IndexingStatusBadgeProps = {
  status: FileIndexingStatus;
  label?: string;
  title?: string;
  description?: string;
  rows?: IndexingStatusBadgeRow[];
  compact?: boolean;
  className?: string;
};

export const FileIndexingBadge = memo(function FileIndexingBadge({ file, compact = false }: { file: WorkspaceFileNode; compact?: boolean }) {
  if (file.kind === "folder") return null;
  if (!isRagEligibleFile(file)) return null;
  const status = file.indexingStatus || "idle";
  if (status === "idle" && compact) return null;
  const label = statusLabel(status);
  const details = fileIndexingDetails(file, label);
  return (
    <IndexingStatusBadge
      status={status}
      label={label}
      title={details.title}
      description={details.description}
      rows={details.rows}
      compact={compact}
    />
  );
}, areFileIndexingBadgePropsEqual);

export function IndexingStatusBadge({
  status,
  label = statusLabel(status),
  title,
  description,
  rows = [],
  compact = false,
  className,
}: IndexingStatusBadgeProps) {
  const [open, setOpen] = useState(false);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const Icon = statusIcon(status);
  const safeTitle = title || label;
  const visibleRows = rows.filter((row) => row.value.trim());
  const hasDetails = Boolean(description || visibleRows.length > 0);
  const popover = useAnchoredPopover({
    open,
    anchorRef: badgeRef,
    popoverRef,
    width: 292,
    estimatedHeight: hasDetails ? 168 : 92,
    minHeight: 76,
    gap: 8,
  });

  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const showPopover = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const hidePopoverSoon = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 90);
  };

  useEffect(() => () => clearCloseTimer(), []);

  return (
    <>
      <span
        ref={badgeRef}
        role="status"
        tabIndex={0}
        aria-label={safeTitle}
        className={cx(
          "inline-flex shrink-0 cursor-default items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] leading-none outline-none transition",
          "focus-visible:ring-2 focus-visible:ring-ring/25",
          compact ? "min-w-5 justify-center" : "min-w-[3.75rem] justify-center",
          statusTone(status),
          className,
        )}
        onMouseEnter={showPopover}
        onMouseLeave={hidePopoverSoon}
        onFocus={showPopover}
        onBlur={hidePopoverSoon}
      >
        <Icon className={cx("h-3 w-3", status === "indexing" && "animate-spin")} />
        {!compact && <span>{label}</span>}
      </span>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="brevyn-popover-surface fixed z-[160] overflow-hidden rounded-[var(--radius-card)] text-[11px] text-muted-foreground transition-opacity duration-100"
          style={{ ...popover.style, opacity: popover.ready ? 1 : 0 }}
          onMouseEnter={showPopover}
          onMouseLeave={hidePopoverSoon}
        >
          <div className="px-3 py-2.5">
            <div className="flex items-start gap-2">
              <Icon className={cx("mt-0.5 h-3.5 w-3.5 shrink-0", status === "indexing" && "animate-spin", statusTextTone(status))} />
              <div className="min-w-0">
                <p className="break-words text-[12px] font-semibold leading-4 text-foreground">{safeTitle}</p>
                {description && <p className="mt-1 break-words leading-4 text-muted-foreground">{description}</p>}
              </div>
            </div>
            {visibleRows.length > 0 && (
              <div className="mt-2.5 grid gap-1.5 border-t border-border/55 pt-2">
                {visibleRows.map((row) => (
                  <div key={`${row.label}:${row.value}`} className="grid grid-cols-[4.25rem_minmax(0,1fr)] gap-2">
                    <span className="text-muted-foreground/72">{row.label}</span>
                    <span className="min-w-0 break-words text-foreground/86">{row.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function areFileIndexingBadgePropsEqual(
  a: { file: WorkspaceFileNode; compact?: boolean },
  b: { file: WorkspaceFileNode; compact?: boolean },
): boolean {
  return (
    a.compact === b.compact &&
    a.file.kind === b.file.kind &&
    a.file.ragEligible === b.file.ragEligible &&
    a.file.indexedAt === b.file.indexedAt &&
    a.file.indexingStatus === b.file.indexingStatus &&
    a.file.indexingError === b.file.indexingError &&
    a.file.indexingWarning === b.file.indexingWarning &&
    a.file.indexingParser === b.file.indexingParser &&
    a.file.indexingParserDetail === b.file.indexingParserDetail
  );
}

function isRagEligibleFile(file: WorkspaceFileNode): boolean {
  if (file.ragEligible === true) return true;
  if (file.ragEligible === false) return false;
  return Boolean(file.indexedAt || (file.indexingStatus && file.indexingStatus !== "idle"));
}

function statusIcon(status: FileIndexingStatus) {
  if (status === "indexed") return CheckCircle2;
  if (status === "indexing") return Loader2;
  if (status === "queued") return Clock3;
  if (status === "failed") return XCircle;
  if (status === "partial") return AlertCircle;
  if (status === "warning") return AlertCircle;
  if (status === "skipped") return MinusCircle;
  if (status === "cancelled") return MinusCircle;
  return Clock3;
}

function statusLabel(status: FileIndexingStatus): string {
  if (status === "indexed") return "已索引";
  if (status === "indexing") return "索引中";
  if (status === "queued") return "排队中";
  if (status === "failed") return "失败";
  if (status === "partial") return "部分索引";
  if (status === "warning") return "警告";
  if (status === "skipped") return "已跳过";
  if (status === "cancelled") return "已取消";
  return "未索引";
}

function fileIndexingDetails(file: WorkspaceFileNode, fallback: string): { title: string; description?: string; rows: IndexingStatusBadgeRow[] } {
  const message = file.indexingError || file.indexingWarning || fallback;
  const parser = parserLabel(file.indexingParserDetail || file.indexingParser);
  return {
    title: message,
    description: parser ? "这个文件进入课程知识库时使用的解析方式。" : undefined,
    rows: [
      { label: "状态", value: statusLabel(file.indexingStatus || "idle") },
      { label: "解析", value: parser },
      { label: "更新时间", value: formatDateTime(file.indexingUpdatedAt || file.indexedAt) },
    ],
  };
}

function parserLabel(value?: string): string {
  const raw = value?.trim();
  if (!raw) return "";
  return raw
    .split(" · ")
    .map((part) => {
      const normalized = part.toLowerCase();
      if (normalized === "mineru") return "MinerU";
      if (normalized === "pptx-jszip") return "本地 PPTX";
      if (normalized === "pdfjs") return "本地 PDF";
      if (normalized === "docx-jszip") return "本地 DOCX";
      if (normalized === "spreadsheet") return "本地表格";
      if (normalized === "plain-text") return "本地文本";
      if (normalized.endsWith("+ocr")) return `${parserLabel(part.slice(0, -4))} + OCR`;
      return part;
    })
    .filter(Boolean)
    .join(" · ");
}

function statusTone(status: FileIndexingStatus): string {
  if (status === "indexed") return "bg-[hsl(var(--status-success)/0.13)] text-[hsl(var(--status-success))] shadow-[inset_0_0_0_1px_hsl(var(--status-success)/0.2)] hover:bg-[hsl(var(--status-success)/0.18)]";
  if (status === "indexing") return "bg-[hsl(var(--status-info)/0.13)] text-[hsl(var(--status-info))] shadow-[inset_0_0_0_1px_hsl(var(--status-info)/0.2)] hover:bg-[hsl(var(--status-info)/0.18)]";
  if (status === "queued") return "bg-[hsl(var(--status-warning)/0.13)] text-[hsl(var(--status-warning))] shadow-[inset_0_0_0_1px_hsl(var(--status-warning)/0.2)] hover:bg-[hsl(var(--status-warning)/0.18)]";
  if (status === "failed") return "bg-[hsl(var(--status-danger)/0.13)] text-[hsl(var(--status-danger))] shadow-[inset_0_0_0_1px_hsl(var(--status-danger)/0.2)] hover:bg-[hsl(var(--status-danger)/0.18)]";
  if (status === "partial") return "bg-[hsl(var(--status-warning)/0.13)] text-[hsl(var(--status-warning))] shadow-[inset_0_0_0_1px_hsl(var(--status-warning)/0.2)] hover:bg-[hsl(var(--status-warning)/0.18)]";
  if (status === "warning") return "bg-[hsl(var(--status-warning)/0.13)] text-[hsl(var(--status-warning))] shadow-[inset_0_0_0_1px_hsl(var(--status-warning)/0.2)] hover:bg-[hsl(var(--status-warning)/0.18)]";
  if (status === "skipped") return "bg-muted text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.7)] hover:bg-muted/80";
  return "bg-muted text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.7)] hover:bg-muted/80";
}

function statusTextTone(status: FileIndexingStatus): string {
  if (status === "indexed") return "text-[hsl(var(--status-success))]";
  if (status === "indexing") return "text-[hsl(var(--status-info))]";
  if (status === "queued" || status === "partial" || status === "warning") return "text-[hsl(var(--status-warning))]";
  if (status === "failed") return "text-[hsl(var(--status-danger))]";
  return "text-muted-foreground";
}

function formatDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
