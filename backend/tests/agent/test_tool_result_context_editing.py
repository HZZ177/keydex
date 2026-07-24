from __future__ import annotations

from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage, ToolMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.agent.context_compression_segments import build_protocol_safe_units
from backend.app.agent.middleware.tool_result_context_editing import (
    ToolResultContextEditingMiddleware,
)
from backend.app.agent.state import build_checkpoint_state_graph
from backend.app.agent.tool_result_context_editing import (
    CONTEXT_EDITING_RECLAIM_THRESHOLD_TOKENS,
    TOOL_RESULT_TOMBSTONE_METADATA_KEY,
    is_tool_result_tombstone,
    select_tool_result_context_candidates,
    tombstone_tool_result,
)
from backend.app.agent.tool_results.artifact_repository import ToolResultArtifactRepository
from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools.base import ToolExecutionContext
from backend.tests.async_checkpoint import TestAsyncCheckpointStore


def _exchange(
    call_ids: list[str],
    *,
    token_sizes: list[int] | None = None,
    tool_name: str = "search_text",
):
    sizes = token_sizes or [1] * len(call_ids)
    return [
        AIMessage(
            content="",
            id=f"ai-{call_ids[0]}",
            tool_calls=[
                {"id": call_id, "name": tool_name, "args": {"query": call_id}}
                for call_id in call_ids
            ],
        ),
        *[
            ToolMessage(
                content="x" * (tokens * 4),
                tool_call_id=call_id,
                name=tool_name,
                id=f"tool-{call_id}",
            )
            for call_id, tokens in zip(call_ids, sizes, strict=True)
        ],
    ]


def _seen_history(token_sizes: list[int]):
    messages = []
    for index, size in enumerate(token_sizes):
        messages.extend(_exchange([f"call-{index}"], token_sizes=[size]))
    messages.append(AIMessage(content="results consumed", id="ai-seen"))
    return messages


def _repositories(tmp_path: Path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="user-1",
        scene_id="scene-1",
    )
    return repositories


def test_selector_protects_five_independent_results_in_parallel_batch() -> None:
    messages = [
        *_exchange(
            [f"call-{index}" for index in range(6)],
            token_sizes=[CONTEXT_EDITING_RECLAIM_THRESHOLD_TOKENS, 1, 1, 1, 1, 1],
        ),
        AIMessage(content="seen", id="ai-seen"),
    ]

    plan = select_tool_result_context_candidates(messages)

    assert [item.tool_call_id for item in plan.candidates] == ["call-0"]
    assert plan.protected_tool_call_ids == (
        "call-1",
        "call-2",
        "call-3",
        "call-4",
        "call-5",
    )


def test_selector_handles_fifty_parallel_results_as_independent_items() -> None:
    messages = [
        *_exchange(
            [f"call-{index}" for index in range(50)],
            token_sizes=[2_223] * 45 + [1] * 5,
        ),
        AIMessage(content="seen", id="ai-seen"),
    ]

    plan = select_tool_result_context_candidates(messages)

    assert len(plan.candidates) == 45
    assert plan.candidates[0].tool_call_id == "call-0"
    assert plan.candidates[-1].tool_call_id == "call-44"
    assert plan.protected_tool_call_ids == tuple(f"call-{index}" for index in range(45, 50))


@pytest.mark.parametrize(
    ("oldest_tokens", "expected"),
    [
        (99_999, []),
        (100_000, ["call-0"]),
    ],
)
def test_selector_uses_100k_reclaimable_token_boundary(
    oldest_tokens: int,
    expected: list[str],
) -> None:
    plan = select_tool_result_context_candidates(
        _seen_history([oldest_tokens, 1, 1, 1, 1, 1])
    )
    assert [item.tool_call_id for item in plan.candidates] == expected


def test_selector_excludes_unseen_error_mutation_and_existing_tombstone() -> None:
    history = _seen_history([100_000, 1, 1, 1, 1, 1])
    history[-1:-1] = [
        *_exchange(["mutation"], tool_name="edit_file"),
        ToolMessage(
            content="failed",
            tool_call_id="error-result",
            name="search_text",
            status="error",
        ),
    ]
    history.extend(_exchange(["trailing-unseen"], token_sizes=[100_000]))
    history[1] = history[1].model_copy(
        update={
            "additional_kwargs": {
                TOOL_RESULT_TOMBSTONE_METADATA_KEY: {
                    "version": "keydex.tool_result_tombstone.v1"
                }
            }
        }
    )

    plan = select_tool_result_context_candidates(history)

    assert "call-0" not in [item.tool_call_id for item in plan.candidates]
    assert "mutation" not in [item.tool_call_id for item in plan.candidates]
    assert "mutation" not in plan.protected_tool_call_ids
    assert "trailing-unseen" not in plan.protected_tool_call_ids


def test_malformed_unit_fails_open_without_blocking_later_valid_units() -> None:
    malformed = [
        AIMessage(
            content="",
            tool_calls=[
                {"id": "missing", "name": "search_text", "args": {}},
                {"id": "present", "name": "search_text", "args": {}},
            ],
        ),
        ToolMessage(content="x" * 400_000, tool_call_id="present", name="search_text"),
    ]
    valid = _seen_history([100_000, 1, 1, 1, 1, 1])

    plan = select_tool_result_context_candidates([*malformed, HumanMessage(content="next"), *valid])

    assert plan.invalid_protocol_units == 1
    assert "present" not in [item.tool_call_id for item in plan.candidates]
    assert [item.tool_call_id for item in plan.candidates] == ["call-0"]


