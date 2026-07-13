import { randomUUID } from "node:crypto";
import type { LocalStore } from "../services/local-store";
import type { IndexingExecutor } from "./indexing-worker-executor";
import type { IndexingTaskRecord } from "./indexing-types";

const DEFAULT_INDEXING_CONCURRENCY = 3;

export interface IndexingQueueOptions {
  concurrency?: number;
  pollMs?: number;
  lockMs?: number;
  onQueueChanged?: () => void;
}

export class IndexingQueueService {
  private readonly workerId = `brevyn-indexer-${randomUUID()}`;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private readonly lockMs: number;
  private readonly active = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private draining = false;
  private stopped = true;

  constructor(
    private readonly store: LocalStore,
    private readonly executor: IndexingExecutor,
    private readonly options: IndexingQueueOptions = {},
  ) {
    this.concurrency = options.concurrency ?? DEFAULT_INDEXING_CONCURRENCY;
    this.pollMs = options.pollMs ?? 1_500;
    this.lockMs = options.lockMs ?? 90_000;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.store.recoverExpiredIndexingTasks(this.workerId);
    this.poke();
    this.timer = setInterval(() => this.poke(), this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.waitForIdle();
  }

  poke(): void {
    if (this.stopped) return;
    void this.drain().catch((error) => {
      console.warn("[indexing-queue] Drain failed", error);
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      this.store.recoverExpiredIndexingTasks(this.workerId);
      while (!this.stopped && this.active.size < this.concurrency) {
        const task = this.store.claimNextIndexingTask(this.workerId, this.lockMs);
        if (!task) break;
        this.active.add(task.id);
        this.options.onQueueChanged?.();
        void this.runTask(task).finally(() => {
          this.active.delete(task.id);
          this.poke();
        });
      }
    } finally {
      this.draining = false;
    }
  }

  private async runTask(task: IndexingTaskRecord): Promise<void> {
    try {
      const result = await this.executor.run(task);
      await this.store.completeIndexingTask(task.id, result, this.workerId, task.lockedUntil);
    } catch (error) {
      this.store.failIndexingTask(task.id, error instanceof Error ? error.message : String(error), this.workerId, task.lockedUntil);
    } finally {
      this.options.onQueueChanged?.();
    }
  }

  private async waitForIdle(): Promise<void> {
    while (this.draining || this.active.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
