import type { BrevynOfficeArtifact, BrevynSemanticUnit } from "./schema";

export interface SemanticUnitChunkMetadata {
  sourceLabel?: string;
  title?: string;
  sectionType?: string;
  sectionIndex?: number;
  chunkInSection?: number;
  chunksInSection?: number;
  artifactId?: string;
  semanticUnitId?: string;
  elementIds?: string[];
  page?: number;
  slide?: number;
  sheet?: string;
  range?: string;
  bbox?: string;
}

export function officeArtifactMarkdown(artifact: BrevynOfficeArtifact): string {
  return artifact.semanticUnits.map((unit) => unit.markdown || unit.text).filter(Boolean).join("\n\n");
}

export function semanticUnitSectionMetadata(unit: BrevynSemanticUnit, index: number): SemanticUnitChunkMetadata {
  return {
    sourceLabel: unit.sourceLabel,
    title: unit.title,
    sectionType: unit.unitType,
    sectionIndex: index + 1,
    artifactId: unit.artifactId,
    semanticUnitId: unit.id,
    elementIds: unit.elementIds,
    page: unit.location.page,
    slide: unit.location.slide,
    sheet: unit.location.sheet,
    range: unit.location.range,
    bbox: unit.bbox ? JSON.stringify(unit.bbox) : undefined,
  };
}
