from __future__ import annotations

from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from backend.app.keydex.capabilities.base import KeydexCapabilityLoadError
from backend.app.keydex.capabilities.keydex_markdown import (
    KEYDEX_MARKDOWN_MAX_BYTES,
    KeydexMarkdownCapability,
    KeydexMarkdownLayerPayload,
)
from backend.app.keydex.capabilities.keydex_markdown import loader as markdown_loader
from backend.app.keydex.loader import KeydexLayerLoader
from backend.app.keydex.models import KeydexLayerDescriptor


def _load(root: Path, *, scope: str = "system") -> KeydexMarkdownLayerPayload:
    result = KeydexMarkdownCapability().load_layer(scope=scope, root=root)  # type: ignore[arg-type]
    assert isinstance(result.payload, KeydexMarkdownLayerPayload)
    return result.payload


def test_km01_missing_keydex_markdown_is_an_empty_contribution(tmp_path: Path) -> None:
    result = KeydexMarkdownCapability().load_layer(scope="system", root=tmp_path)

    assert result.state == "empty"
    assert result.payload.document is None
    assert result.payload.locator == "system:keydex.md"


@pytest.mark.parametrize("content", [b"", b"  \r\n\t"])
def test_km02_blank_keydex_markdown_keeps_a_frozen_document_but_is_empty(
    tmp_path: Path,
    content: bytes,
) -> None:
    (tmp_path / "keydex.md").write_bytes(content)

    result = KeydexMarkdownCapability().load_layer(scope="workspace", root=tmp_path)

    assert result.state == "empty"
    assert result.payload.document is not None
    assert result.payload.document.content == content.decode("utf-8")
    assert result.payload.document.byte_size == len(content)
    assert result.payload.document.locator == "workspace:.keydex/keydex.md"
    assert result.payload.document.contributes is False


def test_km03_utf8_and_bom_are_decoded_without_changing_raw_evidence(
    tmp_path: Path,
) -> None:
    raw = b"\xef\xbb\xbf# \xe6\x8c\x87\xe5\xaf\xbc\n"
    (tmp_path / "keydex.md").write_bytes(raw)

    payload = _load(tmp_path)

    assert payload.document is not None
    assert payload.document.content == "# 指导\n"
    assert payload.document.byte_size == len(raw)
    assert len(payload.document.raw_hash) == 64


@pytest.mark.parametrize("raw", [b"\xff\xfeinvalid", b"valid\0invalid"])
def test_km04_invalid_text_rejects_only_the_markdown_contribution(
    tmp_path: Path,
    raw: bytes,
) -> None:
    (tmp_path / "keydex.md").write_bytes(raw)

    with pytest.raises(KeydexCapabilityLoadError) as exc_info:
        _load(tmp_path)

    assert exc_info.value.code == "keydex_markdown_not_text"
    assert exc_info.value.logical_path == "system:keydex.md"


def test_km05_directory_is_rejected_as_not_a_regular_file(tmp_path: Path) -> None:
    (tmp_path / "keydex.md").mkdir()

    with pytest.raises(KeydexCapabilityLoadError) as exc_info:
        _load(tmp_path)

    assert exc_info.value.code == "keydex_markdown_not_file"


def test_km06_symlink_is_rejected_without_exposing_its_target(tmp_path: Path) -> None:
    private_target = tmp_path / "private-target.md"
    private_target.write_text("SECRET", encoding="utf-8")
    try:
        (tmp_path / "keydex.md").symlink_to(private_target)
    except OSError as exc:
        pytest.skip(f"symlink creation is unavailable: {exc}")

    with pytest.raises(KeydexCapabilityLoadError) as exc_info:
        _load(tmp_path)

    assert exc_info.value.code == "keydex_markdown_forbidden"
    assert str(private_target) not in exc_info.value.reason
    assert "SECRET" not in exc_info.value.reason


