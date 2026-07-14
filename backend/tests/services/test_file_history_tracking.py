from __future__ import annotations

import pytest

from backend.app.services.file_history_service import (
    FileHistoryError,
    FileHistoryService,
    FileMutationSpec,
)
from backend.app.storage import StorageRepositories, init_database

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


def _input_snapshot(service: FileHistoryService, workspace):
    return service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=workspace,
    )


def _prepare(service: FileHistoryService, workspace, snapshot_id: str, specs):
    return service.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=snapshot_id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=workspace,
        tool_name="edit_file",
        tool_call_id="tool-1",
        mutations=specs,
        batch_id="batch-1",
    )


def test_late_track_create_captures_missing_once_and_records_path_head(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    snapshot = _input_snapshot(service, tmp_path)
    specs = [FileMutationSpec("created.txt", "create")]

    first = _prepare(service, tmp_path, snapshot.id, specs)
    second = _prepare(service, tmp_path, snapshot.id, specs)
    entry = repositories.file_history.list_snapshot_entries(snapshot.id)[0]
    assert entry.state == "missing" and entry.version == 1
    assert second[0].id == first[0].id

    (tmp_path / "created.txt").write_text("created", encoding="utf-8")
    committed = service.commit_writes(first, workspace_root=tmp_path)
    head = repositories.file_history.get_path_head(
        committed[0].workspace_identity, committed[0].canonical_path
    )
    assert committed[0].status == "committed"
    assert head is not None
    assert head.session_id == "session-1" and head.state == "file"


def test_late_track_existing_file_captures_preimage_before_write(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    target = tmp_path / "existing.txt"
    target.write_text("before", encoding="utf-8")
    snapshot = _input_snapshot(service, tmp_path)

    prepared = _prepare(
        service,
        tmp_path,
        snapshot.id,
        [FileMutationSpec("existing.txt", "update")],
    )
    target.write_text("after", encoding="utf-8")
    service.commit_writes(prepared, workspace_root=tmp_path)

    entry = repositories.file_history.list_snapshot_entries(snapshot.id)[0]
    backup_path = service.store.resolve_backup_path(
        "session-1", entry.backup_file_name or ""
    )
    assert backup_path.read_text(encoding="utf-8") == "before"
    assert prepared[0].before_hash == entry.content_hash


def test_prepare_batch_backup_failure_has_zero_mutation_metadata(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    (tmp_path / "ok.txt").write_text("ok", encoding="utf-8")
    (tmp_path / "directory").mkdir()
    snapshot = _input_snapshot(service, tmp_path)

    with pytest.raises((FileHistoryError, RuntimeError)):
        _prepare(
            service,
            tmp_path,
            snapshot.id,
            [
                FileMutationSpec("ok.txt", "update"),
                FileMutationSpec("directory", "update"),
            ],
        )

    assert repositories.file_history.list_snapshot_entries(snapshot.id) == []
    assert repositories.file_history.list_mutations(snapshot_id=snapshot.id) == []


def test_abort_write_keeps_preimage_but_does_not_claim_path_head(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    (tmp_path / "file.txt").write_text("before", encoding="utf-8")
    snapshot = _input_snapshot(service, tmp_path)
    prepared = _prepare(
        service,
        tmp_path,
        snapshot.id,
        [FileMutationSpec("file.txt", "update")],
    )

    service.abort_writes(prepared, error_code="tool_failed")

    mutation = repositories.file_history.list_mutations(snapshot_id=snapshot.id)[0]
    assert mutation.status == "aborted"
    assert repositories.file_history.list_snapshot_entries(snapshot.id)
    assert repositories.file_history.get_path_head(
        mutation.workspace_identity, mutation.canonical_path
    ) is None
