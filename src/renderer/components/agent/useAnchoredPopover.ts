import { type CSSProperties, type RefObject, useLayoutEffect, useState } from "react";

type Placement = "top" | "bottom";

interface AnchoredPopoverOptions {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLElement | null>;
  width: number;
  estimatedHeight: number;
  gap?: number;
  padding?: number;
  minHeight?: number;
  preferredPlacement?: Placement;
}

interface AnchoredPopoverPosition {
  ready: boolean;
  placement: Placement;
  style: CSSProperties;
}

export function useAnchoredPopover({
  open,
  anchorRef,
  popoverRef,
  width,
  estimatedHeight,
  gap = 10,
  padding = 12,
  minHeight = 112,
  preferredPlacement = "top",
}: AnchoredPopoverOptions): AnchoredPopoverPosition {
  const [position, setPosition] = useState<AnchoredPopoverPosition>({
    ready: false,
    placement: preferredPlacement,
    style: {
      left: padding,
      top: padding,
      width,
      maxHeight: estimatedHeight,
    },
  });

  useLayoutEffect(() => {
    if (!open) {
      setPosition((current) => ({ ...current, ready: false }));
      return;
    }

    let frame = 0;

    const updatePosition = () => {
      const anchorRect = anchorRef.current?.getBoundingClientRect();
      if (!anchorRect) return;

      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const safeWidth = Math.min(width, Math.max(160, viewportWidth - padding * 2));
      const fullHeight = popoverRef.current?.scrollHeight || estimatedHeight;
      const aboveSpace = Math.max(0, anchorRect.top - padding - gap);
      const belowSpace = Math.max(0, viewportHeight - anchorRect.bottom - padding - gap);
      const hasRoomAbove = aboveSpace >= Math.min(fullHeight, minHeight);
      const hasRoomBelow = belowSpace >= Math.min(fullHeight, minHeight);
      const placement =
        preferredPlacement === "top"
          ? hasRoomAbove || !hasRoomBelow || aboveSpace >= belowSpace
            ? "top"
            : "bottom"
          : hasRoomBelow || !hasRoomAbove || belowSpace >= aboveSpace
            ? "bottom"
            : "top";

      const availableHeight = placement === "top" ? aboveSpace : belowSpace;
      const maxHeight = Math.max(minHeight, Math.min(fullHeight, availableHeight || fullHeight));
      const renderedHeight = Math.min(fullHeight, maxHeight);
      const left = clamp(anchorRect.right - safeWidth, padding, viewportWidth - safeWidth - padding);
      const top =
        placement === "top"
          ? clamp(anchorRect.top - gap - renderedHeight, padding, viewportHeight - padding - renderedHeight)
          : clamp(anchorRect.bottom + gap, padding, viewportHeight - padding - renderedHeight);

      setPosition({
        ready: true,
        placement,
        style: {
          left,
          top,
          width: safeWidth,
          maxHeight,
        },
      });
    };

    const scheduleUpdate = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updatePosition);
    };

    updatePosition();
    frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
    };
  }, [anchorRef, estimatedHeight, gap, minHeight, open, padding, popoverRef, preferredPlacement, width]);

  return position;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}
