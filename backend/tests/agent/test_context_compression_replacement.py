from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage

from backend.app.agent.compact_runtime_attachments import CompactRuntimeAttachment
from backend.app.agent.context_compression_replacement import (
    build_compression_replacement,
    calculate_dynamic_summary_max_tokens,
    plan_compression_budget,
)
from backend.app.agent.context_compression_selection import (
    select_recent_execution_segment,
    select_structured_user_message_groups,
)
from backend.app.agent.context_compression_utils import (
    is_context_compression_summary_message,
)
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    build_structured_user_message_member,
)


def _group(group_id: str, text: str) -> StructuredUserMessageGroup:
    return StructuredUserMessageGroup.create(
        group_id=group_id,
        root_user_message=build_structured_user_message_member(
            "root_user_message",
            0,
            {"content": text, "message_id": f"m-{group_id}", "role": "HumanMessage"},
            source_id=f"m-{group_id}",
        ),
    )


def _recent_segment():
    return select_recent_execution_segment(
        [
            HumanMessage(id="old", content="old request"),
            AIMessage(id="old-a", content="old answer"),
            AIMessage(id="tail-a", content="current work"),
        ],
        target_tokens=5,
    )


def test_dynamic_summary_capacity_uses_target_then_normal_ceiling() -> None:
    assert calculate_dynamic_summary_max_tokens(
        mandatory_visible_tokens=0, deferred_replay_reserve=0
    ) == 12_000
    assert calculate_dynamic_summary_max_tokens(
        mandatory_visible_tokens=10_000, deferred_replay_reserve=0
    ) == 10_000
    assert calculate_dynamic_summary_max_tokens(
        mandatory_visible_tokens=15_000, deferred_replay_reserve=0
    ) == 9_000
    assert calculate_dynamic_summary_max_tokens(
        mandatory_visible_tokens=30_000, deferred_replay_reserve=0
    ) == 8_000


def test_budget_plan_counts_latest_group_plan_tail_and_deferred_reserve() -> None:
    selection = select_structured_user_message_groups(
        [_group("g1", "now")], reserve_estimator=lambda _group: 1_500
    )
    recent = _recent_segment()
    plan_message = HumanMessage(content="plan")
    attachment = CompactRuntimeAttachment(
        kind="plan_snapshot",
        message=plan_message,
        approximate_tokens=800,
        source_tool_call_ids=("p1",),
        optional=False,
    )
    budget = plan_compression_budget(
        group_selection=selection,
        recent_execution=recent,
        plan_attachment=attachment,
    )
    assert budget.mandatory_visible_tokens >= 800 + recent.approximate_tokens
    assert budget.deferred_replay_reserve == 1_500
    assert 8_000 <= budget.requested_summary_max_tokens <= 12_000


def test_replacement_has_one_summary_then_groups_attachments_and_tail() -> None:
    groups = [_group("g8", "资料"), _group("g9", "skill"), _group("g10", "@file")]
    selection = select_structured_user_message_groups(groups, reserve_estimator=lambda _group: 0)
    recent = _recent_segment()
    runtime_attachment = CompactRuntimeAttachment(
        kind="recent_read_manifest",
        message=HumanMessage(content="manifest", id="manifest"),
        approximate_tokens=5,
        source_tool_call_ids=("r1",),
        optional=True,
    )
    result = build_compression_replacement(
        summary="详细摘要",
        boundary_id="b1",
        prefix_messages=[HumanMessage(id="prefix", content="first goal")],
        all_groups=groups,
        group_selection=selection,
        recent_execution=recent,
        recent_attachments=[runtime_attachment],
    )
    assert result.success is True
    summaries = [item for item in result.messages if is_context_compression_summary_message(item)]
    assert len(summaries) == 1
    assert result.messages[0] is summaries[0]
    visible = [str(message.content) for message in result.messages]
    assert visible.index("资料") < visible.index("manifest")
    assert visible.index("manifest") < visible.index("current work")
    assert result.report.selected_group_ids == ("g8", "g9", "g10")
    assert visible.index("资料") < visible.index("skill") < visible.index("@file")
    assert result.report.replacement_actual_tokens + result.report.deferred_replay_reserve <= 20_000


def test_replacement_accepts_normal_soft_overflow_between_target_and_ceiling() -> None:
    groups = [_group("mandatory", "now")]

    def estimator(message) -> int:
        return 21_000 if is_context_compression_summary_message(message) else 1

    result = build_compression_replacement(
        summary="summary",
        boundary_id="b-soft-overflow",
        prefix_messages=[HumanMessage(content="prefix")],
        all_groups=groups,
        group_selection=select_structured_user_message_groups(groups),
        recent_execution=select_recent_execution_segment([], target_tokens=10),
        token_estimator=estimator,
    )

    assert result.success is True
    total = result.report.replacement_actual_tokens + result.report.deferred_replay_reserve
    assert 20_000 < total <= 24_000


