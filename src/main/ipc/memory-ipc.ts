import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../types/ipc";
import type { WorkspaceMemoryFileKind, WorkspaceMemoryReadInput, WorkspaceMemoryWriteInput } from "../../types/domain";
import type { IpcContext } from "./context";
import { requireObject } from "./validation";

export function registerMemoryIpc({ store }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.memorySummary, (_event, scopeId: unknown) => store.workspaceMemorySummary(optionalString(scopeId)));
  ipcMain.handle(IPC_CHANNELS.memoryReadFile, (_event, input: unknown) => store.readWorkspaceMemoryFile(normalizeWorkspaceMemoryReadInput(input)));
  ipcMain.handle(IPC_CHANNELS.memoryWriteFile, (_event, input: unknown) => store.writeWorkspaceMemoryFile(normalizeWorkspaceMemoryWriteInput(input)));
}

function normalizeMemoryFileKind(value: unknown): WorkspaceMemoryFileKind {
  return value === "auto" ? "auto" : "claude";
}

function normalizeWorkspaceMemoryReadInput(value: unknown): WorkspaceMemoryReadInput {
  if (typeof value === "string") {
    return { kind: normalizeMemoryFileKind(value) };
  }
  const input = requireObject(value, "Memory read input");
  return {
    scopeId: optionalString(input.scopeId),
    kind: normalizeMemoryFileKind(input.kind),
    relativePath: optionalString(input.relativePath),
  };
}

function normalizeWorkspaceMemoryWriteInput(value: unknown): WorkspaceMemoryWriteInput {
  const input = requireObject(value, "Memory write input");
  return {
    scopeId: optionalString(input.scopeId),
    kind: normalizeMemoryFileKind(input.kind),
    relativePath: optionalString(input.relativePath),
    content: typeof input.content === "string" ? input.content : "",
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
