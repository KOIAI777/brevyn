import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import AdmZip from "adm-zip";

export const LIBREOFFICE_RUNTIME_VERSION = "2";
export const BREVYN_SOFFICE_PATH_ENV = "BREVYN_SOFFICE_PATH";
export const BREVYN_LIBREOFFICE_ARCHIVE_ENV = "BREVYN_LIBREOFFICE_ARCHIVE";
export const BREVYN_LIBREOFFICE_RUNTIME_DIR_ENV = "BREVYN_LIBREOFFICE_RUNTIME_DIR";
export const BREVYN_LIBREOFFICE_ARCHIVE_SHA256_ENV = "BREVYN_LIBREOFFICE_ARCHIVE_SHA256";

const RUNTIME_ROOT_NAME = "libreoffice";
const EXTRACTION_TIMEOUT_MS = 180_000;
const EXTRACTION_STALE_MS = 5 * 60_000;
const execFileAsync = promisify(execFile);
const extractionPromises = new Map<string, Promise<LibreOfficeRuntime | null>>();
const validationCache = new Map<string, { stamp: string; ok: boolean; version: string }>();

export type LibreOfficeRuntime = {
  source: "bundled" | "system" | "codex";
  sofficePath: string;
  runtimeDir?: string;
  version?: string;
  sofficeVersion?: string;
};

export type LibreOfficeConversionResult =
  | { ok: true; pdfPath: string; runtime: LibreOfficeRuntime }
  | { ok: false; reason: string };

export type LibreOfficeRuntimeStatus = {
  status: "ready" | "available" | "missing" | "error";
  source?: LibreOfficeRuntime["source"];
  sofficePath?: string;
  sofficeVersion?: string;
  runtimeDir?: string;
  runtimeVersion: string;
  archivePath?: string;
  selfTest?: "passed" | "failed" | "not_run";
  detail?: string;
};

