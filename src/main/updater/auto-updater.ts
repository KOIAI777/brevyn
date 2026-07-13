import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UpdaterStatus } from "../../types/domain";
import { IPC_CHANNELS } from "../../types/ipc";

let currentStatus: UpdaterStatus = initialStatus();
let checkInterval: ReturnType<typeof setInterval> | null = null;
let initialized = false;
let installingUpdate = false;
let dismissedDownloadedVersion: string | null | undefined;

function initialStatus(): UpdaterStatus {
  const currentVersion = app.getVersion();
  if (!app.isPackaged) {
    return {
      status: "unsupported",
      currentVersion,
      supported: false,
      reason: "Auto updates are available after packaging the app.",
    };
  }
  if (!hasUpdateFeedConfig()) {
    return {
      status: "unsupported",
      currentVersion,
      supported: false,
      reason: "Update publishing is not configured yet.",
    };
  }
  return { status: "idle", currentVersion, supported: true };
}

function hasUpdateFeedConfig(): boolean {
  return existsSync(join(process.resourcesPath, "app-update.yml"));
}

function withBase(status: { status: UpdaterStatus["status"]; supported?: boolean; [key: string]: unknown }): UpdaterStatus {
  return {
    ...status,
    currentVersion: app.getVersion(),
    supported: status.supported ?? (app.isPackaged && hasUpdateFeedConfig()),
  } as UpdaterStatus;
}

function updaterStatePath(): string {
  return join(app.getPath("userData"), "updater-state.json");
}

function getDismissedDownloadedVersion(): string | null {
  if (dismissedDownloadedVersion !== undefined) return dismissedDownloadedVersion;
  try {
    const parsed = JSON.parse(readFileSync(updaterStatePath(), "utf8")) as { dismissedDownloadedVersion?: unknown };
    dismissedDownloadedVersion = typeof parsed.dismissedDownloadedVersion === "string" ? parsed.dismissedDownloadedVersion : null;
  } catch {
    dismissedDownloadedVersion = null;
  }
  return dismissedDownloadedVersion;
}

function saveDismissedDownloadedVersion(version: string): void {
  dismissedDownloadedVersion = version;
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(updaterStatePath(), JSON.stringify({ dismissedDownloadedVersion: version }, null, 2));
  } catch (error) {
    console.warn("[brevyn-updater] Failed to persist dismissed update version", error);
  }
}

function withDismissal(status: UpdaterStatus): UpdaterStatus {
  if (status.status !== "downloaded") return status;
  return { ...status, dismissed: getDismissedDownloadedVersion() === status.version };
}

function setStatus(status: UpdaterStatus): void {
  currentStatus = withDismissal(status);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.updaterStatusChanged, currentStatus);
    }
  }
}

export function getUpdaterStatus(): UpdaterStatus {
  return currentStatus;
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged || !hasUpdateFeedConfig()) {
    setStatus(initialStatus());
    return;
  }
  if (currentStatus.status === "checking" || currentStatus.status === "downloading" || currentStatus.status === "downloaded") {
    return;
  }

  try {
    setStatus(withBase({ status: "checking" }));
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setStatus(withBase({
      status: "error",
      error: error instanceof Error ? error.message : String(error || "Failed to check for updates."),
    }));
  }
}

export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged || !hasUpdateFeedConfig()) {
    setStatus(initialStatus());
    return;
  }
  if (currentStatus.status !== "available") return;

  const version = currentStatus.version;
  try {
    setStatus(withBase({ status: "downloading", version, progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 } }));
    await autoUpdater.downloadUpdate();
  } catch (error) {
    setStatus(withBase({
      status: "error",
      error: error instanceof Error ? error.message : String(error || "Failed to download update."),
    }));
  }
}

export function quitAndInstallUpdate(): void {
  if (currentStatus.status !== "downloaded") return;
  installingUpdate = true;
  for (const window of BrowserWindow.getAllWindows()) {
    window.removeAllListeners("close");
  }
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

export function dismissDownloadedUpdate(): UpdaterStatus {
  if (currentStatus.status !== "downloaded") return currentStatus;
  saveDismissedDownloadedVersion(currentStatus.version);
  setStatus(currentStatus);
  return currentStatus;
}

export function isInstallingUpdate(): boolean {
  return installingUpdate;
}

export function cleanupUpdater(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

export function initAutoUpdater(): void {
  if (initialized || !app.isPackaged || !hasUpdateFeedConfig()) return;
  initialized = true;

  autoUpdater.logger = {
    info: (...args: unknown[]) => console.log("[brevyn-updater]", ...args),
    warn: (...args: unknown[]) => console.warn("[brevyn-updater]", ...args),
    error: (...args: unknown[]) => console.error("[brevyn-updater]", ...args),
    debug: (...args: unknown[]) => console.debug("[brevyn-updater]", ...args),
  };
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    setStatus(withBase({ status: "checking" }));
  });

  autoUpdater.on("update-available", (info) => {
    setStatus(withBase({
      status: "available",
      version: info.version,
      releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
    }));
  });

  autoUpdater.on("download-progress", (progress) => {
    const version = "version" in currentStatus && currentStatus.version ? currentStatus.version : "";
    setStatus(withBase({
      status: "downloading",
      version,
      progress: {
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      },
    }));
  });

  autoUpdater.on("update-downloaded", (info) => {
    setStatus(withBase({ status: "downloaded", version: info.version }));
  });

  autoUpdater.on("update-not-available", () => {
    setStatus(withBase({ status: "not-available" }));
  });

  autoUpdater.on("error", (error) => {
    setStatus(withBase({ status: "error", error: error.message }));
  });

  checkInterval = setInterval(() => {
    void checkForUpdates();
  }, 4 * 60 * 60 * 1000);

  setTimeout(() => {
    void checkForUpdates();
  }, 10_000);
}
