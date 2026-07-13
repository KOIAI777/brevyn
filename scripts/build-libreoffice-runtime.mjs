import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import AdmZip from "adm-zip";

const LIBREOFFICE_RUNTIME_VERSION = "2";
const outputDir = resolve("dist/runtimes");
const requireRuntime = process.env.BREVYN_REQUIRE_LIBREOFFICE_RUNTIME === "1";
const platform = process.platform;
const arch = process.arch;
const runtimeId = `libreoffice-${platform}-${arch}`;
const zipName = `${runtimeId}.zip`;
const zipPath = join(outputDir, zipName);
const manifestPath = join(outputDir, "libreoffice-runtime.json");

mkdirSync(outputDir, { recursive: true });

const source = findLibreOfficeSource();
if (!source) {
  const message = `LibreOffice runtime source not found for ${platform}/${arch}.`;
  writeManifest({ available: false, runtimeVersion: LIBREOFFICE_RUNTIME_VERSION, platform, arch, message });
  if (requireRuntime) {
    console.error(message);
    process.exit(1);
  }
  console.log(`${message} Skipping bundled LibreOffice runtime.`);
  process.exit(0);
}

const sofficeVersion = readSofficeVersion(source.executable);
const sourceHash = sourceFingerprint(source.root, source.executable, sofficeVersion);
const previous = readManifest();
if (
  previous?.available
  && previous.runtimeVersion === LIBREOFFICE_RUNTIME_VERSION
  && previous.source === source.root
  && previous.sourceHash === sourceHash
  && previous.zipName === zipName
  && existsSync(zipPath)
) {
  console.log(`LibreOffice runtime already prepared: ${zipPath}`);
  process.exit(0);
}

rmSync(zipPath, { force: true });
if (platform === "darwin") {
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", source.root, zipPath], { stdio: "inherit" });
} else if (platform === "win32") {
  zipDirectoryWithParent(source.root, zipPath);
} else {
  const message = `Bundled LibreOffice runtime packaging is not configured for ${platform}.`;
  writeManifest({ available: false, runtimeVersion: LIBREOFFICE_RUNTIME_VERSION, platform, arch, message });
  console.error(message);
  process.exit(requireRuntime ? 1 : 0);
}

const archiveSha256 = await sha256File(zipPath);
writeManifest({
  available: true,
  runtimeVersion: LIBREOFFICE_RUNTIME_VERSION,
  platform,
  arch,
  runtimeId,
  zipName,
  bundleName: basename(source.root),
  source: source.root,
  sourceHash,
  sofficeVersion,
  archiveSha256,
  zipSize: statSync(zipPath).size,
  createdAt: new Date().toISOString(),
});
console.log(`Prepared LibreOffice runtime: ${zipPath}`);

function findLibreOfficeSource() {
  const explicit = process.env.BREVYN_LIBREOFFICE_APP || process.env.BREVYN_LIBREOFFICE_HOME;
  const candidates = platform === "darwin"
    ? [
        explicit,
        "/Applications/LibreOffice.app",
        "/Applications/LibreOfficeDev.app",
        join(process.env.HOME || "", ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/libreoffice-headless/libreoffice/LibreOfficeDev.app"),
      ]
    : platform === "win32"
      ? [
          explicit,
          join(process.env.ProgramFiles || "C:\\Program Files", "LibreOffice"),
          join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "LibreOffice"),
          join(process.env.ChocolateyToolsLocation || "C:\\tools", "LibreOffice"),
        ]
      : [
          explicit,
          "/usr/lib/libreoffice",
          "/opt/libreoffice",
        ];

  for (const candidate of candidates.filter(Boolean)) {
    const root = normalizeSourceRoot(resolve(String(candidate)));
    const executable = sofficeInSource(root);
    if (executable) return { root, executable };
  }
  return null;
}

function normalizeSourceRoot(candidate) {
  if (!existsSync(candidate) || statSync(candidate).isDirectory()) return candidate;
  if (platform === "darwin") return resolve(dirname(candidate), "../..");
  return resolve(dirname(candidate), "..");
}

function sofficeInSource(root) {
  const candidates = platform === "darwin"
    ? [join(root, "Contents", "MacOS", "soffice")]
    : platform === "win32"
      ? [join(root, "program", "soffice.com"), join(root, "program", "soffice.exe")]
      : [join(root, "program", "soffice"), join(root, "usr", "bin", "soffice")];
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function readSofficeVersion(executable) {
  try {
    return execFileSync(executable, ["--headless", "--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    }).trim().split(/\r?\n/u)[0] || "unknown";
  } catch (error) {
    const message = `LibreOffice runtime failed its version check: ${error instanceof Error ? error.message : String(error)}`;
    if (requireRuntime) throw new Error(message);
    console.warn(message);
    return "unknown";
  }
}

function sourceFingerprint(root, executable, version) {
  const hash = createHash("sha256");
  hash.update(`${root}\n${version}\n`);
  for (const path of collectFiles(root)) {
    const stats = statSync(path);
    hash.update(relative(root, path).split(sep).join("/"));
    hash.update(`\0${stats.size}\0${stats.mtimeMs}\0`);
  }
  const executableStats = statSync(executable);
  hash.update(`${relative(root, executable)}\0${executableStats.size}\0${executableStats.mtimeMs}`);
  return hash.digest("hex").slice(0, 24);
}

function zipDirectoryWithParent(sourceDir, outputPath) {
  const zip = new AdmZip();
  const rootName = basename(sourceDir);
  for (const filePath of collectFiles(sourceDir)) {
    const entryName = `${rootName}/${relative(sourceDir, filePath).split(sep).join("/")}`;
    zip.addLocalFile(filePath, dirnameForZipEntry(entryName), basename(entryName));
  }
  zip.writeZip(outputPath);
}

function collectFiles(directory) {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function dirnameForZipEntry(entryName) {
  const base = basename(entryName);
  return entryName.slice(0, entryName.length - base.length).replace(/\/$/u, "");
}

function readManifest() {
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return null;
  }
}

function writeManifest(manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
