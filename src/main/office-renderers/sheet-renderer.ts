import type {
  BrevynMergedCell,
  BrevynOfficeRenderSurface,
  BrevynOfficeRenderTarget,
  BrevynSpreadsheetShape,
  BrevynWorksheetCellStyle,
  BrevynWorksheetModel,
} from "../office-model/schema";
import { DEFAULT_CHART_HEIGHT, DEFAULT_CHART_WIDTH } from "./chart-renderer";

const SHEET_ENGINE = "brevyn-office-sheet-html-v1";
const ROW_HEADER_WIDTH = 52;
const COLUMN_HEADER_HEIGHT = 30;
const DEFAULT_CELL_WIDTH = 96;
const DEFAULT_CELL_HEIGHT = 28;
const MIN_SHEET_WIDTH = 720;
const MIN_SHEET_HEIGHT = 320;
const MAX_RENDER_COLUMNS = 40;
const MAX_RENDER_ROWS = 160;

export function renderSpreadsheetSheet(sheet: BrevynWorksheetModel): BrevynOfficeRenderSurface {
  const columnCount = Math.max(1, Math.min(sheet.renderedColumns || sheet.totalColumns || 1, MAX_RENDER_COLUMNS));
  const maxRowNumber = Math.max(sheet.renderedRows || 1, ...sheet.rows.map((row) => row.number));
  const rowCount = Math.max(1, Math.min(maxRowNumber, MAX_RENDER_ROWS));
  const layout = buildSheetLayout(sheet, columnCount, rowCount);
  const bounds = contentBounds(sheet, layout);
  const width = Math.max(MIN_SHEET_WIDTH, ROW_HEADER_WIDTH + layout.totalColumnWidth, bounds.width);
  const height = Math.max(MIN_SHEET_HEIGHT, COLUMN_HEADER_HEIGHT + layout.totalRowHeight, bounds.height);
  const targets: BrevynOfficeRenderTarget[] = [];
  const parts: string[] = [
    `<div class="brevyn-sheet-surface" role="table" aria-label="${escapeAttr(sheet.name)}" style="width:${width}px;height:${height}px">`,
    `<div class="brevyn-sheet-corner" style="left:0;top:0;width:${ROW_HEADER_WIDTH}px;height:${COLUMN_HEADER_HEIGHT}px"></div>`,
  ];

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const x = layout.columnLefts[columnIndex];
    const columnWidth = layout.columnWidths[columnIndex];
    parts.push(`<div class="brevyn-sheet-col-header" role="columnheader" style="left:${x}px;top:0;width:${columnWidth}px;height:${COLUMN_HEADER_HEIGHT}px">${spreadsheetColumnName(columnIndex)}</div>`);
  }

  const rowsByNumber = new Map(sheet.rows.map((row) => [row.number, row] as const));
  for (let rowRenderIndex = 0; rowRenderIndex < rowCount; rowRenderIndex += 1) {
    const rowNumber = layout.rowNumbers[rowRenderIndex] || rowRenderIndex + 1;
    const row = rowsByNumber.get(rowNumber);
    const y = layout.rowTops[rowRenderIndex];
    const rowHeight = layout.rowHeights[rowRenderIndex];
    parts.push(`<div class="brevyn-sheet-row-header" role="rowheader" style="left:0;top:${y}px;width:${ROW_HEADER_WIDTH}px;height:${rowHeight}px">${rowNumber}</div>`);

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const x = layout.columnLefts[columnIndex];
      const cell = row?.cells.find((item) => item.column === columnIndex + 1);
      const merge = mergeForCell(sheet.mergedCells, rowNumber, columnIndex + 1);
      if (merge && (merge.startRow !== rowNumber || merge.startColumn !== columnIndex + 1)) continue;
      const cellWidth = merge ? mergedWidth(layout, merge) : layout.columnWidths[columnIndex];
      const cellHeight = merge ? mergedHeight(layout, merge) : rowHeight;
      const text = cell?.text || "";
      const style = cell?.style || {};
      const range = merge?.ref || cell?.ref || `${spreadsheetColumnName(columnIndex)}${rowNumber}`;
      const targetId = cell?.id || `${sheet.id}:cell-${spreadsheetColumnName(columnIndex)}${rowNumber}`;
      parts.push(renderCellHtml({ text, x, y, width: cellWidth, height: cellHeight, style, formula: Boolean(cell?.formula), range }));
      targets.push({
        id: targetId,
        type: "cell",
        text,
        bbox: { x, y, width: cellWidth, height: cellHeight },
        location: {
          sheet: sheet.name,
          range,
          row: rowNumber,
          column: columnIndex + 1,
        },
        metadata: {
          rowIndex: rowRenderIndex,
          columnIndex,
          rowNumber,
          columnNumber: columnIndex + 1,
          formula: cell?.formula || "",
        },
      });
    }
  }

  parts.push(freezePaneHtml(sheet, layout, width, height));
  for (const chart of sheet.charts) {
    if (!chart.render?.data) continue;
    const box = chartBoxForAnchor(chart, layout, columnCount, rowCount);
    parts.push(`<div class="brevyn-sheet-floating brevyn-sheet-chart" style="left:${round(box.x)}px;top:${round(box.y)}px;width:${round(box.width)}px;height:${round(box.height)}px">${chart.render.data}</div>`);
    targets.push({
      id: chart.id,
      type: "chart",
      text: chart.title,
      bbox: box,
      location: { sheet: sheet.name, objectPath: chart.name },
      metadata: { chartIndex: chart.index, type: chart.type },
    });
  }

  for (const image of sheet.images || []) {
    if (!image.dataUrl) continue;
    const box = drawingBoxForAnchor(image.anchor, layout, columnCount, rowCount, {
      width: 320,
      height: 200,
      fallbackColumn: columnCount + 1,
      fallbackRow: 2,
    });
    parts.push(`<div class="brevyn-sheet-floating brevyn-sheet-image" style="left:${round(box.x)}px;top:${round(box.y)}px;width:${round(box.width)}px;height:${round(box.height)}px"><img src="${escapeAttr(image.dataUrl)}" alt="${escapeAttr(image.name)}"/></div>`);
    targets.push({
      id: image.id,
      type: "image",
      text: image.name,
      bbox: box,
      location: { sheet: sheet.name, objectPath: image.name },
      metadata: { imageIndex: image.index, assetId: image.assetId },
    });
  }

  for (const shape of sheet.shapes || []) {
    const box = shapeBoxForAnchor(shape, layout, columnCount, rowCount);
    const fill = escapeCss(shape.fillColor || "#ffffff");
    const stroke = escapeCss(shape.lineColor || "#94a3b8");
    parts.push(`<div class="brevyn-sheet-floating brevyn-sheet-shape" style="left:${round(box.x)}px;top:${round(box.y)}px;width:${round(box.width)}px;height:${round(box.height)}px;background:${fill};border-color:${stroke}"><span>${escapeHtml(shape.text || shape.name)}</span></div>`);
    targets.push({
      id: shape.id,
      type: "shape",
      text: shape.text || shape.name,
      bbox: box,
      location: { sheet: sheet.name, objectPath: shape.name },
      metadata: { shapeIndex: shape.index, shapeType: shape.shapeType || "" },
    });
  }

  parts.push("</div>");
  return {
    id: `${sheet.id}:render-main`,
    kind: "html",
    role: "sheet",
    width,
    height,
    mediaType: "text/html",
    data: parts.join(""),
    engine: SHEET_ENGINE,
    warnings: [
      sheet.truncatedRows ? `Only ${rowCount} rows are rendered in this preview surface.` : "",
      sheet.truncatedColumns ? `Only ${columnCount} columns are rendered in this preview surface.` : "",
    ].filter(Boolean),
    targets,
  };
}

