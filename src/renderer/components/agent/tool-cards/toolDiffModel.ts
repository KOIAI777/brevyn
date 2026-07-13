import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff";
import { getToolInputPath } from "@/components/agent/tool-cards/toolPathModel";
import type { ToolResultBlock } from "@/components/agent/tool-cards/toolTypes";

export interface ToolDiffStats {
  additions: number;
  deletions: number;
}

export type ToolDiffSource =
  | { kind: "patch"; patch: string; filePath: string; additions: number; deletions: number }
  | { kind: "files"; filePath: string; oldContent: string; newContent: string; patch?: string; additions: number; deletions: number; disableLineNumbers?: boolean };

const diffStatsCache = new WeakMap<object, Map<string, ToolDiffStats | null>>();
const diffSourceCache = new WeakMap<object, Map<string, ToolDiffSource | null>>();

export function getToolResultDiffStats(result?: ToolResultBlock, toolName?: string): ToolDiffStats | null {
  if (!result || result.isError) return null;
  const rawValue = result.toolUseResult ?? result.rawResult;
  const raw = recordObject(rawValue);
  const cacheKey = rawValue && typeof rawValue === "object" ? rawValue : null;
  const cacheToolName = toolName || "";
  const cachedByTool = cacheKey ? diffStatsCache.get(cacheKey) : undefined;
  if (cachedByTool?.has(cacheToolName)) return cachedByTool.get(cacheToolName) ?? null;
  const stats = computeToolResultDiffStats(raw, toolName);
  if (cacheKey) {
    const nextCache = cachedByTool ?? new Map<string, ToolDiffStats | null>();
    nextCache.set(cacheToolName, stats);
    diffStatsCache.set(cacheKey, nextCache);
  }
  return stats;
}

function computeToolResultDiffStats(raw: Record<string, unknown>, toolName?: string): ToolDiffStats | null {
  const gitDiff = recordObject(raw.gitDiff);
  const gitAdditions = nonNegativeInteger(gitDiff.additions);
  const gitDeletions = nonNegativeInteger(gitDiff.deletions);
  if (gitAdditions !== null || gitDeletions !== null) {
    return diffStatsOrNull(gitAdditions ?? 0, gitDeletions ?? 0);
  }
  const patch = stringValue(gitDiff.patch, "");
  if (patch) return diffStatsFromPatch(patch);
  const structuredPatch = Array.isArray(raw.structuredPatch) ? raw.structuredPatch : [];
  if (structuredPatch.length > 0) return diffStatsFromStructuredPatch(structuredPatch);
  if (toolName === "Write" && raw.type === "create" && raw.originalFile === null && typeof raw.content === "string") {
    return diffStatsOrNull(lineCount(raw.content), 0);
  }
  return null;
}

export function getToolResultDiffSource(toolName: string, result?: ToolResultBlock): ToolDiffSource | null {
  if (!result || result.isError) return null;
  const rawValue = result.toolUseResult ?? result.rawResult;
  const raw = recordObject(rawValue);
  const cacheKey = rawValue && typeof rawValue === "object" ? rawValue : null;
  const cachedByTool = cacheKey ? diffSourceCache.get(cacheKey) : undefined;
  if (cachedByTool?.has(toolName)) return cachedByTool.get(toolName) ?? null;
  const source = computeToolResultDiffSource(toolName, raw);
  if (cacheKey) {
    const nextCache = cachedByTool ?? new Map<string, ToolDiffSource | null>();
    nextCache.set(toolName, source);
    diffSourceCache.set(cacheKey, nextCache);
  }
  return source;
}

