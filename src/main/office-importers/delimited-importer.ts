import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { createHash } from "node:crypto";
import type {
  BrevynOfficeArtifact,
  BrevynOfficeElement,
  BrevynSemanticUnit,
  BrevynSpreadsheetTable,
  BrevynWorksheetCell,
  BrevynWorksheetColumn,
  BrevynWorksheetModel,
  BrevynWorksheetRow,
} from "../office-model/schema";
import { renderSpreadsheetSheet, spreadsheetColumnName } from "../office-renderers/sheet-renderer";

export const DELIMITED_OBJECT_MODEL_SCHEMA_VERSION = 1;
export const DELIMITED_OBJECT_MODEL_PARSER = "brevyn-delimited-object-model";
export const DEFAULT_DELIMITED_MAX_ROWS = 2_000;
export const DEFAULT_DELIMITED_MAX_COLUMNS = 80;
export const DEFAULT_DELIMITED_MAX_BYTES = 50 * 1024 * 1024;

export interface ImportDelimitedOptions {
  sourcePath: string;
  byteCount: number;
  delimiter: "," | "\t";
  maxRows?: number;
  maxColumns?: number;
  maxBytes?: number;
}

export function importDelimitedArtifact(options: ImportDelimitedOptions): BrevynOfficeArtifact {
  const maxRows = options.maxRows ?? DEFAULT_DELIMITED_MAX_ROWS;
  const maxColumns = options.maxColumns ?? DEFAULT_DELIMITED_MAX_COLUMNS;
  const maxBytes = options.maxBytes ?? DEFAULT_DELIMITED_MAX_BYTES;
  const bytes = readFileSync(options.sourcePath);
  const bytesToRead = Math.min(bytes.length, maxBytes);
  const text = bytes.subarray(0, bytesToRead).toString("utf8");
  const rows = parseDelimitedRows(text, options.delimiter);
  const artifactId = `artifact-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  const visibleRows = rows.slice(0, maxRows);
  const totalColumns = Math.max(...rows.map((row) => row.length), 0);
  const renderedColumns = Math.min(totalColumns, maxColumns);
  const worksheetRows = delimitedWorksheetRows(artifactId, visibleRows, maxColumns);
  const sheetName = options.delimiter === "\t" ? "TSV" : "CSV";
  const usedRange = worksheetRows.length > 0 && renderedColumns > 0
    ? `A1:${spreadsheetColumnName(renderedColumns - 1)}${worksheetRows.length}`
    : undefined;
  const columns = delimitedColumns(renderedColumns, visibleRows);
  const table = usedRange ? delimitedTable(artifactId, sheetName, usedRange, visibleRows, renderedColumns) : undefined;
  const sheet: BrevynWorksheetModel = {
    id: `${artifactId}:sheet-1`,
    index: 0,
    name: sheetName,
    usedRange,
    totalRows: rows.length,
    totalColumns,
    renderedRows: worksheetRows.length,
    renderedColumns,
    truncatedRows: rows.length > maxRows || bytes.length > maxBytes,
    truncatedColumns: totalColumns > maxColumns,
    columns,
    rows: worksheetRows,
    mergedCells: [],
    drawingCount: 0,
    charts: [],
    images: [],
    shapes: [],
    hyperlinks: [],
    comments: [],
    tables: table ? [table] : [],
    namedRanges: [],
  };
  sheet.render = renderSpreadsheetSheet(sheet);
  const elements = delimitedElements(sheet);
  const semanticUnits = delimitedSemanticUnits(artifactId, sheet, elements);
  const warnings = delimitedWarnings({ byteCount: bytes.length, maxBytes, totalRows: rows.length, maxRows, totalColumns, maxColumns, semanticUnits });
  const extension = extname(options.sourcePath).toLowerCase();

  return {
    id: artifactId,
    schemaVersion: DELIMITED_OBJECT_MODEL_SCHEMA_VERSION,
    kind: "csv",
    title: basename(options.sourcePath),
    source: {
      path: options.sourcePath,
      name: basename(options.sourcePath),
      byteCount: options.byteCount,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    metadata: {
      parser: DELIMITED_OBJECT_MODEL_PARSER,
      parserVersion: 1,
      createdAt: new Date().toISOString(),
      coverageStatus: semanticUnits.length === 0 ? "skipped" : warnings.length > 0 ? "partial" : "complete",
      warnings,
      delimiter: options.delimiter === "\t" ? "tab" : "comma",
      extension,
      rows: rows.length,
      columns: totalColumns,
      rowsIndexed: worksheetRows.length,
      columnsIndexed: renderedColumns,
      truncated: sheet.truncatedRows || sheet.truncatedColumns,
    },
    workbook: {
      sheets: [sheet],
      sheetCount: 1,
      renderedSheetCount: 1,
      maxRows,
      maxColumns,
      truncated: sheet.truncatedRows || sheet.truncatedColumns,
    },
    elements,
    assets: [],
    semanticUnits,
  };
}

export function parseDelimitedRows(raw: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let inQuotes = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    const next = raw[index + 1];
    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === delimiter) {
      row.push(value);
      value = "";
      continue;
    }
    if (!inQuotes && (char === "\n" || char === "\r")) {
      row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
      if (char === "\r" && next === "\n") index += 1;
      continue;
    }
    value += char;
  }

  row.push(value);
  if (row.some((cell) => cell.trim())) rows.push(row);
  return rows;
}

function delimitedWorksheetRows(artifactId: string, rows: string[][], maxColumns: number): BrevynWorksheetRow[] {
  return rows
    .map((row, rowIndex): BrevynWorksheetRow => {
      const rowNumber = rowIndex + 1;
      const cells = row.slice(0, maxColumns).map((value, columnIndex): BrevynWorksheetCell => {
        const column = columnIndex + 1;
        const ref = `${spreadsheetColumnName(columnIndex)}${rowNumber}`;
        const text = normalizeCell(value);
        return {
          id: `${artifactId}:sheet-1:cell-${ref}`,
          ref,
          row: rowNumber,
          column,
          columnName: spreadsheetColumnName(columnIndex),
          text,
          rawValue: value,
          type: "text",
          style: rowIndex === 0 ? { bold: true, fillColor: "#f8fafc", borderBottom: true } : undefined,
        };
      }).filter((cell) => cell.text || cell.rawValue);
      return { number: rowNumber, cells };
    })
    .filter((row) => row.cells.length > 0);
}

function delimitedColumns(columnCount: number, rows: string[][]): BrevynWorksheetColumn[] {
  return Array.from({ length: columnCount }, (_value, index) => {
    const values = rows.slice(0, 80).map((row) => normalizeCell(row[index] || ""));
    const longest = Math.max(spreadsheetColumnName(index).length, ...values.map((value) => value.length));
    return {
      index,
      name: spreadsheetColumnName(index),
      widthPx: Math.max(80, Math.min(260, longest * 8 + 28)),
    };
  });
}

function delimitedTable(artifactId: string, sheetName: string, ref: string, rows: string[][], columnCount: number): BrevynSpreadsheetTable {
  const header = rows[0] || [];
  const columns = Array.from({ length: columnCount }, (_value, index) => normalizeCell(header[index] || `Column ${spreadsheetColumnName(index)}`));
  const prefix = sheetName === "TSV" ? "Tsv" : "Csv";
  return {
    id: `${artifactId}:sheet-1:table-1`,
    name: `${prefix}Table`,
    displayName: `${prefix}Table`,
    ref,
    columns,
    totalsRowShown: false,
  };
}

function delimitedElements(sheet: BrevynWorksheetModel): BrevynOfficeElement[] {
  const elements: BrevynOfficeElement[] = [];
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      if (!cell.text.trim()) continue;
      elements.push({
        id: cell.id,
        type: "table_cell",
        text: cell.text,
        markdown: `${cell.ref}: ${cell.text}`,
        location: {
          sheet: sheet.name,
          range: cell.ref,
          row: cell.row,
          column: cell.column,
        },
      });
    }
  }
  for (const table of sheet.tables || []) {
    const markdown = [
      `Table: ${table.displayName || table.name}`,
      `Range: ${table.ref}`,
      table.columns.length > 0 ? `Columns: ${table.columns.join(", ")}` : "",
    ].filter(Boolean).join("\n");
    elements.push({
      id: table.id,
      type: "table",
      text: markdown,
      markdown,
      location: {
        sheet: sheet.name,
        range: table.ref,
        objectPath: table.displayName || table.name,
      },
    });
  }
  return elements;
}

function delimitedSemanticUnits(artifactId: string, sheet: BrevynWorksheetModel, elements: BrevynOfficeElement[]): BrevynSemanticUnit[] {
  const markdown = markdownTable(sheet.rows.map((row) => sparseCellsToValues(row.cells)), { fallbackHeaderPrefix: "Column" });
  if (!markdown.trim()) return [];
  const range = sheet.usedRange || "A1";
  const unitIds = elements.filter((element) => element.location.range).map((element) => element.id);
  const rangeUnit: BrevynSemanticUnit = {
    id: `${sheet.id}:unit-used-range`,
    artifactId,
    elementIds: unitIds,
    unitType: "spreadsheet_range",
    title: sheet.name,
    text: [`## Sheet 1: ${sheet.name}`, markdown].join("\n\n"),
    markdown: [`## Sheet 1: ${sheet.name}`, markdown].join("\n\n"),
    sourceLabel: `工作表 1: ${sheet.name}`,
    citation: `${sheet.name}!${range}`,
    location: { sheet: sheet.name, range },
    importance: 0.85,
  };
  const table = sheet.tables?.[0];
  if (!table) return [rangeUnit];
  const tableUnit: BrevynSemanticUnit = {
    id: `${sheet.id}:unit-table-1`,
    artifactId,
    elementIds: [table.id, ...unitIds],
    unitType: "table",
    title: table.displayName || table.name,
    text: [`## Table ${table.displayName || table.name}`, `Range: ${sheet.name}!${table.ref}`, markdown].join("\n\n"),
    markdown: [`## Table ${table.displayName || table.name}`, `Range: ${sheet.name}!${table.ref}`, markdown].join("\n\n"),
    sourceLabel: `表格 ${table.displayName || table.name}`,
    citation: `${sheet.name}!${table.ref}`,
    location: {
      sheet: sheet.name,
      range: table.ref,
      objectPath: table.displayName || table.name,
    },
    importance: 0.9,
  };
  return [rangeUnit, tableUnit];
}

