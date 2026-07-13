import { closeSync, openSync, readSync } from "node:fs";
import type JSZip from "jszip";
import type { ParsedIndexingFile, ParseInput } from "./types";

export const MAX_PARSED_CHARS = 900_000;

export function normalizeText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function readFilePrefix(sourcePath: string, bytesToRead: number): Buffer {
  if (bytesToRead <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(bytesToRead);
  let fd: number | undefined;
  try {
    fd = openSync(sourcePath, "r");
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
    return bytesRead === bytesToRead ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function capParsedText(text: string, warnings: string[]): { text: string; truncated: boolean } {
  if (text.length <= MAX_PARSED_CHARS) {
    return { text, truncated: false };
  }
  warnings.push(`Parsed text was capped at ${MAX_PARSED_CHARS} characters for this indexing pass.`);
  return { text: text.slice(0, MAX_PARSED_CHARS), truncated: true };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

export function emptyParsedFile(input: ParseInput, byteCount: number, warning: string): ParsedIndexingFile {
  return {
    text: "",
    byteCount,
    warnings: [warning],
    metadata: {
      parser: "unsupported",
      kind: input.kind,
      truncated: false,
    },
  };
}

export function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function numberFromPath(path: string): number {
  const match = path.match(/(\d+)(?=\.xml$)/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

export function sortedZipFiles(zip: JSZip, pattern: RegExp): JSZip.JSZipObject[] {
  return Object.values(zip.files)
    .filter((file) => !file.dir && pattern.test(file.name))
    .sort((a, b) => numberFromPath(a.name) - numberFromPath(b.name));
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export async function collectConsoleWarnings<T>(action: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  const capture = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    if (message.startsWith("Warning:")) {
      warnings.push(message);
      return;
    }
    originalLog(...args);
  };
  console.log = capture;
  console.warn = (...args: unknown[]) => {
    const message = args.map(String).join(" ");
    warnings.push(message);
  };
  try {
    const result = await action();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { result, warnings: dedupeWarnings(warnings) };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
}

export function dedupeWarnings(warnings: string[]): string[] {
  return Array.from(new Set(warnings)).slice(0, 8);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

