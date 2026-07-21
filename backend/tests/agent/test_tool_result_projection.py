from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.agent.tool_results.budgets import (
    GLOBAL_TOOL_RESULT_BUDGET_BYTES,
    ToolResultPolicy,
    get_tool_result_policy,
)
from backend.app.agent.tool_results.models import (
    ToolResultProjection,
    ToolResultProjectionMeta,
)
from backend.app.agent.tool_results.projectors import project_tool_result
from backend.app.tools.base import ToolExecutionContext


def _context(tmp_path: Path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=1,
    )


@pytest.mark.parametrize(
    "payload",
    [
        "x" * 200_000,
        {"items": [{"index": index, "value": "中😀" * 100} for index in range(1000)]},
        ["value" * 100 for _ in range(2000)],
    ],
    ids=["large-text", "large-dict", "large-list"],
)
def test_generic_projection_is_valid_json_within_global_budget(
    payload: object,
    tmp_path: Path,
) -> None:
    projection = project_tool_result(
        payload,
        tool_name="unknown_tool",
        policy=get_tool_result_policy("unknown_tool"),
        context=_context(tmp_path),
    )
    parsed = json.loads(projection.model_content)
    assert len(projection.model_content.encode("utf-8")) <= GLOBAL_TOOL_RESULT_BUDGET_BYTES
    assert parsed["truncated"] is True
    assert parsed["_keydex_projection"] == {
        "truncated": True,
        "reason_code": "budget_exceeded",
    }
    assert projection.meta.full_bytes > GLOBAL_TOOL_RESULT_BUDGET_BYTES
    assert parsed == projection.display_payload


def test_complete_projection_sends_only_business_payload(tmp_path: Path) -> None:
    payload = {"path": ".", "tree": "./\nsrc/", "truncated": False}

    projection = project_tool_result(
        payload,
        tool_name="list_dir",
        policy=get_tool_result_policy("list_dir"),
        context=_context(tmp_path),
    )

    assert json.loads(projection.model_content) == payload
    assert "_keydex_projection" not in projection.model_content
    assert projection.meta.full_bytes == projection.meta.model_bytes


def test_circular_and_unserializable_values_do_not_break_projection(tmp_path: Path) -> None:
    circular: list[object] = []
    circular.append(circular)

    class Broken:
        def __str__(self) -> str:
            raise RuntimeError("cannot stringify")

    projection = project_tool_result(
        {"circular": circular, "broken": Broken()},
        tool_name="unknown_tool",
        policy=get_tool_result_policy("unknown_tool"),
        context=_context(tmp_path),
    )
    parsed = json.loads(projection.model_content)
    assert parsed["circular"] == ["<circular reference>"]
    assert parsed["broken"] == "<Broken>"


def test_must_be_complete_never_returns_a_partial_prefix(tmp_path: Path) -> None:
    projection = project_tool_result(
        {"instruction": "secret-rule\n" * 10_000},
        tool_name="load_skill",
        policy=get_tool_result_policy("load_skill"),
        context=_context(tmp_path),
    )
    parsed = json.loads(projection.model_content)
    assert parsed["ok"] is False
    assert parsed["error"]["code"] == "tool_result_too_large_for_model"
    assert "secret-rule" not in projection.model_content
    assert len(projection.model_content.encode("utf-8")) <= GLOBAL_TOOL_RESULT_BUDGET_BYTES


def test_custom_projector_cannot_bypass_final_guard(tmp_path: Path) -> None:
    def oversized(*_args, **_kwargs) -> ToolResultProjection:
        content = "x" * 100_000
        meta = ToolResultProjectionMeta(
            tool_name="custom",
            full_bytes=len(content),
            model_bytes=len(content),
            approximate_full_tokens=25_000,
            approximate_model_tokens=25_000,
            budget_bytes=GLOBAL_TOOL_RESULT_BUDGET_BYTES,
            truncated=False,
        )
        return ToolResultProjection(
            model_content=content,
            display_payload={"content": content},
            meta=meta,
        )

    projection = project_tool_result(
        {},
        tool_name="custom",
        policy=ToolResultPolicy(),
        context=_context(tmp_path),
        projector=oversized,
    )
    assert len(projection.model_content.encode("utf-8")) <= GLOBAL_TOOL_RESULT_BUDGET_BYTES
    assert projection.meta.truncated is True
