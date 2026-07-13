#!/usr/bin/env python3
"""Shared helpers for Brevyn Office skill scripts."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path
from typing import Any, Optional

OFFICE_EXTENSIONS = {".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".xlsm", ".csv", ".tsv"}
RENDERABLE_EXTENSIONS = OFFICE_EXTENSIONS | {".pdf"}
_SOFFICE_CACHE: Optional[str] = None


def resolve_soffice(prepare: bool = True) -> Optional[str]:
    global _SOFFICE_CACHE
    if _SOFFICE_CACHE and Path(_SOFFICE_CACHE).exists():
        return _SOFFICE_CACHE

    explicit = os.environ.get("BREVYN_SOFFICE_PATH", "").strip()
    runtime_value = os.environ.get("BREVYN_LIBREOFFICE_RUNTIME_DIR", "").strip()
    runtime_dir = Path(runtime_value).expanduser() if runtime_value else None
    for candidate in _soffice_candidates(runtime_dir, explicit):
        if candidate.exists():
            _SOFFICE_CACHE = str(candidate)
            return _SOFFICE_CACHE

    archive_value = os.environ.get("BREVYN_LIBREOFFICE_ARCHIVE", "").strip()
    archive = Path(archive_value).expanduser() if archive_value else None
    if prepare and archive and archive.exists() and runtime_dir:
        extracted = _prepare_bundled_runtime(archive, runtime_dir)
        if extracted:
            _SOFFICE_CACHE = str(extracted)
            return _SOFFICE_CACHE

    system_soffice = shutil.which("soffice") or shutil.which("soffice.exe")
    if system_soffice:
        _SOFFICE_CACHE = system_soffice
        return _SOFFICE_CACHE
    return None


def file_type(path: Path) -> str:
    suffix = path.suffix.lower().lstrip(".")
    return suffix or "unknown"


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def sha256_file(path: Path, limit_bytes: Optional[int] = None) -> str:
    digest = hashlib.sha256()
    remaining = limit_bytes
    with path.open("rb") as handle:
        while True:
            size = 1024 * 1024 if remaining is None else min(1024 * 1024, remaining)
            if size <= 0:
                break
            chunk = handle.read(size)
            if not chunk:
                break
            digest.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
    return digest.hexdigest()


def default_output_dir(input_path: Path, suffix: str) -> Path:
    return input_path.with_suffix("").parent / f"{input_path.stem}-{suffix}"


def get_soffice_env() -> dict[str, str]:
    env = os.environ.copy()
    env["SAL_USE_VCLPLUGIN"] = "svp"
    soffice = resolve_soffice()
    if soffice:
        env["BREVYN_SOFFICE_PATH"] = soffice
        executable_dir = str(Path(soffice).parent)
        current_path = env.get("PATH", "")
        path_parts = [part for part in current_path.split(os.pathsep) if part]
        if executable_dir not in path_parts:
            env["PATH"] = os.pathsep.join([executable_dir, *path_parts])
    if _needs_socket_shim():
        shim = _ensure_socket_shim()
        env["LD_PRELOAD"] = str(shim)
    return env


def convert_office_to_pdf(input_path: Path, outdir: Path, timeout: int = 90) -> tuple[Optional[Path], str]:
    outdir.mkdir(parents=True, exist_ok=True)
    soffice = resolve_soffice()
    if not soffice:
        return None, "soffice not found"

    with tempfile.TemporaryDirectory(prefix="brevyn-lo-profile-") as profile:
        profile_uri = Path(profile).resolve().as_uri()
        result = subprocess.run(
            [soffice, "--headless", f"-env:UserInstallation={profile_uri}", "--convert-to", "pdf", "--outdir", str(outdir), str(input_path)],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=get_soffice_env(),
            check=False,
        )
    produced = outdir / f"{input_path.stem}.pdf"
    if result.returncode != 0 or not produced.exists():
        message = (result.stderr or result.stdout or "LibreOffice PDF conversion failed").strip()
        return None, message

    normalized = outdir / "render.pdf"
    if produced != normalized:
        normalized.unlink(missing_ok=True)
        produced.rename(normalized)
    return normalized, ""


def _soffice_candidates(runtime_dir: Optional[Path], explicit: str = "") -> list[Path]:
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    if runtime_dir:
        if sys.platform == "darwin":
            candidates.extend([
                runtime_dir / "LibreOffice.app" / "Contents" / "MacOS" / "soffice",
                runtime_dir / "LibreOfficeDev.app" / "Contents" / "MacOS" / "soffice",
                runtime_dir / "libreoffice" / "LibreOffice.app" / "Contents" / "MacOS" / "soffice",
                runtime_dir / "libreoffice" / "LibreOfficeDev.app" / "Contents" / "MacOS" / "soffice",
            ])
        elif os.name == "nt":
            candidates.extend([
                runtime_dir / "LibreOffice" / "program" / "soffice.exe",
                runtime_dir / "program" / "soffice.exe",
                runtime_dir / "libreoffice" / "program" / "soffice.exe",
            ])
        else:
            candidates.extend([
                runtime_dir / "libreoffice" / "program" / "soffice",
                runtime_dir / "program" / "soffice",
                runtime_dir / "usr" / "bin" / "soffice",
            ])
    return candidates


def _prepare_bundled_runtime(archive: Path, runtime_dir: Path) -> Optional[Path]:
    expected_sha256 = os.environ.get("BREVYN_LIBREOFFICE_ARCHIVE_SHA256", "").strip().lower()
    if expected_sha256 and sha256_file(archive) != expected_sha256:
        return None

    lock_dir = Path(f"{runtime_dir}.extracting")
    deadline = time.monotonic() + 180
    owns_lock = False
    runtime_dir.parent.mkdir(parents=True, exist_ok=True)
    while not owns_lock:
        try:
            lock_dir.mkdir()
            owns_lock = True
        except FileExistsError:
            ready = next((path for path in _soffice_candidates(runtime_dir) if path.exists()), None)
            if ready and _soffice_works(ready):
                return ready
            try:
                if time.time() - lock_dir.stat().st_mtime > 300:
                    shutil.rmtree(lock_dir, ignore_errors=True)
                    continue
            except OSError:
                pass
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.25)

    temporary_dir = Path(f"{runtime_dir}.tmp-{os.getpid()}-{int(time.time() * 1000)}")
    try:
        ready = next((path for path in _soffice_candidates(runtime_dir) if path.exists()), None)
        if ready and _soffice_works(ready):
            return ready
        shutil.rmtree(temporary_dir, ignore_errors=True)
        temporary_dir.mkdir(parents=True)
        if sys.platform == "darwin":
            result = subprocess.run(
                ["ditto", "-x", "-k", str(archive), str(temporary_dir)],
                capture_output=True,
                text=True,
                timeout=180,
                check=False,
            )
            if result.returncode != 0:
                return None
        else:
            _safe_extract_zip(archive, temporary_dir)

        extracted = next((path for path in _soffice_candidates(temporary_dir) if path.exists()), None)
        if not extracted:
            return None
        if os.name != "nt":
            extracted.chmod(extracted.stat().st_mode | 0o111)
        if not _soffice_works(extracted):
            return None
        shutil.rmtree(runtime_dir, ignore_errors=True)
        temporary_dir.replace(runtime_dir)
        return next((path for path in _soffice_candidates(runtime_dir) if path.exists()), None)
    except (OSError, subprocess.SubprocessError, zipfile.BadZipFile):
        return None
    finally:
        shutil.rmtree(temporary_dir, ignore_errors=True)
        shutil.rmtree(lock_dir, ignore_errors=True)


def _safe_extract_zip(archive: Path, target_dir: Path) -> None:
    target_root = target_dir.resolve()
    with zipfile.ZipFile(archive, "r") as package:
        for member in package.infolist():
            destination = (target_root / member.filename).resolve()
            if os.path.commonpath([str(target_root), str(destination)]) != str(target_root):
                raise zipfile.BadZipFile(f"unsafe archive entry: {member.filename}")
        package.extractall(target_root)


def _soffice_works(path: Path) -> bool:
    try:
        result = subprocess.run(
            [str(path), "--headless", "--version"],
            capture_output=True,
            text=True,
            timeout=20,
            check=False,
            env={**os.environ, "SAL_USE_VCLPLUGIN": "svp"},
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def copy_pdf(input_path: Path, outdir: Path) -> Path:
    outdir.mkdir(parents=True, exist_ok=True)
    output = outdir / "render.pdf"
    if input_path.resolve() != output.resolve():
        shutil.copy2(input_path, output)
    return output


def pdf_to_images(pdf_path: Path, outdir: Path, dpi: int = 130, fmt: str = "png", timeout: int = 90) -> tuple[list[Path], str]:
    outdir.mkdir(parents=True, exist_ok=True)
    pdftoppm = shutil.which("pdftoppm")
    if not pdftoppm:
        return [], "pdftoppm not found"

    for stale in outdir.glob("page-*.*"):
        if stale.suffix.lower() in {".png", ".jpg", ".jpeg"}:
            stale.unlink(missing_ok=True)

    format_arg = "-png" if fmt.lower() == "png" else "-jpeg"
    result = subprocess.run(
        [pdftoppm, format_arg, "-r", str(dpi), str(pdf_path), str(outdir / "page")],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    if result.returncode != 0:
        return [], (result.stderr or result.stdout or "Poppler PDF rasterization failed").strip()
    images = sorted(outdir.glob("page-*.*"), key=_page_sort_key)
    return images, ""


def create_contact_sheet(images: list[Path], output: Path, thumb_width: int = 320, thumb_height: int = 180) -> tuple[Optional[Path], str]:
    try:
        from PIL import Image, ImageDraw
    except Exception as error:  # noqa: BLE001
        return None, f"Pillow unavailable: {error}"

    if not images:
        return None, "no images to montage"
    thumbs = []
    for index, image_path in enumerate(images, start=1):
        with Image.open(image_path).convert("RGB") as image:
            image.thumbnail((thumb_width, thumb_height))
            canvas = Image.new("RGB", (thumb_width + 20, thumb_height + 40), "white")
            canvas.paste(image, ((canvas.width - image.width) // 2, 10))
            draw = ImageDraw.Draw(canvas)
            draw.text((10, thumb_height + 17), f"Page {index}", fill="black")
            thumbs.append(canvas)
    cols = min(4, len(thumbs))
    rows = (len(thumbs) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * thumbs[0].width, rows * thumbs[0].height), "#f4f4f4")
    for index, thumb in enumerate(thumbs):
        sheet.paste(thumb, ((index % cols) * thumb.width, (index // cols) * thumb.height))
    output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(output, quality=92)
    return output, ""


def blank_images(images: list[Path]) -> list[str]:
    try:
        from PIL import Image, ImageChops
    except Exception:
        return []

    blanks: list[str] = []
    for image_path in images:
        try:
            with Image.open(image_path).convert("RGB") as image:
                background = Image.new("RGB", image.size, image.getpixel((0, 0)))
                if ImageChops.difference(image, background).getbbox() is None:
                    blanks.append(str(image_path))
        except Exception:
            continue
    return blanks


def strip_xml_tags(value: str) -> str:
    return re.sub(r"<[^>]+>", " ", value)


def _page_sort_key(path: Path) -> tuple[int, str]:
    match = re.search(r"-(\d+)\.", path.name)
    return (int(match.group(1)) if match else 0, path.name)


_SHIM_SO = Path(tempfile.gettempdir()) / "lo_socket_shim.so"


def _needs_socket_shim() -> bool:
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.close()
        return False
    except OSError:
        return True


def _ensure_socket_shim() -> Path:
    if _SHIM_SO.exists():
        return _SHIM_SO
    src = Path(tempfile.gettempdir()) / "lo_socket_shim.c"
    src.write_text(_SHIM_SOURCE, encoding="utf-8")
    subprocess.run(["gcc", "-shared", "-fPIC", "-o", str(_SHIM_SO), str(src), "-ldl"], check=True, capture_output=True)
    src.unlink(missing_ok=True)
    return _SHIM_SO


_SHIM_SOURCE = r"""
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

