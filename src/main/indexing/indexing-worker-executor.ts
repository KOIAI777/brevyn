import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { IndexingTaskRecord, IndexingWorkerResult } from "./indexing-types";
import type { DocumentParseService } from "../services/document-parse-service";

export interface IndexingExecutor {
  run(task: IndexingTaskRecord): Promise<IndexingWorkerResult>;
}

export class DocumentEnhancedIndexingExecutor implements IndexingExecutor {
  constructor(
    private readonly base: IndexingExecutor,
    private readonly documentParser: DocumentParseService,
  ) {}

  async run(task: IndexingTaskRecord): Promise<IndexingWorkerResult> {
    const result = await this.base.run(task);
    if (task.payload.sourcePath) {
      const documentEnhanced = await this.documentParser.enhanceIndexingResult({
        sourcePath: task.payload.sourcePath,
        kind: task.payload.kind,
        parsed: result.parsed,
        result,
        fileName: task.payload.name,
      });
      return stripTransientParsed(documentEnhanced || result);
    }
    return stripTransientParsed(result);
  }
}

type WorkerMessage =
  | { ok: true; result: IndexingWorkerResult }
  | { ok: false; error: string };

export class WorkerThreadIndexingExecutor implements IndexingExecutor {
  constructor(
    private readonly workerPath = join(__dirname, "indexing-worker.cjs"),
    private readonly timeoutMs = 120_000,
  ) {}

  run(task: IndexingTaskRecord): Promise<IndexingWorkerResult> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath, { workerData: task });
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        void worker.terminate();
        reject(new Error(`Indexing worker timed out for ${task.payload.name}.`));
      }, this.timeoutMs);

      worker.once("message", (message: WorkerMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (message.ok) {
          resolve(message.result);
        } else {
          reject(new Error(message.error));
        }
        void worker.terminate();
      });

      worker.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
        void worker.terminate();
      });

      worker.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          reject(new Error(`Indexing worker exited without a result for ${task.payload.name}.`));
        } else {
          reject(new Error(`Indexing worker exited with code ${code} for ${task.payload.name}.`));
        }
        void worker.terminate();
      });
    });
  }
}

function stripTransientParsed(result: IndexingWorkerResult): IndexingWorkerResult {
  if (!result.parsed) return result;
  const { parsed: _parsed, ...persistable } = result;
  return persistable;
}
