from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.app.storage import A2UIInteractionRecord

A2UIMode = Literal["render", "interactive"]
A2UIInteractionStatus = Literal["waiting_user_input", "submitted", "cancelled"]
A2UIResumeStatus = Literal["not_started", "deferred", "started", "succeeded", "failed"]


class A2UISchemaValidationError(ValueError):
    pass


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
    _validate_schema_value(submit_result, submit_schema_snapshot, path="$")
    return dict(submit_result)


def validate_payload(
    payload: Any,
    input_schema: dict[str, Any],
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise A2UISchemaValidationError("payload must be an object")
    _validate_schema_value(payload, input_schema, path="$")
    return dict(payload)


def _validate_schema_value(value: Any, schema: dict[str, Any], *, path: str) -> None:
    if not isinstance(schema, dict):
        raise A2UISchemaValidationError(f"{path}: schema must be an object")

    expected_type = schema.get("type")
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
            for index, item in enumerate(value):
                _validate_schema_value(item, item_schema, path=f"{path}[{index}]")

    if isinstance(value, dict):
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
                _validate_schema_value(item, item_schema, path=f"{path}.{key}")
                continue
            if schema.get("additionalProperties") is False:
                raise A2UISchemaValidationError(f"{path}.{key}: additional property is not allowed")


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
