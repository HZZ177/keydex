from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ToolCallRequest
from langchain_core.messages import ToolMessage
from langgraph.types import Command


class DuplicateToolForceStopError(RuntimeError):
    def __init__(self, *, tool_name: str, repeat_count: int) -> None:
        super().__init__(
            f"工具 `{tool_name}` 使用相同参数连续调用已达 {repeat_count} 次，已强制终止本轮对话"
        )
        self.tool_name = tool_name
        self.repeat_count = repeat_count


class ToolErrorHandlingMiddleware(AgentMiddleware):
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        try:
            return await handler(request)
        except Exception as exc:
            tool_call = request.tool_call or {}
            return ToolMessage(
                content=json.dumps(
                    {
                        "code": "tool_execution_failed",
                        "message": str(exc),
                        "type": type(exc).__name__,
                    },
                    ensure_ascii=False,
                ),
                tool_call_id=str(tool_call.get("id") or ""),
                name=str(tool_call.get("name") or ""),
                status="error",
            )


class DuplicateToolCallGuardMiddleware(AgentMiddleware):
    def __init__(self, *, max_repeats: int = 3) -> None:
        self.max_repeats = max(1, max_repeats)
        self._last_signature: str | None = None
        self._repeat_count = 0

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        tool_call = request.tool_call or {}
        tool_name = str(tool_call.get("name") or "")
        signature = _tool_signature(tool_call)
        if signature == self._last_signature:
            self._repeat_count += 1
        else:
            self._last_signature = signature
            self._repeat_count = 1

        if self._repeat_count > self.max_repeats:
            raise DuplicateToolForceStopError(
                tool_name=tool_name or "unknown_tool",
                repeat_count=self._repeat_count,
            )
        return await handler(request)


def build_default_middleware() -> tuple[AgentMiddleware, ...]:
    return (
        ToolErrorHandlingMiddleware(),
        DuplicateToolCallGuardMiddleware(),
    )


def _tool_signature(tool_call: Any) -> str:
    name = str(tool_call.get("name") or "")
    args = tool_call.get("args") or {}
    try:
        args_text = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        args_text = str(args)
    return f"{name}:{args_text}"
