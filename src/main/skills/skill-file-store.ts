import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { SkillItem, SkillResource, SkillResourceKind } from "../../types/domain";
import type { SkillBlueprint } from "./skill-registry";

interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  category?: string;
  icon?: string;
  triggers?: string[];
  tags?: string[];
  scopes?: string[];
  allowedTools?: string[];
}

const MAX_SKILL_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_RESOURCES = 200;
const LEGACY_DEFAULT_SKILL_SOURCE_FILE = ".brevyn-default-skill.json";
const SKILL_COPY_BLOCKLIST = new Set([
  LEGACY_DEFAULT_SKILL_SOURCE_FILE,
  ".DS_Store",
  ".git",
  "node_modules",
  "dist",
  ".next",
  ".cache",
  ".turbo",
  "__pycache__",
]);
const DEFAULT_SKILL_SHARED_DIRS = new Set(["_shared"]);
const SKILL_RESOURCE_DIRS: Array<{ dirname: string; kind: SkillResourceKind }> = [
  { dirname: "references", kind: "reference" },
  { dirname: "static", kind: "reference" },
  { dirname: "docs", kind: "reference" },
  { dirname: "scripts", kind: "script" },
  { dirname: "assets", kind: "asset" },
  { dirname: "templates", kind: "template" },
  { dirname: "examples", kind: "example" },
  { dirname: "agents", kind: "agent_config" },
  { dirname: "config", kind: "other" },
  { dirname: "data", kind: "other" },
  { dirname: "src", kind: "other" },
  { dirname: "tests", kind: "other" },
  { dirname: "evals", kind: "other" },
  { dirname: "tasks", kind: "reference" },
  { dirname: "profiles", kind: "reference" },
  { dirname: "ooxml", kind: "reference" },
  { dirname: "troubleshooting", kind: "reference" },
];
const ROOT_REFERENCE_FILE_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);
const ROOT_REFERENCE_FILE_SKIP = new Set(["SKILL.md", "README.md", "LICENSE", "LICENSE.txt", "license.txt"]);
const NATIVE_PLUGIN_MANIFEST = {
  name: "brevyn-global-skills",
  version: "1.0.0",
};

export class SkillFileStore {
  constructor(private readonly rootPath: string) {}

  ensureNativePluginManifest(): void {
    const pluginDir = join(this.rootPath, ".claude-plugin");
    const manifestPath = join(pluginDir, "plugin.json");
    mkdirSync(pluginDir, { recursive: true });
    if (existsSync(manifestPath)) return;
    writeFileSync(manifestPath, JSON.stringify(NATIVE_PLUGIN_MANIFEST, null, 2), "utf8");
  }

  nativePluginRootPath(): string {
    return this.rootPath;
  }

