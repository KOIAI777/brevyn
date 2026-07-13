import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import AdmZip from "adm-zip";
import { compareDefaultSkillNames, isDefaultSkillIgnoredName, validateDefaultSkillLock } from "./default-skill-lock.mjs";

const sourceDir = join(process.cwd(), "default-skills");
const outputDir = join(process.cwd(), "dist");
const outputPath = join(outputDir, "default-skills.zip");

if (!existsSync(sourceDir)) {
  console.error(`Default skills directory not found: ${sourceDir}`);
  process.exit(1);
}

validateDefaultSkillLock();

mkdirSync(outputDir, { recursive: true });
rmSync(join(outputDir, "default-skills"), { recursive: true, force: true });
rmSync(outputPath, { force: true });

const zip = new AdmZip(undefined, { noSort: true });
const files = collectFiles(sourceDir);
for (const filePath of files) {
  const entryName = relative(sourceDir, filePath).split(sep).join("/");
  zip.addLocalFile(filePath, dirnameForZipEntry(entryName));
}

zip.writeZip(outputPath);
const sizeMb = (statSync(outputPath).size / (1024 * 1024)).toFixed(1);
console.log(`Built ${relative(process.cwd(), outputPath)} from ${files.length} files (${sizeMb}MB).`);

function collectFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !isDefaultSkillIgnoredName(entry.name))
    .sort((a, b) => compareDefaultSkillNames(a.name, b.name));

  const files = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path));
      continue;
    }
    if (entry.isFile()) files.push(path);
  }
  return files;
}

function dirnameForZipEntry(entryName) {
  const base = basename(entryName);
  return entryName.slice(0, entryName.length - base.length).replace(/\/$/, "");
}
