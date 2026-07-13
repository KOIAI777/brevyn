import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface AtomicJsonWriteOptions {
  mode?: number;
  skipBackup?: boolean;
}

export function readJsonFileSafe<T>(filePath: string): T | null {
  const main = readJsonCandidate<T>(filePath);
  if (main) return main;

  const tmpPath = `${filePath}.tmp`;
  const tmp = readJsonCandidate<T>(tmpPath);
  if (tmp) {
    promoteFile(tmpPath, filePath);
    return tmp;
  }

  removeIfExists(tmpPath);

  const bakPath = `${filePath}.bak`;
  const backup = readJsonCandidate<T>(bakPath);
  if (backup) {
    writeJsonFileAtomic(filePath, backup, { skipBackup: true });
    return backup;
  }

  return null;
}

export function writeJsonFileAtomic(filePath: string, data: unknown, options: AtomicJsonWriteOptions = {}): void {
  const mode = options.mode ?? 0o600;
  const dir = dirname(filePath);
  const tmpPath = `${filePath}.tmp`;
  const bakPath = `${filePath}.bak`;

  mkdirSync(dir, { recursive: true });
  try {
    if (!options.skipBackup && existsSync(filePath)) {
      try {
        copyFileSync(filePath, bakPath);
        chmodSync(bakPath, mode);
      } catch {
        // A missing backup should not block the new atomic write.
      }
    }

    writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode });
    fsyncFile(tmpPath);
    renameSync(tmpPath, filePath);
    try {
      chmodSync(filePath, mode);
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }
    fsyncDirectory(dir);
  } catch (error) {
    removeIfExists(tmpPath);
    throw error;
  }
}

function readJsonCandidate<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function promoteFile(sourcePath: string, targetPath: string): void {
  try {
    renameSync(sourcePath, targetPath);
    try {
      chmodSync(targetPath, 0o600);
    } catch {
      // Best effort on filesystems that do not support POSIX modes.
    }
    fsyncDirectory(dirname(targetPath));
  } catch {
    // If promotion fails, leave the caller on the last complete file or backup.
  }
}

function removeIfExists(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // Stale temp cleanup must not mask the original read/write path.
  }
}

function fsyncFile(filePath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r+");
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is best-effort across platforms and filesystems.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
