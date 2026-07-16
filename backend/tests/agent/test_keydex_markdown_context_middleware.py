from __future__ import annotations

from pathlib import Path

import pytest
from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from backend.app.agent.keydex_markdown_context_middleware import (
    KeydexMarkdownContextMiddleware,
    is_keydex_markdown_context_message,
)
from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.keydex.capabilities.keydex_markdown import (
    KEYDEX_MARKDOWN_CONTEXT_PROTOCOL,
)
from backend.app.keydex.runtime_cache import KeydexCapabilityRuntimeCache


def _snapshot(tmp_path: Path, *, system: str = "", workspace: str = ""):
    builtin_root = tmp_path / "builtin"
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    builtin_root.mkdir()
    system_root.mkdir()
    workspace_root.mkdir()
    if system:
        (system_root / "keydex.md").write_text(system, encoding="utf-8")
    if workspace:
        keydex_root = workspace_root / ".keydex"
        keydex_root.mkdir()
        (keydex_root / "keydex.md").write_text(workspace, encoding="utf-8")
    cache = KeydexCapabilityRuntimeCache(
        builtin_root=builtin_root,
        system_root=system_root,
    )
    return (
        cache.get_workspace_snapshot(workspace_root) if workspace else cache.get_system_snapshot()
    )


@pytest.mark.asyncio
async def test_km20_no_snapshot_is_a_true_noop() -> None:
    middleware = KeydexMarkdownContextMiddleware()
    request = ModelRequest(
        model=object(),
        messages=[HumanMessage(content="real request")],
        tools=[],
        state={},
    )
    captured = []

    async def handler(value: ModelRequest) -> AIMessage:
        captured.append(value)
        return AIMessage(content="ok")

    await middleware.awrap_model_call(request, handler)

    assert captured == [request]


@pytest.mark.asyncio
async def test_km20_empty_effective_documents_are_a_true_noop(tmp_path: Path) -> None:
    snapshot = _snapshot(tmp_path)
    token = set_request_context(keydex_snapshot=snapshot)
    middleware = KeydexMarkdownContextMiddleware()
    request = ModelRequest(model=object(), messages=[], tools=[], state={})
    captured = []

    async def handler(value: ModelRequest) -> AIMessage:
        captured.append(value)
        return AIMessage(content="ok")

    try:
        await middleware.awrap_model_call(request, handler)
    finally:
        reset_request_context(token)

    assert captured == [request]


@pytest.mark.asyncio
async def test_km21_inserts_after_all_leading_system_messages(tmp_path: Path) -> None:
    snapshot = _snapshot(tmp_path, system="system guidance")
    token = set_request_context(keydex_snapshot=snapshot)
    middleware = KeydexMarkdownContextMiddleware()
    messages = [
        SystemMessage(content="summary one"),
        SystemMessage(content="summary two"),
        HumanMessage(content="first real user"),
        AIMessage(content="history"),
        HumanMessage(content="latest real user"),
    ]
    request = ModelRequest(
        model=object(),
        system_message=SystemMessage(content="agent system prompt"),
        messages=messages,
        tools=[],
        state={"messages": messages, "checkpoint_marker": "stable"},
    )
    captured = []

    async def handler(value: ModelRequest) -> AIMessage:
        captured.append(value)
        return AIMessage(content="ok")

    try:
        await middleware.awrap_model_call(request, handler)
    finally:
        reset_request_context(token)

    model_request = captured[0]
    assert [message.content for message in model_request.messages[:2]] == [
        "summary one",
        "summary two",
    ]
    assert is_keydex_markdown_context_message(model_request.messages[2])
    assert model_request.messages[3:] == messages[2:]
    assert model_request.messages[-1].content == "latest real user"
    assert model_request.system_message is request.system_message


@pytest.mark.asyncio
async def test_km22_injected_message_has_only_safe_protocol_metadata(
    tmp_path: Path,
) -> None:
    snapshot = _snapshot(
        tmp_path,
        system="broad guidance",
        workspace="specific guidance",
    )
    token = set_request_context(keydex_snapshot=snapshot)
    middleware = KeydexMarkdownContextMiddleware()
    request = ModelRequest(
        model=object(),
        messages=[HumanMessage(content="real request")],
        tools=[],
        state={},
    )
    captured = []

    async def handler(value: ModelRequest) -> AIMessage:
        captured.append(value)
        return AIMessage(content="ok")

    try:
        await middleware.awrap_model_call(request, handler)
    finally:
        reset_request_context(token)

    injected = captured[0].messages[0]
    assert isinstance(injected, HumanMessage)
    assert injected.additional_kwargs == {
        "protocol": KEYDEX_MARKDOWN_CONTEXT_PROTOCOL,
        "effective_fingerprint": snapshot.capabilities["keydex_markdown"].fingerprint,
        "scopes": ["system", "workspace"],
    }
    metadata = str(injected.additional_kwargs)
    assert "broad guidance" not in metadata
    assert "specific guidance" not in metadata
    assert str(tmp_path) not in metadata


