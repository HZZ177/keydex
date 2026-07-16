from __future__ import annotations

import asyncio
import hashlib
import os
import time
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass, field
from pathlib import Path, PurePath
from typing import Any, Literal, Protocol

from watchfiles import Change, awatch

from backend.app.core.logger import logger

WATCH_DEBOUNCE_MS = 200
WATCH_STEP_MS = 50
MAX_BATCH_PATHS = 256
DOCUMENT_WRITE_ECHO_TTL_SECONDS = 5.0

IGNORED_WORKSPACE_DIRECTORIES = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        ".idea",
        ".venv",
        ".tox",
        "node_modules",
        "__pycache__",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
        "dist",
        "build",
        "coverage",
    }
)
IGNORED_TEMP_FILE_SUFFIXES = (
    "~",
    ".swp",
    ".swo",
    ".tmp",
    ".temp",
    ".crdownload",
    ".part",
)

FileChangeKind = Literal["added", "modified", "deleted"]


class FileChangeSubscriber(Protocol):
    async def send(
        self,
        *,
        session_id: str,
        action: str,
        data: dict[str, Any],
    ) -> bool: ...


@dataclass(frozen=True, slots=True)
class FileChange:
    kind: FileChangeKind
    path: str
    write_id: str | None = None

    def to_payload(self) -> dict[str, str]:
        payload = {"kind": self.kind, "path": self.path}
        if self.write_id:
            payload["write_id"] = self.write_id
        return payload


@dataclass(frozen=True, slots=True)
class FileChangeBatch:
    changes: tuple[FileChange, ...] = ()
    resync_required: bool = False


@dataclass(slots=True)
class _RootWatch:
    root: Path
    workspace_ids: set[str] = field(default_factory=set)
    local_subscription_keys: set[tuple[FileChangeSubscriber, str]] = field(
        default_factory=set
    )
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None


@dataclass(slots=True)
class _LocalFileSubscription:
    subscriber: FileChangeSubscriber
    watch_id: str
    path: Path
    root_key: str
    sequence: int = 0


@dataclass(frozen=True, slots=True)
class _DocumentWriteEcho:
    write_id: str
    expected_revision: str
    expected_bytes: int
    expires_at: float


WatchFactory = Any


def normalize_workspace_change_path(
    workspace_root: str | Path,
    changed_path: str | Path,
    *,
    windows_semantics: bool | None = None,
) -> str:
    root = _resolve_path(workspace_root)
    raw_changed = Path(changed_path).expanduser()
    target = _resolve_path(root / raw_changed if not raw_changed.is_absolute() else raw_changed)
    relative_parts = _relative_parts(
        target,
        root,
        windows_semantics=os.name == "nt" if windows_semantics is None else windows_semantics,
    )
    return "/".join(relative_parts)


def normalize_local_file_path(
    path: str | Path,
    *,
    require_file: bool = False,
) -> Path:
    raw = Path(path).expanduser()
    if not raw.is_absolute():
        raise ValueError("本地文件监视路径必须是绝对路径")
    try:
        resolved = raw.resolve(strict=require_file)
    except OSError as exc:
        raise ValueError("本地文件监视路径不存在或不可访问") from exc
    if require_file and not resolved.is_file():
        raise ValueError("本地文件监视路径必须指向文件")
    return resolved


def should_ignore_workspace_path(path: str | PurePath) -> bool:
    normalized = str(path).replace("\\", "/").strip("/")
    if not normalized:
        return False
    parts = tuple(part for part in normalized.split("/") if part)
    if any(part in IGNORED_WORKSPACE_DIRECTORIES for part in parts):
        return True
    name = parts[-1]
    lower_name = name.casefold()
    return (
        name.startswith(".#")
        or name.startswith("~$")
        or any(lower_name.endswith(suffix) for suffix in IGNORED_TEMP_FILE_SUFFIXES)
    )


def coalesce_file_changes(
    changes: Iterable[FileChange],
    *,
    max_paths: int = MAX_BATCH_PATHS,
) -> FileChangeBatch:
    states: dict[str, FileChangeKind | None] = {}
    distinct_paths: set[str] = set()
    for change in changes:
        distinct_paths.add(change.path)
        if len(distinct_paths) > max_paths:
            return FileChangeBatch(resync_required=True)
        previous = states.get(change.path)
        states[change.path] = _merge_change_kind(previous, change.kind)
    merged = tuple(
        FileChange(kind=kind, path=path)
        for path, kind in sorted(states.items())
        if kind is not None
    )
    return FileChangeBatch(changes=merged)


