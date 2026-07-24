from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app.agent.checkpoint import LegacySQLiteCheckpointSaver
from backend.app.agent.checkpoint_migration import (
    MIGRATION_ID,
    CheckpointMigrationCoordinator,
    CheckpointMigrationError,
    CheckpointMigrationRepository,
    MigrationFileLock,
    MigrationStatus,
)
from backend.app.agent.checkpoint_migration_collapse import NamespaceCollapseMigrator
from backend.app.agent.checkpoint_migration_copy import CompactTargetBuilder
from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.storage import init_database
from backend.tests.agent.test_checkpoint_legacy import _checkpoint


def _seed_session(connection, session_id: str, *, active_session_id: str | None = None) -> None:
    connection.execute(
        """
        insert into sessions (
          id, user_id, scene_id, status, active_session_id, created_at, updated_at
        ) values (?, 'user', 'scene', 'idle', ?, '2026-01-01', '2026-01-01')
        """,
        (session_id, active_session_id),
    )


def _seed_legacy(path: Path) -> tuple:
    database = init_database(path)
    saver = LegacySQLiteCheckpointSaver(database)
    root = saver.put(
        {"configurable": {"thread_id": "thread-a", "checkpoint_ns": ""}},
        _checkpoint("checkpoint-01"),
        {"source": "input"},
        {},
    )
    saver.put(root, _checkpoint("checkpoint-02"), {"source": "loop"}, {})
    saver.put(
        {"configurable": {"thread_id": "thread-a", "checkpoint_ns": "branch"}},
        _checkpoint("checkpoint-09"),
        {"source": "fork"},
        {},
    )
    saver.put(
        {"configurable": {"thread_id": "thread-b", "checkpoint_ns": ""}},
        _checkpoint("checkpoint-03"),
        {"source": "input"},
        {},
    )
    return database, saver


def test_schema_is_idempotent_and_empty_database_needs_no_migration(tmp_path: Path) -> None:
    database = init_database(tmp_path / "app.db")
    repository = CheckpointMigrationRepository(database)

    repository.ensure_schema()
    repository.ensure_schema()

    assert repository.ensure_required() is None
    with database.connect() as connection:
        session_columns = {
            row["name"] for row in connection.execute("pragma table_info(sessions)")
        }
        migration_tables = {
            row["name"]
            for row in connection.execute(
                """
                select name from sqlite_master
                where type = 'table' and name like 'checkpoint_migration_%'
                """
            )
        }
    assert {
        "checkpoint_lineage_epoch",
        "checkpoint_history_floor_turn_index",
        "checkpoint_root_id",
        "checkpoint_collapsed_at",
        "checkpoint_migration_id",
    } <= session_columns
    assert migration_tables == {
        "checkpoint_migration_state",
        "checkpoint_migration_namespaces",
    }


def test_preflight_inventory_covers_namespaces_floors_and_pending_state(
    tmp_path: Path,
) -> None:
    database, _saver = _seed_legacy(tmp_path / "app.db")
    with database.transaction() as connection:
        _seed_session(connection, "session-empty", active_session_id="thread-a")
        _seed_session(connection, "session-history", active_session_id="thread-a")
        connection.executemany(
            """
            insert into message_events (
              id, session_id, seq, turn_index, action, created_at, updated_at
            ) values (?, 'session-history', ?, ?, 'message', '2026-01-01', '2026-01-01')
            """,
            [("event-1", 1, 0), ("event-2", 2, 4)],
        )
        connection.execute(
            """
            insert into trace_record (
              trace_id, session_id, scene_id, user_id, turn_index, root_node_id,
              status, start_time, created_at, updated_at
            ) values (
              'trace-1', 'session-history', 'scene', 'user', 4, 'root',
              'running', '2026-01-01', '2026-01-01', '2026-01-01'
            )
            """
        )
        connection.execute(
            """
            insert into session_pending_inputs (
              id, session_id, mode, status, message, created_at, updated_at
            ) values (
              'input-1', 'session-history', 'queue', 'queued', 'private message',
              '2026-01-01', '2026-01-01'
            )
            """
        )
        connection.execute(
            """
            insert into command_approval_requests (
              id, session_id, title, command, status, created_at, updated_at
            ) values (
              'approval-1', 'session-history', 'approval', 'secret command',
              'pending', '2026-01-01', '2026-01-01'
            )
            """
        )

    coordinator = CheckpointMigrationCoordinator(database)
    required = coordinator.inspect()
    started = coordinator.start()
    inventory = coordinator.repository.inventory()

    assert required is not None
    assert required.migration_id == MIGRATION_ID
    assert started.status is MigrationStatus.PREFLIGHTING
    assert started.progress_basis_points == 500
    assert inventory.thread_count == 2
    assert inventory.namespace_count == 3
    assert inventory.checkpoint_count == 4
    assert inventory.empty_history_session_count == 1
    assert inventory.max_history_floor == 5
    assert inventory.shared_active_thread_count == 1
    assert inventory.changed_active_thread_count == 2
    assert inventory.running_trace_count == 1
    assert inventory.pending_input_count == 1
    assert inventory.approval_count == 1
    with database.connect() as connection:
        details = connection.execute(
            """
            select count(*) as count
            from checkpoint_migration_namespaces
            where migration_id = ?
            """,
            (MIGRATION_ID,),
        ).fetchone()
        inventory_json = connection.execute(
            """
            select inventory_json from checkpoint_migration_state
            where migration_id = ?
            """,
            (MIGRATION_ID,),
        ).fetchone()["inventory_json"]
    assert details["count"] == 3
    assert "private message" not in inventory_json
    assert "secret command" not in inventory_json


