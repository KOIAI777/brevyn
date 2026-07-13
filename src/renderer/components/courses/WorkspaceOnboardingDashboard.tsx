import { Archive, ArrowRight, CalendarDays, CheckCircle2, GraduationCap, Loader2, Plus } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import type { SemesterWorkspace } from "@/types/domain";

type OnboardingMode = "no-semester" | "select-semester";

export function WorkspaceOnboardingDashboard({
  mode,
  semesters,
  onSelectSemester,
  onOpenSemesterSettings,
  onOpenArchive,
  onWorkspaceChanged,
}: {
  mode: OnboardingMode;
  semesters: SemesterWorkspace[];
  onSelectSemester: (semesterId: string) => Promise<void> | void;
  onOpenSemesterSettings: () => void;
  onOpenArchive: () => void;
  onWorkspaceChanged: () => Promise<void> | void;
}) {
  const [term, setTerm] = useState("");
  const [weekCount, setWeekCount] = useState("16");
  const [creating, setCreating] = useState(false);
  const [selectingSemesterId, setSelectingSemesterId] = useState("");
  const [error, setError] = useState("");
  const hasSemesters = semesters.length > 0;
  const copy = mode === "select-semester"
    ? {
        eyebrow: "学期入口",
        status: "未选择学期",
        title: "回到一个学期。",
        description: "选择要继续的学期，Brevyn 会恢复它的课程、资料、作业和会话。你也可以从这里新建一个学期。",
      }
    : {
        eyebrow: "Brevyn 学术工作台",
        status: "未创建学期",
        title: "为学习建立一个原点。",
        description: "Brevyn 是一个本地优先的学术工作台。它把课程、资料、作业和对话放进同一个学期脉络里，让零散的学习慢慢沉淀成可继续的记录。",
      };

  async function createSemester() {
    const nextTerm = term.trim();
    const nextWeekCount = normalizeWeekCountInput(weekCount);
    if (!nextTerm) {
      setError("请先填写学期名称。");
      return;
    }
    if (!nextWeekCount) {
      setError("请填写 1-30 之间的学期周数。");
      return;
    }
    setCreating(true);
    setError("");
    try {
      await window.brevyn.semester.create({
        term: nextTerm,
        weekCount: nextWeekCount,
      });
      setTerm("");
      setWeekCount("16");
      await onWorkspaceChanged();
    } catch (reason) {
      setError(errorMessage(reason, "创建学期失败。"));
    } finally {
      setCreating(false);
    }
  }

  async function selectSemester(semester: SemesterWorkspace) {
    setSelectingSemesterId(semester.id);
    setError("");
    try {
      await onSelectSemester(semester.id);
    } catch (reason) {
      setError(errorMessage(reason, "切换学期失败。"));
    } finally {
      setSelectingSemesterId("");
    }
  }

  return (
    <div className="brevyn-dashboard-background brevyn-dashboard-scroll brevyn-scrollbar">
      <div className="brevyn-dashboard-shell brevyn-empty-dashboard-shell">
        <section className="relative overflow-hidden rounded-[var(--radius-window)] bg-[linear-gradient(180deg,hsl(var(--card)/0.98),hsl(var(--surface-panel)/0.94))] shadow-[var(--shadow-panel)]">
          <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-foreground/12 to-transparent" />
          <div className="brevyn-empty-dashboard-watermark pointer-events-none absolute -bottom-12 right-8 select-none font-semibold leading-none tracking-[-0.08em] text-foreground/5">
            01
          </div>
          <header className="relative z-[1] flex items-center justify-between gap-4 border-b border-border/50 px-5 py-4">
            <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              <GraduationCap className="h-4 w-4" />
              <span className="truncate">{copy.eyebrow}</span>
            </div>
            <span className="shrink-0 rounded-[var(--radius-badge)] bg-muted px-2 py-1 text-[10px] font-semibold text-muted-foreground">
              {copy.status}
            </span>
          </header>

          <div className="brevyn-empty-dashboard-stage relative z-[1]">
            <div className="flex min-w-0 flex-col justify-center">
              <div className="inline-flex w-fit items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                <CalendarDays className="h-4 w-4" />
                学期入口
              </div>
              <h2 className="brevyn-empty-dashboard-title mt-4 text-foreground">{copy.title}</h2>
              <p className="brevyn-empty-dashboard-description mt-3.5 text-muted-foreground">{copy.description}</p>

              <div className="mt-6 grid max-w-2xl grid-cols-3 divide-x divide-border/50 border-y border-border/55 text-xs">
                <OnboardingMilestone index="01" title="学期" text="命名当前阶段" />
                <OnboardingMilestone index="02" title="课程" text="添加课程入口" />
                <OnboardingMilestone index="03" title="作业" text="沉淀资料会话" />
              </div>
            </div>

            <aside className="brevyn-empty-dashboard-side flex items-center">
              <div className="w-full rounded-[var(--radius-panel)] bg-background/78 p-4 shadow-[0_18px_40px_hsl(var(--foreground)/0.06),inset_0_0_0_1px_hsl(var(--border)/0.52)]">
                <div className="text-[13px] font-semibold text-foreground">新建学期</div>
                <div className="mt-2">
                  <p className="text-[11px] leading-5 text-muted-foreground">
                    填写名称和周数。目录和归档可以稍后在学期管理中调整。
                  </p>
                </div>
                <div className="mt-5 space-y-4">
                  <label className="block space-y-2 text-[11px] text-muted-foreground">
                    <span>学期名称</span>
                    <input
                      className="h-10 w-full rounded-[var(--radius-control)] border bg-card px-3 text-sm font-medium text-foreground outline-none transition placeholder:text-muted-foreground/55 focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-55"
                      value={term}
                      onChange={(event) => setTerm(event.target.value)}
                      onKeyDown={(event) => {
                        if (isComposingText(event)) return;
                        if (event.key === "Enter" && !creating && term.trim() && normalizeWeekCountInput(weekCount)) void createSemester();
                      }}
                      placeholder="例如：2026 秋季学期"
                      disabled={creating}
                    />
                  </label>
                  <label className="block space-y-2 text-[11px] text-muted-foreground">
                    <span>学期周数</span>
                    <input
                      className="h-10 w-full rounded-[var(--radius-control)] border bg-card px-3 text-sm font-medium text-foreground outline-none transition placeholder:text-muted-foreground/55 focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-55"
                      type="number"
                      min={1}
                      max={30}
                      step={1}
                      inputMode="numeric"
                      value={weekCount}
                      onChange={(event) => setWeekCount(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !creating && term.trim() && normalizeWeekCountInput(weekCount)) void createSemester();
                      }}
                      placeholder="16"
                      disabled={creating}
                    />
                    <span className="block text-[10px] leading-4 text-muted-foreground/75">
                      用于生成 Week 1 到 Week N 的课件目录。
                    </span>
                  </label>
                  <button
                    type="button"
                    className="inline-flex h-10 w-full items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-foreground px-4 text-xs font-medium text-background transition hover:opacity-90 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => void createSemester()}
                    disabled={creating || !term.trim() || !normalizeWeekCountInput(weekCount)}
                  >
                    {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                    {creating ? "正在建立" : "建立并进入"}
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[var(--radius-control)] text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground active:scale-[0.98]"
                    onClick={onOpenSemesterSettings}
                  >
                    更多学期设置
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </aside>
          </div>
        </section>

        {error && (
          <div className="rounded-[var(--radius-control)] bg-[hsl(var(--status-warning)/0.12)] px-3 py-2 text-xs leading-5 text-[hsl(var(--status-warning))] shadow-[inset_0_0_0_1px_hsl(var(--status-warning)/0.18)]">
            {error}
          </div>
        )}

        {hasSemesters && (
          <section className="rounded-[var(--radius-panel)] bg-card p-4 shadow-[var(--shadow-panel)]">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <CheckCircle2 className="h-4 w-4" />
                  可继续的学期
                </div>
                <p className="mt-1 text-xs text-muted-foreground">选择后会加载对应课程、作业和会话。</p>
              </div>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border bg-background/75 px-3 text-xs font-medium text-muted-foreground transition hover:bg-accent hover:text-foreground"
                onClick={onOpenSemesterSettings}
              >
                管理全部
              </button>
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              {semesters.map((semester) => (
                <button
                  key={semester.id}
                  type="button"
                  className="group flex min-w-0 items-center gap-3 rounded-[var(--radius-card)] bg-background/68 p-3 text-left shadow-[inset_0_0_0_1px_hsl(var(--border)/0.52)] transition hover:bg-accent/50 disabled:cursor-wait disabled:opacity-70"
                  disabled={Boolean(selectingSemesterId)}
                  onClick={() => void selectSemester(semester)}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-card text-muted-foreground ring-1 ring-border/60">
                    {selectingSemesterId === semester.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarDays className="h-4 w-4" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold text-foreground">{semester.term}</span>
                    <span className="mt-1 block truncate text-[10px] text-muted-foreground">{semester.semesterNo} · {semester.folderName}</span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="px-1 text-xs leading-5 text-muted-foreground">
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/45 pt-4">
            <div className="max-w-2xl">
              <div className="mb-1 font-semibold text-foreground">已有历史学期？</div>
              <p>归档学期不会出现在当前工作区。需要继续时，可以从归档中恢复。</p>
            </div>
            <button
              type="button"
              className="inline-flex h-8 items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
              onClick={onOpenArchive}
            >
              <Archive className="h-3.5 w-3.5" />
              打开归档
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

function OnboardingMilestone({ index, title, text }: { index: string; title: string; text: string }) {
  return (
    <div className="min-w-0 px-4 py-3 first:pl-0 last:pr-0">
      <div className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground">{index}</div>
      <div className="mt-2 text-sm font-semibold tracking-[-0.02em] text-foreground">{title}</div>
      <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{text}</p>
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "").trim();
  return message || fallback;
}

function isComposingText(event: KeyboardEvent<HTMLInputElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

function normalizeWeekCountInput(value: string): number | undefined {
  const numeric = Number(value.trim());
  if (!Number.isFinite(numeric)) return undefined;
  const weekCount = Math.trunc(numeric);
  if (weekCount < 1 || weekCount > 30) return undefined;
  return weekCount;
}
