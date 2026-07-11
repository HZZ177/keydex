from __future__ import annotations

import math
import re
from datetime import date
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.app.storage import A2UIInteractionRecord

A2UIMode = Literal["render", "interactive"]
A2UIInteractionStatus = Literal["waiting_user_input", "submitted", "cancelled"]
A2UIResumeStatus = Literal["not_started", "deferred", "started", "succeeded", "failed"]


class A2UISchemaValidationError(ValueError):
    pass


_INTEGER_TEXT_PATTERN = re.compile(r"^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)$")
_NUMBER_TEXT_PATTERN = re.compile(
    r"^[+-]?(?:(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$"
)
_TABLE_COLUMN_TYPES = frozenset({"text", "number", "boolean", "select", "date"})


class A2UIInteractionState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    interaction_id: str = Field(min_length=1)
    status: A2UIInteractionStatus
    can_submit: bool
    submit_request_id: str | None = None
    cancel_request_id: str | None = None
    submit_result: dict[str, Any] | None = None
    cancel_reason: str | None = None
    resume_status: A2UIResumeStatus = "not_started"
    resume_group_id: str | None = None
    pending_count: int | None = Field(default=None, ge=0)
    resume_error: str | None = None


class A2UIObject(BaseModel):
    model_config = ConfigDict(extra="forbid")

    render_key: str = Field(min_length=1)
    mode: A2UIMode
    stream_id: str = Field(min_length=1)
    tool_call_id: str | None = None
    trace_id: str | None = None
    turn_index: int | None = None
    payload: dict[str, Any]
    input_schema: dict[str, Any]
    submit_schema: dict[str, Any]
    interaction: A2UIInteractionState | None = None

    @field_validator("payload", "input_schema", "submit_schema")
    @classmethod
    def validate_object_fields(cls, value: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise ValueError("must be an object")
        return dict(value)

    @model_validator(mode="after")
    def require_interaction_for_interactive(self) -> A2UIObject:
        if self.mode == "interactive" and self.interaction is None:
            raise ValueError("interactive A2UI requires interaction")
        return self


class A2UISubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    interaction_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    session_id: str | None = Field(default=None, min_length=1)
    submit_result: dict[str, Any]

    @field_validator("submit_result")
    @classmethod
    def validate_submit_result_object(cls, value: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise ValueError("submit_result must be an object")
        return dict(value)


class A2UICancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    interaction_id: str = Field(min_length=1)
    request_id: str = Field(min_length=1)
    session_id: str | None = Field(default=None, min_length=1)
    cancel_reason: str | None = None


class A2UIResumeSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: A2UIResumeStatus
    resume_group_id: str | None = None
    pending_count: int = Field(default=0, ge=0)
    error: str | None = None


def interaction_state_from_record(
    record: A2UIInteractionRecord,
    *,
    pending_count: int | None = None,
) -> A2UIInteractionState:
    return A2UIInteractionState(
        interaction_id=record.id,
        status=record.status,
        can_submit=record.can_submit,
        submit_request_id=record.submit_request_id,
        cancel_request_id=record.cancel_request_id,
        submit_result=record.submit_result,
        cancel_reason=record.cancel_reason,
        resume_status=record.resume_status,
        resume_group_id=record.resume_group_id,
        pending_count=pending_count,
        resume_error=record.resume_error,
    )


def a2ui_object_from_record(
    record: A2UIInteractionRecord,
    *,
    pending_count: int | None = None,
) -> A2UIObject:
    return A2UIObject(
        render_key=record.render_key,
        mode=record.mode,
        stream_id=record.stream_id,
        tool_call_id=record.tool_call_id,
        trace_id=record.trace_id,
        turn_index=record.turn_index,
        payload=record.payload,
        input_schema=record.input_schema,
        submit_schema=record.submit_schema_snapshot,
        interaction=interaction_state_from_record(record, pending_count=pending_count),
    )


def validate_submit_result(
    submit_result: Any,
    submit_schema_snapshot: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(submit_result, dict):
        raise A2UISchemaValidationError("submit_result must be an object")
    return _validate_schema_value(dict(submit_result), submit_schema_snapshot, path="$")


def validate_payload(
    payload: Any,
    input_schema: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise A2UISchemaValidationError("payload must be an object")
    return _validate_schema_value(dict(payload), input_schema, path="$")


def validate_table_payload(payload: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(payload)
    columns = _validate_table_columns(normalized.get("columns"), path="$.columns")
    normalized["columns"] = columns
    normalized["rows"] = _validate_table_rows(
        normalized.get("rows"),
        columns=columns,
        path="$.rows",
    )
    return normalized


def validate_table_submit_result(
    original_payload: dict[str, Any],
    submit_result: dict[str, Any],
) -> dict[str, Any]:
    result_type = str(submit_result.get("result_type") or "").strip()
    if result_type == "correction":
        correction_note = str(submit_result.get("correction_note") or "").strip()
        if not correction_note:
            raise A2UISchemaValidationError("$.correction_note: correction note is required")
        return {
            "result_type": "correction",
            "columns": [],
            "rows": [],
            "changes": _empty_table_changes(),
            "correction_note": correction_note,
        }
    if result_type != "table":
        raise A2UISchemaValidationError("$.result_type: value is not in enum")

    original = validate_table_payload(original_payload)
    original_columns = original["columns"]
    submitted_columns = _validate_submitted_table_columns(
        submit_result.get("columns"),
        original_columns=original_columns,
    )
    submitted_rows = _validate_table_rows(
        submit_result.get("rows"),
        columns=original_columns,
        path="$.rows",
    )
    _validate_table_row_mutation_permissions(
        original_rows=original["rows"],
        submitted_rows=submitted_rows,
        allow_add_rows=original.get("allow_add_rows") is True,
        allow_delete_rows=original.get("allow_delete_rows") is True,
    )
    return {
        "result_type": "table",
        "columns": submitted_columns,
        "rows": submitted_rows,
        "changes": _build_table_changes(
            original_columns=original_columns,
            submitted_columns=submitted_columns,
            original_rows=original["rows"],
            submitted_rows=submitted_rows,
        ),
    }


def _validate_table_columns(value: Any, *, path: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise A2UISchemaValidationError(f"{path}: array has too few items")
    columns: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise A2UISchemaValidationError(f"{path}[{index}]: expected object")
        column = dict(item)
        key = str(column.get("key") or "").strip()
        label = str(column.get("label") or "").strip()
        column_type = str(column.get("type") or "").strip().lower()
        if not key:
            raise A2UISchemaValidationError(f"{path}[{index}].key: string is too short")
        if key in seen_keys:
            raise A2UISchemaValidationError(f"{path}[{index}].key: duplicate column key")
        if not label:
            raise A2UISchemaValidationError(f"{path}[{index}].label: string is too short")
        if column_type not in _TABLE_COLUMN_TYPES:
            raise A2UISchemaValidationError(f"{path}[{index}].type: value is not in enum")
        options = column.get("options")
        if column_type == "select":
            if not isinstance(options, list) or not options:
                raise A2UISchemaValidationError(f"{path}[{index}].options: select column requires options")
            option_values: set[str] = set()
            normalized_options: list[dict[str, Any]] = []
            for option_index, option in enumerate(options):
                if not isinstance(option, dict):
                    raise A2UISchemaValidationError(
                        f"{path}[{index}].options[{option_index}]: expected object"
                    )
                option_value = str(option.get("value") or "").strip()
                option_label = str(option.get("label") or "").strip()
                if not option_value or not option_label:
                    raise A2UISchemaValidationError(
                        f"{path}[{index}].options[{option_index}]: label and value are required"
                    )
                if option_value in option_values:
                    raise A2UISchemaValidationError(
                        f"{path}[{index}].options[{option_index}].value: duplicate option value"
                    )
                option_values.add(option_value)
                normalized_options.append({**option, "value": option_value, "label": option_label})
            column["options"] = normalized_options
        elif options is not None:
            column.pop("options", None)
        column.update({"key": key, "label": label, "type": column_type})
        columns.append(column)
        seen_keys.add(key)
    return columns


def _validate_table_rows(
    value: Any,
    *,
    columns: list[dict[str, Any]],
    path: str,
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise A2UISchemaValidationError(f"{path}: expected array")
    column_by_key = {str(column["key"]): column for column in columns}
    rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise A2UISchemaValidationError(f"{path}[{index}]: expected object")
        row_id = str(item.get("id") or "").strip()
        if not row_id:
            raise A2UISchemaValidationError(f"{path}[{index}].id: string is too short")
        if row_id in seen_ids:
            raise A2UISchemaValidationError(f"{path}[{index}].id: duplicate row id")
        raw_values = item.get("values")
        if not isinstance(raw_values, dict):
            raise A2UISchemaValidationError(f"{path}[{index}].values: expected object")
        unknown_keys = sorted(set(raw_values) - set(column_by_key))
        if unknown_keys:
            raise A2UISchemaValidationError(
                f"{path}[{index}].values.{unknown_keys[0]}: unknown column key"
            )
        normalized_values: dict[str, Any] = {}
        for column_key, column in column_by_key.items():
            cell_path = f"{path}[{index}].values.{column_key}"
            if column_key not in raw_values:
                if column.get("required") is True:
                    raise A2UISchemaValidationError(f"{cell_path}: required value is missing")
                normalized_values[column_key] = None
                continue
            normalized_values[column_key] = _normalize_table_cell_value(
                raw_values[column_key],
                column=column,
                path=cell_path,
            )
        rows.append({"id": row_id, "values": normalized_values})
        seen_ids.add(row_id)
    return rows


def _normalize_table_cell_value(value: Any, *, column: dict[str, Any], path: str) -> Any:
    required = column.get("required") is True
    if value is None or (isinstance(value, str) and not value.strip()):
        if required:
            raise A2UISchemaValidationError(f"{path}: required value is missing")
        return None
    column_type = str(column["type"])
    if column_type == "number":
        normalized = _coerce_json_type(value, "number")
        if not _matches_json_type(normalized, "number"):
            raise A2UISchemaValidationError(f"{path}: expected number")
        return normalized
    if column_type == "boolean":
        if not isinstance(value, bool):
            raise A2UISchemaValidationError(f"{path}: expected boolean")
        return value
    if not isinstance(value, str):
        raise A2UISchemaValidationError(f"{path}: expected string")
    normalized_text = value.strip()
    if column_type == "select":
        allowed_values = {
            str(option.get("value") or "")
            for option in column.get("options") or []
            if isinstance(option, dict) and option.get("disabled") is not True
        }
        if normalized_text not in allowed_values:
            raise A2UISchemaValidationError(f"{path}: value is not in select options")
    if column_type == "date":
        try:
            date.fromisoformat(normalized_text)
        except ValueError as exc:
            raise A2UISchemaValidationError(f"{path}: expected ISO date") from exc
    return normalized_text


def _validate_submitted_table_columns(
    value: Any,
    *,
    original_columns: list[dict[str, Any]],
) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise A2UISchemaValidationError("$.columns: expected array")
    original_keys = [str(column["key"]) for column in original_columns]
    submitted: list[dict[str, str]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise A2UISchemaValidationError(f"$.columns[{index}]: expected object")
        key = str(item.get("key") or "").strip()
        label = str(item.get("label") or "").strip()
        if not key or not label:
            raise A2UISchemaValidationError(f"$.columns[{index}]: key and label are required")
        submitted.append({"key": key, "label": label})
    if [column["key"] for column in submitted] != original_keys:
        raise A2UISchemaValidationError("$.columns: stable column keys or order changed")
    return submitted


def _validate_table_row_mutation_permissions(
    *,
    original_rows: list[dict[str, Any]],
    submitted_rows: list[dict[str, Any]],
    allow_add_rows: bool,
    allow_delete_rows: bool,
) -> None:
    original_ids = {str(row["id"]) for row in original_rows}
    submitted_ids = {str(row["id"]) for row in submitted_rows}
    if not allow_add_rows and submitted_ids - original_ids:
        raise A2UISchemaValidationError("$.rows: adding rows is not allowed")
    if not allow_delete_rows and original_ids - submitted_ids:
        raise A2UISchemaValidationError("$.rows: deleting rows is not allowed")


def _build_table_changes(
    *,
    original_columns: list[dict[str, Any]],
    submitted_columns: list[dict[str, str]],
    original_rows: list[dict[str, Any]],
    submitted_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    original_by_id = {str(row["id"]): row for row in original_rows}
    submitted_by_id = {str(row["id"]): row for row in submitted_rows}
    shared_ids = [str(row["id"]) for row in original_rows if str(row["id"]) in submitted_by_id]
    cells: list[dict[str, Any]] = []
    for row_id in shared_ids:
        old_values = original_by_id[row_id]["values"]
        new_values = submitted_by_id[row_id]["values"]
        for column in original_columns:
            column_key = str(column["key"])
            if old_values.get(column_key) == new_values.get(column_key):
                continue
            cells.append(
                {
                    "row_id": row_id,
                    "column_key": column_key,
                    "old_value": old_values.get(column_key),
                    "new_value": new_values.get(column_key),
                }
            )
    column_labels = [
        {
            "column_key": str(original["key"]),
            "old_label": str(original["label"]),
            "new_label": submitted["label"],
        }
        for original, submitted in zip(original_columns, submitted_columns, strict=True)
        if str(original["label"]) != submitted["label"]
    ]
    return {
        "cells": cells,
        "column_labels": column_labels,
        "added_row_ids": [str(row["id"]) for row in submitted_rows if str(row["id"]) not in original_by_id],
        "deleted_row_ids": [str(row["id"]) for row in original_rows if str(row["id"]) not in submitted_by_id],
    }


def _empty_table_changes() -> dict[str, list[Any]]:
    return {
        "cells": [],
        "column_labels": [],
        "added_row_ids": [],
        "deleted_row_ids": [],
    }


def _validate_schema_value(value: Any, schema: dict[str, Any], *, path: str) -> Any:
    if not isinstance(schema, dict):
        raise A2UISchemaValidationError(f"{path}: schema must be an object")

    expected_type = schema.get("type")
    value = _coerce_json_type(value, expected_type)
    if expected_type is not None and not _matches_json_type(value, expected_type):
        raise A2UISchemaValidationError(f"{path}: expected {expected_type}")

    enum_values = schema.get("enum")
    if enum_values is not None and value not in enum_values:
        raise A2UISchemaValidationError(f"{path}: value is not in enum")

    if isinstance(value, str):
        min_length = schema.get("minLength")
        if min_length is not None and len(value) < int(min_length):
            raise A2UISchemaValidationError(f"{path}: string is too short")

    if isinstance(value, int | float):
        if "minimum" in schema and value < schema["minimum"]:
            raise A2UISchemaValidationError(f"{path}: value is below minimum")
        if "maximum" in schema and value > schema["maximum"]:
            raise A2UISchemaValidationError(f"{path}: value is above maximum")

    if isinstance(value, list):
        min_items = schema.get("minItems")
        if min_items is not None and len(value) < int(min_items):
            raise A2UISchemaValidationError(f"{path}: array has too few items")
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            value = [
                _validate_schema_value(item, item_schema, path=f"{path}[{index}]")
                for index, item in enumerate(value)
            ]

    if isinstance(value, dict):
        value = dict(value)
        required = schema.get("required") or []
        for key in required:
            if key not in value:
                raise A2UISchemaValidationError(f"{path}.{key}: required field is missing")
        properties = schema.get("properties") or {}
        if not isinstance(properties, dict):
            properties = {}
        for key, item in value.items():
            item_schema = properties.get(key)
            if isinstance(item_schema, dict):
                value[key] = _validate_schema_value(item, item_schema, path=f"{path}.{key}")
                continue
            if schema.get("additionalProperties") is False:
                raise A2UISchemaValidationError(f"{path}.{key}: additional property is not allowed")

    return value


def _coerce_json_type(value: Any, expected_type: Any) -> Any:
    if not isinstance(value, str):
        return value
    if expected_type is None:
        return value
    if isinstance(expected_type, list):
        if _matches_json_type(value, expected_type):
            return value
        if "integer" in expected_type:
            coerced = _coerce_integer_text(value)
            if coerced is not None:
                return coerced
        if "number" in expected_type:
            coerced = _coerce_number_text(value)
            if coerced is not None:
                return coerced
        return value
    if expected_type == "integer":
        coerced = _coerce_integer_text(value)
        return value if coerced is None else coerced
    if expected_type == "number":
        coerced = _coerce_number_text(value)
        return value if coerced is None else coerced
    return value


def _coerce_integer_text(value: str) -> int | None:
    text = value.strip()
    if not _INTEGER_TEXT_PATTERN.fullmatch(text):
        return None
    return int(text.replace(",", ""))


def _coerce_number_text(value: str) -> int | float | None:
    text = value.strip()
    if not _NUMBER_TEXT_PATTERN.fullmatch(text):
        return None
    normalized = text.replace(",", "")
    if _INTEGER_TEXT_PATTERN.fullmatch(text):
        return int(normalized)
    parsed = float(normalized)
    return parsed if math.isfinite(parsed) else None


def _matches_json_type(value: Any, expected_type: Any) -> bool:
    if isinstance(expected_type, list):
        return any(_matches_json_type(value, item) for item in expected_type)
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    if expected_type == "null":
        return value is None
    return True
