import type { IndexingChunkMetadata } from "./indexing-types";
import type { ParsedIndexingFile } from "./parsers";
import { MAX_PARSED_CHARS } from "./parsers/utils";

const CHUNK_SIZE = 2_400;
const CHUNK_OVERLAP = 260;
const MIN_SPLITTABLE_TEXT_CHARS = 900;

export function chunkParsedText(parsed: ParsedIndexingFile): { chunks: string[]; metadata: IndexingChunkMetadata[] } {
  const sections = parsed.sections?.filter((section) => section.text.trim());
  if (!sections || sections.length === 0) {
    const chunks = chunkText(parsed.text);
    return { chunks, metadata: chunks.map(() => ({})) };
  }

  const boundedSections = trimSectionsToCharCount(sections, MAX_PARSED_CHARS);
  const chunks: string[] = [];
  const metadata: IndexingChunkMetadata[] = [];
  for (const section of boundedSections) {
    const sectionChunks = chunkText(section.text, { minChunks: minChunksForStructuredText(section.text) });
    sectionChunks.forEach((chunk, index) => {
      chunks.push(chunk);
      metadata.push({
        sourceLabel: section.sourceLabel,
        title: section.title,
        sectionType: section.sectionType,
        sectionIndex: section.sectionIndex,
        chunkInSection: index + 1,
        chunksInSection: sectionChunks.length,
        artifactId: section.artifactId,
        semanticUnitId: section.semanticUnitId,
        elementIds: section.elementIds,
        page: section.page,
        slide: section.slide,
        sheet: section.sheet,
        range: section.range,
        bbox: section.bbox,
      });
    });
  }
  return { chunks, metadata };
}

function trimSectionsToCharCount<T extends { text: string }>(sections: T[], maxChars: number): T[] {
  if (maxChars <= 0) return [];
  const result: T[] = [];
  let remaining = maxChars;
  for (const section of sections) {
    if (remaining <= 0) break;
    if (section.text.length <= remaining) {
      result.push(section);
      remaining -= section.text.length;
      continue;
    }
    result.push({ ...section, text: section.text.slice(0, remaining) });
    break;
  }
  return result;
}

function chunkText(text: string, options: { minChunks?: number } = {}): string[] {
  if (!text) return [];
  const minChunks = Math.max(1, Math.floor(options.minChunks || 1));
  if (minChunks > 1 && text.trim().length <= CHUNK_SIZE) {
    const split = splitShortStructuredText(text, minChunks);
    if (split.length >= minChunks) return split;
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const hardEnd = Math.min(text.length, start + CHUNK_SIZE);
    const softEnd = findSoftBoundary(text, start, hardEnd);
    const chunk = text.slice(start, softEnd).trim();
    if (chunk) chunks.push(chunk);
    if (softEnd >= text.length) break;
    start = Math.max(softEnd - CHUNK_OVERLAP, start + 1);
  }
  return chunks;
}

function minChunksForStructuredText(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length < MIN_SPLITTABLE_TEXT_CHARS || trimmed.length > CHUNK_SIZE) return 1;
  const paragraphs = trimmed.split(/\n{2,}/).filter((part) => part.trim().length > 0);
  if (paragraphs.length >= 12 || trimmed.length >= 1_800) return 3;
  if (paragraphs.length >= 6) return 2;
  const lines = trimmed.split(/\n/).filter((part) => part.trim().length > 0);
  return lines.length >= 10 ? 2 : 1;
}

function splitShortStructuredText(text: string, minChunks: number): string[] {
  const paragraphParts = text.split(/(\n{2,})/);
  const paragraphs: string[] = [];
  for (let index = 0; index < paragraphParts.length; index += 2) {
    const body = paragraphParts[index] || "";
    const separator = paragraphParts[index + 1] || "";
    if (body.trim()) paragraphs.push(`${body}${separator}`.trim());
  }
  const units = paragraphs.length >= minChunks
    ? paragraphs
    : text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  if (units.length < minChunks) return [text.trim()].filter(Boolean);

  const targetChars = Math.ceil(text.length / minChunks);
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (chunks.length < minChunks - 1 && current && candidate.length >= targetChars) {
      chunks.push(current.trim());
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function findSoftBoundary(text: string, start: number, hardEnd: number): number {
  if (hardEnd >= text.length) return text.length;
  const window = text.slice(start, hardEnd);
  const paragraphBreak = window.lastIndexOf("\n\n");
  if (paragraphBreak > CHUNK_SIZE * 0.55) return start + paragraphBreak;
  const lineBreak = window.lastIndexOf("\n");
  if (lineBreak > CHUNK_SIZE * 0.65) return start + lineBreak;
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("。"), window.lastIndexOf("? "), window.lastIndexOf("! "));
  if (sentence > CHUNK_SIZE * 0.7) return start + sentence + 1;
  return hardEnd;
}
