export type HostedWebSearchInput = Record<string, unknown> & {
  hosted: true;
  status: string;
  providerStatus?: string;
  actionType?: string;
  query?: string;
  queries?: string[];
  url?: string;
  pattern?: string;
  sources?: unknown[];
};

export function hostedWebSearchInput(item: Record<string, unknown>, status?: string): HostedWebSearchInput {
  const action = recordOf(item.action);
  const actionType = searchActionType(action);
  const queries = webSearchQueries(item, action);
  const query = firstNonEmptyString(
    item.query,
    action.query,
    item.search_query,
    action.search_query,
    queries[0],
  );
  const providerStatus = stringOf(item.status);
  const result: HostedWebSearchInput = {
    hosted: true,
    status: status || providerStatus || "completed",
  };

  if (providerStatus) result.providerStatus = providerStatus;
  if (actionType) result.actionType = actionType;
  if (query) result.query = query;
  if (queries.length > 0) result.queries = queries;

  const url = firstNonEmptyString(item.url, action.url, item.page_url, action.page_url);
  if (url) result.url = url;

  const pattern = firstNonEmptyString(item.pattern, action.pattern, item.text, action.text);
  if (pattern && actionType === "find_in_page") result.pattern = pattern;

  const sources = webSearchSources(item, action);
  if (sources.length > 0) result.sources = sources;

  return result;
}

function searchActionType(action: Record<string, unknown>): string {
  const type = stringOf(action.type);
  if (type === "search" || type === "open_page" || type === "find_in_page") return type;
  if (stringOf(action.url)) return "open_page";
  if (stringOf(action.pattern) || stringOf(action.text)) return "find_in_page";
  if (stringOf(action.query) || Array.isArray(action.queries)) return "search";
  return type;
}

function webSearchQueries(item: Record<string, unknown>, action: Record<string, unknown>): string[] {
  const sources = [
    item.queries,
    action.queries,
    item.search_queries,
    action.search_queries,
  ];
  return uniqueNonEmptyStrings(sources.flatMap((source) => {
    const values = arrayOf(source);
    if (!values) return [];
    return values.flatMap((value) => {
      if (typeof value === "string") return [value];
      const object = recordOf(value);
      return [firstNonEmptyString(object.query, object.search_query, object.text)];
    });
  }));
}

function webSearchSources(item: Record<string, unknown>, action: Record<string, unknown>): unknown[] {
  const directSources = arrayOf(action.sources) || arrayOf(item.sources);
  if (directSources) return directSources;
  const results = arrayOf(action.results) || arrayOf(item.results);
  return results || [];
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    const text = stringOf(value).trim();
    if (text) return text;
  }
  return "";
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayOf(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}
