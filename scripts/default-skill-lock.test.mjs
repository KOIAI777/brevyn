import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { updateDefaultSkillLock, validateDefaultSkillLock } from "./default-skill-lock.mjs";

const lockModuleUrl = new URL("./default-skill-lock.mjs", import.meta.url).href;
const archiveScriptPath = fileURLToPath(new URL("./build-skills-archive.mjs", import.meta.url));

test("default Skill content changes require a version increase", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "brevyn-skill-lock-"));
  const skillDir = join(rootDir, "default-skills", "example-skill");
  try {
    mkdirSync(skillDir, { recursive: true });
    writeSkill(skillDir, "1.0.0", "Initial instructions.");
    writeFileSync(join(skillDir, ".env.example"), "IGNORED_VALUE=one\n", "utf8");
    updateDefaultSkillLock({ rootDir });
    validateDefaultSkillLock({ rootDir });

    const lockPath = join(rootDir, "default-skills", ".skill-versions.json");
    const legacyLock = JSON.parse(readFileSync(lockPath, "utf8"));
    legacyLock.schemaVersion = 1;
    legacyLock.skills["example-skill"].contentSha256 = "sha256:legacy-locale-dependent-hash";
    writeFileSync(lockPath, `${JSON.stringify(legacyLock, null, 2)}\n`, "utf8");
    updateDefaultSkillLock({ rootDir });
    validateDefaultSkillLock({ rootDir });

    writeFileSync(join(skillDir, ".env.example"), "IGNORED_VALUE=two\n", "utf8");
    validateDefaultSkillLock({ rootDir });

    const skillPath = join(skillDir, "SKILL.md");
    writeFileSync(skillPath, readFileSync(skillPath, "utf8").replaceAll("\n", "\r\n"), "utf8");
    validateDefaultSkillLock({ rootDir });

    writeSkill(skillDir, "1.0.0", "Changed instructions.");
    assert.throws(
      () => updateDefaultSkillLock({ rootDir }),
      /changed without a version increase \(1\.0\.0 -> 1\.0\.0\)/u,
    );
    assert.throws(() => validateDefaultSkillLock({ rootDir }), /content changed without an updated version lock/u);

    writeSkill(skillDir, "1.0.1", "Changed instructions.");
    updateDefaultSkillLock({ rootDir });
    validateDefaultSkillLock({ rootDir });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("default Skill hashes do not depend on the process locale", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "brevyn-skill-locale-"));
  const skillDir = join(rootDir, "default-skills", "example-skill");
  try {
    mkdirSync(join(skillDir, "templates", "brands", "anthropic"), { recursive: true });
    mkdirSync(join(skillDir, "templates", "brands", "中国电建"), { recursive: true });
    mkdirSync(join(skillDir, "templates", "brands", "中汽研"), { recursive: true });
    writeSkill(skillDir, "1.0.0", "Locale-independent instructions.");
    writeFileSync(join(skillDir, "templates", "brands", "anthropic", "design.md"), "Anthropic\n", "utf8");
    writeFileSync(join(skillDir, "templates", "brands", "中国电建", "设计.md"), "Power China\n", "utf8");
    writeFileSync(join(skillDir, "templates", "brands", "中汽研", "设计.md"), "CATARC\n", "utf8");

    const englishHash = skillHashForLocale(rootDir, "en_US.UTF-8");
    const chineseHash = skillHashForLocale(rootDir, "zh_CN.UTF-8");
    assert.equal(chineseHash, englishHash);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("default Skill archives do not depend on the process locale", () => {
  const rootDir = mkdtempSync(join(tmpdir(), "brevyn-skill-archive-locale-"));
  const skillDir = join(rootDir, "default-skills", "example-skill");
  try {
    mkdirSync(join(skillDir, "templates", "brands", "anthropic"), { recursive: true });
    mkdirSync(join(skillDir, "templates", "brands", "中国电建"), { recursive: true });
    mkdirSync(join(skillDir, "templates", "brands", "中汽研"), { recursive: true });
    writeSkill(skillDir, "1.0.0", "Locale-independent archive instructions.");
    writeFileSync(join(skillDir, "templates", "brands", "anthropic", "design.md"), "Anthropic\n", "utf8");
    writeFileSync(join(skillDir, "templates", "brands", "中国电建", "设计.md"), "Power China\n", "utf8");
    writeFileSync(join(skillDir, "templates", "brands", "中汽研", "设计.md"), "CATARC\n", "utf8");
    updateDefaultSkillLock({ rootDir });

    const englishHash = archiveHashForLocale(rootDir, "en_US.UTF-8");
    const chineseHash = archiveHashForLocale(rootDir, "zh_CN.UTF-8");
    assert.equal(chineseHash, englishHash);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

function writeSkill(skillDir, version, instructions) {
  writeFileSync(join(skillDir, "SKILL.md"), [
    "---",
    "name: example-skill",
    "description: Test fixture.",
    `version: "${version}"`,
    "---",
    "",
    "# Example",
    "",
    instructions,
    "",
  ].join("\n"), "utf8");
}

function skillHashForLocale(rootDir, locale) {
  const source = [
    `import { collectDefaultSkillState } from ${JSON.stringify(lockModuleUrl)};`,
    `process.stdout.write(collectDefaultSkillState(${JSON.stringify(rootDir)}).skills["example-skill"].contentSha256);`,
  ].join("\n");
  return execFileSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    env: { ...process.env, LANG: locale, LC_ALL: locale },
  });
}

function archiveHashForLocale(rootDir, locale) {
  execFileSync(process.execPath, [archiveScriptPath], {
    cwd: rootDir,
    env: { ...process.env, LANG: locale, LC_ALL: locale },
    stdio: "pipe",
  });
  return createHash("sha256")
    .update(readFileSync(join(rootDir, "dist", "default-skills.zip")))
    .digest("hex");
}
