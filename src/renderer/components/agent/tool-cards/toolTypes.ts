export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: unknown;
  isError: boolean;
  contentText?: string;
  rawResult?: unknown;
  toolUseResult?: unknown;
}

export interface ReadFileResult {
  filePath: string;
  content: string;
  startLine: number;
  totalLines?: number;
  numLines?: number;
}

export interface WebSearchLink {
  title: string;
  url: string;
}

export interface AgentTaskSummary {
  id: string;
  subject: string;
  description?: string;
  status?: string;
  owner?: string;
  blocks?: string[];
  blockedBy?: string[];
}