@pytest.mark.asyncio
async def test_km23_request_state_and_original_messages_are_never_mutated(
    tmp_path: Path,
) -> None:
    snapshot = _snapshot(tmp_path, system="guidance")
    token = set_request_context(keydex_snapshot=snapshot)
    middleware = KeydexMarkdownContextMiddleware()
    messages = [HumanMessage(content="persisted user")]
    state = {"messages": messages, "checkpoint_marker": "stable"}
    request = ModelRequest(model=object(), messages=messages, tools=[], state=state)
    captured = []

    async def handler(value: ModelRequest) -> AIMessage:
        captured.append(value)
        return AIMessage(content="ok")

    try:
        await middleware.awrap_model_call(request, handler)
    finally:
        reset_request_context(token)

    assert request.messages == messages
    assert state == {"messages": messages, "checkpoint_marker": "stable"}
    assert captured[0].state is state
    assert all(not is_keydex_markdown_context_message(item) for item in state["messages"])


@pytest.mark.asyncio
async def test_km24_rewrapping_the_same_request_keeps_exactly_one_context(
    tmp_path: Path,
) -> None:
    snapshot = _snapshot(tmp_path, system="guidance")
    token = set_request_context(keydex_snapshot=snapshot)
    middleware = KeydexMarkdownContextMiddleware()
    request = ModelRequest(
        model=object(),
        messages=[HumanMessage(content="real request")],
        tools=[],
        state={},
    )
    captured = []

    async def first_handler(value: ModelRequest) -> AIMessage:
        captured.append(value)
        return AIMessage(content="ok")

    async def second_handler(value: ModelRequest) -> AIMessage:
        captured.append(value)
        return AIMessage(content="ok")

    try:
        await middleware.awrap_model_call(request, first_handler)
        await middleware.awrap_model_call(captured[0], second_handler)
    finally:
        reset_request_context(token)

    for model_request in captured:
        assert (
            sum(is_keydex_markdown_context_message(message) for message in model_request.messages)
            == 1
        )
        assert model_request.messages[-1].content == "real request"


@pytest.mark.asyncio
async def test_km26_compressed_summary_keeps_context_before_real_history(
    tmp_path: Path,
) -> None:
    snapshot = _snapshot(tmp_path, system="compressed guidance")
    token = set_request_context(keydex_snapshot=snapshot)
    middleware = KeydexMarkdownContextMiddleware()
    request = ModelRequest(
        model=object(),
        messages=[
            SystemMessage(content="compressed conversation summary"),
            HumanMessage(content="latest real request"),
        ],
        tools=[],
        state={},
    )
    captured = []

    async def handler(value: ModelRequest) -> AIMessage:
        captured.append(value)
        return AIMessage(content="ok")

    try:
        await middleware.awrap_model_call(request, handler)
    finally:
        reset_request_context(token)

    assert captured[0].messages[0].content == "compressed conversation summary"
    assert is_keydex_markdown_context_message(captured[0].messages[1])
    assert captured[0].messages[2].content == "latest real request"


@pytest.mark.asyncio
async def test_km27_skill_activation_and_markdown_context_coexist_once(
    tmp_path: Path,
) -> None:
    snapshot = _snapshot(tmp_path, system="workspace guidance")
    token = set_request_context(keydex_snapshot=snapshot)
    middleware = KeydexMarkdownContextMiddleware()
    request = ModelRequest(
        model=object(),
        messages=[
            HumanMessage(content="real request"),
            SystemMessage(content="activated SKILL.md body"),
        ],
        tools=[],
        state={},
    )
    captured = []

    async def handler(value: ModelRequest) -> AIMessage:
        captured.append(value)
        return AIMessage(content="ok")

    try:
        await middleware.awrap_model_call(request, handler)
    finally:
        reset_request_context(token)

    messages = captured[0].messages
    assert sum(is_keydex_markdown_context_message(item) for item in messages) == 1
    assert [item.content for item in messages[1:]] == [
        "real request",
        "activated SKILL.md body",
    ]


@pytest.mark.asyncio
async def test_km28_rebuilt_model_request_uses_the_same_frozen_turn_snapshot(
    tmp_path: Path,
) -> None:
    source = tmp_path / "system" / "keydex.md"
    snapshot = _snapshot(tmp_path, system="GUIDANCE-V1")
    token = set_request_context(keydex_snapshot=snapshot)
    middleware = KeydexMarkdownContextMiddleware()
    captured = []

    async def handler(value: ModelRequest) -> AIMessage:
        captured.append(value)
        return AIMessage(content="ok")

    try:
        await middleware.awrap_model_call(
            ModelRequest(
                model=object(),
                messages=[HumanMessage(content="initial call")],
                tools=[],
                state={},
            ),
            handler,
        )
        source.write_text("GUIDANCE-V2", encoding="utf-8")
        await middleware.awrap_model_call(
            ModelRequest(
                model=object(),
                messages=[HumanMessage(content="rebuilt continuation")],
                tools=[],
                state={},
            ),
            handler,
        )
    finally:
        reset_request_context(token)

    assert len(captured) == 2
    for request in captured:
        context = next(
            item for item in request.messages if is_keydex_markdown_context_message(item)
        )
        assert "GUIDANCE-V1" in str(context.content)
        assert "GUIDANCE-V2" not in str(context.content)
