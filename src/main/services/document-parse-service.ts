import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { PDFDocument } from "pdf-lib";
import type { IndexingWorkerResult } from "../indexing";
import { chunkParsedText } from "../indexing/chunking";
import type { ParsedDocumentCoverage, ParsedIndexingFile } from "../indexing/parsers/types";
import { normalizeText } from "../indexing/parsers";
import { dedupeWarnings } from "../indexing/parsers/utils";
import type { BrevynOfficeArtifact, BrevynSemanticUnit } from "../office-model/schema";
import { extractMultimodalText, multimodalEndpoint, multimodalHeaders } from "../providers/multimodal-request";
import type { ModelProviderConfig, WorkspaceFileKind } from "../../types/domain";
import { convertOfficeDocumentToPdf } from "./libreoffice-runtime";
import { ProviderService, envApiKeyForProvider } from "./provider-service";

interface DocumentParseEnhanceInput {
  sourcePath: string;
  kind: WorkspaceFileKind;
  parsed?: ParsedIndexingFile;
  result: IndexingWorkerResult;
  fileName?: string;
}

interface DocumentParseServiceOptions {
  rootDataDir: string;
  providers: ProviderService;
}

const DOC_PARSE_TIMEOUT_MS = 900_000;
const MAX_DOCUMENT_PARSE_FILE_BYTES = 200 * 1024 * 1024;
const DOC_PARSE_MODEL_ID = "brevyn-doc-parse";
const DOCUMENT_PARSE_MODE = "precision";
const DOC_PARSE_OUTPUT_TOKENS = 32768;
const PPTX_SLIDE_OCR_CONCURRENCY = 2;

export interface PptxSlideOcrResult {
  slide: number;
  markdown: string;
}

export class DocumentParseService {
  constructor(private readonly options: DocumentParseServiceOptions) {}

  async enhanceIndexingResult(input: DocumentParseEnhanceInput): Promise<IndexingWorkerResult | null> {
    if (!shouldRunDocumentParse(input)) return null;
    if (!input.sourcePath || !existsSync(input.sourcePath)) return null;
    const provider = this.documentParseProvider();
    if (!provider) return null;
    const apiKey = this.options.providers.apiKey(provider.id) || envApiKeyForProvider(provider);
    if (!apiKey) return null;
    const stats = statSync(input.sourcePath);
    if (stats.size > MAX_DOCUMENT_PARSE_FILE_BYTES) {
      return appendDocumentParseWarning(input.result, `MinerU document parsing skipped because the file is larger than ${formatBytes(MAX_DOCUMENT_PARSE_FILE_BYTES)}.`);
    }

    try {
      if (input.kind === "pptx" && input.parsed) {
        const slideEnhanced = await this.enhancePptxSlides({ ...input, parsed: input.parsed }, provider, apiKey, stats.size);
        // PPTX indexing must keep the local slide structure. Whole-document
        // Markdown cannot be mapped back to reliable slide citations.
        return slideEnhanced || input.result;
      }
      const parsedText = await this.callDocumentParser({
        provider,
        apiKey,
        sourcePath: input.sourcePath,
        kind: input.kind,
        fileName: input.fileName || basename(input.sourcePath),
      });
      const normalized = normalizeText(parsedText);
      if (!normalized) return appendDocumentParseWarning(input.result, "MinerU document parsing completed but returned empty Markdown.");
      return buildDocumentParsedResult(input, normalized, provider, stats.size);
    } catch (error) {
      return appendDocumentParseWarning(input.result, `MinerU document parsing failed: ${errorMessage(error)}`);
    }
  }