def _normalize_unordered_watcher_batch(changes: list[FileChange]) -> list[FileChange]:
    """Treat add+delete for one path as an atomic replace.

    ``watchfiles`` yields a set, so the order between those two raw events is not
    meaningful. Normalizing before the order-sensitive coalescer keeps local and
    workspace subscribers deterministic.
    """

    kinds_by_path: dict[str, set[FileChangeKind]] = {}
    for change in changes:
        kinds_by_path.setdefault(change.path, set()).add(change.kind)
    atomic_replaces = {
        path
        for path, kinds in kinds_by_path.items()
        if "added" in kinds and "deleted" in kinds
    }
    if not atomic_replaces:
        return changes
    normalized = [change for change in changes if change.path not in atomic_replaces]
    normalized.extend(FileChange("modified", path) for path in sorted(atomic_replaces))
    return normalized


def _tag_document_write_changes(
    batch: FileChangeBatch,
    write_ids_by_path: dict[str, str],
) -> FileChangeBatch:
    if not batch.changes or not write_ids_by_path:
        return batch
    return FileChangeBatch(
        changes=tuple(
            FileChange(
                kind=change.kind,
                path=change.path,
                write_id=write_ids_by_path.get(change.path),
            )
            for change in batch.changes
        ),
        resync_required=batch.resync_required,
    )


def _matching_document_write_id(
    target: Path,
    echoes: tuple[_DocumentWriteEcho, ...],
) -> str | None:
    try:
        size = target.stat().st_size
    except OSError:
        return None
    candidates = [echo for echo in echoes if echo.expected_bytes == size]
    if not candidates:
        return None
    digest = hashlib.sha256()
    try:
        with target.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                digest.update(chunk)
    except OSError:
        return None
    revision = f"sha256:{digest.hexdigest()}"
    return next(
        (
            echo.write_id
            for echo in reversed(candidates)
            if echo.expected_revision == revision
        ),
        None,
    )


