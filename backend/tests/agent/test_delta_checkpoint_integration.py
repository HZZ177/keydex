from __future__ import annotations

import sqlite3
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import aiosqlite
import pytest
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    RemoveMessage,
    ToolMessage,
)
from langgraph.channels.delta import DeltaChannel
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import REMOVE_ALL_MESSAGES, add_messages
from typing_extensions import TypedDict

from backend.app.agent.checkpoint import KeydexAsyncCheckpointStore
from backend.app.agent.checkpoint_serializer import KeydexCompressedSerializer
from backend.app.agent.state import keydex_messages_delta_reducer


class FullMessagesState(TypedDict, total=False):
    messages: Annotated[list, add_messages]


class DeltaMessagesState(TypedDict, total=False):
    messages: Annotated[
        list,
        DeltaChannel(
            keydex_messages_delta_reducer,
            list,
            snapshot_frequency=3,
        ),
    ]


def _compile_passthrough(state_schema: type[TypedDict], checkpointer):
    builder = StateGraph(state_schema)

    async def keep_state(_state):
        return {}

    builder.add_node("keep", keep_state)
    builder.add_edge(START, "keep")
    builder.add_edge("keep", END)
    return builder.compile(checkpointer=checkpointer)


@asynccontextmanager
async def _store(path: Path) -> AsyncIterator[KeydexAsyncCheckpointStore]:
    serializer = KeydexCompressedSerializer(compression_min_bytes=128)
    connection = await aiosqlite.connect(path)
    saver = AsyncSqliteSaver(connection, serde=serializer)
    await saver.setup()
    store = KeydexAsyncCheckpointStore(saver)
    try:
        yield store
    finally:
        store.begin_closing()
        await connection.close()


def _message_digest(messages: list) -> list[tuple[str | None, str, str]]:
    return [
        (message.id, message.type, str(message.content))
        for message in messages
    ]


@pytest.mark.asyncio
async def test_plain_full_root_can_continue_as_delta_and_restart(tmp_path: Path) -> None:
    path = tmp_path / "checkpoint.db"
    config = {"configurable": {"thread_id": "collapsed", "checkpoint_ns": ""}}
    root_messages = [
        HumanMessage(id="root-human", content="seed-" + ("x" * 1_000)),
        AIMessage(
            id="root-ai",
            content="calling",
            tool_calls=[{"id": "call-1", "name": "lookup", "args": {}}],
        ),
        ToolMessage(id="root-tool", tool_call_id="call-1", content="done"),
    ]

    async with _store(path) as store:
        full_graph = _compile_passthrough(FullMessagesState, store)
        await full_graph.ainvoke({"messages": root_messages}, config=config)
        root_snapshot = await full_graph.aget_state(config)
        root_config = root_snapshot.config

    async with _store(path) as store:
        delta_graph = _compile_passthrough(DeltaMessagesState, store)
        await delta_graph.ainvoke(
            {"messages": [HumanMessage(id="after", content="continue")]},
            config=config,
        )
        latest = await delta_graph.aget_state(config)
        historical_root = await delta_graph.aget_state(root_config)

    assert _message_digest(historical_root.values["messages"]) == _message_digest(
        root_messages
    )
    assert [message.id for message in latest.values["messages"]] == [
        "root-human",
        "root-ai",
        "root-tool",
        "after",
    ]

    with sqlite3.connect(path) as inspection:
        stored_types = {
            row[0]
            for row in inspection.execute(
                "select distinct type from checkpoints"
            )
        }
    assert any(value.startswith("keydex-zstd-v1:") for value in stored_types)


@pytest.mark.asyncio
async def test_delta_updates_remove_all_snapshot_and_time_travel(tmp_path: Path) -> None:
    path = tmp_path / "checkpoint.db"
    config = {"configurable": {"thread_id": "thread", "checkpoint_ns": ""}}

    async with _store(path) as store:
        graph = _compile_passthrough(DeltaMessagesState, store)
        await graph.ainvoke(
            {"messages": [HumanMessage(id="human", content="one")]},
            config=config,
        )
        first = await graph.aget_state(config)
        await graph.ainvoke(
            {"messages": [AIMessage(id="ai", content="two")]},
            config=config,
        )
        await graph.ainvoke(
            {"messages": [HumanMessage(id="human", content="one-updated")]},
            config=config,
        )
        before_compression = await graph.aget_state(config)
        await graph.ainvoke(
            {
                "messages": [
                    RemoveMessage(id=REMOVE_ALL_MESSAGES),
                    HumanMessage(id="summary", content="compressed"),
                ]
            },
            config=config,
        )
        latest = await graph.aget_state(config)
        historical_first = await graph.aget_state(first.config)
        historical_before = await graph.aget_state(before_compression.config)

    assert _message_digest(historical_first.values["messages"]) == [
        ("human", "human", "one")
    ]
    assert _message_digest(historical_before.values["messages"]) == [
        ("human", "human", "one-updated"),
        ("ai", "ai", "two"),
    ]
    assert _message_digest(latest.values["messages"]) == [
        ("summary", "human", "compressed")
    ]
