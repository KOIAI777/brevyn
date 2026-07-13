import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const pdfPackageDir = dirname(require.resolve("pdfjs-dist/package.json"));
const outputDir = join(process.cwd(), "dist", "pdfjs");

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

copyFileSync(require.resolve("pdfjs-dist/build/pdf.min.mjs"), join(outputDir, "pdf.min.mjs"));
copyFileSync(require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"), join(outputDir, "pdf.worker.min.mjs"));

const standardFontsDir = join(pdfPackageDir, "standard_fonts");
if (existsSync(standardFontsDir)) {
  cpSync(standardFontsDir, join(outputDir, "standard_fonts"), { recursive: true });
}
