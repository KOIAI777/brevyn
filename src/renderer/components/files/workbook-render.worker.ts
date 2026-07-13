import type {
  SpreadsheetPreview,
  SpreadsheetPreviewCell,
  SpreadsheetPreviewCellStyle,
  SpreadsheetPreviewChart,
  SpreadsheetPreviewChartSeries,
  SpreadsheetPreviewShape,
  SpreadsheetPreviewMergedCell,
  SpreadsheetPreviewSheet,
} from "@/types/domain";

type Camera = {
  x: number;
  y: number;
  zoom: number;
};

type Theme = {
  background: string;
  foreground: string;
  card: string;
  muted: string;
  mutedForeground: string;
  border: string;
  primary: string;
  selectionFill: string;
  selectionStroke: string;
  searchFill: string;
};

type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ChartAxisScale = {
  min: number;
  max: number;
  majorUnit?: number;
  numberFormat?: string;
};

type ChartAxisStyle = NonNullable<NonNullable<SpreadsheetPreviewChart["style"]>["axis"]>;

type WorkbookRenderMessage =
  | { type: "init"; workbook: SpreadsheetPreview; sheetIndex: number; camera: Camera; viewport: ViewportMetrics; theme: Theme; selection?: WorkbookSelection | null; search?: string }
  | { type: "render"; sheetIndex: number; camera: Camera; viewport: ViewportMetrics; theme: Theme; selection?: WorkbookSelection | null; search?: string };

type WorkbookWorkerResponse =
  | { type: "frame"; bitmap: ImageBitmap; metrics: ViewportMetrics; sheetIndex: number; layout: WorkbookSheetLayout }
  | { type: "error"; message: string };

export type ViewportMetrics = {
  width: number;
  height: number;
  dpr: number;
};

export type WorkbookSelection = {
  sheetIndex: number;
  kind?: "cell" | "chart" | "shape";
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
  chartId?: string;
  shapeId?: string;
};

