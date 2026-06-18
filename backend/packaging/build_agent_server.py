from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

WINDOWS_TAURI_TRIPLE = "x86_64-pc-windows-msvc"


def copy_with_retry(source: Path, target: Path, attempts: int = 10) -> None:
    last_error: OSError | None = None
    for _ in range(attempts):
        try:
            shutil.copy2(source, target)
            return
        except OSError as err:
            last_error = err
            time.sleep(0.5)
    if last_error is not None:
        raise last_error


def build_with_pyinstaller(output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--clean",
            "--onefile",
            "--noconsole",
            "--name",
            "agent-server",
            "--distpath",
            str(output_dir),
            "backend/packaging/agent_server_entry.py",
        ],
        check=True,
    )
    built = output_dir / ("agent-server.exe" if sys.platform == "win32" else "agent-server")
    if sys.platform == "win32":
        tauri_name = output_dir / f"agent-server-{WINDOWS_TAURI_TRIPLE}.exe"
        copy_with_retry(built, tauri_name)
        return tauri_name
    return built


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build the Python Codex agent server binary.")
    parser.add_argument("--output-dir", default="desktop/src-tauri/binaries")
    args = parser.parse_args(argv)
    binary = build_with_pyinstaller(Path(args.output_dir))
    print(binary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
