import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, extname, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";

export const WORKSPACE_FILE_PREVIEW_PROTOCOL = "brevyn-file";

type PreviewEntry = {
  root: string;
  isDirectory: boolean;
  createdAt: number;
  cacheKey: string;
};

const ENTRY_TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const previewEntries = new Map<string, PreviewEntry>();
const previewTokensByKey = new Map<string, string>();

export function registerWorkspaceFilePreviewProtocol(): void {
  protocol.handle(WORKSPACE_FILE_PREVIEW_PROTOCOL, handleWorkspaceFilePreviewRequest);
}

export function workspaceFilePreviewUrl(sourcePath: string): string {
  return registerPreviewEntry(sourcePath, false);
}

export function workspaceDirectoryPreviewUrl(sourcePath: string): string {
  return registerPreviewEntry(sourcePath, true);
}

function handleWorkspaceFilePreviewRequest(request: Request): Promise<Response> | Response {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return new Response("Bad request.", { status: 400 });
  }

  const entry = previewEntries.get(url.hostname);
  if (!entry) {
    return new Response("Preview resource not found.", { status: 404 });
  }

  let targetPath = entry.root;
  if (entry.isDirectory) {
    const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    try {
      targetPath = realpathSync(resolve(entry.root, relativePath));
    } catch {
      return new Response("Preview resource not found.", { status: 404 });
    }
    if (!isInsideDirectory(targetPath, entry.root)) {
      return new Response("Preview resource is outside the registered directory.", { status: 403 });
    }
  } else {
    const requestedName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (requestedName && requestedName !== basename(entry.root)) {
      return new Response("Preview resource not found.", { status: 404 });
    }
  }

  if (!existsSync(targetPath)) {
    return new Response("Preview resource does not exist.", { status: 404 });
  }
  return fetchFileWithContentType(targetPath, request);
}

function registerPreviewEntry(sourcePath: string, isDirectory: boolean): string {
  prunePreviewEntries();
  const root = realpathExisting(sourcePath);
  const stats = statSync(root);
  if (isDirectory && !stats.isDirectory()) {
    throw new Error("Preview resource is not a directory.");
  }
  if (!isDirectory && !stats.isFile()) {
    throw new Error("Preview resource is not a file.");
  }

  const cacheKey = `${isDirectory ? "directory" : "file"}:${root}:${stats.size}:${stats.mtimeMs}`;
  const existingToken = previewTokensByKey.get(cacheKey);
  const existingEntry = existingToken ? previewEntries.get(existingToken) : undefined;
  if (existingToken && existingEntry) {
    existingEntry.createdAt = Date.now();
    return previewUrl(existingToken, root, isDirectory);
  }
  if (existingToken) previewTokensByKey.delete(cacheKey);

  const token = randomUUID();
  previewEntries.set(token, { root, isDirectory, createdAt: Date.now(), cacheKey });
  previewTokensByKey.set(cacheKey, token);
  return previewUrl(token, root, isDirectory);
}

function previewUrl(token: string, root: string, isDirectory: boolean): string {
  return `${WORKSPACE_FILE_PREVIEW_PROTOCOL}://${token}${isDirectory ? "" : `/${encodeURIComponent(basename(root))}`}`;
}

async function fetchFileWithContentType(targetPath: string, request: Request): Promise<Response> {
  const stats = statSync(targetPath);
  const etag = `"${stats.size}-${Math.floor(stats.mtimeMs)}"`;
  const cacheHeaders = {
    "cache-control": "private, max-age=3600, immutable",
    etag,
    "last-modified": stats.mtime.toUTCString(),
  };
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }
  const response = await net.fetch(pathToFileURL(targetPath).toString());
  const headers = new Headers(response.headers);
  const contentType = contentTypeForPath(targetPath);
  if (contentType) headers.set("content-type", contentType);
  headers.set("access-control-allow-origin", "*");
  headers.set("cross-origin-resource-policy", "cross-origin");
  for (const [key, value] of Object.entries(cacheHeaders)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function contentTypeForPath(targetPath: string): string {
  const extension = extname(targetPath).toLowerCase();
  if (extension === ".mjs" || extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".html" || extension === ".htm") return "text/html; charset=utf-8";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".json" || extension === ".map") return "application/json; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".ttf") return "font/ttf";
  if (extension === ".otf") return "font/otf";
  return "";
}

function prunePreviewEntries(): void {
  const now = Date.now();
  for (const [token, entry] of previewEntries) {
    if (now - entry.createdAt > ENTRY_TTL_MS) {
      deletePreviewEntry(token, entry);
    }
  }

  while (previewEntries.size > MAX_ENTRIES) {
    const oldestToken = previewEntries.keys().next().value;
    if (!oldestToken) break;
    deletePreviewEntry(oldestToken, previewEntries.get(oldestToken));
  }
}

function deletePreviewEntry(token: string, entry?: PreviewEntry): void {
  previewEntries.delete(token);
  if (entry && previewTokensByKey.get(entry.cacheKey) === token) {
    previewTokensByKey.delete(entry.cacheKey);
  }
}

function realpathExisting(sourcePath: string): string {
  const resolved = realpathSync(resolve(sourcePath));
  if (!existsSync(resolved)) {
    throw new Error("Preview resource does not exist.");
  }
  return resolved;
}

function isInsideDirectory(targetPath: string, rootPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(rootPath.endsWith(sep) ? rootPath : `${rootPath}${sep}`);
}