  private async enhancePptxSlides(
    input: DocumentParseEnhanceInput & { parsed: ParsedIndexingFile },
    provider: ModelProviderConfig,
    apiKey: string,
    byteCount: number,
  ): Promise<IndexingWorkerResult | null> {
    const slideNumbers = pptxSlidesNeedingOcr(input.parsed);
    if (slideNumbers.length === 0) return null;

    const pdfPath = await this.preparePptxPdf(input.sourcePath, input.fileName || basename(input.sourcePath));
    if (!pdfPath) {
      return appendDocumentParseWarning(input.result, "PPTX slide OCR skipped because a page-preserving PDF could not be generated.");
    }

    const pdf = await PDFDocument.load(readFileSync(pdfPath));
    const availableSlides = slideNumbers.filter((slide) => slide <= pdf.getPageCount());
    const warnings = slideNumbers
      .filter((slide) => slide > pdf.getPageCount())
      .map((slide) => `PPTX slide ${slide} OCR skipped because the converted PDF has only ${pdf.getPageCount()} pages.`);
    const pageInputs = await Promise.all(availableSlides.map(async (slide) => ({
      slide,
      data: await singlePagePdfBytes(pdf, slide),
    })));
    const recognized: PptxSlideOcrResult[] = [];

    for (let offset = 0; offset < pageInputs.length; offset += PPTX_SLIDE_OCR_CONCURRENCY) {
      const batch = pageInputs.slice(offset, offset + PPTX_SLIDE_OCR_CONCURRENCY);
      const batchResults = await Promise.all(batch.map(async ({ slide, data }) => {
        try {
          const markdown = normalizeText(await this.callDocumentParserData({
            provider,
            apiKey,
            data,
            mediaType: "application/pdf",
            kind: "pdf",
            fileName: `${basename(input.sourcePath, extname(input.sourcePath))}-slide-${slide}.pdf`,
            prompt: pptxSlideParsePrompt(input.fileName || basename(input.sourcePath), slide),
          }));
          if (!markdown) {
            warnings.push(`PPTX slide ${slide} OCR returned empty Markdown.`);
            return null;
          }
          return { slide, markdown } satisfies PptxSlideOcrResult;
        } catch (error) {
          warnings.push(`PPTX slide ${slide} OCR failed: ${errorMessage(error)}`);
          return null;
        }
      }));
      recognized.push(...batchResults.filter((item): item is PptxSlideOcrResult => Boolean(item)));
    }

    if (recognized.length === 0) {
      return appendDocumentParseWarning(input.result, warnings[0] || "PPTX slide OCR did not return any indexed content.");
    }
    return buildPptxSlideOcrResult(input, recognized, provider, byteCount, warnings);
  }

  private async preparePptxPdf(sourcePath: string, title: string): Promise<string | null> {
    const stats = statSync(sourcePath);
    const cacheKey = createHash("sha256")
      .update(`${sourcePath}\n${stats.size}\n${stats.mtimeMs}\n${title}`)
      .digest("hex")
      .slice(0, 20);
    const outputDir = join(this.options.rootDataDir, ".preview-cache", "office-pdf", cacheKey);
    mkdirSync(outputDir, { recursive: true });
    const expectedPdf = join(outputDir, `${basename(sourcePath).replace(/\.[^.]+$/u, "")}.pdf`);
    if (existsSync(expectedPdf)) return expectedPdf;
    const converted = await convertOfficeDocumentToPdf({
      rootDataDir: this.options.rootDataDir,
      sourcePath,
      outputDir,
    });
    return converted.ok ? converted.pdfPath : null;
  }

  private documentParseProvider(): ModelProviderConfig | undefined {
    const provider = this.options.providers.ocrProvider();
    if (!provider || provider.protocol !== "openai_responses") return undefined;
    if (provider.selectedModel.trim().toLowerCase() !== DOC_PARSE_MODEL_ID) return undefined;
    return provider;
  }

  private async callDocumentParser(input: {
    provider: ModelProviderConfig;
    apiKey: string;
    sourcePath: string;
    kind: WorkspaceFileKind;
    fileName: string;
  }): Promise<string> {
    const mediaType = documentParseMediaType(input.sourcePath, input.kind);
    if (!mediaType) throw new Error(`MinerU document parsing is not enabled for ${extname(input.sourcePath) || input.kind}.`);
    return this.callDocumentParserData({
      provider: input.provider,
      apiKey: input.apiKey,
      data: readFileSync(input.sourcePath),
      mediaType,
      kind: input.kind,
      fileName: input.fileName,
      prompt: documentParsePrompt(input.kind, input.fileName),
    });
  }

