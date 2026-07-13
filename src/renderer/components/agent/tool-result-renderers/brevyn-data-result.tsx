import { PreviewPill, ToolCodeBlock, ToolDetailsShell } from "@/components/agent/tool-cards/shared";
import type { ToolCardHelpers, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/types";
import { getParsedToolResult, getToolResultText, recordObject, stringValue } from "@/components/agent/tool-cards/toolModel";
import { BREVYN_MCP_FULL_TOOL_NAMES } from "../../../../shared/brevyn-mcp-catalog";

const BREVYN_DATA_TOOLS = new Set(BREVYN_MCP_FULL_TOOL_NAMES);

export function isBrevynDataTool(toolName: string): boolean {
  return BREVYN_DATA_TOOLS.has(toolName);
}

export function BrevynDataResultDetails({
  toolUse,
  result,
}: {
  toolUse: ToolUseBlock;
  result?: ToolResultBlock;
} & ToolCardHelpers) {
  const output = result ? getToolResultText(result) : "";
  const structured = result && !result.isError ? recordObject(getParsedToolResult(result)) : {};
  const summary = result && !result.isError ? summarizeOutput(toolUse.name, result) : null;

  if (result && !result.isError && toolUse.name === "mcp__brevyn__list_course_files") {
    return <CourseFilesDetails root={structured} fallbackOutput={output} />;
  }
  if (result && !result.isError && toolUse.name === "mcp__brevyn__read_parsed_file") {
    return <ParsedFileDetails root={structured} fallbackOutput={output} />;
  }
  if (result && !result.isError && toolUse.name === "mcp__brevyn__update_course_task_info") {
    return <CourseTaskInfoDetails root={structured} />;
  }

  return (
    summary ? (
      <ToolDetailsShell className="px-3 py-2">
        <div className="flex flex-wrap gap-2">
          {summary.pills.map((pill) => (
            <PreviewPill key={`${pill.label}:${pill.value}`} label={pill.label} value={pill.value} />
          ))}
        </div>
        {summary.preview && (
          <p className="mt-2 line-clamp-3 break-words text-[11px] leading-5 text-muted-foreground">
            {summary.preview}
          </p>
        )}
      </ToolDetailsShell>
    ) : result ? (
      <ToolDetailsShell>
        <ToolCodeBlock maxHeight="max-h-44" className="text-[11px] leading-5">
          {output || "没有返回内容。"}
        </ToolCodeBlock>
      </ToolDetailsShell>
    ) : null
  );
}

function CourseTaskInfoDetails({ root }: { root: Record<string, unknown> }) {
  const task = recordObject(root.task);
  const counts = recordObject(root.counts);
  return (
    <ToolDetailsShell className="px-3 py-2.5">
      <div className="flex flex-wrap gap-2">
        <PreviewPill label="Task" value={stringValue(task.title, "当前任务")} />
        <PreviewPill label="Requirements" value={String(numberValue(counts.requirements, 0))} />
        <PreviewPill label="Rubric" value={String(numberValue(counts.rubricCriteria, 0))} />
        <PreviewPill label="Sources" value={String(numberValue(counts.sources, 0))} />
      </div>
      <div className="brevyn-status-card-success mt-2 rounded-lg px-3 py-2 text-[11px] leading-5 text-[hsl(var(--status-success))]">
        任务信息已保存，并同步到课程 Dashboard 与当前任务会话。
      </div>
    </ToolDetailsShell>
  );
}

function ParsedFileDetails({ root, fallbackOutput }: { root: Record<string, unknown>; fallbackOutput: string }) {
  const file = recordObject(root.file);
  const name = stringValue(file.name ?? file.fileName, "解析文本");
  const content = stringValue(root.content, "");
  const charCount = numberValue(root.charCount, content.length);
  const returnedChars = numberValue(root.returnedChars, content.length);
  const offset = numberValue(root.offset, 0);
  const nextOffset = typeof root.nextOffset === "number" ? root.nextOffset : null;
  const preview = content.replace(/\s+/g, " ").trim();
  return (
    <ToolDetailsShell className="px-3 py-2.5">
      <div className="flex flex-wrap gap-2">
        <PreviewPill label="File" value={name} />
        <PreviewPill label="Chars" value={`${returnedChars}/${charCount}`} />
        {offset > 0 && <PreviewPill label="Offset" value={String(offset)} />}
        {root.truncated === true && nextOffset !== null && <PreviewPill label="Next" value={String(nextOffset)} />}
      </div>
      <div className="mt-2 rounded-lg border border-border/55 bg-background/60 px-3 py-2">
        <div className="text-[11px] font-medium text-foreground">已读取解析 Markdown</div>
        <p className="mt-1 line-clamp-4 break-words text-[11px] leading-5 text-muted-foreground">
          {preview || fallbackOutput || "没有可显示的预览。"}
        </p>
      </div>
    </ToolDetailsShell>
  );
}

function CourseFilesDetails({ root, fallbackOutput }: { root: Record<string, unknown>; fallbackOutput: string }) {
  const groups = fileGroups(root);
  const files = fileRecords(root);
  if (groups.length === 0 && files.length === 0) {
    return (
      <ToolDetailsShell className="px-3 py-2.5">
        <div className="flex flex-wrap gap-2">
          <PreviewPill label="Files" value="0" />
          <PreviewPill label="Indexed" value="0" />
          <PreviewPill label="Parsed" value="0" />
        </div>
        <div className="mt-2 rounded-lg border border-dashed border-border/60 bg-background/45 px-3 py-3 text-[11px] leading-5 text-muted-foreground">
          当前筛选范围没有课程文件。
        </div>
        {root.truncated === true && (
          <p className="mt-2 text-[10px] text-muted-foreground">{fallbackOutput}</p>
        )}
      </ToolDetailsShell>
    );
  }
  const count = numberValue(root.count, files.length);
  const totalMatched = numberValue(root.totalMatched, count);
  const truncated = root.truncated === true;
  const indexedCount = groups.reduce((sum, group) => sum + group.indexedCount, 0) || files.filter(isIndexedFile).length;
  const parsedCount = groups.reduce((sum, group) => sum + group.parsedTextCount, 0) || files.filter((file) => file.hasParsedText).length;
  return (
    <ToolDetailsShell className="px-3 py-2.5">
      <div className="flex flex-wrap gap-2">
        <PreviewPill label="Files" value={`${count}${totalMatched !== count ? `/${totalMatched}` : ""}`} />
        <PreviewPill label="Indexed" value={String(indexedCount)} />
        <PreviewPill label="Parsed" value={String(parsedCount)} />
        {truncated && <PreviewPill label="More" value="truncated" />}
      </div>
      <div className="mt-2 space-y-2">
        {(groups.length > 0 ? groups : [{ id: "files", title: "课程文件", files, count: files.length, indexedCount, parsedTextCount: parsedCount }]).slice(0, 5).map((group) => (
          <div key={group.id} className="rounded-lg border border-border/55 bg-background/60 px-2.5 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 truncate text-[11px] font-semibold text-foreground">{group.title}</div>
              <div className="shrink-0 text-[10px] text-muted-foreground">
                {group.count} 个 · {group.indexedCount} 已索引 · {group.parsedTextCount} 可读
              </div>
            </div>
            <div className="mt-1.5 space-y-1">
              {group.files.slice(0, 4).map((file) => (
                <div key={file.fileId || `${group.id}:${file.name}`} className="flex min-w-0 items-center gap-2 rounded-md bg-card/54 px-2 py-1.5 text-[11px]">
                  <span className="min-w-0 flex-1 truncate text-foreground/88" title={file.path || file.name}>
                    {file.name || file.path || "file"}
                  </span>
                  <span className={statusBadgeClass(file.indexingStatus)}>{statusLabel(file.indexingStatus)}</span>
                  {file.hasParsedText && <span className="shrink-0 rounded-full bg-[hsl(var(--status-info)/0.12)] px-1.5 py-0.5 text-[10px] font-medium text-[hsl(var(--status-info))]">解析</span>}
                </div>
              ))}
              {group.files.length > 4 && (
                <div className="px-2 pt-0.5 text-[10px] text-muted-foreground">
                  还有 {group.files.length - 4} 个文件
                </div>
              )}
            </div>
          </div>
        ))}
        {groups.length > 5 && <div className="px-1 text-[10px] text-muted-foreground">还有 {groups.length - 5} 个分组</div>}
      </div>
    </ToolDetailsShell>
  );
}

interface Summary {
  status: string;
  suffix: string;
  preview: string;
  pills: Array<{ label: string; value: string }>;
}

function summarizeOutput(toolName: string, result: ToolResultBlock): Summary | null {
  const root = recordObject(getParsedToolResult(result));
  if (toolName === "mcp__brevyn__course_structure") return courseStructureSummary(root);
  if (toolName === "mcp__brevyn__list_course_files") return listFilesSummary(root);
  if (toolName === "mcp__brevyn__get_file_record") return fileRecordSummary(root);
  if (toolName === "mcp__brevyn__read_parsed_file") return parsedFileSummary(root);
  if (toolName === "mcp__brevyn__update_course_task_info") return courseTaskInfoSummary(root);
  return null;
}

function courseTaskInfoSummary(root: Record<string, unknown>): Summary {
  const task = recordObject(root.task);
  const counts = recordObject(root.counts);
  const title = stringValue(task.title, "当前任务");
  const requirementCount = numberValue(counts.requirements, 0);
  const rubricCount = numberValue(counts.rubricCriteria, 0);
  const sourceCount = numberValue(counts.sources, 0);
  return {
    status: "已同步",
    suffix: title,
    preview: stringValue(task.summary, "课程任务信息已保存。"),
    pills: [
      { label: "Requirements", value: String(requirementCount) },
      { label: "Rubric", value: String(rubricCount) },
      { label: "Sources", value: String(sourceCount) },
    ],
  };
}

function courseStructureSummary(root: Record<string, unknown>): Summary {
  const courses = Array.isArray(root.courses) ? root.courses : [];
  const semester = recordObject(root.semester);
  const course = recordObject(root.course);
  const task = recordObject(root.task);
  const semesterName = stringValue(semester.name ?? semester.label ?? semester.title, "");
  const courseName = stringValue(course.name ?? course.title, "");
  const taskName = stringValue(task.title ?? task.name, "");
  return {
    status: `${courses.length} 门课程`,
    suffix: courses.length > 0 ? `${courses.length} 门课程` : "当前结构",
    preview: [semesterName, courseName, taskName].filter(Boolean).join(" · "),
    pills: [
      { label: "Courses", value: String(courses.length) },
      ...(semesterName ? [{ label: "Semester", value: semesterName }] : []),
    ],
  };
}

function listFilesSummary(root: Record<string, unknown>): Summary {
  const files = Array.isArray(root.files) ? root.files : Array.isArray(root.items) ? root.items : [];
  const groups = fileGroups(root);
  const firstNames = files.slice(0, 3).map((item) => {
    const file = recordObject(item);
    return stringValue(file.name ?? file.fileName ?? file.path, "");
  }).filter(Boolean);
  const indexedCount = groups.reduce((sum, group) => sum + group.indexedCount, 0);
  const parsedCount = groups.reduce((sum, group) => sum + group.parsedTextCount, 0);
  return {
    status: `${files.length} 个文件`,
    suffix: `${files.length} 个文件`,
    preview: groups.length > 0 ? groups.map((group) => `${group.title} ${group.count}`).join(" · ") : firstNames.join(" · "),
    pills: [
      { label: "Files", value: String(files.length) },
      ...(indexedCount > 0 ? [{ label: "Indexed", value: String(indexedCount) }] : []),
      ...(parsedCount > 0 ? [{ label: "Parsed", value: String(parsedCount) }] : []),
    ],
  };
}

function fileRecordSummary(root: Record<string, unknown>): Summary {
  const record = recordObject(root.file ?? root.record ?? root);
  const name = stringValue(record.name ?? record.fileName ?? record.path, "文件记录");
  const section = stringValue(record.sectionKind ?? record.section ?? record.bucket, "");
  return {
    status: "1 个记录",
    suffix: name,
    preview: stringValue(record.path ?? record.sourcePath, ""),
    pills: [
      { label: "File", value: name },
      ...(section ? [{ label: "Section", value: section }] : []),
    ],
  };
}

function parsedFileSummary(root: Record<string, unknown>): Summary {
  const file = recordObject(root.file ?? root.record ?? root);
  const name = stringValue(file.name ?? file.fileName ?? file.path, "解析文本");
  const content = stringValue(root.content, "");
  const charCount = numberValue(root.charCount, content.length);
  const returnedChars = numberValue(root.returnedChars, content.length);
  return {
    status: `${returnedChars} 字符`,
    suffix: name,
    preview: content.replace(/\s+/g, " ").trim(),
    pills: [
      { label: "File", value: name },
      { label: "Chars", value: `${returnedChars}/${charCount}` },
      ...(root.truncated === true ? [{ label: "More", value: "truncated" }] : []),
    ],
  };
}

type CourseFileRecord = {
  fileId: string;
  name: string;
  path: string;
  indexingStatus: string;
  hasParsedText: boolean;
};

type CourseFileGroup = {
  id: string;
  title: string;
  count: number;
  indexedCount: number;
  parsedTextCount: number;
  files: CourseFileRecord[];
};

function fileGroups(root: Record<string, unknown>): CourseFileGroup[] {
  const groups = Array.isArray(root.groups) ? root.groups : [];
  return groups.map((item, index) => {
    const group = recordObject(item);
    const files = fileRecords(group);
    return {
      id: stringValue(group.id, `group-${index}`),
      title: stringValue(group.title, "文件"),
      count: numberValue(group.count, files.length),
      indexedCount: numberValue(group.indexedCount, files.filter(isIndexedFile).length),
      parsedTextCount: numberValue(group.parsedTextCount, files.filter((file) => file.hasParsedText).length),
      files,
    };
  }).filter((group) => group.count > 0 || group.files.length > 0);
}

function fileRecords(root: Record<string, unknown>): CourseFileRecord[] {
  const files = Array.isArray(root.files) ? root.files : Array.isArray(root.items) ? root.items : [];
  return files.map((item) => {
    const file = recordObject(item);
    return {
      fileId: stringValue(file.fileId ?? file.id, ""),
      name: stringValue(file.name ?? file.fileName, ""),
      path: stringValue(file.path ?? file.readPath, ""),
      indexingStatus: stringValue(file.indexingStatus, "idle"),
      hasParsedText: file.hasParsedText === true,
    };
  });
}

function isIndexedFile(file: CourseFileRecord): boolean {
  return file.indexingStatus === "indexed" || file.indexingStatus === "partial" || file.indexingStatus === "warning";
}

function statusLabel(status: string): string {
  if (status === "indexed") return "已索引";
  if (status === "indexing") return "索引中";
  if (status === "queued") return "排队";
  if (status === "failed") return "失败";
  if (status === "partial") return "部分";
  if (status === "warning") return "警告";
  if (status === "skipped") return "跳过";
  if (status === "cancelled") return "取消";
  return "未索引";
}

function statusBadgeClass(status: string): string {
  const base = "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium";
  if (status === "indexed") return `${base} bg-[hsl(var(--status-success)/0.13)] text-[hsl(var(--status-success))]`;
  if (status === "queued" || status === "indexing") return `${base} bg-[hsl(var(--status-info)/0.12)] text-[hsl(var(--status-info))]`;
  if (status === "failed" || status === "cancelled") return `${base} bg-destructive/10 text-destructive`;
  if (status === "partial" || status === "warning" || status === "skipped") return `${base} bg-[hsl(var(--status-warning)/0.13)] text-[hsl(var(--status-warning))]`;
  return `${base} bg-muted text-muted-foreground`;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
