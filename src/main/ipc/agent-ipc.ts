import { BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../../types/ipc";
import type { IpcContext } from "./context";
import { normalizeAgentApprovalInput, normalizeAgentAskUserResponseInput, normalizeAgentExitPlanResponseInput, normalizeAgentQueueMessageInput, normalizeAgentRunInput, requireString } from "./validation";

export function registerAgentIpc({ store }: IpcContext): void {
  ipcMain.handle(IPC_CHANNELS.agentMessages, (_event, threadId: unknown) => store.agentMessages(requireString(threadId, "Thread id")));
  ipcMain.handle(IPC_CHANNELS.agentUsageSummary, () => store.agentUsageSummary());
  ipcMain.handle(IPC_CHANNELS.agentRun, (_event, input: unknown) => store.runAgent(normalizeAgentRunInput(input)));
  ipcMain.handle(IPC_CHANNELS.agentQueueMessage, (_event, input: unknown) => store.queueAgentMessage(normalizeAgentQueueMessageInput(input)));
  ipcMain.handle(IPC_CHANNELS.agentStop, (_event, threadId: unknown) => store.stopAgent(requireString(threadId, "Thread id")));
  ipcMain.handle(IPC_CHANNELS.agentApprove, (_event, input: unknown) => store.approveAgent(normalizeAgentApprovalInput(input)));
  ipcMain.handle(IPC_CHANNELS.agentReject, (_event, input: unknown) => store.rejectAgent(normalizeAgentApprovalInput(input)));
  ipcMain.handle(IPC_CHANNELS.agentAnswerQuestion, (_event, input: unknown) => store.answerAgentQuestion(normalizeAgentAskUserResponseInput(input)));
  ipcMain.handle(IPC_CHANNELS.agentResolveExitPlan, (_event, input: unknown) => store.resolveAgentExitPlan(normalizeAgentExitPlanResponseInput(input)));

  try {
    store.onAgentEvent((agentEvent) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.webContents.isDestroyed()) {
          window.webContents.send(IPC_CHANNELS.agentEvent, agentEvent);
        }
      }
    });
  } catch (error) {
    console.warn("[agent-ipc] Agent event stream unavailable", error);
  }
}
