import * as React from "react";
import type { FileContents } from "@pierre/diffs";
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import { Check, Copy } from "lucide-react";
import type { ToolCardHelpers, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/types";
import { ToolInputPreview } from "@/components/agent/tool-cards/ToolInputPreview";
import { ToolCodeBlock, ToolDetailsShell } from "@/components/agent/tool-cards/shared";
import { getToolResultText } from "@/components/agent/tool-cards/toolModel";
import { getToolResultDiffSource, type ToolDiffSource } from "@/components/agent/tool-cards/toolDiffModel";
import { PIERRE_DIFF_CSS } from "@/components/agent/tool-result-renderers/pierre-styles";

export function isFileTool(toolName: string): boolean {
  return toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit";
}

export function FileToolDetails({
  toolUse,
  result,
  ...helpers
}: {
  toolUse: ToolUseBlock;
  result?: ToolResultBlock;
} & ToolCardHelpers) {
  if (!result) {
    return <ToolInputPreview toolName={toolUse.name} input={toolUse.input} compact {...helpers} />;
  }

  if (result.isError) {
    return (
      <>
        <ToolInputPreview toolName={toolUse.name} input={toolUse.input} compact {...helpers} />
        <ToolDetailsShell className="mt-2">
          <ToolCodeBlock maxHeight="max-h-44" className="text-[11px] leading-5 text-destructive/80">
            {getToolResultText(result)}
          </ToolCodeBlock>
        </ToolDetailsShell>
      </>
    );
  }

  if (toolUse.name === "Write") {
    return <FileDiffDetails toolName={toolUse.name} result={result} />;
  }

  if (toolUse.name === "Edit") {
    return <FileDiffDetails toolName={toolUse.name} result={result} />;
  }

  if (toolUse.name === "MultiEdit") {
    return <FileDiffDetails toolName={toolUse.name} result={result} />;
  }

  return <ToolInputPreview toolName={toolUse.name} input={toolUse.input} compact {...helpers} />;
}

function FileDiffDetails({
  toolName,
  result,
}: {
  toolName: string;
  result: ToolResultBlock;
}) {
  const source = React.useMemo(() => getToolResultDiffSource(toolName, result), [result, toolName]);
  if (!source) return null;
  return <PierreDiffSource source={source} />;
}

function PierreDiffFrame({
  children,
  filePath,
  additions,
  deletions,
  copyText,
}: {
  children: React.ReactNode;
  filePath: string;
  additions: number;
  deletions: number;
  copyText?: string;
}) {
  return (
    <div className="mt-2 flex max-h-[400px] min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-card/95 text-[11px] shadow-sm [contain:layout_paint_style]">
      <DiffFrameHeader filePath={filePath} additions={additions} deletions={deletions} copyText={copyText} />
      <div className="min-h-0 overflow-auto bg-background/70 brevyn-scrollbar">
        {children}
      </div>
    </div>
  );
}

function DiffFrameHeader({
  filePath,
  additions,
  deletions,
  copyText,
}: {
  filePath: string;
  additions: number;
  deletions: number;
  copyText?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const displayName = React.useMemo(() => basename(filePath || "file"), [filePath]);

  async function handleCopy() {
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch (error) {
      console.error("[FileDiffDetails] Failed to copy diff:", error);
    }
  }

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/35 px-3">
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium text-foreground/82" title={filePath || displayName}>
        {displayName}
      </span>
      <DiffStat value={additions} tone="add" />
      <DiffStat value={deletions} tone="delete" />
      {copyText && (
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="ml-1 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
          aria-label={copied ? "Diff copied" : "Copy diff"}
          title={copied ? "已复制" : "复制 diff"}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
}

function DiffStat({ value, tone }: { value: number; tone: "add" | "delete" }) {
  const prefix = tone === "add" ? "+" : "-";
  const color = tone === "add" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400";
  return (
    <span className={`shrink-0 font-mono text-[12px] font-semibold ${color}`}>
      {prefix}{Math.max(0, value)}
    </span>
  );
}

function usePierreDiffOptions(disableLineNumbers = false) {
  return React.useMemo(() => ({
    diffStyle: "unified" as const,
    theme: { dark: "one-dark-pro" as const, light: "one-light" as const },
    disableLineNumbers,
    disableFileHeader: true,
    diffIndicators: "bars" as const,
    hunkSeparators: "line-info" as const,
    lineDiffType: "none" as const,
    overflow: "scroll" as const,
    themeType: "system" as const,
    unsafeCSS: PIERRE_DIFF_CSS,
  }), [disableLineNumbers]);
}

function PierreDiffSource({ source }: { source: ToolDiffSource }) {
  const options = usePierreDiffOptions(source.kind === "files" && source.disableLineNumbers === true);

  if (source.kind === "patch") {
    return (
      <PierreDiffFrame filePath={source.filePath} additions={source.additions} deletions={source.deletions} copyText={source.patch}>
        <PatchDiff patch={source.patch} options={options} />
      </PierreDiffFrame>
    );
  }

  return (
    <PierreFileDiff
      filePath={source.filePath}
      oldContent={source.oldContent}
      newContent={source.newContent}
      patch={source.patch}
      additions={source.additions}
      deletions={source.deletions}
      options={options}
    />
  );
}

function PierreFileDiff({
  filePath,
  oldContent,
  newContent,
  patch,
  additions,
  deletions,
  options,
}: {
  filePath: string;
  oldContent: string;
  newContent: string;
  patch?: string;
  additions: number;
  deletions: number;
  options: ReturnType<typeof usePierreDiffOptions>;
}) {
  const oldFile = React.useMemo<FileContents>(() => ({
    name: filePath || "file",
    contents: oldContent,
    cacheKey: `old:${filePath}:${cheapHash(oldContent)}`,
  }), [filePath, oldContent]);
  const newFile = React.useMemo<FileContents>(() => ({
    name: filePath || "file",
    contents: newContent,
    cacheKey: `new:${filePath}:${cheapHash(newContent)}`,
  }), [filePath, newContent]);

  return (
    <PierreDiffFrame filePath={filePath} additions={additions} deletions={deletions} copyText={patch}>
      <MultiFileDiff oldFile={oldFile} newFile={newFile} options={options} />
    </PierreDiffFrame>
  );
}

function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).pop() || normalized || "file";
}

function cheapHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }
  return hash >>> 0;
}
