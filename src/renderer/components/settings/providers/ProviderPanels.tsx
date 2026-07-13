import { Eye, TerminalSquare, ToggleLeft, ToggleRight } from "lucide-react";
import { cx } from "@/lib/cn";
import type { AgentGatewayStatus, RecognizedAcademicCalendar, RecognizedCourseTimetable } from "../../../../types/domain";

type VisionTestResult = RecognizedAcademicCalendar | RecognizedCourseTimetable;

export function AgentGatewayAdvancedPanel({
  status,
  busy,
  onToggle,
}: {
  status: AgentGatewayStatus | null;
  busy: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const enabled = Boolean(status?.enabled);
  const label = agentGatewayStatusLabel(status);
  const detail = status?.state === "running" && status.url
    ? `${status.url}${status.activeRuns > 0 ? ` · ${status.activeRuns} 个运行中` : ""}`
    : status?.state === "failed"
      ? status.error || "启动失败"
      : "关闭时仍会在 OpenAI Responses Agent 运行时按需启动。";
  return (
    <div className="mt-3 rounded-lg border bg-card/70 px-3 py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <TerminalSquare className="h-3.5 w-3.5 text-muted-foreground" />
            OpenAI Responses Gateway
            <span className={cx("rounded-full px-1.5 py-0.5 text-[10px] font-medium", status?.state === "failed" ? "bg-rose-100 text-rose-800" : "bg-muted text-muted-foreground")}>
              {label}
            </span>
          </div>
          <div className="mt-1 text-[11px] leading-5 text-muted-foreground">
            {detail}
          </div>
        </div>
        <button
          type="button"
          className={cx(
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-60",
            enabled ? "border-[hsl(var(--status-success)/0.26)] bg-[hsl(var(--status-success)/0.12)] text-[hsl(var(--status-success))] hover:bg-[hsl(var(--status-success)/0.18)]" : "bg-background text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          onClick={() => onToggle(!enabled)}
          disabled={busy || status?.state === "starting" || status?.state === "stopping"}
        >
          {enabled ? <ToggleRight className="h-4 w-4" /> : <ToggleLeft className="h-4 w-4" />}
          {busy || status?.state === "starting" || status?.state === "stopping" ? "处理中" : enabled ? "开启" : "关闭"}
        </button>
      </div>
    </div>
  );
}

function agentGatewayStatusLabel(status: AgentGatewayStatus | null): string {
  if (!status) return "加载中";
  if (!status.enabled && status.state === "disabled") return "按需模式";
  if (status.state === "running") return "运行中";
  if (status.state === "starting") return "启动中";
  if (status.state === "stopping") return "停止中";
  if (status.state === "failed") return "启动失败";
  return status.enabled ? "已启用" : "按需模式";
}

export function VisionTestResultPanel({ result }: { result: VisionTestResult }) {
  const summary = result.kind === "academic_calendar"
    ? `${result.events.length} 个校历事件${result.semester?.term ? ` · ${result.semester.term}` : ""}`
    : `${result.courses.length} 门课程${result.semesterLabel ? ` · ${result.semesterLabel}` : ""}`;
  const warnings = result.warnings.length;
  return (
    <div className="mt-3 overflow-hidden rounded-lg border bg-card/80">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Eye className="h-3.5 w-3.5" />
            视觉测试结果
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={result.sourcePath}>
            {summary}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1 text-[10px] text-muted-foreground">
          <span className="rounded-full bg-muted px-2 py-1">{result.modelId}</span>
          {warnings > 0 && <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-900">{warnings} 条提醒</span>}
        </div>
      </div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 text-[11px] leading-5 text-muted-foreground brevyn-scrollbar">
        {JSON.stringify(result, null, 2)}
      </pre>
    </div>
  );
}
