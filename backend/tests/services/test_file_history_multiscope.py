from __future__ import annotations

import pytest

from backend.app.services.file_history_service import FileHistoryService, FileMutationSpec
from backend.app.services.file_history_store import FileHistoryStoreError
from backend.app.storage import StorageRepositories, init_database


NOW = "2026-07-15T00:00:00Z"


def _service(tmp_path) -> tuple[FileHistoryService, StorageRepositories]:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    with repositories.db.connect() as conn:
        conn.execute(
            "insert into sessions (id, user_id, scene_id, status, created_at, updated_at) "
            "values ('session-1', 'user-1', 'scene-1', 'active', ?, ?)",
            (NOW, NOW),
        )
    return FileHistoryService(repositories, data_dir=tmp_path / "data"), repositories


def test_input_snapshot_tracks_workspace_and_external_resources_in_one_lineage(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    workspace = tmp_path / "workspace"
    external_dir = tmp_path / "external"
    workspace.mkdir()
    external_dir.mkdir()
    workspace_file = workspace / "same.txt"
    external_file = external_dir / "same.txt"
    workspace_file.write_text("workspace-before", encoding="utf-8")
    external_file.write_text("external-before", encoding="utf-8")
    first = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=workspace,
    )

    prepared = service.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=first.id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=workspace,
        tool_name="edit_file",
        tool_call_id="call-1",
        mutations=(
            FileMutationSpec(workspace_file, "update"),
            FileMutationSpec(external_file, "update"),
        ),
        batch_id="batch-1",
    )
    service.abort_writes(prepared)
    second = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-2",
        message_event_id="message-2",
        workspace_root=workspace,
    )

    entries = repositories.file_history.list_snapshot_entries(second.id)
    tracked = repositories.file_history.list_tracked_files("session-1")

    assert second.parent_snapshot_id == first.id
    assert {entry.scope_kind for entry in entries} == {"workspace", "external"}
    assert len({entry.scope_identity for entry in entries}) == 2
    assert len({(item.scope_kind, item.scope_identity, item.canonical_path) for item in tracked}) == 2


def test_prepare_writes_fails_before_business_files_change_when_second_backup_fails(
    tmp_path, monkeypatch
) -> None:
    service, repositories = _service(tmp_path)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    first = workspace / "first.txt"
    second = tmp_path / "external" / "second.txt"
    second.parent.mkdir()
    first.write_text("first-before", encoding="utf-8")
    second.write_text("second-before", encoding="utf-8")
    snapshot = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=workspace,
    )
    original = service.store.create_backup
    calls = 0

    def fail_second(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise FileHistoryStoreError("injected_backup_failure", "injected")
        return original(**kwargs)

    monkeypatch.setattr(service.store, "create_backup", fail_second)

    with pytest.raises(FileHistoryStoreError, match="injected"):
        service.prepare_writes(
            session_id="session-1",
            active_session_id="session-1",
            snapshot_id=snapshot.id,
            trace_id="trace-1",
            turn_index=1,
            workspace_root=workspace,
            tool_name="edit_file",
            tool_call_id="call-1",
            mutations=(
                FileMutationSpec(first, "update"),
                FileMutationSpec(second, "update"),
            ),
            batch_id="batch-1",
        )

    assert first.read_text(encoding="utf-8") == "first-before"
    assert second.read_text(encoding="utf-8") == "second-before"
    assert repositories.file_history.list_mutations(snapshot_id=snapshot.id) == []


def test_commit_writes_persists_all_scopes_and_independent_path_heads(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    workspace = tmp_path / "workspace"
    external_dir = tmp_path / "external"
    workspace.mkdir()
    external_dir.mkdir()
    workspace_file = workspace / "same.txt"
    external_file = external_dir / "same.txt"
    workspace_file.write_text("workspace-before", encoding="utf-8")
    external_file.write_text("external-before", encoding="utf-8")
    snapshot = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=workspace,
    )
    prepared = service.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=snapshot.id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=workspace,
        tool_name="edit_file",
        tool_call_id="call-1",
        mutations=(
            FileMutationSpec(workspace_file, "update"),
            FileMutationSpec(external_file, "update"),
        ),
        batch_id="batch-1",
    )
    workspace_file.write_text("workspace-after", encoding="utf-8")
    external_file.write_text("external-after", encoding="utf-8")

    committed = service.commit_writes(prepared, workspace_root=workspace)

    assert {item.status for item in committed} == {"committed"}
    assert len(committed) == 2
    heads = [
        repositories.file_history.get_path_head(
            item.workspace_identity,
            item.canonical_path,
            scope_kind=item.scope_kind,
            scope_identity=item.scope_identity,
        )
        for item in committed
    ]
    assert all(head is not None for head in heads)
    assert len({head.content_hash for head in heads if head is not None}) == 2


