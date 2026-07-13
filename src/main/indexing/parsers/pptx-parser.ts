import { readFileSync } from "node:fs";
import { extname } from "node:path";
import JSZip from "jszip";
import type { CoverageStatus, ParsedDocumentAsset, ParsedDocumentCoverageItem, ParsedIndexingFile, ParsedIndexingSection, ParseInput } from "./types";
import { embeddedMediaFiles, mediaAssetFromPath } from "./ooxml-assets";
import { importPptxArtifact } from "../../office-importers/pptx-importer";
import { orderedPptxSlideParts, pptxSlideRelationshipsPath, readPptxRelationships } from "../../office-importers/pptx-package";
import type { BrevynOfficeArtifact } from "../../office-model/schema";
import { officeArtifactMarkdown } from "../../office-model/semantic-units";
import { capParsedText, decodeXml, dedupeWarnings, emptyParsedFile, errorMessage, normalizeText, numberFromPath, sortedZipFiles } from "./utils";

const SPARSE_VISUAL_SLIDE_TEXT_CHARS = 240;
const LARGE_VISUAL_COVERAGE_RATIO = 0.35;

interface PptxSlideSize {
  width: number;
  height: number;
}

export async function parsePptx(input: ParseInput, byteCount: number): Promise<ParsedIndexingFile> {
  if (extname(input.sourcePath).toLowerCase() === ".ppt") {
    return emptyParsedFile(input, byteCount, "Legacy .ppt files need conversion to .pptx before local text extraction.");
  }

  const artifact = await importPptxArtifact({
    sourcePath: input.sourcePath,
    byteCount,
  });
  const zip = await JSZip.loadAsync(readFileSync(input.sourcePath));
  const slideParts = await orderedPptxSlideParts(zip);
  const slideSize = await readPptxSlideSize(zip);
  const noteFiles = sortedZipFiles(zip, /^ppt\/notesSlides\/notesSlide\d+\.xml$/);
  const mediaFiles = embeddedMediaFiles(zip, "ppt");
  const notesByNumber = new Map<number, JSZip.JSZipObject>();
  for (const file of noteFiles) {
    notesByNumber.set(numberFromPath(file.name), file);
  }
  const parts: string[] = [];
  const sections: ParsedIndexingSection[] = [];
  const assets: ParsedDocumentAsset[] = [];
  const coverageItems: ParsedDocumentCoverageItem[] = [];
  const referencedMedia = new Set<string>();
  const warnings: string[] = [];
  let indexedSlides = 0;
  let emptySlides = 0;
  let failedSlides = 0;
  let indexedNotes = 0;
  let failedNotes = 0;
  let imageOnlySlides = 0;
  let sparseVisualSlides = 0;
  let slidesNeedingOcr = 0;

  for (const { file, slideNumber, partNumber } of slideParts) {
    try {
      const slideXml = await file.async("string");
      const slideText = extractPptxXmlText(slideXml);
      const relationships = await readPptxRelationships(zip, pptxSlideRelationshipsPath(file.name), "ppt/slides");
      const slideMediaTargets = [...new Set(relationships
        .filter((relationship) => relationship.type?.includes("/image") && relationship.targetMode !== "External" && Boolean(zip.file(relationship.target)))
        .map((relationship) => relationship.target))];
      const noteTarget = relationships.find((relationship) => relationship.type?.includes("/notesSlide"))?.target;
      const noteFile = (noteTarget ? zip.file(noteTarget) : null) || notesByNumber.get(partNumber);
      let noteText = "";
      if (noteFile) {
        try {
          noteText = extractPptxXmlText(await noteFile.async("string"));
          if (noteText) indexedNotes += 1;
        } catch (error) {
          failedNotes += 1;
          warnings.push(`Slide ${slideNumber} speaker notes extraction failed: ${errorMessage(error)}`);
        }
      }
      const imageCoverageRatio = pptxSlideImageCoverageRatio(slideXml, slideSize);
      const slideNeedsOcr = shouldOcrPptxSlide({
        text: slideText,
        mediaCount: slideMediaTargets.length,
        imageCoverageRatio,
      });
      const ocrReason = slideNeedsOcr
        ? slideText
          ? "pptx_sparse_text_visual_slide"
          : "pptx_image_only_slide"
        : undefined;
      if (slideNeedsOcr) slidesNeedingOcr += 1;
      if (slideNeedsOcr && slideText) sparseVisualSlides += 1;
      if (slideNeedsOcr && !slideText) imageOnlySlides += 1;
      for (const target of slideMediaTargets) {
        referencedMedia.add(target);
        assets.push(mediaAssetFromPath({
          path: target,
          sourceLabel: `幻灯片 ${slideNumber} 内嵌图片`,
          slideNumber,
          needsOcr: slideNeedsOcr,
          reason: ocrReason,
        }));
      }
      const text = normalizeText([slideText, noteText ? `### Speaker Notes\n\n${noteText}` : ""].filter(Boolean).join("\n\n"));
      coverageItems.push({
        index: slideNumber,
        sourceLabel: `幻灯片 ${slideNumber}`,
        textChars: slideText.length,
        hasText: Boolean(text),
        failed: false,
        needsOcr: slideNeedsOcr,
        reason: ocrReason,
        slideNumber,
        visualSignals: slideMediaTargets.length > 0
          ? { imageOps: slideMediaTargets.length, paintOps: Math.round(imageCoverageRatio * 1000) }
          : undefined,
      });
      if (text) {
        indexedSlides += 1;
        const sectionText = `## Slide ${slideNumber}\n\n${text}`;
        parts.push(sectionText);
        sections.push({
          text: sectionText,
          sourceLabel: `幻灯片 ${slideNumber}`,
          title: slideText.split("\n").map((line) => line.trim()).find(Boolean),
          sectionType: "slide",
          sectionIndex: slideNumber,
          slide: slideNumber,
        });
      } else {
        emptySlides += 1;
      }
    } catch (error) {
      failedSlides += 1;
      coverageItems.push({
        index: slideNumber,
        sourceLabel: `幻灯片 ${slideNumber}`,
        textChars: 0,
        hasText: false,
        failed: true,
        needsOcr: true,
        reason: "pptx_slide_text_extraction_failed",
        slideNumber,
      });
      warnings.push(`Slide ${slideNumber} text extraction failed: ${errorMessage(error)}`);
    }
  }
  for (const path of mediaFiles) {
    if (referencedMedia.has(path)) continue;
    assets.push(mediaAssetFromPath({
      path,
      sourceLabel: "PPTX 未关联内嵌图片",
      needsOcr: false,
    }));
  }

  const artifactSections = sectionsFromPptxArtifact(artifact);
  const text = normalizeText(officeArtifactMarkdown(artifact) || parts.join("\n\n"));
  if (!text) {
    warnings.push("No extractable PPTX text was found. The slides may contain only images or unsupported embedded objects.");
  }
  if (slidesNeedingOcr > 0) warnings.push(`${slidesNeedingOcr} PPTX slides contain visual content that local text extraction may not capture and need OCR/document parsing for full indexing.`);
  if (failedSlides > 0) warnings.push(`${failedSlides} PPTX slides could not be parsed.`);
  if (failedNotes > 0) warnings.push(`${failedNotes} speaker-note sections could not be parsed.`);
  if (emptySlides > 0 && indexedSlides > 0) warnings.push(`${emptySlides} PPTX slides had no extractable text.`);
  warnings.push(...(artifact.metadata.warnings || []));
  const capped = capParsedText(text, warnings);
  const normalized = normalizeText(capped.text);
  const parsedSections = artifactSections.length > 0 ? artifactSections : sections;
  const coverageStatus: CoverageStatus = !normalized
    ? "skipped"
    : failedSlides > 0 || failedNotes > 0 || emptySlides > 0 || slidesNeedingOcr > 0 || capped.truncated
      ? "partial"
      : "complete";
  return {
    text: normalized,
    byteCount,
    warnings: dedupeWarnings(warnings),
    metadata: {
      parser: "pptx-jszip",
      officeParser: String(artifact.metadata.parser || ""),
      artifactId: artifact.id,
      artifactSchemaVersion: artifact.schemaVersion,
      kind: input.kind,
      slides: slideParts.length,
      notes: noteFiles.length,
      notesIndexed: indexedNotes,
      embeddedImages: mediaFiles.length,
      imageOnlySlides,
      sparseVisualSlides,
      slidesNeedingOcr: coverageItems.filter((item) => item.needsOcr).length,
      assetsNeedingOcr: assets.filter((asset) => asset.needsOcr).length,
      sectionsTotal: slideParts.length,
      sectionsIndexed: indexedSlides,
      sectionsEmpty: emptySlides,
      sectionsFailed: failedSlides,
      sectionUnit: "张幻灯片",
      coverageStatus,
      truncated: capped.truncated,
    },
    assets: assets.length > 0 ? assets : undefined,
    coverage: {
      status: coverageStatus,
      unit: "slide",
      total: slideParts.length,
      indexed: indexedSlides,
      empty: emptySlides,
      failed: failedSlides,
      needsOcr: coverageItems.filter((item) => item.needsOcr).length,
      items: coverageItems,
    },
    sections: parsedSections.length > 0 ? parsedSections : undefined,
    officeArtifact: artifact,
  };
}

