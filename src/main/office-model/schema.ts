export type BrevynOfficeKind = "docx" | "pptx" | "xlsx" | "csv" | "pdf";

export interface BrevynOfficeSource {
  path: string;
  name: string;
  byteCount: number;
  sha256?: string;
}

export interface BrevynOfficeMetadata {
  parser: string;
  parserVersion: number;
  createdAt: string;
  coverageStatus: "complete" | "partial" | "skipped";
  warnings?: string[];
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface BrevynOfficeArtifact {
  id: string;
  schemaVersion: number;
  kind: BrevynOfficeKind;
  title: string;
  source: BrevynOfficeSource;
  metadata: BrevynOfficeMetadata;
  workbook?: BrevynWorkbookModel;
  presentation?: BrevynPresentationModel;
  document?: BrevynDocumentModel;
  pdf?: BrevynPdfModel;
  elements: BrevynOfficeElement[];
  assets: BrevynOfficeAsset[];
  semanticUnits: BrevynSemanticUnit[];
}

export interface BrevynWorkbookModel {
  sheets: BrevynWorksheetModel[];
  sheetCount: number;
  renderedSheetCount: number;
  maxRows: number;
  maxColumns: number;
  truncated: boolean;
}

export interface BrevynWorksheetModel {
  id: string;
  index: number;
  name: string;
  relationshipId?: string;
  path?: string;
  usedRange?: string;
  totalRows: number;
  totalColumns: number;
  renderedRows: number;
  renderedColumns: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
  columns: BrevynWorksheetColumn[];
  rows: BrevynWorksheetRow[];
  mergedCells: BrevynMergedCell[];
  freezePanes?: BrevynWorksheetFreezePanes;
  drawingCount: number;
  charts: BrevynSpreadsheetChart[];
  images?: BrevynSpreadsheetImage[];
  shapes?: BrevynSpreadsheetShape[];
  hyperlinks?: BrevynSpreadsheetHyperlink[];
  comments?: BrevynSpreadsheetComment[];
  tables?: BrevynSpreadsheetTable[];
  namedRanges?: BrevynSpreadsheetNamedRange[];
  render?: BrevynOfficeRenderSurface;
}

export interface BrevynWorksheetColumn {
  index: number;
  name: string;
  widthPx: number;
  hidden?: boolean;
}

export interface BrevynWorksheetFreezePanes {
  frozenRows: number;
  frozenColumns: number;
  topLeftCell?: string;
}

export interface BrevynWorksheetRow {
  number: number;
  heightPx?: number;
  hidden?: boolean;
  cells: BrevynWorksheetCell[];
}

export interface BrevynWorksheetCell {
  id: string;
  ref: string;
  row: number;
  column: number;
  columnName: string;
  text: string;
  rawValue?: string;
  formula?: string;
  type?: string;
  styleIndex?: number;
  style?: BrevynWorksheetCellStyle;
  hyperlink?: BrevynSpreadsheetHyperlink;
  commentIds?: string[];
}

export interface BrevynWorksheetCellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number;
  fontColor?: string;
  fillColor?: string;
  borderColor?: string;
  borderTop?: boolean;
  borderRight?: boolean;
  borderBottom?: boolean;
  borderLeft?: boolean;
  horizontalAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  wrapText?: boolean;
  numberFormat?: string;
}

