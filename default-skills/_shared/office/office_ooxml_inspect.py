#!/usr/bin/env python3
"""Inspect OOXML Office files and emit a compact structured inventory."""

from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Any, Optional

from office_common import OFFICE_EXTENSIONS, file_type, sha256_file, strip_xml_tags, write_json


def main() -> int:
    parser = argparse.ArgumentParser(description="Inspect Office OOXML structure.")
    parser.add_argument("input", help="Input .docx/.pptx/.xlsx/.xlsm/.csv/.tsv file")
    parser.add_argument("--out", default="", help="Optional report path.")
    parser.add_argument("--json", action="store_true", help="Print JSON only.")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists() or input_path.suffix.lower() not in OFFICE_EXTENSIONS:
        return fail(f"Unsupported or missing Office file: {input_path}", args.json)

    report = inspect_file(input_path)
    if args.out:
        write_json(Path(args.out).expanduser().resolve(), report)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"Office inspect: {report['status']}")
        print(json.dumps(report["summary"], indent=2, ensure_ascii=False))
    return 0 if report["ok"] else 1


def inspect_file(path: Path) -> dict[str, Any]:
    suffix = path.suffix.lower()
    if suffix in {".csv", ".tsv"}:
        return inspect_delimited(path, "\t" if suffix == ".tsv" else ",")
    try:
        with zipfile.ZipFile(path, "r") as archive:
            names = archive.namelist()
            if suffix == ".docx":
                summary, units = inspect_docx(archive, names)
            elif suffix in {".pptx", ".ppt"}:
                summary, units = inspect_pptx(archive, names)
            elif suffix in {".xlsx", ".xlsm", ".xls"}:
                summary, units = inspect_xlsx(archive, names)
            else:
                summary, units = inspect_generic_ooxml(archive, names)
    except zipfile.BadZipFile:
        return {
            "ok": False,
            "status": "not_ooxml_zip",
            "fileType": file_type(path),
            "input": str(path),
            "sourceHash": sha256_file(path),
            "summary": {},
            "semanticUnits": [],
            "warnings": ["File is not an OOXML zip package; try LibreOffice conversion or a format-specific parser."],
            "fatalIssues": [],
        }
    except Exception as error:  # noqa: BLE001
        return {
            "ok": False,
            "status": "inspect_failed",
            "fileType": file_type(path),
            "input": str(path),
            "sourceHash": sha256_file(path),
            "summary": {},
            "semanticUnits": [],
            "warnings": [],
            "fatalIssues": [str(error)],
        }

    warnings = []
    if not units:
        warnings.append("No semantic units were extracted from OOXML structure.")
    return {
        "ok": True,
        "status": "ok" if not warnings else "warnings",
        "fileType": file_type(path),
        "input": str(path),
        "sourceHash": sha256_file(path),
        "summary": summary,
        "semanticUnits": units[:500],
        "warnings": warnings,
        "fatalIssues": [],
    }


