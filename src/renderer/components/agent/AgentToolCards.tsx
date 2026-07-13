import { useContext, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { AgentThreadIdContext } from "@/components/agent/AgentThreadContext";
import { FilePathChip } from "@/components/chat/FilePathChip";
import type { ToolCardHelpers, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/types";
import { renderToolDetails } from "@/components/agent/tool-result-renderers";
import { DeferredToolDetails } from "@/components/agent/tool-cards/shared";
import {
  getToolErrorSummary,
  getToolSearchLinks,
  getToolInputPath,
  getToolPhrase,
  getToolTarget,
  recordObject,
} from "@/components/agent/tool-cards/toolModel";
import { hasToolResultDiffSource } from "@/components/agent/tool-cards/toolDiffModel";
export { ToolInputPreview } from "@/components/agent/tool-cards/ToolInputPreview";

interface ToolUseCardProps extends ToolCardHelpers {
  block: ToolUseBlock;
  result?: ToolResultBlock;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function ToolUseCard({
  block,
  result,
  collapsed,
  onToggleCollapsed,
  ...helpers
}: ToolUseCardProps) {
  const phrase = getToolPhrase(block, result);
  const failed = result?.isError === true;
  const running = !result;
  const target = getToolTarget(block.name, block.input);
  const status = failed ? getToolErrorSummary(result) : phrase.status;
  const expandable = isToolExpandable(block, result);
  const effectiveCollapsed = expandable ? collapsed : true;

  return (
    <div className="overflow-hidden text-xs text-foreground">
      <ToolCardHeader
        toolUse={block}
        label={phrase.label}
        target={target}
        diffLabel={phrase.diffLabel}
        status={status}
        running={running}
        failed={failed}
        collapsed={effectiveCollapsed}
        onToggleCollapsed={onToggleCollapsed}
        expandable={expandable}
        glyph={helpers.renderToolGlyph(block.name, "h-3.5 w-3.5 shrink-0", result)}
      />
      {expandable && (
        <div className={`${effectiveCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"} grid overflow-hidden transition-[grid-template-rows,opacity] duration-[260ms] ease-[cubic-bezier(0.2,0,0,1)]`}>
          <div className="min-h-0 overflow-hidden px-1 py-0.5">
            <DeferredToolDetails collapsed={effectiveCollapsed} defer={!running}>
              {renderToolDetails({ toolUse: block, result, helpers })}
            </DeferredToolDetails>
          </div>
        </div>
      )}
    </div>
  );
}

interface ToolResultCardProps extends ToolCardHelpers {
  tool: ToolResultBlock;
  toolUse?: ToolUseBlock;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function ToolResultCard({
  tool,
  toolUse,
  collapsed,
  onToggleCollapsed,
  ...helpers
}: ToolResultCardProps) {
  if (!toolUse) return null;
  return (
    <ToolUseCard
      block={toolUse}
      result={tool}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      {...helpers}
    />
  );
}

function ToolCardHeader({
  toolUse,
  label,
  target,
  diffLabel,
  status,
  running,
  failed,
  collapsed,
  onToggleCollapsed,
  expandable,
  glyph,
}: {
  toolUse: ToolUseBlock;
  label: string;
  target: string;
  diffLabel: string;
  status: string;
  running: boolean;
  failed: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  expandable: boolean;
  glyph: ReactNode;
}) {
  const threadId = useContext(AgentThreadIdContext);
  const filePath = fileTarget(toolUse);

  return (
    <div
      role={expandable ? "button" : undefined}
      tabIndex={expandable ? 0 : undefined}
      className={`inline-flex max-w-full flex-wrap items-center gap-2 rounded-md px-0.5 py-0.5 text-left text-[11px] text-muted-foreground transition ${expandable ? "cursor-pointer hover:text-foreground" : "cursor-default"}`}
      onClick={expandable ? onToggleCollapsed : undefined}
      onKeyDown={expandable ? (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onToggleCollapsed();
      } : undefined}
      aria-expanded={expandable ? !collapsed : undefined}
    >
      <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5 font-medium text-foreground/85">
        {glyph}
        <span className={running ? "taskagent-sweep-text" : undefined}>{label}</span>
        {filePath ? (
          <FilePathChip filePath={filePath} threadId={threadId} />
        ) : target ? (
          <span className="min-w-0 truncate text-muted-foreground" title={target}>
            {target}
          </span>
        ) : null}
        {diffLabel && <DiffStatsText value={diffLabel} />}
      </span>
      <span className={`inline-flex min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground/80 ${running ? "taskagent-sweep-text" : ""}`}>
        {failed ? <X className="h-3.5 w-3.5" /> : !running ? <Check className="h-3.5 w-3.5" /> : null}
        <span className="whitespace-normal break-words">{status}</span>
        {expandable && <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`} />}
      </span>
    </div>
  );
}

function isToolExpandable(toolUse: ToolUseBlock, result?: ToolResultBlock): boolean {
  if (toolUse.name === "Read") return result?.isError === true;
  if (!result && isFileWriteTool(toolUse.name)) return false;
  if (!result) return toolUse.name !== "WebSearch";
  if (toolUse.name === "WebSearch") return getToolSearchLinks(result).length > 0;
  if (!result.isError && isFileWriteTool(toolUse.name)) return hasToolResultDiffSource(toolUse.name, result);
  return true;
}

function isFileWriteTool(toolName: string): boolean {
  return toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit";
}

function DiffStatsText({ value }: { value: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px]">
      {value.split(" ").map((part) => {
        if (part.startsWith("+")) return <span key={part} className="text-emerald-500">{part}</span>;
        if (part.startsWith("-")) return <span key={part} className="text-red-500">{part}</span>;
        return <span key={part}>{part}</span>;
      })}
    </span>
  );
}

function fileTarget(toolUse: ToolUseBlock): string {
  const input = recordObject(toolUse.input);
  if (input._partialInput === true && toolUse.name === "Read") return "";
  if (toolUse.name === "Read" || toolUse.name === "Write" || toolUse.name === "Edit" || toolUse.name === "MultiEdit") {
    return getToolInputPath(input);
  }
  return "";
}
