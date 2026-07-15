from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.app.core.logger import logger
from backend.app.keydex.models import KeydexScope
from backend.app.keydex.runtime import build_keydex_layer_fingerprint
from backend.app.keydex.runtime_cache import KeydexRuntimeCache, KeydexWorkspaceRuntimeCache

KeydexSkillsChangedNotifier = Callable[[str, dict[str, Any]], Awaitable[bool]]


@dataclass
class _WatchedSession:
    session_id: str
    workspace_root: Path | None
    effective_fingerprint: str


@dataclass
class _WatchedWorkspace:
    workspace_root: Path
    session_ids: set[str] = field(default_factory=set)
    layer_fingerprint: str = ""
    task: asyncio.Task | None = None


class KeydexSkillsWatcher:
    """Watch system and workspace layers while notifying only affected effective views."""

    def __init__(
        self,
        *,
        runtime_cache: KeydexRuntimeCache | KeydexWorkspaceRuntimeCache,
        notifier: KeydexSkillsChangedNotifier,
        poll_interval_seconds: float = 1.0,
        debounce_seconds: float = 0.2,
        start_tasks: bool = True,
    ) -> None:
        self._runtime_cache = runtime_cache
        self._notifier = notifier
        self._poll_interval_seconds = poll_interval_seconds
        # Kept in the public constructor for compatibility. Fingerprint equality,
        # rather than time alone, is the authoritative event de-duplication rule.
        self._debounce_seconds = debounce_seconds
        self._start_tasks = start_tasks
        self._supports_system = isinstance(runtime_cache, KeydexRuntimeCache)
        self._system_root = runtime_cache.system_root if self._supports_system else None
        self._system_layer_fingerprint = ""
        self._system_task: asyncio.Task | None = None
        self._sessions: dict[str, _WatchedSession] = {}
        self._watched_workspaces: dict[str, _WatchedWorkspace] = {}
        self._lock = asyncio.Lock()

    async def register_session(
        self,
        session_id: str,
        workspace_root: str | Path | None = None,
    ) -> None:
        cleaned_session_id = session_id.strip()
        if not cleaned_session_id:
            return
        root = (
            Path(workspace_root).expanduser().resolve()
            if workspace_root is not None
            else None
        )
        if root is None and not self._supports_system:
            return

        effective_fingerprint = self._get_effective_fingerprint(root)
        workspace_layer_fingerprint = self._build_workspace_layer_fingerprint(root) if root else ""
        system_layer_fingerprint = self._build_system_layer_fingerprint()
        tasks_to_cancel: list[asyncio.Task] = []
        async with self._lock:
            existing = self._sessions.get(cleaned_session_id)
            if existing is not None and existing.workspace_root == root:
                existing.effective_fingerprint = effective_fingerprint
                return
            tasks_to_cancel.extend(self._remove_session_locked(cleaned_session_id))
            self._sessions[cleaned_session_id] = _WatchedSession(
                session_id=cleaned_session_id,
                workspace_root=root,
                effective_fingerprint=effective_fingerprint,
            )
            if self._supports_system:
                self._system_layer_fingerprint = system_layer_fingerprint
                if self._start_tasks and self._system_task is None:
                    self._system_task = asyncio.create_task(self._watch_system_loop())
            if root is not None:
                key = _workspace_key(root)
                watched = self._watched_workspaces.get(key)
                if watched is None:
                    watched = _WatchedWorkspace(
                        workspace_root=root,
                        layer_fingerprint=workspace_layer_fingerprint,
                    )
                    self._watched_workspaces[key] = watched
                    if self._start_tasks:
                        watched.task = asyncio.create_task(self._watch_workspace_loop(key))
                watched.session_ids.add(cleaned_session_id)
        for task in tasks_to_cancel:
            task.cancel()
        logger.debug(
            "[KeydexWatcher] 注册 skill watcher | "
            f"session_id={cleaned_session_id} | "
            f"scope={'workspace' if root is not None else 'system'}"
        )

    async def unregister_session(self, session_id: str) -> None:
        cleaned_session_id = session_id.strip()
        if not cleaned_session_id:
            return
        async with self._lock:
            tasks_to_cancel = self._remove_session_locked(cleaned_session_id)
        for task in tasks_to_cancel:
            task.cancel()
        logger.debug(f"[KeydexWatcher] 注销 skill watcher | session_id={cleaned_session_id}")

    async def handle_system_path_change(
        self,
        changed_path: str | Path | None = None,
        *,
        observed_fingerprint: str | None = None,
    ) -> bool:
        if not self._supports_system or self._system_root is None:
            return False
        if changed_path is not None and not is_keydex_layer_watch_target(
            "system", self._system_root, changed_path
        ):
            return False
        current = observed_fingerprint or self._build_system_layer_fingerprint()
        async with self._lock:
            if current == self._system_layer_fingerprint:
                return False
            self._system_layer_fingerprint = current
            session_ids = sorted(self._sessions)
        assert isinstance(self._runtime_cache, KeydexRuntimeCache)
        self._runtime_cache.invalidate_system()
        return await self._notify_changed_sessions(
            session_ids,
            changed_scope="system",
            changed_path=_logical_changed_path(self._system_root, changed_path),
        )

    async def handle_workspace_path_change(
        self,
        workspace_root: str | Path,
        changed_path: str | Path | None = None,
        *,
        observed_fingerprint: str | None = None,
    ) -> bool:
        root = Path(workspace_root).expanduser().resolve()
        if changed_path is not None and not is_keydex_layer_watch_target(
            "workspace", root, changed_path
        ):
            return False
        key = _workspace_key(root)
        current = observed_fingerprint or self._build_workspace_layer_fingerprint(root)
        async with self._lock:
            watched = self._watched_workspaces.get(key)
            if watched is not None and current == watched.layer_fingerprint:
                return False
            session_ids = sorted(watched.session_ids) if watched is not None else []
            if watched is not None:
                watched.layer_fingerprint = current
        self._invalidate_workspace(root)
        return await self._notify_changed_sessions(
            session_ids,
            changed_scope="workspace",
            changed_path=_logical_changed_path(root, changed_path),
        )

    async def handle_path_change(
        self,
        workspace_root: str | Path,
        changed_path: str | Path | None = None,
        *,
        observed_fingerprint: str | None = None,
    ) -> bool:
        """Compatibility entrypoint for the former workspace-only watcher."""

        return await self.handle_workspace_path_change(
            workspace_root,
            changed_path,
            observed_fingerprint=observed_fingerprint,
        )

    async def close(self) -> None:
        async with self._lock:
            tasks = [
                watched.task
                for watched in self._watched_workspaces.values()
                if watched.task is not None
            ]
            if self._system_task is not None:
                tasks.append(self._system_task)
            self._sessions.clear()
            self._watched_workspaces.clear()
            self._system_task = None
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _notify_changed_sessions(
        self,
        session_ids: list[str],
        *,
        changed_scope: KeydexScope,
        changed_path: str | None,
    ) -> bool:
        notifications: list[tuple[str, dict[str, Any]]] = []
        async with self._lock:
            for session_id in session_ids:
                session = self._sessions.get(session_id)
                if session is None:
                    continue
                effective_fingerprint = self._get_effective_fingerprint(session.workspace_root)
                if effective_fingerprint == session.effective_fingerprint:
                    continue
                session.effective_fingerprint = effective_fingerprint
                session_scope = "workspace" if session.workspace_root is not None else "system"
                workspace_root = (
                    session.workspace_root.as_posix()
                    if session.workspace_root is not None
                    else None
                )
                notifications.append(
                    (
                        session_id,
                        {
                            "session_id": session_id,
                            "sessionId": session_id,
                            "session_scope": session_scope,
                            "sessionScope": session_scope,
                            "workspace_root": workspace_root,
                            "workspaceRoot": workspace_root,
                            "changed_scope": changed_scope,
                            "changedScope": changed_scope,
                            "changed_path": changed_path,
                            "changedPath": changed_path,
                            "effective_fingerprint": effective_fingerprint,
                            "effectiveFingerprint": effective_fingerprint,
                            "fingerprint": effective_fingerprint,
                        },
                    )
                )
        sent = False
        for session_id, payload in notifications:
            if await self._notifier(session_id, payload):
                sent = True
        logger.info(
            "[KeydexWatcher] skills changed | "
            f"changed_scope={changed_scope} | sessions={len(notifications)} | notified={sent}"
        )
        # A layer change is handled even when no effective session view changes.
        return True

    def _get_effective_fingerprint(self, workspace_root: Path | None) -> str:
        if isinstance(self._runtime_cache, KeydexRuntimeCache):
            return self._runtime_cache.get_session_effective_snapshot(workspace_root).fingerprint
        if workspace_root is None:
            return ""
        return self._runtime_cache.get_snapshot(workspace_root).fingerprint

    def _invalidate_workspace(self, workspace_root: Path) -> None:
        if isinstance(self._runtime_cache, KeydexRuntimeCache):
            self._runtime_cache.invalidate_workspace(workspace_root)
        else:
            self._runtime_cache.invalidate(workspace_root)

    def _build_system_layer_fingerprint(self) -> str:
        if not self._supports_system or self._system_root is None:
            return ""
        return build_keydex_layer_fingerprint("system", self._system_root).digest()

    @staticmethod
    def _build_workspace_layer_fingerprint(workspace_root: Path) -> str:
        return build_keydex_layer_fingerprint(
            "workspace", workspace_root / ".keydex"
        ).digest()

    def _remove_session_locked(self, session_id: str) -> list[asyncio.Task]:
        session = self._sessions.pop(session_id, None)
        tasks: list[asyncio.Task] = []
        if session is not None and session.workspace_root is not None:
            key = _workspace_key(session.workspace_root)
            watched = self._watched_workspaces.get(key)
            if watched is not None:
                watched.session_ids.discard(session_id)
                if not watched.session_ids:
                    self._watched_workspaces.pop(key, None)
                    if watched.task is not None:
                        tasks.append(watched.task)
        if not self._sessions and self._system_task is not None:
            tasks.append(self._system_task)
            self._system_task = None
        return tasks

    async def _watch_system_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(self._poll_interval_seconds)
                current = self._build_system_layer_fingerprint()
                async with self._lock:
                    previous = self._system_layer_fingerprint
                if current != previous:
                    await self.handle_system_path_change(observed_fingerprint=current)
        except asyncio.CancelledError:
            return

    async def _watch_workspace_loop(self, key: str) -> None:
        try:
            while True:
                await asyncio.sleep(self._poll_interval_seconds)
                async with self._lock:
                    watched = self._watched_workspaces.get(key)
                    if watched is None:
                        return
                    root = watched.workspace_root
                    previous = watched.layer_fingerprint
                current = self._build_workspace_layer_fingerprint(root)
                if current != previous:
                    await self.handle_workspace_path_change(
                        root, observed_fingerprint=current
                    )
        except asyncio.CancelledError:
            return


