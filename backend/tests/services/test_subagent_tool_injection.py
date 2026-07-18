from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import pytest

from backend.app.agent.langchain_tools import local_tool_to_langchain_tool
from backend.app.core.config import AppSettings
from backend.app.services.chat_service import ChatService
from backend.app.storage import StorageRepositories, init_database
from backend.app.subagents.models import (
    SubagentHandle,
    SubagentRunSnapshot,
)
from backend.app.tools.base import ToolExecutionContext

NOW = datetime(2026, 7, 18, 12, 0, tzinfo=UTC)
_DEFAULT_RUNTIME = object()


class FakeWaitRuntime:
    def __init__(
        self,
        *,
        cancel_wait: bool = False,
        terminal_state: str = "completed",
    ) -> None:
        self.cancel_wait = cancel_wait
        self.terminal_state = terminal_state
        self.spawn_requests = []
        self.resume_requests = []
        self.waited_run_ids = []
        self.trace_cancellations = []

    async def spawn(self, request):
        self.spawn_requests.append(request)
        queued = SubagentRunSnapshot(
            run_id="run-1",
            subagent_id="subagent-1",
            child_session_id="child-1",
            parent_session_id=request.parent_session_id,
            parent_trace_id=request.parent_trace_id,
            parent_tool_call_id=request.parent_tool_call_id,
            parent_timeline_sequence=0,
            initiated_by=request.initiated_by,
            role=request.role,
            task=request.task,
            state="queued",
            version=1,
            created_at=NOW,
            queued_at=NOW,
            updated_at=NOW,
        )
        return SubagentHandle(
            subagent_id=queued.subagent_id,
            run_id=queued.run_id,
            child_session_id=queued.child_session_id,
            parent_session_id=queued.parent_session_id,
            role=queued.role,
            initial_snapshot=queued,
        )

    async def wait_terminal(self, run_id):
        self.waited_run_ids.append(run_id)
        await asyncio.sleep(0)
        if self.cancel_wait:
            raise asyncio.CancelledError
        terminal_payload = {
            "final_report": "final report" if self.terminal_state == "completed" else None,
            "error_code": "SUBAGENT_RUN_FAILED" if self.terminal_state == "failed" else None,
            "error_message": "child failed" if self.terminal_state == "failed" else None,
        }
        return SubagentRunSnapshot(
            run_id=run_id,
            subagent_id="subagent-1",
            child_session_id="child-1",
            parent_session_id="workspace-main",
            parent_trace_id="parent-trace",
            parent_tool_call_id="parent-tool-call",
            parent_timeline_sequence=0,
            initiated_by="main_agent",
            role="explorer",
            task="inspect",
            state=self.terminal_state,
            version=3,
            **terminal_payload,
            created_at=NOW,
            queued_at=NOW,
            started_at=NOW,
            finished_at=NOW,
            updated_at=NOW,
        )

    async def resume(self, subagent_id, task, **kwargs):
        self.resume_requests.append((subagent_id, task, kwargs))
        queued = SubagentRunSnapshot(
            run_id="run-continued",
            subagent_id=subagent_id,
            child_session_id="child-1",
            parent_session_id=kwargs["parent_session_id"],
            parent_trace_id=kwargs.get("parent_trace_id"),
            parent_tool_call_id=kwargs.get("parent_tool_call_id"),
            parent_timeline_sequence=1,
            initiated_by=kwargs["initiated_by"],
            role="explorer",
            task=task,
            state="queued",
            version=1,
            created_at=NOW,
            queued_at=NOW,
            updated_at=NOW,
        )
        return SubagentHandle(
            subagent_id=queued.subagent_id,
            run_id=queued.run_id,
            child_session_id=queued.child_session_id,
            parent_session_id=queued.parent_session_id,
            role=queued.role,
            initial_snapshot=queued,
        )

    async def cancel_by_parent_trace(self, parent_session_id, parent_trace_id, *, reason=None):
        self.trace_cancellations.append((parent_session_id, parent_trace_id, reason))
        return []