def test_commit_failure_compensates_all_written_resources(tmp_path, monkeypatch) -> None:
    service, repositories = _service(tmp_path)
    workspace = tmp_path / "workspace"
    external_dir = tmp_path / "external"
    workspace.mkdir()
    external_dir.mkdir()
    first = workspace / "first.txt"
    second = external_dir / "second.txt"
    first.write_text("first-before", encoding="utf-8")
    second.write_text("second-before", encoding="utf-8")
    snapshot = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=workspace,
    )
    prepared = service.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=snapshot.id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=workspace,
        tool_name="edit_file",
        tool_call_id="call-1",
        mutations=(FileMutationSpec(first, "update"), FileMutationSpec(second, "update")),
        batch_id="batch-1",
    )
    first.write_text("first-after", encoding="utf-8")
    second.write_text("second-after", encoding="utf-8")

    def fail_head(*args, **kwargs):
        raise RuntimeError("injected commit failure")

    monkeypatch.setattr(repositories.file_history, "upsert_path_heads", fail_head)
    with pytest.raises(RuntimeError, match="injected commit failure"):
        service.commit_writes(prepared, workspace_root=workspace)
    restored = service.compensate_writes(prepared, workspace_root=workspace)

    assert len(restored) == 2
    assert first.read_text(encoding="utf-8") == "first-before"
    assert second.read_text(encoding="utf-8") == "second-before"
    assert {
        item.status
        for item in repositories.file_history.list_mutations(snapshot_id=snapshot.id)
    } == {"aborted"}


def test_compensation_failure_marks_mutations_dirty_and_blocks_session(tmp_path, monkeypatch) -> None:
    service, repositories = _service(tmp_path)
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    target = workspace / "file.txt"
    target.write_text("before", encoding="utf-8")
    snapshot = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=workspace,
    )
    prepared = service.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=snapshot.id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=workspace,
        tool_name="edit_file",
        tool_call_id="call-1",
        mutations=(FileMutationSpec(target, "update"),),
    )
    target.write_text("after", encoding="utf-8")

    def fail_restore(**kwargs):
        raise FileHistoryStoreError("injected_restore_failure", "injected")

    monkeypatch.setattr(service.store, "restore_backup", fail_restore)
    with pytest.raises(Exception) as error:
        service.compensate_writes(prepared, workspace_root=workspace)

    state = repositories.file_history.get_session_state("session-1")
    mutation = repositories.file_history.get_mutation(prepared[0].id)
    assert getattr(error.value, "code", None) == "file_history_compensation_failed"
    assert state is not None and state.state == "blocked"
    assert mutation is not None and mutation.status == "dirty"


def test_resolve_target_keeps_same_named_resources_separate_across_scopes(tmp_path) -> None:
    service, _ = _service(tmp_path)
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    workspace_file = workspace / "same.txt"
    external_file = outside / "same.txt"
    workspace_file.write_text("workspace-before", encoding="utf-8")
    external_file.write_text("external-before", encoding="utf-8")
    snapshot = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=workspace,
    )
    prepared = service.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=snapshot.id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=workspace,
        tool_name="edit_file",
        tool_call_id="call-1",
        mutations=(
            FileMutationSpec(workspace_file, "update"),
            FileMutationSpec(external_file, "update"),
        ),
        batch_id="batch-1",
    )
    workspace_file.write_text("workspace-after", encoding="utf-8")
    external_file.write_text("external-after", encoding="utf-8")
    service.commit_writes(prepared, workspace_root=workspace)

    target = service.resolve_target(
        session_id="session-1",
        message_event_id="message-1",
        workspace_root=workspace,
    )

    assert len(target.files) == 2
    assert {item.path.scope_kind for item in target.files} == {"workspace", "external"}
    assert len({item.path.resource_id for item in target.files}) == 2
    assert all(item.entry is not None for item in target.files)


