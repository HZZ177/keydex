from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator, Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from watchfiles import Change, awatch

from backend.app.core.logger import logger

from .models import GitRepositoryResponse
from .query_service import repository_version

GIT_WATCH_DEBOUNCE_MS = 180
GIT_WATCH_STEP_MS = 40


class GitEventSubscriber(Protocol):
    async def send(
        self,
        *,
        session_id: str,
        action: str,
        data: dict[str, Any],
    ) -> bool: ...


@dataclass(slots=True)
class _RepositoryWatch:
    repository: GitRepositoryResponse
    subscribers: set[GitEventSubscriber] = field(default_factory=set)
    stop_event: asyncio.Event = field(default_factory=asyncio.Event)
    task: asyncio.Task[None] | None = None
    sequence: int = 0


GitWatchFactory = Callable[
    [Path, asyncio.Event],
    AsyncIterator[set[tuple[Change, str]]],
]


class GitMetadataEventService:
    """Dedicated watcher for repository metadata ignored by the workspace watcher."""

    def __init__(
        self,
        *,
        watch_factory: GitWatchFactory | None = None,
        invalidate: Callable[[str], None] | None = None,
        start_tasks: bool = True,
    ) -> None:
        self._watch_factory = watch_factory or _default_watch_factory
        self._invalidate = invalidate or (lambda _repository_id: None)
        self._start_tasks = start_tasks
        self._watches: dict[str, _RepositoryWatch] = {}
        self._lock = asyncio.Lock()
        self._closed = False

    async def subscribe(
        self,
        repository: GitRepositoryResponse,
        subscriber: GitEventSubscriber,
    ) -> int:
        async with self._lock:
            self._ensure_open()
            watch = self._watches.get(repository.id)
            if watch is None:
                watch = _RepositoryWatch(repository=repository)
                self._watches[repository.id] = watch
                if self._start_tasks:
                    watch.task = asyncio.create_task(self._watch_loop(repository.id))
            elif _path_key(watch.repository.git_dir_path) != _path_key(repository.git_dir_path):
                raise ValueError("Repository identity cannot be rebound to another gitdir")
            watch.subscribers.add(subscriber)
            return watch.sequence

    async def unsubscribe(self, repository_id: str, subscriber: GitEventSubscriber) -> None:
        task: asyncio.Task[None] | None = None
        async with self._lock:
            watch = self._watches.get(repository_id)
            if watch is None:
                return
            watch.subscribers.discard(subscriber)
            if not watch.subscribers:
                self._watches.pop(repository_id, None)
                watch.stop_event.set()
                task = watch.task
        await _cancel_task(task)

    async def handle_raw_changes(
        self,
        repository_id: str,
        raw_changes: Iterable[tuple[Any, str | Path]],
    ) -> None:
        async with self._lock:
            watch = self._watches.get(repository_id)
            if watch is None:
                return
            repository = watch.repository
            subscribers = tuple(watch.subscribers)
            watch.sequence += 1
            sequence = watch.sequence
        domains: set[str] = set()
        metadata_paths: set[str] = set()
        git_dir = Path(repository.git_dir_path).resolve()
        for _kind, raw_path in raw_changes:
            try:
                relative = Path(raw_path).resolve(strict=False).relative_to(git_dir).as_posix()
            except (OSError, ValueError):
                continue
            mapped = git_metadata_domains(relative)
            if mapped:
                metadata_paths.add(relative)
                domains.update(mapped)
        if not domains:
            return
        self._invalidate(repository_id)
        payload = {
            "repository_id": repository_id,
            "repository_version": repository_version(repository),
            "sequence": sequence,
            "domains": sorted(domains),
            "paths": sorted(metadata_paths)[:64],
            "resync_required": len(metadata_paths) > 64,
        }
        failed: list[GitEventSubscriber] = []
        for subscriber in subscribers:
            try:
                sent = await subscriber.send(
                    session_id="",
                    action="gitMetadataChanged",
                    data=payload,
                )
            except Exception as exc:
                logger.warning(f"[GitMetadataEventService] subscriber failed: {exc}")
                sent = False
            if not sent:
                failed.append(subscriber)
        for subscriber in failed:
            await self.unsubscribe(repository_id, subscriber)

    async def close(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            watches = tuple(self._watches.values())
            self._watches.clear()
            for watch in watches:
                watch.stop_event.set()
        await asyncio.gather(
            *(_cancel_task(watch.task) for watch in watches),
            return_exceptions=True,
        )

    async def _watch_loop(self, repository_id: str) -> None:
        async with self._lock:
            watch = self._watches.get(repository_id)
            if watch is None:
                return
            git_dir = Path(watch.repository.git_dir_path)
            stop_event = watch.stop_event
        try:
            async for changes in self._watch_factory(git_dir, stop_event):
                await self.handle_raw_changes(repository_id, changes)
        except asyncio.CancelledError:
            return
        except Exception as exc:
            logger.opt(exception=True).error(
                f"[GitMetadataEventService] watcher failed | repo={repository_id} | error={exc}"
            )

    def _ensure_open(self) -> None:
        if self._closed:
            raise RuntimeError("Git metadata event service is closed")


def git_metadata_domains(path: str) -> frozenset[str]:
    normalized = path.replace("\\", "/").strip("/")
    head = normalized.split("/", 1)[0]
    # A lock file is only a transient implementation detail. Successful index
    # mutations also change `index`; failed/optional locks do not change Git
    # state and must not trigger a status -> lock -> status refresh loop.
    if normalized.startswith("index.lock"):
        return frozenset()
    if normalized == "index":
        return frozenset({"status", "diff"})
    if normalized == "HEAD" or normalized == "packed-refs" or head == "refs":
        return frozenset({"status", "refs", "history"})
    if head == "logs":
        return frozenset({"history", "reflog"})
    if normalized in {
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "REBASE_HEAD",
        "BISECT_LOG",
        "BISECT_START",
    } or head in {"rebase-apply", "rebase-merge", "sequencer"}:
        return frozenset({"status", "operation"})
    if normalized in {"config", "config.worktree"}:
        return frozenset({"config", "remotes", "refs"})
    if head in {"modules", "worktrees"}:
        return frozenset({"repositories", "status", "refs"})
    return frozenset()


async def _default_watch_factory(
    git_dir: Path,
    stop_event: asyncio.Event,
) -> AsyncIterator[set[tuple[Change, str]]]:
    async for changes in awatch(
        git_dir,
        watch_filter=None,
        debounce=GIT_WATCH_DEBOUNCE_MS,
        step=GIT_WATCH_STEP_MS,
        stop_event=stop_event,
        recursive=True,
        ignore_permission_denied=True,
    ):
        yield changes


async def _cancel_task(task: asyncio.Task[None] | None) -> None:
    if task is None:
        return
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


def _path_key(path: str | Path) -> str:
    value = Path(path).resolve().as_posix().rstrip("/")
    return value.casefold() if os.name == "nt" else value
