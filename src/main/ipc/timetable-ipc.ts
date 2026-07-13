import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../types/ipc";
import type { IpcContext } from "./context";
import { normalizeTimetableRangeQuery } from "./validation";

export function registerTimetableIpc({ store }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.timetableRange, (_event, query: unknown) => store.listTimetableEvents(normalizeTimetableRangeQuery(query)));
}
