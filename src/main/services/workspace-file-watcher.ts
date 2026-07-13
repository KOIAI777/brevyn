import type { BrowserWindow } from "electron";
import { existsSync, mkdirSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { IPC_CHANNELS } from "../../types/ipc";
import type { LocalStore } from "./local-store";

const DEBOUNCE_MS = 300;

let watcher: FSWatcher | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

export function startWorkspaceFileWatcher(rootDataDir: string, store: LocalStore, window: BrowserWindow): void {
  stopWorkspaceFileWatcher();

  const semestersDir = join(rootDataDir, "semesters");
  mkdirSync(semestersDir, { recursive: true });

  try {
    const changed = store.syncActiveSemesterDiskFiles();
    if (changed) notifyFilesChanged(window);
  } catch (error) {
    console.warn("[files] Initial workspace file sync failed", error);
  }

  if (!existsSync(semestersDir)) return;

  try {
    watcher = watch(semestersDir, { recursive: true }, (_eventType, filename) => {
      if (window.isDestroyed()) return;
      const eventKind = workspaceFileEventKind(filename);
      if (eventKind === "ignore") return;
      if (eventKind === "session") {
        scheduleNotify(window);
        return;
      }
      scheduleSync(store, window);
    });
  } catch (error) {
    console.warn("[files] Workspace file watcher failed to start", error);
  }
}

export function stopWorkspaceFileWatcher(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  if (notifyTimer) {
    clearTimeout(notifyTimer);
    notifyTimer = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

function scheduleSync(store: LocalStore, window: BrowserWindow): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    if (window.isDestroyed()) return;
    try {
      const changed = store.syncActiveSemesterDiskFiles();
      if (changed) notifyFilesChanged(window);
    } catch (error) {
      console.warn("[files] Workspace file sync failed", error);
    }
  }, DEBOUNCE_MS);
}

function scheduleNotify(window: BrowserWindow): void {
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    if (!window.isDestroyed()) notifyFilesChanged(window);
  }, DEBOUNCE_MS);
}

function notifyFilesChanged(window: BrowserWindow): void {
  if (!window.webContents.isDestroyed()) {
    window.webContents.send(IPC_CHANNELS.filesChanged);
  }
}

function workspaceFileEventKind(filename: string | Buffer | null): "sync" | "session" | "ignore" {
  if (!filename) return "ignore";
  const normalized = String(filename).replace(/\\/g, "/");
  if (!normalized || normalized.includes("/threads/") || normalized.includes("/.claude/")) return "ignore";
  if (normalized.includes("/.brevyn/sessions/")) return "session";
  if (normalized.includes("/.brevyn/")) return "ignore";
  const basename = normalized.split("/").pop() || "";
  if (basename === ".DS_Store" || basename.endsWith(".tmp")) return "ignore";
  return "sync";
}