  private async callDocumentParserData(input: {
    provider: ModelProviderConfig;
    apiKey: string;
    data: Uint8Array;
    mediaType: string;
    kind: WorkspaceFileKind;
    fileName: string;
    prompt: string;
  }): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOC_PARSE_TIMEOUT_MS);
    try {
      const response = await fetch(multimodalEndpoint(input.provider), {
        method: "POST",
        headers: multimodalHeaders(input.provider, input.apiKey),
        signal: controller.signal,
        body: JSON.stringify({
          model: input.provider.selectedModel,
          max_output_tokens: DOC_PARSE_OUTPUT_TOKENS,
          input: [
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: input.prompt,
                },
                documentParseInputBlock({
                  kind: input.kind,
                  fileName: input.fileName,
                  mediaType: input.mediaType,
                  data: Buffer.from(input.data).toString("base64"),
                }),
              ],
            },
          ],
          parse_options: {
            mode: DOCUMENT_PARSE_MODE,
            ocr: true,
            formula: true,
            table: true,
            is_ocr: true,
            enable_formula: true,
            enable_table: true,
          },
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`document parse request failed (${response.status}): ${text}`);
      return extractMultimodalText(input.provider, parseJson(text));
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`document parse timed out after ${Math.round(DOC_PARSE_TIMEOUT_MS / 1000)}s.`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function pptxSlidesNeedingOcr(parsed: ParsedIndexingFile): number[] {
  const slides = new Set<number>();
  for (const asset of parsed.assets || []) {
    const slide = Number(asset.slideNumber);
    if (asset.needsOcr && Number.isFinite(slide) && slide > 0) slides.add(Math.floor(slide));
  }
  for (const item of parsed.coverage?.items || []) {
    const slide = Number(item.slideNumber);
    if ((item.needsOcr || item.failed) && Number.isFinite(slide) && slide > 0) slides.add(Math.floor(slide));
  }

  const totalSlides = numberValue(parsed.metadata.slides) || numberValue(parsed.metadata.sectionsTotal);
  const missingSlideCount = Math.max(
    numberValue(parsed.metadata.sectionsEmpty),
    numberValue(parsed.metadata.sectionsFailed),
    parsed.coverage?.empty || 0,
    parsed.coverage?.failed || 0,
  );
  if (totalSlides > 0 && (missingSlideCount > 0 || parsed.coverage?.status === "skipped")) {
    const anchoredSlides = new Set(
      (parsed.sections || [])
        .map((section) => Number(section.slide))
        .filter((slide) => Number.isFinite(slide) && slide > 0)
        .map((slide) => Math.floor(slide)),
    );
    for (let slide = 1; slide <= totalSlides; slide += 1) {
      if (!anchoredSlides.has(slide)) slides.add(slide);
    }
  }
  return [...slides].sort((left, right) => left - right);
}

export function buildPptxSlideOcrResult(
  input: DocumentParseEnhanceInput & { parsed: ParsedIndexingFile },
  ocrResults: PptxSlideOcrResult[],
  provider: Pick<ModelProviderConfig, "name" | "selectedModel">,
  byteCount: number,
  warnings: string[] = [],
): IndexingWorkerResult {
  const artifact = asPptxOfficeArtifact(input.result.officeArtifact || input.parsed.officeArtifact);
  const artifactId = artifact?.id || String(input.parsed.metadata.artifactId || "");
  const bySlide = new Map<number, PptxSlideOcrResult>();
  for (const result of ocrResults) {
    const slide = Math.floor(Number(result.slide));
    const markdown = normalizeText(result.markdown);
    if (slide > 0 && markdown) bySlide.set(slide, { slide, markdown });
  }
  const recognized = [...bySlide.values()].sort((left, right) => left.slide - right.slide);
  const ocrSections = recognized.map((result) => ({
    text: normalizeText(`## Slide ${result.slide}\n\n${stripSlideHeading(result.markdown, result.slide)}`),
    sourceLabel: `幻灯片 ${result.slide} OCR`,
    title: `Slide ${result.slide} OCR`,
    sectionType: "slide_ocr",
    sectionIndex: result.slide,
    artifactId: artifactId || undefined,
    semanticUnitId: pptxOcrUnitId(artifactId, input.result.fileId, result.slide),
    slide: result.slide,
  }));
  const sections = [...(input.parsed.sections || []), ...ocrSections]
    .sort((left, right) => (left.slide ?? Number.MAX_SAFE_INTEGER) - (right.slide ?? Number.MAX_SAFE_INTEGER));
  const text = normalizeText(sections.map((section) => section.text).join("\n\n"));
  const expectedSlides = pptxSlidesNeedingOcr(input.parsed);
  const remainingSlides = expectedSlides.filter((slide) => !bySlide.has(slide));
  const totalSlides = numberValue(input.parsed.metadata.slides)
    || numberValue(input.parsed.metadata.sectionsTotal)
    || new Set(sections.map((section) => section.slide).filter((slide): slide is number => Boolean(slide))).size
    || 1;
  const indexedSlides = new Set(sections.map((section) => section.slide).filter((slide): slide is number => Boolean(slide))).size;
  const coverageStatus = remainingSlides.length > 0 ? "partial" : "complete";
  const mergedWarnings = dedupeWarnings([
    ...input.result.warnings.filter((warning) => !isResolvedPptxOcrWarning(warning)),
    ...warnings,
  ]);
  const metadata: Record<string, string | number | boolean> = {
    ...input.parsed.metadata,
    parser: "pptx-jszip+mineru-slide-ocr",
    localParser: String(input.parsed.metadata.parser || input.result.metadata?.parser || "pptx-jszip"),
    coverageStatus,
    sectionsIndexed: indexedSlides,
    sectionsEmpty: Math.max(0, totalSlides - indexedSlides),
    sectionsFailed: remainingSlides.length,
    slidesNeedingOcr: remainingSlides.length,
    assetsNeedingOcr: remainingSlides.length,
    imageOnlySlides: remainingSlides.length,
    documentParseApplied: true,
    documentParseProvider: provider.name,
    documentParseModel: provider.selectedModel,
    documentParseMode: `${DOCUMENT_PARSE_MODE}-slide-ocr`,
    documentParseReplacedLocalPartial: false,
    slidesOcrApplied: recognized.length,
    slidesOcrFailed: remainingSlides.length,
    ocrApplied: recognized.length > 0,
    truncated: false,
  };
  const officeArtifact = augmentPptxArtifactWithOcr(artifact, recognized, input.result.fileId, coverageStatus, mergedWarnings);
  const parsed: ParsedIndexingFile = {
    ...input.parsed,
    text,
    byteCount,
    warnings: mergedWarnings,
    metadata,
    sections,
    coverage: {
      ...(input.parsed.coverage || {}),
      status: coverageStatus,
      unit: "slide",
      total: totalSlides,
      indexed: indexedSlides,
      empty: Math.max(0, totalSlides - indexedSlides),
      failed: remainingSlides.length,
      needsOcr: remainingSlides.length,
    },
    officeArtifact,
  };
  const chunked = chunkParsedText(parsed);
  return {
    ...input.result,
    chunkCount: chunked.chunks.length,
    charCount: text.length,
    byteCount,
    sample: chunked.chunks[0]?.slice(0, 900) || text.slice(0, 900),
    warnings: mergedWarnings,
    chunks: chunked.chunks,
    chunkMetadata: chunked.metadata,
    metadata,
    derivedMarkdown: text,
    parsed,
    officeArtifact,
  };
}

async function singlePagePdfBytes(source: PDFDocument, slide: number): Promise<Uint8Array> {
  const output = await PDFDocument.create();
  const [page] = await output.copyPages(source, [slide - 1]);
  output.addPage(page);
  return output.save();
}

function pptxSlideParsePrompt(fileName: string, slide: number): string {
  return [
    `Parse slide ${slide} from this course PowerPoint: ${fileName}.`,
    `Begin with exactly: ## Slide ${slide}`,
    "Return clean Markdown containing every visible heading, paragraph, bullet, table cell, formula, label, and caption on this slide.",
    "Preserve table structure and reading order. Do not invent unreadable content.",
    "Return Markdown only; do not add commentary about the parsing process.",
  ].join("\n");
}

function stripSlideHeading(markdown: string, slide: number): string {
  return markdown
    .replace(new RegExp(`^#{1,6}\\s*Slide\\s+${slide}\\s*\\n+`, "i"), "")
    .trim();
}

function pptxOcrUnitId(artifactId: string, fileId: string, slide: number): string {
  return `${artifactId || fileId}:slide-${slide}:unit-ocr`;
}

function augmentPptxArtifactWithOcr(
  artifact: BrevynOfficeArtifact | undefined,
  results: PptxSlideOcrResult[],
  fileId: string,
  coverageStatus: "complete" | "partial",
  warnings: string[],
): BrevynOfficeArtifact | undefined {
  if (!artifact) return undefined;
  const existingIds = new Set(artifact.semanticUnits.map((unit) => unit.id));
  const ocrUnits = results.flatMap((result): BrevynSemanticUnit[] => {
    const id = pptxOcrUnitId(artifact.id, fileId, result.slide);
    if (existingIds.has(id)) return [];
    const text = normalizeText(stripSlideHeading(result.markdown, result.slide));
    if (!text) return [];
    return [{
      id,
      artifactId: artifact.id,
      elementIds: [],
      unitType: "slide_region",
      title: `Slide ${result.slide} OCR`,
      text,
      markdown: `## Slide ${result.slide}\n\n${text}`,
      sourceLabel: `幻灯片 ${result.slide} OCR`,
      citation: `Slide ${result.slide}`,
      location: { slide: result.slide },
      importance: 0.82,
    }];
  });
  return {
    ...artifact,
    metadata: {
      ...artifact.metadata,
      parser: "brevyn-pptx-object-model+mineru-slide-ocr",
      coverageStatus,
      warnings,
      slideOcrCount: ocrUnits.length,
    },
    semanticUnits: [...artifact.semanticUnits, ...ocrUnits],
  };
}

function asPptxOfficeArtifact(value: unknown): BrevynOfficeArtifact | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<BrevynOfficeArtifact>;
  if (candidate.kind !== "pptx" || typeof candidate.id !== "string" || !Array.isArray(candidate.semanticUnits)) return undefined;
  return value as BrevynOfficeArtifact;
}