class OutOfOrderRuntime:
    def __init__(self) -> None:
        self.requests_by_run = {}
        self.completion_order = []
        self.second_finished = asyncio.Event()

    async def spawn(self, request):
        suffix = request.parent_tool_call_id.rsplit("-", 1)[-1]
        run_id = f"run-{suffix}"
        child_session_id = f"child-{suffix}"
        self.requests_by_run[run_id] = request
        queued = SubagentRunSnapshot(
            run_id=run_id,
            subagent_id=f"subagent-{suffix}",
            child_session_id=child_session_id,
            parent_session_id=request.parent_session_id,
            parent_trace_id=request.parent_trace_id,
            parent_tool_call_id=request.parent_tool_call_id,
            parent_timeline_sequence=len(self.requests_by_run) - 1,
            initiated_by=request.initiated_by,
            role=request.role,
            task=request.task,
            state="queued",
            version=1,
            created_at=NOW,
            queued_at=NOW,
            updated_at=NOW,
        )
        return SubagentHandle(
            subagent_id=queued.subagent_id,
            run_id=run_id,
            child_session_id=child_session_id,
            parent_session_id=queued.parent_session_id,
            role=queued.role,
            initial_snapshot=queued,
        )

    async def wait_terminal(self, run_id):
        if run_id == "run-a":
            await self.second_finished.wait()
        else:
            self.second_finished.set()
        self.completion_order.append(run_id)
        request = self.requests_by_run[run_id]
        suffix = run_id.rsplit("-", 1)[-1]
        return SubagentRunSnapshot(
            run_id=run_id,
            subagent_id=f"subagent-{suffix}",
            child_session_id=f"child-{suffix}",
            parent_session_id=request.parent_session_id,
            parent_trace_id=request.parent_trace_id,
            parent_tool_call_id=request.parent_tool_call_id,
            parent_timeline_sequence=0 if suffix == "a" else 1,
            initiated_by=request.initiated_by,
            role=request.role,
            task=request.task,
            state="completed",
            version=3,
            final_report=f"report-for-{request.parent_tool_call_id}",
            created_at=NOW,
            queued_at=NOW,
            started_at=NOW,
            finished_at=NOW,
            updated_at=NOW,
        )


def _service(tmp_path, *, runtime=_DEFAULT_RUNTIME):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    service = ChatService(
        settings=AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        repositories=repositories,
        agent_runner=object(),  # type: ignore[arg-type]
        subagent_runtime_provider=lambda: runtime,
    )
    return service, repositories


