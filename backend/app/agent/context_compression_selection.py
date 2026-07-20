from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from backend.app.agent.context_compression_segments import (
    CompressionProtocolUnit,
    approximate_message_tokens,
    build_protocol_safe_units,
    truncate_completed_tool_result,
)
from backend.app.agent.context_compression_turns import (
    RawConversationBundle,
    build_raw_conversation_bundles,
    is_real_user_root,
)
from backend.app.agent.context_compression_utils import stringify_message_content
from backend.app.services.structured_user_message_group import StructuredUserMessageGroup

POST_COMPACTION_TARGET_TOKENS = 20_000
POST_COMPACTION_NORMAL_CEILING_TOKENS = 24_000
SUMMARY_ABSOLUTE_MAX_OUTPUT_TOKENS = 20_000
SUMMARY_PREFERRED_CAPACITY_TOKENS = 12_000
SUMMARY_MIN_CAPACITY_TOKENS = 8_000
RECENT_DIALOGUE_TARGET_TOKENS = 4_000
ACTIVE_EXECUTION_TARGET_TOKENS = 2_000
RECENT_STATE_AND_GROUPS_ENVELOPE_TOKENS = (
    POST_COMPACTION_NORMAL_CEILING_TOKENS - SUMMARY_MIN_CAPACITY_TOKENS
)
# Compatibility export for callers that still describe the combined recent-state budget.
RECENT_EXECUTION_TARGET_TOKENS = (
    RECENT_DIALOGUE_TARGET_TOKENS + ACTIVE_EXECUTION_TARGET_TOKENS
)
RECENT_DIALOGUE_METADATA_KEY = "keydex_recent_dialogue"

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
class RecentDialogueTurn:
    start_index: int
    end_index: int
    messages: tuple[BaseMessage, ...]
    source_message_ids: tuple[str, ...]
    replacement_source_message_ids: tuple[str, ...]
    approximate_tokens: int
    stripped_tool_call_count: int
    stripped_tool_result_count: int
    truncated: bool = False


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
    dialogue_turns: tuple[RecentDialogueTurn, ...] = ()
    active_messages: tuple[BaseMessage, ...] = ()
    replacement_source_message_ids: tuple[str, ...] = ()
    dialogue_tokens: int = 0
    active_tokens: int = 0
    stripped_tool_call_count: int = 0
    stripped_tool_result_count: int = 0

    @property
    def dialogue_messages(self) -> tuple[BaseMessage, ...]:
        return tuple(message for turn in self.dialogue_turns for message in turn.messages)


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
    target_tokens: int = RECENT_DIALOGUE_TARGET_TOKENS,
    reserve_estimator: GroupReserveEstimator = estimate_structured_user_group_deferred_reserve,
) -> tuple[RecentExecutionSegment, StructuredUserGroupSelection]:
    """Keep text dialogue under 4K and its replay groups inside the shared envelope."""

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
        selected_group_tokens = sum(
            item.atomic_tokens for item in selection.selected_costs
        )
        if (
            recent.dialogue_tokens <= target
            and recent.approximate_tokens + selected_group_tokens
            <= RECENT_STATE_AND_GROUPS_ENVELOPE_TOKENS
        ):
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
    target_tokens: int = RECENT_DIALOGUE_TARGET_TOKENS,
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
        return RecentExecutionSegment(
            cut_index=0,
            messages=(),
            source_message_ids=(),
            protocol_units=(),
            approximate_tokens=0,
            reason="empty_history",
        )

    dialogue_target = max(int(target_tokens), 1)
    bundles = build_raw_conversation_bundles(messages)
    latest_real_bundle = next(
        (bundle for bundle in reversed(bundles) if bundle.has_real_user_root),
        None,
    )
    latest_bundle = bundles[-1] if bundles else None
    active_bundle = (
        latest_real_bundle
        if latest_real_bundle is not None and not _bundle_is_completed(latest_real_bundle)
        else (
            latest_bundle
            if latest_real_bundle is None
            and latest_bundle is not None
            and not _bundle_is_completed(latest_bundle)
            else None
        )
    )
    completed_bundles = [
        bundle
        for bundle in bundles
        if bundle.has_real_user_root and bundle is not active_bundle
    ]

    dialogue_turns: list[RecentDialogueTurn] = []
    dialogue_tokens = 0
    for bundle in reversed(completed_bundles):
        remaining = max(dialogue_target - dialogue_tokens, 0)
        turn = _build_recent_dialogue_turn(
            bundle,
            max_tokens=remaining or dialogue_target,
            allow_truncate=not dialogue_turns,
        )
        if turn is None:
            break
        if dialogue_turns and dialogue_tokens + turn.approximate_tokens > dialogue_target:
            break
        dialogue_turns.insert(0, turn)
        dialogue_tokens += turn.approximate_tokens

    active_units = _select_active_protocol_units(
        unit_result.units,
        active_bundle=active_bundle,
        target_tokens=ACTIVE_EXECUTION_TARGET_TOKENS,
    )

    while dialogue_turns and not _has_compressible_prefix(
        messages,
        _selected_source_message_ids(dialogue_turns, active_units),
    ):
        dialogue_tokens -= dialogue_turns[0].approximate_tokens
        dialogue_turns.pop(0)

    while active_units and not _has_compressible_prefix(
        messages,
        _selected_source_message_ids(dialogue_turns, active_units),
    ):
        release_index = next(
            (
                index
                for index, unit in enumerate(active_units)
                if not any(is_real_user_root(message) for message in unit.messages)
            ),
            None,
        )
        if release_index is None:
            break
        active_units.pop(release_index)

    active_messages = _active_messages_from_units(
        active_units,
        target_tokens=ACTIVE_EXECUTION_TARGET_TOKENS,
    )
    active_tokens = sum(approximate_message_tokens(item) for item in active_messages)

    return _build_recent_execution_segment(
        dialogue_turns=dialogue_turns,
        active_units=active_units,
        active_messages=active_messages,
        active_tokens=active_tokens,
        reason="recent_text_dialogue_and_minimal_active_execution",
        message_count=len(messages),
    )


