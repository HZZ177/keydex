from __future__ import annotations

import pytest

from backend.app.tools.base import ToolExecutionContext, ToolExecutionError
from backend.app.tools.command_runtime.tools import _relative, _resolve_cwd


def _context(workspace) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=workspace,
        turn_index=1,
        trace_id="trace-1",
    )


def test_full_access_allows_absolute_external_cwd(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    external = tmp_path / "external"
    workspace.mkdir()
    external.mkdir()
    context = _context(workspace)

    resolved = _resolve_cwd(
        str(external),
        context,
        file_access_mode="full_access",
    )

    assert resolved == external.resolve()
    assert _relative(resolved, context) == str(external.resolve())


def test_workspace_modes_still_reject_external_cwd(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    external = tmp_path / "external"
    workspace.mkdir()
    external.mkdir()

    with pytest.raises(ToolExecutionError) as error:
        _resolve_cwd(
            str(external),
            _context(workspace),
            file_access_mode="workspace_trusted",
        )

    assert error.value.code == "workspace_path_forbidden"


def test_full_access_relative_cwd_remains_workspace_relative(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    nested = workspace / "nested"
    nested.mkdir(parents=True)

    resolved = _resolve_cwd(
        "nested",
        _context(workspace),
        file_access_mode="full_access",
    )

    assert resolved == nested.resolve()
    assert _relative(resolved, _context(workspace)) == "nested"
