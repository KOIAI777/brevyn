import { CircleAlert, Download, Loader2, RefreshCw } from "lucide-react";
import type { GitHubRelease, UpdaterStatus } from "@/types/domain";
import { APP_VERSION } from "@/lib/app-version";
import { cx } from "@/lib/cn";

export function UpdateStatusCard({
  status,
  checking,
  release,
  onCheck,
  onDownload,
  onDismissDownloaded,
  onQuitAndInstall,
}: {
  status: UpdaterStatus | null;
  checking: boolean;
  release: GitHubRelease | null;
  onCheck: () => void;
  onDownload: () => void;
  onDismissDownloaded: () => void;
  onQuitAndInstall: () => void;
}) {
  const currentVersion = status?.currentVersion || APP_VERSION;
  const isChecking = checking || status?.status === "checking";
  const canCheck = status?.status !== "downloading" && status?.status !== "downloaded";
  const progress = status?.status === "downloading" ? clampProgress(status.progress.percent) : 0;

  return (
    <section className="settings-solid-card rounded-[var(--radius-panel)] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">手动检查更新</h3>
          <p className="mt-1 text-xs text-muted-foreground">{updateStatusText(status, currentVersion)}</p>
          {release?.name && status?.status === "available" ? (
            <p className="mt-1 truncate text-xs font-medium text-foreground">{release.name}</p>
          ) : null}
        </div>
        <UpdateActions
          status={status}
          checking={isChecking}
          canCheck={canCheck}
          onCheck={onCheck}
          onDownload={onDownload}
          onDismissDownloaded={onDismissDownloaded}
          onQuitAndInstall={onQuitAndInstall}
        />
      </div>
      {status?.status === "downloading" ? (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-border/60">
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
          </div>
          <div className="mt-1 text-right text-[10px] font-medium text-muted-foreground">{Math.round(progress)}%</div>
        </div>
      ) : null}
      {status?.status === "error" ? (
        <div className="mt-3 rounded-[var(--radius-control)] bg-[hsl(var(--status-warning)/0.1)] px-3 py-2 text-xs text-[hsl(var(--status-warning))]">
          {status.error}
        </div>
      ) : null}
    </section>
  );
}

function UpdateActions({
  status,
  checking,
  canCheck,
  onCheck,
  onDownload,
  onDismissDownloaded,
  onQuitAndInstall,
}: {
  status: UpdaterStatus | null;
  checking: boolean;
  canCheck: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onDismissDownloaded: () => void;
  onQuitAndInstall: () => void;
}) {
  if (status?.status === "available") {
    return (
      <button type="button" className={primaryButtonClassName()} onClick={onDownload}>
        <Download className="h-3.5 w-3.5" />
        下载更新
      </button>
    );
  }
  if (status?.status === "downloading") {
    return (
      <button type="button" className={secondaryButtonClassName()} disabled>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        下载中
      </button>
    );
  }
  if (status?.status === "downloaded") {
    return (
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button type="button" className={primaryButtonClassName()} onClick={onQuitAndInstall}>
          <RefreshCw className="h-3.5 w-3.5" />
          重启更新
        </button>
        {!status.dismissed ? (
          <button type="button" className={secondaryButtonClassName()} onClick={onDismissDownloaded}>
            稍后
          </button>
        ) : null}
      </div>
    );
  }
  if (status?.status === "error") {
    return (
      <button type="button" className={secondaryButtonClassName()} onClick={onCheck}>
        <CircleAlert className="h-3.5 w-3.5" />
        重试
      </button>
    );
  }
  return (
    <button
      type="button"
      className={secondaryButtonClassName()}
      onClick={onCheck}
      disabled={!canCheck || checking}
    >
      <RefreshCw className={cx("h-3.5 w-3.5", checking && "animate-spin")} />
      检查更新
    </button>
  );
}

function updateStatusText(status: UpdaterStatus | null, currentVersion: string): string {
  if (!status) return `当前版本 ${currentVersion}`;
  if (status.status === "unsupported") return status.reason;
  if (status.status === "checking") return `当前版本 ${status.currentVersion}，正在检查。`;
  if (status.status === "available") return `发现新版本 ${status.version}。`;
  if (status.status === "downloading") return `正在下载 ${status.version}。`;
  if (status.status === "downloaded") return status.dismissed ? `更新 ${status.version} 已下载，稍后可重启安装。` : `更新 ${status.version} 已下载。`;
  if (status.status === "not-available") return `当前版本 ${status.currentVersion} 已是最新。`;
  if (status.status === "error") return `当前版本 ${status.currentVersion}，更新检查遇到问题。`;
  return `当前版本 ${currentVersion}`;
}

function primaryButtonClassName(): string {
  return "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-control)] bg-foreground px-3 py-2 text-xs font-semibold text-background transition hover:opacity-90 active:scale-[0.98]";
}

function secondaryButtonClassName(): string {
  return "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-border/65 bg-card px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50";
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
