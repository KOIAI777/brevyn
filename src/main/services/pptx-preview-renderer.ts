import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, posix as pathPosix } from "node:path";
import { createHash } from "node:crypto";
import AdmZip from "adm-zip";
import { DOMParser } from "@xmldom/xmldom";
import type { PresentationPreview } from "../../types/domain";

const EMU_PER_INCH = 914_400;
const PX_PER_INCH = 96;
const DEFAULT_SLIDE_WIDTH = 13.333333 * PX_PER_INCH;
const DEFAULT_SLIDE_HEIGHT = 7.5 * PX_PER_INCH;
const MAX_RENDERED_SLIDES = 120;
const PREVIEW_CACHE_DIR = ".preview-cache";

type SlideSize = { width: number; height: number };
type RelationshipMap = Map<string, string>;
type TransformContext = { offsetX: number; offsetY: number; scaleX: number; scaleY: number };

type SlideElement =
  | { kind: "text"; id: string; x: number; y: number; width: number; height: number; text: string; fontSize: number; color: string; align: string; fill?: string; line?: string }
  | { kind: "image"; id: string; x: number; y: number; width: number; height: number; href: string }
  | { kind: "shape"; id: string; x: number; y: number; width: number; height: number; shape: string; fill?: string; line?: string };

type SlideRender = {
  index: number;
  title?: string;
  text: string;
  svgPath: string;
  unsupportedCount: number;
};

export type PptxPreviewArtifacts = {
  summary: string;
  content: string;
  cacheDir?: string;
  presentation?: PresentationPreview;
};

