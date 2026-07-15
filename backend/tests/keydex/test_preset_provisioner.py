from __future__ import annotations

import json
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from backend.app.keydex.presets import (
    BUNDLED_PRESETS_ROOT,
    LOCK_FILE_NAME,
    MANAGED_DIR_NAME,
    STAGING_DIR_NAME,
    STATE_FILE_NAME,
    PresetValidationError,
    deterministic_tree_sha256,
    load_and_validate_preset_catalog,
    provision_bundled_presets,
)
from backend.app.keydex.runtime import build_keydex_system_layer_runtime_snapshot


def test_t98_production_catalog_is_empty_and_has_no_filesystem_side_effect(tmp_path) -> None:
    payload = json.loads((BUNDLED_PRESETS_ROOT / "catalog.json").read_text(encoding="utf-8"))
    system_root = tmp_path / "never-created"

    result = provision_bundled_presets(system_root=system_root)

    assert payload == {"schema_version": 1, "presets": []}
    assert result.status == "empty"
    assert result.diagnostics == ()
    assert not system_root.exists()


@pytest.mark.parametrize(
    "payload",
    [
        [],
        {"schema_version": 2, "presets": []},
        {"schema_version": 1, "presets": "invalid"},
        {"schema_version": 1, "presets": [], "unknown": True},
    ],
)
def test_t99_catalog_schema_fails_closed_before_system_write(tmp_path, payload) -> None:
    bundle = tmp_path / "bundle"
    bundle.mkdir()
    write_json(bundle / "catalog.json", payload)
    system_root = tmp_path / "system"

    result = provision_bundled_presets(bundle_root=bundle, system_root=system_root)

    assert result.status == "failed"
    assert result.diagnostics
    assert not system_root.exists()