def _drop_oldest_complete_turn(
    messages: list[BaseMessage],
    recent_execution: RecentExecutionSegment,
    *,
    target_tokens: int,
) -> RecentExecutionSegment | None:
    dialogue_turns = list(recent_execution.dialogue_turns)
    minimum_turns = 0 if recent_execution.active_messages else 1
    if len(dialogue_turns) <= minimum_turns:
        return None
    dialogue_turns.pop(0)
    return _build_recent_execution_segment(
        dialogue_turns=dialogue_turns,
        active_units=list(recent_execution.protocol_units),
        active_messages=recent_execution.active_messages,
        active_tokens=recent_execution.active_tokens,
        reason="latest_complete_turns_fitted_with_structured_groups",
        message_count=len(messages),
    )


def _build_recent_execution_segment(
    *,
    dialogue_turns: list[RecentDialogueTurn],
    active_units: list[CompressionProtocolUnit],
    active_messages: tuple[BaseMessage, ...],
    active_tokens: int,
    reason: str,
    message_count: int,
) -> RecentExecutionSegment:
    dialogue_messages = tuple(
        message for turn in dialogue_turns for message in turn.messages
    )
    replacement_messages = (*dialogue_messages, *active_messages)
    source_message_ids = _selected_source_message_ids(dialogue_turns, active_units)
    replacement_source_message_ids = tuple(
        dict.fromkeys(
            [
                *(
                    source_id
                    for turn in dialogue_turns
                    for source_id in turn.replacement_source_message_ids
                ),
                *(message_id for unit in active_units for message_id in unit.message_ids),
            ]
        )
    )
    selected_starts = [
        *(turn.start_index for turn in dialogue_turns),
        *(unit.start_index for unit in active_units),
    ]
    dialogue_tokens = sum(turn.approximate_tokens for turn in dialogue_turns)
    return RecentExecutionSegment(
        cut_index=min(selected_starts) if selected_starts else message_count,
        messages=tuple(replacement_messages),
        source_message_ids=source_message_ids,
        protocol_units=tuple(active_units),
        approximate_tokens=dialogue_tokens + active_tokens,
        reason=reason,
        protocol_unit_overflow=any(
            unit.approximate_tokens > ACTIVE_EXECUTION_TARGET_TOKENS
            for unit in active_units
        ),
        dialogue_turns=tuple(dialogue_turns),
        active_messages=active_messages,
        replacement_source_message_ids=replacement_source_message_ids,
        dialogue_tokens=dialogue_tokens,
        active_tokens=active_tokens,
        stripped_tool_call_count=sum(
            turn.stripped_tool_call_count for turn in dialogue_turns
        ),
        stripped_tool_result_count=sum(
            turn.stripped_tool_result_count for turn in dialogue_turns
        ),
    )


