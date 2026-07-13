import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction, type WheelEvent } from "react";
import { cx } from "@/lib/cn";

export interface UserMessageNavItem {
  id: string;
  index: number;
  preview: string;
}

interface UserMessageNavigatorProps {
  items: UserMessageNavItem[];
  scrollContainer: HTMLElement | null;
  bottomOffset: number;
  ready: boolean;
}

interface NavMarker extends UserMessageNavItem {
  topPx: number;
}

type NavigatorDensity = "hidden" | "compact" | "full";

const MIN_ITEMS = 1;
const MARKER_STEP_PX = 14;
const RAIL_PADDING_PX = 28;
const RAIL_FADE_PX = 28;
const MANUAL_RAIL_SCROLL_LOCK_MS = 1600;
const COMPACT_NAVIGATOR_WIDTH = 680;
const HIDDEN_NAVIGATOR_WIDTH = 480;
const RAIL_MASK = `linear-gradient(to bottom, transparent 0, black ${RAIL_FADE_PX}px, black calc(100% - ${RAIL_FADE_PX}px), transparent 100%)`;

export function UserMessageNavigator({ items, scrollContainer, bottomOffset, ready }: UserMessageNavigatorProps) {
  const [markers, setMarkers] = useState<NavMarker[]>([]);
  const [activeIds, setActiveIds] = useState<Set<string>>(() => new Set());
  const [hoveredId, setHoveredId] = useState("");
  const [railScrollTop, setRailScrollTop] = useState(0);
  const [railContentHeight, setRailContentHeight] = useState(0);
  const [hasMeasured, setHasMeasured] = useState(false);
  const [density, setDensity] = useState<NavigatorDensity>("hidden");
  const railViewportRef = useRef<HTMLDivElement | null>(null);
  const hasMeasuredRef = useRef(false);
  const manualRailScrollUntilRef = useRef(0);
  const hideTimerRef = useRef<number | null>(null);
  const visibleItems = useMemo(() => items.filter((item) => item.preview.trim()), [items]);

  useEffect(() => {
    if (!ready || visibleItems.length < MIN_ITEMS) {
      setMarkers([]);
      setActiveIds(new Set());
      setRailScrollTop(0);
      setRailContentHeight(0);
      setDensity("hidden");
      hasMeasuredRef.current = false;
      setHasMeasured(false);
      return;
    }

    const container = scrollContainer;
    if (!container) return;

    let frame = 0;
    let settleFrame = 0;
    const runUpdate = () => {
      setDensity(navigatorDensity(container.clientWidth));
      updateMarkers(
        container,
        railViewportRef.current,
        visibleItems,
        setMarkers,
        setActiveIds,
        setRailContentHeight,
        setRailScrollTop,
        manualRailScrollUntilRef,
        (value) => {
          hasMeasuredRef.current = value;
          setHasMeasured(value);
        },
      );
    };
    const schedule = () => {
      if (frame || settleFrame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        if (!hasMeasuredRef.current) {
          settleFrame = window.requestAnimationFrame(() => {
            settleFrame = 0;
            runUpdate();
          });
          return;
        }
        runUpdate();
      });
    };

    schedule();
    container.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    if (railViewportRef.current) observer.observe(railViewportRef.current);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (settleFrame) window.cancelAnimationFrame(settleFrame);
      container.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    };
  }, [ready, scrollContainer, visibleItems]);

  useEffect(() => {
    const viewportHeight = railViewportRef.current?.clientHeight ?? 0;
    setRailScrollTop((current) => clampRailScroll(current, railContentHeight, viewportHeight));
  }, [markers.length, railContentHeight]);

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    };
  }, []);

  if (!ready || visibleItems.length < MIN_ITEMS || density === "hidden") return null;

  const hovered = markers.find((marker) => marker.id === hoveredId);

  function showPreview(id: string) {
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setHoveredId(id);
  }

  function hidePreview() {
    if (hideTimerRef.current) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setHoveredId(""), 120);
  }

  function scrollToMessage(id: string) {
    const container = scrollContainer;
    if (!container) return;
    const target = findUserMessageNode(container, id);
    if (!target) return;
    const top = getOffsetTopRelativeTo(target, container) - 20;
    container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }

  function handleRailWheel(event: WheelEvent<HTMLDivElement>) {
    const viewport = railViewportRef.current;
    if (!viewport) return;
    const maxScrollTop = maxRailScroll(railContentHeight, viewport.clientHeight);
    if (maxScrollTop <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    manualRailScrollUntilRef.current = Date.now() + MANUAL_RAIL_SCROLL_LOCK_MS;
    setRailScrollTop((current) => clamp(current + event.deltaY, 0, maxScrollTop));
  }

  const railViewportHeight = railViewportRef.current?.clientHeight ?? 0;
  const hoveredTopPx = hovered ? clamp(hovered.topPx - railScrollTop, 28, Math.max(28, railViewportHeight - 28)) : 0;
  const isVisible = hasMeasured && markers.length >= MIN_ITEMS;

  return (
    <div
      className={cx(
        "pointer-events-none absolute top-5 z-30 transition-[left,width,opacity] duration-150",
        density === "compact" ? "left-2 w-8" : "left-6 w-16",
        isVisible ? "opacity-100" : "opacity-0",
      )}
      style={{ bottom: bottomOffset }}
      aria-label="用户消息导航"
    >
      <div
        ref={railViewportRef}
        className={cx("relative h-full overflow-hidden", isVisible ? "pointer-events-auto" : "pointer-events-none")}
        style={{ maskImage: RAIL_MASK, WebkitMaskImage: RAIL_MASK }}
        onWheel={handleRailWheel}
      >
        <div
          className="relative will-change-transform"
          style={{
            height: railContentHeight,
            transform: `translateY(${-railScrollTop}px)`,
          }}
        >
          {markers.map((marker) => {
            const isActive = activeIds.has(marker.id);
            const isHovered = marker.id === hoveredId;
            return (
              <button
                key={marker.id}
                type="button"
                className={cx(
                  "absolute left-0 flex h-5 -translate-y-1/2 items-center rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/45",
                  density === "compact" ? "w-6" : "w-14",
                )}
                style={{ top: marker.topPx }}
                title={marker.preview}
                aria-label={`跳到第 ${marker.index} 条用户消息`}
                onMouseEnter={() => showPreview(marker.id)}
                onMouseLeave={hidePreview}
                onFocus={() => showPreview(marker.id)}
                onBlur={hidePreview}
                onClick={() => scrollToMessage(marker.id)}
              >
                <span
                  className={cx(
                    "block h-[3px] rounded-full bg-[hsl(var(--foreground)/0.32)] transition-[width,background-color,opacity,transform] duration-150 ease-out",
                    isHovered
                      ? density === "compact" ? "w-5 bg-[hsl(var(--foreground)/0.9)] opacity-100" : "w-8 bg-[hsl(var(--foreground)/0.9)] opacity-100"
                      : isActive
                        ? density === "compact" ? "w-2 bg-[hsl(var(--foreground)/0.62)] opacity-90" : "w-3 bg-[hsl(var(--foreground)/0.62)] opacity-90"
                        : density === "compact" ? "w-2 opacity-60" : "w-3 opacity-60",
                    isHovered && "translate-x-0.5",
                  )}
                />
              </button>
            );
          })}
        </div>
      </div>

      {isVisible && hovered ? (
        <div
          className="pointer-events-auto absolute -translate-y-1/2 rounded-[var(--radius-panel)] border border-border/55 bg-popover/96 px-4 py-3 text-popover-foreground shadow-[0_18px_48px_rgba(0,0,0,0.24)] backdrop-blur-xl transition duration-150"
          style={{
            top: hoveredTopPx,
            left: density === "compact" ? 30 : 58,
            width: Math.min(420, Math.max(220, (scrollContainer?.clientWidth || 420) - 100)),
          }}
          onMouseEnter={() => showPreview(hovered.id)}
          onMouseLeave={hidePreview}
        >
          <p className="line-clamp-4 break-words text-sm leading-6 text-popover-foreground/86">{hovered.preview}</p>
        </div>
      ) : null}
    </div>
  );
}

