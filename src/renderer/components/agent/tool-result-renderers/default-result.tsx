import type { ToolCardHelpers, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/types";
import { ToolInputPreview } from "@/components/agent/tool-cards/ToolInputPreview";
import { ToolCodeBlock, ToolDetailsShell } from "@/components/agent/tool-cards/shared";
import { getToolResultText } from "@/components/agent/tool-cards/toolModel";

export function DefaultToolDetails({
  toolUse,
  result,
  ...helpers
}: {
  toolUse: ToolUseBlock;
  result?: ToolResultBlock;
} & ToolCardHelpers) {
  return (
    <>
      <ToolInputPreview toolName={toolUse.name} input={toolUse.input} compact {...helpers} />
      {result && (
        <ToolDetailsShell className="mt-2">
          <ToolCodeBlock maxHeight="max-h-44" className="text-[11px] leading-5">
            {getToolResultText(result)}
          </ToolCodeBlock>
        </ToolDetailsShell>
      )}
    </>
  );
}
