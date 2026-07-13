import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const appPath = process.argv[2] || "out/mac-arm64/Brevyn.app";
const limit = positiveInteger(process.argv[3]) || 40;

if (!existsSync(appPath)) {
  console.error(`Package not found: ${appPath}`);
  console.error("Run npm run pack first, or pass a packaged .app path.");
  process.exit(1);
}

const roots = [
  appPath,
  join(appPath, "Contents"),
  join(appPath, "Contents", "Frameworks"),
  join(appPath, "Contents", "Resources"),
  join(appPath, "Contents", "Resources", "app.asar.unpacked"),
  join(appPath, "Contents", "Resources", "app.asar.unpacked", "node_modules"),
].filter(existsSync);

console.log(`Package size analysis for ${appPath}\n`);
for (const root of roots) {
  const entries = readdirSync(root).map((name) => {
    const path = join(root, name);
    return { path, size: sizeOf(path) };
  }).sort((a, b) => b.size - a.size);
  console.log(`${relative(process.cwd(), root) || root} (${formatBytes(sizeOf(root))})`);
  for (const entry of entries.slice(0, Math.min(limit, entries.length))) {
    console.log(`  ${formatBytes(entry.size).padStart(8)}  ${relative(root, entry.path)}`);
  }
  console.log("");
}

const largestFiles = collectFiles(appPath)
  .sort((a, b) => b.size - a.size)
  .slice(0, limit);
console.log(`Largest files`);
for (const file of largestFiles) {
  console.log(`  ${formatBytes(file.size).padStart(8)}  ${relative(process.cwd(), file.path)}`);
}

function collectFiles(root) {
  const stats = lstatSync(root);
  if (stats.isFile()) return [{ path: root, size: stats.size }];
  if (stats.isSymbolicLink()) return [];
  if (!stats.isDirectory()) return [];
  return readdirSync(root).flatMap((name) => collectFiles(join(root, name)));
}

function sizeOf(path) {
  const stats = lstatSync(path);
  if (stats.isFile()) return stats.size;
  if (stats.isSymbolicLink()) return 0;
  if (!stats.isDirectory()) return 0;
  return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