def test_tombstone_persists_before_clear_and_preserves_protocol_fields(tmp_path: Path) -> None:
    repositories = _repositories(tmp_path)
    artifact_repository = ToolResultArtifactRepository(
        repositories=repositories,
        data_dir=tmp_path / "data",
    )
    context = ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=1,
        metadata={"tool_call_id": "call-1"},
    )
    original = ToolMessage(
        content="exact output 中😀",
        tool_call_id="call-1",
        name="search_text",
        status="success",
        id="message-1",
        artifact={"large": "runtime" * 100},
    )

    cleared = tombstone_tool_result(
        original,
        repository=artifact_repository,
        context=context,
    )
    repeated = tombstone_tool_result(
        cleared,
        repository=artifact_repository,
        context=context,
    )

    marker = cleared.additional_kwargs[TOOL_RESULT_TOMBSTONE_METADATA_KEY]
    record = repositories.tool_result_artifacts.get(marker["artifact_id"])
    assert record is not None
    persisted_content = (tmp_path / "data" / record.relative_path).read_text(
        encoding="utf-8"
    )
    assert persisted_content == original.content
    assert cleared.id == original.id
    assert cleared.name == original.name
    assert cleared.tool_call_id == original.tool_call_id
    assert cleared.status == original.status
    assert cleared.artifact is None
    assert is_tool_result_tombstone(cleared)
    assert repeated == cleared


@pytest.mark.asyncio
async def test_middleware_replaces_messages_without_orphaning_protocol(tmp_path: Path) -> None:
    repositories = _repositories(tmp_path)
    middleware = ToolResultContextEditingMiddleware(
        repositories=repositories,
        data_dir=tmp_path / "data",
    )
    messages = _seen_history([100_000, 1, 1, 1, 1, 1])
    token = set_request_context(
        session_id="session-1",
        active_session_id="session-1",
        user_id="user-1",
        turn_index=1,
    )
    try:
        result = await middleware.abefore_model({"messages": messages}, runtime=None)
    finally:
        reset_request_context(token)

    assert result is not None
    assert isinstance(result["messages"][0], RemoveMessage)
    assert result["messages"][0].id == REMOVE_ALL_MESSAGES
    replaced = result["messages"][2]
    assert isinstance(replaced, ToolMessage)
    assert is_tool_result_tombstone(replaced)
    assert select_tool_result_context_candidates(result["messages"][1:]).candidates == ()
    assert build_protocol_safe_units(result["messages"][1:]).valid is True


@pytest.mark.asyncio
async def test_middleware_partial_persist_failure_keeps_only_failed_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repositories = _repositories(tmp_path)
    middleware = ToolResultContextEditingMiddleware(
        repositories=repositories,
        data_dir=tmp_path / "data",
    )
    messages = _seen_history([50_000, 50_000, 1, 1, 1, 1, 1])
    original_ensure = middleware.artifacts.ensure_persisted

    def flaky_ensure(*args, **kwargs):
        if kwargs["context"].tool_call_id == "call-0":
            raise OSError("simulated persistence failure")
        return original_ensure(*args, **kwargs)

    monkeypatch.setattr(middleware.artifacts, "ensure_persisted", flaky_ensure)
    token = set_request_context(
        session_id="session-1",
        active_session_id="session-1",
        user_id="user-1",
        turn_index=1,
    )
    try:
        result = await middleware.abefore_model({"messages": messages}, runtime=None)
    finally:
        reset_request_context(token)

    assert result is not None
    updated = result["messages"][1:]
    by_call_id = {
        str(message.tool_call_id): message
        for message in updated
        if isinstance(message, ToolMessage)
    }
    assert is_tool_result_tombstone(by_call_id["call-0"]) is False
    assert is_tool_result_tombstone(by_call_id["call-1"]) is True
    assert build_protocol_safe_units(updated).valid is True


@pytest.mark.asyncio
async def test_tombstone_survives_checkpoint_restart_and_structured_replay_validation(
    tmp_path: Path,
) -> None:
    repositories = _repositories(tmp_path)
    middleware = ToolResultContextEditingMiddleware(
        repositories=repositories,
        data_dir=tmp_path / "data",
    )
    messages = _seen_history([100_000, 1, 1, 1, 1, 1])
    token = set_request_context(
        session_id="session-1",
        active_session_id="session-1",
        user_id="user-1",
        turn_index=1,
    )
    try:
        result = await middleware.abefore_model({"messages": messages}, runtime=None)
    finally:
        reset_request_context(token)
    assert result is not None
    updated = result["messages"][1:]

    checkpointer = TestAsyncCheckpointStore(repositories.db.path)
    graph = build_checkpoint_state_graph(checkpointer)
    config = {
        "configurable": {"thread_id": "session-1", "checkpoint_ns": ""}
    }
    await graph.ainvoke(
        {"messages": updated},
        config=config,
    )
    restored = await graph.aget_state(config)
    restored_messages = restored.values["messages"]
    restored_tombstones = [
        message
        for message in restored_messages
        if isinstance(message, ToolMessage) and is_tool_result_tombstone(message)
    ]
    assert len(restored_tombstones) == 1
    assert restored_tombstones[0].tool_call_id == "call-0"
    assert build_protocol_safe_units(restored_messages).valid is True
