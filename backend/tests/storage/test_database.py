from __future__ import annotations

import pytest

from backend.app.storage import init_database


def _table_names(db_path) -> set[str]:
    db = init_database(db_path)
    with db.connect() as conn:
        rows = conn.execute(
            "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
        ).fetchall()
    return {str(row["name"]) for row in rows}


def test_init_database_creates_core_tables_idempotently(tmp_path) -> None:
    db_path = tmp_path / "app.db"

    first = _table_names(db_path)
    second = _table_names(db_path)

    expected = {
        "settings",
        "model_providers",
        "model_defaults",
        "sessions",
        "message_events",
        "trace_record",
        "trace_event_log",
    }
    assert expected.issubset(first)
    assert expected.issubset(second)


def test_init_database_no_longer_creates_legacy_thread_turn_item_tables(tmp_path) -> None:
    tables = _table_names(tmp_path / "app.db")

    assert "threads" not in tables
    assert "turns" not in tables
    assert "items" not in tables
    assert "events" not in tables
    assert "approvals" not in tables


def test_database_transaction_commits_and_rolls_back(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.transaction() as conn:
        conn.execute(
            "insert into settings (key, value_json, updated_at) values (?, ?, ?)",
            ("committed", "{}", "2026-06-18T00:00:00Z"),
        )

    with db.connect() as conn:
        committed = conn.execute(
            "select value_json from settings where key = ?",
            ("committed",),
        ).fetchone()
    assert committed is not None

    with pytest.raises(RuntimeError):
        with db.transaction() as conn:
            conn.execute(
                "insert into settings (key, value_json, updated_at) values (?, ?, ?)",
                ("rolled_back", "{}", "2026-06-18T00:00:00Z"),
            )
            raise RuntimeError("force rollback")

    with db.connect() as conn:
        rolled_back = conn.execute(
            "select value_json from settings where key = ?",
            ("rolled_back",),
        ).fetchone()
    assert rolled_back is None
