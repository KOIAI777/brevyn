import { ChevronLeft, ChevronRight, Loader2, Minus, MoveHorizontal, Plus, RotateCcw, Search, Table2 } from "lucide-react";
import type {
  FilePreview,
  SpreadsheetPreviewCell,
  SpreadsheetPreviewSheet,
} from "@/types/domain";
import type { FilePreviewLocationTarget } from "@/components/chat/FilePathChip";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type WheelEvent as ReactWheelEvent } from "react";
import type { SelectionPromptState } from "./FilePreviewPane";
import type { ViewportMetrics, WorkbookCellRect, WorkbookChartRect, WorkbookSelection, WorkbookShapeRect, WorkbookSheetLayout } from "./workbook-render.worker";
import WorkbookRenderWorker from "./workbook-render.worker?worker";
import {
  normalizeWorkbookSelection,
  workbookSelectionForTarget,
  workbookSelectionSemanticUnitId,
  workbookSelectionSourceLabel,
  workbookTargetKey,
} from "./workbook-preview-target";

const DEFAULT_ZOOM = 1;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 2.4;
const ROW_HEADER_WIDTH = 52;
const COLUMN_HEADER_HEIGHT = 28;
const DEFAULT_CELL_WIDTH = 96;
const DEFAULT_CELL_HEIGHT = 28;

type WorkbookViewState = {
  sheetIndex?: number;
  zoom?: number;
  scrollLeft?: number;
  scrollTop?: number;
  search?: string;
  selection?: WorkbookSelection;
};

type WorkbookFrameMessage =
  | { type: "frame"; bitmap: ImageBitmap; metrics: ViewportMetrics; sheetIndex: number; layout: WorkbookSheetLayout }
  | { type: "error"; message: string };

