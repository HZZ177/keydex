from __future__ import annotations

import pytest

from backend.app.storage import ThreadTaskRecord, ThreadTaskRunRecord, init_database


def _insert_session(conn) -> None:
    conn.execute(
        """
        insert into sessions (
          id, user_id, scene_id, status, created_at, updated_at
        ) values ('session-1', 'user-1', 'scene-1', 'idle', '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z')
        """
    )


def test_thread_task_record_from_row_parses_json_fields(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    with db.transaction() as conn:
        _insert_session(conn)
        conn.execute(
            """
            insert into thread_tasks (
              id, session_id, type, title, objective, status,
              metadata_json, evidence_json, blocked_audit_json, token_usage_json,
              turn_count, elapsed_seconds, created_at, updated_at
            ) values (
              'task-1', 'session-1', 'goal', '目标', '完成任务', 'active',
              '{"source":"composer_goal"}', '[{"type":"test","title":"passed"}]',
              '{"key":"blocked:env","count":2}', '{"input_tokens":10}',
              3, 42, '2026-07-03T00:00:01Z', '2026-07-03T00:00:02Z'
            )
            """
        )
        row = conn.execute("select * from thread_tasks where id = 'task-1'").fetchone()

    record = ThreadTaskRecord.from_row(row)

    assert record.id == "task-1"
    assert record.type == "goal"
    assert record.title == "目标"
    assert record.metadata == {"source": "composer_goal"}
    assert record.evidence == [{"type": "test", "title": "passed"}]
    assert record.blocked_audit == {"key": "blocked:env", "count": 2}
    assert record.token_usage == {"input_tokens": 10}
    assert record.turn_count == 3
    assert record.elapsed_seconds == 42
    assert record.is_open is True
    assert record.is_terminal is False


def test_thread_task_record_from_row_defaults_empty_json_fields(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    with db.transaction() as conn:
        _insert_session(conn)
        conn.execute(
            """
            insert into thread_tasks (
              id, session_id, type, objective, status,
              metadata_json, evidence_json, blocked_audit_json, token_usage_json,
              created_at, updated_at
            ) values (
              'task-empty', 'session-1', 'goal', '完成任务', 'complete',
              '', '', '', '', '2026-07-03T00:00:01Z', '2026-07-03T00:00:02Z'
            )
            """
        )
        row = conn.execute("select * from thread_tasks where id = 'task-empty'").fetchone()

    record = ThreadTaskRecord.from_row(row)

    assert record.metadata == {}
    assert record.evidence == []
    assert record.blocked_audit == {}
    assert record.token_usage == {}
    assert record.is_open is False
    assert record.is_terminal is True


def test_thread_task_record_from_row_rejects_invalid_json(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    with db.transaction() as conn:
        _insert_session(conn)
        conn.execute(
            """
            insert into thread_tasks (
              id, session_id, type, objective, status,
              metadata_json, created_at, updated_at
            ) values (
              'task-bad-json', 'session-1', 'goal', '完成任务', 'active',
              '{', '2026-07-03T00:00:01Z', '2026-07-03T00:00:02Z'
            )
            """
        )
        row = conn.execute("select * from thread_tasks where id = 'task-bad-json'").fetchone()

    with pytest.raises(ValueError, match="metadata_json"):
        ThreadTaskRecord.from_row(row)


def test_thread_task_run_record_from_row_parses_json_fields(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    with db.transaction() as conn:
        _insert_session(conn)
        conn.execute(
            """
            insert into thread_tasks (
              id, session_id, type, objective, status, created_at, updated_at
            ) values (
              'task-1', 'session-1', 'goal', '完成任务', 'active',
              '2026-07-03T00:00:01Z', '2026-07-03T00:00:01Z'
            )
            """
        )
        conn.execute(
            """
            insert into thread_task_runs (
              id, task_id, session_id, turn_index, trace_id, status,
              summary_json, error_json, started_at, finished_at, created_at, updated_at
            ) values (
              'run-1', 'task-1', 'session-1', 5, 'trace-1', 'succeeded',
              '{"summary":"done"}', '{"retries":0}',
              '2026-07-03T00:00:02Z', '2026-07-03T00:00:03Z',
              '2026-07-03T00:00:02Z', '2026-07-03T00:00:03Z'
            )
            """
        )
        row = conn.execute("select * from thread_task_runs where id = 'run-1'").fetchone()

    record = ThreadTaskRunRecord.from_row(row)

    assert record.id == "run-1"
    assert record.turn_index == 5
    assert record.trace_id == "trace-1"
    assert record.summary == {"summary": "done"}
    assert record.error == {"retries": 0}
    assert record.is_running is False
