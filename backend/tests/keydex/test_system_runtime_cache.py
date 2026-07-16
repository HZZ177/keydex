import asyncio
from pathlib import Path

import pytest

from backend.app.keydex import KeydexRuntimeCache
from backend.app.keydex.runtime import (
    build_keydex_layer_fingerprint,
    build_keydex_system_layer_runtime_snapshot,
    build_keydex_workspace_layer_runtime_snapshot,
)


def _write_skill(root: Path, name: str, description: str = "skill") -> None:
    skill_root = root / "skills" / name
    skill_root.mkdir(parents=True, exist_ok=True)
    (skill_root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n",
        encoding="utf-8",
    )


def test_t47_cold_cache_builds_three_layers(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    _write_skill(system_root, "global")
    _write_skill(workspace_root / ".keydex", "local")
    cache = KeydexRuntimeCache(system_root=system_root)

    snapshot = cache.get_workspace_snapshot(workspace_root)

    assert cache.get_system_layer_snapshot() is snapshot.system_layer
    assert cache.get_workspace_layer_snapshot(workspace_root) is snapshot.workspace_layer
    assert list(snapshot.skill_catalog.skills) == ["global", "keydex-guide", "local"]
    assert snapshot.builtin_layer is not None
    assert cache.get_builtin_layer_snapshot() is snapshot.builtin_layer


def test_t48_hot_cache_reuses_system_and_effective_snapshots(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    _write_skill(system_root, "global")
    fingerprint_calls: list[str] = []
    build_calls: list[Path] = []

    def fingerprint_builder(scope, root):
        fingerprint_calls.append(scope)
        return build_keydex_layer_fingerprint(scope, root)

    def system_builder(root: Path):
        build_calls.append(root)
        return build_keydex_system_layer_runtime_snapshot(root)

    cache = KeydexRuntimeCache(
        system_root=system_root,
        fingerprint_builder=fingerprint_builder,
        system_snapshot_builder=system_builder,
    )

    first = cache.get_system_snapshot()
    second = cache.get_system_snapshot()

    assert second is first
    assert second.system_layer is first.system_layer
    assert fingerprint_calls == ["builtin", "system", "builtin", "system"]
    assert build_calls == [system_root.resolve()]


def test_t46_multiple_workspaces_share_one_system_layer(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    _write_skill(system_root, "global")
    cache = KeydexRuntimeCache(system_root=system_root)

    first = cache.get_workspace_snapshot(tmp_path / "a")
    second = cache.get_workspace_snapshot(tmp_path / "b")

    assert first.system_layer is second.system_layer
    assert first.workspace_layer is not second.workspace_layer


def test_t49_workspace_invalidation_does_not_rebuild_other_workspace(tmp_path: Path) -> None:
    workspace_builds: list[Path] = []

    def workspace_builder(root: Path):
        workspace_builds.append(root)
        return build_keydex_workspace_layer_runtime_snapshot(root)

    cache = KeydexRuntimeCache(
        system_root=tmp_path / "system",
        workspace_snapshot_builder=workspace_builder,
    )
    workspace_a = (tmp_path / "a").resolve()
    workspace_b = (tmp_path / "b").resolve()
    first_a = cache.get_workspace_snapshot(workspace_a)
    first_b = cache.get_workspace_snapshot(workspace_b)

    cache.invalidate_workspace(workspace_a)
    second_a = cache.get_workspace_snapshot(workspace_a)
    second_b = cache.get_workspace_snapshot(workspace_b)

    assert second_a is not first_a
    assert second_b is first_b
    assert workspace_builds == [workspace_a, workspace_b, workspace_a]


def test_t50_system_invalidation_rebuilds_inherited_effective_snapshot(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    _write_skill(system_root, "global", "one")
    cache = KeydexRuntimeCache(system_root=system_root)
    first = cache.get_workspace_snapshot(workspace_root)

    _write_skill(system_root, "global", "two")
    cache.invalidate_system()
    second = cache.get_workspace_snapshot(workspace_root)

    assert second is not first
    assert second.skill_catalog.skills["global"].description == "two"


def test_t51_keydex_json_cannot_disable_fixed_system_inheritance(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    _write_skill(system_root, "global", "one")
    keydex_root = workspace_root / ".keydex"
    keydex_root.mkdir(parents=True)
    (keydex_root / "keydex.md").write_text(
        '{"skills": {"inherit_system": false}}',
        encoding="utf-8",
    )
    cache = KeydexRuntimeCache(system_root=system_root)
    first = cache.get_workspace_snapshot(workspace_root)

    _write_skill(system_root, "global", "two")
    cache.invalidate_system()
    second = cache.get_workspace_snapshot(workspace_root)

    assert second is not first
    assert second.skill_catalog.skills["global"].source == "system"
    assert second.skill_catalog.skills["global"].description == "two"


@pytest.mark.asyncio
async def test_t88_asyncio_gather_cold_load_builds_and_publishes_once(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    _write_skill(system_root, "global")
    build_calls: list[Path] = []

    def system_builder(root: Path):
        build_calls.append(root)
        return build_keydex_system_layer_runtime_snapshot(root)

    cache = KeydexRuntimeCache(
        system_root=system_root,
        system_snapshot_builder=system_builder,
    )

    snapshots = await asyncio.gather(
        *(asyncio.to_thread(cache.get_system_snapshot) for _ in range(16))
    )

    assert len({id(snapshot) for snapshot in snapshots}) == 1
    assert build_calls == [system_root.resolve()]


def test_force_reload_rebuilds_only_requested_workspace_effective(tmp_path: Path) -> None:
    cache = KeydexRuntimeCache(system_root=tmp_path / "system")
    first_a = cache.get_workspace_snapshot(tmp_path / "a")
    first_b = cache.get_workspace_snapshot(tmp_path / "b")

    second_a = cache.get_workspace_snapshot(tmp_path / "a", force_reload=True)
    second_b = cache.get_workspace_snapshot(tmp_path / "b")

    assert second_a is not first_a
    assert second_b is first_b