function navigatorDensity(width: number): NavigatorDensity {
  if (width < HIDDEN_NAVIGATOR_WIDTH) return "hidden";
  if (width < COMPACT_NAVIGATOR_WIDTH) return "compact";
  return "full";
}

function updateMarkers(
  container: HTMLElement,
  rail: HTMLElement | null,
  items: UserMessageNavItem[],
  setMarkers: (markers: NavMarker[]) => void,
  setActiveIds: (ids: Set<string>) => void,
  setRailContentHeight: (height: number) => void,
  setRailScrollTop: Dispatch<SetStateAction<number>>,
  manualRailScrollUntilRef: { current: number },
  setHasMeasured: (value: boolean) => void,
) {
  const viewportTop = container.scrollTop;
  const viewportBottom = viewportTop + container.clientHeight;

  const measuredItems = items.flatMap((item) => {
    const node = findUserMessageNode(container, item.id);
    if (!node) return [];
    const absoluteTop = getOffsetTopRelativeTo(node, container);
    const absoluteBottom = absoluteTop + node.offsetHeight;
    return [{
      ...item,
      absoluteTop,
      absoluteBottom,
    }];
  }).sort((previous, next) => previous.absoluteTop - next.absoluteTop);

  const railHeight = Math.max(1, rail?.clientHeight || container.clientHeight);
  const sequenceHeight = Math.max(0, measuredItems.length - 1) * MARKER_STEP_PX;
  const scrollableContentHeight = sequenceHeight + RAIL_PADDING_PX * 2;
  const fitsInRail = scrollableContentHeight <= railHeight;
  const contentHeight = fitsInRail ? railHeight : scrollableContentHeight;
  const startTop = fitsInRail ? (railHeight - sequenceHeight) / 2 : RAIL_PADDING_PX;
  const nextMarkers = measuredItems.map((item, index) => {
    return { ...item, topPx: startTop + index * MARKER_STEP_PX };
  });

  const nextActiveIds = new Set(
    measuredItems
      .filter((item) => item.absoluteBottom >= viewportTop && item.absoluteTop <= viewportBottom)
      .map((item) => item.id),
  );
  setMarkers(nextMarkers);
  setActiveIds(nextActiveIds);
  setRailContentHeight(contentHeight);

  const activeIndexes = measuredItems.flatMap((item, index) => {
    if (item.absoluteBottom < viewportTop || item.absoluteTop > viewportBottom) return [];
    return [index];
  });
  setRailScrollTop((current) => {
    const clamped = clampRailScroll(current, contentHeight, railHeight);
    if (fitsInRail) return 0;
    if (Date.now() < manualRailScrollUntilRef.current || activeIndexes.length === 0) return clamped;
    const activeCenterIndex = (activeIndexes[0]! + activeIndexes[activeIndexes.length - 1]!) / 2;
    const activeCenterTop = startTop + activeCenterIndex * MARKER_STEP_PX;
    const target = clampRailScroll(activeCenterTop - railHeight / 2, contentHeight, railHeight);
    return Math.abs(target - clamped) < 1 ? clamped : target;
  });
  setHasMeasured(true);
}

function findUserMessageNode(container: HTMLElement, id: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-user-message-id]")).find(
    (node) => node.getAttribute("data-user-message-id") === id,
  );
}

function getOffsetTopRelativeTo(node: HTMLElement, container: HTMLElement): number {
  let top = 0;
  let current: HTMLElement | null = node;
  while (current && current !== container) {
    top += current.offsetTop;
    current = current.offsetParent as HTMLElement | null;
  }
  return top;
}

function maxRailScroll(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - viewportHeight);
}

function clampRailScroll(value: number, contentHeight: number, viewportHeight: number): number {
  return clamp(value, 0, maxRailScroll(contentHeight, viewportHeight));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}
