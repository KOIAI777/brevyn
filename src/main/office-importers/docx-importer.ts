import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { createHash } from "node:crypto";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";
import type {
  BrevynOfficeArtifact,
  BrevynOfficeAsset,
  BrevynOfficeElement,
  BrevynOfficeElementType,
  BrevynSemanticUnit,
} from "../office-model/schema";

export const DOCX_OBJECT_MODEL_SCHEMA_VERSION = 1;
export const DOCX_OBJECT_MODEL_PARSER = "brevyn-docx-object-model";

export interface ImportDocxOptions {
  sourcePath: string;
  byteCount: number;
}

interface DocxRelationship {
  id: string;
  type?: string;
  target: string;
  targetMode?: string;
}

interface DocxResources {
  styles: Map<string, string>;
  relationships: Map<string, DocxRelationship>;
  comments: Map<string, DocxComment>;
  commentAnchors: Map<string, string>;
  notes: DocxNote[];
  trackedChanges: DocxTrackedChange[];
  mediaRelationshipToAssetId: Map<string, string>;
}

interface DocxComment {
  id: string;
  author?: string;
  date?: string;
  text: string;
}

interface DocxNote {
  id: string;
  type: "footnote" | "endnote";
  text: string;
}

interface DocxTrackedChange {
  id: string;
  type: "inserted" | "deleted";
  author?: string;
  date?: string;
  text: string;
}

interface DocxTableCell {
  ref: string;
  row: number;
  column: number;
  columnName: string;
  text: string;
}

interface DocxTableData {
  ref: string;
  rows: string[][];
  cells: DocxTableCell[];
}

interface ParsedDocxBlock {
  id: string;
  type: "heading" | "paragraph" | "list" | "table" | "image_caption";
  text: string;
  markdown: string;
  index: number;
  level?: number;
  sectionPath: string[];
  table?: DocxTableData;
  assetRefs?: string[];
  relationships?: Array<{ id: string; type: string; target: string }>;
}

