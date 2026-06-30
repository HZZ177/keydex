from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path

WINDOWS_TAURI_TRIPLE = "x86_64-pc-windows-msvc"
BUNDLED_RIPGREP_BINARY_NAME = f"rg-{WINDOWS_TAURI_TRIPLE}.exe" if os.name == "nt" else "rg"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def resolve_ripgrep_binary() -> Path | None:
    candidates = [
        *_pyinstaller_ripgrep_candidates(),
        Path(sys.executable).resolve().parent / BUNDLED_RIPGREP_BINARY_NAME,
        REPOSITORY_ROOT / "desktop" / "src-tauri" / "binaries" / BUNDLED_RIPGREP_BINARY_NAME,
        REPOSITORY_ROOT / "desktop" / "src-tauri" / "binaries" / "rg.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def open_ripgrep_process(
    command: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path,
) -> subprocess.Popen[str]:
    return subprocess.Popen(
        _stringify_command(command),
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        **_ripgrep_subprocess_kwargs(),
    )


def run_ripgrep_process(
    command: Sequence[str | os.PathLike[str]],
    *,
    cwd: Path,
    timeout_seconds: int,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        _stringify_command(command),
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout_seconds,
        check=False,
        **_ripgrep_subprocess_kwargs(),
    )


def _ripgrep_subprocess_kwargs() -> dict[str, object]:
    if os.name != "nt":
        return {}

    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    return {
        "creationflags": subprocess.CREATE_NO_WINDOW,
        "startupinfo": startupinfo,
    }


def _stringify_command(command: Sequence[str | os.PathLike[str]]) -> list[str]:
    return [os.fspath(part) for part in command]


def _pyinstaller_ripgrep_candidates() -> list[Path]:
    root = getattr(sys, "_MEIPASS", "")
    if not root:
        return []
    bundle_root = Path(str(root))
    return [
        bundle_root / BUNDLED_RIPGREP_BINARY_NAME,
        bundle_root / "binaries" / BUNDLED_RIPGREP_BINARY_NAME,
        bundle_root / "rg.exe",
    ]