export type WorkbookCellRect = {
  row: number;
  column: number;
  ref: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkbookChartRect = {
  id: string;
  chart: SpreadsheetPreviewChart;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkbookShapeRect = {
  id: string;
  shape: SpreadsheetPreviewShape;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkbookSheetLayout = {
  sheetIndex: number;
  width: number;
  height: number;
  rowHeaderWidth: number;
  columnHeaderHeight: number;
  rowNumbers: number[];
  columnWidths: number[];
  rowHeights: number[];
  columnLefts: number[];
  rowTops: number[];
  cells: WorkbookCellRect[];
  charts: WorkbookChartRect[];
  shapes: WorkbookShapeRect[];
};

const ROW_HEADER_WIDTH = 52;
const COLUMN_HEADER_HEIGHT = 28;
const DEFAULT_CELL_WIDTH = 96;
const DEFAULT_CELL_HEIGHT = 28;
const MIN_CELL_WIDTH = 34;
const MAX_CELL_WIDTH = 280;
const MIN_ROW_HEIGHT = 22;
const MAX_ROW_HEIGHT = 160;
const DEFAULT_CHART_WIDTH = 720;
const DEFAULT_CHART_HEIGHT = 320;
const CHART_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#f59e0b", "#0891b2", "#be123c", "#4f46e5"];
const EXCEL_CHART_BORDER = "#d9d9d9";
const EXCEL_AXIS = "#7f7f7f";
const EXCEL_GRID = "#e6e6e6";
const EXCEL_TEXT = "#1f1f1f";

const workerScope = self as unknown as {
  postMessage(message: WorkbookWorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkbookRenderMessage>) => void) | null;
};

let activeWorkbook: SpreadsheetPreview | null = null;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

workerScope.onmessage = (event: MessageEvent<WorkbookRenderMessage>) => {
  try {
    const message = event.data;
    if (message.type === "init") activeWorkbook = message.workbook;
    if (!activeWorkbook) throw new Error("Workbook renderer was not initialized.");
    const rendered = renderWorkbook(activeWorkbook, message);
    if (!rendered) return;
    const response: WorkbookWorkerResponse = {
      type: "frame",
      bitmap: rendered.bitmap,
      metrics: message.viewport,
      sheetIndex: message.sheetIndex,
      layout: rendered.layout,
    };
    workerScope.postMessage(response, [rendered.bitmap]);
  } catch (error) {
    const response: WorkbookWorkerResponse = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  }
};

function renderWorkbook(workbook: SpreadsheetPreview, message: Extract<WorkbookRenderMessage, { type: "init" | "render" }>): { bitmap: ImageBitmap; layout: WorkbookSheetLayout } | null {
  const sheet = workbook.sheets[message.sheetIndex] || workbook.sheets[0];
  if (!sheet || message.viewport.width <= 0 || message.viewport.height <= 0) return null;
  const metrics = message.viewport;
  const width = Math.max(1, Math.round(metrics.width * metrics.dpr));
  const height = Math.max(1, Math.round(metrics.height * metrics.dpr));
  if (!canvas) canvas = new OffscreenCanvas(width, height);
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  ctx ||= canvas.getContext("2d");
  if (!ctx) throw new Error("Workbook offscreen canvas context is unavailable.");

  const layout = buildSheetLayout(sheet, message.sheetIndex);
  drawSheet(ctx, sheet, layout, message.camera, metrics, message.theme, normalizeSelection(message.selection), message.search || "");
  return { bitmap: canvas.transferToImageBitmap(), layout };
}

function buildSheetLayout(sheet: SpreadsheetPreviewSheet, sheetIndex: number): WorkbookSheetLayout {
  const columnCount = Math.max(26, sheet.renderedColumns || 0, sheet.totalColumns || 0, 1);
  const rowsByNumber = new Map(sheet.rows.map((row) => [row.number, row] as const));
  const maxRowNumber = Math.max(1, sheet.renderedRows || 1, ...sheet.rows.map((row) => row.number));
  const rowCount = Math.max(120, maxRowNumber, sheet.renderedRows || 0);
  const rowNumbers = Array.from({ length: rowCount }, (_value, index) => index + 1);
  const columnWidths = Array.from({ length: columnCount }, (_value, index) => {
    const column = sheet.columns?.find((item) => item.index === index + 1);
    if (column?.hidden) return 0;
    return clamp(column?.widthPx || DEFAULT_CELL_WIDTH, MIN_CELL_WIDTH, MAX_CELL_WIDTH);
  });
  const rowHeights = rowNumbers.map((rowNumber) => {
    const row = rowsByNumber.get(rowNumber);
    if (row?.hidden) return 0;
    return clamp(row?.heightPx || DEFAULT_CELL_HEIGHT, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
  });
  const columnLefts = cumulativeOffsets(columnWidths, ROW_HEADER_WIDTH);
  const rowTops = cumulativeOffsets(rowHeights, COLUMN_HEADER_HEIGHT);
  const cellRects = collectCellRects(sheet, rowNumbers, columnWidths, rowHeights, columnLefts, rowTops);
  const baseWidth = ROW_HEADER_WIDTH + columnWidths.reduce((sum, value) => sum + value, 0);
  const baseHeight = COLUMN_HEADER_HEIGHT + rowHeights.reduce((sum, value) => sum + value, 0);
  const chartRects = collectChartRects(sheet, columnWidths, rowHeights, columnLefts, rowTops);
  const shapeRects = collectShapeRects(sheet, columnWidths, rowHeights, columnLefts, rowTops);
  const drawingRects = [...chartRects, ...shapeRects];
  const contentWidth = drawingRects.reduce((width, drawing) => Math.max(width, drawing.x + drawing.width + 24), baseWidth);
  const contentHeight = drawingRects.reduce((height, drawing) => Math.max(height, drawing.y + drawing.height + 24), baseHeight);
  return {
    sheetIndex,
    width: contentWidth,
    height: contentHeight,
    rowHeaderWidth: ROW_HEADER_WIDTH,
    columnHeaderHeight: COLUMN_HEADER_HEIGHT,
    rowNumbers,
    columnWidths,
    rowHeights,
    columnLefts,
    rowTops,
    cells: cellRects,
    charts: chartRects,
    shapes: shapeRects,
  };
}

function collectCellRects(
  sheet: SpreadsheetPreviewSheet,
  rowNumbers: number[],
  columnWidths: number[],
  rowHeights: number[],
  columnLefts: number[],
  rowTops: number[],
): WorkbookCellRect[] {
  const cells: WorkbookCellRect[] = [];
  const rowIndexByNumber = new Map(rowNumbers.map((rowNumber, index) => [rowNumber, index] as const));
  for (const row of sheet.rows) {
    const rowIndex = rowIndexByNumber.get(row.number);
    if (rowIndex == null) continue;
    const objects = normalizedRowCells(row);
    for (const cell of objects) {
      const columnIndex = cell.column - 1;
      if (columnIndex < 0 || columnIndex >= columnWidths.length) continue;
      const merge = mergeForCell(sheet.mergedCells || [], cell.row, cell.column);
      if (merge && (merge.startRow !== cell.row || merge.startColumn !== cell.column)) continue;
      const width = merge ? mergedWidth(merge, columnWidths) : columnWidths[columnIndex] || DEFAULT_CELL_WIDTH;
      const height = merge ? mergedHeight(merge, rowIndexByNumber, rowHeights) : rowHeights[rowIndex] || DEFAULT_CELL_HEIGHT;
      cells.push({
        row: cell.row,
        column: cell.column,
        ref: merge?.ref || cell.ref,
        text: cell.text,
        x: columnLefts[columnIndex] || ROW_HEADER_WIDTH,
        y: rowTops[rowIndex] || COLUMN_HEADER_HEIGHT,
        width,
        height,
      });
    }
  }
  return cells;
}

function collectChartRects(
  sheet: SpreadsheetPreviewSheet,
  columnWidths: number[],
  rowHeights: number[],
  columnLefts: number[],
  rowTops: number[],
): WorkbookChartRect[] {
  const charts = sheet.charts || [];
  if (charts.length === 0) return [];
  const fallbackColumn = Math.max(1, Math.min(columnWidths.length + 1, Math.max(6, Math.min(columnWidths.length + 1, sheet.renderedColumns + 2))));
  return charts.map((chart, index) => {
    const anchor = chart.anchor;
    const anchorColumn = clamp(Math.floor(anchor?.fromColumn || fallbackColumn), 1, columnWidths.length + 1);
    const anchorRow = clamp(Math.floor(anchor?.fromRow || 2 + index * 10), 1, rowHeights.length + 1);
    const x = columnLefts[anchorColumn - 1] ?? ROW_HEADER_WIDTH + columnWidths.reduce((sum, value) => sum + value, 0) + 24;
    const y = rowTops[anchorRow - 1] ?? COLUMN_HEADER_HEIGHT + DEFAULT_CELL_HEIGHT * (1 + index * 10);
    const toColumn = anchor?.toColumn;
    const toRow = anchor?.toRow;
    const width = Math.max(
      220,
      anchor?.widthPx || (toColumn && toColumn > anchorColumn ? sumSlice(columnWidths, anchorColumn - 1, toColumn - 1) : Math.min(DEFAULT_CHART_WIDTH, DEFAULT_CELL_WIDTH * 5)),
    );
    const height = Math.max(
      160,
      anchor?.heightPx || (toRow && toRow > anchorRow ? sumSlice(rowHeights, anchorRow - 1, toRow - 1) : Math.min(DEFAULT_CHART_HEIGHT, DEFAULT_CELL_HEIGHT * 8)),
    );
    return { id: chart.id, chart, x, y, width, height };
  });
}

function collectShapeRects(
  sheet: SpreadsheetPreviewSheet,
  columnWidths: number[],
  rowHeights: number[],
  columnLefts: number[],
  rowTops: number[],
): WorkbookShapeRect[] {
  const shapes = sheet.shapes || [];
  if (shapes.length === 0) return [];
  const fallbackColumn = Math.max(1, Math.min(columnWidths.length + 1, Math.max(6, Math.min(columnWidths.length + 1, sheet.renderedColumns + 2))));
  return shapes.map((shape, index) => {
    const anchor = shape.anchor;
    const anchorColumn = clamp(Math.floor(anchor?.fromColumn || fallbackColumn), 1, columnWidths.length + 1);
    const anchorRow = clamp(Math.floor(anchor?.fromRow || 2 + index * 4), 1, rowHeights.length + 1);
    const x = columnLefts[anchorColumn - 1] ?? ROW_HEADER_WIDTH + columnWidths.reduce((sum, value) => sum + value, 0) + 24;
    const y = rowTops[anchorRow - 1] ?? COLUMN_HEADER_HEIGHT + DEFAULT_CELL_HEIGHT * (1 + index * 4);
    const toColumn = anchor?.toColumn;
    const toRow = anchor?.toRow;
    const width = Math.max(
      80,
      anchor?.widthPx || (toColumn && toColumn > anchorColumn ? sumSlice(columnWidths, anchorColumn - 1, toColumn - 1) : DEFAULT_CELL_WIDTH * 3),
    );
    const height = Math.max(
      36,
      anchor?.heightPx || (toRow && toRow > anchorRow ? sumSlice(rowHeights, anchorRow - 1, toRow - 1) : DEFAULT_CELL_HEIGHT * 3),
    );
    return { id: shape.id, shape, x, y, width, height };
  });
}

function drawSheet(
  context: OffscreenCanvasRenderingContext2D,
  sheet: SpreadsheetPreviewSheet,
  layout: WorkbookSheetLayout,
  camera: Camera,
  metrics: ViewportMetrics,
  theme: Theme,
  selection: WorkbookSelection | null,
  search: string,
): void {
  const zoom = clamp(camera.zoom || 1, 0.25, 3);
  context.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
  context.clearRect(0, 0, metrics.width, metrics.height);
  context.fillStyle = theme.background;
  context.fillRect(0, 0, metrics.width, metrics.height);

  context.save();
  context.translate(-camera.x, -camera.y);
  context.scale(zoom, zoom);

  drawSheetBackground(context, layout, theme);
  drawGridHeaders(context, layout, theme);
  drawSelectionFill(context, layout, theme, selection);
  drawCells(context, sheet, layout, theme, selection, search.trim().toLowerCase());
  drawCharts(context, layout, theme);
  drawShapes(context, layout, theme);
  drawSelectionOutline(context, layout, theme, selection);
  drawFreezePanes(context, sheet, layout, theme);

  context.restore();
}

function drawCharts(context: OffscreenCanvasRenderingContext2D, layout: WorkbookSheetLayout, theme: Theme): void {
  for (const chartRect of layout.charts) drawChart(context, chartRect, theme);
}

function drawShapes(context: OffscreenCanvasRenderingContext2D, layout: WorkbookSheetLayout, theme: Theme): void {
  for (const rect of layout.shapes) drawShape(context, rect, theme);
}

function drawShape(context: OffscreenCanvasRenderingContext2D, rect: WorkbookShapeRect, theme: Theme): void {
  const { shape, x, y, width, height } = rect;
  context.save();
  const fill = normalizeChartColor(shape.fillColor) || "#ffffff";
  const stroke = normalizeChartColor(shape.lineColor) || "#94a3b8";
  context.fillStyle = fill;
  context.strokeStyle = stroke;
  context.lineWidth = 1.25;
  if (shape.shapeType === "ellipse" || shape.shapeType === "roundRect") {
    roundedRect(context, x + 0.5, y + 0.5, width - 1, height - 1, shape.shapeType === "ellipse" ? Math.min(width, height) / 2 : 10);
    context.fill();
    context.stroke();
  } else {
    context.fillRect(x, y, width, height);
    context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  }
  const text = shape.text || shape.name;
  if (text) {
    context.beginPath();
    context.rect(x + 6, y + 4, Math.max(1, width - 12), Math.max(1, height - 8));
    context.clip();
    context.fillStyle = theme.foreground;
    context.font = "12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    context.textAlign = "left";
    context.textBaseline = "top";
    wrapCanvasText(context, text, x + 8, y + 7, Math.max(1, width - 16), Math.max(1, height - 14), 16);
  }
  context.restore();
}

function drawChart(context: OffscreenCanvasRenderingContext2D, rect: WorkbookChartRect, theme: Theme): void {
  const { chart, x, y, width, height } = rect;
  context.save();
  context.fillStyle = "#ffffff";
  context.fillRect(x, y, width, height);
  context.strokeStyle = EXCEL_CHART_BORDER;
  context.lineWidth = 1;
  context.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  context.beginPath();
  context.rect(x + 1, y + 1, Math.max(1, width - 2), Math.max(1, height - 2));
  context.clip();

  context.fillStyle = EXCEL_TEXT;
  context.font = "400 14px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "top";
  context.fillText(truncateToWidth(context, chart.title || chart.name || "图表", Math.max(40, width - 24)), x + width / 2, y + 12);

  const legendPosition = chart.style?.legendPosition || defaultChartLegendPosition(chart);
  const legendEntries = chartLegendEntries(chart);
  const hasLegend = legendPosition !== "none" && legendEntries.length > 0;
  const legendWidth = hasLegend && (legendPosition === "right" || legendPosition === "left") ? Math.min(150, Math.max(86, width * 0.24)) : 0;
  const legendHeight = hasLegend && (legendPosition === "top" || legendPosition === "bottom") ? 30 : 0;
  const leftPadding = legendPosition === "left" ? legendWidth + 28 : 54 + (chart.style?.axis?.valueTitle ? 14 : 0);
  const rightPadding = legendPosition === "right" ? legendWidth + 22 : 24;
  const topPadding = 42 + (legendPosition === "top" ? legendHeight : 0);
  const bottomPadding = 40 + (chart.style?.axis?.categoryTitle ? 14 : 0) + (legendPosition === "bottom" ? legendHeight : 0);
  const plot = {
    x: x + leftPadding,
    y: y + topPadding,
    width: Math.max(80, width - leftPadding - rightPadding),
    height: Math.max(60, height - topPadding - bottomPadding),
  };
  const renderable = chart.series.some((series) => series.values.length > 0);
  if (!renderable) drawEmptyChart(context, plot, theme);
  else if (chart.type === "pie" || chart.type === "doughnut") drawPieChart(context, chart, plot, theme);
  else if (chart.type === "radar") drawRadarChart(context, chart, plot, theme);
  else if (chart.type === "bubble") drawBubbleChart(context, chart, plot, theme);
  else if (chart.type === "stock" || chart.type === "surface" || chart.type === "treemap" || chart.type === "sunburst" || chart.type === "histogram" || chart.type === "boxWhisker" || chart.type === "waterfall") drawSpecialtyChart(context, chart, plot, theme);
  else if (hasMixedSeriesTypes(chart)) drawComboChart(context, chart, plot, theme);
  else if (chart.type === "line" || chart.type === "scatter" || chart.type === "area") drawLineChart(context, chart, plot, theme);
  else if (chart.type === "bar" && chartBarDirection(chart) === "bar") drawHorizontalBarChart(context, chart, plot, theme);
  else drawBarChart(context, chart, plot, theme);
  if (hasLegend) drawChartLegend(context, legendEntries, chartLegendRect({ x, y, width, height }, legendPosition, legendWidth, legendHeight), theme);

  context.restore();
}

function drawBarChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 4);
  const categories = mergedChartCategories(series).slice(0, 12);
  const stacking = chartStacking(chart);
  const scale = chartAxisScale(chart, 0, barChartMax(series, categories.length, stacking));
  drawValueAxis(context, plot, theme, scale, chart.style?.axis);
  const groupWidth = plot.width / Math.max(1, categories.length);
  const gapRatio = clamp((chart.style?.gapWidth ?? 150) / 500, 0.08, 0.55);
  const activeSeriesCount = stacking === "clustered" ? Math.max(1, series.length) : 1;
  const available = groupWidth * (1 - gapRatio);
  const barGap = activeSeriesCount > 1 ? 2 : 0;
  const barWidth = Math.max(3, Math.min(28, (available - barGap * Math.max(0, activeSeriesCount - 1)) / activeSeriesCount));
  categories.forEach((category, categoryIndex) => {
    const groupX = plot.x + categoryIndex * groupWidth + groupWidth / 2 - ((barWidth + barGap) * activeSeriesCount - barGap) / 2;
    let stackY = plot.y + plot.height;
    const stackTotal = series.reduce((sum, item) => sum + Math.max(0, item.values[categoryIndex] || 0), 0) || 1;
    series.forEach((item, seriesIndex) => {
      const value = Math.max(0, item.values[categoryIndex] || 0);
      const plottedValue = stacking === "percentStacked" ? (value / stackTotal) * 100 : value;
      const barHeight = Math.max(1, valueToChartRatio(plottedValue, scale) * (plot.height - 20));
      const barX = stacking === "clustered" ? groupX + seriesIndex * (barWidth + barGap) : groupX;
      const barY = stacking === "clustered" ? plot.y + plot.height - barHeight : stackY - barHeight;
      context.fillStyle = chartSeriesColor(item, seriesIndex);
      context.fillRect(barX, barY, barWidth, barHeight);
      if (stacking !== "clustered") stackY = barY;
      drawBarDataLabel(context, chart, item, categories[categoryIndex] || String(categoryIndex + 1), value, stackTotal, barX + barWidth / 2, barY - 8, barWidth + 42, theme);
    });
    drawRotatedLabel(context, truncateLabel(category, 9), plot.x + categoryIndex * groupWidth + groupWidth / 2, plot.y + plot.height + 12, theme);
  });
}

function drawHorizontalBarChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 4);
  const categories = mergedChartCategories(series).slice(0, 12);
  const stacking = chartStacking(chart);
  const scale = chartAxisScale(chart, 0, barChartMax(series, categories.length, stacking));
  const rowHeight = plot.height / Math.max(1, categories.length);
  const labelWidth = Math.min(92, Math.max(58, plot.width * 0.28));
  const axisX = plot.x + labelWidth;
  const barWidthMax = Math.max(20, plot.width - labelWidth - 10);
  drawHorizontalValueAxis(context, { x: axisX, y: plot.y, width: barWidthMax, height: plot.height }, theme, scale, chart.style?.axis);
  context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  categories.forEach((category, index) => {
    const y = plot.y + index * rowHeight;
    context.fillStyle = EXCEL_TEXT;
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.fillText(truncateToWidth(context, category || String(index + 1), labelWidth - 8), plot.x + labelWidth - 8, y + rowHeight / 2);
    const barHeight = Math.max(4, Math.min(22, rowHeight * 0.52));
    const stackTotal = series.reduce((sum, item) => sum + Math.max(0, item.values[index] || 0), 0) || 1;
    const activeSeriesCount = stacking === "clustered" ? Math.max(1, series.length) : 1;
    const segmentHeight = stacking === "clustered" ? Math.max(3, barHeight / activeSeriesCount - 1) : barHeight;
    let cursorX = axisX + 1;
    series.forEach((item, seriesIndex) => {
      const value = Math.max(0, item.values[index] || 0);
      const plottedValue = stacking === "percentStacked" ? (value / stackTotal) * 100 : value;
      const segmentWidth = Math.max(2, valueToChartRatio(plottedValue, scale) * barWidthMax);
      const segmentY = stacking === "clustered"
        ? y + rowHeight / 2 - barHeight / 2 + seriesIndex * (segmentHeight + 1)
        : y + rowHeight / 2 - barHeight / 2;
      const segmentX = stacking === "clustered" ? axisX + 1 : cursorX;
      context.fillStyle = chartSeriesColor(item, seriesIndex);
      context.fillRect(segmentX, segmentY, segmentWidth, segmentHeight);
      if (stacking !== "clustered" || segmentWidth > 32) {
        drawBarDataLabel(context, chart, item, category || String(index + 1), value, stackTotal, segmentX + segmentWidth / 2, segmentY + segmentHeight / 2, segmentWidth - 4, theme);
      }
      if (stacking !== "clustered") cursorX += segmentWidth;
    });
  });
}

function drawLineChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 5);
  const values = series.flatMap((item) => item.values);
  const xValues = series.flatMap((item) => item.xValues || []);
  const scale = chartAxisScale(chart, Math.min(...values, 0), Math.max(...values, 1));
  const xScale = xValues.length > 0 ? { min: Math.min(...xValues), max: Math.max(...xValues) } : undefined;
  drawValueAxis(context, plot, theme, scale, chart.style?.axis);
  drawLineSeries(context, chart, series, plot, scale.min, Math.max(1, scale.max - scale.min), theme, xScale);
}

function drawComboChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 8);
  const values = series.flatMap((item) => item.values);
  const scale = chartAxisScale(chart, Math.min(...values, 0), Math.max(...values.map((value) => Math.max(0, value)), 1));
  const span = Math.max(1, scale.max - scale.min);
  drawValueAxis(context, plot, theme, scale, chart.style?.axis);
  const barSeries = series.filter((item) => (item.chartType || chart.type) === "bar" || (item.chartType || chart.type) === "area");
  const lineSeries = series.filter((item) => (item.chartType || chart.type) === "line" || (item.chartType || chart.type) === "scatter");
  drawComboBars(context, chart, barSeries, plot, scale, theme);
  drawLineSeries(context, chart, lineSeries, plot, scale.min, span, theme);
}

function drawLineSeries(
  context: OffscreenCanvasRenderingContext2D,
  chart: SpreadsheetPreviewChart,
  series: SpreadsheetPreviewChartSeries[],
  plot: Rect,
  minValue: number,
  span: number,
  theme: Theme,
  xScale?: { min: number; max: number },
): void {
  for (const [seriesIndex, item] of series.entries()) {
    const color = chartSeriesColor(item, seriesIndex);
    const seriesType = item.chartType || chart.type;
    const points = item.values.map((value, index) => {
      const xValue = item.xValues?.[index];
      const xRatio = xScale && xValue != null && Number.isFinite(xValue)
        ? (xValue - xScale.min) / Math.max(1e-9, xScale.max - xScale.min)
        : (item.values.length <= 1 ? 0.5 : index / (item.values.length - 1));
      return {
        x: plot.x + clamp(xRatio, 0, 1) * plot.width,
        y: plot.y + plot.height - ((value - minValue) / span) * plot.height,
      };
    });
    if (seriesType === "area" && points.length > 1) {
      context.beginPath();
      context.moveTo(points[0].x, plot.y + plot.height);
      for (const point of points) context.lineTo(point.x, point.y);
      context.lineTo(points[points.length - 1].x, plot.y + plot.height);
      context.closePath();
      context.fillStyle = alphaColor(color, 0.16);
      context.fill();
    }
    if (seriesType !== "scatter" && points.length > 1) {
      context.beginPath();
      points.forEach((point, index) => {
        if (index === 0) context.moveTo(point.x, point.y);
        else if (item.smooth && index < points.length - 1) {
          const previous = points[index - 1];
          const next = points[index + 1];
          const cpx = (previous.x + point.x) / 2;
          const cpy = (previous.y + point.y) / 2;
          context.quadraticCurveTo(cpx, cpy, point.x, point.y);
          context.quadraticCurveTo((point.x + next.x) / 2, (point.y + next.y) / 2, next.x, next.y);
        } else {
          context.lineTo(point.x, point.y);
        }
      });
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.stroke();
    }
    const markerSize = markerRadius(item, seriesType);
    if (markerSize <= 0) continue;
    for (const [pointIndex, point] of points.entries()) {
      context.fillStyle = color;
      context.beginPath();
      context.arc(point.x, point.y, markerSize, 0, Math.PI * 2);
      context.fill();
      drawPointDataLabel(context, chart, item, pointIndex, point, theme);
    }
  }
}

function drawComboBars(
  context: OffscreenCanvasRenderingContext2D,
  chart: SpreadsheetPreviewChart,
  series: SpreadsheetPreviewChartSeries[],
  plot: Rect,
  scale: ChartAxisScale,
  theme: Theme,
): void {
  if (series.length === 0) return;
  const categories = mergedChartCategories(series).slice(0, 12);
  const groupWidth = plot.width / Math.max(1, categories.length);
  const barWidth = Math.max(3, Math.min(22, groupWidth * 0.42 / Math.max(1, series.length)));
  categories.forEach((_category, categoryIndex) => {
      const groupX = plot.x + categoryIndex * groupWidth + groupWidth / 2 - (barWidth * series.length) / 2;
    series.forEach((item, seriesIndex) => {
      const value = Math.max(0, item.values[categoryIndex] || 0);
      const barHeight = Math.max(1, valueToChartRatio(value, scale) * (plot.height - 20));
      context.fillStyle = chartSeriesColor(item, seriesIndex);
      context.fillRect(groupX + seriesIndex * barWidth, plot.y + plot.height - barHeight, Math.max(2, barWidth - 2), barHeight);
    });
  });
}

function drawPieChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.find((item) => item.values.length > 0);
  const values = series?.values.slice(0, 10).map((value) => Math.max(0, value)) || [];
  const categories = series?.categories.length ? series.categories.slice(0, values.length) : values.map((_value, index) => String(index + 1));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  const radius = Math.max(24, Math.min(plot.height - 14, plot.width - 16) / 2);
  const centerX = plot.x + plot.width / 2;
  const centerY = plot.y + plot.height / 2;
  let angle = ((chart.style?.firstSliceAngle ?? 0) - 90) * (Math.PI / 180);
  values.forEach((value, index) => {
    const slice = (value / total) * Math.PI * 2;
    context.beginPath();
    context.moveTo(centerX, centerY);
    context.arc(centerX, centerY, radius, angle, angle + slice);
    context.closePath();
    context.fillStyle = chartPointColor(series, index);
    context.fill();
    context.strokeStyle = "#ffffff";
    context.lineWidth = 1;
    context.stroke();
    if (shouldDrawDataLabels(chart, slice, radius)) {
      drawPieDataLabel(context, chart, categories[index] || String(index + 1), value, total, centerX, centerY, radius, angle + slice / 2, theme);
    }
    angle += slice;
  });
  if (chart.type === "doughnut") {
    context.beginPath();
    const holeSize = clamp((chart.style?.holeSize ?? 52) / 100, 0.08, 0.88);
    context.arc(centerX, centerY, radius * holeSize, 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
  }
}

function drawRadarChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 4);
  const categories = mergedChartCategories(series);
  const axisCount = Math.max(3, categories.length || Math.max(...series.map((item) => item.values.length), 0));
  const values = series.flatMap((item) => item.values);
  const maxValue = chart.style?.axis?.valueMax ?? Math.max(...values, 1);
  const minValue = chart.style?.axis?.valueMin ?? 0;
  const span = Math.max(1, maxValue - minValue);
  const centerX = plot.x + plot.width / 2;
  const centerY = plot.y + plot.height / 2;
  const radius = Math.max(28, Math.min(plot.width, plot.height) / 2 - 26);
  context.save();
  context.font = "9px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.textBaseline = "middle";
  for (let ring = 1; ring <= 4; ring += 1) {
    const ringRadius = (radius / 4) * ring;
    context.beginPath();
    for (let axis = 0; axis < axisCount; axis += 1) {
      const angle = -Math.PI / 2 + (axis / axisCount) * Math.PI * 2;
      const x = centerX + Math.cos(angle) * ringRadius;
      const y = centerY + Math.sin(angle) * ringRadius;
      axis === 0 ? context.moveTo(x, y) : context.lineTo(x, y);
    }
    context.closePath();
    context.strokeStyle = alphaColor(theme.border, 0.8);
    context.lineWidth = 1;
    context.stroke();
  }
  for (let axis = 0; axis < axisCount; axis += 1) {
    const angle = -Math.PI / 2 + (axis / axisCount) * Math.PI * 2;
    context.beginPath();
    context.moveTo(centerX, centerY);
    context.lineTo(centerX + Math.cos(angle) * radius, centerY + Math.sin(angle) * radius);
    context.strokeStyle = alphaColor(theme.border, 0.7);
    context.stroke();
    const label = truncateLabel(categories[axis] || String(axis + 1), 10);
    context.fillStyle = theme.mutedForeground;
    context.textAlign = Math.cos(angle) < -0.25 ? "right" : Math.cos(angle) > 0.25 ? "left" : "center";
    context.fillText(label, centerX + Math.cos(angle) * (radius + 12), centerY + Math.sin(angle) * (radius + 12));
  }
  for (const [seriesIndex, item] of series.entries()) {
    const color = chartSeriesColor(item, seriesIndex);
    context.beginPath();
    for (let axis = 0; axis < axisCount; axis += 1) {
      const value = Math.max(0, item.values[axis] || 0);
      const angle = -Math.PI / 2 + (axis / axisCount) * Math.PI * 2;
      const distance = clamp((value - minValue) / span, 0, 1) * radius;
      const x = centerX + Math.cos(angle) * distance;
      const y = centerY + Math.sin(angle) * distance;
      axis === 0 ? context.moveTo(x, y) : context.lineTo(x, y);
    }
    context.closePath();
    context.fillStyle = alphaColor(color, 0.14);
    context.fill();
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.stroke();
  }
  context.restore();
}

function drawBubbleChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.filter((item) => item.values.length > 0 || (item.xValues?.length && item.yValues?.length)).slice(0, 6);
  const points = series.flatMap((item) => {
    const yValues = item.yValues?.length ? item.yValues : item.values;
    const xValues = item.xValues?.length ? item.xValues : yValues.map((_value, index) => index + 1);
    const sizes = item.bubbleSizes?.length ? item.bubbleSizes : yValues.map(() => 1);
    return yValues.map((yValue, index) => ({ xValue: xValues[index] ?? index + 1, yValue, size: sizes[index] ?? 1 }));
  });
  if (points.length === 0) {
    drawEmptyChart(context, plot, theme);
    return;
  }
  const minX = Math.min(...points.map((point) => point.xValue), 0);
  const maxX = Math.max(...points.map((point) => point.xValue), 1);
  const minY = Math.min(...points.map((point) => point.yValue), 0);
  const maxY = Math.max(...points.map((point) => point.yValue), 1);
  const maxSize = Math.max(...points.map((point) => point.size), 1);
  drawValueAxis(context, plot, theme, chartAxisScale(chart, minY, maxY), chart.style?.axis);
  for (const [seriesIndex, item] of series.entries()) {
    const color = chartSeriesColor(item, seriesIndex);
    const yValues = item.yValues?.length ? item.yValues : item.values;
    const xValues = item.xValues?.length ? item.xValues : yValues.map((_value, index) => index + 1);
    const sizes = item.bubbleSizes?.length ? item.bubbleSizes : yValues.map(() => 1);
    for (let index = 0; index < yValues.length; index += 1) {
      const x = plot.x + ((xValues[index] ?? index + 1) - minX) / Math.max(1, maxX - minX) * plot.width;
      const y = plot.y + plot.height - ((yValues[index] - minY) / Math.max(1, maxY - minY)) * plot.height;
      const radius = clamp(4 + Math.sqrt(Math.max(0, sizes[index] ?? 1) / maxSize) * 16, 4, 22);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fillStyle = alphaColor(color, 0.45);
      context.fill();
      context.strokeStyle = color;
      context.lineWidth = 1;
      context.stroke();
    }
  }
}

function drawSpecialtyChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  if (chart.type === "histogram") {
    drawBarChart(context, { ...chart, type: "bar", style: { ...chart.style, grouping: "clustered" } }, plot, theme);
    return;
  }
  if (chart.type === "waterfall") {
    drawWaterfallChart(context, chart, plot, theme);
    return;
  }
  if (chart.type === "treemap" || chart.type === "sunburst") {
    drawTreemapLikeChart(context, chart, plot, theme);
    return;
  }
  if (chart.type === "stock") {
    drawStockChart(context, chart, plot, theme);
    return;
  }
  if (chart.type === "boxWhisker") {
    drawBoxWhiskerChart(context, chart, plot, theme);
    return;
  }
  if (chart.type === "surface") {
    drawSurfaceChart(context, chart, plot, theme);
    return;
  }
  context.save();
  drawLineChart(context, { ...chart, type: "area" }, plot, theme);
  context.fillStyle = theme.mutedForeground;
  context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.textAlign = "right";
  context.textBaseline = "bottom";
  context.fillText(specialtyChartLabel(chart.type), plot.x + plot.width - 4, plot.y + plot.height - 4);
  context.restore();
}

function drawStockChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 4);
  const values = series.flatMap((item) => item.values);
  if (series.length === 0 || values.length === 0) {
    drawEmptyChart(context, plot, theme);
    return;
  }
  const scale = chartAxisScale(chart, Math.min(...values, 0), Math.max(...values, 1));
  drawValueAxis(context, plot, theme, scale, chart.style?.axis);
  const pointCount = Math.max(...series.map((item) => item.values.length));
  const step = plot.width / Math.max(1, pointCount);
  const lowSeries = series[0];
  const highSeries = series[1] || series[0];
  const openSeries = series[2];
  const closeSeries = series[3] || series[series.length - 1];
  for (let index = 0; index < pointCount; index += 1) {
    const low = lowSeries.values[index] ?? Math.min(...series.map((item) => item.values[index] ?? Number.POSITIVE_INFINITY).filter(Number.isFinite));
    const high = highSeries.values[index] ?? Math.max(...series.map((item) => item.values[index] ?? Number.NEGATIVE_INFINITY).filter(Number.isFinite));
    const open = openSeries?.values[index] ?? low;
    const close = closeSeries?.values[index] ?? high;
    if (![low, high, open, close].every(Number.isFinite)) continue;
    const x = plot.x + (index + 0.5) * step;
    const yLow = plot.y + plot.height - valueToChartRatio(low, scale) * plot.height;
    const yHigh = plot.y + plot.height - valueToChartRatio(high, scale) * plot.height;
    const yOpen = plot.y + plot.height - valueToChartRatio(open, scale) * plot.height;
    const yClose = plot.y + plot.height - valueToChartRatio(close, scale) * plot.height;
    const color = close >= open ? "#16a34a" : "#dc2626";
    context.strokeStyle = EXCEL_TEXT;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x, yHigh);
    context.lineTo(x, yLow);
    context.stroke();
    const candleWidth = Math.max(4, Math.min(18, step * 0.5));
    const top = Math.min(yOpen, yClose);
    const height = Math.max(2, Math.abs(yClose - yOpen));
    context.fillStyle = alphaColor(color, 0.72);
    context.fillRect(x - candleWidth / 2, top, candleWidth, height);
    context.strokeStyle = color;
    context.strokeRect(x - candleWidth / 2, top, candleWidth, height);
  }
}

function drawBoxWhiskerChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 8);
  const values = series.flatMap((item) => item.values);
  if (series.length === 0 || values.length === 0) {
    drawEmptyChart(context, plot, theme);
    return;
  }
  const scale = chartAxisScale(chart, Math.min(...values, 0), Math.max(...values, 1));
  drawValueAxis(context, plot, theme, scale, chart.style?.axis);
  const groupWidth = plot.width / Math.max(1, series.length);
  series.forEach((item, index) => {
    const sorted = [...item.values].filter(Number.isFinite).sort((left, right) => left - right);
    if (sorted.length === 0) return;
    const min = sorted[0];
    const q1 = percentile(sorted, 0.25);
    const median = percentile(sorted, 0.5);
    const q3 = percentile(sorted, 0.75);
    const max = sorted[sorted.length - 1];
    const x = plot.x + index * groupWidth + groupWidth / 2;
    const boxWidth = Math.max(12, Math.min(34, groupWidth * 0.46));
    const yMin = plot.y + plot.height - valueToChartRatio(min, scale) * plot.height;
    const yQ1 = plot.y + plot.height - valueToChartRatio(q1, scale) * plot.height;
    const yMedian = plot.y + plot.height - valueToChartRatio(median, scale) * plot.height;
    const yQ3 = plot.y + plot.height - valueToChartRatio(q3, scale) * plot.height;
    const yMax = plot.y + plot.height - valueToChartRatio(max, scale) * plot.height;
    const color = chartSeriesColor(item, index);
    context.strokeStyle = color;
    context.lineWidth = 1.3;
    context.beginPath();
    context.moveTo(x, yMax);
    context.lineTo(x, yMin);
    context.moveTo(x - boxWidth * 0.32, yMax);
    context.lineTo(x + boxWidth * 0.32, yMax);
    context.moveTo(x - boxWidth * 0.32, yMin);
    context.lineTo(x + boxWidth * 0.32, yMin);
    context.stroke();
    context.fillStyle = alphaColor(color, 0.22);
    context.fillRect(x - boxWidth / 2, yQ3, boxWidth, Math.max(2, yQ1 - yQ3));
    context.strokeRect(x - boxWidth / 2, yQ3, boxWidth, Math.max(2, yQ1 - yQ3));
    context.beginPath();
    context.moveTo(x - boxWidth / 2, yMedian);
    context.lineTo(x + boxWidth / 2, yMedian);
    context.stroke();
  });
}

function drawSurfaceChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 10);
  const values = series.flatMap((item) => item.values);
  if (series.length === 0 || values.length === 0) {
    drawEmptyChart(context, plot, theme);
    return;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const columns = Math.max(...series.map((item) => item.values.length));
  const cellWidth = plot.width / Math.max(1, columns);
  const cellHeight = plot.height / Math.max(1, series.length);
  series.forEach((item, rowIndex) => {
    item.values.forEach((value, columnIndex) => {
      const ratio = valueToChartRatio(value, { min, max: max <= min ? min + 1 : max });
      context.fillStyle = heatColor(ratio);
      context.fillRect(plot.x + columnIndex * cellWidth, plot.y + rowIndex * cellHeight, Math.ceil(cellWidth), Math.ceil(cellHeight));
    });
  });
  context.strokeStyle = alphaColor(EXCEL_AXIS, 0.5);
  context.strokeRect(plot.x + 0.5, plot.y + 0.5, plot.width - 1, plot.height - 1);
}

function drawWaterfallChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.find((item) => item.values.length > 0);
  const values = series?.values.slice(0, 14) || [];
  if (values.length === 0) {
    drawEmptyChart(context, plot, theme);
    return;
  }
  const running: number[] = [];
  values.reduce((sum, value, index) => {
    const next = sum + value;
    running[index] = next;
    return next;
  }, 0);
  const minValue = Math.min(0, ...running);
  const maxValue = Math.max(1, ...running);
  const span = Math.max(1, maxValue - minValue);
  drawValueAxis(context, plot, theme, chartAxisScale(chart, minValue, maxValue), chart.style?.axis);
  const barWidth = Math.max(4, Math.min(28, plot.width / Math.max(1, values.length) * 0.54));
  let previous = 0;
  values.forEach((value, index) => {
    const start = previous;
    const end = previous + value;
    const topValue = Math.max(start, end);
    const bottomValue = Math.min(start, end);
    const x = plot.x + (index + 0.5) * (plot.width / values.length) - barWidth / 2;
    const y = plot.y + plot.height - ((topValue - minValue) / span) * plot.height;
    const height = Math.max(2, ((topValue - bottomValue) / span) * plot.height);
    context.fillStyle = value >= 0 ? "#16a34a" : "#dc2626";
    context.fillRect(x, y, barWidth, height);
    previous = end;
  });
}

function drawTreemapLikeChart(context: OffscreenCanvasRenderingContext2D, chart: SpreadsheetPreviewChart, plot: Rect, theme: Theme): void {
  const series = chart.series.find((item) => item.values.length > 0);
  const values = series?.values.slice(0, 12).map((value) => Math.max(0, value)) || [];
  const categories = series?.categories.length ? series.categories : values.map((_value, index) => String(index + 1));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  if (values.length === 0) {
    drawEmptyChart(context, plot, theme);
    return;
  }
  let cursorX = plot.x;
  let cursorY = plot.y;
  let rowHeight = plot.height * 0.42;
  values.forEach((value, index) => {
    const width = Math.max(24, (value / total) * plot.width * 1.8);
    if (cursorX + width > plot.x + plot.width) {
      cursorX = plot.x;
      cursorY += rowHeight;
      rowHeight = Math.max(24, plot.y + plot.height - cursorY);
    }
    const rectWidth = Math.min(width, plot.x + plot.width - cursorX);
    const rectHeight = Math.max(18, rowHeight - 4);
    context.fillStyle = CHART_COLORS[index % CHART_COLORS.length];
    context.fillRect(cursorX, cursorY, rectWidth, rectHeight);
    context.strokeStyle = "#ffffff";
    context.strokeRect(cursorX + 0.5, cursorY + 0.5, Math.max(1, rectWidth - 1), Math.max(1, rectHeight - 1));
    context.fillStyle = "#ffffff";
    context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillText(truncateToWidth(context, categories[index] || String(index + 1), rectWidth - 8), cursorX + 4, cursorY + 4);
    cursorX += rectWidth;
  });
}

function drawEmptyChart(context: OffscreenCanvasRenderingContext2D, plot: Rect, theme: Theme): void {
  context.strokeStyle = theme.border;
  context.setLineDash([4, 4]);
  roundedRect(context, plot.x, plot.y, plot.width, plot.height, 8);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = theme.mutedForeground;
  context.font = "12px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText("暂无可渲染的图表数据", plot.x + plot.width / 2, plot.y + plot.height / 2);
}

function drawValueAxis(
  context: OffscreenCanvasRenderingContext2D,
  plot: Rect,
  theme: Theme,
  scale: ChartAxisScale,
  axis?: ChartAxisStyle,
): void {
  context.strokeStyle = EXCEL_AXIS;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(plot.x, plot.y);
  context.lineTo(plot.x, plot.y + plot.height);
  context.lineTo(plot.x + plot.width, plot.y + plot.height);
  context.stroke();
  context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.fillStyle = EXCEL_TEXT;
  context.textAlign = "right";
  context.textBaseline = "middle";
  const ticks = chartAxisTicks(scale);
  for (const [index, tick] of ticks.entries()) {
    const y = plot.y + plot.height - valueToChartRatio(tick, scale) * plot.height;
    context.strokeStyle = index === 0 ? EXCEL_AXIS : EXCEL_GRID;
    context.beginPath();
    context.moveTo(plot.x, y);
    context.lineTo(plot.x + plot.width, y);
    context.stroke();
    context.fillText(formatAxisTick(tick, scale.numberFormat), plot.x - 6, y);
  }
  if (axis?.valueTitle) {
    context.save();
    context.translate(plot.x - 42, plot.y + plot.height / 2);
    context.rotate(-Math.PI / 2);
    context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    context.fillStyle = theme.mutedForeground;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(truncateToWidth(context, axis.valueTitle, Math.max(60, plot.height - 16)), 0, 0);
    context.restore();
  }
  if (axis?.categoryTitle) {
    context.save();
    context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    context.fillStyle = theme.mutedForeground;
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillText(truncateToWidth(context, axis.categoryTitle, Math.max(60, plot.width - 16)), plot.x + plot.width / 2, plot.y + plot.height + 26);
    context.restore();
  }
}