export async function importDocxArtifact(options: ImportDocxOptions): Promise<BrevynOfficeArtifact> {
  if (extname(options.sourcePath).toLowerCase() === ".doc") {
    throw new Error("Legacy .doc files need conversion to .docx before local document extraction.");
  }
  const bytes = readFileSync(options.sourcePath);
  const zip = await JSZip.loadAsync(bytes);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error("DOCX document.xml was not found. The file may be damaged or unsupported.");
  }
  const artifactId = `artifact-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  const resources = await loadDocxResources(zip);
  const mediaAssets = docxMediaAssets(zip, artifactId);
  registerMediaAssetRelationships(resources, mediaAssets);
  const body = firstElementByLocalName(parseXml(documentXml), "body");
  const blocks = parseDocxBlocks(body || parseXml(documentXml), resources, artifactId);
  const commentElements = docxCommentElements(resources, artifactId);
  attachImageCaptions(blocks, mediaAssets);
  const noteElements = docxNoteElements(resources, artifactId);
  const trackedChangeElements = docxTrackedChangeElements(resources, artifactId);
  const elements = [
    ...docxBlockElements(blocks),
    ...commentElements,
    ...noteElements,
    ...trackedChangeElements,
  ];
  const semanticUnits = docxSemanticUnits(artifactId, blocks, commentElements, noteElements, trackedChangeElements);
  const warnings: string[] = [];
  if (blocks.length === 0 && mediaAssets.length === 0) warnings.push("No extractable DOCX text was found.");
  if (blocks.length === 0 && mediaAssets.length > 0) warnings.push(`${mediaAssets.length} embedded DOCX images were detected and need OCR/document parsing before they can be indexed.`);

  return {
    id: artifactId,
    schemaVersion: DOCX_OBJECT_MODEL_SCHEMA_VERSION,
    kind: "docx",
    title: basename(options.sourcePath),
    source: {
      path: options.sourcePath,
      name: basename(options.sourcePath),
      byteCount: options.byteCount,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    metadata: {
      parser: DOCX_OBJECT_MODEL_PARSER,
      parserVersion: 1,
      createdAt: new Date().toISOString(),
      coverageStatus: semanticUnits.length === 0 ? "skipped" : "complete",
      warnings,
      blocks: blocks.length,
      headings: blocks.filter((block) => block.type === "heading").length,
      paragraphs: blocks.filter((block) => block.type === "paragraph" || block.type === "list").length,
      tables: blocks.filter((block) => block.type === "table").length,
      comments: resources.comments.size,
      images: mediaAssets.length,
      imageCaptions: blocks.filter((block) => block.type === "image_caption").length,
      footnotes: resources.notes.filter((note) => note.type === "footnote").length,
      endnotes: resources.notes.filter((note) => note.type === "endnote").length,
      trackedChanges: resources.trackedChanges.length,
    },
    document: {
      sectionCount: semanticUnits.filter((unit) => unit.unitType === "document_section").length,
      paragraphCount: blocks.filter((block) => block.type === "paragraph" || block.type === "list").length,
      headingCount: blocks.filter((block) => block.type === "heading").length,
      tableCount: blocks.filter((block) => block.type === "table").length,
      commentCount: resources.comments.size,
      imageCount: mediaAssets.length,
      footnoteCount: resources.notes.filter((note) => note.type === "footnote").length,
      endnoteCount: resources.notes.filter((note) => note.type === "endnote").length,
      trackedChangeCount: resources.trackedChanges.length,
    },
    elements,
    assets: mediaAssets,
    semanticUnits,
  };
}

async function loadDocxResources(zip: JSZip): Promise<DocxResources> {
  const stylesXml = await zip.file("word/styles.xml")?.async("string").catch(() => undefined);
  const relsXml = await zip.file("word/_rels/document.xml.rels")?.async("string").catch(() => undefined);
  const commentsXml = await zip.file("word/comments.xml")?.async("string").catch(() => undefined);
  const comments = commentsXml ? parseDocxComments(commentsXml) : new Map<string, DocxComment>();
  const footnotesXml = await zip.file("word/footnotes.xml")?.async("string").catch(() => undefined);
  const endnotesXml = await zip.file("word/endnotes.xml")?.async("string").catch(() => undefined);
  return {
    styles: stylesXml ? parseParagraphStyles(stylesXml) : new Map(),
    relationships: relsXml ? parseRelationships(relsXml) : new Map(),
    comments,
    commentAnchors: new Map(),
    notes: [
      ...(footnotesXml ? parseDocxNotes(footnotesXml, "footnote") : []),
      ...(endnotesXml ? parseDocxNotes(endnotesXml, "endnote") : []),
    ],
    trackedChanges: [
      ...parseTrackedChangesFromXml(footnotesXml || ""),
      ...parseTrackedChangesFromXml(endnotesXml || ""),
    ],
    mediaRelationshipToAssetId: new Map(),
  };
}

function parseDocxBlocks(root: Element | Document, resources: DocxResources, artifactId: string): ParsedDocxBlock[] {
  const blocks: ParsedDocxBlock[] = [];
  const sectionStack = new Map<number, string>();
  const children = Array.from(root.childNodes || []).filter((node): node is Element => node.nodeType === 1);
  let blockIndex = 0;
  for (const child of children) {
    if (localName(child) !== "p" && localName(child) !== "tbl") continue;
    if (localName(child) === "tbl") {
      const table = tableData(child);
      const markdown = markdownTable(table.rows);
      if (!markdown.trim()) continue;
      blockIndex += 1;
      blocks.push({
        id: `${artifactId}:block-${blockIndex}`,
        type: "table",
        text: markdown,
        markdown: [`### Table ${blockIndex}`, markdown].join("\n\n"),
        index: blockIndex,
        sectionPath: currentSectionPath(sectionStack),
        table,
      });
      continue;
    }
    const paragraph = parseParagraph(child, resources);
    if (!paragraph.text.trim() && paragraph.assetRefs.length === 0) continue;
    blockIndex += 1;
    if (paragraph.type === "heading") {
      sectionStack.set(paragraph.level || 1, paragraph.text);
      for (const level of Array.from(sectionStack.keys())) {
        if (level > (paragraph.level || 1)) sectionStack.delete(level);
      }
    }
    const sectionPath = paragraph.type === "heading"
      ? currentSectionPath(sectionStack)
      : currentSectionPath(sectionStack);
    const id = `${artifactId}:block-${blockIndex}`;
    registerCommentAnchors(resources, paragraph.commentIds, paragraph.text);
    blocks.push({
      id,
      type: paragraph.type,
      text: paragraph.text,
      markdown: paragraphMarkdown(paragraph, blockIndex),
      index: blockIndex,
      level: paragraph.level,
      sectionPath,
      assetRefs: paragraph.assetRefs,
      relationships: [
        ...paragraph.hyperlinks.map((link, index) => ({ id: `${id}:hyperlink-${index + 1}`, type: "hyperlink", target: link })),
        ...paragraph.commentIds.map((commentId) => ({ id: `${id}:comment-${commentId}`, type: "comment", target: `${artifactId}:comment-${commentId}` })),
        ...paragraph.footnoteIds.map((noteId) => ({ id: `${id}:footnote-${noteId}`, type: "footnote", target: `${artifactId}:footnote-${noteId}` })),
        ...paragraph.endnoteIds.map((noteId) => ({ id: `${id}:endnote-${noteId}`, type: "endnote", target: `${artifactId}:endnote-${noteId}` })),
      ],
    });
  }
  resources.trackedChanges.push(...trackedChangesFromElement(root));
  return blocks;
}

