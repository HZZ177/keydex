from __future__ import annotations

import base64
import hashlib
import json
import re
import sqlite3
from contextlib import nullcontext
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from backend.app.core.ids import new_id
from backend.app.core.time import to_iso_z, utc_now
from backend.app.security import WorkspacePathError, normalize_workspace_root_for_storage
from backend.app.services.chat_types import (
    PENDING_INPUT_ACTIVE_STATUSES,
    PENDING_INPUT_EDITABLE_STATUSES,
    PENDING_INPUT_MODE_QUEUE,
    PENDING_INPUT_MODE_STEER,
    PENDING_INPUT_MODES,
    PENDING_INPUT_STATUS_CANCELLED,
    PENDING_INPUT_STATUS_DELIVERED,
    PENDING_INPUT_STATUS_FAILED,
    PENDING_INPUT_STATUS_PENDING_STEER,
    PENDING_INPUT_STATUS_QUEUED,
    PENDING_INPUT_STATUS_STARTING,
    PENDING_INPUT_STATUSES,
)
from backend.app.storage.db import Database
from backend.app.subagents.errors import SubagentError, SubagentErrorCode
from backend.app.subagents.models import SubagentRunSnapshot
from backend.app.subagents.state_machine import set_blocked_on, transition_run


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_loads(value: str | None, default: Any = None) -> Any:
    if value is None:
        return default
    return json.loads(value)


SENSITIVE_METADATA_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "proxy_authorization",
    "x-api-key",
    "x_api_key",
    "headers",
}

MODEL_DEFAULT_CHAT = "default_chat"
MODEL_DEFAULT_FAST = "fast"
MODEL_DEFAULT_SCOPES = frozenset({MODEL_DEFAULT_CHAT, MODEL_DEFAULT_FAST})

THREAD_TASK_TYPE_GOAL = "goal"
THREAD_TASK_TYPES = frozenset({THREAD_TASK_TYPE_GOAL})
THREAD_TASK_TYPE_MAX_CHARS = 64
THREAD_TASK_TYPE_PATTERN = re.compile(r"^[a-z][a-z0-9_:-]*$")
THREAD_TASK_STATUS_ACTIVE = "active"
THREAD_TASK_STATUS_PAUSED = "paused"
THREAD_TASK_STATUS_BLOCKED = "blocked"
THREAD_TASK_STATUS_COMPLETE = "complete"
THREAD_TASK_STATUS_SYSTEM_STOPPED = "system_stopped"
THREAD_TASK_STATUS_CANCELLED = "cancelled"
THREAD_TASK_OPEN_STATUSES = frozenset(
    {
        THREAD_TASK_STATUS_ACTIVE,
        THREAD_TASK_STATUS_PAUSED,
        THREAD_TASK_STATUS_BLOCKED,
    }
)
THREAD_TASK_TERMINAL_STATUSES = frozenset(
    {
        THREAD_TASK_STATUS_COMPLETE,
        THREAD_TASK_STATUS_SYSTEM_STOPPED,
        THREAD_TASK_STATUS_CANCELLED,
    }
)
THREAD_TASK_STATUSES = THREAD_TASK_OPEN_STATUSES | THREAD_TASK_TERMINAL_STATUSES
THREAD_TASK_RUN_STATUS_RUNNING = "running"
THREAD_TASK_RUN_STATUS_SUCCEEDED = "succeeded"
THREAD_TASK_RUN_STATUS_FAILED = "failed"
THREAD_TASK_RUN_STATUS_SKIPPED = "skipped"
THREAD_TASK_RUN_STATUS_CANCELLED = "cancelled"
THREAD_TASK_RUN_STATUSES = frozenset(
    {
        THREAD_TASK_RUN_STATUS_RUNNING,
        THREAD_TASK_RUN_STATUS_SUCCEEDED,
        THREAD_TASK_RUN_STATUS_FAILED,
        THREAD_TASK_RUN_STATUS_SKIPPED,
        THREAD_TASK_RUN_STATUS_CANCELLED,
    }
)
A2UI_STATUS_WAITING_USER_INPUT = "waiting_user_input"
A2UI_STATUS_SUBMITTED = "submitted"
A2UI_STATUS_CANCELLED = "cancelled"
A2UI_STATUSES = frozenset(
    {
        A2UI_STATUS_WAITING_USER_INPUT,
        A2UI_STATUS_SUBMITTED,
        A2UI_STATUS_CANCELLED,
    }
)
A2UI_RESUME_STATUS_NOT_STARTED = "not_started"
A2UI_RESUME_STATUS_DEFERRED = "deferred"
A2UI_RESUME_STATUS_STARTED = "started"
A2UI_RESUME_STATUS_SUCCEEDED = "succeeded"
A2UI_RESUME_STATUS_FAILED = "failed"
A2UI_RESUME_STATUSES = frozenset(
    {
        A2UI_RESUME_STATUS_NOT_STARTED,
        A2UI_RESUME_STATUS_DEFERRED,
        A2UI_RESUME_STATUS_STARTED,
        A2UI_RESUME_STATUS_SUCCEEDED,
        A2UI_RESUME_STATUS_FAILED,
    }
)
_UNSET = object()


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _encode_archive_cursor(archived_at: str, entity_id: str) -> str:
    payload = json.dumps([archived_at, entity_id], separators=(",", ":")).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_archive_cursor(cursor: str | None) -> tuple[str, str] | None:
    if cursor is None:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("归档列表 cursor 无效") from exc
    if (
        not isinstance(payload, list)
        or len(payload) != 2
        or not all(isinstance(item, str) and item for item in payload)
    ):
        raise ValueError("归档列表 cursor 无效")
    return payload[0], payload[1]


def _lifecycle_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _lifecycle_payload_hash(payload: dict[str, Any]) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return _lifecycle_hash(canonical)


def _clip_text(value: str | None, limit: int = 4000) -> str | None:
    if value is None:
        return None
    text = str(value)
    if len(text) <= limit:
        return text
    return f"{text[:limit]}..."


def _sanitize_metadata(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if key_text.lower() in SENSITIVE_METADATA_KEYS:
                continue
            cleaned[key_text] = _sanitize_metadata(item)
        return cleaned
    if isinstance(value, list):
        return [_sanitize_metadata(item) for item in value]
    if value is None or isinstance(value, str | int | float | bool):
        return value
    return str(value)


def _json_object_loads(value: str | None, *, field_name: str) -> dict[str, Any]:
    if value is None or value == "":
        return {}
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{field_name} 不是有效 JSON 对象") from exc
    if not isinstance(loaded, dict):
        raise ValueError(f"{field_name} 必须是 JSON 对象")
    return loaded


def _json_array_loads(value: str | None, *, field_name: str) -> list[Any]:
    if value is None or value == "":
        return []
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{field_name} 不是有效 JSON 数组") from exc
    if not isinstance(loaded, list):
        raise ValueError(f"{field_name} 必须是 JSON 数组")
    return loaded


def _non_negative_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, str) and value.strip().isdigit():
        return max(0, int(value))
    return default


@dataclass(frozen=True)
class ModelProviderRecord:
    id: str
    name: str
    base_url: str
    api_key: str | None
    enabled: bool
    models: list[str]
    model_enabled: dict[str, bool]
    health: dict[str, Any]
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class ModelDefaultRecord:
    scope: str
    provider_id: str
    model: str
    updated_at: str


@dataclass(frozen=True)
class WorkspaceRecord:
    id: str
    name: str
    root_path: str
    normalized_root_path: str
    type: str
    created_at: str
    updated_at: str
    last_opened_at: str | None = None
    archived_at: str | None = None

    @property
    def is_archived(self) -> bool:
        return self.archived_at is not None


@dataclass(frozen=True)
class ArchivedWorkspaceSummary:
    workspace: WorkspaceRecord
    session_total: int
    manual_session_count: int
    project_session_count: int


@dataclass(frozen=True)
class ArchivedWorkspacePage:
    items: list[ArchivedWorkspaceSummary]
    next_cursor: str | None
    has_more: bool


@dataclass(frozen=True)
class WorkspaceArchiveMutation:
    record: WorkspaceRecord | None
    changed: bool
    newly_archived: int = 0
    manual_preserved: int = 0
    project_preserved: int = 0


@dataclass(frozen=True)
class WorkspaceRestoreMutation:
    record: WorkspaceRecord | None
    changed: bool
    restored_sessions: int = 0


@dataclass(frozen=True)
class SessionRecord:
    id: str
    user_id: str
    scene_id: str
    status: str
    session_tag: str
    title: str | None
    active_session_id: str | None
    created_at: str
    updated_at: str
    scene_version_seq: int | None = None
    is_debug: bool = False
    debug_type: str | None = None
    is_scheduled: bool = False
    scheduled_task_id: str | None = None
    parent_session_id: str | None = None
    child_session_id: str | None = None
    source_trace_id: str | None = None
    source_active_session_id: str | None = None
    source_checkpoint_id: str | None = None
    source_checkpoint_ns: str | None = None
    workspace_id: str | None = None
    session_type: str = "chat"
    visibility: str = "visible"
    agent_kind: str = "main"
    subagent_id: str | None = None
    subagent_role: str | None = None
    subagent_closed_at: str | None = None
    cwd: str | None = None
    workspace_roots: list[str] = field(default_factory=list)
    current_model_provider_id: str | None = None
    current_model: str | None = None
    context_window_usage: dict[str, Any] | None = None
    context_compression_epoch: int = 0
    pinned_at: str | None = None
    archived_at: str | None = None
    archive_origin: str | None = None
    title_source: str = "manual"

    @property
    def is_archived(self) -> bool:
        return self.archived_at is not None

    @property
    def is_internal(self) -> bool:
        return self.visibility == "internal"

    @property
    def is_subagent(self) -> bool:
        return self.agent_kind == "subagent"


@dataclass(frozen=True)
class SubagentRunRecord:
    run_id: str
    subagent_id: str
    child_session_id: str
    parent_session_id: str
    parent_trace_id: str | None
    parent_tool_call_id: str | None
    parent_timeline_sequence: int
    initiated_by: str
    role: str
    task: str
    state: str
    blocked_on: str | None
    version: int
    final_report: str | None
    report_truncated: bool
    error_code: str | None
    error_message: str | None
    created_at: str
    queued_at: str
    started_at: str | None
    finished_at: str | None
    updated_at: str
    cancel_requested_at: str | None

    def to_snapshot(self) -> SubagentRunSnapshot:
        return SubagentRunSnapshot.model_validate(self.__dict__)

    @classmethod
    def from_snapshot(cls, snapshot: SubagentRunSnapshot) -> SubagentRunRecord:
        payload = snapshot.model_dump(mode="json")
        created_at = str(payload["created_at"])
        return cls(
            run_id=str(payload["run_id"]),
            subagent_id=str(payload["subagent_id"]),
            child_session_id=str(payload["child_session_id"]),
            parent_session_id=str(payload["parent_session_id"]),
            parent_trace_id=payload["parent_trace_id"],
            parent_tool_call_id=payload["parent_tool_call_id"],
            parent_timeline_sequence=int(payload["parent_timeline_sequence"]),
            initiated_by=str(payload["initiated_by"]),
            role=str(payload["role"]),
            task=str(payload["task"]),
            state=str(payload["state"]),
            blocked_on=payload["blocked_on"],
            version=int(payload["version"]),
            final_report=payload["final_report"],
            report_truncated=bool(payload["report_truncated"]),
            error_code=payload["error_code"],
            error_message=payload["error_message"],
            created_at=created_at,
            queued_at=str(payload["queued_at"] or created_at),
            started_at=payload["started_at"],
            finished_at=payload["finished_at"],
            updated_at=str(payload["updated_at"] or created_at),
            cancel_requested_at=payload["cancel_requested_at"],
        )


@dataclass(frozen=True)
class ArchivedSessionSummary:
    session: SessionRecord
    workspace_name: str | None
    workspace_archived_at: str | None


@dataclass(frozen=True)
class ArchivedSessionPage:
    items: list[ArchivedSessionSummary]
    next_cursor: str | None
    has_more: bool


@dataclass(frozen=True)
class SessionLifecycleMutation:
    record: SessionRecord | None
    changed: bool


@dataclass(frozen=True)
class LifecycleOperationRecord:
    id: str
    request_id: str
    payload_hash: str
    entity_type: str
    entity_id: str | None
    entity_hash: str
    action: str
    state: str
    revision: int
    counts: dict[str, int]
    result: dict[str, Any]
    error_code: str | None
    error_detail: dict[str, Any]
    quarantine_token: str | None
    created_at: str
    updated_at: str
    completed_at: str | None


@dataclass(frozen=True)
class LifecycleOperationCreateResult:
    operation: LifecycleOperationRecord
    created: bool


@dataclass(frozen=True)
class SessionForkRecord:
    id: str
    source_session_id: str
    target_session_id: str
    source_message_event_id: str
    target_message_event_id: str
    source_turn_index: int
    target_turn_index: int
    relation_type: str
    created_at: str
    updated_at: str
    source_trace_id: str | None = None
    source_active_session_id: str | None = None
    source_checkpoint_id: str | None = None
    source_checkpoint_ns: str = ""
    is_deleted: bool = False


@dataclass(frozen=True)
class ThreadTaskRecord:
    id: str
    session_id: str
    type: str
    objective: str
    status: str
    metadata: dict[str, Any]
    evidence: list[Any]
    blocked_audit: dict[str, Any]
    turn_count: int
    elapsed_seconds: int
    token_usage: dict[str, Any]
    created_at: str
    updated_at: str
    title: str | None = None
    system_stop_reason: str | None = None
    current_run_id: str | None = None
    deleted_at: str | None = None

    @property
    def is_open(self) -> bool:
        return self.deleted_at is None and self.status in THREAD_TASK_OPEN_STATUSES

    @property
    def is_terminal(self) -> bool:
        return self.status in THREAD_TASK_TERMINAL_STATUSES

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> ThreadTaskRecord:
        return cls(
            id=row["id"],
            session_id=row["session_id"],
            type=row["type"],
            title=row["title"],
            objective=row["objective"],
            status=row["status"],
            metadata=_json_object_loads(row["metadata_json"], field_name="metadata_json"),
            evidence=_json_array_loads(row["evidence_json"], field_name="evidence_json"),
            blocked_audit=_json_object_loads(
                row["blocked_audit_json"],
                field_name="blocked_audit_json",
            ),
            system_stop_reason=row["system_stop_reason"],
            current_run_id=row["current_run_id"],
            turn_count=int(row["turn_count"]),
            elapsed_seconds=int(row["elapsed_seconds"]),
            token_usage=_json_object_loads(
                row["token_usage_json"],
                field_name="token_usage_json",
            ),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            deleted_at=row["deleted_at"],
        )


@dataclass(frozen=True)
class ThreadTaskRunRecord:
    id: str
    task_id: str
    session_id: str
    status: str
    summary: dict[str, Any]
    error: dict[str, Any]
    started_at: str
    created_at: str
    updated_at: str
    turn_index: int | None = None
    trace_id: str | None = None
    finished_at: str | None = None

    @property
    def is_running(self) -> bool:
        return self.status == THREAD_TASK_RUN_STATUS_RUNNING

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> ThreadTaskRunRecord:
        raw_turn_index = row["turn_index"]
        return cls(
            id=row["id"],
            task_id=row["task_id"],
            session_id=row["session_id"],
            turn_index=int(raw_turn_index) if raw_turn_index is not None else None,
            trace_id=row["trace_id"],
            status=row["status"],
            summary=_json_object_loads(row["summary_json"], field_name="summary_json"),
            error=_json_object_loads(row["error_json"], field_name="error_json"),
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


@dataclass(frozen=True)
class AttachmentRecord:
    id: str
    session_id: str | None
    user_id: str
    type: str
    source: str
    name: str
    path: str
    mime_type: str
    size: int
    created_at: str
    updated_at: str
    is_deleted: bool = False


@dataclass(frozen=True)
class MessageEventRecord:
    id: str
    session_id: str
    seq: int
    turn_index: int
    action: str
    data: dict[str, Any]
    created_at: str
    updated_at: str
    trace_record_id: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class PendingInputRecord:
    id: str
    session_id: str
    client_input_id: str | None
    mode: str
    status: str
    message: str
    provider_id: str
    model: str
    user_id: str | None
    scene_id: str | None
    runtime_params: dict[str, Any]
    attachments: list[dict[str, Any]]
    target_turn_index: int | None
    target_trace_id: str | None
    promoted_turn_index: int | None
    promoted_trace_id: str | None
    queue_position: int
    lock_owner: str | None
    lock_expires_at: str | None
    error_code: str | None
    error_message: str | None
    created_at: str
    updated_at: str
    delivered_at: str | None = None
    cancelled_at: str | None = None
    paused_at: str | None = None
    pause_reason: str | None = None
    is_deleted: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "pending_input_id": self.id,
            "session_id": self.session_id,
            "client_input_id": self.client_input_id,
            "mode": self.mode,
            "status": self.status,
            "message": self.message,
            "provider_id": self.provider_id,
            "model": self.model,
            "user_id": self.user_id,
            "scene_id": self.scene_id,
            "runtime_params": self.runtime_params,
            "attachments": self.attachments,
            "target_turn_index": self.target_turn_index,
            "target_trace_id": self.target_trace_id,
            "promoted_turn_index": self.promoted_turn_index,
            "promoted_trace_id": self.promoted_trace_id,
            "queue_position": self.queue_position,
            "lock_owner": self.lock_owner,
            "lock_expires_at": self.lock_expires_at,
            "error_code": self.error_code,
            "error_message": self.error_message,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "delivered_at": self.delivered_at,
            "cancelled_at": self.cancelled_at,
            "paused_at": self.paused_at,
            "pause_reason": self.pause_reason,
            "paused": self.paused_at is not None,
            "is_deleted": self.is_deleted,
        }


@dataclass(frozen=True)
class A2UIInteractionRecord:
    id: str
    session_id: str
    stream_id: str
    render_key: str
    mode: str
    payload: dict[str, Any]
    input_schema: dict[str, Any]
    submit_schema_snapshot: dict[str, Any]
    status: str
    resume_status: str
    created_at: str
    updated_at: str
    trace_id: str | None = None
    active_session_id: str | None = None
    turn_index: int = 0
    tool_call_id: str | None = None
    submit_request_id: str | None = None
    cancel_request_id: str | None = None
    submit_result: dict[str, Any] | None = None
    cancel_reason: str | None = None
    langgraph_thread_id: str | None = None
    checkpoint_ns: str = ""
    checkpoint_id: str | None = None
    interrupt_id: str | None = None
    resume_group_id: str | None = None
    resume_payload: dict[str, Any] | None = None
    resume_error: str | None = None
    submitted_at: str | None = None
    cancelled_at: str | None = None
    resume_started_at: str | None = None
    resume_finished_at: str | None = None
    is_deleted: bool = False

    @property
    def can_submit(self) -> bool:
        return self.status == A2UI_STATUS_WAITING_USER_INPUT and not self.is_deleted


@dataclass(frozen=True)
class CompressionStagingRecord:
    id: int
    original_session_id: str
    active_session_id: str
    target_session_id: str
    generation: int
    status: str
    created_at: str
    updated_at: str
    staging_strategy: str = "anchor_replacement"
    anchor_message_id: str | None = None
    source_last_message_id: str | None = None
    l1_content: str | None = None
    l2_content: str | None = None
    failure_reason: str | None = None
    applied_at: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class ToolResultArtifactRecord:
    id: str
    owner_user_id: str
    source_session_id: str | None
    tool_call_id: str
    tool_name: str
    storage_kind: str
    relative_path: str
    content_type: str
    content_sha256: str
    content_bytes: int
    approximate_tokens: int
    is_complete: bool
    status: str
    created_at: str
    last_accessed_at: str | None = None
    deleted_at: str | None = None


@dataclass(frozen=True)
class TraceRecord:
    trace_id: str
    session_id: str
    scene_id: str
    user_id: str
    turn_index: int
    root_node_id: str
    status: str
    start_time: str
    created_at: str
    updated_at: str
    active_session_id: str | None = None
    scene_name: str | None = None
    scene_version_seq: int | None = None
    end_time: str | None = None
    duration_ms: int | None = None
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_tokens: int = 0
    total_cache_read_tokens: int = 0
    user_message_preview: str | None = None
    input_checkpoint_id: str | None = None
    input_checkpoint_ns: str | None = None
    input_file_snapshot_id: str | None = None
    input_file_snapshot_status: str | None = None
    output_checkpoint_id: str | None = None
    output_checkpoint_ns: str | None = None
    metadata: dict[str, Any] | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class TraceEventLogRecord:
    id: int
    trace_id: str
    trace_record_id: str
    event_type: str
    source: str
    idempotency_key: str
    timestamp_ms: int
    occurred_at: str
    payload: dict[str, Any]
    created_at: str
    updated_at: str
    node_id: str | None = None
    parent_node_id: str | None = None
    root_node_id: str | None = None
    sequence_no: int | None = None
    run_id: str | None = None
    turn_index: int | None = None
    user_id: str | None = None
    original_session_id: str | None = None
    active_session_id: str | None = None
    tags: dict[str, Any] | None = None


@dataclass(frozen=True)
class LLMRequestLogRecord:
    id: str
    trace_id: str
    trace_record_id: str
    session_id: str
    model: str
    status: str
    start_time: str
    created_at: str
    updated_at: str
    active_session_id: str | None = None
    gateway_thread_id: str | None = None
    gateway_trace_id: str | None = None
    turn_index: int | None = None
    provider_id: str | None = None
    provider_name: str | None = None
    end_time: str | None = None
    duration_ms: int | None = None
    time_to_first_token: int | None = None
    input_tokens: int = 0
    cache_read_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    request_preview: str | None = None
    response_preview: str | None = None
    error_message: str | None = None
    metadata: dict[str, Any] | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class CommandApprovalRequestRecord:
    id: str
    session_id: str
    tool_name: str
    kind: str
    title: str
    description: str
    command: str
    cwd: str
    shell: str
    workspace_root: str
    details: dict[str, Any]
    status: str
    created_at: str
    updated_at: str
    trace_id: str | None = None
    turn_index: int | None = None
    run_id: str | None = None
    decision: str | None = None
    trust_scope: str | None = None
    rule_match_type: str | None = None
    reject_message: str | None = None
    trusted_rule_id: str | None = None
    resolved_at: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class TrustedCommandRuleRecord:
    id: str
    command_pattern: str
    normalized_command: str
    match_type: str
    tool_name: str
    shell: str
    shell_path: str
    workspace_root: str
    cwd_pattern: str
    enabled: bool
    created_at: str
    updated_at: str
    created_from_approval_id: str | None = None
    last_used_at: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class CommandApprovalAuditRecord:
    id: str
    approval_id: str
    session_id: str
    command: str
    cwd: str
    decision: str
    created_at: str
    trust_scope: str | None = None
    rule_match_type: str | None = None
    trusted_rule_id: str | None = None
    reject_message: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class McpServerRecord:
    id: str
    name: str
    enabled: bool
    required: bool
    transport: str
    inherit_environment: bool
    auth_type: str
    startup_timeout_sec: int
    tool_timeout_sec: int
    read_timeout_sec: int
    sse_read_timeout_sec: int
    shutdown_timeout_sec: int
    restart_policy: str
    connect_mode: str
    auto_refresh: bool
    refresh_interval_sec: int
    default_tool_exposure_mode: str
    default_tool_approval_mode: str
    supports_parallel_tool_calls: bool
    elicitation_enabled: bool
    sampling_enabled: bool
    created_at: str
    updated_at: str
    description: str | None = None
    command: str | None = None
    args: list[Any] | None = None
    cwd: str | None = None
    env: dict[str, Any] | None = None
    url: str | None = None
    sse_url: str | None = None
    message_url: str | None = None
    headers: dict[str, Any] | None = None
    env_headers: dict[str, Any] | None = None
    bearer_token_env_var: str | None = None
    secret_refs: dict[str, Any] | None = None
    oauth_config: dict[str, Any] | None = None
    oauth_resource: str | None = None
    oauth_scopes: list[Any] | None = None
    resource_reserved_policy: dict[str, Any] | None = None


@dataclass(frozen=True)
class McpServerStatusRecord:
    server_id: str
    status: str
    last_refresh_revision: int
    tools_count: int
    resources_reserved_count: int
    updated_at: str
    capabilities: dict[str, Any] | None = None
    server_info: dict[str, Any] | None = None
    last_connected_at: str | None = None
    last_refresh_at: str | None = None
    last_error_code: str | None = None
    last_error_message: str | None = None
    last_error_detail: dict[str, Any] | None = None


@dataclass(frozen=True)
class McpToolRecord:
    id: str
    server_id: str
    raw_name: str
    model_name: str
    callable_namespace: str
    callable_name: str
    input_schema: dict[str, Any]
    schema_hash: str
    discovery_status: str
    first_seen_at: str
    last_seen_at: str
    call_count: int
    failure_count: int
    display_name: str | None = None
    description: str | None = None
    annotations: dict[str, Any] | None = None
    meta: dict[str, Any] | None = None
    removed_at: str | None = None
    last_used_at: str | None = None


@dataclass(frozen=True)
class McpResourceRecord:
    id: str
    server_id: str
    uri: str
    reserved_only: bool
    name: str | None = None
    description: str | None = None
    mime_type: str | None = None
    meta: dict[str, Any] | None = None
    last_seen_at: str | None = None


@dataclass(frozen=True)
class McpResourceTemplateRecord:
    id: str
    server_id: str
    uri_template: str
    reserved_only: bool
    name: str | None = None
    description: str | None = None
    mime_type: str | None = None
    meta: dict[str, Any] | None = None
    last_seen_at: str | None = None


@dataclass(frozen=True)
class McpToolPolicyRecord:
    id: str
    server_id: str
    raw_tool_name: str
    enabled: bool
    hidden: bool
    priority_available: bool
    approval_mode: str
    schema_change_action: str
    updated_at: str
    parameter_constraints: dict[str, Any] | None = None


@dataclass(frozen=True)
class McpSessionToolOverrideRecord:
    id: str
    session_id: str
    server_id: str
    raw_tool_name: str
    enabled: bool
    created_at: str
    reason: str | None = None
    expires_at: str | None = None


@dataclass(frozen=True)
class McpSessionToolUsageRecord:
    session_id: str
    server_id: str
    raw_tool_name: str
    model_name: str
    success_count: int
    last_success_at: str


@dataclass(frozen=True)
class McpRuntimeSnapshotRecord:
    id: str
    session_id: str
    tool_inventory_revision: int
    visible_tools: list[Any]
    server_status: dict[str, Any]
    policy_summary: dict[str, Any]
    created_at: str
    turn_id: str | None = None
    capability_directory: list[Any] = field(default_factory=list)
    direct_available_tools: int = 0
    on_demand_tools: int = 0
    unavailable_tools: int = 0


@dataclass(frozen=True)
class McpTrustRuleRecord:
    id: str
    rule_kind: str
    scope: str
    approval_mode: str
    hit_count: int
    created_at: str
    updated_at: str
    server_id: str | None = None
    raw_tool_name: str | None = None
    session_id: str | None = None
    condition: dict[str, Any] | None = None
    created_from_approval_id: str | None = None
    expires_at: str | None = None
    last_hit_at: str | None = None


@dataclass(frozen=True)
class McpOAuthTokenRecord:
    id: str
    server_id: str
    token_ref: str
    status: str
    created_at: str
    updated_at: str
    account_label: str | None = None
    refresh_token_ref: str | None = None
    scopes: list[Any] | None = None
    expires_at: str | None = None


@dataclass(frozen=True)
class McpAuditLogRecord:
    id: str
    event_type: str
    created_at: str
    server_id: str | None = None
    raw_tool_name: str | None = None
    session_id: str | None = None
    turn_id: str | None = None
    call_id: str | None = None
    approval_id: str | None = None
    actor: str | None = None
    status: str | None = None
    duration_ms: int | None = None
    summary: str | None = None
    detail: dict[str, Any] | None = None