export function shouldOcrPptxSlide(input: {
  text: string;
  mediaCount: number;
  imageCoverageRatio: number;
}): boolean {
  if (input.mediaCount <= 0) return false;
  const textChars = normalizeText(input.text).length;
  if (textChars === 0) return true;
  if (input.mediaCount >= 2 && textChars <= 200) return true;
  return textChars <= SPARSE_VISUAL_SLIDE_TEXT_CHARS
    && input.imageCoverageRatio >= LARGE_VISUAL_COVERAGE_RATIO;
}

function pptxSlideImageCoverageRatio(xml: string, slideSize?: PptxSlideSize): number {
  if (!slideSize || slideSize.width <= 0 || slideSize.height <= 0) return 0;
  const slideArea = slideSize.width * slideSize.height;
  let imageArea = 0;
  for (const match of xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)) {
    let largestPictureArea = 0;
    for (const ext of match[0].matchAll(/<a:ext\b([^>]*)\/?\s*>/g)) {
      const width = numberAttribute(ext[1] || "", "cx");
      const height = numberAttribute(ext[1] || "", "cy");
      if (width > 0 && height > 0) largestPictureArea = Math.max(largestPictureArea, width * height);
    }
    imageArea += largestPictureArea;
  }
  return Math.min(1, imageArea / slideArea);
}