def test_preview_diff_and_conflicts_use_resource_identity_across_scopes(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    workspace_file = workspace / "same.txt"
    external_file = outside / "same.txt"
    workspace_file.write_text("workspace-before\n", encoding="utf-8")
    external_file.write_text("external-before\n", encoding="utf-8")
    snapshot = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=workspace,
    )
    prepared = service.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=snapshot.id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=workspace,
        tool_name="edit_file",
        tool_call_id="call-1",
        mutations=(
            FileMutationSpec(workspace_file, "update"),
            FileMutationSpec(external_file, "update"),
        ),
        batch_id="batch-1",
    )
    workspace_file.write_text("workspace-after\n", encoding="utf-8")
    external_file.write_text("external-after\n", encoding="utf-8")
    service.commit_writes(prepared, workspace_root=workspace)

    preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=workspace,
        source={"message_event_id": "message-1"},
        file_access_mode="full_access",
    )
    operation_files = repositories.file_history.list_operation_files(preview.operation_id)

    assert len(preview.files) == 2
    assert len({item.resource_id for item in preview.files}) == 2
    assert {item.scope_kind for item in preview.files} == {"workspace", "external"}
    assert {item.requires_full_access for item in preview.files} == {False, True}
    assert all(item.absolute_path for item in preview.files)
    assert len(operation_files) == 2
    assert {item.scope_kind for item in operation_files} == {"workspace", "external"}

    with pytest.raises(Exception) as changed:
        service.preflight_preview(
            session_id="session-1",
            operation_id=preview.operation_id,
            preview_token=preview.preview_token,
            mode="code",
            decision="full",
            workspace_root=workspace,
            file_access_mode="workspace_trusted",
        )
    assert getattr(changed.value, "code", None) == "file_restore_permission_changed"

    with pytest.raises(Exception) as confirmation:
        service.preflight_preview(
            session_id="session-1",
            operation_id=preview.operation_id,
            preview_token=preview.preview_token,
            mode="code",
            decision="full",
            workspace_root=workspace,
            file_access_mode="full_access",
        )
    assert (
        getattr(confirmation.value, "code", None)
        == "file_restore_external_confirmation_required"
    )

    _, target, current = service.preflight_preview(
        session_id="session-1",
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        mode="code",
        decision="full",
        workspace_root=workspace,
        file_access_mode="full_access",
        confirm_external_paths=True,
    )
    assert target is not None and len(current) == 2
    safety = service.create_safety_snapshots(
        operation_id=preview.operation_id,
        workspace_root=workspace,
        canonical_paths=[item.resource_id for item in current],
    )
    assert len(safety) == 2
    assert all(item.safety_state == "file" for item in safety)
    assert len({item.safety_backup_file_name for item in safety}) == 2

    resource_ids = [item.resource_id for item in current]
    restored = service.execute_file_restore(
        operation_id=preview.operation_id,
        target=target,
        workspace_root=workspace,
        canonical_paths=resource_ids,
    )
    assert len(restored) == 2
    assert workspace_file.read_text(encoding="utf-8") == "workspace-before\n"
    assert external_file.read_text(encoding="utf-8") == "external-before\n"

    restore_result = service.materialize_restore_result(
        session_id="session-1",
        active_session_id="session-1",
        target_snapshot_id=target.snapshot.id,
        workspace_root=workspace,
        trace_id="trace-restore",
        changed_canonical_paths=resource_ids,
    )
    repositories.file_history.update_operation(
        preview.operation_id,
        active_snapshot_after=restore_result.id,
    )
    result_entries = repositories.file_history.list_snapshot_entries(restore_result.id)
    assert restore_result.parent_snapshot_id == target.snapshot.id
    assert {item.scope_kind for item in result_entries} == {"workspace", "external"}
    assert len({item.scope_identity for item in result_entries}) == 2

    compensated = service.compensate_operation(
        operation_id=preview.operation_id,
        workspace_root=workspace,
    )
    assert len(compensated) == 2
    assert workspace_file.read_text(encoding="utf-8") == "workspace-after\n"
    assert external_file.read_text(encoding="utf-8") == "external-after\n"


def test_startup_recovery_compensates_interrupted_multiscope_restore(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    workspace_file = workspace / "file.txt"
    external_file = outside / "file.txt"
    workspace_file.write_text("workspace-before", encoding="utf-8")
    external_file.write_text("external-before", encoding="utf-8")
    snapshot = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=workspace,
    )
    prepared = service.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=snapshot.id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=workspace,
        tool_name="edit_file",
        tool_call_id="call-1",
        mutations=(
            FileMutationSpec(workspace_file, "update"),
            FileMutationSpec(external_file, "update"),
        ),
    )
    workspace_file.write_text("workspace-after", encoding="utf-8")
    external_file.write_text("external-after", encoding="utf-8")
    service.commit_writes(prepared, workspace_root=workspace)
    preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=workspace,
        source={"message_event_id": "message-1"},
        file_access_mode="full_access",
    )
    operation, target, current = service.preflight_preview(
        session_id="session-1",
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        mode="code",
        decision="full",
        workspace_root=workspace,
        file_access_mode="full_access",
        confirm_external_paths=True,
    )
    assert target is not None
    claimed = service.claim_operation_request(
        session_id="session-1",
        operation_id=operation.id,
        request_id="request-1",
        mode="code",
        decision="full",
    )
    assert claimed.state == "running"
    resource_ids = [item.resource_id for item in current]
    service.create_safety_snapshots(
        operation_id=operation.id,
        workspace_root=workspace,
        canonical_paths=resource_ids,
    )
    service.execute_file_restore(
        operation_id=operation.id,
        target=target,
        workspace_root=workspace,
        canonical_paths=resource_ids,
    )
    assert workspace_file.read_text(encoding="utf-8") == "workspace-before"
    assert external_file.read_text(encoding="utf-8") == "external-before"

    resumed = FileHistoryService(repositories, data_dir=tmp_path / "data")
    recovered = resumed.recover_incomplete_operations()

    assert recovered == ({"operation_id": operation.id, "status": "compensated"},)
    assert workspace_file.read_text(encoding="utf-8") == "workspace-after"
    assert external_file.read_text(encoding="utf-8") == "external-after"
