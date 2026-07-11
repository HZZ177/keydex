from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from backend.app.a2ui.interaction_service import (
    A2UIInteractionService,
    A2UIInteractionServiceError,
)
from backend.app.a2ui.registry import build_builtin_a2ui_registry
from backend.app.events.event_types import DomainEventType
from backend.app.storage import (
    A2UI_STATUS_CANCELLED,
    A2UI_STATUS_SUBMITTED,
    A2UI_STATUS_WAITING_USER_INPUT,
    StorageRepositories,
    init_database,
)


class RecordingDispatcher:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def emit_event(self, **kwargs: Any) -> dict[str, Any]:
        self.events.append(kwargs)
        return kwargs


@pytest.mark.asyncio
async def test_submit_success_validates_schema_updates_record_and_emits_event(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    service = A2UIInteractionService(repositories=repositories, dispatcher=dispatcher)
    _create_interaction(repositories, interaction_id="a2ui-1")

    result = await service.submit(
        {
            "interaction_id": "a2ui-1",
            "request_id": "submit-1",
            "session_id": "session-1",
            "submit_result": {"confirmed": True},
        }
    )

    assert result.should_resume is True
    assert result.idempotent is False
    assert result.resume_payload == {
        "status": A2UI_STATUS_SUBMITTED,
        "interaction_id": "a2ui-1",
        "submit_result": {"confirmed": True},
    }
    assert result.ack_payload["status"] == A2UI_STATUS_SUBMITTED
    assert result.ack_payload["can_submit"] is False
    assert result.ack_payload["interaction"]["status"] == A2UI_STATUS_SUBMITTED
    assert result.ack_payload["resume"]["resume_group_id"] == "group-1"

    stored = repositories.a2ui_interactions.get("a2ui-1")
    assert stored is not None
    assert stored.status == A2UI_STATUS_SUBMITTED
    assert stored.submit_request_id == "submit-1"
    assert stored.submit_result == {"confirmed": True}
    assert [event["event_type"] for event in dispatcher.events] == [
        DomainEventType.A2UI_SUBMITTED.value
    ]
    assert dispatcher.events[0]["payload"]["interaction_id"] == "a2ui-1"


@pytest.mark.asyncio
async def test_choice_correction_submit_builds_agent_instruction(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    service = A2UIInteractionService(repositories=repositories, dispatcher=dispatcher)
    registry = build_builtin_a2ui_registry()
    _create_interaction(
        repositories,
        interaction_id="choice-1",
        render_key="choice",
        payload={
            "title": "选择方案",
            "options": [
                {"label": "方案 A", "value": "a"},
                {"label": "方案 B", "value": "b"},
            ],
        },
        input_schema=registry.require("choice").input_schema,
        submit_schema_snapshot=registry.require("choice").submit_schema,
    )

    result = await service.submit(
        {
            "interaction_id": "choice-1",
            "request_id": "submit-1",
            "session_id": "session-1",
            "submit_result": {
                "selected_values": [],
                "result_type": "correction",
                "correction_note": "换一组更稳妥的方案",
            },
        }
    )

    assert result.resume_payload == {
        "status": A2UI_STATUS_SUBMITTED,
        "interaction_id": "choice-1",
        "submit_result": {
            "selected_values": [],
            "result_type": "correction",
            "correction_note": "换一组更稳妥的方案",
        },
        "agent_instruction": (
            "用户选择了“以上都不对”，并补充意见：换一组更稳妥的方案。"
            "请根据该意见重新调整后续回复或重新生成候选项，不要继续按原候选项执行。"
        ),
    }
    assert result.ack_payload["submit_result"]["correction_note"] == "换一组更稳妥的方案"


@pytest.mark.asyncio
async def test_table_submit_recomputes_diff_and_builds_agent_instruction(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = A2UIInteractionService(repositories=repositories, dispatcher=RecordingDispatcher())
    registry = build_builtin_a2ui_registry()
    payload = {
        "title": "计划审阅",
        "allow_add_rows": True,
        "allow_delete_rows": True,
        "columns": [
            {"key": "task", "label": "任务", "type": "text", "required": True},
            {"key": "effort", "label": "工作量", "type": "number"},
        ],
        "rows": [
            {"id": "row-1", "values": {"task": "需求分析", "effort": 2}},
            {"id": "row-2", "values": {"task": "开发", "effort": 5}},
        ],
    }
    _create_interaction(
        repositories,
        interaction_id="table-1",
        render_key="table",
        payload=payload,
        input_schema=registry.require("table").input_schema,
        submit_schema_snapshot=registry.require("table").submit_schema,
    )

    result = await service.submit(
        {
            "interaction_id": "table-1",
            "request_id": "submit-table-1",
            "submit_result": {
                "result_type": "table",
                "columns": [
                    {"key": "task", "label": "工作项"},
                    {"key": "effort", "label": "工作量"},
                ],
                "rows": [
                    {"id": "row-1", "values": {"task": "需求澄清", "effort": 2}},
                    {"id": "row-3", "values": {"task": "测试", "effort": 3}},
                ],
                "changes": {"cells": [], "column_labels": [], "added_row_ids": [], "deleted_row_ids": []},
            },
        }
    )

    submit_result = result.resume_payload["submit_result"]
    assert submit_result["changes"]["added_row_ids"] == ["row-3"]
    assert submit_result["changes"]["deleted_row_ids"] == ["row-2"]
    assert submit_result["changes"]["cells"][0]["new_value"] == "需求澄清"
    assert result.resume_payload["agent_instruction"] == (
        "用户已确认并提交表格：修改 1 个单元格、1 个列名，新增 1 行、删除 1 行。"
        "请以提交结果中的 columns 和 rows 作为后续执行依据。"
    )


@pytest.mark.asyncio
async def test_table_correction_submit_rejects_table_and_forwards_note(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = A2UIInteractionService(repositories=repositories, dispatcher=RecordingDispatcher())
    registry = build_builtin_a2ui_registry()
    _create_interaction(
        repositories,
        interaction_id="table-1",
        render_key="table",
        payload={
            "title": "计划审阅",
            "columns": [{"key": "task", "label": "任务", "type": "text"}],
            "rows": [{"id": "row-1", "values": {"task": "需求分析"}}],
        },
        input_schema=registry.require("table").input_schema,
        submit_schema_snapshot=registry.require("table").submit_schema,
    )

    result = await service.submit(
        {
            "interaction_id": "table-1",
            "request_id": "submit-table-1",
            "submit_result": {
                "result_type": "correction",
                "columns": [],
                "rows": [],
                "changes": {"cells": [], "column_labels": [], "added_row_ids": [], "deleted_row_ids": []},
                "correction_note": "不要按任务拆分，请按负责人整理",
            },
        }
    )

    assert result.resume_payload["agent_instruction"] == (
        "用户否决了当前表格，并补充意见：不要按任务拆分，请按负责人整理。"
        "请根据该意见重新组织结构化内容，不要继续使用原表格修改结果。"
    )


@pytest.mark.asyncio
async def test_submit_replay_is_idempotent_without_duplicate_event(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    service = A2UIInteractionService(repositories=repositories, dispatcher=dispatcher)
    _create_interaction(repositories, interaction_id="a2ui-1")

    await service.submit(
        {
            "interaction_id": "a2ui-1",
            "request_id": "submit-1",
            "submit_result": {"confirmed": True},
        }
    )
    replayed = await service.submit(
        {
            "interaction_id": "a2ui-1",
            "request_id": "submit-1",
            "submit_result": {"unexpected": "ignored on idempotent replay"},
        }
    )

    assert replayed.should_resume is False
    assert replayed.idempotent is True
    assert replayed.ack_payload["idempotent"] is True
    assert replayed.ack_payload["submit_result"] == {"confirmed": True}
    assert len(dispatcher.events) == 1


@pytest.mark.asyncio
async def test_cancel_success_and_replay_are_idempotent(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    service = A2UIInteractionService(repositories=repositories, dispatcher=dispatcher)
    _create_interaction(repositories, interaction_id="a2ui-1")

    result = await service.cancel(
        {
            "interaction_id": "a2ui-1",
            "request_id": "cancel-1",
            "session_id": "session-1",
            "cancel_reason": "user_cancelled",
        }
    )
    replayed = await service.cancel(
        {
            "interaction_id": "a2ui-1",
            "request_id": "cancel-1",
            "cancel_reason": "ignored",
        }
    )

    assert result.should_resume is True
    assert result.resume_payload == {
        "status": A2UI_STATUS_CANCELLED,
        "interaction_id": "a2ui-1",
        "reason": "user_cancelled",
    }
    assert replayed.should_resume is False
    assert replayed.idempotent is True
    assert replayed.ack_payload["cancel_reason"] == "user_cancelled"
    assert replayed.ack_payload["interaction"]["status"] == A2UI_STATUS_CANCELLED
    assert len(dispatcher.events) == 1
    assert dispatcher.events[0]["event_type"] == DomainEventType.A2UI_CANCELLED.value


@pytest.mark.asyncio
async def test_closed_interactions_reject_opposite_action(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = A2UIInteractionService(
        repositories=repositories,
        dispatcher=RecordingDispatcher(),
    )
    _create_interaction(repositories, interaction_id="submitted")
    _create_interaction(repositories, interaction_id="cancelled")

    await service.submit(
        {
            "interaction_id": "submitted",
            "request_id": "submit-1",
            "submit_result": {"confirmed": True},
        }
    )
    await service.cancel({"interaction_id": "cancelled", "request_id": "cancel-1"})

    with pytest.raises(A2UIInteractionServiceError) as submit_error:
        await service.submit(
            {
                "interaction_id": "cancelled",
                "request_id": "submit-2",
                "submit_result": {"confirmed": True},
            }
        )
    with pytest.raises(A2UIInteractionServiceError) as cancel_error:
        await service.cancel({"interaction_id": "submitted", "request_id": "cancel-2"})

    assert submit_error.value.code == "interaction_already_cancelled"
    assert cancel_error.value.code == "interaction_already_submitted"


@pytest.mark.asyncio
async def test_submit_schema_validation_failure_keeps_interaction_waiting(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    service = A2UIInteractionService(repositories=repositories, dispatcher=dispatcher)
    _create_interaction(repositories, interaction_id="a2ui-1")

    with pytest.raises(A2UIInteractionServiceError) as error:
        await service.submit(
            {
                "interaction_id": "a2ui-1",
                "request_id": "submit-1",
                "submit_result": {},
            }
        )

    assert error.value.code == "schema_validation_failed"
    assert "confirmed" in error.value.message
    assert repositories.a2ui_interactions.get("a2ui-1").status == (
        A2UI_STATUS_WAITING_USER_INPUT
    )
    assert dispatcher.events == []


@pytest.mark.asyncio
async def test_session_mismatch_rejects_mutation(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = A2UIInteractionService(
        repositories=repositories,
        dispatcher=RecordingDispatcher(),
    )
    _create_interaction(repositories, interaction_id="a2ui-1")

    with pytest.raises(A2UIInteractionServiceError) as error:
        await service.cancel(
            {
                "interaction_id": "a2ui-1",
                "request_id": "cancel-1",
                "session_id": "other-session",
            }
        )

    assert error.value.code == "session_mismatch"
    assert repositories.a2ui_interactions.get("a2ui-1").status == (
        A2UI_STATUS_WAITING_USER_INPUT
    )


def _repositories(tmp_path: Path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_interaction(
    repositories: StorageRepositories,
    *,
    interaction_id: str,
    render_key: str = "confirm",
    payload: dict[str, Any] | None = None,
    input_schema: dict[str, Any] | None = None,
    submit_schema_snapshot: dict[str, Any] | None = None,
) -> None:
    repositories.a2ui_interactions.create(
        interaction_id=interaction_id,
        session_id="session-1",
        trace_id="trace-1",
        active_session_id="session-1",
        turn_index=1,
        tool_call_id=f"tool-{interaction_id}",
        stream_id=f"stream-{interaction_id}",
        render_key=render_key,
        mode="interactive",
        payload=payload or {"title": "Confirm"},
        input_schema=input_schema or {"type": "object"},
        submit_schema_snapshot=submit_schema_snapshot or {
            "type": "object",
            "properties": {"confirmed": {"type": "boolean"}},
            "required": ["confirmed"],
            "additionalProperties": False,
        },
        langgraph_thread_id="thread-1",
        checkpoint_ns="",
        checkpoint_id="checkpoint-1",
        interrupt_id=f"interrupt-{interaction_id}",
        resume_group_id="group-1",
    )
