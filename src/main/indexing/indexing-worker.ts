import { parentPort, workerData } from "node:worker_threads";
import type { IndexingTaskRecord, IndexingWorkerResult } from "./indexing-types";
import { chunkParsedText } from "./chunking";
import { parseIndexingFile } from "./file-parser-adapter";

async function run(task: IndexingTaskRecord): Promise<IndexingWorkerResult> {
  const payload = task.payload;
  if (!payload.sourcePath) {
    throw new Error(`No local source path is available for ${payload.name}. Re-import the file before indexing.`);
  }

  const parsed = await parseIndexingFile({
    sourcePath: payload.sourcePath,
    kind: payload.kind,
  });
  const text = parsed.text;
  const chunked = chunkParsedText(parsed);

  return {
    fileId: payload.fileId,
    sourcePath: payload.sourcePath,
    chunkCount: chunked.chunks.length,
    charCount: text.length,
    byteCount: parsed.byteCount,
    sample: chunked.chunks[0]?.slice(0, 900) || text.slice(0, 900),
    warnings: parsed.warnings,
    chunks: chunked.chunks,
    chunkMetadata: chunked.metadata,
    metadata: parsed.metadata,
    derivedMarkdown: text,
    parsed,
    officeArtifact: parsed.officeArtifact,
  };
}

void run(workerData as IndexingTaskRecord)
  .then((result) => {
    parentPort?.postMessage({ ok: true, result });
  })
  .catch((error) => {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  });
