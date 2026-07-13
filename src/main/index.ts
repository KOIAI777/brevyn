import { app, BrowserWindow, Menu, nativeTheme, protocol, shell } from "electron";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerIpcHandlers } from "./ipc";
import { IPC_CHANNELS } from "../types/ipc";
import { DocumentEnhancedIndexingExecutor, IndexingQueueService, WorkerThreadIndexingExecutor } from "./indexing";
import { createLocalStore, type LocalStore } from "./services/local-store";
import { applyThemePreference, currentWindowBackgroundColor, syncNativeTheme } from "./services/app-theme";
import { startWorkspaceFileWatcher, stopWorkspaceFileWatcher } from "./services/workspace-file-watcher";
import { registerWorkspaceFilePreviewProtocol, WORKSPACE_FILE_PREVIEW_PROTOCOL } from "./services/workspace-file-preview-protocol";
import { cleanupUpdater, initAutoUpdater, isInstallingUpdate } from "./updater/auto-updater";

app.setPath("userData", join(app.getPath("appData"), app.isPackaged ? "Brevyn Community" : "Brevyn Community Dev"));
protocol.registerSchemesAsPrivileged([
  {
    scheme: WORKSPACE_FILE_PREVIEW_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      corsEnabled: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

if (process.platform === "win32") {
  // ClearType can produce colored fringes on dark code/editor surfaces.
  app.commandLine.appendSwitch("disable-lcd-text");
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let store: LocalStore | null = null;
let indexingQueue: IndexingQueueService | null = null;
let indexingFilesChangedTimer: NodeJS.Timeout | null = null;
let shuttingDown = false;
let resolveStoreReady: (store: LocalStore) => void = () => undefined;
const storeReadyPromise = new Promise<LocalStore>((resolve) => {
  resolveStoreReady = resolve;
});

function createWindow(): void {
  const preloadPath = join(__dirname, "preload.cjs");
  const isMac = process.platform === "darwin";
  const iconPath = resolveAppIconPath();
  const dockIconPath = isMac ? resolveMacDockIconPath() : undefined;
  if (isMac && app.dock && dockIconPath) {
    try {
      app.dock.setIcon(dockIconPath);
    } catch (error) {
      console.warn("[brevyn] Failed to set dock icon", error);
    }
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: "Brevyn Community",
    icon: iconPath,
    backgroundColor: currentWindowBackgroundColor(),
    trafficLightPosition: isMac ? { x: 18, y: 18 } : undefined,
    titleBarStyle: isMac ? "hiddenInset" : undefined,
    vibrancy: isMac ? "under-window" : undefined,
    visualEffectState: isMac ? "followWindow" : undefined,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    void mainWindow.loadFile(join(__dirname, "renderer", "index.html")).catch((error) => {
      console.error("[brevyn] Failed to load packaged renderer", error);
      showMainWindow();
    });
  } else {
    void mainWindow.loadURL("http://127.0.0.1:5174").catch((error) => {
      console.error("[brevyn] Failed to load dev renderer", error);
      showMainWindow();
    });
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.once("ready-to-show", () => {
    showMainWindow();
  });

  mainWindow.webContents.once("did-finish-load", () => {
    showMainWindow();
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error("[brevyn] Renderer load failed", { errorCode, errorDescription, validatedURL });
    showMainWindow();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!app.isPackaged && url.startsWith("http://127.0.0.1:5174")) return;
    event.preventDefault();
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    stopWorkspaceFileWatcher();
    mainWindow = null;
  });
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
  mainWindow.show();
  mainWindow.focus();
}

function resolveMacDockIconPath(): string | undefined {
  const resourceDirs = [
    process.resourcesPath,
    join(__dirname, "resources"),
    join(process.cwd(), "resources"),
    join(process.cwd(), "src", "renderer", "assets"),
  ];
  for (const directory of resourceDirs) {
    const candidate = join(directory, "icon.png");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveAppIconPath(): string | undefined {
  const resourceDirs = [
    process.resourcesPath,
    join(__dirname, "resources"),
    join(process.cwd(), "resources"),
    join(process.cwd(), "src", "renderer", "assets"),
  ];
  const platformNames = process.platform === "darwin"
    ? ["icon.png", "icon.icns"]
    : process.platform === "win32"
      ? ["icon.ico", "icon.png"]
      : ["icon.png"];
  for (const directory of resourceDirs) {
    for (const name of platformNames) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

app.whenReady().then(() => {
  nativeTheme.themeSource = "system";
  nativeTheme.on("updated", () => syncNativeTheme(activeThemePreference(), activeCodeThemePreference(), activeFontSmoothingEnabled()));
  Menu.setApplicationMenu(null);
  const dataRoot = brevynDataRoot();
  configureClaudeSdk(dataRoot);
  registerWorkspaceFilePreviewProtocol();
  registerIpcHandlers({ store: createDeferredStore(dataRoot), indexingQueue: createDeferredIndexingQueue() });
  createWindow();
  syncNativeTheme(activeThemePreference(), activeCodeThemePreference(), activeFontSmoothingEnabled());
  initAutoUpdater();

  void initializeLocalServices(dataRoot);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      syncNativeTheme(activeThemePreference(), activeCodeThemePreference(), activeFontSmoothingEnabled());
      if (store) startBackgroundServicesAfterFirstPaint(dataRoot);
    }
  });
});

async function initializeLocalServices(dataRoot: string): Promise<void> {
  try {
    store = createLocalStore(dataRoot, { isPackaged: app.isPackaged });
    applyThemePreference(store.themePreference(), store.codeThemePreference(), store.fontSmoothingEnabled());
    indexingQueue = new IndexingQueueService(store, new DocumentEnhancedIndexingExecutor(new WorkerThreadIndexingExecutor(), store.documentParser), {
      onQueueChanged: scheduleIndexingFilesChangedBroadcast,
    });
    resolveStoreReady(store);
    startBackgroundServicesAfterFirstPaint(dataRoot);
  } catch (error) {
    console.error("[brevyn] Failed to initialize local store", error);
    store = createUnavailableStore(error);
    indexingQueue = null;
    resolveStoreReady(store);
  }
  syncNativeTheme(activeThemePreference(), activeCodeThemePreference(), activeFontSmoothingEnabled());
}

function activeThemePreference() {
  try {
    return store?.themePreference() ?? "system";
  } catch {
    return "system";
  }
}

function activeCodeThemePreference() {
  try {
    return store?.codeThemePreference() ?? "brevyn";
  } catch {
    return "brevyn";
  }
}

function activeFontSmoothingEnabled() {
  try {
    return store?.fontSmoothingEnabled() ?? true;
  } catch {
    return true;
  }
}

function startBackgroundServicesAfterFirstPaint(dataRoot: string): void {
  const start = () => {
    setTimeout(() => {
      startWatcherForMainWindow(dataRoot);
      indexingQueue?.start();
    }, 1_200);
  };
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    start();
    return;
  }
  if (window.webContents.isLoading()) {
    window.webContents.once("did-finish-load", start);
    return;
  }
  start();
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if (isInstallingUpdate()) return;
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  let exited = false;
  const forceExit = () => {
    if (exited) return;
    exited = true;
    app.exit(0);
  };
  const timeout = setTimeout(() => {
    console.warn("[brevyn] Shutdown timed out, forcing exit.");
    forceExit();
  }, 5_000);
  try {
    stopWorkspaceFileWatcher();
    cleanupUpdater();
    store?.stopAllAgents();
  } catch (error) {
    console.warn("[brevyn] Failed to stop active agents before shutdown", error);
  }
  void (async () => {
    try {
      await indexingQueue?.stop();
      await store?.close();
    } catch (error) {
      console.error("[brevyn] Failed to shut down cleanly", error);
    } finally {
      clearTimeout(timeout);
      forceExit();
    }
  })();
});

function scheduleIndexingFilesChangedBroadcast(): void {
  if (indexingFilesChangedTimer) return;
  indexingFilesChangedTimer = setTimeout(() => {
    indexingFilesChangedTimer = null;
    const window = mainWindow;
    if (!window || window.isDestroyed()) return;
    window.webContents.send(IPC_CHANNELS.filesChanged);
  }, 250);
}

function createUnavailableStore(error: unknown): LocalStore {
  const message = error instanceof Error ? error.message : String(error || "Unknown startup error");
  return new Proxy({} as LocalStore, {
    get(_target, property) {
      if (property === "close") return async () => undefined;
      return () => {
        throw new Error(`Workspace store unavailable: ${message}`);
      };
    },
  });
}

function createDeferredStore(dataRoot: string): LocalStore {
  return new Proxy({} as LocalStore, {
    get(_target, property) {
      if (property === "dataRoot") return () => dataRoot;
      if (property === "themePreference") return () => store?.themePreference?.() ?? "system";
      if (property === "codeThemePreference") return () => store?.codeThemePreference?.() ?? "brevyn";
      if (property === "fontSmoothingEnabled") return () => store?.fontSmoothingEnabled?.() ?? true;
      if (property === "onAgentEvent") {
        return (listener: Parameters<LocalStore["onAgentEvent"]>[0]) => {
          let unsubscribe: (() => void) | undefined;
          void storeReadyPromise.then((readyStore) => {
            unsubscribe = readyStore.onAgentEvent(listener);
          });
          return () => unsubscribe?.();
        };
      }
      if (property === "close") {
        return async () => {
          const readyStore = await storeReadyPromise;
          return readyStore.close();
        };
      }
      if (property === "stopAllAgents") {
        return () => {
          void storeReadyPromise.then((readyStore) => readyStore.stopAllAgents());
        };
      }
      return async (...args: unknown[]) => {
        const readyStore = await storeReadyPromise;
        const value = readyStore[property as keyof LocalStore];
        if (typeof value !== "function") return value;
        return (value as (...methodArgs: unknown[]) => unknown).apply(readyStore, args);
      };
    },
  });
}

function createDeferredIndexingQueue(): IndexingQueueService {
  return new Proxy({} as IndexingQueueService, {
    get(_target, property) {
      if (property === "poke") {
        return () => {
          indexingQueue?.poke();
        };
      }
      if (property === "start") {
        return () => {
          indexingQueue?.start();
        };
      }
      if (property === "stop") {
        return async () => indexingQueue?.stop();
      }
      return undefined;
    },
  });
}

function brevynDataRoot(): string {
  return join(homedir(), app.isPackaged ? ".brevyn-community" : ".brevyn-community-dev");
}

function configureClaudeSdk(dataRoot: string): void {
  const configDir = join(dataRoot, "sdk-config");
  mkdirSync(configDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = configDir;
}

function startWatcherForMainWindow(dataRoot: string): void {
  if (store && mainWindow) {
    startWorkspaceFileWatcher(dataRoot, store, mainWindow);
  }
}
