from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.a2ui.registry import build_builtin_a2ui_registry
from backend.app.a2ui.schemas import (
    A2UIInteractionState,
    A2UIObject,
    A2UISchemaValidationError,
    validate_payload,
    validate_submit_result,
    validate_table_payload,
    validate_table_submit_result,
)


def test_a2ui_object_accepts_render_without_interaction() -> None:
    a2ui = A2UIObject(
        render_key="chart",
        mode="render",
        stream_id="stream-1",
        payload={"title": "Chart"},
        input_schema={"type": "object"},
        submit_schema={"type": "object"},
    )

    assert a2ui.render_key == "chart"
    assert a2ui.interaction is None


def test_a2ui_object_requires_interaction_for_interactive() -> None:
    with pytest.raises(ValidationError, match="requires interaction"):
        A2UIObject(
            render_key="choice",
            mode="interactive",
            stream_id="stream-1",
            payload={"title": "选择方案"},
            input_schema={"type": "object"},
            submit_schema={"type": "object"},
        )


def test_a2ui_object_accepts_interactive_interaction_state() -> None:
    a2ui = A2UIObject(
        render_key="choice",
        mode="interactive",
        stream_id="stream-1",
        tool_call_id="tool-call-1",
        payload={"title": "选择方案"},
        input_schema={"type": "object"},
        submit_schema={"type": "object"},
        interaction=A2UIInteractionState(
            interaction_id="a2ui-1",
            status="waiting_user_input",
            can_submit=True,
        ),
    )

    assert a2ui.interaction is not None
    assert a2ui.interaction.interaction_id == "a2ui-1"
    assert a2ui.interaction.can_submit is True


def test_validate_submit_result_accepts_schema_subset() -> None:
    result = validate_submit_result(
        {"confirmed": True, "note": "ok"},
        {
            "type": "object",
            "required": ["confirmed"],
            "properties": {
                "confirmed": {"type": "boolean"},
                "note": {"type": "string", "minLength": 1},
            },
            "additionalProperties": False,
        },
    )

    assert result == {"confirmed": True, "note": "ok"}


def test_builtin_choice_submit_schema_accepts_correction_note() -> None:
    registry = build_builtin_a2ui_registry()
    result = validate_submit_result(
        {
            "selected_values": [],
            "result_type": "correction",
            "correction_note": "换一组更稳妥的方案",
        },
        registry.require("choice").submit_schema,
    )

    assert result == {
        "selected_values": [],
        "result_type": "correction",
        "correction_note": "换一组更稳妥的方案",
    }


def test_validate_submit_result_rejects_missing_required_field() -> None:
    with pytest.raises(A2UISchemaValidationError, match="required"):
        validate_submit_result(
            {"note": "ok"},
            {
                "type": "object",
                "required": ["confirmed"],
                "properties": {"confirmed": {"type": "boolean"}},
            },
        )


def test_validate_submit_result_rejects_additional_property() -> None:
    with pytest.raises(A2UISchemaValidationError, match="additional property"):
        validate_submit_result(
            {"confirmed": True, "extra": "bad"},
            {
                "type": "object",
                "properties": {"confirmed": {"type": "boolean"}},
                "additionalProperties": False,
            },
        )


def test_validate_payload_rejects_number_above_maximum() -> None:
    with pytest.raises(A2UISchemaValidationError, match="above maximum"):
        validate_payload(
            {"ratio": 101},
            {
                "type": "object",
                "properties": {"ratio": {"type": "number", "minimum": 0, "maximum": 100}},
                "additionalProperties": False,
            },
        )


def test_validate_payload_coerces_numeric_strings_for_number_and_integer_fields() -> None:
    result = validate_payload(
        {
            "chart": {
                "items": [
                    {"name": "访问", "value": "1,234"},
                    {"name": "转化", "value": "56.7"},
                ],
                "rank": "2",
            }
        },
        {
            "type": "object",
            "properties": {
                "chart": {
                    "type": "object",
                    "properties": {
                        "items": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string"},
                                    "value": {"type": "number"},
                                },
                                "required": ["name", "value"],
                            },
                        },
                        "rank": {"type": "integer"},
                    },
                }
            },
        },
    )

    assert result == {
        "chart": {
            "items": [
                {"name": "访问", "value": 1234},
                {"name": "转化", "value": 56.7},
            ],
            "rank": 2,
        }
    }


def test_validate_payload_does_not_coerce_numeric_strings_when_string_is_allowed() -> None:
    result = validate_payload(
        {"value": "123"},
        {"type": "object", "properties": {"value": {"type": ["string", "number"]}}},
    )

    assert result == {"value": "123"}


