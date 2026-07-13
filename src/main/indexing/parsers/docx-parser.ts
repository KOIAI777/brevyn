import { readFileSync } from "node:fs";
import { extname } from "node:path";
import JSZip from "jszip";
import type { CoverageStatus, ParsedIndexingFile, ParsedIndexingSection, ParseInput } from "./types";
import { embeddedMediaFiles, mediaAssetFromPath } from "./ooxml-assets";
import { importDocxArtifact } from "../../office-importers/docx-importer";
import type { BrevynOfficeArtifact } from "../../office-model/schema";
import { officeArtifactMarkdown } from "../../office-model/semantic-units";
import { capParsedText, decodeXml, dedupeWarnings, emptyParsedFile, normalizeText } from "./utils";

export async function parseDocx(input: ParseInput, byteCount: number): Promise<ParsedIndexingFile> {
  if (extname(input.sourcePath).toLowerCase() === ".doc") {
    return emptyParsedFile(input, byteCount, "Legacy .doc files need conversion to .docx before local text extraction.");
  }

  const artifact = await importDocxArtifact({
    sourcePath: input.sourcePath,
    byteCount,
  });

  const zip = await JSZip.loadAsync(readFileSync(input.sourcePath));
  const documentFile = zip.file("word/document.xml");
  if (!documentFile) {
    return emptyParsedFile(input, byteCount, "DOCX document.xml was not found. The file may be damaged or unsupported.");
  }

  const shared = await loadDocxSharedResources(zip);
  const documentXml = await documentFile.async("string");
  const documentSections = parseDocxDocumentXml(documentXml, shared);
  const noteSections = await parseDocxNoteSections(zip, shared);
  const headerFooterSections = await parseDocxHeaderFooterSections(zip, shared);
  const mediaFiles = embeddedMediaFiles(zip, "word");
  const sections = [...documentSections, ...noteSections, ...headerFooterSections];
  const indexedSections = sections.filter((section) => section.text);
  const emptySections = sections.length - indexedSections.length;
  const warnings: string[] = [];
  if (indexedSections.length === 0) {
    warnings.push("No extractable DOCX text was found. The document may contain only images or unsupported embedded objects.");
  }
  const imageOnlyDocument = indexedSections.length === 0 && mediaFiles.length > 0;
  if (imageOnlyDocument) {
    warnings.push(`${mediaFiles.length} embedded DOCX images were detected and need OCR/document parsing before they can be indexed.`);
  }
  warnings.push(...(artifact.metadata.warnings || []));
  const text = officeArtifactMarkdown(artifact) || indexedSections.map((section) => formatDocxSection(section)).join("\n\n");
  const capped = capParsedText(text, warnings);
  const normalized = normalizeText(capped.text);
  const artifactSections = sectionsFromDocxArtifact(artifact);
  const parsedSections = artifactSections.length > 0
    ? artifactSections
    : indexedSections.map((section): ParsedIndexingSection => ({
      text: formatDocxSection(section),
      sourceLabel: docxSourceLabel(section),
      title: section.type === "heading" ? section.text : undefined,
      sectionType: section.type,
      sectionIndex: section.index,
    })).filter((section) => section.text);
  const coverageStatus: CoverageStatus = !normalized
    ? "skipped"
    : capped.truncated
      ? "partial"
      : "complete";
  return {
    text: normalized,
    byteCount,
    warnings: dedupeWarnings(warnings),
    metadata: {
      parser: "docx-ooxml",
      officeParser: String(artifact.metadata.parser || ""),
      artifactId: artifact.id,
      artifactSchemaVersion: artifact.schemaVersion,
      kind: input.kind,
      sectionsTotal: artifact.semanticUnits.length || indexedSections.length,
      sectionsIndexed: parsedSections.length,
      sectionsEmpty: emptySections,
      sectionsFailed: 0,
      sectionUnit: artifactSections.length > 0 ? "个语义单元" : "个段落",
      headings: Number(artifact.metadata.headings || 0) || indexedSections.filter((section) => section.type === "heading").length,
      tables: Number(artifact.metadata.tables || 0) || indexedSections.filter((section) => section.type === "table").length,
      lists: indexedSections.filter((section) => section.type === "list").length,
      comments: Number(artifact.metadata.comments || 0),
      footnotes: Number(artifact.metadata.footnotes || 0) || noteSections.filter((section) => section.text).length,
      endnotes: Number(artifact.metadata.endnotes || 0),
      imageCaptions: Number(artifact.metadata.imageCaptions || 0),
      trackedChanges: Number(artifact.metadata.trackedChanges || 0),
      headersFooters: headerFooterSections.filter((section) => section.text).length,
      embeddedImages: mediaFiles.length,
      assetsNeedingOcr: imageOnlyDocument ? mediaFiles.length : 0,
      coverageStatus,
      truncated: capped.truncated,
    },
    assets: mediaFiles.map((path, index) => mediaAssetFromPath({
      path,
      sourceLabel: `DOCX 内嵌图片 ${index + 1}`,
      needsOcr: imageOnlyDocument,
      reason: imageOnlyDocument ? "docx_image_only_document" : undefined,
    })),
    sections: parsedSections.length > 0 ? parsedSections : undefined,
    officeArtifact: artifact,
  };
}

