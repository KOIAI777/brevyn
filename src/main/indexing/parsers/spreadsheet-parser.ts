import { extname } from "node:path";
import type { CoverageStatus, ParsedIndexingFile, ParsedIndexingSection, ParseInput } from "./types";
import { importDelimitedArtifact } from "../../office-importers/delimited-importer";
import { importXlsxArtifact } from "../../office-importers/xlsx-importer";
import type { BrevynOfficeArtifact } from "../../office-model/schema";
import { officeArtifactMarkdown } from "../../office-model/semantic-units";
import { capParsedText, dedupeWarnings, emptyParsedFile, normalizeText } from "./utils";

const MAX_DELIMITED_BYTES = 50 * 1024 * 1024;
const MAX_SPREADSHEET_SHEETS = 32;
const MAX_SPREADSHEET_ROWS_PER_SHEET = 2_000;
const MAX_SPREADSHEET_COLUMNS = 80;

export async function parseSpreadsheet(input: ParseInput, byteCount: number): Promise<ParsedIndexingFile> {
  const extension = extname(input.sourcePath).toLowerCase();
  if (extension === ".xls") {
    return emptyParsedFile(input, byteCount, "Legacy .xls files need conversion to .xlsx before local table extraction.");
  }
  if (extension === ".csv" || extension === ".tsv") {
    return parseDelimitedSpreadsheet(input, byteCount, extension === ".tsv" ? "\t" : ",");
  }
  return parseXlsx(input, byteCount);
}

function parseDelimitedSpreadsheet(input: ParseInput, byteCount: number, delimiter: "," | "\t"): ParsedIndexingFile {
  const artifact = importDelimitedArtifact({
    sourcePath: input.sourcePath,
    byteCount,
    delimiter,
    maxRows: MAX_SPREADSHEET_ROWS_PER_SHEET,
    maxColumns: MAX_SPREADSHEET_COLUMNS,
    maxBytes: MAX_DELIMITED_BYTES,
  });
  const warnings = [...(artifact.metadata.warnings || [])];
  const sections = sectionsFromXlsxArtifact(artifact);
  const capped = capParsedText(officeArtifactMarkdown(artifact), warnings);
  const normalized = normalizeText(capped.text);
  const coverageStatus: CoverageStatus = !normalized
    ? "skipped"
    : artifact.metadata.coverageStatus === "partial" || capped.truncated
      ? "partial"
      : "complete";

  return {
    text: normalized,
    byteCount,
    warnings: dedupeWarnings(warnings),
    metadata: {
      parser: delimiter === "\t" ? "tsv-text" : "csv-text",
      officeParser: String(artifact.metadata.parser || ""),
      artifactId: artifact.id,
      artifactSchemaVersion: artifact.schemaVersion,
      kind: input.kind,
      sheets: artifact.workbook?.sheetCount || 1,
      sheetsIndexed: artifact.workbook?.renderedSheetCount || 1,
      rows: Number(artifact.metadata.rows || 0),
      rowsIndexed: Number(artifact.metadata.rowsIndexed || 0),
      columns: Number(artifact.metadata.columns || 0),
      columnsIndexed: Number(artifact.metadata.columnsIndexed || 0),
      sectionsTotal: artifact.semanticUnits.length,
      sectionsIndexed: sections.length,
      sectionsEmpty: normalized ? 0 : 1,
      sectionsFailed: 0,
      sectionUnit: "个表格区域",
      coverageStatus,
      truncated: Boolean(artifact.metadata.truncated) || capped.truncated,
    },
    sections: sections.length > 0 ? sections : undefined,
    officeArtifact: artifact,
  };
}

async function parseXlsx(input: ParseInput, byteCount: number): Promise<ParsedIndexingFile> {
  const artifact = await importXlsxArtifact({
    sourcePath: input.sourcePath,
    byteCount,
    maxSheets: MAX_SPREADSHEET_SHEETS,
    maxRowsPerSheet: MAX_SPREADSHEET_ROWS_PER_SHEET,
    maxColumns: MAX_SPREADSHEET_COLUMNS,
  });
  const warnings = [...(artifact.metadata.warnings || [])];
  const sections = sectionsFromXlsxArtifact(artifact);
  const capped = capParsedText(officeArtifactMarkdown(artifact), warnings);
  const normalized = normalizeText(capped.text);
  const coverageStatus: CoverageStatus = !normalized
    ? "skipped"
    : artifact.metadata.coverageStatus === "partial" || capped.truncated
      ? "partial"
      : "complete";

  return {
    text: normalized,
    byteCount,
    warnings: dedupeWarnings(warnings),
    metadata: {
      parser: "xlsx-ooxml",
      officeParser: String(artifact.metadata.parser || ""),
      artifactId: artifact.id,
      artifactSchemaVersion: artifact.schemaVersion,
      kind: input.kind,
      sheets: artifact.workbook?.sheetCount || 0,
      sheetsIndexed: artifact.workbook?.sheets.filter((sheet) => sheet.renderedRows > 0).length || 0,
      rows: artifact.workbook?.sheets.reduce((sum, sheet) => sum + sheet.totalRows, 0) || 0,
      rowsIndexed: artifact.workbook?.sheets.reduce((sum, sheet) => sum + sheet.renderedRows, 0) || 0,
      columns: Math.max(...(artifact.workbook?.sheets.map((sheet) => sheet.totalColumns) || [0]), 0),
      sectionsTotal: artifact.semanticUnits.length,
      sectionsIndexed: sections.length,
      sectionsEmpty: Number(artifact.metadata.sheetsEmpty || 0),
      sectionsFailed: Number(artifact.metadata.sheetsFailed || 0),
      sectionUnit: "个语义单元",
      coverageStatus,
      truncated: Boolean(artifact.metadata.truncated) || capped.truncated,
    },
    sections: sections.length > 0 ? sections : undefined,
    officeArtifact: artifact,
  };
}

function sectionsFromXlsxArtifact(artifact: BrevynOfficeArtifact): ParsedIndexingSection[] {
  return artifact.semanticUnits.map((unit, index) => ({
    text: unit.markdown || unit.text,
    sourceLabel: unit.sourceLabel,
    title: unit.title,
    sectionType: unit.unitType,
    sectionIndex: index + 1,
    artifactId: artifact.id,
    semanticUnitId: unit.id,
    elementIds: unit.elementIds,
    sheet: unit.location.sheet,
    range: unit.location.range,
    bbox: unit.bbox ? JSON.stringify(unit.bbox) : undefined,
  }));
}
