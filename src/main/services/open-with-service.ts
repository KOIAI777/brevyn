import { app, nativeImage, shell } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import type { OpenPathOption } from "../../types/domain";

type OpenTargetKind = OpenPathOption["kind"];

interface OpenTarget {
  id: string;
  label: string;
  kind: OpenTargetKind;
  appNames?: string[];
  appPaths?: string[];
  bundleIds?: string[];
  categories: OpenTargetCategory[];
}

type OpenTargetCategory = "all" | "folder" | "code" | "document" | "presentation" | "spreadsheet" | "pdf" | "image";

interface DetectedApp {
  bundleId?: string;
  label: string;
  appPath: string;
}

interface IconCacheEntry {
  dataUrl: string;
  timestamp: number;
}

interface ApplicationCacheEntry {
  apps: DetectedApp[];
  timestamp: number;
}

interface NativeOpenWithApp {
  bundleId?: string;
  displayName: string;
  appPath: string;
  iconDataUrl?: string;
}

interface NativeOpenWithResponse {
  defaultApp?: NativeOpenWithApp | null;
  apps?: NativeOpenWithApp[];
}

const APPLICATION_DIRS = [
  "/Applications",
  join(homedir(), "Applications"),
  "/System/Applications",
  "/System/Applications/Utilities",
];

const EXTENSION_TO_UTI: Record<string, string> = {
  txt: "public.plain-text",
  md: "net.daringfireball.markdown",
  markdown: "net.daringfireball.markdown",
  json: "public.json",
  jsonl: "public.json",
  xml: "public.xml",
  yaml: "public.yaml",
  yml: "public.yaml",
  toml: "public.toml",
  html: "public.html",
  htm: "public.html",
  css: "public.css",
  csv: "public.comma-separated-values-text",
  ts: "public.source-code",
  tsx: "public.source-code",
  js: "com.netscape.javascript-source",
  jsx: "com.netscape.javascript-source",
  py: "public.python-script",
  java: "com.sun.java-source",
  cpp: "public.c-plus-plus-source",
  c: "public.c-source",
  h: "public.c-header",
  sh: "public.shell-script",
  zsh: "public.zsh-script",
  pdf: "com.adobe.pdf",
  doc: "com.microsoft.word.doc",
  docx: "org.openxmlformats.wordprocessingml.document",
  ppt: "com.microsoft.powerpoint.ppt",
  pptx: "org.openxmlformats.presentationml.presentation",
  xls: "com.microsoft.excel.xls",
  xlsx: "org.openxmlformats.spreadsheetml.sheet",
  png: "public.png",
  jpg: "public.jpeg",
  jpeg: "public.jpeg",
  gif: "com.compuserve.gif",
  webp: "org.webmproject.webp",
  svg: "public.svg-image",
};

