from __future__ import annotations

from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from backend.app.keydex.capabilities.keydex_markdown import (
    KEYDEX_MARKDOWN_CAPABILITY_KEY,
)
from backend.app.keydex.runtime_cache import KeydexCapabilityRuntimeCache


def _cache(tmp_path: Path) -> tuple[KeydexCapabilityRuntimeCache, Path, Path]:
    builtin_root = tmp_path / "builtin"
    system_root = tmp_path / "system-keydex"
    workspace_root = tmp_path / "workspace"
    builtin_root.mkdir()
    system_root.mkdir()
    workspace_root.mkdir()
    return (
        KeydexCapabilityRuntimeCache(
            builtin_root=builtin_root,
            system_root=system_root,
        ),
        system_root,
        workspace_root,
    )


def test_km12_system_only_snapshot_contains_only_system_document(tmp_path: Path) -> None:
    cache, system_root, _workspace_root = _cache(tmp_path)
    (system_root / "keydex.md").write_text("system guidance", encoding="utf-8")

    snapshot = cache.get_system_snapshot()
    markdown = snapshot.require(KEYDEX_MARKDOWN_CAPABILITY_KEY)

    assert markdown.scopes == ("system",)
    assert markdown.documents[0].content == "system guidance"
    assert snapshot.capabilities["keydex_markdown"].sources == ("system:keydex.md",)


def test_km13_workspace_snapshot_orders_system_before_workspace(tmp_path: Path) -> None:
    cache, system_root, workspace_root = _cache(tmp_path)
    (system_root / "keydex.md").write_text("broad", encoding="utf-8")
    workspace_keydex = workspace_root / ".keydex"
    workspace_keydex.mkdir()
    (workspace_keydex / "keydex.md").write_text("specific", encoding="utf-8")

    markdown = cache.get_workspace_snapshot(workspace_root).require(
        KEYDEX_MARKDOWN_CAPABILITY_KEY
    )

    assert markdown.scopes == ("system", "workspace")
    assert tuple(document.content for document in markdown.documents) == (
        "broad",
        "specific",
    )
    assert tuple(document.locator for document in markdown.documents) == (
        "system:keydex.md",
        "workspace:.keydex/keydex.md",
    )


def test_km14_workspace_only_document_is_valid_when_system_is_missing(
    tmp_path: Path,
) -> None:
    cache, _system_root, workspace_root = _cache(tmp_path)
    workspace_keydex = workspace_root / ".keydex"
    workspace_keydex.mkdir()
    (workspace_keydex / "keydex.md").write_text("workspace only", encoding="utf-8")

    markdown = cache.get_workspace_snapshot(workspace_root).require(
        KEYDEX_MARKDOWN_CAPABILITY_KEY
    )

    assert markdown.scopes == ("workspace",)
    assert markdown.documents[0].content == "workspace only"


def test_km15_blank_documents_do_not_enter_effective_documents(tmp_path: Path) -> None:
    cache, system_root, workspace_root = _cache(tmp_path)
    (system_root / "keydex.md").write_bytes(b" \n")
    workspace_keydex = workspace_root / ".keydex"
    workspace_keydex.mkdir()
    (workspace_keydex / "keydex.md").write_text("usable", encoding="utf-8")

    snapshot = cache.get_workspace_snapshot(workspace_root)
    markdown = snapshot.require(KEYDEX_MARKDOWN_CAPABILITY_KEY)

    assert markdown.scopes == ("workspace",)
    system_layer = snapshot.layer("system")
    assert system_layer is not None
    frozen_blank = system_layer.capabilities["keydex_markdown"].payload.document
    assert frozen_blank is not None
    assert frozen_blank.content == " \n"


@pytest.mark.parametrize("broken_scope", ["system", "workspace"])
def test_km16_one_layer_failure_preserves_the_other_document_and_diagnostic(
    tmp_path: Path,
    broken_scope: str,
) -> None:
    cache, system_root, workspace_root = _cache(tmp_path)
    workspace_keydex = workspace_root / ".keydex"
    workspace_keydex.mkdir()
    (system_root / "keydex.md").write_text("system valid", encoding="utf-8")
    (workspace_keydex / "keydex.md").write_text("workspace valid", encoding="utf-8")
    broken_root = system_root if broken_scope == "system" else workspace_keydex
    (broken_root / "keydex.md").write_bytes(b"\xff\xfe")

    snapshot = cache.get_workspace_snapshot(workspace_root)
    markdown = snapshot.require(KEYDEX_MARKDOWN_CAPABILITY_KEY)

    expected_scope = "workspace" if broken_scope == "system" else "system"
    assert markdown.scopes == (expected_scope,)
    capability = snapshot.capabilities["keydex_markdown"]
    assert capability.available is True
    assert capability.diagnostics[0].code == "keydex_markdown_not_text"
    assert capability.diagnostics[0].scope == broken_scope


def test_effective_markdown_snapshot_is_immutable_and_fingerprint_sensitive(
    tmp_path: Path,
) -> None:
    cache, system_root, _workspace_root = _cache(tmp_path)
    source = system_root / "keydex.md"
    source.write_text("version-one", encoding="utf-8")
    before = cache.get_system_snapshot()
    source.write_text("version-two", encoding="utf-8")
    after = cache.get_system_snapshot()

    before_markdown = before.require(KEYDEX_MARKDOWN_CAPABILITY_KEY)
    assert before_markdown.documents[0].content == "version-one"
    assert after.require(KEYDEX_MARKDOWN_CAPABILITY_KEY).documents[0].content == (
        "version-two"
    )
    assert before.capabilities["keydex_markdown"].fingerprint != (
        after.capabilities["keydex_markdown"].fingerprint
    )
    with pytest.raises(FrozenInstanceError):
        before_markdown.documents = ()  # type: ignore[misc]
