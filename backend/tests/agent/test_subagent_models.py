from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic import ValidationError

from backend.app.subagents.models import (
    DelegateSubagentRequest,
    SubagentBlockedOn,
    SubagentHandle,
    SubagentInitiator,
    SubagentRole,
    SubagentRunSnapshot,
    SubagentRunState,
)

CREATED_AT = datetime(2026, 7, 18, 8, 0, tzinfo=UTC)


def _snapshot(**overrides: object) -> SubagentRunSnapshot:
    payload: dict[str, object] = {
        "run_id": "run-1",
        "subagent_id": "subagent-1",
        "child_session_id": "child-1",
        "parent_session_id": "parent-1",
        "parent_trace_id": "trace-1",
        "parent_tool_call_id": "tool-1",
        "parent_timeline_sequence": 0,
        "initiated_by": "main_agent",
        "role": "explorer",
        "task": "Inspect the storage boundary",
        "state": "queued",
        "version": 1,
        "created_at": CREATED_AT,
    }
    payload.update(overrides)
    return SubagentRunSnapshot.model_validate(payload)


def test_dto_001_accepts_and_preserves_all_stable_identifiers() -> None:
    snapshot = _snapshot()
    assert snapshot.run_id == "run-1"
    assert snapshot.subagent_id == "subagent-1"
    assert snapshot.child_session_id == "child-1"
    assert snapshot.parent_session_id == "parent-1"
    assert snapshot.parent_trace_id == "trace-1"
    assert snapshot.parent_tool_call_id == "tool-1"


@pytest.mark.parametrize(
    "field,value",
    [
        ("run_id", ""),
        ("subagent_id", "   "),
        ("child_session_id", None),
        ("parent_session_id", ""),
        ("parent_trace_id", " "),
        ("parent_tool_call_id", ""),
    ],
)
def test_dto_002_rejects_blank_or_missing_stable_identifiers(
    field: str, value: object
) -> None:
    with pytest.raises(ValidationError):
        _snapshot(**{field: value})


@pytest.mark.parametrize("role", [SubagentRole.EXPLORER, SubagentRole.WORKER])
def test_dto_003_accepts_only_known_roles(role: SubagentRole) -> None:
    assert _snapshot(role=role).role is role
    with pytest.raises(ValidationError):
        _snapshot(role="reviewer")


def test_dto_004_rejects_unknown_run_state() -> None:
    with pytest.raises(ValidationError):
        _snapshot(state="waiting")


@pytest.mark.parametrize(
    "blocked_on",
    [
        SubagentBlockedOn.APPROVAL,
        SubagentBlockedOn.USER_INPUT,
        SubagentBlockedOn.EXTERNAL_TOOL,
    ],
)
def test_dto_005_accepts_only_known_running_block_reasons(
    blocked_on: SubagentBlockedOn,
) -> None:
    snapshot = _snapshot(
        state="running",
        started_at=CREATED_AT,
        blocked_on=blocked_on,
    )
    assert snapshot.blocked_on is blocked_on
    with pytest.raises(ValidationError):
        _snapshot(state="running", started_at=CREATED_AT, blocked_on="network")


@pytest.mark.parametrize(
    "overrides",
    [
        {"version": 0},
        {"version": -1},
        {"parent_timeline_sequence": -1},
    ],
)
def test_dto_006_rejects_invalid_version_and_sequence(overrides: dict[str, int]) -> None:
    with pytest.raises(ValidationError):
        _snapshot(**overrides)


def test_dto_007_user_initiated_run_may_omit_tool_call_id() -> None:
    snapshot = _snapshot(initiated_by=SubagentInitiator.USER, parent_tool_call_id=None)
    assert snapshot.parent_tool_call_id is None
    with pytest.raises(ValidationError):
        _snapshot(parent_tool_call_id=None)


