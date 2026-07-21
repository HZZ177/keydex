from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from backend.app.agent.tool_results.budgets import get_tool_result_policy
from backend.app.agent.tool_results.models import (
    KeydexToolMessageArtifact,
    ToolResultProjectionMeta,
)
from backend.app.agent.tool_results.projectors import project_tool_result
from backend.app.tools.base import FunctionTool, ToolExecutionContext


def _context(tmp_path: Path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=1,
    )


def test_projection_models_round_trip_and_runtime_artifact_is_bounded_view(tmp_path: Path) -> None:
    projection = project_tool_result(
        {"kind": "example", "items": [{"path": "a.py", "line": 1}]},
        tool_name="example",
        policy=get_tool_result_policy("example"),
        context=_context(tmp_path),
    )
    parsed = json.loads(projection.model_content)
    artifact = KeydexToolMessageArtifact.model_validate(projection.runtime_artifact())

    assert parsed == artifact.display_payload
    assert artifact.projection.model_bytes == len(projection.model_content.encode("utf-8"))
    assert "items" in artifact.display_payload
    assert "full_payload" not in artifact.model_dump(mode="json")


def test_unknown_projection_schema_version_is_rejected() -> None:
    with pytest.raises(ValidationError):
        ToolResultProjectionMeta.model_validate(
            {
                "schema_version": "keydex.tool_projection.v2",
                "tool_name": "example",
                "full_bytes": 0,
                "model_bytes": 0,
                "approximate_full_tokens": 0,
                "approximate_model_tokens": 0,
                "budget_bytes": 1024,
                "truncated": False,
                "artifact_complete": True,
            }
        )


def test_function_tool_remains_compatible_without_projector() -> None:
    tool = FunctionTool(
        name="example",
        description="example",
        parameters={"type": "object", "properties": {}},
        handler=lambda _args, _context: {"ok": True},
    )
    assert tool.result_projector is None


def test_projector_exception_becomes_stable_small_failure(tmp_path: Path) -> None:
    def explode(*_args, **_kwargs):
        raise RuntimeError("secret full result")

    projection = project_tool_result(
        {"secret": "x" * 100_000},
        tool_name="example",
        policy=get_tool_result_policy("example"),
        context=_context(tmp_path),
        projector=explode,
    )
    parsed = json.loads(projection.model_content)
    assert parsed["error"]["code"] == "tool_result_projection_failed"
    assert "secret full result" not in projection.model_content