  ensureDefaultSkillTemplates(blueprints: SkillBlueprint[]): void {
    const templateDir = join(this.rootPath, "default-skills");
    const activeDir = join(this.rootPath, "skills");
    const inactiveDir = join(this.rootPath, "skills-inactive");
    mkdirSync(templateDir, { recursive: true });
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(inactiveDir, { recursive: true });
    for (const blueprint of blueprints) {
      const templateSkillDir = join(templateDir, blueprint.id);
      const templatePath = join(templateSkillDir, "SKILL.md");
      if (!existsSync(templatePath)) {
        mkdirSync(templateSkillDir, { recursive: true });
        writeFileSync(templatePath, renderSkillTemplate(blueprint), "utf8");
      }

      const activePath = join(activeDir, blueprint.id, "SKILL.md");
      const inactivePath = join(inactiveDir, blueprint.id, "SKILL.md");
      if (existsSync(activePath) || existsSync(inactivePath)) continue;
      const targetDir = blueprint.defaultEnabled ? join(activeDir, blueprint.id) : join(inactiveDir, blueprint.id);
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "SKILL.md"), renderSkillTemplate(blueprint), "utf8");
    }
  }

  syncDefaultSkillFolders(sourceDir: string): void {
    if (!existsSync(sourceDir)) return;
    const templateDir = join(this.rootPath, "default-skills");
    const activeDir = join(this.rootPath, "skills");
    const inactiveDir = join(this.rootPath, "skills-inactive");
    mkdirSync(templateDir, { recursive: true });
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(inactiveDir, { recursive: true });

    pruneRemovedDefaultSkillFolders(sourceDir, templateDir, [activeDir, inactiveDir]);
    syncDefaultSharedFolders(sourceDir, [templateDir, activeDir, inactiveDir]);

    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidSkillSlug(entry.name)) continue;
      const sourceSkillDir = join(sourceDir, entry.name);
      if (!existsSync(join(sourceSkillDir, "SKILL.md"))) continue;

      const templateSkillDir = join(templateDir, entry.name);
      syncDefaultSkillFolder(sourceSkillDir, templateSkillDir, entry.name);

      const activeSkillDir = join(activeDir, entry.name);
      const inactiveSkillDir = join(inactiveDir, entry.name);
      if (existsSync(activeSkillDir)) {
        syncDefaultSkillFolder(sourceSkillDir, activeSkillDir, entry.name);
        continue;
      }
      if (existsSync(inactiveSkillDir)) {
        syncDefaultSkillFolder(sourceSkillDir, inactiveSkillDir, entry.name);
        continue;
      }
      replaceSkillFolder(sourceSkillDir, activeSkillDir, entry.name);
    }
  }

  listSkills(): SkillItem[] {
    return [
      ...this.scanDir(join(this.rootPath, "skills"), true),
      ...this.scanDir(join(this.rootPath, "skills-inactive"), false),
    ];
  }

  toggleSkill(id: string, enabled: boolean): SkillItem | null {
    const resolved = this.resolveSkillDir(id);
    if (!resolved) return null;
    const source = join(this.rootPath, enabled ? "skills-inactive" : "skills");
    const target = join(this.rootPath, enabled ? "skills" : "skills-inactive");
    const sourcePath = join(source, resolved.slug);
    const targetPath = join(target, resolved.slug);
    if (!existsSync(sourcePath)) return null;
    mkdirSync(target, { recursive: true });
    renameSync(sourcePath, targetPath);
    return this.readSkillDir(targetPath, resolved.slug, enabled);
  }

  readSkillContent(id: string): string | null {
    const resolved = this.resolveSkillDir(id);
    if (!resolved) return null;
    return readFileSync(join(resolved.dir, "SKILL.md"), "utf8");
  }

  writeSkillContent(id: string, content: string): SkillItem | null {
    const resolved = this.resolveSkillDir(id);
    if (!resolved) return null;
    assertSkillContentNotBlank(content);
    assertSkillContentSize(content, join(resolved.dir, "SKILL.md"));
    writeFileSync(join(resolved.dir, "SKILL.md"), content, "utf8");
    return this.readSkillDir(resolved.dir, resolved.slug, resolved.enabled);
  }

  importSkillFolder(sourcePath: string, enabled = true): SkillItem {
    const sourceDir = resolve(sourcePath);
    const slug = basename(sourceDir).trim();
    if (!isValidSkillSlug(slug)) {
      throw new Error(`Invalid skill folder name: ${slug || "(empty)"}`);
    }
    const sourceSkillPath = join(sourceDir, "SKILL.md");
    if (!existsSync(sourceSkillPath)) {
      throw new Error(`Imported skill folder is missing SKILL.md: ${sourceDir}`);
    }
    if (statSync(sourceSkillPath).size > MAX_SKILL_CONTENT_BYTES) {
      throw new Error(`Skill file is too large. Maximum size is ${formatMaxSkillSize()}.`);
    }

    const targetBaseDir = join(this.rootPath, enabled ? "skills" : "skills-inactive");
    const targetDir = join(targetBaseDir, slug);
    const inactiveTargetDir = join(this.rootPath, "skills-inactive");
    const activeTargetDir = join(this.rootPath, "skills");

    if (existsSync(join(activeTargetDir, slug)) || existsSync(join(inactiveTargetDir, slug))) {
      throw new Error(`A skill with the same folder name already exists: ${slug}`);
    }

    mkdirSync(targetBaseDir, { recursive: true });
    cpSync(sourceDir, targetDir, { recursive: true, errorOnExist: true, force: false, filter: skillCopyFilter });
    const imported = this.readSkillDir(targetDir, slug, enabled);
    if (!imported) {
      throw new Error(`Failed to load imported skill: ${slug}`);
    }
    return imported;
  }

  skillFolderPath(id: string): string | null {
    return this.resolveSkillDir(id)?.dir || null;
  }

  private scanDir(dir: string, enabled: boolean): SkillItem[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const skill = this.readSkillDir(join(dir, entry.name), entry.name, enabled);
        return skill ? [skill] : [];
      });
  }

  private readSkillDir(dir: string, slug: string, enabled: boolean): SkillItem | null {
    const skillPath = join(dir, "SKILL.md");
    if (!existsSync(skillPath)) return null;
    try {
      const parsed = parseSkillMarkdown(readFileSync(skillPath, "utf8"));
      return {
        id: `file:${slug}`,
        slug,
        name: parsed.frontmatter.name || titleFromSlug(slug),
        enabled,
        description: parsed.frontmatter.description || "Workspace skill loaded from SKILL.md.",
        version: parsed.frontmatter.version || "0.1.0",
        category: parsed.frontmatter.category,
        icon: parsed.frontmatter.icon,
        triggers: parsed.frontmatter.triggers,
        tags: parsed.frontmatter.tags,
        scopes: parsed.frontmatter.scopes,
        allowedTools: parsed.frontmatter.allowedTools,
        instructions: parsed.body.trim(),
        resources: listSkillResources(dir),
        sourcePath: skillPath,
      };
    } catch (error) {
      console.warn(`[skills] Failed to parse ${skillPath}`, error);
      return null;
    }
  }

  private resolveSkillDir(id: string): { dir: string; slug: string; enabled: boolean } | null {
    const parsed = parseFileSkillId(id);
    if (!parsed) return null;
    const activeDir = join(this.rootPath, "skills");
    const inactiveDir = join(this.rootPath, "skills-inactive");
    const activePath = resolveSkillChildDir(activeDir, parsed.slug);
    if (!activePath) return null;
    if (existsSync(activePath)) {
      return { dir: activePath, slug: parsed.slug, enabled: true };
    }
    const inactivePath = resolveSkillChildDir(inactiveDir, parsed.slug);
    if (!inactivePath) return null;
    if (existsSync(inactivePath)) {
      return { dir: inactivePath, slug: parsed.slug, enabled: false };
    }
    return null;
  }
}

