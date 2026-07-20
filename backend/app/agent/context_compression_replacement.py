from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import BaseMessage

from backend.app.agent.compact_runtime_attachments import CompactRuntimeAttachment
from backend.app.agent.context_compression_segments import approximate_message_tokens
from backend.app.agent.context_compression_selection import (
    POST_COMPACTION_NORMAL_CEILING_TOKENS,
    POST_COMPACTION_TARGET_TOKENS,
    SUMMARY_ABSOLUTE_MAX_OUTPUT_TOKENS,
    SUMMARY_MIN_CAPACITY_TOKENS,
    SUMMARY_PREFERRED_CAPACITY_TOKENS,
    RecentExecutionSegment,
    StructuredUserGroupSelection,
)
from backend.app.agent.context_compression_utils import (
    build_context_compression_replacement_messages,
    is_context_compression_summary_message,
)
from backend.app.agent.state import CONTEXT_COMPRESSION_DIAGNOSTICS_STATE_KEY
from backend.app.services.structured_user_group_materializer import (
    AttachmentResolver,
    MaterializedStructuredUserGroups,
    SkillValidator,
    StructuredUserGroupMaterializationError,
    StructuredUserGroupMaterializer,
)
from backend.app.services.structured_user_message_group import StructuredUserMessageGroup


@dataclass(frozen=True, slots=True)
class CompressionBudgetPlan:
    mandatory_visible_tokens: int
    deferred_replay_reserve: int
    requested_summary_max_tokens: int
    budget_envelope_tokens: int
    mandatory_group_overflow: bool
    protocol_unit_overflow: bool


@dataclass(frozen=True, slots=True)
class CompressionSelectionReport:
    boundary_id: str
    selected_group_ids: tuple[str, ...]
    candidate_group_ids: tuple[str, ...]
    dropped_components: tuple[dict[str, str], ...]
    prefix_message_count: int
    tail_message_count: int
    replacement_actual_tokens: int
    deferred_replay_reserve: int
    system_tool_estimate_tokens: int
    final_request_estimate_tokens: int
    target_tokens: int
    normal_ceiling_tokens: int
    provider_hard_window_tokens: int
    provider_hard_window_margin: int
    mandatory_group_overflow: bool
    protocol_unit_overflow: bool

    def to_safe_dict(self) -> dict[str, Any]:
        return {
            "boundary_id": self.boundary_id,
            "selected_group_ids": list(self.selected_group_ids),
            "candidate_group_ids": list(self.candidate_group_ids),
            "dropped_components": [dict(item) for item in self.dropped_components],
            "prefix_message_count": self.prefix_message_count,
            "tail_message_count": self.tail_message_count,
            "replacement_actual_tokens": self.replacement_actual_tokens,
            "deferred_replay_reserve": self.deferred_replay_reserve,
            "system_tool_estimate_tokens": self.system_tool_estimate_tokens,
            "final_request_estimate_tokens": self.final_request_estimate_tokens,
            "target_tokens": self.target_tokens,
            "normal_ceiling_tokens": self.normal_ceiling_tokens,
            "provider_hard_window_tokens": self.provider_hard_window_tokens,
            "provider_hard_window_margin": self.provider_hard_window_margin,
            "mandatory_group_overflow": self.mandatory_group_overflow,
            "protocol_unit_overflow": self.protocol_unit_overflow,
        }


@dataclass(frozen=True, slots=True)
class CompressionReplacementBuildResult:
    success: bool
    messages: tuple[BaseMessage, ...]
    state_update: dict[str, Any]
    materialized_groups: MaterializedStructuredUserGroups | None
    report: CompressionSelectionReport
    failure_reason: str | None = None


def calculate_dynamic_summary_max_tokens(
    *,
    mandatory_visible_tokens: int,
    deferred_replay_reserve: int,
) -> int:
    mandatory = max(mandatory_visible_tokens, 0) + max(deferred_replay_reserve, 0)
    target_available = POST_COMPACTION_TARGET_TOKENS - mandatory
    if target_available >= SUMMARY_PREFERRED_CAPACITY_TOKENS:
        return SUMMARY_PREFERRED_CAPACITY_TOKENS
    if target_available >= SUMMARY_MIN_CAPACITY_TOKENS:
        return min(target_available, SUMMARY_ABSOLUTE_MAX_OUTPUT_TOKENS)
    ceiling_available = POST_COMPACTION_NORMAL_CEILING_TOKENS - mandatory
    if ceiling_available >= SUMMARY_MIN_CAPACITY_TOKENS:
        return min(ceiling_available, SUMMARY_ABSOLUTE_MAX_OUTPUT_TOKENS)
    return SUMMARY_MIN_CAPACITY_TOKENS


