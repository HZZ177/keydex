from __future__ import annotations

import pytest

from backend.app.mcp.client import McpClientPromptResult
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.prompts import normalize_mcp_prompt_result, validate_prompt_arguments
from backend.app.mcp.types import McpErrorCode


def test_validate_prompt_arguments_accepts_object_and_none_for_optional_schema() -> None:
    schema = {
        "type": "object",
        "properties": {"topic": {"type": "string"}},
    }

    assert validate_prompt_arguments(schema, {"topic": "MCP"}) == {"topic": "MCP"}
    assert validate_prompt_arguments(schema, None) == {}


@pytest.mark.parametrize(
    ("arguments", "expected_detail"),
    [
        (
            {},
            {"reason": "required_arguments_missing", "missing": ["topic"]},
        ),
        (
            {"topic": 123},
            {
                "reason": "argument_type_mismatch",
                "argument": "topic",
                "expected": ["string"],
            },
        ),
        (
            "not-object",
            {"reason": "arguments_must_be_object"},
        ),
    ],
)
def test_validate_prompt_arguments_rejects_invalid_arguments(
    arguments,
    expected_detail: dict,
) -> None:
    schema = {
        "type": "object",
        "properties": {"topic": {"type": "string"}},
        "required": ["topic"],
    }

    with pytest.raises(McpRuntimeError) as exc_info:
        validate_prompt_arguments(schema, arguments)

    assert exc_info.value.code == McpErrorCode.VALIDATION_ERROR
    assert exc_info.value.detail == expected_detail


def test_normalize_mcp_prompt_result_preserves_messages_metadata_and_arguments() -> None:
    result = McpClientPromptResult(
        description="Ready prompt",
        messages=[{"role": "user", "content": {"type": "text", "text": "Summarize MCP"}}],
        metadata={"source": "fake"},
    )

    payload = normalize_mcp_prompt_result(
        server_id="srv_prompt",
        raw_prompt_name="summarize",
        arguments={"topic": "MCP"},
        result=result,
    )

    assert payload == {
        "server_id": "srv_prompt",
        "raw_name": "summarize",
        "description": "Ready prompt",
        "arguments": {"topic": "MCP"},
        "messages": [
            {"role": "user", "content": {"type": "text", "text": "Summarize MCP"}}
        ],
        "metadata": {"source": "fake"},
    }
