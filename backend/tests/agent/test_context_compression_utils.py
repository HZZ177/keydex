from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from backend.app.agent.context_compression_utils import (
    CONTEXT_COMPRESSION_PACKET_TAG,
    CONTEXT_SUMMARY_TAG,
    LATEST_USER_MESSAGE_SNAPSHOT_MAX_CHARS,
    LATEST_USER_MESSAGE_SNAPSHOT_TAG,
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
            AIMessage(content="旧回答", id="a1"),
            HumanMessage(content="最后用户消息", id="h2"),
            AIMessage(content="最后回答", id="a2"),
        ],
    )

    assert len(result.replaced_messages) == 1
    summary_message = result.replaced_messages[0]
    assert isinstance(summary_message, SystemMessage)
    assert is_context_compression_summary_message(summary_message)
    assert all(is_context_compression_protocol_message(item) for item in result.replaced_messages)

    summary = str(summary_message.content)
    assert summary.startswith(f"<{CONTEXT_COMPRESSION_PACKET_TAG}>")
    assert 'version="' not in summary
    assert f"<{CONTEXT_SUMMARY_TAG}>\n统一压缩摘要\n</{CONTEXT_SUMMARY_TAG}>" in summary
    assert "当前会话正在从一次上下文压缩后的状态继续" in summary
    assert "请优先处理本消息之后出现的真实用户消息" in summary
    assert "如果压缩摘要与后续真实用户消息存在冲突" in summary
    assert "不要向用户说明你正在基于压缩摘要继续" in summary
    assert "请像中断从未发生过一样" in summary
    assert "不要以“我将继续”“根据摘要”“我们之前”等类似表述作为开头" in summary
    assert LATEST_USER_MESSAGE_SNAPSHOT_TAG in summary
    assert 'message_id="h2"' in summary
    assert "最后用户消息" in summary
    assert "最后回答" not in summary
    assert "local-command-caveat" not in summary


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


def test_old_layered_packet_is_not_recognized_as_v3_protocol() -> None:
    legacy = SystemMessage(
        content=(
            '<keydex_context_compression mode="full_replacement">\n'
            "<context_compression:l1>\n旧摘要\n</context_compression:l1>\n"
            "</keydex_context_compression>"
        )
    )

    assert not is_context_compression_summary_message(legacy)
    assert not is_context_compression_protocol_message(legacy)
