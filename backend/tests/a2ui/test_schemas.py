from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.a2ui.schemas import (
    A2UIInteractionState,
    A2UIObject,
    A2UISchemaValidationError,
    validate_payload,
    validate_submit_result,
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
            render_key="confirm",
            mode="interactive",
            stream_id="stream-1",
            payload={"title": "Confirm"},
            input_schema={"type": "object"},
            submit_schema={"type": "object"},
        )


def test_a2ui_object_accepts_interactive_interaction_state() -> None:
    a2ui = A2UIObject(
        render_key="confirm",
        mode="interactive",
        stream_id="stream-1",
        tool_call_id="tool-call-1",
        payload={"title": "Confirm"},
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
