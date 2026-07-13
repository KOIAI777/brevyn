import type { AgentAttachment } from "@/types/domain";
import { clearPendingAttachmentData, getPendingAttachmentData } from "@/components/agent/pendingAttachmentData";

export async function persistAgentAttachments(threadId: string, attachments?: AgentAttachment[]): Promise<AgentAttachment[]> {
  if (!attachments?.length) return [];
  const persisted: AgentAttachment[] = [];
  try {
    for (const attachment of attachments) {
      persisted.push(await persistAgentAttachment(threadId, attachment));
    }
    return persisted;
  } catch (error) {
    await deletePersistedAgentAttachments(persisted);
    throw error;
  }
}

export async function deletePersistedAgentAttachments(attachments: AgentAttachment[]): Promise<void> {
  await Promise.all(attachments.map((attachment) => {
    if (!attachment.persistedFromPending) return Promise.resolve();
    return window.brevyn.attachments.delete({
      threadId: attachment.threadId,
      path: attachment.path,
    }).catch((error) => {
      console.error("[AgentComposer] Failed to delete persisted attachment after send failure:", error);
    });
  }));
}

export function agentAttachmentsForRun(attachments: AgentAttachment[]): AgentAttachment[] {
  return attachments.map((attachment) => {
    const {
      pending: _pending,
      sourcePath: _sourcePath,
      persistedFromPending: _persistedFromPending,
      ...runAttachment
    } = attachment;
    return runAttachment;
  });
}

export function clearPendingAgentAttachmentData(attachments: AgentAttachment[]): void {
  clearPendingAttachmentData(attachments);
}

async function persistAgentAttachment(threadId: string, attachment: AgentAttachment): Promise<AgentAttachment> {
  if (!attachment.pending) return attachment;
  if (attachment.sourcePath) {
    const [saved] = await window.brevyn.attachments.savePaths({ threadId, paths: [attachment.sourcePath] });
    if (!saved) throw new Error(`附件不可用：${attachment.name}`);
    return { ...saved, persistedFromPending: true };
  }
  const data = getPendingAttachmentData(attachment.id);
  if (data) {
    const saved = await window.brevyn.attachments.saveData({
      threadId,
      name: attachment.name,
      mediaType: attachment.mimeType,
      data,
    });
    return { ...saved, persistedFromPending: true };
  }
  throw new Error(`附件数据已失效：${attachment.name}`);
}
