import type { CourseFileSectionKind, RagSearchResult } from "../../types/domain";
import type { RagTextSearchResult } from "../storage/sqlite-business-store";
import type { RagSearchOptions } from "./rag-index-service";

type VectorSearch = (
  query: string,
  semesterId: string,
  courseId: string | undefined,
  maxResults: number,
  excludeCourseIds: string[],
  options: RagSearchOptions,
) => Promise<RagSearchResult[]>;

type TextSearch = (input: {
  query: string;
  semesterId: string;
  courseId?: string;
  taskId?: string;
  sectionKind?: CourseFileSectionKind;
  limit?: number;
}) => RagTextSearchResult[];

export interface HybridRagSearchInput {
  query: string;
  semesterId: string;
  courseId?: string;
  maxResults?: number;
  excludeCourseIds?: string[];
  options?: RagSearchOptions;
  vectorSearch: VectorSearch;
  textSearch: TextSearch;
}

type HybridCandidate = {
  key: string;
  result: RagSearchResult;
  vectorRank?: number;
  textRank?: number;
  vectorScore?: number;
  textRankValue?: number;
  blendedScore: number;
};

const DEFAULT_TOP_K = 6;
const RRF_K = 60;
const VECTOR_WEIGHT = 1;
const TEXT_WEIGHT = 1.12;
const BOTH_SIGNALS_BONUS = 0.003;
const STRUCTURED_ANCHOR_BONUS = 0.0015;
const TITLE_MATCH_BONUS = 0.0012;

export async function searchHybridRag(input: HybridRagSearchInput): Promise<RagSearchResult[]> {
  const query = input.query.trim() || "course materials";
  const maxResults = clampInteger(input.maxResults ?? DEFAULT_TOP_K, 1, 24);
  const options = input.options ?? {};
  const candidateLimit = clampInteger(Math.max(maxResults * 4, 24), maxResults, 80);
  const excludeCourseIds = input.excludeCourseIds ?? [];
  let vectorError: unknown;
  let textError: unknown;

  const [vectorResults, textResults] = await Promise.all([
    input
      .vectorSearch(query, input.semesterId, input.courseId, candidateLimit, excludeCourseIds, {
        ...options,
        perFileMax: Math.max(options.perFileMax ?? 4, 4),
      })
      .catch((error) => {
        vectorError = error;
        return [] as RagSearchResult[];
      }),
    Promise.resolve()
      .then(() =>
        input.textSearch({
          query,
          semesterId: input.semesterId,
          courseId: input.courseId,
          taskId: options.taskId,
          sectionKind: options.sectionKind,
          limit: candidateLimit,
        }),
      )
      .catch((error) => {
        textError = error;
        return [] as RagTextSearchResult[];
      }),
  ]);

  const visibleTextResults = textResults.filter((result) => !excludeCourseIds.includes(result.courseId));
  if (vectorError && visibleTextResults.length === 0) throw vectorError;
  if (textError && vectorResults.length === 0) throw textError;
  if (vectorError) console.warn("[rag] Vector search degraded; using keyword results", vectorError);
  if (textError) console.warn("[rag] Keyword search degraded; using vector results", textError);

  return rankHybridRagResults({
    query,
    maxResults,
    perFileMax: options.perFileMax,
    vectorResults,
    textResults: visibleTextResults,
  });
}

export function rankHybridRagResults(input: {
  query: string;
  maxResults: number;
  perFileMax?: number;
  vectorResults: RagSearchResult[];
  textResults: RagTextSearchResult[];
}): RagSearchResult[] {
  const candidates = new Map<string, HybridCandidate>();
  input.vectorResults.forEach((result, index) => {
    const rank = index + 1;
    upsertCandidate(candidates, {
      result,
      key: candidateKey(result),
      vectorRank: rank,
      vectorScore: result.score,
    });
  });
  input.textResults.forEach((result, index) => {
    const rank = index + 1;
    upsertCandidate(candidates, {
      result: textResultToRagResult(result, input.query),
      key: result.id || `${result.fileId}:${result.chunkIndex ?? index}`,
      textRank: rank,
      textRankValue: result.rank,
    });
  });

  const ranked = Array.from(candidates.values())
    .map((candidate) => ({
      ...candidate,
      blendedScore: blendedScore(candidate),
    }))
    .sort(compareHybridCandidates);

  const diversified = diversifyByFile(ranked, input.maxResults, input.perFileMax);
  const bestScore = Math.max(...diversified.map((candidate) => candidate.blendedScore), 0);
  return diversified.map((candidate) => ({
    ...candidate.result,
    score: bestScore > 0 ? clampNumber(candidate.blendedScore / bestScore, 0, 1) : candidate.result.score,
  }));
}

