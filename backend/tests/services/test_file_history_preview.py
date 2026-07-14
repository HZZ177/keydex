from __future__ import annotations

import os

from backend.app.services.file_history_service import FileHistoryService, FileMutationSpec
from backend.app.storage import (
    FileHistoryPathHeadRecord,
    FileHistoryTrackedFileRecord,
    StorageRepositories,
    init_database,
)

NOW = "2026-07-14T00:00:00Z"


def _service(tmp_path) -> tuple[FileHistoryService, StorageRepositories]:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    with repositories.db.connect() as conn:
        conn.execute(
            """
            insert into sessions (id, user_id, scene_id, status, created_at, updated_at)
            values ('session-1', 'user-1', 'scene-1', 'active', ?, ?)
            """,
            (NOW, NOW),
        )
    return FileHistoryService(repositories, data_dir=tmp_path / "data"), repositories


def _track(repositories: StorageRepositories, path: str, state: str) -> None:
    repositories.file_history.ensure_session_state("session-1")
    repositories.file_history.upsert_tracked_file(
        FileHistoryTrackedFileRecord(
            session_id="session-1",
            canonical_path=path,
            display_path=path,
            latest_version=0,
            first_snapshot_id=None,
            last_snapshot_id=None,
            last_observed_state=state,
            last_observed_hash=None,
            last_observed_size=None,
            last_observed_mtime_ns=None,
            last_observed_mode=None,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def test_diff_preview_covers_text_create_delete_empty_binary_and_large(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    initial = {
        "text.txt": b"a\nold\n",
        "created.txt": None,
        "deleted.txt": b"gone\n",
        "empty.txt": b"",
        "binary.bin": b"\x00before",
        "large.txt": b"a" * (2 * 1024 * 1024 + 1),
        "unchanged.txt": b"same\n",
    }
    for path, content in initial.items():
        if content is not None:
            (tmp_path / path).write_bytes(content)
        _track(repositories, path, "file" if content is not None else "missing")
    service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )

    (tmp_path / "text.txt").write_bytes(b"a\nnew\n")
    (tmp_path / "created.txt").write_bytes(b"created\n")
    (tmp_path / "deleted.txt").unlink()
    (tmp_path / "empty.txt").write_bytes(b"value\n")
    (tmp_path / "binary.bin").write_bytes(b"\x00after")
    (tmp_path / "large.txt").write_bytes(b"b" * (2 * 1024 * 1024 + 1))

    target = service.resolve_target(
        session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    files, insertions, deletions = service.diff_target(target)
    by_path = {item.path: item for item in files}

    assert "unchanged.txt" not in by_path
    assert by_path["text.txt"].insertions == 1
    assert by_path["text.txt"].deletions == 1
    assert "-new" in (by_path["text.txt"].diff or "")
    assert "+old" in (by_path["text.txt"].diff or "")
    assert by_path["created.txt"].target_state == "missing"
    assert by_path["created.txt"].deletions == 1
    assert by_path["deleted.txt"].current_state == "missing"
    assert by_path["deleted.txt"].insertions == 1
    assert by_path["empty.txt"].deletions == 1
    assert by_path["binary.bin"].binary is True
    assert by_path["binary.bin"].diff is None
    assert by_path["large.txt"].truncated is True
    assert by_path["large.txt"].diff is None
    assert insertions >= 2
    assert deletions >= 3


def test_conflict_classification_distinguishes_same_session_other_session_and_external(
    tmp_path,
) -> None:
    service, repositories = _service(tmp_path)
    target_path = tmp_path / "file.txt"
    target_path.write_text("before", encoding="utf-8")
    _track(repositories, "file.txt", "file")
    snapshot = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    prepared = service.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=snapshot.id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=tmp_path,
        tool_name="edit_file",
        tool_call_id="tool-1",
        mutations=(FileMutationSpec("file.txt", "update"),),
    )
    target_path.write_text("after", encoding="utf-8")
    committed = service.commit_writes(prepared, workspace_root=tmp_path)[0]
    target = service.resolve_target(
        session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    files, _, _ = service.diff_target(target)

    own = service.classify_conflicts(session_id="session-1", target=target, files=files)[0]
    assert own.classification == "ready"
    assert own.writer_session_id == "session-1"
    own_preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    assert own_preview.warnings == ()

    with repositories.db.connect() as conn:
        conn.execute(
            """
            insert into sessions (id, user_id, scene_id, status, created_at, updated_at)
            values ('session-2', 'user-1', 'scene-1', 'active', ?, ?)
            """,
            (NOW, NOW),
        )
    head = repositories.file_history.get_path_head(
        committed.workspace_identity, committed.canonical_path
    )
    assert head is not None
    repositories.file_history.upsert_path_head(
        FileHistoryPathHeadRecord(
            workspace_identity=head.workspace_identity,
            canonical_path=head.canonical_path,
            display_path=head.display_path,
            session_id="session-2",
            trace_id="trace-2",
            mutation_id=None,
            state=head.state,
            content_hash=head.content_hash,
            revision=head.revision,
            updated_at=NOW,
        )
    )
    other = service.classify_conflicts(
        session_id="session-1", target=target, files=files
    )[0]
    assert other.classification == "forceable_conflict"
    assert other.reason_code == "other_session_write"
    assert other.writer_session_id == "session-2"
    other_preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    assert other_preview.warnings == ("file_conflicts_detected",)

    target_path.write_text("external", encoding="utf-8")
    external_files, _, _ = service.diff_target(target)
    external = service.classify_conflicts(
        session_id="session-1", target=target, files=external_files
    )[0]
    assert external.classification == "forceable_conflict"
    assert external.reason_code == "external_drift"
    external_preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    assert external_preview.warnings == ("file_conflicts_detected",)


def test_mtime_only_change_is_not_reported_as_file_drift(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    target_path = tmp_path / "file.txt"
    target_path.write_text("same", encoding="utf-8")
    _track(repositories, "file.txt", "file")
    service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    os.utime(target_path, None)
    target = service.resolve_target(
        session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    assert service.diff_target(target)[0] == ()


def test_external_change_then_byte_exact_revert_is_not_reported_as_drift(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    target_path = tmp_path / "file.txt"
    target_path.write_bytes(b"same-bytes")
    _track(repositories, "file.txt", "file")
    service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    original_mtime = target_path.stat().st_mtime_ns
    target_path.write_bytes(b"other-byte")
    target_path.write_bytes(b"same-bytes")
    os.utime(target_path, ns=(original_mtime, original_mtime))

    target = service.resolve_target(
        session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )

    assert service.diff_target(target)[0] == ()