function delimitedWarnings(input: {
  byteCount: number;
  maxBytes: number;
  totalRows: number;
  maxRows: number;
  totalColumns: number;
  maxColumns: number;
  semanticUnits: BrevynSemanticUnit[];
}): string[] {
  const warnings: string[] = [];
  if (input.byteCount > input.maxBytes) warnings.push(`Read first ${formatDelimitedSize(input.maxBytes)} only; streaming CSV parsing is still pending.`);
  if (input.totalRows > input.maxRows) warnings.push(`Only the first ${input.maxRows} spreadsheet rows were indexed.`);
  if (input.totalColumns > input.maxColumns) warnings.push(`Only the first ${input.maxColumns} spreadsheet columns were indexed.`);
  if (input.semanticUnits.length === 0) warnings.push("No extractable spreadsheet text was found.");
  return warnings;
}

function sparseCellsToValues(cells: BrevynWorksheetCell[]): string[] {
  const values: string[] = [];
  for (const cell of cells) values[cell.column - 1] = String(cell.text || "");
  while (values.length > 0 && !values[values.length - 1]) values.pop();
  return values;
}

function markdownTable(rows: string[][], options: { fallbackHeaderPrefix: string }): string {
  const cleanedRows = rows
    .map((row) => row.map((cell) => markdownTableCell(cell)))
    .filter((row) => row.some(Boolean));
  if (cleanedRows.length === 0) return "";
  const width = Math.max(...cleanedRows.map((row) => row.length), 0);
  if (width === 0) return "";
  const headerCandidate = cleanedRows[0] || [];
  const hasHeader = headerCandidate.some((cell) => cell && !looksNumeric(cell));
  const header = hasHeader
    ? normalizeTableWidth(headerCandidate, width)
    : Array.from({ length: width }, (_value, index) => `${options.fallbackHeaderPrefix} ${spreadsheetColumnName(index)}`);
  const body = hasHeader ? cleanedRows.slice(1) : cleanedRows;
  return [
    `| ${header.join(" | ")} |`,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map((row) => `| ${normalizeTableWidth(row, width).join(" | ")} |`),
  ].join("\n");
}

function normalizeTableWidth(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_value, index) => row[index] || "");
}

function markdownTableCell(value: string): string {
  return normalizeCell(value).replace(/\|/g, "\\|").replace(/\n+/g, "<br>");
}

function looksNumeric(value: string): boolean {
  return /^[-+]?\d+(?:[.,]\d+)?%?$/.test(value.trim());
}

function normalizeCell(value: string): string {
  return String(value || "").replace(/^\ufeff/, "").replace(/\s+/g, " ").trim();
}

function formatDelimitedSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}
