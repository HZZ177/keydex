from __future__ import annotations

import pytest

from backend.app.services.lifecycle_events import LifecycleEventPublisher


class _RecordingManager:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    async def broadcast_all(self, *, action: str, data: dict) -> None:
        self.calls.append((action, data))


@pytest.mark.parametrize(
    ("event_type", "entity_field"),
    [
        ("session_archived", "session_id"),
        ("session_restored", "session_id"),
        ("session_purged", "session_id"),
        ("workspace_archived", "workspace_id"),
        ("workspace_restored", "workspace_id"),
        ("workspace_purged", "workspace_id"),
    ],
)
def test_lifecycle_publisher_broadcasts_each_safe_typed_event(
    event_type: str,
    entity_field: str,
) -> None:
    manager = _RecordingManager()
    publisher = LifecycleEventPublisher(manager)
    event = {
        "type": event_type,
        entity_field: "entity-1",
        "operation_id": "op-1",
        "request_id": "req-1",
        "occurred_at": "2026-07-14T00:00:00Z",
        "revision": 3,
        "changed": True,
    }

    publisher.publish(event)

    assert manager.calls == [(event_type, event)]


def test_lifecycle_publisher_rejects_sensitive_or_incomplete_payload() -> None:
    publisher = LifecycleEventPublisher(_RecordingManager())
    base = {
        "type": "session_archived",
        "session_id": "session-1",
        "operation_id": "op-1",
        "request_id": "req-1",
        "occurred_at": "2026-07-14T00:00:00Z",
        "revision": 3,
        "changed": True,
    }

    with pytest.raises(ValueError, match="forbidden"):
        publisher.publish({**base, "title": "private title"})
    with pytest.raises(ValueError, match="missing fields"):
        publisher.publish({key: value for key, value in base.items() if key != "revision"})
