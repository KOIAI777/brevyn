import assert from "node:assert/strict";
import type { SpreadsheetPreview } from "@/types/domain";
import {
  workbookSelectionForTarget,
  workbookSelectionSemanticUnitId,
  workbookSelectionSourceLabel,
} from "./workbook-preview-target";

const workbook: SpreadsheetPreview = {
  renderEngine: "brevyn-workbook-v1",
  sheetCount: 2,
  renderedSheetCount: 2,
  maxRows: 100,
  maxColumns: 20,
  truncated: false,
  sheets: [
    {
      index: 0,
      name: "Summary",
      totalRows: 10,
      totalColumns: 5,
      renderedRows: 10,
      renderedColumns: 5,
      truncatedRows: false,
      truncatedColumns: false,
      rows: [],
    },
    {
      index: 1,
      name: "Data Sheet",
      totalRows: 20,
      totalColumns: 8,
      renderedRows: 20,
      renderedColumns: 8,
      truncatedRows: false,
      truncatedColumns: false,
      rows: [],
      charts: [{
        id: "artifact-1:sheet-2:chart-1",
        index: 0,
        name: "Chart 1",
        title: "Revenue Trend",
        type: "line",
        sourceRefs: ["'Data Sheet'!$B$2:$B$8"],
        series: [],
      }],
      shapes: [{
        id: "artifact-1:sheet-2:shape-1",
        index: 0,
        name: "Callout 1",
        text: "Important result",
      }],
    },
  ],
};

const rangeTarget = workbookSelectionForTarget(workbook, {
  range: "'Data Sheet'!$B$2:$D$5",
});
assert.equal(rangeTarget?.sheetIndex, 1);
assert.deepEqual(rangeTarget?.selection, {
  kind: "cell",
  sheetIndex: 1,
  startRow: 2,
  startColumn: 2,
  endRow: 5,
  endColumn: 4,
});
assert.equal(workbookSelectionSourceLabel(workbook.sheets[1], rangeTarget!.selection), "'Data Sheet'!B2:D5");

const chartTarget = workbookSelectionForTarget(workbook, {
  sectionType: "chart",
  sheet: "Data Sheet",
  semanticUnitId: "artifact-1:sheet-2:chart-1:unit",
  elementIds: ["artifact-1:sheet-2:chart-1"],
});
assert.equal(chartTarget?.selection.kind, "chart");
assert.equal(chartTarget?.selection.chartId, "artifact-1:sheet-2:chart-1");
assert.equal(workbookSelectionSourceLabel(workbook.sheets[1], chartTarget!.selection), "工作表 Data Sheet · 图表 Revenue Trend");
assert.equal(workbookSelectionSemanticUnitId(workbook.sheets[1], chartTarget!.selection), "artifact-1:sheet-2:chart-1:unit");

const shapeTarget = workbookSelectionForTarget(workbook, {
  sectionType: "shape",
  sheet: "Data Sheet",
  elementIds: ["artifact-1:sheet-2:shape-1"],
});
assert.equal(shapeTarget?.selection.kind, "shape");
assert.equal(shapeTarget?.selection.shapeId, "artifact-1:sheet-2:shape-1");

assert.equal(workbookSelectionForTarget(workbook, { sheet: "Missing", range: "A1:B2" }), null);
assert.equal(workbookSelectionForTarget(workbook, { semanticUnitId: "artifact-a123:unit" }), null);

console.log("workbook preview target tests passed");
