import { BrowserWindow, dialog, ipcMain } from "electron";
import { existsSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { IPC_CHANNELS } from "../../types/ipc";
import type { AgentAttachment, AgentAttachmentDataInput } from "../../types/domain";
import type { IpcContext } from "./context";
import { requireString } from "./validation";
import { formatSize } from "../services/workspace-file-tree";

export function registerAttachmentsIpc({ store }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.attachmentsPick, async (event, threadIdInput: unknown) => {
    const threadId = requireString(threadIdInput, "Thread id");
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ["openFile", "multiSelections"] })
      : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
    if (result.canceled || result.filePaths.length === 0) return [];
    return result.filePaths.flatMap((sourcePath) => pendingAttachmentForPath(threadId, sourcePath));
  });

  ipcMain.handle(IPC_CHANNELS.attachmentsList, (_event, threadIdInput: unknown) => {
    return store.listAgentSessionFiles(requireString(threadIdInput, "Thread id"));
  });

  ipcMain.handle(IPC_CHANNELS.attachmentsSavePaths, async (event, input: unknown) => {
    const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const threadId = requireString(data.threadId, "Thread id");
    const paths = Array.isArray(data.paths) ? data.paths.flatMap((path) => {
      const value = typeof path === "string" ? path.trim() : "";
      return value ? [value] : [];
    }) : [];
    const attachments = await store.saveAgentAttachmentPaths(threadId, paths);
    event.sender.send(IPC_CHANNELS.filesChanged);
    return attachments;
  });

  ipcMain.handle(IPC_CHANNELS.attachmentsSaveData, async (event, input: unknown) => {
    const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const normalized: AgentAttachmentDataInput = {
      threadId: requireString(data.threadId, "Thread id"),
      name: requireString(data.name, "Attachment name"),
      mediaType: typeof data.mediaType === "string" ? data.mediaType : undefined,
      data: requireString(data.data, "Attachment data"),
    };
    const attachment = await store.saveAgentAttachmentData(normalized);
    event.sender.send(IPC_CHANNELS.filesChanged);
    return attachment;
  });

  ipcMain.handle(IPC_CHANNELS.attachmentsDelete, async (event, input: unknown) => {
    const data = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const deleted = await store.deleteAgentAttachment(
      requireString(data.threadId, "Thread id"),
      requireString(data.path, "Attachment path"),
    );
    event.sender.send(IPC_CHANNELS.filesChanged);
    return deleted;
  });
}

function pendingAttachmentForPath(threadId: string, sourcePath: string): AgentAttachment[] {
  if (!existsSync(sourcePath)) return [];
  const stats = statSync(sourcePath);
  if (!stats.isFile()) return [];
  const name = basename(sourcePath);
  return [{
    id: `pending-att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    name,
    kind: kindForAttachmentName(name),
    mimeType: undefined,
    size: stats.size,
    sizeLabel: formatSize(stats.size),
    path: sourcePath,
    sourcePath,
    pending: true,
    createdAt: new Date().toISOString(),
  }];
}

function kindForAttachmentName(name: string): AgentAttachment["kind"] {
  const extension = extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"].includes(extension)) return "image";
  if (extension === ".pdf") return "pdf";
  if (extension === ".docx" || extension === ".doc") return "docx";
  if (extension === ".pptx" || extension === ".ppt") return "pptx";
  if ([".xls", ".xlsx", ".csv", ".tsv"].includes(extension)) return "spreadsheet";
  if (extension === ".md") return "markdown";
  if ([".json", ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".c", ".cpp", ".h", ".css", ".html"].includes(extension)) return "code";
  if (extension === ".txt") return "text";
  return "unknown";
}
