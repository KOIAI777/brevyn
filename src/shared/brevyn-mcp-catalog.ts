export type BrevynMcpToolIcon = "network" | "fileText" | "fileSearch" | "search" | "database";

export interface BrevynMcpToolDefinition {
  name: string;
  label: string;
  description: string;
  runtimeDescription: string;
  icon: BrevynMcpToolIcon;
  readOnly: boolean;
}

export interface BrevynMcpServerDefinition {
  name: string;
  displayName: string;
  description: string;
  transportLabel: string;
  tools: readonly BrevynMcpToolDefinition[];
}

export const BREVYN_MCP_SERVER = {
  name: "brevyn",
  displayName: "Brevyn MCP",
  description: "内置课程与资料工具，Agent 运行时自动加载。",
  transportLabel: "SDK 内置",
  tools: [
    {
      name: "course_structure",
      label: "课程结构",
      description: "读取当前学期、课程、任务和工作区目录。",
      runtimeDescription: "Return the current Brevyn semester/course/task structure and semantic workspace roots. Use this before reading files when folder meaning matters.",
      icon: "network",
      readOnly: true,
    },
    {
      name: "list_course_files",
      label: "课程文件",
      description: "列出课程和任务里的文件记录。",
      runtimeDescription: "List Brevyn workspace file records for the current course or task. Returns file ids, names, semantic sections, paths, parsed Markdown availability, and office artifact availability. For full-document work on PDF, DOCX, PPTX, XLSX, CSV, TSV, or other parsed documents, call read_parsed_file when hasParsedText is true. If hasOfficeArtifact is true, use artifactPath/semanticUnitsPath as structured source anchors. For ordinary text/code files use Read/Grep on readPath.",
      icon: "fileText",
      readOnly: true,
    },
    {
      name: "get_file_record",
      label: "文件记录",
      description: "按文件 ID 获取托管路径和元数据。",
      runtimeDescription: "Look up one Brevyn workspace file record by fileId. Returns metadata, managed workspace path, parsed text availability, and office artifact paths when available. Use read_parsed_file when hasParsedText is true; use artifactPath/semanticUnitsPath for structured DOCX sections/tables/comments/footnotes/endnotes/image captions/tracked changes, PPTX, and spreadsheet anchors; use Read for ordinary text/code files.",
      icon: "fileSearch",
      readOnly: true,
    },
    {
      name: "read_parsed_file",
      label: "解析文本",
      description: "读取已解析的 Markdown 全文内容。",
      runtimeDescription: "Read Brevyn's parsed Markdown for a workspace file. Use this for full-document tasks such as PPT planning, summaries, rewrites, outlines, data analysis, and structure analysis when list_course_files or get_file_record reports hasParsedText=true. This content.md is the same parsed text Brevyn chunks for RAG indexing, so it is the default readable source after RAG locates candidate files. The result may include artifactPath and semanticUnitsPath for structured office anchors such as DOCX sections/tables/comments/notes/captions/tracked changes, PPTX slides/speaker notes, or spreadsheet table ranges. This reads Parsed/.../content.md, not the original binary document.",
      icon: "fileText",
      readOnly: true,
    },
    {
      name: "rag_search",
      label: "资料检索",
      description: "搜索已索引的课程材料和证据片段。",
      runtimeDescription: "Search indexed Brevyn course materials. In a semester thread this searches all visible courses; in a course or task thread it defaults to the current course, including lectures, shared materials, and task files. Pass taskId only when the user explicitly wants to search one task's materials. Use this first for targeted course-material questions, rubric evidence, lecture concepts, and assignment evidence. For full-document tasks, use read_parsed_file when parsed Markdown is available.",
      icon: "search",
      readOnly: true,
    },
    {
      name: "update_course_task_info",
      label: "更新课程任务信息",
      description: "把有来源的截止时间、要求和评分标准写入当前课程任务。",
      runtimeDescription: "Replace the structured information for the current Brevyn course task after reading authoritative assignment sources. Use only when the user explicitly asks to organize or update task information. Every requirement and rubric criterion must cite a visible Brevyn file by fileId. Omit uncertain facts; do not infer completion status and do not use this tool outside a task thread.",
      icon: "database",
      readOnly: false,
    },
    {
      name: "office_runtime",
      label: "Office 运行时",
      description: "检查或初始化内置 LibreOffice 运行时。",
      runtimeDescription: "Check Brevyn's LibreOffice runtime. Call with prepare=true before Office rendering, formula recalculation, or Office QA when the runtime has not been verified in this run. Use selfTest=true for a real HTML-to-PDF conversion check. The operation is local and idempotent.",
      icon: "database",
      readOnly: true,
    },
    {
      name: "propose_external_source",
      label: "外部资料候选",
      description: "把有用网页放入用户确认卡片。",
      runtimeDescription: "Put a useful web source into Brevyn's user-confirmation card. Use this immediately after WebSearch/WebFetch finds a URL that may help the current course or task. Calling this tool is how you ask the user to confirm; do not first ask in chat whether to save the source. This does not download or index the source.",
      icon: "database",
      readOnly: false,
    },
  ],
} as const satisfies BrevynMcpServerDefinition;

export const BREVYN_MCP_TOOLS = BREVYN_MCP_SERVER.tools;

export const BREVYN_MCP_FULL_TOOL_NAMES = BREVYN_MCP_TOOLS.map((tool) => fullBrevynMcpToolName(tool.name));

export const BREVYN_MCP_READ_ONLY_FULL_TOOL_NAMES = BREVYN_MCP_TOOLS
  .filter((tool) => tool.readOnly)
  .map((tool) => fullBrevynMcpToolName(tool.name));

export const BREVYN_MCP_TOOL_ALIASES: Record<string, string> = Object.fromEntries(
  BREVYN_MCP_TOOLS.flatMap((tool) => {
    const fullName = fullBrevynMcpToolName(tool.name);
    const camel = camelCaseToolName(tool.name);
    const pascal = camel ? camel[0].toUpperCase() + camel.slice(1) : "";
    return [
      [tool.name, fullName],
      [`mcpBrevyn${camel}`, fullName],
      [`mcpBrevyn${pascal}`, fullName],
    ];
  }),
);

export function getBrevynMcpTool(name: string): BrevynMcpToolDefinition {
  const tool = BREVYN_MCP_TOOLS.find((item) => item.name === name);
  if (!tool) throw new Error(`Unknown Brevyn MCP tool: ${name}`);
  return tool;
}

export function fullBrevynMcpToolName(toolName: string): string {
  return `mcp__${BREVYN_MCP_SERVER.name}__${toolName}`;
}

function camelCaseToolName(name: string): string {
  return name.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
}
