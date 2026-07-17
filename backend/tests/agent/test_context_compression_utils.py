from __future__ import annotations

from langchain_core.messages import HumanMessage, SystemMessage

from backend.app.agent.context_compression_utils import (
    CONTEXT_COMPRESSION_METADATA_KEY,
    LATEST_USER_MESSAGE_SNAPSHOT_MAX_CHARS,
    build_context_compression_replacement_messages,
    build_latest_user_message_snapshot,
    is_context_compression_protocol_message,
    is_context_compression_summary_message,
)


def test_build_replacement_protocol_outputs_single_summary_message() -> None:
    result = build_context_compression_replacement_messages(
        summary="统一压缩摘要",
        source_messages=[
            HumanMessage(content="旧问题", id="h1"),
            HumanMessage(content="最后用户消息", id="h2"),
        ],
        boundary_id="boundary-1",
        tail_message_count=3,
        selected_group_ids=["g9", "g10"],
    )

    assert len(result.replaced_messages) == 1
    summary_message = result.replaced_messages[0]
    assert isinstance(summary_message, HumanMessage)
    assert is_context_compression_summary_message(summary_message)
    assert all(is_context_compression_protocol_message(item) for item in result.replaced_messages)

    summary = str(summary_message.content)
    assert "## 较早历史摘要\n\n统一压缩摘要" in summary
    assert "不是新的用户请求" in summary
    assert "以后续真实用户消息为准" in summary
    assert "以当前事实为准" in summary
    assert "根据摘要" in summary
    assert "无法通过读取文件、查看状态或运行验证自行确认" in summary
    assert "最后用户消息" not in summary
    metadata = summary_message.additional_kwargs[CONTEXT_COMPRESSION_METADATA_KEY]
    assert metadata == {
        "kind": "summary",
        "is_compact_summary": True,
        "schema_version": 1,
        "boundary_id": "boundary-1",
        "prefix_message_count": 2,
        "tail_message_count": 3,
        "selected_group_ids": ["g9", "g10"],
        "source_message_ids": ["h1", "h2"],
    }
    assert result.latest_user_snapshot is None


def test_latest_user_snapshot_textifies_and_truncates_content() -> None:
    long_text = "x" * (LATEST_USER_MESSAGE_SNAPSHOT_MAX_CHARS + 20)

    snapshot = build_latest_user_message_snapshot(
        [
            HumanMessage(
                content=[
                    {"type": "text", "text": long_text},
                    {"type": "image_url", "image_url": {"url": "https://example.test/a.png"}},
                ],
                id="h1",
            )
        ]
    )

    assert snapshot is not None
    assert snapshot.message_id == "h1"
    assert snapshot.truncated is True
    assert "已截断" in snapshot.text
    assert "image_url" not in snapshot.text


def test_old_layered_packet_is_recognized_for_compatibility() -> None:
    legacy = SystemMessage(
        content=(
            '<keydex_context_compression mode="full_replacement">\n'
            "<context_compression:l1>\n旧摘要\n</context_compression:l1>\n"
            "</keydex_context_compression>"
        )
    )

    assert is_context_compression_summary_message(legacy)
    assert is_context_compression_protocol_message(legacy)


def test_compact_summary_is_recognized_by_metadata_not_body_text() -> None:
    message = HumanMessage(
        content="arbitrary body",
        additional_kwargs={
            CONTEXT_COMPRESSION_METADATA_KEY: {
                "kind": "summary",
                "boundary_id": "b1",
            }
        },
    )
    assert is_context_compression_summary_message(message)