export function WorkbookCanvasPreview({
  preview,
  target,
  viewState,
  onViewStateChange,
  onSelectionPrompt,
}: {
  preview: FilePreview;
  target?: FilePreviewLocationTarget | null;
  viewState?: WorkbookViewState;
  onViewStateChange?: (patch: WorkbookViewState) => void;
  onSelectionPrompt: (state: SelectionPromptState | null) => void;
}) {
  const workbook = preview.spreadsheet;
  const sheets = workbook?.sheets || [];
  const initialSheetIndex = clampInteger(viewState?.sheetIndex ?? 0, 0, Math.max(0, sheets.length - 1));
  const [sheetIndex, setSheetIndex] = useState(initialSheetIndex);
  const [zoom, setZoom] = useState(() => clampZoom(viewState?.zoom || DEFAULT_ZOOM));
  const [scrollPosition, setScrollPosition] = useState(() => ({ left: Math.max(0, viewState?.scrollLeft || 0), top: Math.max(0, viewState?.scrollTop || 0) }));
  const [search, setSearch] = useState(viewState?.search || "");
  const [selection, setSelection] = useState<WorkbookSelection | null>(viewState?.selection || null);
  const [error, setError] = useState("");
  const [firstFrameReady, setFirstFrameReady] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const workbookRef = useRef(workbook);
  const sheetIndexRef = useRef(sheetIndex);
  const searchRef = useRef(search);
  const metricsRef = useRef<ViewportMetrics>({ width: 1, height: 1, dpr: 1 });
  const layoutRef = useRef<WorkbookSheetLayout | null>(null);
  const selectionRef = useRef<WorkbookSelection | null>(viewState?.selection || null);
  const dragRef = useRef<{ row: number; column: number; pointerId: number; lastClientX: number; lastClientY: number } | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const pendingRenderRef = useRef(0);
  const pendingViewStateRef = useRef(0);
  const pendingViewStatePatchRef = useRef<WorkbookViewState>({});
  const scrollRef = useRef(scrollPosition);
  const zoomRef = useRef(zoom);
  const pendingTargetRef = useRef<FilePreviewLocationTarget | null>(null);
  const [surfaceSize, setSurfaceSize] = useState({ width: 1200, height: 2200 });
  const activeSheet = sheets[sheetIndex] || sheets[0];
  const targetKey = workbookTargetKey(target);
  workbookRef.current = workbook;

  useEffect(() => {
    const maxSheetIndex = Math.max(0, sheets.length - 1);
    const nextSheetIndex = clampInteger(viewState?.sheetIndex ?? 0, 0, maxSheetIndex);
    setSheetIndex(nextSheetIndex);
    sheetIndexRef.current = nextSheetIndex;
    setZoom(clampZoom(viewState?.zoom || DEFAULT_ZOOM));
    setScrollPosition({ left: Math.max(0, viewState?.scrollLeft || 0), top: Math.max(0, viewState?.scrollTop || 0) });
    setSearch(viewState?.search || "");
    searchRef.current = viewState?.search || "";
    setSelection(viewState?.selection || null);
    selectionRef.current = viewState?.selection || null;
    layoutRef.current = null;
    setFirstFrameReady(false);
    onSelectionPrompt(null);
    // View state is an initial restore cache. Runtime scroll/selection changes are owned locally,
    // otherwise dragging a range replays the cache and clears the worker layout mid-gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.id, workbook, sheets.length]);

  useEffect(() => {
    scrollRef.current = scrollPosition;
  }, [scrollPosition]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    if (!workbook) return undefined;
    const worker = new WorkbookRenderWorker();
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkbookFrameMessage>) => {
      if (event.data.type === "error") {
        setError(event.data.message);
        return;
      }
      if (event.data.sheetIndex !== sheetIndexRef.current) {
        event.data.bitmap.close();
        return;
      }
      setError("");
      layoutRef.current = event.data.layout;
      setSurfaceSize({
        width: Math.max(1, event.data.layout.width * zoomRef.current),
        height: Math.max(1, event.data.layout.height * zoomRef.current),
      });
      paintBitmap(event.data.bitmap, event.data.metrics);
      applyPendingTarget();
    };
    requestRender("init", workbook);
    return () => {
      window.cancelAnimationFrame(pendingRenderRef.current);
      workerRef.current = null;
      worker.terminate();
    };
    // Worker should restart only when the workbook object changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workbook]);

  useEffect(() => () => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    dragRef.current = null;
    window.cancelAnimationFrame(pendingRenderRef.current);
    window.cancelAnimationFrame(pendingViewStateRef.current);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!viewport || !canvas) return undefined;
    const sync = () => {
      const nextMetrics = {
        width: Math.max(1, viewport.clientWidth),
        height: Math.max(1, viewport.clientHeight),
        dpr: window.devicePixelRatio || 1,
      };
      metricsRef.current = nextMetrics;
      canvas.width = Math.max(1, Math.round(nextMetrics.width * nextMetrics.dpr));
      canvas.height = Math.max(1, Math.round(nextMetrics.height * nextMetrics.dpr));
      canvas.style.width = `${nextMetrics.width}px`;
      canvas.style.height = `${nextMetrics.height}px`;
      requestRender();
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(viewport);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetIndex, scrollPosition.left, scrollPosition.top, zoom, selection, search]);

  useEffect(() => {
    if (!targetKey || !target) return;
    pendingTargetRef.current = target;
    applyPendingTarget();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, targetKey]);

  const selectionText = useMemo(() => {
    if (!activeSheet || !selection || selection.sheetIndex !== sheetIndex) return "";
    if (selection.kind === "chart") {
      const chart = activeSheet.charts?.find((item) => item.id === selection.chartId);
      return chart ? workbookChartSelectionText(activeSheet, { id: chart.id, chart, x: 0, y: 0, width: 0, height: 0 }) : "";
    }
    if (selection.kind === "shape") {
      const shape = activeSheet.shapes?.find((item) => item.id === selection.shapeId);
      return shape ? workbookShapeSelectionText(activeSheet, { id: shape.id, shape, x: 0, y: 0, width: 0, height: 0 }) : "";
    }
    return workbookSelectionText(activeSheet, selection);
  }, [activeSheet, selection, sheetIndex]);
  const activeCell = useMemo(() => {
    if (!activeSheet || !selection || selection.sheetIndex !== sheetIndex || selection.kind === "chart" || selection.kind === "shape") return null;
    return findSheetCell(activeSheet, selection.startRow, selection.startColumn);
  }, [activeSheet, selection, sheetIndex]);
  const activeChart = useMemo(() => {
    if (!activeSheet || !selection || selection.sheetIndex !== sheetIndex || selection.kind !== "chart") return null;
    return activeSheet.charts?.find((item) => item.id === selection.chartId) || null;
  }, [activeSheet, selection, sheetIndex]);
  const activeShape = useMemo(() => {
    if (!activeSheet || !selection || selection.sheetIndex !== sheetIndex || selection.kind !== "shape") return null;
    return activeSheet.shapes?.find((item) => item.id === selection.shapeId) || null;
  }, [activeSheet, selection, sheetIndex]);
  const formulaBarRef = activeChart ? "图表" : activeShape ? "形状" : activeCell?.ref || (selection && selection.kind !== "chart" && selection.kind !== "shape" ? `${spreadsheetColumnName(selection.startColumn - 1)}${selection.startRow}` : "");
  const formulaBarValue = activeCell?.text || "";
  const formulaBarFormula = activeCell?.formula ? `=${activeCell.formula}` : "";
  const formulaBarChart = activeChart ? `${spreadsheetChartTypeLabel(activeChart)} · ${activeChart.title || activeChart.name || `图表 ${activeChart.index + 1}`}` : "";
  const formulaBarShape = activeShape ? `${activeShape.shapeType || "形状"} · ${activeShape.text || activeShape.name}` : "";
  const formulaBarTitle = [formulaBarValue, formulaBarFormula, formulaBarChart, formulaBarShape].filter(Boolean).join("  ");

  const selectSheet = useCallback((nextIndex: number) => {
    const clamped = clampInteger(nextIndex, 0, Math.max(0, sheets.length - 1));
    setSheetIndex(clamped);
    sheetIndexRef.current = clamped;
    layoutRef.current = null;
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
    const nextScroll = { left: 0, top: 0 };
    setScrollPosition(nextScroll);
    scrollRef.current = nextScroll;
    setSelection(null);
    selectionRef.current = null;
    onSelectionPrompt(null);
    onViewStateChange?.({ sheetIndex: clamped, scrollLeft: 0, scrollTop: 0, selection: undefined });
  }, [onSelectionPrompt, onViewStateChange, sheets.length]);

  const updateSearch = useCallback((value: string) => {
    setSearch(value);
    searchRef.current = value;
    onViewStateChange?.({ search: value });
  }, [onViewStateChange]);

  function requestRender(type: "init" | "render" = "render", nextWorkbook = workbookRef.current) {
    const worker = workerRef.current;
    if (!worker || !nextWorkbook) return;
    const postRenderMessage = () => {
      const theme = readWorkbookTheme();
      const payload = {
        type,
        workbook: nextWorkbook,
        sheetIndex: sheetIndexRef.current,
        camera: { x: scrollRef.current.left, y: scrollRef.current.top, zoom: zoomRef.current },
        viewport: metricsRef.current,
        theme,
        selection: selectionRef.current,
        search: searchRef.current,
      };
      worker.postMessage(payload);
    };
    window.cancelAnimationFrame(pendingRenderRef.current);
    if (type === "init") {
      postRenderMessage();
      return;
    }
    pendingRenderRef.current = window.requestAnimationFrame(() => {
      postRenderMessage();
    });
  }

  function queueViewStateChange(patch: WorkbookViewState) {
    pendingViewStatePatchRef.current = { ...pendingViewStatePatchRef.current, ...patch };
    if (pendingViewStateRef.current) return;
    pendingViewStateRef.current = window.requestAnimationFrame(() => {
      pendingViewStateRef.current = 0;
      const nextPatch = pendingViewStatePatchRef.current;
      pendingViewStatePatchRef.current = {};
      onViewStateChange?.(nextPatch);
    });
  }

  function paintBitmap(bitmap: ImageBitmap, metrics: ViewportMetrics) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      bitmap.close();
      return;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(metrics.dpr, 0, 0, metrics.dpr, 0, 0);
    context.drawImage(bitmap, 0, 0, metrics.width, metrics.height);
    bitmap.close();
    setFirstFrameReady(true);
  }

  function applyPendingTarget() {
    const nextTarget = pendingTargetRef.current;
    if (!nextTarget || !workbook) return;
    const selectionTarget = workbookSelectionForTarget(workbook, nextTarget);
    if (!selectionTarget) {
      pendingTargetRef.current = null;
      return;
    }
    if (selectionTarget.sheetIndex !== sheetIndexRef.current) {
      setSheetIndex(selectionTarget.sheetIndex);
      sheetIndexRef.current = selectionTarget.sheetIndex;
      layoutRef.current = null;
      onViewStateChange?.({ sheetIndex: selectionTarget.sheetIndex });
      return;
    }
    const layout = layoutRef.current;
    if (!layout || layout.sheetIndex !== selectionTarget.sheetIndex) return;
    pendingTargetRef.current = null;
    setSelection(selectionTarget.selection);
    selectionRef.current = selectionTarget.selection;
    const nextScroll = scrollForSelection(selectionTarget.selection, layout, metricsRef.current, zoomRef.current);
    viewportRef.current?.scrollTo(nextScroll);
    scrollRef.current = nextScroll;
    setScrollPosition(nextScroll);
    onSelectionPrompt(null);
    onViewStateChange?.({
      sheetIndex: selectionTarget.sheetIndex,
      selection: selectionTarget.selection,
      scrollLeft: nextScroll.left,
      scrollTop: nextScroll.top,
    });
  }

  function setWorkbookZoom(nextZoom: number, anchor?: { x: number; y: number }) {
    const clamped = clampZoom(nextZoom);
    const currentZoom = zoomRef.current;
    if (Math.abs(clamped - currentZoom) < 0.001) return;
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    const anchorX = anchor && viewportRect ? anchor.x - viewportRect.left : metricsRef.current.width / 2;
    const anchorY = anchor && viewportRect ? anchor.y - viewportRect.top : metricsRef.current.height / 2;
    const logicalX = (scrollRef.current.left + anchorX) / currentZoom;
    const logicalY = (scrollRef.current.top + anchorY) / currentZoom;
    const nextScroll = clampScroll({
      left: logicalX * clamped - anchorX,
      top: logicalY * clamped - anchorY,
    }, layoutRef.current, metricsRef.current, clamped);
    setZoom(clamped);
    zoomRef.current = clamped;
    viewportRef.current?.scrollTo({ left: nextScroll.left, top: nextScroll.top });
    setScrollPosition(nextScroll);
    scrollRef.current = nextScroll;
    onViewStateChange?.({ zoom: clamped, scrollLeft: nextScroll.left, scrollTop: nextScroll.top });
  }

  function fitWidth() {
    const layout = layoutRef.current;
    if (!layout) return;
    const available = Math.max(1, metricsRef.current.width - 28);
    const nextZoom = clampZoom(available / Math.max(1, layout.width));
    setZoom(nextZoom);
    zoomRef.current = nextZoom;
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
    const nextScroll = { left: 0, top: 0 };
    setScrollPosition(nextScroll);
    scrollRef.current = nextScroll;
    onViewStateChange?.({ zoom: nextZoom, scrollLeft: 0, scrollTop: 0 });
  }

  function resetView() {
    const nextZoom = DEFAULT_ZOOM;
    setZoom(nextZoom);
    zoomRef.current = nextZoom;
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
    const nextScroll = { left: 0, top: 0 };
    setScrollPosition(nextScroll);
    scrollRef.current = nextScroll;
    onViewStateChange?.({ zoom: nextZoom, scrollLeft: 0, scrollTop: 0 });
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      setWorkbookZoom(zoomRef.current * (event.deltaY > 0 ? 1 / 1.12 : 1.12), { x: event.clientX, y: event.clientY });
    }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const shape = shapeFromPoint(event.clientX, event.clientY);
    if (shape) {
      event.preventDefault();
      dragCleanupRef.current?.();
      dragRef.current = null;
      const nextSelection = normalizeWorkbookSelection({
        kind: "shape",
        sheetIndex,
        startRow: 1,
        startColumn: 1,
        endRow: 1,
        endColumn: 1,
        shapeId: shape.id,
      });
      setSelection(nextSelection);
      selectionRef.current = nextSelection;
      queueViewStateChange({ selection: nextSelection });
      const rect = objectRect(shape);
      const text = workbookShapeSelectionText(activeSheet, shape);
      onSelectionPrompt({
        text: text.slice(0, 10_000),
        truncated: text.length > 10_000,
        x: Math.min(Math.max(rect.left + rect.width / 2, 84), Math.max(84, window.innerWidth - 84)),
        y: Math.max(12, rect.bottom + 10),
        source: "page",
        semanticUnitId: workbookSelectionSemanticUnitId(activeSheet, nextSelection),
        sourceLabel: workbookSelectionSourceLabel(activeSheet, nextSelection),
        clear: () => {
          setSelection(null);
          selectionRef.current = null;
          onViewStateChange?.({ selection: undefined });
        },
      });
      return;
    }
    const chart = chartFromPoint(event.clientX, event.clientY);
    if (chart) {
      event.preventDefault();
      dragCleanupRef.current?.();
      dragRef.current = null;
      const nextSelection = normalizeWorkbookSelection({
        kind: "chart",
        sheetIndex,
        startRow: 1,
        startColumn: 1,
        endRow: 1,
        endColumn: 1,
        chartId: chart.id,
      });
      setSelection(nextSelection);
      selectionRef.current = nextSelection;
      queueViewStateChange({ selection: nextSelection });
      const rect = objectRect(chart);
      const text = workbookChartSelectionText(activeSheet, chart);
      onSelectionPrompt({
        text: text.slice(0, 10_000),
        truncated: text.length > 10_000,
        x: Math.min(Math.max(rect.left + rect.width / 2, 84), Math.max(84, window.innerWidth - 84)),
        y: Math.max(12, rect.bottom + 10),
        source: "page",
        semanticUnitId: workbookSelectionSemanticUnitId(activeSheet, nextSelection),
        sourceLabel: workbookSelectionSourceLabel(activeSheet, nextSelection),
        clear: () => {
          setSelection(null);
          selectionRef.current = null;
          onViewStateChange?.({ selection: undefined });
        },
      });
      return;
    }
    const cell = cellFromPoint(event.clientX, event.clientY);
    if (!cell) return;
    event.preventDefault();
    dragCleanupRef.current?.();
    dragRef.current = { row: cell.row, column: cell.column, pointerId: event.pointerId, lastClientX: event.clientX, lastClientY: event.clientY };
    const nextSelection = normalizeWorkbookSelection({
      sheetIndex,
      startRow: cell.row,
      startColumn: cell.column,
      endRow: cell.row,
      endColumn: cell.column,
    });
    setSelection(nextSelection);
    selectionRef.current = nextSelection;
    onSelectionPrompt(null);
    queueViewStateChange({ selection: nextSelection });

    const handleWindowMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      pointerEvent.preventDefault();
      updateDragSelection(pointerEvent.clientX, pointerEvent.clientY);
    };
    const handleWindowEnd = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== event.pointerId) return;
      pointerEvent.preventDefault();
      finishDragSelection(pointerEvent.clientX, pointerEvent.clientY);
    };
    const handleBlur = () => {
      finishDragSelection(dragRef.current?.lastClientX, dragRef.current?.lastClientY);
    };
    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key !== "Escape") return;
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      dragRef.current = null;
      setSelection(null);
      selectionRef.current = null;
      onSelectionPrompt(null);
      onViewStateChange?.({ selection: undefined });
    };
    window.addEventListener("pointermove", handleWindowMove, { passive: false });
    window.addEventListener("pointerup", handleWindowEnd, { passive: false });
    window.addEventListener("pointercancel", handleWindowEnd, { passive: false });
    window.addEventListener("blur", handleBlur);
    window.addEventListener("keydown", handleKeyDown);
    dragCleanupRef.current = () => {
      window.removeEventListener("pointermove", handleWindowMove);
      window.removeEventListener("pointerup", handleWindowEnd);
      window.removeEventListener("pointercancel", handleWindowEnd);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    updateDragSelection(event.clientX, event.clientY);
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    finishDragSelection(event.clientX, event.clientY);
  }

  function updateDragSelection(clientX: number, clientY: number) {
    const anchor = dragRef.current;
    if (!anchor) return;
    anchor.lastClientX = clientX;
    anchor.lastClientY = clientY;
    const cell = cellFromPoint(clientX, clientY, true);
    if (!cell) return;
    const nextSelection = normalizeWorkbookSelection({
      sheetIndex,
      startRow: anchor.row,
      startColumn: anchor.column,
      endRow: cell.row,
      endColumn: cell.column,
    });
    setSelection(nextSelection);
    selectionRef.current = nextSelection;
    queueViewStateChange({ selection: nextSelection });
  }

  function finishDragSelection(clientX?: number, clientY?: number) {
    if (clientX != null && clientY != null) updateDragSelection(clientX, clientY);
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    dragRef.current = null;
    const nextSelection = selectionRef.current;
    if (!activeSheet || !nextSelection || nextSelection.sheetIndex !== sheetIndex) return;
    const text = workbookSelectionText(activeSheet, nextSelection);
    if (!text.trim()) {
      onSelectionPrompt(null);
      return;
    }
    const rect = selectionRect(nextSelection);
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    if (!rect || !viewportRect) return;
    onSelectionPrompt({
      text: text.slice(0, 10_000),
      truncated: text.length > 10_000,
      x: Math.min(Math.max(rect.left + rect.width / 2, 84), Math.max(84, window.innerWidth - 84)),
      y: Math.max(12, rect.top - 44),
      source: "page",
      semanticUnitId: workbookSelectionSemanticUnitId(activeSheet, nextSelection),
      sourceLabel: workbookSelectionSourceLabel(activeSheet, nextSelection),
      clear: () => {
        setSelection(null);
        selectionRef.current = null;
        onViewStateChange?.({ selection: undefined });
      },
    });
  }

  function chartFromPoint(clientX: number, clientY: number): WorkbookChartRect | null {
    const layout = layoutRef.current;
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    if (!layout || !viewportRect) return null;
    const x = (scrollRef.current.left + clientX - viewportRect.left) / zoomRef.current;
    const y = (scrollRef.current.top + clientY - viewportRect.top) / zoomRef.current;
    for (let index = layout.charts.length - 1; index >= 0; index -= 1) {
      const chart = layout.charts[index];
      if (x >= chart.x && x <= chart.x + chart.width && y >= chart.y && y <= chart.y + chart.height) return chart;
    }
    return null;
  }

  function shapeFromPoint(clientX: number, clientY: number): WorkbookShapeRect | null {
    const layout = layoutRef.current;
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    if (!layout || !viewportRect) return null;
    const x = (scrollRef.current.left + clientX - viewportRect.left) / zoomRef.current;
    const y = (scrollRef.current.top + clientY - viewportRect.top) / zoomRef.current;
    for (let index = layout.shapes.length - 1; index >= 0; index -= 1) {
      const shape = layout.shapes[index];
      if (x >= shape.x && x <= shape.x + shape.width && y >= shape.y && y <= shape.y + shape.height) return shape;
    }
    return null;
  }

  function cellFromPoint(clientX: number, clientY: number, clampToGrid = false): WorkbookCellRect | null {
    const layout = layoutRef.current;
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    if (!layout || !viewportRect) return null;
    const x = (scrollRef.current.left + clientX - viewportRect.left) / zoomRef.current;
    const y = (scrollRef.current.top + clientY - viewportRect.top) / zoomRef.current;
    if (!clampToGrid && (x < ROW_HEADER_WIDTH || y < COLUMN_HEADER_HEIGHT)) return null;
    const row = findIndexForPosition(layout.rowTops, layout.rowHeights, y, clampToGrid);
    const column = findIndexForPosition(layout.columnLefts, layout.columnWidths, x, clampToGrid);
    if (row == null || column == null) return null;
    const rowNumber = layout.rowNumbers[row] || row + 1;
    const columnNumber = column + 1;
    const existing = layout.cells.find((cell) => rowNumber >= cell.row && rowNumber <= cell.row && columnNumber >= cell.column && columnNumber <= cell.column);
    return existing || {
      row: rowNumber,
      column: columnNumber,
      ref: `${spreadsheetColumnName(column)}${rowNumber}`,
      text: "",
      x: layout.columnLefts[column] || ROW_HEADER_WIDTH,
      y: layout.rowTops[row] || COLUMN_HEADER_HEIGHT,
      width: layout.columnWidths[column] || DEFAULT_CELL_WIDTH,
      height: layout.rowHeights[row] || DEFAULT_CELL_HEIGHT,
    };
  }

  function selectionRect(current: WorkbookSelection): DOMRect | null {
    const layout = layoutRef.current;
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    if (!layout || !viewportRect) return null;
    if (current.kind === "chart") {
      const chart = layout.charts.find((item) => item.id === current.chartId);
      return chart ? objectRect(chart) : null;
    }
    if (current.kind === "shape") {
      const shape = layout.shapes.find((item) => item.id === current.shapeId);
      return shape ? objectRect(shape) : null;
    }
    const startColumnIndex = current.startColumn - 1;
    const endColumnIndex = current.endColumn - 1;
    const startRowIndex = layout.rowNumbers.indexOf(current.startRow);
    const endRowIndex = layout.rowNumbers.indexOf(current.endRow);
    if (startRowIndex < 0 || endRowIndex < 0 || startColumnIndex < 0 || endColumnIndex < 0) return null;
    const logicalLeft = layout.columnLefts[startColumnIndex] || ROW_HEADER_WIDTH;
    const logicalTop = layout.rowTops[startRowIndex] || COLUMN_HEADER_HEIGHT;
    const logicalRight = (layout.columnLefts[endColumnIndex] || ROW_HEADER_WIDTH) + (layout.columnWidths[endColumnIndex] || DEFAULT_CELL_WIDTH);
    const logicalBottom = (layout.rowTops[endRowIndex] || COLUMN_HEADER_HEIGHT) + (layout.rowHeights[endRowIndex] || DEFAULT_CELL_HEIGHT);
    const left = viewportRect.left + logicalLeft * zoomRef.current - scrollRef.current.left;
    const top = viewportRect.top + logicalTop * zoomRef.current - scrollRef.current.top;
    const right = viewportRect.left + logicalRight * zoomRef.current - scrollRef.current.left;
    const bottom = viewportRect.top + logicalBottom * zoomRef.current - scrollRef.current.top;
    return new DOMRect(left, top, right - left, bottom - top);
  }

  function objectRect(rect: { x: number; y: number; width: number; height: number }): DOMRect {
    const viewportRect = viewportRef.current?.getBoundingClientRect();
    const left = (viewportRect?.left || 0) + rect.x * zoomRef.current - scrollRef.current.left;
    const top = (viewportRect?.top || 0) + rect.y * zoomRef.current - scrollRef.current.top;
    return new DOMRect(left, top, rect.width * zoomRef.current, rect.height * zoomRef.current);
  }

  if (!workbook || !activeSheet) {
    return (
      <div className="rounded-lg border bg-background px-3 py-3">
        <pre className="whitespace-pre-wrap text-[12px] leading-6 text-foreground">{preview.content || "这个表格没有可预览的数据。"}</pre>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-card/85 px-3">
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <Table2 className="h-3.5 w-3.5 text-emerald-600" />
          <span className="truncate">工作簿 · {workbook.renderedSheetCount}/{workbook.sheetCount} 个工作表</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-x-auto py-1 brevyn-scrollbar">
          <WorkbookToolbarButton title="上一张表" onClick={() => selectSheet(sheetIndex - 1)}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </WorkbookToolbarButton>
          <span className="max-w-[10rem] truncate px-1 text-center text-[11px] font-medium text-muted-foreground" title={activeSheet.name}>
            {activeSheet.name}
          </span>
          <WorkbookToolbarButton title="下一张表" onClick={() => selectSheet(sheetIndex + 1)}>
            <ChevronRight className="h-3.5 w-3.5" />
          </WorkbookToolbarButton>
          <span className="mx-1 h-4 w-px bg-border" />
          <WorkbookToolbarButton title="缩小" onClick={() => setWorkbookZoom(zoomRef.current / 1.15)}>
            <Minus className="h-3.5 w-3.5" />
          </WorkbookToolbarButton>
          <span className="min-w-[46px] text-center font-mono text-[11px] text-muted-foreground">{Math.round(zoom * 100)}%</span>
          <WorkbookToolbarButton title="放大" onClick={() => setWorkbookZoom(zoomRef.current * 1.15)}>
            <Plus className="h-3.5 w-3.5" />
          </WorkbookToolbarButton>
          <WorkbookToolbarButton title="适应宽度" onClick={fitWidth}>
            <MoveHorizontal className="h-3.5 w-3.5" />
          </WorkbookToolbarButton>
          <WorkbookToolbarButton title="重置视图" onClick={resetView}>
            <RotateCcw className="h-3.5 w-3.5" />
          </WorkbookToolbarButton>
          <div className="ml-1 flex h-8 w-40 shrink-0 items-center gap-1.5 rounded-lg border bg-background/70 px-2 text-muted-foreground">
            <Search className="h-3.5 w-3.5" />
            <input
              className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
              value={search}
              onChange={(event) => updateSearch(event.target.value)}
              placeholder="搜索单元格"
            />
          </div>
        </div>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/25 px-3 text-[11px] text-muted-foreground">
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto brevyn-scrollbar">
          {sheets.map((sheet, index) => (
            <button
              key={`${sheet.index}-${sheet.name}`}
              type="button"
              className={`h-6 max-w-[12rem] shrink-0 rounded-md px-2 text-[11px] font-medium transition ${index === sheetIndex ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"}`}
              onClick={() => selectSheet(index)}
              title={sheet.name}
            >
              <span className="block truncate">{sheet.name}</span>
            </button>
          ))}
        </div>
        {selectionText && (
          <div className="shrink-0 rounded-full border bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground">
            {selection?.kind === "chart" ? "已选图表" : selection?.kind === "shape" ? "已选形状" : `已选 ${selection?.startRow}:${selection?.startColumn} - ${selection?.endRow}:${selection?.endColumn}`}
          </div>
        )}
      </div>
      <div className="flex h-9 shrink-0 items-center border-b bg-background text-[12px]">
        <div className="flex h-full w-16 shrink-0 items-center justify-center border-r font-mono text-muted-foreground">
          {formulaBarRef || "-"}
        </div>
        <div className="flex h-full w-12 shrink-0 items-center justify-center border-r font-serif text-lg italic text-muted-foreground">
          fx
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-3 px-3" title={formulaBarTitle}>
          {formulaBarChart || formulaBarShape ? (
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
              {formulaBarChart || formulaBarShape}
            </span>
          ) : formulaBarValue || formulaBarFormula ? (
            <>
              <span className="min-w-[4rem] max-w-[35%] truncate font-mono text-[12px] font-medium text-foreground">
                {formulaBarValue || "-"}
              </span>
              {formulaBarFormula && (
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                  {formulaBarFormula}
                </span>
              )}
            </>
          ) : (
            <span className="font-sans text-muted-foreground">选择单元格查看值或公式</span>
          )}
        </div>
      </div>
      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1 overflow-auto bg-muted/20 brevyn-scrollbar"
        onScroll={(event) => {
          const nextScroll = {
            left: event.currentTarget.scrollLeft,
            top: event.currentTarget.scrollTop,
          };
          setScrollPosition(nextScroll);
          scrollRef.current = nextScroll;
          if (dragRef.current) updateDragSelection(dragRef.current.lastClientX, dragRef.current.lastClientY);
          queueViewStateChange({ scrollLeft: nextScroll.left, scrollTop: nextScroll.top });
        }}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handlePointerEnd}
      >
        <div
          aria-hidden="true"
          style={{
            width: `${surfaceSize.width}px`,
            height: `${surfaceSize.height}px`,
          }}
        />
        <canvas
          ref={canvasRef}
          className={`pointer-events-none absolute left-0 top-0 z-10 block ${firstFrameReady ? "opacity-100" : "opacity-0"}`}
          style={{
            transform: `translate(${scrollPosition.left}px, ${scrollPosition.top}px)`,
          }}
        />
        {!firstFrameReady && !error && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background">
            <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-[11px] font-medium text-muted-foreground shadow-sm">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>正在绘制工作簿</span>
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-x-4 top-4 z-30 rounded-lg border bg-background/95 px-3 py-2 text-[12px] text-destructive shadow-sm">
            表格渲染失败：{error}
          </div>
        )}
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background/82 px-2.5 py-1 text-[10px] text-muted-foreground shadow-sm ring-1 ring-border/70">
          滚轮移动 · ⌘/Ctrl + 滚轮缩放 · 拖拽框选/点击图表引用
        </div>
      </div>
    </div>
  );
}

function WorkbookToolbarButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

function workbookSelectionText(sheet: SpreadsheetPreviewSheet, selection: WorkbookSelection): string {
  const normalized = normalizeWorkbookSelection(selection);
  const rows: string[] = [];
  const columnHeaders = Array.from(
    { length: normalized.endColumn - normalized.startColumn + 1 },
    (_value, index) => spreadsheetColumnName(normalized.startColumn + index - 1),
  );
  rows.push(["", ...columnHeaders].join("\t"));
  const rowsByNumber = new Map(sheet.rows.map((row) => [row.number, row] as const));
  for (let rowNumber = normalized.startRow; rowNumber <= normalized.endRow; rowNumber += 1) {
    const row = rowsByNumber.get(rowNumber);
    const cellsByColumn = new Map(normalizedRowCells(row).map((cell) => [cell.column, cell] as const));
    const cells = Array.from({ length: normalized.endColumn - normalized.startColumn + 1 }, (_value, index) => {
      const column = normalized.startColumn + index;
      const cell = cellsByColumn.get(column);
      return cell?.formula ? `${cell.text}${cell.text ? " " : ""}(=${cell.formula})` : cell?.text || "";
    });
    rows.push([String(rowNumber), ...cells].join("\t"));
  }
  return `工作表：${sheet.name}\n${rows.join("\n")}`;
}

