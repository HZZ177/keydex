from __future__ import annotations

from dataclasses import dataclass

from langchain_core.messages import BaseMessage

from backend.app.agent.context_compression_selection import RecentExecutionSegment


@dataclass(frozen=True, slots=True)
class CompressionPrefixInput:
    messages: tuple[BaseMessage, ...]
    source_message_ids: tuple[str, ...]
    preserved_message_ids: tuple[str, ...]
    cut_index: int

    @property
    def is_empty(self) -> bool:
        return not self.messages


def build_compression_prefix_input(
    messages: list[BaseMessage],
    recent_execution: RecentExecutionSegment,
) -> CompressionPrefixInput:
    cut_index = max(min(recent_execution.cut_index, len(messages)), 0)
    preserved = tuple(recent_execution.source_message_ids)
    preserved_set = set(preserved)
    prefix_items = [
        (index, message)
        for index, message in enumerate(messages)
        if _message_identity(message, index) not in preserved_set
    ]
    prefix = tuple(message.model_copy(deep=True) for _index, message in prefix_items)
    prefix_ids = tuple(
        _message_identity(message, index) for index, message in prefix_items
    )
    if set(prefix_ids) & set(preserved):
        raise ValueError("compression prefix 与 preserved tail 不能重叠")
    return CompressionPrefixInput(
        messages=prefix,
        source_message_ids=prefix_ids,
        preserved_message_ids=preserved,
        cut_index=cut_index,
    )


def _message_identity(message: BaseMessage, index: int) -> str:
    return str(getattr(message, "id", "") or f"index:{index}")