def test_validate_payload_accepts_builtin_interactive_enhancement_fields() -> None:
    registry = build_builtin_a2ui_registry()

    choice = validate_payload(
        {
            "title": "请选择方案",
            "options": [
                {"label": "方案 A", "value": "a", "recommended": True, "badge": "推荐"},
                {"label": "方案 B", "value": "b", "disabled": True},
            ],
            "default_values": ["a"],
        },
        registry.require("choice").input_schema,
    )
    form = validate_payload(
        {
            "title": "补充参数",
            "fields": [
                {
                    "name": "budget",
                    "label": "预算",
                    "type": "number",
                    "default_value": "800",
                    "help": "填写预算",
                    "min": "100",
                    "max": 1000,
                    "step": 10,
                }
            ],
        },
        registry.require("form").input_schema,
    )

    assert choice["options"][0]["recommended"] is True
    assert form["fields"][0]["min"] == 100


def test_validate_table_payload_normalizes_rows_and_numeric_values() -> None:
    payload = validate_table_payload(
        {
            "title": "计划审阅",
            "columns": [
                {"key": "task", "label": "任务", "type": "text", "required": True},
                {"key": "effort", "label": "工作量", "type": "number"},
                {
                    "key": "priority",
                    "label": "优先级",
                    "type": "select",
                    "options": [
                        {"label": "高", "value": "high"},
                        {"label": "低", "value": "low"},
                    ],
                },
            ],
            "rows": [
                {
                    "id": "task-1",
                    "values": {"task": "需求分析", "effort": "1,200", "priority": "high"},
                }
            ],
        }
    )

    assert payload["rows"] == [
        {
            "id": "task-1",
            "values": {"task": "需求分析", "effort": 1200, "priority": "high"},
        }
    ]


@pytest.mark.parametrize(
    ("patch", "error"),
    [
        ({"columns": [{"key": "task", "label": "重复", "type": "text"}]}, "duplicate column key"),
        ({"rows": [{"id": "row-1", "values": {"unknown": "x"}}]}, "unknown column key"),
        ({"rows": [{"id": "row-1", "values": {"task": ""}}]}, "required value"),
    ],
)
def test_validate_table_payload_rejects_unstable_or_invalid_contract(
    patch: dict[str, object],
    error: str,
) -> None:
    payload: dict[str, object] = {
        "title": "计划审阅",
        "columns": [{"key": "task", "label": "任务", "type": "text", "required": True}],
        "rows": [{"id": "row-1", "values": {"task": "需求分析"}}],
    }
    for key, value in patch.items():
        if key == "columns":
            payload["columns"] = [*payload["columns"], *value]  # type: ignore[arg-type]
        else:
            payload[key] = value

    with pytest.raises(A2UISchemaValidationError, match=error):
        validate_table_payload(payload)


def test_validate_table_submit_result_recomputes_diff_from_final_snapshot() -> None:
    original = {
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

    result = validate_table_submit_result(
        original,
        {
            "result_type": "table",
            "columns": [
                {"key": "task", "label": "工作项"},
                {"key": "effort", "label": "工作量"},
            ],
            "rows": [
                {"id": "row-1", "values": {"task": "需求澄清", "effort": 2}},
                {"id": "row-3", "values": {"task": "测试", "effort": "3"}},
            ],
            "changes": {"cells": [], "column_labels": [], "added_row_ids": [], "deleted_row_ids": []},
        },
    )

    assert result["rows"][1]["values"]["effort"] == 3
    assert result["changes"] == {
        "cells": [
            {
                "row_id": "row-1",
                "column_key": "task",
                "old_value": "需求分析",
                "new_value": "需求澄清",
            }
        ],
        "column_labels": [
            {"column_key": "task", "old_label": "任务", "new_label": "工作项"}
        ],
        "added_row_ids": ["row-3"],
        "deleted_row_ids": ["row-2"],
    }


def test_validate_table_submit_result_requires_correction_note_and_canonicalizes_payload() -> None:
    original = {
        "title": "计划审阅",
        "columns": [{"key": "task", "label": "任务", "type": "text"}],
        "rows": [{"id": "row-1", "values": {"task": "需求分析"}}],
    }

    with pytest.raises(A2UISchemaValidationError, match="correction note"):
        validate_table_submit_result(
            original,
            {
                "result_type": "correction",
                "columns": [],
                "rows": [],
                "changes": {"cells": [], "column_labels": [], "added_row_ids": [], "deleted_row_ids": []},
            },
        )

    result = validate_table_submit_result(
        original,
        {
            "result_type": "correction",
            "columns": [],
            "rows": [],
            "changes": {"cells": [], "column_labels": [], "added_row_ids": [], "deleted_row_ids": []},
            "correction_note": "列不对，请按负责人分组",
        },
    )
    assert result["correction_note"] == "列不对，请按负责人分组"
    assert result["rows"] == []


@pytest.mark.parametrize("value", ["12万", "1,2", "", "NaN", "Infinity"])
def test_validate_payload_rejects_non_strict_numeric_strings(value: str) -> None:
    with pytest.raises(A2UISchemaValidationError, match="expected number"):
        validate_payload(
            {"value": value},
            {"type": "object", "properties": {"value": {"type": "number"}}},
        )
