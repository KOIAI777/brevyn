import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("src/native/launch-services-helper.swift");
const output = resolve("dist/native/launch-services-helper");

mkdirSync(dirname(output), { recursive: true });

if (process.platform !== "darwin") {
  process.exit(0);
}

execFileSync("swiftc", [source, "-o", output], { stdio: "inherit" });
