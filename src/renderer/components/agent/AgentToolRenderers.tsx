import { useContext } from "react";
import { FilePlus, FileSearch, FileText, FolderOpen, FolderTree, Globe, HelpCircle, ListTodo, MessageCircleQuestion, Pencil, Search, ShieldAlert, ShieldCheck, Sparkles, TerminalSquare } from "lucide-react";
import { ToolUseCard as BaseToolUseCard } from "@/components/agent/AgentToolCards";
import { AgentThreadIdContext } from "@/components/agent/AgentThreadContext";
import { FilePathChip } from "@/components/chat/FilePathChip";
import {
  formatDiffStats,
  getToolInputPath,
  getToolDiffStatsForDisplay,
  getToolTitle,
  isCreatedFileWriteResult,
  recordObject,
  truncatePreview,
  type ToolResultBlock,
  type ToolUseBlock,
} from "@/components/agent/tool-cards/toolModel";

export function ToolUseCard({
  block,
  result,
  collapsed,
  onToggleCollapsed,
}: {
  block: ToolUseBlock;
  result?: ToolResultBlock;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <BaseToolUseCard
      block={block}
      result={result}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      truncatePreview={truncatePreview}
      renderToolGlyph={(toolName, className, result) => <ToolGlyph toolName={toolName} result={result} className={className} />}
    />
  );
}

export function ToolTitle({ toolName, input, result, isError = false }: { toolName: string; input: unknown; result?: ToolResultBlock; isError?: boolean }) {
  const threadId = useContext(AgentThreadIdContext);
  const data = recordObject(input);
  const path = getToolInputPath(data);
  const diff = getToolDiffStatsForDisplay(toolName, input, result);
  const diffLabel = diff && !isError ? formatDiffStats(diff) : "";

  if (toolName === "Read") {
    if (path) {
      return (
        <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
          <span className="shrink-0">读取</span>
          <FilePathChip filePath={path} threadId={threadId} />
        </span>
      );
    }
    return <span>读取</span>;
  }

  if (path && (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit")) {
    const verb = !result ? "正在编辑" : isCreatedFileWriteResult(toolName, result) ? "已创建" : isError ? "编辑失败" : "已编辑";
    return (
      <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1.5">
        <span className="shrink-0">{verb}</span>
        <FilePathChip filePath={path} threadId={threadId} />
        {diffLabel && <DiffStatsText value={diffLabel} />}
      </span>
    );
  }

  return <span>{getToolTitle(toolName, input)}</span>;
}

export function DiffStatsText({ value }: { value: string }) {
  if (!value) return null;
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

export function ToolGlyph({ toolName, result, className }: { toolName: string; result?: ToolResultBlock; className?: string }) {
  if (toolName === "Bash") return <TerminalSquare className={className} />;
  if (toolName === "Read") return <FileText className={className} />;
  if (toolName === "Glob") return <FolderOpen className={className} />;
  if (toolName === "Grep") return <Search className={className} />;
  if (isCreatedFileWriteResult(toolName, result)) return <FilePlus className={className} />;
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") return <Pencil className={className} />;
  if (toolName === "TodoWrite" || toolName === "TodoRead" || toolName === "TaskCreate" || toolName === "TaskGet" || toolName === "TaskUpdate" || toolName === "TaskList") return <ListTodo className={className} />;
  if (toolName === "mcp__brevyn__course_structure") return <FolderTree className={className} />;
  if (toolName === "mcp__brevyn__rag_search") return <FileSearch className={className} />;
  if (toolName === "mcp__brevyn__read_parsed_file") return <FileText className={className} />;
  if (toolName === "WebFetch" || toolName === "WebSearch") return <Globe className={className} />;
  if (toolName === "Skill") return <Sparkles className={className} />;
  if (toolName === "AskUserQuestion") return <MessageCircleQuestion className={className} />;
  if (toolName === "EnterPlanMode" || toolName === "ExitPlanMode") return <ShieldAlert className={className} />;
  if (toolName.startsWith("mcp__brevyn__")) return <ShieldCheck className={className} />;
  return <HelpCircle className={className} />;
}
