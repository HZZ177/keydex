from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import (
    ExtendedModelResponse,
    ModelRequest,
    ModelResponse,
)
from langchain_core.messages import AIMessage

from backend.app.agent.tool_call_preset import ToolCallPresetItem
from backend.app.core.logger import logger
from backend.app.core.request_context import consume_tool_call_preset, get_tool_call_preset

_TOOL_CALL_ID_SAFE_CHARS = re.compile(r"[^A-Za-z0-9_-]+")


class ToolCallPresetRejectedError(ValueError):
    pass


class ToolCallPresetMiddleware(AgentMiddleware):
    def __init__(
        self,
        *,
        allowed_force_tools: set[str] | frozenset[str] | None = None,
    ) -> None:
        super().__init__()
        self.allowed_force_tools = frozenset(allowed_force_tools or {"load_skill"})

    @property
    def name(self) -> str:
        return "ToolCallPresetMiddleware"

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[
            [ModelRequest],
            Awaitable[ModelResponse | ExtendedModelResponse | AIMessage],
        ],
    ) -> ModelResponse | ExtendedModelResponse | AIMessage:
        preset = get_tool_call_preset()
        if preset is None:
            return await handler(request)

        if preset.type != "force":
            logger.debug(
                f"[ToolCallPresetMiddleware] skip unsupported preset type | type={preset.type}"
            )
            return await handler(request)

        self._validate_force_target(preset.calls)
        available_tool_names = self._available_tool_names(request.tools or [])
        matching_calls = [call for call in preset.calls if call.name in available_tool_names]
        if not matching_calls:
            logger.warning(
                "[ToolCallPresetMiddleware] force preset skipped because tools are not "
                f"registered | preset_tools={[call.name for call in preset.calls]} | "
                f"available_tools={sorted(available_tool_names)}"
            )
            return await handler(request)

        consumed_preset = consume_tool_call_preset()
        calls = (consumed_preset or preset).calls
        tool_calls = [self._build_tool_call(call, index) for index, call in enumerate(calls)]
        logger.info(
            f"[ToolCallPresetMiddleware] force preset hit | tool_count={len(tool_calls)} | "
            f"tools={[call['name'] for call in tool_calls]}"
        )
        return AIMessage(content="", tool_calls=tool_calls)

    def _validate_force_target(self, calls: list[ToolCallPresetItem]) -> None:
        invalid_names = sorted(
            {call.name for call in calls if call.name not in self.allowed_force_tools}
        )
        if not invalid_names:
            return
        consume_tool_call_preset()
        raise ToolCallPresetRejectedError(
            "force tool call preset only allows: "
            f"{', '.join(sorted(self.allowed_force_tools))}; got: {', '.join(invalid_names)}"
        )

    @staticmethod
    def _available_tool_names(tools: list[Any]) -> set[str]:
        names: set[str] = set()
        for tool in tools:
            name = getattr(tool, "name", None)
            if name:
                names.add(str(name))
                continue
            if isinstance(tool, dict):
                dict_name = tool.get("name")
                if not dict_name and isinstance(tool.get("function"), dict):
                    dict_name = tool["function"].get("name")
                if dict_name:
                    names.add(str(dict_name))
        return names

    @staticmethod
    def _build_tool_call(call: ToolCallPresetItem, index: int) -> dict[str, Any]:
        safe_name = _TOOL_CALL_ID_SAFE_CHARS.sub("_", call.name).strip("_") or "tool"
        return {
            "id": f"preset_force_{safe_name}_{index}",
            "name": call.name,
            "args": dict(call.args),
            "type": "tool_call",
        }
