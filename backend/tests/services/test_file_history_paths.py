from __future__ import annotations

import os
import unicodedata
from dataclasses import dataclass
from pathlib import Path

import pytest

from backend.app.services.file_history_service import (
    FileHistoryPathError,
    FileHistoryPathResolver,
    FileResourceIdentity,
    FileResourceScope,
    FileResourceScopeCatalog,
    FileResourceScopeKind,
)


def test_file_history_path_resolver_uses_workspace_relative_canonical_key(tmp_path) -> None:
    nested = tmp_path / "目录" / "File.txt"
    nested.parent.mkdir()
    nested.write_text("content", encoding="utf-8")
    resolver = FileHistoryPathResolver(tmp_path)

    first = resolver.resolve(nested)
    second = resolver.resolve(Path("目录") / "." / "File.txt")

    assert first.absolute_path == nested.resolve()
    assert first.canonical_path == second.canonical_path
    assert first.display_path == "目录/File.txt"
    assert first.workspace_identity == second.workspace_identity


def test_file_history_path_resolver_normalizes_unicode_and_windows_case(tmp_path) -> None:
    resolver = FileHistoryPathResolver(tmp_path)
    composed = resolver.resolve(unicodedata.normalize("NFC", "café.txt"))
    decomposed = resolver.resolve(unicodedata.normalize("NFD", "café.txt"))
    assert composed.canonical_path == decomposed.canonical_path

    if os.name == "nt":
        assert resolver.resolve("Case.TXT").canonical_path == resolver.resolve(
            "case.txt"
        ).canonical_path


def test_file_history_path_resolver_rejects_escape_and_stored_identity_mismatch(tmp_path) -> None:
    resolver = FileHistoryPathResolver(tmp_path)
    outside = tmp_path.parent / "outside.txt"

    with pytest.raises(FileHistoryPathError) as escape:
        resolver.resolve(outside)
    assert escape.value.code == "path_outside_workspace"

    with pytest.raises(FileHistoryPathError) as mismatch:
        resolver.resolve_stored("safe.txt", "other.txt")
    assert mismatch.value.code == "canonical_path_mismatch"


def test_file_history_path_resolver_rejects_symlink_components(tmp_path) -> None:
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    link = tmp_path / "linked"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is unavailable")

    resolver = FileHistoryPathResolver(tmp_path)
    with pytest.raises(FileHistoryPathError) as error:
        resolver.resolve(link / "file.txt")
    assert error.value.code in {"path_link_unsafe", "path_outside_workspace"}


@pytest.mark.skipif(os.name != "nt", reason="Windows filename rules")
@pytest.mark.parametrize("name", ["CON", "nul.txt", "folder. ", "bad?.txt"])
def test_file_history_path_resolver_rejects_windows_reserved_names(tmp_path, name) -> None:
    resolver = FileHistoryPathResolver(tmp_path)

    with pytest.raises(FileHistoryPathError) as error:
        resolver.resolve(name)

    assert error.value.code == "path_invalid_windows_name"


def test_file_history_path_resolver_keeps_unicode_and_long_relative_identity(tmp_path) -> None:
    resolver = FileHistoryPathResolver(tmp_path)
    relative = Path("长目录" * 12) / ("emoji-😀-" + "x" * 120 + ".txt")

    resolved = resolver.resolve(relative)

    assert resolved.display_path == relative.as_posix()
    expected = unicodedata.normalize("NFC", relative.as_posix())
    if os.name == "nt":
        expected = expected.casefold()
    assert resolved.canonical_path == expected


def test_file_resource_identity_round_trips_without_trusting_absolute_path() -> None:
    identity = FileResourceIdentity(
        FileResourceScopeKind.EXTERNAL,
        "//server/share",
        "目录/File.txt",
    )

    restored = FileResourceIdentity.from_resource_id(identity.resource_id)

    assert restored == identity
    assert "absolute_path" not in identity.to_dict()
    assert restored.resource_key != FileResourceIdentity(
        FileResourceScopeKind.WORKSPACE,
        "//server/share",
        "目录/File.txt",
    ).resource_key


def test_file_resource_scope_rejects_empty_identity_and_invalid_kind(tmp_path) -> None:
    with pytest.raises(FileHistoryPathError) as empty:
        FileResourceScope("workspace", "", tmp_path, "project")
    assert empty.value.code == "scope_identity_empty"

    with pytest.raises(FileHistoryPathError) as invalid:
        FileResourceScope("machine", "machine", tmp_path, "machine")
    assert invalid.value.code == "scope_kind_invalid"


def test_file_history_path_resolver_prefers_longest_registered_workspace(tmp_path) -> None:
    primary = tmp_path / "primary"
    parent = tmp_path / "projects"
    nested = parent / "nested"
    primary.mkdir()
    nested.mkdir(parents=True)
    target = nested / "same.txt"
    target.write_text("nested", encoding="utf-8")
    resolver = FileHistoryPathResolver(
        primary,
        workspace_scopes=(
            ("workspace-parent", parent, "parent"),
            ("workspace-nested", nested, "nested"),
        ),
        allow_external=True,
    )

    resolved = resolver.resolve(target)

    assert resolved.scope_kind == FileResourceScopeKind.WORKSPACE
    assert resolved.scope_identity == "workspace-nested"
    assert resolved.canonical_path == "same.txt"
    assert resolved.scope_label == "nested"


def test_file_history_path_resolver_classifies_unregistered_path_as_external(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside" / "same.txt"
    workspace.mkdir()
    outside.parent.mkdir()
    outside.write_text("external", encoding="utf-8")
    resolver = FileHistoryPathResolver(workspace, allow_external=True)

    external = resolver.resolve(outside)
    local = resolver.resolve(workspace / "same.txt")

    assert external.scope_kind == FileResourceScopeKind.EXTERNAL
    assert external.requires_full_access is True
    assert external.resource_id != local.resource_id
    assert external.absolute_path == outside.resolve()


def test_scope_catalog_builds_from_registered_projects_and_round_trips_locator(tmp_path) -> None:
    @dataclass
    class Workspace:
        id: str
        name: str
        root_path: str

    primary = tmp_path / "primary"
    other = tmp_path / "other"
    primary.mkdir()
    other.mkdir()
    target = other / "folder" / "file.txt"
    target.parent.mkdir()
    target.write_text("content", encoding="utf-8")
    catalog = FileResourceScopeCatalog.from_workspaces(
        (
            Workspace("workspace-primary", "Primary", str(primary)),
            Workspace("workspace-other", "Other", str(other)),
        )
    )
    resolver = catalog.resolver(primary, allow_external=True)

    resolved = resolver.resolve(target)
    rebuilt = resolver.resolve_stored(
        resolved.display_path,
        resolved.canonical_path,
        scope_kind=resolved.scope_kind,
        scope_identity=resolved.scope_identity,
        scope_root=resolved.scope_root,
        scope_label=resolved.scope_label,
    )

    assert resolved.scope_identity == "workspace-other"
    assert rebuilt.identity == resolved.identity
    assert rebuilt.absolute_path == target.resolve()
