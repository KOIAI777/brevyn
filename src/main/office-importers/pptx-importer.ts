import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import type {
  BrevynOfficeArtifact,
  BrevynOfficeAsset,
  BrevynOfficeElement,
  BrevynSemanticUnit,
} from "../office-model/schema";
import { orderedPptxSlideParts, pptxSlideRelationshipsPath, readPptxRelationships } from "./pptx-package";

export const PPTX_OBJECT_MODEL_SCHEMA_VERSION = 1;
export const PPTX_OBJECT_MODEL_PARSER = "brevyn-pptx-object-model";

export interface ImportPptxOptions {
  sourcePath: string;
  byteCount: number;
}

interface ParsedPptxSlide {
  slideNumber: number;
  part: string;
  title?: string;
  text: string;
  notes: string;
  tableCount: number;
  chartRefs: string[];
  mediaRefs: string[];
  hidden: boolean;
}

export async function importPptxArtifact(options: ImportPptxOptions): Promise<BrevynOfficeArtifact> {
  const bytes = readFileSync(options.sourcePath);
  const zip = await JSZip.loadAsync(bytes);
  const artifactId = `artifact-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  const slideParts = await orderedPptxSlideParts(zip);
  const noteFiles = sortedFiles(zip, /^ppt\/notesSlides\/notesSlide\d+\.xml$/);
  const notesByNumber = new Map<number, JSZip.JSZipObject>();
  for (const file of noteFiles) notesByNumber.set(numberFromPath(file.name), file);
  const notesByPart = new Map<string, JSZip.JSZipObject>();
  for (const file of noteFiles) notesByPart.set(file.name, file);

  const slides: ParsedPptxSlide[] = [];
  const elements: BrevynOfficeElement[] = [];
  const assets: BrevynOfficeAsset[] = [];
  const semanticUnits: BrevynSemanticUnit[] = [];
  const warnings: string[] = [];
  let hiddenSlides = 0;
  let tableCount = 0;
  let chartCount = 0;
  let imageCount = 0;
  let notesCount = 0;
  let imageOnlySlides = 0;

  for (const { file, slideNumber, partNumber } of slideParts) {
    const slideXml = await file.async("string");
    const relationships = await readPptxRelationships(zip, pptxSlideRelationshipsPath(file.name), "ppt/slides");
    const notesTarget = relationships.find((relationship) => relationship.type?.includes("/notesSlide"))?.target;
    const noteFile = (notesTarget ? notesByPart.get(notesTarget) : undefined) || notesByNumber.get(partNumber);
    const noteXml = await noteFile?.async("string").catch(() => undefined);
    const slideText = extractPptxXmlText(slideXml);
    const notes = noteXml ? extractPptxXmlText(noteXml) : "";
    const chartRefs = relationships.filter((relationship) => relationship.type?.includes("/chart")).map((relationship) => relationship.target);
    const mediaRefs = relationships.filter((relationship) => relationship.type?.includes("/image")).map((relationship) => relationship.target);
    const tableRefs = countMatches(slideXml, /<a:tbl\b/g);
    const hidden = /\bshow="0"/.test(slideXml);
    const title = slideText.split("\n").map((line) => line.trim()).find(Boolean);
    if (hidden) hiddenSlides += 1;
    if (notes) notesCount += 1;
    if (!slideText && mediaRefs.length > 0) imageOnlySlides += 1;
    tableCount += tableRefs;
    chartCount += chartRefs.length;
    imageCount += mediaRefs.length;

    const slide: ParsedPptxSlide = {
      slideNumber,
      part: file.name,
      title,
      text: slideText,
      notes,
      tableCount: tableRefs,
      chartRefs,
      mediaRefs,
      hidden,
    };
    slides.push(slide);
    elements.push(...slideElements(artifactId, slide));
    assets.push(...slideAssets(artifactId, slide));
    semanticUnits.push(...slideSemanticUnits(artifactId, slide));
  }

  const unreferencedMedia = sortedNames(zip, /^ppt\/media\//)
    .filter((name) => !assets.some((asset) => asset.path === name));
  for (const [index, path] of unreferencedMedia.entries()) {
    assets.push({
      id: `${artifactId}:asset-unreferenced-${index + 1}`,
      kind: "embedded_media",
      sourceLabel: "PPTX unreferenced embedded media",
      path,
      mediaType: mediaTypeFromPath(path),
    });
  }
  if (imageOnlySlides > 0) warnings.push(`${imageOnlySlides} slide(s) contain images without extractable text and need OCR/document parsing for full indexing.`);
  if (semanticUnits.length === 0) warnings.push("No extractable PPTX text was found. The slides may contain only images or unsupported embedded objects.");

  return {
    id: artifactId,
    schemaVersion: PPTX_OBJECT_MODEL_SCHEMA_VERSION,
    kind: "pptx",
    title: basename(options.sourcePath),
    source: {
      path: options.sourcePath,
      name: basename(options.sourcePath),
      byteCount: options.byteCount,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    metadata: {
      parser: PPTX_OBJECT_MODEL_PARSER,
      parserVersion: PPTX_OBJECT_MODEL_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      coverageStatus: semanticUnits.length === 0 ? "skipped" : imageOnlySlides > 0 ? "partial" : "complete",
      warnings,
      slides: slideParts.length,
      notes: noteFiles.length,
      notesIndexed: notesCount,
      hiddenSlides,
      tables: tableCount,
      charts: chartCount,
      images: imageCount + unreferencedMedia.length,
      imageOnlySlides,
    },
    presentation: {
      slideCount: slideParts.length,
    },
    elements,
    assets,
    semanticUnits,
  };
}

function slideElements(artifactId: string, slide: ParsedPptxSlide): BrevynOfficeElement[] {
  const elements: BrevynOfficeElement[] = [];
  if (slide.text) {
    elements.push({
      id: `${artifactId}:slide-${slide.slideNumber}:text`,
      type: "page",
      text: slide.text,
      markdown: slideMarkdown(slide),
      location: { slide: slide.slideNumber, objectPath: slide.part },
      style: slide.hidden ? { hidden: true } : undefined,
    });
  }
  if (slide.notes) {
    elements.push({
      id: `${artifactId}:slide-${slide.slideNumber}:notes`,
      type: "speaker_note",
      text: slide.notes,
      markdown: `### Speaker Notes\n\n${slide.notes}`,
      location: { slide: slide.slideNumber, objectPath: `Speaker notes ${slide.slideNumber}` },
    });
  }
  slide.chartRefs.forEach((target, index) => {
    elements.push({
      id: `${artifactId}:slide-${slide.slideNumber}:chart-${index + 1}`,
      type: "chart",
      text: `Chart ${index + 1}`,
      markdown: [`Chart ${index + 1}`, `Source part: ${target}`].join("\n"),
      location: { slide: slide.slideNumber, objectPath: target },
    });
  });
  slide.mediaRefs.forEach((target, index) => {
    elements.push({
      id: `${artifactId}:slide-${slide.slideNumber}:image-${index + 1}`,
      type: "image",
      text: "",
      markdown: `Image ${index + 1}: ${target}`,
      location: { slide: slide.slideNumber, objectPath: target },
      assetRefs: [`${artifactId}:slide-${slide.slideNumber}:asset-image-${index + 1}`],
    });
  });
  return elements;
}