function workbookChartSelectionText(sheet: SpreadsheetPreviewSheet, chartRect: WorkbookChartRect): string {
  const chart = chartRect.chart;
  const lines = [
    `工作表：${sheet.name}`,
    `图表：${chart.title || chart.name || `图表 ${chart.index + 1}`}`,
    `类型：${spreadsheetChartTypeLabel(chart)}`,
    chart.sourceRefs.length ? `数据范围：${chart.sourceRefs.join(", ")}` : "",
    "",
    ...chart.series.map((series, index) => {
      const values = series.values.map((value, valueIndex) => {
        const category = series.categories[valueIndex] || String(valueIndex + 1);
        return `${category}: ${value}`;
      }).join("；");
      return `${series.name || `系列 ${index + 1}`}：${values || "暂无可读取数据"}`;
    }),
  ].filter((line) => line != null);
  return lines.join("\n");
}

function workbookShapeSelectionText(sheet: SpreadsheetPreviewSheet, shapeRect: WorkbookShapeRect): string {
  const shape = shapeRect.shape;
  return [
    `工作表：${sheet.name}`,
    `对象：${shape.name || `形状 ${shape.index + 1}`}`,
    shape.shapeType ? `类型：${shape.shapeType}` : "",
    shape.text ? `内容：${shape.text}` : "",
  ].filter(Boolean).join("\n");
}

