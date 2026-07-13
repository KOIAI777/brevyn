import { ChevronDown } from "lucide-react";
import type { AgentPermissionMode } from "@/types/domain";

interface RunSummary {
  runId: string;
  label: string;
  running: boolean;
  status: "running" | "completed" | "stopped" | "failed" | "interrupted";
  permissionMode?: AgentPermissionMode;
  detail?: string;
}

interface TimelineTone {
  text: string;
  dot: string;
  detail: string;
}

interface ProcessTimelinePanelProps {
  summary: RunSummary;
  expanded: boolean;
  lockedOpen: boolean;
  collapsible: boolean;
  onToggle: () => void;
  runSummaryTone: (status: RunSummary["status"]) => TimelineTone;
}

export function ProcessTimelinePanel({
  summary,
  expanded,
  lockedOpen,
  collapsible,
  onToggle,
  runSummaryTone,
}: ProcessTimelinePanelProps) {
  const isThinkingOnly = summary.running && summary.label === "Thinking";
  const canToggle = collapsible && !lockedOpen;
  const tone = runSummaryTone(summary.status);

  return (
    <div className="w-full">
      <button
        type="button"
        className={`flex w-fit items-center gap-2 rounded-lg px-1 py-1 text-left text-[13px] font-semibold transition-[background-color,color,opacity,transform] duration-300 ${canToggle ? "hover:bg-accent/35 hover:text-foreground" : "cursor-default"} ${tone.text}`}
        onClick={canToggle ? onToggle : undefined}
        disabled={!canToggle}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
        {isThinkingOnly ? (
          <span className="taskagent-sweep-text">Thinking</span>
        ) : (
          <span className="transition-opacity duration-300">{summary.label}</span>
        )}
        {summary.permissionMode && !isThinkingOnly && (
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none ${permissionModeBadgeClass(summary.permissionMode)}`}>
            {permissionModeLabel(summary.permissionMode)}
          </span>
        )}
        {collapsible && <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`} />}
      </button>
      {summary.detail && summary.status !== "completed" && !expanded && (
        <p className="mt-0.5 max-w-xl truncate px-1 text-[11px] text-muted-foreground">{summary.detail}</p>
      )}
      <div className="mt-1 h-px w-full bg-gradient-to-r from-border/70 via-border/25 to-transparent" />
    </div>
  );
}

function permissionModeLabel(mode: AgentPermissionMode): string {
  if (mode === "bypassPermissions") return "完全自动";
  if (mode === "plan") return "计划模式";
  return "自动审批";
}

function permissionModeBadgeClass(mode: AgentPermissionMode): string {
  if (mode === "bypassPermissions") return "brevyn-status-pill-warning";
  if (mode === "plan") return "bg-[hsl(var(--foreground)/0.06)] text-muted-foreground";
  return "bg-[hsl(var(--foreground)/0.055)] text-muted-foreground";
}
