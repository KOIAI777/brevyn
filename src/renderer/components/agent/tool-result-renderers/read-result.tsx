import { type ReactNode } from "react";
import type { ToolCardHelpers, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/types";
import { getReadFileResult, getToolInputPath, getToolResultText, recordObject } from "@/components/agent/tool-cards/toolModel";

export function ReadResultDetails({
  toolUse,
  result,
}: {
  toolUse: ToolUseBlock;
  result?: ToolResultBlock;
} & ToolCardHelpers) {
  const fileResult = getReadFileResult(result);
  const content = fileResult?.content ?? (result ? getToolResultText(result) : "");
  const input = recordObject(toolUse.input);
  const sourcePath = fileResult?.filePath || getToolInputPath(input);
  return <ReadSourcePreview content={content} sourcePath={sourcePath} startLine={fileResult?.startLine ?? 1} totalLines={fileResult?.totalLines} />;
}

function ReadSourcePreview({ content, sourcePath, startLine, totalLines }: { content: string; sourcePath: string; startLine: number; totalLines?: number }) {
  const normalized = normalizeReadContent(content);
  if (!normalized.trim()) {
    return (
      <div className="rounded-xl border border-dashed bg-background/65 px-3 py-5 text-center text-[11px] text-muted-foreground">
        没有可显示的读取内容。
      </div>
    );
  }

  const lines = splitPreviewLines(normalized);
  const visibleLines = lines.slice(0, MAX_READ_PREVIEW_LINES);
  const language = languageFromPath(sourcePath);
  const mode = language === "markdown" ? "markdown" : language ? "code" : "text";
  const truncated = lines.length > visibleLines.length;

  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-zinc-950/[0.04] text-[11px] shadow-sm">
      <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/70 bg-muted/35 px-3 py-2 text-xs">
        <span className="min-w-0 truncate font-medium text-foreground" title={sourcePath}>
          {fileName(sourcePath) || "读取内容"}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-emerald-500">
          {truncated ? `${visibleLines.length} / ${totalLines ?? lines.length}` : `${totalLines ?? lines.length}`}
        </span>
      </div>
      <div className="max-h-72 overflow-auto brevyn-scrollbar">
        {visibleLines.map((line, index) => (
          <ReadLine key={index} line={line} lineNumber={startLine + index} mode={mode} />
        ))}
        {truncated && (
          <div className="border-t border-border/70 bg-muted/25 px-3 py-2 text-center text-[11px] text-muted-foreground">
            已限制显示前 {MAX_READ_PREVIEW_LINES} 行，完整内容请在文件预览中查看。
          </div>
        )}
      </div>
    </div>
  );
}

function ReadLine({
  line,
  lineNumber,
  mode,
}: {
  line: string;
  lineNumber: number;
  mode: "markdown" | "code" | "text";
}) {
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] border-l-2 border-l-transparent font-mono leading-6 text-stone-700">
      <span className="select-none border-r border-border/50 pr-3 text-right text-muted-foreground/80">{lineNumber}</span>
      <code className="min-w-0 whitespace-pre-wrap break-words px-3 text-[11px]">
        {highlightLine(line, mode)}
        {line.length === 0 ? "\u00A0" : null}
      </code>
    </div>
  );
}

function normalizeReadContent(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitPreviewLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length > 0 ? lines : [""];
}

function highlightLine(line: string, mode: "markdown" | "code" | "text"): ReactNode {
  if (mode === "markdown") return highlightMarkdownLine(line);
  if (mode === "code") return highlightCodeLine(line);
  return line;
}

function highlightMarkdownLine(line: string): ReactNode {
  const heading = line.match(/^(\s{0,3})(#{1,6})(\s+)(.*)$/);
  if (heading) {
    return (
      <>
        {heading[1]}
        <span className="text-sky-600">{heading[2]}</span>
        {heading[3]}
        <span className="font-semibold text-slate-800">{highlightMarkdownInline(heading[4])}</span>
      </>
    );
  }
  const list = line.match(/^(\s*)([-*+]|\d+\.)(\s+)(.*)$/);
  if (list) {
    return (
      <>
        {list[1]}
        <span className="text-teal-600">{list[2]}</span>
        {list[3]}
        {highlightMarkdownInline(list[4])}
      </>
    );
  }
  const quote = line.match(/^(\s*>+\s?)(.*)$/);
  if (quote) {
    return (
      <>
        <span className="text-emerald-600">{quote[1]}</span>
        <span className="text-stone-600">{highlightMarkdownInline(quote[2])}</span>
      </>
    );
  }
  return highlightMarkdownInline(line);
}

function highlightMarkdownInline(line: string): ReactNode[] {
  return tokenize(line, /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g, (token, index) => {
    if (token.startsWith("`")) return <span key={index} className="rounded bg-sky-500/10 px-1 text-sky-700">{token}</span>;
    if (token.startsWith("**")) return <span key={index} className="font-semibold text-slate-800">{token}</span>;
    if (token.startsWith("*")) return <span key={index} className="italic text-stone-700">{token}</span>;
    return <span key={index} className="text-blue-600">{token}</span>;
  });
}

function highlightCodeLine(line: string): ReactNode[] {
  return tokenize(
    line,
    /(\/\/.*$|#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:async|await|break|case|catch|class|const|continue|def|elif|else|export|extends|false|finally|for|from|function|if|implements|import|in|interface|let|new|null|private|protected|public|return|self|static|super|switch|throw|true|try|type|var|while|yield)\b|\b[A-Za-z_$][\w$]*(?=\s*\()|\b\d+(?:\.\d+)?\b)/g,
    (token, index) => {
      if (token.startsWith("//") || token.startsWith("#")) return <span key={index} className="text-stone-400">{token}</span>;
      if (token.startsWith("\"") || token.startsWith("'") || token.startsWith("`")) return <span key={index} className="text-emerald-700">{token}</span>;
      if (/^\d/.test(token)) return <span key={index} className="text-amber-700">{token}</span>;
      if (/^[A-Za-z_$][\w$]*$/.test(token) && !CODE_KEYWORDS.has(token)) return <span key={index} className="text-sky-700">{token}</span>;
      return <span key={index} className="font-medium text-rose-700">{token}</span>;
    },
  );
}

function tokenize(line: string, pattern: RegExp, renderToken: (token: string, index: number) => ReactNode): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIndex = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(line.slice(lastIndex, index));
    parts.push(renderToken(match[0], tokenIndex));
    tokenIndex += 1;
    lastIndex = index + match[0].length;
  }
  if (lastIndex < line.length) parts.push(line.slice(lastIndex));
  return parts;
}

function languageFromPath(path: string): "markdown" | "code" | null {
  const extension = fileExtension(path);
  if (["md", "markdown", "mdx"].includes(extension)) return "markdown";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return null;
}

function fileName(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) || "";
}

function fileExtension(path: string): string {
  const name = fileName(path).toLowerCase();
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1) : "";
}

const MAX_READ_PREVIEW_LINES = 400;

const CODE_EXTENSIONS = new Set([
  "c",
  "cc",
  "cpp",
  "css",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "jsx",
  "json",
  "mjs",
  "py",
  "rb",
  "rs",
  "sh",
  "swift",
  "ts",
  "tsx",
  "vue",
  "xml",
  "yaml",
  "yml",
]);

const CODE_KEYWORDS = new Set([
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "def",
  "elif",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "interface",
  "let",
  "new",
  "null",
  "private",
  "protected",
  "public",
  "return",
  "self",
  "static",
  "super",
  "switch",
  "throw",
  "true",
  "try",
  "type",
  "var",
  "while",
  "yield",
]);