function spreadsheetChartTypeLabel(chart: { type: string; subtype?: string }): string {
  if (chart.type === "bar") return chart.subtype === "bar" ? "条形图" : "柱状图";
  if (chart.type === "line") return "折线图";
  if (chart.type === "pie") return "饼图";
  if (chart.type === "doughnut") return "环形图";
  if (chart.type === "scatter") return "散点图";
  if (chart.type === "area") return "面积图";
  if (chart.type === "radar") return "雷达图";
  if (chart.type === "bubble") return "气泡图";
  if (chart.type === "stock") return "股票图";
  if (chart.type === "surface") return "曲面图";
  if (chart.type === "treemap") return "树状图";
  if (chart.type === "sunburst") return "旭日图";
  if (chart.type === "histogram") return "直方图";
  if (chart.type === "boxWhisker") return "箱线图";
  if (chart.type === "waterfall") return "瀑布图";
  return "图表";
}

function normalizedRowCells(row?: SpreadsheetPreviewSheet["rows"][number]): SpreadsheetPreviewCell[] {
  if (!row) return [];
  if (row.cellObjects?.length) return row.cellObjects;
  return row.cells.map((text, index) => ({
    ref: `${spreadsheetColumnName(index)}${row.number}`,
    row: row.number,
    column: index + 1,
    text,
  }));
}

