"""Resolve and run LibreOffice for Brevyn Office skills."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

_SHARED_OFFICE = Path(__file__).resolve().parents[3] / "_shared" / "office"
if _SHARED_OFFICE.exists():
    sys.path.insert(0, str(_SHARED_OFFICE))

try:
    from office_common import get_soffice_env as _shared_soffice_env
    from office_common import resolve_soffice as _shared_resolve_soffice
except ImportError:
    _shared_soffice_env = None
    _shared_resolve_soffice = None


def resolve_soffice() -> Optional[str]:
    if _shared_resolve_soffice:
        return _shared_resolve_soffice()
    explicit = os.environ.get("BREVYN_SOFFICE_PATH", "").strip()
    if explicit and Path(explicit).exists():
        return explicit
    return shutil.which("soffice") or shutil.which("soffice.exe")


def get_soffice_env() -> dict[str, str]:
    if _shared_soffice_env:
        return _shared_soffice_env()
    env = os.environ.copy()
    env["SAL_USE_VCLPLUGIN"] = "svp"
    soffice = resolve_soffice()
    if soffice:
        executable_dir = str(Path(soffice).parent)
        path_parts = [part for part in env.get("PATH", "").split(os.pathsep) if part]
        if executable_dir not in path_parts:
            env["PATH"] = os.pathsep.join([executable_dir, *path_parts])
        env["BREVYN_SOFFICE_PATH"] = soffice
    return env


def run_soffice(args: list[str], **kwargs) -> subprocess.CompletedProcess:
    soffice = resolve_soffice()
    if not soffice:
        raise FileNotFoundError("LibreOffice runtime is unavailable")
    env = get_soffice_env()
    supplied_env = kwargs.pop("env", None)
    if supplied_env:
        env.update(supplied_env)
    return subprocess.run([soffice, *args], env=env, **kwargs)


if __name__ == "__main__":
    result = run_soffice(sys.argv[1:])
    raise SystemExit(result.returncode)