function parseParagraph(paragraph: Element, resources: DocxResources): {
  type: "heading" | "paragraph" | "list";
  text: string;
  level?: number;
  hyperlinks: string[];
  commentIds: string[];
  footnoteIds: string[];
  endnoteIds: string[];
  assetRefs: string[];
} {
  const text = normalizeText(textFromElement(paragraph));
  const styleId = firstElementByLocalName(firstElementByLocalName(paragraph, "pPr"), "pStyle")?.getAttribute("w:val")
    || firstElementByLocalName(firstElementByLocalName(paragraph, "pPr"), "pStyle")?.getAttribute("val")
    || "";
  const styleName = resources.styles.get(styleId) || styleId;
  const headingLevel = headingLevelForStyle(styleName);
  const numbered = Boolean(firstElementByLocalName(firstElementByLocalName(paragraph, "pPr"), "numPr"));
  const hyperlinks = hyperlinkTargets(paragraph, resources.relationships);
  const commentIds = commentIdsFromParagraph(paragraph);
  const footnoteIds = noteIdsFromParagraph(paragraph, "footnoteReference");
  const endnoteIds = noteIdsFromParagraph(paragraph, "endnoteReference");
  const assetRefs = imageAssetRefs(paragraph, resources);
  if (headingLevel) return { type: "heading", level: headingLevel, text, hyperlinks, commentIds, footnoteIds, endnoteIds, assetRefs };
  if (numbered) return { type: "list", level: 1, text: text ? `- ${text}` : "", hyperlinks, commentIds, footnoteIds, endnoteIds, assetRefs };
  return { type: "paragraph", text, hyperlinks, commentIds, footnoteIds, endnoteIds, assetRefs };
}

function docxBlockElements(blocks: ParsedDocxBlock[]): BrevynOfficeElement[] {
  const elements: BrevynOfficeElement[] = [];
  for (const block of blocks) {
    elements.push({
      id: block.id,
      type: elementTypeForBlock(block.type),
      text: block.text,
      markdown: block.markdown,
      location: {
        sectionPath: block.sectionPath,
        objectPath: block.type === "table" ? `Table ${block.index}` : block.type === "image_caption" ? `Image caption ${block.index}` : `Paragraph ${block.index}`,
      },
      style: {
        blockIndex: block.index,
        level: block.level || 0,
      },
      assetRefs: block.assetRefs,
      relationships: block.relationships,
    });
    if (block.table) {
      for (const cell of block.table.cells) {
        elements.push({
          id: `${block.id}:cell-${cell.ref}`,
          type: "table_cell",
          text: cell.text,
          markdown: cell.text,
          location: {
            sectionPath: block.sectionPath,
            range: cell.ref,
            row: cell.row,
            column: cell.column,
            objectPath: `Table ${block.index} ${cell.ref}`,
          },
          style: {
            tableIndex: block.index,
            row: cell.row,
            column: cell.column,
          },
        });
      }
    }
  }
  return elements;
}

