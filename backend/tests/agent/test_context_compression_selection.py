from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from backend.app.agent.context_compression_input import build_compression_prefix_input
from backend.app.agent.context_compression_segments import build_protocol_safe_units
from backend.app.agent.context_compression_selection import (
    POST_COMPACTION_NORMAL_CEILING_TOKENS,
    align_recent_execution_with_structured_groups,
    select_recent_execution_segment,
    select_structured_user_message_groups,
)
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    build_structured_user_message_member,
)


def _group(
    group_id: str,
    text: str,
    *,
    skill: str | None = None,
    complete: bool = True,
) -> StructuredUserMessageGroup:
    root = build_structured_user_message_member(
        "root_user_message",
        0,
        {"content": text, "role": "user", "message_id": f"m-{group_id}"},
    )
    members = []
    if skill:
        members.append(
            build_structured_user_message_member(
                "skill_activation",
                1,
                {"skill_name": skill, "source": "workspace", "origin": "composer"},
            )
        )
    return StructuredUserMessageGroup.create(
        group_id=group_id,
        root_user_message=root,
        members=members,
        completeness="complete" if complete else "incomplete",
        incomplete_reasons=() if complete else ("legacy_missing_members",),
    )


def test_group_selection_makes_latest_complete_group_mandatory() -> None:
    selection = select_structured_user_message_groups(
        [_group("g8", "资料"), _group("g9", "skill", skill="plan"), _group("g10", "@file")],
        preserved_message_ids=["m-g8", "m-g9", "m-g10"],
    )
    assert selection.mandatory_group_ids == ("g10",)
    assert [item.group.group_id for item in selection.candidates_newest_first] == ["g9", "g8"]
    assert selection.candidates_newest_first[0].deferred_replay_reserve == 4_000


def test_historical_group_is_not_replayed_without_a_preserved_complete_turn() -> None:
    selection = select_structured_user_message_groups(
        [_group("g8", "资料"), _group("g9", "skill"), _group("g10", "@file")]
    )
    assert selection.mandatory_group_ids == ("g10",)
    assert selection.candidates_newest_first == ()


def test_incomplete_group_never_authorizes_structured_replay() -> None:
    selection = select_structured_user_message_groups(
        [_group("legacy", "old", complete=False), _group("current", "now")]
    )
    assert selection.mandatory_group_ids == ("current",)
    assert selection.ignored_group_ids == ("legacy",)


def test_mandatory_group_overflow_is_reported_but_not_split() -> None:
    group = _group("huge", "x" * ((POST_COMPACTION_NORMAL_CEILING_TOKENS + 1) * 2))
    selection = select_structured_user_message_groups([group], reserve_estimator=lambda _group: 0)
    assert selection.mandatory is not None
    assert selection.mandatory.group.fingerprint == group.fingerprint
    assert selection.mandatory_group_overflow is True


def test_protocol_unit_keeps_parallel_tool_calls_with_results() -> None:
    messages = [
        HumanMessage(id="u1", content="do it"),
        AIMessage(
            id="a1",
            content="",
            tool_calls=[
                {"id": "c1", "name": "read_file", "args": {"path": "a"}},
                {"id": "c2", "name": "read_file", "args": {"path": "b"}},
            ],
        ),
        ToolMessage(id="t1", content="a", tool_call_id="c1"),
        ToolMessage(id="t2", content="b", tool_call_id="c2"),
        AIMessage(id="a2", content="done"),
    ]
    result = build_protocol_safe_units(messages)
    assert result.valid is True
    assert [unit.kind for unit in result.units] == ["message", "tool_exchange", "message"]
    assert result.units[1].message_ids == ("a1", "t1", "t2")


def test_protocol_unit_rejects_missing_and_orphan_tool_results() -> None:
    missing = build_protocol_safe_units(
        [
            AIMessage(
                content="",
                tool_calls=[{"id": "c1", "name": "read_file", "args": {}}],
            )
        ]
    )
    orphan = build_protocol_safe_units([ToolMessage(content="x", tool_call_id="c1")])
    assert missing.valid is False
    assert missing.failure_reason == "missing_tool_result:c1"
    assert orphan.valid is False
    assert orphan.failure_reason == "orphan_tool_result:c1"


