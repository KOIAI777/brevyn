import type { ToolCardHelpers } from "./types";
import { PreviewBlock, PreviewPill } from "./shared";
import { formatUnknown, getToolInputPath, recordObject, stringValue } from "@/components/agent/tool-cards/toolModel";

export function ToolInputPreview({
  toolName,
  input,
  compact = false,
  ...helpers
}: {
  toolName: string;
  input: unknown;
  compact?: boolean;
} & ToolCardHelpers) {
  const data = recordObject(input);
  const path = getToolInputPath(data);
  const command = stringValue(data.command, "");
  const url = stringValue(data.url, "");
  const query = stringValue(data.query, "");
  const pattern = stringValue(data.pattern, "");
  const content = data.content ?? data.new_string ?? data.new_text ?? data.edits ?? data.todos ?? input;

  if (toolName === "Bash" && command) {
    return (
      <PreviewBlock label="Command" value={command} language="bash" compact={compact} truncatePreview={helpers.truncatePreview} />
    );
  }

  if ((toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") && path) {
    return (
      <div className="mt-2">
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/35 px-3 py-2 text-xs">
          <span className="min-w-0 truncate font-medium text-foreground" title={path}>
            {fileName(path)}
          </span>
        </div>
        <PreviewBlock label={toolName === "Write" ? "Content" : "Change"} value={fileChangeSummary(toolName, data, formatUnknown(content))} compact truncatePreview={helpers.truncatePreview} />
      </div>
    );
  }

  if ((toolName === "Read" || toolName === "Glob" || toolName === "Grep") && (path || pattern)) {
    return (
      <div className="mt-2 flex flex-wrap gap-2">
        {path && <PreviewPill label="Path" value={path} />}
        {pattern && <PreviewPill label="Pattern" value={pattern} />}
      </div>
    );
  }

  if (toolName === "WebFetch" && url) {
    return <PreviewPill label="URL" value={url} />;
  }

  if (toolName === "WebSearch" && query) {
    return <PreviewPill label="Query" value={query} />;
  }

  return <PreviewBlock label="Input" value={formatUnknown(input)} compact={compact} truncatePreview={helpers.truncatePreview} />;
}

function fileName(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) || path;
}

function fileChangeSummary(toolName: string, input: Record<string, unknown>, fallback: string): string {
  if (toolName === "Write") {
    const content = typeof input.content === "string" ? input.content : "";
    if (content) return `准备写入 ${lineCount(content)} 行`;
  }
  if (toolName === "Edit") return "准备应用 1 处修改";
  if (toolName === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits.length : 0;
    if (edits > 0) return `准备应用 ${edits} 处修改`;
  }
  return fallback;
}

function lineCount(value: string): number {
  if (!value) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return value.endsWith("\n") ? Math.max(0, count - 1) : count;
}