class FileChangeHub:
    def __init__(
        self,
        *,
        watch_factory: WatchFactory | None = None,
        start_tasks: bool = True,
        ignored_roots: Iterable[str | Path] = (),
    ) -> None:
        self._watch_factory = watch_factory or _default_watch_factory
        self._start_tasks = start_tasks
        self._ignored_root_keys = tuple(
            _path_key(_resolve_path(root)).rstrip("/") for root in ignored_roots
        )
        self._roots: dict[str, _RootWatch] = {}
        self._workspace_subscribers: dict[
            str, set[FileChangeSubscriber]
        ] = {}
        self._workspace_root_keys: dict[str, str] = {}
        self._workspace_sequences: dict[str, int] = {}
        self._local_subscriptions: dict[
            tuple[FileChangeSubscriber, str], _LocalFileSubscription
        ] = {}
        self._published_operation_phases: dict[tuple[str, str], None] = {}
        self._document_write_echoes: dict[str, list[_DocumentWriteEcho]] = {}
        self._lock = asyncio.Lock()
        self._closed = False

    async def register_document_write_echo(
        self,
        write_id: str,
        path: str | Path,
        *,
        revision: str,
        total_bytes: int,
    ) -> None:
        cleaned_write_id = write_id.strip()
        if not cleaned_write_id:
            raise ValueError("write_id 不能为空")
        target = _resolve_path(path)
        now = time.monotonic()
        async with self._lock:
            self._ensure_open()
            self._purge_expired_document_write_echoes_locked(now)
            self._document_write_echoes.setdefault(_path_key(target), []).append(
                _DocumentWriteEcho(
                    write_id=cleaned_write_id,
                    expected_revision=revision,
                    expected_bytes=total_bytes,
                    expires_at=now + DOCUMENT_WRITE_ECHO_TTL_SECONDS,
                )
            )

    async def discard_document_write_echo(
        self,
        write_id: str,
        path: str | Path,
    ) -> None:
        cleaned_write_id = write_id.strip()
        if not cleaned_write_id:
            return
        path_key = _path_key(_resolve_path(path))
        async with self._lock:
            echoes = self._document_write_echoes.get(path_key)
            if not echoes:
                return
            remaining = [echo for echo in echoes if echo.write_id != cleaned_write_id]
            if remaining:
                self._document_write_echoes[path_key] = remaining
            else:
                self._document_write_echoes.pop(path_key, None)

    async def publish_operation_changes(
        self,
        workspace_id: str,
        operation_id: str,
        changes: Iterable[FileChange] = (),
        *,
        phase: str = "complete",
        resync_required: bool = False,
    ) -> bool:
        """Publish one deduplicated restore/compensation result to existing watchers."""

        key = (operation_id.strip(), phase.strip())
        if not key[0] or not key[1]:
            raise ValueError("operation_id 和 phase 不能为空")
        async with self._lock:
            self._ensure_open()
            if key in self._published_operation_phases:
                return False
            self._published_operation_phases[key] = None
            while len(self._published_operation_phases) > 2048:
                self._published_operation_phases.pop(next(iter(self._published_operation_phases)))
        batch = coalesce_file_changes(changes)
        if not batch.changes and not resync_required:
            return True
        failed = await self._broadcast_workspace(
            workspace_id,
            FileChangeBatch(
                changes=batch.changes,
                resync_required=resync_required or batch.resync_required,
            ),
        )
        for subscriber in failed:
            await self.unsubscribe_all(subscriber)
        return True

    async def subscribe_workspace(
        self,
        workspace_id: str,
        workspace_root: str | Path,
        subscriber: FileChangeSubscriber,
    ) -> int:
        cleaned_workspace_id = workspace_id.strip()
        if not cleaned_workspace_id:
            raise ValueError("workspace_id 不能为空")
        root = _resolve_path(workspace_root)
        if not root.is_dir():
            raise ValueError("工作区路径不存在或不是目录")
        async with self._lock:
            self._ensure_open()
            root_key, watched = self._ensure_root_locked(root)
            previous_root_key = self._workspace_root_keys.get(cleaned_workspace_id)
            if previous_root_key is not None and previous_root_key != root_key:
                raise ValueError("同一 workspace_id 不能绑定不同工作区路径")
            self._workspace_root_keys[cleaned_workspace_id] = root_key
            self._workspace_subscribers.setdefault(cleaned_workspace_id, set()).add(
                subscriber
            )
            watched.workspace_ids.add(cleaned_workspace_id)
            return self._workspace_sequences.setdefault(cleaned_workspace_id, 0)

    async def unsubscribe_workspace(
        self,
        workspace_id: str,
        subscriber: FileChangeSubscriber,
    ) -> None:
        task = None
        async with self._lock:
            cleaned_workspace_id = workspace_id.strip()
            subscribers = self._workspace_subscribers.get(cleaned_workspace_id)
            if subscribers is None:
                return
            subscribers.discard(subscriber)
            if subscribers:
                return
            self._workspace_subscribers.pop(cleaned_workspace_id, None)
            root_key = self._workspace_root_keys.pop(cleaned_workspace_id, None)
            self._workspace_sequences.pop(cleaned_workspace_id, None)
            if root_key is not None and root_key in self._roots:
                self._roots[root_key].workspace_ids.discard(cleaned_workspace_id)
                task = self._remove_unused_root_locked(root_key)
        await _cancel_task(task)

    async def subscribe_local_file(
        self,
        watch_id: str,
        path: str | Path,
        subscriber: FileChangeSubscriber,
    ) -> tuple[Path, int]:
        cleaned_watch_id = watch_id.strip()
        if not cleaned_watch_id:
            raise ValueError("watch_id 不能为空")
        target = normalize_local_file_path(path, require_file=True)
        key = (subscriber, cleaned_watch_id)
        async with self._lock:
            self._ensure_open()
            existing = self._local_subscriptions.get(key)
            if existing is not None:
                if _path_key(existing.path) != _path_key(target):
                    raise ValueError("同一 watch_id 不能绑定不同文件")
                return existing.path, existing.sequence
            root_key, watched = self._ensure_root_locked(target.parent)
            subscription = _LocalFileSubscription(
                subscriber=subscriber,
                watch_id=cleaned_watch_id,
                path=target,
                root_key=root_key,
            )
            self._local_subscriptions[key] = subscription
            watched.local_subscription_keys.add(key)
            return target, subscription.sequence

    async def unsubscribe_local_file(
        self,
        watch_id: str,
        subscriber: FileChangeSubscriber,
    ) -> None:
        task = None
        async with self._lock:
            key = (subscriber, watch_id.strip())
            subscription = self._local_subscriptions.pop(key, None)
            if subscription is None:
                return
            watched = self._roots.get(subscription.root_key)
            if watched is not None:
                watched.local_subscription_keys.discard(key)
                task = self._remove_unused_root_locked(subscription.root_key)
        await _cancel_task(task)

    async def unsubscribe_all(self, subscriber: FileChangeSubscriber) -> None:
        tasks: list[asyncio.Task[None]] = []
        async with self._lock:
            for workspace_id, subscribers in list(self._workspace_subscribers.items()):
                subscribers.discard(subscriber)
                if subscribers:
                    continue
                self._workspace_subscribers.pop(workspace_id, None)
                root_key = self._workspace_root_keys.pop(workspace_id, None)
                self._workspace_sequences.pop(workspace_id, None)
                if root_key is not None and root_key in self._roots:
                    self._roots[root_key].workspace_ids.discard(workspace_id)
            for key, subscription in list(self._local_subscriptions.items()):
                if subscription.subscriber is not subscriber:
                    continue
                self._local_subscriptions.pop(key, None)
                watched = self._roots.get(subscription.root_key)
                if watched is not None:
                    watched.local_subscription_keys.discard(key)
            for root_key in list(self._roots):
                task = self._remove_unused_root_locked(root_key)
                if task is not None:
                    tasks.append(task)
        await _cancel_tasks(tasks)

    async def handle_raw_changes(
        self,
        workspace_root: str | Path,
        raw_changes: Iterable[tuple[Any, str | Path]],
    ) -> None:
        root = _resolve_path(workspace_root)
        root_key = _path_key(root)
        raw = tuple(raw_changes)
        document_write_ids = await self._consume_document_write_echoes(raw)
        async with self._lock:
            watched = self._roots.get(root_key)
            if watched is None:
                return
            workspace_ids = tuple(watched.workspace_ids)
            local_keys = tuple(watched.local_subscription_keys)

        failed: set[FileChangeSubscriber] = set()
        for workspace_id in workspace_ids:
            normalized: list[FileChange] = []
            write_ids_by_path: dict[str, str] = {}
            for raw_kind, raw_path in raw:
                try:
                    if self._is_ignored_workspace_target(raw_path):
                        continue
                    relative = normalize_workspace_change_path(root, raw_path)
                    kind = _normalize_change_kind(raw_kind)
                except (ValueError, OSError):
                    continue
                if not should_ignore_workspace_path(relative):
                    normalized.append(FileChange(kind=kind, path=relative))
                    write_id = document_write_ids.get(_path_key(_resolve_path(raw_path)))
                    if write_id:
                        write_ids_by_path[relative] = write_id
            batch = coalesce_file_changes(_normalize_unordered_watcher_batch(normalized))
            batch = _tag_document_write_changes(batch, write_ids_by_path)
            if batch.changes or batch.resync_required:
                failed.update(await self._broadcast_workspace(workspace_id, batch))

        for key in local_keys:
            async with self._lock:
                subscription = self._local_subscriptions.get(key)
            if subscription is None:
                continue
            normalized = []
            local_write_id: str | None = None
            for raw_kind, raw_path in raw:
                target = _resolve_path(raw_path)
                if _path_key(target) == _path_key(subscription.path):
                    normalized.append(
                        FileChange(
                            kind=_normalize_change_kind(raw_kind),
                            path=str(subscription.path),
                        )
                    )
                    local_write_id = document_write_ids.get(_path_key(target)) or local_write_id
            batch = coalesce_file_changes(_normalize_unordered_watcher_batch(normalized))
            batch = _tag_document_write_changes(
                batch,
                {str(subscription.path): local_write_id} if local_write_id else {},
            )
            if batch.changes or batch.resync_required:
                if not await self._broadcast_local(subscription, batch):
                    failed.add(subscription.subscriber)
        for subscriber in failed:
            await self.unsubscribe_all(subscriber)

    def _is_ignored_workspace_target(self, path: str | Path) -> bool:
        target_key = _path_key(_resolve_path(path))
        return any(
            target_key == root_key or target_key.startswith(f"{root_key}/")
            for root_key in self._ignored_root_keys
        )

    async def broadcast_root_resync(self, workspace_root: str | Path) -> None:
        root_key = _path_key(_resolve_path(workspace_root))
        async with self._lock:
            watched = self._roots.get(root_key)
            if watched is None:
                return
            workspace_ids = tuple(watched.workspace_ids)
            local_subscriptions = tuple(
                self._local_subscriptions[key]
                for key in watched.local_subscription_keys
                if key in self._local_subscriptions
            )
        failed: set[FileChangeSubscriber] = set()
        for workspace_id in workspace_ids:
            failed.update(
                await self._broadcast_workspace(
                    workspace_id,
                    FileChangeBatch(resync_required=True),
                )
            )
        for subscription in local_subscriptions:
            if not await self._broadcast_local(
                subscription,
                FileChangeBatch(resync_required=True),
            ):
                failed.add(subscription.subscriber)
        for subscriber in failed:
            await self.unsubscribe_all(subscriber)

    async def close(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            roots = tuple(self._roots.values())
            self._roots.clear()
            self._workspace_subscribers.clear()
            self._workspace_root_keys.clear()
            self._workspace_sequences.clear()
            self._local_subscriptions.clear()
            self._published_operation_phases.clear()
            self._document_write_echoes.clear()
            for watched in roots:
                watched.stop_event.set()
            tasks = [watched.task for watched in roots if watched.task is not None]
        await _cancel_tasks(tasks)

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("FileChangeHub 已关闭")

    async def _consume_document_write_echoes(
        self,
        raw_changes: tuple[tuple[Any, str | Path], ...],
    ) -> dict[str, str]:
        targets = {
            _path_key(target): target
            for _, raw_path in raw_changes
            if (target := _resolve_path(raw_path))
        }
        if not targets:
            return {}
        now = time.monotonic()
        async with self._lock:
            self._purge_expired_document_write_echoes_locked(now)
            candidates = {
                path_key: tuple(self._document_write_echoes.get(path_key, ()))
                for path_key in targets
                if path_key in self._document_write_echoes
            }
        if not candidates:
            return {}

        matched: dict[str, str] = {}
        for path_key, echoes in candidates.items():
            write_id = await asyncio.to_thread(
                _matching_document_write_id,
                targets[path_key],
                echoes,
            )
            if write_id:
                matched[path_key] = write_id

        async with self._lock:
            for path_key in matched:
                echoes = candidates[path_key]
                current = self._document_write_echoes.get(path_key)
                if current is not None and tuple(current) == echoes:
                    self._document_write_echoes.pop(path_key, None)

        tagged_paths = dict(matched)
        for path_key, write_id in matched.items():
            parent_key = _path_key(targets[path_key].parent)
            if parent_key in targets:
                tagged_paths[parent_key] = write_id
        return tagged_paths

    def _purge_expired_document_write_echoes_locked(self, now: float) -> None:
        for path_key, echoes in list(self._document_write_echoes.items()):
            active = [echo for echo in echoes if echo.expires_at > now]
            if active:
                self._document_write_echoes[path_key] = active
            else:
                self._document_write_echoes.pop(path_key, None)

    def _ensure_root_locked(self, root: Path) -> tuple[str, _RootWatch]:
        root_key = _path_key(root)
        watched = self._roots.get(root_key)
        if watched is None:
            watched = _RootWatch(root=root)
            self._roots[root_key] = watched
            if self._start_tasks:
                watched.task = asyncio.create_task(self._watch_loop(root_key))
        return root_key, watched

    def _remove_unused_root_locked(self, root_key: str) -> asyncio.Task[None] | None:
        watched = self._roots.get(root_key)
        if watched is None or watched.workspace_ids or watched.local_subscription_keys:
            return None
        self._roots.pop(root_key, None)
        watched.stop_event.set()
        return watched.task

    async def _watch_loop(self, root_key: str) -> None:
        async with self._lock:
            watched = self._roots.get(root_key)
            if watched is None:
                return
            root = watched.root
            stop_event = watched.stop_event
        try:
            async for changes in self._watch_factory(root, stop_event):
                await self.handle_raw_changes(root, changes)
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.opt(exception=True).error(
                f"[FileChangeHub] watcher 异常 | root={root} | error={exc}"
            )
            await self.broadcast_root_resync(root)

    async def _broadcast_workspace(
        self,
        workspace_id: str,
        batch: FileChangeBatch,
    ) -> set[FileChangeSubscriber]:
        async with self._lock:
            subscribers = tuple(self._workspace_subscribers.get(workspace_id, ()))
            if not subscribers:
                return set()
            sequence = self._workspace_sequences.get(workspace_id, 0) + 1
            self._workspace_sequences[workspace_id] = sequence
        payload = {
            "workspace_id": workspace_id,
            "sequence": sequence,
            "resync_required": batch.resync_required,
            "changes": [change.to_payload() for change in batch.changes],
        }
        failed: set[FileChangeSubscriber] = set()
        for subscriber in subscribers:
            if not await _send_event(subscriber, "workspaceFilesChanged", payload):
                failed.add(subscriber)
        return failed

    async def _broadcast_local(
        self,
        subscription: _LocalFileSubscription,
        batch: FileChangeBatch,
    ) -> bool:
        async with self._lock:
            key = (subscription.subscriber, subscription.watch_id)
            current = self._local_subscriptions.get(key)
            if current is not subscription:
                return True
            subscription.sequence += 1
            sequence = subscription.sequence
        payload = {
            "watch_id": subscription.watch_id,
            "path": str(subscription.path),
            "sequence": sequence,
            "resync_required": batch.resync_required,
            "changes": [change.to_payload() for change in batch.changes],
        }
        return await _send_event(subscription.subscriber, "localFileChanged", payload)


async def _default_watch_factory(
    root: Path,
    stop_event: asyncio.Event,
) -> AsyncIterator[set[tuple[Change, str]]]:
    async for changes in awatch(
        root,
        debounce=WATCH_DEBOUNCE_MS,
        step=WATCH_STEP_MS,
        stop_event=stop_event,
        watch_filter=None,
        recursive=True,
        ignore_permission_denied=True,
    ):
        yield changes


async def _send_event(
    subscriber: FileChangeSubscriber,
    action: str,
    payload: dict[str, Any],
) -> bool:
    try:
        return bool(await subscriber.send(session_id="", action=action, data=payload))
    except Exception as exc:
        logger.warning(f"[FileChangeHub] 推送订阅者失败 | action={action} | error={exc}")
        return False


async def _cancel_task(task: asyncio.Task[None] | None) -> None:
    if task is None:
        return
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


async def _cancel_tasks(tasks: Iterable[asyncio.Task[None]]) -> None:
    pending = tuple(tasks)
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.gather(*pending, return_exceptions=True)


def _merge_change_kind(
    previous: FileChangeKind | None,
    current: FileChangeKind,
) -> FileChangeKind | None:
    if previous is None:
        return current
    if previous == "added":
        return None if current == "deleted" else "added"
    if previous == "modified":
        return "deleted" if current == "deleted" else "modified"
    if previous == "deleted":
        return "modified" if current == "added" else "deleted"
    return current


def _normalize_change_kind(value: Any) -> FileChangeKind:
    if value in (Change.added, Change.added.value, "added"):
        return "added"
    if value in (Change.deleted, Change.deleted.value, "deleted"):
        return "deleted"
    if value in (Change.modified, Change.modified.value, "modified"):
        return "modified"
    raise ValueError(f"未知文件变动类型: {value}")


def _resolve_path(path: str | Path) -> Path:
    return Path(path).expanduser().resolve(strict=False)


def _path_key(path: Path) -> str:
    text = path.as_posix().rstrip("/")
    return text.casefold() if os.name == "nt" else text


def _relative_parts(
    target: Path,
    root: Path,
    *,
    windows_semantics: bool,
) -> tuple[str, ...]:
    target_parts = target.parts
    root_parts = root.parts
    if len(target_parts) < len(root_parts):
        raise ValueError("变动路径不在工作区内")
    compare = str.casefold if windows_semantics else (lambda value: value)
    for target_part, root_part in zip(target_parts, root_parts, strict=False):
        if compare(target_part) != compare(root_part):
            raise ValueError("变动路径不在工作区内")
    return tuple(target_parts[len(root_parts) :])
