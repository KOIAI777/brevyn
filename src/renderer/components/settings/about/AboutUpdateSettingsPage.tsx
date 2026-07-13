import { CheckCircle2, Clipboard, Cpu, HardDrive, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { UpdateStatusCard } from "@/components/settings/update/UpdateStatusCard";
import { VersionHistory } from "@/components/settings/update/VersionHistory";
import { errorMessage } from "@/components/settings/shared/settingsErrors";
import { ActionButton } from "@/components/settings/shared/SettingsControls";
import { cx } from "@/lib/cn";
import { APP_VERSION } from "@/lib/app-version";
import brevynAppIconUrl from "@/assets/brevyn-app-icon.png";
import type { AppDiagnostics, UpdaterStatus } from "../../../../types/domain";

export function AboutUpdateSettingsPage() {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [releaseNotes, setReleaseNotes] = useState<Awaited<ReturnType<typeof window.brevyn.updater.getReleaseByTag>>>(null);
  const [diagnostics, setDiagnostics] = useState<AppDiagnostics | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState("");
  const [diagnosticsRefreshing, setDiagnosticsRefreshing] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [copyPathState, setCopyPathState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    let cancelled = false;
    void window.brevyn.updater
      .getStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch((error) => {
        if (!cancelled) {
          setStatus({
            status: "error",
            currentVersion: "0.0.0",
            supported: false,
            error: errorMessage(error, "加载更新状态失败。"),
          });
        }
      });
    const unsubscribe = window.brevyn.updater.onStatusChanged((next) => {
      setStatus(next);
      if (next.status !== "checking") setChecking(false);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    void refreshDiagnostics();
  }, []);

  useEffect(() => {
    if (status?.status !== "available" || !status.version) {
      setReleaseNotes(null);
      return;
    }
    let cancelled = false;
    void window.brevyn.updater
      .getReleaseByTag(status.version)
      .then((release) => {
        if (!cancelled) setReleaseNotes(release);
      })
      .catch(() => {
        if (!cancelled) setReleaseNotes(null);
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  async function checkForUpdates() {
    setChecking(true);
    try {
      await window.brevyn.updater.checkForUpdates();
    } catch (error) {
      setStatus({
        status: "error",
        currentVersion: status?.currentVersion || "0.0.0",
        supported: Boolean(status?.supported),
        error: errorMessage(error, "检查更新失败。"),
      });
      setChecking(false);
    }
  }

  async function downloadUpdate() {
    try {
      await window.brevyn.updater.downloadUpdate();
    } catch (error) {
      setStatus({
        status: "error",
        currentVersion: status?.currentVersion || "0.0.0",
        supported: Boolean(status?.supported),
        error: errorMessage(error, "下载更新失败。"),
      });
    }
  }

  async function quitAndInstall() {
    await window.brevyn.updater.quitAndInstall();
  }

  async function dismissDownloadedUpdate() {
    const next = await window.brevyn.updater.dismissDownloaded();
    setStatus(next);
  }

  async function refreshDiagnostics() {
    setDiagnosticsRefreshing(true);
    try {
      const next = await window.brevyn.app.diagnostics();
      setDiagnostics(next);
      setDiagnosticsError("");
    } catch (error) {
      setDiagnosticsError(errorMessage(error, "环境检测失败。"));
    } finally {
      setDiagnosticsRefreshing(false);
    }
  }

  async function copyDiagnostics() {
    if (!diagnostics) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  async function copyDataPath() {
    if (!diagnostics?.paths.userData) return;
    try {
      await navigator.clipboard.writeText(diagnostics.paths.userData);
      setCopyPathState("copied");
      window.setTimeout(() => setCopyPathState("idle"), 1400);
    } catch {
      setCopyPathState("failed");
      window.setTimeout(() => setCopyPathState("idle"), 1800);
    }
  }

  const currentVersion = status?.currentVersion || diagnostics?.app.version || APP_VERSION;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8">
      <AboutIntroCard currentVersion={currentVersion} packaged={diagnostics?.app.packaged} />

      <section className="space-y-3">
        <SectionHeading
          eyebrow="Update"
          title="更新与版本历史"
        />
        <UpdateStatusCard
          status={status}
          checking={checking}
          release={releaseNotes}
          onCheck={() => void checkForUpdates()}
          onDownload={() => void downloadUpdate()}
          onDismissDownloaded={() => void dismissDownloadedUpdate()}
          onQuitAndInstall={() => void quitAndInstall()}
        />
        <VersionHistory />
      </section>

      <section className="space-y-3 pt-1">
        <SectionHeading
          eyebrow="Local"
          title="本地运行环境"
          description="仅用于确认这台 Mac 上的应用运行时与数据目录状态。"
        />
        <EnvironmentDiagnosticsCard
          diagnostics={diagnostics}
          error={diagnosticsError}
          refreshing={diagnosticsRefreshing}
          copyState={copyState}
          copyPathState={copyPathState}
          onRefresh={() => void refreshDiagnostics()}
          onCopy={() => void copyDiagnostics()}
          onCopyDataPath={() => void copyDataPath()}
        />
      </section>
    </div>
  );
}

function AboutIntroCard({ currentVersion, packaged }: { currentVersion: string; packaged?: boolean }) {
  return (
    <section className="relative overflow-hidden rounded-[calc(var(--radius-panel)+6px)] bg-[linear-gradient(135deg,hsl(var(--card))_0%,hsl(var(--accent)/0.62)_100%)] p-6 shadow-sm ring-1 ring-border/55">
      <div className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <img src={brevynAppIconUrl} alt="" className="h-16 w-16 rounded-[22px] shadow-sm" />
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold tracking-[-0.04em] text-foreground">Brevyn</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Brevyn 是为课程学习打造的本地工作区。它把学期、课程、课件、作业、文件索引和 AI 会话组织在同一套结构里，让资料不再散落在文件夹、聊天记录和临时笔记之间。我们打造它，是为了让学生可以围绕真实课程持续积累上下文，更快找到资料、理解任务，并把每一次讨论沉淀回自己的学习空间。
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 self-start rounded-full bg-background/70 px-3 py-1.5 text-xs font-semibold text-muted-foreground ring-1 ring-border/55 sm:self-center">
          <span>Version {currentVersion}</span>
          {packaged === false ? <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">Dev</span> : null}
        </div>
      </div>
    </section>
  );
}

function SectionHeading({ eyebrow, title, description }: { eyebrow: string; title: string; description?: string }) {
  return (
    <div className="px-1">
      <div className="text-[10px] font-semibold uppercase tracking-[0.2em] text-muted-foreground/80">{eyebrow}</div>
      <div className="mt-1 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <h3 className="text-base font-semibold tracking-[-0.02em] text-foreground">{title}</h3>
        {description ? <p className="max-w-md text-xs leading-5 text-muted-foreground sm:text-right">{description}</p> : null}
      </div>
    </div>
  );
}

function EnvironmentDiagnosticsCard({
  diagnostics,
  error,
  refreshing,
  copyState,
  copyPathState,
  onRefresh,
  onCopy,
  onCopyDataPath,
}: {
  diagnostics: AppDiagnostics | null;
  error: string;
  refreshing: boolean;
  copyState: "idle" | "copied" | "failed";
  copyPathState: "idle" | "copied" | "failed";
  onRefresh: () => void;
  onCopy: () => void;
  onCopyDataPath: () => void;
}) {
  const health = useMemo(() => diagnostics ? environmentHealth(diagnostics) : null, [diagnostics]);
  const rows = diagnostics ? [
    { label: "Brevyn", value: `${diagnostics.app.version}${diagnostics.app.packaged ? "" : " · Dev"}` },
    { label: "系统", value: `${platformLabel(diagnostics.runtime.platform)} ${diagnostics.runtime.osRelease} · ${diagnostics.runtime.arch}` },
    { label: "运行时", value: `Electron ${diagnostics.runtime.electron} · Chrome ${diagnostics.runtime.chrome}` },
    { label: "Node", value: `Node ${diagnostics.runtime.node} · V8 ${diagnostics.runtime.v8}` },
  ] : [];

  return (
    <section className="overflow-hidden rounded-[var(--radius-panel)] bg-muted/24 p-0 ring-1 ring-border/45">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/35 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] bg-background/65 text-muted-foreground ring-1 ring-border/45">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-semibold text-foreground">环境检测</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">用于确认应用版本、系统运行时与本地数据状态。</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ActionButton
            icon={<RefreshCw className={cx("h-3.5 w-3.5", refreshing && "animate-spin")} />}
            label="重新检测"
            onClick={onRefresh}
            disabled={refreshing}
          />
          <ActionButton
            icon={<Clipboard className="h-3.5 w-3.5" />}
            label={copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制诊断"}
            onClick={onCopy}
            disabled={!diagnostics}
          />
        </div>
      </div>

      {error && (
        <div className="mx-5 mt-4 rounded-[var(--radius-control)] bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {diagnostics ? (
        <div className="space-y-4 p-5">
          <div className="grid gap-2 sm:grid-cols-2">
            <HealthTile
              icon={<CheckCircle2 className="h-4 w-4" />}
              label="整体状态"
              value={health?.label || "检测中"}
              tone="good"
            />
            <HealthTile
              icon={<HardDrive className="h-4 w-4" />}
              label="本地数据"
              value={diagnostics.paths.userData ? "已就绪" : "未检测到"}
              tone={diagnostics.paths.userData ? "good" : "warn"}
            />
          </div>

          <div className="rounded-[var(--radius-control)] bg-background/62 p-3 ring-1 ring-border/30">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground">
              <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
              运行环境
            </div>
            <div className="space-y-2">
              {rows.map((row) => (
                <InfoRow key={row.label} label={row.label} value={row.value} />
              ))}
              <InfoRow
                label="数据目录"
                value={diagnostics.paths.userData}
                actionLabel={copyPathState === "copied" ? "已复制" : copyPathState === "failed" ? "失败" : "复制"}
                onAction={onCopyDataPath}
              />
              <InfoRow label="生成时间" value={formatDateTime(diagnostics.generatedAt)} />
            </div>
          </div>
        </div>
      ) : (
        <div className="p-5 text-xs text-muted-foreground">{refreshing ? "正在检测本机环境..." : "尚未生成诊断信息。"}</div>
      )}
    </section>
  );
}

function HealthTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "good" | "warn";
}) {
  return (
    <div className={cx(
      "rounded-[var(--radius-control)] px-3 py-3 shadow-sm ring-1",
      tone === "good" && "bg-[hsl(var(--status-success)/0.1)] text-[hsl(var(--status-success))] ring-[hsl(var(--status-success)/0.18)]",
      tone === "warn" && "bg-[hsl(var(--status-warning)/0.1)] text-[hsl(var(--status-warning))] ring-[hsl(var(--status-warning)/0.18)]",
    )}>
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.12em] opacity-80">
        {icon}
        {label}
      </div>
      <div className="mt-2 truncate text-xs font-semibold text-foreground" title={value}>{value}</div>
    </div>
  );
}

function InfoRow({
  label,
  value,
  actionLabel,
  onAction,
}: {
  label: string;
  value: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-3 text-xs">
      <div className="text-muted-foreground">{label}</div>
      <div className="truncate font-medium text-foreground" title={value}>{value || "未设置"}</div>
      {onAction && (
        <button
          type="button"
          className="rounded-[var(--radius-badge)] px-2 py-1 text-[10px] font-semibold text-muted-foreground transition hover:bg-accent hover:text-foreground"
          onClick={onAction}
        >
          {actionLabel || "复制"}
        </button>
      )}
    </div>
  );
}

function environmentHealth(diagnostics: AppDiagnostics): { overall: "ok" | "warn"; label: string } {
  return diagnostics.paths.userData ? { overall: "ok", label: "运行良好" } : { overall: "warn", label: "数据目录不可用" };
}

function platformLabel(platform: string): string {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  if (platform === "linux") return "Linux";
  return platform;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