def test_t100_duplicate_ids_names_and_invalid_names_are_rejected(tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha"), ("two", "beta")])
    payload = read_json(bundle / "catalog.json")
    payload["presets"][1]["id"] = "one"
    write_json(bundle / "catalog.json", payload)
    with pytest.raises(PresetValidationError, match="unique"):
        load_and_validate_preset_catalog(bundle)

    bundle = create_bundle(tmp_path / "bundle-two", [("one", "alpha")])
    payload = read_json(bundle / "catalog.json")
    duplicate = dict(payload["presets"][0])
    duplicate["id"] = "two"
    payload["presets"].append(duplicate)
    write_json(bundle / "catalog.json", payload)
    with pytest.raises(PresetValidationError, match="ignoring case"):
        load_and_validate_preset_catalog(bundle)

    bundle = tmp_path / "bundle-three"
    bundle.mkdir()
    write_json(
        bundle / "catalog.json",
        {
            "schema_version": 1,
            "presets": [
                {
                    "id": "one",
                    "skill_name": "../escape",
                    "version": 1,
                    "content_sha256": "0" * 64,
                }
            ],
        },
    )
    with pytest.raises(PresetValidationError, match="must match"):
        load_and_validate_preset_catalog(bundle)


def test_t101_frontmatter_name_must_match_catalog_and_directory(tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    entry = bundle / "skills" / "alpha" / "SKILL.md"
    entry.write_text(skill_markdown("other"), encoding="utf-8")
    refresh_catalog_hash(bundle, "one", "alpha")

    result = provision_bundled_presets(bundle_root=bundle, system_root=tmp_path / "system")

    assert result.status == "failed"
    assert result.diagnostics[0].code == "preset_skill_name_mismatch"


def test_t102_any_resource_change_invalidates_tree_hash_before_write(tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    (bundle / "skills" / "alpha" / "notes.txt").write_text("changed", encoding="utf-8")
    system_root = tmp_path / "system"

    result = provision_bundled_presets(bundle_root=bundle, system_root=system_root)

    assert result.status == "failed"
    assert result.diagnostics[0].code == "preset_hash_mismatch"
    assert not system_root.exists()


def test_t103_link_is_rejected_before_system_write(monkeypatch, tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    linked = bundle / "skills" / "alpha" / "notes.txt"
    from backend.app.keydex import presets

    original = presets._is_link_like
    monkeypatch.setattr(presets, "_is_link_like", lambda path: path == linked or original(path))
    system_root = tmp_path / "system"

    result = provision_bundled_presets(bundle_root=bundle, system_root=system_root)

    assert result.status == "failed"
    assert result.diagnostics[0].code == "preset_tree_link_forbidden"
    assert not system_root.exists()


def test_t104_first_seed_is_atomic_managed_and_loads_as_normal_system_skill(tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    system_root = tmp_path / "system"

    result = provision_bundled_presets(bundle_root=bundle, system_root=system_root)

    assert result.status == "completed"
    assert result.installed == ("alpha",)
    assert (system_root / "skills" / "alpha" / "SKILL.md").is_file()
    assert not (system_root / MANAGED_DIR_NAME / LOCK_FILE_NAME).exists()
    assert not (system_root / MANAGED_DIR_NAME / STAGING_DIR_NAME).exists()
    state = read_json(system_root / MANAGED_DIR_NAME / STATE_FILE_NAME)
    assert state["presets"]["one"]["status"] == "installed"
    snapshot = build_keydex_system_layer_runtime_snapshot(system_root)
    assert snapshot.skill_catalog.skills["alpha"].source == "system"


def test_t105_existing_user_skill_is_never_overwritten(tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    system_root = tmp_path / "system"
    user_entry = system_root / "skills" / "alpha" / "SKILL.md"
    user_entry.parent.mkdir(parents=True)
    user_entry.write_text(skill_markdown("alpha", body="user-owned"), encoding="utf-8")

    result = provision_bundled_presets(bundle_root=bundle, system_root=system_root)

    assert result.status == "completed"
    assert result.skipped_existing == ("alpha",)
    assert "user-owned" in user_entry.read_text(encoding="utf-8")
    state = read_json(system_root / MANAGED_DIR_NAME / STATE_FILE_NAME)
    assert state["presets"]["one"]["status"] == "skipped_existing"


def test_t106_t107_known_preset_is_not_restored_after_edit_or_delete(tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    system_root = tmp_path / "system"
    assert provision_bundled_presets(bundle_root=bundle, system_root=system_root).installed == (
        "alpha",
    )
    entry = system_root / "skills" / "alpha" / "SKILL.md"
    entry.write_text(skill_markdown("alpha", body="user edit"), encoding="utf-8")

    edited = provision_bundled_presets(bundle_root=bundle, system_root=system_root)
    assert edited.status == "completed"
    assert "user edit" in entry.read_text(encoding="utf-8")

    import shutil

    shutil.rmtree(entry.parent)
    deleted = provision_bundled_presets(bundle_root=bundle, system_root=system_root)
    assert deleted.status == "completed"
    assert not entry.parent.exists()


def test_t108_t109_upgrade_only_adds_new_id_and_never_updates_old_target(tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    system_root = tmp_path / "system"
    provision_bundled_presets(bundle_root=bundle, system_root=system_root)
    target = system_root / "skills" / "alpha" / "notes.txt"
    target.write_text("user-owned", encoding="utf-8")

    (bundle / "skills" / "alpha" / "notes.txt").write_text("bundle-v2", encoding="utf-8")
    payload = read_json(bundle / "catalog.json")
    payload["presets"][0]["version"] = 2
    payload["presets"][0]["content_sha256"] = deterministic_tree_sha256(
        bundle / "skills" / "alpha"
    )
    add_bundle_item(bundle, payload, "two", "beta")

    result = provision_bundled_presets(bundle_root=bundle, system_root=system_root)

    assert result.installed == ("beta",)
    assert target.read_text(encoding="utf-8") == "user-owned"
    state = read_json(system_root / MANAGED_DIR_NAME / STATE_FILE_NAME)
    assert state["presets"]["one"]["version"] == 1
    assert state["presets"]["two"]["status"] == "installed"


def test_t110_state_is_metadata_only_and_written_with_atomic_replace(monkeypatch, tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    system_root = tmp_path / "system"
    from backend.app.keydex import presets
    replaced_destinations: list[Path] = []
    original_replace = presets.os.replace

    def record_replace(source, destination) -> None:
        replaced_destinations.append(Path(destination))
        original_replace(source, destination)

    monkeypatch.setattr(presets.os, "replace", record_replace)

    provision_bundled_presets(bundle_root=bundle, system_root=system_root)

    managed = system_root / MANAGED_DIR_NAME
    state = read_json(managed / STATE_FILE_NAME)
    assert set(state) == {"schema_version", "presets"}
    assert set(state["presets"]["one"]) == {
        "skill_name",
        "version",
        "content_sha256",
        "status",
    }
    assert list(managed.glob(f".{STATE_FILE_NAME}.*.tmp")) == []
    assert managed / STATE_FILE_NAME in replaced_destinations


def test_t111_corrupt_state_fails_closed_without_reviving_deleted_target(tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    system_root = tmp_path / "system"
    managed = system_root / MANAGED_DIR_NAME
    managed.mkdir(parents=True)
    (managed / STATE_FILE_NAME).write_text("not json", encoding="utf-8")

    result = provision_bundled_presets(bundle_root=bundle, system_root=system_root)

    assert result.status == "failed"
    assert result.diagnostics[0].code == "preset_state_invalid"
    assert not (system_root / "skills" / "alpha").exists()


def test_t112_copy_failure_leaves_no_discoverable_half_skill(monkeypatch, tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    system_root = tmp_path / "system"
    from backend.app.keydex import presets

    def fail_copy(*args, **kwargs):
        raise OSError("simulated copy interruption")

    monkeypatch.setattr(presets.shutil, "copytree", fail_copy)

    result = provision_bundled_presets(bundle_root=bundle, system_root=system_root)

    assert result.status == "failed"
    assert not (system_root / "skills" / "alpha").exists()
    staging = system_root / MANAGED_DIR_NAME / STAGING_DIR_NAME
    assert not staging.exists() or list(staging.iterdir()) == []


def test_t113_active_lock_is_busy_and_stale_lock_is_recovered(tmp_path) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    system_root = tmp_path / "system"
    lock = system_root / MANAGED_DIR_NAME / LOCK_FILE_NAME
    lock.parent.mkdir(parents=True)
    lock.write_text("active", encoding="utf-8")

    busy = provision_bundled_presets(
        bundle_root=bundle, system_root=system_root, stale_lock_seconds=3600
    )
    assert busy.status == "busy"
    assert not (system_root / "skills" / "alpha").exists()

    old = 1
    os.utime(lock, (old, old))
    recovered = provision_bundled_presets(
        bundle_root=bundle, system_root=system_root, stale_lock_seconds=1
    )
    assert recovered.installed == ("alpha",)
    assert not lock.exists()


def test_t113_concurrent_start_allows_one_installer_and_one_busy_result(
    monkeypatch, tmp_path
) -> None:
    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    system_root = tmp_path / "system"
    from backend.app.keydex import presets
    copy_started = threading.Event()
    release_copy = threading.Event()
    original_copytree = presets.shutil.copytree

    def blocking_copytree(*args, **kwargs):
        copy_started.set()
        assert release_copy.wait(timeout=5)
        return original_copytree(*args, **kwargs)

    monkeypatch.setattr(presets.shutil, "copytree", blocking_copytree)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(
            provision_bundled_presets,
            bundle_root=bundle,
            system_root=system_root,
        )
        assert copy_started.wait(timeout=5)
        second = provision_bundled_presets(bundle_root=bundle, system_root=system_root)
        release_copy.set()
        first_result = first.result(timeout=5)

    assert first_result.installed == ("alpha",)
    assert second.status == "busy"
    assert (system_root / "skills" / "alpha" / "SKILL.md").is_file()


def test_t118_workspace_override_still_wins_over_seeded_system_skill(tmp_path) -> None:
    from backend.app.keydex.runtime import build_keydex_workspace_effective_snapshot

    bundle = create_bundle(tmp_path / "bundle", [("one", "alpha")])
    system_root = tmp_path / "system"
    provision_bundled_presets(bundle_root=bundle, system_root=system_root)
    workspace_root = tmp_path / "workspace"
    write_skill(workspace_root / ".keydex" / "skills" / "alpha", "alpha", body="workspace")

    effective = build_keydex_workspace_effective_snapshot(
        workspace_root, system_root=system_root
    )

    assert effective.skill_catalog.skills["alpha"].source == "workspace"


def test_t119_scripts_are_copied_as_inert_resources_and_no_uninstall_is_performed(tmp_path) -> None:
    marker = tmp_path / "must-not-exist"
    script_body = f"from pathlib import Path\nPath({str(marker)!r}).write_text('ran')\n"
    bundle = create_bundle(
        tmp_path / "bundle", [("one", "alpha")], extra_files={"scripts/run.py": script_body}
    )
    system_root = tmp_path / "system"

    provision_bundled_presets(bundle_root=bundle, system_root=system_root)

    assert (system_root / "skills" / "alpha" / "scripts" / "run.py").is_file()
    assert not marker.exists()
    assert (system_root / "skills" / "alpha").is_dir()

    write_json(bundle / "catalog.json", {"schema_version": 1, "presets": []})
    result = provision_bundled_presets(bundle_root=bundle, system_root=system_root)

    assert result.status == "empty"
    assert (system_root / "skills" / "alpha" / "SKILL.md").is_file()


def create_bundle(
    root: Path,
    presets: list[tuple[str, str]],
    *,
    extra_files: dict[str, str] | None = None,
) -> Path:
    root.mkdir(parents=True)
    payload = {"schema_version": 1, "presets": []}
    for preset_id, skill_name in presets:
        write_skill(root / "skills" / skill_name, skill_name, extra_files=extra_files)
        payload["presets"].append(
            {
                "id": preset_id,
                "skill_name": skill_name,
                "version": 1,
                "content_sha256": deterministic_tree_sha256(root / "skills" / skill_name),
            }
        )
    write_json(root / "catalog.json", payload)
    return root


def add_bundle_item(root: Path, payload: dict, preset_id: str, skill_name: str) -> None:
    write_skill(root / "skills" / skill_name, skill_name)
    payload["presets"].append(
        {
            "id": preset_id,
            "skill_name": skill_name,
            "version": 1,
            "content_sha256": deterministic_tree_sha256(root / "skills" / skill_name),
        }
    )
    write_json(root / "catalog.json", payload)


def refresh_catalog_hash(root: Path, preset_id: str, skill_name: str) -> None:
    payload = read_json(root / "catalog.json")
    item = next(item for item in payload["presets"] if item["id"] == preset_id)
    item["content_sha256"] = deterministic_tree_sha256(root / "skills" / skill_name)
    write_json(root / "catalog.json", payload)


def write_skill(
    root: Path,
    name: str,
    *,
    body: str = "preset body",
    extra_files: dict[str, str] | None = None,
) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "SKILL.md").write_text(skill_markdown(name, body=body), encoding="utf-8")
    (root / "notes.txt").write_text("preset resource", encoding="utf-8")
    for relative, content in (extra_files or {}).items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def skill_markdown(name: str, *, body: str = "preset body") -> str:
    return f"---\nname: {name}\ndescription: Bundled {name}\n---\n\n{body}\n"


def write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))