function docxCommentElements(resources: DocxResources, artifactId: string): BrevynOfficeElement[] {
  return Array.from(resources.comments.values()).map((comment): BrevynOfficeElement => ({
    id: `${artifactId}:comment-${comment.id}`,
    type: "comment",
    text: comment.text,
    markdown: [
      `Comment ${comment.id}`,
      comment.author ? `Author: ${comment.author}` : "",
      resources.commentAnchors.get(comment.id) ? `Anchor: ${resources.commentAnchors.get(comment.id)}` : "",
      comment.text,
    ].filter(Boolean).join("\n"),
    location: {
      objectPath: `Comment ${comment.id}`,
    },
    style: {
      commentId: comment.id,
      author: comment.author || "",
    },
  }));
}

function docxNoteElements(resources: DocxResources, artifactId: string): BrevynOfficeElement[] {
  return resources.notes.map((note): BrevynOfficeElement => ({
    id: `${artifactId}:${note.type}-${note.id}`,
    type: "paragraph",
    text: note.text,
    markdown: `${note.type === "footnote" ? "Footnote" : "Endnote"} ${note.id}: ${note.text}`,
    location: {
      objectPath: `${note.type === "footnote" ? "Footnote" : "Endnote"} ${note.id}`,
    },
    style: {
      noteId: note.id,
      noteType: note.type,
    },
  }));
}

function docxTrackedChangeElements(resources: DocxResources, artifactId: string): BrevynOfficeElement[] {
  return resources.trackedChanges.map((change, index): BrevynOfficeElement => ({
    id: `${artifactId}:tracked-change-${index + 1}`,
    type: "tracked_change",
    text: change.text,
    markdown: [
      `Tracked change ${index + 1}`,
      `Type: ${change.type}`,
      change.author ? `Author: ${change.author}` : "",
      change.date ? `Date: ${change.date}` : "",
      change.text,
    ].filter(Boolean).join("\n"),
    location: {
      objectPath: `Tracked change ${index + 1}`,
    },
    style: {
      changeId: change.id,
      changeType: change.type,
      author: change.author || "",
    },
  }));
}