def plan_compression_budget(
    *,
    group_selection: StructuredUserGroupSelection,
    recent_execution: RecentExecutionSegment,
    plan_attachment: CompactRuntimeAttachment | None,
) -> CompressionBudgetPlan:
    group_visible = sum(item.visible_tokens for item in group_selection.selected_costs)
    reserve = sum(
        item.deferred_replay_reserve for item in group_selection.selected_costs
    )
    plan_tokens = plan_attachment.approximate_tokens if plan_attachment else 0
    mandatory_visible = group_visible + recent_execution.approximate_tokens + plan_tokens
    requested = calculate_dynamic_summary_max_tokens(
        mandatory_visible_tokens=mandatory_visible,
        deferred_replay_reserve=reserve,
    )
    envelope = (
        POST_COMPACTION_TARGET_TOKENS
        if mandatory_visible + reserve + requested <= POST_COMPACTION_TARGET_TOKENS
        else POST_COMPACTION_NORMAL_CEILING_TOKENS
    )
    return CompressionBudgetPlan(
        mandatory_visible_tokens=mandatory_visible,
        deferred_replay_reserve=reserve,
        requested_summary_max_tokens=requested,
        budget_envelope_tokens=envelope,
        mandatory_group_overflow=group_selection.mandatory_group_overflow,
        protocol_unit_overflow=recent_execution.protocol_unit_overflow,
    )


def build_compression_replacement(
    *,
    summary: str,
    boundary_id: str,
    prefix_messages: list[BaseMessage],
    summary_protocol_metadata: dict[str, Any] | None = None,
    all_groups: Iterable[StructuredUserMessageGroup | dict[str, Any]],
    group_selection: StructuredUserGroupSelection,
    recent_execution: RecentExecutionSegment,
    plan_attachment: CompactRuntimeAttachment | None = None,
    recent_attachments: Iterable[CompactRuntimeAttachment] = (),
    pre_dropped_components: Iterable[dict[str, str]] = (),
    materializer: StructuredUserGroupMaterializer | None = None,
    skill_validator: SkillValidator | None = None,
    attachment_resolver: AttachmentResolver | None = None,
    system_tool_estimate_tokens: int = 0,
    provider_hard_window_tokens: int = 256_000,
    token_estimator: Callable[[BaseMessage], int] = approximate_message_tokens,
) -> CompressionReplacementBuildResult:
    normalized_groups = [
        (
            item
            if isinstance(item, StructuredUserMessageGroup)
            else StructuredUserMessageGroup.from_dict(item)
        )
        for item in all_groups
    ]
    selected_costs = list(group_selection.selected_costs)

    summary_result = build_context_compression_replacement_messages(
        summary=summary,
        source_messages=prefix_messages,
        boundary_id=boundary_id,
        prefix_message_count=len(prefix_messages),
        tail_message_count=len(recent_execution.messages),
        selected_group_ids=[cost.group.group_id for cost in selected_costs],
        protocol_metadata=summary_protocol_metadata,
    )
    summary_message = summary_result.replaced_messages[0]
    summary_tokens = token_estimator(summary_message)
    mandatory_visible = (
        summary_tokens
        + recent_execution.approximate_tokens
        + sum(item.visible_tokens for item in selected_costs)
        + (plan_attachment.approximate_tokens if plan_attachment else 0)
    )
    reserve = (
        sum(item.deferred_replay_reserve for item in selected_costs)
    )
    envelope = (
        POST_COMPACTION_TARGET_TOKENS
        if mandatory_visible + reserve <= POST_COMPACTION_TARGET_TOKENS
        else POST_COMPACTION_NORMAL_CEILING_TOKENS
    )
    dropped: list[dict[str, str]] = [
        {
            "kind": str(item.get("kind") or "unknown"),
            "reason": str(item.get("reason") or "unknown"),
        }
        for item in pre_dropped_components
    ]
    selected_group_id_set = {cost.group.group_id for cost in selected_costs}
    selected_group_ids = [
        group.group_id
        for group in normalized_groups
        if group.group_id in selected_group_id_set
    ]
    try:
        materialized = (materializer or StructuredUserGroupMaterializer()).materialize(
            groups=normalized_groups,
            selected_group_ids=selected_group_ids,
            boundary_id=boundary_id,
            tail_message_ids=recent_execution.source_message_ids,
            tail_messages=recent_execution.messages,
            skill_validator=skill_validator,
            attachment_resolver=attachment_resolver,
        )
    except StructuredUserGroupMaterializationError as exc:
        report = _report(
            boundary_id=boundary_id,
            selected_group_ids=selected_group_ids,
            group_selection=group_selection,
            dropped=dropped,
            prefix_count=len(prefix_messages),
            tail_count=len(recent_execution.messages),
            replacement_tokens=0,
            reserve=reserve,
            system_tool_estimate=system_tool_estimate_tokens,
            provider_window=provider_hard_window_tokens,
            recent_execution=recent_execution,
        )
        return CompressionReplacementBuildResult(
            success=False,
            messages=(),
            state_update={},
            materialized_groups=None,
            report=report,
            failure_reason=f"materialize_failed:{exc.code}",
        )

    summary_result = build_context_compression_replacement_messages(
        summary=summary,
        source_messages=prefix_messages,
        boundary_id=boundary_id,
        prefix_message_count=len(prefix_messages),
        tail_message_count=len(recent_execution.messages),
        selected_group_ids=selected_group_ids,
        protocol_metadata=summary_protocol_metadata,
    )
    replacement_before_tail: list[BaseMessage] = [
        *summary_result.replaced_messages,
        *materialized.messages,
    ]
    if plan_attachment is not None:
        replacement_before_tail.append(plan_attachment.message)
    replacement_tokens = sum(
        token_estimator(message)
        for message in _deduplicate_messages(
            [*replacement_before_tail, *recent_execution.messages]
        )
    )

    for attachment in recent_attachments:
        if replacement_tokens + reserve + attachment.approximate_tokens > envelope:
            dropped.append({"kind": attachment.kind, "reason": "shared_budget_exhausted"})
            continue
        replacement_before_tail.append(attachment.message)
        replacement_tokens += attachment.approximate_tokens

    replacement = _deduplicate_messages(
        [*replacement_before_tail, *recent_execution.messages]
    )
    replacement = _ensure_single_summary_first(replacement)
    replacement_tokens = sum(token_estimator(message) for message in replacement)
    report = _report(
        boundary_id=boundary_id,
        selected_group_ids=selected_group_ids,
        group_selection=group_selection,
        dropped=dropped,
        prefix_count=len(prefix_messages),
        tail_count=len(recent_execution.messages),
        replacement_tokens=replacement_tokens,
        reserve=reserve,
        system_tool_estimate=system_tool_estimate_tokens,
        provider_window=provider_hard_window_tokens,
        recent_execution=recent_execution,
    )
    if report.provider_hard_window_margin < 0:
        return CompressionReplacementBuildResult(
            success=False,
            messages=(),
            state_update={},
            materialized_groups=None,
            report=report,
            failure_reason="provider_hard_window_exceeded",
        )
    state_update = dict(materialized.state_update)
    state_update[CONTEXT_COMPRESSION_DIAGNOSTICS_STATE_KEY] = {
        **report.to_safe_dict(),
        "deferred_replay_actual_tokens": 0,
        "deferred_replay_delta_tokens": -report.deferred_replay_reserve,
        "materialization_status": "pending",
    }
    return CompressionReplacementBuildResult(
        success=True,
        messages=tuple(replacement),
        state_update=state_update,
        materialized_groups=materialized,
        report=report,
    )


