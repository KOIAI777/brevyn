import { BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { OpenDialogOptions } from "electron";
import { IPC_CHANNELS } from "../../types/ipc";
import type { IpcContext } from "./context";
import { normalizeDeleteFileInput, normalizeFileImportInput, optionalString, requireString } from "./validation";

export function registerFilesIpc({ store, indexingQueue }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.filesTree, (_event, courseId?: unknown) => store.listFiles(optionalString(courseId)));
  ipcMain.handle(IPC_CHANNELS.filesPreview, (_event, fileId: unknown) => store.previewFile(requireString(fileId, "File id")));
  ipcMain.handle(IPC_CHANNELS.filesParsedPreview, (_event, fileId: unknown) => store.previewParsedFile(requireString(fileId, "File id")));
  ipcMain.handle(IPC_CHANNELS.filesImport, async (event, rawInput: unknown) => {
    const input = normalizeFileImportInput(rawInput);
    if (input.sourcePaths?.length) {
      throw new Error("File import paths must be selected from the system file dialog.");
    }
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "Import course files",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Course files",
          extensions: [
            "pdf",
            "docx",
            "ppt",
            "pptx",
            "png",
            "jpg",
            "jpeg",
            "md",
            "txt",
            "ts",
            "tsx",
            "js",
            "jsx",
            "py",
            "java",
            "cpp",
            "c",
            "zip",
          ],
        },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const dialogResult = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (dialogResult.canceled) {
      return { files: [], tree: await store.listFiles(input.courseId), indexingJob: null };
    }
    const sourcePaths = dialogResult.filePaths;
    const result = await store.importFiles({ ...input, sourcePaths });
    if (result.indexingJob) indexingQueue?.poke();
    if (result.files.length > 0) event.sender.send(IPC_CHANNELS.filesChanged);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.filesSections, (_event, courseId: unknown) => store.courseFileSections(requireString(courseId, "Course id")));
  ipcMain.handle(IPC_CHANNELS.filesStats, (_event, courseId?: unknown) => store.fileStats(optionalString(courseId)));
  ipcMain.handle(IPC_CHANNELS.filesOpen, async (_event, fileId: unknown) => {
    const sourcePath = await store.fileOpenPath(requireString(fileId, "File id"));
    if (!sourcePath) throw new Error("文件源路径不可用。");
    const error = await shell.openPath(sourcePath);
    if (error) throw new Error(error);
  });
  ipcMain.handle(IPC_CHANNELS.filesRename, async (event, rawInput: unknown) => {
    const input = normalizeRenameInput(rawInput);
    const result = await store.renameFile(input.fileId, input.name);
    event.sender.send(IPC_CHANNELS.filesChanged);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.filesDelete, async (event, rawInput: unknown) => {
    const result = await store.deleteFile(normalizeDeleteFileInput(rawInput));
    event.sender.send(IPC_CHANNELS.filesChanged);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.filesReveal, async (_event, fileId: unknown) => {
    const sourcePath = await store.fileOpenPath(requireString(fileId, "File id"));
    if (!sourcePath) throw new Error("文件源路径不可用。");
    shell.showItemInFolder(sourcePath);
  });
}

function normalizeRenameInput(value: unknown): { fileId: string; name: string } {
  if (!value || typeof value !== "object") throw new Error("重命名参数不能为空。");
  const input = value as Record<string, unknown>;
  return {
    fileId: requireString(input.fileId, "File id"),
    name: requireString(input.name, "File name"),
  };
}