function drawHorizontalValueAxis(
  context: OffscreenCanvasRenderingContext2D,
  plot: Rect,
  theme: Theme,
  scale: ChartAxisScale,
  axis?: ChartAxisStyle,
): void {
  context.strokeStyle = EXCEL_AXIS;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(plot.x, plot.y);
  context.lineTo(plot.x, plot.y + plot.height);
  context.lineTo(plot.x + plot.width, plot.y + plot.height);
  context.stroke();
  context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.fillStyle = EXCEL_TEXT;
  context.textAlign = "center";
  context.textBaseline = "top";
  const ticks = chartAxisTicks(scale);
  for (const tick of ticks.slice(1)) {
    const x = plot.x + valueToChartRatio(tick, scale) * plot.width;
    context.strokeStyle = EXCEL_GRID;
    context.beginPath();
    context.moveTo(x, plot.y);
    context.lineTo(x, plot.y + plot.height);
    context.stroke();
    context.fillText(formatAxisTick(tick, scale.numberFormat), x, plot.y + plot.height + 4);
  }
  if (axis?.categoryTitle) {
    context.save();
    context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
    context.fillStyle = theme.mutedForeground;
    context.textAlign = "center";
    context.textBaseline = "top";
    context.fillText(truncateToWidth(context, axis.categoryTitle, Math.max(60, plot.width - 16)), plot.x + plot.width / 2, plot.y + plot.height + 18);
    context.restore();
  }
}

type ChartLegendEntry = {
  label: string;
  color: string;
};

function chartLegendRect(chart: Rect, position: NonNullable<SpreadsheetPreviewChart["style"]>["legendPosition"], legendWidth: number, legendHeight: number): Rect {
  if (position === "left") return { x: chart.x + 10, y: chart.y + 50, width: legendWidth, height: Math.max(30, chart.height - 70) };
  if (position === "top") return { x: chart.x + 44, y: chart.y + 38, width: Math.max(60, chart.width - 68), height: legendHeight };
  if (position === "bottom") return { x: chart.x + 44, y: chart.y + chart.height - legendHeight - 8, width: Math.max(60, chart.width - 68), height: legendHeight };
  return { x: chart.x + chart.width - legendWidth - 10, y: chart.y + 50, width: legendWidth, height: Math.max(30, chart.height - 70) };
}

function defaultChartLegendPosition(chart: SpreadsheetPreviewChart): NonNullable<SpreadsheetPreviewChart["style"]>["legendPosition"] {
  if (chart.type === "pie" || chart.type === "doughnut") return "right";
  if (chart.series.length > 1) return "bottom";
  return chart.sourceRefs.length > 0 ? "right" : "none";
}

function hasMixedSeriesTypes(chart: SpreadsheetPreviewChart): boolean {
  const types = new Set(chart.series.map((series) => series.chartType || chart.type).filter((type) => type !== "unknown"));
  return types.size > 1;
}

function chartBarDirection(chart: SpreadsheetPreviewChart): "bar" | "col" {
  if (chart.style?.barDirection === "bar" || chart.subtype === "bar") return "bar";
  return "col";
}

function chartStacking(chart: SpreadsheetPreviewChart): "clustered" | "stacked" | "percentStacked" {
  if (chart.style?.grouping === "stacked") return "stacked";
  if (chart.style?.grouping === "percentStacked") return "percentStacked";
  return "clustered";
}

function barChartMax(series: SpreadsheetPreviewChartSeries[], categoryCount: number, stacking: "clustered" | "stacked" | "percentStacked"): number {
  if (stacking === "percentStacked") return 100;
  if (stacking === "stacked") {
    let maxStack = 1;
    for (let index = 0; index < categoryCount; index += 1) {
      maxStack = Math.max(maxStack, series.reduce((sum, item) => sum + Math.max(0, item.values[index] || 0), 0));
    }
    return niceMax(maxStack);
  }
  return niceMax(Math.max(...series.flatMap((item) => item.values.map((value) => Math.max(0, value))), 1));
}

function chartAxisScale(chart: SpreadsheetPreviewChart, rawMin: number, rawMax: number): ChartAxisScale {
  const minCandidate = Number.isFinite(rawMin) ? rawMin : 0;
  const maxCandidate = Number.isFinite(rawMax) ? rawMax : 1;
  const axis = chart.style?.axis;
  const min = axis?.valueMin ?? (minCandidate < 0 ? niceMin(minCandidate) : 0);
  const max = axis?.valueMax ?? niceMax(Math.max(maxCandidate, min + 1));
  return {
    min,
    max: max <= min ? min + 1 : max,
    majorUnit: axis?.majorUnit,
    numberFormat: chart.style?.grouping === "percentStacked" ? "0%" : axis?.numberFormat,
  };
}

function valueToChartRatio(value: number, scale: ChartAxisScale): number {
  return clamp((value - scale.min) / Math.max(1e-9, scale.max - scale.min), 0, 1);
}

function chartAxisTicks(scale: ChartAxisScale): number[] {
  const span = Math.max(1e-9, scale.max - scale.min);
  const unit = scale.majorUnit && scale.majorUnit > 0 ? scale.majorUnit : niceTickUnit(span / 4);
  const ticks: number[] = [];
  let value = Math.ceil(scale.min / unit) * unit;
  if (Math.abs(value - scale.min) > unit * 0.001) ticks.push(scale.min);
  for (let guard = 0; guard < 8 && value <= scale.max + unit * 0.001; guard += 1, value += unit) {
    if (value >= scale.min - unit * 0.001) ticks.push(roundTick(value));
  }
  if (Math.abs((ticks[ticks.length - 1] ?? scale.min) - scale.max) > unit * 0.001) ticks.push(scale.max);
  return ticks.slice(0, 7);
}

function niceTickUnit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalized = value / base;
  if (normalized <= 1) return base;
  if (normalized <= 2) return 2 * base;
  if (normalized <= 5) return 5 * base;
  return 10 * base;
}

function niceMin(value: number): number {
  if (!Number.isFinite(value) || value >= 0) return 0;
  return -niceMax(Math.abs(value));
}

function roundTick(value: number): number {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function drawBarDataLabel(
  context: OffscreenCanvasRenderingContext2D,
  chart: SpreadsheetPreviewChart,
  series: SpreadsheetPreviewChartSeries,
  category: string,
  value: number,
  total: number,
  x: number,
  y: number,
  maxWidth: number,
  theme: Theme,
): void {
  const labels = chart.style?.dataLabels;
  if (!labels?.showValue && !labels?.showSeriesName && !labels?.showCategoryName && !labels?.showPercent) return;
  const parts: string[] = [];
  if (labels.showSeriesName) parts.push(series.name);
  if (labels.showCategoryName) parts.push(category);
  if (labels.showValue) parts.push(formatAxisTick(value, chart.style?.axis?.numberFormat));
  if (labels.showPercent) parts.push(`${Math.round((value / Math.max(total, 1)) * 100)}%`);
  const text = parts.filter(Boolean).join(" ");
  if (!text) return;
  context.save();
  context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.fillStyle = EXCEL_TEXT;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(truncateToWidth(context, text, Math.max(16, maxWidth)), x, y);
  context.restore();
}

function drawPointDataLabel(
  context: OffscreenCanvasRenderingContext2D,
  chart: SpreadsheetPreviewChart,
  series: SpreadsheetPreviewChartSeries,
  pointIndex: number,
  point: { x: number; y: number },
  theme: Theme,
): void {
  const labels = chart.style?.dataLabels;
  if (!labels?.showValue && !labels?.showSeriesName && !labels?.showCategoryName) return;
  if (series.values.length > 24) return;
  const parts: string[] = [];
  if (labels.showSeriesName) parts.push(series.name);
  if (labels.showCategoryName) parts.push(series.categories[pointIndex] || String(pointIndex + 1));
  if (labels.showValue) parts.push(formatAxisTick(series.values[pointIndex] || 0, chart.style?.axis?.numberFormat));
  const text = parts.filter(Boolean).join(" ");
  if (!text) return;
  context.save();
  context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.fillStyle = EXCEL_TEXT;
  context.textAlign = "center";
  context.textBaseline = "bottom";
  context.fillText(truncateToWidth(context, text, 82), point.x, point.y - 6);
  context.restore();
}

function markerRadius(series: SpreadsheetPreviewChartSeries, seriesType: SpreadsheetPreviewChart["type"]): number {
  if (series.marker?.symbol === "none") return 0;
  if (series.marker?.size != null) return clamp(series.marker.size / 2, 2, 6);
  if (seriesType === "scatter") return 3.5;
  return 2.6;
}

function chartLegendEntries(chart: SpreadsheetPreviewChart): ChartLegendEntry[] {
  if (chart.type === "pie" || chart.type === "doughnut") {
    const series = chart.series.find((item) => item.values.length > 0);
    if (!series) return [];
    return series.values.slice(0, 12).map((_value, index) => ({
      label: series.categories[index] || String(index + 1),
      color: chartPointColor(series, index),
    }));
  }
  return chart.series
    .filter((item) => item.values.length > 0)
    .slice(0, 6)
    .map((series, index) => ({
      label: series.name || `系列 ${index + 1}`,
      color: chartSeriesColor(series, index),
    }));
}

function drawChartLegend(context: OffscreenCanvasRenderingContext2D, entries: ChartLegendEntry[], rect: Rect, theme: Theme): void {
  context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.textBaseline = "middle";
  context.textAlign = "left";
  let cursorX = rect.x;
  let cursorY = rect.y + 8;
  for (const entry of entries.slice(0, 12)) {
    const label = truncateLabel(entry.label, 18);
    const labelWidth = context.measureText(label).width + 20;
    if (cursorX > rect.x && cursorX + labelWidth > rect.x + rect.width) {
      cursorX = rect.x;
      cursorY += 15;
    }
    if (cursorY > rect.y + rect.height - 6) break;
    context.fillStyle = entry.color;
    context.fillRect(cursorX, cursorY - 4, 8, 8);
    context.fillStyle = EXCEL_TEXT;
    context.fillText(label, cursorX + 12, cursorY);
    cursorX += labelWidth + 10;
  }
}

function chartSeriesColor(series: SpreadsheetPreviewChartSeries | undefined, index: number): string {
  return normalizeChartColor(series?.color) || CHART_COLORS[index % CHART_COLORS.length];
}

function chartPointColor(series: SpreadsheetPreviewChartSeries | undefined, index: number): string {
  return normalizeChartColor(series?.pointColors?.[index]) || CHART_COLORS[index % CHART_COLORS.length];
}

function normalizeChartColor(value?: string): string | undefined {
  if (!value) return undefined;
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^[0-9a-f]{6}$/i.test(value)) return `#${value}`;
  return undefined;
}