export function renderPptxPreviewArtifacts(input: {
  rootDataDir: string;
  sourcePath?: string;
  title: string;
}): PptxPreviewArtifacts {
  if (!input.sourcePath || !existsSync(input.sourcePath)) {
    return { summary: "PPTX 源文件不可用于预览。", content: "" };
  }
  if (extname(input.sourcePath).toLowerCase() === ".ppt") {
    return {
      summary: "旧版 .ppt 文件需要用 PowerPoint/WPS/Office 打开才能完整预览。",
      content: "",
    };
  }

  try {
    const stats = statSync(input.sourcePath);
    const cacheKey = createHash("sha256")
      .update(`${input.sourcePath}\n${stats.size}\n${stats.mtimeMs}`)
      .digest("hex")
      .slice(0, 20);
    const cacheDir = join(input.rootDataDir, PREVIEW_CACHE_DIR, "pptx-svg", cacheKey);
    const manifestPath = join(cacheDir, "manifest.json");
    if (existsSync(manifestPath)) {
      const cached = JSON.parse(readFileSync(manifestPath, "utf8")) as PresentationPreview;
      return {
        summary: presentationSummary(cached, true),
        content: presentationContent(cached),
        cacheDir,
        presentation: cached,
      };
    }

    mkdirSync(cacheDir, { recursive: true });
    const mediaDir = join(cacheDir, "media");
    mkdirSync(mediaDir, { recursive: true });

    const zip = new AdmZip(input.sourcePath);
    const size = readSlideSize(zip);
    const slidePaths = getSlidePaths(zip);
    const rendered = slidePaths.slice(0, MAX_RENDERED_SLIDES).map((slidePath, index) => (
      renderSlide(zip, slidePath, index + 1, size, cacheDir, mediaDir)
    ));
    const unsupportedCount = rendered.reduce((count, slide) => count + slide.unsupportedCount, 0);
    const manifest: PresentationPreview = {
      renderEngine: "brevyn-svg-v1",
      width: Math.round(size.width),
      height: Math.round(size.height),
      slideCount: slidePaths.length,
      renderedSlideCount: rendered.length,
      unsupportedCount,
      slides: rendered.map((slide) => ({
        index: slide.index,
        title: slide.title,
        text: slide.text,
        previewUrl: `slides/slide-${slide.index}.svg`,
        unsupportedCount: slide.unsupportedCount,
      })),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    return {
      summary: presentationSummary(manifest, false),
      content: presentationContent(manifest),
      cacheDir,
      presentation: manifest,
    };
  } catch (error) {
    return {
      summary: `PPTX 预览失败：${error instanceof Error ? error.message : String(error || "Unknown error")}`,
      content: "",
    };
  }
}

export function attachPptxPreviewUrls(
  preview: PresentationPreview,
  baseUrl: string,
): PresentationPreview {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  return {
    ...preview,
    slides: preview.slides.map((slide) => ({
      ...slide,
      previewUrl: `${normalizedBaseUrl}/${slide.previewUrl}`,
    })),
  };
}

function renderSlide(
  zip: AdmZip,
  slidePath: string,
  index: number,
  size: SlideSize,
  cacheDir: string,
  mediaDir: string,
): SlideRender {
  const slideXml = readZipText(zip, slidePath);
  if (!slideXml) throw new Error(`Slide XML missing: ${slidePath}`);
  const slideDoc = parseXml(slideXml);
  const slideDir = dirname(slidePath);
  const slideName = basename(slidePath);
  const relsPath = pathPosix.join(slideDir, "_rels", `${slideName}.rels`);
  const rels = parseRelationships(zip, relsPath, slideDir);
  const elements: SlideElement[] = [];

  const spTree = elementsByLocalName(slideDoc, "spTree")[0];
  const unsupportedCount = appendSlideChildren({
    elements,
    zip,
    children: spTree ? directElementChildren(spTree) : directElementChildren(slideDoc.documentElement),
    rels,
    size,
    slideIndex: index,
    mediaDir,
    transform: identityTransformContext(),
  });

  const textRuns = elements.filter((element): element is Extract<SlideElement, { kind: "text" }> => element.kind === "text");
  const title = textRuns.map((element) => element.text.trim()).find(Boolean)?.split("\n")[0]?.slice(0, 80);
  const text = textRuns.map((element) => element.text.trim()).filter(Boolean).join("\n");
  const slideDirOut = join(cacheDir, "slides");
  mkdirSync(slideDirOut, { recursive: true });
  const svgPath = join(slideDirOut, `slide-${index}.svg`);
  writeFileSync(svgPath, renderSlideSvg(size, elements, index), "utf8");
  return { index, title, text, svgPath, unsupportedCount };
}

function appendSlideChildren(
  input: {
    elements: SlideElement[];
    zip: AdmZip;
    children: Element[];
    rels: RelationshipMap;
    size: SlideSize;
    slideIndex: number;
    mediaDir: string;
    transform: TransformContext;
  },
): number {
  let unsupportedCount = 0;
  for (const child of input.children) {
    const childName = child.localName || child.nodeName;
    if (childName === "sp" || childName === "cxnSp") {
      unsupportedCount += appendShapeElement(input.elements, child, input.size, input.transform);
    } else if (childName === "pic") {
      unsupportedCount += appendPictureElement(input.elements, input.zip, child, input.rels, input.size, input.slideIndex, input.mediaDir, input.transform);
    } else if (childName === "grpSp") {
      unsupportedCount += appendGroupElement(input, child);
    } else if (childName === "graphicFrame") {
      unsupportedCount += 1;
    }
  }
  return unsupportedCount;
}

function appendGroupElement(
  input: Parameters<typeof appendSlideChildren>[0],
  group: Element,
): number {
  const transform = readGroupTransformContext(group, input.size, input.transform) || input.transform;
  return appendSlideChildren({
    ...input,
    children: directElementChildren(group),
    transform,
  });
}

function appendShapeElement(elements: SlideElement[], sp: Element, size: SlideSize, context: TransformContext): number {
  const transform = readTransform(sp, size, context);
  if (!transform) return 1;
  const text = textFromElement(sp);
  const shape = firstTextByPath(sp, ["spPr", "prstGeom"], "prst") || "rect";
  const fill = readSolidFill(sp) || "#ffffff";
  const line = readLineColor(sp);
  if (text) {
    elements.push({
      kind: "text",
      id: elementName(sp) || `text-${elements.length + 1}`,
      ...transform,
      text,
      fontSize: readFontSize(sp) || Math.max(12, Math.round(transform.height / 5)),
      color: readTextColor(sp) || "#111827",
      align: readParagraphAlign(sp),
      fill: fill === "none" ? undefined : fill,
      line,
    });
    return 0;
  }
  elements.push({
    kind: "shape",
    id: elementName(sp) || `shape-${elements.length + 1}`,
    ...transform,
    shape,
    fill: fill === "none" ? undefined : fill,
    line,
  });
  return 0;
}

function appendPictureElement(
  elements: SlideElement[],
  zip: AdmZip,
  pic: Element,
  rels: RelationshipMap,
  size: SlideSize,
  slideIndex: number,
  mediaDir: string,
  context: TransformContext,
): number {
  const transform = readTransform(pic, size, context);
  const embedId = firstTextByPath(pic, ["blipFill", "blip"], "embed");
  const target = embedId ? rels.get(embedId) : undefined;
  if (!transform || !target) return 1;
  const entry = zip.getEntry(target);
  if (!entry) return 1;
  const mediaName = `${slideIndex}-${basename(target)}`;
  const mediaOutput = join(mediaDir, mediaName);
  if (!existsSync(mediaOutput)) copyFileFromZip(entry, mediaOutput);
  elements.push({
    kind: "image",
    id: elementName(pic) || `image-${elements.length + 1}`,
    ...transform,
    href: `../media/${encodeURIComponent(mediaName)}`,
  });
  return 0;
}

function renderSlideSvg(size: SlideSize, elements: SlideElement[], index: number): string {
  const body = elements.map((element) => {
    if (element.kind === "image") {
      return `<image href="${escapeXml(element.href)}" x="${num(element.x)}" y="${num(element.y)}" width="${num(element.width)}" height="${num(element.height)}" preserveAspectRatio="xMidYMid meet" />`;
    }
    if (element.kind === "shape") {
      return renderShape(element);
    }
    const fill = element.fill && element.fill !== "#ffffff" ? element.fill : "transparent";
    const line = element.line || "transparent";
    return [
      `<rect x="${num(element.x)}" y="${num(element.y)}" width="${num(element.width)}" height="${num(element.height)}" rx="6" fill="${escapeXml(fill)}" stroke="${escapeXml(line)}" stroke-width="${line === "transparent" ? 0 : 1}" />`,
      renderText(element),
    ].join("");
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${num(size.width)}" height="${num(size.height)}" viewBox="0 0 ${num(size.width)} ${num(size.height)}" role="img" aria-label="Slide ${index}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${body}
</svg>`;
}

function renderShape(element: Extract<SlideElement, { kind: "shape" }>): string {
  const fill = element.fill || "transparent";
  const line = element.line || (fill === "transparent" ? "#d8d8d8" : "transparent");
  if (element.shape.includes("ellipse")) {
    return `<ellipse cx="${num(element.x + element.width / 2)}" cy="${num(element.y + element.height / 2)}" rx="${num(element.width / 2)}" ry="${num(element.height / 2)}" fill="${escapeXml(fill)}" stroke="${escapeXml(line)}" stroke-width="1" />`;
  }
  if (element.shape.includes("line")) {
    return `<line x1="${num(element.x)}" y1="${num(element.y)}" x2="${num(element.x + element.width)}" y2="${num(element.y + element.height)}" stroke="${escapeXml(line)}" stroke-width="2" />`;
  }
  return `<rect x="${num(element.x)}" y="${num(element.y)}" width="${num(element.width)}" height="${num(element.height)}" rx="6" fill="${escapeXml(fill)}" stroke="${escapeXml(line)}" stroke-width="${line === "transparent" ? 0 : 1}" />`;
}

function renderText(element: Extract<SlideElement, { kind: "text" }>): string {
  const padding = Math.max(6, Math.min(18, element.fontSize * 0.5));
  const lineHeight = element.fontSize * 1.22;
  const maxChars = Math.max(6, Math.floor((element.width - padding * 2) / Math.max(5, element.fontSize * 0.54)));
  const lines = wrapText(element.text, maxChars).slice(0, Math.max(1, Math.floor((element.height - padding) / lineHeight)));
  const anchor = element.align === "center" ? "middle" : element.align === "right" ? "end" : "start";
  const x = element.align === "center" ? element.x + element.width / 2 : element.align === "right" ? element.x + element.width - padding : element.x + padding;
  return `<text x="${num(x)}" y="${num(element.y + padding + element.fontSize)}" font-family="Arial, Helvetica, sans-serif" font-size="${num(element.fontSize)}" fill="${escapeXml(element.color)}" text-anchor="${anchor}">${lines.map((line, lineIndex) => (
    `<tspan x="${num(x)}" dy="${lineIndex === 0 ? 0 : num(lineHeight)}">${escapeXml(line)}</tspan>`
  )).join("")}</text>`;
}

function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (!line) {
        line = word;
      } else if (`${line} ${word}`.length <= maxChars) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function readSlideSize(zip: AdmZip): SlideSize {
  const presentationXml = readZipText(zip, "ppt/presentation.xml");
  if (!presentationXml) return { width: DEFAULT_SLIDE_WIDTH, height: DEFAULT_SLIDE_HEIGHT };
  const doc = parseXml(presentationXml);
  const slideSize = elementsByLocalName(doc, "sldSz")[0];
  const cx = Number(slideSize?.getAttribute("cx"));
  const cy = Number(slideSize?.getAttribute("cy"));
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || cx <= 0 || cy <= 0) {
    return { width: DEFAULT_SLIDE_WIDTH, height: DEFAULT_SLIDE_HEIGHT };
  }
  return { width: emuToPx(cx), height: emuToPx(cy) };
}

function identityTransformContext(): TransformContext {
  return { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
}

function readTransform(element: Element, size: SlideSize, context = identityTransformContext()): { x: number; y: number; width: number; height: number } | null {
  const xfrm = elementsByLocalName(element, "xfrm")[0];
  if (!xfrm) return null;
  const off = directChildByLocalName(xfrm, "off");
  const ext = directChildByLocalName(xfrm, "ext");
  if (!off || !ext) return null;
  const localX = emuToPx(Number(off.getAttribute("x") || 0));
  const localY = emuToPx(Number(off.getAttribute("y") || 0));
  const localWidth = emuToPx(Number(ext.getAttribute("cx") || 0));
  const localHeight = emuToPx(Number(ext.getAttribute("cy") || 0));
  const x = context.offsetX + localX * context.scaleX;
  const y = context.offsetY + localY * context.scaleY;
  const width = localWidth * context.scaleX;
  const height = localHeight * context.scaleY;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    x: clamp(x, -size.width, size.width * 2),
    y: clamp(y, -size.height, size.height * 2),
    width: clamp(width, 1, size.width * 2),
    height: clamp(height, 1, size.height * 2),
  };
}

function readGroupTransformContext(group: Element, size: SlideSize, parent: TransformContext): TransformContext | null {
  const grpSpPr = directChildByLocalName(group, "grpSpPr");
  const xfrm = grpSpPr ? elementsByLocalName(grpSpPr, "xfrm")[0] : undefined;
  if (!xfrm) return null;
  const off = directChildByLocalName(xfrm, "off");
  const ext = directChildByLocalName(xfrm, "ext");
  const chOff = directChildByLocalName(xfrm, "chOff");
  const chExt = directChildByLocalName(xfrm, "chExt");
  if (!off || !ext || !chOff || !chExt) return null;
  const offX = emuToPx(Number(off.getAttribute("x") || 0));
  const offY = emuToPx(Number(off.getAttribute("y") || 0));
  const extWidth = emuToPx(Number(ext.getAttribute("cx") || 0));
  const extHeight = emuToPx(Number(ext.getAttribute("cy") || 0));
  const childOffX = emuToPx(Number(chOff.getAttribute("x") || 0));
  const childOffY = emuToPx(Number(chOff.getAttribute("y") || 0));
  const childExtWidth = emuToPx(Number(chExt.getAttribute("cx") || 0));
  const childExtHeight = emuToPx(Number(chExt.getAttribute("cy") || 0));
  if (![offX, offY, extWidth, extHeight, childOffX, childOffY, childExtWidth, childExtHeight].every(Number.isFinite) || childExtWidth <= 0 || childExtHeight <= 0) {
    return null;
  }
  const scaleX = parent.scaleX * (extWidth / childExtWidth);
  const scaleY = parent.scaleY * (extHeight / childExtHeight);
  const offsetX = parent.offsetX + offX * parent.scaleX - childOffX * scaleX;
  const offsetY = parent.offsetY + offY * parent.scaleY - childOffY * scaleY;
  return {
    offsetX: clamp(offsetX, -size.width * 2, size.width * 2),
    offsetY: clamp(offsetY, -size.height * 2, size.height * 2),
    scaleX,
    scaleY,
  };
}

function getSlidePaths(zip: AdmZip): string[] {
  const presentationXml = readZipText(zip, "ppt/presentation.xml");
  const relationships = parseRelationships(zip, "ppt/_rels/presentation.xml.rels", "ppt");
  if (presentationXml) {
    const doc = parseXml(presentationXml);
    const slidePaths = elementsByLocalName(doc, "sldId")
      .map((slide) => slide.getAttribute("r:id") || slide.getAttribute("id"))
      .map((relationshipId) => relationshipId ? relationships.get(relationshipId) : undefined)
      .filter((path): path is string => Boolean(path));
    if (slidePaths.length > 0) return slidePaths;
  }
  return zip.getEntries()
    .map((entry) => entry.entryName)
    .filter((entryName) => /^ppt\/slides\/slide\d+\.xml$/.test(entryName))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)?.[1] || 0) - Number(b.match(/slide(\d+)\.xml$/)?.[1] || 0));
}

function parseRelationships(zip: AdmZip, relsPath: string, baseDir: string): RelationshipMap {
  const relsXml = readZipText(zip, relsPath);
  const rels = new Map<string, string>();
  if (!relsXml) return rels;
  const relsDoc = parseXml(relsXml);
  for (const rel of elementsByLocalName(relsDoc, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (!id || !target) continue;
    rels.set(id, normalizeZipTarget(baseDir, target));
  }
  return rels;
}

function textFromElement(element: Element): string {
  return elementsByLocalName(element, "p")
    .map((paragraph) => elementsByLocalName(paragraph, "t").map((node) => node.textContent || "").join("").trim())
    .filter(Boolean)
    .join("\n");
}

function readSolidFill(element: Element): string | undefined {
  const spPr = elementsByLocalName(element, "spPr")[0];
  if (!spPr) return undefined;
  if (elementsByLocalName(spPr, "noFill").length > 0) return "none";
  const srgb = elementsByLocalName(spPr, "srgbClr")[0]?.getAttribute("val");
  if (srgb) return `#${srgb}`;
  const scheme = elementsByLocalName(spPr, "schemeClr")[0]?.getAttribute("val");
  return scheme ? schemeColor(scheme) : undefined;
}

function readLineColor(element: Element): string | undefined {
  const ln = elementsByLocalName(element, "ln")[0];
  if (!ln || elementsByLocalName(ln, "noFill").length > 0) return undefined;
  const srgb = elementsByLocalName(ln, "srgbClr")[0]?.getAttribute("val");
  if (srgb) return `#${srgb}`;
  const scheme = elementsByLocalName(ln, "schemeClr")[0]?.getAttribute("val");
  return scheme ? schemeColor(scheme) : undefined;
}

function readTextColor(element: Element): string | undefined {
  const runProps = elementsByLocalName(element, "rPr")[0];
  if (!runProps) return undefined;
  const srgb = elementsByLocalName(runProps, "srgbClr")[0]?.getAttribute("val");
  if (srgb) return `#${srgb}`;
  const scheme = elementsByLocalName(runProps, "schemeClr")[0]?.getAttribute("val");
  return scheme ? schemeColor(scheme) : undefined;
}

function readFontSize(element: Element): number | undefined {
  const sizes = elementsByLocalName(element, "rPr")
    .map((node) => Number(node.getAttribute("sz")))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (sizes.length === 0) return undefined;
  return Math.max(8, Math.round(sizes[0] / 100));
}

function readParagraphAlign(element: Element): string {
  const align = elementsByLocalName(element, "pPr")[0]?.getAttribute("algn");
  if (align === "ctr") return "center";
  if (align === "r") return "right";
  return "left";
}

function firstTextByPath(element: Element, path: string[], attribute: string): string | undefined {
  let current: Element | undefined = element;
  for (const part of path) {
    current = current ? elementsByLocalName(current, part)[0] : undefined;
  }
  return current?.getAttribute(attribute) || current?.getAttribute(`r:${attribute}`) || undefined;
}

function directChildByLocalName(element: Element, localName: string): Element | undefined {
  const children = element.childNodes;
  for (let index = 0; index < children.length; index += 1) {
    const child = children.item(index);
    if (child.nodeType !== 1) continue;
    const childElement = child as Element;
    if (childElement.localName === localName || childElement.nodeName === localName) return childElement;
  }
  return undefined;
}

function directElementChildren(element: Element): Element[] {
  const result: Element[] = [];
  const children = element.childNodes;
  for (let index = 0; index < children.length; index += 1) {
    const child = children.item(index);
    if (child.nodeType === 1) result.push(child as Element);
  }
  return result;
}

function elementsByLocalName(root: Node, localName: string): Element[] {
  const result: Element[] = [];
  function walk(node: Node): void {
    const children = node.childNodes;
    if (!children) return;
    for (let index = 0; index < children.length; index += 1) {
      const child = children.item(index);
      if (child.nodeType === 1) {
        const element = child as Element;
        if (element.localName === localName || element.nodeName === localName) result.push(element);
      }
      walk(child);
    }
  }
  walk(root);
  return result;
}

function elementName(element: Element): string | undefined {
  const cNvPr = elementsByLocalName(element, "cNvPr")[0];
  return cNvPr?.getAttribute("name") || cNvPr?.getAttribute("id") || undefined;
}

function normalizeZipTarget(baseDir: string, target: string): string {
  const normalizedTarget = target.replace(/\\/g, "/");
  if (normalizedTarget.startsWith("/")) return normalizedTarget.slice(1);
  return pathPosix.normalize(pathPosix.join(baseDir, normalizedTarget));
}

function copyFileFromZip(entry: { getData: () => Buffer }, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, entry.getData());
}

function presentationSummary(preview: PresentationPreview, cached: boolean): string {
  const parts = [
    cached ? "已加载 PPTX 预览缓存。" : "已生成 PPTX 幻灯片预览。",
    `显示 ${preview.renderedSlideCount} / ${preview.slideCount} 页。`,
  ];
  if (preview.unsupportedCount > 0) {
    parts.push(`${preview.unsupportedCount} 个复杂对象以简化方式处理。`);
  }
  return parts.join(" ");
}

function presentationContent(preview: PresentationPreview): string {
  return preview.slides.map((slide) => [
    `幻灯片 ${slide.index}${slide.title ? `：${slide.title}` : ""}`,
    slide.text || "（未找到可提取文本。）",
  ].join("\n")).join("\n\n");
}

function schemeColor(value: string): string {
  const colors: Record<string, string> = {
    tx1: "#111827",
    tx2: "#374151",
    bg1: "#ffffff",
    bg2: "#f3f4f6",
    accent1: "#2563eb",
    accent2: "#16a34a",
    accent3: "#dc2626",
    accent4: "#9333ea",
    accent5: "#0891b2",
    accent6: "#ea580c",
  };
  return colors[value] || "#111827";
}

function readZipText(zip: AdmZip, path: string): string | null {
  const entry = zip.getEntry(path);
  return entry ? entry.getData().toString("utf8") : null;
}

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, "application/xml");
}

function emuToPx(value: number): number {
  return (value / EMU_PER_INCH) * PX_PER_INCH;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function num(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "0";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
