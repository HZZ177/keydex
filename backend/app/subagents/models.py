from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Any

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

SUBAGENT_SCHEMA_VERSION = 1


def _stable_id(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("stable identifiers must be non-empty strings")
    return value.strip()


StableId = Annotated[str, BeforeValidator(_stable_id)]


class SubagentRole(StrEnum):
    EXPLORER = "explorer"
    WORKER = "worker"


class SubagentRunState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    INTERRUPTED = "interrupted"


class SubagentInstanceState(StrEnum):
    IDLE = "idle"
    RUNNING = "running"
    CLOSED = "closed"


class SubagentBlockedOn(StrEnum):
    APPROVAL = "approval"
    USER_INPUT = "user_input"
    EXTERNAL_TOOL = "external_tool"


class SubagentInitiator(StrEnum):
    MAIN_AGENT = "main_agent"
    USER = "user"


TERMINAL_RUN_STATES = frozenset(
    {
        SubagentRunState.COMPLETED,
        SubagentRunState.FAILED,
        SubagentRunState.CANCELLED,
        SubagentRunState.INTERRUPTED,
    }
)
ACTIVE_RUN_STATES = frozenset({SubagentRunState.QUEUED, SubagentRunState.RUNNING})


class SubagentDomainModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, use_enum_values=False)


