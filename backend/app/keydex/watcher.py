from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.app.core.logger import logger
from backend.app.keydex.runtime import build_keydex_workspace_fingerprint
from backend.app.keydex.runtime_cache import KeydexWorkspaceRuntimeCache

WorkspaceSkillsChangedNotifier = Callable[[str, dict[str, Any]], Awaitable[bool]]


@dataclass
class _WatchedWorkspace:
    workspace_root: Path
    session_ids: set[str] = field(default_factory=set)
    fingerprint: str = ""
    task: asyncio.Task | None = None
    last_notified_fingerprint: str = ""
    last_event_at: float = 0.0


class KeydexWorkspaceWatcher:
    def __init__(
        self,
        *,
        runtime_cache: KeydexWorkspaceRuntimeCache,
        notifier: WorkspaceSkillsChangedNotifier,
        poll_interval_seconds: float = 1.0,
        debounce_seconds: float = 0.2,
        start_tasks: bool = True,
    ) -> None:
        self._runtime_cache = runtime_cache
        self._notifier = notifier
        self._poll_interval_seconds = poll_interval_seconds
        self._debounce_seconds = debounce_seconds
        self._start_tasks = start_tasks
        self._watched: dict[str, _WatchedWorkspace] = {}
        self._lock = asyncio.Lock()

    async def register_session(self, session_id: str, workspace_root: str | Path) -> None:
        cleaned_session_id = session_id.strip()
        if not cleaned_session_id:
            return
        root = Path(workspace_root).expanduser().resolve()
        key = _workspace_key(root)
        async with self._lock:
            watched = self._watched.get(key)
            if watched is None:
                watched = _WatchedWorkspace(
                    workspace_root=root,
                    fingerprint=build_keydex_workspace_fingerprint(root).digest(),
                )
                self._watched[key] = watched
                if self._start_tasks:
                    watched.task = asyncio.create_task(self._watch_loop(key))
            watched.session_ids.add(cleaned_session_id)
        logger.debug(
            f"[KeydexWatcher] 注册 workspace skill watcher | "
            f"session_id={cleaned_session_id} | workspace_root={root}"
        )

    async def unregister_session(self, session_id: str) -> None:
        cleaned_session_id = session_id.strip()
        if not cleaned_session_id:
            return
        tasks_to_cancel: list[asyncio.Task] = []
        async with self._lock:
            empty_keys: list[str] = []
            for key, watched in self._watched.items():
                watched.session_ids.discard(cleaned_session_id)
                if not watched.session_ids:
                    empty_keys.append(key)
                    if watched.task is not None:
                        tasks_to_cancel.append(watched.task)
            for key in empty_keys:
                self._watched.pop(key, None)
        for task in tasks_to_cancel:
            task.cancel()
        logger.debug(
            f"[KeydexWatcher] 注销 workspace skill watcher | session_id={cleaned_session_id}"
        )

    async def handle_path_change(
        self,
        workspace_root: str | Path,
        changed_path: str | Path | None = None,
        *,
        observed_fingerprint: str | None = None,
    ) -> bool:
        root = Path(workspace_root).expanduser().resolve()
        if changed_path is not None and not is_keydex_watch_target(root, changed_path):
            return False

        key = _workspace_key(root)
        current_fingerprint = (
            observed_fingerprint or build_keydex_workspace_fingerprint(root).digest()
        )
        now = time.monotonic()
        async with self._lock:
            watched = self._watched.get(key)
            session_ids = sorted(watched.session_ids) if watched else []
            if watched is not None:
                if (
                    self._debounce_seconds > 0
                    and current_fingerprint == watched.last_notified_fingerprint
                    and now - watched.last_event_at < self._debounce_seconds
                ):
                    return False
                watched.fingerprint = current_fingerprint
                watched.last_notified_fingerprint = current_fingerprint
                watched.last_event_at = now

        self._runtime_cache.invalidate(root)
        payload = {
            "workspace_root": root.as_posix(),
            "workspaceRoot": root.as_posix(),
            "changed_path": _changed_path_payload(root, changed_path),
            "changedPath": _changed_path_payload(root, changed_path),
            "fingerprint": current_fingerprint,
        }
        sent = False
        for session_id in session_ids:
            if await self._notifier(session_id, payload):
                sent = True
        logger.info(
            "[KeydexWatcher] workspace skills changed | "
            f"workspace_root={root} | sessions={len(session_ids)} | notified={sent}"
        )
        return True

    async def close(self) -> None:
        async with self._lock:
            tasks = [watched.task for watched in self._watched.values() if watched.task is not None]
            self._watched.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _watch_loop(self, key: str) -> None:
        try:
            while True:
                await asyncio.sleep(self._poll_interval_seconds)
                async with self._lock:
                    watched = self._watched.get(key)
                    if watched is None:
                        return
                    root = watched.workspace_root
                    previous_fingerprint = watched.fingerprint
                current_fingerprint = build_keydex_workspace_fingerprint(root).digest()
                if current_fingerprint != previous_fingerprint:
                    await self.handle_path_change(
                        root,
                        observed_fingerprint=current_fingerprint,
                    )
        except asyncio.CancelledError:
            return


def is_keydex_watch_target(workspace_root: str | Path, changed_path: str | Path) -> bool:
    root = Path(workspace_root).expanduser().resolve()
    raw_changed = Path(changed_path).expanduser()
    target = (root / raw_changed if not raw_changed.is_absolute() else raw_changed).resolve(
        strict=False
    )
    keydex_json = (root / ".keydex" / "keydex.json").resolve(strict=False)
    if _path_key(target) == _path_key(keydex_json):
        return True
    skills_root = (root / ".keydex" / "skills").resolve(strict=False)
    if target.name != "SKILL.md":
        return False
    try:
        target.relative_to(skills_root)
        return True
    except ValueError:
        return False


def _changed_path_payload(workspace_root: Path, changed_path: str | Path | None) -> str | None:
    if changed_path is None:
        return None
    raw_changed = Path(changed_path).expanduser()
    target = (
        workspace_root / raw_changed if not raw_changed.is_absolute() else raw_changed
    ).resolve(strict=False)
    try:
        return target.relative_to(workspace_root).as_posix()
    except ValueError:
        return target.as_posix()


def _workspace_key(path: Path) -> str:
    return _path_key(path.resolve())


def _path_key(path: Path) -> str:
    text = path.as_posix().rstrip("/")
    return text.casefold() if os.name == "nt" else text
