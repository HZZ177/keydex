from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import HumanMessage, RemoveMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.agent.checkpoint_runtime import CheckpointRuntime
from backend.app.agent.state import (
    CHECKPOINT_STATE_UPDATE_NODE,
    build_checkpoint_state_graph,
)
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


def _state_update(*, group_id: str, boundary_id: str) -> dict[str, Any]:
    values = _checkpoint(
        "graph-native",
        group_id=group_id,
        boundary_id=boundary_id,
    )["channel_values"]
    return {
        "messages": [
            RemoveMessage(id=REMOVE_ALL_MESSAGES),
            *values["messages"],
        ],
        "structured_user_message_groups": {
            "mode": "replace",
            "groups": values["structured_user_message_groups"],
        },
        "structured_user_group_replay_markers": values[
            "structured_user_group_replay_markers"
        ],
        "pending_tool_call_preset": values["pending_tool_call_preset"],
    }


async def _prepare_official_two_turn_session(tmp_path):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    session = repositories.sessions.create(
        session_id="session-source",
        user_id="local-user",
        scene_id="desktop-agent",
        title="source",
    )
    runtime = CheckpointRuntime(repositories.db.path)
    assert await runtime.start() is True
    saver = runtime.require_store()
    graph = build_checkpoint_state_graph(saver)
    first = await graph.aupdate_state(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
        _state_update(group_id="group-1", boundary_id="boundary-1"),
        as_node=CHECKPOINT_STATE_UPDATE_NODE,
    )
    second = await graph.aupdate_state(
        first,
        _state_update(group_id="group-2", boundary_id="boundary-2"),
        as_node=CHECKPOINT_STATE_UPDATE_NODE,
    )
    for turn_index, input_config, output_config in (
        (1, None, first),
        (2, first, second),
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
            input_checkpoint_id=(
                input_config["configurable"]["checkpoint_id"]
                if input_config is not None
                else None
            ),
            input_checkpoint_ns="",
        )
        repositories.trace_records.finish(
            trace_id,
            status="completed",
            output_checkpoint_id=output_config["configurable"]["checkpoint_id"],
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
    return repositories, runtime, saver, graph, session


def _checkpoint_values(checkpoint) -> dict:
    values = getattr(checkpoint, "values", None)
    if isinstance(values, dict):
        return dict(values)
    return dict(checkpoint.checkpoint["channel_values"])


@pytest.mark.asyncio
async def test_fork_and_reverse_use_checkpoint_local_group_and_boundary_state(
    tmp_path,
) -> None:
    repositories, runtime, saver, graph, session = (
        await _prepare_official_two_turn_session(tmp_path)
    )
    try:
        service = SessionForkService(repositories, checkpointer=saver)

        forked = (
            await service.fork_session(
                session_id=session.id,
                user_id=session.user_id,
                message_event_id="event-ai-1",
            )
        ).session
        fork_checkpoint = await graph.aget_state(
            {"configurable": {"thread_id": forked.id, "checkpoint_ns": ""}}
        )
        fork_values = _checkpoint_values(fork_checkpoint)
        assert [
            item["group_id"] for item in fork_values["structured_user_message_groups"]
        ] == ["group-1"]
        assert set(fork_values["structured_user_group_replay_markers"]) == {
            "boundary-1:group-1"
        }
        assert fork_values["pending_tool_call_preset"]["metadata"]["boundary_id"] == (
            "boundary-1"
        )

        await service.reverse_session(
            session_id=session.id,
            user_id=session.user_id,
            message_event_id="event-user-2",
        )
        reversed_checkpoint = await graph.aget_state(
            {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
        )
        reverse_values = _checkpoint_values(reversed_checkpoint)
        assert [
            item["group_id"] for item in reverse_values["structured_user_message_groups"]
        ] == ["group-1"]
        assert "boundary-2:group-2" not in reverse_values[
            "structured_user_group_replay_markers"
        ]
    finally:
        await runtime.close()


@pytest.mark.asyncio
async def test_archive_restart_preserves_pending_state_and_purge_removes_checkpoint(
    tmp_path,
) -> None:
    repositories, runtime, _saver, _graph, session = (
        await _prepare_official_two_turn_session(tmp_path)
    )
    with repositories.db.transaction() as conn:
        conn.execute(
            "update sessions set archived_at = ?, archive_origin = 'manual' where id = ?",
            ("2026-07-17T00:00:00Z", session.id),
        )
    await runtime.close()

    restarted = StorageRepositories(init_database(tmp_path / "app.db"))
    restarted_runtime = CheckpointRuntime(restarted.db.path)
    assert await restarted_runtime.start() is True
    try:
        restarted_graph = build_checkpoint_state_graph(restarted_runtime.require_store())
        checkpoint = await restarted_graph.aget_state(
            {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
        )
        values = _checkpoint_values(checkpoint)
        assert values["pending_tool_call_preset"]["metadata"]["boundary_id"] == "boundary-2"
        assert values["structured_user_group_replay_markers"]["boundary-2:group-2"][
            "status"
        ] == "pending"

        plan = PurgePlanner(restarted, data_dir=tmp_path / "data").plan_session(session.id)
        counts = PurgeDatabaseExecutor(restarted).execute(plan)

        assert counts["checkpoints"] == 2
        assert counts["writes"] > 0
        purged = await restarted_graph.aget_state(
            {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
        )
        assert purged.values == {}
        assert "checkpoint_id" not in purged.config["configurable"]
    finally:
        await restarted_runtime.close()


@pytest.mark.asyncio
async def test_fork_source_and_target_advance_group_boundaries_independently(
    tmp_path,
) -> None:
    repositories, runtime, saver, graph, session = (
        await _prepare_official_two_turn_session(tmp_path)
    )
    try:
        forked = (
            await SessionForkService(
                repositories,
                checkpointer=saver,
            ).fork_session(
                session_id=session.id,
                user_id=session.user_id,
                message_event_id="event-ai-1",
            )
        ).session

        for thread_id, group_id, boundary_id in (
            (session.id, "source-skill", "source-boundary"),
            (forked.id, "target-attachment", "target-boundary"),
        ):
            await graph.aupdate_state(
                {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}},
                {"structured_user_group_replay_markers": {"mode": "reset"}},
                as_node=CHECKPOINT_STATE_UPDATE_NODE,
            )
            await graph.aupdate_state(
                {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}},
                _state_update(group_id=group_id, boundary_id=boundary_id),
                as_node=CHECKPOINT_STATE_UPDATE_NODE,
            )

        source_values = _checkpoint_values(
            await graph.aget_state(
                {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}}
            )
        )
        target_values = _checkpoint_values(
            await graph.aget_state(
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
    finally:
        await runtime.close()
