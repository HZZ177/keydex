from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Collection
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from backend.app.agent.context_governance_observability import log_context_governance_metric
from backend.app.agent.middleware.common import _state_messages
from backend.app.agent.tool_results.continuations import (
    InvalidContinuationCursor,
    validate_search_cursor,
)
from backend.app.core.request_context import get_active_session_id
from backend.app.tools.base import ToolExecutionError

EXPLORATION_GOVERNANCE_METADATA_KEY = "_keydex_internal_governance"
GUARDED_DISCOVERY_TOOLS = frozenset(
    {"search_text", "grep_files", "search_files", "list_dir"}
)
MAX_WIDE_DISCOVERY_PER_TURN = 5


def should_enable_exploration_guard(
    *,
    has_role_preset: bool,
    agent_kind: str,
    tool_names: Collection[str],
) -> bool:
    """Only a main agent that can actually delegate may be forced to Explorer."""

    return bool(
        not has_role_preset
        and str(agent_kind or "main") == "main"
        and "delegate_subagent" in tool_names
    )


@dataclass(frozen=True, slots=True)
class ExplorationClassification:
    kind: Literal["wide_discovery", "targeted", "verified_continuation"]
    reason: str
    scope_key: str
    logical_query_id: str | None = None
    page_index: int | None = None

    @property
    def is_wide(self) -> bool:
        return self.kind == "wide_discovery"

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "reason": self.reason,
            "scope_key": self.scope_key,
            "logical_query_id": self.logical_query_id,
            "page_index": self.page_index,
        }


@dataclass(frozen=True, slots=True)
class ExplorationReservation:
    call_id: str
    classification: ExplorationClassification
    counted: bool


@dataclass(frozen=True, slots=True)
class _ListContinuation:
    signature: str
    next_offset: int
    logical_query_id: str
    page_index: int


def classify_exploration_call(
    tool_name: str,
    args: dict[str, Any],
    *,
    workspace_root: Path,
    prior_top_scopes: frozenset[str] = frozenset(),
    verified_list_continuation: _ListContinuation | None = None,
) -> ExplorationClassification:
    normalized_tool = str(tool_name or "")
    if normalized_tool not in GUARDED_DISCOVERY_TOOLS:
        return ExplorationClassification("targeted", "non_discovery_tool", "-")
    scope_key, parts, concrete_file = _scope(args.get("path"), workspace_root)
    if normalized_tool != "list_dir":
        cursor = str(args.get("cursor") or "").strip()
        if cursor:
            try:
                continuation = validate_search_cursor(
                    cursor,
                    tool_name=normalized_tool,
                    args=args,
                )
            except InvalidContinuationCursor:
                pass
            else:
                return ExplorationClassification(
                    "verified_continuation",
                    "verified_search_cursor",
                    scope_key,
                    continuation.logical_query_id,
                    continuation.page_index,
                )
    elif verified_list_continuation is not None:
        return ExplorationClassification(
            "verified_continuation",
            "verified_list_offset",
            scope_key,
            verified_list_continuation.logical_query_id,
            verified_list_continuation.page_index,
        )

    if concrete_file or _explicit_file_include(args.get("include")):
        return ExplorationClassification("targeted", "explicit_file_target", scope_key)
    if normalized_tool == "search_files" and _explicit_file_query(args.get("query")):
        return ExplorationClassification("targeted", "explicit_file_target", scope_key)

    top_scope = parts[0].casefold() if parts else "."
    if len(parts) >= 2:
        prior_specific = {item for item in prior_top_scopes if item not in {"", "."}}
        if prior_specific and top_scope not in prior_specific:
            return ExplorationClassification(
                "wide_discovery",
                "cross_scope_discovery",
                scope_key,
            )
        return ExplorationClassification("targeted", "bounded_subdirectory", scope_key)

    if normalized_tool == "list_dir":
        depth = _positive_int(args.get("depth"), 2)
        if depth > 2:
            return ExplorationClassification(
                "wide_discovery",
                "deep_root_listing" if not parts else "deep_top_level_listing",
                scope_key,
            )
        return ExplorationClassification("targeted", "shallow_directory_listing", scope_key)
    if not parts:
        return ExplorationClassification(
            "wide_discovery",
            "workspace_root_search",
            scope_key,
        )
    return ExplorationClassification(
        "wide_discovery",
        "top_level_broad_search",
        scope_key,
    )


