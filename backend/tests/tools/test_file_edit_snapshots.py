from __future__ import annotations

from backend.app.tools import ToolExecutionContext
from backend.app.tools.file_snapshots import (
    ensure_file_snapshot_store,
    record_file_snapshot,
    require_current_file_content,
)


def _context(tmp_path, session_id: str) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id=session_id,
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
    )


def test_file_read_snapshot_store_records_and_isolates_contexts(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("hello\n", encoding="utf-8")
    first = _context(tmp_path, "first")
    second = _context(tmp_path, "second")

    snapshot = record_file_snapshot(target, context=first, content="hello\n", full_read=True)

    assert snapshot.relative_path == "note.txt"
    assert ensure_file_snapshot_store(first).get(target) == snapshot
    assert ensure_file_snapshot_store(second).get(target) is None
    assert require_current_file_content(target, context=first) == "hello\n"


def test_file_read_snapshot_store_does_not_downgrade_full_read_with_partial_read(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("hello\n", encoding="utf-8")
    context = _context(tmp_path, "first")

    full = record_file_snapshot(target, context=context, content="hello\n", full_read=True)
    partial = record_file_snapshot(target, context=context, content="hello\n", full_read=False)

    assert partial is full
    assert require_current_file_content(target, context=context) == "hello\n"


def test_file_read_snapshot_store_discard_invalidates_write_guard(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("hello\n", encoding="utf-8")
    context = _context(tmp_path, "first")
    store = ensure_file_snapshot_store(context)
    record_file_snapshot(target, context=context, content="hello\n", full_read=True)

    store.discard(target)

    try:
        require_current_file_content(target, context=context)
    except Exception as exc:
        assert getattr(exc, "code", "") == "file_not_read"
    else:
        raise AssertionError("expected file_not_read after discard")
