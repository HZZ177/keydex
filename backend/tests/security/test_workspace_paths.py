from pathlib import Path

import pytest

from backend.app.security import (
    WorkspacePathError,
    normalize_workspace_roots,
    resolve_path,
    resolve_workspace_path,
)


def test_resolves_relative_path_inside_workspace(tmp_path) -> None:
    nested = tmp_path / "src"
    nested.mkdir()

    resolved = resolve_workspace_path(
        "src/../src",
        cwd=tmp_path,
        workspace_roots=[tmp_path],
    )

    assert resolved == nested.resolve()


def test_rejects_path_outside_workspace(tmp_path) -> None:
    outside = tmp_path.parent / "outside.txt"

    with pytest.raises(WorkspacePathError):
        resolve_workspace_path(outside, cwd=tmp_path, workspace_roots=[tmp_path])


def test_resolve_path_reports_external_without_throwing(tmp_path) -> None:
    outside = tmp_path.parent / "outside.txt"

    resolved = resolve_path(outside, cwd=tmp_path, workspace_roots=[tmp_path])

    assert not resolved.is_inside_workspace
    assert resolved.workspace_root is None


def test_normalize_workspace_roots_deduplicates_and_resolves(tmp_path) -> None:
    roots = normalize_workspace_roots(tmp_path, [tmp_path, Path(tmp_path) / "."])

    assert roots == [tmp_path.resolve()]
