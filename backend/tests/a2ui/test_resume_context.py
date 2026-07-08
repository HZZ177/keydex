from __future__ import annotations

from backend.app.a2ui.resume_context import build_a2ui_resume_context


def test_same_render_key_consumes_exact_tool_call_id_without_old_payload() -> None:
    first = {"render_key": "confirm", "interaction_id": "a2ui-1"}
    second = {"render_key": "confirm", "interaction_id": "a2ui-2"}
    context = build_a2ui_resume_context(
        payloads_by_tool_call_id={"tool-1": first, "tool-2": second},
        payloads_by_render_key={"confirm": [first, second]},
    )

    consumed = context.consume(render_key="confirm", tool_call_id="tool-2")

    assert consumed == second
    assert context.payloads_by_tool_call_id == {"tool-1": first}
    assert context.payloads_by_render_key == {"confirm": [first]}


def test_no_tool_call_id_does_not_fallback_when_tool_call_payload_exists() -> None:
    payload = {"render_key": "confirm", "interaction_id": "a2ui-1"}
    context = build_a2ui_resume_context(
        payloads_by_tool_call_id={"tool-1": payload},
        payloads_by_render_key={"confirm": [payload]},
    )

    assert context.consume(render_key="confirm", tool_call_id=None) is None
    assert context.payloads_by_tool_call_id == {"tool-1": payload}
    assert context.payloads_by_render_key == {"confirm": [payload]}


def test_no_tool_call_id_does_not_fallback_for_payload_without_render_key() -> None:
    payload = {"interaction_id": "a2ui-1", "submit_result": {"confirmed": True}}
    context = build_a2ui_resume_context(
        payloads_by_tool_call_id={"tool-1": payload},
        payloads_by_render_key={"confirm": [payload]},
    )

    assert context.consume(render_key="confirm", tool_call_id=None) is None
    assert context.payloads_by_tool_call_id == {"tool-1": payload}
    assert context.payloads_by_render_key == {"confirm": [payload]}


def test_render_key_alias_can_be_consumed_when_no_tool_call_payload_exists() -> None:
    payload = {"render_key": "confirm", "interaction_id": "a2ui-1"}
    context = build_a2ui_resume_context(
        payloads_by_render_key={"confirm": [payload]},
    )

    assert context.consume(render_key="confirm") == payload
    assert context.payloads_by_render_key == {}
