import { readFileSync } from "node:fs";
import { basename, posix as pathPosix } from "node:path";
import { createHash } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import type {
  BrevynMergedCell,
  BrevynOfficeArtifact,
  BrevynOfficeAsset,
  BrevynOfficeElement,
  BrevynSpreadsheetComment,
  BrevynSpreadsheetChart,
  BrevynSpreadsheetChartSeries,
  BrevynSpreadsheetChartStyle,
  BrevynSpreadsheetChartType,
  BrevynSpreadsheetHyperlink,
  BrevynSpreadsheetImage,
  BrevynSpreadsheetNamedRange,
  BrevynSpreadsheetShape,
  BrevynSpreadsheetTable,
  BrevynSemanticUnit,
  BrevynWorksheetCellStyle,
  BrevynWorksheetColumn,
  BrevynWorksheetFreezePanes,
  BrevynWorksheetCell,
  BrevynWorksheetModel,
  BrevynWorksheetRow,
} from "../office-model/schema";
import { renderSpreadsheetChart } from "../office-renderers/chart-renderer";
import { renderSpreadsheetSheet, spreadsheetColumnName } from "../office-renderers/sheet-renderer";

export const XLSX_OBJECT_MODEL_SCHEMA_VERSION = 2;
export const XLSX_OBJECT_MODEL_PARSER = "brevyn-xlsx-object-model";
export const DEFAULT_XLSX_MAX_SHEETS = 32;
export const DEFAULT_XLSX_MAX_ROWS_PER_SHEET = 2_000;
export const DEFAULT_XLSX_MAX_COLUMNS = 80;

export interface ImportXlsxOptions {
  sourcePath: string;
  byteCount: number;
  maxSheets?: number;
  maxRowsPerSheet?: number;
  maxColumns?: number;
}

interface ImportLimits {
  maxSheets: number;
  maxRowsPerSheet: number;
  maxColumns: number;
}

interface XlsxSharedResources {
  relationships: Map<string, string>;
  sharedStrings: string[];
  dateStyleIndexes: Set<number>;
  styles: BrevynWorksheetCellStyle[];
}

interface ParsedXlsxSheetRows {
  rows: BrevynWorksheetRow[];
  totalRows: number;
  totalColumns: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
  columns: BrevynWorksheetColumn[];
  mergedCells: BrevynMergedCell[];
  freezePanes?: BrevynWorksheetFreezePanes;
  drawingCount: number;
  charts: BrevynSpreadsheetChart[];
  images: BrevynSpreadsheetImage[];
  shapes: BrevynSpreadsheetShape[];
  hyperlinks: BrevynSpreadsheetHyperlink[];
  comments: BrevynSpreadsheetComment[];
  tables: BrevynSpreadsheetTable[];
  assets: BrevynOfficeAsset[];
}

interface FormulaEvaluationContext {
  currentSheet?: string;
  cells: Map<string, string>;
  sheets?: Map<string, Map<string, string>>;
}

interface XlsxRelationship {
  id: string;
  type?: string;
  target: string;
  targetMode?: string;
}

interface ParsedFormulaReference {
  sheet?: string;
  ref: string;
}