class ExplorationGuard:
    def __init__(
        self,
        *,
        workspace_root: Path,
        enabled: bool,
        max_wide_discovery: int = MAX_WIDE_DISCOVERY_PER_TURN,
    ) -> None:
        self.workspace_root = Path(workspace_root).resolve(strict=False)
        self.enabled = bool(enabled)
        self.max_wide_discovery = max(1, int(max_wide_discovery))
        self._lock = asyncio.Lock()
        self._turn_key = ""
        self._executed_ids: set[str] = set()
        self._inflight_ids: set[str] = set()
        self._prior_top_scopes: set[str] = set()
        self._list_continuations: dict[str, _ListContinuation] = {}
        self._logical_query_calls: dict[str, int] = {}

    def bind_turn(self, messages: list[BaseMessage], *, active_session_id: str) -> None:
        human_index, human_id = _last_human_identity(messages)
        turn_key = f"{active_session_id}:{human_id}"
        if turn_key != self._turn_key:
            self._turn_key = turn_key
            self._executed_ids.clear()
            self._inflight_ids.clear()
            self._prior_top_scopes.clear()
            self._list_continuations.clear()
            self._logical_query_calls.clear()
        completed_results = {
            str(message.tool_call_id or "")
            for message in messages[human_index + 1 :]
            if isinstance(message, ToolMessage)
        }
        for message in messages[human_index + 1 :]:
            if not isinstance(message, AIMessage):
                continue
            for call in message.tool_calls:
                call_id = str(call.get("id") or "").strip()
                tool_name = str(call.get("name") or "")
                args = call.get("args") if isinstance(call.get("args"), dict) else {}
                if not call_id or call_id not in completed_results or call_id in self._executed_ids:
                    continue
                classification = _classification_from_history(messages, call_id)
                if classification is None:
                    classification = classify_exploration_call(
                        tool_name,
                        args,
                        workspace_root=self.workspace_root,
                        prior_top_scopes=frozenset(self._prior_top_scopes),
                    )
                if classification.is_wide:
                    self._executed_ids.add(call_id)
                if classification.kind != "verified_continuation":
                    self._remember_scope(classification.scope_key)

    async def before_tool(
        self,
        *,
        tool_name: str,
        args: dict[str, Any],
        call_id: str,
        context: Any = None,
    ) -> ExplorationReservation | None:
        if not self.enabled or tool_name not in GUARDED_DISCOVERY_TOOLS:
            return None
        verified_list = self._verified_list_continuation(args) if tool_name == "list_dir" else None
        classification = classify_exploration_call(
            tool_name,
            args,
            workspace_root=self.workspace_root,
            prior_top_scopes=frozenset(self._prior_top_scopes),
            verified_list_continuation=verified_list,
        )
        normalized_call_id = call_id or (
            f"anonymous:{hashlib.sha256(_json(args).encode()).hexdigest()}"
        )
        async with self._lock:
            if not classification.is_wide:
                logical_id = classification.logical_query_id or normalized_call_id
                self._logical_query_calls[logical_id] = (
                    self._logical_query_calls.get(logical_id, 0) + 1
                )
                log_context_governance_metric(
                    "exploration_guard_classified",
                    tool=tool_name,
                    session_id=getattr(context, "session_id", None),
                    trace_id=getattr(context, "trace_id", None),
                    tool_call_id=normalized_call_id,
                    classification=classification.kind,
                    reason_code=classification.reason,
                    logical_query_id=logical_id,
                    page_index=classification.page_index,
                    calls_per_logical_query=self._logical_query_calls[logical_id],
                    continuation_used=classification.kind == "verified_continuation",
                )
                return ExplorationReservation(normalized_call_id, classification, False)
            if normalized_call_id in self._executed_ids | self._inflight_ids:
                return ExplorationReservation(normalized_call_id, classification, False)
            reserved = len(self._executed_ids | self._inflight_ids)
            if reserved >= self.max_wide_discovery:
                log_context_governance_metric(
                    "exploration_guard_rejected",
                    tool=tool_name,
                    session_id=getattr(context, "session_id", None),
                    trace_id=getattr(context, "trace_id", None),
                    tool_call_id=normalized_call_id,
                    reason_code=classification.reason,
                    wide_discovery_count=reserved,
                    wide_discovery_limit=self.max_wide_discovery,
                )
                raise ToolExecutionError(
                    "本轮主 Agent 已执行 5 次宽范围查询；请委派 Explorer，"
                    "或把查询收窄到具体文件/二级子目录。",
                    code="explorer_delegation_required",
                    details={
                        "wide_discovery_limit": self.max_wide_discovery,
                        "reason": classification.reason,
                        "suggested_tool": "delegate_subagent",
                        "suggested_args": {
                            "type": "explorer",
                            "task": "说明要调查的目标、范围、约束和需要返回的源码证据。",
                        },
                    },
                )
            self._inflight_ids.add(normalized_call_id)
            logical_id = classification.logical_query_id or normalized_call_id
            self._logical_query_calls[logical_id] = self._logical_query_calls.get(logical_id, 0) + 1
            log_context_governance_metric(
                "exploration_guard_reserved",
                tool=tool_name,
                session_id=getattr(context, "session_id", None),
                trace_id=getattr(context, "trace_id", None),
                tool_call_id=normalized_call_id,
                reason_code=classification.reason,
                logical_query_id=logical_id,
                calls_per_logical_query=self._logical_query_calls[logical_id],
                continuation_used=False,
            )
            return ExplorationReservation(normalized_call_id, classification, True)

    async def after_tool(
        self,
        reservation: ExplorationReservation | None,
        *,
        tool_name: str,
        args: dict[str, Any],
        result: Any,
    ) -> dict[str, Any] | None:
        if reservation is None:
            return None
        async with self._lock:
            self._inflight_ids.discard(reservation.call_id)
            if reservation.counted:
                self._executed_ids.add(reservation.call_id)
            if reservation.classification.kind != "verified_continuation":
                self._remember_scope(reservation.classification.scope_key)
            if tool_name == "list_dir" and isinstance(result, dict):
                self._record_list_continuation(args, result)
        return {"exploration": reservation.classification.to_dict()}

    async def cancel_tool(self, reservation: ExplorationReservation | None) -> None:
        """Release a reservation when execution is cancelled before producing a result."""

        if reservation is None:
            return
        async with self._lock:
            self._inflight_ids.discard(reservation.call_id)

    def _remember_scope(self, scope_key: str) -> None:
        parts = [part for part in scope_key.split("/") if part and part != "."]
        if parts:
            self._prior_top_scopes.add(parts[0].casefold())

    def _list_signature(self, args: dict[str, Any]) -> str:
        normalized = {
            "path": _normalized_path_text(args.get("path")),
            "depth": _positive_int(args.get("depth"), 2),
            "limit": _positive_int(args.get("limit"), 100),
            "include_hidden": bool(args.get("include_hidden", False)),
        }
        return hashlib.sha256(_json(normalized).encode("utf-8")).hexdigest()

    def _verified_list_continuation(self, args: dict[str, Any]) -> _ListContinuation | None:
        offset = _non_negative_int(args.get("offset"), 0)
        if offset <= 0:
            return None
        continuation = self._list_continuations.get(self._list_signature(args))
        if continuation is None or continuation.next_offset != offset:
            return None
        return continuation

    def _record_list_continuation(self, args: dict[str, Any], result: dict[str, Any]) -> None:
        next_offset = result.get("next_offset")
        if not isinstance(next_offset, int) or next_offset <= 0:
            return
        signature = self._list_signature(args)
        previous = self._list_continuations.get(signature)
        self._list_continuations[signature] = _ListContinuation(
            signature=signature,
            next_offset=next_offset,
            logical_query_id=(
                previous.logical_query_id
                if previous is not None
                else f"lq_list_{hashlib.sha256(signature.encode()).hexdigest()[:20]}"
            ),
            page_index=(previous.page_index + 1 if previous is not None else 1),
        )


