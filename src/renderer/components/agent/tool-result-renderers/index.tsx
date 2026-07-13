import type { ToolCardHelpers, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/types";
import { BashResultDetails } from "@/components/agent/tool-result-renderers/bash-result";
import { BrevynDataResultDetails, isBrevynDataTool } from "@/components/agent/tool-result-renderers/brevyn-data-result";
import { DefaultToolDetails } from "@/components/agent/tool-result-renderers/default-result";
import { FileToolDetails, isFileTool } from "@/components/agent/tool-result-renderers/file-result";
import { RagSearchResultDetails } from "@/components/agent/tool-result-renderers/rag-search-result";
import { ReadResultDetails } from "@/components/agent/tool-result-renderers/read-result";
import { isSearchTool, SearchResultDetails } from "@/components/agent/tool-result-renderers/search-result";
import { isTaskTool, TaskResultDetails } from "@/components/agent/tool-result-renderers/task-result";
import { isTodoTool, TodoResultDetails } from "@/components/agent/tool-result-renderers/todo-result";
import { isWebTool, WebResultDetails } from "@/components/agent/tool-result-renderers/web-result";

export function renderToolDetails({
  toolUse,
  result,
  helpers,
}: {
  toolUse: ToolUseBlock;
  result?: ToolResultBlock;
  helpers: ToolCardHelpers;
}) {
  if (toolUse.name === "Bash") return <BashResultDetails toolUse={toolUse} result={result} {...helpers} />;
  if (toolUse.name === "Read") return <ReadResultDetails toolUse={toolUse} result={result} {...helpers} />;
  if (isFileTool(toolUse.name)) return <FileToolDetails toolUse={toolUse} result={result} {...helpers} />;
  if (toolUse.name === "mcp__brevyn__rag_search") return <RagSearchResultDetails toolUse={toolUse} result={result} {...helpers} />;
  if (isBrevynDataTool(toolUse.name)) return <BrevynDataResultDetails toolUse={toolUse} result={result} {...helpers} />;
  if (isTaskTool(toolUse.name)) return <TaskResultDetails toolUse={toolUse} result={result} {...helpers} />;
  if (isTodoTool(toolUse.name)) return <TodoResultDetails toolUse={toolUse} result={result} {...helpers} />;
  if (isSearchTool(toolUse.name)) return <SearchResultDetails toolUse={toolUse} result={result} {...helpers} />;
  if (isWebTool(toolUse.name)) return <WebResultDetails toolUse={toolUse} result={result} {...helpers} />;
  return <DefaultToolDetails toolUse={toolUse} result={result} {...helpers} />;
}