const CATEGORY_EXTENSIONS: Record<Exclude<OpenTargetCategory, "all" | "folder">, Set<string>> = {
  code: new Set([
    "c", "cc", "cpp", "css", "go", "h", "html", "java", "js", "json", "jsonl", "jsx", "md", "markdown",
    "mjs", "py", "rs", "sh", "swift", "toml", "ts", "tsx", "txt", "xml", "yaml", "yml", "zsh",
  ]),
  document: new Set(["doc", "docx", "pages"]),
  presentation: new Set(["ppt", "pptx", "key"]),
  spreadsheet: new Set(["csv", "xls", "xlsx", "numbers"]),
  pdf: new Set(["pdf"]),
  image: new Set(["bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "tiff", "webp"]),
};

const OPEN_TARGETS: OpenTarget[] = [
  {
    id: "finder",
    label: "Finder",
    kind: "finder",
    appPaths: ["/System/Library/CoreServices/Finder.app"],
    categories: ["all"],
  },
  {
    id: "terminal",
    label: "Terminal",
    kind: "terminal",
    appPaths: ["/System/Applications/Utilities/Terminal.app"],
    appNames: ["Terminal"],
    bundleIds: ["com.apple.Terminal"],
    categories: ["folder", "code"],
  },
  {
    id: "iterm2",
    label: "iTerm2",
    kind: "terminal",
    appPaths: ["/Applications/iTerm.app", "/Applications/iTerm2.app"],
    appNames: ["iTerm", "iTerm2"],
    bundleIds: ["com.googlecode.iterm2"],
    categories: ["folder", "code"],
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "editor",
    appPaths: ["/Applications/Cursor.app", "/Applications/Cursor Preview.app", "/Applications/Cursor Nightly.app"],
    appNames: ["Cursor", "Cursor Preview", "Cursor Nightly"],
    bundleIds: ["com.todesktop.230313mzl4w4u92"],
    categories: ["folder", "code"],
  },
  {
    id: "vscode",
    label: "Visual Studio Code",
    kind: "editor",
    appPaths: ["/Applications/Visual Studio Code.app", "/Applications/Visual Studio Code - Insiders.app"],
    appNames: ["Visual Studio Code", "Visual Studio Code - Insiders"],
    bundleIds: ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders"],
    categories: ["folder", "code"],
  },
  {
    id: "xcode",
    label: "Xcode",
    kind: "editor",
    appPaths: ["/Applications/Xcode.app"],
    appNames: ["Xcode"],
    bundleIds: ["com.apple.dt.Xcode"],
    categories: ["folder", "code"],
  },
  {
    id: "textedit",
    label: "TextEdit",
    kind: "editor",
    appPaths: ["/System/Applications/TextEdit.app"],
    appNames: ["TextEdit"],
    bundleIds: ["com.apple.TextEdit"],
    categories: ["code", "document"],
  },
  {
    id: "preview",
    label: "Preview",
    kind: "viewer",
    appPaths: ["/System/Applications/Preview.app"],
    appNames: ["Preview"],
    bundleIds: ["com.apple.Preview"],
    categories: ["pdf", "image"],
  },
  {
    id: "powerpoint",
    label: "Microsoft PowerPoint",
    kind: "office",
    appPaths: ["/Applications/Microsoft PowerPoint.app"],
    appNames: ["Microsoft PowerPoint", "PowerPoint"],
    bundleIds: ["com.microsoft.Powerpoint"],
    categories: ["presentation"],
  },
  {
    id: "keynote",
    label: "Keynote",
    kind: "office",
    appPaths: ["/Applications/Keynote.app"],
    appNames: ["Keynote"],
    bundleIds: ["com.apple.iWork.Keynote"],
    categories: ["presentation"],
  },
  {
    id: "word",
    label: "Microsoft Word",
    kind: "office",
    appPaths: ["/Applications/Microsoft Word.app"],
    appNames: ["Microsoft Word", "Word"],
    bundleIds: ["com.microsoft.Word"],
    categories: ["document"],
  },
  {
    id: "pages",
    label: "Pages",
    kind: "office",
    appPaths: ["/Applications/Pages.app"],
    appNames: ["Pages"],
    bundleIds: ["com.apple.iWork.Pages"],
    categories: ["document"],
  },
  {
    id: "excel",
    label: "Microsoft Excel",
    kind: "office",
    appPaths: ["/Applications/Microsoft Excel.app"],
    appNames: ["Microsoft Excel", "Excel"],
    bundleIds: ["com.microsoft.Excel"],
    categories: ["spreadsheet"],
  },
  {
    id: "numbers",
    label: "Numbers",
    kind: "office",
    appPaths: ["/Applications/Numbers.app"],
    appNames: ["Numbers"],
    bundleIds: ["com.apple.iWork.Numbers"],
    categories: ["spreadsheet"],
  },
  {
    id: "wps",
    label: "WPS Office",
    kind: "office",
    appPaths: ["/Applications/wpsoffice.app", "/Applications/WPS Office.app"],
    appNames: ["WPS Office", "WPS", "wpsoffice"],
    bundleIds: ["com.kingsoft.wpsoffice.mac", "com.kingsoft.wpsoffice"],
    categories: ["document", "presentation", "spreadsheet"],
  },
];

export abstract class OpenWithService {
  private iconCache = new Map<string, IconCacheEntry>();
  private static readonly ICON_CACHE_TTL_MS = 5 * 60 * 1000;
  private static readonly MAX_ICON_CACHE_SIZE = 80;

  async getFileIcon(appPath: string): Promise<string | undefined> {
    const cached = this.iconCache.get(appPath);
    if (cached && Date.now() - cached.timestamp < OpenWithService.ICON_CACHE_TTL_MS) {
      return cached.dataUrl;
    }
    const dataUrl = await this.loadFileIcon(appPath);
    if (dataUrl) {
      this.iconCache.set(appPath, { dataUrl, timestamp: Date.now() });
      if (this.iconCache.size > OpenWithService.MAX_ICON_CACHE_SIZE) {
        this.evictOldest();
      }
    }
    return dataUrl;
  }

  private async loadFileIcon(appPath: string): Promise<string | undefined> {
    if (appPath.endsWith(".app")) {
      const bundleIcon = await readBundleIcon(appPath);
      if (isUsableDataUrl(bundleIcon)) return bundleIcon;
    }
    try {
      const icon = await app.getFileIcon(appPath, { size: "normal" });
      const dataUrl = icon.isEmpty() ? "" : icon.toDataURL();
      if (isUsableDataUrl(dataUrl)) return dataUrl;
    } catch {
      // Continue to the bundle icon fallback below.
    }
    const bundleIcon = await readBundleIcon(appPath);
    return isUsableDataUrl(bundleIcon) ? bundleIcon : undefined;
  }

  private evictOldest(): void {
    let oldestKey = "";
    let oldestTs = Infinity;
    for (const [key, entry] of this.iconCache) {
      if (entry.timestamp < oldestTs) {
        oldestTs = entry.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) this.iconCache.delete(oldestKey);
  }

  abstract getPathOptions(targetPath: string): Promise<OpenPathOption[]>;
  abstract openWithApp(appPath: string, targetPath: string): Promise<void>;
  abstract openWithDefault(targetPath: string): Promise<void>;
  abstract revealInFinder(targetPath: string): void;
  abstract openTerminalAt(targetPath: string, appPath?: string): Promise<void>;
}

class MacOpenWithService extends OpenWithService {
  private applicationCache: ApplicationCacheEntry | null = null;
  private static readonly APPLICATION_CACHE_TTL_MS = 15 * 1000;

  async getPathOptions(targetPath: string): Promise<OpenPathOption[]> {
    const categories = categoriesForPath(targetPath);
    const nativeOptions = await this.getNativePathOptions(targetPath);
    if (nativeOptions.length > 0) {
      const supplementalOptions = await this.getSupplementalOptions(categories);
      return deduplicateOptions([...nativeOptions, ...supplementalOptions]);
    }
    return this.getFallbackPathOptions(targetPath, categories);
  }

  private async getNativePathOptions(targetPath: string): Promise<OpenPathOption[]> {
    const helperPath = nativeHelperPath();
    if (!helperPath) return [];
    try {
      const stdout = await execFileWithTimeout(helperPath, [targetPath], 5000, 8 * 1024 * 1024);
      const response = JSON.parse(stdout) as NativeOpenWithResponse;
      return nativeResponseToOptions(response);
    } catch {
      return [];
    }
  }

  private async getFallbackPathOptions(targetPath: string, categories: Set<OpenTargetCategory>): Promise<OpenPathOption[]> {
    const extension = extensionOf(targetPath);
    const finderApp = await this.detectTarget(OPEN_TARGETS[0]);
    const defaultApp = categories.has("folder") ? finderApp : await this.detectDefaultApp(extension);
    const detectedTargets = await this.getSupplementalOptions(categories);

    const options: OpenPathOption[] = [];
    const recommendedOption = detectedTargets.find((option) => option.kind !== "finder" && option.kind !== "terminal");
    if (defaultApp) {
      options.push({
        id: "default",
        label: defaultApp.label,
        kind: "default",
        appPath: defaultApp.appPath,
        iconDataUrl: await this.getFileIcon(defaultApp.appPath),
      });
    } else if (recommendedOption) {
      options.push({
        ...recommendedOption,
        kind: "default",
      });
    }
    options.push(...detectedTargets);

    return deduplicateOptions(options);
  }

  private async getSupplementalOptions(categories: Set<OpenTargetCategory>): Promise<OpenPathOption[]> {
    const detectedTargets: OpenPathOption[] = [];
    for (const target of OPEN_TARGETS) {
      if (!targetApplies(target, categories)) continue;
      const detected = await this.detectTarget(target);
      if (!detected) continue;
      detectedTargets.push({
        id: target.kind === "terminal" ? `terminal:${target.id}` : target.id === "finder" ? "finder" : `app:${target.id}`,
        label: detected.label || target.label,
        kind: target.kind,
        appPath: detected.appPath,
        iconDataUrl: await this.getFileIcon(detected.appPath),
      });
    }
    return detectedTargets;
  }

  async openWithApp(appPath: string, targetPath: string): Promise<void> {
    await execOpen(["-a", appPath, targetPath]);
  }

  async openWithDefault(targetPath: string): Promise<void> {
    const error = await shell.openPath(targetPath);
    if (error) throw new Error(error);
  }

  revealInFinder(targetPath: string): void {
    shell.showItemInFolder(targetPath);
  }

  async openTerminalAt(targetPath: string, appPath?: string): Promise<void> {
    const dirPath = directoryForOpen(targetPath);
    if (appPath) {
      await execOpen(["-a", appPath, dirPath]);
      return;
    }
    await execOpen(["-a", "Terminal", dirPath]);
  }

  private async detectDefaultApp(extension: string): Promise<DetectedApp | null> {
    const uti = EXTENSION_TO_UTI[extension];
    if (!uti) return null;
    try {
      const bundleId = await this.queryDefaultBundleId(uti);
      if (!bundleId) return null;
      return this.resolveBundleIdToApp(bundleId);
    } catch {
      return null;
    }
  }

  private async detectTarget(target: OpenTarget): Promise<DetectedApp | null> {
    for (const appPath of target.appPaths || []) {
      const resolved = findExistingAppPath(appPath);
      if (resolved) return appFromPath(resolved, target);
    }

    for (const bundleId of target.bundleIds || []) {
      const app = await this.resolveBundleIdToApp(bundleId);
      if (app) return { ...app, label: target.label };
    }

    const apps = this.listApplications();
    for (const appName of target.appNames || []) {
      const normalized = normalizeAppName(appName);
      const found = apps.find((app) => normalizeAppName(app.label).startsWith(normalized));
      if (found) return { ...found, label: target.label };
    }

    return null;
  }

  private listApplications(): DetectedApp[] {
    if (
      this.applicationCache &&
      Date.now() - this.applicationCache.timestamp < MacOpenWithService.APPLICATION_CACHE_TTL_MS
    ) {
      return this.applicationCache.apps;
    }
    const apps: DetectedApp[] = [];
    const seen = new Set<string>();
    for (const dir of APPLICATION_DIRS) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.toLowerCase().endsWith(".app")) continue;
        const appPath = join(dir, entry);
        if (seen.has(appPath) || !existsSync(appPath)) continue;
        seen.add(appPath);
        apps.push(appFromPath(appPath));
      }
    }
    this.applicationCache = { apps, timestamp: Date.now() };
    return apps;
  }

  private async queryDefaultBundleId(uti: string): Promise<string | undefined> {
    const stdout = await execFileWithTimeout("/usr/bin/defaults", [
      "read",
      "com.apple.LaunchServices/com.apple.launchservices.secure",
      "LSHandlers",
    ]);
    if (!stdout) return undefined;

    const lines = stdout.split("\n");
    let capturing = false;
    let capturedBundleId: string | undefined;
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("LSHandlerContentType") && trimmed.includes(uti)) {
        capturing = true;
        capturedBundleId = undefined;
        continue;
      }
      if (!capturing) continue;
      const bundleMatch = trimmed.match(/LSHandlerRole(?:All|Viewer|Editor)\s*=\s*"([^"]+)"/);
      if (bundleMatch) capturedBundleId = bundleMatch[1];
      if (trimmed === ")" || trimmed.startsWith("}")) {
        if (capturedBundleId) return capturedBundleId;
        capturing = false;
      }
    }
    return capturedBundleId;
  }

  private async resolveBundleIdToApp(bundleId: string): Promise<DetectedApp | null> {
    try {
      const stdout = await execFileWithTimeout("/usr/bin/mdfind", [
        `kMDItemCFBundleIdentifier == '${bundleId}'`,
      ]);
      const lines = stdout.split("\n").filter((line) => line.endsWith(".app"));
      const appPath = sortAppPaths(lines)[0];
      return appPath ? appFromPath(appPath, { bundleIds: [bundleId] }) : null;
    } catch {
      return null;
    }
  }
}

