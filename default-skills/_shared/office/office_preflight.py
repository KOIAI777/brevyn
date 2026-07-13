#!/usr/bin/env python3
"""Lightweight Office runtime preflight for Brevyn default skills.

Checks whether the local runtime can perform common Office QA tasks:
LibreOffice conversion, Poppler PDF rasterization, and Python package imports.
The script is intentionally dependency-light and returns machine-readable JSON.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from office_common import get_soffice_env, resolve_soffice


DEFAULT_PACKAGES = [
    "openpyxl",
    "PIL",
    "defusedxml",
]


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""
    path: str = ""
    version: str = ""

    def to_json(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "ok": self.ok,
            "detail": self.detail,
            "path": self.path,
            "version": self.version,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Check Brevyn Office QA runtime dependencies.")
    parser.add_argument("--json", action="store_true", help="Emit JSON only.")
    parser.add_argument("--packages", nargs="*", default=DEFAULT_PACKAGES, help="Python packages to import-check.")
    args = parser.parse_args()

    checks = [
        python_check(),
        soffice_check(),
        command_check("pdftoppm", ["pdftoppm", "-v"], explicit_path=os.environ.get("BREVYN_PDFTOPPM_PATH", "")),
    ]
    checks.extend(package_check(name) for name in args.packages)

    ok = all(check.ok for check in checks)
    missing = [check.name for check in checks if not check.ok]
    result = {
        "ok": ok,
        "status": "ok" if ok else "missing_dependencies",
        "checks": [check.to_json() for check in checks],
        "missing": missing,
        "repairHint": repair_hint(missing),
    }

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(f"Brevyn Office preflight: {'ok' if ok else 'missing dependencies'}")
        for check in checks:
            marker = "OK" if check.ok else "MISSING"
            suffix = f" ({check.version})" if check.version else ""
            print(f"- {marker}: {check.name}{suffix} {check.path}".rstrip())
        if not ok:
            print(f"Repair hint: {result['repairHint']}")
    return 0 if ok else 1


def python_check() -> Check:
    version = ".".join(str(part) for part in sys.version_info[:3])
    ok = sys.version_info >= (3, 9)
    return Check("python>=3.9", ok, path=sys.executable, version=version)


def soffice_check() -> Check:
    path = resolve_soffice()
    if not path:
        return Check("soffice", False, detail="Bundled or system LibreOffice runtime not found")
    return command_check("soffice", [path, "--headless", "--version"], explicit_path=path, env=get_soffice_env())


def command_check(
    name: str,
    command: list[str],
    explicit_path: str = "",
    env: Optional[dict[str, str]] = None,
) -> Check:
    path = explicit_path if explicit_path and Path(explicit_path).exists() else shutil.which(command[0])
    if not path:
        return Check(name, False, detail=f"{command[0]} not found")
    executable_command = [path, *command[1:]]
    try:
        result = subprocess.run(executable_command, capture_output=True, text=True, timeout=20, check=False, env=env)
        output = (result.stdout or result.stderr or "").strip().splitlines()
        version = output[0] if output else ""
        return Check(name, result.returncode == 0 or bool(output), path=path, version=version)
    except Exception as error:  # noqa: BLE001 - preflight must report any runtime failure.
        return Check(name, False, detail=str(error), path=path)


def package_check(name: str) -> Check:
    found = importlib.util.find_spec(name) is not None
    return Check(f"python:{name}", found, detail="" if found else f"Python package {name} not importable")


def repair_hint(missing: list[str]) -> str:
    hints: list[str] = []
    if "soffice" in missing:
        hints.append("restart Brevyn to restore its bundled LibreOffice runtime, or install LibreOffice")
    if "pdftoppm" in missing:
        hints.append("install Poppler and ensure `pdftoppm` is on PATH")
    packages = [item.replace("python:", "") for item in missing if item.startswith("python:")]
    if packages:
        hints.append(f"install Python packages: {' '.join(packages)}")
    return "; ".join(hints) if hints else "no repair needed"


if __name__ == "__main__":
    raise SystemExit(main())