function isResolvedPptxOcrWarning(warning: string): boolean {
  const normalized = warning.toLowerCase();
  return normalized.includes("pptx slides contain images without extractable slide text")
    || normalized.includes("pptx slides had no extractable text")
    || normalized.includes("pptx slides contain visual content that local text extraction may not capture");
}

function shouldRunDocumentParse(input: DocumentParseEnhanceInput): boolean {
  if (!documentParseMediaType(input.sourcePath, input.kind)) return false;
  if (input.kind === "image") return true;
  if ((input.result.chunkCount ?? 0) === 0) return true;

  const metadata = input.parsed?.metadata || input.result.metadata || {};
  const coverageStatus = typeof metadata.coverageStatus === "string" ? metadata.coverageStatus : "";
  if (coverageStatus === "partial" || coverageStatus === "skipped") return true;
  if (input.parsed?.coverage?.status === "partial" || input.parsed?.coverage?.status === "skipped") return true;
  if ((input.parsed?.coverage?.needsOcr || 0) > 0) return true;
  if (input.parsed?.coverage?.items?.some((item) => item.needsOcr)) return true;
  if (numberValue(metadata.sectionsNeedingOcr) > 0) return true;
  if (numberValue(metadata.assetsNeedingOcr) > 0) return true;
  if (numberValue(metadata.imageOnlySlides) > 0) return true;
  if (numberValue(metadata.slidesNeedingOcr) > 0) return true;
  return false;
}