interface SheetLayout {
  columnWidths: number[];
  columnLefts: number[];
  rowHeights: number[];
  rowTops: number[];
  rowNumbers: number[];
  rowIndexByNumber: Map<number, number>;
  totalColumnWidth: number;
  totalRowHeight: number;
}

function buildSheetLayout(sheet: BrevynWorksheetModel, columnCount: number, rowCount: number): SheetLayout {
  const columnWidths = Array.from({ length: columnCount }, (_value, index) => {
    const column = sheet.columns.find((item) => item.index === index + 1);
    return column?.hidden ? 0 : Math.max(28, Math.min(280, column?.widthPx || DEFAULT_CELL_WIDTH));
  });
  const maxRowNumber = Math.max(rowCount, ...sheet.rows.slice(0, rowCount).map((row) => row.number));
  const rowNumbers = Array.from({ length: Math.min(rowCount, maxRowNumber) }, (_value, index) => index + 1);
  const rowsByNumber = new Map(sheet.rows.map((row) => [row.number, row] as const));
  const rowHeights = rowNumbers.map((rowNumber) => {
    const row = rowsByNumber.get(rowNumber);
    return row?.hidden ? 0 : Math.max(20, Math.min(160, row?.heightPx || DEFAULT_CELL_HEIGHT));
  });
  const rowIndexByNumber = new Map(rowNumbers.map((rowNumber, index) => [rowNumber, index] as const));
  return {
    columnWidths,
    columnLefts: cumulativeOffsets(columnWidths, ROW_HEADER_WIDTH),
    rowHeights,
    rowTops: cumulativeOffsets(rowHeights, COLUMN_HEADER_HEIGHT),
    rowNumbers,
    rowIndexByNumber,
    totalColumnWidth: columnWidths.reduce((sum, value) => sum + value, 0),
    totalRowHeight: rowHeights.reduce((sum, value) => sum + value, 0),
  };
}

