from __future__ import annotations

from typing import Any

from backend.app.services import MessageEventService
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-web-history",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


def _append(
    repositories: StorageRepositories,
    event_id: str,
    action: str,
    data: dict[str, Any],
) -> None:
    repositories.message_events.append(
        event_id=event_id,
        session_id="ses-web-history",
        turn_index=1,
        action=action,
        data=data,
    )


def _payload(status: str = "completed") -> dict[str, Any]:
    return {
        "kind": "web_activity",
        "schema_version": 1,
        "activity_type": "search",
        "status": status,
        "query": "latest",
        "requested_urls": [],
        "sources": (
            [
                {
                    "source_id": "src_1",
                    "url": "https://example.com/a",
                    "domain": "example.com",
                    "title": "Example",
                    "snippet": "Summary",
                    "favicon": None,
                    "published_at": None,
                    "truncated": False,
                }
            ]
            if status == "completed"
            else []
        ),
        "items": [],
        "error": None,
        "started_at_ms": 100,
        "ended_at_ms": 120 if status != "running" else None,
        "duration_ms": 20 if status != "running" else None,
    }


def test_web_activity_roundtrips_through_history_and_deferred_summary(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)
    _append(
        repositories,
        "evt-start",
        "tool_start",
        {
            "tool": "web_search",
            "run_id": "run-web",
            "tool_call_id": "call-web",
            "params": {"query": "latest"},
            "ui_payload": _payload("running"),
        },
    )
    _append(
        repositories,
        "evt-end",
        "tool_end",
        {
            "tool": "web_search",
            "run_id": "run-web",
            "tool_call_id": "call-web",
            "status": "completed",
            "result": "bounded",
            "ui_payload": _payload(),
        },
    )

    full = service.get_display_messages("ses-web-history")
    deferred = service.get_display_messages(
        "ses-web-history",
        include_tool_details=False,
    )

    assert full[0]["uiPayload"] == _payload()
    assert deferred[0]["uiPayload"] == _payload()
    assert deferred[0]["toolDetailsDeferred"] is True
    assert full[0]["toolDetailRef"] == {
        "startEventId": "evt-start",
        "endEventId": "evt-end",
        "runId": "run-web",
        "toolCallId": "call-web",
    }


def test_running_web_activity_is_restored_from_start_event(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)
    _append(
        repositories,
        "evt-start",
        "tool_start",
        {
            "tool": "web_search",
            "run_id": "run-web",
            "ui_payload": _payload("running"),
        },
    )

    messages = service.get_display_messages("ses-web-history")

    assert messages[0]["status"] == "running"
    assert messages[0]["uiPayload"]["status"] == "running"


def test_cancelled_web_activity_restores_cancelled_status(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)
    _append(
        repositories,
        "evt-start",
        "tool_start",
        {
            "tool": "web_search",
            "run_id": "run-web",
            "ui_payload": _payload("running"),
        },
    )
    _append(
        repositories,
        "evt-end",
        "tool_end",
        {
            "tool": "web_search",
            "run_id": "run-web",
            "status": "cancelled",
            "ui_payload": _payload("cancelled"),
        },
    )

    messages = service.get_display_messages("ses-web-history")

    assert messages[0]["status"] == "cancelled"
    assert messages[0]["uiPayload"]["status"] == "cancelled"


def test_web_activity_lazy_detail_matches_history_payload(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)
    _append(
        repositories,
        "evt-start",
        "tool_start",
        {"tool": "web_search", "run_id": "run-web", "ui_payload": _payload("running")},
    )
    _append(
        repositories,
        "evt-end",
        "tool_end",
        {"tool": "web_search", "run_id": "run-web", "ui_payload": _payload()},
    )

    detail = service.get_tool_detail(
        session_id="ses-web-history",
        start_event_id="evt-start",
        end_event_id="evt-end",
    )

    assert detail is not None
    assert detail["uiPayload"] == _payload()
    assert detail["status"] == "completed"


def test_unknown_web_activity_schema_falls_back_without_crashing(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = MessageEventService(repositories.message_events)
    unknown = {**_payload(), "schema_version": 2, "raw_response": "hidden"}
    _append(
        repositories,
        "evt-start",
        "tool_start",
        {"tool": "web_search", "run_id": "run-web", "ui_payload": unknown},
    )
    _append(
        repositories,
        "evt-end",
        "tool_end",
        {"tool": "web_search", "run_id": "run-web", "ui_payload": unknown},
    )

    messages = service.get_display_messages("ses-web-history")

    assert "uiPayload" not in messages[0]
    assert messages[0]["status"] == "completed"
