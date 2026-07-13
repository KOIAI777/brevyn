#!/usr/bin/env python3
"""Runtime preflight for the ppt-master skill.

The script intentionally stays compatible with Python 3.8+ so it can explain a
too-old interpreter before the rest of the skill hits newer typing syntax.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import sys
from pathlib import Path


MIN_PYTHON = (3, 10)
RECOMMENDED_PYTHON = "3.11"

REQUIRED_MODULES = [
    ("pptx", "python-pptx", "PPTX export and PPTX source intake"),
    ("xlsxwriter", "XlsxWriter", "native workbook/chart export"),
    ("svglib", "svglib", "SVG fallback conversion"),
    ("reportlab", "reportlab", "SVG fallback rendering"),
    ("fitz", "PyMuPDF", "PDF source conversion"),
    ("mammoth", "mammoth", "DOCX source conversion"),
    ("markdownify", "markdownify", "HTML/EPUB source conversion"),
    ("bs4", "beautifulsoup4", "HTML source conversion"),
    ("openpyxl", "openpyxl", "XLSX source conversion"),
    ("PIL", "Pillow", "image analysis and processing"),
    ("numpy", "numpy", "image analysis helpers"),
    ("requests", "requests", "web source and image helpers"),
    ("flask", "flask", "confirmation and live preview helpers"),
]

OPTIONAL_MODULES = [
    ("curl_cffi", "curl_cffi", "web pages that block standard Python TLS fingerprints"),
    ("ebooklib", "ebooklib", "EPUB source conversion"),
    ("nbconvert", "nbconvert", "Jupyter notebook source conversion"),
    ("google.genai", "google-genai", "Gemini image generation backend"),
    ("edge_tts", "edge-tts", "recorded narration audio"),
    ("playwright", "playwright", "optional visual review workflow"),
    ("cairosvg", "CairoSVG", "higher-fidelity SVG to PNG fallback; may also need system cairo"),
]


def module_available(name: str) -> bool:
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, AttributeError, ValueError):
        return False


def check_modules(modules: list[tuple[str, str, str]]) -> list[dict[str, str]]:
    missing = []
    for module_name, package_name, purpose in modules:
        if not module_available(module_name):
            missing.append({
                "module": module_name,
                "package": package_name,
                "purpose": purpose,
            })
    return missing


def requirements_path() -> Path:
    return Path(__file__).resolve().parents[1] / "requirements.txt"


def python_command() -> str:
    executable = sys.executable or "python3"
    return executable if Path(executable).exists() else "python3"


def install_command() -> str:
    return "{} -m pip install -r {}".format(python_command(), shell_quote(str(requirements_path())))


def shell_quote(value: str) -> str:
    if not value:
        return "''"
    safe = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_/:=-."
    if all(char in safe for char in value):
        return value
    return "'" + value.replace("'", "'\"'\"'") + "'"


def build_result() -> dict[str, object]:
    python_version = "{}.{}.{}".format(sys.version_info.major, sys.version_info.minor, sys.version_info.micro)
    python_too_old = (sys.version_info.major, sys.version_info.minor) < MIN_PYTHON
    missing_required = [] if python_too_old else check_modules(REQUIRED_MODULES)
    missing_optional = [] if python_too_old else check_modules(OPTIONAL_MODULES)

    status = "ok"
    if python_too_old or missing_required:
        status = "failed"
    elif missing_optional:
        status = "warning"

    messages = []
    if python_too_old:
        messages.append(
            "Python {} is too old. ppt-master requires Python {}+ and recommends Python {}.".format(
                python_version,
                "{}.{}".format(MIN_PYTHON[0], MIN_PYTHON[1]),
                RECOMMENDED_PYTHON,
            )
        )
    if missing_required:
        messages.append(
            "Missing required Python packages: {}.".format(
                ", ".join(item["package"] for item in missing_required)
            )
        )
    if missing_optional:
        messages.append(
            "Optional features unavailable until these packages are installed: {}.".format(
                ", ".join(item["package"] for item in missing_optional)
            )
        )

    return {
        "status": status,
        "python": {
            "executable": sys.executable,
            "version": python_version,
            "platform": platform.platform(),
            "minimum": "{}.{}".format(MIN_PYTHON[0], MIN_PYTHON[1]),
            "recommended": RECOMMENDED_PYTHON,
        },
        "requirements": str(requirements_path()),
        "missingRequired": missing_required,
        "missingOptional": missing_optional,
        "installCommand": install_command(),
        "messages": messages,
    }


def print_text(result: dict[str, object]) -> None:
    status = str(result["status"])
    python_info = result["python"]  # type: ignore[index]
    print("ppt-master runtime preflight: {}".format(status))
    print("Python: {} ({})".format(python_info["version"], python_info["executable"]))  # type: ignore[index]
    for message in result["messages"]:  # type: ignore[index]
        print("- {}".format(message))
    if status == "failed":
        print("")
        print("Repair command:")
        print(result["installCommand"])


def main() -> int:
    parser = argparse.ArgumentParser(description="Check ppt-master runtime dependencies.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON.")
    args = parser.parse_args()

    result = build_result()
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print_text(result)
    return 0 if result["status"] in {"ok", "warning"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