function renderCellHtml(input: { text: string; x: number; y: number; width: number; height: number; style: BrevynWorksheetCellStyle; formula: boolean; range: string }): string {
  const style = input.style;
  const alignItems = style.verticalAlign === "top" ? "flex-start" : style.verticalAlign === "bottom" ? "flex-end" : "center";
  const justifyContent = style.horizontalAlign === "center" ? "center" : style.horizontalAlign === "right" ? "flex-end" : "flex-start";
  const classes = ["brevyn-sheet-cell", input.formula ? "brevyn-sheet-cell-formula" : "", style.wrapText ? "brevyn-sheet-cell-wrap" : ""].filter(Boolean).join(" ");
  const inlineStyle = [
    `left:${round(input.x)}px`,
    `top:${round(input.y)}px`,
    `width:${round(input.width)}px`,
    `height:${round(input.height)}px`,
    `align-items:${alignItems}`,
    `justify-content:${justifyContent}`,
    `font-size:${Math.max(9, Math.min(18, style.fontSize || 12))}px`,
    `font-weight:${style.bold ? 700 : 400}`,
    `font-style:${style.italic ? "italic" : "normal"}`,
    `text-decoration:${style.underline ? "underline" : "none"}`,
    `color:${escapeCss(style.fontColor || "var(--brevyn-sheet-fg, #111827)")}`,
    `background:${escapeCss(style.fillColor || (input.formula ? "var(--brevyn-sheet-formula-bg, #eff6ff)" : "var(--brevyn-sheet-cell-bg, #fff)"))}`,
    style.borderColor ? `--brevyn-cell-border:${escapeCss(style.borderColor)}` : "",
    style.borderTop ? `border-top-color:var(--brevyn-cell-border, var(--brevyn-sheet-border, #e5e7eb));border-top-width:1.5px` : "",
    style.borderRight ? `border-right-color:var(--brevyn-cell-border, var(--brevyn-sheet-border, #e5e7eb));border-right-width:1.5px` : "",
    style.borderBottom ? `border-bottom-color:var(--brevyn-cell-border, var(--brevyn-sheet-border, #e5e7eb));border-bottom-width:1.5px` : "",
    style.borderLeft ? `border-left-color:var(--brevyn-cell-border, var(--brevyn-sheet-border, #e5e7eb));border-left-width:1.5px` : "",
  ].filter(Boolean).join(";");
  return `<div class="${classes}" role="cell" data-range="${escapeAttr(input.range)}" title="${escapeAttr(input.text)}" style="${inlineStyle}"><span>${escapeHtml(input.text)}</span></div>`;
}

function freezePaneHtml(sheet: BrevynWorksheetModel, layout: SheetLayout, width: number, height: number): string {
  const parts: string[] = [];
  if (sheet.freezePanes?.frozenColumns) {
    const x = layout.columnLefts[sheet.freezePanes.frozenColumns] ?? ROW_HEADER_WIDTH + layout.totalColumnWidth;
    parts.push(`<div class="brevyn-sheet-freeze-line" style="left:${x}px;top:0;width:2px;height:${height}px"></div>`);
  }
  if (sheet.freezePanes?.frozenRows) {
    const y = layout.rowTops[sheet.freezePanes.frozenRows] ?? COLUMN_HEADER_HEIGHT + layout.totalRowHeight;
    parts.push(`<div class="brevyn-sheet-freeze-line" style="left:0;top:${y}px;width:${width}px;height:2px"></div>`);
  }
  return parts.join("");
}

function cumulativeOffsets(values: number[], start: number): number[] {
  let current = start;
  return values.map((value) => {
    const offset = current;
    current += value;
    return offset;
  });
}