function shouldDrawDataLabels(chart: SpreadsheetPreviewChart, sliceRadians: number, radius: number): boolean {
  const labels = chart.style?.dataLabels;
  if (!labels?.showCategoryName && !labels?.showValue && !labels?.showPercent && !labels?.showSeriesName) return false;
  return sliceRadians > 0.32 && radius >= 34;
}

function drawPieDataLabel(
  context: OffscreenCanvasRenderingContext2D,
  chart: SpreadsheetPreviewChart,
  category: string,
  value: number,
  total: number,
  centerX: number,
  centerY: number,
  radius: number,
  angle: number,
  theme: Theme,
): void {
  const labels = chart.style?.dataLabels;
  if (!labels) return;
  const parts: string[] = [];
  if (labels.showCategoryName) parts.push(category);
  if (labels.showValue) parts.push(formatAxisTick(value));
  if (labels.showPercent) parts.push(`${Math.round((value / Math.max(total, 1)) * 100)}%`);
  if (parts.length === 0) return;
  const distance = chart.type === "doughnut" ? radius * 0.72 : radius * 0.62;
  const x = centerX + Math.cos(angle) * distance;
  const y = centerY + Math.sin(angle) * distance;
  const text = parts.join(" ");
  context.save();
  context.font = "10px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  const width = Math.min(88, context.measureText(text).width + 8);
  context.fillStyle = "rgba(255, 255, 255, 0.86)";
  context.fillRect(x - width / 2, y - 8, width, 16);
  context.fillStyle = EXCEL_TEXT;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(truncateToWidth(context, text, width - 6), x, y);
  context.restore();
}

function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  if (value <= 5) return Math.ceil(value);
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const normalized = value / base;
  if (normalized <= 1) return base;
  if (normalized <= 2) return 2 * base;
  if (normalized <= 5) return 5 * base;
  return 10 * base;
}

function formatAxisTick(value: number, numberFormat?: string): string {
  if (!Number.isFinite(value)) return "";
  if (numberFormat?.includes("%")) {
    const percentValue = Math.abs(value) <= 1 ? value * 100 : value;
    return `${Math.round(percentValue * 10) / 10}`.replace(/\\.0$/, "") + "%";
  }
  if (Math.abs(value) >= 1000) return String(Math.round(value));
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0];
  const position = clamp(ratio, 0, 1) * (values.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (position - lower);
}

function heatColor(ratio: number): string {
  const clamped = clamp(ratio, 0, 1);
  const stops = [
    [37, 99, 235],
    [14, 165, 233],
    [34, 197, 94],
    [250, 204, 21],
    [239, 68, 68],
  ];
  const scaled = clamped * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(scaled));
  const local = scaled - index;
  const start = stops[index];
  const end = stops[index + 1];
  const channel = (channelIndex: number) => Math.round(start[channelIndex] + (end[channelIndex] - start[channelIndex]) * local);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}

function drawRotatedLabel(context: OffscreenCanvasRenderingContext2D, label: string, x: number, y: number, theme: Theme): void {
  if (!label) return;
  context.save();
  context.translate(x, y);
  context.rotate(-Math.PI / 7);
  context.font = "9px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.fillStyle = theme.mutedForeground;
  context.textAlign = "right";
  context.textBaseline = "middle";
  context.fillText(label, 0, 0);
  context.restore();
}

function mergedChartCategories(series: SpreadsheetPreviewChartSeries[]): string[] {
  const longest = series.reduce((best, item) => item.categories.length > best.length ? item.categories : best, [] as string[]);
  if (longest.length > 0) return longest;
  const maxLength = Math.max(...series.map((item) => item.values.length), 0);
  return Array.from({ length: maxLength }, (_value, index) => String(index + 1));
}

function truncateToWidth(context: OffscreenCanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (context.measureText(value).width <= maxWidth) return value;
  let next = value;
  while (next.length > 1 && context.measureText(`${next}...`).width > maxWidth) next = next.slice(0, -1);
  return `${next}...`;
}

