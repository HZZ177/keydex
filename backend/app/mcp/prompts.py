from __future__ import annotations

from typing import Any

from backend.app.mcp.client import McpClientPromptResult
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.types import McpErrorCode


def validate_prompt_arguments(
    schema: dict[str, Any],
    arguments: dict[str, Any] | None,
) -> dict[str, Any]:
    if arguments is None:
        parsed: dict[str, Any] = {}
    elif isinstance(arguments, dict):
        parsed = dict(arguments)
    else:
        raise McpRuntimeError(
            McpErrorCode.VALIDATION_ERROR,
            detail={"reason": "arguments_must_be_object"},
        )
    required = schema.get("required")
    if isinstance(required, list):
        missing = [str(key) for key in required if str(key) not in parsed]
        if missing:
            raise McpRuntimeError(
                McpErrorCode.VALIDATION_ERROR,
                detail={"reason": "required_arguments_missing", "missing": missing},
            )
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return parsed
    for key, value in parsed.items():
        property_schema = properties.get(key)
        if isinstance(property_schema, dict):
            _validate_json_schema_type(key, value, property_schema.get("type"))
    return parsed


def normalize_mcp_prompt_result(
    *,
    server_id: str,
    raw_prompt_name: str,
    arguments: dict[str, Any],
    result: McpClientPromptResult,
) -> dict[str, Any]:
    return {
        "server_id": server_id,
        "raw_name": raw_prompt_name,
        "description": result.description,
        "arguments": arguments,
        "messages": result.messages,
        "metadata": result.metadata,
    }


def _validate_json_schema_type(key: str, value: Any, schema_type: Any) -> None:
    if schema_type is None:
        return
    expected_types = schema_type if isinstance(schema_type, list) else [schema_type]
    if "null" in expected_types and value is None:
        return
    type_checks = {
        "string": lambda item: isinstance(item, str),
        "number": lambda item: isinstance(item, int | float) and not isinstance(item, bool),
        "integer": lambda item: isinstance(item, int) and not isinstance(item, bool),
        "boolean": lambda item: isinstance(item, bool),
        "object": lambda item: isinstance(item, dict),
        "array": lambda item: isinstance(item, list),
    }
    for expected_type in expected_types:
        checker = type_checks.get(str(expected_type))
        if checker is not None and checker(value):
            return
    raise McpRuntimeError(
        McpErrorCode.VALIDATION_ERROR,
        detail={
            "reason": "argument_type_mismatch",
            "argument": key,
            "expected": [str(item) for item in expected_types],
        },
    )
