import { CalendarDays, PanelRightClose, PanelRightOpen } from "lucide-react";
import type { ReactNode } from "react";
import type { SemesterWorkspace } from "@/types/domain";
import { cx } from "@/lib/cn";
import { parseDateOnly, semesterWeekNumberForDate } from "../../../shared/semester-weeks";

export function AppTitleBar({
  semester,
  fileRailCollapsed,
  onToggleFileRail,
}: {
  semester?: SemesterWorkspace | null;
  fileRailCollapsed: boolean;
  onToggleFileRail: () => void;
}) {
  const today = new Date();
  const currentWeek = semester ? semesterWeekNumberForDate(semester, today) : undefined;
  const semesterStateLabel = semester ? getSemesterStateLabel(semester, today, currentWeek) : undefined;

  return (
    <header className="drag-region flex h-12 shrink-0 items-center border-b border-border/60 bg-card px-3 text-foreground">
      <div className="w-20 shrink-0" />

      {semester && (
        <div
          className="no-drag hidden h-8 shrink-0 cursor-default items-center gap-2 rounded-[var(--radius-control)] bg-background px-3 text-[13px] font-semibold text-foreground shadow-sm ring-1 ring-black/[0.06] sm:flex"
          title="当前学期"
        >
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <span className="max-w-[128px] truncate">{semester.term}</span>
          {semesterStateLabel && (
            <span className="rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
              {semesterStateLabel}
            </span>
          )}
        </div>
      )}
      <div className="no-drag ml-auto flex shrink-0 items-center gap-1.5">
        <TitleBarIconButton
          active={!fileRailCollapsed}
          ariaLabel={fileRailCollapsed ? "显示右侧工作区" : "隐藏右侧工作区"}
          title={fileRailCollapsed ? "显示右侧工作区" : "隐藏右侧工作区"}
          onClick={onToggleFileRail}
        >
          {fileRailCollapsed ? <PanelRightOpen className="h-3.5 w-3.5" /> : <PanelRightClose className="h-3.5 w-3.5" />}
        </TitleBarIconButton>
      </div>
    </header>
  );
}

function getSemesterStateLabel(semester: SemesterWorkspace, today: Date, currentWeek?: number): string | undefined {
  if (currentWeek) return `第 ${currentWeek} 周`;
  const start = parseDateOnly(semester.startsAt);
  const end = parseDateOnly(semester.endsAt);
  if (!start || !end) return undefined;
  if (today < start) return "未开始";
  if (today > end) return "已结束";
  return undefined;
}

function TitleBarIconButton({
  active,
  ariaLabel,
  title,
  onClick,
  children,
}: {
  active: boolean;
  ariaLabel: string;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <span className="relative inline-flex h-8 w-8 items-center justify-center">
      <button
        type="button"
        className={cx(
          "peer inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] transition active:scale-[0.98]",
          active
            ? "bg-accent text-foreground shadow-sm ring-1 ring-black/[0.06]"
            : "bg-background/70 text-muted-foreground shadow-sm ring-1 ring-black/[0.04] hover:bg-accent hover:text-foreground",
        )}
        aria-label={ariaLabel}
        aria-pressed={active}
        onClick={onClick}
      >
        {children}
      </button>
      <span className="pointer-events-none absolute right-1/2 top-full z-[1000] mt-2 hidden translate-x-1/2 whitespace-nowrap rounded-[var(--radius-control)] bg-popover px-2.5 py-1.5 text-[11px] font-medium text-popover-foreground shadow-lg ring-1 ring-border peer-hover:block peer-focus-visible:block">
        {title}
      </span>
    </span>
  );
}