function contentBounds(sheet: BrevynWorksheetModel, layout: SheetLayout): { width: number; height: number } {
  let width = ROW_HEADER_WIDTH + layout.totalColumnWidth;
  let height = COLUMN_HEADER_HEIGHT + layout.totalRowHeight;
  for (const chart of sheet.charts) {
    const box = chartBoxForAnchor(chart, layout, layout.columnWidths.length, layout.rowHeights.length);
    width = Math.max(width, box.x + box.width + 24);
    height = Math.max(height, box.y + box.height + 24);
  }
  for (const image of sheet.images || []) {
    const box = drawingBoxForAnchor(image.anchor, layout, layout.columnWidths.length, layout.rowHeights.length, {
      width: 320,
      height: 200,
      fallbackColumn: layout.columnWidths.length + 1,
      fallbackRow: 2,
    });
    width = Math.max(width, box.x + box.width + 24);
    height = Math.max(height, box.y + box.height + 24);
  }
  for (const shape of sheet.shapes || []) {
    const box = shapeBoxForAnchor(shape, layout, layout.columnWidths.length, layout.rowHeights.length);
    width = Math.max(width, box.x + box.width + 24);
    height = Math.max(height, box.y + box.height + 24);
  }
  return { width, height };
}

function chartBoxForAnchor(
  chart: BrevynWorksheetModel["charts"][number],
  layout: SheetLayout,
  columnCount: number,
  rowCount: number,
): { x: number; y: number; width: number; height: number } {
  return drawingBoxForAnchor(chart.anchor, layout, columnCount, rowCount, {
    width: DEFAULT_CHART_WIDTH,
    height: DEFAULT_CHART_HEIGHT,
    fallbackColumn: columnCount + 1,
    fallbackRow: 2,
  });
}

function shapeBoxForAnchor(
  shape: BrevynSpreadsheetShape,
  layout: SheetLayout,
  columnCount: number,
  rowCount: number,
): { x: number; y: number; width: number; height: number } {
  return drawingBoxForAnchor(shape.anchor, layout, columnCount, rowCount, {
    width: 260,
    height: 96,
    fallbackColumn: columnCount + 1,
    fallbackRow: 2 + shape.index * 4,
  });
}

function drawingBoxForAnchor(
  anchor: { fromRow?: number; fromColumn?: number; toRow?: number; toColumn?: number; widthPx?: number; heightPx?: number } | undefined,
  layout: SheetLayout,
  columnCount: number,
  rowCount: number,
  fallback: { width: number; height: number; fallbackColumn: number; fallbackRow: number },
): { x: number; y: number; width: number; height: number } {
  const anchorColumn = Math.max(1, Math.min(columnCount + 1, anchor?.fromColumn || fallback.fallbackColumn));
  const anchorRow = Math.max(1, Math.min(rowCount + 1, anchor?.fromRow || fallback.fallbackRow));
  const x = layout.columnLefts[anchorColumn - 1] ?? ROW_HEADER_WIDTH + layout.totalColumnWidth;
  const fromRowIndex = layout.rowIndexByNumber.get(anchorRow) ?? anchorRow - 1;
  const y = layout.rowTops[fromRowIndex] ?? COLUMN_HEADER_HEIGHT + DEFAULT_CELL_HEIGHT;
  const toColumn = anchor?.toColumn;
  const toRow = anchor?.toRow;
  const toRowIndex = toRow ? layout.rowIndexByNumber.get(toRow) ?? toRow - 1 : undefined;
  const width = Math.max(120, anchor?.widthPx || (toColumn && toColumn > anchorColumn ? sumSlice(layout.columnWidths, anchorColumn - 1, toColumn - 1) : Math.min(fallback.width, DEFAULT_CELL_WIDTH * 5)));
  const height = Math.max(90, anchor?.heightPx || (toRowIndex && toRowIndex > fromRowIndex ? sumSlice(layout.rowHeights, fromRowIndex, toRowIndex) : Math.min(fallback.height, DEFAULT_CELL_HEIGHT * 8)));
  return { x, y, width, height };
}

function mergeForCell(mergedCells: BrevynMergedCell[], row: number, column: number): BrevynMergedCell | undefined {
  return mergedCells.find((merge) => row >= merge.startRow && row <= merge.endRow && column >= merge.startColumn && column <= merge.endColumn);
}

function mergedWidth(layout: SheetLayout, merge: BrevynMergedCell): number {
  return sumSlice(layout.columnWidths, merge.startColumn - 1, merge.endColumn);
}

function mergedHeight(layout: SheetLayout, merge: BrevynMergedCell): number {
  const startIndex = layout.rowIndexByNumber.get(merge.startRow) ?? merge.startRow - 1;
  const endIndex = (layout.rowIndexByNumber.get(merge.endRow) ?? merge.endRow - 1) + 1;
  return sumSlice(layout.rowHeights, startIndex, endIndex);
}

function sumSlice(values: number[], start: number, end: number): number {
  return values.slice(Math.max(0, start), Math.max(start, end)).reduce((sum, value) => sum + value, 0);
}

export function spreadsheetColumnName(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function escapeHtml(value: string): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function escapeCss(value: string): string {
  return value.replace(/[;"{}]/g, "");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
