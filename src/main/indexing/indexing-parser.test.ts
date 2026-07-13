import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { IndexingTaskRecord, IndexingWorkerResult } from "./indexing-types";
import type { WorkspaceFileKind } from "../../types/domain";

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "brevyn-indexing-parser-"));
  const fixtures = await createFixtures(dir);
  for (const fixture of fixtures) {
    const result = await runWorker(fixture.path, fixture.kind);
    assert.ok(result.chunkCount > 0, `${fixture.name} should produce chunks`);
    assert.equal(result.chunks.length, result.chunkCount, `${fixture.name} chunk count should match`);
    assert.equal(result.chunkMetadata?.length, result.chunkCount, `${fixture.name} metadata should align`);
    assert.equal(result.metadata?.parser, fixture.parser, `${fixture.name} parser mismatch`);
    assert.ok(result.metadata?.coverageStatus === "complete" || result.metadata?.coverageStatus === "partial", `${fixture.name} should report coverage`);
    assert.match(result.sample, fixture.sample, `${fixture.name} sample should include extracted text`);
    assert.ok(result.chunkMetadata?.some((metadata) => metadata.sourceLabel), `${fixture.name} should include section labels`);
    if (fixture.name === "csv" || fixture.name === "tsv") {
      assert.equal(typeof result.officeArtifact, "object", `${fixture.name} should include an office artifact`);
      const artifact = result.officeArtifact as {
        id?: string;
        kind?: string;
        workbook?: { sheets?: Array<{ name?: string; usedRange?: string; render?: { kind?: string; data?: string; targets?: Array<{ type?: string; location?: { range?: string } }> }; tables?: Array<{ name?: string; ref?: string; columns?: string[] }> }> };
        semanticUnits?: Array<{ unitType?: string; title?: string; location?: { sheet?: string; range?: string }; citation?: string }>;
      };
      const sheetName = fixture.name === "tsv" ? "TSV" : "CSV";
      assert.equal(artifact.kind, "csv", `${fixture.name} artifact should use csv office kind`);
      assert.equal(artifact.workbook?.sheets?.[0]?.name, sheetName, `${fixture.name} artifact should expose a single sheet`);
      assert.equal(artifact.workbook?.sheets?.[0]?.usedRange, "A1:B3", `${fixture.name} artifact should include used range`);
      assert.equal(artifact.workbook?.sheets?.[0]?.tables?.[0]?.ref, "A1:B3", `${fixture.name} artifact should expose a table range`);
      assert.equal(artifact.workbook?.sheets?.[0]?.render?.kind, "html", `${fixture.name} sheet should use the HTML workbook renderer`);
      assert.match(artifact.workbook?.sheets?.[0]?.render?.data || "", /brevyn-sheet-surface/, `${fixture.name} sheet should include an engine-rendered surface`);
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "table" && unit.location?.range === "A1:B3"), `${fixture.name} should include table-level semantic units`);
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.artifactId === artifact.id && metadata.sheet === sheetName && metadata.range === "A1:B3"), `${fixture.name} chunks should carry artifact/range metadata`);
    } else if (fixture.name === "xlsx") {
      assert.equal(typeof result.officeArtifact, "object", "xlsx should include an office artifact");
      const artifact = result.officeArtifact as {
        id?: string;
        workbook?: { sheets?: Array<{ name?: string; usedRange?: string; columns?: Array<{ widthPx?: number }>; rows?: Array<{ heightPx?: number; cells?: Array<{ text?: string; style?: { bold?: boolean; fillColor?: string; borderBottom?: boolean }; hyperlink?: { target?: string }; commentIds?: string[] }> }>; mergedCells?: Array<{ ref?: string }>; freezePanes?: { frozenRows?: number; frozenColumns?: number }; render?: { kind?: string; data?: string; engine?: string; targets?: Array<{ type?: string; location?: { range?: string; row?: number; column?: number }; metadata?: { rowNumber?: number; columnNumber?: number } }> }; charts?: Array<{ title?: string; type?: string; anchor?: { widthPx?: number; heightPx?: number }; series?: Array<{ values?: number[] }>; render?: { kind?: string; data?: string; engine?: string } }>; hyperlinks?: Array<{ ref?: string; target?: string }>; comments?: Array<{ ref?: string; author?: string; text?: string }>; tables?: Array<{ name?: string; ref?: string; columns?: string[] }>; namedRanges?: Array<{ name?: string; ref?: string }> }> };
        semanticUnits?: Array<{ id?: string; unitType?: string; title?: string; elementIds?: string[]; location?: { sheet?: string; range?: string }; citation?: string }>;
      };
      assert.ok(artifact.id?.startsWith("artifact-"), "xlsx artifact should have a stable artifact id");
      assert.equal(artifact.workbook?.sheets?.[0]?.name, "Rubric", "xlsx artifact should include workbook sheets");
      assert.equal(artifact.workbook?.sheets?.[0]?.usedRange, "A1:B3", "xlsx artifact should include used range");
      assert.ok((artifact.workbook?.sheets?.[0]?.columns?.[0]?.widthPx || 0) > 100, "xlsx artifact should include column widths");
      assert.equal(artifact.workbook?.sheets?.[0]?.freezePanes?.frozenRows, 1, "xlsx artifact should include freeze panes");
      assert.equal(artifact.workbook?.sheets?.[0]?.mergedCells?.[0]?.ref, "A1:B1", "xlsx artifact should include merged cells");
      assert.equal(artifact.workbook?.sheets?.[0]?.rows?.[0]?.cells?.[0]?.style?.bold, true, "xlsx artifact should include cell font styles");
      assert.equal(artifact.workbook?.sheets?.[0]?.rows?.[1]?.cells?.[1]?.text, "40%", "xlsx artifact should format percentage cells");
      assert.equal(artifact.workbook?.sheets?.[0]?.rows?.[1]?.cells?.[1]?.style?.borderBottom, true, "xlsx artifact should include border styles");
      assert.equal(artifact.workbook?.sheets?.[0]?.rows?.[1]?.cells?.[0]?.hyperlink?.target, "https://example.com/rubric", "xlsx artifact should attach cell hyperlinks");
      assert.ok((artifact.workbook?.sheets?.[0]?.rows?.[1]?.cells?.[0]?.commentIds || []).length > 0, "xlsx artifact should attach cell comment ids");
      assert.equal(artifact.workbook?.sheets?.[0]?.render?.kind, "html", "xlsx sheet should use the HTML workbook renderer");
      assert.match(artifact.workbook?.sheets?.[0]?.render?.data || "", /brevyn-sheet-surface/, "xlsx sheet should include an engine-rendered surface");
      assert.ok(artifact.workbook?.sheets?.[0]?.render?.targets?.some((target) => target.type === "cell" && target.location?.range === "A2" && target.location.row === 2 && target.metadata?.rowNumber === 2), "xlsx sheet surface should include selectable cell targets");
      assert.equal(artifact.workbook?.sheets?.[0]?.charts?.[0]?.title, "Rubric Weights", "xlsx artifact should include chart objects");
      assert.equal(artifact.workbook?.sheets?.[0]?.charts?.[0]?.type, "bar", "xlsx chart should include chart type");
      assert.ok((artifact.workbook?.sheets?.[0]?.charts?.[0]?.anchor?.widthPx || 0) > 300, "xlsx chart should include drawing dimensions");
      assert.deepEqual(artifact.workbook?.sheets?.[0]?.charts?.[0]?.series?.[0]?.values, [40, 60], "xlsx chart should include cached chart values");
      assert.equal(artifact.workbook?.sheets?.[0]?.charts?.[0]?.render?.kind, "html", "xlsx chart should use the HTML chart renderer");
      assert.match(artifact.workbook?.sheets?.[0]?.charts?.[0]?.render?.data || "", /brevyn-chart/, "xlsx chart should include an engine-rendered surface");
      assert.equal(artifact.workbook?.sheets?.[0]?.hyperlinks?.[0]?.target, "https://example.com/rubric", "xlsx artifact should include hyperlink objects");
      assert.equal(artifact.workbook?.sheets?.[0]?.comments?.[0]?.text, "Explain rubric weighting", "xlsx artifact should include comment objects");
      assert.equal(artifact.workbook?.sheets?.[0]?.tables?.[0]?.name, "RubricTable", "xlsx artifact should include table objects");
      assert.equal(artifact.workbook?.sheets?.[0]?.tables?.[0]?.ref, "A1:B3", "xlsx table should include range");
      assert.equal(artifact.workbook?.sheets?.[0]?.namedRanges?.[0]?.name, "WeightRange", "xlsx artifact should include named ranges");
      assert.equal(artifact.semanticUnits?.[0]?.location?.range, "A1:B3", "xlsx semantic unit should include range");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "table" && unit.title === "RubricTable" && unit.location?.range === "A1:B3"), "xlsx artifact should include table-level semantic units");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "chart" && unit.title === "Rubric Weights" && unit.elementIds?.some((id) => id.includes("chart-1"))), "xlsx artifact should include chart semantic units with object ids");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "comment" && unit.location?.range === "A2"), "xlsx artifact should include comment semantic units");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "hyperlink" && unit.location?.range === "A2"), "xlsx artifact should include hyperlink semantic units");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "named_range" && unit.title === "WeightRange"), "xlsx artifact should include named-range semantic units");
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.artifactId === artifact.id && metadata.sheet === "Rubric" && metadata.range === "A1:B3"), "xlsx chunks should carry artifact/range metadata");
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.semanticUnitId?.includes("unit-table") && metadata.range === "A1:B3"), "xlsx chunks should carry table semantic-unit metadata");
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.sectionType === "chart" && metadata.elementIds?.some((id) => id.includes("chart-1"))), "xlsx chunks should carry chart object ids");
    } else if (fixture.name === "docx") {
      assert.equal(typeof result.officeArtifact, "object", "docx should include an office artifact");
      const artifact = result.officeArtifact as {
        id?: string;
        kind?: string;
        document?: { headingCount?: number; tableCount?: number; commentCount?: number; paragraphCount?: number; footnoteCount?: number; endnoteCount?: number; trackedChangeCount?: number };
        elements?: Array<{ type?: string; text?: string; assetRefs?: string[]; location?: { range?: string }; relationships?: Array<{ type?: string; target?: string }> }>;
        semanticUnits?: Array<{ unitType?: string; title?: string; sourceLabel?: string; citation?: string; location?: { range?: string } }>;
      };
      assert.ok(artifact.id?.startsWith("artifact-"), "docx artifact should have a stable artifact id");
      assert.equal(artifact.kind, "docx", "docx artifact kind mismatch");
      assert.equal(artifact.document?.headingCount, 1, "docx artifact should count headings");
      assert.equal(artifact.document?.tableCount, 1, "docx artifact should count tables");
      assert.equal(artifact.document?.commentCount, 1, "docx artifact should count comments");
      assert.equal(artifact.document?.footnoteCount, 1, "docx artifact should count footnotes");
      assert.equal(artifact.document?.endnoteCount, 1, "docx artifact should count endnotes");
      assert.equal(artifact.document?.trackedChangeCount, 2, "docx artifact should count tracked changes");
      assert.ok(artifact.elements?.some((element) => element.type === "heading" && element.text === "Debate Brief"), "docx artifact should expose heading elements");
      assert.ok(artifact.elements?.some((element) => element.type === "table_cell" && element.location?.range === "B2" && element.text === "40%"), "docx artifact should expose table cells for spreadsheet reuse");
      assert.ok(artifact.elements?.some((element) => element.type === "image_caption" && element.text?.includes("Figure 1") && (element.assetRefs || []).length > 0), "docx artifact should connect image captions to image assets");
      assert.ok(artifact.elements?.some((element) => element.type === "tracked_change" && element.text === "stronger"), "docx artifact should expose inserted tracked changes");
      assert.ok(artifact.elements?.some((element) => element.type === "tracked_change" && element.text === "weak"), "docx artifact should expose deleted tracked changes");
      assert.ok(artifact.elements?.some((element) => element.relationships?.some((relationship) => relationship.type === "hyperlink" && relationship.target === "https://example.com/evidence")), "docx artifact should expose hyperlink relationships");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "document_section" && unit.title === "Debate Brief"), "docx artifact should expose document-section semantic units");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "table" && unit.location?.range === "A1:B2"), "docx artifact should expose table semantic units with a reusable range");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "comment"), "docx artifact should expose comment semantic units");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "footnote"), "docx artifact should expose footnote semantic units");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "endnote"), "docx artifact should expose endnote semantic units");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "image_caption"), "docx artifact should expose image caption semantic units");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "tracked_change"), "docx artifact should expose tracked-change semantic units");
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.artifactId === artifact.id && metadata.semanticUnitId?.includes("unit-section")), "docx chunks should carry document-section semantic-unit metadata");
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.sectionType === "table" && metadata.semanticUnitId?.includes("unit-table")), "docx chunks should carry table semantic-unit metadata");
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.sectionType === "comment" && metadata.semanticUnitId?.includes("unit-comment")), "docx chunks should carry comment semantic-unit metadata");
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.sectionType === "footnote"), "docx chunks should carry footnote semantic-unit metadata");
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.sectionType === "endnote"), "docx chunks should carry endnote semantic-unit metadata");
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.sectionType === "tracked_change"), "docx chunks should carry tracked-change semantic-unit metadata");
    } else if (fixture.name === "pptx") {
      assert.equal(typeof result.officeArtifact, "object", "pptx should include an office artifact");
      const artifact = result.officeArtifact as {
        id?: string;
        kind?: string;
        presentation?: { slideCount?: number };
        elements?: Array<{ type?: string; text?: string; location?: { slide?: number } }>;
        semanticUnits?: Array<{ unitType?: string; title?: string; sourceLabel?: string; citation?: string; location?: { slide?: number } }>;
      };
      assert.ok(artifact.id?.startsWith("artifact-"), "pptx artifact should have a stable artifact id");
      assert.equal(artifact.kind, "pptx", "pptx artifact kind mismatch");
      assert.equal(artifact.presentation?.slideCount, 2, "pptx artifact should include slide count");
      assert.ok(artifact.elements?.some((element) => element.type === "page" && element.location?.slide === 1 && element.text?.includes("Debate Slide")), "pptx artifact should use presentation order for slide locations");
      assert.ok(artifact.elements?.some((element) => element.type === "page" && element.location?.slide === 2 && element.text?.includes("Physical first slide")), "pptx artifact should not use physical part numbers as slide locations");
      assert.ok(artifact.elements?.some((element) => element.type === "speaker_note" && element.location?.slide === 1 && element.text?.includes("Speaker notes")), "pptx artifact should expose speaker notes");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "slide" && unit.location?.slide === 1), "pptx artifact should expose slide semantic units");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "speaker_notes" && unit.location?.slide === 1), "pptx artifact should expose speaker-note semantic units");
      assert.ok(result.chunks.some((chunk, index) => chunk.includes("Debate Slide") && result.chunkMetadata?.[index]?.slide === 1), "pptx chunks should carry presentation-order slide metadata");
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.sectionType === "speaker_notes" && metadata.slide === 1), "pptx chunks should carry speaker-note metadata");
    } else if (fixture.name === "pdf") {
      assert.equal(typeof result.officeArtifact, "object", "pdf should include an office artifact");
      const artifact = result.officeArtifact as {
        id?: string;
        kind?: string;
        pdf?: { pageCount?: number };
        elements?: Array<{ type?: string; location?: { page?: number } }>;
        semanticUnits?: Array<{ id?: string; unitType?: string; sourceLabel?: string; location?: { page?: number } }>;
      };
      assert.ok(artifact.id?.startsWith("artifact-"), "pdf artifact should have a stable artifact id");
      assert.equal(artifact.kind, "pdf", "pdf artifact kind mismatch");
      assert.equal(artifact.pdf?.pageCount, 1, "pdf artifact should include page count");
      assert.ok(artifact.elements?.some((element) => element.type === "page" && element.location?.page === 1), "pdf artifact should expose page elements");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "document_section" && unit.location?.page === 1), "pdf artifact should expose heading semantic units");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "paragraph" && unit.location?.page === 1), "pdf artifact should expose paragraph semantic units");
      assert.ok(artifact.semanticUnits?.some((unit) => unit.unitType === "table" && unit.location?.page === 1), "pdf artifact should expose table-like semantic units");
      assert.ok(result.chunkMetadata?.some((metadata) => metadata.artifactId === artifact.id && metadata.semanticUnitId?.includes("region") && metadata.page === 1), "pdf chunks should carry region semantic-unit metadata");
    }
  }
  const brokenDocxPath = join(dir, "broken.docx");
  writeFileSync(brokenDocxPath, "not a zip", "utf8");
  const brokenDocxResult = await runWorker(brokenDocxPath, "docx");
  assert.equal(brokenDocxResult.chunkCount, 0, "broken docx should return an empty parse result instead of failing the worker");
  assert.ok(brokenDocxResult.warnings.some((warning) => warning.includes("DOCX local extraction failed")), "broken docx should explain the local extraction failure");
  console.log("indexing parser tests passed");
}

