from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock

from backend.app.keydex.capabilities.base import (
    CapabilityComposeResult,
    CapabilityKey,
    CapabilityLoadResult,
    CapabilityWatchSpec,
)
from backend.app.keydex.registry import KeydexCapabilityRegistry
from backend.app.keydex.runtime_cache import KeydexCapabilityRuntimeCache


class _TextCapability:
    id = "text"
    effective_key = CapabilityKey("text", tuple)
    format_revision = "1"
    supported_scopes = frozenset({"builtin", "system", "workspace"})
    watch_specs = (CapabilityWatchSpec("source.txt"),)

    def __init__(self) -> None:
        self.load_count = 0
        self._lock = Lock()

    def load_layer(self, *, scope, root):
        with self._lock:
            self.load_count += 1
        source = root / "source.txt"
        if not source.is_file():
            return CapabilityLoadResult(payload="", state="empty")
        return CapabilityLoadResult(payload=source.read_text(encoding="utf-8"))

    def compose(self, *, mode, layers):
        return CapabilityComposeResult(
            payload=tuple(
                (layer.scope, layer.payload)
                for layer in layers
                if layer.available and layer.state != "empty"
            ),
            sources=tuple(source for layer in layers for source in layer.sources),
        )


def _write(root: Path, value: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "source.txt").write_text(value, encoding="utf-8")


def _cache(tmp_path: Path) -> tuple[KeydexCapabilityRuntimeCache, _TextCapability]:
    capability = _TextCapability()
    cache = KeydexCapabilityRuntimeCache(
        builtin_root=tmp_path / "builtin",
        system_root=tmp_path / "system",
        registry=KeydexCapabilityRegistry((capability,)),
    )
    return cache, capability


def test_kr14_hot_cache_reuses_layer_and_effective_snapshot(tmp_path: Path) -> None:
    _write(tmp_path / "builtin", "builtin")
    _write(tmp_path / "system", "system")
    cache, capability = _cache(tmp_path)

    first = cache.get_system_snapshot()
    second = cache.get_system_snapshot()

    assert second is first
    assert capability.load_count == 2
    assert first.require(capability.effective_key) == (
        ("builtin", "builtin"),
        ("system", "system"),
    )


def test_kr15_system_invalidation_rebuilds_all_effective_views_only(tmp_path: Path) -> None:
    _write(tmp_path / "builtin", "builtin")
    _write(tmp_path / "system", "system-v1")
    _write(tmp_path / "a" / ".keydex", "a")
    _write(tmp_path / "b" / ".keydex", "b")
    cache, _ = _cache(tmp_path)
    system_before = cache.get_system_snapshot()
    a_before = cache.get_workspace_snapshot(tmp_path / "a")
    b_before = cache.get_workspace_snapshot(tmp_path / "b")
    a_layer = cache.get_workspace_layer_snapshot(tmp_path / "a")
    b_layer = cache.get_workspace_layer_snapshot(tmp_path / "b")

    _write(tmp_path / "system", "system-v2")
    cache.invalidate_system()
    system_after = cache.get_system_snapshot()
    a_after = cache.get_workspace_snapshot(tmp_path / "a")
    b_after = cache.get_workspace_snapshot(tmp_path / "b")

    assert system_after is not system_before
    assert a_after is not a_before
    assert b_after is not b_before
    assert cache.get_workspace_layer_snapshot(tmp_path / "a") is a_layer
    assert cache.get_workspace_layer_snapshot(tmp_path / "b") is b_layer


def test_kr16_workspace_a_invalidation_does_not_rebuild_workspace_b(tmp_path: Path) -> None:
    _write(tmp_path / "builtin", "builtin")
    _write(tmp_path / "system", "system")
    _write(tmp_path / "a" / ".keydex", "a-v1")
    _write(tmp_path / "b" / ".keydex", "b")
    cache, capability = _cache(tmp_path)
    a_before = cache.get_workspace_snapshot(tmp_path / "a")
    b_before = cache.get_workspace_snapshot(tmp_path / "b")
    count_before = capability.load_count

    _write(tmp_path / "a" / ".keydex", "a-v2")
    cache.invalidate_workspace(tmp_path / "a")
    b_after = cache.get_workspace_snapshot(tmp_path / "b")
    a_after = cache.get_workspace_snapshot(tmp_path / "a")

    assert b_after is b_before
    assert a_after is not a_before
    assert capability.load_count == count_before + 1


def test_kr17_concurrent_cold_load_builds_each_layer_once(tmp_path: Path) -> None:
    _write(tmp_path / "builtin", "builtin")
    _write(tmp_path / "system", "system")
    cache, capability = _cache(tmp_path)

    with ThreadPoolExecutor(max_workers=8) as executor:
        snapshots = list(executor.map(lambda _: cache.get_system_snapshot(), range(16)))

    assert all(snapshot is snapshots[0] for snapshot in snapshots)
    assert capability.load_count == 2


def test_force_reload_refreshes_the_complete_effective_snapshot(tmp_path: Path) -> None:
    _write(tmp_path / "builtin", "builtin")
    _write(tmp_path / "system", "system")
    _write(tmp_path / "workspace" / ".keydex", "workspace")
    cache, capability = _cache(tmp_path)
    before = cache.get_workspace_snapshot(tmp_path / "workspace")
    count_before = capability.load_count

    after = cache.get_session_effective_snapshot(
        tmp_path / "workspace",
        force_reload=True,
    )

    assert after is not before
    assert capability.load_count == count_before + 3
