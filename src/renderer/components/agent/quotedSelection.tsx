import { FileText, MessageSquareQuote, X } from "lucide-react";
import type { ReactElement } from "react";
import type { ContextAnchor, FileContextAnchor, MessageContextAnchor } from "@/types/domain";
import {
  MAX_CONTEXT_ANCHOR_CHARS,
  contextAnchorId,
  contextAnchorLabel,
  contextAnchorPath,
  contextAnchorSourceLabel,
  createFileContextAnchor,
  createMessageContextAnchor,
  parseContextAnchors,
  promptWithContextAnchors,
  stripContextAnchors,
  type ParsedContextAnchorRef,
} from "../../../shared/context-anchor";

export type AgentQuotedSelection = ContextAnchor;
export type AgentQuotedFileSelection = FileContextAnchor;
export type AgentQuotedMessageSelection = MessageContextAnchor;
export type ParsedAgentQuote = ParsedContextAnchorRef;

export const MAX_QUOTED_SELECTION_CHARS = MAX_CONTEXT_ANCHOR_CHARS;
export const quoteSelectionId = contextAnchorId;
export const createQuotedSelection = createFileContextAnchor;
export const createQuotedMessageSelection = createMessageContextAnchor;
export const promptWithQuotedSelection = promptWithContextAnchors;
export const stripQuotedSelections = stripContextAnchors;
export const quoteLabel = contextAnchorLabel;
export const quotePath = contextAnchorPath;

export function parseQuotedSelections(content: string): { quotes: ParsedAgentQuote[]; text: string } {
  const parsed = parseContextAnchors(content);
  return { quotes: parsed.anchors, text: parsed.text };
}

export function QuotedSelectionChip({
  quote,
  removable = false,
  onRemove,
}: {
  quote: AgentQuotedSelection | ParsedAgentQuote;
  removable?: boolean;
  onRemove?: () => void;
}): ReactElement {
  const kind = quote.kind;
  const filename = quoteLabel(quote);
  const path = quotePath(quote);
  const sourceLabel = quote.kind === "file" ? contextAnchorSourceLabel(quote) : "";
  const text = "text" in quote ? quote.text : "";
  const excerpt = text ? quoteTextExcerpt(text) : "";
  const title = text ? `${filename}${sourceLabel ? ` · ${sourceLabel}` : ""}${path ? `\n${path}` : ""}\n\n${text}` : path || filename;
  return (
    <span
      className="group/quote relative inline-flex max-w-[min(22rem,100%)] items-start gap-2 overflow-hidden rounded-lg border border-border/70 bg-background/68 py-1.5 pl-3 pr-1 text-[11px] font-medium text-foreground shadow-[inset_0_1px_0_hsl(var(--background)/0.65)] ring-1 ring-background/45 transition hover:border-primary/24 hover:bg-accent/42"
      title={title}
    >
      <span className="absolute inset-y-1 left-1 w-0.5 rounded-full bg-primary/45" />
      <span className="ml-1 mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-foreground/[0.055] text-muted-foreground">
        {kind === "message" ? <MessageSquareQuote className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.04em] text-muted-foreground/75">
            {kind === "message" ? "对话引用" : "文件引用"}
          </span>
          <span className="min-w-0 max-w-44 truncate text-foreground/90">{filename}</span>
          {sourceLabel && <span className="shrink-0 text-[10px] text-muted-foreground">{sourceLabel}</span>}
        </span>
        {excerpt ? (
          <span className="line-clamp-3 min-w-0 max-w-[18rem] whitespace-normal break-words text-[11px] leading-4 text-muted-foreground">“{excerpt}”</span>
        ) : (
          <span className="line-clamp-3 min-w-0 max-w-[18rem] whitespace-normal break-words text-[11px] leading-4 text-muted-foreground">{path}</span>
        )}
      </span>
      {"text" in quote && <span className="mt-0.5 shrink-0 rounded-md bg-foreground/[0.055] px-1.5 py-0.5 text-[10px] text-muted-foreground">{quote.text.trim().length} 字</span>}
      {removable && (
        <button
          type="button"
          className="ml-0.5 mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-background hover:text-foreground"
          onClick={onRemove}
          aria-label={`Remove quoted selection from ${filename}`}
          title="移除引用"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function quoteTextExcerpt(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 180)}...`;
}