class ExplorationGuardTurnMiddleware(AgentMiddleware):
    def __init__(self, guard: ExplorationGuard) -> None:
        self.guard = guard

    async def abefore_model(self, state: Any, runtime: Any) -> None:
        del runtime
        self.guard.bind_turn(
            _state_messages(state),
            active_session_id=get_active_session_id(),
        )
        return None


def _scope(raw_path: Any, workspace_root: Path) -> tuple[str, tuple[str, ...], bool]:
    raw = str(raw_path or ".").strip() or "."
    candidate = Path(raw)
    if not candidate.is_absolute():
        candidate = workspace_root / candidate
    resolved = candidate.resolve(strict=False)
    try:
        relative = resolved.relative_to(workspace_root.resolve(strict=False))
        parts = tuple(part for part in relative.parts if part not in {"", "."})
    except ValueError:
        normalized = _normalized_path_text(raw)
        parts = tuple(
            part
            for part in PurePosixPath(normalized).parts
            if part not in {"", ".", "/"}
        )
    scope_key = "/".join(parts) or "."
    concrete_file = resolved.is_file() or _looks_like_file_path(raw)
    return scope_key, parts, concrete_file


def _normalized_path_text(value: Any) -> str:
    text = str(value or ".").strip().replace("\\", "/") or "."
    return text.casefold()


