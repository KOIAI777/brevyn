import { registerAgentIpc } from "./agent-ipc";
import { registerAgentGatewayIpc } from "./agent-gateway-ipc";
import { registerAppIpc } from "./app-ipc";
import { registerAttachmentsIpc } from "./attachments-ipc";
import type { IpcContext } from "./context";
import { registerFilesIpc } from "./files-ipc";
import { registerExternalSourcesIpc } from "./external-sources-ipc";
import { registerIndexingIpc } from "./indexing-ipc";
import { registerMemoryIpc } from "./memory-ipc";
import { registerProvidersIpc } from "./provider-ipc";
import { registerSourceCandidatesIpc } from "./source-candidates-ipc";
import { registerSkillsIpc } from "./skills-ipc";
import { registerTimetableIpc } from "./timetable-ipc";
import { registerUpdaterIpc } from "./updater-ipc";
import { registerVisionIpc } from "./vision-ipc";
import { registerWorkspaceIpc } from "./workspace-ipc";
import { createOpenWithService } from "../services/open-with-service";

export function registerIpcHandlers(ctx: IpcContext): void {
  if (!ctx.openWithService) {
    ctx.openWithService = createOpenWithService();
  }
  registerWorkspaceIpc(ctx);
  registerFilesIpc(ctx);
  registerExternalSourcesIpc(ctx);
  registerSourceCandidatesIpc(ctx);
  registerIndexingIpc(ctx);
  registerSkillsIpc(ctx);
  registerMemoryIpc(ctx);
  registerProvidersIpc(ctx);
  registerVisionIpc(ctx);
  registerTimetableIpc(ctx);
  registerAgentIpc(ctx);
  registerAgentGatewayIpc(ctx);
  registerAttachmentsIpc(ctx);
  registerUpdaterIpc();
  registerAppIpc(ctx);
}
