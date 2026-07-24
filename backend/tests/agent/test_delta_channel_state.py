from __future__ import annotations

from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    RemoveMessage,
)
from langgraph.graph.message import REMOVE_ALL_MESSAGES, add_messages

from backend.app.agent.state import (
    create_messages_delta_channel,
    keydex_messages_delta_reducer,
)
from backend.app.core.config import AppSettings


def test_message_delta_reducer_matches_ordered_add_messages_oracle() -> None:
    original = [HumanMessage(id="human", content="before")]
    writes = [
        [AIMessage(id="assistant", content="answer")],
        [HumanMessage(id="human", content="updated")],
        [AIMessageChunk(id="stream", content="chunk")],
        [RemoveMessage(id="assistant")],
    ]

    expected = list(original)
    for write in writes:
        expected = add_messages(expected, write)

    assert keydex_messages_delta_reducer(original, writes) == expected
    assert keydex_messages_delta_reducer(original, []) == original


def test_message_delta_reducer_remove_all_then_replacement() -> None:
    result = keydex_messages_delta_reducer(
        [
            HumanMessage(id="old-human", content="old"),
            AIMessage(id="old-ai", content="old"),
        ],
        [
            [RemoveMessage(id=REMOVE_ALL_MESSAGES)],
            [HumanMessage(id="summary", content="compressed")],
        ],
    )

    assert [(message.id, message.content) for message in result] == [
        ("summary", "compressed")
    ]


def test_delta_snapshot_frequency_is_configurable() -> None:
    settings = AppSettings(
        checkpoint_delta_snapshot_frequency=128,
        _env_file=None,
    )

    assert settings.checkpoint_delta_snapshot_frequency == 128
    assert create_messages_delta_channel(32).snapshot_frequency == 32
