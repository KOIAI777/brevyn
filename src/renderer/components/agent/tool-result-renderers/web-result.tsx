import type { ToolCardHelpers, ToolResultBlock, ToolUseBlock } from "@/components/agent/tool-cards/types";
import { ToolDetailsShell } from "@/components/agent/tool-cards/shared";
import { getToolResultText, getToolSearchLinks, recordObject, stringValue, type WebSearchLink } from "@/components/agent/tool-cards/toolModel";

export function isWebTool(toolName: string): boolean {
  return toolName === "WebSearch" || toolName === "WebFetch";
}

export function WebResultDetails({
  toolUse,
  result,
}: {
  toolUse: ToolUseBlock;
  result?: ToolResultBlock;
} & ToolCardHelpers) {
  const data = recordObject(toolUse.input);
  const isSearch = toolUse.name === "WebSearch";
  const hosted = data.hosted === true;
  const target = isSearch ? webSearchQueryFromInput(data) || stringValue(data.query, "query") : stringValue(data.url, "URL");
  const output = result ? getToolResultText(result) : "";
  const links = isSearch ? getToolSearchLinks(result) : [];
  return isSearch ? (
    <WebSearchSummary query={target} links={links} result={result} output={output} hosted={hosted} />
  ) : (
    <WebFetchSummary url={target} result={result} output={output} />
  );
}

function WebSearchSummary({
  query,
  links,
  result,
  output,
  hosted,
}: {
  query: string;
  links: WebSearchLink[];
  result?: ToolResultBlock;
  output: string;
  hosted?: boolean;
}) {
  return (
    <ToolDetailsShell className="px-3 py-2 [contain:layout_paint_style]">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Search</p>
      <p className="mt-1 break-words text-xs leading-5 text-foreground">"{query}"</p>
      {hosted && !result && (
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          OpenAI Responses hosted web search 已完成，搜索结果会由模型在正文里引用。
        </p>
      )}
      {result && (
        <div className="mt-3 space-y-1.5">
          {links.length > 0 ? links.map((link, index) => (
            <a
              key={`${link.url}-${index}`}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-foreground transition hover:bg-accent/45"
              title={link.url}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground">
                {siteInitial(link)}
              </span>
              <span className="min-w-0 flex-1 truncate">{link.title || link.url}</span>
              <span className="shrink-0 truncate text-[11px] text-muted-foreground">{hostFromUrl(link.url)}</span>
            </a>
          )) : hosted ? (
            <p className="text-xs text-muted-foreground">
              Hosted web search 已完成，暂无可展示引用链接。
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {result.isError ? "搜索失败，展开结果不可用。" : `${resultCountFromText(output)} 个搜索结果`}
            </p>
          )}
        </div>
      )}
    </ToolDetailsShell>
  );
}

function WebFetchSummary({ url, result, output }: { url: string; result?: ToolResultBlock; output: string }) {
  return (
    <ToolDetailsShell className="px-3 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">URL</p>
      <p className="mt-1 break-words text-xs leading-5 text-foreground">{url}</p>
      {result && (
        <p className="mt-3 line-clamp-4 text-xs leading-5 text-muted-foreground">
          {result.isError ? "网页读取失败。" : firstMeaningfulLine(output) || "网页读取完成。"}
        </p>
      )}
    </ToolDetailsShell>
  );
}

function webSearchQueryFromInput(data: Record<string, unknown>): string {
  const direct = stringValue(data.query, "");
  if (direct) return direct;
  const queries = Array.isArray(data.queries) ? data.queries : [];
  for (const query of queries) {
    if (typeof query === "string" && query.trim()) return query.trim();
    const object = recordObject(query);
    const value = stringValue(object.query ?? object.search_query ?? object.text, "");
    if (value) return value;
  }
  return "";
}

function resultCountFromText(output: string): number {
  const match = output.match(/Found\s+(\d+)\s+results?/i) || output.match(/(\d+)\s+results?/i);
  if (!match) return 0;
  const count = Number.parseInt(match[1] || "0", 10);
  return Number.isFinite(count) ? count : 0;
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function siteInitial(link: WebSearchLink): string {
  const host = hostFromUrl(link.url);
  return (host || link.title || "W").slice(0, 1).toUpperCase();
}

function firstMeaningfulLine(output: string): string {
  return output.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("{") && !line.startsWith("[")) || "";
}
