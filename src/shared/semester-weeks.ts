import type { SemesterWorkspace } from "../types/domain";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_MANUAL_WEEK_COUNT = 30;

type SemesterDateRange = Pick<SemesterWorkspace, "startsAt" | "endsAt">;
type SemesterWeekConfig = Pick<SemesterWorkspace, "startsAt" | "endsAt" | "weekCount">;

export interface SemesterWeekRange {
  weekNumber: number;
  startsAt: string;
  endsAt: string;
}

export function semesterWeekRanges(semester?: SemesterDateRange | null): SemesterWeekRange[] {
  const start = parseDateOnly(semester?.startsAt);
  const end = parseDateOnly(semester?.endsAt);
  if (!start || !end || end < start) return [];
  const ranges: SemesterWeekRange[] = [];
  for (let weekStart = start, weekNumber = 1; weekStart <= end; weekStart = addDays(weekStart, 7), weekNumber += 1) {
    const weekEnd = minDate(addDays(weekStart, 6), end);
    ranges.push({
      weekNumber,
      startsAt: formatDateOnly(weekStart),
      endsAt: formatDateOnly(weekEnd),
    });
  }
  return ranges;
}

export function semesterWeekNumbers(semester?: SemesterDateRange | null): number[] {
  return semesterWeekRanges(semester).map((range) => range.weekNumber);
}

export function semesterLectureWeekNumbers(semester?: SemesterWeekConfig | null): number[] {
  const weekCount = normalizedSemesterWeekCount(semester?.weekCount);
  if (weekCount) return Array.from({ length: weekCount }, (_item, index) => index + 1);
  return semesterWeekNumbers(semester);
}

export function normalizedSemesterWeekCount(value?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const weekCount = Math.trunc(value);
  if (weekCount < 1) return undefined;
  return Math.min(weekCount, MAX_MANUAL_WEEK_COUNT);
}

export function semesterWeekNumberForDate(semester: SemesterDateRange | null | undefined, value: Date | string): number | undefined {
  const day = typeof value === "string" ? parseDateOnly(value) : startOfDay(value);
  if (!day) return undefined;
  return semesterWeekRanges(semester).find((range) => {
    const start = parseDateOnly(range.startsAt);
    const end = parseDateOnly(range.endsAt);
    return Boolean(start && end && day >= start && day <= end);
  })?.weekNumber;
}

export function semesterWeekNumberForRange(
  semester: SemesterDateRange | null | undefined,
  startValue: Date | string,
  endValue: Date | string,
): number | undefined {
  const targetStart = typeof startValue === "string" ? parseDateOnly(startValue) : startOfDay(startValue);
  const targetEnd = typeof endValue === "string" ? parseDateOnly(endValue) : startOfDay(endValue);
  if (!targetStart || !targetEnd || targetEnd < targetStart) return undefined;
  let selectedWeek: number | undefined;
  let longestOverlap = 0;
  for (const range of semesterWeekRanges(semester)) {
    const weekStart = parseDateOnly(range.startsAt);
    const weekEnd = parseDateOnly(range.endsAt);
    if (!weekStart || !weekEnd) continue;
    const overlapStart = weekStart > targetStart ? weekStart : targetStart;
    const overlapEnd = weekEnd < targetEnd ? weekEnd : targetEnd;
    const overlap = overlapEnd >= overlapStart ? Math.floor((overlapEnd.getTime() - overlapStart.getTime()) / DAY_MS) + 1 : 0;
    if (overlap > longestOverlap) {
      longestOverlap = overlap;
      selectedWeek = range.weekNumber;
    }
  }
  return selectedWeek;
}

export function normalizedWeekNumber(value?: number, allowedWeeks?: number[]): number | undefined {
  if (!Number.isInteger(value) || !value || value < 1) return undefined;
  if (allowedWeeks && allowedWeeks.length > 0 && !allowedWeeks.includes(value)) return undefined;
  return value;
}

export function lectureWeekFolderName(weekNumber: number): string {
  return `Week ${weekNumber}`;
}

export function lectureWeekNumberFromFolderName(value: string): number | undefined {
  const match = /^\s*(?:week|wk|第)?\s*(\d{1,2})\s*(?:周)?\s*$/i.exec(value);
  return match ? normalizedWeekNumber(Number(match[1])) : undefined;
}

export function lectureWeekNumberFromPath(value: string): number | undefined {
  const normalizedPath = value.replace(/\\/g, "/");
  const match = /(?:^|\/)((?:Week|Wk|第)\s*\d{1,2}\s*(?:周)?)(?:\/|$)/i.exec(normalizedPath);
  return match ? lectureWeekNumberFromFolderName(match[1]) : undefined;
}

export function parseDateOnly(value?: string): Date | undefined {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setHours(0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatDateOnly(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function startOfDay(date: Date): Date {
  const normalized = new Date(date);
  normalized.setHours(0, 0, 0, 0);
  return normalized;
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function minDate(a: Date, b: Date): Date {
  return a <= b ? a : b;
}