function buildDocumentParsedResult(input: DocumentParseEnhanceInput, markdown: string, provider: ModelProviderConfig, byteCount: number): IndexingWorkerResult {
  const coverageTotal = input.parsed?.coverage?.total || numberValue(input.parsed?.metadata.sectionsTotal) || numberValue(input.result.metadata?.sectionsTotal) || 1;
  const parsed: ParsedIndexingFile = {
    text: markdown,
    byteCount,
    warnings: [],
    metadata: {
      ...(input.parsed?.metadata || {}),
      parser: "mineru",
      localParser: String(input.parsed?.metadata?.parser || input.result.metadata?.parser || ""),
      kind: input.kind,
      coverageStatus: "complete",
      sectionsTotal: coverageTotal,
      sectionsIndexed: coverageTotal,
      sectionsEmpty: 0,
      sectionsFailed: 0,
      sectionsNeedingOcr: 0,
      assetsNeedingOcr: 0,
      imageOnlySlides: 0,
      truncated: false,
      documentParseApplied: true,
      documentParseProvider: provider.name,
      documentParseModel: provider.selectedModel,
      documentParseMode: DOCUMENT_PARSE_MODE,
      documentParseReplacedLocalPartial: true,
    },
    sections: [
      {
        text: markdown,
        sourceLabel: "MinerU Markdown",
        title: input.fileName || basename(input.sourcePath),
        sectionType: "document_parse",
        sectionIndex: 1,
      },
    ],
    coverage: completeCoverage(input, coverageTotal),
  };
  const chunked = chunkParsedText(parsed);
  return {
    fileId: input.result.fileId,
    sourcePath: input.result.sourcePath || input.sourcePath,
    chunkCount: chunked.chunks.length,
    charCount: markdown.length,
    byteCount,
    sample: chunked.chunks[0]?.slice(0, 900) || markdown.slice(0, 900),
    warnings: [],
    chunks: chunked.chunks,
    chunkMetadata: chunked.metadata,
    metadata: parsed.metadata,
    derivedMarkdown: markdown,
  };
}

