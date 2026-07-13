import { BarChart3, ChevronDown, ChevronLeft, ChevronRight, Code2, Eye, ExternalLink, FileSearch, FileText, FolderOpen, ImageIcon, Loader2, Maximize2, Minimize2, Minus, MoveHorizontal, Plus, Presentation, Quote, RotateCcw, Search, Table2, Terminal, Type } from "lucide-react";
import type { ContextAnchor, FilePreview, OpenPathOption, SpreadsheetPreviewChart, SpreadsheetPreviewChartSeries, SpreadsheetPreviewSheet } from "@/types/domain";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject, type SyntheticEvent, type WheelEvent as ReactWheelEvent } from "react";
import { createPortal } from "react-dom";
import { Markdownish } from "@/components/chat/Markdownish";
import { createQuotedSelection, MAX_QUOTED_SELECTION_CHARS } from "@/components/agent/quotedSelection";
import type { ParsedPreviewResult } from "@/hooks/useFilePreviewState";
import type { FilePreviewLocationTarget } from "@/components/chat/FilePathChip";
import { FileTypeBadge, FileTypeIcon } from "./FileTypeIcon";
import type { FilePreviewLoadingFile } from "@/hooks/useFilePreviewState";
import { WorkbookCanvasPreview } from "./WorkbookCanvasPreview";

const openPathOptionsCache = new Map<string, OpenPathOption[]>();
const PREVIEW_VIEW_STATE_LIMIT = 60;
const previewViewStates = new Map<string, PreviewViewState>();
type PreviewViewState = {
  scrollTop?: number;
  pdfZoom?: number;
  pdfFitMode?: "custom" | "page" | "width";
  pdfScrollTop?: number;
  pptxSlideIndex?: number;
  imageZoom?: number;
  imageOffsetX?: number;
  imageOffsetY?: number;
  imageZoomIndex?: number;
  imageScrollLeft?: number;
  imageScrollTop?: number;
  spreadsheetSheetIndex?: number;
  spreadsheetSearch?: string;
  spreadsheetSelection?: SpreadsheetSelection;
  spreadsheetZoom?: number;
  spreadsheetScrollLeft?: number;
  spreadsheetScrollTop?: number;
};

type SpreadsheetSelection = {
  sheetIndex: number;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
};

export interface SelectionPromptState {
  text: string;
  truncated: boolean;
  x: number;
  y: number;
  source: "page" | "preview-frame";
  page?: number;
  semanticUnitId?: string;
  sourceLabel?: string;
  clear?: () => void;
}

type ParsedPreviewMissingState = {
  fileId: string;
  title: string;
  path: string;
  message: string;
};

function pdfSelectionSource(eventData: unknown): { page?: number; sourceLabel?: string } {
  if (!eventData || typeof eventData !== "object") return {};
  const pageValue = "page" in eventData ? Number((eventData as { page?: unknown }).page) : NaN;
  if (!Number.isFinite(pageValue) || pageValue <= 0) return {};
  const page = Math.floor(pageValue);
  const sourceLabel = "sourceLabel" in eventData && typeof (eventData as { sourceLabel?: unknown }).sourceLabel === "string"
    ? String((eventData as { sourceLabel?: string }).sourceLabel)
    : `第 ${page} 页`;
  return { page, sourceLabel };
}

function pdfSelectionSemanticUnitId(preview: FilePreview, page: number | undefined, eventData?: unknown): string | undefined {
  if (eventData && typeof eventData === "object" && "semanticUnitId" in eventData && typeof (eventData as { semanticUnitId?: unknown }).semanticUnitId === "string") {
    return (eventData as { semanticUnitId: string }).semanticUnitId;
  }
  if (preview.kind !== "pdf" || typeof page !== "number") return undefined;
  const artifactId = typeof preview.metadata?.artifactId === "string" ? preview.metadata.artifactId : "";
  return artifactId ? `${artifactId}:unit-page-${page}` : undefined;
}

function pdfHighlightPayload(target?: FilePreviewLocationTarget | null): { type: "pdf-highlight-page"; page?: number; semanticUnitId?: string; bbox?: string; text?: string } | null {
  if (!target) return null;
  const page = typeof target.page === "number" && target.page > 0
    ? Math.floor(target.page)
    : typeof target.slide === "number" && target.slide > 0
      ? Math.floor(target.slide)
      : undefined;
  const semanticUnitId = target.semanticUnitId?.trim();
  const bbox = target.bbox?.trim();
  const text = target.text?.trim();
  if (!page && !semanticUnitId && !bbox && !text) return null;
  return { type: "pdf-highlight-page", page, semanticUnitId: semanticUnitId || undefined, bbox: bbox || undefined, text: text || undefined };
}

function postPdfHighlight(iframe: HTMLIFrameElement | null, target?: FilePreviewLocationTarget | null): void {
  const payload = pdfHighlightPayload(target);
  if (!payload) return;
  iframe?.contentWindow?.postMessage(payload, "*");
}

function previewTargetKey(target?: FilePreviewLocationTarget | null): string {
  if (!target) return "";
  return [
    target.fileId,
    target.sourcePath,
    target.path,
    target.sectionType,
    target.semanticUnitId,
    ...(target.elementIds || []),
    target.page,
    target.slide,
    target.sheet,
    target.range,
    target.bbox,
    target.text,
  ].filter((value) => value !== undefined && value !== null && value !== "").join("|");
}