async function createFixtures(dir: string): Promise<Array<{ name: string; path: string; kind: WorkspaceFileKind; parser: string; sample: RegExp }>> {
  const textPath = join(dir, "notes.txt");
  writeFileSync(textPath, "Week 1\nDebate topic and rubric notes.", "utf8");
  const csvPath = join(dir, "rubric.csv");
  writeFileSync(csvPath, "Criterion,Weight\nArgument clarity,40%\nEvidence,60%\n", "utf8");
  const tsvPath = join(dir, "schedule.tsv");
  writeFileSync(tsvPath, "Week\tTopic\n1\tDebate prep\n2\tFinal speech\n", "utf8");
  const xlsxPath = join(dir, "rubric.xlsx");
  await writeXlsxFixture(xlsxPath);
  const docxPath = join(dir, "brief.docx");
  await writeDocxFixture(docxPath);
  const pptxPath = join(dir, "slides.pptx");
  await writePptxFixture(pptxPath);
  const pdfPath = join(dir, "handout.pdf");
  await writePdfFixture(pdfPath);
  return [
    { name: "text", path: textPath, kind: "text", parser: "plain-text", sample: /Debate topic/ },
    { name: "csv", path: csvPath, kind: "spreadsheet", parser: "csv-text", sample: /Argument clarity/ },
    { name: "tsv", path: tsvPath, kind: "spreadsheet", parser: "tsv-text", sample: /Debate prep/ },
    { name: "xlsx", path: xlsxPath, kind: "spreadsheet", parser: "xlsx-ooxml", sample: /Argument clarity/ },
    { name: "docx", path: docxPath, kind: "docx", parser: "docx-ooxml", sample: /Debate Brief/ },
    { name: "pptx", path: pptxPath, kind: "pptx", parser: "pptx-jszip", sample: /Debate Slide/ },
    { name: "pdf", path: pdfPath, kind: "pdf", parser: "pdfjs-dist", sample: /Debate PDF/ },
  ];
}

