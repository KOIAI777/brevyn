import type { AgentAttachment } from "@/types/domain";

export const MAX_PENDING_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const LONG_TEXT_ATTACHMENT_THRESHOLD = 2_000;

const pendingAttachmentData = new Map<string, string>();

export function setPendingAttachmentData(attachmentId: string, data: string): void {
  pendingAttachmentData.set(attachmentId, data);
}

export function getPendingAttachmentData(attachmentId: string): string | undefined {
  return pendingAttachmentData.get(attachmentId);
}

export function deletePendingAttachmentData(attachmentId: string): void {
  pendingAttachmentData.delete(attachmentId);
}

export function clearPendingAttachmentData(attachments: AgentAttachment[]): void {
  for (const attachment of attachments) {
    deletePendingAttachmentData(attachment.id);
  }
}