class WinOpenWithService extends OpenWithService {
  async getPathOptions(targetPath: string): Promise<OpenPathOption[]> {
    return [
      { id: "default", label: "默认应用", kind: "default" },
      { id: "finder", label: "File Explorer", kind: "finder", appPath: targetPath },
    ];
  }

  async openWithApp(_appPath: string, _targetPath: string): Promise<void> {
    throw new Error("Windows 暂不支持指定应用打开。");
  }

  async openWithDefault(targetPath: string): Promise<void> {
    const error = await shell.openPath(targetPath);
    if (error) throw new Error(error);
  }

  revealInFinder(targetPath: string): void {
    shell.showItemInFolder(targetPath);
  }

  async openTerminalAt(_targetPath: string, _appPath?: string): Promise<void> {
    throw new Error("Windows 暂不支持。");
  }
}

class LinuxOpenWithService extends OpenWithService {
  async getPathOptions(targetPath: string): Promise<OpenPathOption[]> {
    return [
      { id: "default", label: "默认应用", kind: "default" },
      { id: "finder", label: "文件管理器", kind: "finder", appPath: targetPath },
    ];
  }

  async openWithApp(_appPath: string, _targetPath: string): Promise<void> {
    throw new Error("Linux 暂不支持指定应用打开。");
  }

