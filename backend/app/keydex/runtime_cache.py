from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from threading import RLock

from backend.app.keydex.builtin_skills import BUILTIN_SKILLS_ROOT
from backend.app.keydex.models import KeydexScope, resolve_system_keydex_root
from backend.app.keydex.runtime import (
    KeydexEffectiveRuntimeSnapshot,
    KeydexLayerFingerprint,
    KeydexLayerRuntimeSnapshot,
    KeydexWorkspaceFingerprint,
    KeydexWorkspaceRuntimeSnapshot,
    build_keydex_builtin_layer_runtime_snapshot,
    build_keydex_layer_fingerprint,
    build_keydex_system_layer_runtime_snapshot,
    build_keydex_workspace_fingerprint,
    build_keydex_workspace_layer_runtime_snapshot,
    build_keydex_workspace_runtime_snapshot,
    compose_keydex_effective_runtime_snapshot,
)

SnapshotBuilder = Callable[[Path], KeydexWorkspaceRuntimeSnapshot]
FingerprintBuilder = Callable[[Path], KeydexWorkspaceFingerprint]
LayerFingerprintBuilder = Callable[[KeydexScope, Path], KeydexLayerFingerprint]
SystemSnapshotBuilder = Callable[[Path], KeydexLayerRuntimeSnapshot]
WorkspaceLayerSnapshotBuilder = Callable[[Path], KeydexLayerRuntimeSnapshot]
BuiltinSnapshotBuilder = Callable[[Path], KeydexLayerRuntimeSnapshot]


@dataclass(frozen=True)
class _EffectiveCacheKey:
    mode: str
    workspace_key: str | None
    builtin_fingerprint: str | None
    system_fingerprint: str | None
    workspace_fingerprint: str | None
    inherit_system: bool
    available: bool