def _bundle_is_completed(bundle: RawConversationBundle) -> bool:
    return bool(
        bundle.messages
        and isinstance(bundle.messages[-1], AIMessage)
        and not bundle.messages[-1].tool_calls
    )


def _build_recent_dialogue_turn(
    bundle: RawConversationBundle,
    *,
    max_tokens: int,
    allow_truncate: bool,
) -> RecentDialogueTurn | None:
    visible: list[tuple[int, BaseMessage, str]] = []
    replacement_sources: list[str] = []
    all_source_ids = _bundle_source_message_ids(bundle)
    for offset, message in enumerate(bundle.messages):
        source_id = _source_message_id(message, bundle.start_index + offset)
        if isinstance(message, HumanMessage) and is_real_user_root(message):
            text = _visible_text(message.content)
            if text:
                visible.append(
                    (
                        bundle.start_index + offset,
                        _recent_dialogue_human(message, text),
                        source_id,
                    )
                )
                replacement_sources.append(source_id)
        elif isinstance(message, AIMessage):
            text = _visible_text(message.content)
            if text:
                visible.append(
                    (
                        bundle.start_index + offset,
                        _recent_dialogue_ai(message, text),
                        source_id,
                    )
                )
                replacement_sources.append(source_id)
    if not visible:
        return None
    full_tokens = sum(approximate_message_tokens(item[1]) for item in visible)
    truncated = full_tokens > max(max_tokens, 1)
    if truncated and not allow_truncate:
        return None
    selected = (
        _truncate_latest_dialogue_turn(visible, max_tokens=max(max_tokens, 1))
        if truncated
        else visible
    )
    if not selected:
        return None
    selected_source_ids = tuple(item[2] for item in selected)
    source_ids = (
        _expand_selected_protocol_source_ids(bundle, selected_source_ids)
        if truncated
        else all_source_ids
    )
    return RecentDialogueTurn(
        start_index=min(item[0] for item in selected),
        end_index=bundle.end_index,
        messages=tuple(item[1] for item in selected),
        source_message_ids=source_ids,
        replacement_source_message_ids=selected_source_ids,
        approximate_tokens=sum(approximate_message_tokens(item[1]) for item in selected),
        stripped_tool_call_count=sum(
            len(message.tool_calls)
            for message in bundle.messages
            if isinstance(message, AIMessage)
        ),
        stripped_tool_result_count=sum(
            isinstance(message, ToolMessage) for message in bundle.messages
        ),
        truncated=truncated,
    )


def _truncate_latest_dialogue_turn(
    visible: list[tuple[int, BaseMessage, str]],
    *,
    max_tokens: int,
) -> list[tuple[int, BaseMessage, str]]:
    users = [item for item in visible if isinstance(item[1], HumanMessage)]
    assistants = [item for item in visible if isinstance(item[1], AIMessage)]
    selected = list(users)
    used = sum(approximate_message_tokens(item[1]) for item in selected)
    for item in reversed(assistants):
        remaining = max_tokens - used
        if remaining <= 0:
            break
        tokens = approximate_message_tokens(item[1])
        if tokens <= remaining:
            selected.append(item)
            used += tokens
            continue
        shortened = _truncate_dialogue_message(item[1], max_tokens=remaining)
        if shortened is not None:
            selected.append((item[0], shortened, item[2]))
        break
    return sorted(selected, key=lambda item: item[0])


