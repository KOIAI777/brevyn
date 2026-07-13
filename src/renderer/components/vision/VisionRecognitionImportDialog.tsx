import { AlertCircle, CalendarDays, Check, ChevronDown, GraduationCap, ImagePlus, Loader2, Upload, X } from "lucide-react";
import { useMemo, useState } from "react";
import { CourseIcon, COURSE_ICON_OPTIONS } from "@/components/courses/CourseIcon";
import type { CourseIconKey, RecognizedAcademicCalendar, RecognizedCourseSchedule, RecognizedCourseTimetable, VisionRecognitionKind } from "@/types/domain";
import { cx } from "@/lib/cn";
import { matchCourseIcon } from "../../../shared/course-icon-matcher";
import { semesterWeekRanges } from "../../../shared/semester-weeks";

type VisionDraft = RecognizedAcademicCalendar | RecognizedCourseTimetable;

export function VisionRecognitionImportButton({
  kind,
  className,
  variant = "default",
  onImported,
}: {
  kind: VisionRecognitionKind;
  className?: string;
  variant?: "default" | "primary";
  onImported?: (draft: VisionDraft) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={cx(
          "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium transition",
          variant === "primary"
            ? "border-transparent bg-foreground text-background hover:bg-foreground hover:text-background hover:opacity-90"
            : "bg-card text-muted-foreground hover:bg-accent hover:text-foreground",
          className,
        )}
        onClick={() => setOpen(true)}
      >
        <ImagePlus className="h-3.5 w-3.5" />
        {kind === "course_timetable" ? "识别课表" : "识别校历"}
      </button>
      {open && (
        <VisionRecognitionImportDialog
          kind={kind}
          onImported={onImported}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function VisionRecognitionImportDialog({
  kind,
  onImported,
  onClose,
}: {
  kind: VisionRecognitionKind;
  onImported?: (draft: VisionDraft) => Promise<void> | void;
  onClose: () => void;
}) {
  const [sourcePath, setSourcePath] = useState("");
  const [imagePreviewUrl, setImagePreviewUrl] = useState("");
  const [draft, setDraft] = useState<VisionDraft | null>(null);
  const [showRawDraft, setShowRawDraft] = useState(false);
  const [busy, setBusy] = useState<"picking" | "recognizing" | "importing" | "">("");
  const [error, setError] = useState("");
  const canImport = Boolean(draft && !busy);
  const rawDraftText = useMemo(() => (showRawDraft && draft ? JSON.stringify(draft, null, 2) : ""), [draft, showRawDraft]);

  function updateDraft(nextDraft: VisionDraft) {
    const clean = withoutApplied(nextDraft);
    setDraft(clean);
  }

  async function pickAndRecognize() {
    setBusy("picking");
    setError("");
    setDraft(null);
    setImagePreviewUrl("");
    setShowRawDraft(false);
    try {
      const path = await window.brevyn.vision.pickImage();
      if (!path) return;
      setSourcePath(path);
      try {
        setImagePreviewUrl(await window.brevyn.vision.previewImage(path));
      } catch (reason) {
        setError(errorMessage(reason, "图片预览失败，但仍可继续识别。"));
      }
      setBusy("recognizing");
      const result = kind === "course_timetable"
        ? await window.brevyn.vision.recognizeCourseTimetable({ sourcePath: path })
        : await window.brevyn.vision.recognizeAcademicCalendar({ sourcePath: path });
      const clean = withoutApplied(result);
      updateDraft(clean);
    } catch (reason) {
      setError(errorMessage(reason, "视觉识别失败。"));
    } finally {
      setBusy("");
    }
  }

  async function importDraft() {
    if (!draft) {
      setError("识别草稿还没有准备好。");
      return;
    }
    setBusy("importing");
    setError("");
    try {
      const imported = draft.kind === "course_timetable"
        ? await window.brevyn.vision.importCourseTimetable(draft)
        : await window.brevyn.vision.importAcademicCalendar(draft);
      updateDraft(imported);
      await onImported?.(imported);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason, "导入识别结果失败。"));
    } finally {
      setBusy("");
    }
  }

  const title = kind === "course_timetable" ? "课程表识别" : "校历识别";
  const subtitle = kind === "course_timetable" ? "确认后创建课程和每周上课安排。" : "确认后创建学期校历事件。";

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-foreground/18 p-6 backdrop-blur-[2px]">
      <div className="isolate flex h-[82vh] w-[min(1180px,calc(100vw-48px))] flex-col overflow-hidden rounded-lg border bg-card shadow-2xl ring-1 ring-border/80 [contain:layout_paint_style]">
        <div className="drag-region flex items-center justify-between border-b bg-muted/25 px-4 py-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              {kind === "course_timetable" ? <GraduationCap className="h-4 w-4" /> : <CalendarDays className="h-4 w-4" />}
              {title}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">{subtitle}</div>
          </div>
          <button
            type="button"
            className="no-drag flex h-8 w-8 items-center justify-center rounded-md border bg-background/70 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            onClick={onClose}
            title="关闭识别窗口"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
          <div className="min-w-0 text-[11px] text-muted-foreground">
            {sourcePath ? <span className="block truncate">{sourcePath}</span> : "选择图片开始识别。确认导入前不会写入任何数据。"}
          </div>
          <button
            type="button"
            className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background disabled:cursor-not-allowed disabled:opacity-50"
            onClick={pickAndRecognize}
            disabled={Boolean(busy)}
          >
            {busy === "picking" || busy === "recognizing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {busy === "recognizing" ? "正在识别..." : "选择图片"}
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-b border-[hsl(var(--status-warning)/0.2)] bg-[hsl(var(--status-warning)/0.11)] px-4 py-2 text-[11px] leading-5 text-[hsl(var(--status-warning))]">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        )}

        <div className="grid min-h-0 flex-1 items-stretch gap-4 overflow-hidden p-4 md:grid-cols-[0.9fr_1.1fr]">
          <section className="min-h-0 overflow-hidden rounded-lg border bg-background [contain:layout_paint]">
            {imagePreviewUrl ? (
              <img src={imagePreviewUrl} alt="识别图片" className="h-full w-full select-none object-contain [backface-visibility:hidden] [transform:translateZ(0)]" draggable={false} />
            ) : sourcePath ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-xs text-muted-foreground">
                <AlertCircle className="h-5 w-5" />
                无法预览图片，但仍可继续识别。
              </div>
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-muted-foreground">
                <ImagePlus className="h-8 w-8" />
                请选择课程表或校历截图。
              </div>
            )}
          </section>

          <section className="isolate flex min-h-0 flex-col overflow-hidden rounded-lg border bg-background/70 [contain:layout_paint]">
            {busy === "recognizing" ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                视觉模型正在读取图片...
              </div>
            ) : draft ? (
              <>
                <RecognitionSummary draft={draft} />
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain border-t p-3 [contain:layout_paint] [scrollbar-gutter:stable] brevyn-scrollbar">
                  <RecognitionStructuredReview draft={draft} onChange={updateDraft} />
                </div>
                <div className="border-t bg-card/50">
                  <button
                    type="button"
                    className="flex h-9 w-full items-center justify-between px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
                    onClick={() => setShowRawDraft((value) => !value)}
                  >
                    <span>原始结果</span>
                    <ChevronDown className={cx("h-3.5 w-3.5 transition-transform", showRawDraft && "rotate-180")} />
                  </button>
                  {showRawDraft && (
                    <textarea
                      className="h-44 w-full resize-none border-t bg-card/60 p-3 font-mono text-[11px] leading-5 outline-none brevyn-scrollbar"
                      value={rawDraftText}
                      spellCheck={false}
                      readOnly
                    />
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
                <CalendarDays className="h-7 w-7" />
                识别结果会显示在这里，确认后再导入。
              </div>
            )}
          </section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
          <div className="text-[11px] text-muted-foreground">
            {draft ? "请检查结构化结果，确认无误后导入。" : "暂无识别结果。"}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="h-8 rounded-md border bg-background px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-foreground px-3 text-xs font-medium text-background disabled:cursor-not-allowed disabled:opacity-50"
              onClick={importDraft}
              disabled={!canImport}
            >
              {busy === "importing" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {busy === "importing" ? "正在导入..." : "确认导入"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecognitionSummary({ draft }: { draft: VisionDraft }) {
  const warnings = draft.warnings || [];
  if (draft.kind === "course_timetable") {
    const sessions = draft.courses.reduce((total, course) => total + course.sessions.length, 0);
    return (
      <div className="space-y-3 p-3">
        <SummaryPills items={[`${draft.courses.length} 门课程`, `${sessions} 个上课安排`, draft.applied?.events ? `${draft.applied.events.length} 个事件` : "导入后生成事件", draft.semesterLabel || "未识别学期"]} />
        <Warnings warnings={warnings} />
      </div>
    );
  }
  const weeks = weekCount(draft.semester?.startsAt, draft.semester?.endsAt);
  return (
    <div className="space-y-3 p-3">
      <SummaryPills items={[draft.semester?.term || "未识别学期", `${draft.events.length} 个事件`, weeks ? `${weeks} 周` : "未识别周范围", `${warnings.length} 条提醒`]} />
      <Warnings warnings={warnings} />
    </div>
  );
}

function SummaryPills({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className="rounded-full border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground">{item}</span>
      ))}
    </div>
  );
}

function Warnings({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return <div className="rounded-md border border-[hsl(var(--status-success)/0.2)] bg-[hsl(var(--status-success)/0.11)] px-2 py-1.5 text-[11px] text-[hsl(var(--status-success))]">模型没有返回提醒。</div>;
  return (
    <div className="max-h-24 space-y-1 overflow-y-auto rounded-md border border-[hsl(var(--status-warning)/0.2)] bg-[hsl(var(--status-warning)/0.11)] px-2 py-1.5 text-[11px] leading-5 text-[hsl(var(--status-warning))] brevyn-scrollbar">
      {warnings.map((warning, index) => <div key={`${index}-${warning}`}>{warning}</div>)}
    </div>
  );
}

function RecognitionStructuredReview({ draft, onChange }: { draft: VisionDraft; onChange: (draft: VisionDraft) => void }) {
  if (draft.kind === "course_timetable") {
    return <CourseTimetableReview draft={draft} onChange={(next) => onChange(next)} />;
  }
  return <AcademicCalendarReview draft={draft} onChange={(next) => onChange(next)} />;
}

function CourseTimetableReview({ draft, onChange }: { draft: RecognizedCourseTimetable; onChange: (draft: RecognizedCourseTimetable) => void }) {
  if (draft.courses.length === 0) {
    return <EmptyReview label="没有识别到课程。" />;
  }
  function updateCourse(courseIndex: number, patch: Partial<RecognizedCourseTimetable["courses"][number]>) {
    onChange({
      ...draft,
      courses: draft.courses.map((course, index) => index === courseIndex ? { ...course, ...patch } : course),
    });
  }

  function updateSession(courseIndex: number, sessionIndex: number, patch: Partial<RecognizedCourseTimetable["courses"][number]["sessions"][number]>) {
    onChange({
      ...draft,
      courses: draft.courses.map((course, index) => {
        if (index !== courseIndex) return course;
        return {
          ...course,
          sessions: course.sessions.map((session, innerIndex) => innerIndex === sessionIndex ? { ...session, ...patch } : session),
        };
      }),
    });
  }

  return (
    <div className="space-y-3">
      {draft.courses.map((course, courseIndex) => (
        <div key={`course-${courseIndex}`} className="overflow-hidden rounded-lg border bg-card/70">
          <div className="space-y-2 border-b bg-muted/30 px-3 py-2">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 text-xs font-semibold">课程 {courseIndex + 1}</div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                <CourseIconPicker
                  value={resolvedCourseIcon(course)}
                  automatic={!course.icon}
                  onChange={(icon) => updateCourse(courseIndex, { icon })}
                />
                {course.confidence !== undefined && <ConfidenceBadge value={course.confidence} />}
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-[0.7fr_1.3fr]">
              <EditableField label="课程代码" value={course.code} onChange={(value) => updateCourse(courseIndex, { code: value })} />
              <EditableField label="课程名称" value={stripSectionLabel(course.name, course.section)} onChange={(value) => updateCourse(courseIndex, { name: value })} />
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <EditableField label="班级" value={course.section || ""} onChange={(value) => updateCourse(courseIndex, { section: value || undefined })} />
              <EditableField label="教师" value={course.instructor || ""} onChange={(value) => updateCourse(courseIndex, { instructor: value || undefined })} />
              <EditableField label="学分" value={course.units === undefined ? "" : String(course.units)} onChange={(value) => updateCourse(courseIndex, { units: numberOrUndefined(value) })} />
            </div>
          </div>
          {course.sessions.length > 0 ? (
            <div className="overflow-x-auto p-3">
              <div className="min-w-[540px] space-y-1.5 text-[11px]">
                <div className="grid grid-cols-[64px_minmax(130px,1fr)_minmax(96px,0.75fr)_minmax(150px,1fr)_52px] gap-2 px-1 text-[10px] font-medium text-muted-foreground">
                  <div>星期</div>
                  <div>时间</div>
                  <div>教室</div>
                  <div>周次</div>
                  <div className="text-right">置信度</div>
                </div>
                {course.sessions.map((session, index) => (
                  <div key={`session-${courseIndex}-${index}`} className="grid grid-cols-[64px_minmax(130px,1fr)_minmax(96px,0.75fr)_minmax(150px,1fr)_52px] items-center gap-2 rounded-md border bg-background/65 p-2">
                    <select className={editableClassName} value={session.dayOfWeek} onChange={(event) => updateSession(courseIndex, index, { dayOfWeek: event.target.value as typeof session.dayOfWeek })}>
                      {["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((day) => <option key={day} value={day}>{weekdayLabel(day)}</option>)}
                    </select>
                    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-1">
                      <input className={editableClassName} value={session.startTime} onChange={(event) => updateSession(courseIndex, index, { startTime: event.target.value })} />
                      <span className="text-muted-foreground">-</span>
                      <input className={editableClassName} value={session.endTime} onChange={(event) => updateSession(courseIndex, index, { endTime: event.target.value })} />
                    </div>
                    <input className={editableClassName} value={session.room || ""} onChange={(event) => updateSession(courseIndex, index, { room: event.target.value || undefined })} />
                    <input className={editableClassName} value={session.weeks || ""} placeholder="全部周次" onChange={(event) => updateSession(courseIndex, index, { weeks: event.target.value || undefined })} />
                    <div className="text-right text-muted-foreground">{formatConfidence(session.confidence)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="px-3 py-3 text-[11px] text-muted-foreground">这门课没有识别到每周上课安排。</div>
          )}
        </div>
      ))}
    </div>
  );
}

function AcademicCalendarReview({ draft, onChange }: { draft: RecognizedAcademicCalendar; onChange: (draft: RecognizedAcademicCalendar) => void }) {
  const weeks = calendarWeekRows(draft.semester?.startsAt, draft.semester?.endsAt, draft.events);

  function updateSemester(patch: Partial<NonNullable<RecognizedAcademicCalendar["semester"]>>) {
    onChange({ ...draft, semester: { ...(draft.semester || { term: "" }), ...patch } });
  }

  function updateEvent(eventIndex: number, patch: Partial<RecognizedAcademicCalendar["events"][number]>) {
    onChange({
      ...draft,
      events: draft.events.map((event, index) => index === eventIndex ? { ...event, ...patch } : event),
    });
  }

  return (
    <div className="space-y-3">
      {draft.semester && (
        <div className="space-y-2 rounded-lg border bg-card/70 px-3 py-2">
          <div className="text-xs font-semibold">学期</div>
          <div className="grid gap-2 md:grid-cols-2">
            <EditableField label="学期名称" value={draft.semester.term || ""} onChange={(value) => updateSemester({ term: value })} />
            <EditableField label="文件夹" value={draft.semester.folderName || ""} onChange={(value) => updateSemester({ folderName: value || undefined })} />
            <EditableField label="开始日期" value={draft.semester.startsAt || ""} onChange={(value) => updateSemester({ startsAt: value || undefined })} />
            <EditableField label="结束日期" value={draft.semester.endsAt || ""} onChange={(value) => updateSemester({ endsAt: value || undefined })} />
          </div>
        </div>
      )}
      {weeks.length > 0 ? (
        <div className="space-y-2">
          {weeks.map((week) => (
            <div key={week.week} className="overflow-hidden rounded-lg border bg-card/70 [contain:layout_paint] [content-visibility:auto] [contain-intrinsic-size:220px]">
              <div className="flex items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2">
                <div>
                  <div className="text-xs font-semibold">第 {week.week} 周</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{week.startsAt} - {week.endsAt}</div>
                </div>
                <span className="rounded-full border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">{week.events.length} 个事件</span>
              </div>
              {week.events.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-[11px]">
                    <thead className="bg-background/80 text-muted-foreground">
                      <tr>
                        <th className="px-3 py-2 font-medium">事件</th>
                        <th className="px-3 py-2 font-medium">开始</th>
                        <th className="px-3 py-2 font-medium">结束</th>
                        <th className="px-3 py-2 font-medium">置信度</th>
                      </tr>
                    </thead>
                    <tbody>
                      {week.events.map(({ event, index }) => (
                        <tr key={`event-${index}`} className="border-t">
                          <td className="px-3 py-2">
                            <input className={editableClassName} value={event.title} onChange={(inputEvent) => updateEvent(index, { title: inputEvent.target.value })} />
                          </td>
                          <td className="px-3 py-2">
                            <input className={editableClassName} value={event.startsAt} onChange={(inputEvent) => updateEvent(index, { startsAt: inputEvent.target.value })} />
                          </td>
                          <td className="px-3 py-2">
                            <input className={editableClassName} value={event.endsAt || ""} onChange={(inputEvent) => updateEvent(index, { endsAt: inputEvent.target.value || undefined })} />
                          </td>
                          <td className="px-3 py-2">{formatConfidence(event.confidence)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-3 py-3 text-[11px] text-muted-foreground">这一周没有识别到事件。</div>
              )}
            </div>
          ))}
        </div>
      ) : draft.events.length > 0 ? (
        <div className="overflow-hidden rounded-lg border bg-card/70">
          <div className="border-b bg-muted/30 px-3 py-2 text-xs font-semibold">未归入周次的事件</div>
          <div className="space-y-2 p-3">
            {draft.events.map((event, index) => (
              <div key={`unassigned-event-${index}`} className="grid gap-2 rounded-md border bg-background/70 p-2 [contain:layout_paint] [content-visibility:auto] [contain-intrinsic-size:96px] md:grid-cols-[1.4fr_0.8fr_0.8fr]">
                <EditableField label="事件" value={event.title} onChange={(value) => updateEvent(index, { title: value })} />
                <EditableField label="开始" value={event.startsAt} onChange={(value) => updateEvent(index, { startsAt: value })} />
                <EditableField label="结束" value={event.endsAt || ""} onChange={(value) => updateEvent(index, { endsAt: value || undefined })} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <EmptyReview label="请补充学期开始和结束日期，用于生成周次。" />
      )}
    </div>
  );
}

function EmptyReview({ label }: { label: string }) {
  return <div className="rounded-lg border border-dashed bg-card/60 px-3 py-8 text-center text-xs text-muted-foreground">{label}</div>;
}

function ConfidenceBadge({ value }: { value: number }) {
  return <span className="shrink-0 rounded-full border bg-background px-2 py-0.5 text-[10px] font-medium text-muted-foreground">{formatConfidence(value)}</span>;
}

function CourseIconPicker({ value, automatic, onChange }: { value: CourseIconKey; automatic: boolean; onChange: (value: CourseIconKey) => void }) {
  const [open, setOpen] = useState(false);
  const activeOption = COURSE_ICON_OPTIONS.find((option) => option.key === value) || COURSE_ICON_OPTIONS[0];

  return (
    <div className="relative" aria-label="课程图标">
      <button
        type="button"
        className="flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] bg-background px-2 text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-black/[0.04] transition hover:bg-accent hover:text-foreground active:scale-[0.98]"
        title={automatic ? `自动匹配：${activeOption.label}` : `已选择：${activeOption.label}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <CourseIcon course={{ icon: value }} className="h-3.5 w-3.5" />
        <span>{activeOption.label}</span>
        {automatic && <span className="rounded-[var(--radius-badge)] bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">自动</span>}
      </button>

      {open && (
        <div className="absolute right-0 top-8 z-20 grid w-48 grid-cols-6 gap-1 rounded-[var(--radius-card)] bg-card/98 p-2 shadow-xl ring-1 ring-black/[0.08] backdrop-blur-xl">
          {COURSE_ICON_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              className={cx(
                "flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] bg-background text-muted-foreground shadow-sm ring-1 ring-black/[0.04] transition hover:bg-accent hover:text-foreground active:scale-[0.98]",
                option.key === value && "bg-[hsl(var(--status-info)/0.14)] text-[hsl(var(--status-info))] ring-[hsl(var(--status-info)/0.24)] hover:bg-[hsl(var(--status-info)/0.18)] hover:text-[hsl(var(--status-info))]",
              )}
              title={option.label}
              aria-label={option.label}
              onClick={() => {
                onChange(option.key);
                setOpen(false);
              }}
            >
              <CourseIcon course={{ icon: option.key }} className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function resolvedCourseIcon(course: RecognizedCourseSchedule): CourseIconKey {
  return course.icon || matchCourseIcon({
    code: course.code,
    name: stripSectionLabel(course.name, course.section),
    category: course.category,
  });
}

const editableClassName = "h-7 w-full rounded-md border border-border/70 bg-background px-2 text-[11px] text-foreground outline-none transition focus:border-foreground/30 focus:ring-2 focus:ring-ring/15";

function EditableField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block space-y-1 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
      <span>{label}</span>
      <input className={editableClassName} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function withoutApplied<T extends VisionDraft>(draft: T): T {
  const { applied: _applied, ...clean } = draft;
  return clean as T;
}

function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "").trim();
  return message || fallback;
}

function weekCount(startsAt?: string, endsAt?: string): number | undefined {
  return semesterWeekRanges({ startsAt, endsAt }).length || undefined;
}

function calendarWeekRows(startsAt: string | undefined, endsAt: string | undefined, events: RecognizedAcademicCalendar["events"]) {
  return semesterWeekRanges({ startsAt, endsAt }).map((range) => {
    const weekStart = dateOnly(range.startsAt);
    const weekEnd = dateOnly(range.endsAt);
    const row: {
      week: number;
      startsAt: string;
      endsAt: string;
      events: Array<{ event: RecognizedAcademicCalendar["events"][number]; index: number }>;
    } = {
      week: range.weekNumber,
      startsAt: range.startsAt,
      endsAt: range.endsAt,
      events: events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => {
          const eventStart = dateOnly(event.startsAt);
          const eventEnd = dateOnly(event.endsAt || event.startsAt);
          return Boolean(weekStart && weekEnd && eventStart && eventEnd && eventStart <= weekEnd && eventEnd >= weekStart);
        }),
    };
    return row;
  });
}

function dateOnly(value?: string): Date | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setHours(0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? undefined : date;
}


function stripSectionLabel(name: string, section?: string): string {
  if (!section) return name;
  return name.replace(new RegExp(`\\s*\\(${escapeRegExp(section)}\\)\\s*$`), "").trim() || name;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberOrUndefined(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatConfidence(value?: number): string {
  if (value === undefined) return "—";
  return `${Math.round(value * 100)}%`;
}

function weekdayLabel(day: string): string {
  if (day === "mon") return "周一";
  if (day === "tue") return "周二";
  if (day === "wed") return "周三";
  if (day === "thu") return "周四";
  if (day === "fri") return "周五";
  if (day === "sat") return "周六";
  return "周日";
}
