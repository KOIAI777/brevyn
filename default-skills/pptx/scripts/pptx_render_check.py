#!/usr/bin/env python3
"""Render-check a PPTX for Brevyn Office QA.

Produces slide PNGs/JPEGs, a contact sheet, and a JSON report with basic
failure signals: conversion failure, blank slides, and placeholder text.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from office.soffice import get_soffice_env, resolve_soffice
from PIL import Image, ImageChops, ImageDraw


PLACEHOLDER_PATTERN = re.compile(r"\b(lorem|ipsum|todo|placeholder|xxxx|insert text|click to add)\b", re.I)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render-check a PPTX and emit a QA report.")
    parser.add_argument("pptx", help="Input .pptx file")
    parser.add_argument("--outdir", default="", help="Output directory for rendered slides/report")
    parser.add_argument("--dpi", type=int, default=130)
    parser.add_argument("--json", action="store_true", help="Print JSON report only")
    args = parser.parse_args()

    pptx = Path(args.pptx).expanduser().resolve()
    if not pptx.exists() or pptx.suffix.lower() != ".pptx":
        return fail(f"Invalid PPTX file: {pptx}", args.json)

    outdir = Path(args.outdir).expanduser().resolve() if args.outdir else pptx.with_suffix("").parent / f"{pptx.stem}-render-check"
    outdir.mkdir(parents=True, exist_ok=True)

    report = render_check(pptx, outdir, args.dpi)
    report_path = outdir / "pptx-render-report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"PPTX render check: {report['status']}")
        print(f"Report: {report_path}")
        if report.get("contactSheet"):
            print(f"Contact sheet: {report['contactSheet']}")
    return 0 if report["ok"] else 1


def render_check(pptx: Path, outdir: Path, dpi: int) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        pdf_path = convert_to_pdf(pptx, tmpdir)
        if not pdf_path:
            return base_report(pptx, outdir, "render_failed", ["LibreOffice PDF conversion failed"])
        images = convert_pdf_to_images(pdf_path, outdir, dpi)
        if not images:
            return base_report(pptx, outdir, "render_failed", ["Poppler image conversion failed"])

    placeholder_hits = extract_placeholder_hits(pptx)
    blank_slides = [str(path) for path in images if is_blank_image(path)]
    contact_sheet = create_contact_sheet(images, outdir / "contact-sheet.jpg")
    warnings = []
    if blank_slides:
        warnings.append(f"{len(blank_slides)} rendered slide(s) appear blank")
    if placeholder_hits:
        warnings.append(f"{len(placeholder_hits)} placeholder text hit(s) found")
    status = "ok" if not warnings else "warnings"
    return {
        **base_report(pptx, outdir, status, warnings),
        "ok": True,
        "slideCount": len(images),
        "renderedSlides": [str(path) for path in images],
        "blankSlides": blank_slides,
        "placeholderHits": placeholder_hits[:50],
        "contactSheet": str(contact_sheet) if contact_sheet else "",
    }


def base_report(pptx: Path, outdir: Path, status: str, warnings: list[str]) -> dict[str, Any]:
    return {
        "ok": status != "render_failed",
        "status": status,
        "input": str(pptx),
        "outdir": str(outdir),
        "warnings": warnings,
    }


def convert_to_pdf(pptx: Path, tmpdir: Path) -> Optional[Path]:
    soffice = resolve_soffice()
    if not soffice:
        return None
    profile = tmpdir / "lo-profile"
    profile.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [soffice, "--headless", f"-env:UserInstallation={profile.resolve().as_uri()}", "--convert-to", "pdf", "--outdir", str(tmpdir), str(pptx)],
        capture_output=True,
        text=True,
        env=get_soffice_env(),
    )
    pdf_path = tmpdir / f"{pptx.stem}.pdf"
    return pdf_path if result.returncode == 0 and pdf_path.exists() else None


def convert_pdf_to_images(pdf_path: Path, outdir: Path, dpi: int) -> list[Path]:
    prefix = outdir / "slide"
    result = subprocess.run(
        ["pdftoppm", "-jpeg", "-r", str(dpi), str(pdf_path), str(prefix)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []
    return sorted(outdir.glob("slide-*.jpg"))


def extract_placeholder_hits(pptx: Path) -> list[dict[str, str]]:
    hits: list[dict[str, str]] = []
    try:
        with zipfile.ZipFile(pptx, "r") as archive:
            for name in archive.namelist():
                if not name.startswith("ppt/slides/slide") or not name.endswith(".xml"):
                    continue
                text = archive.read(name).decode("utf-8", errors="ignore")
                for match in PLACEHOLDER_PATTERN.finditer(strip_xml(text)):
                    hits.append({"part": name, "text": match.group(0)})
    except Exception as error:  # noqa: BLE001
        hits.append({"part": "pptx", "text": f"placeholder scan failed: {error}"})
    return hits


def strip_xml(value: str) -> str:
    return re.sub(r"<[^>]+>", " ", value)


def is_blank_image(path: Path) -> bool:
    try:
        with Image.open(path).convert("RGB") as image:
            bbox = ImageChops.difference(image, Image.new("RGB", image.size, image.getpixel((0, 0)))).getbbox()
            return bbox is None
    except Exception:
        return False


def create_contact_sheet(images: list[Path], output: Path) -> Optional[Path]:
    if not images:
        return None
    thumbs = []
    for index, path in enumerate(images, start=1):
        with Image.open(path).convert("RGB") as image:
            image.thumbnail((320, 180))
            canvas = Image.new("RGB", (340, 220), "white")
            canvas.paste(image, ((340 - image.width) // 2, 12))
            draw = ImageDraw.Draw(canvas)
            draw.text((12, 194), f"Slide {index}", fill="black")
            thumbs.append(canvas)
    cols = min(4, len(thumbs))
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * 340, rows * 220), "#f4f4f4")
    for index, thumb in enumerate(thumbs):
        sheet.paste(thumb, ((index % cols) * 340, (index // cols) * 220))
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, quality=92)
    return output


def fail(message: str, json_only: bool) -> int:
    payload = {"ok": False, "status": "invalid_input", "warnings": [message]}
    print(json.dumps(payload, indent=2) if json_only else message, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
