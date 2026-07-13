import type { SpreadsheetPreview, SpreadsheetPreviewSheet } from "@/types/domain";
import type { FilePreviewLocationTarget } from "@/components/chat/FilePathChip";
import type { WorkbookSelection } from "./workbook-render.worker";

export type WorkbookPreviewSelectionTarget = {
  sheetIndex: number;
  selection: WorkbookSelection;
};

export function workbookTargetKey(target?: FilePreviewLocationTarget | null): string {
  if (!target) return "";
  return [
    target.fileId,
    target.sourcePath,
    target.path,
    target.sectionType,
    target.sheet,
    target.range,
    target.semanticUnitId,
    ...(target.elementIds || []),
    target.sourceLabel,
    target.bbox,
  ].filter(Boolean).join("|");
}

export function workbookSelectionForTarget(
  workbook: SpreadsheetPreview,
  target: FilePreviewLocationTarget,
): WorkbookPreviewSelectionTarget | null {
  const objectTarget = workbookObjectSelectionForTarget(workbook, target);
  const objectSection = target.sectionType === "chart" || target.sectionType === "shape";
  if (objectTarget && objectSection) return objectTarget;

  const rangeTarget = parseWorkbookRangeTarget(target);
  if (rangeTarget) {
    const sheetIndex = findTargetSheetIndex(workbook, rangeTarget.sheet);
    if (sheetIndex < 0) return null;
    return {
      sheetIndex,
      selection: normalizeWorkbookSelection({
        kind: "cell",
        sheetIndex,
        startRow: rangeTarget.startRow,
        startColumn: rangeTarget.startColumn,
        endRow: rangeTarget.endRow,
        endColumn: rangeTarget.endColumn,
      }),
    };
  }

  return objectTarget;
}

export function normalizeWorkbookSelection(selection: WorkbookSelection): WorkbookSelection {
  if (selection.kind === "chart" || selection.kind === "shape") return selection;
  return {
    kind: "cell",
    sheetIndex: selection.sheetIndex,
    startRow: Math.max(1, Math.min(selection.startRow, selection.endRow)),
    endRow: Math.max(1, Math.max(selection.startRow, selection.endRow)),
    startColumn: Math.max(1, Math.min(selection.startColumn, selection.endColumn)),
    endColumn: Math.max(1, Math.max(selection.startColumn, selection.endColumn)),
  };
}

export function workbookSelectionSourceLabel(sheet: SpreadsheetPreviewSheet, selection: WorkbookSelection): string {
  if (selection.kind === "chart") {
    const chart = sheet.charts?.find((item) => item.id === selection.chartId);
    return `工作表 ${sheet.name} · 图表 ${chart?.title || chart?.name || "未命名图表"}`;
  }
  if (selection.kind === "shape") {
    const shape = sheet.shapes?.find((item) => item.id === selection.shapeId);
    return `工作表 ${sheet.name} · 对象 ${shape?.name || "未命名对象"}`;
  }
  const normalized = normalizeWorkbookSelection(selection);
  const start = `${spreadsheetColumnName(normalized.startColumn - 1)}${normalized.startRow}`;
  const end = `${spreadsheetColumnName(normalized.endColumn - 1)}${normalized.endRow}`;
  const range = start === end ? start : `${start}:${end}`;
  return `${quotedSheetName(sheet.name)}!${range}`;
}

export function workbookSelectionSemanticUnitId(sheet: SpreadsheetPreviewSheet, selection: WorkbookSelection): string | undefined {
  if (selection.kind === "chart") {
    const chart = sheet.charts?.find((item) => item.id === selection.chartId);
    return chart ? `${chart.id}:unit` : undefined;
  }
  if (selection.kind === "shape") {
    const shape = sheet.shapes?.find((item) => item.id === selection.shapeId);
    return shape ? `${shape.id}:unit` : undefined;
  }
  return undefined;
}