def test_newer_candidate_that_does_not_fit_stops_selection_without_skipping() -> None:
    groups = [
        _group("old-small", "old"),
        _group("new-huge", "x" * 50_000),
        _group("mandatory", "now"),
    ]
    selection = select_structured_user_message_groups(groups, reserve_estimator=lambda _group: 0)
    result = build_compression_replacement(
        summary="summary",
        boundary_id="b1",
        prefix_messages=[HumanMessage(content="prefix")],
        all_groups=groups,
        group_selection=selection,
        recent_execution=select_recent_execution_segment([], target_tokens=10),
    )
    assert result.success is True
    assert result.report.selected_group_ids == ("mandatory",)
    assert "old-small" not in result.report.selected_group_ids


def test_provider_hard_window_failure_returns_no_partial_state() -> None:
    groups = [_group("g1", "now")]
    result = build_compression_replacement(
        summary="summary",
        boundary_id="b1",
        prefix_messages=[HumanMessage(content="prefix")],
        all_groups=groups,
        group_selection=select_structured_user_message_groups(groups),
        recent_execution=select_recent_execution_segment([], target_tokens=10),
        system_tool_estimate_tokens=100,
        provider_hard_window_tokens=10,
    )
    assert result.success is False
    assert result.failure_reason == "provider_hard_window_exceeded"
    assert result.messages == ()
    assert result.state_update == {}


def test_selection_report_never_contains_message_or_file_bodies() -> None:
    groups = [_group("g1", "sensitive body")]
    result = build_compression_replacement(
        summary="secret summary",
        boundary_id="b1",
        prefix_messages=[HumanMessage(content="prefix secret")],
        all_groups=groups,
        group_selection=select_structured_user_message_groups(groups),
        recent_execution=select_recent_execution_segment([], target_tokens=10),
    )
    safe = str(result.report.to_safe_dict())
    assert "sensitive body" not in safe
    assert "secret summary" not in safe
    assert "prefix secret" not in safe


def test_mixed_rounds_keep_only_fitting_groups_in_original_chronology() -> None:
    groups = [
        _group("g8", "资料" * 30_000),
        _group("g9", "skill"),
        _group("g10", "@file"),
    ]
    result = build_compression_replacement(
        summary="summary",
        boundary_id="mixed-boundary",
        prefix_messages=[HumanMessage(content="prefix")],
        all_groups=groups,
        group_selection=select_structured_user_message_groups(
            groups, reserve_estimator=lambda _group: 0
        ),
        recent_execution=select_recent_execution_segment([], target_tokens=10),
    )
    assert result.success is True
    assert result.report.selected_group_ids == ("g9", "g10")
    visible = [str(message.content) for message in result.messages]
    assert "资料" * 30_000 not in visible
    assert visible.index("skill") < visible.index("@file")
    assert result.report.dropped_components == (
        {"kind": "structured_user_group", "reason": "shared_budget_exhausted"},
    )


def test_pre_dropped_recent_file_reason_is_preserved_without_sensitive_body() -> None:
    groups = [_group("g1", "now")]
    result = build_compression_replacement(
        summary="summary",
        boundary_id="drop-boundary",
        prefix_messages=[HumanMessage(content="prefix")],
        all_groups=groups,
        group_selection=select_structured_user_message_groups(groups),
        recent_execution=select_recent_execution_segment([], target_tokens=10),
        pre_dropped_components=[
            {"kind": "recent_read_snippet", "reason": "read_denied_or_missing"}
        ],
    )
    assert result.success is True
    assert result.report.dropped_components == (
        {"kind": "recent_read_snippet", "reason": "read_denied_or_missing"},
    )


def test_oversized_mandatory_group_succeeds_only_when_final_hard_window_fits() -> None:
    groups = [_group("mandatory", "x" * 60_000)]
    selection = select_structured_user_message_groups(
        groups, reserve_estimator=lambda _group: 0
    )
    success = build_compression_replacement(
        summary="summary",
        boundary_id="mandatory-success",
        prefix_messages=[HumanMessage(content="prefix")],
        all_groups=groups,
        group_selection=selection,
        recent_execution=select_recent_execution_segment([], target_tokens=10),
        provider_hard_window_tokens=100_000,
    )
    assert success.success is True
    assert success.report.mandatory_group_overflow is True
    assert success.report.replacement_actual_tokens > 24_000
    assert success.report.provider_hard_window_margin > 0

    failure = build_compression_replacement(
        summary="summary",
        boundary_id="mandatory-failure",
        prefix_messages=[HumanMessage(content="prefix")],
        all_groups=groups,
        group_selection=selection,
        recent_execution=select_recent_execution_segment([], target_tokens=10),
        provider_hard_window_tokens=10_000,
    )
    assert failure.success is False
    assert failure.failure_reason == "provider_hard_window_exceeded"
    assert failure.messages == ()
    assert failure.state_update == {}
