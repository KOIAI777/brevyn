import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../../types/ipc";
import type { IpcContext } from "./context";

export function registerAgentGatewayIpc({ store }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.agentGatewayStatus, () => store.agentGatewayStatus());
  ipcMain.handle(IPC_CHANNELS.agentGatewaySetEnabled, (_event, enabled: unknown) => store.setAgentGatewayEnabled(Boolean(enabled)));
}
