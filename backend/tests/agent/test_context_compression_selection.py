from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from backend.app.agent.context_compression_input import build_compression_prefix_input
from backend.app.agent.context_compression_segments import build_protocol_safe_units
from backend.app.agent.context_compression_selection import (
    POST_COMPACTION_NORMAL_CEILING_TOKENS,
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
        [_group("g8", "资料"), _group("g9", "skill", skill="plan"), _group("g10", "@file")]
    )
    assert selection.mandatory_group_ids == ("g10",)
    assert [item.group.group_id for item in selection.candidates_newest_first] == ["g9", "g8"]
    assert selection.candidates_newest_first[0].deferred_replay_reserve == 4_000


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
    assert 0 < segment.cut_index < len(original)
    assert prefix.messages
    assert set(prefix.source_message_ids).isdisjoint(segment.source_message_ids)
    assert [message.model_dump() for message in original] == before


def test_large_tool_result_is_truncated_only_in_replacement_copy() -> None:
    source = ToolMessage(id="t1", content="z" * 20_000, tool_call_id="c1")
    messages = [
        AIMessage(
            id="a1",
            content="",
            tool_calls=[{"id": "c1", "name": "read_file", "args": {}}],
        ),
        source,
    ]
    segment = select_recent_execution_segment(messages, target_tokens=500)
    assert "已截断" in str(segment.messages[1].content)
    assert source.content == "z" * 20_000
    assert segment.protocol_unit_overflow is True