def test_orphan_broken_parent_and_insufficient_space_fail_safely(tmp_path: Path) -> None:
    orphan_db, saver = _seed_legacy(tmp_path / "orphan.db")
    root = saver.get_tuple(
        {"configurable": {"thread_id": "thread-a", "checkpoint_ns": ""}}
    )
    assert root is not None
    with orphan_db.transaction() as connection:
        connection.execute(
            """
            insert into checkpoint_writes_v2 (
              thread_id, checkpoint_ns, checkpoint_id, task_id, task_path,
              idx, channel, type, value_blob, created_at
            ) values (
              'missing-thread', '', 'missing-checkpoint', 'task', '', 0,
              'messages', 'bytes', x'01', '2026-01-01'
            )
            """
        )
    with pytest.raises(CheckpointMigrationError) as orphan_error:
        CheckpointMigrationCoordinator(orphan_db).start()
    assert orphan_error.value.code == "checkpoint_migration_orphan_writes"

    broken_db, _ = _seed_legacy(tmp_path / "broken.db")
    with broken_db.transaction() as connection:
        connection.execute(
            """
            update checkpoints_v2
            set parent_checkpoint_id = 'missing-parent'
            where checkpoint_id = 'checkpoint-02'
            """
        )
    with pytest.raises(CheckpointMigrationError) as broken_error:
        CheckpointMigrationCoordinator(broken_db).start()
    assert broken_error.value.code == "checkpoint_migration_broken_parent"

    small_db, _ = _seed_legacy(tmp_path / "small.db")
    with pytest.raises(CheckpointMigrationError) as space_error:
        CheckpointMigrationCoordinator(small_db).start(free_disk_bytes=0)
    assert space_error.value.code == "checkpoint_migration_insufficient_space"


def test_start_retry_acknowledge_and_progress_are_idempotent(tmp_path: Path) -> None:
    database, _saver = _seed_legacy(tmp_path / "app.db")
    coordinator = CheckpointMigrationCoordinator(database)

    first = coordinator.start()
    repeated = coordinator.start()
    assert repeated.migration_id == first.migration_id
    assert repeated.started_at == first.started_at

    progress = coordinator.repository.update_progress(9_999)
    regressed = coordinator.repository.update_progress(100)
    assert progress.progress_basis_points == 9_900
    assert regressed.progress_basis_points == 9_900
    assert regressed.user_percent == 99

    coordinator.repository.fail("injected_failure", "safe")
    retried = coordinator.retry()
    assert retried.status is MigrationStatus.PREFLIGHTING
    assert retried.migration_id == first.migration_id

    completed = coordinator.repository.update_progress(
        10_000,
        status=MigrationStatus.COMPLETED,
    )
    assert completed.progress_basis_points == 10_000
    assert completed.user_percent == 100
    acknowledged = coordinator.acknowledge()
    repeated_ack = coordinator.acknowledge()
    assert acknowledged.ui_acknowledged_at is not None
    assert repeated_ack.ui_acknowledged_at == acknowledged.ui_acknowledged_at


@pytest.mark.parametrize(
    ("stage", "minimum_percent"),
    [
        ("preflight", 5),
        ("copy", 30),
        ("collapse", 75),
    ],
)
def test_application_startup_resumes_interrupted_preswap_migration(
    tmp_path: Path,
    stage: str,
    minimum_percent: int,
) -> None:
    data_dir = tmp_path / stage
    database, _saver = _seed_legacy(data_dir / "app.db")
    coordinator = CheckpointMigrationCoordinator(database)
    coordinator.start()
    if stage in {"copy", "collapse"}:
        asyncio.run(CompactTargetBuilder(database).build())
    if stage == "collapse":
        NamespaceCollapseMigrator(database).collapse()

    interrupted = coordinator.inspect()
    assert interrupted is not None
    assert interrupted.user_percent >= minimum_percent

    app = create_app(AppSettings(data_dir=data_dir))
    with TestClient(app) as client:
        percentages: list[int] = []
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            payload = client.get("/api/checkpoint-migration").json()
            percentages.append(payload["percent"])
            if payload["state"] == "completed":
                break
            time.sleep(0.02)
        else:
            pytest.fail(f"interrupted {stage} migration did not resume")

    assert percentages == sorted(percentages)
    assert percentages[0] >= minimum_percent
    assert percentages[-1] == 100


