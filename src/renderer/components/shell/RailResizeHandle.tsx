import type { PointerEvent } from "react";
import { cx } from "@/lib/cn";

export function RailResizeHandle({
  collapsed,
  resizing,
  label,
  onResizeStart,
}: {
  collapsed: boolean;
  resizing?: boolean;
  label: string;
  onResizeStart: (event: PointerEvent) => void;
}) {
  return (
    <button
      type="button"
      tabIndex={collapsed ? -1 : 0}
      className="absolute -left-1 top-0 z-30 flex h-full w-4 cursor-col-resize touch-none items-center justify-center bg-transparent focus:outline-none"
      aria-label={label}
      onPointerDown={(event) => {
        event.stopPropagation();
        onResizeStart(event);
      }}
    >
      <span
        className={cx(
          "h-[calc(100%-1.5rem)] w-px rounded-full bg-border opacity-0 transition-[opacity,background-color,box-shadow] duration-150",
          "group-hover/rail:opacity-70 group-hover/rail:bg-foreground/22",
          resizing && "bg-foreground/35 opacity-100 shadow-[0_0_0_3px_hsl(var(--foreground)/0.045)]",
        )}
      />
    </button>
  );
}
