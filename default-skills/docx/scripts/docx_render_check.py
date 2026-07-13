#!/usr/bin/env python3
"""Render-check a DOCX for Brevyn Office QA."""

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
from PIL import Image, ImageChops


PLACEHOLDER_PATTERN = re.compile(r"\b(lorem|ipsum|todo|placeholder|xxxx|insert text|sample text)\b", re.I)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render-check a DOCX and emit a QA report.")
    parser.add_argument("docx", help="Input .docx file")
    parser.add_argument("--outdir", default="", help="Output directory for rendered pages/report")
    parser.add_argument("--dpi", type=int, default=130)
    parser.add_argument("--json", action="store_true", help="Print JSON report only")
    args = parser.parse_args()

    docx = Path(args.docx).expanduser().resolve()
    if not docx.exists() or docx.suffix.lower() != ".docx":
        return fail(f"Invalid DOCX file: {docx}", args.json)

    outdir = Path(args.outdir).expanduser().resolve() if args.outdir else docx.with_suffix("").parent / f"{docx.stem}-render-check"
    outdir.mkdir(parents=True, exist_ok=True)

    report = render_check(docx, outdir, args.dpi)
    report_path = outdir / "docx-render-report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"DOCX render check: {report['status']}")
        print(f"Report: {report_path}")
    return 0 if report["ok"] else 1


def render_check(docx: Path, outdir: Path, dpi: int) -> dict[str, Any]:
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        pdf_path = convert_to_pdf(docx, tmpdir)
        if not pdf_path:
            return base_report(docx, outdir, "render_failed", ["LibreOffice PDF conversion failed"])
        pages = convert_pdf_to_images(pdf_path, outdir, dpi)
        if not pages:
            return base_report(docx, outdir, "render_failed", ["Poppler image conversion failed"])

    placeholder_hits = extract_placeholder_hits(docx)
    blank_pages = [str(path) for path in pages if is_blank_image(path)]
    warnings = []
    if blank_pages:
        warnings.append(f"{len(blank_pages)} rendered page(s) appear blank")
    if placeholder_hits:
        warnings.append(f"{len(placeholder_hits)} placeholder text hit(s) found")
    status = "ok" if not warnings else "warnings"
    return {
        **base_report(docx, outdir, status, warnings),
        "ok": True,
        "pageCount": len(pages),
        "renderedPages": [str(path) for path in pages],
        "blankPages": blank_pages,
        "placeholderHits": placeholder_hits[:50],
    }


def base_report(docx: Path, outdir: Path, status: str, warnings: list[str]) -> dict[str, Any]:
    return {
        "ok": status != "render_failed",
        "status": status,
        "input": str(docx),
        "outdir": str(outdir),
        "warnings": warnings,
    }


def convert_to_pdf(docx: Path, tmpdir: Path) -> Optional[Path]:
    soffice = resolve_soffice()
    if not soffice:
        return None
    profile = tmpdir / "lo-profile"
    profile.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [soffice, "--headless", f"-env:UserInstallation={profile.resolve().as_uri()}", "--convert-to", "pdf", "--outdir", str(tmpdir), str(docx)],
        capture_output=True,
        text=True,
        env=get_soffice_env(),
    )
    pdf_path = tmpdir / f"{docx.stem}.pdf"
    return pdf_path if result.returncode == 0 and pdf_path.exists() else None


def convert_pdf_to_images(pdf_path: Path, outdir: Path, dpi: int) -> list[Path]:
    prefix = outdir / "page"
    result = subprocess.run(
        ["pdftoppm", "-png", "-r", str(dpi), str(pdf_path), str(prefix)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []
    return sorted(outdir.glob("page-*.png"))


def extract_placeholder_hits(docx: Path) -> list[dict[str, str]]:
    hits: list[dict[str, str]] = []
    try:
        with zipfile.ZipFile(docx, "r") as archive:
            for name in archive.namelist():
                if not name.startswith("word/") or not name.endswith(".xml"):
                    continue
                text = archive.read(name).decode("utf-8", errors="ignore")
                for match in PLACEHOLDER_PATTERN.finditer(strip_xml(text)):
                    hits.append({"part": name, "text": match.group(0)})
    except Exception as error:  # noqa: BLE001
        hits.append({"part": "docx", "text": f"placeholder scan failed: {error}"})
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


def fail(message: str, json_only: bool) -> int:
    payload = {"ok": False, "status": "invalid_input", "warnings": [message]}
    print(json.dumps(payload, indent=2) if json_only else message, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