static int (*real_socket)(int, int, int);
static int (*real_socketpair)(int, int, int, int[2]);
static int (*real_listen)(int, int);
static int (*real_accept)(int, struct sockaddr *, socklen_t *);
static int (*real_close)(int);
static int (*real_read)(int, void *, size_t);

static int is_shimmed[1024];
static int peer_of[1024];
static int wake_r[1024];
static int wake_w[1024];
static int listener_fd = -1;

__attribute__((constructor))
static void init(void) {
    real_socket = dlsym(RTLD_NEXT, "socket");
    real_socketpair = dlsym(RTLD_NEXT, "socketpair");
    real_listen = dlsym(RTLD_NEXT, "listen");
    real_accept = dlsym(RTLD_NEXT, "accept");
    real_close = dlsym(RTLD_NEXT, "close");
    real_read = dlsym(RTLD_NEXT, "read");
    for (int i = 0; i < 1024; i++) {
        peer_of[i] = -1;
        wake_r[i] = -1;
        wake_w[i] = -1;
    }
}

int socket(int domain, int type, int protocol) {
    if (domain == AF_UNIX) {
        int fd = real_socket(domain, type, protocol);
        if (fd >= 0) return fd;
        int sv[2];
        if (real_socketpair(domain, type, protocol, sv) == 0) {
            if (sv[0] >= 0 && sv[0] < 1024) {
                is_shimmed[sv[0]] = 1;
                peer_of[sv[0]] = sv[1];
                int wp[2];
                if (pipe(wp) == 0) {
                    wake_r[sv[0]] = wp[0];
                    wake_w[sv[0]] = wp[1];
                }
            }
            return sv[0];
        }
        errno = EAFNOSUPPORT;
        return -1;
    }
    return real_socket(domain, type, protocol);
}

int listen(int sockfd, int backlog) {
    if (sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        listener_fd = sockfd;
        return 0;
    }
    return real_listen(sockfd, backlog);
}

int accept(int sockfd, struct sockaddr *addr, socklen_t *addrlen) {
    if (sockfd == listener_fd && sockfd >= 0 && sockfd < 1024 && is_shimmed[sockfd]) {
        char buf;
        if (wake_r[sockfd] >= 0) real_read(wake_r[sockfd], &buf, 1);
        errno = EINVAL;
        return -1;
    }
    return real_accept(sockfd, addr, addrlen);
}

int close(int fd) {
    if (fd >= 0 && fd < 1024 && is_shimmed[fd]) {
        if (wake_w[fd] >= 0) write(wake_w[fd], "x", 1);
        if (peer_of[fd] >= 0) real_close(peer_of[fd]);
        if (wake_r[fd] >= 0) real_close(wake_r[fd]);
        if (wake_w[fd] >= 0) real_close(wake_w[fd]);
        is_shimmed[fd] = 0;
        peer_of[fd] = -1;
        wake_r[fd] = -1;
        wake_w[fd] = -1;
    }
    return real_close(fd);
}
"""
