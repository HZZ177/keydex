from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from backend.app.services.chat_service import ChatService
from backend.app.services.chat_stream_manager import ChatStreamManager
from backend.app.services.chat_types import ChatRequest, ChatTurnResult
from backend.app.storage import StorageRepositories, init_database
from backend.app.subagents.errors import SubagentError, SubagentErrorCode
from backend.app.subagents.models import SubagentRunSnapshot, SubagentSpawnRequest
from backend.app.subagents.runtime import (
    SessionBackedSubagentRuntime,
    SubagentWaitCancellationToken,
)

NOW = datetime(2026, 7, 18, 9, 0, tzinfo=UTC)


class SchedulingChatManager:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.requests = []
        self.child_release = asyncio.Event()
        self.child_tasks: list[asyncio.Task[None]] = []

    async def start_chat(self, request) -> str:
        self.requests.append(request)
        if self.fail:
            raise RuntimeError("scheduler unavailable")

        async def child_execution() -> None:
            await self.child_release.wait()

        self.child_tasks.append(asyncio.create_task(child_execution()))
        return request.session_id

    async def finish(self) -> None:
        self.child_release.set()
        if self.child_tasks:
            await asyncio.gather(*self.child_tasks)


class CountingCancelManager(SchedulingChatManager):
    def __init__(self) -> None:
        super().__init__()
        self.cancel_calls: list[str] = []

    async def cancel(self, session_id: str) -> bool:
        self.cancel_calls.append(session_id)
        return True


class CompletingChatService:
    def __init__(self, mode: str) -> None:
        self.mode = mode

    async def handle_chat(self, request, *, chat_adapter, cancellation):
        await asyncio.sleep(0)
        if self.mode == "error":
            raise RuntimeError("child execution failed")
        return ChatTurnResult(
            session_id=request.session_id or "",
            trace_id=f"child-trace-{self.mode}",
            turn_index=1,
            status=self.mode,
            final_content="final report" if self.mode == "completed" else "",
        )


class ControlledChatService:
    def __init__(self, repositories) -> None:
        self.repositories = repositories
        self.started: dict[str, asyncio.Event] = {}
        self.release: dict[str, asyncio.Event] = {}

    async def handle_chat(self, request, *, chat_adapter, cancellation):
        session_id = request.session_id or ""
        self.started.setdefault(session_id, asyncio.Event()).set()
        release = self.release.setdefault(session_id, asyncio.Event())
        await release.wait()
        return ChatTurnResult(
            session_id=session_id,
            trace_id=f"child-trace-{session_id}",
            turn_index=1,
            status="completed",
            final_content=f"done:{session_id}",
        )


def _setup(tmp_path):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    root = tmp_path / "workspace"
    root.mkdir()
    workspace = repositories.workspaces.create(
        workspace_id="workspace-1",
        root_path=root,
        name="Fixture workspace",
    )
    parent = repositories.sessions.create(
        session_id="parent-1",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(root),
        workspace_roots=[str(root)],
        current_model_provider_id="provider-1",
        current_model="model-1",
    )
    return repositories, parent


def _request(**overrides) -> SubagentSpawnRequest:
    payload = {
        "parent_session_id": "parent-1",
        "parent_trace_id": "trace-1",
        "parent_tool_call_id": "tool-call-1",
        "user_id": "local-user",
        "role": "explorer",
        "task": "Inspect the storage boundary",
    }
    payload.update(overrides)
    return SubagentSpawnRequest.model_validate(payload)


def _runtime(repositories, manager, *, publisher=None):
    ids = iter(str(index) for index in range(1, 100))
    return SessionBackedSubagentRuntime(
        repositories=repositories,
        chat_stream_manager=manager,
        event_publisher=publisher,
        id_factory=lambda: next(ids),
        clock=lambda: NOW,
    )


def _persist_terminal_instance(repositories, parent, state: str):
    child = repositories.sessions.create(
        session_id=f"terminal-child-{state}",
        user_id=parent.user_id,
        scene_id=parent.scene_id,
        session_type="workspace",
        session_tag="subagent",
        parent_session_id=parent.id,
        visibility="internal",
        agent_kind="subagent",
        subagent_id=f"terminal-subagent-{state}",
        subagent_role="worker",
        workspace_id=parent.workspace_id,
        cwd=parent.cwd,
        workspace_roots=list(parent.workspace_roots),
        current_model_provider_id=parent.current_model_provider_id,
        current_model=parent.current_model,
    )
    payload = {
        "run_id": f"terminal-run-{state}",
        "subagent_id": child.subagent_id,
        "child_session_id": child.id,
        "parent_session_id": parent.id,
        "parent_trace_id": "old-parent-trace",
        "parent_tool_call_id": "old-parent-tool",
        "parent_timeline_sequence": 0,
        "initiated_by": "main_agent",
        "role": "worker",
        "task": "old task",
        "state": state,
        "version": 2,
        "created_at": NOW,
        "queued_at": NOW,
        "started_at": NOW,
        "finished_at": NOW,
        "updated_at": NOW,
    }
    if state == "completed":
        payload["final_report"] = "old final report"
    elif state == "failed":
        payload.update(error_code="OLD_FAILURE", error_message="old failure")
    old_run = SubagentRunSnapshot.model_validate(payload)
    repositories.subagent_runs.create(old_run)
    return child, old_run


def test_spawn_persists_hidden_child_and_queued_run_before_scheduling(tmp_path) -> None:
    repositories, parent = _setup(tmp_path)
    manager = SchedulingChatManager()
    published = []

    def publisher(snapshot) -> None:
        assert repositories.subagent_runs.get(snapshot.run_id) is not None
        assert (
            repositories.sessions.get(snapshot.child_session_id, include_internal=True)
            is not None
        )
        published.append(snapshot)

    runtime = _runtime(repositories, manager, publisher=publisher)

    async def scenario():
        handle = await runtime.spawn(_request())
        assert manager.child_tasks[0].done() is False
        await manager.finish()
        return handle

    handle = asyncio.run(scenario())

    assert handle.subagent_id == "subagent-1"
    assert handle.child_session_id == "subagent-session-2"
    assert handle.run_id == "subagent-run-3"
    assert handle.initial_snapshot.state.value == "queued"
    assert handle.initial_snapshot.parent_timeline_sequence == 0
    assert [snapshot.state.value for snapshot in published] == ["queued", "running"]
    assert published[0] == handle.initial_snapshot
    assert repositories.sessions.get(handle.child_session_id) is None
    child = repositories.sessions.get(handle.child_session_id, include_internal=True)
    assert child is not None
    assert child.parent_session_id == parent.id
    assert child.visibility == "internal"
    assert child.agent_kind == "subagent"
    assert child.subagent_role == "explorer"
    assert child.workspace_id == parent.workspace_id
    assert child.current_model == parent.current_model
    assert len(manager.requests) == 1
    scheduled = manager.requests[0]
    assert scheduled.message == "Inspect the storage boundary"
    assert scheduled.session_id == handle.child_session_id
    assert scheduled.subagent_run_id == handle.run_id
    assert scheduled.subagent_parent_session_id == parent.id