def test_source_fingerprint_change_and_os_lock_contention(tmp_path: Path) -> None:
    database, saver = _seed_legacy(tmp_path / "app.db")
    coordinator = CheckpointMigrationCoordinator(database)
    original = coordinator.inspect()
    assert original is not None

    saver.put(
        {"configurable": {"thread_id": "thread-c", "checkpoint_ns": ""}},
        _checkpoint("checkpoint-10"),
        {},
        {},
    )
    changed = coordinator.inspect()
    assert changed is not None
    assert changed.status is MigrationStatus.FAILED
    assert changed.error_code == "checkpoint_migration_source_changed"

    first_lock = MigrationFileLock(database.path)
    second_lock = MigrationFileLock(database.path)
    assert first_lock.acquire() is True
    try:
        assert second_lock.acquire() is False
    finally:
        first_lock.release()
    assert second_lock.acquire() is True
    second_lock.release()


def test_application_liveness_stays_up_while_legacy_migration_is_required(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "data"
    database, _saver = _seed_legacy(data_dir / "app.db")
    app = create_app(AppSettings(data_dir=data_dir))

    with TestClient(app) as client:
        health = client.get("/api/health")
        gated = client.post("/api/sessions/session-1/fork", json={})

    assert database.path.exists()
    assert health.status_code == 200
    assert health.json()["checkpoint_status"] == "migration-required"
    assert health.json()["checkpoint_ready"] is False
    assert gated.status_code == 503


def test_application_migration_api_is_idempotent_and_acknowledgement_survives_restart(
    tmp_path: Path,
) -> None:
    data_dir = tmp_path / "data"
    database, _saver = _seed_legacy(data_dir / "app.db")
    app = create_app(AppSettings(data_dir=data_dir))

    with TestClient(app) as client:
        required = client.get("/api/checkpoint-migration")
        assert required.status_code == 200
        assert required.json() == {
            "state": "required",
            "percent": 0,
            "can_start": True,
            "can_retry": False,
            "can_acknowledge": False,
            "error": None,
        }

        first = client.post("/api/checkpoint-migration/start")
        repeated = client.post("/api/checkpoint-migration/start")
        assert first.status_code == repeated.status_code == 200
        assert first.json()["state"] in {"running", "completed"}
        assert repeated.json()["state"] in {"running", "completed"}

        percentages: list[int] = []
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            response = client.get("/api/checkpoint-migration")
            assert response.status_code == 200
            payload = response.json()
            percentages.append(payload["percent"])
            if payload["state"] == "completed":
                break
            time.sleep(0.02)
        else:
            pytest.fail("checkpoint migration did not complete")

        assert percentages == sorted(percentages)
        assert all(value <= 99 for value in percentages[:-1])
        assert percentages[-1] == 100
        assert payload["can_acknowledge"] is True
        assert client.get("/api/health").json()["checkpoint_ready"] is False
        acknowledged = client.post("/api/checkpoint-migration/acknowledge")
        assert acknowledged.status_code == 200
        assert acknowledged.json()["state"] == "ready"
        assert client.get("/api/health").json()["checkpoint_ready"] is True
        with client.websocket_connect("/agent-base/ws/chat") as websocket:
            websocket.send_json({"action": "ping"})
            assert websocket.receive_json()["action"] == "pong"

    restarted = create_app(AppSettings(data_dir=data_dir))
    with TestClient(restarted) as client:
        ready = client.get("/api/checkpoint-migration").json()
        assert ready["state"] == "ready"
        assert ready["percent"] == 100
        assert ready["can_acknowledge"] is False
        assert client.get("/api/health").json()["checkpoint_ready"] is True

        repeated_ack = client.post("/api/checkpoint-migration/acknowledge")
        assert repeated_ack.status_code == 200
        assert repeated_ack.json()["state"] == "ready"
        assert client.get("/api/health").json()["checkpoint_ready"] is True

    with database.connect() as connection:
        tables = {
            row["name"]
            for row in connection.execute(
                "select name from sqlite_master where type = 'table'"
            )
        }
        guarded_legacy_rows = connection.execute(
            """
            select
              (select count(*) from checkpoints_v2)
              + (select count(*) from checkpoint_writes_v2)
            """
        ).fetchone()[0]
    assert {"checkpoints", "writes"} <= tables
    assert "checkpoint_backend_guard" in tables
    assert guarded_legacy_rows == 0
