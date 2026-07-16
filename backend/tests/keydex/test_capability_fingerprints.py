from __future__ import annotations

from pathlib import Path

from backend.app.keydex import build_keydex_layer_fingerprint
from backend.app.keydex.capabilities.base import CapabilityKey, CapabilityWatchSpec
from backend.app.keydex.registry import KeydexCapabilityRegistry


class _FilesCapability:
    id = "files"
    effective_key = CapabilityKey("files")
    supported_scopes = frozenset({"system"})
    watch_specs = (CapabilityWatchSpec("files", kind="subtree"),)

    def __init__(self, revision: str) -> None:
        self.format_revision = revision

    def load_layer(self, **kwargs):  # pragma: no cover - fingerprinting never loads
        raise AssertionError("loader must not be called")

    def compose(self, **kwargs):  # pragma: no cover - fingerprinting never composes
        raise AssertionError("composer must not be called")


def _write_skill(root: Path, *, body: str = "one") -> None:
    skill_root = root / "skills" / "sample"
    skill_root.mkdir(parents=True, exist_ok=True)
    (skill_root / "SKILL.md").write_text(
        "---\nname: sample\ndescription: sample\n---\n\n" + body,
        encoding="utf-8",
    )
    (skill_root / "reference.md").write_text(body, encoding="utf-8")


def test_kr10_runtime_and_capability_revision_invalidate_digest(tmp_path: Path) -> None:
    root = tmp_path / ".keydex"
    root.mkdir()
    first_registry = KeydexCapabilityRegistry((_FilesCapability("1"),))
    second_registry = KeydexCapabilityRegistry((_FilesCapability("2"),))

    first = build_keydex_layer_fingerprint(
        "system", root, registry=first_registry, runtime_revision="runtime-1"
    )
    capability_changed = build_keydex_layer_fingerprint(
        "system", root, registry=second_registry, runtime_revision="runtime-1"
    )
    runtime_changed = build_keydex_layer_fingerprint(
        "system", root, registry=first_registry, runtime_revision="runtime-2"
    )

    assert first.digest() != capability_changed.digest()
    assert first.digest() != runtime_changed.digest()


def test_kr11_supported_sources_create_modify_and_delete_change_digest(tmp_path: Path) -> None:
    root = tmp_path / ".keydex"
    root.mkdir()
    missing = build_keydex_layer_fingerprint("system", root)
    (root / "keydex.md").write_text("AAAA", encoding="utf-8")
    created = build_keydex_layer_fingerprint("system", root)
    (root / "keydex.md").write_text("BBBB", encoding="utf-8")
    same_size_modified = build_keydex_layer_fingerprint("system", root)
    (root / "keydex.md").unlink()
    deleted = build_keydex_layer_fingerprint("system", root)

    assert missing.digest() != created.digest()
    assert created.digest() != same_size_modified.digest()
    assert deleted.digest() == missing.digest()


def test_kr12_unknown_files_and_keydex_json_do_not_change_digest(tmp_path: Path) -> None:
    root = tmp_path / ".keydex"
    _write_skill(root)
    before = build_keydex_layer_fingerprint("system", root)
    (root / "keydex.md").write_text("{invalid", encoding="utf-8")
    (root / "unknown.txt").write_text("ignored", encoding="utf-8")
    after = build_keydex_layer_fingerprint("system", root)

    assert after.digest() == before.digest()


def test_ks03_skill_resources_are_fingerprinted_without_directory_mtime(tmp_path: Path) -> None:
    root = tmp_path / ".keydex"
    _write_skill(root, body="same")
    before = build_keydex_layer_fingerprint("system", root)
    (root / "skills" / "sample" / "reference.md").write_text("diff", encoding="utf-8")
    after = build_keydex_layer_fingerprint("system", root)

    assert before.capability_fingerprints["skills"] != after.capability_fingerprints["skills"]
    assert before.capability_fingerprints["keydex_markdown"] == after.capability_fingerprints[
        "keydex_markdown"
    ]


def test_kr13_equal_logical_trees_have_equal_private_root_independent_digest(
    tmp_path: Path,
) -> None:
    first_root = tmp_path / "private-a" / ".keydex"
    second_root = tmp_path / "private-b" / ".keydex"
    _write_skill(first_root)
    _write_skill(second_root)
    (first_root / "keydex.md").write_text("private guidance", encoding="utf-8")
    (second_root / "keydex.md").write_text("private guidance", encoding="utf-8")

    first = build_keydex_layer_fingerprint("system", first_root)
    second = build_keydex_layer_fingerprint("system", second_root)
    serialized = str(first.to_payload())

    assert first.digest() == second.digest()
    assert first_root.as_posix() not in serialized
    assert "private guidance" not in serialized
