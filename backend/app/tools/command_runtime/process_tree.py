from __future__ import annotations

import locale
import os
import signal
import subprocess
import sys

from backend.app.core.logger import logger


def kill_process_tree(pid: int) -> None:
    if pid <= 0:
        return
    if sys.platform == "win32":
        _kill_windows_tree(pid)
        return
    _kill_posix_group(pid)


def _kill_windows_tree(pid: int) -> None:
    try:
        result = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            check=False,
            timeout=5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        stdout = _decode_process_output(result.stdout)
        stderr = _decode_process_output(result.stderr)
        if result.returncode != 0:
            logger.warning(
                "[CommandRuntime] taskkill 返回非零状态 | "
                f"pid={pid} | returncode={result.returncode} | "
                f"stdout={stdout or '-'} | stderr={stderr or '-'}"
            )
        else:
            logger.debug(
                "[CommandRuntime] taskkill 已请求终止进程树 | "
                f"pid={pid} | stdout={stdout or '-'}"
            )
    except Exception as exc:
        logger.warning(f"[CommandRuntime] taskkill 失败 | pid={pid} | error={exc}")


def _kill_posix_group(pid: int) -> None:
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except Exception as exc:
            logger.warning(f"[CommandRuntime] kill 失败 | pid={pid} | error={exc}")


def _decode_process_output(value: bytes | None) -> str:
    if not value:
        return ""
    for encoding in (locale.getpreferredencoding(False), "gb18030", "utf-8"):
        try:
            return value.decode(encoding).strip()
        except UnicodeDecodeError:
            continue
    return value.decode("utf-8", errors="replace").strip()
