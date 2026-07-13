import type { WorkspaceFileKind } from "../../../types/domain";

export interface ParsedIndexingFile {
  text: string;
  byteCount: number;
  warnings: string[];
  metadata: Record<string, string | number | boolean>;
  sections?: ParsedIndexingSection[];
  elements?: ParsedDocumentElement[];
  assets?: ParsedDocumentAsset[];
  coverage?: ParsedDocumentCoverage;
  officeArtifact?: unknown;
}

export type CoverageStatus = "complete" | "partial" | "skipped";

export interface ParsedIndexingSection {
  text: string;
  sourceLabel: string;
  title?: string;
  sectionType?: string;
  sectionIndex?: number;
  artifactId?: string;
  semanticUnitId?: string;
  elementIds?: string[];
  page?: number;
  slide?: number;
  sheet?: string;
  range?: string;
  bbox?: string;
}

export type ParsedDocumentElementType =
  | "title"
  | "paragraph"
  | "list"
  | "table"
  | "formula"
  | "image_caption"
  | "ocr"
  | "page"
  | "slide"
  | "note";

export interface ParsedDocumentElement {
  id: string;
  type: ParsedDocumentElementType;
  text: string;
  sourceLabel: string;
  title?: string;
  pageNumber?: number;
  slideNumber?: number;
  sectionIndex?: number;
  assetId?: string;
  confidence?: number;
}

export interface ParsedDocumentAsset {
  id: string;
  kind: "image" | "page_image" | "slide_image" | "embedded_media";
  sourceLabel: string;
  mediaType?: string;
  byteCount?: number;
  pageNumber?: number;
  slideNumber?: number;
  needsOcr?: boolean;
  reason?: string;
}

export interface ParsedDocumentCoverage {
  status: CoverageStatus;
  unit: "document" | "page" | "slide" | "section" | "image";
  total: number;
  indexed: number;
  empty: number;
  failed: number;
  needsOcr: number;
  items?: ParsedDocumentCoverageItem[];
}

export interface ParsedDocumentCoverageItem {
  index: number;
  sourceLabel: string;
  textChars: number;
  hasText: boolean;
  failed: boolean;
  needsOcr: boolean;
  reason?: string;
  pageNumber?: number;
  slideNumber?: number;
  visualSignals?: {
    imageOps?: number;
    paintOps?: number;
  };
  ocrApplied?: boolean;
}

export interface ParseInput {
  sourcePath: string;
  kind: WorkspaceFileKind;
}
