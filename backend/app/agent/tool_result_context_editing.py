from __future__ import annotations

import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

from backend.app.agent.context_compression_segments import build_protocol_safe_units
from backend.app.agent.tool_results.artifact_repository import (
    PersistedToolResultRef,
    ToolResultArtifactRepository,
)
from backend.app.agent.tool_results.budgets import (
    approximate_tokens,
    get_tool_result_policy,
    utf8_bytes,
)
from backend.app.core.time import to_iso_z, utc_now
from backend.app.tools.base import ToolExecutionContext

TOOL_RESULT_TOMBSTONE_METADATA_KEY = "keydex_tool_result_tombstone"
TOOL_RESULT_TOMBSTONE_VERSION = "keydex.tool_result_tombstone.v1"
RECENT_ELIGIBLE_TOOL_RESULTS = 5
CONTEXT_EDITING_RECLAIM_THRESHOLD_TOKENS = 100_000


@dataclass(frozen=True, slots=True)
class ToolResultContextCandidate:
    message_index: int
    tool_call_id: str
    tool_name: str
    approximate_tokens: int


@dataclass(frozen=True, slots=True)
class ToolResultContextEditingPlan:
    candidates: tuple[ToolResultContextCandidate, ...]
    protected_tool_call_ids: tuple[str, ...]
    reclaimable_tokens: int
    valid_protocol_units: int
    invalid_protocol_units: int


def select_tool_result_context_candidates(
    messages: list[BaseMessage],
    *,
    recent_results: int = RECENT_ELIGIBLE_TOOL_RESULTS,
    reclaim_threshold_tokens: int = CONTEXT_EDITING_RECLAIM_THRESHOLD_TOKENS,
) -> ToolResultContextEditingPlan:
    """Select old independent ToolMessages while failing open per malformed unit."""

    valid_indices, valid_units, invalid_units = _validated_tool_result_indices(messages)
    last_ai_index = max(
        (index for index, message in enumerate(messages) if isinstance(message, AIMessage)),
        default=-1,
    )
    eligible = [
        _candidate(index, message)
        for index, message in enumerate(messages)
        if index in valid_indices
        and index < last_ai_index
        and isinstance(message, ToolMessage)
        and _is_eligible_tool_result(message)
    ]
    keep = max(int(recent_results), 0)
    protected = eligible[-keep:] if keep else []
    older = eligible[:-keep] if keep else eligible
    reclaimable = sum(item.approximate_tokens for item in older)
    candidates = older if reclaimable >= max(int(reclaim_threshold_tokens), 0) else []
    return ToolResultContextEditingPlan(
        candidates=tuple(candidates),
        protected_tool_call_ids=tuple(item.tool_call_id for item in protected),
        reclaimable_tokens=reclaimable,
        valid_protocol_units=valid_units,
        invalid_protocol_units=invalid_units,
    )


def tombstone_tool_result(
    message: ToolMessage,
    *,
    repository: ToolResultArtifactRepository,
    context: ToolExecutionContext,
) -> ToolMessage:
    """Persist recoverable content before returning an idempotent protocol-safe copy."""

    if is_tool_result_tombstone(message):
        return message.model_copy(deep=True)
    tool_name = str(getattr(message, "name", "") or "unknown_tool")
    artifact_context = replace(
        context,
        metadata={
            **context.metadata,
            "tool_call_id": str(message.tool_call_id or ""),
        },
    )
    original_content = _message_content_text(message)
    original_bytes = utf8_bytes(original_content)
    original_tokens = approximate_tokens(original_bytes)
    persisted = _existing_persisted_ref(
        message,
        repository=repository,
        context=artifact_context,
    )
    if persisted is None:
        persisted = repository.ensure_persisted(
            original_content,
            context=artifact_context,
            tool_name=tool_name,
            is_complete=_message_artifact_complete(message),
        )
    marker = {
        "version": TOOL_RESULT_TOMBSTONE_VERSION,
        "artifact_id": persisted.artifact_id,
        "content_sha256": persisted.content_sha256,
        "original_bytes": original_bytes,
        "approximate_tokens": original_tokens,
        "cleared_at": to_iso_z(utc_now()),
        "reason": "consumed_and_outside_recent_window",
    }
    additional_kwargs = dict(getattr(message, "additional_kwargs", {}) or {})
    additional_kwargs[TOOL_RESULT_TOMBSTONE_METADATA_KEY] = marker
    content = (
        "[Earlier tool result cleared]\n"
        f"tool: {tool_name}\n"
        f"original_bytes: {original_bytes}\n"
        f"approximate_tokens: {original_tokens}\n"
        f"artifact_id: {persisted.artifact_id}\n"
        "reason: consumed_and_outside_recent_window\n"
        f"Use read_tool_result(artifact_id=\"{persisted.artifact_id}\") "
        "if the exact output is needed."
    )
    return message.model_copy(
        update={
            "content": content,
            "artifact": None,
            "additional_kwargs": additional_kwargs,
        },
        deep=True,
    )