function computeToolResultDiffSource(toolName: string, raw: Record<string, unknown>): ToolDiffSource | null {
  const filePath = filePathFrom(raw);
  const gitDiff = recordObject(raw.gitDiff);
  const gitPatch = stringValue(gitDiff.patch, "");
  if (gitPatch) {
    const patch = normalizeGitPatch(gitPatch, filePath, stringValue(gitDiff.status, ""));
    const stats = diffStatsFromPatch(patch) ?? { additions: 0, deletions: 0 };
    return {
      kind: "patch",
      patch,
      filePath: filePath || filePathFromPatch(patch) || "file",
      additions: stats.additions,
      deletions: stats.deletions,
    };
  }

  const structuredPatch = Array.isArray(raw.structuredPatch) ? raw.structuredPatch : [];
  if (structuredPatch.length > 0) {
    const status = raw.originalFile === null ? "added" : stringValue(gitDiff.status ?? raw.type, "modified");
    const patch = patchFromStructuredPatch(structuredPatch, filePath, status);
    const stats = diffStatsFromPatch(patch) ?? { additions: 0, deletions: 0 };
    return {
      kind: "patch",
      patch,
      filePath: filePath || filePathFromPatch(patch) || "file",
      additions: stats.additions,
      deletions: stats.deletions,
    };
  }

  const originalFile = typeof raw.originalFile === "string" ? raw.originalFile : raw.originalFile === null ? "" : undefined;
  if (toolName === "Write" && originalFile !== undefined && typeof raw.content === "string") {
    const resolvedFilePath = filePath || "file";
    const status = originalFile ? "modified" : "added";
    const patch = createUnifiedPatch(originalFile, raw.content, resolvedFilePath, status);
    const stats = patch ? diffStatsFromPatch(patch) ?? { additions: 0, deletions: 0 } : {
      additions: lineCount(raw.content),
      deletions: lineCount(originalFile),
    };
    return {
      kind: "files",
      filePath: resolvedFilePath,
      oldContent: originalFile,
      newContent: raw.content,
      patch,
      additions: stats.additions,
      deletions: stats.deletions,
    };
  }

  if (toolName === "Edit" && typeof originalFile === "string") {
    const oldString = stringValue(raw.oldString ?? raw.old_string, "");
    const newString = stringValue(raw.newString ?? raw.new_string, "");
    if (!oldString && !newString) return null;
    if (!oldString) {
      return {
        kind: "files",
        filePath: filePath || "file",
        oldContent: oldString,
        newContent: newString,
        additions: lineCount(newString),
        deletions: 0,
        disableLineNumbers: true,
      };
    }
    const newContent = applyEdit(originalFile, oldString, newString, raw.replaceAll === true || raw.replace_all === true);
    const patch = createUnifiedPatch(originalFile, newContent, filePath || "file", "modified");
    const stats = patch ? diffStatsFromPatch(patch) ?? { additions: 0, deletions: 0 } : {
      additions: lineCount(newString),
      deletions: lineCount(oldString),
    };
    return {
      kind: "files",
      filePath: filePath || "file",
      oldContent: originalFile,
      newContent,
      patch,
      additions: stats.additions,
      deletions: stats.deletions,
    };
  }

  if (toolName === "MultiEdit" && typeof originalFile === "string") {
    const edits = Array.isArray(raw.edits) ? raw.edits.map(recordObject) : [];
    if (edits.length === 0) return null;
    const newContent = applyMultiEdit(originalFile, edits);
    const patch = createUnifiedPatch(originalFile, newContent, filePath || "file", "modified");
    const stats = patch ? diffStatsFromPatch(patch) ?? { additions: 0, deletions: 0 } : { additions: 0, deletions: 0 };
    return {
      kind: "files",
      filePath: filePath || "file",
      oldContent: originalFile,
      newContent,
      patch,
      additions: stats.additions,
      deletions: stats.deletions,
    };
  }

  return null;
}

export function hasToolResultDiffSource(toolName: string, result?: ToolResultBlock): boolean {
  if (!result || result.isError) return false;
  const raw = recordObject(result.toolUseResult ?? result.rawResult);
  const gitDiff = recordObject(raw.gitDiff);
  if (stringValue(gitDiff.patch, "")) return true;
  const structuredPatch = Array.isArray(raw.structuredPatch) ? raw.structuredPatch : [];
  if (structuredPatch.length > 0) return true;
  const originalFile = typeof raw.originalFile === "string" ? raw.originalFile : raw.originalFile === null ? "" : undefined;
  if (toolName === "Write") return originalFile !== undefined && typeof raw.content === "string";
  if (toolName === "Edit") {
    return typeof originalFile === "string" && (
      typeof raw.oldString === "string" ||
      typeof raw.old_string === "string" ||
      typeof raw.newString === "string" ||
      typeof raw.new_string === "string"
    );
  }
  if (toolName === "MultiEdit") return typeof originalFile === "string" && Array.isArray(raw.edits) && raw.edits.length > 0;
  return false;
}

export function formatDiffStats(diff: ToolDiffStats): string {
  const parts: string[] = [];
  if (diff.additions > 0) parts.push(`+${diff.additions}`);
  if (diff.deletions > 0) parts.push(`-${diff.deletions}`);
  return parts.join(" ");
}

function lineCount(value: string): number {
  if (!value) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) count += 1;
  }
  return value.endsWith("\n") ? Math.max(0, count - 1) : count;
}

function diffStatsFromPatch(patch: string): ToolDiffStats | null {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return diffStatsOrNull(additions, deletions);
}

