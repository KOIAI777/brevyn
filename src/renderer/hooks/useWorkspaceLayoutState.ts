import { useEffect, useMemo, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";

const CHAT_MIN_WIDTH = 520;
const RESPONSIVE_SIDEBAR_COLLAPSE_WIDTH = 1180;
const RESPONSIVE_RAILS_COLLAPSE_WIDTH = 1320;
const SIDEBAR_WIDTH_STORAGE_KEY = "brevyn.sidebar.width";
const FILE_RAIL_WIDTH_STORAGE_KEY = "brevyn.files.rail.width";
const FILE_RAIL_COLLAPSED_STORAGE_KEY = "brevyn.files.rail.collapsed";
const FILE_RAIL_MAX_STORED_WIDTH = 1600;
const SIDEBAR_WIDTH = { min: 240, default: 340, max: 520 } as const;
const RAIL_WIDTHS = {
  files: { min: 520, renderMin: 420, default: 720 },
} as const;

export type ResizableRail = "files";

interface UseWorkspaceLayoutStateArgs {
  contentGridRef: React.RefObject<HTMLDivElement | null>;
}

export function useWorkspaceLayoutState({ contentGridRef }: UseWorkspaceLayoutStateArgs) {
  const initialResponsiveModeRef = useRef(readResponsiveMode());
  const preferredSidebarCollapsedRef = useRef(false);
  const preferredRailCollapsedRef = useRef({ files: readStoredFileRailCollapsed() });
  const responsiveModeRef = useRef(initialResponsiveModeRef.current);
  const [sidebarCollapsed, setSidebarCollapsedState] = useState(() => initialResponsiveModeRef.current.sidebar ? true : preferredSidebarCollapsedRef.current);
  const [fileRailCollapsed, setFileRailCollapsedState] = useState(() => initialResponsiveModeRef.current.rails ? true : preferredRailCollapsedRef.current.files);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readStoredSidebarWidth());
  const [fileRailWidth, setFileRailWidth] = useState<number>(() => readStoredFileRailWidth());
  const [sidebarResizing, setSidebarResizing] = useState(false);
  const [resizingRail, setResizingRail] = useState<ResizableRail | null>(null);
  const [windowResizing, setWindowResizing] = useState(false);

  const sidebarResizeStateRef = useRef<{ startX: number; startWidth: number; element: HTMLElement } | null>(null);
  const sidebarResizeFrameRef = useRef<number | null>(null);
  const sidebarResizePointerXRef = useRef(0);
  const resizeStateRef = useRef<{ rail: ResizableRail; startX: number; startWidth: number; startWidths: Record<ResizableRail, number>; moved: boolean } | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const resizePointerXRef = useRef(0);
  const railWidthsRef = useRef<Record<ResizableRail, number>>({ files: RAIL_WIDTHS.files.default });

  railWidthsRef.current = { files: fileRailWidth };

  useEffect(() => {
    let timeout = 0;
    function handleResize() {
      setWindowResizing(true);
      const previousMode = responsiveModeRef.current;
      const nextMode = readResponsiveMode();
      responsiveModeRef.current = nextMode;
      if (nextMode.sidebar !== previousMode.sidebar) {
        setSidebarCollapsedState(nextMode.sidebar ? true : preferredSidebarCollapsedRef.current);
      }
      if (nextMode.rails !== previousMode.rails) {
        setFileRailCollapsedState(nextMode.rails ? true : preferredRailCollapsedRef.current.files);
      }
      if (timeout) window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        setWindowResizing(false);
        timeout = 0;
      }, 140);
    }
    window.addEventListener("resize", handleResize, { passive: true });
    return () => {
      window.removeEventListener("resize", handleResize);
      if (timeout) window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    if (!resizingRail) return;
    function applyResize(clientX: number) {
      const state = resizeStateRef.current;
      if (!state) return;
      const config = RAIL_WIDTHS[state.rail];
      const gridWidth = contentGridRef.current?.getBoundingClientRect().width || window.innerWidth;
      const otherRailWidth = state.rail === "files" || fileRailCollapsed ? 0 : state.startWidths.files;
      const availableMax = gridWidth - otherRailWidth - CHAT_MIN_WIDTH;
      const minWidth = config.renderMin;
      const maxWidth = Math.max(minWidth, availableMax, state.startWidth);
      const nextWidth = clamp(state.startWidth - (clientX - state.startX), minWidth, maxWidth);
      const nextWidths = { ...state.startWidths, [state.rail]: nextWidth };
      railWidthsRef.current = nextWidths;
      if (contentGridRef.current) {
        contentGridRef.current.style.gridTemplateColumns = gridColumnsForWidths(
          fileRailCollapsed,
          nextWidths.files,
        );
      }
      return nextWidth;
    }
    function handlePointerMove(event: PointerEvent) {
      const state = resizeStateRef.current;
      if (!state) return;
      if (!state.moved && Math.abs(event.clientX - state.startX) < 2) return;
      state.moved = true;
      resizePointerXRef.current = event.clientX;
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        applyResize(resizePointerXRef.current);
      });
    }
    function handlePointerUp() {
      const state = resizeStateRef.current;
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      if (!state?.moved) {
        resizeStateRef.current = null;
        setResizingRail(null);
        return;
      }
      const nextWidth = applyResize(resizePointerXRef.current);
      if (resizeStateRef.current?.rail === "files" && typeof nextWidth === "number") {
        setFileRailWidth(nextWidth);
        storeFileRailWidth(nextWidth);
      }
      resizeStateRef.current = null;
      setResizingRail(null);
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [contentGridRef, fileRailCollapsed, resizingRail]);

  useEffect(() => {
    if (!sidebarResizing) return;
    function applyResize(clientX: number) {
      const state = sidebarResizeStateRef.current;
      if (!state) return;
      const availableMax = window.innerWidth - CHAT_MIN_WIDTH - 48;
      const maxWidth = Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, availableMax));
      const nextWidth = clamp(state.startWidth + clientX - state.startX, SIDEBAR_WIDTH.min, maxWidth);
      state.element.style.width = `${nextWidth}px`;
      return nextWidth;
    }
    function handlePointerMove(event: PointerEvent) {
      sidebarResizePointerXRef.current = event.clientX;
      if (sidebarResizeFrameRef.current !== null) return;
      sidebarResizeFrameRef.current = window.requestAnimationFrame(() => {
        sidebarResizeFrameRef.current = null;
        applyResize(sidebarResizePointerXRef.current);
      });
    }
    function handlePointerUp() {
      if (sidebarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarResizeFrameRef.current);
        sidebarResizeFrameRef.current = null;
      }
      const nextWidth = applyResize(sidebarResizePointerXRef.current);
      if (typeof nextWidth === "number") {
        setSidebarWidth(nextWidth);
        storeSidebarWidth(nextWidth);
      }
      sidebarResizeStateRef.current = null;
      setSidebarResizing(false);
    }
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      if (sidebarResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(sidebarResizeFrameRef.current);
        sidebarResizeFrameRef.current = null;
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [sidebarResizing]);

  const setSidebarCollapsed: Dispatch<SetStateAction<boolean>> = (value) => {
    setSidebarCollapsedState((current) => {
      const next = resolveSetState(value, current);
      preferredSidebarCollapsedRef.current = next;
      return next;
    });
  };

  const setFileRailCollapsed: Dispatch<SetStateAction<boolean>> = (value) => {
    setFileRailCollapsedState((current) => {
      const next = resolveSetState(value, current);
      preferredRailCollapsedRef.current = { ...preferredRailCollapsedRef.current, files: next };
      storeFileRailCollapsed(next);
      return next;
    });
  };

  const contentGridColumns = useMemo(
    () => gridColumnsForWidths(fileRailCollapsed, fileRailWidth),
    [fileRailCollapsed, fileRailWidth],
  );

  function startRailResize(rail: ResizableRail, event: ReactPointerEvent) {
    const renderedWidths = measureRenderedRailWidths(contentGridRef.current, railWidthsRef.current);
    const startWidth = renderedWidths[rail] || fileRailWidth;
    resizeStateRef.current = { rail, startX: event.clientX, startWidth, startWidths: renderedWidths, moved: false };
    resizePointerXRef.current = event.clientX;
    setResizingRail(rail);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.stopPropagation();
    event.preventDefault();
  }

  function startSidebarResize(event: ReactPointerEvent) {
    if (sidebarCollapsed) return;
    const element = event.currentTarget.closest("[data-workspace-sidebar]");
    if (!(element instanceof HTMLElement)) return;
    sidebarResizeStateRef.current = { startX: event.clientX, startWidth: sidebarWidth, element };
    sidebarResizePointerXRef.current = event.clientX;
    setSidebarResizing(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  return {
    sidebarCollapsed,
    setSidebarCollapsed,
    sidebarWidth,
    sidebarResizing,
    fileRailCollapsed,
    setFileRailCollapsed,
    fileRailWidth,
    resizingRail,
    windowResizing,
    contentGridColumns,
    startRailResize,
    startSidebarResize,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function readResponsiveMode(): { sidebar: boolean; rails: boolean } {
  if (typeof window === "undefined") return { sidebar: false, rails: false };
  return {
    sidebar: window.innerWidth < RESPONSIVE_SIDEBAR_COLLAPSE_WIDTH,
    rails: window.innerWidth < RESPONSIVE_RAILS_COLLAPSE_WIDTH,
  };
}

function resolveSetState<T>(value: SetStateAction<T>, current: T): T {
  return typeof value === "function" ? (value as (current: T) => T)(current) : value;
}

function readStoredSidebarWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) ? clamp(value, SIDEBAR_WIDTH.min, SIDEBAR_WIDTH.max) : SIDEBAR_WIDTH.default;
  } catch {
    return SIDEBAR_WIDTH.default;
  }
}

function storeSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // preference storage may fail in locked environments
  }
}

function readStoredFileRailWidth(): number {
  try {
    const storedValue = window.localStorage.getItem(FILE_RAIL_WIDTH_STORAGE_KEY);
    if (storedValue === null) return RAIL_WIDTHS.files.default;
    const value = Number(storedValue);
    return Number.isFinite(value) && value > 0
      ? clamp(value, RAIL_WIDTHS.files.renderMin, FILE_RAIL_MAX_STORED_WIDTH)
      : RAIL_WIDTHS.files.default;
  } catch {
    return RAIL_WIDTHS.files.default;
  }
}

function storeFileRailWidth(width: number): void {
  try {
    window.localStorage.setItem(FILE_RAIL_WIDTH_STORAGE_KEY, String(Math.round(width)));
  } catch {
    // preference storage may fail in locked environments
  }
}

function readStoredFileRailCollapsed(): boolean {
  try {
    const value = window.localStorage.getItem(FILE_RAIL_COLLAPSED_STORAGE_KEY);
    if (value === "false") return false;
    return true;
  } catch {
    return true;
  }
}

function storeFileRailCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(FILE_RAIL_COLLAPSED_STORAGE_KEY, collapsed ? "true" : "false");
  } catch {
    // preference storage may fail in locked environments
  }
}

function gridColumnsForWidths(
  fileRailCollapsed: boolean,
  fileRailWidth: number,
): string {
  return [
    "minmax(0, 1fr)",
    railColumn(fileRailCollapsed, fileRailWidth),
  ].join(" ");
}

function railColumn(collapsed: boolean, width: number): string {
  if (collapsed) return "0px";
  return `${width}px`;
}

function measureRenderedRailWidths(gridElement: HTMLDivElement | null, fallback: Record<ResizableRail, number>): Record<ResizableRail, number> {
  if (!gridElement) return fallback;
  const columns = window.getComputedStyle(gridElement).gridTemplateColumns
    .split(" ")
    .map((value) => Number.parseFloat(value))
    .filter((value) => Number.isFinite(value));
  if (columns.length < 2) return fallback;
  return {
    files: columns[1] || fallback.files,
  };
}