function findSheetCell(sheet: SpreadsheetPreviewSheet, rowNumber: number, columnNumber: number): SpreadsheetPreviewCell | null {
  const row = sheet.rows.find((item) => item.number === rowNumber);
  if (!row) return null;
  return normalizedRowCells(row).find((cell) => cell.column === columnNumber) || null;
}

function scrollForSelection(selection: WorkbookSelection, layout: WorkbookSheetLayout, metrics: ViewportMetrics, zoom: number): { left: number; top: number } {
  if (selection.kind === "chart") {
    const chart = layout.charts.find((item) => item.id === selection.chartId);
    if (chart) return centerLogicalRect({ x: chart.x, y: chart.y, width: chart.width, height: chart.height }, layout, metrics, zoom);
  }
  if (selection.kind === "shape") {
    const shape = layout.shapes.find((item) => item.id === selection.shapeId);
    if (shape) return centerLogicalRect({ x: shape.x, y: shape.y, width: shape.width, height: shape.height }, layout, metrics, zoom);
  }
  const startColumnIndex = Math.max(0, selection.startColumn - 1);
  const endColumnIndex = Math.max(0, selection.endColumn - 1);
  const startRowIndex = nearestRowIndex(layout.rowNumbers, selection.startRow);
  const endRowIndex = Math.max(startRowIndex, nearestRowIndex(layout.rowNumbers, selection.endRow));
  const left = layout.columnLefts[startColumnIndex] || ROW_HEADER_WIDTH;
  const top = layout.rowTops[startRowIndex] || COLUMN_HEADER_HEIGHT;
  const right = (layout.columnLefts[endColumnIndex] || left) + (layout.columnWidths[endColumnIndex] || DEFAULT_CELL_WIDTH);
  const bottom = (layout.rowTops[endRowIndex] || top) + (layout.rowHeights[endRowIndex] || DEFAULT_CELL_HEIGHT);
  return centerLogicalRect({ x: left, y: top, width: right - left, height: bottom - top }, layout, metrics, zoom);
}