function parseSkillMarkdown(content: string): { frontmatter: SkillFrontmatter; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: {}, body: content };
  const rawFrontmatter = content.slice(3, end).trim();
  const body = content.slice(end + 4).trimStart();
  return { frontmatter: parseFrontmatter(rawFrontmatter), body };
}

function parseFrontmatter(value: string): SkillFrontmatter {
  const result: SkillFrontmatter = {};
  const lines = value.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    const key = normalizeFrontmatterKey(match[1]);
    let raw = match[2] || "";
    const blockMarker = raw.trim();
    if (blockMarker === "|" || blockMarker === "|-" || blockMarker === "|+" || blockMarker === ">" || blockMarker === ">-" || blockMarker === ">+") {
      const block: string[] = [];
      while (index + 1 < lines.length && (lines[index + 1].startsWith(" ") || lines[index + 1].startsWith("\t") || lines[index + 1].trim() === "")) {
        index += 1;
        block.push(lines[index].replace(/^\s{2}/, ""));
      }
      raw = block.join(blockMarker.startsWith(">") ? " " : "\n");
    }
    const stringValue = unquote(raw);
    const listValue = parseFrontmatterList(stringValue, lines, index);
    if (listValue.consumed > 0) index += listValue.consumed;
    if (key === "name") result.name = stringValue;
    if (key === "description") result.description = stringValue;
    if (key === "version") result.version = stringValue;
    if (key === "category") result.category = stringValue;
    if (key === "icon") result.icon = stringValue;
    if (key === "triggers") result.triggers = listValue.values;
    if (key === "tags") result.tags = listValue.values;
    if (key === "scopes") result.scopes = listValue.values;
    if (key === "allowedTools") result.allowedTools = listValue.values;
  }
  return result;
}

function normalizeFrontmatterKey(key: string): keyof SkillFrontmatter | string {
  if (key === "allowed-tools" || key === "allowed_tools") return "allowedTools";
  return key;
}

