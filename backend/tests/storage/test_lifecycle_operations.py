from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest

from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def test_lifecycle_operation_create_replay_and_revision_cas(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    created = repositories.lifecycle_operations.create_or_replay(
        request_id="req-archive-1",
        entity_type="session",
        entity_id="ses-operation",
        action="archive",
        payload={"stop_if_active": False},
    )
    replay = repositories.lifecycle_operations.create_or_replay(
        request_id="req-archive-1",
        entity_type="session",
        entity_id="ses-operation",
        action="archive",
        payload={"stop_if_active": False},
    )
    claimed = repositories.lifecycle_operations.update(
        created.operation.id,
        expected_revision=1,
        state="running",
        counts={"blockers": 0},
    )
    stale = repositories.lifecycle_operations.update(
        created.operation.id,
        expected_revision=1,
        state="failed",
    )
    completed = repositories.lifecycle_operations.update(
        created.operation.id,
        expected_revision=2,
        state="completed",
        result={"changed": True},
        completed=True,
    )

    assert created.created is True
    assert replay.created is False
    assert replay.operation.id == created.operation.id
    assert claimed is not None
    assert claimed.revision == 2
    assert claimed.counts == {"blockers": 0}
    assert stale is None
    assert completed is not None
    assert completed.revision == 3
    assert completed.completed_at is not None
    assert completed.result == {"changed": True}


def test_lifecycle_request_id_rejects_payload_or_action_reuse(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.lifecycle_operations.create_or_replay(
        request_id="req-conflict",
        entity_type="workspace",
        entity_id="ws-operation",
        action="archive",
        payload={"stop_active_sessions": False},
    )

    with pytest.raises(ValueError, match="不同的生命周期请求"):
        repositories.lifecycle_operations.create_or_replay(
            request_id="req-conflict",
            entity_type="workspace",
            entity_id="ws-operation",
            action="archive",
            payload={"stop_active_sessions": True},
        )
    with pytest.raises(ValueError, match="不同的生命周期请求"):
        repositories.lifecycle_operations.create_or_replay(
            request_id="req-conflict",
            entity_type="workspace",
            entity_id="ws-operation",
            action="restore",
            payload={"stop_active_sessions": False},
        )


def test_lifecycle_lock_has_single_owner_and_can_expire_or_release(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    operations = [
        repositories.lifecycle_operations.create_or_replay(
            request_id=f"req-lock-{index}",
            entity_type="session",
            entity_id="ses-lock",
            action="archive",
            payload={"index": index},
        ).operation
        for index in range(2)
    ]
    now = datetime(2026, 7, 14, 1, 0, tzinfo=UTC)

    def acquire(operation_id: str) -> bool:
        return repositories.lifecycle_operations.acquire_lock(
            operation_id=operation_id,
            entity_type="session",
            entity_id="ses-lock",
            ttl_seconds=30,
            now=now,
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        acquired = list(executor.map(acquire, [operation.id for operation in operations]))

    assert sum(acquired) == 1
    winner = operations[acquired.index(True)]
    loser = operations[acquired.index(False)]
    assert repositories.lifecycle_operations.release_locks(winner.id) == 1
    assert acquire(loser.id) is True
    assert repositories.lifecycle_operations.acquire_lock(
        operation_id=winner.id,
        entity_type="session",
        entity_id="ses-lock",
        ttl_seconds=30,
        now=now + timedelta(minutes=1),
    ) is True


def test_completed_purge_scrubs_business_content_but_keeps_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    sensitive = {
        "entity": "ws-sensitive-id",
        "name": "Secret Project Name",
        "root": "D:/private/SecretRoot",
        "title": "Sensitive Session Title",
        "content": "secret message body",
    }
    created = repositories.lifecycle_operations.create_or_replay(
        request_id="req-purge-sensitive",
        entity_type="workspace",
        entity_id=sensitive["entity"],
        action="purge",
        payload=sensitive,
    ).operation
    completed = repositories.lifecycle_operations.update(
        created.id,
        expected_revision=1,
        state="completed",
        counts={"sessions": 2, "messages": 8},
        result=sensitive,
        error_code="safe_code",
        error_detail={"phase": "finalize", "path": sensitive["root"]},
        quarantine_token="operation-token",
        completed=True,
    )
    assert completed is not None

    scrubbed = repositories.lifecycle_operations.scrub_completed_purge(created.id)

    assert scrubbed is not None
    assert scrubbed.entity_id is None
    assert scrubbed.result == {}
    assert scrubbed.error_detail == {}
    assert scrubbed.quarantine_token is None
    assert scrubbed.counts == {"sessions": 2, "messages": 8}
    assert scrubbed.state == "completed"
    with repositories.db.connect() as conn:
        row = conn.execute(
            "select * from lifecycle_operations where id = ?",
            (created.id,),
        ).fetchone()
    persisted_text = "\n".join("" if value is None else str(value) for value in row)
    for value in sensitive.values():
        assert value not in persisted_text
    replay = repositories.lifecycle_operations.get_by_request(
        entity_type="workspace",
        entity_id=sensitive["entity"],
        request_id="req-purge-sensitive",
    )
    assert replay is not None
    assert replay.id == created.id


def test_cleanup_failed_operation_survives_repository_restart(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    repositories = StorageRepositories(init_database(db_path))
    operation = repositories.lifecycle_operations.create_or_replay(
        request_id="req-cleanup-retry",
        entity_type="session",
        entity_id="ses-cleanup-retry",
        action="purge",
        payload={"confirmed": True},
    ).operation
    failed = repositories.lifecycle_operations.update(
        operation.id,
        expected_revision=1,
        state="cleanup_failed",
        error_code="quarantine_cleanup_failed",
        error_detail={"retryable": True, "phase": "finalize", "path": "hidden"},
        quarantine_token="retry-token",
    )
    assert failed is not None

    restarted = StorageRepositories(init_database(db_path))
    pending = restarted.lifecycle_operations.list_cleanup_failed()

    assert [item.id for item in pending] == [operation.id]
    assert pending[0].quarantine_token == "retry-token"
    assert pending[0].error_detail == {"retryable": True, "phase": "finalize"}