def is_tool_result_tombstone(message: ToolMessage) -> bool:
    marker = dict(getattr(message, "additional_kwargs", {}) or {}).get(
        TOOL_RESULT_TOMBSTONE_METADATA_KEY
    )
    return isinstance(marker, dict) and marker.get("version") == TOOL_RESULT_TOMBSTONE_VERSION


def _validated_tool_result_indices(
    messages: list[BaseMessage],
) -> tuple[set[int], int, int]:
    valid_indices: set[int] = set()
    valid_units = 0
    invalid_units = 0
    index = 0
    while index < len(messages):
        message = messages[index]
        if not isinstance(message, AIMessage) or not message.tool_calls:
            index += 1
            continue
        cursor = index + 1
        while cursor < len(messages) and isinstance(messages[cursor], ToolMessage):
            cursor += 1
        unit_messages = messages[index:cursor]
        unit = build_protocol_safe_units(unit_messages)
        if unit.valid and len(unit.units) == 1 and unit.units[0].kind == "tool_exchange":
            valid_units += 1
            valid_indices.update(range(index + 1, cursor))
        else:
            invalid_units += 1
        index = max(cursor, index + 1)
    return valid_indices, valid_units, invalid_units


def _candidate(index: int, message: ToolMessage) -> ToolResultContextCandidate:
    return ToolResultContextCandidate(
        message_index=index,
        tool_call_id=str(message.tool_call_id or ""),
        tool_name=str(getattr(message, "name", "") or "unknown_tool"),
        approximate_tokens=approximate_tokens(utf8_bytes(_message_content_text(message))),
    )


def _is_eligible_tool_result(message: ToolMessage) -> bool:
    if is_tool_result_tombstone(message):
        return False
    if str(getattr(message, "status", "") or "").casefold() == "error":
        return False
    tool_name = str(getattr(message, "name", "") or "")
    policy = get_tool_result_policy(tool_name)
    return bool(policy.persist_before_clear and not policy.never_clear)


def _message_content_text(message: ToolMessage) -> str:
    content = message.content
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False, sort_keys=True, default=str)


def _message_artifact_complete(message: ToolMessage) -> bool:
    artifact = getattr(message, "artifact", None)
    if not isinstance(artifact, dict):
        return True
    projection = artifact.get("projection")
    if isinstance(projection, dict):
        return bool(projection.get("artifact_complete", True))
    return True


def _existing_persisted_ref(
    message: ToolMessage,
    *,
    repository: ToolResultArtifactRepository,
    context: ToolExecutionContext,
) -> PersistedToolResultRef | None:
    artifact = getattr(message, "artifact", None)
    if not isinstance(artifact, dict):
        return None
    persisted = artifact.get("persisted_ref")
    projection = artifact.get("projection")
    artifact_id = ""
    if isinstance(persisted, dict):
        artifact_id = str(persisted.get("artifact_id") or "").strip()
    if not artifact_id and isinstance(projection, dict):
        artifact_id = str(projection.get("artifact_id") or "").strip()
    if not artifact_id:
        return None
    record = repository.repositories.tool_result_artifacts.get(artifact_id)
    if record is None or record.status != "active" or record.owner_user_id != context.user_id:
        return None
    repository.repositories.tool_result_artifacts.grant(
        artifact_id=record.id,
        session_id=context.session_id,
    )
    return PersistedToolResultRef(
        artifact_id=record.id,
        storage_kind=record.storage_kind,
        content_type=record.content_type,
        content_bytes=record.content_bytes,
        content_sha256=record.content_sha256,
        is_complete=record.is_complete,
    )


def context_for_context_editing(
    *,
    session_id: str,
    user_id: str,
    data_dir: Path,
    turn_index: int,
    repositories: Any,
) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id=session_id,
        user_id=user_id,
        workspace_root=data_dir,
        turn_index=max(int(turn_index), 0),
        active_session_id=session_id,
        metadata={"repositories": repositories, "data_dir": str(data_dir)},
    )