function nearestRowIndex(rowNumbers: number[], targetRow: number): number {
  if (rowNumbers.length === 0) return 0;
  const exact = rowNumbers.indexOf(targetRow);
  if (exact >= 0) return exact;
  let closest = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < rowNumbers.length; index += 1) {
    const distance = Math.abs((rowNumbers[index] || 0) - targetRow);
    if (distance < closestDistance) {
      closest = index;
      closestDistance = distance;
    }
  }
  return closest;
}

function centerLogicalRect(rect: { x: number; y: number; width: number; height: number }, layout: WorkbookSheetLayout, metrics: ViewportMetrics, zoom: number): { left: number; top: number } {
  return clampScroll({
    left: rect.x * zoom + rect.width * zoom / 2 - metrics.width / 2,
    top: rect.y * zoom + rect.height * zoom / 2 - metrics.height / 2,
  }, layout, metrics, zoom);
}

function findIndexForPosition(offsets: number[], sizes: number[], position: number, clampToRange = false): number | null {
  let firstVisible: number | null = null;
  let lastVisible: number | null = null;
  for (let index = 0; index < offsets.length; index += 1) {
    const start = offsets[index] || 0;
    const size = sizes[index] || 0;
    if (size <= 0) continue;
    firstVisible ??= index;
    lastVisible = index;
    const end = start + size;
    if (position >= start && position <= end) return index;
  }
  if (clampToRange && firstVisible != null && lastVisible != null) {
    const firstStart = offsets[firstVisible] || 0;
    const lastEnd = (offsets[lastVisible] || 0) + (sizes[lastVisible] || 0);
    if (position < firstStart) return firstVisible;
    if (position > lastEnd) return lastVisible;
    let closest = firstVisible;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = firstVisible; index <= lastVisible; index += 1) {
      const size = sizes[index] || 0;
      if (size <= 0) continue;
      const start = offsets[index] || 0;
      const end = start + size;
      const distance = Math.min(Math.abs(position - start), Math.abs(position - end));
      if (distance < closestDistance) {
        closest = index;
        closestDistance = distance;
      }
    }
    return closest;
  }
  return null;
}