function runWorker(sourcePath: string, kind: WorkspaceFileKind): Promise<IndexingWorkerResult> {
  return new Promise((resolveResult, reject) => {
    const task: IndexingTaskRecord = {
      id: `task-${basename(sourcePath)}`,
      jobId: "job",
      courseId: "course",
      fileId: `file-${basename(sourcePath)}`,
      kind: "parse_chunk",
      status: "queued",
      attempts: 0,
      maxAttempts: 1,
      nextRunAt: new Date().toISOString(),
      progress: 0,
      payload: {
        fileId: `file-${basename(sourcePath)}`,
        courseId: "course",
        name: basename(sourcePath),
        path: basename(sourcePath),
        sourcePath,
        kind,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const worker = new Worker(resolve("dist/indexing-worker.cjs"), { workerData: task });
    worker.on("message", (message: { ok: true; result: IndexingWorkerResult } | { ok: false; error: string }) => {
      if (message.ok) resolveResult(message.result);
      else reject(new Error(message.error));
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) reject(new Error(`indexing worker exited with ${code}`));
    });
  });
}

async function writeXlsxFixture(path: string): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/><Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/><Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Rubric" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="WeightRange">Rubric!$B$2:$B$3</definedName></definedNames></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`);
  zip.file("xl/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><color rgb="FF111827"/></font><font><b/><sz val="12"/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2563EB"/></patternFill></fill></fills><borders count="2"><border/><border><bottom style="thin"><color rgb="FF94A3B8"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="9" fontId="0" fillId="0" borderId="1" applyBorder="1"/></cellXfs></styleSheet>`);
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="6" uniqueCount="6"><si><t>Criterion</t></si><si><t>Weight</t></si><si><t>Argument clarity</t></si><si><t>40%</t></si><si><t>Evidence</t></si><si><t>60%</t></si></sst>`);
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="12" customWidth="1"/></cols><sheetData><row r="1" ht="24" customHeight="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1" t="s" s="1"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="2"><v>0.4</v></c></row><row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" s="2"><v>0.6</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><hyperlinks><hyperlink ref="A2" r:id="rId2" tooltip="Rubric reference"/></hyperlinks><tableParts count="1"><tablePart r:id="rId4"/></tableParts><drawing r:id="rId1"/></worksheet>`);
  zip.file("xl/worksheets/_rels/sheet1.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/rubric" TargetMode="External"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>`);
  zip.file("xl/comments1.xml", `<?xml version="1.0" encoding="UTF-8"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Koi</author></authors><commentList><comment ref="A2" authorId="0"><text><r><t>Explain rubric weighting</t></r></text></comment></commentList></comments>`);
  zip.file("xl/tables/table1.xml", `<?xml version="1.0" encoding="UTF-8"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="RubricTable" displayName="RubricTable" ref="A1:B3" totalsRowShown="0"><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="Criterion"/><tableColumn id="2" name="Weight"/></tableColumns></table>`);
  zip.file("xl/drawings/drawing1.xml", `<?xml version="1.0" encoding="UTF-8"?><wsDr xmlns="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><oneCellAnchor><from><col>3</col><row>1</row></from><ext cx="4000000" cy="2400000"/><graphicFrame><nvGraphicFramePr><cNvPr id="1" name="Chart 1"/></nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></graphicFrame><clientData/></oneCellAnchor></wsDr>`);
  zip.file("xl/drawings/_rels/drawing1.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>`);
  zip.file("xl/charts/chart1.xml", `<?xml version="1.0" encoding="UTF-8"?><chartSpace xmlns="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><chart><title><tx><rich><a:p><a:r><a:t>Rubric Weights</a:t></a:r></a:p></rich></tx></title><plotArea><barChart><barDir val="col"/><ser><idx val="0"/><order val="0"/><tx><strRef><f>Rubric!$B$1</f><strCache><pt idx="0"><v>Weight</v></pt></strCache></strRef></tx><cat><strRef><f>Rubric!$A$2:$A$3</f><strCache><pt idx="0"><v>Argument clarity</v></pt><pt idx="1"><v>Evidence</v></pt></strCache></strRef></cat><val><numRef><f>Rubric!$B$2:$B$3</f><numCache><pt idx="0"><v>40</v></pt><pt idx="1"><v>60</v></pt></numCache></numRef></val></ser></barChart></plotArea></chart></chartSpace>`);
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writeDocxFixture(path: string): Promise<void> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/></Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/evidence" TargetMode="External"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" Target="endnotes.xml"/></Relationships>`);
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style></w:styles>`);
  zip.file("word/comments.xml", `<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Koi" w:date="2026-07-09T00:00:00Z"><w:p><w:r><w:t>Clarify the evidence source.</w:t></w:r></w:p></w:comment></w:comments>`);
  zip.file("word/footnotes.xml", `<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:footnote w:id="-1"/><w:footnote w:id="1"><w:p><w:r><w:t>Evidence source footnote.</w:t></w:r></w:p></w:footnote></w:footnotes>`);
  zip.file("word/endnotes.xml", `<?xml version="1.0" encoding="UTF-8"?><w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:endnote w:id="-1"/><w:endnote w:id="2"><w:p><w:r><w:t>Appendix endnote detail.</w:t></w:r></w:p></w:endnote></w:endnotes>`);
  zip.file("word/media/image1.png", Buffer.from("iVBORw0KGgo=", "base64"));
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Debate Brief</w:t></w:r></w:p><w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Argument clarity and evidence matter.</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r><w:r><w:endnoteReference w:id="2"/></w:r><w:commentRangeEnd w:id="0"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r></w:p><w:p><w:hyperlink r:id="rId2"><w:r><w:t>Evidence checklist</w:t></w:r></w:hyperlink></w:p><w:p><w:r><w:drawing><a:blip r:embed="rId3"/></w:drawing></w:r></w:p><w:p><w:r><w:t>Figure 1. Debate evidence workflow.</w:t></w:r></w:p><w:p><w:r><w:t>This claim is </w:t></w:r><w:del w:id="7" w:author="Koi" w:date="2026-07-09T00:00:00Z"><w:r><w:delText>weak</w:delText></w:r></w:del><w:ins w:id="8" w:author="Koi" w:date="2026-07-09T00:00:00Z"><w:r><w:t>stronger</w:t></w:r></w:ins><w:r><w:t>.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Criterion</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Weight</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Argument</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>40%</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`);
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writePptxFixture(path: string): Promise<void> {
  const zip = new JSZip();
  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`);
  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`);
  zip.file("ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Physical first slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  zip.file("ppt/slides/slide2.xml", `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Debate Slide</a:t></a:r></a:p><a:p><a:r><a:t>Evidence summary</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  zip.file("ppt/slides/_rels/slide2.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`);
  zip.file("ppt/notesSlides/notesSlide1.xml", `<?xml version="1.0" encoding="UTF-8"?><p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Speaker notes for debate slide.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`);
  writeFileSync(path, await zip.generateAsync({ type: "nodebuffer" }));
}

async function writePdfFixture(path: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([420, 320]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Debate PDF handout", { x: 40, y: 260, size: 18, font });
  page.drawText("Use evidence and rebuttal.", { x: 40, y: 228, size: 12, font });
  page.drawText("Criterion", { x: 40, y: 172, size: 11, font });
  page.drawText("Weight", { x: 170, y: 172, size: 11, font });
  page.drawText("Argument clarity", { x: 40, y: 148, size: 11, font });
  page.drawText("40%", { x: 170, y: 148, size: 11, font });
  page.drawText("Evidence", { x: 40, y: 124, size: 11, font });
  page.drawText("60%", { x: 170, y: 124, size: 11, font });
  writeFileSync(path, await pdf.save());
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
