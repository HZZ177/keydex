from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from backend.app.agent.exploration_guard import (
    ExplorationGuard,
    ExplorationGuardTurnMiddleware,
    classify_exploration_call,
    should_enable_exploration_guard,
)
from backend.app.agent.tool_results.continuations import issue_search_cursor
from backend.app.tools.base import FunctionTool, ToolExecutionContext


@pytest.mark.parametrize(
    ("has_role_preset", "agent_kind", "tool_names", "expected"),
    [
        (False, "main", {"search_text", "delegate_subagent"}, True),
        (False, "main", {"search_text"}, False),
        (True, "main", {"search_text", "delegate_subagent"}, False),
        (False, "explorer", {"search_text", "delegate_subagent"}, False),
        (False, "worker", {"search_text", "delegate_subagent"}, False),
    ],
)
def test_guard_enablement_requires_main_agent_with_real_delegate_tool(
    has_role_preset: bool,
    agent_kind: str,
    tool_names: set[str],
    expected: bool,
) -> None:
    assert should_enable_exploration_guard(
        has_role_preset=has_role_preset,
        agent_kind=agent_kind,
        tool_names=tool_names,
    ) is expected


@pytest.mark.parametrize(
    ("tool_name", "args", "kind", "reason"),
    [
        ("search_text", {"query": "needle"}, "wide_discovery", "workspace_root_search"),
        (
            "grep_files",
            {"query": "needle", "path": "backend"},
            "wide_discovery",
            "top_level_broad_search",
        ),
        (
            "search_text",
            {"query": "needle", "path": "backend/app"},
            "targeted",
            "bounded_subdirectory",
        ),
        (
            "search_text",
            {"query": "needle", "path": "backend/app/main.py"},
            "targeted",
            "explicit_file_target",
        ),
        (
            "search_files",
            {"query": "main.py"},
            "targeted",
            "explicit_file_target",
        ),
        (
            "list_dir",
            {"path": ".", "depth": 3},
            "wide_discovery",
            "deep_root_listing",
        ),
        (
            "list_dir",
            {"path": ".", "depth": 2},
            "targeted",
            "shallow_directory_listing",
        ),
        ("read_file", {"path": "README.md"}, "targeted", "non_discovery_tool"),
        (
            "read_tool_result",
            {"artifact_id": "tra-1"},
            "targeted",
            "non_discovery_tool",
        ),
    ],
)
def test_classifier_matrix(
    tmp_path: Path,
    tool_name: str,
    args: dict,
    kind: str,
    reason: str,
) -> None:
    classification = classify_exploration_call(
        tool_name,
        args,
        workspace_root=tmp_path,
    )
    assert classification.kind == kind
    assert classification.reason == reason


def test_classifier_verifies_search_cursor_and_rejects_tampering(tmp_path: Path) -> None:
    args = {"query": "needle", "path": ".", "limit": 20}
    cursor = issue_search_cursor(tool_name="search_text", args=args, offset=20)

    continued = classify_exploration_call(
        "search_text",
        {**args, "cursor": cursor},
        workspace_root=tmp_path,
    )
    tampered = classify_exploration_call(
        "search_text",
        {**args, "query": "different", "cursor": cursor},
        workspace_root=tmp_path,
    )

    assert continued.kind == "verified_continuation"
    assert continued.reason == "verified_search_cursor"
    assert tampered.kind == "wide_discovery"


def test_classifier_detects_cross_scope_discovery(tmp_path: Path) -> None:
    classification = classify_exploration_call(
        "search_text",
        {"query": "needle", "path": "frontend/src"},
        workspace_root=tmp_path,
        prior_top_scopes=frozenset({"backend"}),
    )
    assert classification.kind == "wide_discovery"
    assert classification.reason == "cross_scope_discovery"


def _context(tmp_path: Path, guard: ExplorationGuard, call_id: str) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace-1",
        active_session_id="session-1",
        metadata={"tool_call_id": call_id, "exploration_guard": guard},
    )


@pytest.mark.asyncio
async def test_parallel_six_wide_queries_execute_at_most_five_handlers(tmp_path: Path) -> None:
    guard = ExplorationGuard(workspace_root=tmp_path, enabled=True)
    guard.bind_turn([HumanMessage(content="investigate", id="human-1")], active_session_id="s")
    calls = 0

    async def handler(_args, _context):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0)
        return {"results": []}

    tool = FunctionTool(
        name="search_text",
        description="search",
        parameters={"type": "object", "properties": {}},
        handler=handler,
    )
    results = await asyncio.gather(
        *[
            tool.run(
                {"query": f"query-{index}", "path": "."},
                _context(tmp_path, guard, f"call-{index}"),
            )
            for index in range(6)
        ]
    )

    assert calls == 5
    assert sum(result.ok for result in results) == 5
    rejected = next(result for result in results if not result.ok)
    assert rejected.error["code"] == "explorer_delegation_required"
    assert rejected.error["details"]["suggested_tool"] == "delegate_subagent"


