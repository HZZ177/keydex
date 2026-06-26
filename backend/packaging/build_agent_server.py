from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

WINDOWS_TAURI_TRIPLE = "x86_64-pc-windows-msvc"
MANIFEST_VERSION = 1
ROOT = Path(__file__).resolve().parents[2]
ENTRY_POINT = ROOT / "backend" / "packaging" / "agent_server_entry.py"
SIDECAR_INPUT_ROOTS = (
    ROOT / "backend" / "app",
    ROOT / "backend" / "packaging",
    ROOT / "requirements.txt",
    ROOT / "pyproject.toml",
)
SIDECAR_INPUT_SUFFIXES = {".py", ".md", ".txt", ".toml", ".lock"}
PYINSTALLER_COLLECT_SUBMODULES = (
    "backend.app.agent",
    "backend.app.services",
    "backend.app.tools",
)


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


def expected_binary(output_dir: Path) -> Path:
    if sys.platform == "win32":
        return output_dir / f"agent-server-{WINDOWS_TAURI_TRIPLE}.exe"
    return output_dir / "agent-server"


def manifest_path(output_dir: Path) -> Path:
    return output_dir / "agent-server.build.json"


def iter_sidecar_inputs() -> list[Path]:
    files: list[Path] = []
    for root in SIDECAR_INPUT_ROOTS:
        if root.is_file():
            files.append(root)
            continue
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if "__pycache__" in path.parts:
                continue
            if path.suffix.lower() not in SIDECAR_INPUT_SUFFIXES:
                continue
            files.append(path)
    return sorted(set(files))


def sidecar_fingerprint() -> tuple[str, list[str]]:
    digest = hashlib.sha256()
    digest.update(f"manifest_version={MANIFEST_VERSION}\n".encode())
    digest.update(f"python={sys.version}\n".encode())
    digest.update(f"platform={sys.platform}\n".encode())
    paths: list[str] = []
    for path in iter_sidecar_inputs():
        relative = path.relative_to(ROOT).as_posix()
        paths.append(relative)
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest(), paths


def is_current_build(output_dir: Path, fingerprint: str) -> bool:
    binary = expected_binary(output_dir)
    manifest = manifest_path(output_dir)
    if not binary.is_file() or not manifest.is_file():
        return False
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return (
        payload.get("manifest_version") == MANIFEST_VERSION
        and payload.get("fingerprint") == fingerprint
        and payload.get("binary") == binary.name
    )


def write_manifest(output_dir: Path, binary: Path, fingerprint: str, inputs: list[str]) -> None:
    payload = {
        "manifest_version": MANIFEST_VERSION,
        "fingerprint": fingerprint,
        "binary": binary.name,
        "inputs": inputs,
    }
    manifest_path(output_dir).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def build_with_pyinstaller(
    output_dir: Path,
    *,
    reuse_if_current: bool = False,
    clean: bool = False,
) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    fingerprint, inputs = sidecar_fingerprint()
    reusable_binary = expected_binary(output_dir)
    if reuse_if_current and not clean and is_current_build(output_dir, fingerprint):
        print(f"复用已有 sidecar：{reusable_binary}")
        return reusable_binary
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
    ]
    if clean:
        command.append("--clean")
    for package_name in PYINSTALLER_COLLECT_SUBMODULES:
        command.extend(["--collect-submodules", package_name])
    command.extend(
        [
            "--onefile",
            "--noconsole",
            "--name",
            "agent-server",
            "--distpath",
            str(output_dir),
            str(ENTRY_POINT),
        ]
    )
    subprocess.run(
        command,
        check=True,
    )
    built = output_dir / ("agent-server.exe" if sys.platform == "win32" else "agent-server")
    if sys.platform == "win32":
        tauri_name = output_dir / f"agent-server-{WINDOWS_TAURI_TRIPLE}.exe"
        copy_with_retry(built, tauri_name)
        write_manifest(output_dir, tauri_name, fingerprint, inputs)
        return tauri_name
    write_manifest(output_dir, built, fingerprint, inputs)
    return built


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="构建 Keydex 智能体服务端可执行文件。")
    parser.add_argument("--output-dir", default="desktop/src-tauri/binaries")
    parser.add_argument(
        "--reuse-if-current",
        action="store_true",
        help="输入未变化时复用已有 sidecar。",
    )
    parser.add_argument("--clean", action="store_true", help="清理 PyInstaller 缓存后重新构建。")
    args = parser.parse_args(argv)
    binary = build_with_pyinstaller(
        Path(args.output_dir),
        reuse_if_current=args.reuse_if_current,
        clean=args.clean,
    )
    print(binary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