function parseFrontmatterList(raw: string, lines: string[], index: number): { values: string[] | undefined; consumed: number } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return { values: trimmed.slice(1, -1).split(",").map((item) => unquote(item)).filter(Boolean), consumed: 0 };
  }
  if (trimmed) return { values: splitCommaList(trimmed), consumed: 0 };
  const values: string[] = [];
  let consumed = 0;
  while (index + consumed + 1 < lines.length) {
    const next = lines[index + consumed + 1];
    const item = next.match(/^\s*-\s+(.+)$/);
    if (!item) break;
    values.push(unquote(item[1]));
    consumed += 1;
  }
  return { values: values.length ? values : undefined, consumed };
}

function splitCommaList(value: string): string[] | undefined {
  if (!value.includes(",")) return value ? [value] : undefined;
  const values = value.split(",").map((item) => unquote(item)).filter(Boolean);
  return values.length ? values : undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function listSkillResources(skillDir: string): SkillResource[] {
  const resources: SkillResource[] = [];
  for (const { dirname, kind } of SKILL_RESOURCE_DIRS) {
    const resourceDir = join(skillDir, dirname);
    if (!existsSync(resourceDir)) continue;
    collectSkillResources(skillDir, resourceDir, kind, resources);
    if (resources.length >= MAX_SKILL_RESOURCES) break;
  }
  collectRootReferenceResources(skillDir, resources);
  return resources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function collectRootReferenceResources(skillDir: string, resources: SkillResource[]): void {
  if (resources.length >= MAX_SKILL_RESOURCES) return;
  for (const entry of readdirSync(skillDir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith(".") || ROOT_REFERENCE_FILE_SKIP.has(entry.name)) continue;
    const extension = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".")).toLowerCase() : "";
    if (!ROOT_REFERENCE_FILE_EXTENSIONS.has(extension)) continue;
    const fullPath = join(skillDir, entry.name);
    const stats = statSync(fullPath);
    resources.push({
      kind: "reference",
      name: entry.name,
      relativePath: entry.name,
      size: stats.size,
      sizeLabel: formatBytes(stats.size),
    });
    if (resources.length >= MAX_SKILL_RESOURCES) return;
  }
}

function collectSkillResources(skillDir: string, dir: string, kind: SkillResourceKind, resources: SkillResource[]): void {
  if (resources.length >= MAX_SKILL_RESOURCES) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSkillResources(skillDir, fullPath, kind, resources);
      continue;
    }
    if (!entry.isFile()) continue;
    const stats = statSync(fullPath);
    resources.push({
      kind,
      name: entry.name,
      relativePath: toPosixPath(relative(skillDir, fullPath)),
      size: stats.size,
      sizeLabel: formatBytes(stats.size),
    });
    if (resources.length >= MAX_SKILL_RESOURCES) return;
  }
}