@pytest.mark.parametrize(
    "roles",
    [
        pytest.param(("explorer", "explorer"), id="FT-RT-003-parallel-explorers"),
        pytest.param(("worker", "worker"), id="FT-RT-004-parallel-workers"),
        pytest.param(("explorer", "worker"), id="FT-RT-005-mixed-roles"),
    ],
)
def test_spawn_parallel_role_matrix_is_independent(tmp_path, roles: tuple[str, str]) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        handles = await asyncio.gather(
            *(
                runtime.spawn(_request(role=role, task=f"task-{index}"))
                for index, role in enumerate(roles)
            )
        )
        snapshots = [await runtime.get_run(handle.run_id) for handle in handles]
        await manager.finish()
        return handles, snapshots

    handles, snapshots = asyncio.run(scenario())
    assert len({handle.subagent_id for handle in handles}) == 2
    assert len({handle.child_session_id for handle in handles}) == 2
    assert [snapshot.role.value for snapshot in snapshots] == list(roles)
    assert {snapshot.parent_timeline_sequence for snapshot in snapshots} == {0, 1}


def test_ft_rt_009_publish_failure_keeps_durable_snapshot_queryable(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()

    def failing_publisher(_snapshot) -> None:
        raise RuntimeError("injected event transport failure")

    runtime = _runtime(repositories, manager, publisher=failing_publisher)

    async def scenario():
        handle = await runtime.spawn(_request())
        durable = await runtime.get_run(handle.run_id)
        await manager.finish()
        return handle, durable

    handle, durable = asyncio.run(scenario())
    assert durable.run_id == handle.run_id
    assert durable.state.value == "running"
    assert repositories.subagent_runs.get(handle.run_id) is not None


@pytest.mark.parametrize(
    ("mode", "expected_state", "expected_error_code"),
    [
        ("completed", "completed", None),
        ("error", "failed", SubagentErrorCode.SUBAGENT_RUN_FAILED.value),
        ("cancelled", "cancelled", None),
        ("missing_report", "failed", SubagentErrorCode.MISSING_FINAL_REPORT.value),
    ],
)
def test_chat_stream_lifecycle_observer_maps_child_completion_to_durable_run(
    tmp_path,
    mode: str,
    expected_state: str,
    expected_error_code: str | None,
) -> None:
    repositories, _ = _setup(tmp_path)
    manager = ChatStreamManager(CompletingChatService(mode))  # type: ignore[arg-type]
    published = []
    runtime = _runtime(repositories, manager, publisher=published.append)

    async def scenario():
        handle = await runtime.spawn(_request())
        terminal = await asyncio.wait_for(
            runtime.wait_terminal(handle.run_id),
            timeout=1,
        )
        await runtime.shutdown()
        return handle, terminal

    handle, terminal = asyncio.run(scenario())

    assert handle.initial_snapshot.state.value == "queued"
    assert terminal.state.value == expected_state
    assert terminal.error_code == expected_error_code
    assert terminal.final_report == (
        "final report" if expected_state == "completed" else None
    )
    assert [snapshot.state.value for snapshot in published] == [
        "queued",
        "running",
        expected_state,
    ]


def test_steer_queues_for_queued_run_and_rejects_wrong_child_or_terminal(tmp_path) -> None:
    repositories, parent = _setup(tmp_path)
    child = repositories.sessions.create(
        session_id="queued-child",
        user_id=parent.user_id,
        scene_id=parent.scene_id,
        session_type="workspace",
        session_tag="subagent",
        parent_session_id=parent.id,
        visibility="internal",
        agent_kind="subagent",
        subagent_id="queued-subagent",
        subagent_role="explorer",
        workspace_id=parent.workspace_id,
        cwd=parent.cwd,
        workspace_roots=list(parent.workspace_roots),
        current_model_provider_id=parent.current_model_provider_id,
        current_model=parent.current_model,
    )
    queued = SubagentRunSnapshot(
        run_id="queued-run",
        subagent_id="queued-subagent",
        child_session_id=child.id,
        parent_session_id=parent.id,
        parent_trace_id="trace-queued",
        parent_tool_call_id="tool-queued",
        parent_timeline_sequence=0,
        initiated_by="main_agent",
        role="explorer",
        task="inspect",
        state="queued",
        version=1,
        created_at=NOW,
        queued_at=NOW,
        updated_at=NOW,
    )
    repositories.subagent_runs.create(queued)
    service = ControlledChatService(repositories)
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = _runtime(repositories, manager)

    async def scenario() -> None:
        unchanged = await runtime.steer(queued.run_id, child.id, "focus on storage")
        assert unchanged == queued
        pending = repositories.pending_inputs.list_active_by_session(child.id)
        assert [record.message for record in pending] == ["focus on storage"]
        assert pending[0].mode == "queue"
        assert child.id not in service.started

        with pytest.raises(SubagentError) as wrong_child:
            await runtime.steer(queued.run_id, "another-child", "do not deliver")
        assert wrong_child.value.code is SubagentErrorCode.STEER_NOT_ALLOWED

        terminal = await runtime.cancel(queued.run_id, reason="cancel before start")
        assert terminal.state.value == "cancelled"
        assert terminal.cancel_requested_at is not None
        assert repositories.pending_inputs.list_active_by_session(child.id)[0].paused_at
        with pytest.raises(SubagentError) as terminal_error:
            await runtime.steer(terminal.run_id, child.id, "too late")
        assert terminal_error.value.code is SubagentErrorCode.RUN_TERMINAL

        with pytest.raises(SubagentError) as blank:
            await runtime.steer(terminal.run_id, child.id, "   ")
        assert blank.value.code is SubagentErrorCode.STEER_NOT_ALLOWED
        await runtime.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "terminal_state",
    ["completed", "failed", "cancelled", "interrupted"],
)
def test_ft_ctl_005_006_terminal_runs_reject_steer_and_cancel_is_idempotent(
    tmp_path, terminal_state: str
) -> None:
    repositories, parent = _setup(tmp_path)
    child, old_run = _persist_terminal_instance(repositories, parent, terminal_state)
    runtime = _runtime(repositories, SchedulingChatManager())

    async def scenario():
        with pytest.raises(SubagentError) as steer_error:
            await runtime.steer(old_run.run_id, child.id, "too late")
        replay = await runtime.cancel(old_run.run_id, reason="terminal replay")
        return steer_error.value, replay

    error, replay = asyncio.run(scenario())
    assert error.code is SubagentErrorCode.RUN_TERMINAL
    assert replay == old_run
    assert repositories.pending_inputs.list_active_by_session(child.id) == []