function sectionsFromDocxArtifact(artifact: BrevynOfficeArtifact): ParsedIndexingSection[] {
  return artifact.semanticUnits.map((unit, index) => ({
    text: unit.markdown || unit.text,
    sourceLabel: unit.sourceLabel,
    title: unit.title,
    sectionType: unit.unitType,
    sectionIndex: index + 1,
    artifactId: artifact.id,
    semanticUnitId: unit.id,
    elementIds: unit.elementIds,
    bbox: unit.bbox ? JSON.stringify(unit.bbox) : undefined,
  }));
}

interface DocxSharedResources {
  paragraphStyles: Map<string, string>;
  numberingLevels: Map<string, string>;
}

interface DocxSection {
  type: "heading" | "paragraph" | "list" | "table" | "footnote" | "header" | "footer";
  index: number;
  level?: number;
  text: string;
}

async function loadDocxSharedResources(zip: JSZip): Promise<DocxSharedResources> {
  const stylesXml = await zip.file("word/styles.xml")?.async("string").catch(() => undefined);
  const numberingXml = await zip.file("word/numbering.xml")?.async("string").catch(() => undefined);
  return {
    paragraphStyles: stylesXml ? parseDocxParagraphStyles(stylesXml) : new Map(),
    numberingLevels: numberingXml ? parseDocxNumberingLevels(numberingXml) : new Map(),
  };
}

function parseDocxParagraphStyles(xml: string): Map<string, string> {
  const styles = new Map<string, string>();
  const stylePattern = /<w:style\b(?=[^>]*\bw:type="paragraph")[^>]*\bw:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
  for (const match of xml.matchAll(stylePattern)) {
    const styleId = decodeXml(match[1] || "");
    const body = match[2] || "";
    const name = body.match(/<w:name\b[^>]*\bw:val="([^"]+)"/)?.[1] || styleId;
    styles.set(styleId, decodeXml(name));
  }
  return styles;
}

