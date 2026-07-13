import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Minimize2 } from "lucide-react";
import type { ContextUsage } from "@/components/agent/agentTimelineModel";
import { useAnchoredPopover } from "@/components/agent/useAnchoredPopover";

export function ContextUsageButton({
  usage,
  autoCompactThresholdPercent,
  compacting,
  compactDisabled,
  onCompact,
}: {
  usage: ContextUsage | null;
  autoCompactThresholdPercent: number;
  compacting: boolean;
  compactDisabled: boolean;
  onCompact: () => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const popover = useAnchoredPopover({
    open: open && !compacting && Boolean(usage),
    anchorRef: buttonRef,
    popoverRef,
    width: 256,
    estimatedHeight: 236,
    minHeight: 188,
    gap: 10,
  });

  const clearCloseTimer = () => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  };

  const showMenu = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const hideMenuSoon = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      closeTimerRef.current = null;
    }, 90);
  };

  useEffect(() => () => clearCloseTimer(), []);

  if (compacting) {
    return (
      <button
        type="button"
        disabled
        className="relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[hsl(var(--status-warning)/0.12)] text-[hsl(var(--status-warning))]"
        title="正在压缩上下文"
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </button>
    );
  }
  if (!usage) return null;

  const contextInputTokens = usage.contextInputTokens ?? usage.inputTokens;
  const ratio = usage.contextWindow ? clampNumber(contextInputTokens / usage.contextWindow, 0, 1) : 0;
  const compactThresholdRatio = clampNumber(autoCompactThresholdPercent, 50, 95) / 100;
  const compactThreshold = usage.contextWindow ? usage.contextWindow * compactThresholdRatio : 0;
  const warning = compactThreshold > 0 ? contextInputTokens / compactThreshold >= 0.8 : false;
  const percent = usage.contextWindow ? Math.round((contextInputTokens / usage.contextWindow) * 100) : undefined;
  const contextWindowLabel = usage.contextWindowSource === "inferred" ? "估算窗口" : usage.contextWindowSource === "unknown" ? "未知窗口" : "上下文窗口";
  const usageLabel = usage.contextWindow
    ? `${formatTokens(contextInputTokens)} / ${formatTokens(usage.contextWindow)}`
    : `${formatTokens(contextInputTokens)} 已使用`;
  const cacheHitLabel = typeof usage.cacheHitRate === "number" && Number.isFinite(usage.cacheHitRate)
    ? `${Math.round(clampNumber(usage.cacheHitRate, 0, 1) * 100)}%`
    : "暂无数据";

  return (
    <div className="relative">
      <button
        type="button"
        ref={buttonRef}
        className={`relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition hover:bg-[hsl(var(--foreground)/0.08)] hover:text-foreground ${
          warning ? "text-[hsl(var(--status-warning))] hover:bg-[hsl(var(--status-warning)/0.1)]" : "text-muted-foreground"
        }`}
        aria-label="Context usage"
        title="Context usage"
        onMouseEnter={showMenu}
        onMouseLeave={hideMenuSoon}
        onFocus={showMenu}
        onBlur={hideMenuSoon}
      >
        <ContextUsageRing ratio={ratio} warning={warning} />
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="brevyn-popover-surface fixed z-[160] overflow-y-auto rounded-[var(--radius-panel)] p-3 text-xs transition-opacity duration-100 brevyn-scrollbar"
          style={{ ...popover.style, opacity: popover.ready ? 1 : 0 }}
          onMouseEnter={showMenu}
          onMouseLeave={hideMenuSoon}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[12px] font-semibold text-foreground">上下文用量</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {usageLabel} · {contextWindowLabel}
              </p>
            </div>
            {percent !== undefined && (
              <span className={`rounded-full px-2 py-1 text-[10px] font-semibold ${warning ? "bg-[hsl(var(--status-warning)/0.12)] text-[hsl(var(--status-warning))]" : "bg-muted text-muted-foreground"}`}>
                {percent}%
              </span>
            )}
          </div>
          <div className="mt-3 grid gap-1.5">
            <ContextUsageTextRow label="模型" value={usage.modelId} />
            <ContextUsageTextRow label="使用量" value={usageLabel} />
          </div>
          <div className="mt-3 border-t border-border/55 pt-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[11px] font-medium text-muted-foreground">平均缓存命中率</span>
              <span className="font-mono text-[13px] font-semibold text-foreground">{cacheHitLabel}</span>
            </div>
          </div>
          <button
            type="button"
            className={`mt-3 inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-xl border px-3 text-[11px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
              warning
                ? "border-transparent bg-[hsl(var(--status-warning))] text-background hover:brightness-95"
                : "border-border bg-background/70 text-foreground hover:bg-accent"
            }`}
            disabled={compactDisabled}
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
          >
            <Minimize2 className="h-3.5 w-3.5" />
            压缩上下文
          </button>
        </div>,
        document.body,
      )}
    </div>
  );
}

function ContextUsageRing({ ratio, warning }: { ratio: number; warning: boolean }) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const clampedRatio = clampNumber(ratio, 0, 1);
  const dashOffset = circumference * (1 - clampedRatio);

  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 20 20"
      className={`relative h-[18px] w-[18px] shrink-0 transition-colors ${warning ? "text-[hsl(var(--status-warning))]" : "text-[hsl(var(--foreground)/0.68)]"}`}
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.18"
        strokeWidth="2"
      />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={dashOffset}
        transform="rotate(-90 10 10)"
        style={{ transition: "stroke-dashoffset 320ms ease-out" }}
      />
      <circle cx="10" cy="10" r="2" fill="currentColor" opacity="0.78" />
    </svg>
  );
}

function ContextUsageTextRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex items-center justify-between gap-3 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-medium text-foreground">{value}</span>
    </div>
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimNumber(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${trimNumber(tokens / 1_000)}K`;
  return String(tokens);
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