function truncateLabel(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function roundedRect(context: OffscreenCanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function drawSheetBackground(context: OffscreenCanvasRenderingContext2D, layout: WorkbookSheetLayout, theme: Theme): void {
  context.fillStyle = theme.background;
  context.fillRect(0, 0, layout.width, layout.height);
  context.strokeStyle = theme.border;
  context.strokeRect(0.5, 0.5, layout.width, layout.height);
}

function drawGridHeaders(context: OffscreenCanvasRenderingContext2D, layout: WorkbookSheetLayout, theme: Theme): void {
  context.fillStyle = theme.card;
  context.fillRect(0, 0, layout.width, COLUMN_HEADER_HEIGHT);
  context.fillRect(0, 0, ROW_HEADER_WIDTH, layout.height);
  context.strokeStyle = theme.border;
  context.lineWidth = 1;
  context.font = "600 11px system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  context.textBaseline = "middle";
  context.fillStyle = theme.mutedForeground;

  context.strokeRect(0.5, 0.5, ROW_HEADER_WIDTH, COLUMN_HEADER_HEIGHT);
  for (let index = 0; index < layout.columnWidths.length; index += 1) {
    const x = layout.columnLefts[index] || ROW_HEADER_WIDTH;
    const width = layout.columnWidths[index] || 0;
    if (width <= 0) continue;
    context.strokeRect(x + 0.5, 0.5, width, COLUMN_HEADER_HEIGHT);
    context.textAlign = "center";
    context.fillText(columnName(index), x + width / 2, COLUMN_HEADER_HEIGHT / 2);
  }
  for (let index = 0; index < layout.rowNumbers.length; index += 1) {
    const y = layout.rowTops[index] || COLUMN_HEADER_HEIGHT;
    const height = layout.rowHeights[index] || 0;
    if (height <= 0) continue;
    context.strokeRect(0.5, y + 0.5, ROW_HEADER_WIDTH, height);
    context.textAlign = "right";
    context.fillText(String(layout.rowNumbers[index]), ROW_HEADER_WIDTH - 9, y + height / 2);
  }
}

function drawCells(
  context: OffscreenCanvasRenderingContext2D,
  sheet: SpreadsheetPreviewSheet,
  layout: WorkbookSheetLayout,
  theme: Theme,
  selection: WorkbookSelection | null,
  search: string,
): void {
  const rowsByNumber = new Map(sheet.rows.map((row) => [row.number, row] as const));
  context.textBaseline = "middle";
  for (let rowIndex = 0; rowIndex < layout.rowNumbers.length; rowIndex += 1) {
    const rowNumber = layout.rowNumbers[rowIndex] || rowIndex + 1;
    const row = rowsByNumber.get(rowNumber);
    const cellsByColumn = new Map(normalizedRowCells(row).map((cell) => [cell.column, cell] as const));
    for (let columnIndex = 0; columnIndex < layout.columnWidths.length; columnIndex += 1) {
      const columnNumber = columnIndex + 1;
      const x = layout.columnLefts[columnIndex] || ROW_HEADER_WIDTH;
      const y = layout.rowTops[rowIndex] || COLUMN_HEADER_HEIGHT;
      const width = layout.columnWidths[columnIndex] || 0;
      const height = layout.rowHeights[rowIndex] || 0;
      if (width <= 0 || height <= 0) continue;
      const merge = mergeForCell(sheet.mergedCells || [], rowNumber, columnNumber);
      if (merge && (merge.startRow !== rowNumber || merge.startColumn !== columnNumber)) continue;
      const cell = cellsByColumn.get(columnNumber);
      const cellWidth = merge ? mergedWidth(merge, layout.columnWidths) : width;
      const cellHeight = merge ? mergedHeight(merge, new Map(layout.rowNumbers.map((item, index) => [item, index] as const)), layout.rowHeights) : height;
      const text = cell?.text || "";
      const matched = Boolean(search && text.toLowerCase().includes(search));
      drawCell(context, { x, y, width: cellWidth, height: cellHeight, text, style: cell?.style, matched, theme });
    }
  }
}

function drawCell(
  context: OffscreenCanvasRenderingContext2D,
  input: {
    x: number;
    y: number;
    width: number;
    height: number;
    text: string;
    style?: SpreadsheetPreviewCellStyle;
    matched: boolean;
    theme: Theme;
  },
): void {
  const { x, y, width, height, text, style, matched, theme } = input;
  context.fillStyle = matched ? theme.searchFill : style?.fillColor || theme.background;
  context.fillRect(x, y, width, height);
  context.strokeStyle = style?.borderColor || theme.border;
  context.lineWidth = 1;
  context.strokeRect(x + 0.5, y + 0.5, width, height);
  if (!text) return;
  const fontSize = clamp(style?.fontSize || 12, 9, 20);
  const fontWeight = style?.bold ? 700 : 400;
  const fontStyle = style?.italic ? "italic " : "";
  context.font = `${fontStyle}${fontWeight} ${fontSize}px system-ui, -apple-system, BlinkMacSystemFont, sans-serif`;
  context.fillStyle = style?.fontColor || theme.foreground;
  context.textAlign = style?.horizontalAlign === "right" ? "right" : style?.horizontalAlign === "center" ? "center" : "left";
  const textX = context.textAlign === "right" ? x + width - 8 : context.textAlign === "center" ? x + width / 2 : x + 8;
  const textY = style?.verticalAlign === "top" ? y + Math.max(12, fontSize) : style?.verticalAlign === "bottom" ? y + height - Math.max(10, fontSize / 2) : y + height / 2;
  context.save();
  context.beginPath();
  context.rect(x + 3, y + 2, Math.max(0, width - 6), Math.max(0, height - 4));
  context.clip();
  context.fillText(text, textX, textY);
  if (style?.underline) {
    const metrics = context.measureText(text);
    const underlineY = textY + fontSize * 0.42;
    const underlineWidth = Math.min(metrics.width, width - 12);
    const underlineX = context.textAlign === "right" ? textX - underlineWidth : context.textAlign === "center" ? textX - underlineWidth / 2 : textX;
    context.strokeStyle = style.fontColor || theme.foreground;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(underlineX, underlineY);
    context.lineTo(underlineX + underlineWidth, underlineY);
    context.stroke();
  }
  context.restore();
}

function drawSelectionFill(
  context: OffscreenCanvasRenderingContext2D,
  layout: WorkbookSheetLayout,
  theme: Theme,
  selection: WorkbookSelection | null,
): void {
  if (selection?.kind === "chart") return;
  const rect = selectionBounds(layout, selection);
  if (!rect) return;
  context.fillStyle = theme.selectionFill;
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
}

function drawSelectionOutline(
  context: OffscreenCanvasRenderingContext2D,
  layout: WorkbookSheetLayout,
  theme: Theme,
  selection: WorkbookSelection | null,
): void {
  const rect = selectionBounds(layout, selection);
  if (!rect) return;
  context.save();
  context.strokeStyle = theme.selectionStroke;
  context.lineWidth = 2;
  context.strokeRect(rect.x + 1, rect.y + 1, Math.max(0, rect.width - 2), Math.max(0, rect.height - 2));
  context.strokeStyle = "rgba(255, 255, 255, 0.72)";
  context.lineWidth = 1;
  context.strokeRect(rect.x + 3, rect.y + 3, Math.max(0, rect.width - 6), Math.max(0, rect.height - 6));
  context.restore();
}

function drawFreezePanes(context: OffscreenCanvasRenderingContext2D, sheet: SpreadsheetPreviewSheet, layout: WorkbookSheetLayout, theme: Theme): void {
  const frozenColumns = sheet.freezePanes?.frozenColumns || 0;
  const frozenRows = sheet.freezePanes?.frozenRows || 0;
  context.strokeStyle = theme.mutedForeground;
  context.lineWidth = 2;
  if (frozenColumns > 0) {
    const x = layout.columnLefts[frozenColumns] ?? layout.width;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, layout.height);
    context.stroke();
  }
  if (frozenRows > 0) {
    const y = layout.rowTops[frozenRows] ?? layout.height;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(layout.width, y);
    context.stroke();
  }
}

function normalizedRowCells(row?: SpreadsheetPreviewSheet["rows"][number]): SpreadsheetPreviewCell[] {
  if (!row) return [];
  if (row.cellObjects?.length) return row.cellObjects;
  return row.cells.map((text, index) => ({
    ref: `${columnName(index)}${row.number}`,
    row: row.number,
    column: index + 1,
    text,
  }));
}

function normalizeSelection(selection?: WorkbookSelection | null): WorkbookSelection | null {
  if (!selection) return null;
  if (selection.kind === "chart") return selection;
  return {
    kind: "cell",
    sheetIndex: selection.sheetIndex,
    startRow: Math.min(selection.startRow, selection.endRow),
    endRow: Math.max(selection.startRow, selection.endRow),
    startColumn: Math.min(selection.startColumn, selection.endColumn),
    endColumn: Math.max(selection.startColumn, selection.endColumn),
  };
}

function selectionBounds(layout: WorkbookSheetLayout, selection: WorkbookSelection | null): Rect | null {
  if (!selection || selection.sheetIndex !== layout.sheetIndex) return null;
  if (selection.kind === "chart") {
    const chart = layout.charts.find((item) => item.id === selection.chartId);
    return chart ? { x: chart.x, y: chart.y, width: chart.width, height: chart.height } : null;
  }
  if (selection.kind === "shape") {
    const shape = layout.shapes.find((item) => item.id === selection.shapeId);
    return shape ? { x: shape.x, y: shape.y, width: shape.width, height: shape.height } : null;
  }
  const startRowIndex = layout.rowNumbers.indexOf(selection.startRow);
  const endRowIndex = layout.rowNumbers.indexOf(selection.endRow);
  const startColumnIndex = selection.startColumn - 1;
  const endColumnIndex = selection.endColumn - 1;
  if (startRowIndex < 0 || endRowIndex < 0 || startColumnIndex < 0 || endColumnIndex < 0) return null;
  const x = layout.columnLefts[startColumnIndex] ?? ROW_HEADER_WIDTH;
  const y = layout.rowTops[startRowIndex] ?? COLUMN_HEADER_HEIGHT;
  const right = (layout.columnLefts[endColumnIndex] ?? x) + (layout.columnWidths[endColumnIndex] || DEFAULT_CELL_WIDTH);
  const bottom = (layout.rowTops[endRowIndex] ?? y) + (layout.rowHeights[endRowIndex] || DEFAULT_CELL_HEIGHT);
  return {
    x,
    y,
    width: Math.max(0, right - x),
    height: Math.max(0, bottom - y),
  };
}

function wrapCanvasText(context: OffscreenCanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, maxHeight: number, lineHeight: number): void {
  const words = text.split(/(\s+)/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = `${line}${word}`;
    if (line && context.measureText(next).width > maxWidth) {
      lines.push(line.trimEnd());
      line = word.trimStart();
      continue;
    }
    line = next;
  }
  if (line) lines.push(line.trimEnd());
  const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
  lines.slice(0, maxLines).forEach((value, index) => {
    const textValue = index === maxLines - 1 && lines.length > maxLines ? truncateToWidth(context, `${value}...`, maxWidth) : truncateToWidth(context, value, maxWidth);
    context.fillText(textValue, x, y + index * lineHeight);
  });
}

function specialtyChartLabel(type: SpreadsheetPreviewChart["type"]): string {
  if (type === "stock") return "股票图";
  if (type === "surface") return "曲面图";
  if (type === "treemap") return "树状图";
  if (type === "sunburst") return "旭日图";
  if (type === "histogram") return "直方图";
  if (type === "boxWhisker") return "箱线图";
  if (type === "waterfall") return "瀑布图";
  return "图表";
}

function mergeForCell(mergedCells: SpreadsheetPreviewMergedCell[], row: number, column: number): SpreadsheetPreviewMergedCell | undefined {
  return mergedCells.find((merge) => row >= merge.startRow && row <= merge.endRow && column >= merge.startColumn && column <= merge.endColumn);
}

function mergedWidth(merge: SpreadsheetPreviewMergedCell, columnWidths: number[]): number {
  let width = 0;
  for (let column = merge.startColumn; column <= merge.endColumn; column += 1) width += columnWidths[column - 1] || DEFAULT_CELL_WIDTH;
  return width;
}

function mergedHeight(merge: SpreadsheetPreviewMergedCell, rowIndexByNumber: Map<number, number>, rowHeights: number[]): number {
  let height = 0;
  for (let row = merge.startRow; row <= merge.endRow; row += 1) {
    const rowIndex = rowIndexByNumber.get(row);
    height += rowIndex == null ? DEFAULT_CELL_HEIGHT : rowHeights[rowIndex] || DEFAULT_CELL_HEIGHT;
  }
  return height;
}

function cumulativeOffsets(values: number[], start: number): number[] {
  let current = start;
  return values.map((value) => {
    const offset = current;
    current += value;
    return offset;
  });
}

function sumSlice(values: number[], start: number, end: number): number {
  return values.slice(Math.max(0, start), Math.max(start, end)).reduce((sum, value) => sum + value, 0);
}

function columnName(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function alphaColor(color: string, alpha: number): string {
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    const normalized = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color;
    const red = Number.parseInt(normalized.slice(1, 3), 16);
    const green = Number.parseInt(normalized.slice(3, 5), 16);
    const blue = Number.parseInt(normalized.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }
  if (color.startsWith("hsl(")) return color.replace(/^hsl\((.*)\)$/, `hsl($1 / ${alpha})`);
  if (color.startsWith("rgb(")) return color.replace(/^rgb\((.*)\)$/, `rgba($1, ${alpha})`);
  return color;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
