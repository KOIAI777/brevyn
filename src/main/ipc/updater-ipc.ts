import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../types/ipc";
import {
  checkForUpdates,
  downloadUpdate,
  dismissDownloadedUpdate,
  getUpdaterStatus,
  quitAndInstallUpdate,
} from "../updater/auto-updater";
import { getGitHubReleaseByTag, listGitHubReleases } from "../updater/github-release-service";

export function registerUpdaterIpc(): void {
  ipcMain.handle(IPC_CHANNELS.updaterCheck, async () => {
    await checkForUpdates();
  });

  ipcMain.handle(IPC_CHANNELS.updaterDownload, async () => {
    await downloadUpdate();
  });

  ipcMain.handle(IPC_CHANNELS.updaterStatus, () => getUpdaterStatus());

  ipcMain.handle(IPC_CHANNELS.updaterReleasesList, (_event, options) => listGitHubReleases(options));

  ipcMain.handle(IPC_CHANNELS.updaterReleaseByTag, (_event, tag) => getGitHubReleaseByTag(typeof tag === "string" ? tag : ""));

  ipcMain.handle(IPC_CHANNELS.updaterDismissDownloaded, () => dismissDownloadedUpdate());

  ipcMain.handle(IPC_CHANNELS.updaterQuitAndInstall, () => {
    quitAndInstallUpdate();
  });
}