  async openWithDefault(targetPath: string): Promise<void> {
    const error = await shell.openPath(targetPath);
    if (error) throw new Error(error);
  }

  revealInFinder(targetPath: string): void {
    shell.showItemInFolder(targetPath);
  }

  async openTerminalAt(_targetPath: string, _appPath?: string): Promise<void> {
    throw new Error("Linux 暂不支持。");
  }
}

export function createOpenWithService(): OpenWithService {
  if (process.platform === "darwin") return new MacOpenWithService();
  if (process.platform === "win32") return new WinOpenWithService();
  return new LinuxOpenWithService();
}

function nativeHelperPath(): string | null {
  const candidates = app.isPackaged
    ? [
        join(process.resourcesPath, "native", "launch-services-helper"),
        join(process.resourcesPath, "app.asar.unpacked", "dist", "native", "launch-services-helper"),
      ]
    : [
        join(app.getAppPath(), "dist", "native", "launch-services-helper"),
        join(process.cwd(), "dist", "native", "launch-services-helper"),
      ];
  return candidates.find((candidate) => existsSync(candidate)) || null;
}

function nativeResponseToOptions(response: NativeOpenWithResponse): OpenPathOption[] {
  const options: OpenPathOption[] = [];
  const defaultApp = response.defaultApp || null;
  if (defaultApp) {
    options.push(nativeAppToOption(defaultApp, "default"));
  }
  for (const nativeApp of response.apps || []) {
    if (defaultApp && sameNativeApp(defaultApp, nativeApp)) continue;
    options.push(nativeAppToOption(nativeApp));
  }
  if (!defaultApp && options[0]) {
    options[0] = { ...options[0], kind: "default" };
  }
  return deduplicateOptions(options);
}

