from __future__ import annotations

from langchain_core.messages import HumanMessage

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.services.purge_service import PurgeDatabaseExecutor, PurgePlanner
from backend.app.services.session_fork_service import SessionForkService
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    build_structured_user_message_member,
)
from backend.app.storage import StorageRepositories, init_database


def _checkpoint(checkpoint_id: str, *, group_id: str, boundary_id: str) -> dict:
    group = StructuredUserMessageGroup.create(
        group_id=group_id,
        root_user_message=build_structured_user_message_member(
            "root_user_message",
            0,
            {
                "content": f"request from {group_id}",
                "message_id": f"message-{group_id}",
                "role": "HumanMessage",
            },
            source_id=f"message-{group_id}",
        ),
    )
    return {
        "v": 1,
        "id": checkpoint_id,
        "ts": f"2026-07-17T00:00:00+00:00:{checkpoint_id}",
        "channel_values": {
            "messages": [HumanMessage(content=f"checkpoint {checkpoint_id}")],
            "structured_user_message_groups": [group.to_dict()],
            "structured_user_group_replay_markers": {
                f"{boundary_id}:{group_id}": {
                    "boundary_id": boundary_id,
                    "group_id": group_id,
                    "status": "pending",
                }
            },
            "pending_tool_call_preset": {
                "type": "force",
                "producer": "skill_activation",
                "calls": [
                    {
                        "name": "load_skill",
                        "args": {"skill_name": group_id, "source": "workspace"},
                    }
                ],
                "metadata": {
                    "source": "context_compression",
                    "boundary_id": boundary_id,
                    "selected_group_ids": [group_id],
                },
            },
        },
        "channel_versions": {},
        "versions_seen": {},
    }