export function FilePreviewPane({
  preview,
  previewTarget,
  loading = false,
  loadingFile,
  expanded,
  onToggleExpanded,
  threadId,
  onAddQuotedSelection,
  onPreviewSourceFile,
  onPreviewParsedFile,
}: {
  preview: FilePreview | null;
  previewTarget?: FilePreviewLocationTarget | null;
  loading?: boolean;
  loadingFile?: FilePreviewLoadingFile | null;
  expanded?: boolean;
  onToggleExpanded?: () => void;
  threadId?: string;
  onAddQuotedSelection?: (quote: ContextAnchor) => void;
  onPreviewSourceFile?: (fileId: string) => Promise<boolean> | boolean;
  onPreviewParsedFile?: (fileId: string) => Promise<ParsedPreviewResult> | ParsedPreviewResult;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const previewFrameCleanupRef = useRef<(() => void) | null>(null);
  const previewKey = preview ? filePreviewViewKey(preview) : "";
  const [selectionPrompt, setSelectionPrompt] = useState<SelectionPromptState | null>(null);
  const [parsedMissing, setParsedMissing] = useState<ParsedPreviewMissingState | null>(null);
  const [previewFrameHeight, setPreviewFrameHeight] = useState(0);
  const captureQuoteSelection = Boolean(threadId && preview && preview.sourcePath && onAddQuotedSelection);
  const isParsedPreview = Boolean(preview?.id.endsWith(":parsed"));
  const parsedSourceFileId = preview ? parsedPreviewSourceFileId(preview) : "";
  const originalFileId = preview ? originalPreviewSourceFileId(preview) : "";
  const canToggleParsedPreview = Boolean((parsedSourceFileId || isParsedPreview || parsedMissing?.fileId) && onPreviewParsedFile);

  const selectionPromptFromSelection = useCallback((selection: Selection | null, root: Node, offset?: DOMRect): SelectionPromptState | null => {
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const text = selection.toString().replace(/\u00a0/g, " ").trim();
    if (!text) return null;
    const range = selection.getRangeAt(0);
    const anchorNode = selection.anchorNode;
    const focusNode = selection.focusNode;
    if (!anchorNode || !focusNode || !root.contains(anchorNode) || !root.contains(focusNode)) return null;
    const rangeRect = range.getBoundingClientRect();
    if (!rangeRect.width && !rangeRect.height) return null;
    const selectedText = text.slice(0, MAX_QUOTED_SELECTION_CHARS);
    const truncated = text.length > MAX_QUOTED_SELECTION_CHARS;
    const left = (offset?.left || 0) + rangeRect.left;
    const top = (offset?.top || 0) + rangeRect.top;
    const x = Math.min(Math.max(left + rangeRect.width / 2, 84), Math.max(84, window.innerWidth - 84));
    const y = Math.max(12, top - 44);
    return {
      text: selectedText,
      truncated,
      x,
      y,
      source: offset ? "preview-frame" : "page",
    };
  }, []);

  useEffect(() => {
    if (!previewKey) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const saved = readPreviewViewState(previewKey);
      if (scrollRef.current) scrollRef.current.scrollTop = saved?.scrollTop || 0;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [previewKey]);

  const updateSelectionPrompt = useCallback(() => {
    const container = scrollRef.current;
    if (!container || !preview || !threadId || !preview.sourcePath) {
      setSelectionPrompt(null);
      return;
    }
    setSelectionPrompt(selectionPromptFromSelection(window.getSelection(), container));
  }, [preview, selectionPromptFromSelection, threadId]);

  const updateFrameSelectionPrompt = useCallback(() => {
    const frame = previewFrameRef.current;
    const frameWindow = frame?.contentWindow;
    const frameDocument = frame?.contentDocument;
    if (!frame || !frameWindow || !frameDocument || !preview || !threadId || !preview.sourcePath) {
      setSelectionPrompt(null);
      return;
    }
    const page = frameDocument.querySelector(".page");
    if (!page) {
      setSelectionPrompt(null);
      return;
    }
    setSelectionPrompt(selectionPromptFromSelection(frameWindow.getSelection(), page, frame.getBoundingClientRect()));
  }, [preview, selectionPromptFromSelection, threadId]);

  const handlePreviewFrameLoad = useCallback(() => {
    previewFrameCleanupRef.current?.();
    previewFrameCleanupRef.current = null;
    const frame = previewFrameRef.current;
    if (!frame) return;
    let frameId = 0;
    let resizeFrameId = 0;
    let resizeObserver: ResizeObserver | null = null;
    const frameDocument = frame.contentDocument;
    const resizeDocxFrame = () => {
      if (preview?.kind !== "docx") return;
      const documentElement = frame.contentDocument?.documentElement;
      const body = frame.contentDocument?.body;
      if (!documentElement || !body) return;
      const viewportHeight = scrollRef.current?.clientHeight || 0;
      const nextHeight = Math.ceil(Math.max(
        viewportHeight,
        documentElement.scrollHeight,
        body.scrollHeight,
        documentElement.offsetHeight,
        body.offsetHeight,
      ));
      setPreviewFrameHeight((current) => Math.abs(current - nextHeight) > 2 ? nextHeight : current);
    };
    const scheduleResize = () => {
      if (resizeFrameId) return;
      resizeFrameId = window.requestAnimationFrame(() => {
        resizeFrameId = 0;
        resizeDocxFrame();
      });
    };
    if (preview?.kind === "docx" && frameDocument) {
      scheduleResize();
      resizeObserver = new ResizeObserver(scheduleResize);
      if (frameDocument.documentElement) resizeObserver.observe(frameDocument.documentElement);
      if (frameDocument.body) {
        resizeObserver.observe(frameDocument.body);
        frameDocument.body.querySelectorAll("img").forEach((image) => {
          image.addEventListener("load", scheduleResize);
        });
      }
      frame.contentWindow?.addEventListener("resize", scheduleResize);
    }
    const useFrameSelectionBridge = captureQuoteSelection && preview?.kind !== "pdf" && preview?.kind !== "pptx" && !(preview?.kind === "docx" && preview.previewUrl);
    if (!useFrameSelectionBridge) {
      previewFrameCleanupRef.current = () => {
        if (resizeFrameId) window.cancelAnimationFrame(resizeFrameId);
        resizeObserver?.disconnect();
        if (frameDocument?.body) {
          frameDocument.body.querySelectorAll("img").forEach((image) => {
            image.removeEventListener("load", scheduleResize);
          });
        }
        frame.contentWindow?.removeEventListener("resize", scheduleResize);
      };
      return;
    }
    const schedule = () => {
      if (frameId) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = 0;
        updateFrameSelectionPrompt();
      });
    };
    frameDocument?.addEventListener("mouseup", schedule);
    frameDocument?.addEventListener("keyup", schedule);
    frameDocument?.addEventListener("selectionchange", schedule);
    previewFrameCleanupRef.current = () => {
      if (frameId) window.cancelAnimationFrame(frameId);
      if (resizeFrameId) window.cancelAnimationFrame(resizeFrameId);
      resizeObserver?.disconnect();
      if (frameDocument?.body) {
        frameDocument.body.querySelectorAll("img").forEach((image) => {
          image.removeEventListener("load", scheduleResize);
        });
      }
      frame.contentWindow?.removeEventListener("resize", scheduleResize);
      frameDocument?.removeEventListener("mouseup", schedule);
      frameDocument?.removeEventListener("keyup", schedule);
      frameDocument?.removeEventListener("selectionchange", schedule);
    };
  }, [captureQuoteSelection, preview?.kind, updateFrameSelectionPrompt]);

  useEffect(() => {
    if (!captureQuoteSelection) {
      setSelectionPrompt(null);
      return undefined;
    }
    const container = scrollRef.current;
    if (!container) return undefined;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateSelectionPrompt();
      });
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-quote-selection-action]")) return;
      setSelectionPrompt(null);
    };
    container.addEventListener("mouseup", schedule);
    container.addEventListener("keyup", schedule);
    container.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("selectionchange", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      container.removeEventListener("mouseup", schedule);
      container.removeEventListener("keyup", schedule);
      container.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("selectionchange", schedule);
    };
  }, [captureQuoteSelection, updateSelectionPrompt]);

  useEffect(() => {
    handlePreviewFrameLoad();
    return () => {
      previewFrameCleanupRef.current?.();
      previewFrameCleanupRef.current = null;
    };
  }, [handlePreviewFrameLoad, previewKey]);

  useEffect(() => {
    setPreviewFrameHeight(0);
    setSelectionPrompt(null);
  }, [previewKey]);

  function handlePreviewScroll() {
    if (!previewKey || !scrollRef.current) return;
    updatePreviewViewState(previewKey, { scrollTop: scrollRef.current.scrollTop });
  }

  function addSelectionToConversation() {
    if (!selectionPrompt || !preview?.sourcePath || !threadId || !onAddQuotedSelection) return;
    onAddQuotedSelection(createQuotedSelection({
      threadId,
      text: selectionPrompt.text,
      filePath: preview.sourcePath,
      page: selectionPrompt.page,
      semanticUnitId: selectionPrompt.semanticUnitId,
      sourceLabel: selectionPrompt.sourceLabel,
    }));
    selectionPrompt.clear?.();
    if (selectionPrompt.source === "preview-frame") {
      previewFrameRef.current?.contentWindow?.getSelection()?.removeAllRanges();
    }
    setSelectionPrompt(null);
    window.getSelection()?.removeAllRanges();
  }

  useEffect(() => {
    setParsedMissing(null);
  }, [preview?.id]);

  async function openParsedPreview() {
    if (!preview || !parsedSourceFileId || !onPreviewParsedFile) return;
    const result = await onPreviewParsedFile(parsedSourceFileId);
    if (!result?.ok) {
      setParsedMissing({
        fileId: parsedSourceFileId,
        title: preview.title,
        path: preview.path,
        message: result?.message || "还没有生成解析文本。",
      });
    }
  }

  function closeParsedMissing() {
    setParsedMissing(null);
  }

  async function openOriginalPreview() {
    setParsedMissing(null);
    if (isParsedPreview && originalFileId && onPreviewSourceFile) {
      await onPreviewSourceFile(originalFileId);
    }
  }

  if (!preview) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center justify-between border-b bg-card/60 px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs font-semibold">
            <Eye className="h-4 w-4 text-muted-foreground" />
            阅读预览
          </div>
          {onToggleExpanded && (
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-md border bg-background/70 text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={onToggleExpanded}
              title={expanded ? "收起预览" : "展开预览"}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          )}
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <div className="brevyn-preview-empty-card w-full max-w-[18rem] rounded-2xl border border-dashed border-border/80 bg-background/55 px-4 py-5 text-center shadow-sm ring-1 ring-white/45">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border bg-card/85 text-muted-foreground shadow-sm">
              <FileSearch className={`h-5 w-5 ${loading ? "animate-pulse" : ""}`} />
            </div>
            {loading ? (
              <PreviewLoadingState file={loadingFile} />
            ) : (
              <>
                <p className="mt-3 text-sm font-semibold text-foreground">选择文件预览</p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  点击文件树或对话里的文件引用，Markdown、PDF、图片和 Office 文档会在这里打开。
                </p>
                <div className="mt-3 flex flex-wrap justify-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                  {["MD", "PDF", "DOCX", "PPTX", "XLSX", "IMG"].map((label) => (
                    <span key={label} className="rounded-full border bg-card/70 px-2 py-0.5">
                      {label}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  const isDocxPdfPreview = preview.kind === "docx" && Boolean(preview.previewUrl);
  const isFullBleedDocxPreview = preview.kind === "docx" && Boolean(preview.html || preview.previewUrl);
  const isDeckPreview = preview.kind === "pptx" && Boolean(preview.previewUrl || preview.fileUrl);
  const isWorkbookPreview = preview.kind === "spreadsheet" && Boolean(preview.spreadsheet);
  const shouldFillPreview = isDeckPreview || isDocxPdfPreview || isWorkbookPreview;
  const shouldShowSummary = Boolean(preview.summary && !isFullBleedDocxPreview && !isDeckPreview && !isWorkbookPreview);
  const officePreviewModeLabel = officePreviewModeLabelFor(preview);
  const selectionPromptButton = captureQuoteSelection && selectionPrompt && (
    <div
      className="fixed z-[9999] -translate-x-1/2"
      style={{ left: selectionPrompt.x, top: selectionPrompt.y }}
    >
      <button
        type="button"
        data-quote-selection-action
        className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border/70 bg-card/95 px-3 text-[12px] font-semibold text-foreground shadow-[0_12px_32px_rgba(35,31,24,0.18)] ring-1 ring-background/60 transition hover:-translate-y-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={addSelectionToConversation}
        title={selectionPrompt.truncated ? `已截断到 ${MAX_QUOTED_SELECTION_CHARS} 字` : "引用选中文本询问 Brevyn"}
      >
        <Quote className="h-3.5 w-3.5" />
        <span>问 Brevyn</span>
        {selectionPrompt.truncated && <span className="text-[10px] text-muted-foreground">前 {MAX_QUOTED_SELECTION_CHARS} 字</span>}
      </button>
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {selectionPromptButton ? createPortal(selectionPromptButton, document.body) : null}
      <div className="flex min-h-[42px] items-center gap-2 border-b px-3 py-2">
        <FileTypeIcon name={preview.title || preview.path} isDirectory={preview.kind === "folder"} size={16} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="truncate text-xs font-semibold">{preview.title}</div>
            <FileTypeBadge name={preview.title || preview.path} kind={preview.kind} />
            {officePreviewModeLabel && (
              <span className="shrink-0 rounded-full border border-border/70 bg-card/75 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                {officePreviewModeLabel}
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="shrink-0">{previewKindLabel(preview.kind)}</span>
            <span className="h-0.5 w-0.5 shrink-0 rounded-full bg-muted-foreground/45" />
            <span className="truncate">{preview.path}</span>
          </div>
        </div>
        {canToggleParsedPreview && (
          <div className="flex h-7 shrink-0 items-center overflow-hidden rounded-lg border bg-background/70 p-0.5 text-[11px] font-medium shadow-sm">
            <button
              type="button"
              className={`h-6 rounded-md px-2.5 transition ${!isParsedPreview && !parsedMissing ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
              onClick={() => void openOriginalPreview()}
            >
              原文预览
            </button>
            <button
              type="button"
              className={`flex h-6 items-center gap-1 rounded-md px-2.5 transition ${isParsedPreview || parsedMissing ? "bg-primary/12 text-primary shadow-sm" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
              onClick={() => void openParsedPreview()}
            >
              <FileText className="h-3.5 w-3.5" />
              <span>解析文本</span>
            </button>
          </div>
        )}
        {preview.sourcePath && <OpenPreviewFileMenu preview={preview} />}
        {onToggleExpanded && (
          <button
            type="button"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/60 hover:text-foreground"
            onClick={onToggleExpanded}
            title={expanded ? "收起预览" : "展开预览"}
          >
            {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      <div
        ref={scrollRef}
        className={`relative h-full min-h-0 flex-1 brevyn-scrollbar ${shouldFillPreview ? "flex flex-col overflow-hidden bg-background p-0" : `overflow-y-auto ${isFullBleedDocxPreview ? "bg-[#f6f6f4] p-0" : "p-3"}`}`}
        onScroll={handlePreviewScroll}
      >
        {parsedMissing
          ? <ParsedPreviewMissingCard message={parsedMissing.message} onBack={closeParsedMissing} />
          : (
            <PreviewContent
              preview={preview}
              previewTarget={previewTarget}
              previewKey={previewKey}
              shouldShowSummary={shouldShowSummary}
              fillPreview={shouldFillPreview}
              previewFrameRef={previewFrameRef}
              previewFrameHeight={previewFrameHeight}
              onFrameLoad={handlePreviewFrameLoad}
              onFrameSelectionPrompt={setSelectionPrompt}
            />
          )}
      </div>
      {loading && <PreviewPaneLoadingOverlay file={loadingFile} />}
    </div>
  );
}

function PreviewContent({
  preview,
  previewTarget,
  previewKey,
  shouldShowSummary,
  fillPreview,
  previewFrameRef,
  previewFrameHeight,
  onFrameLoad,
  onFrameSelectionPrompt,
}: {
  preview: FilePreview;
  previewTarget?: FilePreviewLocationTarget | null;
  previewKey: string;
  shouldShowSummary: boolean;
  fillPreview?: boolean;
  previewFrameRef: MutableRefObject<HTMLIFrameElement | null>;
  previewFrameHeight: number;
  onFrameLoad: () => void;
  onFrameSelectionPrompt: (state: SelectionPromptState | null) => void;
}) {
  return (
    <div className={fillPreview ? "flex h-full min-h-0 w-full flex-1 flex-col" : undefined}>
      {shouldShowSummary && <div className="mb-3 rounded-lg border bg-background/70 px-3 py-2 text-[12px] leading-5 text-muted-foreground">{preview.summary}</div>}

      {preview.kind === "markdown" && preview.content && (
        <div className="rounded-lg border bg-background px-3 py-3 text-[12px] leading-6 text-foreground">
          <Markdownish content={preview.content} preserveSoftBreaks />
        </div>
      )}

      {preview.kind === "pdf" && (preview.previewUrl || preview.fileUrl) && (
        <PdfPreviewFrame preview={preview} viewKey={previewKey} target={previewTarget} onSelectionPrompt={onFrameSelectionPrompt} />
      )}

      {preview.kind === "docx" && preview.previewUrl && (
        <DocxPdfPreviewFrame preview={preview} viewKey={previewKey} target={previewTarget} onSelectionPrompt={onFrameSelectionPrompt} />
      )}

      {preview.kind === "pptx" && (preview.previewUrl || preview.fileUrl) && (
        <div className="flex h-full min-h-0 flex-1 flex-col">
          <PptxPdfPreviewFrame preview={preview} viewKey={previewKey} target={previewTarget} onSelectionPrompt={onFrameSelectionPrompt} />
        </div>
      )}

      {(preview.kind === "code" || preview.kind === "text") && preview.content && (
        <pre className="overflow-x-auto rounded-lg border bg-muted/40 px-3 py-3 text-[12px] leading-6 text-foreground">
          <code>{preview.content}</code>
        </pre>
      )}

      {preview.kind === "image" && <ImagePreviewFrame preview={preview} viewKey={previewKey} />}

      {preview.kind === "docx" && !preview.previewUrl && preview.html && (
        <div className="min-h-[70vh] bg-[#f6f6f4]">
          <iframe
            ref={previewFrameRef}
            className="block w-full border-0 bg-[#f6f6f4]"
            sandbox="allow-same-origin"
            scrolling="no"
            srcDoc={officePreviewDocument(preview.html, "docx")}
            style={{ height: previewFrameHeight ? `${previewFrameHeight}px` : "70vh" }}
            title={preview.title}
            onLoad={onFrameLoad}
          />
        </div>
      )}

      {preview.kind === "docx" && !preview.previewUrl && !preview.html && preview.content && (
        <div className="rounded-lg border bg-background px-3 py-3">
          <pre className="whitespace-pre-wrap text-[12px] leading-6 text-foreground">{preview.content}</pre>
        </div>
      )}

      {preview.kind === "spreadsheet" && preview.spreadsheet && (
        <WorkbookCanvasPreview
          preview={preview}
          target={previewTarget}
          viewState={{
            sheetIndex: readPreviewViewState(previewKey)?.spreadsheetSheetIndex,
            zoom: readPreviewViewState(previewKey)?.spreadsheetZoom,
            scrollLeft: readPreviewViewState(previewKey)?.spreadsheetScrollLeft,
            scrollTop: readPreviewViewState(previewKey)?.spreadsheetScrollTop,
            search: readPreviewViewState(previewKey)?.spreadsheetSearch,
            selection: readPreviewViewState(previewKey)?.spreadsheetSelection,
          }}
          onViewStateChange={(patch) => {
            const nextPatch: PreviewViewState = {};
            if ("sheetIndex" in patch) nextPatch.spreadsheetSheetIndex = patch.sheetIndex;
            if ("zoom" in patch) nextPatch.spreadsheetZoom = patch.zoom;
            if ("scrollLeft" in patch) nextPatch.spreadsheetScrollLeft = patch.scrollLeft;
            if ("scrollTop" in patch) nextPatch.spreadsheetScrollTop = patch.scrollTop;
            if ("search" in patch) nextPatch.spreadsheetSearch = patch.search;
            if ("selection" in patch) nextPatch.spreadsheetSelection = patch.selection;
            updatePreviewViewState(previewKey, nextPatch);
          }}
          onSelectionPrompt={onFrameSelectionPrompt}
        />
      )}

      {preview.kind === "spreadsheet" && !preview.spreadsheet && preview.html && (
        <div className="h-[70vh] overflow-hidden rounded-lg border bg-background shadow-sm">
          <iframe
            ref={previewFrameRef}
            className="h-full w-full bg-background"
            sandbox="allow-same-origin"
            srcDoc={officePreviewDocument(preview.html, "spreadsheet")}
            title={preview.title}
            onLoad={onFrameLoad}
          />
        </div>
      )}

      {(preview.kind === "pptx" || preview.kind === "spreadsheet") && !preview.previewUrl && !preview.html && preview.content && (
        <div className="rounded-lg border bg-background px-3 py-3">
          <pre className="whitespace-pre-wrap text-[12px] leading-6 text-foreground">{preview.content}</pre>
        </div>
      )}
    </div>
  );
}

function PreviewLoadingState({ file }: { file?: FilePreviewLoadingFile | null }) {
  const [slow, setSlow] = useState(false);
  const isPptx = file?.kind === "pptx";

  useEffect(() => {
    setSlow(false);
    const timeout = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(timeout);
  }, [file?.id]);

  return (
    <>
      <p className="mt-3 text-sm font-semibold text-foreground">
        {isPptx ? "正在生成高保真预览" : "正在生成预览"}
      </p>
      <p className="mx-auto mt-1 max-w-[15rem] text-[11px] leading-5 text-muted-foreground">
        {isPptx
          ? slow
            ? "仍在生成，可以先查看解析文本或继续等待。"
            : "首次使用需要初始化预览组件，之后会更快。"
          : "正在读取文件内容，请稍候。"}
      </p>
      {file?.name && (
        <div className="mx-auto mt-2 max-w-[15rem] truncate rounded-full border bg-card/70 px-2.5 py-1 text-[10px] font-medium text-muted-foreground" title={file.path || file.name}>
          {file.name}
        </div>
      )}
      <div className="mt-3 space-y-2">
        <div className="mx-auto h-2.5 w-36 animate-pulse rounded-full bg-muted" />
        <div className="mx-auto h-2.5 w-24 animate-pulse rounded-full bg-muted/70" />
      </div>
    </>
  );
}

function PreviewPaneLoadingOverlay({ file }: { file?: FilePreviewLoadingFile | null }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/94 p-4">
      <div className="w-full max-w-[18rem] rounded-[var(--radius-card)] border bg-card px-4 py-5 text-center shadow-lg">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        <PreviewLoadingState file={file} />
      </div>
    </div>
  );
}

function PreviewFrameLoadingOverlay({ label }: { label: string }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background">
      <div className="flex items-center gap-2 rounded-[var(--radius-control)] border bg-card px-3 py-2 text-[11px] font-medium text-muted-foreground shadow-sm">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span>{label}</span>
      </div>
    </div>
  );
}

function PptxPdfPreviewFrame({
  preview,
  viewKey,
  target,
  onSelectionPrompt,
}: {
  preview: FilePreview;
  viewKey: string;
  target?: FilePreviewLocationTarget | null;
  onSelectionPrompt: (state: SelectionPromptState | null) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const restoredViewRef = useRef(false);
  const savedSlideIndexRef = useRef(Math.max(0, readPreviewViewState(viewKey)?.pptxSlideIndex || 0));
  const [zoom, setZoom] = useState(() => readPreviewViewState(viewKey)?.pdfZoom || 100);
  const [fitMode, setFitMode] = useState<"custom" | "page" | "width">("page");
  const [ready, setReady] = useState(false);
  const src = preview.previewUrl || preview.fileUrl || "";
  const [pageCount, setPageCount] = useState(0);
  const effectivePageCount = pageCount;
  const initialSlide = Math.min(Math.max(readPreviewViewState(viewKey)?.pptxSlideIndex || 0, 0), Math.max(0, effectivePageCount - 1));
  const [slideIndex, setSlideIndex] = useState(initialSlide);
  const targetKey = previewTargetKey(target);

  useEffect(() => {
    const saved = readPreviewViewState(viewKey);
    setZoom(100);
    setFitMode("page");
    setReady(false);
    restoredViewRef.current = false;
    savedSlideIndexRef.current = Math.max(0, saved?.pptxSlideIndex || 0);
    setPageCount(0);
    setSlideIndex(savedSlideIndexRef.current);
    // Only reset when the file changes; iframe will report the real page count after load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, viewKey]);

  useEffect(() => {
    const root = document.documentElement;
    const sendTheme = () => postPdfPreviewTheme(iframeRef.current);
    sendTheme();
    const observer = new MutationObserver(sendTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [src]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === "pdf-rendered" || event.data?.type === "pdf-error") {
        setReady(true);
        return;
      }
      if (event.data?.type === "pdf-selection-cleared") {
        onSelectionPrompt(null);
        return;
      }
      if (event.data?.type === "pdf-selection" && typeof event.data.text === "string" && event.data.rect) {
        const text = event.data.text.replace(/\u00a0/g, " ").trim();
        if (!text) {
          onSelectionPrompt(null);
          return;
        }
        const frameRect = iframeRef.current?.getBoundingClientRect();
        if (!frameRect) return;
        const rangeRect = event.data.rect as { left?: number; top?: number; width?: number; height?: number };
        const selectedText = text.slice(0, MAX_QUOTED_SELECTION_CHARS);
        const truncated = text.length > MAX_QUOTED_SELECTION_CHARS;
        const left = frameRect.left + Number(rangeRect.left || 0);
        const top = frameRect.top + Number(rangeRect.top || 0);
        const width = Number(rangeRect.width || 0);
        const x = Math.min(Math.max(left + width / 2, 84), Math.max(84, window.innerWidth - 84));
        const y = Math.max(12, top - 44);
        const sourceInfo = pdfSelectionSource(event.data);
        onSelectionPrompt({
          text: selectedText,
          truncated,
          x,
          y,
          source: "preview-frame",
          page: sourceInfo.page,
          semanticUnitId: pdfSelectionSemanticUnitId(preview, sourceInfo.page, event.data),
          sourceLabel: sourceInfo.sourceLabel,
          clear: () => iframeRef.current?.contentWindow?.postMessage({ type: "pdf-clear-selection" }, "*"),
        });
        return;
      }
      if (event.data?.type === "pdf-loaded" && typeof event.data.pageCount === "number") {
        const nextPageCount = Math.max(0, Math.floor(event.data.pageCount));
        setPageCount(nextPageCount);
        if (!restoredViewRef.current) {
          restoredViewRef.current = true;
          const savedIndex = Math.min(savedSlideIndexRef.current, Math.max(0, nextPageCount - 1));
          if (savedIndex > 0) {
            setSlideIndex(savedIndex);
            iframeRef.current?.contentWindow?.postMessage({ type: "pdf-page", page: savedIndex + 1 }, "*");
          } else if (typeof event.data.page === "number") {
            const nextPage = Math.max(1, Math.floor(event.data.page));
            setSlideIndex(Math.min(Math.max(nextPage - 1, 0), Math.max(0, nextPageCount - 1)));
          }
        }
        postPdfPreviewTheme(iframeRef.current);
        postPdfHighlight(iframeRef.current, target);
      }
      if (event.data?.type === "pdf-page-changed" && typeof event.data.page === "number") {
        const nextIndex = Math.max(0, Math.floor(event.data.page) - 1);
        setSlideIndex(nextIndex);
        if (restoredViewRef.current) updatePreviewViewState(viewKey, { pptxSlideIndex: nextIndex });
      }
      if (event.data?.type === "pdf-zoom-changed" && typeof event.data.zoom === "number") {
        const nextFitMode = isPdfFitMode(event.data.fitMode) ? event.data.fitMode : "custom";
        setZoom(event.data.zoom);
        setFitMode(nextFitMode);
        updatePreviewViewState(viewKey, { pdfZoom: event.data.zoom, pdfFitMode: nextFitMode });
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onSelectionPrompt, preview, target, viewKey]);

  useEffect(() => {
    if (!targetKey) return;
    window.setTimeout(() => postPdfHighlight(iframeRef.current, target), 120);
  }, [target, targetKey]);

  function sendPdfZoom(direction: "in" | "out" | "reset" | "fit-page" | "fit-width") {
    iframeRef.current?.contentWindow?.postMessage({ type: "pdf-zoom", direction }, "*");
  }

  function selectSlide(nextIndex: number) {
    const maxIndex = Math.max(0, effectivePageCount - 1);
    const clamped = Math.min(Math.max(nextIndex, 0), maxIndex);
    setSlideIndex(clamped);
    updatePreviewViewState(viewKey, { pptxSlideIndex: clamped });
    iframeRef.current?.contentWindow?.postMessage({ type: "pdf-page", page: clamped + 1 }, "*");
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-card/85 px-3">
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <Presentation className="h-3.5 w-3.5 text-primary" />
          <span className="truncate">{effectivePageCount || "多"} 页演示文稿</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-x-auto py-1 brevyn-scrollbar">
          {effectivePageCount > 0 && (
            <>
              <DeckToolbarButton title="上一页" onClick={() => selectSlide(slideIndex - 1)}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </DeckToolbarButton>
              <span className="min-w-[58px] text-center font-mono text-[11px] text-muted-foreground">
                {slideIndex + 1}/{effectivePageCount}
              </span>
              <DeckToolbarButton title="下一页" onClick={() => selectSlide(slideIndex + 1)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </DeckToolbarButton>
              <span className="mx-1 h-4 w-px bg-border" />
            </>
          )}
          <DeckToolbarButton title="缩小" onClick={() => sendPdfZoom("out")}>
            <Minus className="h-3.5 w-3.5" />
          </DeckToolbarButton>
          <span className="min-w-[46px] text-center font-mono text-[11px] text-muted-foreground">{zoom}%</span>
          <DeckToolbarButton title="放大" onClick={() => sendPdfZoom("in")}>
            <Plus className="h-3.5 w-3.5" />
          </DeckToolbarButton>
          <DeckToolbarTextButton title="适应窗口" active={fitMode === "page"} onClick={() => sendPdfZoom("fit-page")}>
            <Maximize2 className="h-3.5 w-3.5" />
            <span>整页</span>
          </DeckToolbarTextButton>
          <DeckToolbarTextButton title="适应宽度" active={fitMode === "width"} onClick={() => sendPdfZoom("fit-width")}>
            <MoveHorizontal className="h-3.5 w-3.5" />
            <span>宽度</span>
          </DeckToolbarTextButton>
          <DeckToolbarButton title="重置缩放" onClick={() => sendPdfZoom("reset")}>
            <RotateCcw className="h-3.5 w-3.5" />
          </DeckToolbarButton>
        </div>
      </div>
      <div className="relative h-full min-h-0 flex-1 bg-muted/25">
        <iframe
          ref={iframeRef}
          className={`h-full w-full border-0 bg-muted/25 ${ready ? "opacity-100" : "opacity-0"}`}
          src={src}
          title={preview.title}
          onLoad={() => postPdfPreviewTheme(iframeRef.current)}
        />
        {!ready && <PreviewFrameLoadingOverlay label="正在绘制演示文稿" />}
      </div>
    </div>
  );
}

function DocxPdfPreviewFrame({
  preview,
  viewKey,
  target,
  onSelectionPrompt,
}: {
  preview: FilePreview;
  viewKey: string;
  target?: FilePreviewLocationTarget | null;
  onSelectionPrompt: (state: SelectionPromptState | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const restoredViewRef = useRef(false);
  const [zoom, setZoom] = useState(() => readPreviewViewState(viewKey)?.pdfZoom || 100);
  const [fitMode, setFitMode] = useState<"custom" | "page" | "width">("page");
  const [ready, setReady] = useState(false);
  const src = preview.previewUrl || "";
  const targetKey = previewTargetKey(target);

  usePdfFitOnResize(containerRef, iframeRef, fitMode, ready);

  useEffect(() => {
    const saved = readPreviewViewState(viewKey);
    setZoom(saved?.pdfZoom || 100);
    setFitMode(isPdfFitMode(saved?.pdfFitMode) ? saved.pdfFitMode : "page");
    setReady(false);
    restoredViewRef.current = false;
  }, [src, viewKey]);

  useEffect(() => {
    const root = document.documentElement;
    const sendTheme = () => postPdfPreviewTheme(iframeRef.current);
    sendTheme();
    const observer = new MutationObserver(sendTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [src]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === "pdf-rendered" || event.data?.type === "pdf-error") {
        setReady(true);
        return;
      }
      if (event.data?.type === "pdf-selection-cleared") {
        onSelectionPrompt(null);
        return;
      }
      if (event.data?.type === "pdf-selection" && typeof event.data.text === "string" && event.data.rect) {
        const text = event.data.text.replace(/\u00a0/g, " ").trim();
        if (!text) {
          onSelectionPrompt(null);
          return;
        }
        const frameRect = iframeRef.current?.getBoundingClientRect();
        if (!frameRect) return;
        const rangeRect = event.data.rect as { left?: number; top?: number; width?: number; height?: number };
        const selectedText = text.slice(0, MAX_QUOTED_SELECTION_CHARS);
        const truncated = text.length > MAX_QUOTED_SELECTION_CHARS;
        const left = frameRect.left + Number(rangeRect.left || 0);
        const top = frameRect.top + Number(rangeRect.top || 0);
        const width = Number(rangeRect.width || 0);
        const x = Math.min(Math.max(left + width / 2, 84), Math.max(84, window.innerWidth - 84));
        const y = Math.max(12, top - 44);
        const sourceInfo = pdfSelectionSource(event.data);
        onSelectionPrompt({
          text: selectedText,
          truncated,
          x,
          y,
          source: "preview-frame",
          page: sourceInfo.page,
          semanticUnitId: pdfSelectionSemanticUnitId(preview, sourceInfo.page, event.data),
          sourceLabel: sourceInfo.sourceLabel,
          clear: () => iframeRef.current?.contentWindow?.postMessage({ type: "pdf-clear-selection" }, "*"),
        });
        return;
      }
      if (event.data?.type === "pdf-loaded" && !restoredViewRef.current) {
        restoredViewRef.current = true;
        const saved = readPreviewViewState(viewKey);
        if (saved?.pdfFitMode === "width") {
          iframeRef.current?.contentWindow?.postMessage({ type: "pdf-zoom", direction: "fit-width" }, "*");
        } else if ((saved?.pdfFitMode === "custom" || !saved?.pdfFitMode) && saved?.pdfZoom) {
          iframeRef.current?.contentWindow?.postMessage({ type: "pdf-zoom", zoom: saved.pdfZoom }, "*");
        } else {
          iframeRef.current?.contentWindow?.postMessage({ type: "pdf-zoom", direction: "fit-page" }, "*");
        }
        if (saved?.pdfScrollTop) {
          iframeRef.current?.contentWindow?.postMessage({ type: "pdf-scroll", scrollTop: saved.pdfScrollTop }, "*");
        }
        postPdfPreviewTheme(iframeRef.current);
        postPdfHighlight(iframeRef.current, target);
        return;
      }
      if (event.data?.type === "pdf-zoom-changed" && typeof event.data.zoom === "number") {
        const nextFitMode = isPdfFitMode(event.data.fitMode) ? event.data.fitMode : "custom";
        setZoom(event.data.zoom);
        setFitMode(nextFitMode);
        updatePreviewViewState(viewKey, { pdfZoom: event.data.zoom, pdfFitMode: nextFitMode });
      }
      if (event.data?.type === "pdf-scroll-changed" && typeof event.data.scrollTop === "number") {
        updatePreviewViewState(viewKey, { pdfScrollTop: event.data.scrollTop });
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onSelectionPrompt, preview, target, viewKey]);

  useEffect(() => {
    if (!targetKey) return;
    window.setTimeout(() => postPdfHighlight(iframeRef.current, target), 120);
  }, [target, targetKey]);

  function sendPdfZoom(direction: "in" | "out" | "reset" | "fit-page" | "fit-width") {
    iframeRef.current?.contentWindow?.postMessage({ type: "pdf-zoom", direction }, "*");
  }

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-background text-foreground">
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-card/85 px-3">
        <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
          <Type className="h-3.5 w-3.5 text-blue-600" />
          <span className="truncate">Word 文档预览</span>
        </div>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-1 overflow-x-auto py-1 brevyn-scrollbar">
          <DeckToolbarButton title="缩小" onClick={() => sendPdfZoom("out")}>
            <Minus className="h-3.5 w-3.5" />
          </DeckToolbarButton>
          <span className="min-w-[46px] text-center font-mono text-[11px] text-muted-foreground">{zoom}%</span>
          <DeckToolbarButton title="放大" onClick={() => sendPdfZoom("in")}>
            <Plus className="h-3.5 w-3.5" />
          </DeckToolbarButton>
          <DeckToolbarTextButton title="适应窗口" active={fitMode === "page"} onClick={() => sendPdfZoom("fit-page")}>
            <Maximize2 className="h-3.5 w-3.5" />
            <span>整页</span>
          </DeckToolbarTextButton>
          <DeckToolbarTextButton title="适应宽度" active={fitMode === "width"} onClick={() => sendPdfZoom("fit-width")}>
            <MoveHorizontal className="h-3.5 w-3.5" />
            <span>宽度</span>
          </DeckToolbarTextButton>
          <DeckToolbarButton title="重置缩放" onClick={() => sendPdfZoom("reset")}>
            <RotateCcw className="h-3.5 w-3.5" />
          </DeckToolbarButton>
        </div>
      </div>
      <div className="relative h-full min-h-0 flex-1 bg-muted/25">
        <iframe
          ref={iframeRef}
          className={`h-full w-full border-0 bg-muted/25 ${ready ? "opacity-100" : "opacity-0"}`}
          src={src}
          title={preview.title}
          onLoad={() => postPdfPreviewTheme(iframeRef.current)}
        />
        {!ready && <PreviewFrameLoadingOverlay label="正在绘制 Word 文档" />}
      </div>
    </div>
  );
}

function DeckToolbarButton({ title, onClick, children, active = false }: { title: string; onClick: () => void; children: ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

function DeckToolbarTextButton({ title, active, onClick, children }: { title: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className={`flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg px-2 text-[11px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 ${active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"}`}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

function isPdfFitMode(value: unknown): value is "custom" | "page" | "width" {
  return value === "custom" || value === "page" || value === "width";
}

function usePdfFitOnResize(
  containerRef: RefObject<HTMLElement | null>,
  iframeRef: RefObject<HTMLIFrameElement | null>,
  fitMode: "custom" | "page" | "width",
  ready: boolean,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ready || fitMode === "custom") return;
    let timeout = 0;
    const refit = () => {
      if (timeout) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        iframeRef.current?.contentWindow?.postMessage({
          type: "pdf-zoom",
          direction: fitMode === "page" ? "fit-page" : "fit-width",
        }, "*");
        timeout = 0;
      }, 120);
    };
    const observer = new ResizeObserver(refit);
    observer.observe(container);
    return () => {
      observer.disconnect();
      if (timeout) window.clearTimeout(timeout);
    };
  }, [containerRef, fitMode, iframeRef, ready]);
}

function normalizeSpreadsheetSelection(selection: SpreadsheetSelection): SpreadsheetSelection {
  return {
    sheetIndex: selection.sheetIndex,
    startRow: Math.max(1, Math.min(selection.startRow, selection.endRow)),
    endRow: Math.max(1, Math.max(selection.startRow, selection.endRow)),
    startColumn: Math.max(1, Math.min(selection.startColumn, selection.endColumn)),
    endColumn: Math.max(1, Math.max(selection.startColumn, selection.endColumn)),
  };
}

function spreadsheetSelectionText(sheet: SpreadsheetPreviewSheet, selection: SpreadsheetSelection): string {
  const rows: string[] = [];
  const selectedRows = sheet.rows.filter((row) => row.number >= selection.startRow && row.number <= selection.endRow);
  if (selectedRows.length === 0) return "";
  const columnHeaders = Array.from(
    { length: selection.endColumn - selection.startColumn + 1 },
    (_value, index) => spreadsheetColumnName(selection.startColumn + index - 1),
  );
  rows.push(["", ...columnHeaders].join("\t"));
  selectedRows.forEach((row) => {
    const cells = Array.from(
      { length: selection.endColumn - selection.startColumn + 1 },
      (_value, index) => row.cells[selection.startColumn + index - 1] || "",
    );
    rows.push([String(row.number), ...cells].join("\t"));
  });
  return `工作表：${sheet.name}\n${rows.join("\n")}`;
}

function spreadsheetSelectionRect(root: HTMLElement | null, selection: SpreadsheetSelection): DOMRect | null {
  if (!root) return null;
  const first = root.querySelector<HTMLElement>(`[data-spreadsheet-cell="${selection.startRow}:${selection.startColumn}"]`);
  const last = root.querySelector<HTMLElement>(`[data-spreadsheet-cell="${selection.endRow}:${selection.endColumn}"]`);
  if (!first || !last) return null;
  const firstRect = first.getBoundingClientRect();
  const lastRect = last.getBoundingClientRect();
  const left = Math.min(firstRect.left, lastRect.left);
  const top = Math.min(firstRect.top, lastRect.top);
  const right = Math.max(firstRect.right, lastRect.right);
  const bottom = Math.max(firstRect.bottom, lastRect.bottom);
  return new DOMRect(left, top, right - left, bottom - top);
}

function spreadsheetCellFromPoint(clientX: number, clientY: number): { row: number; column: number } | null {
  const target = document.elementFromPoint(clientX, clientY);
  if (!(target instanceof HTMLElement)) return null;
  const cell = target.closest<HTMLElement>("[data-spreadsheet-cell]");
  const raw = cell?.dataset.spreadsheetCell;
  if (!raw) return null;
  const [rowRaw, columnRaw] = raw.split(":");
  const row = Number(rowRaw);
  const column = Number(columnRaw);
  if (!Number.isInteger(row) || !Number.isInteger(column)) return null;
  return { row, column };
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

function ParsedPreviewMissingCard({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="flex min-h-[18rem] items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-dashed border-border/80 bg-background/70 px-5 py-6 text-center shadow-sm">
        <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border bg-card/85 text-primary shadow-sm">
          <FileText className="h-5 w-5" />
        </div>
        <p className="mt-3 text-sm font-semibold text-foreground">还没有解析文本</p>
        <p className="mt-1 text-[12px] leading-5 text-muted-foreground">{friendlyParsedPreviewMessage(message)}</p>
        <button
          type="button"
          className="mt-4 inline-flex h-8 items-center justify-center rounded-lg border bg-card px-3 text-[12px] font-medium text-foreground shadow-sm transition hover:bg-accent"
          onClick={onBack}
        >
          返回原文预览
        </button>
      </div>
    </div>
  );
}

function SpreadsheetPreviewFrame({
  preview,
  viewKey,
  onSelectionPrompt,
}: {
  preview: FilePreview;
  viewKey: string;
  onSelectionPrompt: (state: SelectionPromptState | null) => void;
}) {
  const workbook = preview.spreadsheet;
  const saved = readPreviewViewState(viewKey);
  const initialSheetIndex = Math.min(Math.max(saved?.spreadsheetSheetIndex || 0, 0), Math.max(0, (workbook?.sheets.length || 1) - 1));
  const [sheetIndex, setSheetIndex] = useState(initialSheetIndex);
  const [search, setSearch] = useState(saved?.spreadsheetSearch || "");
  const [selection, setSelection] = useState<SpreadsheetSelection | null>(() => saved?.spreadsheetSelection || null);
  const dragAnchorRef = useRef<{ row: number; column: number } | null>(null);
  const selectionRef = useRef<SpreadsheetSelection | null>(saved?.spreadsheetSelection || null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const sheets = workbook?.sheets || [];
  const sheet = sheets[sheetIndex] || sheets[0];
  const sheetSurface = (sheet?.render?.kind === "html" || sheet?.render?.kind === "svg") && sheet.render.data ? sheet.render : undefined;
  const normalizedSearch = search.trim().toLowerCase();
  const columnCount = Math.max(sheet?.renderedColumns || 0, ...((sheet?.rows || []).map((row) => row.cells.length)), 1);
  const visibleColumnCount = Math.min(columnCount, workbook?.maxColumns || 40);

  useEffect(() => {
    const nextSheetIndex = Math.min(Math.max(readPreviewViewState(viewKey)?.spreadsheetSheetIndex || 0, 0), Math.max(0, sheets.length - 1));
    setSheetIndex(nextSheetIndex);
    setSearch(readPreviewViewState(viewKey)?.spreadsheetSearch || "");
    const savedSelection = readPreviewViewState(viewKey)?.spreadsheetSelection || null;
    setSelection(savedSelection);
    selectionRef.current = savedSelection;
    if (gridRef.current) {
      gridRef.current.scrollLeft = 0;
      gridRef.current.scrollTop = 0;
    }
    onSelectionPrompt(null);
  }, [preview.id, preview.spreadsheet, sheets.length, viewKey, onSelectionPrompt]);

  function selectSheet(nextIndex: number) {
    const clamped = Math.min(Math.max(nextIndex, 0), Math.max(0, sheets.length - 1));
    setSheetIndex(clamped);
    setSelection(null);
    selectionRef.current = null;
    onSelectionPrompt(null);
    if (gridRef.current) {
      gridRef.current.scrollLeft = 0;
      gridRef.current.scrollTop = 0;
    }
    updatePreviewViewState(viewKey, { spreadsheetSheetIndex: clamped, spreadsheetSelection: undefined });
  }

  function updateSearch(value: string) {
    setSearch(value);
    updatePreviewViewState(viewKey, { spreadsheetSearch: value });
  }

  function beginCellSelection(rowNumber: number, columnNumber: number, event: ReactPointerEvent<HTMLElement>) {
    event.preventDefault();
    dragAnchorRef.current = { row: rowNumber, column: columnNumber };
    const nextSelection = normalizeSpreadsheetSelection({
      sheetIndex,
      startRow: rowNumber,
      startColumn: columnNumber,
      endRow: rowNumber,
      endColumn: columnNumber,
    });
    setSelection(nextSelection);
    selectionRef.current = nextSelection;
    updatePreviewViewState(viewKey, { spreadsheetSelection: nextSelection });
    onSelectionPrompt(null);
    gridRef.current?.setPointerCapture(event.pointerId);
  }

  function extendCellSelection(rowNumber: number, columnNumber: number) {
    const anchor = dragAnchorRef.current;
    if (!anchor) return;
    const nextSelection = normalizeSpreadsheetSelection({
      sheetIndex,
      startRow: anchor.row,
      startColumn: anchor.column,
      endRow: rowNumber,
      endColumn: columnNumber,
    });
    setSelection(nextSelection);
    selectionRef.current = nextSelection;
    updatePreviewViewState(viewKey, { spreadsheetSelection: nextSelection });
  }

  function extendCellSelectionFromPoint(clientX: number, clientY: number) {
    const cell = spreadsheetCellFromPoint(clientX, clientY);
    if (!cell) return;
    extendCellSelection(cell.row, cell.column);
  }

  function finishCellSelection(event?: ReactPointerEvent<HTMLElement>) {
    const nextSelection = selectionRef.current;
    dragAnchorRef.current = null;
    if (event) {
      try {
        gridRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released.
      }
    }
    if (!sheet || !nextSelection || nextSelection.sheetIndex !== sheetIndex) return;
    const text = spreadsheetSelectionText(sheet, nextSelection);
    if (!text.trim()) {
      onSelectionPrompt(null);
      return;
    }
    const rect = spreadsheetSelectionRect(gridRef.current, nextSelection);
    if (!rect) return;
    onSelectionPrompt({
      text: text.slice(0, MAX_QUOTED_SELECTION_CHARS),
      truncated: text.length > MAX_QUOTED_SELECTION_CHARS,
      x: Math.min(Math.max(rect.left + rect.width / 2, 84), Math.max(84, window.innerWidth - 84)),
      y: Math.max(12, rect.top - 44),
      source: "page",
      clear: () => {
        setSelection(null);
        selectionRef.current = null;
        updatePreviewViewState(viewKey, { spreadsheetSelection: undefined });
      },
    });
  }

  if (!workbook || !sheet) {
    return (
      <div className="rounded-lg border bg-background px-3 py-3">
        <pre className="whitespace-pre-wrap text-[12px] leading-6 text-foreground">{preview.content || "这个表格没有可预览的数据。"}</pre>
      </div>
    );
  }

  return (
    <div className="flex h-[70vh] min-h-0 flex-col overflow-hidden rounded-lg border bg-background shadow-sm">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b bg-card/80 px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto brevyn-scrollbar">
          {sheets.map((item, index) => (
            <button
              key={`${item.index}-${item.name}`}
              type="button"
              className={`h-7 max-w-[12rem] shrink-0 rounded-md px-2 text-[11px] font-medium transition ${index === sheetIndex ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"}`}
              onClick={() => selectSheet(index)}
              title={item.name}
            >
              <span className="block truncate">{item.name}</span>
            </button>
          ))}
        </div>
        <div className="flex h-7 w-44 shrink-0 items-center gap-1.5 rounded-md border bg-background/78 px-2 text-muted-foreground">
          <Search className="h-3.5 w-3.5" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
            value={search}
            onChange={(event) => updateSearch(event.target.value)}
            placeholder="搜索单元格"
          />
        </div>
      </div>
      <div className="flex h-8 shrink-0 items-center justify-between gap-2 border-b bg-muted/30 px-3 text-[11px] text-muted-foreground">
        <div className="min-w-0 truncate">
          结构化工作簿视图 · {workbook.renderedSheetCount}/{workbook.sheetCount} 个工作表 · {sheet.renderedRows}/{sheet.totalRows} 行 · {sheet.renderedColumns}/{sheet.totalColumns} 列
        </div>
        {workbook.truncated && <div className="shrink-0 text-amber-700 dark:text-amber-300">已截断部分内容</div>}
      </div>
      <div
        ref={gridRef}
        className="min-h-0 flex-1 overflow-auto bg-[hsl(var(--muted)/0.18)] brevyn-scrollbar"
        onPointerMove={(event) => {
          if (!dragAnchorRef.current) return;
          extendCellSelectionFromPoint(event.clientX, event.clientY);
        }}
        onPointerUp={finishCellSelection}
        onPointerCancel={finishCellSelection}
      >
        {sheetSurface ? (
          <SpreadsheetSheetSurface
            sheet={sheet}
            sheetIndex={sheetIndex}
            selection={selection}
            normalizedSearch={normalizedSearch}
            onPointerDownCell={beginCellSelection}
          />
        ) : (
          <>
            <table className="min-w-full border-separate border-spacing-0 bg-background text-[12px]">
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-30 h-8 w-12 border-b border-r bg-card text-[10px] font-medium text-muted-foreground" />
            {Array.from({ length: visibleColumnCount }, (_value, columnIndex) => (
                    <th
                      key={columnIndex}
                      className="sticky top-0 z-20 h-8 min-w-[7.5rem] border-b border-r bg-card px-2 text-center font-mono text-[10px] font-semibold text-muted-foreground"
                    >
                      {spreadsheetColumnName(columnIndex)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.rows.map((row, rowIndex) => (
                  <tr key={row.number}>
                    <th className="sticky left-0 z-10 h-8 border-b border-r bg-card px-2 text-right font-mono text-[10px] font-medium text-muted-foreground">
                      {row.number}
                    </th>
                  {Array.from({ length: visibleColumnCount }, (_value, columnIndex) => {
                      const columnNumber = columnIndex + 1;
                      const value = row.cells[columnIndex] || "";
                      const selected = Boolean(selection && selection.sheetIndex === sheetIndex && row.number >= selection.startRow && row.number <= selection.endRow && columnNumber >= selection.startColumn && columnNumber <= selection.endColumn);
                      const matched = Boolean(normalizedSearch && value.toLowerCase().includes(normalizedSearch));
                      return (
                        <td
                          key={columnIndex}
                          data-spreadsheet-cell={`${row.number}:${columnNumber}`}
                          className={`h-8 max-w-[18rem] select-none border-b border-r px-2 align-middle text-foreground transition ${selected ? "bg-primary/16 outline outline-1 -outline-offset-1 outline-primary/65" : matched ? "bg-amber-100/70 text-amber-950 dark:bg-amber-400/20 dark:text-amber-100" : "bg-background hover:bg-muted/50"}`}
                          onPointerDown={(event) => beginCellSelection(row.number, columnNumber, event)}
                          title={value}
                        >
                          <span className="block truncate">{value}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {sheet.rows.length === 0 && (
              <div className="flex h-full min-h-[16rem] items-center justify-center text-[12px] text-muted-foreground">
                这个工作表没有可预览的数据
              </div>
            )}
          </>
        )}
        {!sheetSurface && sheet.charts && sheet.charts.length > 0 && (
          <div className="border-t bg-background px-3 py-3">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
              <BarChart3 className="h-3.5 w-3.5 text-primary" />
              <span>图表 · {sheet.charts.length}</span>
            </div>
            <div className="grid gap-3 xl:grid-cols-2">
              {sheet.charts.map((chart) => (
                <SpreadsheetChartCard key={chart.id} chart={chart} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SpreadsheetChartCard({ chart }: { chart: SpreadsheetPreviewChart }) {
  const renderable = chart.series.some((series) => series.values.length > 0);
  const htmlMarkup = chart.render?.kind === "html" && chart.render.data ? chart.render.data : "";
  return (
    <div className="overflow-hidden rounded-lg border bg-card/65 shadow-sm">
      <div className="flex min-h-10 items-center justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-[12px] font-semibold text-foreground">{chart.title || chart.name}</div>
          <div className="mt-0.5 truncate text-[10px] text-muted-foreground">
            {spreadsheetChartTypeLabel(chart)}{chart.sourceRefs.length > 0 ? ` · ${chart.sourceRefs.join(", ")}` : ""}
          </div>
        </div>
        <span className="shrink-0 rounded-full border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
          {chart.series.length} 组
        </span>
      </div>
      <div className="h-56 bg-background p-3">
        {htmlMarkup ? (
          <div
            className="h-full w-full"
            dangerouslySetInnerHTML={{ __html: htmlMarkup }}
          />
        ) : renderable ? <SpreadsheetChartSvg chart={chart} /> : (
          <div className="flex h-full items-center justify-center rounded-md border border-dashed text-[12px] text-muted-foreground">
            暂无可渲染的图表缓存数据
          </div>
        )}
      </div>
    </div>
  );
}

function SpreadsheetSheetSurface({
  sheet,
  sheetIndex,
  selection,
  normalizedSearch,
  onPointerDownCell,
}: {
  sheet: SpreadsheetPreviewSheet;
  sheetIndex: number;
  selection: SpreadsheetSelection | null;
  normalizedSearch: string;
  onPointerDownCell: (rowIndex: number, columnIndex: number, event: ReactPointerEvent<HTMLElement>) => void;
}) {
  const surface = sheet.render;
  const markup = (surface?.kind === "html" || surface?.kind === "svg") && surface.data ? surface.data : "";
  if (!surface || !markup) return null;
  const scaleStyle = {
    width: `${surface.width}px`,
    height: `${surface.height}px`,
    ["--brevyn-sheet-bg" as string]: "hsl(var(--background))",
    ["--brevyn-sheet-cell-bg" as string]: "hsl(var(--background))",
    ["--brevyn-sheet-formula-bg" as string]: "hsl(var(--primary) / 0.08)",
    ["--brevyn-sheet-header-bg" as string]: "hsl(var(--card))",
    ["--brevyn-sheet-fg" as string]: "hsl(var(--foreground))",
    ["--brevyn-sheet-muted" as string]: "hsl(var(--muted-foreground))",
    ["--brevyn-sheet-border" as string]: "hsl(var(--border))",
    ["--brevyn-sheet-freeze" as string]: "hsl(var(--muted-foreground) / 0.55)",
    ["--brevyn-chart-bg" as string]: "hsl(var(--background))",
    ["--brevyn-chart-fg" as string]: "hsl(var(--foreground))",
    ["--brevyn-chart-muted" as string]: "hsl(var(--muted-foreground))",
    ["--brevyn-chart-border" as string]: "hsl(var(--border))",
  };

  return (
    <div className="relative min-w-max bg-background" style={scaleStyle}>
      <SpreadsheetSurfaceStyles />
      <div className="pointer-events-none absolute inset-0" dangerouslySetInnerHTML={{ __html: markup }} />
      <div className="absolute inset-0">
        {(surface.targets || []).filter((target) => target.type === "cell").map((target) => {
          const rowNumber = Number(target.metadata?.rowNumber ?? target.location.row ?? -1);
          const columnNumber = Number(target.metadata?.columnNumber ?? target.location.column ?? -1);
          if (!Number.isInteger(rowNumber) || !Number.isInteger(columnNumber) || rowNumber <= 0 || columnNumber <= 0) return null;
          const selected = Boolean(selection && selection.sheetIndex === sheetIndex && rowNumber >= selection.startRow && rowNumber <= selection.endRow && columnNumber >= selection.startColumn && columnNumber <= selection.endColumn);
          const matched = Boolean(normalizedSearch && (target.text || "").toLowerCase().includes(normalizedSearch));
          return (
            <button
              key={target.id}
              type="button"
              data-spreadsheet-cell={`${rowNumber}:${columnNumber}`}
              className={`absolute select-none border-0 bg-transparent p-0 text-left outline-none transition ${selected ? "ring-2 ring-primary/75 ring-inset bg-primary/12" : matched ? "bg-amber-300/28 ring-1 ring-amber-400/70 ring-inset" : "hover:bg-primary/8"}`}
              style={{
                left: `${target.bbox.x}px`,
                top: `${target.bbox.y}px`,
                width: `${target.bbox.width}px`,
                height: `${target.bbox.height}px`,
              }}
              title={target.text || target.location.range || ""}
              onPointerDown={(event) => onPointerDownCell(rowNumber, columnNumber, event)}
            />
          );
        })}
      </div>
      {sheet.rows.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">
          这个工作表没有可预览的数据
        </div>
      )}
    </div>
  );
}

function SpreadsheetSurfaceStyles() {
  return (
    <style>{`
      .brevyn-sheet-surface {
        position: relative;
        overflow: hidden;
        background: var(--brevyn-sheet-bg, #fff);
        color: var(--brevyn-sheet-fg, #111827);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
      }
      .brevyn-sheet-corner,
      .brevyn-sheet-col-header,
      .brevyn-sheet-row-header,
      .brevyn-sheet-cell,
      .brevyn-sheet-floating,
      .brevyn-sheet-freeze-line {
        position: absolute;
        box-sizing: border-box;
      }
      .brevyn-sheet-corner,
      .brevyn-sheet-col-header,
      .brevyn-sheet-row-header {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--brevyn-sheet-header-bg, #f8fafc);
        border: 0 solid var(--brevyn-sheet-border, #e5e7eb);
        color: var(--brevyn-sheet-muted, #64748b);
        font-size: 11px;
        font-weight: 650;
        user-select: none;
      }
      .brevyn-sheet-corner {
        border-right-width: 1px;
        border-bottom-width: 1px;
      }
      .brevyn-sheet-col-header {
        border-right-width: 1px;
        border-bottom-width: 1px;
      }
      .brevyn-sheet-row-header {
        justify-content: flex-end;
        padding-right: 10px;
        border-right-width: 1px;
        border-bottom-width: 1px;
        font-variant-numeric: tabular-nums;
      }
      .brevyn-sheet-cell {
        display: flex;
        min-width: 0;
        overflow: hidden;
        border: 1px solid var(--brevyn-sheet-border, #e5e7eb);
        padding: 0 8px;
        line-height: 1.24;
        white-space: nowrap;
        user-select: none;
      }
      .brevyn-sheet-cell > span {
        display: block;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .brevyn-sheet-cell-wrap {
        align-content: center;
        white-space: normal;
      }
      .brevyn-sheet-cell-wrap > span {
        display: -webkit-box;
        -webkit-line-clamp: 3;
        -webkit-box-orient: vertical;
        white-space: normal;
      }
      .brevyn-sheet-freeze-line {
        z-index: 2;
        background: var(--brevyn-sheet-freeze, #94a3b8);
        pointer-events: none;
      }
      .brevyn-sheet-floating {
        z-index: 1;
        overflow: hidden;
        border: 1px solid var(--brevyn-sheet-border, #e5e7eb);
        border-radius: 8px;
        background: var(--brevyn-sheet-bg, #fff);
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
      }
      .brevyn-sheet-image {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 4px;
      }
      .brevyn-sheet-image img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
      .brevyn-chart {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
        min-width: 0;
        min-height: 0;
        background: var(--brevyn-chart-bg, #fff);
        color: var(--brevyn-chart-fg, #111827);
        padding: 14px 16px 12px;
        box-sizing: border-box;
      }
      .brevyn-chart-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 13px;
        font-weight: 700;
      }
      .brevyn-chart-subtitle {
        margin-top: 2px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--brevyn-chart-muted, #6b7280);
        font-size: 10px;
      }
      .brevyn-chart-plot {
        position: relative;
        flex: 1;
        min-height: 0;
        margin-top: 10px;
      }
      .brevyn-chart-plot-bars {
        display: flex;
        align-items: flex-end;
        gap: 8px;
        padding: 8px 8px 0;
        border-left: 1px solid var(--brevyn-chart-border, #e5e7eb);
        border-bottom: 1px solid var(--brevyn-chart-border, #e5e7eb);
      }
      .brevyn-chart-bar-group {
        display: flex;
        flex: 1;
        align-items: flex-end;
        justify-content: center;
        gap: 2px;
        height: 100%;
        min-width: 12px;
      }
      .brevyn-chart-bar {
        width: min(18px, 42%);
        border-radius: 4px 4px 0 0;
      }
      .brevyn-chart-axis {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: 1fr;
        gap: 8px;
        margin: 4px 8px 0 24px;
        color: var(--brevyn-chart-muted, #6b7280);
        font-size: 9px;
      }
      .brevyn-chart-axis-label {
        overflow: hidden;
        text-align: center;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .brevyn-chart-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 6px 12px;
        margin-top: 8px;
        color: var(--brevyn-chart-muted, #6b7280);
        font-size: 10px;
      }
      .brevyn-chart-legend span {
        display: inline-flex;
        align-items: center;
        min-width: 0;
        gap: 5px;
      }
      .brevyn-chart-legend i {
        display: inline-block;
        width: 9px;
        height: 9px;
        border-radius: 2px;
        flex: none;
      }
      .brevyn-chart-plot-hbars {
        display: grid;
        grid-template-columns: minmax(72px, 0.3fr) 1fr;
        align-content: center;
        gap: 8px;
      }
      .brevyn-chart-hbar-label {
        overflow: hidden;
        color: var(--brevyn-chart-muted, #6b7280);
        font-size: 10px;
        text-align: right;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .brevyn-chart-hbar-track {
        overflow: hidden;
        height: 10px;
        align-self: center;
        border-radius: 999px;
        background: var(--brevyn-chart-border, #e5e7eb);
      }
      .brevyn-chart-hbar-fill {
        height: 100%;
        border-radius: inherit;
      }
      .brevyn-chart-plot-line {
        border-left: 1px solid var(--brevyn-chart-border, #e5e7eb);
        border-bottom: 1px solid var(--brevyn-chart-border, #e5e7eb);
        margin-left: 10px;
      }
      .brevyn-chart-line-layer,
      .brevyn-chart-point {
        position: absolute;
      }
      .brevyn-chart-point {
        width: 8px;
        height: 8px;
        transform: translate(-50%, -50%);
        border-radius: 999px;
        box-shadow: 0 0 0 2px var(--brevyn-chart-bg, #fff);
      }
      .brevyn-chart-plot-pie {
        display: grid;
        grid-template-columns: minmax(82px, 0.42fr) 1fr;
        align-items: center;
        gap: 14px;
      }
      .brevyn-chart-pie {
        width: min(128px, 100%);
        aspect-ratio: 1;
        border-radius: 999px;
        box-shadow: inset 0 0 0 1px var(--brevyn-chart-border, #e5e7eb);
      }
      .brevyn-chart-doughnut::after {
        content: "";
        display: block;
        width: 44%;
        height: 44%;
        margin: 28%;
        border-radius: inherit;
        background: var(--brevyn-chart-bg, #fff);
      }
      .brevyn-chart-pie-legend {
        display: grid;
        gap: 5px;
        min-width: 0;
        color: var(--brevyn-chart-fg, #111827);
        font-size: 10px;
      }
      .brevyn-chart-pie-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .brevyn-chart-pie-label span {
        display: inline-block;
        width: 9px;
        height: 9px;
        margin-right: 6px;
        border-radius: 2px;
      }
      .brevyn-chart-empty {
        display: flex;
        flex: 1;
        align-items: center;
        justify-content: center;
        margin-top: 12px;
        border: 1px dashed var(--brevyn-chart-border, #d1d5db);
        border-radius: 10px;
        color: var(--brevyn-chart-muted, #6b7280);
        font-size: 12px;
      }
    `}</style>
  );
}

function SpreadsheetChartSvg({ chart }: { chart: SpreadsheetPreviewChart }) {
  if (chart.type === "pie" || chart.type === "doughnut") return <SpreadsheetPieChartSvg chart={chart} />;
  if (chart.type === "line" || chart.type === "scatter" || chart.type === "area") return <SpreadsheetLineChartSvg chart={chart} />;
  return <SpreadsheetBarChartSvg chart={chart} />;
}

function SpreadsheetBarChartSvg({ chart }: { chart: SpreadsheetPreviewChart }) {
  const width = 520;
  const height = 220;
  const margin = { top: 14, right: 18, bottom: 48, left: 44 };
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 4);
  const categories = mergedChartCategories(series);
  const maxValue = Math.max(...series.flatMap((item) => item.values), 1);
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const groupWidth = innerWidth / Math.max(categories.length, 1);
  const barWidth = Math.max(4, Math.min(22, (groupWidth - 8) / Math.max(series.length, 1)));
  const horizontal = chart.type === "bar" && chart.subtype === "bar";
  if (horizontal) return <SpreadsheetHorizontalBarChartSvg chart={chart} />;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full">
      <ChartGrid width={width} height={height} margin={margin} />
      {series.map((item, seriesIndex) => item.values.map((value, valueIndex) => {
        const barHeight = (value / maxValue) * innerHeight;
        const x = margin.left + valueIndex * groupWidth + (groupWidth - barWidth * series.length) / 2 + seriesIndex * barWidth;
        const y = margin.top + innerHeight - barHeight;
        return <rect key={`${item.name}-${valueIndex}`} x={x} y={y} width={barWidth - 1} height={barHeight} rx={3} fill={CHART_COLORS[seriesIndex % CHART_COLORS.length]} />;
      }))}
      {categories.slice(0, 8).map((label, index) => (
        <text key={index} x={margin.left + index * groupWidth + groupWidth / 2} y={height - 19} textAnchor="end" transform={`rotate(-32 ${margin.left + index * groupWidth + groupWidth / 2} ${height - 19})`} className="fill-muted-foreground text-[10px]">
          {truncateChartLabel(label, 10)}
        </text>
      ))}
      <ChartLegend series={series} x={margin.left} y={8} />
    </svg>
  );
}

function SpreadsheetHorizontalBarChartSvg({ chart }: { chart: SpreadsheetPreviewChart }) {
  const width = 520;
  const height = 220;
  const margin = { top: 20, right: 24, bottom: 20, left: 82 };
  const first = chart.series.find((item) => item.values.length > 0);
  const categories = first?.categories.length ? first.categories : first?.values.map((_value, index) => String(index + 1)) || [];
  const values = first?.values || [];
  const maxValue = Math.max(...values, 1);
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const rowHeight = innerHeight / Math.max(values.length, 1);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full">
      {values.slice(0, 12).map((value, index) => {
        const barWidth = (value / maxValue) * innerWidth;
        const y = margin.top + index * rowHeight + rowHeight * 0.2;
        return (
          <g key={index}>
            <text x={margin.left - 8} y={y + rowHeight * 0.45} textAnchor="end" className="fill-muted-foreground text-[10px]">{truncateChartLabel(categories[index] || String(index + 1), 12)}</text>
            <rect x={margin.left} y={y} width={barWidth} height={Math.max(5, rowHeight * 0.58)} rx={4} fill={CHART_COLORS[0]} />
          </g>
        );
      })}
    </svg>
  );
}

function SpreadsheetLineChartSvg({ chart }: { chart: SpreadsheetPreviewChart }) {
  const width = 520;
  const height = 220;
  const margin = { top: 16, right: 20, bottom: 42, left: 44 };
  const series = chart.series.filter((item) => item.values.length > 0).slice(0, 5);
  const maxValue = Math.max(...series.flatMap((item) => item.values), 1);
  const minValue = Math.min(...series.flatMap((item) => item.values), 0);
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const span = Math.max(1, maxValue - minValue);
  const xFor = (index: number, count: number) => margin.left + (count <= 1 ? innerWidth / 2 : (index / (count - 1)) * innerWidth);
  const yFor = (value: number) => margin.top + innerHeight - ((value - minValue) / span) * innerHeight;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full">
      <ChartGrid width={width} height={height} margin={margin} />
      {series.map((item, seriesIndex) => {
        const points = item.values.map((value, index) => `${xFor(index, item.values.length)},${yFor(value)}`).join(" ");
        return (
          <g key={item.name || seriesIndex}>
            {chart.type === "area" && <polygon points={`${margin.left},${margin.top + innerHeight} ${points} ${xFor(item.values.length - 1, item.values.length)},${margin.top + innerHeight}`} fill={CHART_COLORS[seriesIndex % CHART_COLORS.length]} opacity="0.16" />}
            <polyline points={points} fill="none" stroke={CHART_COLORS[seriesIndex % CHART_COLORS.length]} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            {item.values.map((value, index) => <circle key={index} cx={xFor(index, item.values.length)} cy={yFor(value)} r={chart.type === "scatter" ? 3.5 : 2.6} fill={CHART_COLORS[seriesIndex % CHART_COLORS.length]} />)}
          </g>
        );
      })}
      <ChartLegend series={series} x={margin.left} y={8} />
    </svg>
  );
}

function SpreadsheetPieChartSvg({ chart }: { chart: SpreadsheetPreviewChart }) {
  const width = 520;
  const height = 220;
  const series = chart.series.find((item) => item.values.length > 0);
  const values = series?.values || [];
  const categories = series?.categories.length ? series.categories : values.map((_value, index) => String(index + 1));
  const total = values.reduce((sum, value) => sum + Math.max(0, value), 0) || 1;
  let angle = -90;
  const cx = 138;
  const cy = 110;
  const radius = 76;
  const innerRadius = chart.type === "doughnut" ? 38 : 0;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full">
      {values.slice(0, 10).map((value, index) => {
        const slice = (Math.max(0, value) / total) * 360;
        const path = donutSlicePath(cx, cy, radius, innerRadius, angle, angle + slice);
        angle += slice;
        return <path key={index} d={path} fill={CHART_COLORS[index % CHART_COLORS.length]} stroke="white" strokeWidth="1.5" />;
      })}
      <g transform="translate(250 44)">
        {values.slice(0, 10).map((value, index) => (
          <g key={index} transform={`translate(0 ${index * 16})`}>
            <rect width="9" height="9" rx="2" fill={CHART_COLORS[index % CHART_COLORS.length]} />
            <text x="16" y="8" className="fill-foreground text-[10px]">{truncateChartLabel(categories[index] || String(index + 1), 24)} · {Math.round((value / total) * 100)}%</text>
          </g>
        ))}
      </g>
    </svg>
  );
}

function ChartGrid({ width, height, margin }: { width: number; height: number; margin: { top: number; right: number; bottom: number; left: number } }) {
  const innerHeight = height - margin.top - margin.bottom;
  const innerWidth = width - margin.left - margin.right;
  return (
    <g>
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
        <line key={ratio} x1={margin.left} x2={margin.left + innerWidth} y1={margin.top + innerHeight * ratio} y2={margin.top + innerHeight * ratio} stroke="currentColor" className="text-border" strokeWidth="1" />
      ))}
      <line x1={margin.left} x2={margin.left} y1={margin.top} y2={height - margin.bottom} stroke="currentColor" className="text-border" />
      <line x1={margin.left} x2={width - margin.right} y1={height - margin.bottom} y2={height - margin.bottom} stroke="currentColor" className="text-border" />
    </g>
  );
}

function ChartLegend({ series, x, y }: { series: SpreadsheetPreviewChartSeries[]; x: number; y: number }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      {series.slice(0, 4).map((item, index) => (
        <g key={item.name || index} transform={`translate(${index * 102} 0)`}>
          <rect width="8" height="8" rx="2" fill={CHART_COLORS[index % CHART_COLORS.length]} />
          <text x="13" y="8" className="fill-muted-foreground text-[10px]">{truncateChartLabel(item.name || `Series ${index + 1}`, 13)}</text>
        </g>
      ))}
    </g>
  );
}

const CHART_COLORS = ["#2563eb", "#16a34a", "#dc2626", "#9333ea", "#f59e0b", "#0891b2", "#be123c", "#4f46e5"];

function mergedChartCategories(series: SpreadsheetPreviewChartSeries[]): string[] {
  const longest = series.reduce((best, item) => item.categories.length > best.length ? item.categories : best, [] as string[]);
  if (longest.length > 0) return longest;
  const maxLength = Math.max(...series.map((item) => item.values.length), 0);
  return Array.from({ length: maxLength }, (_value, index) => String(index + 1));
}

function spreadsheetChartTypeLabel(chart: SpreadsheetPreviewChart): string {
  if (chart.type === "bar") return chart.subtype === "bar" ? "条形图" : "柱状图";
  if (chart.type === "line") return "折线图";
  if (chart.type === "pie") return "饼图";
  if (chart.type === "doughnut") return "环形图";
  if (chart.type === "scatter") return "散点图";
  if (chart.type === "area") return "面积图";
  if (chart.type === "radar") return "雷达图";
  return "图表";
}

function truncateChartLabel(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function donutSlicePath(cx: number, cy: number, outerRadius: number, innerRadius: number, startAngle: number, endAngle: number): string {
  const start = polarPoint(cx, cy, outerRadius, endAngle);
  const end = polarPoint(cx, cy, outerRadius, startAngle);
  const largeArc = endAngle - startAngle <= 180 ? "0" : "1";
  if (innerRadius <= 0) {
    return [`M ${cx} ${cy}`, `L ${start.x} ${start.y}`, `A ${outerRadius} ${outerRadius} 0 ${largeArc} 0 ${end.x} ${end.y}`, "Z"].join(" ");
  }
  const innerStart = polarPoint(cx, cy, innerRadius, startAngle);
  const innerEnd = polarPoint(cx, cy, innerRadius, endAngle);
  return [
    `M ${start.x} ${start.y}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 0 ${end.x} ${end.y}`,
    `L ${innerStart.x} ${innerStart.y}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 1 ${innerEnd.x} ${innerEnd.y}`,
    "Z",
  ].join(" ");
}

function polarPoint(cx: number, cy: number, radius: number, angleDegrees: number): { x: number; y: number } {
  const angle = ((angleDegrees - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(angle),
    y: cy + radius * Math.sin(angle),
  };
}

function PdfPreviewFrame({
  preview,
  viewKey,
  target,
  onSelectionPrompt,
}: {
  preview: FilePreview;
  viewKey: string;
  target?: FilePreviewLocationTarget | null;
  onSelectionPrompt: (state: SelectionPromptState | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const restoredViewRef = useRef(false);
  const [zoom, setZoom] = useState(() => readPreviewViewState(viewKey)?.pdfZoom || 100);
  const [fitMode, setFitMode] = useState<"custom" | "page" | "width">(() => {
    const saved = readPreviewViewState(viewKey)?.pdfFitMode;
    return isPdfFitMode(saved) ? saved : "width";
  });
  const [ready, setReady] = useState(false);
  const src = preview.previewUrl || preview.fileUrl || "";
  const targetKey = previewTargetKey(target);

  usePdfFitOnResize(containerRef, iframeRef, fitMode, ready);

  useEffect(() => {
    const saved = readPreviewViewState(viewKey);
    setZoom(saved?.pdfZoom || 100);
    setFitMode(isPdfFitMode(saved?.pdfFitMode) ? saved.pdfFitMode : "width");
    setReady(false);
    restoredViewRef.current = false;
  }, [src, viewKey]);

  useEffect(() => {
    const root = document.documentElement;
    const sendTheme = () => postPdfPreviewTheme(iframeRef.current);
    sendTheme();
    const observer = new MutationObserver(sendTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [src]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === "pdf-rendered" || event.data?.type === "pdf-error") {
        setReady(true);
        return;
      }
      if (event.data?.type === "pdf-selection-cleared") {
        onSelectionPrompt(null);
        return;
      }
      if (event.data?.type === "pdf-selection" && typeof event.data.text === "string" && event.data.rect) {
        const text = event.data.text.replace(/\u00a0/g, " ").trim();
        if (!text) {
          onSelectionPrompt(null);
          return;
        }
        const frameRect = iframeRef.current?.getBoundingClientRect();
        if (!frameRect) return;
        const rangeRect = event.data.rect as { left?: number; top?: number; width?: number; height?: number };
        const selectedText = text.slice(0, MAX_QUOTED_SELECTION_CHARS);
        const truncated = text.length > MAX_QUOTED_SELECTION_CHARS;
        const left = frameRect.left + Number(rangeRect.left || 0);
        const top = frameRect.top + Number(rangeRect.top || 0);
        const width = Number(rangeRect.width || 0);
        const x = Math.min(Math.max(left + width / 2, 84), Math.max(84, window.innerWidth - 84));
        const y = Math.max(12, top - 44);
        const sourceInfo = pdfSelectionSource(event.data);
        onSelectionPrompt({
          text: selectedText,
          truncated,
          x,
          y,
          source: "preview-frame",
          page: sourceInfo.page,
          semanticUnitId: pdfSelectionSemanticUnitId(preview, sourceInfo.page, event.data),
          sourceLabel: sourceInfo.sourceLabel,
          clear: () => iframeRef.current?.contentWindow?.postMessage({ type: "pdf-clear-selection" }, "*"),
        });
        return;
      }
      if (event.data?.type === "pdf-loaded" && !restoredViewRef.current) {
        restoredViewRef.current = true;
        const saved = readPreviewViewState(viewKey);
        if (saved?.pdfFitMode === "width") {
          iframeRef.current?.contentWindow?.postMessage({ type: "pdf-zoom", direction: "fit-width" }, "*");
        } else if ((saved?.pdfFitMode === "custom" || !saved?.pdfFitMode) && saved?.pdfZoom) {
          iframeRef.current?.contentWindow?.postMessage({ type: "pdf-zoom", zoom: saved.pdfZoom }, "*");
        }
        if (saved?.pdfScrollTop) {
          iframeRef.current?.contentWindow?.postMessage({ type: "pdf-scroll", scrollTop: saved.pdfScrollTop }, "*");
        }
        postPdfPreviewTheme(iframeRef.current);
        postPdfHighlight(iframeRef.current, target);
        return;
      }
      if (event.data?.type === "pdf-zoom-changed" && typeof event.data.zoom === "number") {
        setZoom(event.data.zoom);
        const nextFitMode = isPdfFitMode(event.data.fitMode) ? event.data.fitMode : "custom";
        setFitMode(nextFitMode);
        updatePreviewViewState(viewKey, { pdfZoom: event.data.zoom, pdfFitMode: nextFitMode });
      }
      if (event.data?.type === "pdf-scroll-changed" && typeof event.data.scrollTop === "number") {
        updatePreviewViewState(viewKey, { pdfScrollTop: event.data.scrollTop });
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onSelectionPrompt, preview, target, viewKey]);

  useEffect(() => {
    if (!targetKey) return;
    window.setTimeout(() => postPdfHighlight(iframeRef.current, target), 120);
  }, [target, targetKey]);

  function sendPdfZoom(direction: "in" | "out" | "reset" | "fit-width") {
    iframeRef.current?.contentWindow?.postMessage({ type: "pdf-zoom", direction }, "*");
  }

  return (
    <PreviewCanvasFrame
      toolbar={(
        <>
          <PreviewIconButton title="缩小" onClick={() => sendPdfZoom("out")}>
            <Minus className="h-3.5 w-3.5" />
          </PreviewIconButton>
          <span className="min-w-[42px] text-center font-mono text-[11px] text-muted-foreground">{zoom}%</span>
          <PreviewIconButton title="放大" onClick={() => sendPdfZoom("in")}>
            <Plus className="h-3.5 w-3.5" />
          </PreviewIconButton>
          <PreviewIconButton title="适应宽度" onClick={() => sendPdfZoom("fit-width")}>
            <MoveHorizontal className="h-3.5 w-3.5" />
          </PreviewIconButton>
          <PreviewIconButton title="重置缩放" onClick={() => sendPdfZoom("reset")}>
            <RotateCcw className="h-3.5 w-3.5" />
          </PreviewIconButton>
        </>
      )}
    >
      <div ref={containerRef} className="relative h-full w-full">
        <iframe
          ref={iframeRef}
          className={`h-full w-full border-0 bg-background ${ready ? "opacity-100" : "opacity-0"}`}
          src={src}
          title={preview.title}
          onLoad={() => postPdfPreviewTheme(iframeRef.current)}
        />
        {!ready && <PreviewFrameLoadingOverlay label="正在绘制 PDF" />}
      </div>
    </PreviewCanvasFrame>
  );
}

function postPdfPreviewTheme(frame: HTMLIFrameElement | null): void {
  const target = frame?.contentWindow;
  if (!target) return;
  const root = document.documentElement;
  const styles = window.getComputedStyle(root);
  const read = (name: string) => styles.getPropertyValue(name).trim();
  target.postMessage({
    type: "pdf-theme",
    theme: {
      mode: root.dataset.theme === "dark" ? "dark" : "light",
      background: read("--background"),
      foreground: read("--foreground"),
      card: read("--card"),
      muted: read("--muted"),
      mutedForeground: read("--muted-foreground"),
      border: read("--border"),
      primary: read("--primary"),
    },
  }, "*");
}

function ImagePreviewFrame({ preview, viewKey }: { preview: FilePreview; viewKey: string }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const imageSizeRef = useRef<{ width: number; height: number } | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const savedState = readPreviewViewState(viewKey);
  const [zoom, setZoom] = useState(() => clampImageZoom(savedState?.imageZoom || 1));
  const [offset, setOffset] = useState(() => ({
    x: savedState?.imageOffsetX || 0,
    y: savedState?.imageOffsetY || 0,
  }));
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const zoomLabel = `${Math.round(zoom * 100)}%`;

  useEffect(() => {
    const saved = readPreviewViewState(viewKey);
    setZoom(clampImageZoom(saved?.imageZoom || 1));
    setOffset({
      x: saved?.imageOffsetX || 0,
      y: saved?.imageOffsetY || 0,
    });
    setNaturalSize(null);
    imageSizeRef.current = null;
    dragRef.current = null;
    setDragging(false);
  }, [preview.fileUrl, viewKey]);

  function persist(nextZoom = zoom, nextOffset = offset) {
    updatePreviewViewState(viewKey, {
      imageZoom: nextZoom,
      imageOffsetX: nextOffset.x,
      imageOffsetY: nextOffset.y,
    });
  }

  const fitToViewport = useCallback(() => {
    const viewport = viewportRef.current;
    const imageSize = imageSizeRef.current;
    if (!viewport || !imageSize) return;
    const viewportWidth = Math.max(1, viewport.clientWidth - 32);
    const viewportHeight = Math.max(1, viewport.clientHeight - 32);
    const nextZoom = clampImageZoom(Math.min(1, viewportWidth / imageSize.width, viewportHeight / imageSize.height));
    const nextOffset = { x: 0, y: 0 };
    setZoom(nextZoom);
    setOffset(nextOffset);
    updatePreviewViewState(viewKey, {
      imageZoom: nextZoom,
      imageOffsetX: 0,
      imageOffsetY: 0,
    });
  }, [viewKey]);

  useEffect(() => {
    if (!naturalSize) return;
    if (readPreviewViewState(viewKey)?.imageZoom) {
      persist();
      return;
    }
    fitToViewport();
    // Run only after each image's natural size is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [naturalSize, fitToViewport, viewKey]);

  function setImageZoom(nextZoom: number, anchor?: { x: number; y: number }) {
    const viewport = viewportRef.current;
    const clamped = clampImageZoom(nextZoom);
    if (!viewport || !anchor || clamped === zoom) {
      setZoom(clamped);
      persist(clamped, offset);
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const anchorX = anchor.x - rect.left;
    const anchorY = anchor.y - rect.top;
    const ratio = clamped / zoom;
    const nextOffset = {
      x: anchorX - centerX - (anchorX - centerX - offset.x) * ratio,
      y: anchorY - centerY - (anchorY - centerY - offset.y) * ratio,
    };
    setZoom(clamped);
    setOffset(nextOffset);
    persist(clamped, nextOffset);
  }

  function nudgeZoom(direction: "in" | "out") {
    const step = direction === "in" ? 1.18 : 1 / 1.18;
    setImageZoom(zoom * step);
  }

  function resetView() {
    const nextZoom = 1;
    const nextOffset = { x: 0, y: 0 };
    setZoom(nextZoom);
    setOffset(nextOffset);
    persist(nextZoom, nextOffset);
  }

  function handleImageLoad(event: SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    const size = {
      width: image.naturalWidth || image.width || 1,
      height: image.naturalHeight || image.height || 1,
    };
    imageSizeRef.current = size;
    setNaturalSize(size);
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) {
      const delta = event.deltaY > 0 ? 1 / 1.12 : 1.12;
      setImageZoom(zoom * delta, { x: event.clientX, y: event.clientY });
      return;
    }
    const nextOffset = {
      x: offset.x - event.deltaX,
      y: offset.y - event.deltaY,
    };
    setOffset(nextOffset);
    persist(zoom, nextOffset);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const nextOffset = {
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    };
    setOffset(nextOffset);
    persist(zoom, nextOffset);
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      dragRef.current = null;
      setDragging(false);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released when the window loses focus.
      }
    }
  }

  if (!preview.fileUrl) {
    return (
      <div className="overflow-hidden rounded-lg border bg-background p-2">
        <div className="flex aspect-[4/3] items-center justify-center rounded-md border border-dashed text-center text-xs text-muted-foreground">图片源不可用。</div>
      </div>
    );
  }

  return (
    <PreviewCanvasFrame
      toolbar={(
        <>
          <PreviewIconButton title="缩小" onClick={() => nudgeZoom("out")}>
            <Minus className="h-3.5 w-3.5" />
          </PreviewIconButton>
          <span className="min-w-[42px] text-center font-mono text-[11px] text-muted-foreground">{zoomLabel}</span>
          <PreviewIconButton title="放大" onClick={() => nudgeZoom("in")}>
            <Plus className="h-3.5 w-3.5" />
          </PreviewIconButton>
          <PreviewIconButton title="适应窗口" onClick={fitToViewport}>
            <MoveHorizontal className="h-3.5 w-3.5" />
          </PreviewIconButton>
          <PreviewIconButton title="100%" onClick={resetView}>
            <span className="text-[10px] font-semibold">1:1</span>
          </PreviewIconButton>
        </>
      )}
    >
      <div
        ref={viewportRef}
        className={`relative h-full overflow-hidden bg-[hsl(var(--muted))]/25 ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <img
          className="pointer-events-none absolute left-1/2 top-1/2 block max-w-none select-none rounded-md object-contain shadow-sm ring-1 ring-border/70"
          src={preview.fileUrl}
          alt={preview.title}
          draggable={false}
          onLoad={handleImageLoad}
          style={{
            width: naturalSize ? naturalSize.width : "auto",
            height: naturalSize ? naturalSize.height : "auto",
            transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px)) scale(${zoom})`,
            transformOrigin: "center center",
          }}
        />
        <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full bg-background/82 px-2.5 py-1 text-[10px] text-muted-foreground shadow-sm ring-1 ring-border/70">
          拖拽移动 · ⌘/Ctrl + 滚轮缩放
        </div>
      </div>
    </PreviewCanvasFrame>
  );
}

function clampImageZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(6, Math.max(0.1, value));
}

function filePreviewViewKey(preview: FilePreview): string {
  return preview.sourcePath || preview.id || preview.path;
}

function readPreviewViewState(key: string): PreviewViewState | undefined {
  const state = previewViewStates.get(key);
  if (!state) return undefined;
  previewViewStates.delete(key);
  previewViewStates.set(key, state);
  return state;
}

function updatePreviewViewState(key: string, patch: PreviewViewState): void {
  if (!key) return;
  const current = readPreviewViewState(key) || {};
  previewViewStates.set(key, { ...current, ...patch });
  while (previewViewStates.size > PREVIEW_VIEW_STATE_LIMIT) {
    const oldest = previewViewStates.keys().next().value;
    if (!oldest) break;
    previewViewStates.delete(oldest);
  }
}

function PreviewCanvasFrame({ toolbar, children }: { toolbar: ReactNode; children: ReactNode }) {
  return (
    <div className="h-[70vh] overflow-hidden rounded-lg border bg-background shadow-sm">
      <div className="flex h-9 items-center justify-end gap-1 border-b bg-card/75 px-2">
        {toolbar}
      </div>
      <div className="h-[calc(70vh-2.25rem)] min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

function PreviewIconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

function OpenPreviewFileMenu({ preview }: { preview: FilePreview }) {
  const [open, setOpen] = useState(false);
  const sourcePath = preview.sourcePath || "";
  const cacheKey = openPathOptionsCacheKey(sourcePath, preview.kind);
  const cachedOptions = cacheKey ? openPathOptionsCache.get(cacheKey) : undefined;
  const [options, setOptions] = useState<OpenPathOption[]>(() => cachedOptions || []);
  const [loading, setLoading] = useState(() => Boolean(sourcePath && !cachedOptions));
  const menuRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const primaryOption = options[0] || null;

  useEffect(() => {
    if (!open) return undefined;
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    setOpen(false);
    if (!sourcePath) {
      setOptions([]);
      setLoading(false);
      return;
    }
    const cached = cacheKey ? openPathOptionsCache.get(cacheKey) : undefined;
    if (cached) {
      setOptions(cached);
      setLoading(false);
      return;
    }
    setOptions([]);
    void loadOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcePath, cacheKey]);

  async function loadOptions() {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    try {
      const nextOptions = await window.brevyn.app.openPathOptions(sourcePath);
      if (cacheKey) openPathOptionsCache.set(cacheKey, nextOptions);
      if (requestIdRef.current === requestId) setOptions(nextOptions);
    } catch {
      if (requestIdRef.current === requestId) setOptions([]);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }

  function closeMenu() {
    setOpen(false);
  }

  function toggleMenu() {
    setOpen((nextOpen) => !nextOpen);
  }

  async function openWith(option: OpenPathOption) {
    if (!sourcePath) return;
    await window.brevyn.app.openPathWith({ path: sourcePath, optionId: option.id, appPath: option.appPath });
    closeMenu();
  }

  return (
    <div ref={menuRef} className="relative shrink-0">
      <div className={`flex h-7 overflow-hidden rounded-lg border bg-background/70 text-muted-foreground shadow-sm transition ${open ? "border-foreground/15 bg-muted/70 text-foreground" : "hover:border-foreground/15 hover:text-foreground"}`}>
        <button
          type="button"
          className="flex w-8 items-center justify-center transition hover:bg-muted/70"
          onClick={() => primaryOption ? void openWith(primaryOption) : toggleMenu()}
          title={primaryOption ? `打开：${primaryOption.label}` : "打开方式"}
        >
          {primaryOption ? <OpenPathOptionIcon option={primaryOption} /> : <OpenPathOptionIconPlaceholder loading={loading} />}
        </button>
        <button
          type="button"
          className="flex w-6 items-center justify-center border-l border-border/80 transition hover:bg-muted/70"
          onClick={toggleMenu}
          title="选择打开方式"
          aria-expanded={open}
          aria-haspopup="menu"
        >
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      {open && (
        <div className="absolute right-0 top-8 z-50 w-60 overflow-hidden rounded-xl border bg-[hsl(var(--popover))] p-1 text-[12px] text-popover-foreground shadow-xl ring-1 ring-black/5" role="menu">
          <div className="px-2.5 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">打开方式</div>
          {loading && <div className="px-2.5 py-2 text-muted-foreground">正在读取本机应用...</div>}
          {!loading && options.map((option) => (
            <button
              key={`${option.id}-${option.appPath || ""}`}
              type="button"
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-accent"
              onClick={() => void openWith(option)}
              role="menuitem"
            >
              <OpenPathOptionIcon option={option} />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </button>
          ))}
          {!loading && options.length === 0 && <div className="px-2.5 py-2 text-muted-foreground">没有找到可用应用。</div>}
        </div>
      )}
    </div>
  );
}

function OpenPathOptionIconPlaceholder({ loading }: { loading: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`h-4 w-4 rounded-[4px] bg-muted/70 ${loading ? "animate-pulse" : ""}`}
    />
  );
}

function OpenPathOptionIcon({ option }: { option: OpenPathOption }) {
  if (option.iconDataUrl) {
    return <img className="h-4 w-4 rounded-[4px]" src={option.iconDataUrl} alt="" aria-hidden="true" />;
  }
  const label = option.label.toLowerCase();
  if (option.kind === "finder") return <FolderOpen className="h-3.5 w-3.5 text-blue-500" />;
  if (option.kind === "terminal") return <Terminal className="h-3.5 w-3.5 text-emerald-500" />;
  if (label.includes("cursor") || label.includes("code") || label.includes("xcode")) return <Code2 className="h-3.5 w-3.5 text-sky-500" />;
  if (label.includes("preview")) return <ImageIcon className="h-3.5 w-3.5 text-blue-500" />;
  if (label.includes("powerpoint") || label.includes("keynote")) return <Presentation className="h-3.5 w-3.5 text-orange-500" />;
  if (label.includes("excel") || label.includes("numbers")) return <Table2 className="h-3.5 w-3.5 text-emerald-600" />;
  if (label.includes("word") || label.includes("pages")) return <Type className="h-3.5 w-3.5 text-blue-600" />;
  return <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />;
}

function openPathOptionsCacheKey(sourcePath: string, kind: FilePreview["kind"]): string {
  if (!sourcePath) return "";
  if (kind === "folder") return "folder";
  const fileName = sourcePath.split(/[\\/]/).pop() || sourcePath;
  const dotIndex = fileName.lastIndexOf(".");
  const extension = dotIndex > 0 ? fileName.slice(dotIndex).toLowerCase() : "";
  return `${kind}:${extension || fileName.toLowerCase()}`;
}

function parsedPreviewSourceFileId(preview: FilePreview): string {
  if (!preview.sourcePath) return "";
  if (preview.id.endsWith(":parsed")) return "";
  if (preview.id.includes("/") || preview.id.includes("\\")) return "";
  if (preview.kind === "folder" || preview.kind === "markdown" || preview.kind === "code" || preview.kind === "text") return "";
  return preview.id;
}

function originalPreviewSourceFileId(preview: FilePreview): string {
  return preview.id.endsWith(":parsed") ? preview.id.slice(0, -":parsed".length) : "";
}

function friendlyParsedPreviewMessage(message: string): string {
  if (message.includes("尚未生成解析文本") || message.includes("请先索引文件")) {
    return "索引完成后会在这里生成可复制、可引用的文本版本。";
  }
  return message || "索引完成后会在这里生成可复制、可引用的文本版本。";
}

function previewKindLabel(kind: FilePreview["kind"]): string {
  if (kind === "folder") return "文件夹";
  if (kind === "markdown") return "Markdown";
  if (kind === "pdf") return "PDF";
  if (kind === "image") return "图片";
  if (kind === "code") return "代码";
  if (kind === "text") return "文本";
  if (kind === "docx") return "Word";
  if (kind === "pptx") return "演示文稿";
  if (kind === "spreadsheet") return "表格";
  return "文件";
}

function officePreviewModeLabelFor(preview: FilePreview): string {
  const mode = preview.metadata?.officePreviewMode;
  if (mode === "high-fidelity-pdf") return "高保真预览";
  if (mode === "structured-workbook") return "结构化工作簿";
  if (mode === "basic-html") return "基础预览";
  return "";
}

function officePreviewDocument(html: string, kind: "docx" | "presentation" | "spreadsheet"): string {
  const bodyClass = `office-kind-${kind}`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root {
        color-scheme: light;
        font-family: "Avenir Next", "Segoe UI", sans-serif;
        background: #f5f2ec;
        color: #1f2933;
      }
      body {
        margin: 0;
        padding: clamp(10px, 3vw, 24px);
        background:
          radial-gradient(circle at 20% 0%, rgba(255,255,255,.9), transparent 28rem),
          #f5f2ec;
        overflow-wrap: anywhere;
      }
      .office-kind-docx {
        padding: 0;
        background: #f6f6f4;
      }
      .page {
        box-sizing: border-box;
        width: min(100%, 780px);
        min-height: calc(100vh - 48px);
        margin: 0 auto;
        padding: clamp(22px, 5vw, 42px) clamp(18px, 6vw, 48px);
        border: 1px solid rgba(31, 41, 51, 0.12);
        border-radius: 12px;
        background: #fffdf8;
        box-shadow: 0 20px 50px rgba(31, 41, 51, 0.10);
      }
      .office-kind-docx .page {
        width: 100%;
        max-width: none;
        min-height: 100vh;
        margin: 0;
        padding: clamp(20px, 3.2vw, 36px);
        border: 0;
        border-radius: 0;
        box-shadow: none;
        overflow: visible;
      }
      h1, h2, h3 {
        margin: 1.1em 0 0.55em;
        line-height: 1.2;
        color: #111827;
      }
      h1:first-child, h2:first-child, h3:first-child, p:first-child {
        margin-top: 0;
      }
      h1 { font-size: 24px; letter-spacing: -0.02em; }
      h2 { font-size: 19px; }
      h3 { font-size: 16px; }
      p, li {
        font-size: 13.5px;
        line-height: 1.72;
      }
      p {
        margin: 0.7em 0;
      }
      table {
        width: max-content;
        min-width: 100%;
        margin: 1em 0;
        border-collapse: collapse;
        font-size: 12.5px;
      }
      .office-kind-docx table {
        width: 100% !important;
        max-width: 100%;
        min-width: 0;
        table-layout: auto;
      }
      th, td {
        border: 1px solid rgba(31, 41, 51, 0.18);
        padding: 8px 10px;
        vertical-align: top;
        overflow-wrap: anywhere;
        word-break: normal;
      }
      .office-kind-docx th,
      .office-kind-docx td {
        padding: 7px 9px;
      }
      .office-kind-docx p,
      .office-kind-docx li,
      .office-kind-docx th,
      .office-kind-docx td {
        font-size: clamp(11px, 1.8vw, 13.5px);
        line-height: 1.58;
      }
      th {
        background: rgba(245, 242, 236, 0.85);
      }
      img {
        max-width: 100%;
        height: auto;
        border-radius: 8px;
      }
      a {
        color: #2563eb;
      }
      .office-preview-title {
        margin: 0 0 18px;
        font-size: 18px;
        font-weight: 720;
        letter-spacing: -0.02em;
        color: #111827;
      }
      .office-preview-notice,
      .office-sheet-meta,
      .office-slide-index,
      .office-empty {
        color: #667085;
        font-size: 12px;
      }
      .office-preview-notice {
        margin: 0 0 12px;
        border: 1px solid rgba(31, 41, 51, 0.1);
        border-radius: 10px;
        background: rgba(245, 242, 236, 0.75);
        padding: 8px 10px;
      }
      .office-sheet,
      .office-slide {
        margin-top: 14px;
        border: 1px solid rgba(31, 41, 51, 0.12);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.62);
        padding: 14px;
      }
      .office-sheet h3,
      .office-slide h3 {
        margin: 0 0 8px;
      }
      .office-table-wrap {
        margin-top: 10px;
        overflow: auto;
        border: 1px solid rgba(31, 41, 51, 0.12);
        border-radius: 10px;
        background: white;
      }
      .office-table-wrap table {
        margin: 0;
      }
      .office-table-wrap thead th {
        position: sticky;
        top: 0;
        z-index: 2;
      }
      .office-row-heading {
        position: sticky;
        left: 0;
        z-index: 1;
        min-width: 38px;
        text-align: center;
        color: #667085;
      }
      .office-slide ul {
        margin: 10px 0 0;
        padding-left: 1.2rem;
      }
      .office-slide li + li {
        margin-top: 6px;
      }
    </style>
  </head>
  <body class="${bodyClass}">
    <main class="page">${html}</main>
  </body>
</html>`;
}
