import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface CleanupFailure {
  scope: "workspace" | "thread" | "rag" | "file";
  operation: string;
  targetId?: string;
  path?: string;
  message: string;
  createdAt?: string;
}

export function recordCleanupFailure(rootDataDir: string, failure: CleanupFailure): void {
  try {
    mkdirSync(rootDataDir, { recursive: true });
    appendFileSync(
      join(rootDataDir, "cleanup-failures.jsonl"),
      `${JSON.stringify({ ...failure, createdAt: failure.createdAt || new Date().toISOString() })}\n`,
      "utf8",
    );
  } catch (error) {
    console.warn("[cleanup] Failed to record cleanup failure", error);
  }
}