def _deduplicate_messages(messages: list[BaseMessage]) -> list[BaseMessage]:
    result: list[BaseMessage] = []
    seen_ids: set[str] = set()
    seen_member_fingerprints: set[str] = set()
    for message in messages:
        message_id = str(getattr(message, "id", "") or "")
        metadata = getattr(message, "additional_kwargs", {}).get(
            "keydex_structured_user_group"
        )
        member_fingerprint = (
            str(metadata.get("member_fingerprint") or "") if isinstance(metadata, dict) else ""
        )
        if message_id and message_id in seen_ids:
            continue
        if member_fingerprint and member_fingerprint in seen_member_fingerprints:
            continue
        if message_id:
            seen_ids.add(message_id)
        if member_fingerprint:
            seen_member_fingerprints.add(member_fingerprint)
        result.append(message)
    return result


def _ensure_single_summary_first(messages: list[BaseMessage]) -> list[BaseMessage]:
    summaries = [message for message in messages if is_context_compression_summary_message(message)]
    if len(summaries) != 1:
        raise ValueError("replacement 必须恰好包含一条 compact summary")
    return [summaries[0], *[message for message in messages if message is not summaries[0]]]


def _report(
    *,
    boundary_id: str,
    selected_group_ids: list[str],
    group_selection: StructuredUserGroupSelection,
    dropped: list[dict[str, str]],
    prefix_count: int,
    tail_count: int,
    replacement_tokens: int,
    reserve: int,
    system_tool_estimate: int,
    provider_window: int,
    recent_execution: RecentExecutionSegment,
) -> CompressionSelectionReport:
    final_estimate = replacement_tokens + reserve + max(system_tool_estimate, 0)
    return CompressionSelectionReport(
        boundary_id=boundary_id,
        selected_group_ids=tuple(selected_group_ids),
        candidate_group_ids=tuple(
            item.group.group_id for item in group_selection.candidates_newest_first
        ),
        dropped_components=tuple(dict(item) for item in dropped),
        prefix_message_count=prefix_count,
        tail_message_count=tail_count,
        replacement_actual_tokens=replacement_tokens,
        deferred_replay_reserve=reserve,
        system_tool_estimate_tokens=max(system_tool_estimate, 0),
        final_request_estimate_tokens=final_estimate,
        target_tokens=POST_COMPACTION_TARGET_TOKENS,
        normal_ceiling_tokens=POST_COMPACTION_NORMAL_CEILING_TOKENS,
        provider_hard_window_tokens=max(provider_window, 1),
        provider_hard_window_margin=max(provider_window, 1) - final_estimate,
        mandatory_group_overflow=group_selection.mandatory_group_overflow,
        protocol_unit_overflow=recent_execution.protocol_unit_overflow,
    )
