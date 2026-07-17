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
from backend.app.services.structured_user_message_group import StructuredUserMessageGroup

POST_COMPACTION_TARGET_TOKENS = 20_000
POST_COMPACTION_NORMAL_CEILING_TOKENS = 24_000
SUMMARY_ABSOLUTE_MAX_OUTPUT_TOKENS = 20_000
SUMMARY_PREFERRED_CAPACITY_TOKENS = 12_000
SUMMARY_MIN_CAPACITY_TOKENS = 8_000
RECENT_EXECUTION_TARGET_TOKENS = 3_000

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
            "message_context_item",
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
    return StructuredUserGroupSelection(
        mandatory=mandatory,
        candidates_newest_first=tuple(reversed(costs[:-1])),
        ignored_group_ids=tuple(ignored),
        mandatory_group_overflow=mandatory.atomic_tokens > POST_COMPACTION_NORMAL_CEILING_TOKENS,
    )


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

    selected: list[CompressionProtocolUnit] = []
    total = 0
    for unit in reversed(unit_result.units):
        if len(unit_result.units) > 1 and len(selected) >= len(unit_result.units) - 1:
            break
        if selected and total >= max(target_tokens, 1):
            break
        selected.append(unit)
        total += unit.approximate_tokens
    selected.reverse()
    cut_index = selected[0].start_index
    replacement_messages: list[BaseMessage] = []
    for unit in selected:
        for message in unit.messages:
            if isinstance(message, ToolMessage) and unit.approximate_tokens > target_tokens:
                replacement_messages.append(
                    truncate_completed_tool_result(message, max_tokens=max(target_tokens // 2, 256))
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
        reason="latest_protocol_units",
        protocol_unit_overflow=any(unit.approximate_tokens > target_tokens for unit in selected),
    )
