from __future__ import annotations

import ctypes
import os
import signal
import sys
import threading
from collections.abc import Iterable

from backend.app.core.logger import logger

_TH32CS_SNAPPROCESS = 0x00000002
_PROCESS_TERMINATE = 0x0001
_ERROR_NO_MORE_FILES = 18
_ERROR_INVALID_PARAMETER = 87
_MAX_PATH = 260


class _ProcessEntry32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_ulong),
        ("cntUsage", ctypes.c_ulong),
        ("th32ProcessID", ctypes.c_ulong),
        ("th32DefaultHeapID", ctypes.c_size_t),
        ("th32ModuleID", ctypes.c_ulong),
        ("cntThreads", ctypes.c_ulong),
        ("th32ParentProcessID", ctypes.c_ulong),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", ctypes.c_ulong),
        ("szExeFile", ctypes.c_wchar * _MAX_PATH),
    ]


def kill_process_tree(pid: int) -> None:
    if pid <= 0:
        return
    if sys.platform == "win32":
        _kill_windows_tree(pid)
        return
    _kill_posix_group(pid)


def request_kill_process_tree(pid: int) -> None:
    """Start best-effort process-tree cleanup without blocking the caller."""
    if pid <= 0:
        return
    threading.Thread(
        target=kill_process_tree,
        args=(pid,),
        name=f"command-tree-kill-{pid}",
        daemon=True,
    ).start()


def _kill_windows_tree(pid: int) -> None:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.argtypes = [ctypes.c_ulong, ctypes.c_ulong]
    kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    kernel32.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_ProcessEntry32W)]
    kernel32.Process32FirstW.restype = ctypes.c_int
    kernel32.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_ProcessEntry32W)]
    kernel32.Process32NextW.restype = ctypes.c_int
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    kernel32.TerminateProcess.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int

    snapshot = kernel32.CreateToolhelp32Snapshot(_TH32CS_SNAPPROCESS, 0)
    invalid_handle = ctypes.c_void_p(-1).value
    if snapshot in (None, invalid_handle):
        logger.warning(
            "[CommandRuntime] 获取 Windows 进程快照失败 | "
            f"pid={pid} | error={ctypes.get_last_error()}"
        )
        return

    process_pairs: list[tuple[int, int]] = []
    try:
        entry = _ProcessEntry32W()
        entry.dwSize = ctypes.sizeof(_ProcessEntry32W)
        has_entry = bool(kernel32.Process32FirstW(snapshot, ctypes.byref(entry)))
        while has_entry:
            process_pairs.append((int(entry.th32ProcessID), int(entry.th32ParentProcessID)))
            has_entry = bool(kernel32.Process32NextW(snapshot, ctypes.byref(entry)))
        error = ctypes.get_last_error()
        if error not in (0, _ERROR_NO_MORE_FILES):
            logger.warning(
                "[CommandRuntime] 枚举 Windows 进程失败 | "
                f"pid={pid} | error={error}"
            )
    finally:
        kernel32.CloseHandle(snapshot)

    targets = _process_tree_termination_order(pid, process_pairs)
    terminated: list[int] = []
    for target_pid in targets:
        handle = kernel32.OpenProcess(_PROCESS_TERMINATE, False, target_pid)
        if not handle:
            error = ctypes.get_last_error()
            if error != _ERROR_INVALID_PARAMETER:
                logger.warning(
                    "[CommandRuntime] 打开待终止进程失败 | "
                    f"root_pid={pid} | pid={target_pid} | error={error}"
                )
            continue
        try:
            if kernel32.TerminateProcess(handle, 1):
                terminated.append(target_pid)
            else:
                logger.warning(
                    "[CommandRuntime] 终止 Windows 进程失败 | "
                    f"root_pid={pid} | pid={target_pid} | error={ctypes.get_last_error()}"
                )
        finally:
            kernel32.CloseHandle(handle)

    logger.debug(
        "[CommandRuntime] 已请求终止 Windows 进程树 | "
        f"root_pid={pid} | target_pids={targets} | terminated_pids={terminated}"
    )


def _process_tree_termination_order(
    root_pid: int,
    process_pairs: Iterable[tuple[int, int]],
) -> list[int]:
    children_by_parent: dict[int, list[int]] = {}
    for process_id, parent_process_id in process_pairs:
        if process_id <= 0 or process_id == parent_process_id:
            continue
        children_by_parent.setdefault(parent_process_id, []).append(process_id)

    tree = [root_pid]
    visited = {root_pid}
    index = 0
    while index < len(tree):
        parent_pid = tree[index]
        index += 1
        for child_pid in children_by_parent.get(parent_pid, []):
            if child_pid in visited:
                continue
            visited.add(child_pid)
            tree.append(child_pid)
    tree.reverse()
    return tree


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