async function readPptxSlideSize(zip: JSZip): Promise<PptxSlideSize | undefined> {
  const xml = await zip.file("ppt/presentation.xml")?.async("string").catch(() => undefined);
  const match = xml?.match(/<p:sldSz\b([^>]*)\/?\s*>/);
  if (!match) return undefined;
  const width = numberAttribute(match[1] || "", "cx");
  const height = numberAttribute(match[1] || "", "cy");
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function numberAttribute(attributes: string, name: string): number {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}="(\\d+)"`));
  return match ? Number(match[1]) : 0;
}

function sectionsFromPptxArtifact(artifact: BrevynOfficeArtifact): ParsedIndexingSection[] {
  return artifact.semanticUnits.map((unit, index) => ({
    text: unit.markdown || unit.text,
    sourceLabel: unit.sourceLabel,
    title: unit.title,
    sectionType: unit.unitType,
    sectionIndex: index + 1,
    artifactId: artifact.id,
    semanticUnitId: unit.id,
    elementIds: unit.elementIds,
    slide: unit.location.slide,
    bbox: unit.bbox ? JSON.stringify(unit.bbox) : undefined,
  }));
}

function extractPptxXmlText(xml: string): string {
  const fragments: string[] = [];
  const tagPattern = /<(?:a|m):t\b[^>]*>([\s\S]*?)<\/(?:a|m):t>/g;
  for (const match of xml.matchAll(tagPattern)) {
    const value = decodeXml(match[1] || "").trim();
    if (value) fragments.push(value);
  }
  return normalizeText(fragments.join("\n"));
}
