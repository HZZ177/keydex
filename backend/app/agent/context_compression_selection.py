from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from langchain_core.messages import BaseMessage, ToolMessage

from backend.app.agent.context_compression_segments import (
    CompressionProtocolUnit,
    approximate_message_tokens,
    build_protocol_safe_units,
    truncate_completed_tool_result,
)
from backend.app.agent.context_compression_turns import build_raw_conversation_bundles
from backend.app.services.structured_user_message_group import StructuredUserMessageGroup

POST_COMPACTION_TARGET_TOKENS = 20_000
POST_COMPACTION_NORMAL_CEILING_TOKENS = 24_000
SUMMARY_ABSOLUTE_MAX_OUTPUT_TOKENS = 20_000
SUMMARY_PREFERRED_CAPACITY_TOKENS = 12_000
SUMMARY_MIN_CAPACITY_TOKENS = 8_000
RECENT_EXECUTION_TARGET_TOKENS = 6_000

GroupReserveEstimator = Callable[[StructuredUserMessageGroup], int]


@dataclass(frozen=True, slots=True)
class StructuredUserGroupCost:
    group: StructuredUserMessageGroup
    visible_tokens: int
    deferred_replay_reserve: int

    @property
    def atomic_tokens(self) -> int:
        return self.visible_tokens + self.deferred_replay_reserve


@dataclass(frozen=True, slots=True)
class StructuredUserGroupSelection:
    mandatory: StructuredUserGroupCost | None
    candidates_newest_first: tuple[StructuredUserGroupCost, ...]
    ignored_group_ids: tuple[str, ...]
    mandatory_group_overflow: bool

    @property
    def mandatory_group_ids(self) -> tuple[str, ...]:
        return (self.mandatory.group.group_id,) if self.mandatory else ()

    @property
    def selected_costs(self) -> tuple[StructuredUserGroupCost, ...]:
        if self.mandatory is None:
            return ()
        return (*reversed(self.candidates_newest_first), self.mandatory)


@dataclass(frozen=True, slots=True)
class RecentExecutionSegment:
    cut_index: int
    messages: tuple[BaseMessage, ...]
    source_message_ids: tuple[str, ...]
    protocol_units: tuple[CompressionProtocolUnit, ...]
    approximate_tokens: int
    reason: str
    protocol_unit_overflow: bool = False
    failure_reason: str | None = None


