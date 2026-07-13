import { AlertCircle, CalendarDays, ChevronLeft, ChevronRight, GraduationCap, Image, Loader2, RefreshCw, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Course, RecognizedAcademicCalendar, RecognizedCourseTimetable, SemesterWorkspace, TimetableEvent, TimetableViewMode } from "@/types/domain";
import { cx } from "@/lib/cn";
import { DropdownSelect } from "@/components/ui/DropdownSelect";
import { VisionRecognitionImportButton } from "@/components/vision/VisionRecognitionImportDialog";
import { SemesterManagementDialog } from "./SemesterManagementDialog";
import { semesterWeekNumberForRange } from "../../../shared/semester-weeks";

export function TimetableDialog({
  course,
  semesters,
  onSelectSemester,
  onWorkspaceChanged,
  onClose,
}: {
  course?: Course;
  semesters: SemesterWorkspace[];
  onSelectSemester?: (semesterId: string) => Promise<void> | void;
  onWorkspaceChanged?: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [viewMode, setViewMode] = useState<TimetableViewMode>("week");
  const [anchorDate, setAnchorDate] = useState(() => new Date());
  const [events, setEvents] = useState<TimetableEvent[]>([]);
  const [semester, setSemester] = useState<SemesterWorkspace | null>(null);
  const [managingSemesters, setManagingSemesters] = useState(false);
  const [semesterLoading, setSemesterLoading] = useState(false);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [semesterLoaded, setSemesterLoaded] = useState(false);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [showEventsLoading, setShowEventsLoading] = useState(false);
  const [semesterError, setSemesterError] = useState("");
  const [eventsError, setEventsError] = useState("");
  const eventsRequestRef = useRef(0);

  const range = useMemo(() => getRange(anchorDate, viewMode), [anchorDate, viewMode]);
  const scopedCourseId = course?.workspaceKind === "course" ? course.id : undefined;
  const weekNumber = useMemo(() => semesterWeekNumberForRange(semester, range.start, range.end), [semester, range.start, range.end]);
  const rangeSchoolEvents = useMemo(() => events
    .filter((event) => event.kind === "school_event" && eventOverlapsRange(event, range.start, range.end))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt)), [events, range.start, range.end]);
  const loadError = semesterError || eventsError;
  const initialContentLoading = !semesterLoaded || !eventsLoaded;

  useEffect(() => {
    void loadSemester();
  }, []);

  useEffect(() => {
    void loadEvents();
  }, [scopedCourseId, range.start.toISOString(), range.end.toISOString(), viewMode]);

  useEffect(() => {
    if (!eventsLoading) {
      setShowEventsLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowEventsLoading(true), 180);
    return () => window.clearTimeout(timer);
  }, [eventsLoading]);

  async function loadSemester() {
    setSemesterLoading(true);
    try {
      setSemester(await window.brevyn.semester.current());
      setSemesterError("");
    } catch (error) {
      setSemester(null);
      setSemesterError(errorMessage(error, "加载当前学期失败。"));
    } finally {
      setSemesterLoading(false);
      setSemesterLoaded(true);
    }
  }

  async function loadEvents() {
    const requestId = eventsRequestRef.current + 1;
    eventsRequestRef.current = requestId;
    setEventsLoading(true);
    try {
      const result = await window.brevyn.timetable.range({
        viewMode,
        rangeStart: range.start.toISOString(),
        rangeEnd: range.end.toISOString(),
        courseId: scopedCourseId,
        includeDeadlines: true,
        includeSchoolEvents: true,
      });
      if (eventsRequestRef.current !== requestId) return;
      setEvents(result);
      setEventsError("");
    } catch (error) {
      if (eventsRequestRef.current !== requestId) return;
      setEvents([]);
      setEventsError(errorMessage(error, "加载时间表事件失败。"));
    } finally {
      if (eventsRequestRef.current === requestId) {
        setEventsLoading(false);
        setEventsLoaded(true);
      }
    }
  }

  async function selectSemester(semesterId: string) {
    try {
      setSemesterError("");
      await onSelectSemester?.(semesterId);
      await Promise.all([loadSemester(), loadEvents()]);
    } catch (error) {
      setSemesterError(errorMessage(error, "切换学期失败。"));
    }
  }

  async function refreshWorkspace() {
    try {
      setSemesterError("");
      setEventsError("");
      await onWorkspaceChanged?.();
      await Promise.all([loadSemester(), loadEvents()]);
    } catch (error) {
      setSemesterError(errorMessage(error, "刷新时间表失败。"));
    }
  }

  async function handleVisionImported(draft: RecognizedAcademicCalendar | RecognizedCourseTimetable) {
    try {
      setSemesterError("");
      setEventsError("");
      await onWorkspaceChanged?.();
      if (draft.kind === "academic_calendar") {
        const importedSemester = draft.applied?.semester;
        const anchor = parseDateOnly(importedSemester?.startsAt || draft.semester?.startsAt);
        if (importedSemester?.id) await onSelectSemester?.(importedSemester.id);
        if (anchor) {
          setViewMode("week");
          setAnchorDate(anchor);
        }
      }
      await loadSemester();
      await loadEvents();
    } catch (error) {
      setSemesterError(errorMessage(error, "刷新时间表失败。"));
    }
  }

  async function goToToday() {
    const today = new Date();
    setAnchorDate(today);
    setViewMode("week");
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/18 p-1.5 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="brevyn-window-surface brevyn-dialog-window flex h-[96vh] max-h-[calc(100vh-12px)] w-[min(1760px,calc(100vw-12px))] max-w-none flex-col overflow-hidden">
        <div className="drag-region flex items-center justify-between bg-[hsl(var(--surface-chrome))] px-4 py-3 shadow-[inset_0_-1px_0_hsl(var(--border)/0.62)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CalendarDays className="h-4 w-4" />
              时间表
            </div>
            <div className="truncate text-[11px] text-muted-foreground">{semester?.term || "默认工作区"} · 学期、截止日期、校历事件和课程安排</div>
          </div>
          <button
            type="button"
            className="no-drag flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] bg-card text-muted-foreground shadow-sm ring-1 ring-black/[0.06] transition hover:bg-background hover:text-foreground active:scale-[0.98]"
            onClick={onClose}
            title="关闭时间表"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <div className="flex rounded-[var(--radius-control)] bg-background p-0.5 shadow-inner ring-1 ring-black/[0.04]">
              {(["week", "month", "year"] as TimetableViewMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={cx("h-7 rounded-[var(--radius-badge)] px-3 text-[11px] font-medium capitalize transition", viewMode === mode ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
                  onClick={() => setViewMode(mode)}
                >
                  {viewModeTabLabel(mode)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border bg-card px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
              onClick={() => void goToToday()}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              今天
            </button>
            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setAnchorDate(shiftDate(anchorDate, viewMode, -1))}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <div className="min-w-[250px] truncate text-center text-xs font-semibold">
              {viewMode === "week" && weekNumber ? `第 ${weekNumber} 周 · ` : ""}
              {range.label}
            </div>
            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground hover:bg-accent hover:text-foreground" onClick={() => setAnchorDate(shiftDate(anchorDate, viewMode, 1))}>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {(loadError || semesterLoading) && (
          <div className="flex items-center justify-between gap-3 border-b bg-muted/25 px-4 py-2 text-[11px] text-muted-foreground">
            <div className="flex min-w-0 items-center gap-2">
              {loadError ? <AlertCircle className="h-3.5 w-3.5 shrink-0 text-amber-600" /> : <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
              <span className="truncate">{loadError || "正在加载学期..."}</span>
            </div>
            {loadError && (
              <button
                type="button"
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-[var(--radius-control)] border bg-card px-2 text-[11px] font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
                onClick={() => void refreshWorkspace()}
              >
                <RefreshCw className="h-3 w-3" />
                重试
              </button>
            )}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden p-4">
          <div className="flex items-center justify-between gap-3 rounded-[var(--radius-card)] bg-background/70 px-3 py-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
            <div className="flex min-w-0 items-center gap-2">
              <GraduationCap className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="truncate text-xs font-semibold">{semester?.term || "未选择学期"}</div>
                <div className="truncate text-[11px] text-muted-foreground">{semester?.folderName || "学期文件夹"}</div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {semesters.length > 0 && (
                <div className="w-64">
                  <DropdownSelect
                    value={semester?.id || ""}
                    options={semesters.map((item) => ({
                      value: item.id,
                      label: item.term,
                      detail: item.folderName || "学期文件夹",
                    }))}
                    placeholder="选择学期"
                    disabled={semesterLoading}
                    ariaLabel="选择学期"
                    onChange={(value) => void selectSemester(value)}
                  />
                </div>
              )}
              <VisionRecognitionImportButton
                kind="academic_calendar"
                onImported={handleVisionImported}
              />
              <button
                type="button"
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border bg-card px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
                onClick={() => setManagingSemesters(true)}
              >
                <Settings2 className="h-3.5 w-3.5" />
                管理
              </button>
            </div>
          </div>

          <section className="grid min-h-0 flex-1 gap-3 md:grid-cols-[220px_minmax(0,1fr)]">
            <RangeEventRail events={initialContentLoading ? [] : rangeSchoolEvents} range={range} />
            <div className="min-h-0 overflow-hidden rounded-[var(--radius-card)] bg-background/70 p-4 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
              <div className="mb-3 flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-xs font-semibold">{viewModeLabel(viewMode)}</div>
                  {viewMode === "week" && (
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {weekNumber ? `第 ${weekNumber} 周` : "不在学期周范围内"} · 截止日期显示在时间表内，校历事件固定在左侧
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {showEventsLoading && !loadError && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      更新中
                    </span>
                  )}
                  <EventLegend />
                </div>
              </div>
              <div className="h-[calc(100%-34px)] min-h-0 overflow-hidden">
                {initialContentLoading ? (
                  <TimetableLoadingState />
                ) : (
                  <>
                    {viewMode === "week" && <WeekGrid start={range.start} events={events} weekNumber={weekNumber} />}
                    {viewMode === "month" && <MonthGrid anchor={anchorDate} events={events} />}
                    {viewMode === "year" && <YearGrid anchor={anchorDate} events={events} />}
                  </>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
      {managingSemesters && (
        <SemesterManagementDialog
          onSelectSemester={selectSemester}
          onWorkspaceChanged={refreshWorkspace}
          onClose={() => {
            setManagingSemesters(false);
            void refreshWorkspace();
          }}
        />
      )}
    </div>
  );
}

function TimetableLoadingState() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] bg-card/45 text-center text-xs text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      <div>
        <div className="font-medium text-foreground">正在加载时间表</div>
        <div className="mt-1">同步学期、校历和课程安排...</div>
      </div>
    </div>
  );
}

function WeekGrid({ start, events, weekNumber }: { start: Date; events: TimetableEvent[]; weekNumber?: number }) {
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index));
  const weekEnd = endOfDay(addDays(start, 6));
  const now = new Date();
  const showNowLine = now >= start && now <= weekEnd;
  const eventsByDay = days.map((day) => eventsForDay(events, day).filter((event) => event.kind !== "school_event" && event.kind !== "school_week"));
  const timedEventsByDay = eventsByDay.map((dayEvents) => dayEvents.filter(eventHasTime));
  const allDayEventsByDay = eventsByDay.map((dayEvents) => dayEvents.filter((event) => !eventHasTime(event)));
  const timeBounds = timetableHourBounds(timedEventsByDay.flat());
  const hourMarks = timeAxisHours(timeBounds);
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
      <div className="flex shrink-0 items-center justify-between rounded-[var(--radius-control)] bg-muted/25 px-3 py-2 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
        <div className="text-xs font-semibold">{weekNumber ? `第 ${weekNumber} 周` : "本周"}</div>
        <div className="text-[11px] text-muted-foreground">{formatShort(start)} - {formatShort(weekEnd)}</div>
      </div>
      <div className="grid shrink-0 grid-cols-[4.25rem_repeat(7,minmax(0,1fr))] gap-2">
        <div className="rounded-[var(--radius-control)] bg-card/55 px-2 py-2 text-center text-[10px] font-medium text-muted-foreground ring-1 ring-black/[0.035]">
          时间
        </div>
        {days.map((day, index) => {
          const isToday = isSameDay(day, now);
          const allDayEvents = allDayEventsByDay[index] || [];
          return (
            <div
              key={day.toISOString()}
              className={cx(
                "min-w-0 rounded-[var(--radius-control)] bg-card px-2 py-2 text-center shadow-[inset_0_0_0_1px_hsl(var(--border)/0.36)]",
                isToday && "bg-primary/10 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.46)]",
              )}
            >
              <div className="truncate text-[11px] font-semibold">{formatWeekday(day)}</div>
              <div className="truncate text-[10px] text-muted-foreground">{formatShort(day)}</div>
              {allDayEvents.length > 0 && (
                <div className="mt-1 flex flex-wrap justify-center gap-1">
                  {allDayEvents.slice(0, 2).map((event) => (
                    <span key={event.id} className={cx("max-w-full truncate rounded-[var(--radius-badge)] px-1.5 py-0.5 text-[9px]", eventTone(event.kind))}>
                      {event.title}
                    </span>
                  ))}
                  {allDayEvents.length > 2 && <span className="rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">+{allDayEvents.length - 2}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[4.25rem_repeat(7,minmax(0,1fr))] gap-2 overflow-hidden">
        <TimeAxis hourMarks={hourMarks} bounds={timeBounds} />
        {days.map((day, index) => {
          const isToday = isSameDay(day, now);
          const timedEvents = timedEventsByDay[index] || [];
          return (
            <div
              key={day.toISOString()}
              className={cx(
                "relative min-h-0 overflow-visible rounded-[var(--radius-control)] bg-card shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]",
                isToday && "bg-primary/5 shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.5)]",
              )}
            >
              <TimeGridLines bounds={timeBounds} />
              {showNowLine && isToday && <CurrentTimeLine bounds={timeBounds} />}
              {timedEvents.map((event) => (
                <TimedEventBlock key={event.id} event={event} bounds={timeBounds} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type TimetableHourBounds = {
  startHour: number;
  endHour: number;
};

function TimeAxis({ hourMarks, bounds }: { hourMarks: number[]; bounds: TimetableHourBounds }) {
  return (
    <div className="relative min-h-0 overflow-hidden rounded-[var(--radius-control)] bg-card/55 text-[10px] text-muted-foreground ring-1 ring-black/[0.035]">
      {hourMarks.map((hour) => (
        <div
          key={hour}
          className="absolute left-0 right-0 flex -translate-y-1/2 items-center justify-center"
          style={{ top: timeAxisTop(hour, bounds) }}
        >
          <span className="rounded-[var(--radius-badge)] bg-background px-1.5 py-0.5 shadow-sm ring-1 ring-black/[0.035]">
            {String(hour).padStart(2, "0")}:00
          </span>
        </div>
      ))}
    </div>
  );
}

function TimeGridLines({ bounds }: { bounds: TimetableHourBounds }) {
  const hourMarks = timeAxisHours(bounds);
  return (
    <div className="pointer-events-none absolute inset-0">
      {hourMarks.map((hour) => (
        <div
          key={hour}
          className="absolute left-0 right-0 border-t border-border/45"
          style={{ top: timeAxisTop(hour, bounds) }}
        />
      ))}
    </div>
  );
}

function TimedEventBlock({ event, bounds }: { event: TimetableEvent; bounds: TimetableHourBounds }) {
  const position = timedEventPosition(event, bounds);
  const title = compactCourseTitle(event.title);
  const details = [formatTime(event.startsAt), event.endsAt ? formatTime(event.endsAt) : "", event.title, event.location].filter(Boolean).join(" · ");
  return (
    <div
      className={cx("group absolute left-1 right-1 z-10 flex items-start overflow-visible rounded-[var(--radius-control)] px-2 py-1 text-[10px] leading-[13px] shadow-sm ring-1 ring-black/[0.04] hover:z-30", eventTone(event.kind))}
      style={position}
      title={details}
    >
      <div className="line-clamp-2 break-words font-semibold">{title}</div>
      <div className="pointer-events-none absolute left-0 top-full z-40 mt-1 hidden max-w-[16rem] rounded-[var(--radius-control)] bg-popover px-2.5 py-2 text-[10px] font-semibold leading-4 text-popover-foreground shadow-lg ring-1 ring-black/[0.08] group-hover:block">
        {title}
      </div>
    </div>
  );
}

function timetableHourBounds(events: TimetableEvent[]): TimetableHourBounds {
  const minutes = events.flatMap((event) => {
    const start = minuteOfDay(event.startsAt);
    const end = minuteOfDay(event.endsAt || event.startsAt);
    return [start, end].filter((value): value is number => value !== undefined);
  });
  const earliest = minutes.length > 0 ? Math.min(...minutes) : 8 * 60;
  const latest = minutes.length > 0 ? Math.max(...minutes) : 22 * 60;
  const startHour = Math.max(0, Math.min(8, Math.floor(earliest / 60)));
  const endHour = Math.min(24, Math.max(22, Math.ceil(latest / 60)));
  return { startHour, endHour: Math.max(startHour + 1, endHour) };
}

function timeAxisHours(bounds: TimetableHourBounds): number[] {
  return Array.from({ length: bounds.endHour - bounds.startHour + 1 }, (_, index) => bounds.startHour + index);
}

function timedEventPosition(event: TimetableEvent, bounds: TimetableHourBounds): { top: string; height: string } {
  const startMinute = bounds.startHour * 60;
  const endMinute = bounds.endHour * 60;
  const total = endMinute - startMinute;
  const rawStart = minuteOfDay(event.startsAt) ?? startMinute;
  const rawEnd = minuteOfDay(event.endsAt || event.startsAt) ?? rawStart + 60;
  const clampedStart = clamp(rawStart, startMinute, endMinute);
  const clampedEnd = clamp(Math.max(rawEnd, rawStart + 30), startMinute, endMinute);
  return {
    top: timeAxisTopFromProgress((clampedStart - startMinute) / total),
    height: `calc(${Math.max(6, ((clampedEnd - clampedStart) / total) * 100)}% - 0.25rem)`,
  };
}

function eventHasTime(event: TimetableEvent): boolean {
  return minuteOfDay(event.startsAt) !== undefined;
}

function minuteOfDay(value?: string): number | undefined {
  const match = value?.match(/T(\d{2}):(\d{2})/);
  if (!match) return undefined;
  return Number(match[1]) * 60 + Number(match[2]);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function timeAxisTop(hour: number, bounds: TimetableHourBounds): string {
  return timeAxisTopFromProgress((hour - bounds.startHour) / (bounds.endHour - bounds.startHour));
}

function timeAxisTopFromProgress(progress: number): string {
  const clamped = clamp(progress, 0, 1);
  return `calc(0.9rem + (100% - 1.8rem) * ${clamped})`;
}

function compactCourseTitle(title: string): string {
  const segments = title.split(/\s*[·|]\s*/).map((item) => item.trim()).filter(Boolean);
  return segments.length > 1 ? segments.slice(1).join(" · ") : title;
}

function MonthGrid({ anchor, events }: { anchor: Date; events: TimetableEvent[] }) {
  const days = monthDays(anchor);
  const today = new Date();
  return (
    <div className="grid h-full min-h-0 grid-cols-7 grid-rows-6 gap-1.5 overflow-hidden">
      {days.map((day) => {
        const dayEvents = eventsForDay(events, day);
        const hasSchoolEvent = dayEvents.some((event) => event.kind === "school_event");
        return (
          <div
            key={day.toISOString()}
            className={cx(
              "min-h-0 overflow-hidden rounded-[var(--radius-control)] border bg-card px-2 py-1.5",
              hasSchoolEvent && "border-emerald-200 bg-emerald-50/45",
              isSameDay(day, today) && "border-primary/40 bg-primary/10",
            )}
          >
            <div className={cx("flex items-center justify-between gap-1 text-[10px] font-medium text-muted-foreground", isSameDay(day, today) && "text-primary")}>
              <span>{day.getDate()}</span>
              {hasSchoolEvent && <span className="h-1.5 w-1.5 rounded-[var(--radius-pill)] bg-emerald-500" />}
            </div>
            <div className="mt-1 space-y-1">
              {dayEvents
                .filter((event) => event.kind !== "school_event" && event.kind !== "school_week")
                .slice(0, 3)
                .map((event) => (
                  <div key={event.id} className={cx("truncate rounded-[var(--radius-badge)] px-1.5 py-0.5 text-[10px]", eventTone(event.kind))}>{event.title}</div>
                ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function YearGrid({ anchor, events }: { anchor: Date; events: TimetableEvent[] }) {
  const year = anchor.getFullYear();
  return (
    <div className="grid h-full min-h-0 grid-cols-4 grid-rows-3 gap-2 overflow-hidden">
      {Array.from({ length: 12 }, (_, month) => {
        const monthEvents = events.filter((event) => {
          if (event.kind === "school_week") return false;
          const date = parseDateOnly(event.startsAt) || new Date(event.startsAt);
          return date.getFullYear() === year && date.getMonth() === month;
        });
        const monthStart = new Date(year, month, 1);
        const monthDaysCount = new Date(year, month + 1, 0).getDate();
        return (
          <div key={month} className="min-h-0 overflow-hidden rounded-[var(--radius-control)] border bg-card px-3 py-2">
            <div className="mb-2 text-xs font-semibold">{monthStart.toLocaleString("zh-CN", { month: "short" })}</div>
            <div className="grid grid-cols-7 gap-1">
              {Array.from({ length: monthDaysCount }, (_, index) => {
                const day = new Date(year, month, index + 1);
                const dayEvents = eventsForDay(monthEvents, day);
                const hasSchoolEvent = dayEvents.some((event) => event.kind === "school_event");
                const hasDeadline = dayEvents.some((event) => event.kind === "deadline");
                const hasCourseSession = dayEvents.some((event) => event.kind === "course_session");
                return (
                  <div
                    key={index}
                    className={cx(
                      "flex h-5 items-center justify-center rounded-[var(--radius-badge)] text-[9px] text-muted-foreground",
                      hasSchoolEvent ? "bg-emerald-100 text-emerald-900 ring-1 ring-emerald-200" : hasDeadline ? "bg-amber-100 text-amber-900" : hasCourseSession ? "bg-blue-100 text-blue-900" : "",
                    )}
                  >
                    {index + 1}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EventCard({ event, compact = false }: { event: TimetableEvent; compact?: boolean }) {
  const meta = eventMeta(event);
  return (
    <div className={cx("rounded-[var(--radius-control)] border px-2 py-2 text-[11px] leading-4", eventTone(event.kind), compact && "py-1.5")}>
      {meta && <div className="font-semibold">{meta}</div>}
      <div className={cx("font-medium", meta && "mt-1")}>{event.title}</div>
      {!compact && event.location && <div className="mt-1 opacity-75">{event.location}</div>}
    </div>
  );
}

function EventLegend() {
  return (
    <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
      <span className="rounded-[var(--radius-badge)] bg-blue-50 px-1.5 py-0.5 text-blue-900">课程</span>
      <span className="rounded-[var(--radius-badge)] bg-amber-50 px-1.5 py-0.5 text-amber-900">截止</span>
      <span className="rounded-[var(--radius-badge)] bg-emerald-50 px-1.5 py-0.5 text-emerald-900">校历</span>
    </div>
  );
}

function RangeEventRail({ events, range }: { events: TimetableEvent[]; range: { start: Date; end: Date; label: string } }) {
  return (
    <aside className="min-h-0 overflow-hidden rounded-[var(--radius-card)] bg-background/70 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
      <div className="flex items-center justify-between border-b bg-muted/25 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-semibold">
          <Image className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">事件</span>
        </div>
        <span className="shrink-0 text-[10px] text-muted-foreground">{events.length}</span>
      </div>
      <div className="border-b px-3 py-2 text-[11px] text-muted-foreground">{range.label}</div>
      <div className="h-full min-h-0 space-y-2 overflow-y-auto p-3 brevyn-scrollbar">
        {events.map((event) => (
          <div key={event.id} className="rounded-[var(--radius-control)] border border-emerald-100 bg-emerald-50 px-2.5 py-2 text-[11px] leading-4 text-emerald-950">
            <div className="font-semibold">{eventDateRange(event)}</div>
            <div className="mt-1 font-medium">{event.title}</div>
            {event.notes && <div className="mt-1 line-clamp-2 opacity-75">{event.notes}</div>}
          </div>
        ))}
        {events.length === 0 && (
          <div className="rounded-[var(--radius-control)] border border-dashed bg-card px-3 py-5 text-center text-xs leading-5 text-muted-foreground">
            当前范围内没有校历事件。
          </div>
        )}
      </div>
    </aside>
  );
}

function getRange(anchor: Date, mode: TimetableViewMode) {
  if (mode === "week") {
    const start = startOfWeek(anchor);
    const end = endOfDay(addDays(start, 6));
    return { start, end, label: `${formatShort(start)} - ${formatShort(end)}` };
  }
  if (mode === "month") {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const end = endOfDay(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0));
    return { start, end, label: start.toLocaleString("zh-CN", { month: "long", year: "numeric" }) };
  }
  const start = new Date(anchor.getFullYear(), 0, 1);
  const end = endOfDay(new Date(anchor.getFullYear(), 11, 31));
  return { start, end, label: String(anchor.getFullYear()) };
}

function shiftDate(date: Date, mode: TimetableViewMode, amount: number) {
  const next = new Date(date);
  if (mode === "week") next.setDate(next.getDate() + amount * 7);
  if (mode === "month") next.setMonth(next.getMonth() + amount);
  if (mode === "year") next.setFullYear(next.getFullYear() + amount);
  return next;
}

function monthDays(anchor: Date) {
  const first = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
  return Array.from({ length: 42 }, (_, index) => addDays(first, index));
}

function eventsForDay(events: TimetableEvent[], day: Date) {
  const dayStart = startOfDay(day);
  const dayEnd = endOfDay(day);
  return events.filter((event) => eventOverlapsRange(event, dayStart, dayEnd));
}

function eventOverlapsRange(event: TimetableEvent, start: Date, end: Date) {
  const eventStart = parseDateOnly(event.startsAt) || new Date(event.startsAt);
  const eventEnd = parseDateOnly(event.endsAt || event.startsAt) || new Date(event.endsAt || event.startsAt);
  return eventStart <= end && endOfDay(eventEnd) >= start;
}

function CurrentTimeLine({ bounds }: { bounds: TimetableHourBounds }) {
  const now = new Date();
  const startMinute = bounds.startHour * 60;
  const endMinute = bounds.endHour * 60;
  const currentMinute = now.getHours() * 60 + now.getMinutes();
  if (currentMinute < startMinute || currentMinute > endMinute) return null;
  const progress = (currentMinute - startMinute) / (endMinute - startMinute);
  return (
    <div className="pointer-events-none absolute left-0 right-0 z-10" style={{ top: timeAxisTopFromProgress(progress) }}>
      <div className="flex items-center">
        <div className="ml-1 h-2 w-2 rounded-[var(--radius-pill)] bg-primary" />
        <div className="h-px flex-1 bg-primary" />
      </div>
    </div>
  );
}

function startOfWeek(date: Date) {
  const next = new Date(date);
  const day = next.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + diff);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function endOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function formatDay(date: Date) {
  return date.toLocaleDateString("zh-CN", { weekday: "short", month: "short", day: "numeric" });
}

function formatWeekday(date: Date) {
  return date.toLocaleDateString("zh-CN", { weekday: "short" });
}

function formatShort(date: Date) {
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function formatMonthLabel(date: Date) {
  return date.toLocaleDateString("zh-CN", { month: "long" });
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function eventDateRange(event: TimetableEvent) {
  const start = parseDateOnly(event.startsAt) || new Date(event.startsAt);
  const end = parseDateOnly(event.endsAt || event.startsAt) || new Date(event.endsAt || event.startsAt);
  if (isSameDay(start, end)) return formatShort(start);
  return `${formatShort(start)} - ${formatShort(end)}`;
}

function eventMeta(event: TimetableEvent) {
  if (event.kind === "course_session") return formatTime(event.startsAt);
  if (event.kind === "deadline") return "截止日期";
  if (event.kind === "school_week") return event.endsAt ? `${formatShort(parseDateOnly(event.startsAt) || new Date(event.startsAt))} - ${formatShort(parseDateOnly(event.endsAt) || new Date(event.endsAt))}` : "周";
  return event.endsAt && event.endsAt !== event.startsAt ? `${formatShort(parseDateOnly(event.startsAt) || new Date(event.startsAt))} - ${formatShort(parseDateOnly(event.endsAt) || new Date(event.endsAt))}` : "全天";
}

function parseDateOnly(value?: string) {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function viewModeLabel(mode: TimetableViewMode) {
  if (mode === "week") return "周视图";
  if (mode === "month") return "月视图";
  return "年视图";
}

function viewModeTabLabel(mode: TimetableViewMode) {
  if (mode === "week") return "Week";
  if (mode === "month") return "Month";
  return "Year";
}

function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "").trim();
  return message || fallback;
}

function kindLabel(kind: TimetableEvent["kind"]) {
  if (kind === "course_session") return "课程";
  if (kind === "deadline") return "截止日期";
  if (kind === "school_week") return "周";
  return "校历";
}

function eventTone(kind: TimetableEvent["kind"]) {
  if (kind === "deadline") return "border-amber-100 bg-amber-50 text-amber-950";
  if (kind === "school_week") return "border-slate-200 bg-slate-50 text-slate-800";
  if (kind === "school_event") return "border-emerald-100 bg-emerald-50 text-emerald-950";
  return "border-blue-100 bg-blue-50 text-blue-950";
}
