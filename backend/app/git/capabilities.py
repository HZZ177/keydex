from __future__ import annotations

import os
import re
import shutil
import subprocess
from collections.abc import Callable
from pathlib import Path

from .models import GitCapabilityResponse

_VERSION_PATTERN = re.compile(r"git version (\d+)\.(\d+)\.(\d+)(?:[.-][^\s]+)?", re.IGNORECASE)


def parse_git_version(output: str) -> tuple[int, int, int] | None:
    match = _VERSION_PATTERN.search(output.strip())
    if not match:
        return None
    return tuple(int(match.group(index)) for index in range(1, 4))  # type: ignore[return-value]


def _startup_info() -> subprocess.STARTUPINFO | None:
    if os.name != "nt":
        return None
    info = subprocess.STARTUPINFO()
    info.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    info.wShowWindow = subprocess.SW_HIDE
    return info


def _run_probe(argv: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        argv,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=5,
        stdin=subprocess.DEVNULL,
        startupinfo=_startup_info(),
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )


def probe_git_capabilities(
    *,
    executable: str | Path | None = None,
    which: Callable[[str], str | None] = shutil.which,
    execute: Callable[[list[str]], subprocess.CompletedProcess[str]] = _run_probe,
) -> GitCapabilityResponse:
    resolved = str(executable) if executable is not None else which("git")
    if not resolved:
        return GitCapabilityResponse(available=False, reason="git executable was not found")
    try:
        version_result = execute([resolved, "--version"])
    except (OSError, subprocess.SubprocessError) as exc:
        return GitCapabilityResponse(
            available=False,
            executable=resolved,
            reason=f"git capability probe failed: {type(exc).__name__}",
        )
    version_tuple = parse_git_version(version_result.stdout or version_result.stderr)
    if version_result.returncode != 0 or version_tuple is None:
        return GitCapabilityResponse(
            available=False,
            executable=resolved,
            reason="git returned an unsupported version response",
        )
    lfs_available = False
    try:
        lfs_result = execute([resolved, "lfs", "version"])
        lfs_available = lfs_result.returncode == 0 and "git-lfs/" in (
            lfs_result.stdout or lfs_result.stderr
        ).lower()
    except (OSError, subprocess.SubprocessError):
        pass
    return GitCapabilityResponse(
        available=True,
        executable=resolved,
        version=".".join(str(part) for part in version_tuple),
        supports_switch=version_tuple >= (2, 23, 0),
        supports_restore=version_tuple >= (2, 23, 0),
        supports_pathspec_from_file=version_tuple >= (2, 13, 0),
        lfs_available=lfs_available,
    )