def _truncate_dialogue_message(
    message: BaseMessage,
    *,
    max_tokens: int,
) -> BaseMessage | None:
    text = str(message.content or "")
    if not text or max_tokens <= 0:
        return None
    marker = "\n...[近期 Agent 正文按 4K 预算截断]...\n"

    def build(char_count: int) -> BaseMessage:
        half = max(char_count // 2, 1)
        content = (
            f"{text[:half]}{marker}{text[-(char_count - half):]}"
            if char_count < len(text)
            else text
        )
        return message.model_copy(update={"content": content}, deep=True)

    low = 1
    high = len(text)
    best: BaseMessage | None = None
    while low <= high:
        middle = (low + high) // 2
        candidate = build(middle)
        if approximate_message_tokens(candidate) <= max_tokens:
            best = candidate
            low = middle + 1
        else:
            high = middle - 1
    return best


def _recent_dialogue_human(message: HumanMessage, text: str) -> HumanMessage:
    return HumanMessage(
        id=message.id,
        content=text,
        name=message.name,
        additional_kwargs={
            RECENT_DIALOGUE_METADATA_KEY: {"kind": "user_text", "source_id": message.id},
        },
    )


def _recent_dialogue_ai(message: AIMessage, text: str) -> AIMessage:
    return AIMessage(
        id=message.id,
        content=text,
        name=message.name,
        tool_calls=[],
        invalid_tool_calls=[],
        additional_kwargs={
            RECENT_DIALOGUE_METADATA_KEY: {"kind": "assistant_text", "source_id": message.id},
        },
    )


def _visible_text(content: object) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return stringify_message_content(content).strip()
    parts: list[str] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        block_type = str(item.get("type") or "").casefold()
        if block_type in {"reasoning", "thinking", "reasoning_content"}:
            continue
        if block_type in {"text", "output_text"} and item.get("text"):
            parts.append(str(item["text"]))
    return "\n".join(parts).strip()


def _select_active_protocol_units(
    units: tuple[CompressionProtocolUnit, ...],
    *,
    active_bundle: RawConversationBundle | None,
    target_tokens: int,
) -> list[CompressionProtocolUnit]:
    if active_bundle is None:
        return []
    candidates = [
        unit
        for unit in units
        if active_bundle.start_index <= unit.start_index < active_bundle.end_index
    ]
    selected: list[CompressionProtocolUnit] = []
    total = 0
    for unit in reversed(candidates):
        if selected and total + unit.approximate_tokens > target_tokens:
            break
        selected.append(unit)
        total += unit.approximate_tokens
        if total >= target_tokens:
            break
    selected.reverse()
    root_unit = next(
        (
            unit
            for unit in candidates
            if any(is_real_user_root(message) for message in unit.messages)
        ),
        None,
    )
    if root_unit is not None and root_unit not in selected:
        selected.insert(0, root_unit)
    return selected


def _active_messages_from_units(
    units: list[CompressionProtocolUnit],
    *,
    target_tokens: int,
) -> tuple[BaseMessage, ...]:
    messages: list[BaseMessage] = []
    for unit in units:
        for message in unit.messages:
            if isinstance(message, ToolMessage) and unit.approximate_tokens > target_tokens:
                messages.append(
                    truncate_completed_tool_result(
                        message,
                        max_tokens=max(target_tokens // 2, 256),
                    )
                )
            else:
                messages.append(message.model_copy(deep=True))
    return tuple(messages)


def _selected_source_message_ids(
    dialogue_turns: list[RecentDialogueTurn],
    active_units: list[CompressionProtocolUnit],
) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(
            [
                *(source_id for turn in dialogue_turns for source_id in turn.source_message_ids),
                *(message_id for unit in active_units for message_id in unit.message_ids),
            ]
        )
    )


def _bundle_source_message_ids(bundle: RawConversationBundle) -> tuple[str, ...]:
    return tuple(
        _source_message_id(message, bundle.start_index + offset)
        for offset, message in enumerate(bundle.messages)
    )


def _expand_selected_protocol_source_ids(
    bundle: RawConversationBundle,
    selected_source_ids: tuple[str, ...],
) -> tuple[str, ...]:
    selected = set(selected_source_ids)
    for offset, message in enumerate(bundle.messages):
        source_id = _source_message_id(message, bundle.start_index + offset)
        if source_id not in selected or not isinstance(message, AIMessage):
            continue
        if not message.tool_calls:
            continue
        cursor = offset + 1
        while cursor < len(bundle.messages) and isinstance(
            bundle.messages[cursor], ToolMessage
        ):
            selected.add(
                _source_message_id(
                    bundle.messages[cursor],
                    bundle.start_index + cursor,
                )
            )
            cursor += 1
    return tuple(
        source_id
        for source_id in _bundle_source_message_ids(bundle)
        if source_id in selected
    )


def _source_message_id(message: BaseMessage, index: int) -> str:
    return str(getattr(message, "id", "") or f"index:{index}")


def _has_compressible_prefix(
    messages: list[BaseMessage],
    selected_source_ids: tuple[str, ...],
) -> bool:
    selected = set(selected_source_ids)
    return any(
        _source_message_id(message, index) not in selected
        for index, message in enumerate(messages)
    )


def _structured_group_root_message_id(group: StructuredUserMessageGroup) -> str:
    return str(
        group.root_user_message.source_id
        or group.root_user_message.payload.get("message_id")
        or ""
    )
