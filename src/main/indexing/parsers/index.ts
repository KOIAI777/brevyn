import { statSync } from "node:fs";
import type { WorkspaceFileKind } from "../../../types/domain";
import { parseDocx } from "./docx-parser";
import { parsePdf } from "./pdf-parser";
import { parsePptx } from "./pptx-parser";
import { parseSpreadsheet } from "./spreadsheet-parser";
import { parsePlainText } from "./text-parser";
import type { ParsedIndexingFile, ParseInput } from "./types";
import { emptyParsedFile, formatBytes, normalizeText } from "./utils";

export type { ParsedIndexingFile, ParseInput } from "./types";
export { normalizeText };

const TEXT_KINDS = new Set<WorkspaceFileKind>(["markdown", "code", "text"]);
const MAX_INDEXING_FILE_BYTES = 50 * 1024 * 1024;

export async function parseIndexingFile(input: ParseInput): Promise<ParsedIndexingFile> {
  const stats = statSync(input.sourcePath);
  if (stats.size > MAX_INDEXING_FILE_BYTES) {
    return emptyParsedFile(input, stats.size, `Skipped indexing because the file is larger than ${formatBytes(MAX_INDEXING_FILE_BYTES)}.`);
  }
  try {
    if (TEXT_KINDS.has(input.kind)) {
      return parsePlainText(input, stats.size);
    }
    if (input.kind === "docx") {
      return await parseDocx(input, stats.size);
    }
    if (input.kind === "pdf") {
      return await parsePdf(input, stats.size);
    }
    if (input.kind === "pptx") {
      return await parsePptx(input, stats.size);
    }
    if (input.kind === "spreadsheet") {
      return await parseSpreadsheet(input, stats.size);
    }
  } catch (error) {
    return emptyParsedFile(input, stats.size, `${input.kind.toUpperCase()} local extraction failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (input.kind === "image") {
    return emptyParsedFile(input, stats.size, "Image multimodal indexing is reserved for the vision parser adapter.");
  }
  return emptyParsedFile(input, stats.size, `${input.kind.toUpperCase()} parser is not enabled for RAG indexing yet.`);
}