class McpServersRepository:
    VALID_TRANSPORTS = {"stdio", "streamable_http", "sse"}
    VALID_AUTH_TYPES = {"none", "header_token", "bearer_env", "oauth"}
    VALID_RESTART_POLICIES = {"never", "on_failure", "always"}
    VALID_CONNECT_MODES = {"on_startup", "on_demand"}
    VALID_TOOL_EXPOSURE_MODES = {
        "allow_all_except_disabled",
        "allow_selected_only",
    }
    VALID_TOOL_APPROVAL_MODES = {"auto", "prompt", "approve"}
    JSON_FIELDS = {
        "args": "args_json",
        "env": "env_json",
        "headers": "headers_json",
        "env_headers": "env_headers_json",
        "secret_refs": "secret_refs_json",
        "oauth_config": "oauth_config_json",
        "oauth_scopes": "oauth_scopes_json",
        "resource_reserved_policy": "resource_reserved_policy_json",
    }
    BOOL_FIELDS = {
        "enabled",
        "required",
        "inherit_environment",
        "auto_refresh",
        "supports_parallel_tool_calls",
        "elicitation_enabled",
        "sampling_enabled",
    }
    DIRECT_FIELDS = {
        "name",
        "description",
        "transport",
        "command",
        "cwd",
        "url",
        "sse_url",
        "message_url",
        "bearer_token_env_var",
        "auth_type",
        "oauth_resource",
        "startup_timeout_sec",
        "tool_timeout_sec",
        "read_timeout_sec",
        "sse_read_timeout_sec",
        "shutdown_timeout_sec",
        "restart_policy",
        "connect_mode",
        "refresh_interval_sec",
        "default_tool_exposure_mode",
        "default_tool_approval_mode",
    }

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        server_id: str,
        name: str,
        transport: str,
        description: str | None = None,
        enabled: bool = True,
        required: bool = False,
        command: str | None = None,
        args: list[Any] | None = None,
        cwd: str | None = None,
        inherit_environment: bool = True,
        env: dict[str, Any] | None = None,
        url: str | None = None,
        sse_url: str | None = None,
        message_url: str | None = None,
        headers: dict[str, Any] | None = None,
        env_headers: dict[str, Any] | None = None,
        bearer_token_env_var: str | None = None,
        auth_type: str = "none",
        secret_refs: dict[str, Any] | None = None,
        oauth_config: dict[str, Any] | None = None,
        oauth_resource: str | None = None,
        oauth_scopes: list[Any] | None = None,
        startup_timeout_sec: int = 30,
        tool_timeout_sec: int = 60,
        read_timeout_sec: int = 60,
        sse_read_timeout_sec: int = 300,
        shutdown_timeout_sec: int = 10,
        restart_policy: str = "on_failure",
        connect_mode: str = "on_demand",
        auto_refresh: bool = True,
        refresh_interval_sec: int = 60,
        default_tool_exposure_mode: str = "allow_all_except_disabled",
        default_tool_approval_mode: str = "prompt",
        supports_parallel_tool_calls: bool = False,
        elicitation_enabled: bool = True,
        sampling_enabled: bool = False,
        resource_reserved_policy: dict[str, Any] | None = None,
    ) -> McpServerRecord:
        if not name.strip():
            raise ValueError("MCP server 名称不能为空")
        self._validate_fields(
            transport=transport,
            auth_type=auth_type,
            restart_policy=restart_policy,
            connect_mode=connect_mode,
            default_tool_exposure_mode=default_tool_exposure_mode,
            default_tool_approval_mode=default_tool_approval_mode,
        )
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_servers (
                  id, name, description, enabled, required, transport, command, args_json, cwd,
                  inherit_environment, env_json, url, sse_url, message_url, headers_json,
                  env_headers_json, bearer_token_env_var, auth_type, secret_refs_json,
                  oauth_config_json, oauth_resource, oauth_scopes_json, startup_timeout_sec,
                  tool_timeout_sec, read_timeout_sec, sse_read_timeout_sec, shutdown_timeout_sec,
                  restart_policy, connect_mode, auto_refresh, refresh_interval_sec,
                  default_tool_exposure_mode, default_tool_approval_mode,
                  supports_parallel_tool_calls, elicitation_enabled, sampling_enabled,
                  resource_reserved_policy_json, created_at, updated_at
                ) values (
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    server_id,
                    name.strip(),
                    description,
                    int(enabled),
                    int(required),
                    transport,
                    command,
                    _json_dumps(args) if args is not None else None,
                    cwd,
                    int(inherit_environment),
                    _json_dumps(env) if env is not None else None,
                    url,
                    sse_url,
                    message_url,
                    _json_dumps(headers) if headers is not None else None,
                    _json_dumps(env_headers) if env_headers is not None else None,
                    bearer_token_env_var,
                    auth_type,
                    _json_dumps(secret_refs) if secret_refs is not None else None,
                    _json_dumps(oauth_config) if oauth_config is not None else None,
                    oauth_resource,
                    _json_dumps(oauth_scopes) if oauth_scopes is not None else None,
                    startup_timeout_sec,
                    tool_timeout_sec,
                    read_timeout_sec,
                    sse_read_timeout_sec,
                    shutdown_timeout_sec,
                    restart_policy,
                    connect_mode,
                    int(auto_refresh),
                    refresh_interval_sec,
                    default_tool_exposure_mode,
                    default_tool_approval_mode,
                    int(supports_parallel_tool_calls),
                    int(elicitation_enabled),
                    int(sampling_enabled),
                    _json_dumps(resource_reserved_policy)
                    if resource_reserved_policy is not None
                    else None,
                    now,
                    now,
                ),
            )
            conn.execute(
                """
                insert into mcp_server_status (server_id, updated_at)
                values (?, ?)
                on conflict(server_id) do nothing
                """,
                (server_id, now),
            )
        record = self.get(server_id)
        if record is None:
            raise RuntimeError(f"创建 MCP server 后无法读取: {server_id}")
        return record

    def get(self, server_id: str) -> McpServerRecord | None:
        with self.db.connect() as conn:
            row = conn.execute("select * from mcp_servers where id = ?", (server_id,)).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        enabled: bool | None = None,
        transport: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[McpServerRecord], int]:
        filters: list[str] = []
        params: list[Any] = []
        if enabled is not None:
            filters.append("enabled = ?")
            params.append(int(enabled))
        if transport is not None:
            self._require_choice("transport", transport, self.VALID_TRANSPORTS)
            filters.append("transport = ?")
            params.append(transport)
        where = f"where {' and '.join(filters)}" if filters else ""
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from mcp_servers {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from mcp_servers
                {where}
                order by updated_at desc, created_at desc, name asc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    def update(self, server_id: str, **changes: Any) -> McpServerRecord | None:
        if not changes:
            return self.get(server_id)
        assignments: list[str] = []
        params: list[Any] = []
        for field_name, value in changes.items():
            if field_name in self.DIRECT_FIELDS:
                self._validate_update_field(field_name, value)
                assignments.append(f"{field_name} = ?")
                params.append(
                    value.strip() if field_name == "name" and isinstance(value, str) else value
                )
            elif field_name in self.BOOL_FIELDS:
                assignments.append(f"{field_name} = ?")
                params.append(int(bool(value)))
            elif field_name in self.JSON_FIELDS:
                assignments.append(f"{self.JSON_FIELDS[field_name]} = ?")
                params.append(_json_dumps(value) if value is not None else None)
            else:
                raise ValueError(f"不支持更新的 MCP server 字段: {field_name}")
        assignments.append("updated_at = ?")
        params.append(to_iso_z(utc_now()))
        params.append(server_id)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"""
                update mcp_servers
                set {", ".join(assignments)}
                where id = ?
                """,
                params,
            )
        if cursor.rowcount == 0:
            return None
        return self.get(server_id)

    def set_enabled(self, server_id: str, enabled: bool) -> McpServerRecord | None:
        return self.update(server_id, enabled=enabled)

    def delete(self, server_id: str) -> bool:
        with self.db.transaction() as conn:
            cursor = conn.execute("delete from mcp_servers where id = ?", (server_id,))
        return int(cursor.rowcount or 0) > 0

    @classmethod
    def _validate_fields(
        cls,
        *,
        transport: str,
        auth_type: str,
        restart_policy: str,
        connect_mode: str,
        default_tool_exposure_mode: str,
        default_tool_approval_mode: str,
    ) -> None:
        cls._require_choice("transport", transport, cls.VALID_TRANSPORTS)
        cls._require_choice("auth_type", auth_type, cls.VALID_AUTH_TYPES)
        cls._require_choice("restart_policy", restart_policy, cls.VALID_RESTART_POLICIES)
        cls._require_choice("connect_mode", connect_mode, cls.VALID_CONNECT_MODES)
        cls._require_choice(
            "default_tool_exposure_mode",
            default_tool_exposure_mode,
            cls.VALID_TOOL_EXPOSURE_MODES,
        )
        cls._require_choice(
            "default_tool_approval_mode",
            default_tool_approval_mode,
            cls.VALID_TOOL_APPROVAL_MODES,
        )

    @classmethod
    def _validate_update_field(cls, field_name: str, value: Any) -> None:
        if field_name == "transport":
            cls._require_choice(field_name, str(value), cls.VALID_TRANSPORTS)
        elif field_name == "auth_type":
            cls._require_choice(field_name, str(value), cls.VALID_AUTH_TYPES)
        elif field_name == "restart_policy":
            cls._require_choice(field_name, str(value), cls.VALID_RESTART_POLICIES)
        elif field_name == "connect_mode":
            cls._require_choice(field_name, str(value), cls.VALID_CONNECT_MODES)
        elif field_name == "default_tool_exposure_mode":
            cls._require_choice(field_name, str(value), cls.VALID_TOOL_EXPOSURE_MODES)
        elif field_name == "default_tool_approval_mode":
            cls._require_choice(field_name, str(value), cls.VALID_TOOL_APPROVAL_MODES)
        elif field_name == "name" and not str(value).strip():
            raise ValueError("MCP server 名称不能为空")

    @staticmethod
    def _require_choice(field_name: str, value: str, allowed: set[str]) -> None:
        if value not in allowed:
            expected = ", ".join(sorted(allowed))
            raise ValueError(
                f"不支持的 MCP server {field_name}: {value}; expected one of: {expected}"
            )

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpServerRecord:
        return McpServerRecord(
            id=row["id"],
            name=row["name"],
            description=row["description"],
            enabled=bool(row["enabled"]),
            required=bool(row["required"]),
            transport=row["transport"],
            command=row["command"],
            args=_json_loads(row["args_json"], None),
            cwd=row["cwd"],
            inherit_environment=bool(row["inherit_environment"]),
            env=_json_loads(row["env_json"], None),
            url=row["url"],
            sse_url=row["sse_url"],
            message_url=row["message_url"],
            headers=_json_loads(row["headers_json"], None),
            env_headers=_json_loads(row["env_headers_json"], None),
            bearer_token_env_var=row["bearer_token_env_var"],
            auth_type=row["auth_type"],
            secret_refs=_json_loads(row["secret_refs_json"], None),
            oauth_config=_json_loads(row["oauth_config_json"], None),
            oauth_resource=row["oauth_resource"],
            oauth_scopes=_json_loads(row["oauth_scopes_json"], None),
            startup_timeout_sec=int(row["startup_timeout_sec"]),
            tool_timeout_sec=int(row["tool_timeout_sec"]),
            read_timeout_sec=int(row["read_timeout_sec"]),
            sse_read_timeout_sec=int(row["sse_read_timeout_sec"]),
            shutdown_timeout_sec=int(row["shutdown_timeout_sec"]),
            restart_policy=row["restart_policy"],
            connect_mode=row["connect_mode"],
            auto_refresh=bool(row["auto_refresh"]),
            refresh_interval_sec=int(row["refresh_interval_sec"]),
            default_tool_exposure_mode=row["default_tool_exposure_mode"],
            default_tool_approval_mode=row["default_tool_approval_mode"],
            supports_parallel_tool_calls=bool(row["supports_parallel_tool_calls"]),
            elicitation_enabled=bool(row["elicitation_enabled"]),
            sampling_enabled=bool(row["sampling_enabled"]),
            resource_reserved_policy=_json_loads(row["resource_reserved_policy_json"], None),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class McpServerStatusRepository:
    VALID_STATUSES = {
        "unknown",
        "online",
        "offline",
        "auth_required",
        "error",
        "disabled",
    }

    def __init__(self, db: Database) -> None:
        self.db = db

    def get(self, server_id: str) -> McpServerStatusRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from mcp_server_status where server_id = ?",
                (server_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def upsert(
        self,
        server_id: str,
        *,
        status: str = "unknown",
        capabilities: dict[str, Any] | None = None,
        server_info: dict[str, Any] | None = None,
        last_connected_at: str | None = None,
        last_refresh_at: str | None = None,
        last_refresh_revision: int | None = None,
        last_error_code: str | None = None,
        last_error_message: str | None = None,
        last_error_detail: dict[str, Any] | None = None,
        tools_count: int = 0,
        resources_reserved_count: int = 0,
    ) -> McpServerStatusRecord:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        existing = self.get(server_id) if last_refresh_revision is None else None
        resolved_last_refresh_revision = (
            last_refresh_revision
            if last_refresh_revision is not None
            else existing.last_refresh_revision
            if existing is not None
            else 0
        )
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_server_status (
                  server_id, status, capabilities_json, server_info_json, last_connected_at,
                  last_refresh_at, last_refresh_revision, last_error_code, last_error_message,
                  last_error_detail_json, tools_count, resources_reserved_count,
                  updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(server_id) do update set
                  status=excluded.status,
                  capabilities_json=excluded.capabilities_json,
                  server_info_json=excluded.server_info_json,
                  last_connected_at=excluded.last_connected_at,
                  last_refresh_at=excluded.last_refresh_at,
                  last_refresh_revision=excluded.last_refresh_revision,
                  last_error_code=excluded.last_error_code,
                  last_error_message=excluded.last_error_message,
                  last_error_detail_json=excluded.last_error_detail_json,
                  tools_count=excluded.tools_count,
                  resources_reserved_count=excluded.resources_reserved_count,
                  updated_at=excluded.updated_at
                """,
                (
                    server_id,
                    status,
                    _json_dumps(capabilities) if capabilities is not None else None,
                    _json_dumps(server_info) if server_info is not None else None,
                    last_connected_at,
                    last_refresh_at,
                    resolved_last_refresh_revision,
                    last_error_code,
                    last_error_message,
                    _json_dumps(last_error_detail) if last_error_detail is not None else None,
                    tools_count,
                    resources_reserved_count,
                    now,
                ),
            )
        record = self.get(server_id)
        if record is None:
            raise RuntimeError(f"写入 MCP server status 后无法读取: {server_id}")
        return record

    def update_error(
        self,
        server_id: str,
        *,
        status: str = "error",
        error_code: str | None = None,
        error_message: str | None = None,
        error_detail: dict[str, Any] | None = None,
    ) -> McpServerStatusRecord:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update mcp_server_status set
                  status = ?,
                  last_error_code = ?,
                  last_error_message = ?,
                  last_error_detail_json = ?,
                  updated_at = ?
                where server_id = ?
                """,
                (
                    status,
                    error_code,
                    error_message,
                    _json_dumps(error_detail) if error_detail is not None else None,
                    now,
                    server_id,
                ),
            )
        record = self.get(server_id)
        if record is None:
            return self.upsert(
                server_id,
                status=status,
                last_error_code=error_code,
                last_error_message=error_message,
                last_error_detail=error_detail,
            )
        return record

    def update_refresh_counts(
        self,
        server_id: str,
        *,
        status: str = "online",
        capabilities: dict[str, Any] | None = None,
        server_info: dict[str, Any] | None = None,
        tools_count: int = 0,
        resources_reserved_count: int = 0,
    ) -> McpServerStatusRecord:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_server_status (
                  server_id, status, capabilities_json, server_info_json, last_connected_at,
                  last_refresh_at, last_refresh_revision, tools_count,
                  resources_reserved_count, updated_at
                ) values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                on conflict(server_id) do update set
                  status=excluded.status,
                  capabilities_json=excluded.capabilities_json,
                  server_info_json=excluded.server_info_json,
                  last_connected_at=excluded.last_connected_at,
                  last_refresh_at=excluded.last_refresh_at,
                  last_refresh_revision=mcp_server_status.last_refresh_revision + 1,
                  last_error_code=null,
                  last_error_message=null,
                  last_error_detail_json=null,
                  tools_count=excluded.tools_count,
                  resources_reserved_count=excluded.resources_reserved_count,
                  updated_at=excluded.updated_at
                """,
                (
                    server_id,
                    status,
                    _json_dumps(capabilities) if capabilities is not None else None,
                    _json_dumps(server_info) if server_info is not None else None,
                    now,
                    now,
                    tools_count,
                    resources_reserved_count,
                    now,
                ),
            )
        record = self.get(server_id)
        if record is None:
            raise RuntimeError(f"刷新 MCP server status 后无法读取: {server_id}")
        return record

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            expected = ", ".join(sorted(cls.VALID_STATUSES))
            raise ValueError(f"不支持的 MCP server status: {status}; expected one of: {expected}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpServerStatusRecord:
        status = str(row["status"])
        if status == "refreshing":
            status = "unknown"
        return McpServerStatusRecord(
            server_id=row["server_id"],
            status=status,
            capabilities=_json_loads(row["capabilities_json"], None),
            server_info=_json_loads(row["server_info_json"], None),
            last_connected_at=row["last_connected_at"],
            last_refresh_at=row["last_refresh_at"],
            last_refresh_revision=int(row["last_refresh_revision"]),
            last_error_code=row["last_error_code"],
            last_error_message=row["last_error_message"],
            last_error_detail=_json_loads(row["last_error_detail_json"], None),
            tools_count=int(row["tools_count"]),
            resources_reserved_count=int(row["resources_reserved_count"]),
            updated_at=row["updated_at"],
        )


class McpToolsRepository:
    VALID_DISCOVERY_STATUSES = {"new", "active", "removed", "schema_changed"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def upsert_many(self, server_id: str, tools: list[dict[str, Any]]) -> list[McpToolRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            for tool in tools:
                raw_name = self._required_text(tool, "raw_name")
                model_name = self._required_text(tool, "model_name")
                callable_namespace = self._required_text(tool, "callable_namespace")
                callable_name = self._required_text(tool, "callable_name")
                schema_hash = self._required_text(tool, "schema_hash")
                input_schema = tool.get("input_schema") or {}
                if not isinstance(input_schema, dict):
                    raise ValueError("MCP tool input_schema 必须是 JSON 对象")
                conn.execute(
                    """
                    insert into mcp_tools (
                      id, server_id, raw_name, model_name, callable_namespace, callable_name,
                      display_name, description, input_schema_json, annotations_json, meta_json,
                      schema_hash, discovery_status, first_seen_at, last_seen_at,
                      removed_at
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, null)
                    on conflict(server_id, raw_name) do update set
                      model_name=excluded.model_name,
                      callable_namespace=excluded.callable_namespace,
                      callable_name=excluded.callable_name,
                      display_name=excluded.display_name,
                      description=excluded.description,
                      input_schema_json=excluded.input_schema_json,
                      annotations_json=excluded.annotations_json,
                      meta_json=excluded.meta_json,
                      schema_hash=excluded.schema_hash,
                      discovery_status=case
                        when mcp_tools.schema_hash <> excluded.schema_hash
                          then 'schema_changed'
                        else 'active'
                      end,
                      last_seen_at=excluded.last_seen_at,
                      removed_at=null
                    """,
                    (
                        str(tool.get("id") or new_id()),
                        server_id,
                        raw_name,
                        model_name,
                        callable_namespace,
                        callable_name,
                        tool.get("display_name"),
                        tool.get("description"),
                        _json_dumps(input_schema),
                        _json_dumps(tool.get("annotations"))
                        if tool.get("annotations") is not None
                        else None,
                        _json_dumps(tool.get("meta")) if tool.get("meta") is not None else None,
                        schema_hash,
                        now,
                        now,
                    ),
                )
        return self.list_by_server(server_id)

    def mark_removed_missing(self, server_id: str, seen_raw_names: list[str]) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            if seen_raw_names:
                placeholders = ", ".join("?" for _ in seen_raw_names)
                cursor = conn.execute(
                    f"""
                    update mcp_tools set
                      discovery_status = 'removed',
                      removed_at = coalesce(removed_at, ?),
                      last_seen_at = ?
                    where server_id = ?
                      and discovery_status <> 'removed'
                      and raw_name not in ({placeholders})
                    """,
                    [now, now, server_id, *seen_raw_names],
                )
            else:
                cursor = conn.execute(
                    """
                    update mcp_tools set
                      discovery_status = 'removed',
                      removed_at = coalesce(removed_at, ?),
                      last_seen_at = ?
                    where server_id = ? and discovery_status <> 'removed'
                    """,
                    (now, now, server_id),
                )
        return int(cursor.rowcount or 0)

    def set_discovery_status(
        self,
        server_id: str,
        raw_name: str,
        status: str,
    ) -> McpToolRecord | None:
        self._validate_choice("discovery_status", status, self.VALID_DISCOVERY_STATUSES)
        now = to_iso_z(utc_now())
        removed_at = now if status == "removed" else None
        with self.db.transaction() as conn:
            conn.execute(
                """
                update mcp_tools set
                  discovery_status = ?,
                  removed_at = ?,
                  last_seen_at = ?
                where server_id = ? and raw_name = ?
                """,
                (status, removed_at, now, server_id, raw_name),
            )
        return self.get_by_raw_name(server_id, raw_name)

    def record_call_result(
        self,
        server_id: str,
        raw_name: str,
        *,
        success: bool,
    ) -> McpToolRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update mcp_tools set
                  call_count = call_count + 1,
                  failure_count = failure_count + ?,
                  last_used_at = ?
                where server_id = ? and raw_name = ?
                """,
                (0 if success else 1, now, server_id, raw_name),
            )
        return self.get_by_raw_name(server_id, raw_name)

    def get_by_raw_name(self, server_id: str, raw_name: str) -> McpToolRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from mcp_tools where server_id = ? and raw_name = ?",
                (server_id, raw_name),
            ).fetchone()
        return self._from_row(row) if row else None

    def get_by_model_name(self, model_name: str) -> McpToolRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from mcp_tools where model_name = ?",
                (model_name,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_model_names(self, *, limit: int = 10000) -> set[str]:
        resolved_limit = max(1, min(limit, 10000))
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select model_name from mcp_tools
                order by model_name asc
                limit ?
                """,
                (resolved_limit,),
            ).fetchall()
        return {str(row["model_name"]) for row in rows}

    def list_by_server(
        self,
        server_id: str,
        *,
        status: str | None = None,
        enabled: bool | None = None,
        limit: int = 500,
    ) -> list[McpToolRecord]:
        filters = ["tools.server_id = ?"]
        params: list[Any] = [server_id]
        if status is not None:
            self._validate_choice("discovery_status", status, self.VALID_DISCOVERY_STATUSES)
            filters.append("tools.discovery_status = ?")
            params.append(status)
        if enabled is not None:
            filters.append("coalesce(policy.enabled, 1) = ?")
            params.append(int(enabled))
        params.append(max(1, min(limit, 1000)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select tools.*
                from mcp_tools tools
                left join mcp_tool_policies policy
                  on policy.server_id = tools.server_id
                 and policy.raw_tool_name = tools.raw_name
                where {" and ".join(filters)}
                order by tools.raw_name asc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    @staticmethod
    def _required_text(tool: dict[str, Any], field_name: str) -> str:
        value = str(tool.get(field_name) or "").strip()
        if not value:
            raise ValueError(f"MCP tool {field_name} 不能为空")
        return value

    @staticmethod
    def _validate_choice(field_name: str, value: str, allowed: set[str]) -> None:
        if value not in allowed:
            expected = ", ".join(sorted(allowed))
            raise ValueError(
                f"不支持的 MCP tool {field_name}: {value}; expected one of: {expected}"
            )

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpToolRecord:
        return McpToolRecord(
            id=row["id"],
            server_id=row["server_id"],
            raw_name=row["raw_name"],
            model_name=row["model_name"],
            callable_namespace=row["callable_namespace"],
            callable_name=row["callable_name"],
            display_name=row["display_name"],
            description=row["description"],
            input_schema=_json_object_loads(
                row["input_schema_json"],
                field_name="input_schema_json",
            ),
            annotations=_json_loads(row["annotations_json"], None),
            meta=_json_loads(row["meta_json"], None),
            schema_hash=row["schema_hash"],
            discovery_status=row["discovery_status"],
            first_seen_at=row["first_seen_at"],
            last_seen_at=row["last_seen_at"],
            removed_at=row["removed_at"],
            last_used_at=row["last_used_at"],
            call_count=int(row["call_count"]),
            failure_count=int(row["failure_count"]),
        )


class McpResourcesRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def upsert_resources(
        self,
        server_id: str,
        resources: list[dict[str, Any]],
    ) -> list[McpResourceRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            for resource in resources:
                uri = self._required_text(resource, "uri")
                conn.execute(
                    """
                    insert into mcp_resources (
                      id, server_id, uri, name, description, mime_type, meta_json,
                      last_seen_at, reserved_only
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, 1)
                    on conflict(server_id, uri) do update set
                      name=excluded.name,
                      description=excluded.description,
                      mime_type=excluded.mime_type,
                      meta_json=excluded.meta_json,
                      last_seen_at=excluded.last_seen_at,
                      reserved_only=1
                    """,
                    (
                        str(resource.get("id") or new_id()),
                        server_id,
                        uri,
                        resource.get("name"),
                        resource.get("description"),
                        resource.get("mime_type"),
                        _json_dumps(resource.get("meta"))
                        if resource.get("meta") is not None
                        else None,
                        now,
                    ),
                )
        return self.list_resources(server_id)

    def upsert_templates(
        self,
        server_id: str,
        templates: list[dict[str, Any]],
    ) -> list[McpResourceTemplateRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            for template in templates:
                uri_template = self._required_text(template, "uri_template")
                conn.execute(
                    """
                    insert into mcp_resource_templates (
                      id, server_id, uri_template, name, description, mime_type, meta_json,
                      last_seen_at, reserved_only
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, 1)
                    on conflict(server_id, uri_template) do update set
                      name=excluded.name,
                      description=excluded.description,
                      mime_type=excluded.mime_type,
                      meta_json=excluded.meta_json,
                      last_seen_at=excluded.last_seen_at,
                      reserved_only=1
                    """,
                    (
                        str(template.get("id") or new_id()),
                        server_id,
                        uri_template,
                        template.get("name"),
                        template.get("description"),
                        template.get("mime_type"),
                        _json_dumps(template.get("meta"))
                        if template.get("meta") is not None
                        else None,
                        now,
                    ),
                )
        return self.list_templates(server_id)

    def list_resources(self, server_id: str) -> list[McpResourceRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from mcp_resources
                where server_id = ?
                order by uri asc
                """,
                (server_id,),
            ).fetchall()
        return [self._resource_from_row(row) for row in rows]

    def list_templates(self, server_id: str) -> list[McpResourceTemplateRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from mcp_resource_templates
                where server_id = ?
                order by uri_template asc
                """,
                (server_id,),
            ).fetchall()
        return [self._template_from_row(row) for row in rows]

    @staticmethod
    def _required_text(item: dict[str, Any], field_name: str) -> str:
        value = str(item.get(field_name) or "").strip()
        if not value:
            raise ValueError(f"MCP resource {field_name} 不能为空")
        return value

    @staticmethod
    def _resource_from_row(row: sqlite3.Row) -> McpResourceRecord:
        return McpResourceRecord(
            id=row["id"],
            server_id=row["server_id"],
            uri=row["uri"],
            name=row["name"],
            description=row["description"],
            mime_type=row["mime_type"],
            meta=_json_loads(row["meta_json"], None),
            last_seen_at=row["last_seen_at"],
            reserved_only=bool(row["reserved_only"]),
        )

    @staticmethod
    def _template_from_row(row: sqlite3.Row) -> McpResourceTemplateRecord:
        return McpResourceTemplateRecord(
            id=row["id"],
            server_id=row["server_id"],
            uri_template=row["uri_template"],
            name=row["name"],
            description=row["description"],
            mime_type=row["mime_type"],
            meta=_json_loads(row["meta_json"], None),
            last_seen_at=row["last_seen_at"],
            reserved_only=bool(row["reserved_only"]),
        )


class McpToolPoliciesRepository:
    VALID_APPROVAL_MODES = {"inherit", "auto", "prompt", "approve", "deny"}
    VALID_RISK_LEVELS = {"low", "medium", "high", "unknown"}
    VALID_SCHEMA_CHANGE_ACTIONS = {"keep_enabled", "require_review", "disable"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def get(self, server_id: str, raw_tool_name: str) -> McpToolPolicyRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from mcp_tool_policies
                where server_id = ? and raw_tool_name = ?
                """,
                (server_id, raw_tool_name),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_by_server(self, server_id: str) -> list[McpToolPolicyRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from mcp_tool_policies
                where server_id = ?
                order by raw_tool_name asc
                """,
                (server_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def upsert(
        self,
        *,
        server_id: str,
        raw_tool_name: str,
        enabled: bool = True,
        hidden: bool = False,
        priority_available: bool = False,
        approval_mode: str = "inherit",
        parameter_constraints: dict[str, Any] | None = None,
        schema_change_action: str = "require_review",
    ) -> McpToolPolicyRecord:
        self._validate(approval_mode, schema_change_action)
        existing = self.get(server_id, raw_tool_name)
        policy_id = existing.id if existing else new_id()
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_tool_policies (
                  id, server_id, raw_tool_name, enabled, hidden, priority_available,
                  approval_mode, parameter_constraints_json, schema_change_action, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(server_id, raw_tool_name) do update set
                  enabled=excluded.enabled,
                  hidden=excluded.hidden,
                  priority_available=excluded.priority_available,
                  approval_mode=excluded.approval_mode,
                  parameter_constraints_json=excluded.parameter_constraints_json,
                  schema_change_action=excluded.schema_change_action,
                  updated_at=excluded.updated_at
                """,
                (
                    policy_id,
                    server_id,
                    raw_tool_name,
                    int(enabled),
                    int(hidden),
                    int(priority_available),
                    approval_mode,
                    _json_dumps(parameter_constraints)
                    if parameter_constraints is not None
                    else None,
                    schema_change_action,
                    now,
                ),
            )
        record = self.get(server_id, raw_tool_name)
        if record is None:
            raise RuntimeError(f"写入 MCP tool policy 后无法读取: {server_id}/{raw_tool_name}")
        return record

    def bulk_update(
        self,
        server_id: str,
        policies: list[dict[str, Any]],
    ) -> list[McpToolPolicyRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            for policy in policies:
                raw_tool_name = str(policy.get("raw_tool_name") or "").strip()
                if not raw_tool_name:
                    raise ValueError("MCP tool policy raw_tool_name 不能为空")
                approval_mode = str(policy.get("approval_mode") or "inherit")
                schema_change_action = str(
                    policy.get("schema_change_action") or "require_review"
                )
                self._validate(approval_mode, schema_change_action)
                conn.execute(
                    """
                    insert into mcp_tool_policies (
                      id, server_id, raw_tool_name, enabled, hidden, priority_available,
                      approval_mode, parameter_constraints_json, schema_change_action, updated_at
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    on conflict(server_id, raw_tool_name) do update set
                      enabled=excluded.enabled,
                      hidden=excluded.hidden,
                      priority_available=excluded.priority_available,
                      approval_mode=excluded.approval_mode,
                      parameter_constraints_json=excluded.parameter_constraints_json,
                      schema_change_action=excluded.schema_change_action,
                      updated_at=excluded.updated_at
                    """,
                    (
                        str(policy.get("id") or new_id()),
                        server_id,
                        raw_tool_name,
                        int(bool(policy.get("enabled", True))),
                        int(bool(policy.get("hidden", False))),
                        int(bool(policy.get("priority_available", False))),
                        approval_mode,
                        _json_dumps(policy.get("parameter_constraints"))
                        if policy.get("parameter_constraints") is not None
                        else None,
                        schema_change_action,
                        now,
                    ),
                )
        return self.list_by_server(server_id)

    @classmethod
    def _validate(
        cls,
        approval_mode: str,
        schema_change_action: str,
    ) -> None:
        if approval_mode not in cls.VALID_APPROVAL_MODES:
            raise ValueError(f"不支持的 MCP tool approval_mode: {approval_mode}")
        if schema_change_action not in cls.VALID_SCHEMA_CHANGE_ACTIONS:
            raise ValueError(f"不支持的 MCP tool schema_change_action: {schema_change_action}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpToolPolicyRecord:
        return McpToolPolicyRecord(
            id=row["id"],
            server_id=row["server_id"],
            raw_tool_name=row["raw_tool_name"],
            enabled=bool(row["enabled"]),
            hidden=bool(row["hidden"]),
            priority_available=bool(row["priority_available"]),
            approval_mode=row["approval_mode"],
            parameter_constraints=_json_loads(row["parameter_constraints_json"], None),
            schema_change_action=row["schema_change_action"],
            updated_at=row["updated_at"],
        )


class McpSessionToolOverridesRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def set(
        self,
        *,
        session_id: str,
        server_id: str,
        raw_tool_name: str,
        enabled: bool,
        reason: str | None = None,
        expires_at: str | None = None,
    ) -> McpSessionToolOverrideRecord:
        now = to_iso_z(utc_now())
        existing = self.get(session_id, server_id, raw_tool_name)
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_session_tool_overrides (
                  id, session_id, server_id, raw_tool_name, enabled, reason,
                  created_at, expires_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(session_id, server_id, raw_tool_name) do update set
                  enabled=excluded.enabled,
                  reason=excluded.reason,
                  expires_at=excluded.expires_at
                """,
                (
                    existing.id if existing else new_id(),
                    session_id,
                    server_id,
                    raw_tool_name,
                    int(enabled),
                    reason,
                    existing.created_at if existing else now,
                    expires_at,
                ),
            )
        record = self.get(session_id, server_id, raw_tool_name)
        if record is None:
            raise RuntimeError("写入 MCP session override 后无法读取")
        return record

    def get(
        self,
        session_id: str,
        server_id: str,
        raw_tool_name: str,
    ) -> McpSessionToolOverrideRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from mcp_session_tool_overrides
                where session_id = ? and server_id = ? and raw_tool_name = ?
                """,
                (session_id, server_id, raw_tool_name),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_by_session(self, session_id: str) -> list[McpSessionToolOverrideRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from mcp_session_tool_overrides
                where session_id = ?
                order by created_at desc, raw_tool_name asc
                """,
                (session_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def delete(self, session_id: str, server_id: str, raw_tool_name: str) -> bool:
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                delete from mcp_session_tool_overrides
                where session_id = ? and server_id = ? and raw_tool_name = ?
                """,
                (session_id, server_id, raw_tool_name),
            )
        return int(cursor.rowcount or 0) > 0

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpSessionToolOverrideRecord:
        return McpSessionToolOverrideRecord(
            id=row["id"],
            session_id=row["session_id"],
            server_id=row["server_id"],
            raw_tool_name=row["raw_tool_name"],
            enabled=bool(row["enabled"]),
            reason=row["reason"],
            created_at=row["created_at"],
            expires_at=row["expires_at"],
        )


class McpSessionToolUsageRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def record_success(
        self,
        *,
        session_id: str,
        server_id: str,
        raw_tool_name: str,
        model_name: str,
    ) -> McpSessionToolUsageRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_session_tool_usage (
                  session_id, server_id, raw_tool_name, model_name,
                  success_count, last_success_at
                ) values (?, ?, ?, ?, 1, ?)
                on conflict(session_id, server_id, raw_tool_name) do update set
                  model_name=excluded.model_name,
                  success_count=mcp_session_tool_usage.success_count + 1,
                  last_success_at=excluded.last_success_at
                """,
                (session_id, server_id, raw_tool_name, model_name, now),
            )
        record = self.get(session_id, server_id, raw_tool_name)
        if record is None:
            raise RuntimeError("写入 MCP session tool usage 后无法读取")
        return record

    def get(
        self,
        session_id: str,
        server_id: str,
        raw_tool_name: str,
    ) -> McpSessionToolUsageRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from mcp_session_tool_usage
                where session_id = ? and server_id = ? and raw_tool_name = ?
                """,
                (session_id, server_id, raw_tool_name),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_recent_model_names(self, session_id: str, *, limit: int = 20) -> list[str]:
        resolved_limit = max(1, min(limit, 100))
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select model_name from mcp_session_tool_usage
                where session_id = ?
                order by last_success_at desc, model_name asc
                limit ?
                """,
                (session_id, resolved_limit),
            ).fetchall()
        return [str(row["model_name"]) for row in rows]

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpSessionToolUsageRecord:
        return McpSessionToolUsageRecord(
            session_id=row["session_id"],
            server_id=row["server_id"],
            raw_tool_name=row["raw_tool_name"],
            model_name=row["model_name"],
            success_count=int(row["success_count"]),
            last_success_at=row["last_success_at"],
        )


class McpRuntimeSnapshotsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def save(
        self,
        *,
        snapshot_id: str,
        session_id: str,
        tool_inventory_revision: int,
        visible_tools: list[Any],
        server_status: dict[str, Any],
        policy_summary: dict[str, Any],
        capability_directory: list[Any] | None = None,
        direct_available_tools: int | None = None,
        on_demand_tools: int | None = None,
        unavailable_tools: int | None = None,
        turn_id: str | None = None,
    ) -> McpRuntimeSnapshotRecord:
        now = to_iso_z(utc_now())
        resolved_capability_directory = capability_directory or []
        resolved_direct_available_tools = _non_negative_int(direct_available_tools)
        resolved_on_demand_tools = _non_negative_int(on_demand_tools)
        resolved_unavailable_tools = _non_negative_int(unavailable_tools)
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_runtime_snapshots (
                  id, session_id, turn_id, tool_inventory_revision, visible_tools_json,
                  server_status_json, policy_summary_json, capability_directory_json,
                  direct_available_tools, on_demand_tools, unavailable_tools, created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_id,
                    session_id,
                    turn_id,
                    tool_inventory_revision,
                    _json_dumps(visible_tools),
                    _json_dumps(server_status),
                    _json_dumps(policy_summary),
                    _json_dumps(resolved_capability_directory),
                    resolved_direct_available_tools,
                    resolved_on_demand_tools,
                    resolved_unavailable_tools,
                    now,
                ),
            )
        record = self.get(snapshot_id)
        if record is None:
            raise RuntimeError(f"保存 MCP runtime snapshot 后无法读取: {snapshot_id}")
        return record

    def get(self, snapshot_id: str) -> McpRuntimeSnapshotRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from mcp_runtime_snapshots where id = ?",
                (snapshot_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_by_session(
        self,
        session_id: str,
        *,
        turn_id: str | None = None,
        limit: int = 100,
    ) -> list[McpRuntimeSnapshotRecord]:
        filters = ["session_id = ?"]
        params: list[Any] = [session_id]
        if turn_id is not None:
            filters.append("turn_id = ?")
            params.append(turn_id)
        params.append(max(1, min(limit, 500)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from mcp_runtime_snapshots
                where {" and ".join(filters)}
                order by created_at desc, id desc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpRuntimeSnapshotRecord:
        return McpRuntimeSnapshotRecord(
            id=row["id"],
            session_id=row["session_id"],
            turn_id=row["turn_id"],
            tool_inventory_revision=int(row["tool_inventory_revision"]),
            visible_tools=_json_array_loads(
                row["visible_tools_json"],
                field_name="visible_tools_json",
            ),
            server_status=_json_object_loads(
                row["server_status_json"],
                field_name="server_status_json",
            ),
            policy_summary=_json_object_loads(
                row["policy_summary_json"],
                field_name="policy_summary_json",
            ),
            created_at=row["created_at"],
            capability_directory=_json_array_loads(
                row["capability_directory_json"],
                field_name="capability_directory_json",
            ),
            direct_available_tools=int(row["direct_available_tools"]),
            on_demand_tools=int(row["on_demand_tools"]),
            unavailable_tools=int(row["unavailable_tools"]),
        )


class McpOAuthTokensRepository:
    VALID_STATUSES = {"active", "expired", "revoked", "error"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def upsert_for_server(
        self,
        *,
        server_id: str,
        token_ref: str,
        token_id: str | None = None,
        account_label: str | None = None,
        refresh_token_ref: str | None = None,
        scopes: list[Any] | None = None,
        expires_at: str | None = None,
        status: str = "active",
    ) -> McpOAuthTokenRecord:
        self._validate_status(status)
        resolved_id = token_id or new_id()
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update mcp_oauth_tokens set
                  status='revoked',
                  updated_at=?
                where server_id=? and status='active' and id != ?
                """,
                (now, server_id, resolved_id),
            )
            conn.execute(
                """
                insert into mcp_oauth_tokens (
                  id, server_id, account_label, token_ref, refresh_token_ref,
                  scopes_json, expires_at, status, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(id) do update set
                  account_label=excluded.account_label,
                  token_ref=excluded.token_ref,
                  refresh_token_ref=excluded.refresh_token_ref,
                  scopes_json=excluded.scopes_json,
                  expires_at=excluded.expires_at,
                  status=excluded.status,
                  updated_at=excluded.updated_at
                """,
                (
                    resolved_id,
                    server_id,
                    account_label,
                    token_ref,
                    refresh_token_ref,
                    _json_dumps(scopes) if scopes is not None else None,
                    expires_at,
                    status,
                    now,
                    now,
                ),
            )
        record = self.get(resolved_id)
        if record is None:
            raise RuntimeError(f"写入 MCP OAuth token 后无法读取: {resolved_id}")
        return record

    def get(self, token_id: str) -> McpOAuthTokenRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from mcp_oauth_tokens where id = ?",
                (token_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def get_active_for_server(self, server_id: str) -> McpOAuthTokenRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from mcp_oauth_tokens
                where server_id = ? and status = 'active'
                order by updated_at desc, id desc
                limit 1
                """,
                (server_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        server_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[McpOAuthTokenRecord], int]:
        if status is not None:
            self._validate_status(status)
        filters: list[str] = []
        params: list[Any] = []
        if server_id is not None:
            filters.append("server_id = ?")
            params.append(server_id)
        if status is not None:
            filters.append("status = ?")
            params.append(status)
        where = f"where {' and '.join(filters)}" if filters else ""
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from mcp_oauth_tokens {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from mcp_oauth_tokens
                {where}
                order by updated_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    def set_status(self, token_id: str, status: str) -> McpOAuthTokenRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                "update mcp_oauth_tokens set status = ?, updated_at = ? where id = ?",
                (status, now, token_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(token_id)

    def clear_for_server(self, server_id: str, *, status: str = "revoked") -> int:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update mcp_oauth_tokens set
                  status = ?,
                  updated_at = ?
                where server_id = ? and status != ?
                """,
                (status, now, server_id, status),
            )
        return cursor.rowcount

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 MCP OAuth token status: {status}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpOAuthTokenRecord:
        return McpOAuthTokenRecord(
            id=row["id"],
            server_id=row["server_id"],
            account_label=row["account_label"],
            token_ref=row["token_ref"],
            refresh_token_ref=row["refresh_token_ref"],
            scopes=_json_loads(row["scopes_json"], None),
            expires_at=row["expires_at"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class McpTrustRulesRepository:
    VALID_RULE_KINDS = {"tool", "tool_with_params", "deny_tool"}
    VALID_SCOPES = {"session", "global"}
    VALID_APPROVAL_MODES = {"approve", "deny"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        rule_id: str,
        rule_kind: str,
        scope: str,
        approval_mode: str,
        server_id: str | None = None,
        raw_tool_name: str | None = None,
        session_id: str | None = None,
        condition: dict[str, Any] | None = None,
        created_from_approval_id: str | None = None,
        expires_at: str | None = None,
    ) -> McpTrustRuleRecord:
        self._validate(rule_kind, scope, approval_mode)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_trust_rules (
                  id, server_id, raw_tool_name, rule_kind, scope, session_id,
                  condition_json, approval_mode, created_from_approval_id, expires_at,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rule_id,
                    server_id,
                    raw_tool_name,
                    rule_kind,
                    scope,
                    session_id,
                    _json_dumps(condition) if condition is not None else None,
                    approval_mode,
                    created_from_approval_id,
                    expires_at,
                    now,
                    now,
                ),
            )
        record = self.get(rule_id)
        if record is None:
            raise RuntimeError(f"创建 MCP trust rule 后无法读取: {rule_id}")
        return record

    def get(self, rule_id: str) -> McpTrustRuleRecord | None:
        with self.db.connect() as conn:
            row = conn.execute("select * from mcp_trust_rules where id = ?", (rule_id,)).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        server_id: str | None = None,
        scope: str | None = None,
        session_id: str | None = None,
        limit: int = 200,
    ) -> list[McpTrustRuleRecord]:
        filters: list[str] = []
        params: list[Any] = []
        if server_id is not None:
            filters.append("server_id = ?")
            params.append(server_id)
        if scope is not None:
            if scope not in self.VALID_SCOPES:
                raise ValueError(f"不支持的 MCP trust scope: {scope}")
            filters.append("scope = ?")
            params.append(scope)
        if session_id is not None:
            filters.append("session_id = ?")
            params.append(session_id)
        where = f"where {' and '.join(filters)}" if filters else ""
        params.append(max(1, min(limit, 500)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from mcp_trust_rules
                {where}
                order by created_at desc, id desc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def touch_hit(self, rule_id: str) -> McpTrustRuleRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update mcp_trust_rules set
                  hit_count = hit_count + 1,
                  last_hit_at = ?,
                  updated_at = ?
                where id = ?
                """,
                (now, now, rule_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(rule_id)

    def delete(self, rule_id: str) -> bool:
        with self.db.transaction() as conn:
            cursor = conn.execute("delete from mcp_trust_rules where id = ?", (rule_id,))
        return int(cursor.rowcount or 0) > 0

    @classmethod
    def _validate(cls, rule_kind: str, scope: str, approval_mode: str) -> None:
        if rule_kind not in cls.VALID_RULE_KINDS:
            raise ValueError(f"不支持的 MCP trust rule_kind: {rule_kind}")
        if scope not in cls.VALID_SCOPES:
            raise ValueError(f"不支持的 MCP trust scope: {scope}")
        if approval_mode not in cls.VALID_APPROVAL_MODES:
            raise ValueError(f"不支持的 MCP trust approval_mode: {approval_mode}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpTrustRuleRecord:
        return McpTrustRuleRecord(
            id=row["id"],
            server_id=row["server_id"],
            raw_tool_name=row["raw_tool_name"],
            rule_kind=row["rule_kind"],
            scope=row["scope"],
            session_id=row["session_id"],
            condition=_json_loads(row["condition_json"], None),
            approval_mode=row["approval_mode"],
            hit_count=int(row["hit_count"]),
            created_from_approval_id=row["created_from_approval_id"],
            expires_at=row["expires_at"],
            last_hit_at=row["last_hit_at"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class McpAuditLogRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def append(
        self,
        *,
        audit_id: str,
        event_type: str,
        server_id: str | None = None,
        raw_tool_name: str | None = None,
        session_id: str | None = None,
        turn_id: str | None = None,
        call_id: str | None = None,
        approval_id: str | None = None,
        actor: str | None = None,
        status: str | None = None,
        duration_ms: int | None = None,
        summary: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> McpAuditLogRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_audit_log (
                  id, event_type, server_id, raw_tool_name, session_id,
                  turn_id, call_id, approval_id, actor, status, duration_ms, summary,
                  detail_json, created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    audit_id,
                    event_type,
                    server_id,
                    raw_tool_name,
                    session_id,
                    turn_id,
                    call_id,
                    approval_id,
                    actor,
                    status,
                    duration_ms,
                    summary,
                    _json_dumps(detail) if detail is not None else None,
                    now,
                ),
            )
        record = self.get(audit_id)
        if record is None:
            raise RuntimeError(f"写入 MCP audit 后无法读取: {audit_id}")
        return record

    def get(self, audit_id: str) -> McpAuditLogRecord | None:
        with self.db.connect() as conn:
            row = conn.execute("select * from mcp_audit_log where id = ?", (audit_id,)).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        server_id: str | None = None,
        session_id: str | None = None,
        event_type: str | None = None,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[McpAuditLogRecord], int]:
        filters: list[str] = []
        params: list[Any] = []
        if server_id is not None:
            filters.append("server_id = ?")
            params.append(server_id)
        if session_id is not None:
            filters.append("session_id = ?")
            params.append(session_id)
        if event_type is not None:
            filters.append("event_type = ?")
            params.append(event_type)
        if status is not None:
            filters.append("status = ?")
            params.append(status)
        where = f"where {' and '.join(filters)}" if filters else ""
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from mcp_audit_log {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from mcp_audit_log
                {where}
                order by created_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpAuditLogRecord:
        return McpAuditLogRecord(
            id=row["id"],
            event_type=row["event_type"],
            server_id=row["server_id"],
            raw_tool_name=row["raw_tool_name"],
            session_id=row["session_id"],
            turn_id=row["turn_id"],
            call_id=row["call_id"],
            approval_id=row["approval_id"],
            actor=row["actor"],
            status=row["status"],
            duration_ms=row["duration_ms"],
            summary=row["summary"],
            detail=_json_loads(row["detail_json"], None),
            created_at=row["created_at"],
        )


class SettingsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def set(self, key: str, value: Any) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into settings (key, value_json, updated_at)
                values (?, ?, ?)
                on conflict(key) do update set
                  value_json=excluded.value_json,
                  updated_at=excluded.updated_at
                """,
                (key, _json_dumps(value), to_iso_z(utc_now())),
            )

    def get(self, key: str, default: Any = None) -> Any:
        with self.db.connect() as conn:
            row = conn.execute("select value_json from settings where key = ?", (key,)).fetchone()
        return _json_loads(row["value_json"], default) if row else default


class WebSettingsDataError(ValueError):
    """Raised when persisted Web settings cannot be decoded safely."""

    def __init__(self, *, provider_id: str, field: str) -> None:
        self.provider_id = provider_id
        self.field = field
        super().__init__(f"Web Provider 配置损坏: provider={provider_id}, field={field}")


@dataclass(frozen=True, slots=True)
class WebSettingsRecord:
    enabled: bool
    active_provider_id: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class WebProviderConfigRecord:
    provider_id: str
    config: dict[str, Any]
    secrets: dict[str, Any]
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class WebProviderConfigWrite:
    config: dict[str, Any] = field(default_factory=dict)
    secrets: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class WebSettingsSnapshot:
    settings: WebSettingsRecord
    providers: tuple[WebProviderConfigRecord, ...]


class WebSettingsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def get_settings(self) -> WebSettingsRecord:
        with self.db.connect() as conn:
            row = conn.execute("select * from web_settings where id = 1").fetchone()
        if row is None:
            raise RuntimeError("Web 设置尚未初始化")
        return self._settings_from_row(row)

    def get_provider(self, provider_id: str) -> WebProviderConfigRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from web_provider_configs where provider_id = ?",
                (provider_id,),
            ).fetchone()
        return self._provider_from_row(row) if row else None

    def list_providers(self) -> list[WebProviderConfigRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "select * from web_provider_configs order by provider_id"
            ).fetchall()
        return [self._provider_from_row(row) for row in rows]

    def get_snapshot(self) -> WebSettingsSnapshot:
        return WebSettingsSnapshot(
            settings=self.get_settings(),
            providers=tuple(self.list_providers()),
        )

    def upsert_provider(
        self,
        provider_id: str,
        *,
        config: dict[str, Any],
        secrets: dict[str, Any],
    ) -> WebProviderConfigRecord:
        provider_id = self._normalize_provider_id(provider_id)
        with self.db.transaction(immediate=True) as conn:
            self._upsert_provider(
                conn,
                provider_id=provider_id,
                config=config,
                secrets=secrets,
                now=to_iso_z(utc_now()),
            )
        provider = self.get_provider(provider_id)
        if provider is None:  # pragma: no cover - guarded by the upsert above
            raise RuntimeError("Web Provider 配置保存失败")
        return provider

    def save(
        self,
        *,
        enabled: bool,
        active_provider_id: str,
        providers: dict[str, WebProviderConfigWrite],
    ) -> WebSettingsSnapshot:
        active_provider_id = self._normalize_provider_id(active_provider_id)
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            for provider_id, write in providers.items():
                self._upsert_provider(
                    conn,
                    provider_id=self._normalize_provider_id(provider_id),
                    config=write.config,
                    secrets=write.secrets,
                    now=now,
                )
            conn.execute(
                """
                update web_settings
                set enabled = ?, active_provider_id = ?, updated_at = ?
                where id = 1
                """,
                (int(enabled), active_provider_id, now),
            )
        return self.get_snapshot()

    @staticmethod
    def _normalize_provider_id(provider_id: str) -> str:
        normalized = provider_id.strip()
        if not normalized:
            raise ValueError("provider_id 不能为空")
        return normalized

    @staticmethod
    def _upsert_provider(
        conn: sqlite3.Connection,
        *,
        provider_id: str,
        config: dict[str, Any],
        secrets: dict[str, Any],
        now: str,
    ) -> None:
        config_json = _json_dumps(config)
        secrets_json = _json_dumps(secrets)
        conn.execute(
            """
            insert into web_provider_configs (
              provider_id, config_json, secrets_json, created_at, updated_at
            ) values (?, ?, ?, ?, ?)
            on conflict(provider_id) do update set
              config_json = excluded.config_json,
              secrets_json = excluded.secrets_json,
              updated_at = excluded.updated_at
            """,
            (provider_id, config_json, secrets_json, now, now),
        )

    @staticmethod
    def _settings_from_row(row: sqlite3.Row) -> WebSettingsRecord:
        return WebSettingsRecord(
            enabled=bool(row["enabled"]),
            active_provider_id=row["active_provider_id"],
            updated_at=row["updated_at"],
        )

    @classmethod
    def _provider_from_row(cls, row: sqlite3.Row) -> WebProviderConfigRecord:
        provider_id = row["provider_id"]
        return WebProviderConfigRecord(
            provider_id=provider_id,
            config=cls._load_mapping(row["config_json"], provider_id, "config_json"),
            secrets=cls._load_mapping(row["secrets_json"], provider_id, "secrets_json"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _load_mapping(raw: str, provider_id: str, field_name: str) -> dict[str, Any]:
        try:
            value = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise WebSettingsDataError(provider_id=provider_id, field=field_name) from exc
        if not isinstance(value, dict):
            raise WebSettingsDataError(provider_id=provider_id, field=field_name)
        return value


class ModelProvidersRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def upsert(self, provider: ModelProviderRecord) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into model_providers (
                  id, name, base_url, api_key_encrypted, enabled, models_json,
                  model_enabled_json, health_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(id) do update set
                  name=excluded.name,
                  base_url=excluded.base_url,
                  api_key_encrypted=excluded.api_key_encrypted,
                  enabled=excluded.enabled,
                  models_json=excluded.models_json,
                  model_enabled_json=excluded.model_enabled_json,
                  health_json=excluded.health_json,
                  updated_at=excluded.updated_at
                """,
                (
                    provider.id,
                    provider.name,
                    provider.base_url,
                    provider.api_key,
                    int(provider.enabled),
                    _json_dumps(provider.models),
                    _json_dumps(provider.model_enabled),
                    _json_dumps(provider.health),
                    provider.created_at,
                    provider.updated_at,
                ),
            )

    def get(self, provider_id: str) -> ModelProviderRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from model_providers where id = ?",
                (provider_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list(self) -> list[ModelProviderRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "select * from model_providers order by created_at, name",
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def delete(self, provider_id: str) -> bool:
        with self.db.transaction() as conn:
            cursor = conn.execute("delete from model_providers where id = ?", (provider_id,))
        return cursor.rowcount > 0

    def set_model_default(self, *, scope: str, provider_id: str, model: str) -> None:
        cleaned_scope = _require_model_default_scope(scope)
        cleaned_model = model.strip()
        if not cleaned_model:
            raise ValueError("model default model must not be empty")
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into model_defaults (scope, provider_id, model, updated_at)
                values (?, ?, ?, ?)
                on conflict(scope) do update set
                  provider_id=excluded.provider_id,
                  model=excluded.model,
                  updated_at=excluded.updated_at
                """,
                (cleaned_scope, provider_id, cleaned_model, to_iso_z(utc_now())),
            )

    def get_model_default(self, scope: str) -> ModelDefaultRecord | None:
        cleaned_scope = _require_model_default_scope(scope)
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from model_defaults where scope = ?",
                (cleaned_scope,),
            ).fetchone()
        return (
            ModelDefaultRecord(
                scope=row["scope"],
                provider_id=row["provider_id"],
                model=row["model"],
                updated_at=row["updated_at"],
            )
            if row
            else None
        )

    def delete_model_default(self, scope: str) -> bool:
        cleaned_scope = _require_model_default_scope(scope)
        with self.db.transaction() as conn:
            cursor = conn.execute("delete from model_defaults where scope = ?", (cleaned_scope,))
        return cursor.rowcount > 0

    @staticmethod
    def _from_row(row: sqlite3.Row) -> ModelProviderRecord:
        return ModelProviderRecord(
            id=row["id"],
            name=row["name"],
            base_url=row["base_url"],
            api_key=row["api_key_encrypted"],
            enabled=bool(row["enabled"]),
            models=_json_loads(row["models_json"], []),
            model_enabled=_json_loads(row["model_enabled_json"], {}),
            health=_json_loads(row["health_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class LifecycleOperationsRepository:
    VALID_ENTITY_TYPES = {"workspace", "session"}
    VALID_ACTIONS = {"archive", "restore", "purge"}
    VALID_STATES = {
        "planned",
        "running",
        "quarantined",
        "db_committed",
        "completed",
        "cleanup_failed",
        "rolled_back",
        "compensation_failed",
        "blocked",
        "failed",
    }
    SAFE_ERROR_DETAIL_KEYS = {
        "retryable",
        "phase",
        "blocker_count",
        "operation_id",
        "state",
        "code",
    }

    def __init__(self, db: Database) -> None:
        self.db = db

    def create_or_replay(
        self,
        *,
        request_id: str,
        entity_type: str,
        entity_id: str,
        action: str,
        payload: dict[str, Any],
        operation_id: str | None = None,
    ) -> LifecycleOperationCreateResult:
        self._validate_entity_type(entity_type)
        self._validate_action(action)
        cleaned_request_id = request_id.strip()
        cleaned_entity_id = entity_id.strip()
        if not cleaned_request_id:
            raise ValueError("request_id 不能为空")
        if not cleaned_entity_id:
            raise ValueError("entity_id 不能为空")
        entity_hash = _lifecycle_hash(cleaned_entity_id)
        payload_hash = _lifecycle_payload_hash(payload)
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            existing = conn.execute(
                """
                select * from lifecycle_operations
                where entity_type = ? and entity_hash = ? and request_id = ?
                """,
                (entity_type, entity_hash, cleaned_request_id),
            ).fetchone()
            if existing is not None:
                operation = self._from_row(existing)
                if operation.action != action or operation.payload_hash != payload_hash:
                    raise ValueError("request_id 已用于不同的生命周期请求")
                return LifecycleOperationCreateResult(operation=operation, created=False)
            resolved_id = operation_id or new_id()
            conn.execute(
                """
                insert into lifecycle_operations (
                  id, request_id, payload_hash, entity_type, entity_id, entity_hash,
                  action, state, revision, counts_json, result_json, error_detail_json,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, 'planned', 1, '{}', '{}', '{}', ?, ?)
                """,
                (
                    resolved_id,
                    cleaned_request_id,
                    payload_hash,
                    entity_type,
                    cleaned_entity_id,
                    entity_hash,
                    action,
                    now,
                    now,
                ),
            )
            row = conn.execute(
                "select * from lifecycle_operations where id = ?",
                (resolved_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("创建 lifecycle operation 后无法读取")
        return LifecycleOperationCreateResult(operation=self._from_row(row), created=True)

    def get(self, operation_id: str) -> LifecycleOperationRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from lifecycle_operations where id = ?",
                (operation_id,),
            ).fetchone()
        return self._from_row(row) if row is not None else None

    def get_by_request(
        self,
        *,
        entity_type: str,
        entity_id: str,
        request_id: str,
    ) -> LifecycleOperationRecord | None:
        self._validate_entity_type(entity_type)
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from lifecycle_operations
                where entity_type = ? and entity_hash = ? and request_id = ?
                """,
                (entity_type, _lifecycle_hash(entity_id.strip()), request_id.strip()),
            ).fetchone()
        return self._from_row(row) if row is not None else None

    def list_cleanup_failed(self) -> list[LifecycleOperationRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from lifecycle_operations
                where state = 'cleanup_failed'
                order by updated_at asc, id asc
                """
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def update(
        self,
        operation_id: str,
        *,
        expected_revision: int,
        state: str | None = None,
        counts: dict[str, int] | None = None,
        result: dict[str, Any] | None = None,
        error_code: str | None | object = _UNSET,
        error_detail: dict[str, Any] | None = None,
        quarantine_token: str | None | object = _UNSET,
        completed: bool = False,
    ) -> LifecycleOperationRecord | None:
        assignments = ["revision = revision + 1", "updated_at = ?"]
        params: list[Any] = [to_iso_z(utc_now())]
        if state is not None:
            self._validate_state(state)
            assignments.append("state = ?")
            params.append(state)
        if counts is not None:
            normalized_counts = {str(key): int(value) for key, value in counts.items()}
            assignments.append("counts_json = ?")
            params.append(_json_dumps(normalized_counts))
        if result is not None:
            assignments.append("result_json = ?")
            params.append(_json_dumps(_sanitize_metadata(result)))
        if error_code is not _UNSET:
            assignments.append("error_code = ?")
            params.append(error_code)
        if error_detail is not None:
            safe_detail = {
                key: _sanitize_metadata(value)
                for key, value in error_detail.items()
                if key in self.SAFE_ERROR_DETAIL_KEYS
            }
            assignments.append("error_detail_json = ?")
            params.append(_json_dumps(safe_detail))
        if quarantine_token is not _UNSET:
            assignments.append("quarantine_token = ?")
            params.append(quarantine_token)
        if completed:
            assignments.append("completed_at = ?")
            params.append(to_iso_z(utc_now()))
        params.extend([operation_id, expected_revision])
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                f"""
                update lifecycle_operations
                set {', '.join(assignments)}
                where id = ? and revision = ?
                """,
                params,
            )
            if cursor.rowcount == 0:
                return None
            row = conn.execute(
                "select * from lifecycle_operations where id = ?",
                (operation_id,),
            ).fetchone()
        return self._from_row(row) if row is not None else None

    def scrub_completed_purge(self, operation_id: str) -> LifecycleOperationRecord | None:
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                """
                update lifecycle_operations
                set entity_id = null,
                    result_json = '{}',
                    error_detail_json = '{}',
                    quarantine_token = null,
                    revision = revision + 1,
                    updated_at = ?
                where id = ? and action = 'purge' and state = 'completed'
                """,
                (to_iso_z(utc_now()), operation_id),
            )
            row = conn.execute(
                "select * from lifecycle_operations where id = ?",
                (operation_id,),
            ).fetchone()
        if cursor.rowcount == 0:
            return self._from_row(row) if row is not None else None
        return self._from_row(row)

    def acquire_lock(
        self,
        *,
        operation_id: str,
        entity_type: str,
        entity_id: str,
        ttl_seconds: int = 30,
        now: datetime | None = None,
    ) -> bool:
        self._validate_entity_type(entity_type)
        acquired_time = now or utc_now()
        acquired_at = to_iso_z(acquired_time)
        expires_at = to_iso_z(acquired_time + timedelta(seconds=max(1, ttl_seconds)))
        lock_key = f"{entity_type}:{_lifecycle_hash(entity_id.strip())}"
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                """
                insert into lifecycle_locks (
                  lock_key, owner_operation_id, acquired_at, expires_at
                ) values (?, ?, ?, ?)
                on conflict(lock_key) do update set
                  owner_operation_id = excluded.owner_operation_id,
                  acquired_at = excluded.acquired_at,
                  expires_at = excluded.expires_at
                where lifecycle_locks.owner_operation_id = excluded.owner_operation_id
                   or lifecycle_locks.expires_at <= excluded.acquired_at
                """,
                (lock_key, operation_id, acquired_at, expires_at),
            )
        return cursor.rowcount > 0

    def release_locks(self, operation_id: str) -> int:
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                "delete from lifecycle_locks where owner_operation_id = ?",
                (operation_id,),
            )
        return cursor.rowcount

    @classmethod
    def _validate_entity_type(cls, entity_type: str) -> None:
        if entity_type not in cls.VALID_ENTITY_TYPES:
            raise ValueError(f"不支持的生命周期对象类型: {entity_type}")

    @classmethod
    def _validate_action(cls, action: str) -> None:
        if action not in cls.VALID_ACTIONS:
            raise ValueError(f"不支持的生命周期操作: {action}")

    @classmethod
    def _validate_state(cls, state: str) -> None:
        if state not in cls.VALID_STATES:
            raise ValueError(f"不支持的生命周期状态: {state}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> LifecycleOperationRecord:
        return LifecycleOperationRecord(
            id=row["id"],
            request_id=row["request_id"],
            payload_hash=row["payload_hash"],
            entity_type=row["entity_type"],
            entity_id=row["entity_id"],
            entity_hash=row["entity_hash"],
            action=row["action"],
            state=row["state"],
            revision=int(row["revision"]),
            counts={str(key): int(value) for key, value in _json_loads(row["counts_json"], {}).items()},
            result=_json_loads(row["result_json"], {}),
            error_code=row["error_code"],
            error_detail=_json_loads(row["error_detail_json"], {}),
            quarantine_token=row["quarantine_token"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            completed_at=row["completed_at"],
        )


class WorkspacesRepository:
    VALID_TYPES = {"project"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        workspace_id: str,
        root_path: str | Path,
        name: str | None = None,
        workspace_type: str = "project",
        last_opened_at: str | None = None,
    ) -> WorkspaceRecord:
        self._validate_type(workspace_type)
        resolved_root = self._resolve_workspace_directory(root_path)
        normalized_root = normalize_workspace_root_for_storage(resolved_root)
        existing = self.get_by_normalized_root_path(normalized_root)
        if existing is not None:
            return existing

        now = to_iso_z(utc_now())
        resolved_name = self._resolve_name(name, resolved_root)
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into workspaces (
                  id, name, root_path, normalized_root_path, type, created_at,
                  updated_at, last_opened_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    workspace_id,
                    resolved_name,
                    str(resolved_root),
                    normalized_root,
                    workspace_type,
                    now,
                    now,
                    last_opened_at,
                ),
            )
        record = self.get(workspace_id)
        if record is None:
            raise RuntimeError(f"创建 workspace 后无法读取: {workspace_id}")
        return record

    def get(self, workspace_id: str) -> WorkspaceRecord | None:
        query = "select * from workspaces where id = ? and archived_at is null"
        with self.db.connect() as conn:
            row = conn.execute(query, (workspace_id,)).fetchone()
        return self._from_row(row) if row else None

    def get_archived(self, workspace_id: str) -> WorkspaceRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from workspaces where id = ? and archived_at is not null",
                (workspace_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def archive_project(
        self,
        workspace_id: str,
        *,
        archived_at: str,
    ) -> WorkspaceArchiveMutation:
        with self.db.transaction(immediate=True) as conn:
            before = conn.execute(
                "select * from workspaces where id = ?",
                (workspace_id,),
            ).fetchone()
            if before is None:
                return WorkspaceArchiveMutation(record=None, changed=False)
            preserved = conn.execute(
                """
                select
                  coalesce(sum(case when archive_origin = 'manual' then 1 else 0 end), 0)
                    as manual_count,
                  coalesce(sum(case when archive_origin = 'project' then 1 else 0 end), 0)
                    as project_count
                from sessions
                where workspace_id = ?
                  and archived_at is not null
                  and visibility = 'visible'
                """,
                (workspace_id,),
            ).fetchone()
            workspace_cursor = conn.execute(
                """
                update workspaces
                set archived_at = ?
                where id = ? and archived_at is null
                """,
                (archived_at, workspace_id),
            )
            newly_archived = 0
            if workspace_cursor.rowcount > 0:
                visible_row = conn.execute(
                    """
                    select count(*) as total
                    from sessions
                    where workspace_id = ?
                      and archived_at is null
                      and visibility = 'visible'
                    """,
                    (workspace_id,),
                ).fetchone()
                conn.execute(
                    """
                    update sessions
                    set archived_at = ?, archive_origin = 'project'
                    where workspace_id = ? and archived_at is null
                    """,
                    (archived_at, workspace_id),
                )
                newly_archived = int(visible_row["total"] if visible_row is not None else 0)
            row = conn.execute(
                "select * from workspaces where id = ?",
                (workspace_id,),
            ).fetchone()
        return WorkspaceArchiveMutation(
            record=self._from_row(row),
            changed=workspace_cursor.rowcount > 0,
            newly_archived=newly_archived,
            manual_preserved=int(preserved["manual_count"] or 0),
            project_preserved=int(preserved["project_count"] or 0),
        )

    def restore_project_only(self, workspace_id: str) -> WorkspaceRestoreMutation:
        return self._restore_project(workspace_id, restore_project_sessions=False)

    def restore_with_project_sessions(self, workspace_id: str) -> WorkspaceRestoreMutation:
        return self._restore_project(workspace_id, restore_project_sessions=True)

    def _restore_project(
        self,
        workspace_id: str,
        *,
        restore_project_sessions: bool,
    ) -> WorkspaceRestoreMutation:
        with self.db.transaction(immediate=True) as conn:
            existing = conn.execute(
                "select id from workspaces where id = ?",
                (workspace_id,),
            ).fetchone()
            if existing is None:
                return WorkspaceRestoreMutation(record=None, changed=False)
            workspace_cursor = conn.execute(
                """
                update workspaces
                set archived_at = null
                where id = ? and archived_at is not null
                """,
                (workspace_id,),
            )
            restored_sessions = 0
            if restore_project_sessions:
                visible_row = conn.execute(
                    """
                    select count(*) as total
                    from sessions
                    where workspace_id = ?
                      and archived_at is not null
                      and archive_origin = 'project'
                      and visibility = 'visible'
                    """,
                    (workspace_id,),
                ).fetchone()
                conn.execute(
                    """
                    update sessions
                    set archived_at = null, archive_origin = null
                    where workspace_id = ?
                      and archived_at is not null
                      and archive_origin = 'project'
                    """,
                    (workspace_id,),
                )
                restored_sessions = int(visible_row["total"] if visible_row is not None else 0)
            row = conn.execute(
                "select * from workspaces where id = ?",
                (workspace_id,),
            ).fetchone()
        return WorkspaceRestoreMutation(
            record=self._from_row(row) if row is not None else None,
            changed=workspace_cursor.rowcount > 0 or restored_sessions > 0,
            restored_sessions=restored_sessions,
        )

    def get_by_root_path(
        self,
        root_path: str | Path,
    ) -> WorkspaceRecord | None:
        resolved_root = self._resolve_workspace_directory(root_path)
        return self.get_by_normalized_root_path(
            normalize_workspace_root_for_storage(resolved_root),
        )

    def get_by_normalized_root_path(
        self,
        normalized_root_path: str,
    ) -> WorkspaceRecord | None:
        query = """
            select * from workspaces
            where normalized_root_path = ? and archived_at is null
            order by updated_at desc, created_at desc limit 1
        """
        with self.db.connect() as conn:
            row = conn.execute(query, (normalized_root_path,)).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        limit: int = 100,
    ) -> list[WorkspaceRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from workspaces
                where archived_at is null
                order by
                  last_opened_at is null,
                  last_opened_at desc,
                  updated_at desc,
                  created_at desc,
                  name asc
                limit ?
                """,
                (max(1, min(limit, 500)),),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def list_archived(
        self,
        *,
        query: str | None = None,
        cursor: str | None = None,
        limit: int = 100,
    ) -> ArchivedWorkspacePage:
        page_size = max(1, min(limit, 200))
        filters = ["w.archived_at is not null"]
        params: list[Any] = []
        cleaned_query = str(query or "").strip().casefold()
        if cleaned_query:
            pattern = f"%{_escape_like(cleaned_query)}%"
            filters.append(
                "(lower(w.name) like ? escape '\\' "
                "or lower(w.normalized_root_path) like ? escape '\\')"
            )
            params.extend([pattern, pattern])
        cursor_value = _decode_archive_cursor(cursor)
        if cursor_value is not None:
            archived_at, workspace_id = cursor_value
            filters.append("(w.archived_at < ? or (w.archived_at = ? and w.id < ?))")
            params.extend([archived_at, archived_at, workspace_id])
        params.append(page_size + 1)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select
                  w.*,
                  count(s.id) as archived_session_total,
                  coalesce(sum(case when s.archive_origin = 'manual' then 1 else 0 end), 0)
                    as manual_session_count,
                  coalesce(sum(case when s.archive_origin = 'project' then 1 else 0 end), 0)
                    as project_session_count
                from workspaces w
                left join sessions s
                  on s.workspace_id = w.id
                 and s.archived_at is not null
                 and s.visibility = 'visible'
                where {' and '.join(filters)}
                group by w.id
                order by w.archived_at desc, w.id desc
                limit ?
                """,
                params,
            ).fetchall()
        has_more = len(rows) > page_size
        visible_rows = rows[:page_size]
        items = [
            ArchivedWorkspaceSummary(
                workspace=self._from_row(row),
                session_total=int(row["archived_session_total"] or 0),
                manual_session_count=int(row["manual_session_count"] or 0),
                project_session_count=int(row["project_session_count"] or 0),
            )
            for row in visible_rows
        ]
        last = visible_rows[-1] if has_more and visible_rows else None
        return ArchivedWorkspacePage(
            items=items,
            next_cursor=(
                _encode_archive_cursor(last["archived_at"], last["id"])
                if last is not None
                else None
            ),
            has_more=has_more,
        )

    def update(
        self,
        workspace_id: str,
        *,
        name: str | None = None,
        root_path: str | Path | None = None,
        workspace_type: str | None = None,
        last_opened_at: str | None = None,
    ) -> WorkspaceRecord | None:
        assignments: list[str] = []
        params: list[Any] = []
        if name is not None:
            assignments.append("name = ?")
            params.append(self._resolve_name(name, None))
        if root_path is not None:
            resolved_root = self._resolve_workspace_directory(root_path)
            assignments.extend(["root_path = ?", "normalized_root_path = ?"])
            params.extend([str(resolved_root), normalize_workspace_root_for_storage(resolved_root)])
        if workspace_type is not None:
            self._validate_type(workspace_type)
            assignments.append("type = ?")
            params.append(workspace_type)
        if last_opened_at is not None:
            assignments.append("last_opened_at = ?")
            params.append(last_opened_at)
        if not assignments:
            return self.get(workspace_id)

        assignments.append("updated_at = ?")
        params.append(to_iso_z(utc_now()))
        params.append(workspace_id)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"""
                update workspaces
                set {", ".join(assignments)}
                where id = ? and archived_at is null
                """,
                params,
            )
        if cursor.rowcount == 0:
            return None
        return self.get(workspace_id)

    def touch(self, workspace_id: str, *, opened_at: str | None = None) -> WorkspaceRecord | None:
        return self.update(workspace_id, last_opened_at=opened_at or to_iso_z(utc_now()))

    @classmethod
    def _validate_type(cls, workspace_type: str) -> None:
        if workspace_type not in cls.VALID_TYPES:
            raise ValueError(f"不支持的 workspace 类型: {workspace_type}")

    @staticmethod
    def _resolve_workspace_directory(root_path: str | Path) -> Path:
        root_text = str(root_path).strip()
        if not root_text:
            raise WorkspacePathError("工作区路径不能为空")
        resolved = Path(root_text).expanduser().resolve()
        if not resolved.exists():
            raise WorkspacePathError(f"工作区路径不存在: {root_path}")
        if not resolved.is_dir():
            raise WorkspacePathError(f"工作区路径不是目录: {root_path}")
        return resolved

    @staticmethod
    def _resolve_name(name: str | None, root_path: Path | None) -> str:
        cleaned = str(name or "").strip()
        if cleaned:
            return cleaned
        if root_path is not None and root_path.name:
            return root_path.name
        raise ValueError("工作区名称不能为空")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> WorkspaceRecord:
        return WorkspaceRecord(
            id=row["id"],
            name=row["name"],
            root_path=row["root_path"],
            normalized_root_path=row["normalized_root_path"],
            type=row["type"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_opened_at=row["last_opened_at"],
            archived_at=row["archived_at"],
        )


class SessionsRepository:
    INTERNAL_CONTEXT_COMPRESSION_SESSION_TAG = "__context_compression_active__"
    SUBAGENT_SESSION_TAG = "subagent"
    VALID_STATUSES = {
        "active",
        "closed",
        "failed",
        "running",
        "waiting_approval",
        "waiting_input",
    }
    VALID_SESSION_TYPES = {"workspace", "chat"}
    VALID_VISIBILITIES = {"visible", "internal"}
    VALID_AGENT_KINDS = {"main", "subagent"}
    VALID_SUBAGENT_ROLES = {"explorer", "worker"}
    VALID_TITLE_SOURCES = {"auto_candidate", "auto", "manual"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        session_id: str,
        user_id: str,
        scene_id: str,
        title: str | None = None,
        status: str = "active",
        session_tag: str = "chat",
        scene_version_seq: int | None = None,
        active_session_id: str | None = None,
        is_debug: bool = False,
        workspace_id: str | None = None,
        session_type: str = "chat",
        visibility: str = "visible",
        agent_kind: str = "main",
        subagent_id: str | None = None,
        subagent_role: str | None = None,
        subagent_closed_at: str | None = None,
        cwd: str | None = None,
        workspace_roots: list[str] | None = None,
        current_model_provider_id: str | None = None,
        current_model: str | None = None,
        context_compression_epoch: int = 0,
        title_source: str = "auto_candidate",
        parent_session_id: str | None = None,
        child_session_id: str | None = None,
        source_trace_id: str | None = None,
        source_active_session_id: str | None = None,
        source_checkpoint_id: str | None = None,
        source_checkpoint_ns: str | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> SessionRecord:
        self._validate_status(status)
        self._validate_session_type(session_type)
        self._validate_agent_metadata(
            visibility=visibility,
            agent_kind=agent_kind,
            subagent_id=subagent_id,
            subagent_role=subagent_role,
            subagent_closed_at=subagent_closed_at,
            parent_session_id=parent_session_id,
            session_type=session_type,
            session_tag=session_tag,
        )
        self._validate_title_source(title_source)
        now = to_iso_z(utc_now())
        resolved_active_session_id = active_session_id or session_id
        transaction = (
            nullcontext(connection) if connection is not None else self.db.transaction()
        )
        with transaction as conn:
            conn.execute(
                """
                insert into sessions (
                  id, user_id, scene_id, scene_version_seq, status, is_debug,
                  session_tag, active_session_id, workspace_id, session_type,
                  visibility, agent_kind, subagent_id, subagent_role, subagent_closed_at, cwd,
                  workspace_roots_json, current_model_provider_id, current_model,
                  context_compression_epoch, title, title_source,
                  parent_session_id, child_session_id,
                  source_trace_id, source_active_session_id,
                  source_checkpoint_id, source_checkpoint_ns, created_at, updated_at
                ) values (
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    session_id,
                    user_id,
                    scene_id,
                    scene_version_seq,
                    status,
                    int(is_debug),
                    session_tag,
                    resolved_active_session_id,
                    workspace_id,
                    session_type,
                    visibility,
                    agent_kind,
                    subagent_id,
                    subagent_role,
                    subagent_closed_at,
                    cwd,
                    _json_dumps(workspace_roots or []),
                    current_model_provider_id,
                    current_model,
                    int(context_compression_epoch),
                    title,
                    title_source,
                    parent_session_id,
                    child_session_id,
                    source_trace_id,
                    source_active_session_id,
                    source_checkpoint_id,
                    source_checkpoint_ns,
                    now,
                    now,
                ),
            )
            row = conn.execute(
                "select * from sessions where id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError(f"创建 session 后无法读取: {session_id}")
        return self._from_row(row)

    def get(
        self,
        session_id: str,
        *,
        include_internal: bool = False,
    ) -> SessionRecord | None:
        query = "select * from sessions where id = ? and archived_at is null"
        if not include_internal:
            query += " and visibility = 'visible'"
        with self.db.connect() as conn:
            row = conn.execute(query, (session_id,)).fetchone()
        return self._from_row(row) if row else None

    def get_internal_for_parent(
        self,
        *,
        child_session_id: str,
        parent_session_id: str,
        run_id: str,
    ) -> SessionRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select s.*
                from sessions s
                join subagent_run r
                  on r.child_session_id = s.id
                 and r.parent_session_id = s.parent_session_id
                 and r.subagent_id = s.subagent_id
                where s.id = ?
                  and s.parent_session_id = ?
                  and r.run_id = ?
                  and s.visibility = 'internal'
                  and s.agent_kind = 'subagent'
                  and s.archived_at is null
                """,
                (child_session_id, parent_session_id, run_id),
            ).fetchone()
        return self._from_row(row) if row is not None else None

    def get_subagent_for_parent(
        self,
        *,
        subagent_id: str,
        parent_session_id: str,
        include_archived: bool = False,
    ) -> SessionRecord | None:
        archive_filter = "" if include_archived else "and archived_at is null"
        with self.db.connect() as conn:
            row = conn.execute(
                f"""
                select * from sessions
                where subagent_id = ?
                  and parent_session_id = ?
                  and visibility = 'internal'
                  and agent_kind = 'subagent'
                  {archive_filter}
                """,
                (subagent_id, parent_session_id),
            ).fetchone()
        return self._from_row(row) if row is not None else None

    def get_subagent(self, subagent_id: str) -> SessionRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from sessions
                where subagent_id = ?
                  and visibility = 'internal'
                  and agent_kind = 'subagent'
                  and archived_at is null
                """,
                (subagent_id,),
            ).fetchone()
        return self._from_row(row) if row is not None else None

    def close_subagent_instance(
        self,
        subagent_id: str,
        *,
        closed_at: datetime,
    ) -> SessionRecord:
        closed_at_value = to_iso_z(closed_at)
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                """
                select * from sessions
                where subagent_id = ?
                  and visibility = 'internal'
                  and agent_kind = 'subagent'
                  and archived_at is null
                """,
                (subagent_id,),
            ).fetchone()
            if row is None:
                raise SubagentError(
                    SubagentErrorCode.SUBAGENT_NOT_FOUND,
                    "the requested Sub-Agent instance does not exist",
                    details={"subagent_id": subagent_id},
                )
            if row["subagent_closed_at"] is None:
                active = conn.execute(
                    """
                    select run_id from subagent_run
                    where subagent_id = ? and state in ('queued', 'running')
                    """,
                    (subagent_id,),
                ).fetchone()
                if active is not None:
                    raise SubagentError(
                        SubagentErrorCode.SUBAGENT_CLOSE_REQUIRES_CANCEL,
                        "an active Run must be cancelled before closing the instance",
                        details={"run_id": active["run_id"]},
                    )
                conn.execute(
                    """
                    update sessions
                    set subagent_closed_at = ?, status = 'closed', updated_at = ?
                    where id = ? and subagent_closed_at is null
                    """,
                    (closed_at_value, closed_at_value, row["id"]),
                )
                row = conn.execute(
                    "select * from sessions where id = ?",
                    (row["id"],),
                ).fetchone()
        if row is None:
            raise RuntimeError("Sub-Agent instance disappeared while closing")
        return self._from_row(row)

    def get_many(
        self,
        session_ids: list[str],
        *,
        include_internal: bool = False,
    ) -> list[SessionRecord]:
        resolved_ids = list(dict.fromkeys(session_id for session_id in session_ids if session_id))
        if not resolved_ids:
            return []
        placeholders = ", ".join("?" for _ in resolved_ids)
        visibility_filter = "" if include_internal else " and visibility = 'visible'"
        with self.db.connect() as conn:
            rows = conn.execute(
                f"select * from sessions where id in ({placeholders}) "
                f"and archived_at is null{visibility_filter}",
                resolved_ids,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def get_archived(
        self,
        session_id: str,
        *,
        include_internal: bool = False,
    ) -> SessionRecord | None:
        visibility_filter = "" if include_internal else " and visibility = 'visible'"
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from sessions where id = ? and archived_at is not null"
                + visibility_filter,
                (session_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def archive_manual(
        self,
        session_id: str,
        *,
        archived_at: str,
    ) -> SessionLifecycleMutation:
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                """
                update sessions
                set archived_at = ?, archive_origin = 'manual'
                where id = ? and archived_at is null and visibility = 'visible'
                """,
                (archived_at, session_id),
            )
            if cursor.rowcount > 0:
                conn.execute(
                    """
                    update sessions
                    set archived_at = ?, archive_origin = 'manual'
                    where parent_session_id = ?
                      and agent_kind = 'subagent'
                      and visibility = 'internal'
                      and archived_at is null
                    """,
                    (archived_at, session_id),
                )
            row = conn.execute("select * from sessions where id = ?", (session_id,)).fetchone()
        return SessionLifecycleMutation(
            record=self._from_row(row) if row is not None else None,
            changed=cursor.rowcount > 0,
        )

    def restore(self, session_id: str) -> SessionLifecycleMutation:
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                """
                update sessions
                set archived_at = null, archive_origin = null
                where id = ? and archived_at is not null and visibility = 'visible'
                """,
                (session_id,),
            )
            if cursor.rowcount > 0:
                conn.execute(
                    """
                    update sessions
                    set archived_at = null, archive_origin = null
                    where parent_session_id = ?
                      and agent_kind = 'subagent'
                      and visibility = 'internal'
                      and archived_at is not null
                    """,
                    (session_id,),
                )
            row = conn.execute("select * from sessions where id = ?", (session_id,)).fetchone()
        return SessionLifecycleMutation(
            record=self._from_row(row) if row is not None else None,
            changed=cursor.rowcount > 0,
        )

    def hard_delete_internal(self, session_id: str) -> bool:
        """Remove an incomplete internal session created by a failed transaction-like workflow."""
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                "delete from session_forks where source_session_id = ? or target_session_id = ?",
                (session_id, session_id),
            )
            cursor = conn.execute("delete from sessions where id = ?", (session_id,))
        return cursor.rowcount > 0

    def list(
        self,
        *,
        user_id: str | None = None,
        scene_id: str | None = None,
        status: str | None = None,
        session_tag: str | None = None,
        workspace_id: str | None = None,
        session_type: str | None = None,
        title: str | None = None,
        include_internal: bool = False,
        limit: int = 100,
        offset: int = 0,
    ) -> list[SessionRecord]:
        where, params = self._list_filters(
            user_id=user_id,
            scene_id=scene_id,
            status=status,
            session_tag=session_tag,
            workspace_id=workspace_id,
            session_type=session_type,
            title=title,
            include_internal=include_internal,
        )
        params.extend((max(1, min(limit, 500)), max(0, int(offset))))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from sessions
                {where}
                order by
                  pinned_at is null,
                  pinned_at desc,
                  updated_at desc,
                  created_at desc,
                  id desc
                limit ? offset ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def count(
        self,
        *,
        user_id: str | None = None,
        scene_id: str | None = None,
        status: str | None = None,
        session_tag: str | None = None,
        workspace_id: str | None = None,
        session_type: str | None = None,
        title: str | None = None,
        include_internal: bool = False,
    ) -> int:
        where, params = self._list_filters(
            user_id=user_id,
            scene_id=scene_id,
            status=status,
            session_tag=session_tag,
            workspace_id=workspace_id,
            session_type=session_type,
            title=title,
            include_internal=include_internal,
        )
        with self.db.connect() as conn:
            row = conn.execute(f"select count(*) as total from sessions {where}", params).fetchone()
        return int(row["total"] if row is not None else 0)

    def _list_filters(
        self,
        *,
        user_id: str | None,
        scene_id: str | None,
        status: str | None,
        session_tag: str | None,
        workspace_id: str | None,
        session_type: str | None,
        title: str | None,
        include_internal: bool,
    ) -> tuple[str, list[Any]]:
        filters: list[str] = []
        params: list[Any] = []
        if user_id is not None:
            filters.append("user_id = ?")
            params.append(user_id)
        if scene_id is not None:
            filters.append("scene_id = ?")
            params.append(scene_id)
        if status is not None:
            self._validate_status(status)
            filters.append("status = ?")
            params.append(status)
        if session_tag is not None:
            filters.append("session_tag = ?")
            params.append(session_tag)
        if workspace_id is not None:
            filters.append("workspace_id = ?")
            params.append(workspace_id)
        if session_type is not None:
            self._validate_session_type(session_type)
            filters.append("session_type = ?")
            params.append(session_type)
        if title:
            filters.append("instr(lower(coalesce(title, '')), ?) > 0")
            params.append(title.strip().lower())
        if not include_internal:
            filters.append("visibility = 'visible'")
            if session_tag is None:
                filters.append("(session_tag is null or session_tag != ?)")
                params.append(self.INTERNAL_CONTEXT_COMPRESSION_SESSION_TAG)
                filters.append(
                    """
                    not (
                      source_active_session_id is not null
                      and source_checkpoint_id is not null
                      and parent_session_id is not null
                      and active_session_id = id
                    )
                    """
                )
        filters.append("archived_at is null")

        where = f"where {' and '.join(filters)}" if filters else ""
        return where, params

    def list_archived(
        self,
        *,
        query: str | None = None,
        workspace_id: str | None = None,
        workspace_ids: list[str] | None = None,
        exclude_archived_workspaces: bool = True,
        cursor: str | None = None,
        limit: int = 100,
    ) -> ArchivedSessionPage:
        page_size = max(1, min(limit, 200))
        filters = ["s.archived_at is not null", "s.visibility = 'visible'"]
        params: list[Any] = []
        if workspace_id is not None:
            filters.append("s.workspace_id = ?")
            params.append(workspace_id)
        elif workspace_ids:
            selected_workspace_ids = list(dict.fromkeys(item for item in workspace_ids if item))
            if selected_workspace_ids:
                placeholders = ", ".join("?" for _ in selected_workspace_ids)
                filters.append(f"s.workspace_id in ({placeholders})")
                params.extend(selected_workspace_ids)
        if exclude_archived_workspaces:
            filters.append("(w.id is null or w.archived_at is null)")
        cleaned_query = str(query or "").strip().casefold()
        if cleaned_query:
            pattern = f"%{_escape_like(cleaned_query)}%"
            filters.append("lower(coalesce(s.title, '')) like ? escape '\\'")
            params.append(pattern)
        cursor_value = _decode_archive_cursor(cursor)
        if cursor_value is not None:
            archived_at, session_id = cursor_value
            filters.append("(s.archived_at < ? or (s.archived_at = ? and s.id < ?))")
            params.extend([archived_at, archived_at, session_id])
        params.append(page_size + 1)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select
                  s.*,
                  w.name as archived_workspace_name,
                  w.archived_at as archived_workspace_archived_at
                from sessions s
                left join workspaces w on w.id = s.workspace_id
                where {' and '.join(filters)}
                order by s.archived_at desc, s.id desc
                limit ?
                """,
                params,
            ).fetchall()
        has_more = len(rows) > page_size
        visible_rows = rows[:page_size]
        items = [
            ArchivedSessionSummary(
                session=self._from_row(row),
                workspace_name=row["archived_workspace_name"],
                workspace_archived_at=row["archived_workspace_archived_at"],
            )
            for row in visible_rows
        ]
        last = visible_rows[-1] if has_more and visible_rows else None
        return ArchivedSessionPage(
            items=items,
            next_cursor=(
                _encode_archive_cursor(last["archived_at"], last["id"])
                if last is not None
                else None
            ),
            has_more=has_more,
        )

    def update(
        self,
        session_id: str,
        *,
        title: str | None = None,
        status: str | None = None,
        active_session_id: str | None = None,
        workspace_id: str | None = None,
        session_type: str | None = None,
        cwd: str | None = None,
        workspace_roots: list[str] | None = None,
        current_model_provider_id: str | None = None,
        current_model: str | None = None,
        context_compression_epoch: int | None = None,
        title_source: str | None = None,
        parent_session_id: str | None = None,
        child_session_id: str | None = None,
        source_trace_id: str | None = None,
        source_active_session_id: str | None = None,
        source_checkpoint_id: str | None = None,
        source_checkpoint_ns: str | None = None,
    ) -> SessionRecord | None:
        assignments: list[str] = []
        params: list[Any] = []
        if title is not None:
            assignments.append("title = ?")
            params.append(title)
        if title_source is not None:
            self._validate_title_source(title_source)
            assignments.append("title_source = ?")
            params.append(title_source)
        if status is not None:
            self._validate_status(status)
            assignments.append("status = ?")
            params.append(status)
        if active_session_id is not None:
            assignments.append("active_session_id = ?")
            params.append(active_session_id)
        if workspace_id is not None:
            assignments.append("workspace_id = ?")
            params.append(workspace_id)
        if session_type is not None:
            self._validate_session_type(session_type)
            assignments.append("session_type = ?")
            params.append(session_type)
        if cwd is not None:
            assignments.append("cwd = ?")
            params.append(cwd)
        if workspace_roots is not None:
            assignments.append("workspace_roots_json = ?")
            params.append(_json_dumps(workspace_roots))
        if current_model_provider_id is not None:
            assignments.append("current_model_provider_id = ?")
            params.append(current_model_provider_id)
        if current_model is not None:
            assignments.append("current_model = ?")
            params.append(current_model)
        if context_compression_epoch is not None:
            assignments.append("context_compression_epoch = ?")
            params.append(int(context_compression_epoch))
        if parent_session_id is not None:
            assignments.append("parent_session_id = ?")
            params.append(parent_session_id)
        if child_session_id is not None:
            assignments.append("child_session_id = ?")
            params.append(child_session_id)
        if source_trace_id is not None:
            assignments.append("source_trace_id = ?")
            params.append(source_trace_id)
        if source_active_session_id is not None:
            assignments.append("source_active_session_id = ?")
            params.append(source_active_session_id)
        if source_checkpoint_id is not None:
            assignments.append("source_checkpoint_id = ?")
            params.append(source_checkpoint_id)
        if source_checkpoint_ns is not None:
            assignments.append("source_checkpoint_ns = ?")
            params.append(source_checkpoint_ns)
        if not assignments:
            return self.get(session_id, include_internal=True)

        assignments.append("updated_at = ?")
        params.append(to_iso_z(utc_now()))
        params.append(session_id)
        with self.db.transaction() as conn:
            conn.execute(
                f"update sessions set {', '.join(assignments)} where id = ? and archived_at is null",
                params,
            )
        return self.get(session_id, include_internal=True)

    def get_context_compression_epoch(self, session_id: str) -> int:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select context_compression_epoch
                from sessions
                where id = ? and archived_at is null
                """,
                (session_id,),
            ).fetchone()
        if row is None:
            return 0
        return int(row["context_compression_epoch"] or 0)

    def increment_context_compression_epoch(self, session_id: str) -> int:
        # A completed compression invalidates the pre-compression usage snapshot.
        # Clear it atomically with the epoch change so history reloads cannot restore stale progress.
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update sessions
                set context_compression_epoch = context_compression_epoch + 1,
                    context_window_usage_json = null,
                    updated_at = ?
                where id = ? and archived_at is null
                """,
                (now, session_id),
            )
            if cursor.rowcount == 0:
                return 0
            row = conn.execute(
                """
                select context_compression_epoch
                from sessions
                where id = ?
                """,
                (session_id,),
            ).fetchone()
        if row is None:
            return 0
        return int(row["context_compression_epoch"] or 0)

    def update_title_if_auto_allowed(
        self,
        session_id: str,
        *,
        title: str,
        only_when_default_title: bool,
    ) -> SessionRecord | None:
        cleaned = title.strip()
        if not cleaned:
            raise ValueError("title must not be empty")
        allowed_sources = (
            ("auto_candidate",) if only_when_default_title else ("auto_candidate", "auto")
        )
        placeholders = ", ".join("?" for _ in allowed_sources)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"""
                update sessions
                set title = ?, title_source = 'auto', updated_at = ?
                where id = ?
                  and archived_at is null
                  and title_source in ({placeholders})
                """,
                [cleaned, now, session_id, *allowed_sources],
            )
        if cursor.rowcount == 0:
            return None
        return self.get(session_id, include_internal=True)

    def touch(self, session_id: str) -> SessionRecord | None:
        assignments = ["updated_at = ?"]
        params: list[Any] = [to_iso_z(utc_now())]
        params.append(session_id)
        with self.db.transaction() as conn:
            conn.execute(
                f"update sessions set {', '.join(assignments)} where id = ? and archived_at is null",
                params,
            )
        return self.get(session_id, include_internal=True)

    def update_context_window_usage(
        self,
        session_id: str,
        snapshot: dict[str, Any],
    ) -> SessionRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update sessions
                set context_window_usage_json = ?, updated_at = ?
                where id = ? and archived_at is null
                """,
                (_json_dumps(snapshot), now, session_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(session_id, include_internal=True)

    def set_pinned(self, session_id: str, pinned: bool) -> SessionRecord | None:
        pinned_at = to_iso_z(utc_now()) if pinned else None
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update sessions
                set pinned_at = ?
                where id = ? and archived_at is null and visibility = 'visible'
                """,
                (pinned_at, session_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(session_id)

    def close(self, session_id: str) -> SessionRecord | None:
        return self.update(session_id, status="closed")

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 session 状态: {status}")

    @classmethod
    def _validate_session_type(cls, session_type: str) -> None:
        if session_type not in cls.VALID_SESSION_TYPES:
            raise ValueError(f"不支持的 session 类型: {session_type}")

    @classmethod
    def _validate_agent_metadata(
        cls,
        *,
        visibility: str,
        agent_kind: str,
        subagent_id: str | None,
        subagent_role: str | None,
        subagent_closed_at: str | None,
        parent_session_id: str | None,
        session_type: str,
        session_tag: str,
    ) -> None:
        if visibility not in cls.VALID_VISIBILITIES:
            raise ValueError(f"不支持的 session 可见性: {visibility}")
        if agent_kind not in cls.VALID_AGENT_KINDS:
            raise ValueError(f"不支持的 agent 类型: {agent_kind}")
        if subagent_role is not None and subagent_role not in cls.VALID_SUBAGENT_ROLES:
            raise ValueError(f"不支持的 Sub-Agent 角色: {subagent_role}")
        if agent_kind == "main":
            if (
                subagent_id is not None
                or subagent_role is not None
                or subagent_closed_at is not None
            ):
                raise ValueError("main session 不能携带 Sub-Agent 元数据")
            return
        if (
            visibility != "internal"
            or not str(subagent_id or "").strip()
            or subagent_role not in cls.VALID_SUBAGENT_ROLES
            or not str(parent_session_id or "").strip()
            or session_type != "workspace"
            or session_tag != cls.SUBAGENT_SESSION_TAG
        ):
            raise ValueError(
                "Sub-Agent session 必须是 internal workspace，并包含 parent/id/role/tag"
            )

    @classmethod
    def _validate_title_source(cls, title_source: str) -> None:
        if title_source not in cls.VALID_TITLE_SOURCES:
            raise ValueError(f"不支持的 title 来源: {title_source}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> SessionRecord:
        archived_at = row["archived_at"]
        archive_origin = row["archive_origin"]
        if (archived_at is None) != (archive_origin is None):
            raise RuntimeError(
                "session archive state is invalid: archived_at and archive_origin must match"
            )
        if archive_origin not in {None, "manual", "project"}:
            raise RuntimeError(f"session archive origin is invalid: {archive_origin}")
        return SessionRecord(
            id=row["id"],
            user_id=row["user_id"],
            scene_id=row["scene_id"],
            scene_version_seq=row["scene_version_seq"],
            status=row["status"],
            is_debug=bool(row["is_debug"]),
            debug_type=row["debug_type"],
            is_scheduled=bool(row["is_scheduled"]),
            scheduled_task_id=row["scheduled_task_id"],
            session_tag=row["session_tag"],
            active_session_id=row["active_session_id"],
            parent_session_id=row["parent_session_id"],
            child_session_id=row["child_session_id"],
            source_trace_id=row["source_trace_id"],
            source_active_session_id=row["source_active_session_id"],
            source_checkpoint_id=row["source_checkpoint_id"],
            source_checkpoint_ns=row["source_checkpoint_ns"],
            workspace_id=row["workspace_id"],
            session_type=row["session_type"],
            visibility=row["visibility"],
            agent_kind=row["agent_kind"],
            subagent_id=row["subagent_id"],
            subagent_role=row["subagent_role"],
            subagent_closed_at=row["subagent_closed_at"],
            cwd=row["cwd"],
            workspace_roots=_json_loads(row["workspace_roots_json"], []),
            current_model_provider_id=row["current_model_provider_id"],
            current_model=row["current_model"],
            context_window_usage=_json_loads(row["context_window_usage_json"], None),
            context_compression_epoch=int(row["context_compression_epoch"] or 0),
            pinned_at=row["pinned_at"],
            title=row["title"],
            title_source=row["title_source"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            archived_at=archived_at,
            archive_origin=archive_origin,
        )


class SubagentRunRepository:
    ACTIVE_STATES = ("queued", "running")

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        record: SubagentRunRecord | SubagentRunSnapshot,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> SubagentRunRecord:
        resolved = (
            record
            if isinstance(record, SubagentRunRecord)
            else SubagentRunRecord.from_snapshot(record)
        )
        if connection is not None:
            self._insert(connection, resolved)
            row = connection.execute(
                "select * from subagent_run where run_id = ?",
                (resolved.run_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError(f"创建 Sub-Agent Run 后无法读取: {resolved.run_id}")
            return self._from_row(row)
        with self.db.transaction(immediate=True) as conn:
            self._insert(conn, resolved)
            row = conn.execute(
                "select * from subagent_run where run_id = ?",
                (resolved.run_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError(f"创建 Sub-Agent Run 后无法读取: {resolved.run_id}")
        return self._from_row(row)

    @staticmethod
    def _insert(conn: sqlite3.Connection, record: SubagentRunRecord) -> None:
        conn.execute(
            """
            insert into subagent_run (
              run_id, subagent_id, child_session_id, parent_session_id,
              parent_trace_id, parent_tool_call_id, parent_timeline_sequence,
              initiated_by, role, task, state, blocked_on, version,
              final_report, report_truncated, error_code, error_message,
              created_at, queued_at, started_at, finished_at, updated_at,
              cancel_requested_at
            ) values (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            )
            """,
            (
                record.run_id,
                record.subagent_id,
                record.child_session_id,
                record.parent_session_id,
                record.parent_trace_id,
                record.parent_tool_call_id,
                record.parent_timeline_sequence,
                record.initiated_by,
                record.role,
                record.task,
                record.state,
                record.blocked_on,
                record.version,
                record.final_report,
                int(record.report_truncated),
                record.error_code,
                record.error_message,
                record.created_at,
                record.queued_at,
                record.started_at,
                record.finished_at,
                record.updated_at,
                record.cancel_requested_at,
            ),
        )

    def get(
        self,
        run_id: str,
        *,
        parent_session_id: str | None = None,
    ) -> SubagentRunRecord | None:
        filters = ["run_id = ?"]
        params: list[Any] = [run_id]
        if parent_session_id is not None:
            filters.append("parent_session_id = ?")
            params.append(parent_session_id)
        with self.db.connect() as conn:
            row = conn.execute(
                f"select * from subagent_run where {' and '.join(filters)}",
                params,
            ).fetchone()
        return self._from_row(row) if row is not None else None

    def list_by_parent(self, parent_session_id: str) -> list[SubagentRunRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from subagent_run
                where parent_session_id = ?
                order by parent_timeline_sequence, created_at, run_id
                """,
                (parent_session_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def list_active_by_parent_trace(
        self,
        parent_session_id: str,
        parent_trace_id: str,
    ) -> list[SubagentRunRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from subagent_run
                where parent_session_id = ?
                  and parent_trace_id = ?
                  and state in ('queued', 'running')
                order by parent_timeline_sequence, created_at, run_id
                """,
                (parent_session_id, parent_trace_id),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def list_by_subagent(
        self,
        subagent_id: str,
        *,
        parent_session_id: str | None = None,
    ) -> list[SubagentRunRecord]:
        filters = ["subagent_id = ?"]
        params: list[Any] = [subagent_id]
        if parent_session_id is not None:
            filters.append("parent_session_id = ?")
            params.append(parent_session_id)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from subagent_run
                where {' and '.join(filters)}
                order by parent_timeline_sequence, created_at, run_id
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def get_active(
        self,
        subagent_id: str,
        *,
        parent_session_id: str | None = None,
    ) -> SubagentRunRecord | None:
        filters = ["subagent_id = ?", "state in ('queued', 'running')"]
        params: list[Any] = [subagent_id]
        if parent_session_id is not None:
            filters.append("parent_session_id = ?")
            params.append(parent_session_id)
        with self.db.connect() as conn:
            row = conn.execute(
                f"select * from subagent_run where {' and '.join(filters)}",
                params,
            ).fetchone()
        return self._from_row(row) if row is not None else None

    def list_reconciliation_candidates(self) -> list[SubagentRunRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from subagent_run
                where state in ('queued', 'running')
                order by updated_at, run_id
                """
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def next_parent_sequence(
        self,
        parent_session_id: str,
        *,
        connection: sqlite3.Connection,
    ) -> int:
        row = connection.execute(
            """
            select coalesce(max(parent_timeline_sequence), -1) + 1 as next_sequence
            from subagent_run
            where parent_session_id = ?
            """,
            (parent_session_id,),
        ).fetchone()
        return int(row["next_sequence"] if row is not None else 0)

    def transition(
        self,
        run_id: str,
        to_state: str,
        *,
        expected_version: int,
        now: datetime,
        final_report: str | None = None,
        report_truncated: bool = False,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> SubagentRunRecord:
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                "select * from subagent_run where run_id = ?",
                (run_id,),
            ).fetchone()
            if row is None:
                raise SubagentError(
                    SubagentErrorCode.RUN_NOT_FOUND,
                    "the requested Sub-Agent Run does not exist",
                    details={"run_id": run_id},
                )
            current_record = self._from_row(row)
            current = current_record.to_snapshot()
            if current.version != expected_version:
                try:
                    replay = transition_run(
                        current,
                        to_state,
                        expected_version=current.version,
                        now=now,
                        final_report=final_report,
                        report_truncated=report_truncated,
                        error_code=error_code,
                        error_message=error_message,
                    )
                except SubagentError as exc:
                    raise SubagentError(
                        SubagentErrorCode.RUN_VERSION_CONFLICT,
                        "the Run snapshot version is stale",
                        details={
                            "run_id": run_id,
                            "expected_version": expected_version,
                            "actual_version": current.version,
                        },
                    ) from exc
                if replay is current:
                    return current_record

            updated = transition_run(
                current,
                to_state,
                expected_version=expected_version,
                now=now,
                final_report=final_report,
                report_truncated=report_truncated,
                error_code=error_code,
                error_message=error_message,
            )
            if updated is current:
                return current_record
            updated_record = SubagentRunRecord.from_snapshot(updated)
            cursor = conn.execute(
                """
                update subagent_run
                set state = ?, blocked_on = ?, version = ?,
                    final_report = ?, report_truncated = ?,
                    error_code = ?, error_message = ?,
                    started_at = ?, finished_at = ?, updated_at = ?,
                    cancel_requested_at = ?
                where run_id = ? and version = ? and state = ?
                """,
                (
                    updated_record.state,
                    updated_record.blocked_on,
                    updated_record.version,
                    updated_record.final_report,
                    int(updated_record.report_truncated),
                    updated_record.error_code,
                    updated_record.error_message,
                    updated_record.started_at,
                    updated_record.finished_at,
                    updated_record.updated_at,
                    updated_record.cancel_requested_at,
                    run_id,
                    expected_version,
                    current_record.state,
                ),
            )
            if cursor.rowcount != 1:
                raise SubagentError(
                    SubagentErrorCode.RUN_VERSION_CONFLICT,
                    "the Run changed before the atomic transition committed",
                    details={"run_id": run_id, "expected_version": expected_version},
                )
            persisted = conn.execute(
                "select * from subagent_run where run_id = ?", (run_id,)
            ).fetchone()
        if persisted is None:
            raise RuntimeError(f"状态转换后无法读取 Sub-Agent Run: {run_id}")
        return self._from_row(persisted)

    def update_blocked_on(
        self,
        run_id: str,
        blocked_on: str | None,
        *,
        expected_version: int,
        now: datetime,
    ) -> SubagentRunRecord:
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                "select * from subagent_run where run_id = ?", (run_id,)
            ).fetchone()
            if row is None:
                raise SubagentError(
                    SubagentErrorCode.RUN_NOT_FOUND,
                    "the requested Sub-Agent Run does not exist",
                    details={"run_id": run_id},
                )
            current_record = self._from_row(row)
            updated = set_blocked_on(
                current_record.to_snapshot(),
                blocked_on,
                expected_version=expected_version,
            )
            if updated.version == current_record.version:
                return current_record
            cursor = conn.execute(
                """
                update subagent_run
                set blocked_on = ?, version = ?, updated_at = ?
                where run_id = ? and version = ? and state = 'running'
                """,
                (
                    updated.blocked_on.value if updated.blocked_on is not None else None,
                    updated.version,
                    to_iso_z(now),
                    run_id,
                    expected_version,
                ),
            )
            if cursor.rowcount != 1:
                raise SubagentError(
                    SubagentErrorCode.RUN_VERSION_CONFLICT,
                    "the Run changed before the blocked_on update committed",
                    details={"run_id": run_id, "expected_version": expected_version},
                )
            persisted = conn.execute(
                "select * from subagent_run where run_id = ?", (run_id,)
            ).fetchone()
        if persisted is None:
            raise RuntimeError(f"blocked_on 更新后无法读取 Sub-Agent Run: {run_id}")
        return self._from_row(persisted)

    @staticmethod
    def _from_row(row: sqlite3.Row) -> SubagentRunRecord:
        return SubagentRunRecord(
            run_id=row["run_id"],
            subagent_id=row["subagent_id"],
            child_session_id=row["child_session_id"],
            parent_session_id=row["parent_session_id"],
            parent_trace_id=row["parent_trace_id"],
            parent_tool_call_id=row["parent_tool_call_id"],
            parent_timeline_sequence=int(row["parent_timeline_sequence"]),
            initiated_by=row["initiated_by"],
            role=row["role"],
            task=row["task"],
            state=row["state"],
            blocked_on=row["blocked_on"],
            version=int(row["version"]),
            final_report=row["final_report"],
            report_truncated=bool(row["report_truncated"]),
            error_code=row["error_code"],
            error_message=row["error_message"],
            created_at=row["created_at"],
            queued_at=row["queued_at"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            updated_at=row["updated_at"],
            cancel_requested_at=row["cancel_requested_at"],
        )


class SessionForksRepository:
    VALID_RELATION_TYPES = {"fork"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        fork_id: str,
        source_session_id: str,
        target_session_id: str,
        source_message_event_id: str,
        target_message_event_id: str,
        source_turn_index: int,
        target_turn_index: int,
        source_trace_id: str | None = None,
        source_active_session_id: str | None = None,
        source_checkpoint_id: str | None = None,
        source_checkpoint_ns: str | None = None,
        relation_type: str = "fork",
    ) -> SessionForkRecord:
        self._validate_relation_type(relation_type)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into session_forks (
                  id, source_session_id, target_session_id, source_message_event_id,
                  target_message_event_id, source_turn_index, target_turn_index,
                  source_trace_id, source_active_session_id,
                  source_checkpoint_id, source_checkpoint_ns, relation_type,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    fork_id,
                    source_session_id,
                    target_session_id,
                    source_message_event_id,
                    target_message_event_id,
                    int(source_turn_index),
                    int(target_turn_index),
                    source_trace_id,
                    source_active_session_id,
                    source_checkpoint_id,
                    source_checkpoint_ns or "",
                    relation_type,
                    now,
                    now,
                ),
            )
        record = self.get(fork_id)
        if record is None:
            raise RuntimeError(f"创建 session fork 后无法读取: {fork_id}")
        return record

    def get(self, fork_id: str, *, include_deleted: bool = False) -> SessionForkRecord | None:
        query = "select * from session_forks where id = ?"
        params: list[Any] = [fork_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def get_by_target(
        self,
        target_session_id: str,
        *,
        relation_type: str = "fork",
        include_deleted: bool = False,
    ) -> SessionForkRecord | None:
        self._validate_relation_type(relation_type)
        query = "select * from session_forks where target_session_id = ? and relation_type = ?"
        params: list[Any] = [target_session_id, relation_type]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by created_at desc, id desc limit 1"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_by_targets(
        self,
        target_session_ids: list[str],
        *,
        relation_type: str = "fork",
        include_deleted: bool = False,
    ) -> list[SessionForkRecord]:
        self._validate_relation_type(relation_type)
        resolved_ids = list(
            dict.fromkeys(session_id for session_id in target_session_ids if session_id)
        )
        if not resolved_ids:
            return []
        placeholders = ", ".join("?" for _ in resolved_ids)
        query = (
            f"select * from session_forks where target_session_id in ({placeholders}) "
            "and relation_type = ?"
        )
        params: list[Any] = [*resolved_ids, relation_type]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by target_session_id, created_at desc, id desc"
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        latest_by_target: dict[str, SessionForkRecord] = {}
        for row in rows:
            record = self._from_row(row)
            latest_by_target.setdefault(record.target_session_id, record)
        return list(latest_by_target.values())

    def list_by_source(
        self,
        source_session_id: str,
        *,
        relation_type: str = "fork",
        include_deleted: bool = False,
    ) -> list[SessionForkRecord]:
        self._validate_relation_type(relation_type)
        query = "select * from session_forks where source_session_id = ? and relation_type = ?"
        params: list[Any] = [source_session_id, relation_type]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by source_turn_index asc, created_at asc, id asc"
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._from_row(row) for row in rows]

    def soft_delete_by_target(self, target_session_id: str) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update session_forks
                set is_deleted = 1, updated_at = ?
                where target_session_id = ? and is_deleted = 0
                """,
                (now, target_session_id),
            )
        return int(cursor.rowcount)

    @classmethod
    def _validate_relation_type(cls, relation_type: str) -> None:
        if relation_type not in cls.VALID_RELATION_TYPES:
            raise ValueError(f"不支持的 session fork 关系类型: {relation_type}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> SessionForkRecord:
        return SessionForkRecord(
            id=row["id"],
            source_session_id=row["source_session_id"],
            target_session_id=row["target_session_id"],
            source_message_event_id=row["source_message_event_id"],
            target_message_event_id=row["target_message_event_id"],
            source_turn_index=int(row["source_turn_index"]),
            target_turn_index=int(row["target_turn_index"]),
            source_trace_id=row["source_trace_id"],
            source_active_session_id=row["source_active_session_id"],
            source_checkpoint_id=row["source_checkpoint_id"],
            source_checkpoint_ns=row["source_checkpoint_ns"] or "",
            relation_type=row["relation_type"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class AttachmentsRepository:
    VALID_TYPES = {"image", "document", "file"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        attachment_id: str | None = None,
        session_id: str | None = None,
        user_id: str,
        type: str,
        source: str,
        name: str,
        path: str,
        mime_type: str,
        size: int,
        connection: sqlite3.Connection | None = None,
    ) -> AttachmentRecord:
        cleaned_type = type.strip() or "file"
        if cleaned_type not in self.VALID_TYPES:
            raise ValueError(f"unsupported attachment type: {cleaned_type}")
        if not user_id.strip():
            raise ValueError("attachment user_id must not be empty")
        if not name.strip():
            raise ValueError("attachment name must not be empty")
        if not path.strip():
            raise ValueError("attachment path must not be empty")
        now = to_iso_z(utc_now())
        record_id = attachment_id or new_id()
        transaction = nullcontext(connection) if connection is not None else self.db.transaction()
        with transaction as conn:
            conn.execute(
                """
                insert into attachments (
                  id, session_id, user_id, type, source, name, path, mime_type,
                  size, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record_id,
                    session_id,
                    user_id,
                    cleaned_type,
                    source.strip() or "unknown",
                    name.strip(),
                    path,
                    mime_type.strip() or "application/octet-stream",
                    max(0, int(size)),
                    now,
                    now,
                ),
            )
            row = conn.execute(
                "select * from attachments where id = ?",
                (record_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError(f"创建 attachment 后无法读取: {record_id}")
        return self._from_row(row)

    def get(
        self,
        attachment_id: str,
        *,
        include_deleted: bool = False,
        connection: sqlite3.Connection | None = None,
    ) -> AttachmentRecord | None:
        query = "select * from attachments where id = ?"
        params: list[Any] = [attachment_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        transaction = nullcontext(connection) if connection is not None else self.db.connect()
        with transaction as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_by_ids(
        self,
        attachment_ids: list[str],
        *,
        include_deleted: bool = False,
    ) -> list[AttachmentRecord]:
        ordered_ids = [item for item in dict.fromkeys(attachment_ids) if item]
        if not ordered_ids:
            return []
        placeholders = ",".join("?" for _ in ordered_ids)
        query = f"select * from attachments where id in ({placeholders})"
        params: list[Any] = list(ordered_ids)
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        records = {row["id"]: self._from_row(row) for row in rows}
        return [records[item] for item in ordered_ids if item in records]

    def claim_for_session(
        self,
        attachment_ids: list[str],
        *,
        session_id: str,
        user_id: str,
    ) -> None:
        ordered_ids = [item for item in dict.fromkeys(attachment_ids) if item]
        if not ordered_ids:
            return
        now = to_iso_z(utc_now())
        placeholders = ",".join("?" for _ in ordered_ids)
        with self.db.transaction() as conn:
            conn.execute(
                f"""
                update attachments
                set session_id = ?, updated_at = ?
                where id in ({placeholders})
                  and user_id = ?
                  and is_deleted = 0
                  and (session_id is null or session_id = ?)
                """,
                [session_id, now, *ordered_ids, user_id, session_id],
            )

    def soft_delete(self, attachment_id: str) -> bool:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update attachments
                set is_deleted = 1, updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, attachment_id),
            )
        return cursor.rowcount > 0

    def hard_delete_unreferenced_web_annotation(
        self,
        attachment_id: str,
    ) -> tuple[str, AttachmentRecord | None]:
        """Delete only an unattached, transient web-annotation upload.

        The broad string checks are intentionally conservative: an attachment id
        found anywhere in a history or pending-input payload protects the record,
        even if a future payload schema moves the exact attachment field.
        """

        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                "select * from attachments where id = ? and is_deleted = 0",
                (attachment_id,),
            ).fetchone()
            if row is None:
                return "not_found", None
            record = self._from_row(row)
            if record.source != "web_annotation":
                return "source_forbidden", record
            protected_queries = (
                """
                select 1 from web_annotation_attachment_clones
                where attachment_id = ? limit 1
                """,
                """
                select 1 from message_events
                where is_deleted = 0 and instr(coalesce(data_json, ''), ?) > 0
                limit 1
                """,
                """
                select 1 from session_pending_inputs
                where is_deleted = 0 and instr(coalesce(attachments_json, ''), ?) > 0
                limit 1
                """,
            )
            if any(conn.execute(query, (attachment_id,)).fetchone() for query in protected_queries):
                return "referenced", record
            cursor = conn.execute(
                "delete from attachments where id = ? and source = 'web_annotation'",
                (attachment_id,),
            )
            if cursor.rowcount != 1:
                return "not_found", None
        return "deleted", record

    @staticmethod
    def _from_row(row: sqlite3.Row) -> AttachmentRecord:
        return AttachmentRecord(
            id=row["id"],
            session_id=row["session_id"],
            user_id=row["user_id"],
            type=row["type"],
            source=row["source"],
            name=row["name"],
            path=row["path"],
            mime_type=row["mime_type"],
            size=int(row["size"] or 0),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class A2UIInteractionsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        session_id: str,
        stream_id: str,
        render_key: str,
        mode: str,
        payload: dict[str, Any],
        input_schema: dict[str, Any],
        submit_schema_snapshot: dict[str, Any],
        interaction_id: str | None = None,
        trace_id: str | None = None,
        active_session_id: str | None = None,
        turn_index: int = 0,
        tool_call_id: str | None = None,
        langgraph_thread_id: str | None = None,
        checkpoint_ns: str = "",
        checkpoint_id: str | None = None,
        interrupt_id: str | None = None,
        resume_group_id: str | None = None,
    ) -> A2UIInteractionRecord:
        self._validate_status(A2UI_STATUS_WAITING_USER_INPUT)
        self._validate_resume_status(A2UI_RESUME_STATUS_NOT_STARTED)
        resolved_id = interaction_id or new_id()
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                insert into a2ui_interactions (
                  id, session_id, trace_id, active_session_id, turn_index,
                  tool_call_id, stream_id, render_key, mode, payload_json,
                  input_schema_json, submit_schema_snapshot_json, status,
                  langgraph_thread_id, checkpoint_ns, checkpoint_id, interrupt_id,
                  resume_group_id, resume_status, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    resolved_id,
                    session_id,
                    trace_id,
                    active_session_id,
                    int(turn_index),
                    tool_call_id,
                    stream_id,
                    render_key,
                    mode,
                    _json_dumps(payload),
                    _json_dumps(input_schema),
                    _json_dumps(submit_schema_snapshot),
                    A2UI_STATUS_WAITING_USER_INPUT,
                    langgraph_thread_id,
                    checkpoint_ns,
                    checkpoint_id,
                    interrupt_id,
                    resume_group_id,
                    A2UI_RESUME_STATUS_NOT_STARTED,
                    now,
                    now,
                ),
            )
        record = self.get(resolved_id)
        if record is None:
            raise RuntimeError(f"创建 A2UI interaction 后无法读取: {resolved_id}")
        return record

    def get(
        self,
        interaction_id: str,
        *,
        include_deleted: bool = False,
    ) -> A2UIInteractionRecord | None:
        query = "select * from a2ui_interactions where id = ?"
        params: list[Any] = [interaction_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_by_session(
        self,
        session_id: str,
        *,
        include_deleted: bool = False,
        limit: int = 1000,
    ) -> list[A2UIInteractionRecord]:
        query = "select * from a2ui_interactions where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by created_at asc, id asc limit ?"
        params.append(max(1, min(limit, 5000)))
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._from_row(row) for row in rows]

    def get_waiting_by_session(self, session_id: str) -> list[A2UIInteractionRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from a2ui_interactions
                where session_id = ?
                  and status = ?
                  and is_deleted = 0
                order by created_at asc, id asc
                """,
                (session_id, A2UI_STATUS_WAITING_USER_INPUT),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def submit(
        self,
        interaction_id: str,
        *,
        request_id: str,
        submit_result: dict[str, Any],
        resume_payload: dict[str, Any] | None = None,
    ) -> A2UIInteractionRecord:
        return self._close_interaction(
            interaction_id,
            status=A2UI_STATUS_SUBMITTED,
            request_id=request_id,
            result=submit_result,
            reason=None,
            resume_payload=resume_payload,
        )

    def cancel(
        self,
        interaction_id: str,
        *,
        request_id: str,
        cancel_reason: str | None = None,
        resume_payload: dict[str, Any] | None = None,
    ) -> A2UIInteractionRecord:
        return self._close_interaction(
            interaction_id,
            status=A2UI_STATUS_CANCELLED,
            request_id=request_id,
            result=None,
            reason=cancel_reason,
            resume_payload=resume_payload,
        )

    def mark_resume_deferred(self, interaction_id: str) -> A2UIInteractionRecord:
        return self._mark_resume_status(
            [interaction_id],
            resume_status=A2UI_RESUME_STATUS_DEFERRED,
        )[0]

    def update_interrupt_id(
        self,
        interaction_id: str,
        interrupt_id: str,
    ) -> A2UIInteractionRecord:
        normalized_interrupt_id = str(interrupt_id or "").strip()
        if not normalized_interrupt_id:
            raise ValueError("A2UI interrupt_id 不能为空")
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                "select * from a2ui_interactions where id = ? and is_deleted = 0",
                (interaction_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"A2UI interaction 不存在: {interaction_id}")
            conn.execute(
                """
                update a2ui_interactions
                set interrupt_id = ?, updated_at = ?
                where id = ?
                """,
                (normalized_interrupt_id, now, interaction_id),
            )
        record = self.get(interaction_id)
        if record is None:
            raise RuntimeError(f"更新 A2UI interrupt_id 后无法读取: {interaction_id}")
        return record

    def mark_resume_started(
        self,
        interaction_ids: list[str],
        *,
        resume_payload: dict[str, Any] | None = None,
    ) -> list[A2UIInteractionRecord]:
        return self._mark_resume_status(
            interaction_ids,
            resume_status=A2UI_RESUME_STATUS_STARTED,
            resume_payload=resume_payload,
            started=True,
        )

    def mark_resume_finished(
        self,
        interaction_ids: list[str],
        *,
        resume_payload: dict[str, Any] | None = None,
    ) -> list[A2UIInteractionRecord]:
        return self._mark_resume_status(
            interaction_ids,
            resume_status=A2UI_RESUME_STATUS_SUCCEEDED,
            resume_payload=resume_payload,
            finished=True,
        )

    def mark_resume_failed(
        self,
        interaction_ids: list[str],
        *,
        error: str,
        resume_payload: dict[str, Any] | None = None,
    ) -> list[A2UIInteractionRecord]:
        return self._mark_resume_status(
            interaction_ids,
            resume_status=A2UI_RESUME_STATUS_FAILED,
            resume_payload=resume_payload,
            error=error,
            finished=True,
        )

    def list_resume_group_peers(
        self,
        *,
        resume_group_id: str,
        include_interaction_id: str | None = None,
    ) -> list[A2UIInteractionRecord]:
        query = """
            select * from a2ui_interactions
            where resume_group_id = ?
              and is_deleted = 0
              and (
                resume_status = ?
        """
        params: list[Any] = [resume_group_id, A2UI_RESUME_STATUS_NOT_STARTED]
        if include_interaction_id:
            query += " or id = ?"
            params.append(include_interaction_id)
        query += ") order by created_at asc, id asc"
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._from_row(row) for row in rows]

    def _close_interaction(
        self,
        interaction_id: str,
        *,
        status: str,
        request_id: str,
        result: dict[str, Any] | None,
        reason: str | None,
        resume_payload: dict[str, Any] | None,
    ) -> A2UIInteractionRecord:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        request_column = (
            "submit_request_id"
            if status == A2UI_STATUS_SUBMITTED
            else "cancel_request_id"
        )
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                "select * from a2ui_interactions where id = ? and is_deleted = 0",
                (interaction_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"A2UI interaction 不存在: {interaction_id}")
            current = self._from_row(row)
            existing_request_id = getattr(current, request_column)
            if current.status == status and existing_request_id == request_id:
                return current
            if current.status != A2UI_STATUS_WAITING_USER_INPUT:
                raise ValueError(
                    f"A2UI interaction 已关闭: {interaction_id} status={current.status}"
                )
            if status == A2UI_STATUS_SUBMITTED:
                conn.execute(
                    """
                    update a2ui_interactions
                    set status = ?,
                        submit_request_id = ?,
                        submit_result_json = ?,
                        resume_payload_json = coalesce(?, resume_payload_json),
                        submitted_at = ?,
                        updated_at = ?
                    where id = ?
                    """,
                    (
                        status,
                        request_id,
                        _json_dumps(result or {}),
                        _json_dumps(resume_payload) if resume_payload is not None else None,
                        now,
                        now,
                        interaction_id,
                    ),
                )
            else:
                conn.execute(
                    """
                    update a2ui_interactions
                    set status = ?,
                        cancel_request_id = ?,
                        cancel_reason = ?,
                        resume_payload_json = coalesce(?, resume_payload_json),
                        cancelled_at = ?,
                        updated_at = ?
                    where id = ?
                    """,
                    (
                        status,
                        request_id,
                        reason,
                        _json_dumps(resume_payload) if resume_payload is not None else None,
                        now,
                        now,
                        interaction_id,
                    ),
                )
        record = self.get(interaction_id)
        if record is None:
            raise RuntimeError(f"更新 A2UI interaction 后无法读取: {interaction_id}")
        return record

    def _mark_resume_status(
        self,
        interaction_ids: list[str],
        *,
        resume_status: str,
        resume_payload: dict[str, Any] | None = None,
        error: str | None = None,
        started: bool = False,
        finished: bool = False,
    ) -> list[A2UIInteractionRecord]:
        self._validate_resume_status(resume_status)
        ids = [interaction_id for interaction_id in interaction_ids if interaction_id]
        if not ids:
            return []
        now = to_iso_z(utc_now())
        assignments = ["resume_status = ?", "updated_at = ?"]
        params: list[Any] = [resume_status, now]
        if resume_payload is not None:
            assignments.append("resume_payload_json = ?")
            params.append(_json_dumps(resume_payload))
        if error is not None:
            assignments.append("resume_error = ?")
            params.append(error)
        if started:
            assignments.append("resume_started_at = coalesce(resume_started_at, ?)")
            params.append(now)
        if finished:
            assignments.append("resume_finished_at = ?")
            params.append(now)
        placeholders = ",".join("?" for _ in ids)
        params.extend(ids)
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                f"""
                update a2ui_interactions
                set {", ".join(assignments)}
                where id in ({placeholders})
                  and is_deleted = 0
                """,
                params,
            )
        return [record for record_id in ids if (record := self.get(record_id)) is not None]

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in A2UI_STATUSES:
            raise ValueError(f"不支持的 A2UI interaction status: {status}")

    @classmethod
    def _validate_resume_status(cls, status: str) -> None:
        if status not in A2UI_RESUME_STATUSES:
            raise ValueError(f"不支持的 A2UI resume_status: {status}")

    @staticmethod
    def _json_object_or_none(value: str | None, *, field_name: str) -> dict[str, Any] | None:
        if value is None or value == "":
            return None
        return _json_object_loads(value, field_name=field_name)

    @classmethod
    def _from_row(cls, row: sqlite3.Row) -> A2UIInteractionRecord:
        return A2UIInteractionRecord(
            id=row["id"],
            session_id=row["session_id"],
            trace_id=row["trace_id"],
            active_session_id=row["active_session_id"],
            turn_index=int(row["turn_index"]),
            tool_call_id=row["tool_call_id"],
            stream_id=row["stream_id"],
            render_key=row["render_key"],
            mode=row["mode"],
            payload=_json_object_loads(row["payload_json"], field_name="payload_json"),
            input_schema=_json_object_loads(
                row["input_schema_json"],
                field_name="input_schema_json",
            ),
            submit_schema_snapshot=_json_object_loads(
                row["submit_schema_snapshot_json"],
                field_name="submit_schema_snapshot_json",
            ),
            status=row["status"],
            submit_request_id=row["submit_request_id"],
            cancel_request_id=row["cancel_request_id"],
            submit_result=cls._json_object_or_none(
                row["submit_result_json"],
                field_name="submit_result_json",
            ),
            cancel_reason=row["cancel_reason"],
            langgraph_thread_id=row["langgraph_thread_id"],
            checkpoint_ns=row["checkpoint_ns"] or "",
            checkpoint_id=row["checkpoint_id"],
            interrupt_id=row["interrupt_id"],
            resume_group_id=row["resume_group_id"],
            resume_status=row["resume_status"],
            resume_payload=cls._json_object_or_none(
                row["resume_payload_json"],
                field_name="resume_payload_json",
            ),
            resume_error=row["resume_error"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            submitted_at=row["submitted_at"],
            cancelled_at=row["cancelled_at"],
            resume_started_at=row["resume_started_at"],
            resume_finished_at=row["resume_finished_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class PendingInputsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create_or_get(
        self,
        *,
        session_id: str,
        message: str,
        mode: str,
        client_input_id: str | None = None,
        user_id: str | None = None,
        scene_id: str | None = None,
        provider_id: str = "",
        model: str = "",
        runtime_params: dict[str, Any] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        target_turn_index: int | None = None,
        target_trace_id: str | None = None,
    ) -> tuple[PendingInputRecord, bool]:
        cleaned_session_id = session_id.strip()
        if not cleaned_session_id:
            raise ValueError("session_id 不能为空")
        cleaned_message = str(message or "").strip()
        if not cleaned_message and not attachments and not runtime_params:
            raise ValueError("pending input message 不能为空")
        cleaned_mode = self._validate_mode(mode)
        cleaned_client_input_id = str(client_input_id or "").strip() or None
        if cleaned_client_input_id:
            existing = self.get_by_client_input_id(
                cleaned_session_id,
                cleaned_client_input_id,
            )
            if existing is not None:
                return existing, False

        record_id = new_id()
        now = to_iso_z(utc_now())
        status = (
            PENDING_INPUT_STATUS_PENDING_STEER
            if cleaned_mode == PENDING_INPUT_MODE_STEER
            else PENDING_INPUT_STATUS_QUEUED
        )
        try:
            with self.db.transaction(immediate=True) as conn:
                queue_position = self._next_queue_position(conn, cleaned_session_id)
                conn.execute(
                    """
                    insert into session_pending_inputs (
                      id, session_id, client_input_id, mode, status, message,
                      provider_id, model, user_id, scene_id, runtime_params_json,
                      attachments_json, target_turn_index, target_trace_id,
                      queue_position, created_at, updated_at
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        record_id,
                        cleaned_session_id,
                        cleaned_client_input_id,
                        cleaned_mode,
                        status,
                        cleaned_message,
                        str(provider_id or ""),
                        str(model or ""),
                        user_id,
                        scene_id,
                        _json_dumps(runtime_params or {}),
                        _json_dumps(attachments or []),
                        target_turn_index,
                        target_trace_id,
                        queue_position,
                        now,
                        now,
                    ),
                )
        except sqlite3.IntegrityError:
            if cleaned_client_input_id:
                existing = self.get_by_client_input_id(
                    cleaned_session_id,
                    cleaned_client_input_id,
                )
                if existing is not None:
                    return existing, False
            raise
        record = self.get(record_id)
        if record is None:
            raise RuntimeError(f"创建 pending input 后无法读取: {record_id}")
        return record, True

    def get(
        self,
        pending_input_id: str,
        *,
        include_deleted: bool = False,
    ) -> PendingInputRecord | None:
        query = "select * from session_pending_inputs where id = ?"
        params: list[Any] = [pending_input_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def get_by_client_input_id(
        self,
        session_id: str,
        client_input_id: str,
        *,
        include_deleted: bool = False,
    ) -> PendingInputRecord | None:
        query = "select * from session_pending_inputs where session_id = ? and client_input_id = ?"
        params: list[Any] = [session_id, client_input_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by created_at desc, id desc limit 1"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_active_by_session(
        self,
        session_id: str,
        *,
        limit: int = 100,
    ) -> list[PendingInputRecord]:
        placeholders = ", ".join("?" for _ in PENDING_INPUT_ACTIVE_STATUSES)
        params: list[Any] = [
            session_id,
            *sorted(PENDING_INPUT_ACTIVE_STATUSES),
            max(1, min(limit, 500)),
        ]
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from session_pending_inputs
                where session_id = ?
                  and is_deleted = 0
                  and status in ({placeholders})
                order by queue_position asc, created_at asc, id asc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def has_active_queue(self, session_id: str) -> bool:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select 1 from session_pending_inputs
                where session_id = ?
                  and is_deleted = 0
                  and status in ('queued', 'starting', 'running')
                  and paused_at is null
                limit 1
                """,
                (session_id,),
            ).fetchone()
        return row is not None

    def claim_next_queued(
        self,
        session_id: str,
        *,
        lock_owner: str,
        lock_seconds: int = 60,
    ) -> PendingInputRecord | None:
        self.recover_expired_claims(session_id=session_id)
        lock_expires_at = to_iso_z(utc_now() + timedelta(seconds=max(1, lock_seconds)))
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                """
                select * from session_pending_inputs
                where session_id = ?
                  and is_deleted = 0
                  and status = 'queued'
                  and paused_at is null
                order by queue_position asc, created_at asc, id asc
                limit 1
                """,
                (session_id,),
            ).fetchone()
            if row is None:
                return None
            conn.execute(
                """
                update session_pending_inputs
                set status = ?, lock_owner = ?, lock_expires_at = ?, updated_at = ?
                where id = ? and status = 'queued' and is_deleted = 0
                """,
                (
                    PENDING_INPUT_STATUS_STARTING,
                    lock_owner,
                    lock_expires_at,
                    now,
                    row["id"],
                ),
            )
        return self.get(str(row["id"]))

    def recover_expired_claims(self, *, session_id: str | None = None) -> list[PendingInputRecord]:
        now = to_iso_z(utc_now())
        filters = [
            "is_deleted = 0",
            "status in ('starting', 'running')",
            "lock_expires_at is not null",
            "lock_expires_at <= ?",
        ]
        params: list[Any] = [now]
        if session_id is not None:
            filters.append("session_id = ?")
            params.append(session_id)
        with self.db.transaction(immediate=True) as conn:
            rows = conn.execute(
                f"""
                select id from session_pending_inputs
                where {" and ".join(filters)}
                order by queue_position asc, created_at asc, id asc
                """,
                params,
            ).fetchall()
            ids = [str(row["id"]) for row in rows]
            if not ids:
                return []
            placeholders = ", ".join("?" for _ in ids)
            conn.execute(
                f"""
                update session_pending_inputs
                set status = ?,
                    mode = ?,
                    lock_owner = null,
                    lock_expires_at = null,
                    updated_at = ?
                where id in ({placeholders})
                  and is_deleted = 0
                """,
                (
                    PENDING_INPUT_STATUS_QUEUED,
                    PENDING_INPUT_MODE_QUEUE,
                    now,
                    *ids,
                ),
            )
        return [record for record in (self.get(row_id) for row_id in ids) if record is not None]

    def claim_pending_steers(
        self,
        session_id: str,
        *,
        turn_index: int,
        trace_id: str,
        lock_owner: str,
        limit: int = 20,
    ) -> list[PendingInputRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            rows = conn.execute(
                """
                select * from session_pending_inputs
                where session_id = ?
                  and is_deleted = 0
                  and status = 'pending_steer'
                  and paused_at is null
                  and (
                    target_turn_index is null
                    or target_turn_index = ?
                  )
                order by queue_position asc, created_at asc, id asc
                limit ?
                """,
                (session_id, int(turn_index), max(1, min(limit, 100))),
            ).fetchall()
            ids = [str(row["id"]) for row in rows]
            if not ids:
                return []
            placeholders = ", ".join("?" for _ in ids)
            conn.execute(
                f"""
                update session_pending_inputs
                set status = ?,
                    target_turn_index = ?,
                    target_trace_id = ?,
                    delivered_at = ?,
                    lock_owner = ?,
                    lock_expires_at = null,
                    updated_at = ?
                where id in ({placeholders})
                  and status = 'pending_steer'
                  and is_deleted = 0
                """,
                (
                    PENDING_INPUT_STATUS_DELIVERED,
                    int(turn_index),
                    trace_id,
                    now,
                    lock_owner,
                    now,
                    *ids,
                ),
            )
        return [record for record in (self.get(row_id) for row_id in ids) if record is not None]

    def convert_pending_steers_to_queue(self, session_id: str) -> list[PendingInputRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            rows = conn.execute(
                """
                select id from session_pending_inputs
                where session_id = ?
                  and is_deleted = 0
                  and status = 'pending_steer'
                  and paused_at is null
                order by queue_position asc, created_at asc, id asc
                """,
                (session_id,),
            ).fetchall()
            ids = [str(row["id"]) for row in rows]
            if not ids:
                return []
            placeholders = ", ".join("?" for _ in ids)
            conn.execute(
                f"""
                update session_pending_inputs
                set mode = ?,
                    status = ?,
                    lock_owner = null,
                    lock_expires_at = null,
                    updated_at = ?
                where id in ({placeholders})
                  and status = 'pending_steer'
                  and paused_at is null
                  and is_deleted = 0
                """,
                (
                    PENDING_INPUT_MODE_QUEUE,
                    PENDING_INPUT_STATUS_QUEUED,
                    now,
                    *ids,
                ),
            )
        return [record for record in (self.get(row_id) for row_id in ids) if record is not None]

    def mark_delivered(
        self,
        pending_input_id: str,
        *,
        promoted_turn_index: int | None = None,
        promoted_trace_id: str | None = None,
    ) -> PendingInputRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                update session_pending_inputs
                set status = ?,
                    promoted_turn_index = coalesce(?, promoted_turn_index),
                    promoted_trace_id = coalesce(?, promoted_trace_id),
                    delivered_at = coalesce(delivered_at, ?),
                    lock_owner = null,
                    lock_expires_at = null,
                    paused_at = null,
                    pause_reason = null,
                    updated_at = ?
                where id = ?
                  and is_deleted = 0
                  and status in ('queued', 'starting', 'running')
                """,
                (
                    PENDING_INPUT_STATUS_DELIVERED,
                    promoted_turn_index,
                    promoted_trace_id,
                    now,
                    now,
                    pending_input_id,
                ),
            )
        return self.get(pending_input_id)

    def mark_failed(
        self,
        pending_input_id: str,
        *,
        error_code: str,
        error_message: str,
    ) -> PendingInputRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                update session_pending_inputs
                set status = ?,
                    error_code = ?,
                    error_message = ?,
                    lock_owner = null,
                    lock_expires_at = null,
                    updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (
                    PENDING_INPUT_STATUS_FAILED,
                    error_code,
                    error_message,
                    now,
                    pending_input_id,
                ),
            )
        return self.get(pending_input_id)

    def release_to_queue(self, pending_input_id: str) -> PendingInputRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            conn.execute(
                """
                update session_pending_inputs
                set status = ?,
                    mode = ?,
                    lock_owner = null,
                    lock_expires_at = null,
                    updated_at = ?
                where id = ?
                  and is_deleted = 0
                  and status in ('starting', 'running')
                """,
                (
                    PENDING_INPUT_STATUS_QUEUED,
                    PENDING_INPUT_MODE_QUEUE,
                    now,
                    pending_input_id,
                ),
            )
        return self.get(pending_input_id)

    def reorder_pending(
        self,
        session_id: str,
        pending_input_ids: list[str],
    ) -> list[PendingInputRecord] | None:
        cleaned_session_id = str(session_id or "").strip()
        cleaned_ids = [str(item or "").strip() for item in pending_input_ids]
        if not cleaned_session_id or not cleaned_ids or any(not item for item in cleaned_ids):
            raise ValueError("session_id 和 pending_input_ids 不能为空")
        if len(set(cleaned_ids)) != len(cleaned_ids):
            raise ValueError("pending_input_ids 不能包含重复项")

        placeholders = ", ".join("?" for _ in cleaned_ids)
        editable_statuses = sorted(PENDING_INPUT_EDITABLE_STATUSES)
        editable_placeholders = ", ".join("?" for _ in editable_statuses)
        active_statuses = sorted(PENDING_INPUT_ACTIVE_STATUSES)
        active_placeholders = ", ".join("?" for _ in active_statuses)
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            rows = conn.execute(
                f"""
                select id, queue_position
                from session_pending_inputs
                where session_id = ?
                  and id in ({placeholders})
                  and is_deleted = 0
                  and status in ({editable_placeholders})
                """,
                (cleaned_session_id, *cleaned_ids, *editable_statuses),
            ).fetchall()
            if len(rows) != len(cleaned_ids):
                return None

            positions = sorted(int(row["queue_position"] or 0) for row in rows)
            for pending_input_id, queue_position in zip(cleaned_ids, positions, strict=True):
                conn.execute(
                    """
                    update session_pending_inputs
                    set queue_position = ?, updated_at = ?
                    where id = ?
                      and session_id = ?
                      and is_deleted = 0
                      and status in ('pending_steer', 'queued')
                    """,
                    (queue_position, now, pending_input_id, cleaned_session_id),
                )

            reordered_rows = conn.execute(
                f"""
                select * from session_pending_inputs
                where session_id = ?
                  and is_deleted = 0
                  and status in ({active_placeholders})
                order by queue_position asc, created_at asc, id asc
                """,
                (cleaned_session_id, *active_statuses),
            ).fetchall()
        return [self._from_row(row) for row in reordered_rows]

    def update_pending(
        self,
        pending_input_id: str,
        *,
        message: str | None = None,
        mode: str | None = None,
        runtime_params: dict[str, Any] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        provider_id: str | None = None,
        model: str | None = None,
    ) -> PendingInputRecord | None:
        assignments: list[str] = []
        params: list[Any] = []
        if message is not None:
            cleaned = message.strip()
            if not cleaned and not attachments:
                raise ValueError("pending input message 不能为空")
            assignments.append("message = ?")
            params.append(cleaned)
        if mode is not None:
            cleaned_mode = self._validate_mode(mode)
            assignments.append("mode = ?")
            params.append(cleaned_mode)
            assignments.append("status = ?")
            params.append(
                PENDING_INPUT_STATUS_PENDING_STEER
                if cleaned_mode == PENDING_INPUT_MODE_STEER
                else PENDING_INPUT_STATUS_QUEUED
            )
        if runtime_params is not None:
            assignments.append("runtime_params_json = ?")
            params.append(_json_dumps(runtime_params))
        if attachments is not None:
            assignments.append("attachments_json = ?")
            params.append(_json_dumps(attachments))
        if provider_id is not None:
            assignments.append("provider_id = ?")
            params.append(provider_id)
        if model is not None:
            assignments.append("model = ?")
            params.append(model)
        if not assignments:
            return self.get(pending_input_id)
        assignments.append("updated_at = ?")
        params.append(to_iso_z(utc_now()))
        params.append(pending_input_id)
        params.extend(sorted(PENDING_INPUT_EDITABLE_STATUSES))
        placeholders = ", ".join("?" for _ in PENDING_INPUT_EDITABLE_STATUSES)
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                f"""
                update session_pending_inputs
                set {', '.join(assignments)}
                where id = ?
                  and is_deleted = 0
                  and status in ({placeholders})
                """,
                params,
            )
            if cursor.rowcount <= 0:
                return None
        return self.get(pending_input_id)

    def cancel(
        self,
        pending_input_id: str,
        *,
        reason: str | None = None,
    ) -> PendingInputRecord | None:
        now = to_iso_z(utc_now())
        placeholders = ", ".join("?" for _ in PENDING_INPUT_EDITABLE_STATUSES)
        params: list[Any] = [
            PENDING_INPUT_STATUS_CANCELLED,
            reason,
            now,
            now,
            pending_input_id,
            *sorted(PENDING_INPUT_EDITABLE_STATUSES),
        ]
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                f"""
                update session_pending_inputs
                set status = ?,
                    error_message = ?,
                    cancelled_at = ?,
                    lock_owner = null,
                    lock_expires_at = null,
                    updated_at = ?
                where id = ?
                  and is_deleted = 0
                  and status in ({placeholders})
                """,
                params,
            )
            if cursor.rowcount <= 0:
                return None
        return self.get(pending_input_id)

    def pause_active_for_session(
        self,
        session_id: str,
        *,
        reason: str = "user_stopped",
    ) -> list[PendingInputRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            rows = conn.execute(
                """
                select id from session_pending_inputs
                where session_id = ?
                  and is_deleted = 0
                  and status in ('pending_steer', 'queued')
                  and paused_at is null
                order by queue_position asc, created_at asc, id asc
                """,
                (session_id,),
            ).fetchall()
            ids = [str(row["id"]) for row in rows]
            if not ids:
                return []
            placeholders = ", ".join("?" for _ in ids)
            conn.execute(
                f"""
                update session_pending_inputs
                set paused_at = ?, pause_reason = ?, updated_at = ?
                where id in ({placeholders})
                  and is_deleted = 0
                  and status in ('pending_steer', 'queued')
                """,
                (now, str(reason or "user_stopped"), now, *ids),
            )
        return [record for record in (self.get(row_id) for row_id in ids) if record is not None]

    def resume_paused(
        self,
        session_id: str,
        *,
        pending_input_id: str | None = None,
        mode: str | None = None,
    ) -> list[PendingInputRecord]:
        cleaned_id = str(pending_input_id or "").strip()
        cleaned_mode = self._validate_mode(mode) if mode is not None else None
        filters = [
            "session_id = ?",
            "is_deleted = 0",
            "status in ('pending_steer', 'queued')",
            "paused_at is not null",
        ]
        params: list[Any] = [session_id]
        if cleaned_id:
            filters.append("id = ?")
            params.append(cleaned_id)
        if cleaned_mode:
            filters.append("mode = ?")
            params.append(cleaned_mode)
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            rows = conn.execute(
                f"""
                select id from session_pending_inputs
                where {' and '.join(filters)}
                order by queue_position asc, created_at asc, id asc
                """,
                params,
            ).fetchall()
            ids = [str(row["id"]) for row in rows]
            if not ids:
                return []
            placeholders = ", ".join("?" for _ in ids)
            conn.execute(
                f"""
                update session_pending_inputs
                set paused_at = null, pause_reason = null, updated_at = ?
                where id in ({placeholders})
                  and is_deleted = 0
                  and status in ('pending_steer', 'queued')
                """,
                (now, *ids),
            )
        return [record for record in (self.get(row_id) for row_id in ids) if record is not None]

    def resume_steers_as_new_turn(
        self,
        session_id: str,
        *,
        pending_input_id: str | None = None,
    ) -> list[PendingInputRecord]:
        """Resume paused steer inputs while idle by promoting one to start a new turn.

        The remaining steers stay as steer inputs and are claimed together before the
        first model request of the promoted turn.
        """
        cleaned_id = str(pending_input_id or "").strip()
        filters = [
            "session_id = ?",
            "is_deleted = 0",
            "status = 'pending_steer'",
            "mode = 'steer'",
            "paused_at is not null",
        ]
        params: list[Any] = [session_id]
        if cleaned_id:
            filters.append("id = ?")
            params.append(cleaned_id)
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            rows = conn.execute(
                f"""
                select id from session_pending_inputs
                where {' and '.join(filters)}
                order by queue_position asc, created_at asc, id asc
                """,
                params,
            ).fetchall()
            ids = [str(row["id"]) for row in rows]
            if not ids:
                return []
            placeholders = ", ".join("?" for _ in ids)
            conn.execute(
                f"""
                update session_pending_inputs
                set paused_at = null, pause_reason = null, updated_at = ?
                where id in ({placeholders})
                  and is_deleted = 0
                  and status = 'pending_steer'
                """,
                (now, *ids),
            )
            conn.execute(
                """
                update session_pending_inputs
                set mode = ?, status = ?, updated_at = ?
                where id = ?
                  and is_deleted = 0
                  and status = 'pending_steer'
                """,
                (PENDING_INPUT_MODE_QUEUE, PENDING_INPUT_STATUS_QUEUED, now, ids[0]),
            )
        return [record for record in (self.get(row_id) for row_id in ids) if record is not None]

    @staticmethod
    def _validate_mode(mode: str) -> str:
        cleaned = str(mode or "").strip() or PENDING_INPUT_MODE_STEER
        if cleaned not in PENDING_INPUT_MODES:
            raise ValueError(f"不支持的 pending input mode: {cleaned}")
        return cleaned

    @staticmethod
    def _validate_status(status: str) -> str:
        cleaned = str(status or "").strip()
        if cleaned not in PENDING_INPUT_STATUSES:
            raise ValueError(f"不支持的 pending input status: {cleaned}")
        return cleaned

    @staticmethod
    def _next_queue_position(conn: sqlite3.Connection, session_id: str) -> int:
        row = conn.execute(
            """
            select coalesce(max(queue_position), 0) as max_position
            from session_pending_inputs
            where session_id = ? and is_deleted = 0
            """,
            (session_id,),
        ).fetchone()
        return int(row["max_position"] if row else 0) + 1

    @staticmethod
    def _from_row(row: sqlite3.Row) -> PendingInputRecord:
        runtime_params = _json_loads(row["runtime_params_json"], {})
        attachments = _json_loads(row["attachments_json"], [])
        if not isinstance(runtime_params, dict):
            runtime_params = {}
        if not isinstance(attachments, list):
            attachments = []
        return PendingInputRecord(
            id=row["id"],
            session_id=row["session_id"],
            client_input_id=row["client_input_id"],
            mode=row["mode"],
            status=row["status"],
            message=row["message"],
            provider_id=row["provider_id"] or "",
            model=row["model"] or "",
            user_id=row["user_id"],
            scene_id=row["scene_id"],
            runtime_params=runtime_params,
            attachments=[item for item in attachments if isinstance(item, dict)],
            target_turn_index=(
                int(row["target_turn_index"]) if row["target_turn_index"] is not None else None
            ),
            target_trace_id=row["target_trace_id"],
            promoted_turn_index=(
                int(row["promoted_turn_index"])
                if row["promoted_turn_index"] is not None
                else None
            ),
            promoted_trace_id=row["promoted_trace_id"],
            queue_position=int(row["queue_position"] or 0),
            lock_owner=row["lock_owner"],
            lock_expires_at=row["lock_expires_at"],
            error_code=row["error_code"],
            error_message=row["error_message"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            delivered_at=row["delivered_at"],
            cancelled_at=row["cancelled_at"],
            paused_at=row["paused_at"],
            pause_reason=row["pause_reason"],
            is_deleted=bool(row["is_deleted"]),
        )


class MessageEventsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def append(
        self,
        *,
        event_id: str,
        session_id: str,
        turn_index: int,
        action: str,
        data: dict[str, Any] | None = None,
        trace_record_id: str | None = None,
    ) -> MessageEventRecord:
        return self.append_many(
            session_id=session_id,
            events=[
                {
                    "event_id": event_id,
                    "trace_record_id": trace_record_id,
                    "turn_index": turn_index,
                    "action": action,
                    "data": data or {},
                }
            ],
        )[0]

    def append_many(
        self,
        *,
        session_id: str,
        events: list[dict[str, Any]],
    ) -> list[MessageEventRecord]:
        if not events:
            return []
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                """
                select coalesce(max(seq), 0) as max_seq
                from message_events
                where session_id = ? and is_deleted = 0
                """,
                (session_id,),
            ).fetchone()
            first_seq = int(row["max_seq"]) + 1
            records: list[MessageEventRecord] = []
            rows: list[tuple[Any, ...]] = []
            for offset, event in enumerate(events):
                event_id = str(event["event_id"])
                trace_record_id = event.get("trace_record_id")
                turn_index = int(event["turn_index"])
                action = str(event["action"])
                data = event.get("data") or {}
                if not isinstance(data, dict):
                    raise ValueError("message event data 必须是 JSON 对象")
                seq = first_seq + offset
                copied_data = dict(data)
                rows.append(
                    (
                        event_id,
                        session_id,
                        trace_record_id,
                        seq,
                        turn_index,
                        action,
                        _json_dumps(copied_data),
                        now,
                        now,
                    )
                )
                records.append(
                    MessageEventRecord(
                        id=event_id,
                        session_id=session_id,
                        trace_record_id=trace_record_id,
                        seq=seq,
                        turn_index=turn_index,
                        action=action,
                        data=copied_data,
                        created_at=now,
                        updated_at=now,
                    )
                )
            conn.executemany(
                """
                insert into message_events (
                  id, session_id, trace_record_id, seq, turn_index, action,
                  data_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )
        return records

    def get(self, event_id: str, *, include_deleted: bool = False) -> MessageEventRecord | None:
        query = "select * from message_events where id = ?"
        params: list[Any] = [event_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_by_session(
        self,
        session_id: str,
        *,
        include_deleted: bool = False,
        limit: int | None = 1000,
        through_turn_index: int | None = None,
    ) -> list[MessageEventRecord]:
        query = "select * from message_events where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        if through_turn_index is not None:
            query += " and turn_index <= ?"
            params.append(int(through_turn_index))
        query += " order by seq asc"
        if limit is not None:
            query += " limit ?"
            params.append(max(1, min(limit, 5000)))
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._from_row(row) for row in rows]

    def count_by_session(self, session_id: str, *, include_deleted: bool = False) -> int:
        query = "select count(*) as count from message_events where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return int(row["count"] if row else 0)

    def count_turns(self, session_id: str, *, include_deleted: bool = False) -> int:
        query = (
            "select count(distinct turn_index) as count from message_events where session_id = ?"
        )
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return int(row["count"] if row else 0)

    def soft_delete_from_turn(self, session_id: str, turn_index: int) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update message_events
                set is_deleted = 1, updated_at = ?
                where session_id = ?
                  and turn_index >= ?
                  and is_deleted = 0
                """,
                (now, session_id, int(turn_index)),
            )
        return int(cursor.rowcount)

    def delete_from_turn(self, session_id: str, turn_index: int) -> int:
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                delete from message_events
                where session_id = ?
                  and turn_index >= ?
                """,
                (session_id, int(turn_index)),
            )
        return int(cursor.rowcount)

    def list_turn_indexes(
        self,
        session_id: str,
        *,
        cursor_turn_index: int | None = None,
        direction: str = "older",
        limit: int | None = 5,
        offset: int = 0,
        include_deleted: bool = False,
    ) -> list[int]:
        query = "select turn_index from message_events where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        if cursor_turn_index is not None:
            if direction == "newer":
                query += " and turn_index > ?"
            else:
                query += " and turn_index < ?"
            params.append(cursor_turn_index)
        order = "asc" if direction == "newer" else "desc"
        query += f" group by turn_index order by turn_index {order}"
        if limit is not None:
            query += " limit ? offset ?"
            params.extend([max(1, min(limit, 101)), max(0, offset)])
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [int(row["turn_index"]) for row in rows]

    def list_by_turn(
        self,
        session_id: str,
        turn_index: int,
        *,
        include_deleted: bool = False,
    ) -> list[MessageEventRecord]:
        query = "select * from message_events where session_id = ? and turn_index = ?"
        params: list[Any] = [session_id, turn_index]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by seq asc"
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._from_row(row) for row in rows]

    def get_max_seq_and_turn(self, session_id: str) -> tuple[int, int]:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select
                  coalesce(max(seq), 0) as max_seq,
                  coalesce(max(turn_index), 0) as max_turn
                from message_events
                where session_id = ? and is_deleted = 0
                """,
                (session_id,),
            ).fetchone()
        return int(row["max_seq"]), int(row["max_turn"])

    @staticmethod
    def _from_row(row: sqlite3.Row) -> MessageEventRecord:
        return MessageEventRecord(
            id=row["id"],
            session_id=row["session_id"],
            trace_record_id=row["trace_record_id"],
            seq=int(row["seq"]),
            turn_index=int(row["turn_index"]),
            action=row["action"],
            data=_json_loads(row["data_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class ThreadTasksRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        session_id: str,
        type: str,
        objective: str,
        task_id: str | None = None,
        title: str | None = None,
        status: str = THREAD_TASK_STATUS_ACTIVE,
        metadata: dict[str, Any] | None = None,
        evidence: list[Any] | None = None,
        blocked_audit: dict[str, Any] | None = None,
        system_stop_reason: str | None = None,
        current_run_id: str | None = None,
        turn_count: int = 0,
        elapsed_seconds: int = 0,
        token_usage: dict[str, Any] | None = None,
    ) -> ThreadTaskRecord:
        self._validate_type(type)
        self._validate_status(status)
        resolved_task_id = task_id or new_id()
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into thread_tasks (
                  id, session_id, type, title, objective, status,
                  metadata_json, evidence_json, blocked_audit_json,
                  system_stop_reason, current_run_id, turn_count,
                  elapsed_seconds, token_usage_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    resolved_task_id,
                    session_id,
                    type,
                    title,
                    objective,
                    status,
                    _json_dumps(metadata or {}),
                    _json_dumps(evidence or []),
                    _json_dumps(blocked_audit or {}),
                    system_stop_reason,
                    current_run_id,
                    int(turn_count),
                    int(elapsed_seconds),
                    _json_dumps(token_usage or {}),
                    now,
                    now,
                ),
            )
        record = self.get(resolved_task_id)
        if record is None:
            raise RuntimeError(f"创建 thread task 后无法读取: {resolved_task_id}")
        return record

    def get(self, task_id: str, *, include_deleted: bool = False) -> ThreadTaskRecord | None:
        query = "select * from thread_tasks where id = ?"
        params: list[Any] = [task_id]
        if not include_deleted:
            query += " and deleted_at is null"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return ThreadTaskRecord.from_row(row) if row else None

    def list_by_session(
        self,
        session_id: str,
        *,
        include_deleted: bool = False,
        limit: int = 100,
    ) -> list[ThreadTaskRecord]:
        query = "select * from thread_tasks where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and deleted_at is null"
        query += " order by updated_at desc, created_at desc, id desc limit ?"
        params.append(max(1, min(limit, 500)))
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [ThreadTaskRecord.from_row(row) for row in rows]

    def get_open_by_session(self, session_id: str) -> ThreadTaskRecord | None:
        placeholders = ", ".join("?" for _ in THREAD_TASK_OPEN_STATUSES)
        params: list[Any] = [session_id, *sorted(THREAD_TASK_OPEN_STATUSES)]
        with self.db.connect() as conn:
            row = conn.execute(
                f"""
                select * from thread_tasks
                where session_id = ?
                  and deleted_at is null
                  and status in ({placeholders})
                order by updated_at desc, created_at desc, id desc
                limit 1
                """,
                params,
            ).fetchone()
        return ThreadTaskRecord.from_row(row) if row else None

    def list_by_status(
        self,
        status: str,
        *,
        include_deleted: bool = False,
        limit: int = 500,
    ) -> list[ThreadTaskRecord]:
        self._validate_status(status)
        query = "select * from thread_tasks where status = ?"
        params: list[Any] = [status]
        if not include_deleted:
            query += " and deleted_at is null"
        query += " order by updated_at desc, created_at desc, id desc limit ?"
        params.append(max(1, min(limit, 1000)))
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [ThreadTaskRecord.from_row(row) for row in rows]

    def update(
        self,
        task_id: str,
        *,
        title: str | None | object = _UNSET,
        objective: str | None = None,
        status: str | None = None,
        metadata: dict[str, Any] | None = None,
        evidence: list[Any] | None = None,
        blocked_audit: dict[str, Any] | None = None,
        system_stop_reason: str | None | object = _UNSET,
        current_run_id: str | None | object = _UNSET,
        turn_count: int | None = None,
        elapsed_seconds: int | None = None,
        token_usage: dict[str, Any] | None = None,
        deleted_at: str | None | object = _UNSET,
    ) -> ThreadTaskRecord | None:
        assignments: list[str] = []
        params: list[Any] = []
        if title is not _UNSET:
            assignments.append("title = ?")
            params.append(title)
        if objective is not None:
            assignments.append("objective = ?")
            params.append(objective)
        if status is not None:
            self._validate_status(status)
            assignments.append("status = ?")
            params.append(status)
        if metadata is not None:
            assignments.append("metadata_json = ?")
            params.append(_json_dumps(metadata))
        if evidence is not None:
            assignments.append("evidence_json = ?")
            params.append(_json_dumps(evidence))
        if blocked_audit is not None:
            assignments.append("blocked_audit_json = ?")
            params.append(_json_dumps(blocked_audit))
        if system_stop_reason is not _UNSET:
            assignments.append("system_stop_reason = ?")
            params.append(system_stop_reason)
        if current_run_id is not _UNSET:
            assignments.append("current_run_id = ?")
            params.append(current_run_id)
        if turn_count is not None:
            assignments.append("turn_count = ?")
            params.append(int(turn_count))
        if elapsed_seconds is not None:
            assignments.append("elapsed_seconds = ?")
            params.append(int(elapsed_seconds))
        if token_usage is not None:
            assignments.append("token_usage_json = ?")
            params.append(_json_dumps(token_usage))
        if deleted_at is not _UNSET:
            assignments.append("deleted_at = ?")
            params.append(deleted_at)
        if not assignments:
            return self.get(task_id)

        assignments.append("updated_at = ?")
        params.append(to_iso_z(utc_now()))
        params.append(task_id)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"""
                update thread_tasks
                set {', '.join(assignments)}
                where id = ?
                """,
                params,
            )
        if cursor.rowcount == 0:
            return None
        return self.get(task_id, include_deleted=True)

    def soft_delete(self, task_id: str) -> ThreadTaskRecord | None:
        deleted_at = to_iso_z(utc_now())
        return self.update(task_id, deleted_at=deleted_at)

    @classmethod
    def _validate_type(cls, type: str) -> None:
        if (
            not type
            or len(type) > THREAD_TASK_TYPE_MAX_CHARS
            or THREAD_TASK_TYPE_PATTERN.fullmatch(type) is None
        ):
            raise ValueError(f"不支持的 thread task 类型: {type}")

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in THREAD_TASK_STATUSES:
            raise ValueError(f"不支持的 thread task 状态: {status}")


class ThreadTaskRunsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create_running(
        self,
        *,
        task_id: str,
        session_id: str,
        run_id: str | None = None,
        turn_index: int | None = None,
        trace_id: str | None = None,
        summary: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
    ) -> ThreadTaskRunRecord:
        resolved_run_id = run_id or new_id()
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into thread_task_runs (
                  id, task_id, session_id, turn_index, trace_id, status,
                  summary_json, error_json, started_at, created_at, updated_at
                ) values (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
                """,
                (
                    resolved_run_id,
                    task_id,
                    session_id,
                    turn_index,
                    trace_id,
                    _json_dumps(summary or {}),
                    _json_dumps(error or {}),
                    now,
                    now,
                    now,
                ),
            )
        record = self.get(resolved_run_id)
        if record is None:
            raise RuntimeError(f"创建 thread task run 后无法读取: {resolved_run_id}")
        return record

    def get(self, run_id: str) -> ThreadTaskRunRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from thread_task_runs where id = ?",
                (run_id,),
            ).fetchone()
        return ThreadTaskRunRecord.from_row(row) if row else None

    def list_by_task(self, task_id: str, *, limit: int = 100) -> list[ThreadTaskRunRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from thread_task_runs
                where task_id = ?
                order by started_at desc, created_at desc, id desc
                limit ?
                """,
                (task_id, max(1, min(limit, 500))),
            ).fetchall()
        return [ThreadTaskRunRecord.from_row(row) for row in rows]

    def get_running_by_task(self, task_id: str) -> ThreadTaskRunRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from thread_task_runs
                where task_id = ? and status = ?
                order by started_at desc, created_at desc, id desc
                limit 1
                """,
                (task_id, THREAD_TASK_RUN_STATUS_RUNNING),
            ).fetchone()
        return ThreadTaskRunRecord.from_row(row) if row else None

    def attach_turn(
        self,
        run_id: str,
        *,
        turn_index: int,
        trace_id: str | None = None,
    ) -> ThreadTaskRunRecord | None:
        assignments = ["turn_index = ?", "updated_at = ?"]
        params: list[Any] = [int(turn_index), to_iso_z(utc_now())]
        if trace_id is not None:
            assignments.insert(1, "trace_id = ?")
            params.insert(1, trace_id)
        params.append(run_id)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"update thread_task_runs set {', '.join(assignments)} where id = ?",
                params,
            )
        if cursor.rowcount == 0:
            return None
        return self.get(run_id)

    def finish(
        self,
        run_id: str,
        *,
        status: str,
        summary: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
    ) -> ThreadTaskRunRecord | None:
        self._validate_finish_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update thread_task_runs
                set status = ?,
                    summary_json = ?,
                    error_json = ?,
                    finished_at = ?,
                    updated_at = ?
                where id = ?
                """,
                (
                    status,
                    _json_dumps(summary or {}),
                    _json_dumps(error or {}),
                    now,
                    now,
                    run_id,
                ),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(run_id)

    @classmethod
    def _validate_finish_status(cls, status: str) -> None:
        if status == THREAD_TASK_RUN_STATUS_RUNNING or status not in THREAD_TASK_RUN_STATUSES:
            raise ValueError(f"不支持的 thread task run 完成状态: {status}")


class CompressionStagingRepository:
    """压缩暂存记录仓储。

    后台压缩先把 L1/L2 和锚点写入 pending 记录，再切换活动会话；
    下一次模型调用前由中间件按 target_session_id 消费并标记 applied。
    """

    VALID_STATUSES = {"pending", "applied", "superseded", "failed"}
    VALID_STAGING_STRATEGIES = {"anchor_replacement", "full_replacement"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
        target_session_id: str,
        generation: int,
        anchor_message_id: str | None = None,
        source_last_message_id: str | None = None,
        l1_content: str | None = None,
        l2_content: str | None = None,
        staging_strategy: str = "anchor_replacement",
    ) -> CompressionStagingRecord:
        if generation < 1:
            raise ValueError("压缩暂存 generation 必须大于等于 1")
        self._validate_staging_strategy(staging_strategy)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                insert into compression_staging (
                  original_session_id, active_session_id, target_session_id,
                  generation, status, staging_strategy, anchor_message_id,
                  source_last_message_id, l1_content, l2_content,
                  created_at, updated_at
                ) values (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    original_session_id,
                    active_session_id,
                    target_session_id,
                    generation,
                    staging_strategy,
                    anchor_message_id,
                    source_last_message_id,
                    l1_content,
                    l2_content,
                    now,
                    now,
                ),
            )
            row_id = int(cursor.lastrowid)
        record = self.get(row_id)
        if record is None:
            raise RuntimeError(f"创建压缩暂存记录后无法读取: {row_id}")
        return record

    def create_with_latest_priority(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
        target_session_id: str,
        generation: int,
        anchor_message_id: str | None = None,
        source_last_message_id: str | None = None,
        l1_content: str | None = None,
        l2_content: str | None = None,
        staging_strategy: str = "anchor_replacement",
    ) -> CompressionStagingRecord:
        if generation < 1:
            raise ValueError("压缩暂存 generation 必须大于等于 1")
        self._validate_staging_strategy(staging_strategy)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update compression_staging
                set status = 'superseded',
                    failure_reason = 'superseded_by_newer_generation',
                    updated_at = ?
                where original_session_id = ?
                  and generation < ?
                  and status in ('pending', 'applied')
                  and is_deleted = 0
                """,
                (now, original_session_id, generation),
            )
        return self.create(
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            target_session_id=target_session_id,
            generation=generation,
            anchor_message_id=anchor_message_id,
            source_last_message_id=source_last_message_id,
            l1_content=l1_content,
            l2_content=l2_content,
            staging_strategy=staging_strategy,
        )

    def get(
        self, staging_id: int, *, include_deleted: bool = False
    ) -> CompressionStagingRecord | None:
        query = "select * from compression_staging where id = ?"
        params: list[Any] = [staging_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def get_latest(
        self,
        *,
        original_session_id: str,
        status: str | None = None,
        target_session_id: str | None = None,
        include_deleted: bool = False,
    ) -> CompressionStagingRecord | None:
        filters = ["original_session_id = ?"]
        params: list[Any] = [original_session_id]
        if status is not None:
            self._validate_status(status)
            filters.append("status = ?")
            params.append(status)
        if target_session_id is not None:
            filters.append("target_session_id = ?")
            params.append(target_session_id)
        if not include_deleted:
            filters.append("is_deleted = 0")
        where = " and ".join(filters)
        with self.db.connect() as conn:
            row = conn.execute(
                f"""
                select * from compression_staging
                where {where}
                order by generation desc, id desc
                limit 1
                """,
                params,
            ).fetchone()
        return self._from_row(row) if row else None

    def next_generation(self, original_session_id: str) -> int:
        latest = self.get_latest(original_session_id=original_session_id, include_deleted=True)
        return (latest.generation + 1) if latest is not None else 1

    def mark_status(
        self,
        staging_id: int,
        *,
        status: str,
        failure_reason: str | None = None,
    ) -> CompressionStagingRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        applied_at = now if status == "applied" else None
        with self.db.transaction() as conn:
            conn.execute(
                """
                update compression_staging
                set status = ?,
                    failure_reason = ?,
                    applied_at = coalesce(?, applied_at),
                    updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (status, failure_reason, applied_at, now, staging_id),
            )
        return self.get(staging_id)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的压缩暂存状态: {status}")

    @classmethod
    def _validate_staging_strategy(cls, strategy: str) -> None:
        if strategy not in cls.VALID_STAGING_STRATEGIES:
            raise ValueError(f"不支持的压缩暂存策略: {strategy}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> CompressionStagingRecord:
        return CompressionStagingRecord(
            id=int(row["id"]),
            original_session_id=row["original_session_id"],
            active_session_id=row["active_session_id"],
            target_session_id=row["target_session_id"],
            generation=int(row["generation"]),
            status=row["status"],
            staging_strategy=row["staging_strategy"],
            anchor_message_id=row["anchor_message_id"],
            source_last_message_id=row["source_last_message_id"],
            l1_content=row["l1_content"],
            l2_content=row["l2_content"],
            failure_reason=row["failure_reason"],
            applied_at=row["applied_at"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class TraceRecordsRepository:
    VALID_STATUSES = {"running", "completed", "failed", "cancelled", "waiting_input"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        trace_id: str,
        session_id: str,
        scene_id: str,
        user_id: str,
        turn_index: int,
        root_node_id: str,
        active_session_id: str | None = None,
        scene_name: str | None = None,
        scene_version_seq: int | None = None,
        user_message_preview: str | None = None,
        input_checkpoint_id: str | None = None,
        input_checkpoint_ns: str | None = None,
        metadata: dict[str, Any] | None = None,
        status: str = "running",
    ) -> TraceRecord:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into trace_record (
                  trace_id, session_id, active_session_id, scene_id, scene_name,
                  scene_version_seq, user_id, turn_index, root_node_id, status,
                  start_time, user_message_preview, input_checkpoint_id,
                  input_checkpoint_ns, metadata_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trace_id,
                    session_id,
                    active_session_id,
                    scene_id,
                    scene_name,
                    scene_version_seq,
                    user_id,
                    turn_index,
                    root_node_id,
                    status,
                    now,
                    user_message_preview,
                    input_checkpoint_id,
                    input_checkpoint_ns,
                    _json_dumps(metadata or {}),
                    now,
                    now,
                ),
            )
        record = self.get(trace_id)
        if record is None:
            raise RuntimeError(f"创建 trace_record 后无法读取: {trace_id}")
        return record

    def get(self, trace_id: str, *, include_deleted: bool = False) -> TraceRecord | None:
        query = "select * from trace_record where trace_id = ?"
        params: list[Any] = [trace_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def set_input_file_snapshot(
        self,
        trace_id: str,
        *,
        snapshot_id: str | None,
        status: str,
    ) -> TraceRecord | None:
        with self.db.transaction() as conn:
            conn.execute(
                """
                update trace_record
                   set input_file_snapshot_id = ?, input_file_snapshot_status = ?,
                       updated_at = ?
                 where trace_id = ? and is_deleted = 0
                """,
                (snapshot_id, status, to_iso_z(utc_now()), trace_id),
            )
        return self.get(trace_id)

    def list_by_session(self, session_id: str) -> list[TraceRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from trace_record
                where session_id = ? and is_deleted = 0
                order by turn_index asc, created_at asc
                """,
                (session_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def soft_delete_from_turn(self, session_id: str, turn_index: int) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update trace_record
                set is_deleted = 1, updated_at = ?
                where session_id = ?
                  and turn_index >= ?
                  and is_deleted = 0
                """,
                (now, session_id, int(turn_index)),
            )
        return int(cursor.rowcount)

    def finish(
        self,
        trace_id: str,
        *,
        status: str,
        duration_ms: int | None = None,
        total_input_tokens: int = 0,
        total_output_tokens: int = 0,
        total_cache_read_tokens: int = 0,
        output_checkpoint_id: str | None = None,
        output_checkpoint_ns: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> TraceRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        total_tokens = total_input_tokens + total_output_tokens
        with self.db.transaction() as conn:
            conn.execute(
                """
                update trace_record set
                  status = ?,
                  end_time = ?,
                  duration_ms = ?,
                  total_input_tokens = ?,
                  total_output_tokens = ?,
                  total_tokens = ?,
                  total_cache_read_tokens = ?,
                  output_checkpoint_id = ?,
                  output_checkpoint_ns = ?,
                  metadata_json = coalesce(?, metadata_json),
                  updated_at = ?
                where trace_id = ? and is_deleted = 0
                """,
                (
                    status,
                    now,
                    duration_ms,
                    total_input_tokens,
                    total_output_tokens,
                    total_tokens,
                    total_cache_read_tokens,
                    output_checkpoint_id,
                    output_checkpoint_ns,
                    None if metadata is None else _json_dumps(metadata),
                    now,
                    trace_id,
                ),
            )
        return self.get(trace_id)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 trace 状态: {status}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> TraceRecord:
        return TraceRecord(
            trace_id=row["trace_id"],
            session_id=row["session_id"],
            active_session_id=row["active_session_id"],
            scene_id=row["scene_id"],
            scene_name=row["scene_name"],
            scene_version_seq=row["scene_version_seq"],
            user_id=row["user_id"],
            turn_index=int(row["turn_index"]),
            root_node_id=row["root_node_id"],
            status=row["status"],
            start_time=row["start_time"],
            end_time=row["end_time"],
            duration_ms=row["duration_ms"],
            total_input_tokens=int(row["total_input_tokens"]),
            total_output_tokens=int(row["total_output_tokens"]),
            total_tokens=int(row["total_tokens"]),
            total_cache_read_tokens=int(row["total_cache_read_tokens"]),
            user_message_preview=row["user_message_preview"],
            input_checkpoint_id=row["input_checkpoint_id"],
            input_checkpoint_ns=row["input_checkpoint_ns"],
            input_file_snapshot_id=row["input_file_snapshot_id"],
            input_file_snapshot_status=row["input_file_snapshot_status"],
            output_checkpoint_id=row["output_checkpoint_id"],
            output_checkpoint_ns=row["output_checkpoint_ns"],
            metadata=_json_loads(row["metadata_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class TraceEventLogsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def append(
        self,
        *,
        trace_id: str,
        trace_record_id: str,
        event_type: str,
        source: str,
        idempotency_key: str,
        timestamp_ms: int,
        payload: dict[str, Any],
        occurred_at: str | None = None,
        node_id: str | None = None,
        parent_node_id: str | None = None,
        root_node_id: str | None = None,
        sequence_no: int | None = None,
        run_id: str | None = None,
        turn_index: int | None = None,
        user_id: str | None = None,
        original_session_id: str | None = None,
        active_session_id: str | None = None,
        tags: dict[str, Any] | None = None,
    ) -> TraceEventLogRecord:
        now = to_iso_z(utc_now())
        resolved_occurred_at = occurred_at or now
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                insert into trace_event_log (
                  trace_id, trace_record_id, event_type, source, idempotency_key,
                  node_id, parent_node_id, root_node_id, sequence_no, run_id,
                  turn_index, user_id, original_session_id, active_session_id,
                  timestamp_ms, occurred_at, tags_json, payload_json,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trace_id,
                    trace_record_id,
                    event_type,
                    source,
                    idempotency_key,
                    node_id,
                    parent_node_id,
                    root_node_id,
                    sequence_no,
                    run_id,
                    turn_index,
                    user_id,
                    original_session_id,
                    active_session_id,
                    timestamp_ms,
                    resolved_occurred_at,
                    _json_dumps(tags or {}),
                    _json_dumps(payload),
                    now,
                    now,
                ),
            )
            row_id = int(cursor.lastrowid)
        record = self.get(row_id)
        if record is None:
            raise RuntimeError(f"追加 trace_event_log 后无法读取: {row_id}")
        return record

    def get(self, row_id: int) -> TraceEventLogRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from trace_event_log where id = ?",
                (row_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_by_trace_record(self, trace_record_id: str) -> list[TraceEventLogRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from trace_event_log
                where trace_record_id = ?
                order by sequence_no asc, id asc
                """,
                (trace_record_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    @staticmethod
    def _from_row(row: sqlite3.Row) -> TraceEventLogRecord:
        return TraceEventLogRecord(
            id=int(row["id"]),
            trace_id=row["trace_id"],
            trace_record_id=row["trace_record_id"],
            event_type=row["event_type"],
            source=row["source"],
            idempotency_key=row["idempotency_key"],
            node_id=row["node_id"],
            parent_node_id=row["parent_node_id"],
            root_node_id=row["root_node_id"],
            sequence_no=row["sequence_no"],
            run_id=row["run_id"],
            turn_index=row["turn_index"],
            user_id=row["user_id"],
            original_session_id=row["original_session_id"],
            active_session_id=row["active_session_id"],
            timestamp_ms=int(row["timestamp_ms"]),
            occurred_at=row["occurred_at"],
            tags=_json_loads(row["tags_json"], {}),
            payload=_json_loads(row["payload_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class LLMRequestLogsRepository:
    VALID_STATUSES = {"running", "completed", "failed", "cancelled"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def start(
        self,
        *,
        request_id: str,
        trace_id: str,
        trace_record_id: str,
        session_id: str,
        model: str,
        active_session_id: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
        turn_index: int | None = None,
        provider_id: str | None = None,
        provider_name: str | None = None,
        request_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        start_time: str | None = None,
    ) -> LLMRequestLogRecord:
        now = to_iso_z(utc_now())
        resolved_start_time = start_time or now
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into llm_request_logs (
                  id, trace_id, trace_record_id, session_id, active_session_id,
                  gateway_thread_id, gateway_trace_id, turn_index,
                  provider_id, provider_name, model, status,
                  start_time, request_preview, metadata_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request_id,
                    trace_id,
                    trace_record_id,
                    session_id,
                    active_session_id,
                    gateway_thread_id,
                    gateway_trace_id,
                    turn_index,
                    provider_id,
                    provider_name,
                    model,
                    "running",
                    resolved_start_time,
                    _clip_text(request_preview),
                    _json_dumps(_sanitize_metadata(metadata or {})),
                    now,
                    now,
                ),
            )
        record = self.get(request_id)
        if record is None:
            raise RuntimeError(f"创建 LLM 请求日志后无法读取: {request_id}")
        return record

    def finish(
        self,
        request_id: str,
        *,
        input_tokens: int = 0,
        cache_read_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int | None = None,
        response_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
        time_to_first_token: int | None = None,
        end_time: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
    ) -> LLMRequestLogRecord | None:
        return self._complete(
            request_id,
            status="completed",
            input_tokens=input_tokens,
            cache_read_tokens=cache_read_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            response_preview=response_preview,
            metadata=metadata,
            duration_ms=duration_ms,
            time_to_first_token=time_to_first_token,
            end_time=end_time,
            gateway_thread_id=gateway_thread_id,
            gateway_trace_id=gateway_trace_id,
        )

    def fail(
        self,
        request_id: str,
        *,
        error_message: str,
        input_tokens: int = 0,
        cache_read_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int | None = None,
        response_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
        time_to_first_token: int | None = None,
        end_time: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
    ) -> LLMRequestLogRecord | None:
        return self._complete(
            request_id,
            status="failed",
            input_tokens=input_tokens,
            cache_read_tokens=cache_read_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            response_preview=response_preview,
            error_message=error_message,
            metadata=metadata,
            duration_ms=duration_ms,
            time_to_first_token=time_to_first_token,
            end_time=end_time,
            gateway_thread_id=gateway_thread_id,
            gateway_trace_id=gateway_trace_id,
        )

    def cancel(
        self,
        request_id: str,
        *,
        error_message: str | None = None,
        input_tokens: int = 0,
        cache_read_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int | None = None,
        response_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
        time_to_first_token: int | None = None,
        end_time: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
    ) -> LLMRequestLogRecord | None:
        return self._complete(
            request_id,
            status="cancelled",
            input_tokens=input_tokens,
            cache_read_tokens=cache_read_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            response_preview=response_preview,
            error_message=error_message,
            metadata=metadata,
            duration_ms=duration_ms,
            time_to_first_token=time_to_first_token,
            end_time=end_time,
            gateway_thread_id=gateway_thread_id,
            gateway_trace_id=gateway_trace_id,
        )

    def get(self, request_id: str, *, include_deleted: bool = False) -> LLMRequestLogRecord | None:
        query = "select * from llm_request_logs where id = ?"
        params: list[Any] = [request_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        status: str | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[LLMRequestLogRecord], int]:
        where, params = self._filters(
            start_time=start_time,
            end_time=end_time,
            model=model,
            status=status,
        )
        resolved_page = max(1, page)
        resolved_page_size = max(1, min(page_size, 200))
        offset = (resolved_page - 1) * resolved_page_size
        with self.db.connect() as conn:
            total_row = conn.execute(
                f"select count(*) as total from llm_request_logs {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from llm_request_logs
                {where}
                order by start_time desc, created_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_page_size, offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total_row["total"])

    def summary(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        where, params = self._filters(start_time=start_time, end_time=end_time, model=model)
        with self.db.connect() as conn:
            row = conn.execute(
                f"""
                select
                  count(*) as request_count,
                  coalesce(sum(input_tokens), 0) as input_tokens,
                  coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
                  coalesce(sum(output_tokens), 0) as output_tokens,
                  coalesce(sum(total_tokens), 0) as total_tokens,
                  coalesce(
                    sum(case when status = 'completed' then 1 else 0 end),
                    0
                  ) as success_count,
                  coalesce(sum(case when status = 'failed' then 1 else 0 end), 0) as failed_count,
                  avg(duration_ms) as avg_duration_ms
                from llm_request_logs
                {where}
                """,
                params,
            ).fetchone()
        return {
            "request_count": int(row["request_count"] or 0),
            "input_tokens": int(row["input_tokens"] or 0),
            "cache_read_tokens": int(row["cache_read_tokens"] or 0),
            "output_tokens": int(row["output_tokens"] or 0),
            "total_tokens": int(row["total_tokens"] or 0),
            "success_count": int(row["success_count"] or 0),
            "failed_count": int(row["failed_count"] or 0),
            "avg_duration_ms": int(row["avg_duration_ms"] or 0),
        }

    def trend(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        bucket: str = "day",
        timezone_offset_minutes: int = 0,
    ) -> list[dict[str, Any]]:
        return self.trend_page(
            start_time=start_time,
            end_time=end_time,
            model=model,
            bucket=bucket,
            timezone_offset_minutes=timezone_offset_minutes,
        )["points"]

    def trend_page(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        bucket: str = "day",
        timezone_offset_minutes: int = 0,
        start_after: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        if bucket not in {"hour", "day"}:
            raise ValueError(f"不支持的用量统计粒度: {bucket}")
        _validate_timezone_offset(timezone_offset_minutes)
        if limit is not None and limit < 1:
            raise ValueError("趋势分页数量必须大于等于 1")
        if limit is not None and limit > 2000:
            raise ValueError("趋势分页数量不能超过 2000")

        cursor_start_time = (
            _usage_cursor_next_start_time(
                start_after,
                bucket=bucket,
                timezone_offset_minutes=timezone_offset_minutes,
            )
            if start_after
            else None
        )
        effective_start_time = _max_iso_time(start_time, cursor_start_time)
        where, params = self._filters(
            start_time=effective_start_time,
            end_time=end_time,
            model=model,
        )
        bucket_expression = _usage_bucket_sql_expression(bucket)
        timezone_modifier = _sqlite_timezone_modifier(timezone_offset_minutes)
        query_params: list[Any] = [timezone_modifier, *params]
        fetch_limit = limit + 1 if limit is not None else None
        limit_sql = ""
        if fetch_limit is not None:
            limit_sql = "limit ?"
            query_params.append(fetch_limit)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select
                  {bucket_expression} as time,
                  count(*) as request_count,
                  coalesce(sum(input_tokens), 0) as input_tokens,
                  coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
                  coalesce(sum(output_tokens), 0) as output_tokens,
                  coalesce(sum(total_tokens), 0) as total_tokens,
                  coalesce(sum(case when status = 'failed' then 1 else 0 end), 0) as failed_count
                from llm_request_logs
                {where}
                group by time
                order by time asc
                {limit_sql}
                """,
                query_params,
            ).fetchall()
        has_more = fetch_limit is not None and len(rows) > limit
        visible_rows = rows[:limit] if has_more and limit is not None else rows
        points = [
            {
                "time": str(row["time"]),
                "request_count": int(row["request_count"] or 0),
                "input_tokens": int(row["input_tokens"] or 0),
                "cache_read_tokens": int(row["cache_read_tokens"] or 0),
                "output_tokens": int(row["output_tokens"] or 0),
                "total_tokens": int(row["total_tokens"] or 0),
                "failed_count": int(row["failed_count"] or 0),
            }
            for row in visible_rows
        ]
        return {
            "points": points,
            "next_cursor": points[-1]["time"] if has_more and points else None,
            "has_more": has_more,
        }

    def list_models(self) -> list[str]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select distinct model from llm_request_logs
                where is_deleted = 0
                order by model asc
                """
            ).fetchall()
        return [str(row["model"]) for row in rows]

    def _complete(
        self,
        request_id: str,
        *,
        status: str,
        input_tokens: int = 0,
        cache_read_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int | None = None,
        response_preview: str | None = None,
        error_message: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
        time_to_first_token: int | None = None,
        end_time: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
    ) -> LLMRequestLogRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        resolved_end_time = end_time or now
        resolved_total_tokens = (
            int(total_tokens)
            if total_tokens is not None
            else int(input_tokens or 0) + int(output_tokens or 0)
        )
        metadata_json = None if metadata is None else _json_dumps(_sanitize_metadata(metadata))
        with self.db.transaction() as conn:
            conn.execute(
                """
                update llm_request_logs set
                  status = ?,
                  end_time = ?,
                  duration_ms = coalesce(?, duration_ms),
                  time_to_first_token = coalesce(?, time_to_first_token),
                  gateway_thread_id = coalesce(?, gateway_thread_id),
                  gateway_trace_id = coalesce(?, gateway_trace_id),
                  input_tokens = ?,
                  cache_read_tokens = ?,
                  output_tokens = ?,
                  total_tokens = ?,
                  response_preview = coalesce(?, response_preview),
                  error_message = ?,
                  metadata_json = coalesce(?, metadata_json),
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (
                    status,
                    resolved_end_time,
                    duration_ms,
                    time_to_first_token,
                    gateway_thread_id,
                    gateway_trace_id,
                    max(0, int(input_tokens or 0)),
                    max(0, int(cache_read_tokens or 0)),
                    max(0, int(output_tokens or 0)),
                    max(0, resolved_total_tokens),
                    _clip_text(response_preview),
                    _clip_text(error_message),
                    metadata_json,
                    now,
                    request_id,
                ),
            )
        return self.get(request_id)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 LLM 请求状态: {status}")

    @staticmethod
    def _filters(
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        status: str | None = None,
    ) -> tuple[str, list[Any]]:
        filters = ["is_deleted = 0"]
        params: list[Any] = []
        if start_time:
            filters.append("start_time >= ?")
            params.append(start_time)
        if end_time:
            filters.append("start_time <= ?")
            params.append(end_time)
        if model:
            filters.append("model = ?")
            params.append(model)
        if status:
            filters.append("status = ?")
            params.append(status)
        return f"where {' and '.join(filters)}", params

    @staticmethod
    def _from_row(row: sqlite3.Row) -> LLMRequestLogRecord:
        return LLMRequestLogRecord(
            id=row["id"],
            trace_id=row["trace_id"],
            trace_record_id=row["trace_record_id"],
            session_id=row["session_id"],
            active_session_id=row["active_session_id"],
            gateway_thread_id=row["gateway_thread_id"],
            gateway_trace_id=row["gateway_trace_id"],
            turn_index=row["turn_index"],
            provider_id=row["provider_id"],
            provider_name=row["provider_name"],
            model=row["model"],
            status=row["status"],
            start_time=row["start_time"],
            end_time=row["end_time"],
            duration_ms=row["duration_ms"],
            time_to_first_token=row["time_to_first_token"],
            input_tokens=int(row["input_tokens"]),
            cache_read_tokens=int(row["cache_read_tokens"]),
            output_tokens=int(row["output_tokens"]),
            total_tokens=int(row["total_tokens"]),
            request_preview=row["request_preview"],
            response_preview=row["response_preview"],
            error_message=row["error_message"],
            metadata=_json_loads(row["metadata_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class CommandApprovalRequestsRepository:
    VALID_STATUSES = {"pending", "approved", "rejected", "expired", "cancelled"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        approval_id: str,
        session_id: str,
        command: str,
        cwd: str,
        title: str,
        description: str = "",
        trace_id: str | None = None,
        turn_index: int | None = None,
        run_id: str | None = None,
        tool_name: str = "command",
        kind: str = "exec",
        shell: str = "shell",
        workspace_root: str = "",
        details: dict[str, Any] | None = None,
    ) -> CommandApprovalRequestRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into command_approval_requests (
                  id, session_id, trace_id, turn_index, run_id, tool_name, kind,
                  title, description, command, cwd, shell, workspace_root, details_json,
                  status, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (
                    approval_id,
                    session_id,
                    trace_id,
                    turn_index,
                    run_id,
                    tool_name,
                    kind,
                    title,
                    description,
                    command,
                    cwd,
                    shell,
                    workspace_root,
                    _json_dumps(details or {}),
                    now,
                    now,
                ),
            )
        record = self.get(approval_id)
        if record is None:
            raise RuntimeError(f"创建 command 审批后无法读取: {approval_id}")
        return record

    def get(
        self,
        approval_id: str,
        *,
        include_deleted: bool = False,
    ) -> CommandApprovalRequestRecord | None:
        query = "select * from command_approval_requests where id = ?"
        params: list[Any] = [approval_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_pending(
        self,
        *,
        session_id: str | None = None,
        limit: int = 100,
    ) -> list[CommandApprovalRequestRecord]:
        filters = ["status = 'pending'", "is_deleted = 0"]
        params: list[Any] = []
        if session_id:
            filters.append("session_id = ?")
            params.append(session_id)
        params.append(max(1, min(limit, 500)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from command_approval_requests
                where {" and ".join(filters)}
                order by created_at asc, id asc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def list_history(
        self,
        *,
        session_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[CommandApprovalRequestRecord], int]:
        filters = ["is_deleted = 0"]
        params: list[Any] = []
        if session_id:
            filters.append("session_id = ?")
            params.append(session_id)
        where = f"where {' and '.join(filters)}"
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from command_approval_requests {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from command_approval_requests
                {where}
                order by created_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    def resolve(
        self,
        approval_id: str,
        *,
        status: str,
        decision: str | None,
        trust_scope: str | None = None,
        rule_match_type: str | None = None,
        reject_message: str | None = None,
        trusted_rule_id: str | None = None,
    ) -> CommandApprovalRequestRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update command_approval_requests set
                  status = ?,
                  decision = ?,
                  trust_scope = ?,
                  rule_match_type = ?,
                  reject_message = ?,
                  trusted_rule_id = ?,
                  resolved_at = ?,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (
                    status,
                    decision,
                    trust_scope,
                    rule_match_type,
                    reject_message,
                    trusted_rule_id,
                    now,
                    now,
                    approval_id,
                ),
            )
        return self.get(approval_id)

    def cancel_pending_for_session(self, session_id: str) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update command_approval_requests set
                  status = 'cancelled',
                  decision = 'rejected',
                  reject_message = coalesce(reject_message, '本轮对话已取消'),
                  resolved_at = ?,
                  updated_at = ?
                where session_id = ? and status = 'pending' and is_deleted = 0
                """,
                (now, now, session_id),
            )
        return int(cursor.rowcount or 0)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 command 审批状态: {status}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> CommandApprovalRequestRecord:
        return CommandApprovalRequestRecord(
            id=row["id"],
            session_id=row["session_id"],
            trace_id=row["trace_id"],
            turn_index=row["turn_index"],
            run_id=row["run_id"],
            tool_name=row["tool_name"],
            kind=row["kind"],
            title=row["title"],
            description=row["description"],
            command=row["command"],
            cwd=row["cwd"],
            shell=row["shell"],
            workspace_root=row["workspace_root"],
            details=_json_loads(row["details_json"], {}),
            status=row["status"],
            decision=row["decision"],
            trust_scope=row["trust_scope"],
            rule_match_type=row["rule_match_type"],
            reject_message=row["reject_message"],
            trusted_rule_id=row["trusted_rule_id"],
            created_at=row["created_at"],
            resolved_at=row["resolved_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class TrustedCommandRulesRepository:
    VALID_MATCH_TYPES = {"exact", "prefix"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        rule_id: str,
        command_pattern: str,
        normalized_command: str,
        match_type: str,
        tool_name: str = "",
        shell: str = "",
        shell_path: str = "",
        workspace_root: str = "",
        cwd_pattern: str = ".",
        created_from_approval_id: str | None = None,
        enabled: bool = True,
    ) -> TrustedCommandRuleRecord:
        self._validate_match_type(match_type)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into trusted_command_rules (
                  id, command_pattern, normalized_command, match_type, tool_name, shell,
                  shell_path, workspace_root, cwd_pattern, enabled, created_from_approval_id,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rule_id,
                    command_pattern,
                    normalized_command,
                    match_type,
                    tool_name,
                    shell,
                    shell_path,
                    workspace_root,
                    cwd_pattern,
                    int(enabled),
                    created_from_approval_id,
                    now,
                    now,
                ),
            )
        record = self.get(rule_id)
        if record is None:
            raise RuntimeError(f"创建已信任命令后无法读取: {rule_id}")
        return record

    def get(
        self,
        rule_id: str,
        *,
        include_deleted: bool = False,
    ) -> TrustedCommandRuleRecord | None:
        query = "select * from trusted_command_rules where id = ?"
        params: list[Any] = [rule_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        include_disabled: bool = True,
        include_deleted: bool = False,
        limit: int = 200,
    ) -> list[TrustedCommandRuleRecord]:
        filters: list[str] = []
        if not include_disabled:
            filters.append("enabled = 1")
        if not include_deleted:
            filters.append("is_deleted = 0")
        where = f"where {' and '.join(filters)}" if filters else ""
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from trusted_command_rules
                {where}
                order by created_at desc, id desc
                limit ?
                """,
                (max(1, min(limit, 500)),),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def set_enabled(self, rule_id: str, enabled: bool) -> TrustedCommandRuleRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update trusted_command_rules set
                  enabled = ?,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (int(enabled), now, rule_id),
            )
        return self.get(rule_id)

    def delete(self, rule_id: str) -> bool:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update trusted_command_rules set
                  is_deleted = 1,
                  enabled = 0,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, rule_id),
            )
        return int(cursor.rowcount or 0) > 0

    def touch_last_used(self, rule_id: str) -> TrustedCommandRuleRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update trusted_command_rules set
                  last_used_at = ?,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, now, rule_id),
            )
        return self.get(rule_id)

    @classmethod
    def _validate_match_type(cls, match_type: str) -> None:
        if match_type not in cls.VALID_MATCH_TYPES:
            raise ValueError(f"不支持的命令匹配类型: {match_type}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> TrustedCommandRuleRecord:
        return TrustedCommandRuleRecord(
            id=row["id"],
            command_pattern=row["command_pattern"],
            normalized_command=row["normalized_command"],
            match_type=row["match_type"],
            tool_name=row["tool_name"],
            shell=row["shell"],
            shell_path=row["shell_path"],
            workspace_root=row["workspace_root"],
            cwd_pattern=row["cwd_pattern"],
            enabled=bool(row["enabled"]),
            created_from_approval_id=row["created_from_approval_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_used_at=row["last_used_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class CommandApprovalAuditRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        audit_id: str,
        approval_id: str,
        session_id: str,
        command: str,
        cwd: str,
        decision: str,
        trust_scope: str | None = None,
        rule_match_type: str | None = None,
        trusted_rule_id: str | None = None,
        reject_message: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CommandApprovalAuditRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into command_approval_audit (
                  id, approval_id, session_id, command, cwd, decision, trust_scope,
                  rule_match_type, trusted_rule_id, reject_message, metadata_json, created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    audit_id,
                    approval_id,
                    session_id,
                    command,
                    cwd,
                    decision,
                    trust_scope,
                    rule_match_type,
                    trusted_rule_id,
                    reject_message,
                    _json_dumps(_sanitize_metadata(metadata or {})),
                    now,
                ),
            )
        record = self.get(audit_id)
        if record is None:
            raise RuntimeError(f"创建 command 审批审计后无法读取: {audit_id}")
        return record

    def get(self, audit_id: str) -> CommandApprovalAuditRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from command_approval_audit where id = ?",
                (audit_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        session_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[CommandApprovalAuditRecord], int]:
        filters: list[str] = []
        params: list[Any] = []
        if session_id:
            filters.append("session_id = ?")
            params.append(session_id)
        where = f"where {' and '.join(filters)}" if filters else ""
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from command_approval_audit {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from command_approval_audit
                {where}
                order by created_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    @staticmethod
    def _from_row(row: sqlite3.Row) -> CommandApprovalAuditRecord:
        return CommandApprovalAuditRecord(
            id=row["id"],
            approval_id=row["approval_id"],
            session_id=row["session_id"],
            command=row["command"],
            cwd=row["cwd"],
            decision=row["decision"],
            trust_scope=row["trust_scope"],
            rule_match_type=row["rule_match_type"],
            trusted_rule_id=row["trusted_rule_id"],
            reject_message=row["reject_message"],
            metadata=_json_loads(row["metadata_json"], {}),
            created_at=row["created_at"],
        )


def _validate_timezone_offset(value: int) -> None:
    if value < -14 * 60 or value > 14 * 60:
        raise ValueError("时区偏移必须在 -840 到 840 分钟之间")


def _usage_bucket_key(
    start_time: str,
    *,
    bucket: str,
    timezone_offset_minutes: int,
) -> str:
    value = datetime.fromisoformat(str(start_time).replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    local_time = value.astimezone(UTC) + timedelta(minutes=timezone_offset_minutes)
    if bucket == "hour":
        return local_time.strftime("%Y-%m-%dT%H:00:00")
    return local_time.strftime("%Y-%m-%d")


def _usage_bucket_sql_expression(bucket: str) -> str:
    if bucket == "hour":
        return "strftime('%Y-%m-%dT%H:00:00', start_time, ?)"
    return "strftime('%Y-%m-%d', start_time, ?)"


def _sqlite_timezone_modifier(timezone_offset_minutes: int) -> str:
    sign = "+" if timezone_offset_minutes >= 0 else "-"
    return f"{sign}{abs(timezone_offset_minutes)} minutes"


def _usage_cursor_next_start_time(
    start_after: str,
    *,
    bucket: str,
    timezone_offset_minutes: int,
) -> str:
    if bucket == "hour":
        try:
            local_bucket = datetime.strptime(start_after, "%Y-%m-%dT%H:00:00")
        except ValueError as exc:
            raise ValueError("趋势游标格式不正确") from exc
        next_bucket = local_bucket + timedelta(hours=1)
    else:
        try:
            local_bucket = datetime.strptime(start_after, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError("趋势游标格式不正确") from exc
        next_bucket = local_bucket + timedelta(days=1)
    utc_bucket = next_bucket - timedelta(minutes=timezone_offset_minutes)
    return to_iso_z(utc_bucket.replace(tzinfo=UTC))


def _max_iso_time(left: str | None, right: str | None) -> str | None:
    if not left:
        return right
    if not right:
        return left
    return max(left, right)


class ToolResultArtifactsRepository:
    VALID_STORAGE_KINDS = {"managed_json", "managed_text", "command_log"}
    VALID_STATUSES = {"active", "quarantined", "deleted"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create_or_get(
        self,
        *,
        artifact_id: str,
        owner_user_id: str,
        source_session_id: str | None,
        tool_call_id: str,
        tool_name: str,
        storage_kind: str,
        relative_path: str,
        content_type: str,
        content_sha256: str,
        content_bytes: int,
        approximate_tokens: int,
        is_complete: bool = True,
        connection: sqlite3.Connection | None = None,
    ) -> ToolResultArtifactRecord:
        if storage_kind not in self.VALID_STORAGE_KINDS:
            raise ValueError(f"unsupported tool result storage kind: {storage_kind}")
        if content_bytes < 0 or approximate_tokens < 0:
            raise ValueError("tool result artifact sizes must be non-negative")
        now = to_iso_z(utc_now())
        transaction = nullcontext(connection) if connection is not None else self.db.transaction()
        with transaction as conn:
            existing = conn.execute(
                """
                select * from tool_result_artifacts
                where source_session_id is ? and tool_call_id = ? and content_sha256 = ?
                """,
                (source_session_id, tool_call_id, content_sha256),
            ).fetchone()
            if existing is None:
                conn.execute(
                    """
                    insert into tool_result_artifacts (
                      id, owner_user_id, source_session_id, tool_call_id, tool_name,
                      storage_kind, relative_path, content_type, content_sha256,
                      content_bytes, approximate_tokens, is_complete, status, created_at
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
                    """,
                    (
                        artifact_id,
                        owner_user_id,
                        source_session_id,
                        tool_call_id,
                        tool_name,
                        storage_kind,
                        relative_path,
                        content_type,
                        content_sha256,
                        content_bytes,
                        approximate_tokens,
                        int(is_complete),
                        now,
                    ),
                )
                existing = conn.execute(
                    "select * from tool_result_artifacts where id = ?",
                    (artifact_id,),
                ).fetchone()
        if existing is None:
            raise RuntimeError("tool result artifact row was not created")
        return _tool_result_artifact_from_row(existing)

    def get(self, artifact_id: str) -> ToolResultArtifactRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from tool_result_artifacts where id = ?",
                (artifact_id,),
            ).fetchone()
        return _tool_result_artifact_from_row(row) if row is not None else None

    def find_by_source(
        self,
        *,
        source_session_id: str | None,
        tool_call_id: str,
        content_sha256: str,
    ) -> ToolResultArtifactRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from tool_result_artifacts
                where source_session_id is ? and tool_call_id = ? and content_sha256 = ?
                """,
                (source_session_id, tool_call_id, content_sha256),
            ).fetchone()
        return _tool_result_artifact_from_row(row) if row is not None else None

    def grant(
        self,
        *,
        artifact_id: str,
        session_id: str,
        connection: sqlite3.Connection | None = None,
    ) -> None:
        transaction = nullcontext(connection) if connection is not None else self.db.transaction()
        with transaction as conn:
            conn.execute(
                """
                insert or ignore into tool_result_artifact_grants (
                  artifact_id, session_id, created_at
                )
                values (?, ?, ?)
                """,
                (artifact_id, session_id, to_iso_z(utc_now())),
            )

    def has_grant(self, *, artifact_id: str, session_id: str) -> bool:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select 1 from tool_result_artifact_grants
                where artifact_id = ? and session_id = ?
                """,
                (artifact_id, session_id),
            ).fetchone()
        return row is not None

    def list_for_session(self, session_id: str) -> list[ToolResultArtifactRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select a.* from tool_result_artifacts a
                join tool_result_artifact_grants g on g.artifact_id = a.id
                where g.session_id = ?
                order by a.created_at, a.id
                """,
                (session_id,),
            ).fetchall()
        return [_tool_result_artifact_from_row(row) for row in rows]

    def copy_grants(
        self,
        *,
        source_session_id: str,
        target_session_id: str,
        owner_user_id: str | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> int:
        transaction = nullcontext(connection) if connection is not None else self.db.transaction()
        with transaction as conn:
            before = conn.total_changes
            if owner_user_id is None:
                conn.execute(
                    """
                    insert or ignore into tool_result_artifact_grants (
                      artifact_id, session_id, created_at
                    )
                    select artifact_id, ?, ? from tool_result_artifact_grants
                    where session_id = ?
                    """,
                    (target_session_id, to_iso_z(utc_now()), source_session_id),
                )
            else:
                conn.execute(
                    """
                    insert or ignore into tool_result_artifact_grants (
                      artifact_id, session_id, created_at
                    )
                    select g.artifact_id, ?, ?
                      from tool_result_artifact_grants g
                      join tool_result_artifacts a on a.id = g.artifact_id
                     where g.session_id = ? and a.owner_user_id = ?
                    """,
                    (
                        target_session_id,
                        to_iso_z(utc_now()),
                        source_session_id,
                        owner_user_id,
                    ),
                )
            return conn.total_changes - before

    def delete_grants_for_session(
        self,
        session_id: str,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> list[str]:
        transaction = nullcontext(connection) if connection is not None else self.db.transaction()
        with transaction as conn:
            rows = conn.execute(
                "select artifact_id from tool_result_artifact_grants where session_id = ?",
                (session_id,),
            ).fetchall()
            artifact_ids = [str(row["artifact_id"]) for row in rows]
            conn.execute(
                "delete from tool_result_artifact_grants where session_id = ?",
                (session_id,),
            )
        return artifact_ids

    def grant_count(self, artifact_id: str) -> int:
        with self.db.connect() as conn:
            row = conn.execute(
                "select count(*) as value from tool_result_artifact_grants where artifact_id = ?",
                (artifact_id,),
            ).fetchone()
        return int(row["value"] if row is not None else 0)

    def list_unreferenced(self) -> list[ToolResultArtifactRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select a.* from tool_result_artifacts a
                left join tool_result_artifact_grants g on g.artifact_id = a.id
                where g.artifact_id is null and a.status != 'deleted'
                order by a.created_at, a.id
                """
            ).fetchall()
        return [_tool_result_artifact_from_row(row) for row in rows]

    def set_status(
        self,
        artifact_id: str,
        status: str,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> ToolResultArtifactRecord | None:
        if status not in self.VALID_STATUSES:
            raise ValueError(f"unsupported tool result artifact status: {status}")
        transaction = nullcontext(connection) if connection is not None else self.db.transaction()
        with transaction as conn:
            cursor = conn.execute(
                """
                update tool_result_artifacts
                set status = ?, deleted_at = case when ? = 'deleted' then ? else deleted_at end
                where id = ?
                """,
                (status, status, to_iso_z(utc_now()), artifact_id),
            )
            if cursor.rowcount == 0:
                return None
            row = conn.execute(
                "select * from tool_result_artifacts where id = ?",
                (artifact_id,),
            ).fetchone()
        return _tool_result_artifact_from_row(row) if row is not None else None

    def touch(self, artifact_id: str) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                "update tool_result_artifacts set last_accessed_at = ? where id = ?",
                (to_iso_z(utc_now()), artifact_id),
            )

    def delete_record(self, artifact_id: str) -> None:
        with self.db.transaction() as conn:
            conn.execute("delete from tool_result_artifacts where id = ?", (artifact_id,))


def _tool_result_artifact_from_row(row: sqlite3.Row) -> ToolResultArtifactRecord:
    return ToolResultArtifactRecord(
        id=str(row["id"]),
        owner_user_id=str(row["owner_user_id"]),
        source_session_id=(
            str(row["source_session_id"]) if row["source_session_id"] is not None else None
        ),
        tool_call_id=str(row["tool_call_id"]),
        tool_name=str(row["tool_name"]),
        storage_kind=str(row["storage_kind"]),
        relative_path=str(row["relative_path"]),
        content_type=str(row["content_type"]),
        content_sha256=str(row["content_sha256"]),
        content_bytes=int(row["content_bytes"]),
        approximate_tokens=int(row["approximate_tokens"]),
        is_complete=bool(row["is_complete"]),
        status=str(row["status"]),
        created_at=str(row["created_at"]),
        last_accessed_at=(
            str(row["last_accessed_at"]) if row["last_accessed_at"] is not None else None
        ),
        deleted_at=str(row["deleted_at"]) if row["deleted_at"] is not None else None,
    )


class StorageRepositories:
    """Repositories retained during backend runtime replacement.

    The previous Thread/Turn/Item/Event/Approval repositories are intentionally
    removed from this shell. New session/message_event/trace repositories are
    introduced by the kt-agentloop rewrite issues.
    """

    def __init__(self, db: Database) -> None:
        from backend.app.annotations.repository import WorkspaceAnnotationsRepository
        from backend.app.right_sidebar.repository import RightSidebarScopeRepository
        from backend.app.storage.file_history_repository import FileHistoryRepository
        from backend.app.web_annotations.repository import WebAnnotationRepositories

        self.db = db
        self.mcp_servers = McpServersRepository(db)
        self.mcp_server_status = McpServerStatusRepository(db)
        self.mcp_tools = McpToolsRepository(db)
        self.mcp_resources = McpResourcesRepository(db)
        self.mcp_tool_policies = McpToolPoliciesRepository(db)
        self.mcp_session_tool_overrides = McpSessionToolOverridesRepository(db)
        self.mcp_session_tool_usage = McpSessionToolUsageRepository(db)
        self.mcp_runtime_snapshots = McpRuntimeSnapshotsRepository(db)
        self.mcp_oauth_tokens = McpOAuthTokensRepository(db)
        self.mcp_trust_rules = McpTrustRulesRepository(db)
        self.mcp_audit_log = McpAuditLogRepository(db)
        self.settings = SettingsRepository(db)
        self.web_settings = WebSettingsRepository(db)
        self.model_providers = ModelProvidersRepository(db)
        self.lifecycle_operations = LifecycleOperationsRepository(db)
        self.workspaces = WorkspacesRepository(db)
        self.sessions = SessionsRepository(db)
        self.subagent_runs = SubagentRunRepository(db)
        self.session_forks = SessionForksRepository(db)
        self.attachments = AttachmentsRepository(db)
        self.annotations = WorkspaceAnnotationsRepository(db)
        self.right_sidebar_scopes = RightSidebarScopeRepository(db)
        self.web_annotations = WebAnnotationRepositories(db)
        self.a2ui_interactions = A2UIInteractionsRepository(db)
        self.message_events = MessageEventsRepository(db)
        self.pending_inputs = PendingInputsRepository(db)
        self.thread_tasks = ThreadTasksRepository(db)
        self.thread_task_runs = ThreadTaskRunsRepository(db)
        self.compression_staging = CompressionStagingRepository(db)
        self.command_approvals = CommandApprovalRequestsRepository(db)
        self.trusted_command_rules = TrustedCommandRulesRepository(db)
        self.command_approval_audit = CommandApprovalAuditRepository(db)
        self.trace_records = TraceRecordsRepository(db)
        self.trace_event_logs = TraceEventLogsRepository(db)
        self.llm_request_logs = LLMRequestLogsRepository(db)
        self.file_history = FileHistoryRepository(db)
        self.tool_result_artifacts = ToolResultArtifactsRepository(db)


def legacy_model_provider_from_settings(value: dict[str, Any]) -> ModelProviderRecord | None:
    base_url = str(value.get("base_url") or "").strip().rstrip("/")
    model = str(value.get("model") or "").strip()
    if not base_url and not model:
        return None
    now = to_iso_z(utc_now())
    models = [model] if model else []
    return ModelProviderRecord(
        id="legacy-openai-compatible",
        name="OpenAI-compatible",
        base_url=base_url,
        api_key=value.get("api_key") if isinstance(value.get("api_key"), str) else None,
        enabled=True,
        models=models,
        model_enabled={model: True} if model else {},
        health={},
        created_at=now,
        updated_at=now,
    )


def _clean_model_default_scope(scope: str) -> str:
    cleaned = scope.strip()
    if not cleaned:
        raise ValueError("model default scope must not be empty")
    return cleaned


def _require_model_default_scope(scope: str) -> str:
    cleaned = _clean_model_default_scope(scope)
    if cleaned not in MODEL_DEFAULT_SCOPES:
        expected = ", ".join(sorted(MODEL_DEFAULT_SCOPES))
        raise ValueError(f"unknown model default scope '{cleaned}', expected one of: {expected}")
    return cleaned