def _looks_like_file_path(value: str) -> bool:
    normalized = value.replace("\\", "/").rstrip("/")
    name = normalized.rsplit("/", 1)[-1]
    dot = name.rfind(".")
    return bool(
        name not in {"", ".", ".."}
        and dot > 0
        and dot < len(name) - 1
        and not any(char in name for char in "*?[]{}")
    )


def _explicit_file_include(value: Any) -> bool:
    if not isinstance(value, list) or not value:
        return False
    return all(
        isinstance(item, str)
        and _looks_like_file_path(item)
        and not any(char in item for char in "*?[]{}")
        for item in value
    )


def _explicit_file_query(value: Any) -> bool:
    text = str(value or "").strip()
    return bool(text and _looks_like_file_path(text) and not any(char in text for char in "*?[]{}"))


def _last_human_identity(messages: list[BaseMessage]) -> tuple[int, str]:
    for index in range(len(messages) - 1, -1, -1):
        message = messages[index]
        if isinstance(message, HumanMessage):
            message_id = str(getattr(message, "id", "") or "").strip()
            if not message_id:
                message_id = hashlib.sha256(
                    f"{index}:{message.content}".encode("utf-8", errors="replace")
                ).hexdigest()[:24]
            return index, message_id
    return -1, "no-human-message"


def _classification_from_history(
    messages: list[BaseMessage],
    tool_call_id: str,
) -> ExplorationClassification | None:
    for message in messages:
        if not isinstance(message, ToolMessage) or str(message.tool_call_id or "") != tool_call_id:
            continue
        artifact = getattr(message, "artifact", None)
        governance = artifact.get("governance") if isinstance(artifact, dict) else None
        raw = governance.get("exploration") if isinstance(governance, dict) else None
        if not isinstance(raw, dict):
            return None
        try:
            return ExplorationClassification(
                kind=str(raw["kind"]),
                reason=str(raw["reason"]),
                scope_key=str(raw["scope_key"]),
                logical_query_id=(
                    str(raw["logical_query_id"]) if raw.get("logical_query_id") else None
                ),
                page_index=int(raw["page_index"]) if raw.get("page_index") else None,
            )
        except (KeyError, TypeError, ValueError):
            return None
    return None


def _positive_int(value: Any, default: int) -> int:
    try:
        return max(1, int(value))
    except (TypeError, ValueError):
        return default


def _non_negative_int(value: Any, default: int) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
