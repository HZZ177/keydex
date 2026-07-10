from __future__ import annotations

import json
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
from langgraph.types import Command

from backend.app.agent.state import (
    PENDING_TOOL_CALL_PRESET_STATE_KEY,
    build_pending_tool_call_preset_update,
)
from backend.app.agent.tool_call_preset import ToolCallPreset, ToolCallPresetItem
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
        context_preset = get_tool_call_preset()
        state_preset = self._state_preset(request)
        force_presets = [
            preset
            for preset in (context_preset, state_preset)
            if preset is not None and preset.type == "force"
        ]
        if not force_presets:
            if context_preset is not None:
                logger.debug(
                    "[ToolCallPresetMiddleware] skip unsupported preset type | "
                    f"type={context_preset.type}"
                )
            return await handler(request)

        calls = self._deduplicate_calls(
            call for preset in force_presets for call in preset.calls
        )
        self._validate_force_target(calls)
        available_tool_names = self._available_tool_names(request.tools or [])
        matching_calls = [call for call in calls if call.name in available_tool_names]
        if not matching_calls:
            logger.warning(
                "[ToolCallPresetMiddleware] force preset skipped because tools are not "
                f"registered | preset_tools={[call.name for call in calls]} | "
                f"available_tools={sorted(available_tool_names)}"
            )
            return await handler(request)

        if context_preset is not None and context_preset.type == "force":
            consume_tool_call_preset()
        tool_calls = [self._build_tool_call(call, index) for index, call in enumerate(calls)]
        logger.info(
            f"[ToolCallPresetMiddleware] force preset hit | tool_count={len(tool_calls)} | "
            f"tools={[call['name'] for call in tool_calls]}"
        )
        message = AIMessage(content="", tool_calls=tool_calls)
        if state_preset is None:
            return message
        return ExtendedModelResponse(
            model_response=ModelResponse(result=[message]),
            command=Command(update=build_pending_tool_call_preset_update(None)),
        )

    @staticmethod
    def _state_preset(request: ModelRequest) -> ToolCallPreset | None:
        state = request.state if isinstance(request.state, dict) else {}
        raw_preset = state.get(PENDING_TOOL_CALL_PRESET_STATE_KEY)
        if not isinstance(raw_preset, dict):
            return None
        try:
            return ToolCallPreset(**raw_preset)
        except (TypeError, ValueError) as exc:
            logger.warning(
                "[ToolCallPresetMiddleware] invalid state preset skipped | "
                f"error={exc}"
            )
            return None

    @staticmethod
    def _deduplicate_calls(calls: Any) -> list[ToolCallPresetItem]:
        result: list[ToolCallPresetItem] = []
        seen: set[tuple[str, str]] = set()
        for call in calls:
            identity = (
                call.name,
                json.dumps(call.args, ensure_ascii=True, sort_keys=True, separators=(",", ":")),
            )
            if identity in seen:
                continue
            seen.add(identity)
            result.append(call)
        return result

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
