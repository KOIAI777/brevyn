import assert from "node:assert/strict";
import { isFilePathLike } from "./FilePathChip";

const accepted = [
  "index.html",
  "src/App.tsx",
  "./src/App.tsx",
  "Semester shared/index.html",
  "./Week 1/Pathos, Logos, and Ethos.pdf",
  "@assets/report.pdf",
  "/Users/koi/Desktop/projects/uclaw/apps/uclaw-electron/index.html",
];

const rejected = [
  "not a file",
  "Debate Guidelines_EAP III_AY 25-26.pdf",
  "debate rubric 25-26, sem 2-2.pdf",
  "Pathos, Logos, and Ethos.pdf",
  "10 - EAP III Debate Topics AY2025-26 Semester 1.docx",
  "中文 文件（第1周）.pdf",
  "open index.html",
  "code index.html",
  "cat ./src/App.tsx",
  "https://example.com/report.pdf",
  "https://example.com/",
  "report.pdf\nnext line",
  "report.pdf?",
  ".env",
];

for (const value of accepted) {
  assert.equal(isFilePathLike(value), true, `expected file path: ${value}`);
}

for (const value of rejected) {
  assert.equal(isFilePathLike(value), false, `expected non-file path: ${value}`);
}

console.log("FilePathChip tests passed");