def inspect_docx(archive: zipfile.ZipFile, names: list[str]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    document = read_text(archive, "word/document.xml")
    paragraphs = re.findall(r"<w:p[\s>].*?</w:p>", document, flags=re.S)
    tables = re.findall(r"<w:tbl[\s>].*?</w:tbl>", document, flags=re.S)
    headings = []
    units: list[dict[str, Any]] = []
    for index, paragraph in enumerate(paragraphs, start=1):
        text = compact_text(strip_xml_tags(paragraph))
        style_match = re.search(r'w:val="(Heading\d+|Title|Subtitle)"', paragraph)
        if style_match and text:
            headings.append(text)
            units.append({"type": "document_section", "index": index, "title": text, "style": style_match.group(1)})
    for index, table_xml in enumerate(tables, start=1):
        text = compact_text(strip_xml_tags(table_xml))
        units.append({"type": "table", "index": index, "preview": text[:500]})
    comments = read_text(archive, "word/comments.xml")
    footnotes = read_text(archive, "word/footnotes.xml")
    endnotes = read_text(archive, "word/endnotes.xml")
    media = [name for name in names if name.startswith("word/media/")]
    summary = {
        "paragraphCount": len(paragraphs),
        "tableCount": len(tables),
        "headingCount": len(headings),
        "headings": headings[:50],
        "imageCount": len(media),
        "commentCount": comments.count("<w:comment"),
        "footnoteCount": max(0, footnotes.count("<w:footnote") - 2) if footnotes else 0,
        "endnoteCount": max(0, endnotes.count("<w:endnote") - 2) if endnotes else 0,
        "trackedInsertions": document.count("<w:ins"),
        "trackedDeletions": document.count("<w:del"),
        "media": media[:100],
    }
    return summary, units


def inspect_pptx(archive: zipfile.ZipFile, names: list[str]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    slide_parts = sorted([name for name in names if re.match(r"ppt/slides/slide\d+\.xml$", name)], key=natural_key)
    note_parts = sorted([name for name in names if re.match(r"ppt/notesSlides/notesSlide\d+\.xml$", name)], key=natural_key)
    chart_parts = sorted([name for name in names if name.startswith("ppt/charts/") and name.endswith(".xml")])
    media = [name for name in names if name.startswith("ppt/media/")]
    units: list[dict[str, Any]] = []
    hidden_count = 0
    table_count = 0
    for index, slide_part in enumerate(slide_parts, start=1):
        xml = read_text(archive, slide_part)
        text = compact_text(strip_xml_tags(xml))
        if 'show="0"' in xml:
            hidden_count += 1
        tables = xml.count("<a:tbl")
        table_count += tables
        units.append({"type": "slide", "slideNumber": index, "part": slide_part, "tableCount": tables, "preview": text[:500]})
    for index, note_part in enumerate(note_parts, start=1):
        text = compact_text(strip_xml_tags(read_text(archive, note_part)))
        if text:
            units.append({"type": "speaker_note", "slideNumber": index, "part": note_part, "preview": text[:500]})
    summary = {
        "slideCount": len(slide_parts),
        "hiddenSlideCount": hidden_count,
        "notesCount": len(note_parts),
        "chartCount": len(chart_parts),
        "tableCount": table_count,
        "imageCount": len(media),
        "charts": chart_parts[:100],
        "media": media[:100],
        "themes": [name for name in names if re.match(r"ppt/theme/theme\d+\.xml$", name)][:20],
        "masters": [name for name in names if re.match(r"ppt/slideMasters/slideMaster\d+\.xml$", name)][:50],
        "layouts": [name for name in names if re.match(r"ppt/slideLayouts/slideLayout\d+\.xml$", name)][:100],
    }
    return summary, units


def inspect_xlsx(archive: zipfile.ZipFile, names: list[str]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    workbook = read_text(archive, "xl/workbook.xml")
    sheet_entries = re.findall(r'<sheet[^>]*name="([^"]+)"[^>]*sheetId="([^"]+)"[^>]*/?>', workbook)
    sheet_parts = sorted([name for name in names if re.match(r"xl/worksheets/sheet\d+\.xml$", name)], key=natural_key)
    chart_parts = sorted([name for name in names if name.startswith("xl/charts/") and name.endswith(".xml")])
    drawing_parts = sorted([name for name in names if name.startswith("xl/drawings/") and name.endswith(".xml")])
    table_parts = sorted([name for name in names if name.startswith("xl/tables/") and name.endswith(".xml")])
    comments = sorted([name for name in names if name.startswith("xl/comments") and name.endswith(".xml")])
    units: list[dict[str, Any]] = []
    formula_count = 0
    merged_count = 0
    for index, sheet_part in enumerate(sheet_parts, start=1):
        xml = read_text(archive, sheet_part)
        sheet_name = sheet_entries[index - 1][0] if index - 1 < len(sheet_entries) else f"Sheet{index}"
        sheet_formulas = xml.count("<f")
        formula_count += sheet_formulas
        merged = xml.count("<mergeCell")
        merged_count += merged
        dimension = regex_value(xml, r'<dimension ref="([^"]+)"') or ""
        units.append({
            "type": "worksheet",
            "sheetName": sheet_name,
            "sheetNumber": index,
            "part": sheet_part,
            "dimension": dimension,
            "formulaCount": sheet_formulas,
            "mergedCellCount": merged,
        })
    for index, chart_part in enumerate(chart_parts, start=1):
        xml = read_text(archive, chart_part)
        title = compact_text(strip_xml_tags(regex_value(xml, r"<c:title>(.*?)</c:title>", flags=re.S) or ""))
        units.append({"type": "chart", "index": index, "part": chart_part, "title": title[:200]})
    summary = {
        "sheetCount": len(sheet_parts),
        "sheets": [entry[0] for entry in sheet_entries] or [f"Sheet{index}" for index in range(1, len(sheet_parts) + 1)],
        "formulaCount": formula_count,
        "chartCount": len(chart_parts),
        "tableCount": len(table_parts),
        "drawingCount": len(drawing_parts),
        "commentPartCount": len(comments),
        "mergedCellCount": merged_count,
        "charts": chart_parts[:100],
        "tables": table_parts[:100],
        "drawings": drawing_parts[:100],
    }
    return summary, units


def inspect_generic_ooxml(archive: zipfile.ZipFile, names: list[str]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    return {"partCount": len(names), "mediaCount": len([name for name in names if "/media/" in name])}, []


def inspect_delimited(path: Path, delimiter: str) -> dict[str, Any]:
    rows = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for index, line in enumerate(handle):
            if index >= 50:
                break
            rows.append(line.rstrip("\n").split(delimiter))
    width = max((len(row) for row in rows), default=0)
    return {
        "ok": True,
        "status": "ok",
        "fileType": file_type(path),
        "input": str(path),
        "sourceHash": sha256_file(path),
        "summary": {"rowSampleCount": len(rows), "columnCount": width, "delimiter": "\\t" if delimiter == "\t" else delimiter},
        "semanticUnits": [{"type": "table", "sheetName": "CSV" if delimiter == "," else "TSV", "range": f"A1:{width}:{len(rows)}", "previewRows": rows[:10]}],
        "warnings": [],
        "fatalIssues": [],
    }


def read_text(archive: zipfile.ZipFile, name: str) -> str:
    try:
        return archive.read(name).decode("utf-8", errors="ignore")
    except KeyError:
        return ""


def compact_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def regex_value(value: str, pattern: str, flags: int = 0) -> Optional[str]:
    match = re.search(pattern, value, flags)
    return match.group(1) if match else None


def natural_key(value: str) -> tuple[Any, ...]:
    return tuple(int(part) if part.isdigit() else part for part in re.split(r"(\d+)", value))


def fail(message: str, json_only: bool) -> int:
    payload = {"ok": False, "status": "invalid_input", "warnings": [], "fatalIssues": [message]}
    print(json.dumps(payload, indent=2, ensure_ascii=False) if json_only else message, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