function slideAssets(artifactId: string, slide: ParsedPptxSlide): BrevynOfficeAsset[] {
  return slide.mediaRefs.map((target, index): BrevynOfficeAsset => ({
    id: `${artifactId}:slide-${slide.slideNumber}:asset-image-${index + 1}`,
    kind: "image",
    sourceLabel: `Slide ${slide.slideNumber} image ${index + 1}`,
    path: target,
    mediaType: mediaTypeFromPath(target),
    elementIds: [`${artifactId}:slide-${slide.slideNumber}:image-${index + 1}`],
  }));
}

function slideSemanticUnits(artifactId: string, slide: ParsedPptxSlide): BrevynSemanticUnit[] {
  const units: BrevynSemanticUnit[] = [];
  if (slide.text) {
    const elementId = `${artifactId}:slide-${slide.slideNumber}:text`;
    units.push({
      id: `${artifactId}:slide-${slide.slideNumber}:unit-slide`,
      artifactId,
      elementIds: [elementId],
      unitType: "slide",
      title: slide.title || `Slide ${slide.slideNumber}`,
      text: slideMarkdown(slide),
      markdown: slideMarkdown(slide),
      sourceLabel: `幻灯片 ${slide.slideNumber}`,
      citation: `Slide ${slide.slideNumber}`,
      location: { slide: slide.slideNumber },
      importance: 0.75,
    });
  }
  if (slide.notes) {
    const elementId = `${artifactId}:slide-${slide.slideNumber}:notes`;
    units.push({
      id: `${artifactId}:slide-${slide.slideNumber}:unit-notes`,
      artifactId,
      elementIds: [elementId],
      unitType: "speaker_notes",
      title: `Slide ${slide.slideNumber} speaker notes`,
      text: `### Speaker Notes\n\n${slide.notes}`,
      markdown: `### Speaker Notes\n\n${slide.notes}`,
      sourceLabel: `幻灯片 ${slide.slideNumber} 讲者备注`,
      citation: `Slide ${slide.slideNumber} speaker notes`,
      location: { slide: slide.slideNumber, objectPath: "speaker_notes" },
      importance: 0.62,
    });
  }
  slide.chartRefs.forEach((target, index) => {
    const elementId = `${artifactId}:slide-${slide.slideNumber}:chart-${index + 1}`;
    units.push({
      id: `${artifactId}:slide-${slide.slideNumber}:unit-chart-${index + 1}`,
      artifactId,
      elementIds: [elementId],
      unitType: "chart",
      title: `Slide ${slide.slideNumber} chart ${index + 1}`,
      text: `Chart ${index + 1}\nSource part: ${target}`,
      markdown: `### Chart ${index + 1}\n\nSource part: ${target}`,
      sourceLabel: `幻灯片 ${slide.slideNumber} 图表 ${index + 1}`,
      citation: `Slide ${slide.slideNumber} chart ${index + 1}`,
      location: { slide: slide.slideNumber, objectPath: target },
      importance: 0.68,
    });
  });
  return units;
}

function slideMarkdown(slide: ParsedPptxSlide): string {
  return [`## Slide ${slide.slideNumber}`, slide.text].filter(Boolean).join("\n\n");
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

function sortedFiles(zip: JSZip, pattern: RegExp): JSZip.JSZipObject[] {
  return Object.values(zip.files)
    .filter((file) => !file.dir && pattern.test(file.name))
    .sort((left, right) => numberFromPath(left.name) - numberFromPath(right.name));
}

function sortedNames(zip: JSZip, pattern: RegExp): string[] {
  return Object.values(zip.files)
    .filter((file) => !file.dir && pattern.test(file.name))
    .map((file) => file.name)
    .sort();
}

function numberFromPath(path: string): number {
  const match = path.match(/(\d+)(?=\.xml$|$)/);
  return match ? Number(match[1]) : 0;
}

function countMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length;
}

function mediaTypeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".emf")) return "image/x-emf";
  return "application/octet-stream";
}

function normalizeText(value: string): string {
  return value.replace(/\r/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}
