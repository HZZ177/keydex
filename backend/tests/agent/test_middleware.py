from __future__ import annotations

import pytest
from langchain.agents.middleware import ToolCallRequest
from langchain_core.messages import ToolMessage

from backend.app.agent.middleware import (
    DuplicateToolCallGuardMiddleware,
    DuplicateToolForceStopError,
    ToolErrorHandlingMiddleware,
)


def _request() -> ToolCallRequest:
    return ToolCallRequest(
        tool_call={"id": "call_1", "name": "read_file", "args": {"path": "a.txt"}},
        tool=None,
        state={},
        runtime=None,
    )


@pytest.mark.asyncio
async def test_tool_error_handling_middleware_returns_error_tool_message() -> None:
    middleware = ToolErrorHandlingMiddleware()

    async def failing_handler(request: ToolCallRequest) -> ToolMessage:
        raise RuntimeError("boom")

    result = await middleware.awrap_tool_call(_request(), failing_handler)

    assert isinstance(result, ToolMessage)
    assert result.status == "error"
    assert result.tool_call_id == "call_1"
    assert "boom" in result.content


@pytest.mark.asyncio
async def test_duplicate_tool_call_guard_stops_repeated_same_args() -> None:
    middleware = DuplicateToolCallGuardMiddleware(max_repeats=2)

    async def handler(request: ToolCallRequest) -> ToolMessage:
        return ToolMessage(content="ok", tool_call_id="call_1")

    await middleware.awrap_tool_call(_request(), handler)
    await middleware.awrap_tool_call(_request(), handler)

    with pytest.raises(DuplicateToolForceStopError):
        await middleware.awrap_tool_call(_request(), handler)