function nativeAppToOption(nativeApp: NativeOpenWithApp, forcedKind?: OpenTargetKind): OpenPathOption {
  const kind = forcedKind || nativeAppKind(nativeApp);
  return {
    id: kind === "default" ? "default" : nativeAppOptionId(nativeApp, kind),
    label: normalizeNativeDisplayName(nativeApp.displayName, nativeApp.appPath),
    kind,
    appPath: nativeApp.appPath,
    iconDataUrl: isUsableDataUrl(nativeApp.iconDataUrl) ? nativeApp.iconDataUrl : undefined,
  };
}

function nativeAppOptionId(nativeApp: NativeOpenWithApp, kind: OpenTargetKind): string {
  if (kind === "finder") return "finder";
  const key = nativeApp.bundleId || normalizeAppName(nativeApp.displayName) || basename(nativeApp.appPath, ".app");
  if (kind === "terminal") return `terminal:native:${key}`;
  return `app:native:${key}`;
}

function nativeAppKind(nativeApp: NativeOpenWithApp): OpenTargetKind {
  const bundleId = nativeApp.bundleId?.toLowerCase() || "";
  const appPath = nativeApp.appPath.toLowerCase();
  const label = normalizeAppName(nativeApp.displayName);
  for (const target of OPEN_TARGETS) {
    if (target.bundleIds?.some((id) => id.toLowerCase() === bundleId)) return target.kind;
    if (target.appPaths?.some((path) => path.toLowerCase() === appPath)) return target.kind;
    if (target.appNames?.some((name) => label === normalizeAppName(name))) return target.kind;
  }
  return "application";
}

function sameNativeApp(a: NativeOpenWithApp, b: NativeOpenWithApp): boolean {
  if (a.bundleId && b.bundleId && a.bundleId === b.bundleId) return true;
  return a.appPath === b.appPath;
}

function normalizeNativeDisplayName(displayName: string, appPath: string): string {
  const trimmed = displayName.trim();
  if (normalizeAppName(trimmed) === "wpsoffice") return "WPS Office";
  return trimmed || basename(appPath, ".app");
}

