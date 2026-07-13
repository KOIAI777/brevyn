import { posix } from "node:path";
import type JSZip from "jszip";
import type { ParsedDocumentAsset } from "./types";
import { decodeXml, sortedZipFiles } from "./utils";

export function embeddedMediaFiles(zip: JSZip, rootDir: "word" | "ppt"): string[] {
  return sortedZipFiles(zip, new RegExp(`^${rootDir}/media/[^/]+$`)).map((file) => file.name);
}

export function mediaAssetFromPath(input: {
  path: string;
  sourceLabel: string;
  slideNumber?: number;
  pageNumber?: number;
  needsOcr?: boolean;
  reason?: string;
}): ParsedDocumentAsset {
  return {
    id: `asset-${input.slideNumber ? `slide-${input.slideNumber}-` : ""}${safeAssetId(input.path)}`,
    kind: input.slideNumber ? "slide_image" : "embedded_media",
    sourceLabel: input.sourceLabel,
    mediaType: mediaTypeForPath(input.path),
    slideNumber: input.slideNumber,
    pageNumber: input.pageNumber,
    needsOcr: input.needsOcr,
    reason: input.reason,
  };
}

export async function mediaTargetsFromRelationships(zip: JSZip, relsPath: string, baseDir: string): Promise<string[]> {
  const rels = await zip.file(relsPath)?.async("string").catch(() => undefined);
  if (!rels) return [];
  const targets: string[] = [];
  const pattern = /<Relationship\b[^>]*\bTarget=["']([^"']+)["'][^>]*>/g;
  for (const match of rels.matchAll(pattern)) {
    const raw = decodeXml(match[1] || "").trim();
    if (!raw || raw.startsWith("http://") || raw.startsWith("https://")) continue;
    const normalized = posix.normalize(posix.join(baseDir, raw));
    if (normalized.includes("/media/")) targets.push(normalized);
  }
  return [...new Set(targets)];
}

function safeAssetId(path: string): string {
  return path.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function mediaTypeForPath(path: string): string | undefined {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".bmp")) return "image/bmp";
  if (normalized.endsWith(".tif") || normalized.endsWith(".tiff")) return "image/tiff";
  return undefined;
}