def test_long_single_turn_is_cut_on_protocol_unit_boundary() -> None:
    original = [HumanMessage(id="u1", content="one long job")]
    original.extend(AIMessage(id=f"a{index}", content="x" * 800) for index in range(1, 20))
    before = [message.model_dump() for message in original]
    segment = select_recent_execution_segment(original, target_tokens=1_000)
    prefix = build_compression_prefix_input(original, segment)
    assert segment.cut_index == 0
    assert prefix.messages
    assert set(prefix.source_message_ids).isdisjoint(segment.source_message_ids)
    assert segment.dialogue_turns[0].truncated is True
    assert segment.dialogue_messages[0].id == "u1"
    assert "a1" in prefix.source_message_ids
    assert "a19" in segment.source_message_ids
    assert [message.model_dump() for message in original] == before


def test_large_tool_result_is_truncated_only_in_replacement_copy() -> None:
    source = ToolMessage(id="t1", content="z" * 20_000, tool_call_id="c1")
    messages = [
        HumanMessage(id="u1", content="do a long job"),
        AIMessage(id="progress", content="older progress"),
        AIMessage(
            id="a1",
            content="",
            tool_calls=[{"id": "c1", "name": "read_file", "args": {}}],
        ),
        source,
    ]
    segment = select_recent_execution_segment(messages, target_tokens=500)
    assert "已截断" in str(segment.active_messages[-1].content)
    assert source.content == "z" * 20_000
    assert segment.protocol_unit_overflow is True


def test_recent_selection_preserves_latest_complete_turns_atomically_within_budget() -> None:
    messages = [
        HumanMessage(id="u1", content="第一轮"),
        AIMessage(id="a1", content="第一轮结果"),
        HumanMessage(id="u2", content="第二轮"),
        AIMessage(id="a2", content="第二轮结果"),
        HumanMessage(id="u3", content="第三轮"),
    ]
    segment = select_recent_execution_segment(messages, target_tokens=100)
    assert segment.cut_index == 2
    assert segment.source_message_ids == ("u2", "a2", "u3")
    assert segment.reason == "recent_text_dialogue_and_minimal_active_execution"
    assert [message.id for message in segment.dialogue_messages] == ["u2", "a2"]
    assert [message.id for message in segment.active_messages] == ["u3"]


def test_recent_selection_keeps_dialogue_budget_separate_from_fitting_group_reserves() -> None:
    messages = [
        HumanMessage(id="m-g1", content="第一轮"),
        AIMessage(id="a1", content="第一轮结果"),
        HumanMessage(id="m-g2", content="第二轮"),
        AIMessage(id="a2", content="第二轮结果"),
        HumanMessage(id="m-g3", content="第三轮"),
        AIMessage(id="a3", content="第三轮结果"),
        HumanMessage(id="m-g4", content="第四轮"),
    ]
    groups = [
        _group("g1", "第一轮", skill="plan"),
        _group("g2", "第二轮", skill="plan"),
        _group("g3", "第三轮", skill="plan"),
        _group("g4", "第四轮"),
    ]

    recent, selection = align_recent_execution_with_structured_groups(
        messages,
        groups,
        target_tokens=6_000,
    )

    assert recent.source_message_ids == (
        "m-g2",
        "a2",
        "m-g3",
        "a3",
        "m-g4",
    )
    assert [item.group.group_id for item in selection.selected_costs] == [
        "g2",
        "g3",
        "g4",
    ]
    assert recent.reason == "recent_text_dialogue_and_minimal_active_execution"


def test_group_reserves_trim_oldest_dialogue_only_at_shared_envelope() -> None:
    messages: list[HumanMessage | AIMessage] = []
    groups = []
    for index in range(1, 7):
        messages.extend(
            [
                HumanMessage(id=f"m-g{index}", content=f"第{index}轮"),
                AIMessage(id=f"a{index}", content=f"第{index}轮结果"),
            ]
        )
        groups.append(_group(f"g{index}", f"第{index}轮", skill="plan"))

    recent, selection = align_recent_execution_with_structured_groups(messages, groups)

    assert [item.group.group_id for item in selection.selected_costs] == [
        "g4",
        "g5",
        "g6",
    ]
    assert [message.id for message in recent.dialogue_messages] == [
        "m-g4",
        "a4",
        "m-g5",
        "a5",
        "m-g6",
        "a6",
    ]
    assert recent.reason == "latest_complete_turns_fitted_with_structured_groups"


