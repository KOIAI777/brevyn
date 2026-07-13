import { posix } from "node:path";
import type JSZip from "jszip";

export interface PptxPackageRelationship {
  id: string;
  type?: string;
  target: string;
  targetMode?: string;
}

export interface OrderedPptxSlidePart {
  file: JSZip.JSZipObject;
  slideNumber: number;
  partNumber: number;
}

export async function orderedPptxSlideParts(zip: JSZip): Promise<OrderedPptxSlidePart[]> {
  const fallbackFiles = Object.values(zip.files)
    .filter((file) => !file.dir && /^ppt\/slides\/slide\d+\.xml$/.test(file.name))
    .sort((left, right) => pptxPartNumber(left.name) - pptxPartNumber(right.name));
  const presentationXml = await zip.file("ppt/presentation.xml")?.async("string").catch(() => undefined);
  if (!presentationXml) return fallbackSlideParts(fallbackFiles);

  const relationships = await readPptxRelationships(zip, "ppt/_rels/presentation.xml.rels", "ppt");
  const slideTargetsById = new Map(
    relationships
      .filter((relationship) => relationship.type?.endsWith("/slide"))
      .map((relationship) => [relationship.id, relationship.target]),
  );
  const orderedTargets: string[] = [];
  for (const match of presentationXml.matchAll(/<(?:[\w.-]+:)?sldId\b([^>]*)\/?\s*>/g)) {
    const attributes = parseXmlAttributes(match[1] || "");
    const relationshipId = attributes["r:id"] || attributes["relationships:id"];
    const target = relationshipId ? slideTargetsById.get(relationshipId) : undefined;
    if (target && zip.file(target) && !orderedTargets.includes(target)) orderedTargets.push(target);
  }
  if (orderedTargets.length === 0) return fallbackSlideParts(fallbackFiles);

  const seen = new Set(orderedTargets);
  orderedTargets.push(...fallbackFiles.map((file) => file.name).filter((name) => !seen.has(name)));
  return orderedTargets.flatMap((target, index) => {
    const file = zip.file(target);
    return file ? [{ file, slideNumber: index + 1, partNumber: pptxPartNumber(target) }] : [];
  });
}

export async function readPptxRelationships(zip: JSZip, relsPath: string, baseDir: string): Promise<PptxPackageRelationship[]> {
  const xml = await zip.file(relsPath)?.async("string").catch(() => undefined);
  if (!xml) return [];
  const relationships: PptxPackageRelationship[] = [];
  for (const match of xml.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*)\/?>/g)) {
    const attributes = parseXmlAttributes(match[1] || "");
    const id = attributes.Id || attributes.id || "";
    const target = attributes.Target || "";
    if (!id || !target) continue;
    relationships.push({
      id,
      type: attributes.Type,
      target: normalizeRelationshipTarget(baseDir, target),
      targetMode: attributes.TargetMode,
    });
  }
  return relationships;
}

export function pptxSlideRelationshipsPath(slidePart: string): string {
  const name = posix.basename(slidePart);
  return posix.join(posix.dirname(slidePart), "_rels", `${name}.rels`);
}

function fallbackSlideParts(files: JSZip.JSZipObject[]): OrderedPptxSlidePart[] {
  return files.map((file, index) => ({
    file,
    slideNumber: index + 1,
    partNumber: pptxPartNumber(file.name),
  }));
}

function parseXmlAttributes(value: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of value.matchAll(/([A-Za-z_:][\w:.-]*)=["']([^"']*)["']/g)) {
    attributes[match[1] || ""] = decodeXml(match[2] || "");
  }
  return attributes;
}

function normalizeRelationshipTarget(baseDir: string, target: string): string {
  if (/^[a-z]+:/i.test(target)) return target;
  if (target.startsWith("/")) return posix.normalize(target.replace(/^\/+/, ""));
  return posix.normalize(posix.join(baseDir, target.replace(/^\/+/, "")));
}

function pptxPartNumber(path: string): number {
  const match = path.match(/(\d+)(?=\.xml$|$)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
