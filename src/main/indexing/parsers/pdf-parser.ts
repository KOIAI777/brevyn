import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CoverageStatus, ParsedDocumentCoverageItem, ParsedIndexingFile, ParsedIndexingSection, ParseInput } from "./types";
import type { BrevynOfficeArtifact, BrevynOfficeElement, BrevynSemanticUnit } from "../../office-model/schema";
import { officeArtifactMarkdown } from "../../office-model/semantic-units";
import { capParsedText, collectConsoleWarnings, dedupeWarnings, emptyParsedFile, errorMessage, normalizeText, withTimeout } from "./utils";

const require = createRequire(__filename);
type PdfParse = (buffer: Buffer) => Promise<{
  numpages?: number;
  numrender?: number;
  text?: string;
}>;

const PDF_PARSE_TIMEOUT_MS = 30_000;
const PDF_OBJECT_MODEL_SCHEMA_VERSION = 1;
const PDF_OBJECT_MODEL_PARSER = "brevyn-pdf-object-model";

export async function parsePdf(input: ParseInput, byteCount: number): Promise<ParsedIndexingFile> {
  try {
    return await withTimeout(parsePdfPages(input, byteCount), PDF_PARSE_TIMEOUT_MS, "PDF text extraction timed out.");
  } catch (error) {
    return parsePdfFallback(input, byteCount, errorMessage(error));
  }
}

async function parsePdfPages(input: ParseInput, byteCount: number): Promise<ParsedIndexingFile> {
  const parsed = await collectConsoleWarnings(() => parsePdfPagesWithPdfjs(input, byteCount));
  const warnings = [
    ...parsed.result.warnings,
    ...parsed.warnings.filter((warning) => !isIgnorablePdfjsWarning(warning)),
  ];
  return {
    ...parsed.result,
    warnings: dedupeWarnings(warnings),
  };
}

