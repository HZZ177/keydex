from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from backend.app.agent.context_compression_turns import (
    build_compression_turn_manifest,
    build_fallback_turn_summary,
)
from backend.app.agent.context_compression_utils import (
    build_context_compression_replacement_messages,
)
from backend.app.services.context_compression_prompt_builder import build_compaction_prompt


def test_manifest_assigns_one_record_to_every_real_user_turn() -> None:
    messages = [
        HumanMessage(id="u1", content="第一轮问题"),
        AIMessage(id="a1", content="第一轮处理"),
        HumanMessage(
            id="inject-2",
            content="用户引用文件 a.md",
            additional_kwargs={"_injected": True},
        ),
        HumanMessage(id="u2", content="第二轮纠正"),
        AIMessage(id="a2", content="第二轮处理"),
        HumanMessage(id="u3", content="第三轮要求"),
    ]
    manifest = build_compression_turn_manifest(messages)
    assert manifest.expected_record_ids == ("TURN-0001", "TURN-0002", "TURN-0003")
    assert [message.id for message in manifest.segments[1].messages] == [
        "inject-2",
        "u2",
        "a2",
    ]
    prompt = str(build_compaction_prompt(turn_segments=manifest.segments).human_message.content)
    assert 'TURN id="TURN-0001"' in prompt
    assert 'TURN id="TURN-0002"' in prompt
    assert "宿主要求覆盖的 ID（必须逐一输出）" in prompt


def test_repeated_compaction_appends_execution_segment_to_the_same_long_turn() -> None:
    first = build_compression_turn_manifest(
        [HumanMessage(id="u1", content="执行一个长任务"), AIMessage(id="a1", content="阶段一")]
    )
    first_records = [{"id": "TURN-0001", "text": "用户要求执行长任务；Agent 完成阶段一。"}]
    metadata = first.protocol_metadata(first_records, "阶段一结束，继续执行")
    summary_message = build_context_compression_replacement_messages(
        summary="## 逐轮对话与执行记录\n\n### TURN-0001\n\n阶段一",
        boundary_id="b1",
        protocol_metadata=metadata,
    ).replaced_messages[0]

    second = build_compression_turn_manifest(
        [
            summary_message,
            HumanMessage(id="u1", content="执行一个长任务"),
            AIMessage(id="a2", content="阶段二"),
        ]
    )
    assert second.previous_records == tuple(first_records)
    assert second.expected_record_ids == ("TURN-0001/EXEC-0001",)
    assert second.segments[0].kind == "execution"


def test_fallback_record_keeps_user_agent_and_tool_evidence() -> None:
    manifest = build_compression_turn_manifest(
        [HumanMessage(id="u1", content="检查问题"), AIMessage(id="a1", content="检查完成")]
    )
    fallback = build_fallback_turn_summary(manifest.segments[0])
    assert "检查问题" in fallback
    assert "检查完成" in fallback
    assert "宿主从原始消息保底提取" in fallback