function toPosixPath(path: string): string {
  return path.split(sep).join("/");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${formatNumber(kb)} KB`;
  return `${formatNumber(kb / 1024)} MB`;
}

function formatNumber(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

function parseFileSkillId(id: unknown): { slug: string } | null {
  if (typeof id !== "string") return null;
  if (!id.startsWith("file:")) return null;
  const slug = id.slice("file:".length);
  if (!isValidSkillSlug(slug)) return null;
  return { slug };
}

function resolveSkillChildDir(baseDir: string, slug: string): string | null {
  const base = resolve(baseDir);
  const target = resolve(base, slug);
  if (target === base || target.startsWith(`${base}${sep}`)) return target;
  return null;
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function renderSkillTemplate(blueprint: SkillBlueprint): string {
  return [
    "---",
    `name: "${blueprint.name}"`,
    `description: "${blueprint.description}"`,
    `version: "${blueprint.version}"`,
    "---",
    "",
    blueprint.instructions,
    "",
  ].join("\n");
}

function isValidSkillSlug(slug: string): boolean {
  if (!slug || slug === "." || slug === "..") return false;
  return slug === sanitizeSkillSlug(slug);
}

function sanitizeSkillSlug(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.\./g, "-");
}

function assertSkillContentSize(content: string, skillPath: string): void {
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength <= MAX_SKILL_CONTENT_BYTES) return;
  throw new Error(`Skill file is too large. Maximum size is ${formatMaxSkillSize()} (${skillPath}).`);
}

function assertSkillContentNotBlank(content: string): void {
  if (typeof content === "string" && content.trim().length > 0) return;
  throw new Error("SKILL.md cannot be saved empty.");
}

function formatMaxSkillSize(): string {
  return "10 MB";
}

export function firstDefaultSkillSourceDir(candidates: string[]): string | undefined {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const sourceDir = resolve(candidate);
    if (seen.has(sourceDir)) continue;
    seen.add(sourceDir);
    if (!existsSync(sourceDir)) continue;
    try {
      const hasSkill = readdirSync(sourceDir, { withFileTypes: true }).some((entry) => (
        entry.isDirectory()
        && isValidSkillSlug(entry.name)
        && existsSync(join(sourceDir, entry.name, "SKILL.md"))
      ));
      if (hasSkill) return sourceDir;
    } catch {
      continue;
    }
  }
  return undefined;
}

function syncDefaultSkillFolder(sourceDir: string, targetDir: string, slug: string): void {
  if (!existsSync(targetDir)) {
    replaceSkillFolder(sourceDir, targetDir, slug);
    return;
  }

  const sourceVersion = parseSkillVersion(sourceDir);
  const targetVersion = parseSkillVersion(targetDir);
  removeLegacyDefaultSkillMarker(targetDir);
  if (compareSemver(sourceVersion, targetVersion) <= 0) return;
  replaceSkillFolder(sourceDir, targetDir, slug);
}

function pruneRemovedDefaultSkillFolders(sourceDir: string, templateDir: string, targetDirs: string[]): void {
  if (!existsSync(templateDir)) return;
  const sourceSlugs = defaultSkillSlugs(sourceDir);
  for (const entry of readdirSync(templateDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSkillSlug(entry.name) || DEFAULT_SKILL_SHARED_DIRS.has(entry.name)) continue;
    if (sourceSlugs.has(entry.name)) continue;
    const templateSkillDir = join(templateDir, entry.name);
    if (!existsSync(join(templateSkillDir, "SKILL.md"))) continue;
    rmSync(templateSkillDir, { recursive: true, force: true });
    for (const targetDir of targetDirs) {
      rmSync(join(targetDir, entry.name), { recursive: true, force: true });
    }
  }
  for (const sharedDir of DEFAULT_SKILL_SHARED_DIRS) {
    if (existsSync(join(sourceDir, sharedDir))) continue;
    rmSync(join(templateDir, sharedDir), { recursive: true, force: true });
    for (const targetDir of targetDirs) {
      rmSync(join(targetDir, sharedDir), { recursive: true, force: true });
    }
  }
}

function defaultSkillSlugs(sourceDir: string): Set<string> {
  const slugs = new Set<string>();
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !isValidSkillSlug(entry.name) || DEFAULT_SKILL_SHARED_DIRS.has(entry.name)) continue;
    if (!existsSync(join(sourceDir, entry.name, "SKILL.md"))) continue;
    slugs.add(entry.name);
  }
  return slugs;
}

function syncDefaultSharedFolders(sourceDir: string, targetBaseDirs: string[]): void {
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !DEFAULT_SKILL_SHARED_DIRS.has(entry.name)) continue;
    const sourceSharedDir = join(sourceDir, entry.name);
    for (const targetBaseDir of targetBaseDirs) {
      replaceSkillFolder(sourceSharedDir, join(targetBaseDir, entry.name), entry.name);
    }
  }
}

function replaceSkillFolder(sourceDir: string, targetDir: string, slug: string): void {
  const parentDir = resolve(targetDir, "..");
  mkdirSync(parentDir, { recursive: true });
  const tmpDir = join(parentDir, `.${slug}.syncing-${process.pid}-${Date.now()}`);
  rmSync(tmpDir, { recursive: true, force: true });
  cpSync(sourceDir, tmpDir, { recursive: true, filter: skillCopyFilter });
  rmSync(targetDir, { recursive: true, force: true });
  renameSync(tmpDir, targetDir);
}

function removeLegacyDefaultSkillMarker(skillDir: string): void {
  rmSync(join(skillDir, LEGACY_DEFAULT_SKILL_SOURCE_FILE), { force: true });
}

function skillCopyFilter(src: string): boolean {
  return !SKILL_COPY_BLOCKLIST.has(basename(src));
}

function parseSkillVersion(skillDir: string): string {
  try {
    const parsed = parseSkillMarkdown(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
    return parsed.frontmatter.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseSemver(value: string): [number, number, number] {
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return [
    match ? Number(match[1] || 0) : 0,
    match ? Number(match[2] || 0) : 0,
    match ? Number(match[3] || 0) : 0,
  ];
}
