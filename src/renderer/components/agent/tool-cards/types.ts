import type { ReactNode } from "react";
import type { ToolResultBlock } from "@/components/agent/tool-cards/toolTypes";
export type { ReadFileResult, ToolResultBlock, ToolUseBlock, WebSearchLink } from "@/components/agent/tool-cards/toolTypes";

export interface ToolCardHelpers {
  truncatePreview: (value: string) => string;
  renderToolGlyph: (toolName: string, className: string, result?: ToolResultBlock) => ReactNode;
}
