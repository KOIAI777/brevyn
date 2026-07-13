import type { ParsedIndexingFile, ParseInput } from "./types";
import { capParsedText, formatBytes, normalizeText, readFilePrefix } from "./utils";

const MAX_TEXT_BYTES = 50 * 1024 * 1024;

export function parsePlainText(input: ParseInput, byteCount: number): ParsedIndexingFile {
  const bytesToRead = Math.min(byteCount, MAX_TEXT_BYTES);
  const raw = readFilePrefix(input.sourcePath, bytesToRead).toString("utf8");
  const warnings: string[] = [];
  const byteTruncated = byteCount > MAX_TEXT_BYTES;
  if (byteTruncated) warnings.push(`Read first ${formatBytes(MAX_TEXT_BYTES)} only; streaming text parsing is still pending.`);
  const capped = capParsedText(raw, warnings);
  return {
    text: normalizeText(capped.text),
    byteCount,
    warnings,
    metadata: {
      parser: "plain-text",
      kind: input.kind,
      coverageStatus: normalizeText(capped.text) ? "complete" : "skipped",
      truncated: byteTruncated || capped.truncated,
      bytesRead: bytesToRead,
    },
    sections: normalizeText(capped.text)
      ? [{ text: normalizeText(capped.text), sourceLabel: "全文", sectionType: "document", sectionIndex: 1 }]
      : undefined,
  };
}
