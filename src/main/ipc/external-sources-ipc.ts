import { BrowserWindow, dialog, ipcMain } from "electron";
import type { OpenDialogOptions } from "electron";
import { IPC_CHANNELS } from "../../types/ipc";
import type { ExternalSourceAddFilesInput, ExternalSourceAddUrlInput, ExternalSourceListInput } from "../../types/domain";
import type { IpcContext } from "./context";
import { requireString } from "./validation";

export function registerExternalSourcesIpc({ store, indexingQueue }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.externalSourcesList, (_event, rawInput: unknown) => {
    return store.listExternalSources(normalizeExternalSourceListInput(rawInput));
  });
  ipcMain.handle(IPC_CHANNELS.externalSourcesAddUrl, async (event, rawInput: unknown) => {
    const result = await store.addExternalSourceUrl(normalizeExternalSourceAddUrlInput(rawInput));
    if (result.indexingJob) indexingQueue?.poke();
    event.sender.send(IPC_CHANNELS.filesChanged);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.externalSourcesAddFiles, async (event, rawInput: unknown) => {
    const input = normalizeExternalSourceAddFilesInput(rawInput);
    const window = BrowserWindow.fromWebContents(event.sender);
    const options: OpenDialogOptions = {
      title: "添加外部来源",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "资料文件", extensions: ["pdf", "docx", "pptx", "xlsx", "xls", "csv", "md", "txt"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    };
    const dialogResult = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (dialogResult.canceled) {
      return { sources: [], tree: await store.listFiles(input.courseId), indexingJob: null };
    }
    const result = await store.addExternalSourceFiles({ ...input, sourcePaths: dialogResult.filePaths });
    if (result.indexingJob) indexingQueue?.poke();
    event.sender.send(IPC_CHANNELS.filesChanged);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.externalSourcesRetry, async (event, sourceId: unknown) => {
    const result = await store.retryExternalSource(requireString(sourceId, "Source id"));
    if (result.indexingJob) indexingQueue?.poke();
    event.sender.send(IPC_CHANNELS.filesChanged);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.externalSourcesDelete, async (event, sourceId: unknown) => {
    const result = await store.deleteExternalSource(requireString(sourceId, "Source id"));
    event.sender.send(IPC_CHANNELS.filesChanged);
    return result;
  });
}

function normalizeExternalSourceListInput(value: unknown): ExternalSourceListInput {
  if (!value || typeof value !== "object") throw new Error("来源范围不能为空。");
  const input = value as Record<string, unknown>;
  return {
    courseId: requireString(input.courseId, "Course id"),
    taskId: optionalTrimmedString(input.taskId),
  };
}

function normalizeExternalSourceAddUrlInput(value: unknown): ExternalSourceAddUrlInput {
  if (!value || typeof value !== "object") throw new Error("来源参数不能为空。");
  const input = value as Record<string, unknown>;
  return {
    courseId: requireString(input.courseId, "Course id"),
    taskId: optionalTrimmedString(input.taskId),
    scope: input.scope === "task" ? "task" : "course",
    url: requireString(input.url, "URL"),
    title: optionalTrimmedString(input.title),
  };
}

function normalizeExternalSourceAddFilesInput(value: unknown): ExternalSourceAddFilesInput {
  if (!value || typeof value !== "object") throw new Error("来源参数不能为空。");
  const input = value as Record<string, unknown>;
  return {
    courseId: requireString(input.courseId, "Course id"),
    taskId: optionalTrimmedString(input.taskId),
    scope: input.scope === "task" ? "task" : "course",
  };
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