function docxSemanticUnits(
  artifactId: string,
  blocks: ParsedDocxBlock[],
  commentElements: BrevynOfficeElement[],
  noteElements: BrevynOfficeElement[],
  trackedChangeElements: BrevynOfficeElement[],
): BrevynSemanticUnit[] {
  const units: BrevynSemanticUnit[] = [];
  const grouped = new Map<string, ParsedDocxBlock[]>();
  for (const block of blocks) {
    const key = block.sectionPath.join(" > ") || "Document";
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(block);
  }
  let sectionIndex = 0;
  for (const [sectionTitle, sectionBlocks] of grouped) {
    const markdown = sectionBlocks.map((block) => block.markdown).join("\n\n");
    if (!markdown.trim()) continue;
    sectionIndex += 1;
    units.push({
      id: `${artifactId}:unit-section-${sectionIndex}`,
      artifactId,
      elementIds: sectionBlocks.map((block) => block.id),
      unitType: "document_section",
      title: sectionTitle,
      text: markdown,
      markdown,
      sourceLabel: `章节 ${sectionIndex}: ${sectionTitle}`,
      citation: `Section: ${sectionTitle}`,
      location: {
        sectionPath: sectionTitle === "Document" ? [] : sectionTitle.split(" > "),
      },
      importance: sectionTitle === "Document" ? 0.65 : 0.85,
    });
  }
  for (const block of blocks.filter((item) => item.type === "table")) {
    units.push({
      id: `${artifactId}:unit-table-${block.index}`,
      artifactId,
      elementIds: [block.id, ...(block.table?.cells.map((cell) => `${block.id}:cell-${cell.ref}`) || [])],
      unitType: "table",
      title: `Table ${block.index}`,
      text: tableSemanticMarkdown(block),
      markdown: tableSemanticMarkdown(block),
      sourceLabel: `表格 ${block.index}`,
      citation: `Table ${block.index}`,
      location: {
        sectionPath: block.sectionPath,
        range: block.table?.ref,
        objectPath: `Table ${block.index}`,
      },
      importance: 0.9,
    });
  }
  for (const block of blocks.filter((item) => item.type === "image_caption")) {
    units.push({
      id: `${artifactId}:unit-image-caption-${block.index}`,
      artifactId,
      elementIds: [block.id],
      unitType: "image_caption",
      title: `Image caption ${block.index}`,
      text: block.markdown,
      markdown: block.markdown,
      sourceLabel: `图片说明 ${block.index}`,
      citation: `Image caption ${block.index}`,
      location: {
        sectionPath: block.sectionPath,
        objectPath: `Image caption ${block.index}`,
      },
      importance: 0.8,
    });
  }
  for (const element of commentElements) {
    units.push({
      id: `${artifactId}:unit-${element.id.split(":").pop()}`,
      artifactId,
      elementIds: [element.id],
      unitType: "comment",
      title: element.location.objectPath,
      text: element.markdown || element.text || "",
      markdown: element.markdown || element.text || "",
      sourceLabel: element.location.objectPath || "评论",
      citation: element.location.objectPath || "Comment",
      location: element.location,
      importance: 0.75,
    });
  }
  for (const element of noteElements) {
    const noteType = element.style?.noteType === "endnote" ? "endnote" : "footnote";
    const label = noteType === "endnote" ? "Endnote" : "Footnote";
    units.push({
      id: `${artifactId}:unit-${noteType}-${String(element.style?.noteId || element.id.split("-").pop() || units.length + 1)}`,
      artifactId,
      elementIds: [element.id],
      unitType: noteType,
      title: element.location.objectPath,
      text: element.markdown || element.text || "",
      markdown: element.markdown || element.text || "",
      sourceLabel: element.location.objectPath || label,
      citation: element.location.objectPath || label,
      location: element.location,
      importance: 0.7,
    });
  }
  for (const element of trackedChangeElements) {
    units.push({
      id: `${artifactId}:unit-${element.id.split(":").pop()}`,
      artifactId,
      elementIds: [element.id],
      unitType: "tracked_change",
      title: element.location.objectPath,
      text: element.markdown || element.text || "",
      markdown: element.markdown || element.text || "",
      sourceLabel: element.location.objectPath || "修订",
      citation: element.location.objectPath || "Tracked change",
      location: element.location,
      importance: 0.7,
    });
  }
  return units;
}

function parseParagraphStyles(xml: string): Map<string, string> {
  const styles = new Map<string, string>();
  const doc = parseXml(xml);
  for (const style of elementsByLocalName(doc, "style")) {
    const type = style.getAttribute("w:type") || style.getAttribute("type") || "";
    if (type !== "paragraph") continue;
    const id = style.getAttribute("w:styleId") || style.getAttribute("styleId") || "";
    if (!id) continue;
    const name = firstElementByLocalName(style, "name")?.getAttribute("w:val")
      || firstElementByLocalName(style, "name")?.getAttribute("val")
      || id;
    styles.set(id, decodeXml(name));
  }
  return styles;
}

function parseRelationships(xml: string): Map<string, DocxRelationship> {
  const rels = new Map<string, DocxRelationship>();
  const doc = parseXml(xml);
  for (const rel of elementsByLocalName(doc, "Relationship")) {
    const id = rel.getAttribute("Id") || "";
    if (!id) continue;
    rels.set(id, {
      id,
      type: rel.getAttribute("Type") || undefined,
      target: rel.getAttribute("Target") || "",
      targetMode: rel.getAttribute("TargetMode") || undefined,
    });
  }
  return rels;
}

