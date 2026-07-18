from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend.app.subagents.models import SubagentRole
from backend.app.tools.base import ToolExecutionContext
from backend.app.tools.subagent import (
    DELEGATE_SUBAGENT_PARAMETERS,
    DELEGATE_SUBAGENT_TOOL_NAME,
    create_delegate_subagent_tool,
    parse_delegate_subagent_request,
)


def _context(tmp_path: Path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="parent-session",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="parent-trace",
        metadata={"tool_call_id": "parent-tool-call"},
    )


def test_delegate_subagent_schema_exposes_exactly_type_and_task() -> None:
    tool = create_delegate_subagent_tool(lambda _args, _context: None)
    spec = tool.to_tool_spec()

    assert tool.name == spec.name == DELEGATE_SUBAGENT_TOOL_NAME
    assert spec.parameters == DELEGATE_SUBAGENT_PARAMETERS
    assert set(spec.parameters["properties"]) == {"type", "task"}
    assert spec.parameters["required"] == ["type", "task"]
    assert spec.parameters["additionalProperties"] is False
    assert "background" not in str(spec.parameters).lower()
    assert "run_id" not in str(spec.parameters).lower()


@pytest.mark.parametrize("role", ["explorer", "worker"])
def test_delegate_subagent_parser_accepts_only_fixed_role_and_trimmed_task(role: str) -> None:
    request = parse_delegate_subagent_request(
        {"type": role, "task": "  bounded task  "}
    )

    assert request.type is SubagentRole(role)
    assert request.task == "bounded task"


@pytest.mark.parametrize(
    "args",
    [
        {"type": "unknown", "task": "work"},
        {"type": "worker", "task": "   "},
        {"type": "worker"},
        {"task": "work"},
        {"type": "worker", "task": "work", "model": "forbidden"},
        {"type": "worker", "task": "work", "background": True},
        {"type": "worker", "task": "work", "run_id": "forbidden"},
    ],
)
def test_delegate_subagent_parser_rejects_unknown_missing_blank_and_extra_fields(
    args,
) -> None:
    with pytest.raises(Exception) as raised:
        parse_delegate_subagent_request(args)

    assert getattr(raised.value, "code", None) == "SUBAGENT_REQUEST_INVALID"


def test_delegate_subagent_function_tool_returns_stable_validation_error(tmp_path) -> None:
    async def handler(args, _context):
        return parse_delegate_subagent_request(args).model_dump(mode="json")

    tool = create_delegate_subagent_tool(handler)
    result = asyncio.run(
        tool.run(
            {"type": "worker", "task": "work", "tools": ["forbidden"]},
            _context(tmp_path),
        )
    )

    assert result.ok is False
    assert result.error is not None
    assert result.error["code"] == "SUBAGENT_REQUEST_INVALID"
    assert result.error["retryable"] is False
