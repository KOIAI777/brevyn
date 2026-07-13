import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../types/ipc";
import type { IpcContext } from "./context";
import { optionalString, requireString } from "./validation";

export function registerIndexingIpc({ store, indexingQueue }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.filesIndex, async (event, courseId: unknown, sectionId?: unknown) => {
    const job = await store.reindexCourseFiles(requireString(courseId, "Course id"), optionalString(sectionId));
    indexingQueue?.poke();
    event.sender.send(IPC_CHANNELS.filesChanged);
    return job;
  });
  ipcMain.handle(IPC_CHANNELS.filesRetryIndex, async (event, fileId: unknown) => {
    const job = await store.retryIndexingFile(requireString(fileId, "File id"));
    indexingQueue?.poke();
    event.sender.send(IPC_CHANNELS.filesChanged);
    return job;
  });
  ipcMain.handle(IPC_CHANNELS.filesIndexActiveSemester, async (event) => {
    const result = await store.indexActiveSemesterCourses();
    if (result.jobs.length > 0) indexingQueue?.poke();
    if (result.jobs.length > 0) event.sender.send(IPC_CHANNELS.filesChanged);
    return result;
  });
  ipcMain.handle(IPC_CHANNELS.filesIndexHealth, (_event, courseId?: unknown) => store.embeddingIndexHealth(optionalString(courseId)));
  ipcMain.handle(IPC_CHANNELS.filesIndexingJobs, (_event, courseId?: unknown) => store.listIndexingJobs(optionalString(courseId)));
  ipcMain.handle(IPC_CHANNELS.filesIndexingCancel, async (event, jobId: unknown) => {
    const job = await store.cancelIndexingJob(requireString(jobId, "Indexing job id"));
    event.sender.send(IPC_CHANNELS.filesChanged);
    return job;
  });
  ipcMain.handle(IPC_CHANNELS.ragSearch, (_event, query: unknown, courseId?: unknown) => store.searchRag(requireString(query, "RAG query"), optionalString(courseId)));
}
