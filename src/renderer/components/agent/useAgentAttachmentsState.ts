import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import type { AgentAttachment, WorkspaceFileKind } from "@/types/domain";
import {
  deletePendingAttachmentData,
  LONG_TEXT_ATTACHMENT_THRESHOLD,
  MAX_PENDING_ATTACHMENT_BYTES,
  setPendingAttachmentData,
} from "@/components/agent/pendingAttachmentData";

const ATTACHMENT_TOAST_MS = 3_800;

export function useAgentAttachmentsState({ threadId }: { threadId: string; running: boolean }) {
  const [pendingAttachmentsByThread, setPendingAttachmentsByThread] = useState<Record<string, AgentAttachment[]>>({});
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [attachmentToastMessage, setAttachmentToastMessage] = useState("");
  const attachmentToastTimerRef = useRef<number | null>(null);
  const pendingAttachments = pendingAttachmentsByThread[threadId] || [];

  useEffect(() => {
    setDraggingFiles(false);
  }, [threadId]);

  useEffect(() => () => {
    if (attachmentToastTimerRef.current) window.clearTimeout(attachmentToastTimerRef.current);
  }, []);

  function setPendingAttachmentsForThread(targetThreadId: string, updater: (current: AgentAttachment[]) => AgentAttachment[]) {
    setPendingAttachmentsByThread((currentByThread) => {
      const nextAttachments = updater(currentByThread[targetThreadId] || []);
      const nextByThread = { ...currentByThread };
      if (nextAttachments.length === 0) delete nextByThread[targetThreadId];
      else nextByThread[targetThreadId] = nextAttachments;
      return nextByThread;
    });
  }

  async function pickAttachments() {
    const next = await window.brevyn.attachments.pick(threadId);
    if (next.length) setPendingAttachmentsForThread(threadId, (current) => mergeAttachments(current, next));
  }

  async function addDroppedFiles(files: File[]): Promise<number> {
    if (files.length === 0) return 0;
    const targetThreadId = threadId;
    const attachments: AgentAttachment[] = [];
    const rejectedLargeFiles: string[] = [];
    for (const file of files) {
      try {
        const sourcePath = safePathForFile(file);
        if (!sourcePath && file.size > MAX_PENDING_ATTACHMENT_BYTES) {
          rejectedLargeFiles.push(file.name || "未命名文件");
          continue;
        }
        attachments.push(await pendingAttachmentForFile(targetThreadId, file, sourcePath));
      } catch (error) {
        console.error("[AgentComposer] Failed to add attachment:", error);
        showAttachmentToast(`附件添加失败：${file.name || "未命名文件"}`);
      }
    }
    if (attachments.length > 0) setPendingAttachmentsForThread(targetThreadId, (current) => mergeAttachments(current, attachments));
    if (rejectedLargeFiles.length > 0) {
      showAttachmentToast(`文件过大，请从文件选择器添加：${rejectedLargeFiles.slice(0, 2).join("、")}`);
    }
    return attachments.length;
  }

  async function removeAttachment(attachment: AgentAttachment) {
    setPendingAttachmentsForThread(threadId, (current) => current.filter((item) => item.id !== attachment.id));
    if (attachment.pending) {
      deletePendingAttachmentData(attachment.id);
      return;
    }
    try {
      await window.brevyn.attachments.delete({ threadId: attachment.threadId || threadId, path: attachment.path });
    } catch (error) {
      console.error("[AgentComposer] Failed to delete pending attachment:", error);
    }
  }

  function restoreAttachments(attachments: AgentAttachment[], targetThreadId = threadId) {
    setPendingAttachmentsForThread(targetThreadId, (current) => mergeAttachments(attachments, current));
  }

  function clearAttachments(): AgentAttachment[] {
    const attachments = pendingAttachments;
    setPendingAttachmentsForThread(threadId, () => []);
    return attachments;
  }

  function handlePaste(event: ClipboardEvent<HTMLElement>, pastedText?: string) {
    const files = Array.from(event.clipboardData.files || []);
    if (files.length > 0) {
      event.preventDefault();
      void addDroppedFiles(files);
      return;
    }

    const plainText = event.clipboardData.getData("text/plain") || "";
    const text = pastedText || plainText;
    if (plainText.length < LONG_TEXT_ATTACHMENT_THRESHOLD && text.length < LONG_TEXT_ATTACHMENT_THRESHOLD) return;
    event.preventDefault();
    void addClipboardTextAttachment(text);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDraggingFiles(false);
    void addDroppedFiles(Array.from(event.dataTransfer.files || []));
  }

  return {
    pendingAttachments,
    draggingFiles,
    attachmentToastMessage,
    setDraggingFiles,
    pickAttachments,
    removeAttachment,
    restoreAttachments,
    clearAttachments,
    handlePaste,
    handleDrop,
  };

  async function addClipboardTextAttachment(text: string) {
    const file = clipboardTextFile(text);
    const added = await addDroppedFiles([file]);
    if (added > 0) showAttachmentToast(`已将超长文本转为附件：${file.name}`);
  }

  function showAttachmentToast(message: string): void {
    if (attachmentToastTimerRef.current) window.clearTimeout(attachmentToastTimerRef.current);
    setAttachmentToastMessage(message);
    attachmentToastTimerRef.current = window.setTimeout(() => {
      setAttachmentToastMessage("");
      attachmentToastTimerRef.current = null;
    }, ATTACHMENT_TOAST_MS);
  }
}

