import { PreviewPill, ToolCodeBlock, ToolDetailsShell } from "@/components/agent/tool-cards/shared";
import type { ToolCardHelpers, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/types";
import { getToolResultText, recordObject, stringValue } from "@/components/agent/tool-cards/toolModel";

export function isSearchTool(toolName: string): boolean {
  return toolName === "Glob" || toolName === "Grep";
}

export function SearchResultDetails({
  toolUse,
  result,
}: {
  toolUse: ToolUseBlock;
  result?: ToolResultBlock;
} & ToolCardHelpers) {
  const data = recordObject(toolUse.input);
  const pattern = stringValue(data.pattern, "pattern");
  const path = stringValue(data.path ?? data.glob, "");
  const output = result ? getToolResultText(result) : "";

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <PreviewPill label="Pattern" value={pattern} />
        {path && <PreviewPill label="Path" value={path} />}
      </div>
      {result && (
        <ToolDetailsShell className="mt-2">
          <ToolCodeBlock maxHeight="max-h-52" className="text-[11px] leading-5">
            {output || "没有匹配结果。"}
          </ToolCodeBlock>
        </ToolDetailsShell>
      )}
    </>
  );
}
