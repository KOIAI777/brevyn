import { BrowserWindow, dialog, ipcMain } from "electron";
import type { OpenDialogOptions } from "electron";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { IPC_CHANNELS } from "../../types/ipc";
import type { IpcContext } from "./context";
import { normalizeRecognizedAcademicCalendar, normalizeRecognizedCourseTimetable, normalizeVisionRecognitionInput, requireString } from "./validation";

const MAX_PREVIEW_IMAGE_BYTES = 18 * 1024 * 1024;

export function registerVisionIpc({ store }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.visionPickImage, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Pick image for vision recognition",
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] || null;
  });
  ipcMain.handle(IPC_CHANNELS.visionPreviewImage, (_event, sourcePath: unknown) => imageDataUrl(requireString(sourcePath, "Image path")));
  ipcMain.handle(IPC_CHANNELS.visionRecognizeAcademicCalendar, (_event, input: unknown) => store.recognizeAcademicCalendar(normalizeVisionRecognitionInput(input)));
  ipcMain.handle(IPC_CHANNELS.visionRecognizeCourseTimetable, (_event, input: unknown) => store.recognizeCourseTimetable(normalizeVisionRecognitionInput(input)));
  ipcMain.handle(IPC_CHANNELS.visionImportAcademicCalendar, async (event, input: unknown) => {
    const result = await store.importAcademicCalendar(normalizeRecognizedAcademicCalendar(input));
    event.sender.send(IPC_CHANNELS.filesChanged);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.visionImportCourseTimetable, async (event, input: unknown) => {
    const result = await store.importCourseTimetable(normalizeRecognizedCourseTimetable(input));
    event.sender.send(IPC_CHANNELS.filesChanged);
    return result;
  });
}

function imageDataUrl(sourcePath: string): string {
  if (!existsSync(sourcePath)) throw new Error(`Image file not found: ${sourcePath}`);
  const stats = statSync(sourcePath);
  if (!stats.isFile()) throw new Error("Selected path is not an image file.");
  if (stats.size > MAX_PREVIEW_IMAGE_BYTES) throw new Error("Image is too large to preview.");
  return `data:${mediaTypeForPath(sourcePath)};base64,${readFileSync(sourcePath).toString("base64")}`;
}

function mediaTypeForPath(sourcePath: string): string {
  const ext = extname(sourcePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  return "image/jpeg";
}
