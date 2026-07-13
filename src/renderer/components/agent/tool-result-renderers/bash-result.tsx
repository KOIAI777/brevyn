import type { ToolCardHelpers, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/types";
import { ToolCodeBlock, ToolDetailsShell } from "@/components/agent/tool-cards/shared";
import { getToolResultText, recordObject, stringValue } from "@/components/agent/tool-cards/toolModel";

export function BashResultDetails({
  toolUse,
  result,
  ...helpers
}: {
  toolUse: ToolUseBlock;
  result?: ToolResultBlock;
} & ToolCardHelpers) {
  const command = stringValue(recordObject(toolUse.input).command, "");
  const output = result ? getToolResultText(result) : "";
  const terminalText = [`$ ${command}`, output ? `\n${helpers.truncatePreview(output)}` : ""].join("");
  return (
    <ToolDetailsShell>
      <ToolCodeBlock>
        <span className="text-emerald-600">$</span>
        {terminalText.replace(/^\$/, "")}
      </ToolCodeBlock>
    </ToolDetailsShell>
  );
}