# Transitional import name retained while existing extensions migrate.
KeydexWorkspaceWatcher = KeydexSkillsWatcher


def is_keydex_watch_target(workspace_root: str | Path, changed_path: str | Path) -> bool:
    return is_keydex_layer_watch_target("workspace", workspace_root, changed_path)


def is_keydex_layer_watch_target(
    scope: KeydexScope,
    root: str | Path,
    changed_path: str | Path,
) -> bool:
    if scope == "builtin":
        return False
    base = Path(root).expanduser().resolve()
    keydex_root = base if scope == "system" else base / ".keydex"
    raw_changed = Path(changed_path).expanduser()
    target = (base / raw_changed if not raw_changed.is_absolute() else raw_changed).resolve(
        strict=False
    )
    manifest = (keydex_root / "keydex.json").resolve(strict=False)
    skills_root = (keydex_root / "skills").resolve(strict=False)
    if _path_key(target) in {
        _path_key(keydex_root.resolve(strict=False)),
        _path_key(manifest),
        _path_key(skills_root),
    }:
        return True
    try:
        target.relative_to(skills_root)
        return True
    except ValueError:
        return False


def _logical_changed_path(root: Path, changed_path: str | Path | None) -> str | None:
    if changed_path is None:
        return None
    raw_changed = Path(changed_path).expanduser()
    target = (root / raw_changed if not raw_changed.is_absolute() else raw_changed).resolve(
        strict=False
    )
    try:
        return target.relative_to(root).as_posix()
    except ValueError:
        return None


def _workspace_key(path: Path) -> str:
    return _path_key(path.resolve())


def _path_key(path: Path) -> str:
    text = path.as_posix().rstrip("/")
    return text.casefold() if os.name == "nt" else text