def test_km06_link_like_branch_is_covered_without_os_symlink_permission(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source = tmp_path / "keydex.md"
    source.write_text("PRIVATE MARKER", encoding="utf-8")
    original = markdown_loader._is_link_like
    monkeypatch.setattr(
        markdown_loader,
        "_is_link_like",
        lambda path: path == source or original(path),
    )

    with pytest.raises(KeydexCapabilityLoadError) as exc_info:
        _load(tmp_path)

    assert exc_info.value.code == "keydex_markdown_forbidden"
    assert str(source) not in exc_info.value.reason
    assert "PRIVATE MARKER" not in exc_info.value.reason


def test_km07_exact_32_kib_is_allowed(tmp_path: Path) -> None:
    raw = b"a" * KEYDEX_MARKDOWN_MAX_BYTES
    (tmp_path / "keydex.md").write_bytes(raw)

    payload = _load(tmp_path)

    assert payload.document is not None
    assert payload.document.byte_size == KEYDEX_MARKDOWN_MAX_BYTES
    assert payload.document.content == raw.decode("utf-8")


def test_km08_32_kib_plus_one_is_rejected_without_truncation(tmp_path: Path) -> None:
    (tmp_path / "keydex.md").write_bytes(b"a" * (KEYDEX_MARKDOWN_MAX_BYTES + 1))

    with pytest.raises(KeydexCapabilityLoadError) as exc_info:
        _load(tmp_path)

    assert exc_info.value.code == "keydex_markdown_too_large"
    assert exc_info.value.details == {
        "limit": KEYDEX_MARKDOWN_MAX_BYTES,
        "actual": KEYDEX_MARKDOWN_MAX_BYTES + 1,
    }


def test_km09_same_size_change_changes_hash_and_old_payload_stays_frozen(
    tmp_path: Path,
) -> None:
    source = tmp_path / "keydex.md"
    source.write_text("version-one", encoding="utf-8")
    before = _load(tmp_path)
    source.write_text("version-two", encoding="utf-8")
    after = _load(tmp_path)

    assert before.document is not None and after.document is not None
    assert before.document.byte_size == after.document.byte_size
    assert before.document.raw_hash != after.document.raw_hash
    assert before.document.content == "version-one"
    with pytest.raises(FrozenInstanceError):
        before.document.content = "mutated"  # type: ignore[misc]


def test_km10_payload_contains_no_physical_path(tmp_path: Path) -> None:
    private_root = tmp_path / "private-user" / ".keydex"
    private_root.mkdir(parents=True)
    (private_root / "keydex.md").write_text("PRIVATE MARKER", encoding="utf-8")

    payload = _load(private_root)

    assert private_root.as_posix() not in repr(payload)
    assert payload.document is not None
    assert payload.document.locator == "system:keydex.md"


def test_km11_builtin_scope_is_unsupported_by_generic_loader(tmp_path: Path) -> None:
    root = tmp_path / "builtin"
    root.mkdir()
    (root / "keydex.md").write_text("ignored", encoding="utf-8")
    snapshot = KeydexLayerLoader().load(
        KeydexLayerDescriptor(scope="builtin", root=root, logical_root="builtin")
    )

    markdown = snapshot.capabilities["keydex_markdown"]
    assert markdown.state == "unsupported"
    assert markdown.payload is None
    assert markdown.sources == ()


def test_km16_markdown_failure_isolated_from_skills_in_the_same_layer(
    tmp_path: Path,
) -> None:
    root = tmp_path / ".keydex"
    skill = root / "skills" / "stable-skill"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        "---\nname: stable-skill\ndescription: Stable skill.\n---\n\nBody\n",
        encoding="utf-8",
    )
    (root / "keydex.md").write_bytes(b"\xff\xfe")

    snapshot = KeydexLayerLoader().load(
        KeydexLayerDescriptor(scope="system", root=root, logical_root=".keydex")
    )

    assert snapshot.capabilities["keydex_markdown"].state == "failed"
    assert snapshot.capabilities["keydex_markdown"].diagnostics[0].code == (
        "keydex_markdown_not_text"
    )
    skills = snapshot.capabilities["skills"]
    assert skills.state == "loaded"
    assert tuple(item.name for item in skills.payload.catalog.sorted_skills()) == ("stable-skill",)