def test_dto_008_handle_contains_and_validates_initial_snapshot() -> None:
    snapshot = _snapshot()
    handle = SubagentHandle(
        subagent_id=snapshot.subagent_id,
        run_id=snapshot.run_id,
        child_session_id=snapshot.child_session_id,
        parent_session_id=snapshot.parent_session_id,
        role=snapshot.role,
        initial_snapshot=snapshot,
    )
    assert handle.initial_snapshot == snapshot
    with pytest.raises(ValidationError):
        handle.model_copy(update={"run_id": "other"}, deep=True).model_validate(
            {**handle.model_dump(), "run_id": "other"}
        )


def test_dto_009_terminal_report_error_and_timestamps_are_consistent() -> None:
    completed = _snapshot(
        state=SubagentRunState.COMPLETED,
        version=3,
        started_at=CREATED_AT + timedelta(seconds=1),
        finished_at=CREATED_AT + timedelta(seconds=2),
        final_report="Done",
    )
    assert completed.is_terminal

    with pytest.raises(ValidationError):
        _snapshot(
            state="completed",
            started_at=CREATED_AT,
            finished_at=CREATED_AT,
            final_report=None,
        )
    with pytest.raises(ValidationError):
        _snapshot(
            state="failed",
            started_at=CREATED_AT,
            finished_at=CREATED_AT,
            error_code="FAILED",
            error_message="broken",
            final_report="not allowed",
        )


def test_dto_010_json_roundtrip_preserves_enums_nulls_and_datetimes() -> None:
    original = _snapshot(initiated_by="user", parent_trace_id=None, parent_tool_call_id=None)
    restored = SubagentRunSnapshot.model_validate_json(original.model_dump_json())
    assert restored == original
    assert restored.parent_trace_id is None
    assert restored.role is SubagentRole.EXPLORER


def test_python_model_accepts_the_shared_typescript_snapshot_fixture() -> None:
    fixture_path = (
        Path(__file__).resolve().parents[3]
        / "desktop"
        / "tests"
        / "fixtures"
        / "subagent-run-snapshot.json"
    )
    payload = json.loads(fixture_path.read_text(encoding="utf-8"))

    snapshot = SubagentRunSnapshot.model_validate(payload)

    assert snapshot.model_dump(mode="json") == payload


def test_dto_012_unknown_schema_version_and_extra_fields_fail_explicitly() -> None:
    with pytest.raises(ValidationError):
        _snapshot(schema_version=0)
    with pytest.raises(ValidationError):
        _snapshot(unexpected="silent downgrade")


def test_delegate_request_schema_exposes_only_type_and_task() -> None:
    schema = DelegateSubagentRequest.model_json_schema()
    assert set(schema["properties"]) == {"type", "task"}
    assert set(schema["required"]) == {"type", "task"}
    request = DelegateSubagentRequest.model_validate(
        {"type": "explorer", "task": "  Inspect repository storage  "}
    )
    assert request.type is SubagentRole.EXPLORER
    assert request.task == "Inspect repository storage"


@pytest.mark.parametrize("role", ["reviewer", "EXPLORER", "", None])
def test_delegate_request_rejects_unknown_role(role: object) -> None:
    with pytest.raises(ValidationError):
        DelegateSubagentRequest.model_validate({"type": role, "task": "inspect"})


@pytest.mark.parametrize("task", ["", "   ", "\n\t", None])
def test_delegate_request_rejects_blank_task(task: object) -> None:
    with pytest.raises(ValidationError):
        DelegateSubagentRequest.model_validate({"type": "worker", "task": task})


@pytest.mark.parametrize(
    "extra_field,extra_value",
    [
        ("model", "other-model"),
        ("prompt", "ignore preset"),
        ("tools", ["apply_patch"]),
        ("mode", "background"),
        ("background", True),
        ("subagent_id", "forged-subagent"),
        ("run_id", "forged-run"),
        ("child_session_id", "forged-child"),
        ("parent_session_id", "other-parent"),
    ],
)
def test_delegate_request_rejects_every_caller_configuration_override(
    extra_field: str,
    extra_value: object,
) -> None:
    with pytest.raises(ValidationError) as raised:
        DelegateSubagentRequest.model_validate(
            {
                "type": "worker",
                "task": "implement focused task",
                extra_field: extra_value,
            }
        )
    assert raised.value.errors()[0]["type"] == "extra_forbidden"