function upsertCandidate(
  candidates: Map<string, HybridCandidate>,
  incoming: {
    key: string;
    result: RagSearchResult;
    vectorRank?: number;
    textRank?: number;
    vectorScore?: number;
    textRankValue?: number;
  },
): void {
  const existing = candidates.get(incoming.key);
  if (!existing) {
    candidates.set(incoming.key, {
      ...incoming,
      blendedScore: 0,
    });
    return;
  }
  candidates.set(incoming.key, {
    ...existing,
    result: mergeRagResult(existing.result, incoming.result),
    vectorRank: existing.vectorRank ?? incoming.vectorRank,
    textRank: existing.textRank ?? incoming.textRank,
    vectorScore: existing.vectorScore ?? incoming.vectorScore,
    textRankValue: existing.textRankValue ?? incoming.textRankValue,
  });
}

function mergeRagResult(existing: RagSearchResult, incoming: RagSearchResult): RagSearchResult {
  return {
    ...existing,
    fileId: existing.fileId || incoming.fileId,
    fileName: existing.fileName || incoming.fileName,
    title: existing.title || incoming.title,
    source: existing.source || incoming.source,
    citation: incoming.citation || existing.citation,
    excerpt: incoming.excerpt || existing.excerpt,
    path: existing.path || incoming.path,
    sectionKind: existing.sectionKind || incoming.sectionKind,
    taskId: existing.taskId || incoming.taskId,
    chunkIndex: existing.chunkIndex ?? incoming.chunkIndex,
    chunkCount: existing.chunkCount ?? incoming.chunkCount,
    elementIds: existing.elementIds?.length ? existing.elementIds : incoming.elementIds,
  };
}

function blendedScore(candidate: HybridCandidate): number {
  const vector = candidate.vectorRank ? VECTOR_WEIGHT / (RRF_K + candidate.vectorRank) : 0;
  const text = candidate.textRank ? TEXT_WEIGHT / (RRF_K + candidate.textRank) : 0;
  const bothSignalsBonus = candidate.vectorRank && candidate.textRank ? BOTH_SIGNALS_BONUS : 0;
  return vector + text + bothSignalsBonus + evidenceAnchorBonus(candidate.result);
}

function compareHybridCandidates(a: HybridCandidate, b: HybridCandidate): number {
  if (b.blendedScore !== a.blendedScore) return b.blendedScore - a.blendedScore;
  const bHasBoth = Number(Boolean(b.vectorRank && b.textRank));
  const aHasBoth = Number(Boolean(a.vectorRank && a.textRank));
  if (bHasBoth !== aHasBoth) return bHasBoth - aHasBoth;
  const bVector = b.vectorScore ?? 0;
  const aVector = a.vectorScore ?? 0;
  if (bVector !== aVector) return bVector - aVector;
  const aText = a.textRankValue ?? Number.POSITIVE_INFINITY;
  const bText = b.textRankValue ?? Number.POSITIVE_INFINITY;
  return aText - bText;
}

function diversifyByFile(candidates: HybridCandidate[], maxResults: number, requestedPerFileMax?: number): HybridCandidate[] {
  const perFileMax = clampInteger(requestedPerFileMax ?? 2, 1, Math.max(1, maxResults));
  if (perFileMax > 1 && candidates.length > maxResults) {
    const firstPass = selectDiversePass(candidates, maxResults, 1);
    if (firstPass.length >= Math.min(maxResults, 2)) {
      const selectedKeys = new Set(firstPass.map((candidate) => candidate.key));
      const fill = selectDiversePass(
        candidates.filter((candidate) => !selectedKeys.has(candidate.key)),
        maxResults,
        perFileMax + 1,
        firstPass,
      );
      return [...firstPass, ...fill].slice(0, maxResults);
    }
  }
  return selectDiversePass(candidates, maxResults, perFileMax);
}