function completeCoverage(input: DocumentParseEnhanceInput, total: number): ParsedDocumentCoverage {
  const coverage = input.parsed?.coverage;
  if (!coverage) {
    return {
      status: "complete",
      unit: coverageUnitForKind(input.kind),
      total,
      indexed: total,
      empty: 0,
      failed: 0,
      needsOcr: 0,
    };
  }
  return {
    ...coverage,
    status: "complete",
    indexed: coverage.total || total,
    empty: 0,
    failed: 0,
    needsOcr: 0,
    items: coverage.items?.map((item) => ({
      ...item,
      hasText: true,
      failed: false,
      needsOcr: false,
      ocrApplied: item.needsOcr || item.ocrApplied,
    })),
  };
}

function appendDocumentParseWarning(result: IndexingWorkerResult | null, warning: string): IndexingWorkerResult | null {
  if (!result) return null;
  return {
    ...result,
    warnings: dedupeWarnings([...result.warnings, warning]),
  };
}

function documentParsePrompt(kind: WorkspaceFileKind, fileName: string): string {
  const label = documentKindLabel(kind);
  return [
    `Parse this course ${label}: ${fileName}.`,
    "Return clean Markdown for retrieval indexing.",
    "Preserve document order, headings, page/slide/sheet cues, tables, formulas, equations, bullet hierarchy, figure captions, and visible OCR text.",
    "Use OCR for scanned or image-only regions, but do not invent unreadable content.",
    "Return Markdown only; do not add commentary about the parsing process.",
  ].join("\n");
}

function documentParseInputBlock(input: {
  kind: WorkspaceFileKind;
  fileName: string;
  mediaType: string;
  data: string;
}): unknown {
  const url = `data:${input.mediaType};base64,${input.data}`;
  if (input.kind === "image") return { type: "input_image", image_url: url };
  return { type: "input_file", filename: input.fileName, file_data: url };
}

function documentParseMediaType(sourcePath: string, kind: WorkspaceFileKind): string | undefined {
  const extension = extname(sourcePath).toLowerCase();
  if (kind === "pdf" || extension === ".pdf") return "application/pdf";
  if (kind === "docx" || extension === ".docx" || extension === ".doc") {
    return extension === ".doc"
      ? "application/msword"
      : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (kind === "pptx" || extension === ".pptx" || extension === ".ppt") {
    return extension === ".ppt"
      ? "application/vnd.ms-powerpoint"
      : "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  if (kind === "spreadsheet" || extension === ".xlsx" || extension === ".xls") {
    if (extension === ".csv" || extension === ".tsv") return undefined;
    return extension === ".xls"
      ? "application/vnd.ms-excel"
      : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (kind === "image") {
    if (extension === ".png") return "image/png";
    if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
    if (extension === ".jp2") return "image/jp2";
    if (extension === ".webp") return "image/webp";
    if (extension === ".gif") return "image/gif";
    if (extension === ".bmp") return "image/bmp";
  }
  return undefined;
}

function documentKindLabel(kind: WorkspaceFileKind): string {
  if (kind === "pdf") return "PDF";
  if (kind === "image") return "image";
  if (kind === "docx") return "Word document";
  if (kind === "pptx") return "PowerPoint";
  if (kind === "spreadsheet") return "spreadsheet";
  return "document";
}

function coverageUnitForKind(kind: WorkspaceFileKind): ParsedDocumentCoverage["unit"] {
  if (kind === "pdf") return "page";
  if (kind === "pptx") return "slide";
  if (kind === "spreadsheet") return "section";
  if (kind === "image") return "image";
  return "document";
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`document parser returned invalid JSON: ${value.slice(0, 300)}`);
  }
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