function parseDocxComments(xml: string): Map<string, DocxComment> {
  const comments = new Map<string, DocxComment>();
  const doc = parseXml(xml);
  for (const comment of elementsByLocalName(doc, "comment")) {
    const id = comment.getAttribute("w:id") || comment.getAttribute("id") || "";
    if (!id) continue;
    comments.set(id, {
      id,
      author: comment.getAttribute("w:author") || comment.getAttribute("author") || undefined,
      date: comment.getAttribute("w:date") || comment.getAttribute("date") || undefined,
      text: normalizeText(paragraphTexts(comment).join("\n")),
    });
  }
  return comments;
}

function parseDocxNotes(xml: string, type: DocxNote["type"]): DocxNote[] {
  const notes: DocxNote[] = [];
  if (!xml.trim()) return notes;
  const doc = parseXml(xml);
  for (const note of elementsByLocalName(doc, type)) {
    const id = note.getAttribute("w:id") || note.getAttribute("id") || "";
    if (!id || Number.parseInt(id, 10) < 0) continue;
    const text = normalizeText(paragraphTexts(note).join("\n"));
    if (!text) continue;
    notes.push({ id, type, text });
  }
  return notes;
}

function parseTrackedChangesFromXml(xml: string): DocxTrackedChange[] {
  if (!xml.trim()) return [];
  return trackedChangesFromElement(parseXml(xml));
}

function trackedChangesFromElement(root: Element | Document): DocxTrackedChange[] {
  const changes: DocxTrackedChange[] = [];
  for (const node of elementsByLocalName(root, "ins")) {
    const text = normalizeText(textFromElement(node));
    if (!text) continue;
    changes.push({
      id: node.getAttribute("w:id") || node.getAttribute("id") || `ins-${changes.length + 1}`,
      type: "inserted",
      author: node.getAttribute("w:author") || node.getAttribute("author") || undefined,
      date: node.getAttribute("w:date") || node.getAttribute("date") || undefined,
      text,
    });
  }
  for (const node of elementsByLocalName(root, "del")) {
    const text = normalizeText(deletedTextFromElement(node) || textFromElement(node));
    if (!text) continue;
    changes.push({
      id: node.getAttribute("w:id") || node.getAttribute("id") || `del-${changes.length + 1}`,
      type: "deleted",
      author: node.getAttribute("w:author") || node.getAttribute("author") || undefined,
      date: node.getAttribute("w:date") || node.getAttribute("date") || undefined,
      text,
    });
  }
  return changes;
}

function docxMediaAssets(zip: JSZip, artifactId: string): BrevynOfficeAsset[] {
  return Object.values(zip.files)
    .filter((file) => !file.dir && /^word\/media\//.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((file, index): BrevynOfficeAsset => ({
      id: `${artifactId}:asset-image-${index + 1}`,
      kind: "image",
      sourceLabel: `DOCX image ${index + 1}`,
      path: file.name,
      mediaType: mediaTypeForPath(file.name),
    }));
}

