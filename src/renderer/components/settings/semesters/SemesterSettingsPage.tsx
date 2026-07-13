import { Archive, CalendarDays, Check, Loader2, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ActionButton, Field, IconActionButton, MiniMetric } from "@/components/settings/shared/SettingsControls";
import { errorMessage } from "@/components/settings/shared/settingsErrors";
import { cx } from "@/lib/cn";
import type { SemesterWorkspace } from "@/types/domain";

interface SemesterSettingsPageProps {
  currentSemester?: SemesterWorkspace | null;
  onSelectSemester?: (semesterId: string) => Promise<void> | void;
  onWorkspaceChanged?: () => Promise<void> | void;
}

export function SemesterSettingsPage({
  currentSemester: initialCurrentSemester,
  onSelectSemester,
  onWorkspaceChanged,
}: SemesterSettingsPageProps) {
  const [activeSemesters, setActiveSemesters] = useState<SemesterWorkspace[]>([]);
  const [archivedSemesters, setArchivedSemesters] = useState<SemesterWorkspace[]>([]);
  const [currentSemester, setCurrentSemester] = useState<SemesterWorkspace | null>(initialCurrentSemester ?? null);
  const [busyKey, setBusyKey] = useState("");
  const [term, setTerm] = useState("");
  const [folderName, setFolderName] = useState("");
  const [error, setError] = useState("");
  const { confirm, confirmDialog } = useConfirmDialog();

  const allSemesters = useMemo(() => [...activeSemesters, ...archivedSemesters], [activeSemesters, archivedSemesters]);

  useEffect(() => {
    void loadSemesters();
  }, []);

  useEffect(() => {
    if (initialCurrentSemester) setCurrentSemester(initialCurrentSemester);
  }, [initialCurrentSemester]);

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

  async function afterMutation() {
    await loadSemesters();
    await onWorkspaceChanged?.();
  }

  async function createSemester() {
    const nextTerm = term.trim();
    if (!nextTerm) {
      setError("请填写学期名称。");
      return;
    }
    setBusyKey("semester:create");
    setError("");
    try {
      await window.brevyn.semester.create({
        term: nextTerm,
        folderName: folderName.trim() || undefined,
      });
      setTerm("");
      setFolderName("");
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "创建学期失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function selectSemester(semester: SemesterWorkspace) {
    if (semester.archivedAt || semester.id === currentSemester?.id) return;
    setBusyKey(`semester:select:${semester.id}`);
    setError("");
    try {
      if (onSelectSemester) {
        await onSelectSemester(semester.id);
      } else {
        await window.brevyn.semester.select(semester.id);
        await onWorkspaceChanged?.();
      }
      await loadSemesters();
    } catch (reason) {
      setError(errorMessage(reason, "切换学期失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function archiveSemester(semester: SemesterWorkspace) {
    const ok = await confirm({
      title: `归档“${semester.term}”？`,
      message: "归档后它会从当前工作区隐藏，之后可以在这里恢复。",
      confirmLabel: "归档",
      cancelLabel: "保留",
      tone: "default",
    });
    if (!ok) return;
    setBusyKey(`semester:archive:${semester.id}`);
    setError("");
    try {
      await window.brevyn.semester.archive(semester.id);
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "归档学期失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function restoreSemester(semester: SemesterWorkspace) {
    setBusyKey(`semester:restore:${semester.id}`);
    setError("");
    try {
      await window.brevyn.semester.restore(semester.id);
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "恢复学期失败。"));
    } finally {
      setBusyKey("");
    }
  }

  async function deleteSemester(semester: SemesterWorkspace) {
    if (!semester.archivedAt) {
      setError("请先归档该学期，再进行永久删除。");
      return;
    }
    const ok = await confirm({
      title: `永久删除“${semester.term}”？`,
      message: "这会删除该学期下的课程、文件、会话和索引数据，删除后无法恢复。",
      confirmLabel: "删除",
      cancelLabel: "取消",
      tone: "danger",
    });
    if (!ok) return;
    setBusyKey(`semester:delete:${semester.id}`);
    setError("");
    try {
      await window.brevyn.semester.delete(semester.id);
      await afterMutation();
    } catch (reason) {
      setError(errorMessage(reason, "删除学期失败。"));
    } finally {
      setBusyKey("");
    }
  }

  return (
    <div className="space-y-4">
      {confirmDialog}
      <header className="rounded-[var(--radius-card)] bg-card p-4 shadow-sm ring-1 ring-black/[0.045]">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] bg-muted text-muted-foreground">
                <CalendarDays className="h-4 w-4" />
              </span>
              <span>学期管理</span>
            </div>
            <p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">
              学期只负责切换工作区、归档旧资料和创建新学期；课程表先从主界面撤下，避免占用入口。
            </p>
          </div>
          <div className="grid shrink-0 grid-cols-3 gap-2">
            <MiniMetric label="当前" value={currentSemester?.term || "未选择"} />
            <MiniMetric label="进行中" value={`${activeSemesters.length}`} />
            <MiniMetric label="已归档" value={`${archivedSemesters.length}`} />
          </div>
        </div>
      </header>

      {error && (
        <div className="rounded-[var(--radius-control)] bg-[hsl(var(--status-warning)/0.12)] px-3 py-2 text-xs leading-5 text-[hsl(var(--status-warning))] shadow-[inset_0_0_0_1px_hsl(var(--status-warning)/0.18)]">
          {error}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="space-y-4">
          <SemesterGroup
            title="进行中的学期"
            emptyLabel="暂无进行中的学期。"
            semesters={activeSemesters}
            currentSemesterId={currentSemester?.id}
            busyKey={busyKey}
            onSelect={(semester) => void selectSemester(semester)}
            onArchive={(semester) => void archiveSemester(semester)}
            onRestore={(semester) => void restoreSemester(semester)}
            onDelete={(semester) => void deleteSemester(semester)}
          />
          <SemesterGroup
            title="已归档学期"
            emptyLabel="暂无已归档学期。"
            semesters={archivedSemesters}
            currentSemesterId={currentSemester?.id}
            busyKey={busyKey}
            onSelect={(semester) => void selectSemester(semester)}
            onArchive={(semester) => void archiveSemester(semester)}
            onRestore={(semester) => void restoreSemester(semester)}
            onDelete={(semester) => void deleteSemester(semester)}
          />
        </section>

        <aside className="space-y-3">
          <section className="rounded-[var(--radius-card)] bg-card p-3 shadow-sm ring-1 ring-black/[0.045]">
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold text-foreground">
              <Plus className="h-3.5 w-3.5" />
              新建学期
            </div>
            <div className="space-y-3">
              <Field label="学期名称" value={term} onChange={setTerm} placeholder="例如：2026 秋季学期" />
              <Field label="文件夹名称（可选）" value={folderName} onChange={setFolderName} placeholder="留空则自动生成" />
              <ActionButton
                icon={busyKey === "semester:create" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                label={busyKey === "semester:create" ? "正在创建" : "创建学期"}
                primary
                className="w-full justify-center"
                disabled={busyKey === "semester:create"}
                onClick={() => void createSemester()}
              />
            </div>
          </section>

          <section className="rounded-[var(--radius-card)] bg-card p-3 text-[11px] leading-5 text-muted-foreground shadow-sm ring-1 ring-black/[0.045]">
            <div className="mb-1 text-xs font-semibold text-foreground">删除规则</div>
            <p>学期需要先归档，才允许永久删除。归档不会删除文件，只是从当前工作区隐藏。</p>
            <div className="mt-2 rounded-[var(--radius-control)] bg-muted/55 px-2 py-2">
              共 {allSemesters.length} 个学期
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function SemesterGroup({
  title,
  emptyLabel,
  semesters,
  currentSemesterId,
  busyKey,
  onSelect,
  onArchive,
  onRestore,
  onDelete,
}: {
  title: string;
  emptyLabel: string;
  semesters: SemesterWorkspace[];
  currentSemesterId?: string;
  busyKey: string;
  onSelect: (semester: SemesterWorkspace) => void;
  onArchive: (semester: SemesterWorkspace) => void;
  onRestore: (semester: SemesterWorkspace) => void;
  onDelete: (semester: SemesterWorkspace) => void;
}) {
  return (
    <section className="rounded-[var(--radius-card)] bg-card p-3 shadow-sm ring-1 ring-black/[0.045]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold text-foreground">{title}</div>
        <span className="rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{semesters.length}</span>
      </div>

      {semesters.length === 0 ? (
        <div className="rounded-[var(--radius-control)] bg-muted/35 px-3 py-5 text-center text-xs text-muted-foreground">{emptyLabel}</div>
      ) : (
        <div className="space-y-2">
          {semesters.map((semester) => {
            const isArchived = Boolean(semester.archivedAt);
            const isCurrent = currentSemesterId === semester.id;
            const isBusy = busyKey.endsWith(`:${semester.id}`);
            return (
              <div
                key={semester.id}
                className={cx(
                  "flex items-center gap-2 rounded-[var(--radius-card)] px-3 py-3 shadow-sm ring-1 transition",
                  isArchived ? "bg-muted/40 text-muted-foreground ring-black/[0.035]" : "bg-background/70 ring-black/[0.045]",
                  isCurrent && !isArchived && "ring-foreground/12",
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left disabled:cursor-default"
                  disabled={isArchived || isCurrent || isBusy}
                  onClick={() => onSelect(semester)}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-semibold text-foreground">{semester.term}</span>
                    {isCurrent && !isArchived && <span className="rounded-[var(--radius-badge)] bg-[hsl(var(--status-success)/0.14)] px-1.5 py-0.5 text-[9px] font-semibold uppercase text-[hsl(var(--status-success))]">当前</span>}
                    {isArchived && <span className="rounded-[var(--radius-badge)] bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase">已归档</span>}
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {semester.semesterNo} · {semester.folderName}
                  </div>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  {isArchived ? (
                    <IconActionButton
                      icon={isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                      label="恢复学期"
                      disabled={isBusy}
                      onClick={() => onRestore(semester)}
                    />
                  ) : (
                    <IconActionButton
                      icon={isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
                      label="归档学期"
                      disabled={isBusy}
                      onClick={() => onArchive(semester)}
                    />
                  )}
                  <IconActionButton
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    label={isArchived ? "永久删除" : "请先归档再删除"}
                    danger
                    disabled={isBusy}
                    onClick={() => onDelete(semester)}
                  />
                  {isCurrent && !isArchived && <Check className="h-4 w-4 shrink-0 text-[hsl(var(--status-success))]" />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
