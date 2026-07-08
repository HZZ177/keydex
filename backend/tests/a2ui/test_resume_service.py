from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from langgraph.types import Command

from backend.app.a2ui.resume_service import (
    DEFAULT_A2UI_RESUME_RECURSION_LIMIT,
    A2UIResumeService,
)
from backend.app.core.request_context import consume_a2ui_resume_payload
from backend.app.events.event_types import DomainEventType
from backend.app.storage import (
    A2UI_RESUME_STATUS_FAILED,
    A2UI_RESUME_STATUS_NOT_STARTED,
    A2UI_RESUME_STATUS_SUCCEEDED,
    A2UI_STATUS_SUBMITTED,
    A2UI_STATUS_WAITING_USER_INPUT,
    StorageRepositories,
    init_database,
)


class RecordingDispatcher:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def emit_event(self, **kwargs: Any) -> dict[str, Any]:
        self.events.append(kwargs)
        return kwargs


class RecordingAgent:
    def __init__(self, *, fail: bool = False) -> None:
        self.fail = fail
        self.inputs: list[Any] = []
        self.configs: list[dict[str, Any]] = []

    async def astream_events(self, input_data: Any, *, config: dict[str, Any], version: str):
        self.inputs.append(input_data)
        self.configs.append(config)
        if self.fail:
            raise RuntimeError("resume boom")
        yield {
            "event": "on_chat_model_end",
            "data": {"output": ""},
            "run_id": "run-1",
            "name": "model",
        }


class ResumeContextRecordingAgent(RecordingAgent):
    def __init__(self) -> None:
        super().__init__()
        self.consumed_resume_payload: dict[str, Any] | None = None

    async def astream_events(self, input_data: Any, *, config: dict[str, Any], version: str):
        self.consumed_resume_payload = consume_a2ui_resume_payload(
            "confirm",
            tool_call_id="tool-1",
        )
        async for event in super().astream_events(
            input_data,
            config=config,
            version=version,
        ):
            yield event


async def recording_processor(event_stream, **kwargs: Any) -> None:
    async for _event in event_stream:
        pass
    kwargs["dispatcher"].processed_kwargs = kwargs


async def completed_processor(event_stream, **kwargs: Any) -> SimpleNamespace:
    async for _event in event_stream:
        pass
    kwargs["dispatcher"].processed_kwargs = kwargs
    return SimpleNamespace(
        final_content="交互恢复已完成",
        chain_token_usage={"llm_call_count": 1},
        latest_llm_token_usage={"input_tokens": 3, "output_tokens": 5, "total_tokens": 8},
    )