async function parsePdfPagesWithPdfjs(input: ParseInput, byteCount: number): Promise<ParsedIndexingFile> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(__dirname, "pdfjs", "pdf.worker.min.mjs")).href;
  const bytes = readFileSync(input.sourcePath);
  const artifactId = `artifact-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    disableFontFace: true,
    isEvalSupported: false,
    standardFontDataUrl: pathToFileURL(`${join(__dirname, "pdfjs", "standard_fonts")}/`).href,
    useWorkerFetch: false,
  });
  const pdf = await loadingTask.promise;
  const parts: string[] = [];
  const elements: BrevynOfficeElement[] = [];
  const semanticUnits: BrevynSemanticUnit[] = [];
  const coverageItems: ParsedDocumentCoverageItem[] = [];
  const warnings: string[] = [];
  let indexedPages = 0;
  let emptyPages = 0;
  let failedPages = 0;
  let pagesNeedingOcr = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      try {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        const visualSignals = await pdfPageVisualSignals(page, pdfjs).catch(() => ({ imageOps: 0, paintOps: 0 }));
        const text = normalizeText(content.items
          .map((item) => "str" in item && typeof item.str === "string" ? item.str : "")
          .filter(Boolean)
          .join(" "));
        const viewport = page.getViewport({ scale: 1 });
        page.cleanup();
        const textChars = text.length;
        const ocrReason = pdfPageOcrReason(textChars, visualSignals.imageOps || 0);
        if (ocrReason) pagesNeedingOcr += 1;
        coverageItems.push({
          index: pageNumber,
          pageNumber,
          sourceLabel: `第 ${pageNumber} 页`,
          textChars,
          hasText: Boolean(text),
          failed: false,
          needsOcr: Boolean(ocrReason),
          reason: ocrReason,
          visualSignals,
        });
        if (text) {
          indexedPages += 1;
          const repairedText = repairPdfTextSpacing(text);
          const sectionText = `## Page ${pageNumber}\n\n${repairedText}`;
          const elementId = `${artifactId}:page-${pageNumber}`;
          elements.push({
            id: elementId,
            type: "page",
            text: repairedText,
            markdown: sectionText,
            location: { page: pageNumber },
            bbox: { x: 0, y: 0, width: viewport.width, height: viewport.height },
          });
          const pageRegions = pdfSemanticRegionsFromTextContent({
            artifactId,
            pageNumber,
            pageElementId: elementId,
            textContent: content,
            fallbackText: repairedText,
            viewport: { width: viewport.width, height: viewport.height },
          });
          elements.push(...pageRegions.elements);
          semanticUnits.push(...pageRegions.semanticUnits);
          parts.push(...pageRegions.semanticUnits.map((unit) => unit.markdown || unit.text));
        } else {
          emptyPages += 1;
        }
      } catch (error) {
        failedPages += 1;
        pagesNeedingOcr += 1;
        coverageItems.push({
          index: pageNumber,
          pageNumber,
          sourceLabel: `第 ${pageNumber} 页`,
          textChars: 0,
          hasText: false,
          failed: true,
          needsOcr: true,
          reason: "page_text_extraction_failed",
        });
        warnings.push(`Page ${pageNumber} text extraction failed: ${errorMessage(error)}`);
      }
    }
  } finally {
    await pdf.destroy();
  }

  const artifact: BrevynOfficeArtifact = {
    id: artifactId,
    schemaVersion: PDF_OBJECT_MODEL_SCHEMA_VERSION,
    kind: "pdf",
    title: basename(input.sourcePath),
    source: {
      path: input.sourcePath,
      name: basename(input.sourcePath),
      byteCount,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    metadata: {
      parser: PDF_OBJECT_MODEL_PARSER,
      parserVersion: 1,
      createdAt: new Date().toISOString(),
      coverageStatus: indexedPages > 0 && failedPages === 0 && emptyPages === 0 ? "complete" : indexedPages > 0 ? "partial" : "skipped",
      warnings: [],
      pages: pdf.numPages,
      indexedPages,
      emptyPages,
      failedPages,
    },
    pdf: {
      pageCount: pdf.numPages,
    },
    elements,
    assets: [],
    semanticUnits,
  };
  const text = normalizeText(officeArtifactMarkdown(artifact) || parts.join("\n\n"));
  if (!text) {
    warnings.push("No extractable PDF text was found. This may be a scanned PDF and may need MinerU document parsing.");
  }
  if (failedPages > 0) {
    warnings.push(`${failedPages} PDF pages could not be parsed.`);
  }
  if (emptyPages > 0 && indexedPages > 0) {
    warnings.push(`${emptyPages} PDF pages had no extractable text.`);
  }
  const capped = capParsedText(text, warnings);
  const coverageStatus: CoverageStatus = !normalizeText(capped.text)
    ? "skipped"
    : failedPages > 0 || emptyPages > 0 || capped.truncated
      ? "partial"
      : "complete";
  return {
    text: normalizeText(capped.text),
    byteCount,
    warnings: dedupeWarnings(warnings),
    metadata: {
      parser: "pdfjs-dist",
      officeParser: PDF_OBJECT_MODEL_PARSER,
      artifactId,
      artifactSchemaVersion: PDF_OBJECT_MODEL_SCHEMA_VERSION,
      kind: input.kind,
      pages: pdf.numPages,
      sectionsTotal: semanticUnits.length || pdf.numPages,
      sectionsIndexed: semanticUnits.length || indexedPages,
      sectionsEmpty: emptyPages,
      sectionsFailed: failedPages,
      sectionsNeedingOcr: pagesNeedingOcr,
      sectionUnit: semanticUnits.length > 0 ? "个语义区域" : "页",
      coverageStatus,
      truncated: capped.truncated,
    },
    coverage: {
      status: coverageStatus,
      unit: "page",
      total: pdf.numPages,
      indexed: indexedPages,
      empty: emptyPages,
      failed: failedPages,
      needsOcr: pagesNeedingOcr,
      items: coverageItems,
    },
    sections: sectionsFromPdfArtifact(artifact),
    officeArtifact: artifact,
  };
}

function sectionsFromPdfArtifact(artifact: BrevynOfficeArtifact): ParsedIndexingSection[] {
  return artifact.semanticUnits.map((unit, index) => ({
    text: unit.markdown || unit.text,
    sourceLabel: unit.sourceLabel,
    title: unit.title,
    sectionType: unit.unitType,
    sectionIndex: index + 1,
    artifactId: artifact.id,
    semanticUnitId: unit.id,
    elementIds: unit.elementIds,
    page: unit.location.page,
    bbox: unit.bbox ? JSON.stringify(unit.bbox) : undefined,
  }));
}

interface PdfTextItemLike {
  str?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
}

interface PdfTextContentLike {
  items?: unknown[];
}

