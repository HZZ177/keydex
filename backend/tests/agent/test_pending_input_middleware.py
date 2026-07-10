from __future__ import annotations

import pytest
from langchain_core.messages import HumanMessage, RemoveMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.agent.middleware.pending_inputs import PendingUserInputInjectionMiddleware
from backend.app.core.request_context import (
    get_tool_call_preset,
    reset_request_context,
    set_request_context,
)
from backend.app.events import DomainEvent, DomainEventType, EventDispatcher
from backend.app.services.chat_types import (
    PENDING_INPUT_MODE_STEER,
    PENDING_INPUT_STATUS_DELIVERED,
    PENDING_INPUT_STATUS_PENDING_STEER,
)
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-steer",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


@pytest.mark.asyncio
async def test_pending_input_middleware_injects_all_steers_before_model(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    first, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-steer",
        message="补充第一条约束",
        mode=PENDING_INPUT_MODE_STEER,
        client_input_id="steer-1",
        runtime_params={
            "message_injection": [
                {
                    "type": "follow",
                    "role": "HumanMessage",
                    "content": "[引用片段]\nalpha.py:1",
                }
            ],
            "message_context_items": [
                {"label": "引用片段", "content": "alpha.py:1"},
            ]
        },
    )
    second, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-steer",
        message="补充第二条约束",
        mode=PENDING_INPUT_MODE_STEER,
        client_input_id="steer-2",
    )
    events: list[DomainEvent] = []

    async def collect(event: DomainEvent) -> None:
        events.append(event)

    token = set_request_context(
        session_id="ses-steer",
        active_session_id="ses-steer",
        trace_id="trace-steer",
        turn_index=7,
        user_id="local-user",
    )
    try:
        middleware = PendingUserInputInjectionMiddleware(
            repositories=repositories,
            dispatcher=EventDispatcher([collect]),
        )
        result = await middleware.abefore_model(
            {"messages": [HumanMessage(content="原始问题", id="human-1")]},
            runtime=None,
        )
    finally:
        reset_request_context(token)

    assert result is not None
    messages = result["messages"]
    assert isinstance(messages[0], RemoveMessage)
    assert messages[0].id == REMOVE_ALL_MESSAGES
    assert messages[1].content == "原始问题"
    assert [message.content for message in messages[2:]] == [
        "[引用片段]\nalpha.py:1",
        "补充第一条约束",
        "补充第二条约束",
    ]
    assert [
        message.additional_kwargs["keydex_pending_input_id"]
        for message in messages[2:]
    ] == [first.id, first.id, second.id]

    assert [event.event_type for event in events] == [
        DomainEventType.MESSAGE_USER_CREATED.value,
        DomainEventType.PENDING_INPUT_DELIVERED.value,
        DomainEventType.MESSAGE_USER_CREATED.value,
        DomainEventType.PENDING_INPUT_DELIVERED.value,
    ]
    assert [
        event.payload["pending_input"]["pending_input_id"]
        for event in events
        if event.event_type == DomainEventType.PENDING_INPUT_DELIVERED.value
    ] == [first.id, second.id]
    assert events[0].payload["content"] == "补充第一条约束"
    assert events[0].payload["contextItems"][0]["content"] == "alpha.py:1"

    persisted = [
        repositories.pending_inputs.get(first.id),
        repositories.pending_inputs.get(second.id),
    ]
    assert {record.status for record in persisted if record is not None} == {
        PENDING_INPUT_STATUS_DELIVERED
    }
    assert {record.target_turn_index for record in persisted if record is not None} == {7}
    assert {record.target_trace_id for record in persisted if record is not None} == {
        "trace-steer"
    }


@pytest.mark.asyncio
async def test_pending_input_middleware_keeps_images_and_skill_activation(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    image_path = tmp_path / "guide.png"
    image_path.write_bytes(
        b"\x89PNG\r\n\x1a\n" + b"pending-input-test"
    )
    attachment = repositories.attachments.create(
        attachment_id="att-steer",
        user_id="local-user",
        type="image",
        source="upload",
        name="guide.png",
        path=str(image_path),
        mime_type="image/png",
        size=image_path.stat().st_size,
    )
    record, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-steer",
        message="结合图片继续",
        mode=PENDING_INPUT_MODE_STEER,
        attachments=[{"attachment_id": attachment.id}],
        runtime_params={
            "skill_activation": {"skill_name": "review-skill", "source": "workspace"},
            "message_context_items": [
                {"type": "skill", "label": "/review-skill", "skill_name": "review-skill"},
            ],
        },
    )
    events: list[DomainEvent] = []

    async def collect(event: DomainEvent) -> None:
        events.append(event)

    token = set_request_context(
        session_id="ses-steer",
        active_session_id="ses-steer",
        trace_id="trace-image",
        turn_index=8,
        user_id="local-user",
    )
    try:
        middleware = PendingUserInputInjectionMiddleware(
            repositories=repositories,
            dispatcher=EventDispatcher([collect]),
        )
        result = await middleware.abefore_model({"messages": []}, runtime=None)
        preset = get_tool_call_preset()
    finally:
        reset_request_context(token)

    assert result is not None
    user_message = result["messages"][-1]
    assert user_message.content[0] == {"type": "text", "text": "结合图片继续"}
    assert user_message.content[1]["type"] == "image_url"
    assert user_message.content[1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert preset is not None
    assert preset.calls[0].name == "load_skill"
    assert preset.calls[0].args == {"skill_name": "review-skill"}
    user_event = next(
        event for event in events if event.event_type == DomainEventType.MESSAGE_USER_CREATED.value
    )
    assert user_event.payload["pending_input_id"] == record.id
    assert user_event.payload["attachments"][0]["attachment_id"] == attachment.id


@pytest.mark.asyncio
async def test_pending_input_middleware_skips_without_turn_context(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.pending_inputs.create_or_get(
        session_id="ses-steer",
        message="没有 turn_index 不能注入",
        mode=PENDING_INPUT_MODE_STEER,
    )
    token = set_request_context(session_id="ses-steer", trace_id="trace-no-turn")
    try:
        middleware = PendingUserInputInjectionMiddleware(
            repositories=repositories,
            dispatcher=EventDispatcher(),
        )
        result = await middleware.abefore_model(
            {"messages": [HumanMessage(content="原始问题")]},
            runtime=None,
        )
    finally:
        reset_request_context(token)

    assert result is None
    active_inputs = repositories.pending_inputs.list_active_by_session("ses-steer")
    assert active_inputs[0].status == PENDING_INPUT_STATUS_PENDING_STEER
