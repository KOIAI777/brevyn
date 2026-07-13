import type { ToolCardHelpers, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/types";
import { ToolDetailsShell } from "@/components/agent/tool-cards/shared";
import { recordObject, stringValue } from "@/components/agent/tool-cards/toolModel";
import { parseRagEvidenceOutput, type RagEvidence } from "@/components/agent/ragEvidence";

export function RagSearchResultDetails({
  toolUse,
  result,
}: {
  toolUse: ToolUseBlock;
  result?: ToolResultBlock;
} & ToolCardHelpers) {
  const query = stringValue(recordObject(toolUse.input).query, "course materials");
  const parsed = parseRagOutput(result);
  const countLabel = result ? `${parsed.results.length} 条证据` : "检索中";
  return (
    <ToolDetailsShell className="bg-[linear-gradient(180deg,hsl(var(--card)/0.9),hsl(var(--surface-panel)/0.78))] px-3 py-3 shadow-[var(--shadow-card)]">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">课程证据</p>
          <p className="mt-1 break-words text-xs leading-5 text-foreground">“{query}”</p>
        </div>
        <span className="shrink-0 rounded-[var(--radius-badge)] bg-background/72 px-2 py-1 text-[10px] font-medium text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
          {countLabel}
        </span>
      </div>
      {result && (
        <div className="mt-3 max-h-[34rem] space-y-2 overflow-y-auto pr-1 [contain:layout_paint_style] brevyn-scrollbar">
          {parsed.results.length > 0 ? (
            parsed.results.map((item, index) => (
              <div
                key={`${item.path}-${item.chunkIndex ?? index}-${index}`}
                className="group min-w-0 rounded-[var(--radius-control)] bg-background/62 px-2.5 py-2 text-xs text-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.46)] transition hover:bg-accent/35 [contain:layout_paint_style]"
                title={item.path || item.citation}
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-badge)] bg-foreground text-[10px] font-semibold text-background">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium text-foreground">{item.fileName || item.path || "课程材料"}</span>
                      <span className="shrink-0 rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {scoreLabel(item.score)}
                      </span>
                    </div>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span>{sectionLabel(item.sectionKind)}</span>
                      <span className="h-1 w-1 rounded-full bg-muted-foreground/35" />
                      <span>{chunkLabel(item)}</span>
                    </div>
                    <p className="mt-1.5 line-clamp-3 break-words text-[11px] leading-5 text-muted-foreground">
                      {item.text || item.citation || "没有返回可预览的片段。"}
                    </p>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="rounded-[var(--radius-control)] bg-background/62 px-3 py-4 text-center text-xs leading-5 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.42)]">
              没有找到匹配的课程证据。可以换一个更具体的关键词，或先确认相关资料已经完成索引。
            </div>
          )}
        </div>
      )}
    </ToolDetailsShell>
  );
}

function parseRagOutput(result: ToolResultBlock | undefined): { count: number; results: RagEvidence[] } {
  return parseRagEvidenceOutput(result);
}

function scoreLabel(score?: number): string {
  if (typeof score !== "number") return "相关";
  const value = Math.round(score * 100);
  if (value >= 78) return "高度相关";
  if (value >= 62) return "相关";
  return `${value}%`;
}

function chunkLabel(item: RagEvidence): string {
  if (typeof item.chunkIndex === "number" && typeof item.chunkCount === "number") return `片段 ${item.chunkIndex + 1}/${item.chunkCount}`;
  if (typeof item.chunkIndex === "number") return `片段 ${item.chunkIndex + 1}`;
  return item.citation || "证据片段";
}

function sectionLabel(sectionKind?: string): string {
  if (sectionKind === "lecture") return "课件";
  if (sectionKind === "course_shared") return "课程资料";
  if (sectionKind === "task") return "课程作业";
  return "课程材料";
}