def _prepare_two_turn_session(tmp_path):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    session = repositories.sessions.create(
        session_id="session-source",
        user_id="local-user",
        scene_id="desktop-agent",
        title="source",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    first = saver.put(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
        _checkpoint("checkpoint-1", group_id="group-1", boundary_id="boundary-1"),
        {"step": 1},
        {},
    )
    saver.put(
        first,
        _checkpoint("checkpoint-2", group_id="group-2", boundary_id="boundary-2"),
        {"step": 2},
        {},
    )
    for turn_index, input_id, output_id in (
        (1, None, "checkpoint-1"),
        (2, "checkpoint-1", "checkpoint-2"),
    ):
        trace_id = f"trace-{turn_index}"
        repositories.trace_records.create(
            trace_id=trace_id,
            session_id=session.id,
            active_session_id=session.id,
            scene_id=session.scene_id,
            user_id=session.user_id,
            turn_index=turn_index,
            root_node_id=f"root-{turn_index}",
            input_checkpoint_id=input_id,
            input_checkpoint_ns="",
        )
        repositories.trace_records.finish(
            trace_id,
            status="completed",
            output_checkpoint_id=output_id,
            output_checkpoint_ns="",
        )
        repositories.message_events.append(
            event_id=f"event-user-{turn_index}",
            session_id=session.id,
            trace_record_id=trace_id,
            turn_index=turn_index,
            action="user_message",
            data={"session_id": session.id, "content": f"request {turn_index}"},
        )
        repositories.message_events.append(
            event_id=f"event-ai-{turn_index}",
            session_id=session.id,
            trace_record_id=trace_id,
            turn_index=turn_index,
            action="ai_message",
            data={"session_id": session.id, "content": f"answer {turn_index}"},
        )
    return repositories, saver, session


def _checkpoint_values(checkpoint) -> dict:
    return dict(checkpoint.checkpoint["channel_values"])


def test_fork_and_reverse_use_checkpoint_local_group_and_boundary_state(tmp_path) -> None:
    repositories, saver, session = _prepare_two_turn_session(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    forked = service.fork_session(
        session_id=session.id,
        user_id=session.user_id,
        message_event_id="event-ai-1",
    ).session
    fork_checkpoint = saver.get_tuple(
        {"configurable": {"thread_id": forked.id, "checkpoint_ns": ""}}
    )
    assert fork_checkpoint is not None
    fork_values = _checkpoint_values(fork_checkpoint)
    assert [item["group_id"] for item in fork_values["structured_user_message_groups"]] == [
        "group-1"
    ]
    assert set(fork_values["structured_user_group_replay_markers"]) == {
        "boundary-1:group-1"
    }
    assert fork_values["pending_tool_call_preset"]["metadata"]["boundary_id"] == (
        "boundary-1"
    )

    service.reverse_session(
        session_id=session.id,
        user_id=session.user_id,
        message_event_id="event-user-2",
    )
    reversed_checkpoint = saver.get_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    assert reversed_checkpoint is not None
    reverse_values = _checkpoint_values(reversed_checkpoint)
    assert [
        item["group_id"] for item in reverse_values["structured_user_message_groups"]
    ] == ["group-1"]
    assert "boundary-2:group-2" not in reverse_values[
        "structured_user_group_replay_markers"
    ]


def test_archive_restart_preserves_pending_state_and_purge_removes_checkpoint(tmp_path) -> None:
    repositories, saver, session = _prepare_two_turn_session(tmp_path)
    with repositories.db.transaction() as conn:
        conn.execute(
            "update sessions set archived_at = ?, archive_origin = 'manual' where id = ?",
            ("2026-07-17T00:00:00Z", session.id),
        )

    restarted = StorageRepositories(init_database(tmp_path / "app.db"))
    restarted_saver = SQLiteCheckpointSaver(restarted.db)
    checkpoint = restarted_saver.get_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    assert checkpoint is not None
    values = _checkpoint_values(checkpoint)
    assert values["pending_tool_call_preset"]["metadata"]["boundary_id"] == "boundary-2"
    assert values["structured_user_group_replay_markers"]["boundary-2:group-2"][
        "status"
    ] == "pending"

    plan = PurgePlanner(restarted, data_dir=tmp_path / "data").plan_session(session.id)
    counts = PurgeDatabaseExecutor(restarted).execute(plan)

    assert counts["checkpoints_v2"] == 2
    assert restarted_saver.get_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    ) is None


def test_fork_source_and_target_advance_group_boundaries_independently(tmp_path) -> None:
    repositories, saver, session = _prepare_two_turn_session(tmp_path)
    forked = SessionForkService(repositories, checkpointer=saver).fork_session(
        session_id=session.id,
        user_id=session.user_id,
        message_event_id="event-ai-1",
    ).session
    source_checkpoint = saver.get_tuple(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
    )
    target_checkpoint = saver.get_tuple(
        {"configurable": {"thread_id": forked.id, "checkpoint_ns": ""}}
    )
    assert source_checkpoint is not None and target_checkpoint is not None

    source_next = _checkpoint(
        "source-next", group_id="source-skill", boundary_id="source-boundary"
    )["channel_values"]
    target_next = _checkpoint(
        "target-next", group_id="target-attachment", boundary_id="target-boundary"
    )["channel_values"]
    saver.replace_checkpoint_state(
        thread_id=session.id,
        checkpoint_id=source_checkpoint.config["configurable"]["checkpoint_id"],
        checkpoint_ns="",
        channel_values=source_next,
    )
    saver.replace_checkpoint_state(
        thread_id=forked.id,
        checkpoint_id=target_checkpoint.config["configurable"]["checkpoint_id"],
        checkpoint_ns="",
        channel_values=target_next,
    )

    source_values = _checkpoint_values(
        saver.get_tuple(
            {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
        )
    )
    target_values = _checkpoint_values(
        saver.get_tuple(
            {"configurable": {"thread_id": forked.id, "checkpoint_ns": ""}}
        )
    )
    assert [
        item["group_id"] for item in source_values["structured_user_message_groups"]
    ] == ["source-skill"]
    assert [
        item["group_id"] for item in target_values["structured_user_message_groups"]
    ] == ["target-attachment"]
    assert set(source_values["structured_user_group_replay_markers"]) == {
        "source-boundary:source-skill"
    }
    assert set(target_values["structured_user_group_replay_markers"]) == {
        "target-boundary:target-attachment"
    }
