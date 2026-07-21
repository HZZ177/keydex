from __future__ import annotations

from langchain_core.messages import ToolMessage

from backend.app.agent.event_processor import (
    _keydex_display_payload,
    _structured_tool_output,
    _tool_files_from_structured_output,
)


def test_event_projection_prefers_keydex_display_payload() -> None:
    display = {
        "kind": "search_text",
        "items": [{"path": "visible.py", "line": 3}],
    }
    message = ToolMessage(
        content='{"kind":"legacy","items":[{"path":"hidden.py"}]}',
        tool_call_id="call-1",
        artifact={
            "schema_version": "keydex.tool_artifact.v1",
            "display_payload": display,
            "projection": {},
            "persisted_ref": None,
        },
    )
    assert _structured_tool_output(message) == display


def test_legacy_tool_message_falls_back_to_content() -> None:
    message = ToolMessage(
        content='{"kind":"legacy","value":1}',
        tool_call_id="call-legacy",
    )
    assert _keydex_display_payload(message) is None
    assert _structured_tool_output(message) == {"kind": "legacy", "value": 1}


def test_projected_file_items_drive_ui_file_extraction() -> None:
    message = ToolMessage(
        content='{"files":[]}',
        tool_call_id="call-files",
        artifact={
            "schema_version": "keydex.tool_artifact.v1",
            "display_payload": {
                "files": [{"path": "a.py", "action": "modified"}],
            },
            "projection": {},
            "persisted_ref": None,
        },
    )
    assert _tool_files_from_structured_output(_structured_tool_output(message))[0]["path"] == "a.py"


def test_non_keydex_artifact_is_not_exposed_to_ui() -> None:
    message = ToolMessage(
        content='{"safe":true}',
        tool_call_id="call-third-party",
        artifact={"full_payload": {"secret": "not public"}},
    )
    assert _structured_tool_output(message) == {"safe": True}
