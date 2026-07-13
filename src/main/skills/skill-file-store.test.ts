import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firstDefaultSkillSourceDir, SkillFileStore } from "./skill-file-store";

const rootPath = mkdtempSync(join(tmpdir(), "brevyn-skill-sync-root-"));
const sourcePath = mkdtempSync(join(tmpdir(), "brevyn-skill-sync-source-"));
const staleSourcePath = mkdtempSync(join(tmpdir(), "brevyn-skill-sync-stale-"));

try {
  writeSkill(join(rootPath, "skills", "xlsx"), "xlsx", "2.2.0", "Old spreadsheet instructions.");
  writeSkill(join(sourcePath, "xlsx"), "xlsx", "2.3.0", "New spreadsheet instructions.");
  writeFile(join(sourcePath, "xlsx", "scripts", "xlsx_audit.py"), "print('audit')\n");
  writeSkill(join(sourcePath, "learning-evidence-reader"), "learning-evidence-reader", "0.2.0", "Read verified evidence.");
  writeFile(join(sourcePath, "_shared", "office", "office_preflight.py"), "print('preflight')\n");
  writeSkill(join(staleSourcePath, "xlsx"), "xlsx", "2.2.0", "Stale spreadsheet instructions.");

  const store = new SkillFileStore(rootPath);
  const selectedSource = firstDefaultSkillSourceDir([join(rootPath, "missing"), sourcePath, staleSourcePath]);
  assert.equal(selectedSource, sourcePath);
  store.syncDefaultSkillFolders(selectedSource!);

  const activeXlsx = readFileSync(join(rootPath, "skills", "xlsx", "SKILL.md"), "utf8");
  assert.match(activeXlsx, /version: "2\.3\.0"/u);
  assert.match(activeXlsx, /New spreadsheet instructions/u);
  assert.ok(existsSync(join(rootPath, "skills", "xlsx", "scripts", "xlsx_audit.py")));
  assert.ok(existsSync(join(rootPath, "skills", "learning-evidence-reader", "SKILL.md")));
  assert.ok(existsSync(join(rootPath, "skills", "_shared", "office", "office_preflight.py")));
  assert.ok(existsSync(join(rootPath, "default-skills", "_shared", "office", "office_preflight.py")));

  writeSkill(join(sourcePath, "xlsx"), "xlsx", "2.3.0", "Unversioned follow-up change.");
  store.syncDefaultSkillFolders(sourcePath);
  assert.match(readFileSync(join(rootPath, "skills", "xlsx", "SKILL.md"), "utf8"), /New spreadsheet instructions/u);

  console.log("skill file store tests passed");
} finally {
  rmSync(rootPath, { recursive: true, force: true });
  rmSync(sourcePath, { recursive: true, force: true });
  rmSync(staleSourcePath, { recursive: true, force: true });
}

function writeSkill(directory: string, name: string, version: string, instructions: string): void {
  writeFile(join(directory, "SKILL.md"), [
    "---",
    `name: ${name}`,
    "description: Test fixture.",
    `version: "${version}"`,
    "---",
    "",
    `# ${name}`,
    "",
    instructions,
    "",
  ].join("\n"));
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf8");
}
