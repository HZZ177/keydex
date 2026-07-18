from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from backend.app.subagents.models import DelegateSubagentRequest
from backend.app.tools.base import FunctionTool, ToolExecutionError, ToolHandler

DELEGATE_SUBAGENT_TOOL_NAME = "delegate_subagent"
DELEGATE_SUBAGENT_TOOL_DESCRIPTION = (
    "Delegate one bounded task to a preset Sub-Agent. Use explorer for read-only "
    "investigation and worker for implementation. Provide only the preset type and "
    "a complete standalone task; the call returns the terminal result and final report."
)
DELEGATE_SUBAGENT_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "type": {
            "type": "string",
            "enum": ["explorer", "worker"],
            "description": "The immutable Sub-Agent preset to use.",
        },
        "task": {
            "type": "string",
            "minLength": 1,
            "description": "A complete, bounded task the Sub-Agent can execute independently.",
        },
    },
    "required": ["type", "task"],
    "additionalProperties": False,
}


def parse_delegate_subagent_request(args: dict[str, Any]) -> DelegateSubagentRequest:
    try:
        return DelegateSubagentRequest.model_validate(args)
    except ValidationError as exc:
        validation_errors = [
            {
                "type": item["type"],
                "loc": [str(part) for part in item["loc"]],
                "message": item["msg"],
            }
            for item in exc.errors(include_input=False)
        ]
        raise ToolExecutionError(
            "delegate_subagent requires exactly type=explorer|worker and a non-empty task",
            code="SUBAGENT_REQUEST_INVALID",
            details={"validation_errors": validation_errors},
        ) from exc


def create_delegate_subagent_tool(handler: ToolHandler) -> FunctionTool:
    return FunctionTool(
        name=DELEGATE_SUBAGENT_TOOL_NAME,
        description=DELEGATE_SUBAGENT_TOOL_DESCRIPTION,
        parameters=DELEGATE_SUBAGENT_PARAMETERS,
        handler=handler,
    )