class DelegateSubagentRequest(SubagentDomainModel):
    """The complete model-visible delegate_subagent input contract."""

    type: SubagentRole
    task: str = Field(min_length=1)

    @field_validator("task")
    @classmethod
    def _task_must_not_be_blank(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("task must not be blank")
        return normalized


class ContinueSubagentRequest(SubagentDomainModel):
    """The complete model-visible continue_subagent input contract."""

    subagent_id: StableId
    task: str = Field(min_length=1)

    @field_validator("task")
    @classmethod
    def _task_must_not_be_blank(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("task must not be blank")
        return normalized


class SubagentSpawnRequest(SubagentDomainModel):
    """Trusted internal spawn request built from caller context plus type/task."""

    parent_session_id: StableId
    parent_trace_id: StableId | None = None
    parent_tool_call_id: StableId | None = None
    user_id: StableId
    role: SubagentRole
    task: str = Field(min_length=1)
    initiated_by: SubagentInitiator = SubagentInitiator.MAIN_AGENT

    @field_validator("task")
    @classmethod
    def _task_must_not_be_blank(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("task must not be blank")
        return normalized

    @model_validator(mode="after")
    def _main_agent_requires_tool_call(self) -> SubagentSpawnRequest:
        if (
            self.initiated_by is SubagentInitiator.MAIN_AGENT
            and self.parent_tool_call_id is None
        ):
            raise ValueError("main_agent spawn requires parent_tool_call_id")
        return self


class SubagentRunSnapshot(SubagentDomainModel):
    schema_version: int = Field(default=SUBAGENT_SCHEMA_VERSION, ge=1)
    run_id: StableId
    subagent_id: StableId
    child_session_id: StableId
    parent_session_id: StableId
    parent_trace_id: StableId | None = None
    parent_tool_call_id: StableId | None = None
    parent_timeline_sequence: int = Field(ge=0)
    initiated_by: SubagentInitiator
    role: SubagentRole
    task: str = Field(min_length=1)
    state: SubagentRunState
    blocked_on: SubagentBlockedOn | None = None
    version: int = Field(ge=1)
    final_report: str | None = None
    report_truncated: bool = False
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime
    queued_at: datetime | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    updated_at: datetime | None = None
    cancel_requested_at: datetime | None = None

    @field_validator("task")
    @classmethod
    def _task_must_not_be_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("task must not be blank")
        return value

    @field_validator("final_report", "error_code", "error_message")
    @classmethod
    def _optional_text_must_not_be_blank(cls, value: str | None) -> str | None:
        if value is None:
            return None
        value = value.strip()
        if not value:
            raise ValueError("optional text fields must be non-empty when present")
        return value

    @model_validator(mode="after")
    def _validate_state_payload(self) -> SubagentRunSnapshot:
        if self.initiated_by is SubagentInitiator.MAIN_AGENT and not self.parent_tool_call_id:
            raise ValueError("main_agent runs require parent_tool_call_id")
        if self.blocked_on is not None and self.state is not SubagentRunState.RUNNING:
            raise ValueError("blocked_on is only valid while running")
        if self.state in ACTIVE_RUN_STATES and self.finished_at is not None:
            raise ValueError("active runs cannot have finished_at")
        if self.state in TERMINAL_RUN_STATES and self.finished_at is None:
            raise ValueError("terminal runs require finished_at")
        if self.state is SubagentRunState.QUEUED and self.started_at is not None:
            raise ValueError("queued runs cannot have started_at")
        if self.state is SubagentRunState.RUNNING and self.started_at is None:
            raise ValueError("running runs require started_at")
        if self.started_at is not None and self.started_at < self.created_at:
            raise ValueError("started_at cannot precede created_at")
        if self.finished_at is not None:
            reference = self.started_at or self.created_at
            if self.finished_at < reference:
                raise ValueError("finished_at cannot precede the run")

        if self.state is SubagentRunState.COMPLETED:
            if self.final_report is None:
                raise ValueError("completed runs require final_report")
            if self.error_code is not None or self.error_message is not None:
                raise ValueError("completed runs cannot contain an error")
        elif self.state is SubagentRunState.FAILED:
            if self.final_report is not None:
                raise ValueError("failed runs cannot contain final_report")
            if self.error_code is None or self.error_message is None:
                raise ValueError("failed runs require error_code and error_message")
        elif self.final_report is not None:
            raise ValueError("only completed runs can contain final_report")

        if self.report_truncated and self.final_report is None:
            raise ValueError("report_truncated requires final_report")
        return self

    @property
    def is_terminal(self) -> bool:
        return self.state in TERMINAL_RUN_STATES


class SubagentHandle(SubagentDomainModel):
    schema_version: int = Field(default=SUBAGENT_SCHEMA_VERSION, ge=1)
    subagent_id: StableId
    run_id: StableId
    child_session_id: StableId
    parent_session_id: StableId
    role: SubagentRole
    initial_snapshot: SubagentRunSnapshot

    @model_validator(mode="after")
    def _validate_snapshot_identity(self) -> SubagentHandle:
        snapshot = self.initial_snapshot
        matching_fields = {
            "subagent_id": self.subagent_id,
            "run_id": self.run_id,
            "child_session_id": self.child_session_id,
            "parent_session_id": self.parent_session_id,
            "role": self.role,
        }
        for field_name, expected in matching_fields.items():
            if getattr(snapshot, field_name) != expected:
                raise ValueError(f"initial_snapshot {field_name} does not match handle")
        if snapshot.state not in ACTIVE_RUN_STATES:
            raise ValueError("a new handle requires an active initial snapshot")
        return self


class SubagentInstanceSummary(SubagentDomainModel):
    schema_version: int = Field(default=SUBAGENT_SCHEMA_VERSION, ge=1)
    subagent_id: StableId
    child_session_id: StableId
    parent_session_id: StableId
    role: SubagentRole
    state: SubagentInstanceState
    active_run_id: StableId | None = None
    closed_at: datetime | None = None

    @model_validator(mode="after")
    def _validate_derived_state(self) -> SubagentInstanceSummary:
        if self.state is SubagentInstanceState.RUNNING and self.active_run_id is None:
            raise ValueError("running instances require active_run_id")
        if self.state is not SubagentInstanceState.RUNNING and self.active_run_id is not None:
            raise ValueError("only running instances can expose active_run_id")
        if self.state is SubagentInstanceState.CLOSED and self.closed_at is None:
            raise ValueError("closed instances require closed_at")
        if self.state is not SubagentInstanceState.CLOSED and self.closed_at is not None:
            raise ValueError("only closed instances can expose closed_at")
        return self
