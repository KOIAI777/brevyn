import { BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../types/ipc";
import type { SourceCandidateChangedEvent, SourceCandidateListInput, SourceCandidateStatus } from "../../types/domain";
import type { IpcContext } from "./context";
import { requireString } from "./validation";

export function registerSourceCandidatesIpc({ store, indexingQueue }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.sourceCandidatesList, (_event, rawInput: unknown) => {
    return store.listSourceCandidates(normalizeSourceCandidateListInput(rawInput));
  });

  ipcMain.handle(IPC_CHANNELS.sourceCandidatesAccept, async (_event, candidateId: unknown) => {
    const result = await store.acceptSourceCandidate(requireString(candidateId, "Candidate id"));
    if (result.externalSourceResult?.indexingJob) indexingQueue?.poke();
    broadcastSourceCandidatesChanged({
      semesterId: result.candidate.semesterId,
      courseId: result.candidate.courseId,
      taskId: result.candidate.taskId,
      threadId: result.candidate.threadId,
      candidateId: result.candidate.id,
    });
    if (result.candidate.status === "accepted" && result.externalSourceResult) broadcastFilesChanged();
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.sourceCandidatesReject, (_event, candidateId: unknown) => {
    const candidate = store.rejectSourceCandidate(requireString(candidateId, "Candidate id"));
    broadcastSourceCandidatesChanged({
      semesterId: candidate.semesterId,
      courseId: candidate.courseId,
      taskId: candidate.taskId,
      threadId: candidate.threadId,
      candidateId: candidate.id,
    });
    return candidate;
  });
}

export function broadcastSourceCandidatesChanged(event: SourceCandidateChangedEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.sourceCandidatesChanged, event);
    }
  }
}

function broadcastFilesChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.filesChanged);
    }
  }
}

function normalizeSourceCandidateListInput(value: unknown): SourceCandidateListInput {
  if (!value || typeof value !== "object") throw new Error("候选来源范围不能为空。");
  const input = value as Record<string, unknown>;
  return {
    courseId: requireString(input.courseId, "Course id"),
    taskId: optionalTrimmedString(input.taskId),
    threadId: optionalTrimmedString(input.threadId),
    statuses: normalizeStatuses(input.statuses),
  };
}

function normalizeStatuses(value: unknown): SourceCandidateStatus[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const statuses = value.filter(isSourceCandidateStatus);
  return statuses.length > 0 ? statuses : undefined;
}

function isSourceCandidateStatus(value: unknown): value is SourceCandidateStatus {
  return value === "pending" || value === "accepting" || value === "accepted" || value === "rejected" || value === "failed";
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
