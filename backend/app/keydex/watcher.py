from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.app.core.logger import logger
from backend.app.keydex.models import KeydexScope
from backend.app.keydex.registry import (
    DEFAULT_KEYDEX_CAPABILITY_REGISTRY,
    KeydexCapabilityRegistry,
)
from backend.app.keydex.runtime import KeydexLayerFingerprint, build_keydex_layer_fingerprint
from backend.app.keydex.runtime_cache import (
    KeydexCapabilityRuntimeCache,
    KeydexRuntimeCache,
    KeydexWorkspaceRuntimeCache,
)

KeydexChangedNotifier = Callable[[str, dict[str, Any]], Awaitable[bool]]
WatcherRuntimeCache = (
    KeydexCapabilityRuntimeCache | KeydexRuntimeCache | KeydexWorkspaceRuntimeCache
)


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
    capability_fingerprints: dict[str, str] = field(default_factory=dict)
    task: asyncio.Task | None = None


class KeydexWorkspaceWatcher:
    """Watch only Registry-declared Keydex sources and notify affected sessions."""

    def __init__(
        self,
        *,
        runtime_cache: WatcherRuntimeCache,
        notifier: KeydexChangedNotifier,
        registry: KeydexCapabilityRegistry = DEFAULT_KEYDEX_CAPABILITY_REGISTRY,
        poll_interval_seconds: float = 1.0,
        debounce_seconds: float = 0.2,
        start_tasks: bool = True,
    ) -> None:
        self._runtime_cache = runtime_cache
        self._notifier = notifier
        self._registry = registry
        self._poll_interval_seconds = poll_interval_seconds
        self._debounce_seconds = debounce_seconds
        self._start_tasks = start_tasks
        self._supports_system = hasattr(runtime_cache, "get_session_effective_snapshot")
        self._system_root = runtime_cache.system_root if self._supports_system else None
        self._system_layer_fingerprint = ""
        self._system_capability_fingerprints: dict[str, str] = {}
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
        workspace_fingerprint = self._build_workspace_layer_fingerprint(root) if root else None
        system_fingerprint = self._build_system_layer_fingerprint()
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
            if system_fingerprint is not None:
                self._system_layer_fingerprint = system_fingerprint.digest()
                self._system_capability_fingerprints = _capability_fingerprints(
                    system_fingerprint
                )
                if self._start_tasks and self._system_task is None:
                    self._system_task = asyncio.create_task(self._watch_system_loop())
            if root is not None and workspace_fingerprint is not None:
                key = _workspace_key(root)
                watched = self._watched_workspaces.get(key)
                if watched is None:
                    watched = _WatchedWorkspace(
                        workspace_root=root,
                        layer_fingerprint=workspace_fingerprint.digest(),
                        capability_fingerprints=_capability_fingerprints(
                            workspace_fingerprint
                        ),
                    )
                    self._watched_workspaces[key] = watched
                    if self._start_tasks:
                        watched.task = asyncio.create_task(self._watch_workspace_loop(key))
                watched.session_ids.add(cleaned_session_id)
        for task in tasks_to_cancel:
            task.cancel()
        logger.debug(
            "[KeydexWatcher] registered | "
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

    async def handle_system_path_change(
        self,
        changed_path: str | Path | None = None,
        *,
        previous_path: str | Path | None = None,
        observed_fingerprint: str | KeydexLayerFingerprint | None = None,
    ) -> bool:
        if not self._supports_system or self._system_root is None:
            return False
        matched, changed_paths = _match_changes(
            registry=self._registry,
            scope="system",
            root=self._system_root,
            changed_paths=(previous_path, changed_path),
        )
        if changed_path is not None and not matched:
            return False
        current = (
            observed_fingerprint
            if isinstance(observed_fingerprint, KeydexLayerFingerprint)
            else self._build_system_layer_fingerprint()
        )
        if current is None:
            return False
        current_digest = (
            observed_fingerprint
            if isinstance(observed_fingerprint, str)
            else current.digest()
        )
        current_capabilities = _capability_fingerprints(current)
        async with self._lock:
            if current_digest == self._system_layer_fingerprint:
                return False
            changed_capabilities = _ordered_changed_capabilities(
                self._registry,
                self._system_capability_fingerprints,
                current_capabilities,
                matched,
            )
            self._system_layer_fingerprint = current_digest
            self._system_capability_fingerprints = current_capabilities
            session_ids = sorted(self._sessions)
        self._runtime_cache.invalidate_system()  # type: ignore[union-attr]
        return await self._notify_changed_sessions(
            session_ids,
            changed_scope="system",
            changed_paths=changed_paths,
            changed_capabilities=changed_capabilities,
            capability_fingerprints=current_capabilities,
        )

    async def handle_workspace_path_change(
        self,
        workspace_root: str | Path,
        changed_path: str | Path | None = None,
        *,
        previous_path: str | Path | None = None,
        observed_fingerprint: str | KeydexLayerFingerprint | None = None,
    ) -> bool:
        root = Path(workspace_root).expanduser().resolve()
        matched, changed_paths = _match_changes(
            registry=self._registry,
            scope="workspace",
            root=root,
            changed_paths=(previous_path, changed_path),
        )
        if changed_path is not None and not matched:
            return False
        key = _workspace_key(root)
        current = (
            observed_fingerprint
            if isinstance(observed_fingerprint, KeydexLayerFingerprint)
            else self._build_workspace_layer_fingerprint(root)
        )
        current_digest = (
            observed_fingerprint
            if isinstance(observed_fingerprint, str)
            else current.digest()
        )
        current_capabilities = _capability_fingerprints(current)
        async with self._lock:
            watched = self._watched_workspaces.get(key)
            if watched is not None and current_digest == watched.layer_fingerprint:
                return False
            previous_capabilities = (
                watched.capability_fingerprints if watched is not None else {}
            )
            changed_capabilities = _ordered_changed_capabilities(
                self._registry,
                previous_capabilities,
                current_capabilities,
                matched,
            )
            session_ids = sorted(watched.session_ids) if watched is not None else []
            if watched is not None:
                watched.layer_fingerprint = current_digest
                watched.capability_fingerprints = current_capabilities
        self._invalidate_workspace(root)
        return await self._notify_changed_sessions(
            session_ids,
            changed_scope="workspace",
            changed_paths=changed_paths,
            changed_capabilities=changed_capabilities,
            capability_fingerprints=current_capabilities,
        )

    async def handle_path_change(
        self,
        workspace_root: str | Path,
        changed_path: str | Path | None = None,
        *,
        previous_path: str | Path | None = None,
        observed_fingerprint: str | KeydexLayerFingerprint | None = None,
    ) -> bool:
        return await self.handle_workspace_path_change(
            workspace_root,
            changed_path,
            previous_path=previous_path,
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
        changed_paths: tuple[str, ...],
        changed_capabilities: tuple[str, ...],
        capability_fingerprints: dict[str, str],
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
                first_path = changed_paths[-1] if changed_paths else None
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
                            "changed_path": first_path,
                            "changedPath": first_path,
                            "changed_paths": list(changed_paths),
                            "changedPaths": list(changed_paths),
                            "changed_capabilities": list(changed_capabilities),
                            "changedCapabilities": list(changed_capabilities),
                            "capability_fingerprints": dict(capability_fingerprints),
                            "capabilityFingerprints": dict(capability_fingerprints),
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
            "[KeydexWatcher] capability sources changed | "
            f"scope={changed_scope} | capabilities={','.join(changed_capabilities)} | "
            f"sessions={len(notifications)} | notified={sent}"
        )
        return True

    def _get_effective_fingerprint(self, workspace_root: Path | None) -> str:
        getter = getattr(self._runtime_cache, "get_session_effective_snapshot", None)
        if callable(getter):
            return getter(workspace_root).fingerprint
        if workspace_root is None:
            return ""
        return self._runtime_cache.get_snapshot(workspace_root).fingerprint  # type: ignore[union-attr]

    def _invalidate_workspace(self, workspace_root: Path) -> None:
        invalidator = getattr(self._runtime_cache, "invalidate_workspace", None)
        if callable(invalidator):
            invalidator(workspace_root)
            return
        self._runtime_cache.invalidate(workspace_root)  # type: ignore[union-attr]

    def _build_system_layer_fingerprint(self) -> KeydexLayerFingerprint | None:
        if not self._supports_system or self._system_root is None:
            return None
        return build_keydex_layer_fingerprint(
            "system",
            self._system_root,
            registry=self._registry,
        )

    def _build_workspace_layer_fingerprint(
        self,
        workspace_root: Path,
    ) -> KeydexLayerFingerprint:
        return build_keydex_layer_fingerprint(
            "workspace",
            workspace_root / ".keydex",
            registry=self._registry,
        )

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
                if current is None:
                    return
                async with self._lock:
                    previous = self._system_layer_fingerprint
                if current.digest() != previous:
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
                if current.digest() != previous:
                    await self.handle_workspace_path_change(
                        root,
                        observed_fingerprint=current,
                    )
        except asyncio.CancelledError:
            return


# Transitional import name for call sites migrated by KWR-010.
KeydexSkillsWatcher = KeydexWorkspaceWatcher


def is_keydex_watch_target(workspace_root: str | Path, changed_path: str | Path) -> bool:
    return is_keydex_layer_watch_target("workspace", workspace_root, changed_path)


def is_keydex_layer_watch_target(
    scope: KeydexScope,
    root: str | Path,
    changed_path: str | Path,
    *,
    registry: KeydexCapabilityRegistry = DEFAULT_KEYDEX_CAPABILITY_REGISTRY,
) -> bool:
    matched, _ = _match_changes(
        registry=registry,
        scope=scope,
        root=Path(root).expanduser().resolve(),
        changed_paths=(changed_path,),
    )
    return bool(matched)


def _match_changes(
    *,
    registry: KeydexCapabilityRegistry,
    scope: KeydexScope,
    root: Path,
    changed_paths: tuple[str | Path | None, ...],
) -> tuple[set[str], tuple[str, ...]]:
    if scope == "builtin":
        return set(), ()
    base = Path(root).expanduser().resolve()
    layer_root = base if scope == "system" else base / ".keydex"
    matched: set[str] = set()
    logical_paths: list[str] = []
    for changed_path in changed_paths:
        if changed_path is None:
            continue
        raw = Path(changed_path).expanduser()
        if raw.is_absolute():
            target = raw.resolve(strict=False)
        elif scope == "workspace" and raw.parts and raw.parts[0] == ".keydex":
            target = (base / raw).resolve(strict=False)
        else:
            target = (layer_root / raw).resolve(strict=False)
        if _path_key(target) == _path_key(layer_root.resolve(strict=False)):
            matched.update(
                capability.id
                for capability in registry
                if scope in capability.supported_scopes
            )
            logical_paths.append(".keydex" if scope == "workspace" else ".")
            continue
        for capability_id, spec in registry.watch_specs(scope):
            logical = spec.match(
                scope=scope,
                layer_root=layer_root,
                changed_path=target,
            )
            if logical is None:
                continue
            matched.add(capability_id)
            outward = f".keydex/{logical}" if scope == "workspace" else logical
            logical_paths.append(outward)
    return matched, tuple(dict.fromkeys(logical_paths))


def _ordered_changed_capabilities(
    registry: KeydexCapabilityRegistry,
    previous: dict[str, str],
    current: dict[str, str],
    matched: set[str],
) -> tuple[str, ...]:
    changed = {
        capability.id
        for capability in registry
        if previous.get(capability.id) != current.get(capability.id)
    }
    changed.update(matched)
    return tuple(capability.id for capability in registry if capability.id in changed)


def _capability_fingerprints(fingerprint: KeydexLayerFingerprint) -> dict[str, str]:
    return dict(fingerprint.capability_fingerprints)


def _workspace_key(path: Path) -> str:
    return _path_key(path.resolve())


def _path_key(path: Path) -> str:
    text = path.as_posix().rstrip("/")
    return text.casefold() if os.name == "nt" else text
