from __future__ import annotations

import os
import unicodedata
from pathlib import Path

import pytest

from backend.app.services.file_history_service import (
    FileHistoryPathError,
    FileHistoryPathResolver,
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