@pytest.mark.asyncio
async def test_single_interaction_starts_command_resume_and_marks_succeeded(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    agent = RecordingAgent()
    _create_interaction(repositories, interaction_id="a2ui-1")
    _submit(repositories, "a2ui-1", request_id="submit-1", result={"confirmed": True})
    service = A2UIResumeService(
        repositories=repositories,
        dispatcher=dispatcher,
        agent_factory=lambda _snapshot: agent,
        event_processor=recording_processor,
    )

    result = await service.start_resume("a2ui-1", background=False, user_id="user-1")

    stored = repositories.a2ui_interactions.get("a2ui-1")
    assert result.started is True
    assert result.resume_status == "started"
    assert result.reason == "all_peer_interactions_closed"
    assert stored is not None
    assert stored.resume_status == A2UI_RESUME_STATUS_SUCCEEDED
    assert repositories.sessions.get("session-1").status == "active"
    assert isinstance(agent.inputs[0], Command)
    assert agent.inputs[0].resume == {
        "status": A2UI_STATUS_SUBMITTED,
        "interaction_id": "a2ui-1",
        "submit_result": {"confirmed": True},
    }
    assert agent.configs[0]["configurable"] == {
        "thread_id": "thread-1",
        "checkpoint_ns": "",
        "checkpoint_id": "checkpoint-1",
    }
    assert agent.configs[0]["recursion_limit"] == DEFAULT_A2UI_RESUME_RECURSION_LIMIT
    assert [event["event_type"] for event in dispatcher.events] == [
        DomainEventType.A2UI_RESUME_STARTED.value,
        DomainEventType.A2UI_RESUME_SUCCEEDED.value,
        DomainEventType.TURN_COMPLETED.value,
    ]


@pytest.mark.asyncio
async def test_resume_success_emits_completed_turn_payload(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    agent = RecordingAgent()
    _create_interaction(repositories, interaction_id="a2ui-1")
    _submit(repositories, "a2ui-1", request_id="submit-1", result={"confirmed": True})
    service = A2UIResumeService(
        repositories=repositories,
        dispatcher=dispatcher,
        agent_factory=lambda _snapshot: agent,
        event_processor=completed_processor,
    )

    await service.start_resume("a2ui-1", background=False, user_id="user-1")

    completed = dispatcher.events[-1]
    assert completed["event_type"] == DomainEventType.TURN_COMPLETED.value
    assert completed["original_session_id"] == "session-1"
    assert completed["active_session_id"] == "thread-1"
    assert completed["trace_id"] == "trace-1"
    assert completed["turn_index"] == 1
    assert completed["payload"]["status"] == "completed"
    assert completed["payload"]["final_content"] == "交互恢复已完成"
    assert completed["payload"]["latest_llm_token_usage"] == {
        "input_tokens": 3,
        "output_tokens": 5,
        "total_tokens": 8,
    }
    assert repositories.sessions.get("session-1").status == "active"


@pytest.mark.asyncio
async def test_resume_service_exposes_resume_payload_context_to_reentry(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    agent = ResumeContextRecordingAgent()
    _create_interaction(repositories, interaction_id="a2ui-1", tool_call_id="tool-1")
    _submit(repositories, "a2ui-1", request_id="submit-1", result={"confirmed": True})
    service = A2UIResumeService(
        repositories=repositories,
        dispatcher=dispatcher,
        agent_factory=lambda _snapshot: agent,
        event_processor=recording_processor,
    )

    await service.start_resume("a2ui-1", background=False)

    assert agent.consumed_resume_payload == {
        "status": A2UI_STATUS_SUBMITTED,
        "interaction_id": "a2ui-1",
        "submit_result": {"confirmed": True},
    }


@pytest.mark.asyncio
async def test_parallel_interactions_defer_until_all_peers_closed(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    agent = RecordingAgent()
    _create_interaction(repositories, interaction_id="a2ui-1", tool_call_id="tool-1")
    _create_interaction(repositories, interaction_id="a2ui-2", tool_call_id="tool-2")
    _submit(repositories, "a2ui-1", request_id="submit-1", result={"confirmed": True})
    service = A2UIResumeService(
        repositories=repositories,
        dispatcher=dispatcher,
        agent_factory=lambda _snapshot: agent,
        event_processor=recording_processor,
    )

    result = await service.start_resume("a2ui-1", background=False)

    assert result.started is False
    assert result.resume_status == "deferred"
    assert result.pending_count == 1
    assert result.reason == "waiting_peer_interactions"
    assert repositories.a2ui_interactions.get("a2ui-1").resume_status == (
        A2UI_RESUME_STATUS_NOT_STARTED
    )
    assert agent.inputs == []
    assert [event["event_type"] for event in dispatcher.events] == [
        DomainEventType.A2UI_RESUME_DEFERRED.value
    ]


@pytest.mark.asyncio
async def test_group_all_closed_uses_interrupt_id_command_resume_payload(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    agent = RecordingAgent()
    _create_interaction(repositories, interaction_id="a2ui-1", tool_call_id="tool-1")
    _create_interaction(repositories, interaction_id="a2ui-2", tool_call_id="tool-2")
    _submit(repositories, "a2ui-1", request_id="submit-1", result={"confirmed": True})
    _submit(repositories, "a2ui-2", request_id="submit-2", result={"confirmed": False})
    service = A2UIResumeService(
        repositories=repositories,
        dispatcher=dispatcher,
        agent_factory=lambda _snapshot: agent,
        event_processor=recording_processor,
    )

    result = await service.start_resume("a2ui-2", background=False)

    assert result.started is True
    assert isinstance(agent.inputs[0], Command)
    assert agent.inputs[0].resume == {
        "interrupt-a2ui-1": {
            "status": A2UI_STATUS_SUBMITTED,
            "interaction_id": "a2ui-1",
            "submit_result": {"confirmed": True},
        },
        "interrupt-a2ui-2": {
            "status": A2UI_STATUS_SUBMITTED,
            "interaction_id": "a2ui-2",
            "submit_result": {"confirmed": False},
        },
    }
    assert repositories.a2ui_interactions.get("a2ui-1").resume_status == (
        A2UI_RESUME_STATUS_SUCCEEDED
    )
    assert repositories.a2ui_interactions.get("a2ui-2").resume_status == (
        A2UI_RESUME_STATUS_SUCCEEDED
    )


@pytest.mark.asyncio
async def test_resume_failure_marks_group_failed(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    agent = RecordingAgent(fail=True)
    _create_interaction(repositories, interaction_id="a2ui-1")
    _submit(repositories, "a2ui-1", request_id="submit-1", result={"confirmed": True})
    service = A2UIResumeService(
        repositories=repositories,
        dispatcher=dispatcher,
        agent_factory=lambda _snapshot: agent,
        event_processor=recording_processor,
    )

    with pytest.raises(RuntimeError, match="resume boom"):
        await service.start_resume("a2ui-1", background=False)

    stored = repositories.a2ui_interactions.get("a2ui-1")
    assert stored is not None
    assert stored.resume_status == A2UI_RESUME_STATUS_FAILED
    assert stored.resume_error == "resume boom"
    assert [event["event_type"] for event in dispatcher.events] == [
        DomainEventType.A2UI_RESUME_STARTED.value,
        DomainEventType.A2UI_RESUME_FAILED.value,
    ]


@pytest.mark.asyncio
async def test_sequential_not_blocking_completed_interaction_is_ignored(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    agent = RecordingAgent()
    _create_interaction(repositories, interaction_id="a2ui-1", tool_call_id="tool-1")
    _submit(repositories, "a2ui-1", request_id="submit-1", result={"confirmed": True})
    service = A2UIResumeService(
        repositories=repositories,
        dispatcher=dispatcher,
        agent_factory=lambda _snapshot: agent,
        event_processor=recording_processor,
    )
    await service.start_resume("a2ui-1", background=False)

    _create_interaction(repositories, interaction_id="a2ui-2", tool_call_id="tool-2")
    _submit(repositories, "a2ui-2", request_id="submit-2", result={"confirmed": False})

    await service.start_resume("a2ui-2", background=False)

    assert len(agent.inputs) == 2
    assert agent.inputs[1].resume == {
        "status": A2UI_STATUS_SUBMITTED,
        "interaction_id": "a2ui-2",
        "submit_result": {"confirmed": False},
    }


@pytest.mark.asyncio
async def test_idempotent_replay_does_not_duplicate_resume_run(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    agent = RecordingAgent()
    _create_interaction(repositories, interaction_id="a2ui-1")
    _submit(repositories, "a2ui-1", request_id="submit-1", result={"confirmed": True})
    service = A2UIResumeService(
        repositories=repositories,
        dispatcher=dispatcher,
        agent_factory=lambda _snapshot: agent,
        event_processor=recording_processor,
    )

    first = await service.start_resume("a2ui-1", background=False)
    second = await service.start_resume("a2ui-1", background=False)

    assert first.started is True
    assert second.started is False
    assert second.reason == "resume_already_active"
    assert len(agent.inputs) == 1


def _repositories(tmp_path: Path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


def _create_interaction(
    repositories: StorageRepositories,
    *,
    interaction_id: str,
    tool_call_id: str = "tool-1",
) -> None:
    repositories.a2ui_interactions.create(
        interaction_id=interaction_id,
        session_id="session-1",
        trace_id="trace-1",
        active_session_id="thread-1",
        turn_index=1,
        tool_call_id=tool_call_id,
        stream_id=f"stream-{interaction_id}",
        render_key="confirm",
        mode="interactive",
        payload={"title": "Confirm"},
        input_schema={"type": "object"},
        submit_schema_snapshot={"type": "object"},
        langgraph_thread_id="thread-1",
        checkpoint_ns="",
        checkpoint_id="checkpoint-1",
        interrupt_id=f"interrupt-{interaction_id}",
        resume_group_id="group-1",
    )


def _submit(
    repositories: StorageRepositories,
    interaction_id: str,
    *,
    request_id: str,
    result: dict[str, Any],
) -> None:
    repositories.a2ui_interactions.submit(
        interaction_id,
        request_id=request_id,
        submit_result=result,
        resume_payload={
            "status": A2UI_STATUS_SUBMITTED,
            "interaction_id": interaction_id,
            "submit_result": result,
        },
    )