interface ParsedFormulaRange {
  sheet?: string;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export async function importXlsxArtifact(options: ImportXlsxOptions): Promise<BrevynOfficeArtifact> {
  const limits: ImportLimits = {
    maxSheets: options.maxSheets ?? DEFAULT_XLSX_MAX_SHEETS,
    maxRowsPerSheet: options.maxRowsPerSheet ?? DEFAULT_XLSX_MAX_ROWS_PER_SHEET,
    maxColumns: options.maxColumns ?? DEFAULT_XLSX_MAX_COLUMNS,
  };
  const bytes = readFileSync(options.sourcePath);
  const zip = await JSZip.loadAsync(bytes);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  if (!workbookXml) {
    throw new Error("XLSX workbook.xml was not found. The file may be damaged or unsupported.");
  }

  const artifactId = `artifact-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  const workbookDoc = parseXml(workbookXml);
  const resources: XlsxSharedResources = {
    relationships: await parseRelationships(zip, "xl/_rels/workbook.xml.rels", "xl"),
    sharedStrings: await parseXlsxSharedStrings(zip),
    dateStyleIndexes: await parseXlsxDateStyleIndexes(zip),
    styles: await parseXlsxStyles(zip),
  };
  const workbookSheets = getElementsByLocalName(workbookDoc, "sheet");
  const workbookNamedRanges = parseWorkbookNamedRanges(workbookDoc);
  const visibleSheets = workbookSheets.slice(0, limits.maxSheets);
  const warnings: string[] = [];
  const sheets: BrevynWorksheetModel[] = [];
  const elements: BrevynOfficeElement[] = [];
  const semanticUnits: BrevynSemanticUnit[] = [];
  let failedSheets = 0;
  let emptySheets = 0;
  let truncatedRows = false;
  let truncatedColumns = false;
  let chartCount = 0;
  const assets: BrevynOfficeAsset[] = [];

  for (let index = 0; index < visibleSheets.length; index += 1) {
    const sheet = visibleSheets[index];
    const name = sheet.getAttribute("name") || `Sheet ${index + 1}`;
    const relationshipId = sheet.getAttribute("r:id") || sheet.getAttribute("id") || undefined;
    const sheetPath = relationshipId ? resources.relationships.get(relationshipId) : undefined;
    if (!sheetPath) {
      failedSheets += 1;
      warnings.push(`Worksheet ${name} could not be resolved from workbook relationships.`);
      continue;
    }
    try {
      const parsed = await parseXlsxSheetRows(zip, sheetPath, resources, limits, artifactId, index, name);
      truncatedRows ||= parsed.truncatedRows;
      truncatedColumns ||= parsed.truncatedColumns;
      if (parsed.rows.length === 0) emptySheets += 1;
      const sheetId = sheetElementId(artifactId, index);
      const usedRange = usedRangeForRows(parsed.rows);
      const worksheet: BrevynWorksheetModel = {
        id: sheetId,
        index,
        name,
        relationshipId,
        path: sheetPath,
        usedRange,
        totalRows: parsed.totalRows,
        totalColumns: parsed.totalColumns,
        renderedRows: parsed.rows.length,
        renderedColumns: Math.min(parsed.totalColumns, limits.maxColumns),
        truncatedRows: parsed.truncatedRows,
        truncatedColumns: parsed.truncatedColumns,
        columns: parsed.columns,
        rows: parsed.rows,
        mergedCells: parsed.mergedCells,
        freezePanes: parsed.freezePanes,
        drawingCount: parsed.drawingCount,
        charts: parsed.charts,
        images: parsed.images,
        shapes: parsed.shapes,
        hyperlinks: parsed.hyperlinks,
        comments: parsed.comments,
        tables: parsed.tables,
        namedRanges: workbookNamedRanges
          .filter((range) => !range.sheet || normalizeSheetKey(range.sheet) === normalizeSheetKey(name))
          .map((range, rangeIndex) => ({ ...range, id: `${sheetElementId(artifactId, index)}:named-range-${rangeIndex + 1}` })),
      };
      chartCount += parsed.charts.length;
      assets.push(...parsed.assets);
      sheets.push(worksheet);
    } catch (error) {
      failedSheets += 1;
      warnings.push(`Worksheet ${name} text extraction failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  hydrateWorkbookFormulaValues(sheets);
  for (const worksheet of sheets) {
    worksheet.usedRange = usedRangeForRows(worksheet.rows);
    worksheet.render = renderSpreadsheetSheet(worksheet);
    const sheetElements = worksheetElements(worksheet);
    elements.push(...sheetElements);
    const unit = worksheetSemanticUnit(artifactId, worksheet);
    if (unit) semanticUnits.push(unit);
    semanticUnits.push(...worksheetTableSemanticUnits(artifactId, worksheet));
    semanticUnits.push(...worksheetObjectSemanticUnits(artifactId, worksheet));
  }

  if (workbookSheets.length > visibleSheets.length) warnings.push(`Only the first ${limits.maxSheets} worksheets were indexed.`);
  if (truncatedRows) warnings.push(`Only the first ${limits.maxRowsPerSheet} rows per worksheet were indexed.`);
  if (truncatedColumns) warnings.push(`Only the first ${limits.maxColumns} columns per row were indexed.`);
  if (failedSheets > 0) warnings.push(`${failedSheets} XLSX worksheets could not be parsed.`);
  if (emptySheets > 0 && sheets.length > emptySheets) warnings.push(`${emptySheets} XLSX worksheets had no extractable text.`);
  if (semanticUnits.length === 0) warnings.push("No extractable XLSX text was found. The workbook may contain only charts, images, or unsupported objects.");

  const coverageStatus = semanticUnits.length === 0
    ? "skipped"
    : failedSheets > 0 || emptySheets > 0 || workbookSheets.length > visibleSheets.length || truncatedRows || truncatedColumns
      ? "partial"
      : "complete";

  return {
    id: artifactId,
    schemaVersion: XLSX_OBJECT_MODEL_SCHEMA_VERSION,
    kind: "xlsx",
    title: basename(options.sourcePath),
    source: {
      path: options.sourcePath,
      name: basename(options.sourcePath),
      byteCount: options.byteCount,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    metadata: {
      parser: XLSX_OBJECT_MODEL_PARSER,
      parserVersion: XLSX_OBJECT_MODEL_SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      coverageStatus,
      warnings,
      sheets: workbookSheets.length,
      sheetsIndexed: sheets.filter((sheet) => sheet.renderedRows > 0).length,
      sheetsEmpty: emptySheets,
      sheetsFailed: failedSheets,
      charts: chartCount,
      truncated: workbookSheets.length > visibleSheets.length || truncatedRows || truncatedColumns,
    },
    workbook: {
      sheets,
      sheetCount: workbookSheets.length,
      renderedSheetCount: sheets.length,
      maxRows: limits.maxRowsPerSheet,
      maxColumns: limits.maxColumns,
      truncated: workbookSheets.length > visibleSheets.length || truncatedRows || truncatedColumns,
    },
    elements,
    assets,
    semanticUnits,
  };
}

function worksheetElements(sheet: BrevynWorksheetModel): BrevynOfficeElement[] {
  const elements: BrevynOfficeElement[] = [];
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      const cellText = String(cell.text || "");
      if (!cellText.trim() && !cell.formula) continue;
      elements.push({
        id: cell.id,
        type: cell.formula ? "formula" : "table_cell",
        text: cellText,
        markdown: cell.formula ? `${cell.ref}: =${cell.formula} -> ${cellText}` : `${cell.ref}: ${cellText}`,
        location: {
          sheet: sheet.name,
          range: cell.ref,
          row: cell.row,
          column: cell.column,
        },
        style: {
          styleIndex: cell.styleIndex ?? -1,
        },
        relationships: [
          ...(cell.hyperlink ? [{
            id: `${cell.id}:hyperlink`,
            type: "hyperlink",
            target: cell.hyperlink.target || cell.hyperlink.location || "",
          }] : []),
          ...(cell.commentIds || []).map((commentId) => ({
            id: `${cell.id}:comment-${commentId}`,
            type: "comment",
            target: commentId,
          })),
        ],
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
  for (const chart of sheet.charts) {
    const markdown = chartMarkdown(chart);
    elements.push({
      id: chart.id,
      type: "chart",
      text: markdown,
      markdown,
      location: {
        sheet: sheet.name,
        objectPath: chart.name,
      },
      relationships: chart.sourceRefs.map((sourceRef, index) => ({
        id: `${chart.id}:source-${index + 1}`,
        type: "spreadsheet-range",
        target: sourceRef,
      })),
    });
  }
  for (const image of sheet.images || []) {
    elements.push({
      id: image.id,
      type: "image",
      text: image.name,
      markdown: `Image: ${image.name}`,
      location: {
        sheet: sheet.name,
        objectPath: image.name,
      },
      assetRefs: [image.assetId],
    });
  }
  for (const shape of sheet.shapes || []) {
    elements.push({
      id: shape.id,
      type: "shape",
      text: shape.text || shape.name,
      markdown: [`Shape: ${shape.name}`, shape.text].filter(Boolean).join("\n"),
      location: {
        sheet: sheet.name,
        objectPath: shape.name,
      },
      style: {
        shapeType: shape.shapeType || "",
        fillColor: shape.fillColor || "",
        lineColor: shape.lineColor || "",
      },
    });
  }
  for (const hyperlink of sheet.hyperlinks || []) {
    const target = hyperlink.target || hyperlink.location || "";
    elements.push({
      id: hyperlink.id,
      type: "hyperlink",
      text: [hyperlink.display || hyperlink.ref, target].filter(Boolean).join(" -> "),
      markdown: [`Hyperlink: ${hyperlink.display || hyperlink.ref}`, target ? `Target: ${target}` : "", hyperlink.tooltip ? `Tooltip: ${hyperlink.tooltip}` : ""].filter(Boolean).join("\n"),
      location: {
        sheet: sheet.name,
        range: hyperlink.ref,
      },
      relationships: target ? [{ id: `${hyperlink.id}:target`, type: "hyperlink-target", target }] : undefined,
    });
  }
  for (const comment of sheet.comments || []) {
    elements.push({
      id: comment.id,
      type: "comment",
      text: comment.text,
      markdown: [`Comment ${comment.ref}`, comment.author ? `Author: ${comment.author}` : "", comment.text].filter(Boolean).join("\n"),
      location: {
        sheet: sheet.name,
        range: comment.ref,
      },
    });
  }
  for (const namedRange of sheet.namedRanges || []) {
    elements.push({
      id: namedRange.id,
      type: "named_range",
      text: `${namedRange.name}: ${namedRange.ref}`,
      markdown: `Named range: ${namedRange.name}\nRef: ${namedRange.ref}`,
      location: {
        sheet: sheet.name,
        range: namedRange.ref,
        objectPath: namedRange.name,
      },
    });
  }
  return elements;
}

function worksheetSemanticUnit(artifactId: string, sheet: BrevynWorksheetModel): BrevynSemanticUnit | undefined {
  const table = markdownTable(sheet.rows.map((row) => sparseCellsToValues(row.cells)), { fallbackHeaderPrefix: "Column" });
  const fallback = sheet.rows
    .map((row) => formatSpreadsheetRow(row.number, sparseCellsToValues(row.cells)))
    .filter(Boolean)
    .join("\n");
  const body = table || fallback;
  if (!body.trim()) return undefined;
  const title = `Sheet ${sheet.index + 1}: ${sheet.name}`;
  const range = sheet.usedRange || "A1";
  const objectSummary = worksheetObjectMarkdown(sheet);
  const markdown = [`## ${title}`, body, objectSummary].filter(Boolean).join("\n\n");
  return {
    id: `${sheet.id}:unit-used-range`,
    artifactId,
    elementIds: [],
    unitType: "spreadsheet_range",
    title: sheet.name,
    text: markdown,
    markdown,
    sourceLabel: `工作表 ${sheet.index + 1}: ${sheet.name}`,
    citation: `${sheet.name}!${range}`,
    location: {
      sheet: sheet.name,
      range,
    },
    importance: sheet.index === 0 ? 0.85 : 0.7,
  };
}

function worksheetTableSemanticUnits(artifactId: string, sheet: BrevynWorksheetModel): BrevynSemanticUnit[] {
  return (sheet.tables || []).map((table, index): BrevynSemanticUnit | undefined => {
    const range = parseRangeRef(table.ref);
    if (!range) return undefined;
    const rows = sheet.rows
      .filter((row) => row.number >= range.startRow && row.number <= range.endRow)
      .map((row) => {
        const values: string[] = [];
        for (const cell of row.cells) {
          if (cell.column < range.startColumn || cell.column > range.endColumn) continue;
          values[cell.column - range.startColumn] = String(cell.text || "");
        }
        return values;
      })
      .filter((row) => row.some(Boolean));
    if (rows.length === 0) return undefined;
    const markdown = [
      `## Table ${table.displayName || table.name}`,
      `Range: ${sheet.name}!${table.ref}`,
      markdownTable(rows, { fallbackHeaderPrefix: "Column" }),
    ].filter(Boolean).join("\n\n");
    return {
      id: `${sheet.id}:unit-table-${index + 1}`,
      artifactId,
      elementIds: [table.id],
      unitType: "table",
      title: table.displayName || table.name,
      text: markdown,
      markdown,
      sourceLabel: `表格 ${table.displayName || table.name}`,
      citation: `${sheet.name}!${table.ref}`,
      location: {
        sheet: sheet.name,
        range: table.ref,
        objectPath: table.displayName || table.name,
      },
      importance: 0.9,
    };
  }).filter((unit): unit is BrevynSemanticUnit => Boolean(unit));
}

function worksheetObjectSemanticUnits(artifactId: string, sheet: BrevynWorksheetModel): BrevynSemanticUnit[] {
  const units: BrevynSemanticUnit[] = [];
  for (const chart of sheet.charts) {
    const markdown = chartMarkdown(chart);
    units.push({
      id: `${chart.id}:unit`,
      artifactId,
      elementIds: [chart.id],
      unitType: "chart",
      title: chart.title || chart.name || `Chart ${chart.index + 1}`,
      text: markdown,
      markdown,
      sourceLabel: `图表 ${chart.title || chart.name || chart.index + 1}`,
      citation: `${sheet.name} · Chart ${chart.title || chart.name || chart.index + 1}`,
      location: {
        sheet: sheet.name,
        objectPath: chart.name,
      },
      importance: 0.92,
    });
  }
  for (const shape of sheet.shapes || []) {
    const markdown = [
      `Shape: ${shape.name || `Shape ${shape.index + 1}`}`,
      shape.shapeType ? `Type: ${shape.shapeType}` : "",
      shape.text ? `Text: ${shape.text}` : "",
    ].filter(Boolean).join("\n");
    if (!markdown.trim()) continue;
    units.push({
      id: `${shape.id}:unit`,
      artifactId,
      elementIds: [shape.id],
      unitType: "shape",
      title: shape.name || `Shape ${shape.index + 1}`,
      text: markdown,
      markdown,
      sourceLabel: `对象 ${shape.name || shape.index + 1}`,
      citation: `${sheet.name} · Shape ${shape.name || shape.index + 1}`,
      location: {
        sheet: sheet.name,
        objectPath: shape.name,
      },
      importance: shape.text ? 0.72 : 0.5,
    });
  }
  for (const hyperlink of sheet.hyperlinks || []) {
    const target = hyperlink.target || hyperlink.location || "";
    const markdown = [
      `Hyperlink: ${hyperlink.display || hyperlink.ref}`,
      target ? `Target: ${target}` : "",
      hyperlink.tooltip ? `Tooltip: ${hyperlink.tooltip}` : "",
    ].filter(Boolean).join("\n");
    units.push({
      id: `${hyperlink.id}:unit`,
      artifactId,
      elementIds: [hyperlink.id],
      unitType: "hyperlink",
      title: hyperlink.display || hyperlink.ref,
      text: markdown,
      markdown,
      sourceLabel: `超链接 ${hyperlink.ref}`,
      citation: `${sheet.name}!${hyperlink.ref}`,
      location: { sheet: sheet.name, range: hyperlink.ref },
      importance: 0.55,
    });
  }
  for (const comment of sheet.comments || []) {
    const markdown = [
      `Comment ${comment.ref}`,
      comment.author ? `Author: ${comment.author}` : "",
      comment.text,
    ].filter(Boolean).join("\n");
    units.push({
      id: `${comment.id}:unit`,
      artifactId,
      elementIds: [comment.id],
      unitType: "comment",
      title: `Comment ${comment.ref}`,
      text: markdown,
      markdown,
      sourceLabel: `批注 ${comment.ref}`,
      citation: `${sheet.name}!${comment.ref}`,
      location: { sheet: sheet.name, range: comment.ref },
      importance: 0.68,
    });
  }
  for (const namedRange of sheet.namedRanges || []) {
    const markdown = `Named range: ${namedRange.name}\nRef: ${namedRange.ref}`;
    units.push({
      id: `${namedRange.id}:unit`,
      artifactId,
      elementIds: [namedRange.id],
      unitType: "named_range",
      title: namedRange.name,
      text: markdown,
      markdown,
      sourceLabel: `命名区域 ${namedRange.name}`,
      citation: namedRange.ref.includes("!") ? namedRange.ref : `${sheet.name}!${namedRange.ref}`,
      location: {
        sheet: sheet.name,
        range: namedRange.ref,
        objectPath: namedRange.name,
      },
      importance: 0.7,
    });
  }
  return units;
}

function worksheetObjectMarkdown(sheet: BrevynWorksheetModel): string {
  const lines: string[] = [];
  for (const table of sheet.tables || []) lines.push(`- Table ${table.displayName || table.name}: ${table.ref}${table.columns.length ? ` (${table.columns.join(", ")})` : ""}`);
  for (const chart of sheet.charts) lines.push(`- Chart ${chart.title || chart.name}: ${chart.type}${chart.sourceRefs.length ? ` (${chart.sourceRefs.join(", ")})` : ""}`);
  for (const shape of sheet.shapes || []) lines.push(`- Shape ${shape.name}${shape.text ? `: ${shape.text}` : ""}`);
  for (const range of sheet.namedRanges || []) lines.push(`- Named range ${range.name}: ${range.ref}`);
  for (const link of sheet.hyperlinks || []) lines.push(`- Hyperlink ${link.ref}: ${link.display || link.target || link.location || ""}`);
  for (const comment of sheet.comments || []) lines.push(`- Comment ${comment.ref}${comment.author ? ` by ${comment.author}` : ""}: ${comment.text}`);
  return lines.length > 0 ? [`### Workbook objects`, ...lines].join("\n") : "";
}

function sparseCellsToValues(cells: BrevynWorksheetCell[]): string[] {
  const values: string[] = [];
  for (const cell of cells) values[cell.column - 1] = String(cell.text || "");
  while (values.length > 0 && !values[values.length - 1]) values.pop();
  return values;
}

function parseWorkbookNamedRanges(workbookDoc: Document): BrevynSpreadsheetNamedRange[] {
  return getElementsByLocalName(workbookDoc, "definedName")
    .map((node, index): BrevynSpreadsheetNamedRange | undefined => {
      const name = node.getAttribute("name") || "";
      const ref = (node.textContent || "").trim();
      if (!name || !ref || name.startsWith("_xlnm.")) return undefined;
      const parsed = splitSheetReference(ref);
      return {
        id: `workbook:named-range-${index + 1}`,
        name,
        ref,
        sheet: parsed.sheet,
        hidden: node.getAttribute("hidden") === "1",
      };
    })
    .filter((range): range is BrevynSpreadsheetNamedRange => Boolean(range));
}

function chartMarkdown(chart: BrevynSpreadsheetChart): string {
  const lines = [
    `Chart: ${chart.title || chart.name}`,
    `Type: ${chart.type}`,
    chart.sourceRefs.length > 0 ? `Source: ${chart.sourceRefs.join(", ")}` : "",
  ].filter(Boolean);
  for (const series of chart.series) {
    const pairs = series.values.slice(0, 12).map((value, index) => `${series.categories[index] || index + 1}=${value}`);
    lines.push(`Series ${series.name || "Untitled"}: ${pairs.join(" | ")}`);
  }
  return lines.join("\n");
}

async function parseXlsxSheetRows(
  zip: JSZip,
  sheetPath: string,
  resources: XlsxSharedResources,
  limits: ImportLimits,
  artifactId: string,
  sheetIndex: number,
  sheetName: string,
): Promise<ParsedXlsxSheetRows> {
  const sheetXml = await zip.file(sheetPath)?.async("string");
  if (!sheetXml) {
    return { rows: [], totalRows: 0, totalColumns: 0, truncatedRows: false, truncatedColumns: false, columns: [], mergedCells: [], freezePanes: undefined, drawingCount: 0, charts: [], images: [], shapes: [], hyperlinks: [], comments: [], tables: [], assets: [] };
  }

  const doc = parseXml(sheetXml);
  const sheetDir = pathPosix.dirname(sheetPath);
  const sheetRelationships = await parseRelationshipDetails(zip, `${sheetDir}/_rels/${pathPosix.basename(sheetPath)}.rels`, sheetDir);
  const sheetRelationshipTargets = relationshipTargetMap(sheetRelationships);
  const hyperlinks = parseWorksheetHyperlinks(doc, sheetRelationshipTargets, artifactId, sheetIndex);
  const comments = await parseWorksheetComments(zip, sheetRelationships, artifactId, sheetIndex);
  const tables = await parseWorksheetTables(zip, doc, sheetRelationshipTargets, artifactId, sheetIndex);
  const hyperlinksByRef = mapByCellRef(hyperlinks);
  const commentIdsByRef = mapCommentIdsByRef(comments);
  const allRows = getElementsByLocalName(doc, "row");
  const rows: BrevynWorksheetRow[] = [];
  let totalColumns = 0;
  let truncatedRows = false;
  let truncatedColumns = false;

  for (const row of allRows) {
    if (rows.length >= limits.maxRowsPerSheet) {
      truncatedRows = true;
      break;
    }
    const cells: BrevynWorksheetCell[] = [];
    for (const cell of getDirectChildElementsByLocalName(row, "c")) {
      const cellRef = cell.getAttribute("r") || "";
      const columnIndex = columnIndexFromCellRef(cellRef);
      totalColumns = Math.max(totalColumns, columnIndex + 1);
      if (columnIndex >= limits.maxColumns) {
        truncatedColumns = true;
        continue;
      }
      const rowNumber = Number(row.getAttribute("r")) || rowNumberFromCellRef(cellRef) || rows.length + 1;
      const columnName = spreadsheetColumnName(columnIndex);
      const styleIndex = numberAttribute(cell, "s");
      const style = styleIndex != null ? resources.styles[styleIndex] : undefined;
      const formula = getFirstTextByLocalName(cell, "f") || undefined;
      const text = getXlsxCellText(cell, resources.sharedStrings, resources.dateStyleIndexes, style) || "";
      if (!text.trim() && !formula) continue;
      cells.push({
        id: `${sheetElementId(artifactId, sheetIndex)}:cell-${cellRef || `${columnName}${rowNumber}`}`,
        ref: cellRef || `${columnName}${rowNumber}`,
        row: rowNumber,
        column: columnIndex + 1,
        columnName,
        text,
        rawValue: getFirstTextByLocalName(cell, "v") || undefined,
        formula,
        type: cell.getAttribute("t") || undefined,
        styleIndex,
        style,
        hyperlink: hyperlinksByRef.get((cellRef || `${columnName}${rowNumber}`).toUpperCase()),
        commentIds: commentIdsByRef.get((cellRef || `${columnName}${rowNumber}`).toUpperCase()),
      });
    }
    if (cells.length > 0) {
      const rowNumber = Number(row.getAttribute("r"));
      rows.push({
        number: Number.isFinite(rowNumber) ? rowNumber : cells[0]?.row || rows.length + 1,
        heightPx: rowHeightPx(row),
        hidden: row.getAttribute("hidden") === "1",
        cells,
      });
    }
  }
  hydrateWorksheetFormulaValues(rows);

  const renderedColumnCount = Math.min(totalColumns, limits.maxColumns);
  const drawings = await parseSheetDrawings(zip, sheetPath, doc, artifactId, sheetIndex, sheetName, rows);
  return {
    rows,
    totalRows: allRows.length,
    totalColumns,
    truncatedRows,
    truncatedColumns,
    columns: parseWorksheetColumns(doc, renderedColumnCount),
    mergedCells: parseMergedCells(doc),
    freezePanes: parseFreezePanes(doc),
    drawingCount: getElementsByLocalName(doc, "drawing").length,
    charts: drawings.charts,
    images: drawings.images,
    shapes: drawings.shapes,
    hyperlinks,
    comments,
    tables,
    assets: drawings.assets,
  };
}

async function parseXlsxSharedStrings(zip: JSZip): Promise<string[]> {
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (!sharedXml) return [];
  const doc = parseXml(sharedXml);
  return getElementsByLocalName(doc, "si").map((si) => (
    getElementsByLocalName(si, "t").map((node) => node.textContent || "").join("")
  ));
}

async function parseXlsxDateStyleIndexes(zip: JSZip): Promise<Set<number>> {
  const stylesXml = await zip.file("xl/styles.xml")?.async("string");
  const dateStyleIndexes = new Set<number>();
  if (!stylesXml) return dateStyleIndexes;

  const doc = parseXml(stylesXml);
  const customFormats = new Map<number, string>();
  for (const numFmt of getElementsByLocalName(doc, "numFmt")) {
    const id = Number(numFmt.getAttribute("numFmtId"));
    const code = numFmt.getAttribute("formatCode") || "";
    if (Number.isFinite(id) && code) customFormats.set(id, code);
  }

  const cellXfs = getElementsByLocalName(doc, "cellXfs")[0];
  if (!cellXfs) return dateStyleIndexes;

  getDirectChildElementsByLocalName(cellXfs, "xf").forEach((xf, index) => {
    const numFmtId = Number(xf.getAttribute("numFmtId"));
    if (!Number.isFinite(numFmtId)) return;
    const customFormatCode = customFormats.get(numFmtId);
    if (isDateNumFmtId(numFmtId) || (customFormatCode && isDateFormatCode(customFormatCode))) {
      dateStyleIndexes.add(index);
    }
  });
  return dateStyleIndexes;
}

async function parseXlsxStyles(zip: JSZip): Promise<BrevynWorksheetCellStyle[]> {
  const stylesXml = await zip.file("xl/styles.xml")?.async("string");
  if (!stylesXml) return [];
  const doc = parseXml(stylesXml);
  const fonts = parseStyleFonts(doc);
  const fills = parseStyleFills(doc);
  const borders = parseStyleBorders(doc);
  const numberFormats = parseStyleNumberFormats(doc);
  const cellXfs = getElementsByLocalName(doc, "cellXfs")[0];
  if (!cellXfs) return [];
  return getDirectChildElementsByLocalName(cellXfs, "xf").map((xf) => {
    const font = fonts[numberAttribute(xf, "fontId") || 0] || {};
    const fill = fills[numberAttribute(xf, "fillId") || 0] || {};
    const border = borders[numberAttribute(xf, "borderId") || 0] || {};
    const alignment = getDirectChildElementsByLocalName(xf, "alignment")[0];
    const numFmtId = numberAttribute(xf, "numFmtId");
    return {
      ...font,
      ...fill,
      ...border,
      horizontalAlign: normalizeHorizontalAlign(alignment?.getAttribute("horizontal") || undefined),
      verticalAlign: normalizeVerticalAlign(alignment?.getAttribute("vertical") || undefined),
      wrapText: alignment?.getAttribute("wrapText") === "1",
      numberFormat: numFmtId != null ? numberFormats.get(numFmtId) : undefined,
    };
  });
}

function parseStyleBorders(doc: Document): BrevynWorksheetCellStyle[] {
  const borders = getElementsByLocalName(doc, "borders")[0];
  if (!borders) return [];
  return getDirectChildElementsByLocalName(borders, "border").map((border) => {
    const top = getDirectChildElementsByLocalName(border, "top")[0];
    const right = getDirectChildElementsByLocalName(border, "right")[0];
    const bottom = getDirectChildElementsByLocalName(border, "bottom")[0];
    const left = getDirectChildElementsByLocalName(border, "left")[0];
    const borderColor = parseColor(firstDirectChildElement(top, "color"))
      || parseColor(firstDirectChildElement(right, "color"))
      || parseColor(firstDirectChildElement(bottom, "color"))
      || parseColor(firstDirectChildElement(left, "color"));
    return {
      borderColor,
      borderTop: Boolean(top?.getAttribute("style")),
      borderRight: Boolean(right?.getAttribute("style")),
      borderBottom: Boolean(bottom?.getAttribute("style")),
      borderLeft: Boolean(left?.getAttribute("style")),
    };
  });
}

function parseStyleFonts(doc: Document): BrevynWorksheetCellStyle[] {
  const fonts = getElementsByLocalName(doc, "fonts")[0];
  if (!fonts) return [];
  return getDirectChildElementsByLocalName(fonts, "font").map((font) => ({
    bold: getDirectChildElementsByLocalName(font, "b").length > 0,
    italic: getDirectChildElementsByLocalName(font, "i").length > 0,
    underline: getDirectChildElementsByLocalName(font, "u").length > 0,
    fontSize: numberAttribute(getDirectChildElementsByLocalName(font, "sz")[0], "val"),
    fontColor: parseColor(getDirectChildElementsByLocalName(font, "color")[0]),
  }));
}

function parseStyleFills(doc: Document): BrevynWorksheetCellStyle[] {
  const fills = getElementsByLocalName(doc, "fills")[0];
  if (!fills) return [];
  return getDirectChildElementsByLocalName(fills, "fill").map((fill) => {
    const patternFill = getDirectChildElementsByLocalName(fill, "patternFill")[0];
    const patternType = patternFill?.getAttribute("patternType");
    if (!patternFill || patternType === "none") return {};
    return {
      fillColor: parseColor(getDirectChildElementsByLocalName(patternFill, "fgColor")[0]) || parseColor(getDirectChildElementsByLocalName(patternFill, "bgColor")[0]),
    };
  });
}

function parseStyleNumberFormats(doc: Document): Map<number, string> {
  const formats = new Map<number, string>([
    [0, "General"],
    [1, "0"],
    [2, "0.00"],
    [9, "0%"],
    [10, "0.00%"],
    [14, "m/d/yy"],
    [22, "m/d/yy h:mm"],
  ]);
  for (const numFmt of getElementsByLocalName(doc, "numFmt")) {
    const id = numberAttribute(numFmt, "numFmtId");
    const code = numFmt.getAttribute("formatCode");
    if (id != null && code) formats.set(id, code);
  }
  return formats;
}

function parseWorksheetColumns(doc: Document, columnCount: number): BrevynWorksheetColumn[] {
  const widths = new Map<number, number>();
  const hidden = new Set<number>();
  for (const col of getElementsByLocalName(doc, "col")) {
    const min = Math.max(1, numberAttribute(col, "min") || 1);
    const max = Math.max(min, numberAttribute(col, "max") || min);
    const widthPx = excelColumnWidthToPx(numberAttribute(col, "width"));
    for (let column = min; column <= max && column <= columnCount; column += 1) {
      widths.set(column, widthPx);
      if (col.getAttribute("hidden") === "1") hidden.add(column);
    }
  }
  return Array.from({ length: columnCount }, (_value, index) => ({
    index: index + 1,
    name: spreadsheetColumnName(index),
    widthPx: widths.get(index + 1) || 96,
    hidden: hidden.has(index + 1),
  }));
}

function parseFreezePanes(doc: Document): BrevynWorksheetFreezePanes | undefined {
  const pane = getElementsByLocalName(doc, "pane")[0];
  if (!pane || pane.getAttribute("state") !== "frozen") return undefined;
  return {
    frozenRows: Number(pane.getAttribute("ySplit") || 0) || 0,
    frozenColumns: Number(pane.getAttribute("xSplit") || 0) || 0,
    topLeftCell: pane.getAttribute("topLeftCell") || undefined,
  };
}

function parseWorksheetHyperlinks(
  doc: Document,
  relationships: Map<string, string>,
  artifactId: string,
  sheetIndex: number,
): BrevynSpreadsheetHyperlink[] {
  return getElementsByLocalName(doc, "hyperlink")
    .map((link, index): BrevynSpreadsheetHyperlink | undefined => {
      const ref = link.getAttribute("ref") || "";
      if (!ref) return undefined;
      const relationshipId = link.getAttribute("r:id") || link.getAttribute("id") || undefined;
      return {
        id: `${sheetElementId(artifactId, sheetIndex)}:hyperlink-${index + 1}`,
        ref,
        target: relationshipId ? relationships.get(relationshipId) : undefined,
        location: link.getAttribute("location") || undefined,
        display: link.getAttribute("display") || undefined,
        tooltip: link.getAttribute("tooltip") || undefined,
      };
    })
    .filter((link): link is BrevynSpreadsheetHyperlink => Boolean(link));
}

async function parseWorksheetComments(
  zip: JSZip,
  relationships: Map<string, XlsxRelationship>,
  artifactId: string,
  sheetIndex: number,
): Promise<BrevynSpreadsheetComment[]> {
  const commentRelationship = Array.from(relationships.values()).find((relationship) => relationship.type?.includes("/comments"));
  if (!commentRelationship) return [];
  const commentsXml = await zip.file(commentRelationship.target)?.async("string");
  if (!commentsXml) return [];
  const doc = parseXml(commentsXml);
  const authors = getElementsByLocalName(doc, "author").map((author) => author.textContent || "");
  return getElementsByLocalName(doc, "comment")
    .map((comment, index): BrevynSpreadsheetComment | undefined => {
      const ref = comment.getAttribute("ref") || "";
      if (!ref) return undefined;
      const authorIndex = Number(comment.getAttribute("authorId"));
      const text = getElementsByLocalName(comment, "t").map((node) => node.textContent || "").join("").replace(/\s+/g, " ").trim();
      if (!text) return undefined;
      return {
        id: `${sheetElementId(artifactId, sheetIndex)}:comment-${index + 1}`,
        ref,
        author: Number.isFinite(authorIndex) ? authors[authorIndex] : undefined,
        text,
      };
    })
    .filter((comment): comment is BrevynSpreadsheetComment => Boolean(comment));
}

async function parseWorksheetTables(
  zip: JSZip,
  doc: Document,
  relationships: Map<string, string>,
  artifactId: string,
  sheetIndex: number,
): Promise<BrevynSpreadsheetTable[]> {
  const tableParts = getElementsByLocalName(doc, "tablePart");
  const tables: BrevynSpreadsheetTable[] = [];
  for (const [index, tablePart] of tableParts.entries()) {
    const relationshipId = tablePart.getAttribute("r:id") || tablePart.getAttribute("id") || undefined;
    const tablePath = relationshipId ? relationships.get(relationshipId) : undefined;
    if (!tablePath) continue;
    const tableXml = await zip.file(tablePath)?.async("string");
    if (!tableXml) continue;
    const tableDoc = parseXml(tableXml);
    const table = getElementsByLocalName(tableDoc, "table")[0];
    if (!table) continue;
    const name = table.getAttribute("name") || table.getAttribute("displayName") || `Table${index + 1}`;
    const ref = table.getAttribute("ref") || "";
    if (!ref) continue;
    tables.push({
      id: `${sheetElementId(artifactId, sheetIndex)}:table-${index + 1}`,
      name,
      displayName: table.getAttribute("displayName") || undefined,
      ref,
      columns: getElementsByLocalName(table, "tableColumn").map((column) => column.getAttribute("name") || "").filter(Boolean),
      totalsRowShown: table.getAttribute("totalsRowShown") === "1",
    });
  }
  return tables;
}

function mapByCellRef<T extends { ref: string }>(items: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    for (const ref of expandCellRefs(item.ref)) map.set(ref, item);
  }
  return map;
}

function mapCommentIdsByRef(comments: BrevynSpreadsheetComment[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const comment of comments) {
    const key = normalizeCellReference(comment.ref);
    if (!key) continue;
    const existing = map.get(key) || [];
    existing.push(comment.id);
    map.set(key, existing);
  }
  return map;
}

function expandCellRefs(ref: string): string[] {
  const range = parseRangeRef(ref);
  if (!range) {
    const key = normalizeCellReference(ref);
    return key ? [key] : [];
  }
  const refs: string[] = [];
  const maxCells = 512;
  for (let row = range.startRow; row <= range.endRow && refs.length < maxCells; row += 1) {
    for (let column = range.startColumn; column <= range.endColumn && refs.length < maxCells; column += 1) {
      refs.push(`${spreadsheetColumnName(column - 1)}${row}`);
    }
  }
  return refs;
}

async function parseRelationships(zip: JSZip, relsPath: string, baseDir: string): Promise<Map<string, string>> {
  return relationshipTargetMap(await parseRelationshipDetails(zip, relsPath, baseDir));
}

async function parseRelationshipDetails(zip: JSZip, relsPath: string, baseDir: string): Promise<Map<string, XlsxRelationship>> {
  const relsXml = await zip.file(relsPath)?.async("string");
  const rels = new Map<string, XlsxRelationship>();
  if (!relsXml) return rels;
  const relsDoc = parseXml(relsXml);
  for (const rel of getElementsByLocalName(relsDoc, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) continue;
    const targetMode = rel.getAttribute("TargetMode") || undefined;
    rels.set(id, {
      id,
      type: rel.getAttribute("Type") || undefined,
      target: targetMode === "External" ? target : normalizeZipTarget(baseDir, target),
      targetMode,
    });
  }
  return rels;
}

function relationshipTargetMap(relationships: Map<string, XlsxRelationship>): Map<string, string> {
  const targets = new Map<string, string>();
  for (const [id, relationship] of relationships) targets.set(id, relationship.target);
  return targets;
}

async function parseSheetDrawings(
  zip: JSZip,
  sheetPath: string,
  sheetDoc: Document,
  artifactId: string,
  sheetIndex: number,
  sheetName: string,
  rows: BrevynWorksheetRow[],
): Promise<{ charts: BrevynSpreadsheetChart[]; images: BrevynSpreadsheetImage[]; shapes: BrevynSpreadsheetShape[]; assets: BrevynOfficeAsset[] }> {
  const drawingElements = getElementsByLocalName(sheetDoc, "drawing");
  if (drawingElements.length === 0) return { charts: [], images: [], shapes: [], assets: [] };
  const sheetDir = pathPosix.dirname(sheetPath);
  const sheetRelsPath = `${sheetDir}/_rels/${pathPosix.basename(sheetPath)}.rels`;
  const sheetRelationships = await parseRelationships(zip, sheetRelsPath, sheetDir);
  const charts: BrevynSpreadsheetChart[] = [];
  const images: BrevynSpreadsheetImage[] = [];
  const shapes: BrevynSpreadsheetShape[] = [];
  const assets: BrevynOfficeAsset[] = [];

  for (const drawingElement of drawingElements) {
    const relationshipId = drawingElement.getAttribute("r:id") || drawingElement.getAttribute("id");
    const drawingPath = relationshipId ? sheetRelationships.get(relationshipId) : undefined;
    if (!drawingPath) continue;
    const drawingXml = await zip.file(drawingPath)?.async("string");
    if (!drawingXml) continue;
    const drawingDoc = parseXml(drawingXml);
    const drawingDir = pathPosix.dirname(drawingPath);
    const drawingRelsPath = `${drawingDir}/_rels/${pathPosix.basename(drawingPath)}.rels`;
    const drawingRelationships = await parseRelationships(zip, drawingRelsPath, drawingDir);
    const anchors = [
      ...getElementsByLocalName(drawingDoc, "twoCellAnchor"),
      ...getElementsByLocalName(drawingDoc, "oneCellAnchor"),
      ...getElementsByLocalName(drawingDoc, "absoluteAnchor"),
    ];
    for (const anchor of anchors) {
      const chartRefs = getElementsByLocalName(anchor, "chart");
      for (const chartRef of chartRefs) {
        const chartRelationshipId = chartRef.getAttribute("r:id") || chartRef.getAttribute("id");
        const chartPath = chartRelationshipId ? drawingRelationships.get(chartRelationshipId) : undefined;
        if (!chartPath) continue;
        const chart = await parseSpreadsheetChart(zip, chartPath, artifactId, sheetIndex, sheetName, charts.length, anchor, rows);
        if (chart) charts.push(chart);
      }
      const imageRefs = getElementsByLocalName(anchor, "blip");
      for (const imageRef of imageRefs) {
        const embedId = imageRef.getAttribute("r:embed") || imageRef.getAttribute("embed") || imageRef.getAttribute("id");
        const imagePath = embedId ? drawingRelationships.get(embedId) : undefined;
        if (!imagePath || !imagePath.includes("/media/")) continue;
        const image = await parseSpreadsheetImage(zip, imagePath, artifactId, sheetIndex, sheetName, images.length, anchor);
        if (!image) continue;
        images.push(image.image);
        assets.push(image.asset);
      }
      const shape = parseSpreadsheetShape(anchor, artifactId, sheetIndex, sheetName, shapes.length);
      if (shape) shapes.push(shape);
    }
  }

  return { charts, images, shapes, assets };
}

async function parseSpreadsheetImage(
  zip: JSZip,
  imagePath: string,
  artifactId: string,
  sheetIndex: number,
  sheetName: string,
  imageIndex: number,
  anchor: Element,
): Promise<{ image: BrevynSpreadsheetImage; asset: BrevynOfficeAsset } | undefined> {
  const file = zip.file(imagePath);
  if (!file) return undefined;
  const bytes = await file.async("nodebuffer");
  const mediaType = mediaTypeForPath(imagePath);
  const assetId = `${sheetElementId(artifactId, sheetIndex)}:asset-image-${imageIndex + 1}`;
  const dataUrl = mediaType && bytes.length <= 2 * 1024 * 1024 ? `data:${mediaType};base64,${bytes.toString("base64")}` : undefined;
  const image: BrevynSpreadsheetImage = {
    id: `${sheetElementId(artifactId, sheetIndex)}:image-${imageIndex + 1}`,
    index: imageIndex,
    name: pathPosix.basename(imagePath),
    sheet: sheetName,
    assetId,
    mediaType,
    dataUrl,
    anchor: parseChartAnchor(anchor),
  };
  return {
    image,
    asset: {
      id: assetId,
      kind: "image",
      sourceLabel: `工作表 ${sheetName} 图片 ${imageIndex + 1}`,
      path: imagePath,
      mediaType,
      byteCount: bytes.length,
      dataUrl,
      elementIds: [image.id],
    },
  };
}

function parseSpreadsheetShape(
  anchor: Element,
  artifactId: string,
  sheetIndex: number,
  sheetName: string,
  shapeIndex: number,
): BrevynSpreadsheetShape | undefined {
  const shapeNode = firstDirectChildElement(anchor, "sp") || firstDirectChildElement(anchor, "cxnSp");
  if (!shapeNode) return undefined;
  const text = getElementsByLocalName(shapeNode, "t").map((node) => node.textContent || "").join("\n").replace(/\n{2,}/g, "\n").trim();
  const presetGeometry = getElementsByLocalName(shapeNode, "prstGeom")[0]?.getAttribute("prst") || undefined;
  const name = getElementsByLocalName(shapeNode, "cNvPr")[0]?.getAttribute("name") || `形状 ${shapeIndex + 1}`;
  const fillColor = chartSolidFillColor(firstDirectChildElement(shapeNode, "spPr"));
  const lineColor = chartSolidFillColor(getElementsByLocalName(shapeNode, "ln")[0]);
  if (!text && !presetGeometry && !fillColor && !lineColor) return undefined;
  return {
    id: `${sheetElementId(artifactId, sheetIndex)}:shape-${shapeIndex + 1}`,
    index: shapeIndex,
    name,
    sheet: sheetName,
    shapeType: presetGeometry,
    text,
    fillColor,
    lineColor,
    anchor: parseChartAnchor(anchor),
  };
}

async function parseSpreadsheetChart(
  zip: JSZip,
  chartPath: string,
  artifactId: string,
  sheetIndex: number,
  sheetName: string,
  chartIndex: number,
  anchor: Element,
  rows: BrevynWorksheetRow[],
): Promise<BrevynSpreadsheetChart | undefined> {
  const chartXml = await zip.file(chartPath)?.async("string");
  if (!chartXml) return undefined;
  const chartDoc = parseXml(chartXml);
  const type = spreadsheetChartType(chartDoc);
  const subtype = spreadsheetChartSubtype(chartDoc, type);
  const series = hydrateChartSeriesFromSheet(spreadsheetChartSeries(chartDoc, type), rows);
  const sourceRefs = Array.from(new Set(series.flatMap((item) => [item.categoryRef, item.valueRef].filter((value): value is string => Boolean(value)))));
  const title = chartTitle(chartDoc) || series[0]?.name || `图表 ${chartIndex + 1}`;
  const chart: BrevynSpreadsheetChart = {
    id: `${sheetElementId(artifactId, sheetIndex)}:chart-${chartIndex + 1}`,
    index: chartIndex,
    name: pathPosix.basename(chartPath, ".xml"),
    title,
    type,
    subtype,
    sheet: sheetName,
    anchor: parseChartAnchor(anchor),
    sourceRefs,
    series,
    style: spreadsheetChartStyle(chartDoc, type),
  };
  return {
    ...chart,
    render: renderSpreadsheetChart(chart),
  };
}

function spreadsheetChartType(chartDoc: Document): BrevynSpreadsheetChartType {
  return chartTypeEntries(chartDoc)[0]?.type || "unknown";
}

function chartTypeEntries(chartDoc: Document): Array<{ node: Element; type: BrevynSpreadsheetChartType }> {
  const known: Record<string, BrevynSpreadsheetChartType> = {
    barChart: "bar",
    bar3DChart: "bar",
    lineChart: "line",
    line3DChart: "line",
    pieChart: "pie",
    pie3DChart: "pie",
    doughnutChart: "doughnut",
    scatterChart: "scatter",
    areaChart: "area",
    area3DChart: "area",
    radarChart: "radar",
    bubbleChart: "bubble",
    stockChart: "stock",
    surfaceChart: "surface",
    surface3DChart: "surface",
    treemapChart: "treemap",
    sunburstChart: "sunburst",
    histogramChart: "histogram",
    boxWhiskerChart: "boxWhisker",
    waterfallChart: "waterfall",
  };
  const plotArea = getElementsByLocalName(chartDoc, "plotArea")[0];
  const roots = plotArea ? getDirectChildElements(plotArea) : getDirectChildElements(chartDoc);
  return roots.flatMap((node) => {
    const type = known[node.localName] || known[node.nodeName];
    return type ? [{ node, type }] : [];
  });
}

function spreadsheetChartSubtype(chartDoc: Document, type: BrevynSpreadsheetChartType): string | undefined {
  if (type === "bar") return getElementsByLocalName(chartDoc, "barDir")[0]?.getAttribute("val") || undefined;
  if (type === "scatter") return getElementsByLocalName(chartDoc, "scatterStyle")[0]?.getAttribute("val") || undefined;
  return getElementsByLocalName(chartDoc, "grouping")[0]?.getAttribute("val") || undefined;
}

function spreadsheetChartSeries(chartDoc: Document, type: BrevynSpreadsheetChartType): BrevynSpreadsheetChartSeries[] {
  const entries = chartTypeEntries(chartDoc);
  const chartEntries = entries.length > 0 ? entries : [{ node: chartNodeForType(chartDoc, type), type }].filter((entry): entry is { node: Element; type: BrevynSpreadsheetChartType } => Boolean(entry.node));
  const seriesNodes = chartEntries.flatMap((entry) => (
    getDirectChildElementsByLocalName(entry.node, "ser").map((seriesNode) => ({ seriesNode, seriesType: entry.type }))
  ));
  return seriesNodes.map(({ seriesNode, seriesType }, index) => {
    const name = chartSeriesName(seriesNode) || `Series ${index + 1}`;
    const categoryNode = firstDirectChildByLocalNames(seriesNode, seriesType === "scatter" || seriesType === "bubble" ? ["xVal", "cat"] : ["cat", "xVal"]);
    const valueNode = firstDirectChildByLocalNames(seriesNode, seriesType === "scatter" || seriesType === "bubble" ? ["yVal", "val"] : ["val", "yVal"]);
    const bubbleSizeNode = firstDirectChildByLocalNames(seriesNode, ["bubbleSize"]);
    const categories = chartCachedValues(categoryNode);
    const rawValues = chartCachedValues(valueNode);
    const rawBubbleSizes = chartCachedValues(bubbleSizeNode);
    const values = rawValues.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    const xValues = categories.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    const bubbleSizes = rawBubbleSizes.map((value) => Number(value)).filter((value) => Number.isFinite(value));
    return {
      name,
      categoryRef: chartFormula(categoryNode),
      valueRef: chartFormula(valueNode),
      xValueRef: chartFormula(categoryNode),
      yValueRef: chartFormula(valueNode),
      bubbleSizeRef: chartFormula(bubbleSizeNode),
      categories,
      values,
      xValues: xValues.length > 0 ? xValues : undefined,
      yValues: values,
      bubbleSizes: bubbleSizes.length > 0 ? bubbleSizes : undefined,
      rawValues,
      color: chartSolidFillColor(firstDirectChildElement(seriesNode, "spPr")),
      pointColors: chartPointColors(seriesNode, rawValues.length || values.length || categories.length),
      chartType: seriesType,
      axisGroup: chartAxisGroup(seriesNode),
      marker: chartMarker(seriesNode),
      smooth: booleanChildAttribute(seriesNode, "smooth"),
    };
  });
}

function spreadsheetChartStyle(chartDoc: Document, type: BrevynSpreadsheetChartType): BrevynSpreadsheetChartStyle {
  const chartNode = chartNodeForType(chartDoc, type);
  const dataLabels = chartDataLabels(chartNode);
  const style: BrevynSpreadsheetChartStyle = {
    grouping: chartGrouping(chartNode),
    barDirection: type === "bar" ? chartBarDirection(chartNode) : undefined,
    legendPosition: chartLegendPosition(chartDoc),
    dataLabels,
    holeSize: type === "doughnut" ? numberAttribute(getElementsByLocalName(chartDoc, "holeSize")[0], "val") : undefined,
    gapWidth: type === "bar" ? numberAttribute(getElementsByLocalName(chartDoc, "gapWidth")[0], "val") : undefined,
    firstSliceAngle: (type === "pie" || type === "doughnut") ? numberAttribute(getElementsByLocalName(chartDoc, "firstSliceAng")[0], "val") : undefined,
    axis: chartValueAxis(chartDoc),
  };
  return compactChartStyle(style);
}

function compactChartStyle(style: BrevynSpreadsheetChartStyle): BrevynSpreadsheetChartStyle {
  const next: BrevynSpreadsheetChartStyle = {};
  if (style.grouping) next.grouping = style.grouping;
  if (style.barDirection) next.barDirection = style.barDirection;
  if (style.legendPosition) next.legendPosition = style.legendPosition;
  if (style.dataLabels && Object.values(style.dataLabels).some((value) => value != null && value !== false)) next.dataLabels = style.dataLabels;
  if (style.holeSize != null) next.holeSize = style.holeSize;
  if (style.gapWidth != null) next.gapWidth = style.gapWidth;
  if (style.firstSliceAngle != null) next.firstSliceAngle = style.firstSliceAngle;
  if (style.axis && Object.values(style.axis).some((value) => value != null)) next.axis = style.axis;
  return next;
}

function chartLegendPosition(chartDoc: Document): BrevynSpreadsheetChartStyle["legendPosition"] {
  const value = getElementsByLocalName(chartDoc, "legendPos")[0]?.getAttribute("val");
  if (value === "r") return "right";
  if (value === "l") return "left";
  if (value === "t") return "top";
  if (value === "b") return "bottom";
  if (value === "none") return "none";
  return undefined;
}

function chartDataLabels(chartNode?: Element): BrevynSpreadsheetChartStyle["dataLabels"] {
  const labels = firstDirectChildElement(chartNode, "dLbls") || (chartNode ? getElementsByLocalName(chartNode, "dLbls")[0] : undefined);
  if (!labels) return undefined;
  return {
    showSeriesName: booleanChildAttribute(labels, "showSerName"),
    showCategoryName: booleanChildAttribute(labels, "showCatName"),
    showValue: booleanChildAttribute(labels, "showVal"),
    showPercent: booleanChildAttribute(labels, "showPercent"),
    position: getDirectChildElementsByLocalName(labels, "dLblPos")[0]?.getAttribute("val") || undefined,
  };
}

function chartGrouping(chartNode?: Element): BrevynSpreadsheetChartStyle["grouping"] {
  const value = chartNode ? getElementsByLocalName(chartNode, "grouping")[0]?.getAttribute("val") : undefined;
  if (value === "stacked") return "stacked";
  if (value === "percentStacked") return "percentStacked";
  if (value === "clustered") return "clustered";
  if (value === "standard") return "standard";
  return undefined;
}

function chartBarDirection(chartNode?: Element): BrevynSpreadsheetChartStyle["barDirection"] {
  const value = chartNode ? getElementsByLocalName(chartNode, "barDir")[0]?.getAttribute("val") : undefined;
  if (value === "bar" || value === "col") return value;
  return undefined;
}

function chartValueAxis(chartDoc: Document): BrevynSpreadsheetChartStyle["axis"] | undefined {
  const axis = getElementsByLocalName(chartDoc, "valAx")[0];
  const categoryAxis = getElementsByLocalName(chartDoc, "catAx")[0] || getElementsByLocalName(chartDoc, "dateAx")[0];
  const scaling = axis ? getElementsByLocalName(axis, "scaling")[0] : undefined;
  const numberFormat = axis ? getElementsByLocalName(axis, "numFmt")[0]?.getAttribute("formatCode") || undefined : undefined;
  const majorUnit = axis ? numberAttribute(getElementsByLocalName(axis, "majorUnit")[0], "val") : undefined;
  const categoryTitle = categoryAxis ? chartAxisTitle(categoryAxis) : undefined;
  const valueTitle = axis ? chartAxisTitle(axis) : undefined;
  if (!scaling && !numberFormat && majorUnit == null && !categoryTitle && !valueTitle) return undefined;
  return {
    valueMin: scaling ? numberAttribute(getElementsByLocalName(scaling, "min")[0], "val") : undefined,
    valueMax: scaling ? numberAttribute(getElementsByLocalName(scaling, "max")[0], "val") : undefined,
    majorUnit,
    categoryTitle,
    valueTitle,
    numberFormat,
  };
}

function chartAxisTitle(axis: Element): string | undefined {
  const title = firstDirectChildElement(axis, "title");
  const text = title ? titleText(title) : "";
  return text || undefined;
}

function chartAxisGroup(seriesNode: Element): BrevynSpreadsheetChartSeries["axisGroup"] {
  const value = getDirectChildElementsByLocalName(seriesNode, "axisGroup")[0]?.getAttribute("val");
  if (value === "secondary") return "secondary";
  if (value === "primary") return "primary";
  return undefined;
}

function chartMarker(seriesNode: Element): BrevynSpreadsheetChartSeries["marker"] {
  const marker = firstDirectChildElement(seriesNode, "marker");
  if (!marker) return undefined;
  const symbol = getDirectChildElementsByLocalName(marker, "symbol")[0]?.getAttribute("val") || undefined;
  const size = numberAttribute(getDirectChildElementsByLocalName(marker, "size")[0], "val");
  if (!symbol && size == null) return undefined;
  return { symbol, size };
}

function chartPointColors(seriesNode: Element, fallbackLength: number): string[] | undefined {
  const points = getDirectChildElementsByLocalName(seriesNode, "dPt");
  if (points.length === 0) return undefined;
  const colors: string[] = [];
  for (const point of points) {
    const index = numberChildAttribute(point, "idx", "val");
    const color = chartSolidFillColor(firstDirectChildElement(point, "spPr"));
    if (index != null && color) colors[index] = color;
  }
  if (fallbackLength > colors.length) {
    colors.length = fallbackLength;
  }
  return colors.some(Boolean) ? colors : undefined;
}

function chartSolidFillColor(root?: Element): string | undefined {
  if (!root) return undefined;
  const solidFill = getElementsByLocalName(root, "solidFill")[0];
  if (!solidFill) return undefined;
  const srgb = getElementsByLocalName(solidFill, "srgbClr")[0]?.getAttribute("val");
  if (srgb) return `#${srgb.slice(-6)}`;
  const scheme = getElementsByLocalName(solidFill, "schemeClr")[0]?.getAttribute("val");
  return chartSchemeColor(scheme);
}

function chartSchemeColor(value?: string | null): string | undefined {
  if (!value) return undefined;
  const palette: Record<string, string> = {
    accent1: "#4472C4",
    accent2: "#ED7D31",
    accent3: "#A5A5A5",
    accent4: "#FFC000",
    accent5: "#5B9BD5",
    accent6: "#70AD47",
    tx1: "#000000",
    tx2: "#44546A",
  };
  return palette[value];
}

function hydrateChartSeriesFromSheet(series: BrevynSpreadsheetChartSeries[], rows: BrevynWorksheetRow[]): BrevynSpreadsheetChartSeries[] {
  const cells = worksheetCellTextMap(rows);
  return series.map((item) => {
    const rawValues = item.rawValues.length > 0 ? item.rawValues : valuesForRange(item.valueRef, cells);
    const values = item.values.length > 0
      ? item.values
      : rawValues.map((value) => Number(normalizeNumericText(value))).filter((value) => Number.isFinite(value));
    let categories = item.categories.length > 0 ? item.categories : valuesForRange(item.categoryRef, cells);
    const xRawValues = item.xValues && item.xValues.length > 0 ? item.xValues.map(String) : valuesForRange(item.xValueRef, cells);
    const xValues = item.xValues && item.xValues.length > 0
      ? item.xValues
      : xRawValues.map((value) => Number(normalizeNumericText(value))).filter((value) => Number.isFinite(value));
    const bubbleRawValues = item.bubbleSizes && item.bubbleSizes.length > 0 ? item.bubbleSizes.map(String) : valuesForRange(item.bubbleSizeRef, cells);
    const bubbleSizes = item.bubbleSizes && item.bubbleSizes.length > 0
      ? item.bubbleSizes
      : bubbleRawValues.map((value) => Number(normalizeNumericText(value))).filter((value) => Number.isFinite(value));
    const name = item.name && !looksLikeCellRefText(item.name) ? item.name : valuesForRange(item.name, cells)[0] || item.name;
    if (categories.length === 0 && item.valueRef) {
      categories = inferAdjacentCategoryValues(item.valueRef, cells);
    }
    if (categories.length === 0) {
      categories = values.map((_value, index) => String(index + 1));
    }
    return {
      ...item,
      name,
      categories: categories.slice(0, values.length || categories.length),
      values,
      xValues: xValues.length > 0 ? xValues : item.xValues,
      yValues: values.length > 0 ? values : item.yValues,
      bubbleSizes: bubbleSizes.length > 0 ? bubbleSizes : item.bubbleSizes,
      rawValues,
    };
  });
}

function hydrateWorksheetFormulaValues(rows: BrevynWorksheetRow[]): void {
  const cells = worksheetCellTextMap(rows);
  let changed = false;
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!cell.formula || hasResolvedFormulaText(cell) || formulaHasSheetReference(cell.formula)) continue;
      const value = evaluateSimpleFormula(cell.formula, cells);
      if (value == null) continue;
      cell.text = formatFormulaResult(value);
      cell.rawValue = cell.text;
      cells.set(cell.ref.toUpperCase(), cell.text);
      changed = true;
    }
  }
  if (!changed) return;
  for (const row of rows) {
    for (const cell of row.cells) {
      if (!cell.formula || hasResolvedFormulaText(cell) || formulaHasSheetReference(cell.formula)) continue;
      const value = evaluateSimpleFormula(cell.formula, cells);
      if (value == null) continue;
      cell.text = formatFormulaResult(value);
      cell.rawValue = cell.text;
      cells.set(cell.ref.toUpperCase(), cell.text);
    }
  }
}

