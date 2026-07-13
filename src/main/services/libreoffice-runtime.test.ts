import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import {
  BREVYN_LIBREOFFICE_ARCHIVE_ENV,
  BREVYN_SOFFICE_PATH_ENV,
  inspectLibreOfficeRuntime,
  libreOfficeRuntimeEnvironment,
} from "./libreoffice-runtime";

async function main(): Promise<void> {
  const rootDataDir = mkdtempSync(join(tmpdir(), "brevyn-libreoffice-runtime-"));
  const archiveDir = mkdtempSync(join(tmpdir(), "brevyn-libreoffice-archive-"));
  const previousArchive = process.env[BREVYN_LIBREOFFICE_ARCHIVE_ENV];
  const previousSoffice = process.env[BREVYN_SOFFICE_PATH_ENV];
  try {
    const archivePath = join(archiveDir, `libreoffice-${process.platform}-${process.arch}.zip`);
    const runtimeDir = join(rootDataDir, "runtimes", "libreoffice", `${process.platform}-${process.arch}`, "2");
    const sofficePath = fakeSofficePath(runtimeDir);

    if (process.platform === "win32") {
      writeFileSync(archivePath, "test archive", "utf8");
      mkdirSync(join(sofficePath, ".."), { recursive: true });
      writeFileSync(sofficePath, "", "utf8");
    } else {
      const zip = new AdmZip();
      zip.addFile(fakeSofficeArchivePath(), Buffer.from("#!/bin/sh\necho 'LibreOffice Test 1.0'\n", "utf8"));
      zip.writeZip(archivePath);
    }
    const archiveSha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    writeFileSync(join(archiveDir, "libreoffice-runtime.json"), `${JSON.stringify({
      available: true,
      runtimeVersion: "2",
      platform: process.platform,
      arch: process.arch,
      zipName: `libreoffice-${process.platform}-${process.arch}.zip`,
      archiveSha256,
    })}\n`, "utf8");
    process.env[BREVYN_LIBREOFFICE_ARCHIVE_ENV] = archivePath;
    delete process.env[BREVYN_SOFFICE_PATH_ENV];

    if (process.platform !== "win32") {
      assert.equal(existsSync(sofficePath), false);
      const status = await inspectLibreOfficeRuntime(rootDataDir, { prepare: true });
      assert.equal(status.status, "ready");
      assert.equal(status.source, "bundled");
      assert.match(status.sofficeVersion || "", /LibreOffice Test/u);
      assert.equal(existsSync(sofficePath), true);
      assert.equal(existsSync(join(runtimeDir, ".brevyn-libreoffice-runtime.json")), true);
    } else {
      chmodSync(sofficePath, 0o755);
    }

    const env = libreOfficeRuntimeEnvironment(rootDataDir);
    assert.equal(env[BREVYN_LIBREOFFICE_ARCHIVE_ENV], archivePath);
    assert.equal(env.BREVYN_LIBREOFFICE_ARCHIVE_SHA256, archiveSha256);
    assert.equal(env[BREVYN_SOFFICE_PATH_ENV], sofficePath);
    assert.equal(env.BREVYN_LIBREOFFICE_RUNTIME_DIR, runtimeDir);

    console.log("libreoffice runtime tests passed");
  } finally {
    if (previousArchive === undefined) delete process.env[BREVYN_LIBREOFFICE_ARCHIVE_ENV];
    else process.env[BREVYN_LIBREOFFICE_ARCHIVE_ENV] = previousArchive;
    if (previousSoffice === undefined) delete process.env[BREVYN_SOFFICE_PATH_ENV];
    else process.env[BREVYN_SOFFICE_PATH_ENV] = previousSoffice;
    rmSync(rootDataDir, { recursive: true, force: true });
    rmSync(archiveDir, { recursive: true, force: true });
  }
}

function fakeSofficePath(runtimeDir: string): string {
  if (process.platform === "darwin") return join(runtimeDir, "LibreOffice.app", "Contents", "MacOS", "soffice");
  if (process.platform === "win32") return join(runtimeDir, "LibreOffice", "program", "soffice.com");
  return join(runtimeDir, "libreoffice", "program", "soffice");
}

function fakeSofficeArchivePath(): string {
  if (process.platform === "darwin") return "LibreOffice.app/Contents/MacOS/soffice";
  return "libreoffice/program/soffice";
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
