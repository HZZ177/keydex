from __future__ import annotations

import shutil
from pathlib import Path

from backend.app.keydex.capabilities.skills import (
    SKILLS_CAPABILITY_KEY,
    EffectiveSkillsPayload,
    SkillsCapability,
)
from backend.app.keydex.composer import KeydexEffectiveComposer
from backend.app.keydex.loader import KeydexLayerLoader
from backend.app.keydex.models import KeydexLayerDescriptor
from backend.app.keydex.registry import KeydexCapabilityRegistry


def _write_skill(root: Path, directory: str, *, name: str | None = None, body: str) -> Path:
    skill_root = root / "skills" / directory
    skill_root.mkdir(parents=True, exist_ok=True)
    entry = skill_root / "SKILL.md"
    entry.write_text(
        f"---\nname: {name or directory}\ndescription: {body}\n---\n\n{body}\n",
        encoding="utf-8",
    )
    return entry


def _runtime(tmp_path: Path, workspace_root: Path | None = None):
    capability = SkillsCapability()
    registry = KeydexCapabilityRegistry((capability,))
    loader = KeydexLayerLoader(registry=registry)
    layers = [
        loader.load(
            KeydexLayerDescriptor(
                scope="builtin",
                root=tmp_path / "builtin",
                logical_root="builtin",
            )
        ),
        loader.load(
            KeydexLayerDescriptor(
                scope="system",
                root=tmp_path / "system",
                logical_root=".keydex",
            )
        ),
    ]
    mode = "system_only"
    if workspace_root is not None:
        layers.append(
            loader.load(
                KeydexLayerDescriptor(
                    scope="workspace",
                    root=workspace_root / ".keydex",
                    logical_root=".keydex",
                )
            )
        )
        mode = "workspace_effective"
    return KeydexEffectiveComposer(registry=registry).compose(
        mode=mode,  # type: ignore[arg-type]
        layers=tuple(layers),
        workspace_root=workspace_root,
    )


def test_ks07_priority_is_workspace_then_system_then_builtin(tmp_path: Path) -> None:
    _write_skill(tmp_path / "builtin", "shared", body="builtin")
    _write_skill(tmp_path / "system", "shared", body="system")
    workspace = tmp_path / "workspace"
    _write_skill(workspace / ".keydex", "shared", body="workspace")

    snapshot = _runtime(tmp_path, workspace)
    payload = snapshot.require(SKILLS_CAPABILITY_KEY)

    assert isinstance(payload, EffectiveSkillsPayload)
    assert payload.catalog.skills["shared"].source == "workspace"
    assert payload.catalog.skills["shared"].description == "workspace"


def test_ks09_ks10_invalid_workspace_barrier_repairs_and_delete_falls_back(
    tmp_path: Path,
) -> None:
    _write_skill(tmp_path / "system", "shared", body="system")
    workspace = tmp_path / "workspace"
    invalid = _write_skill(
        workspace / ".keydex",
        "shared",
        name="other",
        body="invalid",
    )

    blocked = _runtime(tmp_path, workspace).require(SKILLS_CAPABILITY_KEY)
    assert "shared" not in blocked.catalog.skills
    assert blocked.catalog.shadowed_names == frozenset({"shared"})

    invalid.write_text(
        "---\nname: shared\ndescription: workspace\n---\n\nworkspace\n",
        encoding="utf-8",
    )
    repaired = _runtime(tmp_path, workspace).require(SKILLS_CAPABILITY_KEY)
    assert repaired.catalog.skills["shared"].source == "workspace"

    shutil.rmtree(invalid.parent)
    fallback = _runtime(tmp_path, workspace).require(SKILLS_CAPABILITY_KEY)
    assert fallback.catalog.skills["shared"].source == "system"


def test_ks08_casefold_barrier_and_stable_sorting_are_preserved(tmp_path: Path) -> None:
    _write_skill(tmp_path / "system", "Shared", body="system")
    _write_skill(tmp_path / "system", "zeta", body="zeta")
    workspace = tmp_path / "workspace"
    _write_skill(workspace / ".keydex", "shared", name="other", body="invalid")
    _write_skill(workspace / ".keydex", "Alpha", body="alpha")

    payload = _runtime(tmp_path, workspace).require(SKILLS_CAPABILITY_KEY)

    assert list(payload.catalog.skills) == ["Alpha", "zeta"]
    assert payload.catalog.shadowed_names == frozenset({"shared"})


def test_effective_payload_reads_only_frozen_winner_resources(tmp_path: Path) -> None:
    entry = _write_skill(tmp_path / "system", "sample", body="v1")
    snapshot = _runtime(tmp_path)
    payload = snapshot.require(SKILLS_CAPABILITY_KEY)
    skill = payload.catalog.skills["sample"]
    entry.write_text(
        "---\nname: sample\ndescription: v2\n---\n\nv2\n",
        encoding="utf-8",
    )

    resource = payload.read_skill_text_resource(skill, "SKILL.md")

    assert "v1" in resource.content
    assert "v2" not in resource.content
