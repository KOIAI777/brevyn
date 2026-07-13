#!/usr/bin/env python3
"""Render Office/PDF files to PDF, page images, and a contact sheet."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from office_common import (
    RENDERABLE_EXTENSIONS,
    blank_images,
    convert_office_to_pdf,
    copy_pdf,
    create_contact_sheet,
    default_output_dir,
    file_type,
    pdf_to_images,
    sha256_file,
    write_json,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render Office/PDF files through LibreOffice/Poppler.")
    parser.add_argument("input", help="Input .docx/.pptx/.xlsx/.pdf file")
    parser.add_argument("--outdir", default="", help="Output directory. Defaults to <stem>-office-render.")
    parser.add_argument("--dpi", type=int, default=130, help="Rasterization DPI.")
    parser.add_argument("--format", choices=["png", "jpg"], default="png", help="Rendered page image format.")
    parser.add_argument("--json", action="store_true", help="Print JSON report only.")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists() or input_path.suffix.lower() not in RENDERABLE_EXTENSIONS:
        return fail(f"Unsupported or missing input file: {input_path}", args.json)

    outdir = Path(args.outdir).expanduser().resolve() if args.outdir else default_output_dir(input_path, "office-render")
    report = render_file(input_path, outdir, dpi=args.dpi, image_format=args.format)
    write_json(outdir / "office-render-report.json", report)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"Office render: {report['status']}")
        print(f"Report: {outdir / 'office-render-report.json'}")
        if report["artifacts"].get("contactSheet"):
            print(f"Contact sheet: {report['artifacts']['contactSheet']}")
    return 0 if report["ok"] else 1


def render_file(input_path: Path, outdir: Path, dpi: int = 130, image_format: str = "png") -> dict[str, Any]:
    outdir.mkdir(parents=True, exist_ok=True)
    fatal_issues: list[str] = []
    warnings: list[str] = []
    file_ext = input_path.suffix.lower()

    if file_ext == ".pdf":
        pdf_path = copy_pdf(input_path, outdir)
        conversion_message = ""
    else:
        pdf_path, conversion_message = convert_office_to_pdf(input_path, outdir)
        if not pdf_path:
            fatal_issues.append(conversion_message or "LibreOffice conversion failed")
            return base_report(input_path, outdir, "render_failed", warnings, fatal_issues)

    page_dir = outdir / "pages"
    pages, raster_message = pdf_to_images(pdf_path, page_dir, dpi=dpi, fmt=image_format)
    if not pages:
        fatal_issues.append(raster_message or "PDF rasterization failed")
        return {
            **base_report(input_path, outdir, "render_failed", warnings, fatal_issues),
            "artifacts": {"pdf": str(pdf_path), "pages": [], "contactSheet": ""},
        }

    blanks = blank_images(pages)
    if blanks:
        warnings.append(f"{len(blanks)} rendered page(s) appear blank")
    contact_sheet, contact_warning = create_contact_sheet(pages, outdir / "contact-sheet.jpg")
    if contact_warning and not contact_sheet:
        warnings.append(contact_warning)

    status = "warnings" if warnings else "ok"
    return {
        "ok": True,
        "status": status,
        "fileType": file_type(input_path),
        "input": str(input_path),
        "sourceHash": sha256_file(input_path),
        "summary": {
            "pageCount": len(pages),
            "dpi": dpi,
            "imageFormat": image_format,
            "conversionMessage": conversion_message,
        },
        "warnings": warnings,
        "fatalIssues": fatal_issues,
        "artifacts": {
            "pdf": str(pdf_path),
            "pages": [str(path) for path in pages],
            "blankPages": blanks,
            "contactSheet": str(contact_sheet) if contact_sheet else "",
            "report": str(outdir / "office-render-report.json"),
        },
    }


def base_report(input_path: Path, outdir: Path, status: str, warnings: list[str], fatal_issues: list[str]) -> dict[str, Any]:
    return {
        "ok": False,
        "status": status,
        "fileType": file_type(input_path),
        "input": str(input_path),
        "sourceHash": sha256_file(input_path) if input_path.exists() else "",
        "summary": {},
        "warnings": warnings,
        "fatalIssues": fatal_issues,
        "artifacts": {"pdf": "", "pages": [], "blankPages": [], "contactSheet": "", "report": str(outdir / "office-render-report.json")},
    }


def fail(message: str, json_only: bool) -> int:
    payload = {"ok": False, "status": "invalid_input", "warnings": [], "fatalIssues": [message]}
    print(json.dumps(payload, indent=2, ensure_ascii=False) if json_only else message, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
