from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.tools.base import ToolExecutionContext, ToolExecutionError
from backend.app.tools.file_access import relative_tool_path

SNAPSHOT_STORE_METADATA_KEY = "_file_read_snapshot_store"


@dataclass(frozen=True)
class FileReadSnapshot:
    path: Path
    relative_path: str
    mtime_ns: int
    size: int
    digest: str
    full_read: bool
    encoding: str = "utf-8"


class FileReadSnapshotStore:
    def __init__(self) -> None:
        self._items: dict[str, FileReadSnapshot] = {}

    def record(
        self,
        path: Path,
        *,
        context: ToolExecutionContext,
        content: str,
        full_read: bool,
        encoding: str = "utf-8",
    ) -> FileReadSnapshot:
        stat = path.stat()
        key = _snapshot_key(path)
        existing = self._items.get(key)
        if existing is not None and existing.full_read and not full_read:
            return existing
        snapshot = FileReadSnapshot(
            path=path.resolve(),
            relative_path=relative_tool_path(path, context),
            mtime_ns=stat.st_mtime_ns,
            size=stat.st_size,
            digest=_digest(content),
            full_read=full_read,
            encoding=encoding,
        )
        self._items[key] = snapshot
        return snapshot

    def get(self, path: Path) -> FileReadSnapshot | None:
        return self._items.get(_snapshot_key(path))

    def discard(self, path: Path) -> None:
        self._items.pop(_snapshot_key(path), None)


def ensure_file_snapshot_store(context: ToolExecutionContext) -> FileReadSnapshotStore:
    existing = context.metadata.get(SNAPSHOT_STORE_METADATA_KEY)
    if isinstance(existing, FileReadSnapshotStore):
        return existing
    store = FileReadSnapshotStore()
    context.metadata[SNAPSHOT_STORE_METADATA_KEY] = store
    return store


def record_file_snapshot(
    path: Path,
    *,
    context: ToolExecutionContext,
    content: str,
    full_read: bool,
    encoding: str = "utf-8",
) -> FileReadSnapshot:
    return ensure_file_snapshot_store(context).record(
        path,
        context=context,
        content=content,
        full_read=full_read,
        encoding=encoding,
    )


def read_current_file_content(
    path: Path,
    *,
    context: ToolExecutionContext,
) -> str:
    store = ensure_file_snapshot_store(context)
    snapshot = store.get(path)
    relative = relative_tool_path(path, context)
    if not path.exists():
        raise ToolExecutionError("文件不存在", code="file_not_found", details={"path": relative})
    if not path.is_file():
        raise ToolExecutionError("路径不是文件", code="path_not_file", details={"path": relative})
    try:
        content = path.read_text(encoding=snapshot.encoding if snapshot is not None else "utf-8")
    except UnicodeDecodeError as exc:
        raise ToolExecutionError(
            "文件不是 UTF-8 文本",
            code="file_not_text",
            details={"path": relative},
        ) from exc
    if snapshot is not None and _snapshot_is_stale(path, content, snapshot):
        raise ToolExecutionError(
            "文件已在读取后发生变化，拒绝覆盖当前内容",
            code="file_modified_since_read",
            details={
                "path": relative,
                "hint": "请重新用 read_file 读取最新内容后再编辑。",
            },
        )
    return content


def _snapshot_is_stale(path: Path, content: str, snapshot: FileReadSnapshot) -> bool:
    stat = path.stat()
    return (
        stat.st_mtime_ns != snapshot.mtime_ns
        or stat.st_size != snapshot.size
        or _digest(content) != snapshot.digest
    )


def _snapshot_key(path: Path) -> str:
    return path.resolve().as_posix().lower()


def _digest(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()
