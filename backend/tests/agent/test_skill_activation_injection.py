from __future__ import annotations

import pytest
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.agent.skill_activation_middleware import SkillActivationInjectionMiddleware
from backend.app.agent.state import PENDING_SKILL_ACTIVATIONS_RESET_MARKER


@pytest.mark.asyncio
async def test_no_pending_skill_activation_is_noop() -> None:
    middleware = SkillActivationInjectionMiddleware()

    result = await middleware.abefore_model({"messages": [HumanMessage(content="hi")]}, None)

    assert result is None


@pytest.mark.asyncio
async def test_pending_skill_activation_injects_system_messages_and_resets() -> None:
    middleware = SkillActivationInjectionMiddleware()
    original = [HumanMessage(content="use a skill")]

    result = await middleware.abefore_model(
        {
            "messages": original,
            "pending_skill_activations": [
                {"skill_name": "alpha", "content": "Alpha instructions"},
                {"skill_name": "beta", "content": "Beta instructions"},
            ],
        },
        None,
    )

    assert result is not None
    messages = result["messages"]
    assert isinstance(messages[0], RemoveMessage)
    assert messages[0].id == REMOVE_ALL_MESSAGES
    assert messages[1:] == [
        original[0],
        SystemMessage(content="Alpha instructions"),
        SystemMessage(content="Beta instructions"),
    ]
    assert result["pending_skill_activations"] == [PENDING_SKILL_ACTIVATIONS_RESET_MARKER]


@pytest.mark.asyncio
async def test_invalid_pending_items_only_reset_pending() -> None:
    middleware = SkillActivationInjectionMiddleware()

    result = await middleware.abefore_model(
        {
            "messages": [HumanMessage(content="hi")],
            "pending_skill_activations": [
                {"skill_name": "alpha", "content": ""},
                "not-a-dict",
            ],
        },
        None,
    )

    assert result == {
        "pending_skill_activations": [PENDING_SKILL_ACTIVATIONS_RESET_MARKER],
    }


@pytest.mark.asyncio
async def test_skill_activation_is_appended_after_existing_tool_sequence() -> None:
    middleware = SkillActivationInjectionMiddleware()
    ai_message = AIMessage(
        content="",
        tool_calls=[
            {
                "id": "call_1",
                "name": "load_skill",
                "args": {"skill_name": "alpha"},
                "type": "tool_call",
            }
        ],
    )
    tool_message = ToolMessage(content="loaded", tool_call_id="call_1", name="load_skill")

    result = await middleware.abefore_model(
        {
            "messages": [HumanMessage(content="hi"), ai_message, tool_message],
            "pending_skill_activations": [
                {"skill_name": "alpha", "content": "Alpha instructions"},
            ],
        },
        None,
    )

    assert result is not None
    assert result["messages"][1:] == [
        HumanMessage(content="hi"),
        ai_message,
        tool_message,
        SystemMessage(content="Alpha instructions"),
    ]
