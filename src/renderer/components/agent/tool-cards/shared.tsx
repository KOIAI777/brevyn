import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";

const LONG_TOOL_TEXT_LIMIT = 12_000;
const LONG_TOOL_TEXT_LINES = 180;

export function ToolDetailsShell({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 overflow-hidden rounded-xl border border-border/60 bg-background/54 shadow-sm ring-1 ring-border/35 ${className}`}>
      {children}
    </div>
  );
}

export function ToolCodeBlock({
  children,
  className = "",
  maxHeight = "max-h-72",
}: {
  children: ReactNode;
  className?: string;
  maxHeight?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = textContent(children);
  const preview = text && !expanded ? truncateLongText(text, LONG_TOOL_TEXT_LIMIT, LONG_TOOL_TEXT_LINES) : null;
  const truncated = Boolean(preview && preview !== text);

  return (
    <div className="min-w-0 max-w-full overflow-hidden">
      <pre className={`${maxHeight} max-w-full overflow-auto whitespace-pre-wrap break-words bg-[linear-gradient(135deg,hsl(var(--surface-warm)/0.94),hsl(var(--muted)/0.86))] px-4 py-3 font-mono text-[12px] leading-6 text-muted-foreground shadow-inner [contain:layout_paint_style] brevyn-scrollbar ${className}`}>
        {truncated ? preview : children}
      </pre>
      {truncated && (
        <button
          type="button"
          className="w-full border-t border-border/60 bg-background/72 px-3 py-2 text-left text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
          onClick={() => setExpanded(true)}
        >
          展开完整内容
        </button>
      )}
    </div>
  );
}

export function PreviewPill({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-2 py-1 text-[11px] text-muted-foreground">
      <span className="shrink-0 font-medium text-foreground">{label}</span>
      <span className="truncate">{value}</span>
    </span>
  );
}

export function PreviewBlock({
  label,
  value,
  language,
  compact = false,
  truncatePreview,
}: {
  label: string;
  value: string;
  language?: string;
  compact?: boolean;
  truncatePreview: (value: string) => string;
}) {
  return (
    <div className="mt-2">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <ToolDetailsShell className="mt-1">
        <ToolCodeBlock maxHeight={compact ? "max-h-36" : "max-h-56"} className="text-[11px] leading-5">
          {language ? `$ ${truncatePreview(value)}` : truncatePreview(value)}
        </ToolCodeBlock>
      </ToolDetailsShell>
    </div>
  );
}

export function DeferredToolDetails({
  collapsed,
  defer = true,
  children,
}: {
  collapsed: boolean;
  defer?: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(() => !collapsed);

  useLayoutEffect(() => {
    if (!collapsed) setMounted(true);
  }, [collapsed]);

  useEffect(() => {
    if (!collapsed) return undefined;
    if (!defer) {
      setMounted(false);
      return undefined;
    }
    const timeout = window.setTimeout(() => setMounted(false), 260);
    return () => window.clearTimeout(timeout);
  }, [collapsed, defer]);

  if (!mounted) return null;
  return <div className="tool-details-content-in [contain:layout_paint_style]">{children}</div>;
}

function textContent(value: ReactNode): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(textContent).join("");
  return "";
}

function truncateLongText(value: string, maxChars: number, maxLines: number): string {
  if (value.length <= maxChars && lineCount(value) <= maxLines) return value;
  const byChars = value.slice(0, maxChars);
  const lines = byChars.split("\n");
  const preview = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : byChars;
  return `${preview.trimEnd()}\n\n... 已截断长输出，展开后查看完整内容`;
}

function lineCount(value: string): number {
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return count;
}