@pytest.mark.asyncio
async def test_cancelled_wide_query_releases_inflight_reservation(tmp_path: Path) -> None:
    guard = ExplorationGuard(workspace_root=tmp_path, enabled=True)
    guard.bind_turn([HumanMessage(content="investigate", id="human-1")], active_session_id="s")
    handler_started = asyncio.Event()
    release_handler = asyncio.Event()

    async def handler(_args, _context):
        handler_started.set()
        await release_handler.wait()
        return {"results": []}

    tool = FunctionTool(
        name="search_text",
        description="search",
        parameters={"type": "object", "properties": {}},
        handler=handler,
    )
    cancelled = asyncio.create_task(
        tool.run(
            {"query": "cancelled", "path": "."},
            _context(tmp_path, guard, "cancelled"),
        )
    )
    await handler_started.wait()
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled

    release_handler.set()
    accepted = [
        await tool.run(
            {"query": f"query-{index}", "path": "."},
            _context(tmp_path, guard, f"accepted-{index}"),
        )
        for index in range(5)
    ]
    rejected = await tool.run(
        {"query": "sixth", "path": "."},
        _context(tmp_path, guard, "rejected"),
    )
    assert all(result.ok for result in accepted)
    assert rejected.ok is False
    assert rejected.error["code"] == "explorer_delegation_required"


@pytest.mark.asyncio
async def test_sixth_query_can_continue_when_narrowed_and_new_human_resets(tmp_path: Path) -> None:
    guard = ExplorationGuard(workspace_root=tmp_path, enabled=True)
    guard.bind_turn([HumanMessage(content="first", id="human-1")], active_session_id="s")
    for index in range(5):
        reservation = await guard.before_tool(
            tool_name="search_text",
            args={"query": str(index), "path": "."},
            call_id=f"wide-{index}",
        )
        await guard.after_tool(
            reservation,
            tool_name="search_text",
            args={"query": str(index), "path": "."},
            result={"results": []},
        )

    narrowed = await guard.before_tool(
        tool_name="search_text",
        args={"query": "needle", "path": "backend/app"},
        call_id="narrowed",
    )
    assert narrowed is not None
    assert narrowed.classification.kind == "targeted"

    guard.bind_turn([HumanMessage(content="second", id="human-2")], active_session_id="s")
    reset = await guard.before_tool(
        tool_name="search_text",
        args={"query": "again", "path": "."},
        call_id="new-turn",
    )
    assert reset is not None and reset.counted is True


@pytest.mark.asyncio
async def test_list_dir_only_reuses_exact_next_offset(tmp_path: Path) -> None:
    guard = ExplorationGuard(workspace_root=tmp_path, enabled=True)
    args = {"path": ".", "depth": 3, "limit": 100, "offset": 0}
    first = await guard.before_tool(tool_name="list_dir", args=args, call_id="list-1")
    await guard.after_tool(
        first,
        tool_name="list_dir",
        args=args,
        result={"truncated": True, "next_offset": 100},
    )

    continued = await guard.before_tool(
        tool_name="list_dir",
        args={**args, "offset": 100},
        call_id="list-2",
    )
    changed = await guard.before_tool(
        tool_name="list_dir",
        args={**args, "limit": 50, "offset": 100},
        call_id="list-3",
    )

    assert continued is not None
    assert continued.classification.kind == "verified_continuation"
    assert changed is not None
    assert changed.classification.kind == "wide_discovery"


@pytest.mark.asyncio
async def test_turn_middleware_rebuilds_count_from_governance_history(tmp_path: Path) -> None:
    guard = ExplorationGuard(workspace_root=tmp_path, enabled=True)
    messages = [HumanMessage(content="investigate", id="human-1")]
    for index in range(5):
        call_id = f"call-{index}"
        messages.extend(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "id": call_id,
                            "name": "search_text",
                            "args": {"query": str(index), "path": "."},
                        }
                    ],
                ),
                ToolMessage(
                    content="{}",
                    tool_call_id=call_id,
                    name="search_text",
                    artifact={
                        "governance": {
                            "exploration": {
                                "kind": "wide_discovery",
                                "reason": "workspace_root_search",
                                "scope_key": ".",
                            }
                        }
                    },
                ),
            ]
        )
    await ExplorationGuardTurnMiddleware(guard).abefore_model(
        {"messages": messages},
        runtime=None,
    )

    with pytest.raises(Exception) as captured:
        await guard.before_tool(
            tool_name="search_text",
            args={"query": "sixth", "path": "."},
            call_id="call-6",
        )
    assert getattr(captured.value, "code", None) == "explorer_delegation_required"
