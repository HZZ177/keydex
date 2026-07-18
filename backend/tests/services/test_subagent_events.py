from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from backend.app.events import ChatAction, DomainEventType, ReplayAction
from backend.app.services.subagent_events import SubagentRunEventPublisher
from backend.app.storage import StorageRepositories, init_database
from backend.app.subagents.models import SubagentRunSnapshot

NOW = datetime(2026, 7, 18, 14, 0, tzinfo=UTC)


class RecordingBroadcastManager:
    def __init__(self) -> None:
        self.events: list[dict] = []

    async def broadcast(self, *, session_id: str, action: str, data: dict) -> bool:
        self.events.append({"session_id": session_id, "action": action, "data": data})
        return True


def _snapshot(
    *,
    version: int = 1,
    state: str = "queued",
    run_id: str = "run-1",
    blocked_on: str | None = None,
) -> SubagentRunSnapshot:
    payload = {
        "run_id": run_id,
        "subagent_id": "subagent-1",
        "child_session_id": "child-1",
        "parent_session_id": "parent-1",
        "parent_trace_id": "trace-1",
        "parent_tool_call_id": "tool-call-1",
        "parent_timeline_sequence": 0,
        "initiated_by": "main_agent",
        "role": "explorer",
        "task": "inspect",
        "state": state,
        "version": version,
        "created_at": NOW,
        "queued_at": NOW,
        "updated_at": NOW,
        "blocked_on": blocked_on,
    }
    if state in {"running", "completed", "failed"}:
        payload["started_at"] = NOW
    if state in {"completed", "failed", "cancelled", "interrupted"}:
        payload["finished_at"] = NOW + timedelta(seconds=1)
    if state == "completed":
        payload["final_report"] = "done"
    if state == "failed":
        payload.update(error_code="FAILED", error_message="child failed")
    return SubagentRunSnapshot.model_validate(payload)


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    parent = repositories.sessions.create(
        session_id="parent-1",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    repositories.trace_records.create(
        trace_id="trace-1",
        session_id=parent.id,
        active_session_id=parent.id,
        scene_id=parent.scene_id,
        user_id=parent.user_id,
        turn_index=3,
        root_node_id="root-3",
    )
    return repositories


def test_subagent_run_updated_is_a_canonical_persisted_and_chat_event() -> None:
    assert DomainEventType.SUBAGENT_RUN_UPDATED.value == "subagent.run.updated"
    assert ChatAction.SUBAGENT_RUN_UPDATED.value == "subagent_run_updated"
    assert ReplayAction.SUBAGENT_RUN_UPDATED.value == "subagent_run_updated"


@pytest.mark.asyncio
async def test_publisher_persists_full_snapshot_then_broadcasts_parent_action(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    manager = RecordingBroadcastManager()
    publisher = SubagentRunEventPublisher(
        repositories=repositories,
        chat_stream_manager=manager,
    )
    snapshot = _snapshot()

    await publisher.publish(snapshot)

    event_key = "subagent_run:run-1:1"
    stored = repositories.message_events.get(event_key)
    assert stored is not None
    assert stored.session_id == "parent-1"
    assert stored.turn_index == 3
    assert stored.action == "subagent_run_updated"
    for key, value in snapshot.model_dump(mode="json").items():
        assert stored.data[key] == value
    assert stored.data["event_key"] == event_key
    assert stored.data["_canonical"]["event_type"] == "subagent.run.updated"
    assert manager.events == [
        {
            "session_id": "parent-1",
            "action": "subagent_run_updated",
            "data": {
                **snapshot.model_dump(mode="json"),
                "event_key": event_key,
                "session_id": "parent-1",
                "trace_id": "trace-1",
                "turn_index": 3,
                "timestamp_ms": manager.events[0]["data"]["timestamp_ms"],
            },
        }
    ]


@pytest.mark.asyncio
async def test_concurrent_runs_inherit_the_same_parent_trace_turn(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    manager = RecordingBroadcastManager()
    publisher = SubagentRunEventPublisher(
        repositories=repositories,
        chat_stream_manager=manager,
    )

    await asyncio.gather(
        publisher.publish(_snapshot(run_id="run-a")),
        publisher.publish(_snapshot(run_id="run-b")),
    )

    stored = repositories.message_events.list_by_session("parent-1")
    assert sorted((event.data["run_id"], event.turn_index) for event in stored) == [
        ("run-a", 3),
        ("run-b", 3),
    ]
    assert [event["data"]["turn_index"] for event in manager.events] == [3, 3]


@pytest.mark.asyncio
async def test_same_run_version_is_idempotent_and_new_version_appends(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    manager = RecordingBroadcastManager()
    publisher = SubagentRunEventPublisher(
        repositories=repositories,
        chat_stream_manager=manager,
    )

    await publisher.publish(_snapshot(version=1))
    await publisher.publish(_snapshot(version=1))
    await publisher.publish(_snapshot(version=2, state="running"))

    events = repositories.message_events.list_by_session("parent-1")
    assert [(event.id, event.data["version"]) for event in events] == [
        ("subagent_run:run-1:1", 1),
        ("subagent_run:run-1:2", 2),
    ]
    assert [event["data"]["version"] for event in manager.events] == [1, 2]


@pytest.mark.asyncio
async def test_ft_evt_001_009_all_states_and_block_changes_publish_full_addresses(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    manager = RecordingBroadcastManager()
    publisher = SubagentRunEventPublisher(
        repositories=repositories,
        chat_stream_manager=manager,
    )
    snapshots = [
        _snapshot(run_id=f"run-{state}", version=index, state=state)
        for index, state in enumerate(
            ("queued", "running", "completed", "failed", "cancelled", "interrupted"),
            start=1,
        )
    ]
    snapshots.append(
        _snapshot(
            run_id="run-blocked",
            version=7,
            state="running",
            blocked_on="approval",
        )
    )

    for snapshot in snapshots:
        await publisher.publish(snapshot)

    assert [event["data"]["state"] for event in manager.events] == [
        "queued",
        "running",
        "completed",
        "failed",
        "cancelled",
        "interrupted",
        "running",
    ]
    assert manager.events[-1]["data"]["blocked_on"] == "approval"
    for snapshot, event in zip(snapshots, manager.events, strict=True):
        data = event["data"]
        assert event["session_id"] == snapshot.parent_session_id
        assert data["run_id"] == snapshot.run_id
        assert data["subagent_id"] == snapshot.subagent_id
        assert data["child_session_id"] == snapshot.child_session_id
        assert data["parent_session_id"] == snapshot.parent_session_id
        assert data["parent_trace_id"] == snapshot.parent_trace_id
        assert data["parent_tool_call_id"] == snapshot.parent_tool_call_id
        assert data["version"] == snapshot.version
