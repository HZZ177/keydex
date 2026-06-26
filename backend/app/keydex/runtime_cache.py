from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from threading import RLock

from backend.app.keydex.runtime import (
    KeydexWorkspaceFingerprint,
    KeydexWorkspaceRuntimeSnapshot,
    build_keydex_workspace_fingerprint,
    build_keydex_workspace_runtime_snapshot,
)

SnapshotBuilder = Callable[[Path], KeydexWorkspaceRuntimeSnapshot]
FingerprintBuilder = Callable[[Path], KeydexWorkspaceFingerprint]


class KeydexWorkspaceRuntimeCache:
    def __init__(
        self,
        *,
        snapshot_builder: SnapshotBuilder = build_keydex_workspace_runtime_snapshot,
        fingerprint_builder: FingerprintBuilder = build_keydex_workspace_fingerprint,
    ) -> None:
        self._snapshot_builder = snapshot_builder
        self._fingerprint_builder = fingerprint_builder
        self._snapshots: dict[str, KeydexWorkspaceRuntimeSnapshot] = {}
        self._lock = RLock()

    def get_snapshot(
        self,
        workspace_root: str | Path,
        *,
        force_reload: bool = False,
    ) -> KeydexWorkspaceRuntimeSnapshot:
        root = Path(workspace_root).expanduser().resolve()
        cache_key = _cache_key(root)
        with self._lock:
            current_fingerprint = self._fingerprint_builder(root).digest()
            cached = self._snapshots.get(cache_key)
            if (
                cached is not None
                and not force_reload
                and cached.fingerprint == current_fingerprint
            ):
                return cached

            snapshot = self._snapshot_builder(root)
            self._snapshots[cache_key] = snapshot
            return snapshot

    def invalidate(self, workspace_root: str | Path) -> None:
        root = Path(workspace_root).expanduser().resolve()
        with self._lock:
            self._snapshots.pop(_cache_key(root), None)

    def invalidate_all(self) -> None:
        with self._lock:
            self._snapshots.clear()


def _cache_key(workspace_root: Path) -> str:
    return workspace_root.as_posix().rstrip("/")
