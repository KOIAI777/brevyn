#!/usr/bin/env python3
"""Produce a unified Office QA report from structural inspection and rendering."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Optional

from office_common import RENDERABLE_EXTENSIONS, default_output_dir, file_type, sha256_file, write_json
from office_ooxml_inspect import inspect_file
from office_render import render_file


def main() -> int:
    parser = argparse.ArgumentParser(description="Create a unified Brevyn Office QA report.")
    parser.add_argument("input", help="Input Office/PDF file")
    parser.add_argument("--outdir", default="", help="Output directory. Defaults to <stem>-office-qa.")
    parser.add_argument("--skip-render", action="store_true", help="Only inspect structure; do not render.")
    parser.add_argument("--dpi", type=int, default=130)
    parser.add_argument("--json", action="store_true", help="Print JSON report only.")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    if not input_path.exists() or input_path.suffix.lower() not in RENDERABLE_EXTENSIONS:
        return fail(f"Unsupported or missing input file: {input_path}", args.json)

    outdir = Path(args.outdir).expanduser().resolve() if args.outdir else default_output_dir(input_path, "office-qa")
    report = build_report(input_path, outdir, skip_render=args.skip_render, dpi=args.dpi)
    write_json(outdir / "office-qa-report.json", report)
    if args.json:
        print(json.dumps(report, indent=2, ensure_ascii=False))
    else:
        print(f"Office QA: {report['status']}")
        print(f"Report: {outdir / 'office-qa-report.json'}")
    return 0 if report["ok"] else 1


def build_report(input_path: Path, outdir: Path, skip_render: bool = False, dpi: int = 130) -> dict[str, Any]:
    outdir.mkdir(parents=True, exist_ok=True)
    fatal_issues: list[str] = []
    warnings: list[str] = []

    inspect_report = inspect_file(input_path) if input_path.suffix.lower() != ".pdf" else pdf_inspect_stub(input_path)
    warnings.extend(prefix_items("inspect", inspect_report.get("warnings", [])))
    fatal_issues.extend(prefix_items("inspect", inspect_report.get("fatalIssues", [])))

    render_report: Optional[dict[str, Any]] = None
    if not skip_render:
        render_report = render_file(input_path, outdir / "render", dpi=dpi)
        warnings.extend(prefix_items("render", render_report.get("warnings", [])))
        fatal_issues.extend(prefix_items("render", render_report.get("fatalIssues", [])))

    status = "ok"
    if fatal_issues:
        status = "failed"
    elif warnings:
        status = "warnings"

    return {
        "ok": not fatal_issues,
        "status": status,
        "fileType": file_type(input_path),
        "input": str(input_path),
        "sourceHash": sha256_file(input_path),
        "summary": {
            "inspect": inspect_report.get("summary", {}),
            "render": render_report.get("summary", {}) if render_report else {},
        },
        "warnings": warnings,
        "fatalIssues": fatal_issues,
        "artifacts": {
            "qaReport": str(outdir / "office-qa-report.json"),
            "inspectReport": str(outdir / "office-inspect-report.json"),
            "renderReport": render_report.get("artifacts", {}).get("report", "") if render_report else "",
            "pdf": render_report.get("artifacts", {}).get("pdf", "") if render_report else "",
            "pages": render_report.get("artifacts", {}).get("pages", []) if render_report else [],
            "contactSheet": render_report.get("artifacts", {}).get("contactSheet", "") if render_report else "",
        },
        "semanticUnits": inspect_report.get("semanticUnits", [])[:500],
    }


def pdf_inspect_stub(input_path: Path) -> dict[str, Any]:
    return {
        "ok": True,
        "status": "ok",
        "fileType": "pdf",
        "input": str(input_path),
        "sourceHash": sha256_file(input_path),
        "summary": {"note": "PDF structure inspection is handled by PDF-specific tools; this QA report covers rendering."},
        "semanticUnits": [],
        "warnings": [],
        "fatalIssues": [],
    }


def prefix_items(prefix: str, values: list[str]) -> list[str]:
    return [f"{prefix}: {value}" for value in values]


def fail(message: str, json_only: bool) -> int:
    payload = {"ok": False, "status": "invalid_input", "warnings": [], "fatalIssues": [message]}
    print(json.dumps(payload, indent=2, ensure_ascii=False) if json_only else message, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