function registerMediaAssetRelationships(resources: DocxResources, mediaAssets: BrevynOfficeAsset[]): void {
  for (const relationship of resources.relationships.values()) {
    if (!relationship.target || !relationship.type?.includes("/image")) continue;
    const normalizedTarget = relationship.target.replace(/^\.\.\//, "").replace(/^word\//, "");
    const asset = mediaAssets.find((candidate) => {
      const path = candidate.path || "";
      return path === `word/${normalizedTarget}` || path.endsWith(`/${basename(normalizedTarget)}`);
    });
    if (asset) resources.mediaRelationshipToAssetId.set(relationship.id, asset.id);
  }
}

function attachImageCaptions(blocks: ParsedDocxBlock[], mediaAssets: BrevynOfficeAsset[]): void {
  const imageBlocks = blocks.filter((block) => (block.assetRefs || []).length > 0);
  if (imageBlocks.length === 0 || mediaAssets.length === 0) return;
  for (const imageBlock of imageBlocks) {
    const nextCaption = blocks.find((candidate) => candidate.index > imageBlock.index && isCaptionText(candidate.text));
    const previousCaption = blocks.find((candidate) => candidate.index < imageBlock.index && imageBlock.index - candidate.index <= 2 && isCaptionText(candidate.text));
    const caption = nextCaption || previousCaption;
    if (!caption) continue;
    caption.type = "image_caption";
    caption.assetRefs = [...new Set([...(caption.assetRefs || []), ...(imageBlock.assetRefs || [])])];
    caption.relationships = [
      ...(caption.relationships || []),
      ...(imageBlock.assetRefs || []).map((assetRef, index) => ({
        id: `${caption.id}:image-${index + 1}`,
        type: "image_caption",
        target: assetRef,
      })),
    ];
  }
}

function isCaptionText(text: string): boolean {
  const normalized = text.trim();
  return /^(fig(?:ure)?\.?\s*\d+|图\s*\d+|表\s*\d+|table\s*\d+)/i.test(normalized);
}

function hyperlinkTargets(paragraph: Element, relationships: Map<string, DocxRelationship>): string[] {
  const targets: string[] = [];
  for (const hyperlink of elementsByLocalName(paragraph, "hyperlink")) {
    const id = hyperlink.getAttribute("r:id") || hyperlink.getAttribute("id") || "";
    const anchor = hyperlink.getAttribute("w:anchor") || hyperlink.getAttribute("anchor") || "";
    const relationship = id ? relationships.get(id) : undefined;
    const target = relationship?.target || (anchor ? `#${anchor}` : "");
    if (target) targets.push(target);
  }
  return targets;
}

function commentIdsFromParagraph(paragraph: Element): string[] {
  const ids = new Set<string>();
  for (const node of [...elementsByLocalName(paragraph, "commentRangeStart"), ...elementsByLocalName(paragraph, "commentReference")]) {
    const id = node.getAttribute("w:id") || node.getAttribute("id") || "";
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

function noteIdsFromParagraph(paragraph: Element, nodeName: "footnoteReference" | "endnoteReference"): string[] {
  const ids = new Set<string>();
  for (const node of elementsByLocalName(paragraph, nodeName)) {
    const id = node.getAttribute("w:id") || node.getAttribute("id") || "";
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

function imageRelationshipIds(paragraph: Element): string[] {
  const ids = new Set<string>();
  for (const node of [...elementsByLocalName(paragraph, "blip"), ...elementsByLocalName(paragraph, "imagedata")]) {
    const id = node.getAttribute("r:embed")
      || node.getAttribute("embed")
      || node.getAttribute("r:id")
      || node.getAttribute("id")
      || "";
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

function imageAssetRefs(paragraph: Element, resources: DocxResources): string[] {
  return imageRelationshipIds(paragraph).map((id) => resources.mediaRelationshipToAssetId.get(id) || id);
}

function registerCommentAnchors(resources: DocxResources, commentIds: string[], text: string): void {
  for (const id of commentIds) {
    if (!resources.commentAnchors.has(id) && text.trim()) resources.commentAnchors.set(id, text.slice(0, 240));
  }
}

function paragraphMarkdown(paragraph: { type: "heading" | "paragraph" | "list"; text: string; level?: number }, index: number): string {
  if (paragraph.type === "heading") return `${"#".repeat(Math.min(Math.max(paragraph.level || 1, 1), 6))} ${paragraph.text}`;
  if (paragraph.type === "list") return paragraph.text;
  return `Paragraph ${index}: ${paragraph.text}`;
}

function tableData(table: Element): DocxTableData {
  const rows: string[][] = [];
  for (const row of childElementsByLocalName(table, "tr")) {
    const cells = childElementsByLocalName(row, "tc").map((cell) => normalizeText(textFromElement(cell))).filter(Boolean);
    if (cells.length > 0) rows.push(cells);
  }
  const width = Math.max(...rows.map((row) => row.length), 0);
  const cells: DocxTableCell[] = [];
  rows.forEach((row, rowIndex) => {
    for (let columnIndex = 0; columnIndex < width; columnIndex += 1) {
      const text = row[columnIndex] || "";
      cells.push({
        ref: `${spreadsheetColumnName(columnIndex)}${rowIndex + 1}`,
        row: rowIndex + 1,
        column: columnIndex + 1,
        columnName: spreadsheetColumnName(columnIndex),
        text,
      });
    }
  });
  return {
    ref: width > 0 && rows.length > 0 ? `A1:${spreadsheetColumnName(width - 1)}${rows.length}` : "",
    rows,
    cells,
  };
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

function tableSemanticMarkdown(block: ParsedDocxBlock): string {
  const parts = [
    `### Table ${block.index}`,
    block.table?.ref ? `Range: ${block.table.ref}` : "",
    block.markdown.replace(/^### Table \d+\n\n/, ""),
  ].filter(Boolean);
  return parts.join("\n\n");
}

function paragraphTexts(root: Element): string[] {
  return elementsByLocalName(root, "p")
    .map((paragraph) => normalizeText(textFromElement(paragraph)))
    .filter(Boolean);
}

function textFromElement(root: Element): string {
  const parts: string[] = [];
  walkElements(root, (node) => {
    const name = localName(node);
    if (name === "t") parts.push(node.textContent || "");
    else if (name === "tab") parts.push("\t");
    else if (name === "br" || name === "cr") parts.push("\n");
  });
  return normalizeText(parts.join(""));
}

function deletedTextFromElement(root: Element): string {
  const parts: string[] = [];
  walkElements(root, (node) => {
    const name = localName(node);
    if (name === "delText") parts.push(node.textContent || "");
    else if (name === "tab") parts.push("\t");
    else if (name === "br" || name === "cr") parts.push("\n");
  });
  return normalizeText(parts.join(""));
}

function currentSectionPath(sectionStack: Map<number, string>): string[] {
  return Array.from(sectionStack.entries())
    .sort(([left], [right]) => left - right)
    .map(([, title]) => title)
    .filter(Boolean);
}

function headingLevelForStyle(styleName: string): number | undefined {
  const normalized = styleName.toLowerCase().replace(/\s+/g, "");
  const match = normalized.match(/^heading([1-6])$/) || normalized.match(/^标题([1-6])$/);
  return match ? Number.parseInt(match[1] || "1", 10) : undefined;
}

function elementTypeForBlock(type: ParsedDocxBlock["type"]): BrevynOfficeElementType {
  if (type === "heading") return "heading";
  if (type === "table") return "table";
  if (type === "image_caption") return "image_caption";
  return "paragraph";
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

function elementsByLocalName(root: Element | Document, name: string): Element[] {
  const result: Element[] = [];
  walkElements(root, (node) => {
    if (localName(node) === name) result.push(node);
  });
  return result;
}

function childElementsByLocalName(root: Element, name: string): Element[] {
  return Array.from(root.childNodes || []).filter((node): node is Element => isElementNode(node) && localName(node) === name);
}

function firstElementByLocalName(root: Element | Document | undefined | null, name: string): Element | undefined {
  if (!root) return undefined;
  return elementsByLocalName(root, name)[0];
}

function walkElements(root: Element | Document, visit: (node: Element) => void): void {
  const children = Array.from(root.childNodes || []);
  for (const child of children) {
    if (!isElementNode(child)) continue;
    visit(child);
    walkElements(child, visit);
  }
}

function isElementNode(node: Node): node is Element {
  return node.nodeType === 1;
}

function localName(node: Element): string {
  return (node.localName || node.nodeName).split(":").pop() || node.nodeName;
}

function normalizeText(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function markdownTableCell(value: string): string {
  return normalizeText(value).replace(/\|/g, "\\|").replace(/\n+/g, "<br>");
}

function spreadsheetColumnName(index: number): string {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name || "A";
}

function decodeXml(value: string): string {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function mediaTypeForPath(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".bmp") return "image/bmp";
  return "image/png";
}
