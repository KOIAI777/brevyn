import { Archive, CalendarDays, Check, Loader2, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { SemesterWorkspace } from "@/types/domain";
import { cx } from "@/lib/cn";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";

export function SemesterManagementDialog({
  onSelectSemester,
  onWorkspaceChanged,
  onClose,
}: {
  onSelectSemester?: (semesterId: string) => Promise<void> | void;
  onWorkspaceChanged?: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [activeSemesters, setActiveSemesters] = useState<SemesterWorkspace[]>([]);
  const [archivedSemesters, setArchivedSemesters] = useState<SemesterWorkspace[]>([]);
  const [currentSemester, setCurrentSemester] = useState<SemesterWorkspace | null>(null);
  const [busyId, setBusyId] = useState("");
  const [creating, setCreating] = useState(false);
  const [term, setTerm] = useState("");
  const [folderName, setFolderName] = useState("");
  const [error, setError] = useState("");
  const { confirm, confirmDialog } = useConfirmDialog();

  const hasArchived = archivedSemesters.length > 0;
  const allSemesters = useMemo(() => [...activeSemesters, ...archivedSemesters], [activeSemesters, archivedSemesters]);

  useEffect(() => {
    void loadSemesters();
  }, []);

  async function loadSemesters() {
    try {
      const [active, archived, current] = await Promise.all([
        window.brevyn.semester.list(),
        window.brevyn.semester.listArchived(),
        window.brevyn.semester.current(),
      ]);
      setActiveSemesters(active);
      setArchivedSemesters(archived);
      setCurrentSemester(current);
    } catch (reason) {
      setActiveSemesters([]);
      setArchivedSemesters([]);
      setCurrentSemester(null);
      setError(errorMessage(reason, "加载学期失败。"));
    }
  }

  async function refreshWorkspace() {
    await loadSemesters();
    await onWorkspaceChanged?.();
  }

  async function createSemester() {
    const nextTerm = term.trim();
    if (!nextTerm) {
      setError("请填写学期名称。");
      return;
    }
    setError("");
    setCreating(true);
    try {
      await window.brevyn.semester.create({
        term: nextTerm,
        folderName: folderName.trim() || undefined,
      });
      setTerm("");
      setFolderName("");
      await refreshWorkspace();
    } catch (reason) {
      setError(errorMessage(reason, "创建学期失败。"));
    } finally {
      setCreating(false);
    }
  }

  async function selectSemester(semester: SemesterWorkspace) {
    if (semester.archivedAt) return;
    setBusyId(semester.id);
    setError("");
    try {
      await onSelectSemester?.(semester.id);
      await refreshWorkspace();
    } catch (reason) {
      setError(errorMessage(reason, "选择学期失败。"));
    } finally {
      setBusyId("");
    }
  }

  async function archiveSemester(semester: SemesterWorkspace) {
    const ok = await confirm({
      title: `归档“${semester.term}”？`,
      message: "归档后它会从当前工作区隐藏，之后可以恢复。",
      confirmLabel: "归档",
      cancelLabel: "保留",
      tone: "default",
    });
    if (!ok) return;
    setBusyId(semester.id);
    setError("");
    try {
      await window.brevyn.semester.archive(semester.id);
      await refreshWorkspace();
    } catch (reason) {
      setError(errorMessage(reason, "归档学期失败。"));
    } finally {
      setBusyId("");
    }
  }

  async function restoreSemester(semester: SemesterWorkspace) {
    setBusyId(semester.id);
    setError("");
    try {
      await window.brevyn.semester.restore(semester.id);
      await refreshWorkspace();
    } catch (reason) {
      setError(errorMessage(reason, "恢复学期失败。"));
    } finally {
      setBusyId("");
    }
  }

  async function deleteSemester(semester: SemesterWorkspace) {
    if (!semester.archivedAt) {
      setError("请先归档该学期，再进行永久删除。");
      return;
    }
    const ok = await confirm({
      title: `永久删除“${semester.term}”？`,
      message: "这会删除该学期下的课程、文件、会话和索引数据。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setBusyId(semester.id);
    setError("");
    try {
      await window.brevyn.semester.delete(semester.id);
      await refreshWorkspace();
    } catch (reason) {
      setError(errorMessage(reason, "删除学期失败。"));
    } finally {
      setBusyId("");
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/20 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {confirmDialog}
      <div className="brevyn-window-surface brevyn-dialog-window flex flex-col overflow-hidden">
        <div className="drag-region flex items-center justify-between bg-[hsl(var(--surface-chrome))] px-4 py-3 shadow-[inset_0_-1px_0_hsl(var(--border)/0.62)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <CalendarDays className="h-4 w-4" />
              管理学期
            </div>
            <div className="truncate text-[11px] text-muted-foreground">归档会隐藏学期；永久删除会移除文件、数据库记录和索引片段。</div>
          </div>
          <button
            type="button"
            className="no-drag flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] bg-card text-muted-foreground shadow-sm ring-1 ring-black/[0.06] transition hover:bg-background hover:text-foreground active:scale-[0.98]"
            onClick={onClose}
            title="关闭学期管理"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 md:grid-cols-[1fr_280px] brevyn-scrollbar">
          <section className="min-h-0 space-y-4">
            <SemesterGroup
              title="进行中的学期"
              emptyLabel="暂无进行中的学期。"
              semesters={activeSemesters}
              currentSemesterId={currentSemester?.id}
              busyId={busyId}
              onSelect={(semester) => void selectSemester(semester)}
              onArchive={(semester) => void archiveSemester(semester)}
              onRestore={(semester) => void restoreSemester(semester)}
              onDelete={(semester) => void deleteSemester(semester)}
            />
            {hasArchived && (
              <SemesterGroup
                title="已归档学期"
                emptyLabel="暂无已归档学期。"
                semesters={archivedSemesters}
                currentSemesterId={currentSemester?.id}
                busyId={busyId}
                onSelect={(semester) => void selectSemester(semester)}
                onArchive={(semester) => void archiveSemester(semester)}
                onRestore={(semester) => void restoreSemester(semester)}
                onDelete={(semester) => void deleteSemester(semester)}
              />
            )}
          </section>

          <aside className="space-y-3">
            <section className="rounded-[var(--radius-card)] bg-background/70 p-3 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
              <div className="mb-2 flex items-center gap-2 text-xs font-semibold">
                <Plus className="h-3.5 w-3.5" />
                新建学期
              </div>
              <label className="mb-2 block space-y-1 text-[11px] text-muted-foreground">
                <span>学期名称</span>
                <input
                  className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20"
                  value={term}
                  onChange={(event) => setTerm(event.target.value)}
                  placeholder="例如：2026 秋季学期"
                />
              </label>
              <label className="mb-2 block space-y-1 text-[11px] text-muted-foreground">
                <span>文件夹名称</span>
                <input
                  className="h-8 w-full rounded-[var(--radius-control)] border bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring/20"
                  value={folderName}
                  onChange={(event) => setFolderName(event.target.value)}
                  placeholder="可选，会自动处理非法字符"
                />
              </label>
              {error && <div className="mb-2 rounded-[var(--radius-control)] bg-amber-50 px-2 py-1.5 text-[11px] leading-4 text-amber-900">{error}</div>}
              <button
                type="button"
                className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-foreground px-3 text-xs font-medium text-background transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void createSemester()}
                disabled={creating}
              >
                {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                {creating ? "正在创建..." : "创建学期"}
              </button>
            </section>

            <section className="rounded-[var(--radius-card)] bg-background/70 p-3 text-[11px] leading-5 text-muted-foreground shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
              <div className="mb-1 text-xs font-semibold text-foreground">安全规则</div>
              <p>只有归档后的学期才允许永久删除。归档学期不会单独归档其下课程，恢复学期后课程会保持原状态。</p>
              <div className="mt-2 rounded-[var(--radius-control)] bg-muted/55 px-2 py-2">共 {allSemesters.length} 个学期 · 已归档 {archivedSemesters.length} 个</div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

function SemesterGroup({
  title,
  emptyLabel,
  semesters,
  currentSemesterId,
  busyId,
  onSelect,
  onArchive,
  onRestore,
  onDelete,
}: {
  title: string;
  emptyLabel: string;
  semesters: SemesterWorkspace[];
  currentSemesterId?: string;
  busyId: string;
  onSelect: (semester: SemesterWorkspace) => void;
  onArchive: (semester: SemesterWorkspace) => void;
  onRestore: (semester: SemesterWorkspace) => void;
  onDelete: (semester: SemesterWorkspace) => void;
}) {
  return (
    <section className="rounded-[var(--radius-card)] bg-background/70 p-3 shadow-[inset_0_0_0_1px_hsl(var(--border)/0.5)]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold">{title}</div>
        <span className="rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{semesters.length}</span>
      </div>

      {semesters.length === 0 ? (
        <div className="rounded-[var(--radius-control)] border border-dashed bg-card px-3 py-5 text-center text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        <div className="space-y-2">
          {semesters.map((semester) => {
            const isArchived = Boolean(semester.archivedAt);
            const isCurrent = currentSemesterId === semester.id;
            const isBusy = busyId === semester.id;
            return (
              <div
                key={semester.id}
                className={cx(
                  "flex items-center gap-2 rounded-[var(--radius-card)] border px-3 py-3 transition",
                  isArchived ? "bg-muted/45 text-muted-foreground" : "bg-card",
                  isCurrent ? "border-border shadow-sm ring-1 ring-border/60" : "border-border/60",
                )}
              >
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(semester)} disabled={isArchived || isBusy}>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">{semester.term}</span>
                    {isCurrent && !isArchived && <span className="shrink-0 rounded-[var(--radius-badge)] bg-emerald-50 px-1.5 py-0.5 text-[9px] uppercase text-emerald-700">当前</span>}
                    {isArchived && <span className="shrink-0 rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[9px] uppercase">已归档</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {semester.semesterNo} · {semester.folderName}
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {isArchived ? (
                    <button type="button" className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground hover:bg-accent hover:text-foreground" title="恢复学期" disabled={isBusy} onClick={() => onRestore(semester)}>
                      {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    </button>
                  ) : (
                    <button type="button" className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground hover:bg-accent hover:text-foreground" title="归档学期" disabled={isBusy} onClick={() => onArchive(semester)}>
                      {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
                    </button>
                  )}
                  <button type="button" className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-control)] border bg-background text-muted-foreground hover:bg-red-50 hover:text-red-700" title={isArchived ? "永久删除" : "请先归档再删除"} disabled={isBusy} onClick={() => onDelete(semester)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  {isCurrent && !isArchived && <Check className="h-4 w-4 shrink-0 text-emerald-600" />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || "");
  return message.trim() || fallback;
}