function parseDocxNumberingLevels(xml: string): Map<string, string> {
  const abstractByNumberingId = new Map<string, string>();
  const numberingPattern = /<w:num\b[^>]*\bw:numId="([^"]+)"[^>]*>([\s\S]*?)<\/w:num>/g;
  for (const match of xml.matchAll(numberingPattern)) {
    const abstractId = (match[2] || "").match(/<w:abstractNumId\b[^>]*\bw:val="([^"]+)"/)?.[1];
    if (abstractId) abstractByNumberingId.set(match[1] || "", abstractId);
  }

  const formatByAbstractLevel = new Map<string, string>();
  const abstractPattern = /<w:abstractNum\b[^>]*\bw:abstractNumId="([^"]+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g;
  for (const abstractMatch of xml.matchAll(abstractPattern)) {
    const abstractId = abstractMatch[1] || "";
    const abstractBody = abstractMatch[2] || "";
    const levelPattern = /<w:lvl\b[^>]*\bw:ilvl="([^"]+)"[^>]*>([\s\S]*?)<\/w:lvl>/g;
    for (const levelMatch of abstractBody.matchAll(levelPattern)) {
      const format = (levelMatch[2] || "").match(/<w:numFmt\b[^>]*\bw:val="([^"]+)"/)?.[1] || "";
      formatByAbstractLevel.set(`${abstractId}:${levelMatch[1] || "0"}`, format);
    }
  }

  const result = new Map<string, string>();
  for (const [numId, abstractId] of abstractByNumberingId) {
    for (const [key, format] of formatByAbstractLevel) {
      if (key.startsWith(`${abstractId}:`)) {
        result.set(`${numId}:${key.split(":")[1] || "0"}`, format);
      }
    }
  }
  return result;
}

function parseDocxDocumentXml(xml: string, shared: DocxSharedResources): DocxSection[] {
  const body = xml.match(/<w:body\b[^>]*>([\s\S]*?)<\/w:body>/)?.[1] || xml;
  return parseDocxBlockSections(body, shared, "paragraph");
}

async function parseDocxNoteSections(zip: JSZip, shared: DocxSharedResources): Promise<DocxSection[]> {
  const sections: DocxSection[] = [];
  const noteFiles = [
    { path: "word/footnotes.xml", type: "footnote" as const },
    { path: "word/endnotes.xml", type: "footnote" as const },
  ];
  for (const file of noteFiles) {
    const xml = await zip.file(file.path)?.async("string").catch(() => undefined);
    if (!xml) continue;
    const notePattern = /<w:(?:footnote|endnote)\b[^>]*>([\s\S]*?)<\/w:(?:footnote|endnote)>/g;
    for (const match of xml.matchAll(notePattern)) {
      const text = parseDocxBlockSections(match[1] || "", shared, file.type).map((section) => section.text).filter(Boolean).join("\n");
      sections.push({ type: file.type, index: sections.length + 1, text: normalizeText(text) });
    }
  }
  return sections;
}

async function parseDocxHeaderFooterSections(zip: JSZip, shared: DocxSharedResources): Promise<DocxSection[]> {
  const sections: DocxSection[] = [];
  const files = Object.values(zip.files)
    .filter((file) => !file.dir && /^word\/(?:header|footer)\d+\.xml$/.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const file of files) {
    const xml = await file.async("string");
    const type = file.name.includes("/header") ? "header" : "footer";
    const text = parseDocxBlockSections(xml, shared, type).map((section) => section.text).filter(Boolean).join("\n");
    sections.push({ type, index: sections.length + 1, text: normalizeText(text) });
  }
  return sections;
}

function parseDocxBlockSections(xml: string, shared: DocxSharedResources, defaultType: DocxSection["type"]): DocxSection[] {
  const sections: DocxSection[] = [];
  const blockPattern = /<w:(p|tbl)\b[\s\S]*?<\/w:\1>/g;
  for (const match of xml.matchAll(blockPattern)) {
    const block = match[0];
    if (match[1] === "tbl") {
      sections.push({ type: "table", index: sections.length + 1, text: extractDocxTableText(block) });
      continue;
    }
    const paragraph = extractDocxParagraph(block, shared, defaultType);
    sections.push({ ...paragraph, index: sections.length + 1 });
  }
  return sections;
}