def estimate_structured_user_group_visible_tokens(group: StructuredUserMessageGroup) -> int:
    visible = 0
    for member in group.ordered_members:
        if member.member_kind in {
            "root_user_message",
            "message_injection_follow",
            "message_injection_slot",
        }:
            visible += max(len(json.dumps(member.payload, ensure_ascii=False)) // 2 + 3, 1)
    return visible


def estimate_structured_user_group_deferred_reserve(
    group: StructuredUserMessageGroup,
) -> int:
    reserve = 0
    for member in group.ordered_members:
        if member.member_kind == "skill_activation":
            reserve += 4_000
        elif member.member_kind in {"attachment", "image_attachment"}:
            size = int(member.payload.get("size") or 0)
            reserve += min(max((size + 3) // 4, 256), 8_000)
    return reserve


def select_structured_user_message_groups(
    groups: Iterable[StructuredUserMessageGroup | dict],
    *,
    reserve_estimator: GroupReserveEstimator = estimate_structured_user_group_deferred_reserve,
    preserved_message_ids: Iterable[str] = (),
) -> StructuredUserGroupSelection:
    normalized: list[StructuredUserMessageGroup] = []
    ignored: list[str] = []
    for item in groups:
        try:
            group = item if isinstance(item, StructuredUserMessageGroup) else (
                StructuredUserMessageGroup.from_dict(item)
            )
        except (TypeError, ValueError):
            continue
        if not group.is_authorizable:
            ignored.append(group.group_id)
            continue
        normalized.append(group)

    if not normalized:
        return StructuredUserGroupSelection(None, (), tuple(ignored), False)

    costs = [
        StructuredUserGroupCost(
            group=group,
            visible_tokens=estimate_structured_user_group_visible_tokens(group),
            deferred_replay_reserve=max(int(reserve_estimator(group)), 0),
        )
        for group in normalized
    ]
    mandatory = costs[-1]
    preserved_ids = {str(item) for item in preserved_message_ids if str(item)}
    replayable_older = [
        cost
        for cost in costs[:-1]
        if _structured_group_root_message_id(cost.group) in preserved_ids
    ]
    return StructuredUserGroupSelection(
        mandatory=mandatory,
        candidates_newest_first=tuple(reversed(replayable_older)),
        ignored_group_ids=tuple(ignored),
        mandatory_group_overflow=mandatory.atomic_tokens > POST_COMPACTION_NORMAL_CEILING_TOKENS,
    )


def align_recent_execution_with_structured_groups(
    messages: list[BaseMessage],
    groups: Iterable[StructuredUserMessageGroup | dict],
    *,
    recent_execution: RecentExecutionSegment | None = None,
    target_tokens: int = RECENT_EXECUTION_TARGET_TOKENS,
    reserve_estimator: GroupReserveEstimator = estimate_structured_user_group_deferred_reserve,
) -> tuple[RecentExecutionSegment, StructuredUserGroupSelection]:
    """Keep complete recent turns and their replay side effects inside one atomic budget."""

    normalized_groups = tuple(groups)
    target = max(int(target_tokens), 1)
    recent = recent_execution or select_recent_execution_segment(
        messages,
        target_tokens=target,
    )
    while True:
        selection = select_structured_user_message_groups(
            normalized_groups,
            reserve_estimator=reserve_estimator,
            preserved_message_ids=recent.source_message_ids,
        )
        older_group_tokens = sum(
            item.atomic_tokens for item in selection.candidates_newest_first
        )
        if recent.approximate_tokens + older_group_tokens <= target:
            return recent, selection
        trimmed = _drop_oldest_complete_turn(
            messages,
            recent,
            target_tokens=target,
        )
        if trimmed is None:
            return recent, selection
        recent = trimmed


def select_recent_execution_segment(
    messages: list[BaseMessage],
    *,
    target_tokens: int = RECENT_EXECUTION_TARGET_TOKENS,
) -> RecentExecutionSegment:
    unit_result = build_protocol_safe_units(messages)
    if not unit_result.valid:
        return RecentExecutionSegment(
            cut_index=len(messages),
            messages=(),
            source_message_ids=(),
            protocol_units=(),
            approximate_tokens=0,
            reason="invalid_protocol_history",
            failure_reason=unit_result.failure_reason,
        )
    if not unit_result.units:
        return RecentExecutionSegment(0, (), (), (), 0, "empty_history")

    target = max(target_tokens, 1)
    bundles = build_raw_conversation_bundles(messages)
    selected: list[CompressionProtocolUnit] = []
    total = 0
    latest_bundle = bundles[-1]
    if latest_bundle.start_index > 0 and latest_bundle.approximate_tokens <= target:
        selected = [
            unit
            for unit in unit_result.units
            if unit.start_index >= latest_bundle.start_index
        ]
        total = sum(unit.approximate_tokens for unit in selected)
        for bundle in reversed(bundles[:-1]):
            if not bundle.has_real_user_root or bundle.start_index <= 0:
                continue
            if total + bundle.approximate_tokens > target:
                break
            prepend = [
                unit
                for unit in unit_result.units
                if bundle.start_index <= unit.start_index < bundle.end_index
            ]
            selected = [*prepend, *selected]
            total += bundle.approximate_tokens
    else:
        for unit in reversed(unit_result.units):
            if unit.start_index < latest_bundle.start_index:
                break
            if len(unit_result.units) > 1 and len(selected) >= len(unit_result.units) - 1:
                break
            if selected and total >= target:
                break
            selected.append(unit)
            total += unit.approximate_tokens
        selected.reverse()

    if not selected:
        selected = [unit_result.units[-1]]
    if len(unit_result.units) > 1 and len(selected) >= len(unit_result.units):
        selected = selected[1:]
    if not selected:
        return RecentExecutionSegment(
            cut_index=len(messages),
            messages=(),
            source_message_ids=(),
            protocol_units=(),
            approximate_tokens=0,
            reason="no_compressible_prefix",
        )
    return _recent_execution_from_units(
        selected,
        target_tokens=target,
        reason="latest_complete_turns_and_active_execution",
    )


def _drop_oldest_complete_turn(
    messages: list[BaseMessage],
    recent_execution: RecentExecutionSegment,
    *,
    target_tokens: int,
) -> RecentExecutionSegment | None:
    selected_bundles = [
        bundle
        for bundle in build_raw_conversation_bundles(messages)
        if bundle.has_real_user_root and bundle.start_index >= recent_execution.cut_index
    ]
    if len(selected_bundles) <= 1:
        return None
    new_cut_index = selected_bundles[1].start_index
    units = [
        unit
        for unit in recent_execution.protocol_units
        if unit.start_index >= new_cut_index
    ]
    if not units:
        return None
    return _recent_execution_from_units(
        units,
        target_tokens=target_tokens,
        reason="latest_complete_turns_fitted_with_structured_groups",
    )


def _recent_execution_from_units(
    units: Iterable[CompressionProtocolUnit],
    *,
    target_tokens: int,
    reason: str,
) -> RecentExecutionSegment:
    selected = tuple(units)
    target = max(int(target_tokens), 1)
    cut_index = selected[0].start_index
    replacement_messages: list[BaseMessage] = []
    for unit in selected:
        for message in unit.messages:
            if isinstance(message, ToolMessage) and unit.approximate_tokens > target:
                replacement_messages.append(
                    truncate_completed_tool_result(message, max_tokens=max(target // 2, 256))
                )
            else:
                replacement_messages.append(message.model_copy(deep=True))
    return RecentExecutionSegment(
        cut_index=cut_index,
        messages=tuple(replacement_messages),
        source_message_ids=tuple(
            message_id for unit in selected for message_id in unit.message_ids
        ),
        protocol_units=tuple(selected),
        approximate_tokens=sum(approximate_message_tokens(item) for item in replacement_messages),
        reason=reason,
        protocol_unit_overflow=any(unit.approximate_tokens > target for unit in selected),
    )


def _structured_group_root_message_id(group: StructuredUserMessageGroup) -> str:
    return str(
        group.root_user_message.source_id
        or group.root_user_message.payload.get("message_id")
        or ""
    )