def test_ft_ctl_002_004_queued_steers_preserve_submission_order(tmp_path) -> None:
    repositories, parent = _setup(tmp_path)
    child = repositories.sessions.create(
        session_id="ordered-child",
        user_id=parent.user_id,
        scene_id=parent.scene_id,
        session_type="workspace",
        session_tag="subagent",
        parent_session_id=parent.id,
        visibility="internal",
        agent_kind="subagent",
        subagent_id="ordered-subagent",
        subagent_role="worker",
        workspace_id=parent.workspace_id,
        cwd=parent.cwd,
        workspace_roots=list(parent.workspace_roots),
    )
    queued = SubagentRunSnapshot(
        run_id="ordered-run",
        subagent_id="ordered-subagent",
        child_session_id=child.id,
        parent_session_id=parent.id,
        parent_trace_id="ordered-trace",
        parent_tool_call_id="ordered-tool",
        parent_timeline_sequence=0,
        initiated_by="main_agent",
        role="worker",
        task="ordered task",
        state="queued",
        version=1,
        created_at=NOW,
        queued_at=NOW,
        updated_at=NOW,
    )
    repositories.subagent_runs.create(queued)
    runtime = _runtime(
        repositories,
        ChatStreamManager(ControlledChatService(repositories)),  # type: ignore[arg-type]
    )

    async def scenario() -> None:
        for message in ("first guidance", "second guidance", "third guidance"):
            snapshot = await runtime.steer(queued.run_id, child.id, message)
            assert snapshot.state.value == "queued"

    asyncio.run(scenario())
    assert [
        record.message
        for record in repositories.pending_inputs.list_active_by_session(child.id)
    ] == ["first guidance", "second guidance", "third guidance"]