function workbookObjectSelectionForTarget(
  workbook: SpreadsheetPreview,
  target: FilePreviewLocationTarget,
): WorkbookPreviewSelectionTarget | null {
  const requestedSheetIndex = target.sheet ? findTargetSheetIndex(workbook, target.sheet) : -1;
  if (target.sheet && requestedSheetIndex < 0) return null;
  const sheetEntries = requestedSheetIndex >= 0
    ? [[requestedSheetIndex, workbook.sheets[requestedSheetIndex]] as const]
    : workbook.sheets.map((sheet, index) => [index, sheet] as const);
  const elementIds = new Set((target.elementIds || []).filter(Boolean));
  const objectText = normalizeObjectText([target.sourceLabel, target.text, target.citation].filter(Boolean).join(" "));

  for (const [sheetIndex, sheet] of sheetEntries) {
    if (!sheet) continue;
    for (const chart of sheet.charts || []) {
      const exact = elementIds.has(chart.id) || semanticUnitContainsElement(target.semanticUnitId, chart.id);
      const labelMatch = target.sectionType === "chart" && objectLabelMatches(objectText, chart.title, chart.name);
      if (!exact && !labelMatch) continue;
      return {
        sheetIndex,
        selection: {
          kind: "chart",
          sheetIndex,
          startRow: 1,
          startColumn: 1,
          endRow: 1,
          endColumn: 1,
          chartId: chart.id,
        },
      };
    }
    for (const shape of sheet.shapes || []) {
      const exact = elementIds.has(shape.id) || semanticUnitContainsElement(target.semanticUnitId, shape.id);
      const labelMatch = target.sectionType === "shape" && objectLabelMatches(objectText, shape.name, shape.text);
      if (!exact && !labelMatch) continue;
      return {
        sheetIndex,
        selection: {
          kind: "shape",
          sheetIndex,
          startRow: 1,
          startColumn: 1,
          endRow: 1,
          endColumn: 1,
          shapeId: shape.id,
        },
      };
    }
  }
  return null;
}

function parseWorkbookRangeTarget(target: FilePreviewLocationTarget): {
  sheet?: string;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
} | null {
  const candidates = [target.range, target.citation, target.sourceLabel].filter((value): value is string => Boolean(value?.trim()));
  for (const candidate of candidates) {
    const parsed = parseRangeCandidate(candidate);
    if (!parsed) continue;
    return { ...parsed, sheet: (target.sheet || parsed.sheet || "").trim() || undefined };
  }
  return null;
}

function parseRangeCandidate(value: string): {
  sheet?: string;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
} | null {
  const trimmed = value.trim();
  const direct = trimmed.match(/^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i);
  const explicitMatches = direct ? [] : Array.from(trimmed.matchAll(/(?:'((?:[^']|'')+)'|([A-Za-z0-9_\-\u4e00-\u9fff ]+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/gi));
  const explicit = explicitMatches[explicitMatches.length - 1];
  const bare = direct || explicit ? null : trimmed.match(/(?:^|[^A-Za-z0-9_])\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?(?:$|[^A-Za-z0-9_])/i);

  const sheet = direct
    ? decodeSheetName(direct[1] || direct[2] || "")
    : explicit
      ? decodeSheetName(explicit[1] || explicit[2] || "")
      : undefined;
  const startColumnLabel = direct ? direct[3] : explicit ? explicit[3] : bare?.[1];
  const startRowValue = direct ? direct[4] : explicit ? explicit[4] : bare?.[2];
  const endColumnLabel = direct ? direct[5] : explicit ? explicit[5] : bare?.[3];
  const endRowValue = direct ? direct[6] : explicit ? explicit[6] : bare?.[4];
  if (!startColumnLabel || !startRowValue) return null;
  const startColumn = spreadsheetColumnIndex(startColumnLabel);
  const startRow = Number(startRowValue);
  const endColumn = spreadsheetColumnIndex(endColumnLabel || startColumnLabel);
  const endRow = Number(endRowValue || startRowValue);
  if (!startColumn || !endColumn || !Number.isInteger(startRow) || !Number.isInteger(endRow) || startRow <= 0 || endRow <= 0) return null;
  return { sheet, startRow, startColumn, endRow, endColumn };
}

function findTargetSheetIndex(workbook: SpreadsheetPreview, sheetName?: string): number {
  const normalized = normalizeSheetName(sheetName);
  if (!normalized) return workbook.sheets.length > 0 ? 0 : -1;
  return workbook.sheets.findIndex((sheet) => normalizeSheetName(sheet.name) === normalized);
}

function normalizeSheetName(value?: string): string {
  return decodeSheetName(value || "").trim().toLowerCase();
}

function decodeSheetName(value: string): string {
  return value.replace(/^'+|'+$/g, "").replace(/''/g, "'").trim();
}

function quotedSheetName(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : `'${value.replace(/'/g, "''")}'`;
}

function semanticUnitContainsElement(semanticUnitId: string | undefined, elementId: string): boolean {
  return Boolean(semanticUnitId && (semanticUnitId === elementId || semanticUnitId.startsWith(`${elementId}:`)));
}

function objectLabelMatches(searchText: string, ...labels: Array<string | undefined>): boolean {
  if (!searchText) return false;
  return labels.some((label) => {
    const normalized = normalizeObjectText(label || "");
    return normalized.length >= 3 && searchText.includes(normalized);
  });
}

function normalizeObjectText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function spreadsheetColumnIndex(label: string): number {
  let value = 0;
  for (const char of label.toUpperCase()) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) return 0;
    value = value * 26 + (code - 64);
  }
  return value;
}

function spreadsheetColumnName(index: number): string {
  let value = Math.max(0, Math.floor(index));
  let label = "";
  do {
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return label;
}
