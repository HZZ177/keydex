from __future__ import annotations

import pytest
from langchain_core.messages import HumanMessage
from langgraph.graph import END, START, StateGraph

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.agent.state import (
    KeydexAgentState,
    build_structured_user_group_replay_marker_update,
    build_structured_user_message_groups_reset_update,
    build_structured_user_message_groups_update,
    merge_structured_user_group_replay_markers,
    merge_structured_user_message_groups,
)
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    build_structured_user_message_member,
)
from backend.app.storage import init_database


def _group(group_id: str, content: str) -> dict[str, object]:
    return StructuredUserMessageGroup.create(
        group_id=group_id,
        root_user_message=build_structured_user_message_member(
            "root_user_message",
            0,
            {"content": content, "role": "HumanMessage"},
        ),
    ).to_dict()


def test_structured_user_group_reducer_appends_dedupes_and_replaces() -> None:
    first = _group("group-1", "first")
    second = _group("group-2", "second")

    appended = merge_structured_user_message_groups([], [first, second, first])
    assert [item["group_id"] for item in appended] == ["group-1", "group-2"]

    changed = _group("group-1", "changed")
    updated = merge_structured_user_message_groups(appended, [changed])
    assert [item["group_id"] for item in updated] == ["group-1", "group-2"]
    assert updated[0]["fingerprint"] == changed["fingerprint"]

    replaced = merge_structured_user_message_groups(
        updated,
        build_structured_user_message_groups_update([second], replace=True)[
            "structured_user_message_groups"
        ],
    )
    assert [item["group_id"] for item in replaced] == ["group-2"]


def test_structured_user_group_reducer_reset_and_round_trip() -> None:
    first = _group("group-1", "first")
    reset = build_structured_user_message_groups_reset_update()[
        "structured_user_message_groups"
    ]
    assert merge_structured_user_message_groups([first], reset) == []

    update = build_structured_user_message_groups_update([first])
    assert update["structured_user_message_groups"] == [first]


def test_replay_marker_reducer_tracks_pending_and_consumed_per_boundary() -> None:
    pending = build_structured_user_group_replay_marker_update(
        boundary_id="boundary-1",
        group_ids=["group-1", "group-2"],
    )["structured_user_group_replay_markers"]
    state = merge_structured_user_group_replay_markers({}, pending)
    assert state["boundary-1:group-1"]["status"] == "pending"

    consumed = build_structured_user_group_replay_marker_update(
        boundary_id="boundary-1",
        group_ids=["group-1"],
        consumed=True,
    )["structured_user_group_replay_markers"]
    state = merge_structured_user_group_replay_markers(state, consumed)
    assert state["boundary-1:group-1"]["status"] == "consumed"
    assert state["boundary-1:group-2"]["status"] == "pending"
    assert merge_structured_user_group_replay_markers(state, {"mode": "reset"}) == {}


@pytest.mark.asyncio
async def test_structured_user_groups_round_trip_through_langgraph_checkpoint(tmp_path) -> None:
    graph_builder = StateGraph(KeydexAgentState)

    async def keep_state(_state: KeydexAgentState) -> dict[str, object]:
        return {}

    graph_builder.add_node("keep", keep_state)
    graph_builder.add_edge(START, "keep")
    graph_builder.add_edge("keep", END)
    graph = graph_builder.compile(
        checkpointer=SQLiteCheckpointSaver(init_database(tmp_path / "checkpoint.db"))
    )
    config = {"configurable": {"thread_id": "thread-1", "checkpoint_ns": ""}}
    group = _group("group-1", "persist me")

    await graph.ainvoke(
        {
            "messages": [HumanMessage(content="persist me")],
            "structured_user_message_groups": [group],
        },
        config=config,
    )
    snapshot = await graph.aget_state(config)

    assert snapshot.values["structured_user_message_groups"] == [group]
    restored = StructuredUserMessageGroup.from_dict(
        snapshot.values["structured_user_message_groups"][0]
    )
    assert restored.group_id == "group-1"
    assert restored.root_user_message.payload["content"] == "persist me"