function mergeAttachments(current: AgentAttachment[], next: AgentAttachment[]): AgentAttachment[] {
  const seen = new Set(current.map(attachmentIdentity));
  return [...current, ...next.filter((item) => {
    const identity = attachmentIdentity(item);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  })];
}

async function pendingAttachmentForFile(threadId: string, file: File, sourcePath: string): Promise<AgentAttachment> {
  const name = file.name || `pasted-file-${Date.now()}`;
  const attachment: AgentAttachment = {
    id: `pending-att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    name,
    kind: kindForAttachmentName(name, file.type),
    mimeType: file.type || undefined,
    size: file.size,
    sizeLabel: formatSize(file.size),
    path: sourcePath || name,
    sourcePath: sourcePath || undefined,
    pending: true,
    createdAt: new Date().toISOString(),
  };
  if (!sourcePath) {
    setPendingAttachmentData(attachment.id, await fileToBase64(file));
  }
  return attachment;
}

function attachmentIdentity(attachment: AgentAttachment): string {
  if (attachment.pending && !attachment.sourcePath) return attachment.id;
  return attachment.sourcePath || attachment.path || attachment.id;
}

function kindForAttachmentName(name: string, mimeType?: string): WorkspaceFileKind {
  if (mimeType?.startsWith("image/")) return "image";
  const extension = name.toLowerCase().slice(name.lastIndexOf("."));
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Failed to read attachment."));
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.slice(value.indexOf(",") + 1) : value);
    };
    reader.readAsDataURL(file);
  });
}

function safePathForFile(file: File): string {
  try {
    return window.brevyn.attachments.pathForFile(file) || "";
  } catch {
    return "";
  }
}

function clipboardTextFile(text: string): File {
  const isMarkdown = looksLikeMarkdown(text);
  const extension = isMarkdown ? "md" : "txt";
  const mediaType = isMarkdown ? "text/markdown" : "text/plain";
  return new File([text], `clipboard-${formatClipboardTimestamp()}.${extension}`, { type: mediaType });
}

function formatClipboardTimestamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function looksLikeMarkdown(text: string): boolean {
  return [
    /^#{1,6}\s+\S/m,
    /```[\s\S]*?```/,
    /^\s*\|.+\|\s*\n\s*\|[\s:-]+\|/m,
    /^---\n[\s\S]*?\n---\n/,
    /^\s*> .+/m,
    /^\s*[-*+]\s+\S/m,
    /^\s*\d+\.\s+\S/m,
    /\[[^\]]+\]\([^)]+\)/,
  ].some((pattern) => pattern.test(text));
}
