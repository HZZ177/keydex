from __future__ import annotations

from pathlib import Path

from backend.app.keydex.capabilities.skills import SkillsCapability, SkillsLayerPayload
from backend.app.keydex.loader import KeydexLayerLoader
from backend.app.keydex.models import KeydexLayerDescriptor
from backend.app.keydex.registry import KeydexCapabilityRegistry


def _write_skill(
    root: Path,
    directory: str,
    *,
    name: str | None = None,
    description: str = "Sample skill",
) -> Path:
    skill_root = root / "skills" / directory
    skill_root.mkdir(parents=True, exist_ok=True)
    entry = skill_root / "SKILL.md"
    entry.write_text(
        f"---\nname: {name or directory}\ndescription: {description}\n---\n\nbody\n",
        encoding="utf-8",
    )
    return entry


def _load(root: Path, *, scope: str = "system"):
    capability = SkillsCapability()
    loader = KeydexLayerLoader(registry=KeydexCapabilityRegistry((capability,)))
    return loader.load(
        KeydexLayerDescriptor(
            scope=scope,  # type: ignore[arg-type]
            root=root,
            logical_root="builtin" if scope == "builtin" else ".keydex",
        )
    ).capabilities["skills"]


def test_ks02_missing_skills_directory_is_a_legal_empty_payload(tmp_path: Path) -> None:
    snapshot = _load(tmp_path / "missing-system")

    assert snapshot.state == "empty"
    assert isinstance(snapshot.payload, SkillsLayerPayload)
    assert snapshot.payload.catalog.skills == {}
    assert snapshot.payload.resources == {}
    assert snapshot.diagnostics == ()


def test_ks05_system_discovery_and_resource_capture_are_frozen(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    entry = _write_skill(system_root, "sample")
    reference = entry.parent / "references" / "guide.md"
    reference.parent.mkdir()
    reference.write_text("guide-v1", encoding="utf-8")

    snapshot = _load(system_root)
    payload = snapshot.payload
    reference.write_text("guide-v2", encoding="utf-8")

    assert payload.catalog.skills["sample"].source == "system"
    assert payload.resources[("sample", "SKILL.md")].content.splitlines()[-1] == "body"
    assert payload.resources[("sample", "references/guide.md")].content == "guide-v1"


def test_ks06_workspace_scope_is_injected_by_descriptor(tmp_path: Path) -> None:
    workspace_keydex = tmp_path / "workspace" / ".keydex"
    _write_skill(workspace_keydex, "local")

    snapshot = _load(workspace_keydex, scope="workspace")

    assert snapshot.payload.catalog.skills["local"].source == "workspace"
    assert snapshot.payload.catalog.profile.scope == "workspace"
    assert snapshot.payload.catalog.profile.manifest == {}


def test_ks08_ks09_invalid_candidate_blocks_its_canonical_name_only(tmp_path: Path) -> None:
    root = tmp_path / "system"
    _write_skill(root, "Shared", name="other")
    _write_skill(root, "healthy")

    snapshot = _load(root)
    payload = snapshot.payload

    assert list(payload.catalog.skills) == ["healthy"]
    assert payload.catalog.blocked_names == frozenset({"shared"})
    assert any(item.code == "skill_name_mismatch" for item in snapshot.diagnostics)


def test_resource_directories_remain_frozen_as_not_file_errors(tmp_path: Path) -> None:
    root = tmp_path / "system"
    entry = _write_skill(root, "sample")
    (entry.parent / "references").mkdir()

    snapshot = _load(root)

    assert snapshot.payload.resource_errors[("sample", "references")] == (
        "skill_resource_not_file",
        "Skill resource path must point to a regular file.",
    )