function extractDocxParagraph(block: string, shared: DocxSharedResources, defaultType: DocxSection["type"]): Omit<DocxSection, "index"> {
  const text = extractDocxText(block);
  const styleId = block.match(/<w:pStyle\b[^>]*\bw:val="([^"]+)"/)?.[1] || "";
  const styleName = shared.paragraphStyles.get(styleId) || styleId;
  const headingLevel = headingLevelForStyle(styleName);
  const numbering = block.match(/<w:numPr\b[\s\S]*?<\/w:numPr>/)?.[0] || "";
  if (headingLevel) return { type: "heading", level: headingLevel, text };
  if (numbering) {
    const numId = numbering.match(/<w:numId\b[^>]*\bw:val="([^"]+)"/)?.[1] || "";
    const level = Number.parseInt(numbering.match(/<w:ilvl\b[^>]*\bw:val="([^"]+)"/)?.[1] || "0", 10);
    const format = shared.numberingLevels.get(`${numId}:${Number.isFinite(level) ? level : 0}`) || "";
    const prefix = format === "bullet" ? "- " : "";
    return { type: "list", level: Number.isFinite(level) ? level + 1 : 1, text: text ? `${prefix}${text}` : "" };
  }
  return { type: defaultType, text };
}

function headingLevelForStyle(styleName: string): number | undefined {
  const normalized = styleName.toLowerCase().replace(/\s+/g, "");
  const match = normalized.match(/^heading([1-6])$/) || normalized.match(/^标题([1-6])$/);
  return match ? Number.parseInt(match[1] || "1", 10) : undefined;
}

function extractDocxTableText(xml: string): string {
  const rows: string[][] = [];
  const rowPattern = /<w:tr\b[\s\S]*?<\/w:tr>/g;
  for (const rowMatch of xml.matchAll(rowPattern)) {
    const cells: string[] = [];
    const cellPattern = /<w:tc\b[\s\S]*?<\/w:tc>/g;
    for (const cellMatch of rowMatch[0].matchAll(cellPattern)) {
      const text = extractDocxText(cellMatch[0]);
      if (text) cells.push(text);
    }
    if (cells.length > 0) rows.push(cells);
  }
  return markdownTable(rows);
}

function extractDocxText(xml: string): string {
  const parts: string[] = [];
  const tokenPattern = /<w:(t|tab|br)\b[^>]*>([\s\S]*?)<\/w:t>|<w:(tab|br)\b[^\/]*\/>/g;
  for (const match of xml.matchAll(tokenPattern)) {
    const type = match[1] || match[3];
    if (type === "t") parts.push(decodeXml(match[2] || ""));
    else if (type === "tab") parts.push("\t");
    else if (type === "br") parts.push("\n");
  }
  return normalizeText(parts.join(""));
}

function formatDocxSection(section: DocxSection): string {
  if (!section.text) return "";
  if (section.type === "heading") return `${"#".repeat(Math.min(Math.max(section.level || 1, 1), 6))} ${section.text}`;
  if (section.type === "table") return `### Table ${section.index}\n\n${section.text}`;
  if (section.type === "footnote") return `### Footnote ${section.index}\n\n${section.text}`;
  if (section.type === "header") return `### Header ${section.index}\n\n${section.text}`;
  if (section.type === "footer") return `### Footer ${section.index}\n\n${section.text}`;
  return section.text;
}

function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length), 0);
  if (width === 0) return "";
  const normalizedRows = rows.map((row) => Array.from({ length: width }, (_value, index) => markdownTableCell(row[index] || "")));
  const header = normalizedRows[0] || [];
  const body = normalizedRows.slice(1);
  return [
    `| ${header.join(" | ")} |`,
    `| ${Array.from({ length: width }, () => "---").join(" | ")} |`,
    ...body.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function markdownTableCell(value: string): string {
  return normalizeText(value).replace(/\|/g, "\\|").replace(/\n+/g, "<br>");
}

function docxSourceLabel(section: DocxSection): string {
  if (section.type === "heading") return `标题 ${section.index}`;
  if (section.type === "table") return `表格 ${section.index}`;
  if (section.type === "footnote") return `脚注 ${section.index}`;
  if (section.type === "header") return `页眉 ${section.index}`;
  if (section.type === "footer") return `页脚 ${section.index}`;
  if (section.type === "list") return `列表段落 ${section.index}`;
  return `段落 ${section.index}`;
}