function categoriesForPath(targetPath: string): Set<OpenTargetCategory> {
  const categories = new Set<OpenTargetCategory>(["all"]);
  if (isDirectory(targetPath)) {
    categories.add("folder");
    return categories;
  }
  const extension = extensionOf(targetPath);
  for (const [category, extensions] of Object.entries(CATEGORY_EXTENSIONS)) {
    if (extensions.has(extension)) categories.add(category as OpenTargetCategory);
  }
  if (categories.size === 1) categories.add("code");
  return categories;
}

function targetApplies(target: OpenTarget, categories: Set<OpenTargetCategory>): boolean {
  return target.categories.some((category) => categories.has(category));
}

function findExistingAppPath(appPath: string): string | null {
  for (const candidate of withHomeApplicationVariant(appPath)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function withHomeApplicationVariant(appPath: string): string[] {
  if (!appPath.startsWith("/Applications/")) return [appPath];
  return [appPath, join(homedir(), "Applications", appPath.slice("/Applications/".length))];
}

function appFromPath(appPath: string, target?: Partial<Pick<OpenTarget, "label" | "bundleIds">>): DetectedApp {
  return {
    appPath,
    bundleId: target?.bundleIds?.[0],
    label: target?.label || basename(appPath, ".app"),
  };
}

function sortAppPaths(paths: string[]): string[] {
  return paths.sort((a, b) => appPathRank(a) - appPathRank(b));
}

function appPathRank(path: string): number {
  if (path.startsWith("/Applications/")) return 0;
  if (path.startsWith(join(homedir(), "Applications"))) return 1;
  if (path.startsWith("/System/Applications/")) return 2;
  return 3;
}

function deduplicateOptions(options: OpenPathOption[]): OpenPathOption[] {
  const seen = new Set<string>();
  const result: OpenPathOption[] = [];
  for (const option of options) {
    const identityKey = option.appPath || option.id;
    if (seen.has(identityKey)) continue;
    seen.add(identityKey);
    result.push(option);
  }
  return result;
}

function normalizeAppName(value: string): string {
  return value.toLowerCase().replace(/\.app$/, "").replace(/[^a-z0-9]+/g, "");
}

function extensionOf(targetPath: string): string {
  return extname(targetPath).slice(1).toLowerCase();
}

function isDirectory(targetPath: string): boolean {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function directoryForOpen(targetPath: string): string {
  return isDirectory(targetPath) ? targetPath : dirname(targetPath);
}

function isUsableDataUrl(value: string | undefined): value is string {
  return Boolean(value?.startsWith("data:image/") && value.length > 150);
}

async function readBundleIcon(appPath: string): Promise<string | undefined> {
  if (!appPath.endsWith(".app")) return undefined;
  const infoPath = join(appPath, "Contents", "Info.plist");
  if (!existsSync(infoPath)) return undefined;
  try {
    const json = await execFileWithTimeout("/usr/bin/plutil", ["-convert", "json", "-o", "-", infoPath]);
    const info = JSON.parse(json) as Record<string, unknown>;
    const iconName = typeof info.CFBundleIconFile === "string" ? info.CFBundleIconFile : "";
    if (!iconName) return undefined;
    const candidates = iconName.endsWith(".icns") ? [iconName] : [`${iconName}.icns`, iconName];
    for (const candidate of candidates) {
      const iconPath = join(appPath, "Contents", "Resources", candidate);
      if (!existsSync(iconPath)) continue;
      if (iconPath.endsWith(".icns")) {
        const converted = await convertIcnsToPngDataUrl(iconPath);
        if (converted) return converted;
      }
      const icon = nativeImage.createFromPath(iconPath);
      if (!icon.isEmpty()) return icon.toDataURL();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function convertIcnsToPngDataUrl(iconPath: string): Promise<string | undefined> {
  const outputPath = join(tmpdir(), `brevyn-app-icon-${randomUUID()}.png`);
  try {
    await execFileWithTimeout("/usr/bin/sips", ["-s", "format", "png", iconPath, "--out", outputPath], 3000);
    const png = readFileSync(outputPath);
    return `data:image/png;base64,${png.toString("base64")}`;
  } catch {
    return undefined;
  } finally {
    try {
      rmSync(outputPath, { force: true });
    } catch {
      // Ignore cleanup failures for temporary icon conversions.
    }
  }
}

function execOpen(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/open", args, (error, _stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve();
    });
  });
}

function execFileWithTimeout(
  command: string,
  args: string[],
  timeoutMs = 3000,
  maxBuffer = 1024 * 1024,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}