class KeydexRuntimeCache:
    def __init__(
        self,
        *,
        system_root: str | Path | None = None,
        builtin_root: str | Path | None = None,
        fingerprint_builder: LayerFingerprintBuilder = build_keydex_layer_fingerprint,
        builtin_snapshot_builder: BuiltinSnapshotBuilder = (
            build_keydex_builtin_layer_runtime_snapshot
        ),
        system_snapshot_builder: SystemSnapshotBuilder = build_keydex_system_layer_runtime_snapshot,
        workspace_snapshot_builder: WorkspaceLayerSnapshotBuilder = (
            build_keydex_workspace_layer_runtime_snapshot
        ),
    ) -> None:
        self._system_root = (
            resolve_system_keydex_root()
            if system_root is None
            else Path(system_root).expanduser().resolve()
        )
        self._builtin_root = (
            BUILTIN_SKILLS_ROOT
            if builtin_root is None
            else Path(builtin_root).expanduser().resolve()
        )
        self._fingerprint_builder = fingerprint_builder
        self._builtin_snapshot_builder = builtin_snapshot_builder
        self._system_snapshot_builder = system_snapshot_builder
        self._workspace_snapshot_builder = workspace_snapshot_builder
        self._builtin_layer: KeydexLayerRuntimeSnapshot | None = None
        self._system_layer: KeydexLayerRuntimeSnapshot | None = None
        self._workspace_layers: dict[str, KeydexLayerRuntimeSnapshot] = {}
        self._effective_snapshots: dict[_EffectiveCacheKey, KeydexEffectiveRuntimeSnapshot] = {}
        self._lock = RLock()

    @property
    def system_root(self) -> Path:
        return self._system_root

    @property
    def builtin_root(self) -> Path:
        return self._builtin_root

    def get_builtin_layer_snapshot(
        self,
        *,
        force_reload: bool = False,
    ) -> KeydexLayerRuntimeSnapshot:
        with self._lock:
            current = self._fingerprint_builder("builtin", self._builtin_root).digest()
            cached = self._builtin_layer
            if cached is not None and not force_reload and cached.fingerprint == current:
                return cached
            snapshot = self._builtin_snapshot_builder(self._builtin_root)
            self._builtin_layer = snapshot
            self._effective_snapshots.clear()
            return snapshot

    def get_system_layer_snapshot(
        self,
        *,
        force_reload: bool = False,
    ) -> KeydexLayerRuntimeSnapshot:
        with self._lock:
            current = self._fingerprint_builder("system", self._system_root).digest()
            cached = self._system_layer
            if cached is not None and not force_reload and cached.fingerprint == current:
                return cached
            snapshot = self._system_snapshot_builder(self._system_root)
            self._system_layer = snapshot
            self._invalidate_system_effective_locked()
            return snapshot

    def get_workspace_layer_snapshot(
        self,
        workspace_root: str | Path,
        *,
        force_reload: bool = False,
    ) -> KeydexLayerRuntimeSnapshot:
        root = Path(workspace_root).expanduser().resolve()
        cache_key = _cache_key(root)
        with self._lock:
            current = self._fingerprint_builder("workspace", root / ".keydex").digest()
            cached = self._workspace_layers.get(cache_key)
            if cached is not None and not force_reload and cached.fingerprint == current:
                return cached
            snapshot = self._workspace_snapshot_builder(root)
            self._workspace_layers[cache_key] = snapshot
            self._invalidate_workspace_effective_locked(cache_key)
            return snapshot

    def get_system_snapshot(
        self,
        *,
        force_reload: bool = False,
    ) -> KeydexEffectiveRuntimeSnapshot:
        with self._lock:
            builtin = self.get_builtin_layer_snapshot()
            system = self.get_system_layer_snapshot(force_reload=force_reload)
            key = _EffectiveCacheKey(
                mode="system_only",
                workspace_key=None,
                builtin_fingerprint=builtin.fingerprint,
                system_fingerprint=system.fingerprint,
                workspace_fingerprint=None,
                inherit_system=True,
                available=(
                    system.skill_catalog.available or builtin.skill_catalog.available
                ),
            )
            cached = self._effective_snapshots.get(key)
            if cached is not None:
                return cached
            snapshot = compose_keydex_effective_runtime_snapshot(
                system,
                builtin_layer=builtin,
            )
            self._effective_snapshots[key] = snapshot
            return snapshot

    def get_workspace_snapshot(
        self,
        workspace_root: str | Path,
        *,
        force_reload: bool = False,
    ) -> KeydexEffectiveRuntimeSnapshot:
        root = Path(workspace_root).expanduser().resolve()
        workspace_key = _cache_key(root)
        with self._lock:
            # API force_reload refreshes the mutable workspace view only. Builtin
            # release content changes on application upgrade/restart or through
            # the explicit invalidate_builtin hook used by development tests.
            builtin = self.get_builtin_layer_snapshot()
            system = self.get_system_layer_snapshot()
            workspace = self.get_workspace_layer_snapshot(root, force_reload=force_reload)
            inherit_system = workspace.profile.inherit_system
            key = _EffectiveCacheKey(
                mode="workspace_effective",
                workspace_key=workspace_key,
                builtin_fingerprint=builtin.fingerprint,
                system_fingerprint=system.fingerprint if inherit_system else None,
                workspace_fingerprint=workspace.fingerprint,
                inherit_system=inherit_system,
                available=workspace.skill_catalog.available,
            )
            cached = self._effective_snapshots.get(key)
            if cached is not None:
                return cached
            snapshot = compose_keydex_effective_runtime_snapshot(
                system,
                workspace,
                workspace_root=root,
                builtin_layer=builtin,
            )
            self._effective_snapshots[key] = snapshot
            return snapshot

    def get_session_effective_snapshot(
        self,
        workspace_root: str | Path | None = None,
        *,
        force_reload: bool = False,
    ) -> KeydexEffectiveRuntimeSnapshot:
        if workspace_root is None:
            return self.get_system_snapshot(force_reload=force_reload)
        return self.get_workspace_snapshot(workspace_root, force_reload=force_reload)

    def invalidate_system(self) -> None:
        with self._lock:
            self._system_layer = None
            self._invalidate_system_effective_locked()

    def invalidate_builtin(self) -> None:
        with self._lock:
            self._builtin_layer = None
            self._effective_snapshots.clear()

    def invalidate_workspace(self, workspace_root: str | Path) -> None:
        root = Path(workspace_root).expanduser().resolve()
        cache_key = _cache_key(root)
        with self._lock:
            self._workspace_layers.pop(cache_key, None)
            self._invalidate_workspace_effective_locked(cache_key)

    def invalidate_all(self) -> None:
        with self._lock:
            self._builtin_layer = None
            self._system_layer = None
            self._workspace_layers.clear()
            self._effective_snapshots.clear()

    def _invalidate_system_effective_locked(self) -> None:
        for key in list(self._effective_snapshots):
            if key.mode == "system_only" or key.system_fingerprint is not None:
                self._effective_snapshots.pop(key, None)

    def _invalidate_workspace_effective_locked(self, workspace_key: str) -> None:
        for key in list(self._effective_snapshots):
            if key.workspace_key == workspace_key:
                self._effective_snapshots.pop(key, None)


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
