import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Map, ShieldAlert, ShieldCheck } from "lucide-react";
import type { AgentPermissionMode } from "@/types/domain";
import { useAnchoredPopover } from "@/components/agent/useAnchoredPopover";

const MODE_ORDER: AgentPermissionMode[] = ["auto", "bypassPermissions", "plan"];

const MODE_COPY: Record<AgentPermissionMode, { label: string; description: string; next: string; tone: string; icon: typeof ShieldCheck }> = {
  auto: {
    label: "自动审批",
    description: "自动判断工具风险，必要时再请求确认。",
    next: "完全自动",
    tone: "text-muted-foreground",
    icon: ShieldCheck,
  },
  bypassPermissions: {
    label: "完全自动",
    description: "跳过权限确认，仅适合受信任工作区。",
    next: "计划模式",
    tone: "text-[hsl(var(--status-warning))]",
    icon: ShieldAlert,
  },
  plan: {
    label: "计划模式",
    description: "只产出计划，不执行写入或命令。",
    next: "自动审批",
    tone: "text-muted-foreground",
    icon: Map,
  },
};

export function AgentPermissionModeButton({
  running,
  permissionMode,
  onSetPermissionMode,
}: {
  running: boolean;
  permissionMode: AgentPermissionMode;
  onSetPermissionMode: (mode: AgentPermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const copy = MODE_COPY[permissionMode];
  const Icon = copy.icon;
  const popover = useAnchoredPopover({
    open,
    anchorRef: buttonRef,
    popoverRef,
    width: 256,
    estimatedHeight: 104,
    minHeight: 96,
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

  function cycleMode() {
    const index = MODE_ORDER.indexOf(permissionMode);
    onSetPermissionMode(MODE_ORDER[(index + 1) % MODE_ORDER.length] || "auto");
  }

  useEffect(() => () => clearCloseTimer(), []);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        ref={buttonRef}
        disabled={running}
        onClick={cycleMode}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-[hsl(var(--foreground)/0.08)] disabled:cursor-not-allowed disabled:opacity-45 ${copy.tone}`}
        aria-label={copy.label}
        onMouseEnter={showPopover}
        onMouseLeave={hidePopoverSoon}
        onFocus={showPopover}
        onBlur={hidePopoverSoon}
      >
        <Icon className="h-4 w-4" strokeWidth={2.1} />
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="brevyn-popover-surface fixed z-[160] rounded-[var(--radius-card)] text-[11px] text-muted-foreground transition-opacity duration-100"
          style={{ ...popover.style, maxHeight: undefined, opacity: popover.ready ? 1 : 0 }}
          onMouseEnter={showPopover}
          onMouseLeave={hidePopoverSoon}
        >
          <div className="px-3 py-2">
            <p className="font-semibold text-foreground">{copy.label}</p>
            <p className="mt-0.5 line-clamp-2 leading-4">{copy.description}</p>
          </div>
          {!running && (
            <p className="border-t border-border/55 bg-background/70 px-3 py-1.5 text-[10px] leading-4 text-muted-foreground/80">
              点击切换到 {copy.next}
            </p>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
