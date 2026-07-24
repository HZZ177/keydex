from __future__ import annotations

from dataclasses import dataclass

import pytest
import zstandard
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    HumanMessage,
    HumanMessageChunk,
    RemoveMessage,
    SystemMessage,
    ToolMessage,
    ToolMessageChunk,
)
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.serde.types import _DeltaSnapshot
from langgraph.graph.message import REMOVE_ALL_MESSAGES
from langgraph.types import Command, Interrupt, Send

from backend.app.agent.checkpoint_serializer import (
    ZSTD_TYPE_PREFIX,
    CheckpointSerializerRejected,
    KeydexCompressedSerializer,
)
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    StructuredUserMessageMember,
)


def _round_trip(serializer: KeydexCompressedSerializer, value):
    return serializer.loads_typed(serializer.dumps_typed(value))


def test_real_keydex_state_types_round_trip() -> None:
    serializer = KeydexCompressedSerializer(compression_min_bytes=64)
    messages = [
        SystemMessage(content="system", id="system-1"),
        HumanMessage(content="hello", id="human-1"),
        AIMessage(
            content="calling",
            id="ai-1",
            tool_calls=[{"name": "read_file", "args": {"path": "a.py"}, "id": "call-1"}],
        ),
        ToolMessage(content="result", tool_call_id="call-1", id="tool-1"),
        HumanMessageChunk(content="chunk"),
        AIMessageChunk(content="chunk"),
        ToolMessageChunk(content="chunk", tool_call_id="call-2"),
        RemoveMessage(id=REMOVE_ALL_MESSAGES),
    ]
    root_member = StructuredUserMessageMember(
        member_kind="root_user_message",
        member_order=0,
        payload={"content": "hello"},
        source_id="message-1",
    )
    group = StructuredUserMessageGroup.create(root_user_message=root_member)
    value = {
        "messages": messages,
        "structured_user_message_groups": [group.to_dict()],
        "structured_user_group_replay_markers": {
            f"boundary:{group.group_id}": {
                "boundary_id": "boundary",
                "group_id": group.group_id,
                "status": "pending",
            }
        },
        "pending_tool_call_preset": {"mode": "force", "tool": "read_file"},
        "context_compression_diagnostics": {"epoch": 2, "tombstones": 1},
        "pending_skill_activations": [{"name": "test-skill"}],
        "attachments": [{"id": "attachment-1", "kind": "image"}],
        "subagent": {"run_id": "run-1", "status": "waiting"},
        "protocol": {
            "send": Send("node", {"value": 1}),
            "command": Command(update={"value": 2}),
            "interrupt": Interrupt(value={"question": "continue?"}, id="interrupt-1"),
        },
    }

    restored = _round_trip(serializer, value)

    assert restored["messages"] == messages
    assert restored["structured_user_message_groups"] == [group.to_dict()]
    assert restored["protocol"]["send"] == value["protocol"]["send"]
    assert restored["protocol"]["command"].update == {"value": 2}
    assert restored["protocol"]["command"].goto == []
    assert restored["protocol"]["interrupt"] == value["protocol"]["interrupt"]


def test_small_payload_keeps_native_tag_and_large_payload_is_compressed() -> None:
    serializer = KeydexCompressedSerializer(
        compression_min_bytes=128,
        min_savings_ratio=0.10,
    )

    small = serializer.dumps_typed({"messages": ["small"]})
    large_value = {
        "messages": [HumanMessage(content="repeated-content-" * 1_000)],
        "snapshot": _DeltaSnapshot(["repeated-value"] * 1_000),
    }
    large = serializer.dumps_typed(large_value)

    assert not small[0].startswith(ZSTD_TYPE_PREFIX)
    assert large[0] == f"{ZSTD_TYPE_PREFIX}msgpack"
    assert serializer.loads_typed(large) == large_value


def test_native_official_payload_remains_readable() -> None:
    official = JsonPlusSerializer(
        pickle_fallback=False,
        allowed_json_modules=(),
        allowed_msgpack_modules=(),
    )
    serializer = KeydexCompressedSerializer()
    payload = official.dumps_typed(
        {"messages": [HumanMessage(content="legacy native", id="message-1")]}
    )

    restored = serializer.loads_typed(payload)

    assert restored["messages"][0].content == "legacy native"


@pytest.mark.parametrize(
    "payload",
    [
        b"not-a-zstd-frame",
        zstandard.ZstdCompressor().compress(b"valid") + b"trailing-data",
        zstandard.ZstdCompressor(write_content_size=False).compress(b"unknown-size"),
    ],
)
def test_corrupt_trailing_and_unknown_size_frames_are_rejected(payload: bytes) -> None:
    serializer = KeydexCompressedSerializer(max_decompressed_bytes=1_024)

    with pytest.raises(CheckpointSerializerRejected) as raised:
        serializer.loads_typed((f"{ZSTD_TYPE_PREFIX}msgpack", payload))

    assert raised.value.code == "checkpoint_serializer_rejected"
    assert payload.hex() not in str(raised.value)


def test_oversized_frame_is_rejected_before_decompression() -> None:
    serializer = KeydexCompressedSerializer(max_decompressed_bytes=64)
    payload = zstandard.ZstdCompressor().compress(b"x" * 65)

    with pytest.raises(CheckpointSerializerRejected):
        serializer.loads_typed((f"{ZSTD_TYPE_PREFIX}bytes", payload))


@dataclass
class DangerousFixture:
    secret: str


def test_unknown_object_is_rejected_on_write_and_native_read() -> None:
    serializer = KeydexCompressedSerializer()
    dangerous = DangerousFixture(secret="must-not-leak")

    with pytest.raises(CheckpointSerializerRejected) as write_error:
        serializer.dumps_typed(dangerous)
    assert "must-not-leak" not in str(write_error.value)

    permissive = JsonPlusSerializer(
        pickle_fallback=False,
        allowed_json_modules=True,
        allowed_msgpack_modules=True,
    )
    native_payload = permissive.dumps_typed(dangerous)
    with pytest.raises(CheckpointSerializerRejected) as read_error:
        serializer.loads_typed(native_payload)
    assert "must-not-leak" not in str(read_error.value)


def test_pickle_and_unknown_type_tags_fail_closed() -> None:
    serializer = KeydexCompressedSerializer()

    with pytest.raises(CheckpointSerializerRejected):
        serializer.loads_typed(("pickle", b"payload"))
    with pytest.raises(CheckpointSerializerRejected):
        serializer.loads_typed(("keydex-zstd-v1:", b"payload"))