def test_delegate_tool_is_injected_only_for_visible_workspace_main_session(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    parent = repositories.sessions.create(
        session_id="workspace-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    chat = repositories.sessions.create(
        session_id="chat-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="chat",
    )
    child = repositories.sessions.create(
        session_id="workspace-child",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        session_tag="subagent",
        visibility="internal",
        agent_kind="subagent",
        subagent_id="subagent-1",
        subagent_role="worker",
        parent_session_id=parent.id,
    )

    parent_tools = service._build_subagent_runtime_tools(session=parent)
    chat_tools = service._build_subagent_runtime_tools(session=chat)
    child_tools = service._build_subagent_runtime_tools(session=child)

    assert [tool.name for tool in parent_tools] == [
        "delegate_subagent",
        "continue_subagent",
    ]
    assert chat_tools == []
    assert child_tools == []


def test_delegate_tool_is_not_injected_without_bound_runtime(tmp_path) -> None:
    service, repositories = _service(tmp_path, runtime=None)
    parent = repositories.sessions.create(
        session_id="workspace-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )

    assert service._build_subagent_runtime_tools(session=parent) == []


def _tool_context(
    tmp_path,
    *,
    agent_kind: str = "main",
    tool_call_id: str | None = "parent-tool-call",
):
    metadata = {"agent_kind": agent_kind}
    if tool_call_id is not None:
        metadata["tool_call_id"] = tool_call_id
    return ToolExecutionContext(
        session_id="workspace-main",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="parent-trace",
        metadata=metadata,
    )


def test_wait_policy_spawns_then_waits_by_run_state_without_blocking_event_loop(tmp_path) -> None:
    runtime = FakeWaitRuntime()
    service, repositories = _service(tmp_path, runtime=runtime)
    parent = repositories.sessions.create(
        session_id="workspace-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    tool = service._build_subagent_runtime_tools(session=parent)[0]

    async def scenario():
        ticked = asyncio.Event()

        async def ticker():
            await asyncio.sleep(0)
            ticked.set()

        ticker_task = asyncio.create_task(ticker())
        result = await tool.run(
            {"type": "explorer", "task": "inspect"},
            _tool_context(tmp_path),
        )
        await ticker_task
        return result, ticked.is_set()

    result, ticked = asyncio.run(scenario())

    assert result.ok is True
    assert result.result["state"] == "completed"
    assert result.result["final_report"] == "final report"
    assert ticked is True
    assert len(runtime.spawn_requests) == 1
    assert runtime.spawn_requests[0].parent_tool_call_id == "parent-tool-call"
    assert runtime.waited_run_ids == ["run-1"]


def test_main_agent_can_continue_existing_subagent_with_current_parent_anchor(tmp_path) -> None:
    runtime = FakeWaitRuntime()
    service, repositories = _service(tmp_path, runtime=runtime)
    parent = repositories.sessions.create(
        session_id="workspace-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    tool = service._build_subagent_runtime_tools(session=parent)[1]

    result = asyncio.run(
        tool.run(
            {"subagent_id": "subagent-1", "task": "continue the investigation"},
            _tool_context(tmp_path, tool_call_id="continue-call-1"),
        )
    )

    assert result.ok is True
    assert result.result["state"] == "completed"
    assert runtime.spawn_requests == []
    assert runtime.waited_run_ids == ["run-continued"]
    subagent_id, task, kwargs = runtime.resume_requests[0]
    assert subagent_id == "subagent-1"
    assert task == "continue the investigation"
    assert kwargs == {
        "initiated_by": "main_agent",
        "parent_session_id": "workspace-main",
        "parent_trace_id": "parent-trace",
        "parent_tool_call_id": "continue-call-1",
    }


@pytest.mark.parametrize(
    ("context", "expected_code"),
    [
        ({"agent_kind": "subagent", "tool_call_id": "forged"}, "ROLE_TOOL_POLICY_VIOLATION"),
        ({"agent_kind": "main"}, "SUBAGENT_PARENT_INVALID"),
    ],
)
def test_continue_tool_rejects_forged_caller_and_missing_parent_tool_call(
    tmp_path,
    context,
    expected_code,
) -> None:
    runtime = FakeWaitRuntime()
    service, repositories = _service(tmp_path, runtime=runtime)
    parent = repositories.sessions.create(
        session_id="workspace-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    tool = service._build_subagent_runtime_tools(session=parent)[1]
    tool_context = ToolExecutionContext(
        session_id=parent.id,
        user_id=parent.user_id,
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="parent-trace",
        metadata=context,
    )

    result = asyncio.run(
        tool.run(
            {"subagent_id": "subagent-1", "task": "continue"},
            tool_context,
        )
    )

    assert result.ok is False
    assert result.error is not None and result.error["code"] == expected_code
    assert runtime.resume_requests == []


@pytest.mark.parametrize(
    ("context", "expected_code"),
    [
        ({"agent_kind": "subagent", "tool_call_id": "forged"}, "ROLE_TOOL_POLICY_VIOLATION"),
        ({"agent_kind": "main"}, "SUBAGENT_PARENT_INVALID"),
    ],
)
def test_wait_policy_rejects_forged_caller_and_missing_parent_tool_call(
    tmp_path,
    context,
    expected_code,
) -> None:
    runtime = FakeWaitRuntime()
    service, repositories = _service(tmp_path, runtime=runtime)
    parent = repositories.sessions.create(
        session_id="workspace-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    tool = service._build_subagent_runtime_tools(session=parent)[0]
    tool_context = ToolExecutionContext(
        session_id=parent.id,
        user_id=parent.user_id,
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="parent-trace",
        metadata=context,
    )

    result = asyncio.run(tool.run({"type": "worker", "task": "work"}, tool_context))

    assert result.ok is False
    assert result.error is not None and result.error["code"] == expected_code
    assert runtime.spawn_requests == []


def test_wait_policy_parent_cancellation_explicitly_cascades_current_trace(tmp_path) -> None:
    runtime = FakeWaitRuntime(cancel_wait=True)
    service, repositories = _service(tmp_path, runtime=runtime)
    parent = repositories.sessions.create(
        session_id="workspace-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    tool = service._build_subagent_runtime_tools(session=parent)[0]

    async def scenario():
        with pytest.raises(asyncio.CancelledError):
            await tool.run(
                {"type": "explorer", "task": "inspect"},
                _tool_context(tmp_path),
            )

    asyncio.run(scenario())

    assert runtime.trace_cancellations == [
        ("workspace-main", "parent-trace", "parent_delegate_tool_cancelled")
    ]


@pytest.mark.parametrize(
    ("state", "expected_code", "retryable"),
    [
        ("failed", "SUBAGENT_RUN_FAILED", True),
        ("cancelled", "SUBAGENT_CANCELLED", False),
        ("interrupted", "SUBAGENT_INTERRUPTED", True),
    ],
)
def test_wait_policy_returns_structured_non_success_terminal_result(
    tmp_path,
    state,
    expected_code,
    retryable,
) -> None:
    runtime = FakeWaitRuntime(terminal_state=state)
    service, repositories = _service(tmp_path, runtime=runtime)
    parent = repositories.sessions.create(
        session_id="workspace-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    tool = service._build_subagent_runtime_tools(session=parent)[0]

    result = asyncio.run(
        tool.run(
            {"type": "explorer", "task": "inspect"},
            _tool_context(tmp_path),
        )
    )

    assert result.ok is True
    assert result.result["ok"] is False
    assert result.result["state"] == state
    assert result.result["error"] == {
        "code": expected_code,
        "message": (
            "child failed"
            if state == "failed"
            else (
                "Sub-Agent execution was cancelled"
                if state == "cancelled"
                else "Sub-Agent execution was interrupted and may be resumed"
            )
        ),
        "retryable": retryable,
    }


def test_parallel_delegate_calls_keep_tool_call_run_and_report_correlation(tmp_path) -> None:
    runtime = OutOfOrderRuntime()
    service, repositories = _service(tmp_path, runtime=runtime)
    parent = repositories.sessions.create(
        session_id="workspace-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    local_tool = service._build_subagent_runtime_tools(session=parent)[0]
    langchain_tool = local_tool_to_langchain_tool(
        local_tool,
        context_factory=lambda: _tool_context(tmp_path, tool_call_id=None),
    )

    async def scenario():
        return await asyncio.gather(
            langchain_tool.ainvoke(
                {"type": "explorer", "task": "first"},
                config={"configurable": {"tool_call_id": "call-a"}},
            ),
            langchain_tool.ainvoke(
                {"type": "worker", "task": "second"},
                config={"configurable": {"tool_call_id": "call-b"}},
            ),
        )

    first_raw, second_raw = asyncio.run(scenario())
    first = json.loads(first_raw)
    second = json.loads(second_raw)

    assert runtime.completion_order == ["run-b", "run-a"]
    assert runtime.requests_by_run["run-a"].parent_tool_call_id == "call-a"
    assert runtime.requests_by_run["run-b"].parent_tool_call_id == "call-b"
    assert (first["run_id"], first["final_report"]) == (
        "run-a",
        "report-for-call-a",
    )
    assert (second["run_id"], second["final_report"]) == (
        "run-b",
        "report-for-call-b",
    )


def test_delegate_tool_injects_parent_id_from_real_langchain_tool_call(tmp_path) -> None:
    runtime = FakeWaitRuntime()
    service, repositories = _service(tmp_path, runtime=runtime)
    parent = repositories.sessions.create(
        session_id="workspace-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    local_tool = service._build_subagent_runtime_tools(session=parent)[0]
    langchain_tool = local_tool_to_langchain_tool(
        local_tool,
        context_factory=lambda: _tool_context(tmp_path, tool_call_id=None),
    )

    tool_message = asyncio.run(
        langchain_tool.ainvoke(
            {
                "type": "tool_call",
                "id": "call-from-model",
                "name": "delegate_subagent",
                "args": {"type": "explorer", "task": "inspect"},
            }
        )
    )

    payload = json.loads(tool_message.content)
    assert tool_message.tool_call_id == "call-from-model"
    assert payload["state"] == "completed"
    assert runtime.spawn_requests[0].parent_tool_call_id == "call-from-model"


def test_continue_tool_injects_parent_id_from_real_langchain_tool_call(tmp_path) -> None:
    runtime = FakeWaitRuntime()
    service, repositories = _service(tmp_path, runtime=runtime)
    parent = repositories.sessions.create(
        session_id="workspace-main",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    local_tool = service._build_subagent_runtime_tools(session=parent)[1]
    langchain_tool = local_tool_to_langchain_tool(
        local_tool,
        context_factory=lambda: _tool_context(tmp_path, tool_call_id=None),
    )

    tool_message = asyncio.run(
        langchain_tool.ainvoke(
            {
                "type": "tool_call",
                "id": "continue-call-from-model",
                "name": "continue_subagent",
                "args": {"subagent_id": "subagent-1", "task": "continue"},
            }
        )
    )

    payload = json.loads(tool_message.content)
    assert tool_message.tool_call_id == "continue-call-from-model"
    assert payload["state"] == "completed"
    assert runtime.resume_requests[0][2]["parent_tool_call_id"] == "continue-call-from-model"