function selectDiversePass(
  candidates: HybridCandidate[],
  maxResults: number,
  perFileMax: number,
  initialSelected: HybridCandidate[] = [],
): HybridCandidate[] {
  const selected: HybridCandidate[] = [];
  const counts = new Map<string, number>();
  for (const candidate of initialSelected) {
    const fileKey = fileDiversityKey(candidate);
    counts.set(fileKey, (counts.get(fileKey) || 0) + 1);
  }
  for (const candidate of candidates) {
    const fileKey = fileDiversityKey(candidate);
    const count = counts.get(fileKey) || 0;
    if (count < perFileMax && initialSelected.length + selected.length < maxResults) {
      selected.push(candidate);
      counts.set(fileKey, count + 1);
    }
  }
  return selected;
}

function fileDiversityKey(candidate: HybridCandidate): string {
  return candidate.result.fileId || candidate.result.path || candidate.result.source || candidate.key;
}

function textResultToRagResult(result: RagTextSearchResult, query: string): RagSearchResult {
  const source = result.filePath || result.fileName || "workspace";
  return {
    id: result.id,
    courseId: result.courseId,
    fileId: result.fileId,
    fileName: result.fileName || source,
    title: result.title || result.fileName || source,
    source,
    sourcePath: result.sourcePath || "",
    citation: result.citation || source,
    excerpt: excerptText(result.text, query),
    score: 0,
    path: source,
    sectionKind: sectionKindForRow(result.sectionId, source),
    taskId: result.taskId || taskIdForRow(result.sectionId, source),
    chunkIndex: result.chunkIndex,
    chunkCount: result.chunkCount,
    sourceLabel: result.sourceLabel,
    sectionType: result.sectionType,
    sectionTitle: result.sectionTitle,
    artifactId: result.artifactId,
    semanticUnitId: result.semanticUnitId,
    elementIds: result.elementIds,
    page: result.page,
    slide: result.slide,
    sheet: result.sheet,
    range: result.range,
    bbox: result.bbox,
  };
}

function candidateKey(result: RagSearchResult): string {
  return result.id || `${result.fileId || result.path || result.source}:${result.chunkIndex ?? ""}`;
}

function sectionKindForRow(sectionId: string, filePath: string): CourseFileSectionKind | undefined {
  if (sectionId.includes(":lecture") || filePath.includes("/Lecture/")) return "lecture";
  if (sectionId.includes(":task-") || filePath.includes("/Task/")) return "task";
  if (sectionId.includes(":shared") || filePath.includes("/Course shared/") || filePath.includes("/Semester shared/")) return "course_shared";
  return undefined;
}

function taskIdForRow(sectionId: string, filePath: string): string | undefined {
  const sectionMatch = sectionId.match(/:task-(.+)$/);
  if (sectionMatch?.[1]) return normalizeTaskId(sectionMatch[1]);
  const pathMatch = filePath.match(/\/Task\/(task-[^/]+)/);
  return pathMatch?.[1];
}

function normalizeTaskId(value: string): string {
  return value.startsWith("task-task-") ? value.slice("task-".length) : value;
}

function evidenceAnchorBonus(result: RagSearchResult): number {
  let bonus = 0;
  if (result.semanticUnitId || result.page || result.slide || result.sheet || result.range || result.sourceLabel) {
    bonus += STRUCTURED_ANCHOR_BONUS;
  }
  if (result.title || result.sectionTitle || result.citation) {
    bonus += TITLE_MATCH_BONUS;
  }
  return bonus;
}

function excerptText(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = normalized.toLowerCase();
  const matchIndex = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (matchIndex === undefined) return normalized.slice(0, 900);
  const start = Math.max(0, matchIndex - 260);
  const end = Math.min(normalized.length, matchIndex + 900);
  return normalized.slice(start, end).trim();
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