def test_steer_running_parallel_runs_uses_each_child_pending_input_stream(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    service = ControlledChatService(repositories)
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = _runtime(repositories, manager)

    async def scenario():
        first, second = await asyncio.gather(
            runtime.spawn(_request(task="first")),
            runtime.spawn(_request(role="worker", task="second")),
        )
        await asyncio.gather(
            service.started.setdefault(first.child_session_id, asyncio.Event()).wait(),
            service.started.setdefault(second.child_session_id, asyncio.Event()).wait(),
        )
        first_snapshot, second_snapshot = await asyncio.gather(
            runtime.steer(first.run_id, first.child_session_id, "guide first"),
            runtime.steer(second.run_id, second.child_session_id, "guide second"),
        )
        assert first_snapshot.state.value == "running"
        assert second_snapshot.state.value == "running"
        first_pending = repositories.pending_inputs.list_active_by_session(
            first.child_session_id
        )
        second_pending = repositories.pending_inputs.list_active_by_session(
            second.child_session_id
        )
        assert [record.message for record in first_pending] == ["guide first"]
        assert [record.message for record in second_pending] == ["guide second"]
        assert first_pending[0].mode == second_pending[0].mode == "steer"
        service.release.setdefault(first.child_session_id, asyncio.Event()).set()
        service.release.setdefault(second.child_session_id, asyncio.Event()).set()
        await asyncio.gather(
            runtime.wait_terminal(first.run_id),
            runtime.wait_terminal(second.run_id),
        )
        for _ in range(100):
            first_status, second_status = await asyncio.gather(
                manager.status(first.child_session_id),
                manager.status(second.child_session_id),
            )
            if first_status["status"] == second_status["status"] == "idle":
                break
            await asyncio.sleep(0.01)
        await runtime.shutdown()

    asyncio.run(scenario())


def test_cancel_running_run_stops_child_pauses_inputs_and_is_idempotent(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    service = ControlledChatService(repositories)
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request())
        await service.started.setdefault(handle.child_session_id, asyncio.Event()).wait()
        await runtime.steer(handle.run_id, handle.child_session_id, "last guidance")
        cancelled = await runtime.cancel(handle.run_id, reason="user requested")
        replay = await runtime.cancel(handle.run_id, reason="duplicate request")
        for _ in range(100):
            if (await manager.status(handle.child_session_id))["status"] == "idle":
                break
            await asyncio.sleep(0.01)
        await runtime.shutdown()
        return handle, cancelled, replay

    handle, cancelled, replay = asyncio.run(scenario())

    assert cancelled.state.value == "cancelled"
    assert cancelled.cancel_requested_at is not None
    assert replay == cancelled
    pending = repositories.pending_inputs.list_active_by_session(
        handle.child_session_id
    )
    assert len(pending) == 1
    assert pending[0].paused_at is not None
    assert pending[0].pause_reason == "user_stopped"


def test_cancel_by_parent_trace_only_cascades_matching_active_runs(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    service = ControlledChatService(repositories)
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = _runtime(repositories, manager)

    async def scenario():
        first, second, unrelated = await asyncio.gather(
            runtime.spawn(_request(task="first trace child")),
            runtime.spawn(_request(role="worker", task="second trace child")),
            runtime.spawn(
                _request(
                    parent_trace_id="trace-unrelated",
                    parent_tool_call_id="tool-unrelated",
                    task="must keep running",
                )
            ),
        )
        cancelled = await runtime.cancel_by_parent_trace(
            "parent-1",
            "trace-1",
            reason="parent tool cancelled",
        )
        unrelated_snapshot = await runtime.get_run(unrelated.run_id)
        empty_replay = await runtime.cancel_by_parent_trace("parent-1", "trace-1")
        await runtime.cancel(unrelated.run_id, reason="test cleanup")
        for _ in range(100):
            statuses = await asyncio.gather(
                manager.status(first.child_session_id),
                manager.status(second.child_session_id),
                manager.status(unrelated.child_session_id),
            )
            if all(status["status"] == "idle" for status in statuses):
                break
            await asyncio.sleep(0.01)
        await runtime.shutdown()
        return first, second, unrelated, cancelled, unrelated_snapshot, empty_replay

    first, second, unrelated, cancelled, unrelated_snapshot, empty_replay = asyncio.run(
        scenario()
    )

    assert [snapshot.run_id for snapshot in cancelled] == [first.run_id, second.run_id]
    assert {snapshot.state.value for snapshot in cancelled} == {"cancelled"}
    assert unrelated_snapshot.run_id == unrelated.run_id
    assert unrelated_snapshot.state.value == "running"
    assert empty_replay == []


@pytest.mark.parametrize("terminal_state", ["completed", "failed", "cancelled", "interrupted"])
def test_resume_terminal_instance_reuses_identity_and_context_session_with_new_run(
    tmp_path,
    terminal_state: str,
) -> None:
    repositories, parent = _setup(tmp_path)
    child, old_run = _persist_terminal_instance(repositories, parent, terminal_state)
    manager = SchedulingChatManager()
    published = []
    runtime = _runtime(repositories, manager, publisher=published.append)

    async def scenario():
        handle = await runtime.resume(child.subagent_id, "follow-up task")
        current = await runtime.get_run(handle.run_id)
        with pytest.raises(SubagentError) as active:
            await runtime.resume(child.subagent_id, "must not overlap")
        assert active.value.code is SubagentErrorCode.RUN_ALREADY_ACTIVE
        await manager.finish()
        await runtime.shutdown()
        return handle, current

    handle, current = asyncio.run(scenario())

    assert handle.subagent_id == old_run.subagent_id
    assert handle.child_session_id == old_run.child_session_id
    assert handle.run_id != old_run.run_id
    assert handle.initial_snapshot.state.value == "queued"
    assert handle.initial_snapshot.initiated_by.value == "user"
    assert handle.initial_snapshot.parent_trace_id is None
    assert handle.initial_snapshot.parent_tool_call_id is None
    assert handle.initial_snapshot.parent_timeline_sequence == 1
    assert current.state.value == "running"
    assert [snapshot.state.value for snapshot in published] == ["queued", "running"]
    assert manager.requests[0].session_id == child.id
    assert manager.requests[0].message == "follow-up task"
    assert repositories.subagent_runs.get(old_run.run_id).to_snapshot() == old_run
    history = repositories.subagent_runs.list_by_subagent(child.subagent_id)
    assert [record.run_id for record in history] == [old_run.run_id, handle.run_id]


def test_resume_rejects_closed_unknown_blank_and_unanchored_main_agent(tmp_path) -> None:
    repositories, parent = _setup(tmp_path)
    child, _ = _persist_terminal_instance(repositories, parent, "completed")
    with repositories.db.transaction(immediate=True) as conn:
        conn.execute(
            "update sessions set subagent_closed_at = ? where id = ?",
            (NOW.isoformat().replace("+00:00", "Z"), child.id),
        )
    runtime = _runtime(repositories, SchedulingChatManager())

    with pytest.raises(SubagentError) as closed:
        asyncio.run(runtime.resume(child.subagent_id, "follow-up"))
    assert closed.value.code is SubagentErrorCode.SUBAGENT_CLOSED

    with pytest.raises(SubagentError) as unknown:
        asyncio.run(runtime.resume("unknown-subagent", "follow-up"))
    assert unknown.value.code is SubagentErrorCode.SUBAGENT_NOT_FOUND

    with pytest.raises(SubagentError) as blank:
        asyncio.run(runtime.resume(child.subagent_id, "  "))
    assert blank.value.code is SubagentErrorCode.RUN_TRANSITION_INVALID

    with pytest.raises(SubagentError) as initiator:
        asyncio.run(
            runtime.resume(
                child.subagent_id,
                "follow-up",
                initiated_by="main_agent",
            )
        )
    assert initiator.value.code is SubagentErrorCode.SUBAGENT_PARENT_INVALID


def test_main_agent_resume_reuses_child_context_and_persists_current_parent_anchor(
    tmp_path,
) -> None:
    repositories, parent = _setup(tmp_path)
    child, old_run = _persist_terminal_instance(repositories, parent, "completed")
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.resume(
            child.subagent_id,
            "continue with prior context",
            initiated_by="main_agent",
            parent_session_id=parent.id,
            parent_trace_id="parent-trace-continued",
            parent_tool_call_id="continue-call-1",
        )
        current = await runtime.get_run(handle.run_id)
        await manager.finish()
        await runtime.shutdown()
        return handle, current

    handle, current = asyncio.run(scenario())

    assert handle.subagent_id == old_run.subagent_id
    assert handle.child_session_id == old_run.child_session_id
    assert handle.run_id != old_run.run_id
    assert current.initiated_by.value == "main_agent"
    assert current.parent_trace_id == "parent-trace-continued"
    assert current.parent_tool_call_id == "continue-call-1"
    assert current.parent_timeline_sequence == 1
    assert manager.requests[0].session_id == child.id
    assert manager.requests[0].message == "continue with prior context"
    assert repositories.subagent_runs.get(old_run.run_id).to_snapshot() == old_run


def test_main_agent_resume_cannot_address_an_instance_from_another_parent(tmp_path) -> None:
    repositories, parent = _setup(tmp_path)
    child, _ = _persist_terminal_instance(repositories, parent, "completed")
    other_parent = repositories.sessions.create(
        session_id="other-parent",
        user_id=parent.user_id,
        scene_id=parent.scene_id,
        session_type="workspace",
    )
    runtime = _runtime(repositories, SchedulingChatManager())

    with pytest.raises(SubagentError) as denied:
        asyncio.run(
            runtime.resume(
                child.subagent_id,
                "cross-parent continuation",
                initiated_by="main_agent",
                parent_session_id=other_parent.id,
                parent_tool_call_id="continue-call-cross-parent",
            )
        )

    assert denied.value.code is SubagentErrorCode.SUBAGENT_NOT_FOUND
    assert repositories.subagent_runs.get_active(child.subagent_id) is None


def test_close_idle_instance_is_idempotent_preserves_history_and_blocks_resume(tmp_path) -> None:
    repositories, parent = _setup(tmp_path)
    child, old_run = _persist_terminal_instance(repositories, parent, "completed")
    runtime = _runtime(repositories, SchedulingChatManager())

    async def scenario():
        first = await runtime.close(child.subagent_id)
        second = await runtime.close(child.subagent_id)
        with pytest.raises(SubagentError) as resume_error:
            await runtime.resume(child.subagent_id, "closed instances stay closed")
        assert resume_error.value.code is SubagentErrorCode.SUBAGENT_CLOSED
        await runtime.shutdown()
        return first, second

    first, second = asyncio.run(scenario())

    assert first == second
    assert first.state.value == "closed"
    assert first.active_run_id is None
    stored_child = repositories.sessions.get_subagent(child.subagent_id)
    assert stored_child is not None
    assert stored_child.status == "closed"
    assert stored_child.subagent_closed_at is not None
    assert repositories.subagent_runs.get(old_run.run_id).to_snapshot() == old_run


def test_close_running_instance_cancels_run_before_marking_instance_closed(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    service = ControlledChatService(repositories)
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request(role="worker", task="running work"))
        await service.started.setdefault(handle.child_session_id, asyncio.Event()).wait()
        summary = await runtime.close(handle.subagent_id)
        for _ in range(100):
            if (await manager.status(handle.child_session_id))["status"] == "idle":
                break
            await asyncio.sleep(0.01)
        replay = await runtime.close(handle.subagent_id)
        await runtime.shutdown()
        return handle, summary, replay

    handle, summary, replay = asyncio.run(scenario())

    assert summary == replay
    assert summary.state.value == "closed"
    assert summary.child_session_id == handle.child_session_id
    run = repositories.subagent_runs.get(handle.run_id)
    assert run is not None
    assert run.state == "cancelled"
    child = repositories.sessions.get_subagent(handle.subagent_id)
    assert child is not None and child.subagent_closed_at is not None


def test_close_unknown_instance_returns_stable_error(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    runtime = _runtime(repositories, SchedulingChatManager())

    with pytest.raises(SubagentError) as unknown:
        asyncio.run(runtime.close("unknown-subagent"))

    assert unknown.value.code is SubagentErrorCode.SUBAGENT_NOT_FOUND


def test_restart_reconciliation_interrupts_only_unowned_active_runs_and_publishes(
    tmp_path,
) -> None:
    repositories, parent = _setup(tmp_path)
    _, terminal = _persist_terminal_instance(repositories, parent, "completed")
    active_runs = []
    for sequence, state in enumerate(("queued", "running"), start=1):
        child = repositories.sessions.create(
            session_id=f"reconcile-child-{state}",
            user_id=parent.user_id,
            scene_id=parent.scene_id,
            session_type="workspace",
            session_tag="subagent",
            parent_session_id=parent.id,
            visibility="internal",
            agent_kind="subagent",
            subagent_id=f"reconcile-subagent-{state}",
            subagent_role="explorer",
            workspace_id=parent.workspace_id,
            cwd=parent.cwd,
            workspace_roots=list(parent.workspace_roots),
            status="running",
        )
        payload = {
            "run_id": f"reconcile-run-{state}",
            "subagent_id": child.subagent_id,
            "child_session_id": child.id,
            "parent_session_id": parent.id,
            "parent_trace_id": f"trace-{state}",
            "parent_tool_call_id": f"tool-{state}",
            "parent_timeline_sequence": sequence,
            "initiated_by": "main_agent",
            "role": "explorer",
            "task": f"{state} task",
            "state": state,
            "version": 1 if state == "queued" else 2,
            "created_at": NOW,
            "queued_at": NOW,
            "updated_at": NOW,
        }
        if state == "running":
            payload.update(started_at=NOW, blocked_on="approval")
        snapshot = SubagentRunSnapshot.model_validate(payload)
        repositories.subagent_runs.create(snapshot)
        repositories.pending_inputs.create_or_get(
            session_id=child.id,
            message=f"pending for {state}",
            mode="queue",
        )
        active_runs.append(snapshot)

    service = ControlledChatService(repositories)
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    published = []
    runtime = _runtime(repositories, manager, publisher=published.append)

    async def scenario():
        observed_versions = []
        await runtime.subscribe(
            "reconcile-run-running",
            lambda snapshot: observed_versions.append(snapshot.version),
        )
        first = await runtime.reconcile_interrupted_runs()
        second = await runtime.reconcile_interrupted_runs()
        await runtime.shutdown()
        return first, second, observed_versions

    first, second, observed_versions = asyncio.run(scenario())

    assert {snapshot.run_id for snapshot in first} == {
        snapshot.run_id for snapshot in active_runs
    }
    assert {snapshot.state.value for snapshot in first} == {"interrupted"}
    assert all(snapshot.blocked_on is None for snapshot in first)
    assert second == []
    assert observed_versions == [2, 3]
    assert {snapshot.state.value for snapshot in published} == {"interrupted"}
    assert repositories.subagent_runs.get(terminal.run_id).to_snapshot() == terminal
    for snapshot in first:
        child = repositories.sessions.get(snapshot.child_session_id, include_internal=True)
        assert child is not None and child.status == "active"
        pending = repositories.pending_inputs.list_active_by_session(
            snapshot.child_session_id
        )
        assert len(pending) == 1
        assert pending[0].paused_at is not None
        assert pending[0].pause_reason == "backend_restarted"


def test_restart_reconciliation_keeps_run_owned_by_chat_stream_manager(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    service = ControlledChatService(repositories)
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request())
        await service.started.setdefault(handle.child_session_id, asyncio.Event()).wait()
        assert await manager.owns_active_run(handle.child_session_id) is True
        reconciled = await runtime.reconcile_interrupted_runs()
        current = await runtime.get_run(handle.run_id)
        await runtime.cancel(handle.run_id, reason="test cleanup")
        await runtime.shutdown()
        return reconciled, current

    reconciled, current = asyncio.run(scenario())

    assert reconciled == []
    assert current.state.value == "running"


def test_race_001_concurrent_resume_creates_exactly_one_active_run(tmp_path) -> None:
    repositories, parent = _setup(tmp_path)
    child, old_run = _persist_terminal_instance(repositories, parent, "completed")
    manager = CountingCancelManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        results = await asyncio.gather(
            runtime.resume(child.subagent_id, "resume one"),
            runtime.resume(child.subagent_id, "resume two"),
            return_exceptions=True,
        )
        active = repositories.subagent_runs.get_active(child.subagent_id)
        assert active is not None
        await runtime.cancel(active.run_id, reason="test cleanup")
        await manager.finish()
        await runtime.shutdown()
        return results, active

    results, active = asyncio.run(scenario())

    handles = [item for item in results if not isinstance(item, BaseException)]
    errors = [item for item in results if isinstance(item, SubagentError)]
    assert len(handles) == len(errors) == 1
    assert errors[0].code is SubagentErrorCode.RUN_ALREADY_ACTIVE
    assert active.run_id != old_run.run_id
    assert len(repositories.subagent_runs.list_by_subagent(child.subagent_id)) == 2


def test_race_002_resume_and_close_leave_no_orphan_active_run(tmp_path) -> None:
    repositories, parent = _setup(tmp_path)
    child, _ = _persist_terminal_instance(repositories, parent, "completed")
    manager = CountingCancelManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        results = await asyncio.gather(
            runtime.resume(child.subagent_id, "racing resume"),
            runtime.close(child.subagent_id),
            return_exceptions=True,
        )
        await manager.finish()
        await runtime.shutdown()
        return results

    results = asyncio.run(scenario())

    assert not [item for item in results if isinstance(item, BaseException)]
    assert repositories.subagent_runs.get_active(child.subagent_id) is None
    stored_child = repositories.sessions.get_subagent(child.subagent_id)
    assert stored_child is not None and stored_child.subagent_closed_at is not None
    assert repositories.subagent_runs.list_by_subagent(child.subagent_id)[-1].state == "cancelled"


@pytest.mark.parametrize("finish_first", [True, False])
def test_race_005_finish_and_steer_have_one_explicit_ordering(
    tmp_path,
    finish_first: bool,
) -> None:
    repositories, _ = _setup(tmp_path)
    service = ControlledChatService(repositories)
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request())
        await service.started.setdefault(handle.child_session_id, asyncio.Event()).wait()
        request = ChatRequest(
            message="initial",
            session_id=handle.child_session_id,
            subagent_run_id=handle.run_id,
            subagent_parent_session_id=handle.parent_session_id,
        )
        finish = runtime.handle_chat_finished(
            handle.child_session_id,
            request=request,
            result=ChatTurnResult(
                session_id=handle.child_session_id,
                trace_id="race-finish",
                turn_index=1,
                status="completed",
                final_content="race completed",
            ),
        )
        steer = runtime.steer(handle.run_id, handle.child_session_id, "late steer")
        ordered = (finish, steer) if finish_first else (steer, finish)
        results = await asyncio.gather(*ordered, return_exceptions=True)
        final = await runtime.get_run(handle.run_id)
        await manager.cancel(handle.child_session_id)
        for _ in range(100):
            if (await manager.status(handle.child_session_id))["status"] == "idle":
                break
            await asyncio.sleep(0.01)
        await runtime.shutdown()
        return handle, results, final

    handle, results, final = asyncio.run(scenario())

    assert final.state.value == "completed"
    steer_errors = [item for item in results if isinstance(item, SubagentError)]
    if steer_errors:
        assert steer_errors[0].code is SubagentErrorCode.RUN_TERMINAL
        assert repositories.pending_inputs.list_active_by_session(handle.child_session_id) == []
    else:
        pending = repositories.pending_inputs.list_active_by_session(handle.child_session_id)
        assert len(pending) == 1
        assert pending[0].paused_at is not None


@pytest.mark.parametrize("cancel_first", [True, False])
def test_race_006_cancel_and_steer_never_leave_deliverable_terminal_input(
    tmp_path,
    cancel_first: bool,
) -> None:
    repositories, _ = _setup(tmp_path)
    service = ControlledChatService(repositories)
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request())
        await service.started.setdefault(handle.child_session_id, asyncio.Event()).wait()
        cancel = runtime.cancel(handle.run_id, reason="race cancel")
        steer = runtime.steer(handle.run_id, handle.child_session_id, "race steer")
        ordered = (cancel, steer) if cancel_first else (steer, cancel)
        results = await asyncio.gather(*ordered, return_exceptions=True)
        for _ in range(100):
            if (await manager.status(handle.child_session_id))["status"] == "idle":
                break
            await asyncio.sleep(0.01)
        final = await runtime.get_run(handle.run_id)
        await runtime.shutdown()
        return handle, results, final

    handle, results, final = asyncio.run(scenario())

    assert final.state.value == "cancelled"
    assert all(
        error.code is SubagentErrorCode.RUN_TERMINAL
        for error in results
        if isinstance(error, SubagentError)
    )
    pending = repositories.pending_inputs.list_active_by_session(handle.child_session_id)
    assert all(record.paused_at is not None for record in pending)


def test_race_007_parent_cancel_and_natural_completion_keep_first_terminal(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    service = ControlledChatService(repositories)
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request())
        await service.started.setdefault(handle.child_session_id, asyncio.Event()).wait()
        request = ChatRequest(
            message="initial",
            session_id=handle.child_session_id,
            subagent_run_id=handle.run_id,
            subagent_parent_session_id=handle.parent_session_id,
        )
        await asyncio.gather(
            runtime.handle_chat_finished(
                handle.child_session_id,
                request=request,
                result=ChatTurnResult(
                    session_id=handle.child_session_id,
                    trace_id="natural-finish",
                    turn_index=1,
                    status="completed",
                    final_content="natural completion",
                ),
            ),
            runtime.cancel_by_parent_trace(handle.parent_session_id, "trace-1"),
        )
        final = await runtime.get_run(handle.run_id)
        await manager.cancel(handle.child_session_id)
        for _ in range(100):
            if (await manager.status(handle.child_session_id))["status"] == "idle":
                break
            await asyncio.sleep(0.01)
        await runtime.shutdown()
        return final

    final = asyncio.run(scenario())

    assert final.state.value in {"completed", "cancelled"}
    replay = repositories.subagent_runs.get(final.run_id).to_snapshot()
    assert replay == final


def test_race_008_subscribe_concurrent_with_terminal_commit_observes_terminal(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request())
        versions = []
        request = manager.requests[0]
        subscription, terminal = await asyncio.gather(
            runtime.subscribe(
                handle.run_id,
                lambda snapshot: versions.append((snapshot.version, snapshot.state.value)),
            ),
            runtime.handle_chat_finished(
                handle.child_session_id,
                request=request,
                result=ChatTurnResult(
                    session_id=handle.child_session_id,
                    trace_id="subscribe-finish",
                    turn_index=1,
                    status="completed",
                    final_content="done",
                ),
            ),
        )
        subscription.unsubscribe()
        await manager.finish()
        await runtime.shutdown()
        return versions, terminal

    versions, terminal = asyncio.run(scenario())

    assert terminal is not None and terminal.state.value == "completed"
    assert (terminal.version, "completed") in versions


def test_race_009_late_owner_finish_cannot_overwrite_interrupted(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request())
        interrupted = await runtime.reconcile_interrupted_runs()
        late = await runtime.handle_chat_finished(
            handle.child_session_id,
            request=manager.requests[0],
            result=ChatTurnResult(
                session_id=handle.child_session_id,
                trace_id="late-owner",
                turn_index=1,
                status="completed",
                final_content="too late",
            ),
        )
        await manager.finish()
        await runtime.shutdown()
        return interrupted, late

    interrupted, late = asyncio.run(scenario())

    assert len(interrupted) == 1
    assert interrupted[0].state.value == "interrupted"
    assert late == interrupted[0]


def test_race_012_concurrent_duplicate_cancel_invokes_underlying_once(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    manager = CountingCancelManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request())
        results = await asyncio.gather(
            runtime.cancel(handle.run_id, reason="first"),
            runtime.cancel(handle.run_id, reason="second"),
        )
        await manager.finish()
        await runtime.shutdown()
        return handle, results

    handle, results = asyncio.run(scenario())

    assert results[0] == results[1]
    assert results[0].state.value == "cancelled"
    assert manager.cancel_calls == [handle.child_session_id]


def test_spawn_allocates_stable_parent_timeline_sequence_for_parallel_instances(
    tmp_path,
) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        first, second = await asyncio.gather(
            runtime.spawn(_request(task="Explore A")),
            runtime.spawn(_request(role="worker", task="Implement B")),
        )
        await manager.finish()
        return first, second

    first, second = asyncio.run(scenario())
    assert first.subagent_id != second.subagent_id
    assert {
        first.initial_snapshot.parent_timeline_sequence,
        second.initial_snapshot.parent_timeline_sequence,
    } == {0, 1}
    assert len(repositories.subagent_runs.list_by_parent("parent-1")) == 2


def test_spawn_rejects_non_workspace_or_internal_parent_before_any_write(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    repositories.sessions.create(
        session_id="chat-parent",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="chat",
    )
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    with pytest.raises(SubagentError) as raised:
        asyncio.run(runtime.spawn(_request(parent_session_id="chat-parent")))
    assert raised.value.code is SubagentErrorCode.SUBAGENT_PARENT_INVALID
    assert manager.requests == []
    assert repositories.subagent_runs.list_by_parent("chat-parent") == []

    internal_parent = repositories.sessions.create(
        session_id="internal-parent",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        session_tag="subagent",
        parent_session_id="parent-1",
        visibility="internal",
        agent_kind="subagent",
        subagent_id="not-a-valid-parent",
        subagent_role="worker",
    )
    for invalid_parent_id in ("missing-parent", internal_parent.id):
        with pytest.raises(SubagentError) as invalid:
            asyncio.run(runtime.spawn(_request(parent_session_id=invalid_parent_id)))
        assert invalid.value.code is SubagentErrorCode.SUBAGENT_PARENT_INVALID
        assert repositories.subagent_runs.list_by_parent(invalid_parent_id) == []


def test_ft_rt_007_child_creation_failure_leaves_no_run_or_child(tmp_path, monkeypatch) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)
    original_create = repositories.sessions.create

    def fail_child_create(*args, **kwargs):
        if kwargs.get("agent_kind") == "subagent":
            raise RuntimeError("child insert failed")
        return original_create(*args, **kwargs)

    monkeypatch.setattr(repositories.sessions, "create", fail_child_create)
    with pytest.raises(RuntimeError, match="child insert failed"):
        asyncio.run(runtime.spawn(_request()))
    assert repositories.subagent_runs.list_by_parent("parent-1") == []
    assert repositories.sessions.list(include_internal=True) == [
        repositories.sessions.get("parent-1")
    ]
    assert manager.requests == []


def test_spawn_transaction_rolls_back_child_when_run_insert_fails(
    tmp_path,
    monkeypatch,
) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    def fail_create(*_args, **_kwargs):
        raise RuntimeError("run insert failed")

    monkeypatch.setattr(repositories.subagent_runs, "create", fail_create)
    with pytest.raises(RuntimeError, match="run insert failed"):
        asyncio.run(runtime.spawn(_request()))
    with repositories.db.connect() as conn:
        child_count = conn.execute(
            "select count(*) as total from sessions where agent_kind = 'subagent'"
        ).fetchone()["total"]
    assert child_count == 0
    assert manager.requests == []


def test_spawn_scheduler_failure_persists_failed_terminal_compensation(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager(fail=True)
    published = []
    runtime = _runtime(repositories, manager, publisher=published.append)

    with pytest.raises(SubagentError) as raised:
        asyncio.run(runtime.spawn(_request()))
    assert raised.value.code is SubagentErrorCode.SUBAGENT_START_FAILED
    runs = repositories.subagent_runs.list_by_parent("parent-1")
    assert len(runs) == 1
    assert runs[0].state == "failed"
    assert runs[0].error_code == SubagentErrorCode.SUBAGENT_START_FAILED.value
    child = repositories.sessions.get(runs[0].child_session_id, include_internal=True)
    assert child is not None
    assert child.status == "failed"
    assert [snapshot.state.value for snapshot in published] == ["queued", "failed"]


def test_chat_service_requires_exact_internal_parent_run_authority(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request())
        await manager.finish()
        return handle

    handle = asyncio.run(scenario())
    service = object.__new__(ChatService)
    service.repositories = repositories
    service.settings = SimpleNamespace(
        default_user_id="local-user",
        default_scene_id="desktop-agent",
    )

    authorized = service._ensure_session(
        ChatRequest(
            message="inspect",
            session_id=handle.child_session_id,
            subagent_run_id=handle.run_id,
            subagent_parent_session_id=handle.parent_session_id,
        )
    )
    assert authorized.id == handle.child_session_id

    with pytest.raises(SubagentError) as missing_authority:
        service._ensure_session(
            ChatRequest(message="forged", session_id=handle.child_session_id)
        )
    assert (
        missing_authority.value.code
        is SubagentErrorCode.CHILD_SESSION_ACCESS_DENIED
    )

    with pytest.raises(SubagentError) as wrong_parent:
        service._ensure_session(
            ChatRequest(
                message="forged",
                session_id=handle.child_session_id,
                subagent_run_id=handle.run_id,
                subagent_parent_session_id="other-parent",
            )
        )
    assert wrong_parent.value.code is SubagentErrorCode.CHILD_SESSION_ACCESS_DENIED


def test_get_run_and_list_by_parent_use_durable_parent_scoped_snapshots(tmp_path) -> None:
    repositories, parent = _setup(tmp_path)
    repositories.sessions.create(
        session_id="parent-2",
        user_id=parent.user_id,
        scene_id=parent.scene_id,
        session_type="workspace",
        workspace_id=parent.workspace_id,
        cwd=parent.cwd,
        workspace_roots=list(parent.workspace_roots),
    )
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        first = await runtime.spawn(_request(task="First"))
        second = await runtime.spawn(_request(role="worker", task="Second"))
        other = await runtime.spawn(
            _request(
                parent_session_id="parent-2",
                parent_trace_id="trace-2",
                parent_tool_call_id="tool-2",
                task="Other parent",
            )
        )
        scoped = await runtime.get_run(
            first.run_id,
            parent_session_id="parent-1",
        )
        parent_runs = await runtime.list_by_parent("parent-1")
        other_runs = await runtime.list_by_parent("parent-2")
        await manager.finish()
        return first, second, other, scoped, parent_runs, other_runs

    first, second, other, scoped, parent_runs, other_runs = asyncio.run(scenario())
    assert scoped.run_id == first.run_id
    assert scoped.state.value == "running"
    assert [snapshot.run_id for snapshot in parent_runs] == [
        first.run_id,
        second.run_id,
    ]
    assert [snapshot.parent_timeline_sequence for snapshot in parent_runs] == [0, 1]
    assert [snapshot.run_id for snapshot in other_runs] == [other.run_id]

    with pytest.raises(SubagentError) as cross_parent:
        asyncio.run(
            runtime.get_run(first.run_id, parent_session_id="parent-2")
        )
    assert cross_parent.value.code is SubagentErrorCode.RUN_NOT_FOUND

    with pytest.raises(SubagentError) as missing:
        asyncio.run(runtime.get_run("missing-run"))
    assert missing.value.code is SubagentErrorCode.RUN_NOT_FOUND
    assert asyncio.run(runtime.list_by_parent("unknown-parent")) == []


def test_run_subscription_replays_latest_and_isolates_multiple_listeners(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)
    sync_versions: list[int] = []
    async_versions: list[int] = []
    failing_versions: list[int] = []

    def sync_listener(snapshot) -> None:
        sync_versions.append(snapshot.version)

    async def async_listener(snapshot) -> None:
        await asyncio.sleep(0)
        async_versions.append(snapshot.version)

    def failing_listener(snapshot) -> None:
        failing_versions.append(snapshot.version)
        raise RuntimeError("listener failure")

    async def scenario() -> None:
        handle = await runtime.spawn(_request())
        sync_subscription = await runtime.subscribe(handle.run_id, sync_listener)
        await runtime.subscribe(handle.run_id, failing_listener)
        await runtime.subscribe(handle.run_id, async_listener)

        running = await runtime.get_run(handle.run_id)
        await runtime._publish_snapshot(running)
        await runtime._publish_snapshot(running)

        sync_subscription.unsubscribe()
        sync_subscription.unsubscribe()
        cancelled = repositories.subagent_runs.transition(
            handle.run_id,
            "cancelled",
            expected_version=2,
            now=NOW,
        ).to_snapshot()
        await runtime._publish_snapshot(cancelled)
        await manager.finish()

    asyncio.run(scenario())
    assert sync_versions == [2]
    assert failing_versions == [2, 3]
    assert async_versions == [2, 3]


def test_subscribe_rejects_unknown_run_and_shutdown_clears_listeners(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    async def scenario() -> None:
        with pytest.raises(SubagentError) as missing:
            await runtime.subscribe("missing-run", lambda _snapshot: None)
        assert missing.value.code is SubagentErrorCode.RUN_NOT_FOUND

        handle = await runtime.spawn(_request())
        versions: list[int] = []
        await runtime.subscribe(handle.run_id, lambda snapshot: versions.append(snapshot.version))
        assert versions == [2]
        await runtime.shutdown()
        cancelled = repositories.subagent_runs.transition(
            handle.run_id,
            "cancelled",
            expected_version=2,
            now=NOW,
        ).to_snapshot()
        await runtime._publish_snapshot(cancelled)
        assert versions == [2]
        await manager.finish()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "terminal_state",
    ["completed", "failed", "cancelled", "interrupted"],
)
def test_wait_terminal_returns_all_durable_terminal_states(
    tmp_path,
    terminal_state: str,
) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request())
        expected_version = 2
        kwargs = {}
        if terminal_state == "completed":
            kwargs["final_report"] = "finished"
        elif terminal_state == "failed":
            kwargs.update(error_code="FAILED", error_message="broken")
        terminal = repositories.subagent_runs.transition(
            handle.run_id,
            terminal_state,
            expected_version=expected_version,
            now=NOW,
            **kwargs,
        ).to_snapshot()
        result = await runtime.wait_terminal(handle.run_id)
        await manager.finish()
        return terminal, result

    terminal, result = asyncio.run(scenario())
    assert result == terminal


def test_ft_rt_039_rebuilt_runtime_waits_from_persisted_terminal_state(tmp_path) -> None:
    repositories, parent = _setup(tmp_path)
    _, terminal = _persist_terminal_instance(repositories, parent, "completed")
    rebuilt = _runtime(repositories, SchedulingChatManager())

    result = asyncio.run(rebuilt.wait_terminal(terminal.run_id))

    assert result == terminal
    assert rebuilt._listeners == {}


def test_wait_terminal_wakes_multiple_waiters_from_published_terminal_snapshot(
    tmp_path,
) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    async def scenario():
        handle = await runtime.spawn(_request())
        waiters = [
            asyncio.create_task(runtime.wait_terminal(handle.run_id)),
            asyncio.create_task(runtime.wait_terminal(handle.run_id)),
        ]
        await asyncio.sleep(0)
        completed = repositories.subagent_runs.transition(
            handle.run_id,
            "completed",
            expected_version=2,
            now=NOW,
            final_report="done",
        ).to_snapshot()
        await runtime._publish_snapshot(completed)
        results = await asyncio.gather(*waiters)
        await manager.finish()
        return completed, results

    completed, results = asyncio.run(scenario())
    assert results == [completed, completed]


def test_wait_cancellation_unsubscribes_without_cancelling_child_run(tmp_path) -> None:
    repositories, _ = _setup(tmp_path)
    manager = SchedulingChatManager()
    runtime = _runtime(repositories, manager)

    async def scenario() -> None:
        handle = await runtime.spawn(_request())
        cancellation = SubagentWaitCancellationToken()
        waiter = asyncio.create_task(
            runtime.wait_terminal(handle.run_id, cancellation=cancellation)
        )
        await asyncio.sleep(0)
        cancellation.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert (await runtime.get_run(handle.run_id)).state.value == "running"
        assert handle.run_id not in runtime._listeners

        caller_cancelled = asyncio.create_task(runtime.wait_terminal(handle.run_id))
        await asyncio.sleep(0)
        caller_cancelled.cancel()
        with pytest.raises(asyncio.CancelledError):
            await caller_cancelled
        assert (await runtime.get_run(handle.run_id)).state.value == "running"
        assert handle.run_id not in runtime._listeners
        await manager.finish()

    asyncio.run(scenario())
