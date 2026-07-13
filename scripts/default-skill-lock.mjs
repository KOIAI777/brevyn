import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const DEFAULT_SKILL_LOCK_RELATIVE_PATH = join("default-skills", ".skill-versions.json");

const LOCK_SCHEMA_VERSION = 2;
const PREVIOUS_LOCK_SCHEMA_VERSION = 1;
const EXCLUDED_NAMES = new Set([
  ".brevyn-default-skill.json",
  ".DS_Store",
  ".cache",
  ".git",
  ".next",
  ".skill-versions.json",
  ".turbo",
  "__pycache__",
  "dist",
  "node_modules",
]);

export function isDefaultSkillIgnoredName(name) {
  return EXCLUDED_NAMES.has(name) || name === ".env" || name.startsWith(".env.");
}

export function compareDefaultSkillNames(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export function validateDefaultSkillLock({ rootDir = process.cwd() } = {}) {
  const state = collectDefaultSkillState(rootDir);
  const lock = readSkillLock(rootDir);
  const errors = [];
  const currentSlugs = Object.keys(state.skills);
  const lockedSlugs = Object.keys(lock.skills || {});

  for (const slug of currentSlugs) {
    const current = state.skills[slug];
    const locked = lock.skills?.[slug];
    if (!locked) {
      errors.push(`Default skill "${slug}" is missing from the version lock.`);
      continue;
    }
    if (locked.version !== current.version) {
      errors.push(`Default skill "${slug}" version lock is ${locked.version}, but SKILL.md declares ${current.version}.`);
    }
    if (locked.contentSha256 !== current.contentSha256) {
      errors.push(`Default skill "${slug}" content changed without an updated version lock.`);
    }
  }

  for (const slug of lockedSlugs) {
    if (!state.skills[slug]) errors.push(`Version lock contains removed default skill "${slug}".`);
  }

  if ((lock.sharedContentSha256 || "") !== (state.sharedContentSha256 || "")) {
    errors.push("Shared Office skill resources changed without an updated version lock.");
  }

  if (errors.length > 0) {
    throw new Error(`${errors.join("\n")}\nRaise each changed Skill version, then run npm run update:skill-lock.`);
  }
  return state;
}

export function updateDefaultSkillLock({ rootDir = process.cwd() } = {}) {
  const state = collectDefaultSkillState(rootDir);
  const previous = readSkillLock(rootDir, { optional: true, allowPreviousSchema: true });
  const isSchemaMigration = Boolean(previous && previous.schemaVersion !== LOCK_SCHEMA_VERSION);
  const errors = [];

  for (const [slug, current] of Object.entries(state.skills)) {
    const locked = previous?.skills?.[slug];
    if (!locked) continue;
    if (compareSemver(current.version, locked.version) < 0) {
      errors.push(`Default skill "${slug}" cannot move backwards from ${locked.version} to ${current.version}.`);
      continue;
    }
    if (!isSchemaMigration && locked.contentSha256 !== current.contentSha256 && compareSemver(current.version, locked.version) <= 0) {
      errors.push(`Default skill "${slug}" changed without a version increase (${locked.version} -> ${current.version}).`);
    }
  }

  if (errors.length > 0) throw new Error(errors.join("\n"));

  const lockPath = resolve(rootDir, DEFAULT_SKILL_LOCK_RELATIVE_PATH);
  const lock = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    sharedContentSha256: state.sharedContentSha256,
    skills: state.skills,
  };
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  return state;
}

export function collectDefaultSkillState(rootDir = process.cwd()) {
  const skillsDir = resolve(rootDir, "default-skills");
  if (!existsSync(skillsDir)) throw new Error(`Default skills directory not found: ${skillsDir}`);

  const skills = {};
  const entries = readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => compareDefaultSkillNames(left.name, right.name));

  for (const entry of entries) {
    if (entry.name === "_shared") continue;
    const skillDir = join(skillsDir, entry.name);
    const skillPath = join(skillDir, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const metadata = parseSkillMetadata(readFileSync(skillPath, "utf8"), skillPath);
    if (metadata.name !== entry.name) {
      throw new Error(`Default skill folder "${entry.name}" declares name "${metadata.name}".`);
    }
    skills[entry.name] = {
      version: metadata.version,
      contentSha256: hashDirectory(skillDir),
    };
  }

  const sharedDir = join(skillsDir, "_shared");
  return {
    skills,
    sharedContentSha256: existsSync(sharedDir) ? hashDirectory(sharedDir) : undefined,
  };
}

function readSkillLock(rootDir, { optional = false, allowPreviousSchema = false } = {}) {
  const lockPath = resolve(rootDir, DEFAULT_SKILL_LOCK_RELATIVE_PATH);
  if (!existsSync(lockPath)) {
    if (optional) return undefined;
    throw new Error(`Default skill version lock not found: ${lockPath}`);
  }
  const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  const supportedSchema = parsed?.schemaVersion === LOCK_SCHEMA_VERSION ||
    (allowPreviousSchema && parsed?.schemaVersion === PREVIOUS_LOCK_SCHEMA_VERSION);
  if (!supportedSchema || !parsed.skills || typeof parsed.skills !== "object") {
    throw new Error(`Invalid default skill version lock: ${lockPath}`);
  }
  return parsed;
}

function parseSkillMetadata(content, skillPath) {
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/u)?.[1];
  if (!frontmatter) throw new Error(`Missing YAML frontmatter in ${skillPath}`);
  const name = frontmatterValue(frontmatter, "name");
  const version = frontmatterValue(frontmatter, "version");
  if (!name) throw new Error(`Missing skill name in ${skillPath}`);
  if (!version || !/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Default skill version must use x.y.z semver in ${skillPath}`);
  }
  return { name, version };
}

function frontmatterValue(frontmatter, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = frontmatter.match(new RegExp(`^${escaped}:\\s*(?:"([^"]+)"|'([^']+)'|([^\\s#]+))\\s*$`, "mu"));
  return (match?.[1] || match?.[2] || match?.[3] || "").trim();
}

function hashDirectory(directory) {
  const hash = createHash("sha256");
  for (const path of collectFiles(directory)) {
    const name = relative(directory, path).split(sep).join("/");
    hash.update(name);
    hash.update("\0");
    hash.update(normalizedFileContent(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function normalizedFileContent(path) {
  const content = readFileSync(path);
  if (!content.includes(13)) return content;
  return Buffer.from(content.toString("latin1").replaceAll("\r\n", "\n"), "latin1");
}

function collectFiles(directory) {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !isDefaultSkillIgnoredName(entry.name))
    .sort((left, right) => compareDefaultSkillNames(left.name, right.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path));
    if (entry.isFile()) files.push(path);
  }
  return files;
}

function compareSemver(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
