import assert from "node:assert/strict";
import type { RagSearchResult } from "../../types/domain";
import type { RagTextSearchResult } from "../storage/sqlite-business-store";
import { chunkParsedText } from "../indexing/chunking";
import { rankHybridRagResults, searchHybridRag } from "./rag-search-orchestrator";

const merged = rankHybridRagResults({
  query: "rubric deadline",
  maxResults: 3,
  vectorResults: [
    vectorResult("chunk-a", "file-a", 0, 0.91),
    vectorResult("chunk-b", "file-b", 0, 0.82),
  ],
  textResults: [
    textResult("chunk-a", "file-a", 0, -3.1, "The rubric explains the final deadline and word count."),
    textResult("chunk-c", "file-c", 0, -2.7, "A separate deadline note for the speech outline."),
  ],
});

assert.equal(merged[0]?.id, "chunk-a");
assert.equal(merged[0]?.score, 1);
assert.match(merged[0]?.excerpt || "", /rubric|deadline/i);
assert.equal(merged.some((result) => result.id === "chunk-c"), true);

const diversified = rankHybridRagResults({
  query: "speech",
  maxResults: 3,
  vectorResults: [
    vectorResult("file-a:0", "file-a", 0, 0.95),
    vectorResult("file-a:1", "file-a", 1, 0.9),
    vectorResult("file-a:2", "file-a", 2, 0.85),
    vectorResult("file-b:0", "file-b", 0, 0.8),
  ],
  textResults: [],
});

assert.deepEqual(
  diversified.map((result) => result.id),
  ["file-a:0", "file-b:0", "file-a:1"],
);

const singleFileLimited = rankHybridRagResults({
  query: "speech",
  maxResults: 6,
  vectorResults: [
    vectorResult("solo:0", "solo", 0, 0.95),
    vectorResult("solo:1", "solo", 1, 0.9),
    vectorResult("solo:2", "solo", 2, 0.85),
    vectorResult("solo:3", "solo", 3, 0.8),
  ],
  textResults: [],
});

assert.deepEqual(
  singleFileLimited.map((result) => result.id),
  ["solo:0", "solo:1"],
);

const anchoredTieBreak = rankHybridRagResults({
  query: "speech requirements",
  maxResults: 2,
  vectorResults: [
    vectorResult("plain", "plain-file", 0, 0.9),
    { ...vectorResult("anchored", "anchored-file", 0, 0.9), slide: 5, semanticUnitId: "unit-slide-5", sourceLabel: "Slide 5" },
  ],
  textResults: [],
});

assert.equal(anchoredTieBreak[0]?.id, "anchored", "structured anchors should break equivalent relevance ties");

const objectAnchor = rankHybridRagResults({
  query: "revenue chart",
  maxResults: 1,
  vectorResults: [{
    ...vectorResult("chart", "workbook", 0, 0.9),
    sectionType: "chart",
    semanticUnitId: "artifact-1:sheet-1:chart-1:unit",
    elementIds: ["artifact-1:sheet-1:chart-1"],
    sheet: "Summary",
  }],
  textResults: [],
});

assert.deepEqual(objectAnchor[0]?.elementIds, ["artifact-1:sheet-1:chart-1"], "object ids should survive hybrid ranking");

const structuredChunks = chunkParsedText({
  text: "short aggregate text",
  byteCount: 1_800,
  warnings: [],
  metadata: {},
  sections: [
    {
      text: Array.from(
        { length: 14 },
        (_value, index) => `Paragraph ${index + 1}: persuasive speech assessment detail with evidence, timing, academic references, classroom delivery, and grading expectations for students.`,
      ).join("\n\n"),
      sourceLabel: "Assessment Guidelines",
      sectionType: "document_section",
    },
    {
      text: "Late submissions receive a 30% deduction without an AR form.\n\nNo visual aid or written script is allowed.",
      sourceLabel: "Assessment Rules",
      sectionType: "document_section",
    },
  ],
});

assert.ok(structuredChunks.chunks.length >= 3, "multi-paragraph structured documents should be split into multiple chunks");
assert.ok(structuredChunks.chunks.some((chunk) => chunk.includes("Paragraph 14")), "later paragraphs should remain indexed");
assert.ok(structuredChunks.chunks.some((chunk) => chunk.includes("30% deduction")), "later sections should not be trimmed by aggregate text length");

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function run(): Promise<void> {
  const warn = console.warn;
  console.warn = () => undefined;
  let fallback: RagSearchResult[];
  try {
    fallback = await searchHybridRag({
      query: "deadline",
      semesterId: "semester-test",
      courseId: "course-test",
      maxResults: 2,
      vectorSearch: async () => {
        throw new Error("embedding provider unavailable");
      },
      textSearch: () => [textResult("keyword-only", "file-k", 0, -1.2, "Deadline evidence from keyword search.")],
    });
  } finally {
    console.warn = warn;
  }

  assert.equal(fallback.length, 1);
  assert.equal(fallback[0]?.id, "keyword-only");

  console.log("rag-search-orchestrator tests passed");
}

function vectorResult(id: string, fileId: string, chunkIndex: number, score: number): RagSearchResult {
  return {
    id,
    courseId: "course-test",
    fileId,
    fileName: `${fileId}.pdf`,
    title: `${fileId}.pdf`,
    source: `/Course/Lecture/${fileId}.pdf`,
    citation: `${fileId}.pdf · page ${chunkIndex + 1}`,
    excerpt: `Vector excerpt ${chunkIndex}`,
    score,
    path: `/Course/Lecture/${fileId}.pdf`,
    sectionKind: "lecture",
    chunkIndex,
    chunkCount: 4,
  };
}

function textResult(id: string, fileId: string, chunkIndex: number, rank: number, text: string): RagTextSearchResult {
  return {
    id,
    semesterId: "semester-test",
    courseId: "course-test",
    sectionId: "course-test:lecture",
    fileId,
    fileName: `${fileId}.pdf`,
    filePath: `/Course/Lecture/${fileId}.pdf`,
    title: `${fileId}.pdf`,
    citation: `${fileId}.pdf · page ${chunkIndex + 1}`,
    text,
    chunkIndex,
    chunkCount: 4,
    rank,
  };
}
