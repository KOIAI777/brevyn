import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { LIBREOFFICE_RUNTIME_VERSION } from "./libreoffice-runtime";

const PREVIEW_CACHE_DIR = ".preview-cache";
const OFFICE_PDF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const OFFICE_PDF_MAX_BYTES = 1024 * 1024 * 1024;
const PDF_VIEWER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PDF_VIEWER_MAX_BYTES = 1024 * 1024 * 1024;
const LIBREOFFICE_PROFILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LIBREOFFICE_PROFILE_MAX_BYTES = 256 * 1024 * 1024;

type CacheEntry = {
  path: string;
  size: number;
  mtimeMs: number;
};

export function schedulePreviewCacheCleanup(rootDataDir: string): void {
  windowlessTimeout(() => {
    try {
      cleanupBoundedCache(join(rootDataDir, PREVIEW_CACHE_DIR, "office-pdf"), OFFICE_PDF_MAX_AGE_MS, OFFICE_PDF_MAX_BYTES);
      cleanupBoundedCache(join(rootDataDir, PREVIEW_CACHE_DIR, "pdf-viewer"), PDF_VIEWER_MAX_AGE_MS, PDF_VIEWER_MAX_BYTES);
      cleanupBoundedCache(join(rootDataDir, PREVIEW_CACHE_DIR, "libreoffice-profiles"), LIBREOFFICE_PROFILE_MAX_AGE_MS, LIBREOFFICE_PROFILE_MAX_BYTES);
      cleanupOldLibreOfficeRuntimes(rootDataDir);
    } catch (error) {
      console.warn("[preview-cache] Cleanup failed", error);
    }
  }, 5_000);
}

function cleanupBoundedCache(cacheDir: string, maxAgeMs: number, maxBytes: number): void {
  const entries = listCacheEntries(cacheDir);
  if (entries.length === 0) return;

  const now = Date.now();
  const keep = new Set<string>();
  for (const entry of entries) {
    if (now - entry.mtimeMs <= maxAgeMs) keep.add(entry.path);
  }

  let totalBytes = entries
    .filter((entry) => keep.has(entry.path))
    .reduce((sum, entry) => sum + entry.size, 0);
  const keptByOldestFirst = entries
    .filter((entry) => keep.has(entry.path))
    .sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const entry of keptByOldestFirst) {
    if (totalBytes <= maxBytes) break;
    keep.delete(entry.path);
    totalBytes -= entry.size;
  }

  for (const entry of entries) {
    if (!keep.has(entry.path)) removeCachePath(entry.path);
  }
}

function cleanupOldLibreOfficeRuntimes(rootDataDir: string): void {
  const platformDir = join(rootDataDir, "runtimes", "libreoffice", `${process.platform}-${process.arch}`);
  if (!existsSync(platformDir)) return;
  for (const entry of safeReadDir(platformDir)) {
    if (entry === LIBREOFFICE_RUNTIME_VERSION || entry.startsWith(`${LIBREOFFICE_RUNTIME_VERSION}.`)) continue;
    removeCachePath(join(platformDir, entry));
  }
}

function listCacheEntries(dir: string): CacheEntry[] {
  if (!existsSync(dir)) return [];
  return safeReadDir(dir)
    .map((entry) => join(dir, entry))
    .map((path) => cacheEntry(path))
    .filter((entry): entry is CacheEntry => Boolean(entry));
}

function cacheEntry(path: string): CacheEntry | null {
  try {
    const stats = statSync(path);
    return {
      path,
      size: directorySize(path),
      mtimeMs: stats.mtimeMs,
    };
  } catch {
    return null;
  }
}

function directorySize(path: string): number {
  try {
    const stats = statSync(path);
    if (!stats.isDirectory()) return stats.size;
    return safeReadDir(path).reduce((sum, entry) => sum + directorySize(join(path, entry)), 0);
  } catch {
    return 0;
  }
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path).filter((entry) => entry !== "." && entry !== "..");
  } catch {
    return [];
  }
}

function removeCachePath(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    console.warn("[preview-cache] Failed to remove cache path", { path, error });
  }
}

function windowlessTimeout(callback: () => void, ms: number): void {
  setTimeout(callback, ms).unref?.();
}
