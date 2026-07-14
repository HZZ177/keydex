from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.api.sessions import (
    SessionReverseFileResponse,
    SessionReversePreviewResponse,
    SessionReverseRequest,
)


def test_reverse_request_strongly_validates_mode_and_decision() -> None:
    request = SessionReverseRequest(
        message_event_id="message-1",
        operation_id="operation-1",
        mode="both",
        decision="force_conflicts",
        preview_token="token-1",
        request_id="request-1",
    )
    assert request.mode.value == "both"
    assert request.decision.value == "force_conflicts"

    with pytest.raises(ValidationError):
        SessionReverseRequest(mode="everything")
    with pytest.raises(ValidationError):
        SessionReverseRequest(decision="ignore_everything")


def test_legacy_reverse_payload_defaults_to_conversation_only() -> None:
    request = SessionReverseRequest(message_event_id="message-1", user_id="user-1")
    assert request.mode.value == "conversation"
    assert request.decision.value == "full"
    assert request.request_id


def test_reverse_file_response_rejects_absolute_or_traversing_paths() -> None:
    common = {
        "current_state": "file",
        "target_state": "missing",
        "classification": "ready",
    }
    with pytest.raises(ValidationError):
        SessionReverseFileResponse(path="C:/private/file.txt", **common)
    with pytest.raises(ValidationError):
        SessionReverseFileResponse(path="../private.txt", **common)

    preview = SessionReversePreviewResponse(
        operation_id="operation-1",
        source={"message_event_id": "message-1"},
        conversation_available=True,
        code_available=True,
        default_mode="both",
        snapshot_id="snapshot-1",
        preview_token="token-1",
        files=[SessionReverseFileResponse(path="src/file.txt", **common)],
    )
    assert preview.files[0].path == "src/file.txt"
