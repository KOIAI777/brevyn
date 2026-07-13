import type { ContextAnchor, FileContextAnchor, MessageContextAnchor } from "../types/domain";

export const MAX_CONTEXT_ANCHOR_CHARS = 2000;

export interface ParsedContextAnchorRef {
  kind: "file" | "message";
  path: string;
  filename: string;
  role?: "user" | "assistant";
  page?: number;
  semanticUnitId?: string;
  sourceLabel?: string;
}

const quotedFileRegex = /<quoted_file[^>]*>[\s\S]*?<\/quoted_file>\n*/g;
const quotedMessageRegex = /<quoted_message[^>]*>[\s\S]*?<\/quoted_message>\n*/g;

export function contextAnchorId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ? `quote_${randomId}` : `quote_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createFileContextAnchor(input: {
  threadId: string;
  text: string;
  filePath: string;
  capturedAt?: number;
  fileId?: string;
  page?: number;
  slide?: number;
  sheet?: string;
  range?: string;
  semanticUnitId?: string;
  bbox?: string;
  sourceLabel?: string;
}): FileContextAnchor {
  const filePath = input.filePath.trim();
  return {
    id: contextAnchorId(),
    kind: "file",
    threadId: input.threadId,
    text: input.text.slice(0, MAX_CONTEXT_ANCHOR_CHARS),
    filePath,
    fileName: contextAnchorFileName(filePath),
    fileId: input.fileId,
    page: input.page,
    slide: input.slide,
    sheet: input.sheet,
    range: input.range,
    semanticUnitId: input.semanticUnitId,
    bbox: input.bbox,
    sourceLabel: input.sourceLabel,
    capturedAt: input.capturedAt ?? Date.now(),
  };
}

export function createMessageContextAnchor(input: {
  threadId: string;
  text: string;
  role: "user" | "assistant";
  capturedAt?: number;
  messageId?: string;
}): MessageContextAnchor {
  return {
    id: contextAnchorId(),
    kind: "message",
    threadId: input.threadId,
    text: input.text.slice(0, MAX_CONTEXT_ANCHOR_CHARS),
    role: input.role,
    label: input.role === "user" ? "用户消息" : "Brevyn 回复",
    messageId: input.messageId,
    capturedAt: input.capturedAt ?? Date.now(),
  };
}

export function promptWithContextAnchors(prompt: string, anchors?: ContextAnchor | ContextAnchor[] | null): string {
  const items = Array.isArray(anchors) ? anchors : anchors ? [anchors] : [];
  const blocks = items
    .filter((item) => item.text.trim())
    .map((item) => contextAnchorBlock(item));
  if (blocks.length === 0) return prompt;
  return `${blocks.join("\n\n")}\n\n${prompt}`.trim();
}

export function parseContextAnchors(content: string): { anchors: ParsedContextAnchorRef[]; text: string } {
  const anchors: ParsedContextAnchorRef[] = [];
  quotedFileRegex.lastIndex = 0;
  quotedMessageRegex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = quotedFileRegex.exec(content)) !== null) {
    const pathMatch = match[0].match(/path="([^"]*)"/);
    if (!pathMatch?.[1]) continue;
    const path = decodeXmlAttribute(pathMatch[1]);
    const pageMatch = match[0].match(/page="([^"]*)"/);
    const semanticUnitMatch = match[0].match(/semantic_unit_id="([^"]*)"/);
    const sourceLabelMatch = match[0].match(/source_label="([^"]*)"/);
    const page = pageMatch?.[1] ? Number(pageMatch[1]) : undefined;
    anchors.push({
      kind: "file",
      path,
      filename: contextAnchorFileName(path),
      page: Number.isFinite(page) ? page : undefined,
      semanticUnitId: semanticUnitMatch?.[1] ? decodeXmlAttribute(semanticUnitMatch[1]) : undefined,
      sourceLabel: sourceLabelMatch?.[1] ? decodeXmlAttribute(sourceLabelMatch[1]) : undefined,
    });
  }
  while ((match = quotedMessageRegex.exec(content)) !== null) {
    const roleMatch = match[0].match(/role="([^"]*)"/);
    const role = roleMatch?.[1] === "user" ? "user" : "assistant";
    anchors.push({
      kind: "message",
      path: "",
      filename: role === "user" ? "用户消息" : "Brevyn 回复",
      role,
    });
  }
  return {
    anchors,
    text: stripContextAnchors(content),
  };
}

export function stripContextAnchors(content: string): string {
  return content
    .replace(quotedFileRegex, "")
    .replace(quotedMessageRegex, "")
    .trim();
}

export function contextAnchorLabel(anchor: ContextAnchor | ParsedContextAnchorRef): string {
  if (anchor.kind === "message") {
    if ("label" in anchor) return anchor.label;
    return anchor.role === "user" ? "用户消息" : "Brevyn 回复";
  }
  if ("fileName" in anchor) return anchor.fileName;
  return anchor.filename;
}

export function contextAnchorPath(anchor: ContextAnchor | ParsedContextAnchorRef): string {
  if (anchor.kind === "message") return "";
  if ("filePath" in anchor) return anchor.filePath;
  return anchor.path;
}

export function contextAnchorSourceLabel(anchor: ContextAnchor | ParsedContextAnchorRef): string {
  if (anchor.kind === "message") return "";
  if (anchor.sourceLabel) return anchor.sourceLabel;
  if (typeof anchor.page === "number") return `第 ${anchor.page} 页`;
  return "";
}

function contextAnchorBlock(anchor: ContextAnchor): string {
  if (anchor.kind === "message") {
    const safeText = anchor.text.replace(/<\/quoted_message>/gi, "</quoted_message_>");
    return `<quoted_message thread_id="${encodeXmlAttribute(anchor.threadId)}" role="${anchor.role}">\n${safeText}\n</quoted_message>`;
  }
  const safeText = anchor.text.replace(/<\/quoted_file>/gi, "</quoted_file_>");
  return `<quoted_file ${quotedFileAttributes(anchor)}>\n${safeText}\n</quoted_file>`;
}

function quotedFileAttributes(anchor: FileContextAnchor): string {
  const attrs = [`path="${encodeXmlAttribute(anchor.filePath)}"`];
  if (typeof anchor.page === "number") attrs.push(`page="${anchor.page}"`);
  if (anchor.sourceLabel) attrs.push(`source_label="${encodeXmlAttribute(anchor.sourceLabel)}"`);
  if (anchor.semanticUnitId) attrs.push(`semantic_unit_id="${encodeXmlAttribute(anchor.semanticUnitId)}"`);
  return attrs.join(" ");
}

function encodeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function contextAnchorFileName(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/");
  return normalized.split("/").filter(Boolean).at(-1) || filePath.trim();
}