function hydrateWorkbookFormulaValues(sheets: BrevynWorksheetModel[]): void {
  const sheetMaps = new Map<string, Map<string, string>>();
  for (const sheet of sheets) {
    sheetMaps.set(normalizeSheetKey(sheet.name), worksheetCellTextMap(sheet.rows));
  }

  for (let pass = 0; pass < 6; pass += 1) {
    let changed = false;
    for (const sheet of sheets) {
      const cells = sheetMaps.get(normalizeSheetKey(sheet.name));
      if (!cells) continue;
      const context: FormulaEvaluationContext = { currentSheet: sheet.name, cells, sheets: sheetMaps };
      for (const row of sheet.rows) {
        for (const cell of row.cells) {
          if (!cell.formula || hasResolvedFormulaText(cell)) continue;
          const value = evaluateSimpleFormula(cell.formula, context);
          if (value == null) continue;
          const text = formatFormulaResult(value);
          if (!text || text === cell.text) continue;
          cell.text = text;
          cell.rawValue = text;
          cells.set(cell.ref.toUpperCase(), text);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
}

type FormulaPrimitive = number | string | boolean;

function evaluateSimpleFormula(formula: string, cells: FormulaEvaluationContext | Map<string, string>): FormulaPrimitive | null {
  const normalized = normalizeFormulaExpression(formula);
  const call = normalized.match(/^([A-Z0-9._]+)\((.*)\)$/i);
  if (!call) return evaluateArithmeticFormula(normalized, cells);
  const value = evaluateFormulaCall(call[1], call[2], cells);
  if (value != null) return value;
  return evaluateArithmeticFormula(normalized, cells);
}

function evaluateFormulaCall(functionName: string, rawArgs: string, cells: FormulaEvaluationContext | Map<string, string>): FormulaPrimitive | null {
  const fn = functionName.toUpperCase();
  const args = splitFormulaArguments(rawArgs);
  if (fn === "AVERAGE") {
    const values = args.flatMap((arg) => numericValuesForFormulaArg(arg, cells));
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  if (fn === "SUM") {
    const values = args.flatMap((arg) => numericValuesForFormulaArg(arg, cells));
    return values.reduce((sum, value) => sum + value, 0);
  }
  if (fn === "MIN") {
    const values = args.flatMap((arg) => numericValuesForFormulaArg(arg, cells));
    return values.length > 0 ? Math.min(...values) : null;
  }
  if (fn === "MAX") {
    const values = args.flatMap((arg) => numericValuesForFormulaArg(arg, cells));
    return values.length > 0 ? Math.max(...values) : null;
  }
  if (fn === "COUNT") {
    return args.flatMap((arg) => numericValuesForFormulaArg(arg, cells)).length;
  }
  if (fn === "COUNTA") {
    return args.flatMap((arg) => textValuesForFormulaArg(arg, cells, true)).filter((value) => value !== "").length;
  }
  if (fn === "COUNTBLANK") {
    return args.flatMap((arg) => allValuesForRange(arg, cells)).filter((value) => value === "").length;
  }
  if (fn === "MEDIAN") {
    const values = args.flatMap((arg) => numericValuesForFormulaArg(arg, cells)).sort((a, b) => a - b);
    if (values.length === 0) return null;
    const middle = Math.floor(values.length / 2);
    return values.length % 2 ? values[middle] : ((values[middle - 1] || 0) + (values[middle] || 0)) / 2;
  }
  if (fn === "STDEV.S" || fn === "STDEVS" || fn === "STDEV") {
    return standardDeviation(args.flatMap((arg) => numericValuesForFormulaArg(arg, cells)), true);
  }
  if (fn === "STDEV.P" || fn === "STDEVP") {
    return standardDeviation(args.flatMap((arg) => numericValuesForFormulaArg(arg, cells)), false);
  }
  if (fn === "ROUND") {
    if (args.length < 1) return null;
    const value = firstValueForFormulaArg(args[0], cells);
    if (value == null) return null;
    const digits = args.length > 1 ? Math.round(firstValueForFormulaArg(args[1], cells) ?? 0) : 0;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }
  if (fn === "ABS" || fn === "INT" || fn === "SQRT") {
    const value = firstValueForFormulaArg(args[0], cells);
    if (value == null) return null;
    if (fn === "ABS") return Math.abs(value);
    if (fn === "INT") return Math.floor(value);
    return value >= 0 ? Math.sqrt(value) : null;
  }
  if (fn === "SUMIF" || fn === "AVERAGEIF") {
    if (args.length < 2) return null;
    const criteriaValues = valuesForRange(args[0], cells);
    const targetValues = args[2] ? valuesForRange(args[2], cells) : criteriaValues;
    const matched = targetValues
      .filter((_value, index) => formulaCriteriaMatches(criteriaValues[index] || "", args[1]))
      .map((value) => Number(normalizeNumericText(value)))
      .filter((value) => Number.isFinite(value));
    if (fn === "SUMIF") return matched.reduce((sum, value) => sum + value, 0);
    return matched.length > 0 ? matched.reduce((sum, value) => sum + value, 0) / matched.length : null;
  }
  if (fn === "SUMIFS" || fn === "AVERAGEIFS") {
    if (args.length < 3 || args.length % 2 !== 1) return null;
    const targetValues = valuesForRange(args[0], cells);
    const criteriaRanges: string[][] = [];
    const criteria: string[] = [];
    for (let index = 1; index < args.length; index += 2) {
      const values = valuesForRange(args[index], cells);
      if (values.length === 0) return null;
      criteriaRanges.push(values);
      criteria.push(args[index + 1]);
    }
    const matched = targetValues
      .filter((_value, rowIndex) => criteriaRanges.every((values, criteriaIndex) => formulaCriteriaMatches(values[rowIndex] || "", criteria[criteriaIndex])))
      .map((value) => Number(normalizeNumericText(value)))
      .filter((value) => Number.isFinite(value));
    if (fn === "SUMIFS") return matched.reduce((sum, value) => sum + value, 0);
    return matched.length > 0 ? matched.reduce((sum, value) => sum + value, 0) / matched.length : null;
  }
  if (fn === "IF") {
    if (args.length < 2) return null;
    const condition = evaluateFormulaCondition(args[0], cells);
    const selected = condition ? args[1] : args[2];
    if (selected == null) return null;
    return valueForFormulaArg(selected, cells);
  }
  if (fn === "IFERROR") {
    if (args.length < 2) return null;
    if (looksLikeFormulaExpression(args[0]) && evaluateArithmeticFormula(args[0], cells) == null && evaluateFormulaCallExpression(args[0], cells) == null) {
      return valueForFormulaArg(args[1], cells);
    }
    const value = valueForFormulaArg(args[0], cells);
    if (value == null || isFormulaError(value)) return valueForFormulaArg(args[1], cells);
    return value;
  }
  if (fn === "IFS") {
    if (args.length < 2) return null;
    for (let index = 0; index < args.length - 1; index += 2) {
      if (evaluateFormulaCondition(args[index], cells)) return valueForFormulaArg(args[index + 1], cells);
    }
    return null;
  }
  if (fn === "AND" || fn === "OR") {
    const values = args.map((arg) => Boolean(valueForFormulaArg(arg, cells)));
    return fn === "AND" ? values.every(Boolean) : values.some(Boolean);
  }
  if (fn === "NOT") {
    return !Boolean(valueForFormulaArg(args[0], cells));
  }
  if (fn === "SUMPRODUCT") {
    const vectors = args.map((arg) => numericValuesForFormulaArg(arg, cells)).filter((values) => values.length > 0);
    if (vectors.length === 0) return null;
    const length = Math.min(...vectors.map((values) => values.length));
    let total = 0;
    for (let index = 0; index < length; index += 1) {
      total += vectors.reduce((product, values) => product * (values[index] || 0), 1);
    }
    return total;
  }
  if (fn === "VLOOKUP" || fn === "HLOOKUP") {
    if (args.length < 3) return null;
    const lookup = valueForFormulaArg(args[0], cells);
    const matrix = matrixForRange(args[1], cells);
    const offset = Math.max(1, Math.round(firstValueForFormulaArg(args[2], cells) ?? Number(args[2]))) - 1;
    const exact = args[3] == null || isFalseFormulaValue(valueForFormulaArg(args[3], cells));
    const found = fn === "VLOOKUP" ? lookupVertical(lookup, matrix, offset, exact) : lookupHorizontal(lookup, matrix, offset, exact);
    return found;
  }
  if (fn === "XLOOKUP") {
    if (args.length < 3) return null;
    const lookup = valueForFormulaArg(args[0], cells);
    const lookupValues = allValuesForRange(args[1], cells);
    const returnValues = allValuesForRange(args[2], cells);
    const fallback = args[3] != null ? valueForFormulaArg(args[3], cells) : null;
    const matchMode = Math.round(firstValueForFormulaArg(args[4], cells) ?? 0);
    const index = matchFormulaIndex(lookup, lookupValues, matchMode);
    return index >= 0 ? returnValues[index] ?? "" : fallback;
  }
  if (fn === "INDEX") {
    if (args.length < 2) return null;
    const matrix = matrixForRange(args[0], cells);
    const row = Math.max(1, Math.round((firstValueForFormulaArg(args[1], cells) ?? Number(args[1])) || 1)) - 1;
    const column = Math.max(1, Math.round((firstValueForFormulaArg(args[2], cells) ?? Number(args[2])) || 1)) - 1;
    return matrix[row]?.[column] ?? null;
  }
  if (fn === "MATCH") {
    if (args.length < 2) return null;
    const lookup = valueForFormulaArg(args[0], cells);
    const values = allValuesForRange(args[1], cells);
    const matchMode = Math.round(firstValueForFormulaArg(args[2], cells) ?? 1);
    const index = matchFormulaIndex(lookup, values, matchMode);
    return index >= 0 ? index + 1 : null;
  }
  if (fn === "DATE") {
    if (args.length < 3) return null;
    const year = Math.round(firstValueForFormulaArg(args[0], cells) ?? NaN);
    const month = Math.round(firstValueForFormulaArg(args[1], cells) ?? NaN);
    const day = Math.round(firstValueForFormulaArg(args[2], cells) ?? NaN);
    return formatFormulaDate(year, month, day);
  }
  if (fn === "TODAY" || fn === "NOW") {
    return new Date().toISOString().slice(0, fn === "TODAY" ? 10 : 16).replace("T", " ");
  }
  if (fn === "YEAR" || fn === "MONTH" || fn === "DAY") {
    const date = formulaDateFromValue(valueForFormulaArg(args[0], cells));
    if (!date) return null;
    if (fn === "YEAR") return date.getUTCFullYear();
    if (fn === "MONTH") return date.getUTCMonth() + 1;
    return date.getUTCDate();
  }
  if (fn === "EOMONTH") {
    const date = formulaDateFromValue(valueForFormulaArg(args[0], cells));
    const months = Math.round(firstValueForFormulaArg(args[1], cells) ?? 0);
    if (!date) return null;
    const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months + 1, 0));
    return end.toISOString().slice(0, 10);
  }
  if (fn === "DATEDIF") {
    const start = formulaDateFromValue(valueForFormulaArg(args[0], cells));
    const end = formulaDateFromValue(valueForFormulaArg(args[1], cells));
    const unit = String(valueForFormulaArg(args[2], cells) ?? "D").toUpperCase();
    if (!start || !end) return null;
    return formulaDateDiff(start, end, unit);
  }
  if (fn === "FILTER") {
    if (args.length < 2) return null;
    const values = allValuesForRange(args[0], cells);
    const includeNumbers = numericCriteriaValuesForFormulaArg(args[1], cells);
    const include = includeNumbers ? includeNumbers.map(String) : allValuesForRange(args[1], cells);
    if (values.length === 0 || include.length === 0) return args[2] != null ? valueForFormulaArg(args[2], cells) : null;
    const filtered = values.filter((_value, index) => formulaTruthValue(include[index] || ""));
    if (filtered.length === 0) return args[2] != null ? valueForFormulaArg(args[2], cells) : "";
    return filtered.filter((value) => value !== "").join(", ");
  }
  if (fn === "UNIQUE") {
    const values = textValuesForFormulaArg(args[0], cells, false);
    const unique = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
    return unique.join(", ");
  }
  if (fn === "SORT") {
    const values = textValuesForFormulaArg(args[0], cells, false);
    const order = Math.round(firstValueForFormulaArg(args[2], cells) ?? 1);
    const sorted = [...values].sort((left, right) => naturalFormulaCompare(left, right));
    if (order < 0) sorted.reverse();
    return sorted.join(", ");
  }
  if (fn === "LEFT" || fn === "RIGHT") {
    const text = firstValueForFormulaTextArg(args[0], cells) ?? "";
    const count = Math.max(0, Math.round(firstValueForFormulaArg(args[1], cells) ?? text.length));
    return fn === "LEFT" ? text.slice(0, count) : text.slice(Math.max(0, text.length - count));
  }
  if (fn === "MID") {
    const text = firstValueForFormulaTextArg(args[0], cells) ?? "";
    const start = Math.max(1, Math.round(firstValueForFormulaArg(args[1], cells) ?? 1)) - 1;
    const count = Math.max(0, Math.round(firstValueForFormulaArg(args[2], cells) ?? text.length));
    return text.slice(start, start + count);
  }
  if (fn === "LEN") {
    return (firstValueForFormulaTextArg(args[0], cells) ?? "").length;
  }
  if (fn === "TRIM" || fn === "UPPER" || fn === "LOWER") {
    const text = firstValueForFormulaTextArg(args[0], cells) ?? String(valueForFormulaArg(args[0], cells) ?? "");
    if (fn === "TRIM") return text.replace(/\s+/g, " ").trim();
    if (fn === "UPPER") return text.toUpperCase();
    return text.toLowerCase();
  }
  if (fn === "SUBSTITUTE") {
    const text = firstValueForFormulaTextArg(args[0], cells) ?? String(valueForFormulaArg(args[0], cells) ?? "");
    const oldText = String(valueForFormulaArg(args[1], cells) ?? "");
    const newText = String(valueForFormulaArg(args[2], cells) ?? "");
    const occurrence = args[3] != null ? Math.round(firstValueForFormulaArg(args[3], cells) ?? 0) : 0;
    return substituteText(text, oldText, newText, occurrence);
  }
  if (fn === "VALUE") {
    const text = firstValueForFormulaTextArg(args[0], cells) ?? String(valueForFormulaArg(args[0], cells) ?? "");
    const numeric = Number(normalizeNumericText(text));
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (fn === "TEXT") {
    const value = valueForFormulaArg(args[0], cells);
    const format = String(valueForFormulaArg(args[1], cells) ?? "");
    return formatFormulaText(value, format);
  }
  if (fn === "CONCAT" || fn === "CONCATENATE") {
    return args.flatMap((arg) => textValuesForFormulaArg(arg, cells, true)).join("");
  }
  if (fn === "TEXTJOIN") {
    if (args.length < 3) return null;
    const delimiterValue = valueForFormulaArg(args[0], cells);
    const delimiter = delimiterValue == null ? "" : String(delimiterValue);
    const ignoreEmpty = Boolean(valueForFormulaArg(args[1], cells));
    const values = args.slice(2).flatMap((arg) => textValuesForFormulaArg(arg, cells, true));
    return values.filter((value) => !ignoreEmpty || value !== "").join(delimiter);
  }
  if (fn === "COUNTIF") {
    if (args.length < 2) return null;
    return countMatchingValues(valuesForRange(args[0], cells), args[1]);
  }
  if (fn === "COUNTIFS") {
    if (args.length < 2 || args.length % 2 !== 0) return null;
    const ranges: string[][] = [];
    const criteria: string[] = [];
    for (let index = 0; index < args.length; index += 2) {
      const values = valuesForRange(args[index], cells);
      if (values.length === 0) return null;
      ranges.push(values);
      criteria.push(args[index + 1]);
    }
    const length = Math.min(...ranges.map((values) => values.length));
    let total = 0;
    for (let rowIndex = 0; rowIndex < length; rowIndex += 1) {
      if (ranges.every((values, rangeIndex) => formulaCriteriaMatches(values[rowIndex] || "", criteria[rangeIndex]))) total += 1;
    }
    return total;
  }
  return null;
}

function evaluateArithmeticFormula(formula: string, cells: FormulaEvaluationContext | Map<string, string>): number | null {
  let expression = normalizeFormulaExpression(formula);
  for (let guard = 0; guard < 8; guard += 1) {
    let replaced = false;
    expression = expression.replace(/([A-Z0-9._]+)\(([^()]*)\)/gi, (match, functionName: string, rawArgs: string) => {
      const value = evaluateFormulaCall(functionName, rawArgs, cells);
      const numeric = asFormulaNumber(value);
      if (numeric == null) return match;
      replaced = true;
      return String(numeric);
    });
    if (!replaced) break;
  }
  expression = expression.replace(/((?:'[^']+'|[A-Za-z0-9_ .]+)!)?\$?([A-Z]{1,3})\$?(\d+)/gi, (match) => {
    const value = firstValueForFormulaArg(match, cells);
    return value == null ? "__UNRESOLVED_REF__" : String(value);
  });
  expression = expression.replace(/(\d+(?:\.\d+)?)%/g, (_match, value: string) => String(Number(value) / 100));
  if (!/^[\d+\-*/().\s]+$/.test(expression)) return null;
  try {
    const value = Function(`"use strict"; return (${expression});`)();
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function evaluateFormulaCallExpression(expression: string, cells: FormulaEvaluationContext | Map<string, string>): FormulaPrimitive | null {
  const call = normalizeFormulaExpression(expression).match(/^([A-Z0-9._]+)\((.*)\)$/i);
  return call ? evaluateFormulaCall(call[1], call[2], cells) : null;
}

function looksLikeFormulaExpression(value: string): boolean {
  return /[+\-*/^<>=()]|[A-Z0-9._]+\(/i.test(value);
}

function formulaHasSheetReference(value: string): boolean {
  return /(?:'[^']+'|[A-Za-z0-9_ .]+)!\$?[A-Z]{1,3}\$?\d+/i.test(value);
}

function looksLikeFormulaReferenceExpression(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(parseFormulaReference(trimmed) || parseRangeRef(trimmed));
}

function splitFormulaArguments(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (const char of value) {
    if ((char === "'" || char === "\"") && quote === char) quote = null;
    else if ((char === "'" || char === "\"") && !quote) quote = char;
    else if (!quote && char === "(") depth += 1;
    else if (!quote && char === ")") depth = Math.max(0, depth - 1);
    if (!quote && depth === 0 && (char === "," || char === ";")) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

function numericValuesForFormulaArg(arg: string | undefined, cells: FormulaEvaluationContext | Map<string, string>): number[] {
  if (arg == null) return [];
  const productValues = numericProductValuesForFormulaArg(arg, cells);
  if (productValues) return productValues;
  const criteriaValues = numericCriteriaValuesForFormulaArg(arg, cells);
  if (criteriaValues) return criteriaValues;
  const literal = Number(normalizeNumericText(arg));
  if (Number.isFinite(literal)) return [literal];
  const rangeValues = valuesForRange(arg, cells)
    .map((value) => Number(normalizeNumericText(value)))
    .filter((value) => Number.isFinite(value));
  if (rangeValues.length > 0) return rangeValues;
  const value = valueForFormulaArg(arg, cells);
  if (typeof value === "number") return [value];
  return [];
}

function numericProductValuesForFormulaArg(arg: string, cells: FormulaEvaluationContext | Map<string, string>): number[] | null {
  const factors = splitFormulaProduct(stripWrappingParens(arg));
  if (factors.length <= 1) return null;
  const vectors = factors.map((factor) => numericValuesForFormulaArg(stripWrappingParens(factor), cells));
  if (vectors.some((vector) => vector.length === 0)) return null;
  const length = Math.max(...vectors.map((vector) => vector.length));
  return Array.from({ length }, (_value, index) => vectors.reduce((product, vector) => product * (vector.length === 1 ? vector[0] || 0 : vector[index] || 0), 1));
}

function numericCriteriaValuesForFormulaArg(arg: string, cells: FormulaEvaluationContext | Map<string, string>): number[] | null {
  const comparison = stripWrappingParens(arg).match(/^(.+?)(>=|<=|<>|>|<|=)(.+)$/);
  if (!comparison) return null;
  const rangeValues = allValuesForRange(comparison[1], cells);
  if (rangeValues.length === 0) return null;
  const criteria = `${comparison[2]}${unquoteFormulaString(comparison[3])}`;
  return rangeValues.map((value) => formulaCriteriaMatches(value, criteria) ? 1 : 0);
}

function splitFormulaProduct(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (const char of value) {
    if ((char === "'" || char === "\"") && quote === char) quote = null;
    else if ((char === "'" || char === "\"") && !quote) quote = char;
    else if (!quote && char === "(") depth += 1;
    else if (!quote && char === ")") depth = Math.max(0, depth - 1);
    if (!quote && depth === 0 && char === "*") {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function stripWrappingParens(value: string): string {
  let trimmed = value.trim();
  while (trimmed.startsWith("(") && trimmed.endsWith(")") && hasWrappingParens(trimmed)) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function hasWrappingParens(value: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === "\"") && quote === char) quote = null;
    else if ((char === "'" || char === "\"") && !quote) quote = char;
    else if (!quote && char === "(") depth += 1;
    else if (!quote && char === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0;
}

function firstValueForFormulaArg(arg: string | undefined, cells: FormulaEvaluationContext | Map<string, string>): number | null {
  const values = numericValuesForFormulaArg(arg, cells);
  return values.length > 0 ? values[0] : null;
}

function countMatchingValues(values: string[], rawCriteria: string): number {
  return values.reduce((count, value) => count + (formulaCriteriaMatches(value, rawCriteria) ? 1 : 0), 0);
}

function valueForFormulaArg(arg: string | undefined, cells: FormulaEvaluationContext | Map<string, string>): FormulaPrimitive | null {
  if (arg == null) return null;
  const trimmed = arg.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return unquoteFormulaString(trimmed);
  if (/^TRUE$/i.test(trimmed)) return true;
  if (/^FALSE$/i.test(trimmed)) return false;
  const numeric = Number(normalizeNumericText(trimmed.replace(/%$/, "")));
  if (Number.isFinite(numeric)) return trimmed.endsWith("%") ? numeric / 100 : numeric;
  const directValue = firstValueForFormulaTextArg(trimmed, cells);
  if (directValue != null) {
    const directNumeric = Number(normalizeNumericText(directValue));
    return Number.isFinite(directNumeric) ? directNumeric : directValue;
  }
  if (looksLikeFormulaReferenceExpression(trimmed)) return null;
  const call = trimmed.match(/^([A-Z0-9._]+)\((.*)\)$/i);
  if (call) return evaluateFormulaCall(call[1], call[2], cells);
  const arithmetic = evaluateArithmeticFormula(trimmed, cells);
  return arithmetic ?? unquoteFormulaString(trimmed);
}

function textValuesForFormulaArg(arg: string, cells: FormulaEvaluationContext | Map<string, string>, includeBlanks = false): string[] {
  const rangeValues = includeBlanks ? allValuesForRange(arg, cells) : valuesForRange(arg, cells);
  if (rangeValues.length > 0) return includeBlanks ? rangeValues : rangeValues.filter((value) => value !== "");
  const value = valueForFormulaArg(arg, cells);
  if (value == null) return [];
  return [formatFormulaResult(value)];
}

function asFormulaNumber(value: FormulaPrimitive | null): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const numeric = Number(normalizeNumericText(value));
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function isFalseFormulaValue(value: FormulaPrimitive | null): boolean {
  if (value == null) return false;
  if (typeof value === "boolean") return value === false;
  if (typeof value === "number") return value === 0;
  return /^false$/i.test(value.trim()) || value.trim() === "0";
}

function isFormulaError(value: FormulaPrimitive): boolean {
  return typeof value === "string" && /^#(?:DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!)$/i.test(value.trim());
}

function formulaTruthValue(value: FormulaPrimitive | string | null): boolean {
  if (value == null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim();
  if (!text) return false;
  if (/^true$/i.test(text)) return true;
  if (/^false$/i.test(text)) return false;
  const numeric = Number(normalizeNumericText(text));
  return Number.isFinite(numeric) ? numeric !== 0 : true;
}

function formatFormulaDate(year: number, month: number, day: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function formulaDateFromValue(value: FormulaPrimitive | null): Date | null {
  if (value == null) return null;
  if (typeof value === "number") return excelSerialDateToDate(value);
  const text = String(value).trim();
  if (!text) return null;
  const numeric = Number(normalizeNumericText(text));
  if (Number.isFinite(numeric)) return excelSerialDateToDate(numeric);
  const direct = new Date(text);
  return Number.isFinite(direct.getTime()) ? new Date(Date.UTC(direct.getFullYear(), direct.getMonth(), direct.getDate())) : null;
}

function excelSerialDateToDate(serial: number): Date | null {
  if (!Number.isFinite(serial)) return null;
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + Math.round(serial) * 86_400_000);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formulaDateDiff(start: Date, end: Date, unit: string): number {
  const msPerDay = 86_400_000;
  if (unit === "Y") {
    let years = end.getUTCFullYear() - start.getUTCFullYear();
    if (Date.UTC(end.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()) > end.getTime()) years -= 1;
    return years;
  }
  if (unit === "M") {
    let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
    if (end.getUTCDate() < start.getUTCDate()) months -= 1;
    return months;
  }
  if (unit === "YM") return ((formulaDateDiff(start, end, "M") % 12) + 12) % 12;
  if (unit === "YD") {
    const aligned = new Date(Date.UTC(end.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    if (aligned > end) aligned.setUTCFullYear(aligned.getUTCFullYear() - 1);
    return Math.floor((end.getTime() - aligned.getTime()) / msPerDay);
  }
  if (unit === "MD") {
    const aligned = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), start.getUTCDate()));
    if (aligned > end) aligned.setUTCMonth(aligned.getUTCMonth() - 1);
    return Math.floor((end.getTime() - aligned.getTime()) / msPerDay);
  }
  return Math.floor((end.getTime() - start.getTime()) / msPerDay);
}

function substituteText(text: string, oldText: string, newText: string, occurrence: number): string {
  if (!oldText) return text;
  if (!occurrence || occurrence < 1) return text.split(oldText).join(newText);
  let seen = 0;
  let cursor = 0;
  let result = "";
  while (cursor < text.length) {
    const index = text.indexOf(oldText, cursor);
    if (index < 0) return result + text.slice(cursor);
    seen += 1;
    result += text.slice(cursor, index);
    result += seen === occurrence ? newText : oldText;
    cursor = index + oldText.length;
  }
  return result;
}

function formatFormulaText(value: FormulaPrimitive | null, format: string): string {
  if (value == null) return "";
  const number = asFormulaNumber(value);
  if (number == null) return String(value);
  if (format.includes("%")) return `${Math.round(number * 1000) / 10}%`;
  if (/[ymd]/i.test(format)) {
    const date = formulaDateFromValue(number);
    if (date) return date.toISOString().slice(0, 10);
  }
  const decimals = format.match(/0\.(0+)/)?.[1]?.length ?? 0;
  return decimals > 0 ? number.toFixed(decimals) : String(Math.round(number));
}

function naturalFormulaCompare(left: string, right: string): number {
  const leftNumber = Number(normalizeNumericText(left));
  const rightNumber = Number(normalizeNumericText(right));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });
}

function standardDeviation(values: number[], sample: boolean): number | null {
  if (values.length < (sample ? 2 : 1)) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const divisor = sample ? values.length - 1 : values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / divisor);
}

function lookupVertical(lookup: FormulaPrimitive | null, matrix: string[][], columnOffset: number, exact: boolean): FormulaPrimitive | null {
  const rows = matrix.filter((row) => row.length > 0);
  const exactIndex = rows.findIndex((row) => formulaValuesEqual(lookup, row[0]));
  if (exactIndex >= 0) return rows[exactIndex]?.[columnOffset] ?? null;
  if (exact) return null;
  const approximateIndex = approximateMatchIndex(lookup, rows.map((row) => row[0]));
  return approximateIndex >= 0 ? rows[approximateIndex]?.[columnOffset] ?? null : null;
}

function lookupHorizontal(lookup: FormulaPrimitive | null, matrix: string[][], rowOffset: number, exact: boolean): FormulaPrimitive | null {
  const header = matrix[0] || [];
  const exactIndex = header.findIndex((value) => formulaValuesEqual(lookup, value));
  if (exactIndex >= 0) return matrix[rowOffset]?.[exactIndex] ?? null;
  if (exact) return null;
  const approximateIndex = approximateMatchIndex(lookup, header);
  return approximateIndex >= 0 ? matrix[rowOffset]?.[approximateIndex] ?? null : null;
}

function matchFormulaIndex(lookup: FormulaPrimitive | null, values: string[], matchMode: number): number {
  const exactIndex = values.findIndex((value) => formulaValuesEqual(lookup, value));
  if (exactIndex >= 0 || matchMode === 0) return exactIndex;
  if (matchMode < 0) return reverseApproximateMatchIndex(lookup, values);
  return approximateMatchIndex(lookup, values);
}

function approximateMatchIndex(lookup: FormulaPrimitive | null, values: string[]): number {
  const target = asFormulaNumber(lookup);
  if (target == null) return -1;
  let best = -1;
  let bestValue = Number.NEGATIVE_INFINITY;
  values.forEach((value, index) => {
    const numeric = asFormulaNumber(value);
    if (numeric != null && numeric <= target && numeric >= bestValue) {
      best = index;
      bestValue = numeric;
    }
  });
  return best;
}

function reverseApproximateMatchIndex(lookup: FormulaPrimitive | null, values: string[]): number {
  const target = asFormulaNumber(lookup);
  if (target == null) return -1;
  let best = -1;
  let bestValue = Number.POSITIVE_INFINITY;
  values.forEach((value, index) => {
    const numeric = asFormulaNumber(value);
    if (numeric != null && numeric >= target && numeric <= bestValue) {
      best = index;
      bestValue = numeric;
    }
  });
  return best;
}

function formulaValuesEqual(left: FormulaPrimitive | null, right: FormulaPrimitive | null | string): boolean {
  const leftNumber = asFormulaNumber(left);
  const rightNumber = asFormulaNumber(right ?? null);
  if (leftNumber != null && rightNumber != null) return leftNumber === rightNumber;
  return String(left ?? "").trim().toLowerCase() === String(right ?? "").trim().toLowerCase();
}

function formulaCriteriaMatches(value: string, rawCriteria: string): boolean {
  const criteria = unquoteFormulaString(rawCriteria);
  const text = String(value || "").trim();
  const comparison = criteria.match(/^(>=|<=|<>|>|<|=)(.*)$/);
  if (comparison) {
    const operator = comparison[1];
    const targetRaw = comparison[2].trim();
    const left = Number(normalizeNumericText(text));
    const right = Number(normalizeNumericText(targetRaw));
    if (Number.isFinite(left) && Number.isFinite(right)) {
      if (operator === ">=") return left >= right;
      if (operator === "<=") return left <= right;
      if (operator === ">") return left > right;
      if (operator === "<") return left < right;
      if (operator === "<>") return left !== right;
      return left === right;
    }
    if (operator === "<>") return text !== targetRaw;
    if (operator === "=") return text === targetRaw;
    return false;
  }
  if (criteria.includes("*") || criteria.includes("?")) {
    const pattern = criteria
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${pattern}$`, "i").test(text);
  }
  return text === criteria;
}

function evaluateFormulaCondition(expression: string, cells: FormulaEvaluationContext | Map<string, string>): boolean {
  const comparison = expression.match(/^(.*?)(>=|<=|<>|>|<|=)(.*)$/);
  if (!comparison) {
    return formulaTruthValue(valueForFormulaArg(expression, cells));
  }
  const leftRaw = comparison[1];
  const operator = comparison[2];
  const rightRaw = comparison[3];
  const leftNumber = firstValueForFormulaArg(leftRaw, cells) ?? Number(normalizeNumericText(leftRaw));
  const rightNumber = firstValueForFormulaArg(rightRaw, cells) ?? Number(normalizeNumericText(rightRaw));
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    if (operator === ">=") return leftNumber >= rightNumber;
    if (operator === "<=") return leftNumber <= rightNumber;
    if (operator === ">") return leftNumber > rightNumber;
    if (operator === "<") return leftNumber < rightNumber;
    if (operator === "<>") return leftNumber !== rightNumber;
    return leftNumber === rightNumber;
  }
  const leftText = String(firstValueForFormulaTextArg(leftRaw, cells) ?? unquoteFormulaString(leftRaw)).trim();
  const rightText = String(firstValueForFormulaTextArg(rightRaw, cells) ?? unquoteFormulaString(rightRaw)).trim();
  if (operator === "<>") return leftText !== rightText;
  if (operator === "=") return leftText === rightText;
  return false;
}

function firstValueForFormulaTextArg(arg: string, cells: FormulaEvaluationContext | Map<string, string>): string | null {
  const values = valuesForRange(arg, cells);
  return values.length > 0 ? values[0] : null;
}

function unquoteFormulaString(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function hasResolvedFormulaText(cell: BrevynWorksheetCell): boolean {
  const text = cell.text.trim();
  return Boolean(text && !looksLikeFormulaText(text));
}

function looksLikeFormulaText(value: string): boolean {
  return /^=/.test(value.trim());
}

function looksLikeCellRefText(value: string): boolean {
  return /!\$?[A-Z]{1,3}\$?\d+$/i.test(value.trim()) || /^\$?[A-Z]{1,3}\$?\d+$/i.test(value.trim());
}

function normalizeFormulaExpression(formula: string): string {
  const source = formula.trim().replace(/^=/, "");
  let result = "";
  let quote: string | null = null;
  for (const char of source) {
    if ((char === "'" || char === "\"") && quote === char) quote = null;
    else if ((char === "'" || char === "\"") && !quote) quote = char;
    if (!quote && /\s/.test(char)) continue;
    result += char;
  }
  return result;
}

function formatFormulaResult(value: FormulaPrimitive): string {
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return "";
  const rounded = Math.round(value * 1000) / 1000;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

function worksheetCellTextMap(rows: BrevynWorksheetRow[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of rows) {
    for (const cell of row.cells) {
      result.set(cell.ref.toUpperCase(), looksLikeFormulaText(cell.text) ? "" : cell.text);
    }
  }
  return result;
}

function valuesForRange(ref: string | undefined, cells: FormulaEvaluationContext | Map<string, string>): string[] {
  const range = parseRangeRef(ref);
  if (!range) return [];
  const sheetCells = formulaCellsForSheet(cells, range.sheet);
  const values: string[] = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      const value = sheetCells.get(`${spreadsheetColumnName(column - 1)}${row}`);
      if (value != null && value !== "") values.push(value);
    }
  }
  return values;
}

function allValuesForRange(ref: string | undefined, cells: FormulaEvaluationContext | Map<string, string>): string[] {
  const range = parseRangeRef(ref);
  if (!range) {
    const parsed = parseFormulaReference(ref);
    if (!parsed) return [];
    return [cellTextForFormulaReference(parsed, cells) || ""];
  }
  const sheetCells = formulaCellsForSheet(cells, range.sheet);
  const values: string[] = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      values.push(sheetCells.get(`${spreadsheetColumnName(column - 1)}${row}`) || "");
    }
  }
  return values;
}

function matrixForRange(ref: string | undefined, cells: FormulaEvaluationContext | Map<string, string>): string[][] {
  const range = parseRangeRef(ref);
  if (!range) {
    const parsed = parseFormulaReference(ref);
    return parsed ? [[cellTextForFormulaReference(parsed, cells) || ""]] : [];
  }
  const sheetCells = formulaCellsForSheet(cells, range.sheet);
  const matrix: string[][] = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const values: string[] = [];
    for (let column = range.startColumn; column <= range.endColumn; column += 1) {
      values.push(sheetCells.get(`${spreadsheetColumnName(column - 1)}${row}`) || "");
    }
    matrix.push(values);
  }
  return matrix;
}

function normalizeCellReference(ref: string | undefined): string | null {
  return parseFormulaReference(ref)?.ref ?? null;
}

function formulaContextFromCells(cells: FormulaEvaluationContext | Map<string, string>): FormulaEvaluationContext {
  return cells instanceof Map ? { cells } : cells;
}

function formulaCellsForSheet(cells: FormulaEvaluationContext | Map<string, string>, sheet?: string): Map<string, string> {
  const context = formulaContextFromCells(cells);
  if (!sheet) return context.cells;
  return context.sheets?.get(normalizeSheetKey(sheet)) || context.cells;
}

function cellTextForFormulaReference(reference: ParsedFormulaReference, cells: FormulaEvaluationContext | Map<string, string>): string | undefined {
  return formulaCellsForSheet(cells, reference.sheet).get(reference.ref);
}

function parseFormulaReference(ref: string | undefined): ParsedFormulaReference | null {
  if (!ref) return null;
  const split = splitSheetReference(ref);
  const normalized = split.ref.replace(/\$/g, "").trim().toUpperCase();
  return /^[A-Z]{1,3}\d+$/i.test(normalized) ? { sheet: split.sheet, ref: normalized } : null;
}

function splitSheetReference(ref: string): { sheet?: string; ref: string } {
  const trimmed = ref.trim();
  const bang = trimmed.lastIndexOf("!");
  if (bang < 0) return { ref: trimmed };
  return {
    sheet: normalizeSheetName(trimmed.slice(0, bang)),
    ref: trimmed.slice(bang + 1),
  };
}

function normalizeSheetName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replace(/''/g, "'");
  return trimmed;
}

function normalizeSheetKey(value: string): string {
  return normalizeSheetName(value).trim().toLowerCase();
}

function inferAdjacentCategoryValues(valueRef: string, cells: Map<string, string>): string[] {
  const range = parseRangeRef(valueRef);
  if (!range) return [];
  const previousColumn = range.startColumn - 1;
  if (previousColumn < 1 || range.endColumn !== range.startColumn) return [];
  const values: string[] = [];
  for (let row = range.startRow; row <= range.endRow; row += 1) {
    const value = cells.get(`${spreadsheetColumnName(previousColumn - 1)}${row}`);
    if (value != null && value !== "") values.push(value);
  }
  return values;
}

function parseRangeRef(ref: string | undefined): ParsedFormulaRange | null {
  if (!ref) return null;
  const split = splitSheetReference(ref);
  const normalized = split.ref.replace(/\$/g, "").replace(/'/g, "");
  const [startRaw, endRaw] = normalized.split(":");
  const start = parseCellRef(startRaw || "");
  const end = parseCellRef(endRaw || startRaw || "");
  if (!start.row || !start.column || !end.row || !end.column) return null;
  return {
    sheet: split.sheet,
    startRow: Math.min(start.row, end.row),
    startColumn: Math.min(start.column, end.column),
    endRow: Math.max(start.row, end.row),
    endColumn: Math.max(start.column, end.column),
  };
}

function normalizeNumericText(value: string): string {
  return value.replace(/,/g, "").replace(/%$/, "");
}

function chartNodeForType(chartDoc: Document, type: BrevynSpreadsheetChartType): Element | undefined {
  const names: Record<BrevynSpreadsheetChartType, string[]> = {
    bar: ["barChart", "bar3DChart"],
    line: ["lineChart", "line3DChart"],
    pie: ["pieChart", "pie3DChart"],
    doughnut: ["doughnutChart"],
    scatter: ["scatterChart"],
    area: ["areaChart", "area3DChart"],
    radar: ["radarChart"],
    bubble: ["bubbleChart"],
    stock: ["stockChart"],
    surface: ["surfaceChart", "surface3DChart"],
    treemap: ["treemapChart"],
    sunburst: ["sunburstChart"],
    histogram: ["histogramChart"],
    boxWhisker: ["boxWhiskerChart"],
    waterfall: ["waterfallChart"],
    unknown: [],
  };
  for (const name of names[type]) {
    const node = getElementsByLocalName(chartDoc, name)[0];
    if (node) return node;
  }
  return undefined;
}

function chartTitle(chartDoc: Document): string {
  const title = getElementsByLocalName(chartDoc, "title")[0];
  return title ? titleText(title) : "";
}

function chartSeriesName(seriesNode: Element): string {
  const tx = getDirectChildElementsByLocalName(seriesNode, "tx")[0];
  if (!tx) return "";
  const cached = chartCachedValues(tx)[0];
  if (cached) return cached;
  return chartFormula(tx) || titleText(tx);
}

function titleText(root: Element): string {
  return getElementsByLocalName(root, "t").map((node) => node.textContent || "").join("").trim();
}

function chartCachedValues(root?: Element): string[] {
  if (!root) return [];
  const cache = getElementsByLocalName(root, "strCache")[0] || getElementsByLocalName(root, "numCache")[0];
  if (!cache) return [];
  return getElementsByLocalName(cache, "pt")
    .sort((a, b) => Number(a.getAttribute("idx") || 0) - Number(b.getAttribute("idx") || 0))
    .map((point) => getFirstTextByLocalName(point, "v"))
    .filter((value) => value !== "");
}

function chartFormula(root?: Element): string | undefined {
  if (!root) return undefined;
  return getFirstTextByLocalName(root, "f") || undefined;
}

function firstDirectChildByLocalNames(root: Element, localNames: string[]): Element | undefined {
  for (const localName of localNames) {
    const child = getDirectChildElementsByLocalName(root, localName)[0];
    if (child) return child;
  }
  return undefined;
}

function firstDirectChildElement(root: Element | undefined, localName: string): Element | undefined {
  return root ? getDirectChildElementsByLocalName(root, localName)[0] : undefined;
}

function parseChartAnchor(anchor: Element): BrevynSpreadsheetChart["anchor"] {
  const from = getDirectChildElementsByLocalName(anchor, "from")[0];
  const to = getDirectChildElementsByLocalName(anchor, "to")[0];
  const ext = getDirectChildElementsByLocalName(anchor, "ext")[0];
  return {
    fromRow: from ? numberChild(from, "row", 0) + 1 : undefined,
    fromColumn: from ? numberChild(from, "col", 0) + 1 : undefined,
    toRow: to ? numberChild(to, "row", 0) + 1 : undefined,
    toColumn: to ? numberChild(to, "col", 0) + 1 : undefined,
    widthPx: ext ? emuToPx(numberAttribute(ext, "cx")) : undefined,
    heightPx: ext ? emuToPx(numberAttribute(ext, "cy")) : undefined,
  };
}

function numberChild(root: Element, localName: string, fallback: number): number {
  const value = Number(getDirectChildElementsByLocalName(root, localName)[0]?.textContent || "");
  return Number.isFinite(value) ? value : fallback;
}

function numberChildAttribute(root: Element, localName: string, attributeName: string): number | undefined {
  const child = getDirectChildElementsByLocalName(root, localName)[0];
  return numberAttribute(child, attributeName);
}

function booleanChildAttribute(root: Element, localName: string): boolean | undefined {
  const child = getDirectChildElementsByLocalName(root, localName)[0];
  if (!child) return undefined;
  const value = child.getAttribute("val");
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return undefined;
}

function getXlsxCellText(cell: Element, sharedStrings: string[], dateStyleIndexes: Set<number>, style?: BrevynWorksheetCellStyle): string {
  const type = cell.getAttribute("t");
  if (type === "inlineStr") {
    return getElementsByLocalName(cell, "t").map((node) => node.textContent || "").join("");
  }

  const value = getFirstTextByLocalName(cell, "v");
  if (!value) return "";
  if (type === "s") {
    const sharedIndex = Number(value);
    return Number.isInteger(sharedIndex) ? sharedStrings[sharedIndex] || "" : "";
  }
  if (type === "b") return value === "1" ? "TRUE" : "FALSE";

  const styleIndex = Number(cell.getAttribute("s"));
  if (!type && Number.isInteger(styleIndex) && dateStyleIndexes.has(styleIndex)) {
    return formatExcelSerialDate(value);
  }
  return formatCellNumber(value, style?.numberFormat);
}

function parseMergedCells(doc: Document): BrevynMergedCell[] {
  return getElementsByLocalName(doc, "mergeCell")
    .map((cell) => cell.getAttribute("ref") || "")
    .filter(Boolean)
    .map((ref) => {
      const [startRaw, endRaw] = ref.split(":");
      const start = parseCellRef(startRaw || "");
      const end = parseCellRef(endRaw || startRaw || "");
      return {
        ref,
        startRow: start.row,
        startColumn: start.column,
        endRow: end.row,
        endColumn: end.column,
      };
    });
}

function usedRangeForRows(rows: BrevynWorksheetRow[]): string | undefined {
  let minRow = Number.POSITIVE_INFINITY;
  let maxRow = 0;
  let minColumn = Number.POSITIVE_INFINITY;
  let maxColumn = 0;
  for (const row of rows) {
    for (const cell of row.cells) {
      minRow = Math.min(minRow, cell.row);
      maxRow = Math.max(maxRow, cell.row);
      minColumn = Math.min(minColumn, cell.column);
      maxColumn = Math.max(maxColumn, cell.column);
    }
  }
  if (!Number.isFinite(minRow) || maxRow <= 0 || !Number.isFinite(minColumn) || maxColumn <= 0) return undefined;
  return `${spreadsheetColumnName(minColumn - 1)}${minRow}:${spreadsheetColumnName(maxColumn - 1)}${maxRow}`;
}

function formatSpreadsheetRow(rowNumber: number, values: string[]): string {
  const cells = values
    .map((value, index) => [spreadsheetColumnName(index), normalizeCell(value)] as const)
    .filter(([, value]) => value)
    .map(([column, value]) => `${column}=${value}`);
  return cells.length > 0 ? `Row ${rowNumber}: ${cells.join(" | ")}` : "";
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

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

function getElementsByLocalName(root: Node, localName: string): Element[] {
  const result: Element[] = [];
  function walk(node: Node): void {
    const children = node.childNodes;
    if (!children) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children.item(index);
      if (child.nodeType === 1) {
        const element = child as Element;
        if (element.localName === localName || element.nodeName === localName) result.push(element);
      }
      walk(child);
    }
  }
  walk(root);
  return result;
}

function getDirectChildElementsByLocalName(root: Element | Document, localName: string): Element[] {
  const result: Element[] = [];
  const children = root.childNodes;
  if (!children) return result;
  for (let index = 0; index < children.length; index += 1) {
    const child = children.item(index);
    if (child.nodeType !== 1) continue;
    const element = child as Element;
    if (element.localName === localName || element.nodeName === localName) result.push(element);
  }
  return result;
}

function getDirectChildElements(root: Element | Document): Element[] {
  const result: Element[] = [];
  const children = root.childNodes;
  if (!children) return result;
  for (let index = 0; index < children.length; index += 1) {
    const child = children.item(index);
    if (child.nodeType === 1) result.push(child as Element);
  }
  return result;
}

function getFirstTextByLocalName(root: Element, localName: string): string {
  return getElementsByLocalName(root, localName)[0]?.textContent || "";
}

function normalizeZipTarget(baseDir: string, target: string): string {
  const normalizedTarget = target.replace(/\\/g, "/");
  if (normalizedTarget.startsWith("/")) return normalizedTarget.slice(1);
  return pathPosix.normalize(pathPosix.join(baseDir, normalizedTarget));
}

function parseCellRef(ref: string): { row: number; column: number } {
  if (!/^\$?[A-Za-z]{1,3}\$?\d+$/.test(ref.trim())) return { row: 0, column: 0 };
  return {
    row: rowNumberFromCellRef(ref),
    column: columnIndexFromCellRef(ref) + 1,
  };
}

function rowNumberFromCellRef(cellRef: string): number {
  const digits = cellRef.match(/\d+/)?.[0];
  const row = digits ? Number(digits) : 0;
  return Number.isFinite(row) ? row : 0;
}

function columnIndexFromCellRef(cellRef: string): number {
  const letters = cellRef.match(/[A-Za-z]+/)?.[0]?.toUpperCase();
  if (!letters) return 0;
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return Math.max(0, index - 1);
}

function sheetElementId(artifactId: string, sheetIndex: number): string {
  return `${artifactId}:sheet-${sheetIndex + 1}`;
}

function numberAttribute(element: Element | undefined, name: string): number | undefined {
  if (!element) return undefined;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) ? value : undefined;
}

function rowHeightPx(row: Element): number | undefined {
  const points = numberAttribute(row, "ht");
  return points != null ? Math.max(18, Math.round(points * 1.333)) : undefined;
}

function excelColumnWidthToPx(width?: number): number {
  if (!width || !Number.isFinite(width)) return 96;
  return Math.max(28, Math.round(width * 7 + 5));
}

function emuToPx(value?: number): number | undefined {
  if (!value || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.round(value / 9525));
}

function parseColor(element?: Element): string | undefined {
  if (!element) return undefined;
  const rgb = element.getAttribute("rgb");
  if (rgb) return `#${rgb.slice(-6)}`;
  const indexed = Number(element.getAttribute("indexed"));
  if (Number.isInteger(indexed)) return INDEXED_EXCEL_COLORS[indexed];
  return undefined;
}

function mediaTypeForPath(sourcePath: string): string {
  const normalized = sourcePath.toLowerCase();
  if (normalized.endsWith(".svg")) return "image/svg+xml";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}

function normalizeHorizontalAlign(value?: string): BrevynWorksheetCellStyle["horizontalAlign"] | undefined {
  if (value === "center") return "center";
  if (value === "right") return "right";
  if (value === "left") return "left";
  return undefined;
}

function normalizeVerticalAlign(value?: string): BrevynWorksheetCellStyle["verticalAlign"] | undefined {
  if (value === "top") return "top";
  if (value === "center") return "middle";
  if (value === "bottom") return "bottom";
  return undefined;
}

const INDEXED_EXCEL_COLORS: Record<number, string | undefined> = {
  0: "#000000",
  1: "#FFFFFF",
  2: "#FF0000",
  3: "#00FF00",
  4: "#0000FF",
  5: "#FFFF00",
  6: "#FF00FF",
  7: "#00FFFF",
  8: "#000000",
  9: "#FFFFFF",
  64: undefined,
};

function formatExcelSerialDate(rawValue: string): string {
  const serial = Number(rawValue);
  if (!Number.isFinite(serial)) return rawValue;
  const millis = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return rawValue;
  const year = date.getUTCFullYear();
  if (year < 1900 || year > 9999) return rawValue;
  const pad = (value: number) => String(value).padStart(2, "0");
  const dateText = `${year}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const hasTime = Math.abs(serial - Math.floor(serial)) > 0.000001;
  if (!hasTime) return dateText;
  return `${dateText} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function formatCellNumber(rawValue: string, numberFormat?: string): string {
  if (!numberFormat || numberFormat === "General") return rawValue;
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return rawValue;
  const normalized = numberFormat.toLowerCase();
  if (normalized.includes("%")) {
    return `${(value * 100).toFixed(decimalPlacesForFormat(normalized))}%`;
  }
  if (normalized.includes("$") || normalized.includes("¥") || normalized.includes("￥")) {
    const prefix = normalized.includes("$") ? "$" : "¥";
    return `${prefix}${formatNumberWithGrouping(value, decimalPlacesForFormat(normalized))}`;
  }
  if (normalized.includes("#,##") || normalized.includes("#,0")) {
    return formatNumberWithGrouping(value, decimalPlacesForFormat(normalized));
  }
  if (/0\.0+/.test(normalized)) {
    return value.toFixed(decimalPlacesForFormat(normalized));
  }
  return rawValue;
}

function decimalPlacesForFormat(format: string): number {
  const match = format.match(/0\.(0+)/);
  return Math.min(6, match?.[1]?.length || 0);
}

function formatNumberWithGrouping(value: number, decimals: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function isDateNumFmtId(numFmtId: number): boolean {
  return (
    (numFmtId >= 14 && numFmtId <= 22) ||
    (numFmtId >= 27 && numFmtId <= 36) ||
    (numFmtId >= 45 && numFmtId <= 47) ||
    (numFmtId >= 50 && numFmtId <= 58)
  );
}

function isDateFormatCode(formatCode: string): boolean {
  const normalized = formatCode
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[[^\]]*]/g, "")
    .toLowerCase();
  return /[ymdhHsS]/.test(normalized);
}