function clampScroll(scroll: { left: number; top: number }, layout: WorkbookSheetLayout | null, metrics: ViewportMetrics, zoom: number): { left: number; top: number } {
  if (!layout) return { left: Math.max(0, scroll.left), top: Math.max(0, scroll.top) };
  const maxX = Math.max(0, layout.width * zoom - metrics.width);
  const maxY = Math.max(0, layout.height * zoom - metrics.height);
  return {
    left: clamp(scroll.left, 0, maxX),
    top: clamp(scroll.top, 0, maxY),
  };
}

function readWorkbookTheme() {
  const styles = window.getComputedStyle(document.documentElement);
  const css = (name: string, fallback: string) => {
    const value = styles.getPropertyValue(name).trim();
    return value ? `hsl(${value})` : fallback;
  };
  const primary = css("--primary", "#2563eb");
  return {
    background: css("--background", "#ffffff"),
    foreground: css("--foreground", "#0f172a"),
    card: css("--card", "#f8fafc"),
    muted: css("--muted", "#f1f5f9"),
    mutedForeground: css("--muted-foreground", "#64748b"),
    border: css("--border", "#e2e8f0"),
    primary,
    selectionFill: "rgba(147, 197, 253, 0.28)",
    selectionStroke: "#60a5fa",
    searchFill: "rgba(245, 158, 11, 0.25)",
  };
}

function spreadsheetColumnName(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }
  return label;
}

function clampZoom(value: number): number {
  return clamp(value, MIN_ZOOM, MAX_ZOOM);
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