interface PdfTextToken {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

interface PdfLine {
  text: string;
  tokens: PdfTextToken[];
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

interface PdfBlock {
  lines: PdfLine[];
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  type: "heading" | "paragraph" | "table" | "pdf_region";
}

function pdfSemanticRegionsFromTextContent(input: {
  artifactId: string;
  pageNumber: number;
  pageElementId: string;
  textContent: PdfTextContentLike;
  fallbackText: string;
  viewport: { width: number; height: number };
}): { elements: BrevynOfficeElement[]; semanticUnits: BrevynSemanticUnit[] } {
  const blocks = pdfBlocksFromTextContent(input.textContent, input.fallbackText);
  const usableBlocks = blocks.length > 0
    ? blocks
    : [{
      lines: [],
      text: input.fallbackText,
      x: 0,
      y: 0,
      width: input.viewport.width,
      height: input.viewport.height,
      fontSize: 0,
      type: "pdf_region" as const,
    }];
  const elements: BrevynOfficeElement[] = [];
  const semanticUnits: BrevynSemanticUnit[] = [];
  usableBlocks.forEach((block, index) => {
    const elementId = `${input.artifactId}:page-${input.pageNumber}-region-${index + 1}`;
    const unitId = `${input.artifactId}:unit-page-${input.pageNumber}-region-${index + 1}`;
    const title = pdfBlockTitle(block, input.pageNumber, index + 1);
    const markdown = pdfBlockMarkdown(block, title);
    const elementType = block.type === "heading" ? "heading" : block.type === "table" ? "table" : "paragraph";
    const bbox = { x: block.x, y: block.y, width: block.width, height: block.height };
    elements.push({
      id: elementId,
      type: elementType,
      text: block.text,
      markdown,
      location: {
        page: input.pageNumber,
        objectPath: `page/${input.pageNumber}/region/${index + 1}`,
      },
      bbox,
      children: [input.pageElementId],
    });
    semanticUnits.push({
      id: unitId,
      artifactId: input.artifactId,
      elementIds: [elementId, input.pageElementId],
      unitType: block.type === "heading" ? "document_section" : block.type === "table" ? "table" : block.type === "paragraph" ? "paragraph" : "pdf_region",
      title,
      text: block.text,
      markdown,
      sourceLabel: `第 ${input.pageNumber} 页 · ${title}`,
      citation: `p. ${input.pageNumber}`,
      location: {
        page: input.pageNumber,
        objectPath: `page/${input.pageNumber}/region/${index + 1}`,
      },
      bbox,
      importance: block.type === "heading" ? 0.9 : block.type === "table" ? 0.82 : 0.65,
    });
  });
  return { elements, semanticUnits };
}

function pdfBlocksFromTextContent(textContent: PdfTextContentLike, fallbackText: string): PdfBlock[] {
  const tokens = pdfTextTokens(textContent);
  if (tokens.length === 0) return [];
  const lines = pdfLinesFromTokens(tokens);
  if (lines.length === 0) return [];
  const fontSizes = lines.map((line) => line.fontSize).filter((value) => value > 0).sort((a, b) => a - b);
  const medianFontSize = fontSizes[Math.floor(fontSizes.length / 2)] || 0;
  const blocks: PdfBlock[] = [];
  let current: PdfLine[] = [];
  let previous: PdfLine | undefined;
  for (const line of lines) {
    const gap = previous ? previous.y - (line.y + line.height) : 0;
    const startsNewBlock = previous
      ? gap > Math.max(8, medianFontSize * 1.45) ||
        isLikelyPdfHeading(line, medianFontSize) ||
        (isLikelyPdfHeading(previous, medianFontSize) && !isLikelyPdfHeading(line, medianFontSize))
      : false;
    if (startsNewBlock && current.length > 0) {
      blocks.push(pdfBlockFromLines(current, medianFontSize));
      current = [];
    }
    current.push(line);
    previous = line;
  }
  if (current.length > 0) blocks.push(pdfBlockFromLines(current, medianFontSize));
  const normalizedFallback = normalizeText(fallbackText);
  const normalizedBlocks = normalizeText(blocks.map((block) => block.text).join(" "));
  if (normalizedBlocks.length < normalizedFallback.length * 0.45) return [];
  return blocks.filter((block) => block.text.length >= 2);
}

function pdfTextTokens(textContent: PdfTextContentLike): PdfTextToken[] {
  const items = Array.isArray(textContent.items) ? textContent.items : [];
  const tokens: PdfTextToken[] = [];
  for (const rawItem of items) {
    const item = rawItem as PdfTextItemLike;
    if (typeof item.str !== "string" || !item.str.trim()) continue;
    const transform = Array.isArray(item.transform) ? item.transform : [];
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    const fontSize = Math.abs(Number(transform[3]) || Number(item.height) || 0);
    const width = Math.max(1, Number(item.width) || item.str.length * Math.max(fontSize * 0.45, 4));
    const height = Math.max(1, Number(item.height) || fontSize || 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    tokens.push({
      text: item.str,
      x,
      y,
      width,
      height,
      fontSize,
    });
  }
  return tokens;
}

function pdfLinesFromTokens(tokens: PdfTextToken[]): PdfLine[] {
  const sorted = [...tokens].sort((a, b) => Math.abs(b.y - a.y) > 2 ? b.y - a.y : a.x - b.x);
  const groups: PdfTextToken[][] = [];
  for (const token of sorted) {
    const group = groups.find((candidate) => {
      const y = average(candidate.map((item) => item.y));
      const height = Math.max(...candidate.map((item) => item.height), token.height);
      return Math.abs(token.y - y) <= Math.max(2.5, height * 0.45);
    });
    if (group) group.push(token);
    else groups.push([token]);
  }
  return groups
    .map((group) => pdfLineFromTokens(group))
    .filter((line) => line.text)
    .sort((a, b) => Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x);
}

function pdfLineFromTokens(tokens: PdfTextToken[]): PdfLine {
  const ordered = [...tokens].sort((a, b) => a.x - b.x);
  const textParts: string[] = [];
  let previous: PdfTextToken | undefined;
  for (const token of ordered) {
    if (previous) {
      const gap = token.x - (previous.x + previous.width);
      if (gap > Math.max(2.5, previous.fontSize * 0.22)) textParts.push(" ");
    }
    textParts.push(token.text);
    previous = token;
  }
  const x = Math.min(...ordered.map((token) => token.x));
  const right = Math.max(...ordered.map((token) => token.x + token.width));
  const y = Math.min(...ordered.map((token) => token.y));
  const bottom = Math.max(...ordered.map((token) => token.y + token.height));
  return {
    text: repairPdfTextSpacing(textParts.join("")).trim(),
    tokens: ordered,
    x,
    y,
    width: right - x,
    height: bottom - y,
    fontSize: average(ordered.map((token) => token.fontSize).filter((value) => value > 0)),
  };
}

function pdfBlockFromLines(lines: PdfLine[], medianFontSize: number): PdfBlock {
  const text = normalizeText(lines.map((line) => line.text).join("\n"));
  const x = Math.min(...lines.map((line) => line.x));
  const right = Math.max(...lines.map((line) => line.x + line.width));
  const y = Math.min(...lines.map((line) => line.y));
  const bottom = Math.max(...lines.map((line) => line.y + line.height));
  const firstLine = lines[0];
  const type = isLikelyPdfTableBlock(lines)
    ? "table"
    : firstLine && isLikelyPdfHeading(firstLine, medianFontSize)
      ? "heading"
      : "paragraph";
  return {
    lines,
    text,
    x,
    y,
    width: right - x,
    height: bottom - y,
    fontSize: average(lines.map((line) => line.fontSize).filter((value) => value > 0)),
    type,
  };
}

function isLikelyPdfHeading(line: PdfLine, medianFontSize: number): boolean {
  const text = line.text.trim();
  if (!text || text.length > 140) return false;
  if (medianFontSize > 0 && line.fontSize >= medianFontSize * 1.18) return true;
  if (/^(\d+(\.\d+)*\.?\s+|[A-Z][A-Z0-9\s:,-]{5,})/.test(text) && text.length <= 90) return true;
  return /^(abstract|introduction|methods?|results?|discussion|conclusion|references|appendix|摘要|引言|方法|结果|讨论|结论|参考文献)\b/i.test(text);
}

function isLikelyPdfTableBlock(lines: PdfLine[]): boolean {
  if (lines.length < 2) return false;
  const tableishLines = lines.filter((line) => {
    const tokenCount = line.tokens.length;
    const numericTokens = line.tokens.filter((token) => /[-+]?\d/.test(token.text)).length;
    const largeGaps = line.tokens.some((token, index) => {
      const previous = line.tokens[index - 1];
      return previous ? token.x - (previous.x + previous.width) > Math.max(18, previous.fontSize * 1.6) : false;
    });
    return tokenCount >= 2 && (numericTokens >= 1 || largeGaps);
  });
  if (tableishLines.length < 2) return false;
  const leftColumns = new Set(tableishLines.map((line) => Math.round(line.x / 12) * 12));
  return leftColumns.size <= Math.max(3, Math.ceil(tableishLines.length / 2));
}

function pdfBlockTitle(block: PdfBlock, pageNumber: number, index: number): string {
  if (block.type === "heading") return block.lines[0]?.text.slice(0, 80) || `Page ${pageNumber} heading`;
  if (block.type === "table") return `Table region ${index}`;
  if (block.type === "paragraph") return `Paragraph ${index}`;
  return `Page ${pageNumber} region ${index}`;
}

function pdfBlockMarkdown(block: PdfBlock, title: string): string {
  if (block.type === "heading") return `## ${block.text}`;
  if (block.type === "table") return `### ${title}\n\n${block.lines.map((line) => line.text).join("\n")}`;
  return `### ${title}\n\n${block.text}`;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function pdfPageVisualSignals(page: { getOperatorList: () => Promise<{ fnArray?: unknown[] }> }, pdfjs: { OPS?: Record<string, number> }): Promise<{ imageOps: number; paintOps: number }> {
  const ops = pdfjs.OPS || {};
  const imageOps = new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
    ops.paintJpegXObject,
  ].filter((value): value is number => typeof value === "number"));
  const paintOps = new Set([
    ...imageOps,
    ops.paintFormXObjectBegin,
    ops.paintFormXObjectEnd,
  ].filter((value): value is number => typeof value === "number"));
  const operatorList = await page.getOperatorList();
  const fnArray = Array.isArray(operatorList.fnArray) ? operatorList.fnArray : [];
  let imageCount = 0;
  let paintCount = 0;
  for (const fn of fnArray) {
    if (typeof fn !== "number") continue;
    if (imageOps.has(fn)) imageCount += 1;
    if (paintOps.has(fn)) paintCount += 1;
  }
  return { imageOps: imageCount, paintOps: paintCount };
}

function pdfPageOcrReason(textChars: number, imageOps: number): string | undefined {
  if (textChars === 0) return "empty_page";
  if (imageOps > 0 && textChars < 80) return "image_heavy_low_text_page";
  return undefined;
}

function isIgnorablePdfjsWarning(warning: string): boolean {
  return warning.includes("Cannot access the `require` function") ||
    warning.includes("Cannot polyfill `DOMMatrix`") ||
    warning.includes("Cannot polyfill `ImageData`") ||
    warning.includes("Cannot polyfill `Path2D`") ||
    warning.includes("standardFontDataUrl") ||
    warning.includes("Unable to load font data");
}

async function parsePdfFallback(input: ParseInput, byteCount: number, primaryError: string): Promise<ParsedIndexingFile> {
  const warnings: string[] = [`PDF page-by-page extraction failed: ${primaryError}`];
  let parsed: { result: Awaited<ReturnType<PdfParse>>; warnings: string[] };
  try {
    const pdfParse = loadPdfParseFallback();
    parsed = await collectConsoleWarnings(() => pdfParse(readFileSync(input.sourcePath)));
  } catch (error) {
    return emptyParsedFile(input, byteCount, `PDF text extraction failed: ${primaryError}; fallback failed: ${errorMessage(error)}`);
  }
  const { result } = parsed;
  warnings.push(...parsed.warnings);
  const text = repairPdfTextSpacing(result.text || "");
  if (!normalizeText(text)) {
    warnings.push("No extractable PDF text was found. This may be a scanned PDF and may need MinerU document parsing.");
  }
  const capped = capParsedText(text, warnings);
  const normalized = normalizeText(capped.text);
  const totalPages = result.numpages || result.numrender || 0;
  const needsOcr = normalized ? 0 : totalPages || 1;
  return {
    text: normalized,
    byteCount,
    warnings: dedupeWarnings(warnings),
    metadata: {
      parser: "pdf-parse-fallback",
      kind: input.kind,
      pages: totalPages,
      renderedPages: result.numrender || 0,
      coverageStatus: normalized ? "partial" : "skipped",
      truncated: capped.truncated,
      sectionsNeedingOcr: needsOcr,
    },
    coverage: {
      status: normalized ? "partial" : "skipped",
      unit: totalPages ? "page" : "document",
      total: totalPages || 1,
      indexed: normalized ? totalPages || 1 : 0,
      empty: normalized ? 0 : totalPages || 1,
      failed: 0,
      needsOcr,
    },
    sections: normalized
      ? [{ text: `## PDF Text\n\n${normalized}`, sourceLabel: "PDF 文本", sectionType: "document", sectionIndex: 1 }]
      : undefined,
  };
}

function loadPdfParseFallback(): PdfParse {
  return require("pdf-parse/lib/pdf-parse.js") as PdfParse;
}

function repairPdfTextSpacing(value: string): string {
  return value
    .replace(/\b([A-Z][a-z]{2,})(for|and|of|to|in|with|from|by|the)(?=[A-Z])/g, "$1 $2 ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .replace(/([:;,.])(?=\S)/g, "$1 ");
}