function diffStatsFromStructuredPatch(structuredPatch: unknown[]): ToolDiffStats | null {
  let additions = 0;
  let deletions = 0;
  for (const item of structuredPatch) {
    const patch = recordObject(item);
    const lines = Array.isArray(patch.lines) ? patch.lines : [];
    for (const line of lines) {
      if (typeof line !== "string") continue;
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }
  return diffStatsOrNull(additions, deletions);
}

function diffStatsOrNull(additions: number, deletions: number): ToolDiffStats | null {
  return additions > 0 || deletions > 0 ? { additions, deletions } : null;
}

function filePathFromPatch(patch: string): string {
  const plusMatch = patch.match(/^\+\+\+\s+b\/(.+)$/m);
  if (plusMatch?.[1]) return plusMatch[1].trim();
  const diffMatch = patch.match(/^diff --git\s+a\/.+?\s+b\/(.+)$/m);
  return diffMatch?.[1]?.trim() || "";
}

function filePathFrom(raw: Record<string, unknown>): string {
  const gitDiff = recordObject(raw.gitDiff);
  return getToolInputPath(raw) || stringValue(gitDiff.filename, "");
}

function normalizeGitPatch(patch: string, filePath: string, status: string): string {
  const trimmed = patch.trimEnd();
  if (/^diff --git /m.test(trimmed)) return trimmed;
  return patchFromHunks(trimmed, filePath || "file", status || "modified");
}

function createUnifiedPatch(oldContent: string, newContent: string, filePath: string, status: string): string | undefined {
  if (oldContent === newContent) return undefined;
  const safePath = filePath.replace(/\\/g, "/") || "file";
  const patch = createTwoFilesPatch(
    status === "added" ? "/dev/null" : `a/${safePath}`,
    `b/${safePath}`,
    oldContent,
    newContent,
    "",
    "",
    {
      context: 3,
      headerOptions: FILE_HEADERS_ONLY,
      maxEditLength: 20_000,
      stripTrailingCr: true,
    },
  );
  if (!patch) return undefined;
  const body = patch
    .replace(/\t$/gm, "")
    .replace(/^--- \/dev\/null$/m, "--- /dev/null")
    .trimEnd();
  const header = [
    `diff --git a/${safePath} b/${safePath}`,
    status === "added" ? "new file mode 100644" : "",
  ].filter(Boolean);
  return [...header, body].join("\n");
}

function patchFromStructuredPatch(structuredPatch: unknown[], filePath: string, status: string): string {
  const hunks = structuredPatch.flatMap((item) => {
    const patch = recordObject(item);
    const lines = Array.isArray(patch.lines) ? patch.lines.filter((line): line is string => typeof line === "string") : [];
    if (lines.length === 0) return [];
    const oldStart = numericValue(patch.oldStart) ?? 0;
    const oldLines = numericValue(patch.oldLines) ?? 0;
    const newStart = numericValue(patch.newStart) ?? 0;
    const newLines = numericValue(patch.newLines) ?? 0;
    return [`@@ -${rangeSpec(oldStart, oldLines)} +${rangeSpec(newStart, newLines)} @@`, ...lines];
  });
  return patchFromHunks(hunks.join("\n"), filePath || "file", status);
}

function patchFromHunks(hunks: string, filePath: string, status: string): string {
  const safePath = filePath.replace(/\\/g, "/") || "file";
  const added = status === "added" || status === "create" || status === "new";
  const header = [
    `diff --git a/${safePath} b/${safePath}`,
    added ? "new file mode 100644" : "",
    `--- ${added ? "/dev/null" : `a/${safePath}`}`,
    `+++ b/${safePath}`,
  ].filter(Boolean);
  return [...header, hunks].join("\n");
}

function rangeSpec(start: number, lines: number): string {
  return `${Math.max(0, start)},${Math.max(0, lines)}`;
}

function applyEdit(content: string, oldString: string, newString: string, replaceAll: boolean): string {
  if (!oldString) return content;
  return replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
}

function applyMultiEdit(content: string, edits: Array<Record<string, unknown>>): string {
  return edits.reduce((current, edit) => {
    const oldString = typeof edit.old_string === "string" ? edit.old_string : typeof edit.oldString === "string" ? edit.oldString : "";
    const newString = typeof edit.new_string === "string" ? edit.new_string : typeof edit.newString === "string" ? edit.newString : "";
    const replaceAll = edit.replace_all === true || edit.replaceAll === true;
    return applyEdit(current, oldString, newString, replaceAll);
  }, content);
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function nonNegativeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return null;
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
  }
  return null;
}
