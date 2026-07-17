from __future__ import annotations

from types import SimpleNamespace

import pytest
from langchain.agents.middleware.types import ExtendedModelResponse, ModelRequest
from langchain_core.messages import AIMessage

from backend.app.agent.tool_call_preset import ToolCallPreset, ToolCallPresetItem
from backend.app.agent.tool_call_preset_middleware import (
    ToolCallPresetMiddleware,
    ToolCallPresetRejectedError,
)
from backend.app.core.request_context import (
    get_tool_call_preset,
    reset_request_context,
    set_request_context,
)


def _request(
    *,
    tools: list[object] | None = None,
    state: dict[str, object] | None = None,
) -> ModelRequest:
    return ModelRequest(model=object(), messages=[], tools=tools or [], state=state or {})


def _force_preset(tool_name: str = "load_skill") -> ToolCallPreset:
    return ToolCallPreset(
        type="force",
        calls=[ToolCallPresetItem(name=tool_name, args={"skill_name": "dev-plan"})],
    )


@pytest.mark.asyncio
async def test_force_preset_returns_synthetic_load_skill_tool_call() -> None:
    middleware = ToolCallPresetMiddleware()
    preset = _force_preset()
    token = set_request_context(tool_call_preset=preset)
    handler_called = False

    async def handler(request: ModelRequest) -> AIMessage:
        nonlocal handler_called
        handler_called = True
        return AIMessage(content="normal")

    try:
        result = await middleware.awrap_model_call(
            _request(tools=[SimpleNamespace(name="load_skill")]),
            handler,
        )
        assert isinstance(result, AIMessage)
        assert result.content == ""
        assert result.tool_calls == [
            {
                "id": "preset_force_load_skill_0",
                "name": "load_skill",
                "args": {"skill_name": "dev-plan"},
                "type": "tool_call",
            }
        ]
        assert handler_called is False
        assert get_tool_call_preset() is None
    finally:
        reset_request_context(token)


@pytest.mark.asyncio
async def test_no_preset_calls_model_handler() -> None:
    middleware = ToolCallPresetMiddleware()

    async def handler(request: ModelRequest) -> AIMessage:
        return AIMessage(content="normal")

    result = await middleware.awrap_model_call(_request(), handler)

    assert isinstance(result, AIMessage)
    assert result.content == "normal"


@pytest.mark.asyncio
async def test_state_preset_returns_tool_call_and_atomic_reset_command() -> None:
    middleware = ToolCallPresetMiddleware()
    handler_called = False

    async def handler(request: ModelRequest) -> AIMessage:
        nonlocal handler_called
        handler_called = True
        return AIMessage(content="normal")

    result = await middleware.awrap_model_call(
        _request(
            tools=[SimpleNamespace(name="load_skill")],
            state={"pending_tool_call_preset": _force_preset().to_dict()},
        ),
        handler,
    )

    assert isinstance(result, ExtendedModelResponse)
    assert result.model_response.result[0].tool_calls == [
        {
            "id": "preset_force_load_skill_0",
            "name": "load_skill",
            "args": {"skill_name": "dev-plan"},
            "type": "tool_call",
        }
    ]
    assert result.command is not None
    assert result.command.update == {"pending_tool_call_preset": None}
    assert handler_called is False


@pytest.mark.asyncio
async def test_compression_state_preset_marks_boundary_consumed_only_after_tool_call() -> None:
    middleware = ToolCallPresetMiddleware()
    preset = ToolCallPreset(
        type="force",
        calls=[ToolCallPresetItem(name="load_skill", args={"skill_name": "dev-plan"})],
        metadata={
            "source": "context_compression",
            "boundary_id": "boundary-1",
            "selected_group_ids": ["group-1", "group-1"],
        },
    )

    async def handler(request: ModelRequest) -> AIMessage:
        return AIMessage(content="normal")

    not_consumed = await middleware.awrap_model_call(
        _request(
            tools=[SimpleNamespace(name="read_file")],
            state={"pending_tool_call_preset": preset.to_dict()},
        ),
        handler,
    )
    assert isinstance(not_consumed, AIMessage)
    assert not_consumed.content == "normal"

    consumed = await middleware.awrap_model_call(
        _request(
            tools=[SimpleNamespace(name="load_skill")],
            state={"pending_tool_call_preset": preset.to_dict()},
        ),
        handler,
    )
    assert isinstance(consumed, ExtendedModelResponse)
    assert consumed.command is not None
    assert consumed.command.update == {
        "pending_tool_call_preset": None,
        "structured_user_group_replay_markers": {
            "boundary-1:group-1": {
                "boundary_id": "boundary-1",
                "group_id": "group-1",
                "status": "consumed",
            }
        },
    }


@pytest.mark.asyncio
async def test_force_preset_without_registered_tool_falls_back_without_consuming() -> None:
    middleware = ToolCallPresetMiddleware()
    preset = _force_preset()
    token = set_request_context(tool_call_preset=preset)

    async def handler(request: ModelRequest) -> AIMessage:
        return AIMessage(content="normal")

    try:
        result = await middleware.awrap_model_call(
            _request(tools=[SimpleNamespace(name="read_file")]),
            handler,
        )
        assert isinstance(result, AIMessage)
        assert result.content == "normal"
        assert get_tool_call_preset() is preset
    finally:
        reset_request_context(token)


@pytest.mark.asyncio
async def test_force_preset_rejects_non_load_skill_tool() -> None:
    middleware = ToolCallPresetMiddleware()
    token = set_request_context(tool_call_preset=_force_preset("read_file"))

    async def handler(request: ModelRequest) -> AIMessage:
        return AIMessage(content="normal")

    try:
        with pytest.raises(ToolCallPresetRejectedError):
            await middleware.awrap_model_call(
                _request(tools=[SimpleNamespace(name="read_file")]),
                handler,
            )
        assert get_tool_call_preset() is None
    finally:
        reset_request_context(token)


@pytest.mark.asyncio
async def test_guide_preset_is_reserved_and_passes_through() -> None:
    middleware = ToolCallPresetMiddleware()
    preset = ToolCallPreset(
        type="guide",
        calls=[ToolCallPresetItem(name="load_skill", args={"skill_name": "dev-plan"})],
    )
    token = set_request_context(tool_call_preset=preset)

    async def handler(request: ModelRequest) -> AIMessage:
        return AIMessage(content="normal")

    try:
        result = await middleware.awrap_model_call(
            _request(tools=[SimpleNamespace(name="load_skill")]),
            handler,
        )
        assert isinstance(result, AIMessage)
        assert result.content == "normal"
        assert get_tool_call_preset() is preset
    finally:
        reset_request_context(token)
