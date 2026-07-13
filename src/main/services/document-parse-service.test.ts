import assert from "node:assert/strict";
import type { IndexingWorkerResult } from "../indexing";
import type { ParsedIndexingFile } from "../indexing/parsers/types";
import type { BrevynOfficeArtifact } from "../office-model/schema";
import { shouldOcrPptxSlide } from "../indexing/parsers/pptx-parser";
import { buildPptxSlideOcrResult, pptxSlidesNeedingOcr } from "./document-parse-service";

const artifact: BrevynOfficeArtifact = {
  id: "artifact-slides",
  schemaVersion: 1,
  kind: "pptx",
  title: "Rubric deck",
  source: { path: "/tmp/rubric.pptx", name: "rubric.pptx", byteCount: 1200 },
  metadata: {
    parser: "brevyn-pptx-object-model",
    parserVersion: 1,
    createdAt: "2026-07-11T00:00:00.000Z",
    coverageStatus: "partial",
  },
  presentation: {
    slideCount: 2,
  },
  elements: [],
  assets: [],
  semanticUnits: [{
    id: "artifact-slides:slide-1:unit-slide",
    artifactId: "artifact-slides",
    elementIds: [],
    unitType: "slide",
    title: "Slide 1",
    text: "## Slide 1\n\nCourse introduction",
    markdown: "## Slide 1\n\nCourse introduction",
    sourceLabel: "幻灯片 1",
    citation: "Slide 1",
    location: { slide: 1 },
  }],
};

const parsed: ParsedIndexingFile = {
  text: "## Slide 1\n\nCourse introduction",
  byteCount: 1200,
  warnings: ["1 PPTX slides contain images without extractable slide text and need OCR/document parsing for full indexing."],
  metadata: {
    parser: "pptx-jszip",
    artifactId: artifact.id,
    slides: 2,
    sectionsTotal: 2,
    sectionsIndexed: 1,
    sectionsEmpty: 1,
    imageOnlySlides: 1,
    assetsNeedingOcr: 1,
    coverageStatus: "partial",
  },
  sections: [{
    text: "## Slide 1\n\nCourse introduction",
    sourceLabel: "幻灯片 1",
    title: "Course introduction",
    sectionType: "slide",
    sectionIndex: 1,
    artifactId: artifact.id,
    semanticUnitId: "artifact-slides:slide-1:unit-slide",
    slide: 1,
  }],
  assets: [{
    id: "asset-slide-2-rubric",
    kind: "slide_image",
    sourceLabel: "幻灯片 2 内嵌图片",
    slideNumber: 2,
    needsOcr: true,
  }],
  officeArtifact: artifact,
};

const baseResult: IndexingWorkerResult = {
  fileId: "file-rubric",
  sourcePath: "/tmp/rubric.pptx",
  chunkCount: 1,
  charCount: parsed.text.length,
  byteCount: parsed.byteCount,
  sample: parsed.text,
  warnings: parsed.warnings,
  chunks: [parsed.text],
  chunkMetadata: [{ slide: 1, semanticUnitId: "artifact-slides:slide-1:unit-slide" }],
  metadata: parsed.metadata,
  derivedMarkdown: parsed.text,
  parsed,
  officeArtifact: artifact,
};

assert.deepEqual(pptxSlidesNeedingOcr(parsed), [2]);
assert.equal(shouldOcrPptxSlide({ text: "", mediaCount: 1, imageCoverageRatio: 0.1 }), true);
assert.equal(shouldOcrPptxSlide({ text: "A closer look", mediaCount: 2, imageCoverageRatio: 0.2 }), true);
assert.equal(shouldOcrPptxSlide({ text: "Short title", mediaCount: 1, imageCoverageRatio: 0.6 }), true);
assert.equal(shouldOcrPptxSlide({ text: "Short title", mediaCount: 0, imageCoverageRatio: 0.8 }), false);
assert.equal(shouldOcrPptxSlide({ text: "A".repeat(300), mediaCount: 1, imageCoverageRatio: 0.8 }), false);

const inferredMissingSlide: ParsedIndexingFile = {
  ...parsed,
  assets: undefined,
  metadata: { ...parsed.metadata, slides: 3, sectionsTotal: 3, sectionsEmpty: 2 },
};
assert.deepEqual(pptxSlidesNeedingOcr(inferredMissingSlide), [2, 3]);

const result = buildPptxSlideOcrResult(
  {
    sourcePath: "/tmp/rubric.pptx",
    kind: "pptx",
    fileName: "rubric.pptx",
    parsed,
    result: baseResult,
  },
  [{ slide: 2, markdown: "## Slide 2\n\n| Criterion | Excellent |\n| --- | --- |\n| Evidence | Highly relevant |" }],
  { name: "MinerU", selectedModel: "brevyn-doc-parse" },
  1200,
);

assert.equal(result.metadata?.parser, "pptx-jszip+mineru-slide-ocr");
assert.equal(result.metadata?.documentParseReplacedLocalPartial, false);
assert.equal(result.metadata?.coverageStatus, "complete");
assert.ok(result.chunkMetadata?.some((metadata) => metadata.slide === 1 && metadata.semanticUnitId?.includes("unit-slide")), "local slide anchors should remain indexed");
assert.ok(result.chunkMetadata?.some((metadata) => metadata.slide === 2 && metadata.semanticUnitId === "artifact-slides:slide-2:unit-ocr"), "OCR chunks should carry their exact slide anchor");
assert.ok(result.chunkMetadata?.every((metadata) => metadata.sectionType !== "document_parse"), "PPTX OCR must not fall back to an unanchored whole-document chunk");
assert.match(result.derivedMarkdown || "", /## Slide 2/);

const augmentedArtifact = result.officeArtifact as BrevynOfficeArtifact;
assert.ok(augmentedArtifact.semanticUnits.some((unit) => unit.id === "artifact-slides:slide-2:unit-ocr" && unit.location.slide === 2), "preview sidecars should include the OCR slide unit");

console.log("document parse service tests passed");