export interface BrevynMergedCell {
  ref: string;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export type BrevynSpreadsheetChartType =
  | "bar"
  | "line"
  | "pie"
  | "doughnut"
  | "scatter"
  | "area"
  | "radar"
  | "bubble"
  | "stock"
  | "surface"
  | "treemap"
  | "sunburst"
  | "histogram"
  | "boxWhisker"
  | "waterfall"
  | "unknown";
export type BrevynSpreadsheetChartLegendPosition = "right" | "left" | "top" | "bottom" | "none";

export interface BrevynSpreadsheetChartStyle {
  grouping?: "clustered" | "stacked" | "percentStacked" | "standard";
  barDirection?: "bar" | "col";
  legendPosition?: BrevynSpreadsheetChartLegendPosition;
  dataLabels?: {
    showSeriesName?: boolean;
    showCategoryName?: boolean;
    showValue?: boolean;
    showPercent?: boolean;
    position?: string;
  };
  holeSize?: number;
  gapWidth?: number;
  firstSliceAngle?: number;
  axis?: {
    valueMin?: number;
    valueMax?: number;
    majorUnit?: number;
    categoryTitle?: string;
    valueTitle?: string;
    numberFormat?: string;
  };
}

export interface BrevynSpreadsheetChart {
  id: string;
  index: number;
  name: string;
  title: string;
  type: BrevynSpreadsheetChartType;
  subtype?: string;
  sheet: string;
  anchor?: {
    fromRow?: number;
    fromColumn?: number;
    toRow?: number;
    toColumn?: number;
    widthPx?: number;
    heightPx?: number;
  };
  sourceRefs: string[];
  series: BrevynSpreadsheetChartSeries[];
  style?: BrevynSpreadsheetChartStyle;
  render?: BrevynOfficeRenderSurface;
}

export interface BrevynSpreadsheetChartSeries {
  name: string;
  categoryRef?: string;
  valueRef?: string;
  xValueRef?: string;
  yValueRef?: string;
  bubbleSizeRef?: string;
  categories: string[];
  values: number[];
  xValues?: number[];
  yValues?: number[];
  bubbleSizes?: number[];
  rawValues: string[];
  color?: string;
  pointColors?: string[];
  chartType?: BrevynSpreadsheetChartType;
  axisGroup?: "primary" | "secondary";
  marker?: {
    symbol?: string;
    size?: number;
  };
  smooth?: boolean;
}

export interface BrevynSpreadsheetImage {
  id: string;
  index: number;
  name: string;
  sheet: string;
  assetId: string;
  mediaType: string;
  dataUrl?: string;
  anchor?: {
    fromRow?: number;
    fromColumn?: number;
    toRow?: number;
    toColumn?: number;
    widthPx?: number;
    heightPx?: number;
  };
}

export interface BrevynSpreadsheetShape {
  id: string;
  index: number;
  name: string;
  sheet: string;
  shapeType?: string;
  text: string;
  fillColor?: string;
  lineColor?: string;
  anchor?: {
    fromRow?: number;
    fromColumn?: number;
    toRow?: number;
    toColumn?: number;
    widthPx?: number;
    heightPx?: number;
  };
}

export interface BrevynSpreadsheetHyperlink {
  id: string;
  ref: string;
  target?: string;
  location?: string;
  display?: string;
  tooltip?: string;
}

export interface BrevynSpreadsheetComment {
  id: string;
  ref: string;
  author?: string;
  text: string;
}

export interface BrevynSpreadsheetTable {
  id: string;
  name: string;
  displayName?: string;
  ref: string;
  columns: string[];
  totalsRowShown?: boolean;
}

export interface BrevynSpreadsheetNamedRange {
  id: string;
  name: string;
  ref: string;
  sheet?: string;
  hidden?: boolean;
}

export type BrevynOfficeRenderSurfaceKind = "svg" | "png" | "pdf" | "html";

export interface BrevynOfficeRenderSurface {
  id: string;
  kind: BrevynOfficeRenderSurfaceKind;
  role: "sheet" | "chart" | "page" | "slide" | "thumbnail";
  width: number;
  height: number;
  mediaType: string;
  data?: string;
  path?: string;
  engine: string;
  warnings?: string[];
  targets?: BrevynOfficeRenderTarget[];
}

export interface BrevynOfficeRenderTarget {
  id: string;
  type: "cell" | "chart" | "text" | "image" | "shape";
  text?: string;
  bbox: BrevynOfficeRect;
  location: BrevynOfficeLocation;
  metadata?: Record<string, string | number | boolean>;
}

export interface BrevynPresentationModel {
  slideCount: number;
}

export interface BrevynDocumentModel {
  sectionCount: number;
  paragraphCount?: number;
  headingCount?: number;
  tableCount?: number;
  commentCount?: number;
  imageCount?: number;
  footnoteCount?: number;
  endnoteCount?: number;
  trackedChangeCount?: number;
}

export interface BrevynPdfModel {
  pageCount: number;
}

export type BrevynOfficeElementType =
  | "page"
  | "heading"
  | "paragraph"
  | "text_run"
  | "table"
  | "table_row"
  | "table_cell"
  | "chart"
  | "image"
  | "image_caption"
  | "shape"
  | "speaker_note"
  | "formula"
  | "comment"
  | "hyperlink"
  | "tracked_change"
  | "named_range";

export interface BrevynOfficeElement {
  id: string;
  type: BrevynOfficeElementType;
  text?: string;
  markdown?: string;
  location: BrevynOfficeLocation;
  bbox?: BrevynOfficeRect;
  style?: Record<string, string | number | boolean>;
  assetRefs?: string[];
  children?: string[];
  relationships?: BrevynOfficeRelationship[];
}

export interface BrevynOfficeLocation {
  page?: number;
  slide?: number;
  sheet?: string;
  range?: string;
  row?: number;
  column?: number;
  sectionPath?: string[];
  objectPath?: string;
}

export interface BrevynOfficeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrevynOfficeRelationship {
  id: string;
  type: string;
  target: string;
}

export interface BrevynOfficeAsset {
  id: string;
  kind: "image" | "chart" | "embedded_media" | "drawing";
  sourceLabel: string;
  path?: string;
  mediaType?: string;
  byteCount?: number;
  dataUrl?: string;
  elementIds?: string[];
}

export interface BrevynSemanticUnit {
  id: string;
  artifactId: string;
  elementIds: string[];
  unitType:
    | "document_section"
    | "paragraph"
    | "table"
    | "spreadsheet_range"
    | "slide"
    | "slide_region"
    | "speaker_notes"
    | "chart"
    | "shape"
    | "hyperlink"
    | "named_range"
    | "image_caption"
    | "comment"
    | "footnote"
    | "endnote"
    | "tracked_change"
    | "pdf_region";
  title?: string;
  text: string;
  markdown: string;
  sourceLabel: string;
  citation: string;
  location: BrevynOfficeLocation;
  bbox?: BrevynOfficeRect;
  importance?: number;
}