export async function convertOfficeDocumentToPdf(input: {
  rootDataDir: string;
  sourcePath: string;
  outputDir: string;
  timeoutMs?: number;
}): Promise<LibreOfficeConversionResult> {
  const runtime = await resolveLibreOfficeRuntime(input.rootDataDir);
  if (!runtime) return { ok: false, reason: "未找到可用的 LibreOffice 运行时。" };

  mkdirSync(input.outputDir, { recursive: true });
  const profilesDir = join(input.rootDataDir, ".preview-cache", "libreoffice-profiles");
  mkdirSync(profilesDir, { recursive: true });
  const userInstallation = join(profilesDir, `${process.pid}-${randomUUID()}`);
  mkdirSync(userInstallation, { recursive: true });
  const existingPdfs = new Set(listPdfFiles(input.outputDir));

  try {
    await execFileAsync(runtime.sofficePath, [
      "--headless",
      "--nologo",
      "--nodefault",
      "--nofirststartwizard",
      "--nolockcheck",
      `-env:UserInstallation=${pathToFileURL(userInstallation).href}`,
      "--convert-to",
      "pdf",
      "--outdir",
      input.outputDir,
      input.sourcePath,
    ], {
      timeout: input.timeoutMs || 90_000,
      maxBuffer: 10 * 1024 * 1024,
      env: runtimeProcessEnv(runtime),
    });
  } catch (error) {
    validationCache.delete(runtime.sofficePath);
    return { ok: false, reason: `LibreOffice 转换失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    await rm(userInstallation, { recursive: true, force: true }).catch(() => undefined);
  }

  const expectedPdf = join(input.outputDir, `${basename(input.sourcePath).replace(/\.[^.]+$/u, "")}.pdf`);
  if (existsSync(expectedPdf)) return { ok: true, pdfPath: expectedPdf, runtime };
  const generatedPdf = listPdfFiles(input.outputDir)
    .filter((path) => !existingPdfs.has(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
  if (generatedPdf) return { ok: true, pdfPath: generatedPdf, runtime };
  return { ok: false, reason: "LibreOffice 没有生成 PDF 文件。" };
}

export async function resolveLibreOfficeRuntime(rootDataDir: string): Promise<LibreOfficeRuntime | null> {
  const bundled = await extractBundledRuntime(rootDataDir);
  if (bundled) return bundled;

  const extracted = resolveExtractedBundledRuntime(rootDataDir);
  if (extracted) {
    const health = await validateSoffice(extracted.sofficePath);
    if (health.ok) return { ...extracted, sofficeVersion: health.version };
  }

  for (const runtime of [resolveSystemRuntime(), resolveCodexRuntime()]) {
    if (!runtime) continue;
    const health = await validateSoffice(runtime.sofficePath);
    if (health.ok) return { ...runtime, sofficeVersion: health.version };
  }
  return null;
}

export function libreOfficeRuntimeEnvironment(rootDataDir: string): Record<string, string> {
  const archive = bundledRuntimeArchivePath();
  const archiveManifest = archive ? runtimeArchiveManifest(archive) : null;
  const runtime = resolveExtractedBundledRuntime(rootDataDir) || resolveSystemRuntime() || resolveCodexRuntime();
  const runtimeDir = extractedRuntimeDir(rootDataDir);
  const env: Record<string, string> = {
    [BREVYN_LIBREOFFICE_RUNTIME_DIR_ENV]: runtimeDir,
    BREVYN_LIBREOFFICE_RUNTIME_VERSION: LIBREOFFICE_RUNTIME_VERSION,
  };
  if (archive) env[BREVYN_LIBREOFFICE_ARCHIVE_ENV] = archive;
  if (typeof archiveManifest?.archiveSha256 === "string") {
    env[BREVYN_LIBREOFFICE_ARCHIVE_SHA256_ENV] = archiveManifest.archiveSha256;
  }
  if (runtime?.sofficePath) {
    env[BREVYN_SOFFICE_PATH_ENV] = runtime.sofficePath;
    env.PATH = prependPath(process.env.PATH || "", dirname(runtime.sofficePath));
  }
  const pdfToPpm = resolvePdfToPpm();
  if (pdfToPpm) {
    env.BREVYN_PDFTOPPM_PATH = pdfToPpm;
    env.PATH = prependPath(env.PATH || process.env.PATH || "", dirname(pdfToPpm));
  }
  return env;
}

export async function inspectLibreOfficeRuntime(
  rootDataDir: string,
  options: { prepare?: boolean; selfTest?: boolean } = {},
): Promise<LibreOfficeRuntimeStatus> {
  const archivePath = bundledRuntimeArchivePath() || undefined;
  const runtime = options.prepare
    ? await resolveLibreOfficeRuntime(rootDataDir)
    : resolveExtractedBundledRuntime(rootDataDir) || resolveSystemRuntime() || resolveCodexRuntime();

  if (!runtime) {
    return {
      status: archivePath ? "available" : "missing",
      runtimeVersion: LIBREOFFICE_RUNTIME_VERSION,
      archivePath,
      selfTest: "not_run",
      detail: archivePath ? "LibreOffice runtime is bundled and will initialize on first use." : "LibreOffice runtime was not found.",
    };
  }

  const health = await validateSoffice(runtime.sofficePath, { force: options.selfTest });
  if (!health.ok) {
    return {
      status: "error",
      source: runtime.source,
      sofficePath: runtime.sofficePath,
      runtimeDir: runtime.runtimeDir,
      runtimeVersion: LIBREOFFICE_RUNTIME_VERSION,
      archivePath,
      selfTest: options.selfTest ? "failed" : "not_run",
      detail: health.detail || "LibreOffice failed its version check.",
    };
  }

  if (options.selfTest) {
    let smoke = await runLibreOfficeSmokeTest(rootDataDir);
    if (!smoke.ok && runtime.source === "bundled" && runtime.runtimeDir && archivePath) {
      validationCache.delete(runtime.sofficePath);
      await rm(runtime.runtimeDir, { recursive: true, force: true });
      const repaired = await resolveLibreOfficeRuntime(rootDataDir);
      if (repaired?.source === "bundled") smoke = await runLibreOfficeSmokeTest(rootDataDir);
    }
    if (!smoke.ok) {
      return {
        status: "error",
        source: runtime.source,
        sofficePath: runtime.sofficePath,
        sofficeVersion: health.version,
        runtimeDir: runtime.runtimeDir,
        runtimeVersion: LIBREOFFICE_RUNTIME_VERSION,
        archivePath,
        selfTest: "failed",
        detail: smoke.reason,
      };
    }
  }

  return {
    status: "ready",
    source: runtime.source,
    sofficePath: runtime.sofficePath,
    sofficeVersion: health.version,
    runtimeDir: runtime.runtimeDir,
    runtimeVersion: LIBREOFFICE_RUNTIME_VERSION,
    archivePath,
    selfTest: options.selfTest ? "passed" : "not_run",
  };
}

function resolveExtractedBundledRuntime(rootDataDir: string): LibreOfficeRuntime | null {
  const runtimeDir = extractedRuntimeDir(rootDataDir);
  const sofficePath = findSofficeInRuntimeDir(runtimeDir);
  if (!sofficePath) return null;
  return { source: "bundled", sofficePath, runtimeDir, version: LIBREOFFICE_RUNTIME_VERSION };
}

async function extractBundledRuntime(rootDataDir: string): Promise<LibreOfficeRuntime | null> {
  const archive = bundledRuntimeArchivePath();
  if (!archive) return null;
  const runtimeDir = extractedRuntimeDir(rootDataDir);
  const promiseKey = `${archive}\n${runtimeDir}`;
  const pending = extractionPromises.get(promiseKey);
  if (pending) return pending;
  const promise = extractBundledRuntimeOnce(archive, runtimeDir);
  extractionPromises.set(promiseKey, promise);
  try {
    return await promise;
  } finally {
    extractionPromises.delete(promiseKey);
  }
}

async function extractBundledRuntimeOnce(archive: string, runtimeDir: string): Promise<LibreOfficeRuntime | null> {
  const archiveStats = statSync(archive);
  const manifest = runtimeArchiveManifest(archive);
  const archiveSha256 = typeof manifest?.archiveSha256 === "string" ? manifest.archiveSha256 : "";
  const expectedMarker = {
    version: LIBREOFFICE_RUNTIME_VERSION,
    archive: basename(archive),
    size: archiveStats.size,
    sha256: archiveSha256,
  };
  const lockDir = `${runtimeDir}.extracting`;
  const deadline = Date.now() + EXTRACTION_TIMEOUT_MS;
  let ownsLock = false;

  await mkdir(dirname(runtimeDir), { recursive: true });

  while (!ownsLock) {
    try {
      await mkdir(lockDir, { recursive: false });
      ownsLock = true;
    } catch (error) {
      if (!isAlreadyExistsError(error)) return null;
      const ready = await existingBundledRuntime(runtimeDir, expectedMarker, { acceptMarkerless: true });
      if (ready) return ready;
      if (isStalePath(lockDir, EXTRACTION_STALE_MS)) {
        await rm(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) return null;
      await delay(250);
    }
  }

  try {
    const existing = await existingBundledRuntime(runtimeDir, expectedMarker, { acceptMarkerless: true });
    if (existing) return existing;

    if (expectedMarker.sha256) {
      const actualSha256 = await sha256File(archive);
      if (actualSha256 !== expectedMarker.sha256) {
        console.warn("[libreoffice-runtime] Archive checksum mismatch", { archive });
        return null;
      }
    }

    const temporaryDir = `${runtimeDir}.tmp-${process.pid}-${Date.now()}`;
    await rm(temporaryDir, { recursive: true, force: true });
    await mkdir(dirname(temporaryDir), { recursive: true });
    await mkdir(temporaryDir, { recursive: true });
    try {
      await extractRuntimeArchive(archive, temporaryDir);
      const temporarySoffice = findSofficeInRuntimeDir(temporaryDir);
      if (!temporarySoffice) throw new Error("Extracted runtime does not contain soffice.");
      if (process.platform !== "win32") await execFileAsync("chmod", ["+x", temporarySoffice]);
      const health = await validateSoffice(temporarySoffice, { force: true });
      if (!health.ok) throw new Error(health.detail || "Extracted LibreOffice runtime failed validation.");
      await writeFile(join(temporaryDir, ".brevyn-libreoffice-runtime.json"), `${JSON.stringify(expectedMarker, null, 2)}\n`, "utf8");
      await rm(runtimeDir, { recursive: true, force: true });
      await rename(temporaryDir, runtimeDir);
    } catch (error) {
      await rm(temporaryDir, { recursive: true, force: true });
      console.warn("[libreoffice-runtime] Runtime extraction failed", error);
      return null;
    }

    const sofficePath = findSofficeInRuntimeDir(runtimeDir);
    if (!sofficePath) return null;
    const health = await validateSoffice(sofficePath, { force: true });
    return health.ok
      ? { source: "bundled", sofficePath, runtimeDir, version: LIBREOFFICE_RUNTIME_VERSION, sofficeVersion: health.version }
      : null;
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

async function existingBundledRuntime(
  runtimeDir: string,
  expectedMarker: Record<string, unknown>,
  options: { acceptMarkerless: boolean },
): Promise<LibreOfficeRuntime | null> {
  const sofficePath = findSofficeInRuntimeDir(runtimeDir);
  if (!sofficePath) return null;
  const markerPath = join(runtimeDir, ".brevyn-libreoffice-runtime.json");
  const marker = readJson(markerPath);
  const markerMatches = marker
    && marker.version === expectedMarker.version
    && marker.archive === expectedMarker.archive
    && marker.size === expectedMarker.size
    && marker.sha256 === expectedMarker.sha256;
  if (!markerMatches && !options.acceptMarkerless) return null;
  if (marker && !markerMatches) return null;
  const health = await validateSoffice(sofficePath);
  if (!health.ok) return null;
  if (!markerMatches) await writeFile(markerPath, `${JSON.stringify(expectedMarker, null, 2)}\n`, "utf8");
  return { source: "bundled", sofficePath, runtimeDir, version: LIBREOFFICE_RUNTIME_VERSION, sofficeVersion: health.version };
}

async function extractRuntimeArchive(archive: string, targetDir: string): Promise<void> {
  if (process.platform === "darwin") {
    await execFileAsync("ditto", ["-x", "-k", archive, targetDir], {
      timeout: EXTRACTION_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    return;
  }
  const zip = new AdmZip(archive);
  const targetRoot = resolve(targetDir);
  for (const entry of zip.getEntries()) {
    const entryTarget = resolve(targetRoot, entry.entryName);
    if (!isPathInside(entryTarget, targetRoot)) throw new Error(`Invalid LibreOffice archive entry: ${entry.entryName}`);
  }
  if (process.platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $env:BREVYN_RUNTIME_ARCHIVE -DestinationPath $env:BREVYN_RUNTIME_TARGET -Force",
    ], {
      timeout: EXTRACTION_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        BREVYN_RUNTIME_ARCHIVE: archive,
        BREVYN_RUNTIME_TARGET: targetRoot,
      },
    });
    return;
  }
  zip.extractAllTo(targetRoot, true);
}

function resolveSystemRuntime(): LibreOfficeRuntime | null {
  const explicit = process.env[BREVYN_SOFFICE_PATH_ENV];
  const candidates = [
    explicit,
    ...(process.platform === "darwin" ? [
      "/Applications/LibreOffice.app/Contents/MacOS/soffice",
      "/Applications/LibreOfficeDev.app/Contents/MacOS/soffice",
      "/opt/homebrew/bin/soffice",
      "/usr/local/bin/soffice",
    ] : process.platform === "win32" ? [
      join(process.env.ProgramFiles || "C:\\Program Files", "LibreOffice", "program", "soffice.com"),
      join(process.env.ProgramFiles || "C:\\Program Files", "LibreOffice", "program", "soffice.exe"),
      join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "LibreOffice", "program", "soffice.com"),
      join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "LibreOffice", "program", "soffice.exe"),
    ] : [
      "/usr/bin/soffice",
      "/usr/local/bin/soffice",
      "/usr/lib/libreoffice/program/soffice",
    ]),
    findExecutableOnPath(process.platform === "win32" ? ["soffice.com", "soffice.exe"] : ["soffice"]),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const sofficePath = candidates.find((candidate) => existsSync(candidate));
  return sofficePath ? { source: "system", sofficePath } : null;
}

function resolveCodexRuntime(): LibreOfficeRuntime | null {
  const executableNames = process.platform === "win32" ? ["soffice.com", "soffice.exe"] : ["soffice"];
  const candidates = [
    ...executableNames.map((name) => join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override", name)),
    ...executableNames.map((name) => join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin", name)),
  ];
  const sofficePath = candidates.find((candidate) => existsSync(candidate));
  return sofficePath ? { source: "codex", sofficePath } : null;
}

function resolvePdfToPpm(): string {
  const explicit = process.env.BREVYN_PDFTOPPM_PATH;
  const candidates = [
    explicit,
    findExecutableOnPath(process.platform === "win32" ? ["pdftoppm.exe"] : ["pdftoppm"]),
    join(homedir(), ".cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override", process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function bundledRuntimeArchivePath(): string {
  const explicit = process.env[BREVYN_LIBREOFFICE_ARCHIVE_ENV];
  const candidates = [
    explicit,
    join(process.resourcesPath || "", "runtimes", `libreoffice-${process.platform}-${process.arch}.zip`),
    join(process.cwd(), "dist", "runtimes", `libreoffice-${process.platform}-${process.arch}.zip`),
    join(__dirname, "runtimes", `libreoffice-${process.platform}-${process.arch}.zip`),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function runtimeArchiveManifest(archive: string): Record<string, string | number | boolean> | null {
  const path = join(dirname(archive), "libreoffice-runtime.json");
  const manifest = readJson(path);
  if (!manifest || manifest.available !== true || manifest.zipName !== basename(archive)) return null;
  if (String(manifest.runtimeVersion || "") !== LIBREOFFICE_RUNTIME_VERSION) return null;
  if (manifest.platform && manifest.platform !== process.platform) return null;
  if (manifest.arch && manifest.arch !== process.arch) return null;
  return manifest as Record<string, string | number | boolean>;
}

function extractedRuntimeDir(rootDataDir: string): string {
  return join(rootDataDir || tmpdir(), "runtimes", RUNTIME_ROOT_NAME, `${process.platform}-${process.arch}`, LIBREOFFICE_RUNTIME_VERSION);
}

function findSofficeInRuntimeDir(runtimeDir: string): string {
  const candidates = process.platform === "darwin"
    ? [
        join(runtimeDir, "LibreOffice.app", "Contents", "MacOS", "soffice"),
        join(runtimeDir, "LibreOfficeDev.app", "Contents", "MacOS", "soffice"),
        join(runtimeDir, "libreoffice", "LibreOffice.app", "Contents", "MacOS", "soffice"),
        join(runtimeDir, "libreoffice", "LibreOfficeDev.app", "Contents", "MacOS", "soffice"),
      ]
    : process.platform === "win32"
      ? [
          join(runtimeDir, "LibreOffice", "program", "soffice.com"),
          join(runtimeDir, "LibreOffice", "program", "soffice.exe"),
          join(runtimeDir, "program", "soffice.com"),
          join(runtimeDir, "program", "soffice.exe"),
          join(runtimeDir, "libreoffice", "program", "soffice.com"),
          join(runtimeDir, "libreoffice", "program", "soffice.exe"),
        ]
      : [
          join(runtimeDir, "libreoffice", "program", "soffice"),
          join(runtimeDir, "program", "soffice"),
          join(runtimeDir, "usr", "bin", "soffice"),
        ];
  return candidates.find((candidate) => existsSync(resolve(candidate))) || "";
}

async function validateSoffice(path: string, options: { force?: boolean } = {}): Promise<{ ok: boolean; version: string; detail?: string }> {
  if (!existsSync(path)) return { ok: false, version: "", detail: "soffice executable is missing." };
  const stats = statSync(path);
  const stamp = `${stats.size}:${stats.mtimeMs}`;
  const cached = validationCache.get(path);
  if (!options.force && cached?.stamp === stamp) return { ok: cached.ok, version: cached.version };
  try {
    const result = await execFileAsync(path, ["--headless", "--version"], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      env: runtimeProcessEnv({ sofficePath: path }),
    });
    const version = String(result.stdout || result.stderr || "").trim().split(/\r?\n/u)[0] || "LibreOffice";
    validationCache.set(path, { stamp, ok: true, version });
    return { ok: true, version };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    validationCache.set(path, { stamp, ok: false, version: "" });
    return { ok: false, version: "", detail };
  }
}

async function runLibreOfficeSmokeTest(rootDataDir: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "brevyn-libreoffice-self-test-"));
  const sourcePath = join(tempDir, "runtime-test.html");
  const outputDir = join(tempDir, "output");
  try {
    await writeFile(sourcePath, "<!doctype html><html><body><p>Brevyn LibreOffice runtime test</p></body></html>\n", "utf8");
    const result = await convertOfficeDocumentToPdf({ rootDataDir, sourcePath, outputDir, timeoutMs: 45_000 });
    return result.ok ? { ok: true } : { ok: false, reason: result.reason };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runtimeProcessEnv(runtime: Pick<LibreOfficeRuntime, "sofficePath">): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homedir(),
    [BREVYN_SOFFICE_PATH_ENV]: runtime.sofficePath,
    PATH: prependPath(process.env.PATH || "", dirname(runtime.sofficePath)),
  };
  if (process.platform !== "win32") env.SAL_USE_VCLPLUGIN = "svp";
  return env;
}

function prependPath(current: string, entry: string): string {
  const normalized = process.platform === "win32" ? entry.toLowerCase() : entry;
  const values = current.split(delimiter).filter(Boolean);
  const exists = values.some((value) => (process.platform === "win32" ? value.toLowerCase() : value) === normalized);
  return exists ? current : [entry, ...values].join(delimiter);
}

function findExecutableOnPath(names: string[]): string {
  const paths = (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const directory of paths) {
    for (const name of names) {
      const candidate = join(directory.replace(/^"|"$/gu, ""), name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function listPdfFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((entry) => extname(entry).toLowerCase() === ".pdf")
      .map((entry) => join(dir, entry));
  } catch {
    return [];
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function isPathInside(path: string, root: string): boolean {
  const child = resolve(path);
  const parent = resolve(root);
  const relation = relative(parent, child);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function isAlreadyExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST");
}

function isStalePath(path: string, maxAgeMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > maxAgeMs;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