def test_completed_recent_dialogue_keeps_only_user_and_assistant_visible_text() -> None:
    messages = [
        HumanMessage(id="u0", content="older"),
        AIMessage(id="a0", content="older answer"),
        HumanMessage(id="u1", content="请检查文件"),
        AIMessage(
            id="a1",
            content=[
                {"type": "reasoning", "text": "private chain"},
                {"type": "text", "text": "我先读取相关片段。"},
            ],
            tool_calls=[
                {"id": "c1", "name": "read_file", "args": {"path": "demo.py"}}
            ],
            response_metadata={"provider": "secret"},
            usage_metadata={"input_tokens": 10, "output_tokens": 10, "total_tokens": 20},
        ),
        ToolMessage(id="t1", content="secret tool body", tool_call_id="c1"),
        AIMessage(id="a2", content="检查完成，结论如下。"),
    ]

    segment = select_recent_execution_segment(messages, target_tokens=200)

    assert [type(message) for message in segment.dialogue_messages] == [
        HumanMessage,
        AIMessage,
        AIMessage,
    ]
    assert [str(message.content) for message in segment.dialogue_messages] == [
        "请检查文件",
        "我先读取相关片段。",
        "检查完成，结论如下。",
    ]
    assert all(
        not message.tool_calls
        for message in segment.dialogue_messages
        if isinstance(message, AIMessage)
    )
    assert all(
        not message.response_metadata and message.usage_metadata is None
        for message in segment.dialogue_messages
        if isinstance(message, AIMessage)
    )
    assert not any(isinstance(message, ToolMessage) for message in segment.messages)
    assert segment.stripped_tool_call_count == 1
    assert segment.stripped_tool_result_count == 1


def test_truncated_dialogue_never_leaves_orphan_tool_results_in_prefix() -> None:
    messages = [
        HumanMessage(id="old-u", content="older"),
        AIMessage(id="old-a", content="older answer"),
        HumanMessage(id="u1", content="latest request"),
        AIMessage(
            id="a1",
            content="tool progress " * 1_000,
            tool_calls=[{"id": "c1", "name": "read_file", "args": {}}],
        ),
        ToolMessage(id="t1", content="tool body", tool_call_id="c1"),
        AIMessage(id="a2", content="final answer"),
    ]

    segment = select_recent_execution_segment(messages, target_tokens=500)
    prefix = build_compression_prefix_input(messages, segment)

    assert segment.dialogue_turns[-1].truncated is True
    assert "a1" in segment.source_message_ids
    assert "t1" in segment.source_message_ids
    assert "a1" not in prefix.source_message_ids
    assert "t1" not in prefix.source_message_ids
    assert build_protocol_safe_units(list(prefix.messages)).valid is True


def test_active_execution_keeps_user_root_and_protocol_safe_latest_tool_exchange() -> None:
    messages = [
        HumanMessage(id="old-u", content="older"),
        AIMessage(id="old-a", content="older done"),
        HumanMessage(id="active-u", content="继续执行这个长任务"),
        AIMessage(id="progress", content="中间进度" * 2_000),
        AIMessage(
            id="tool-call",
            content="",
            tool_calls=[{"id": "c1", "name": "read_file", "args": {}}],
        ),
        ToolMessage(id="tool-result", content="z" * 20_000, tool_call_id="c1"),
    ]

    segment = select_recent_execution_segment(messages, target_tokens=100)
    prefix = build_compression_prefix_input(messages, segment)

    assert segment.active_messages[0].id == "active-u"
    assert [message.id for message in segment.active_messages[-2:]] == [
        "tool-call",
        "tool-result",
    ]
    assert "已截断" in str(segment.active_messages[-1].content)
    assert "progress" in prefix.source_message_ids
    assert set(prefix.source_message_ids).isdisjoint(segment.source_message_ids)


def test_single_active_tool_exchange_moves_whole_exchange_to_prefix() -> None:
    messages = [
        HumanMessage(id="active-u", content="执行当前任务"),
        AIMessage(
            id="tool-call",
            content="开始读取",
            tool_calls=[{"id": "c1", "name": "read_file", "args": {}}],
        ),
        ToolMessage(id="tool-result", content="result", tool_call_id="c1"),
    ]

    segment = select_recent_execution_segment(messages)
    prefix = build_compression_prefix_input(messages, segment)

    assert [message.id for message in segment.active_messages] == ["active-u"]
    assert [message.id for message in prefix.messages] == ["tool-call", "tool-result"]
    assert build_protocol_safe_units(list(prefix.messages)).valid is True
