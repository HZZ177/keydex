from __future__ import annotations

import pytest

from backend.app.services.file_history_service import FileHistoryError, FileMutationSpec
from backend.tests.services.test_file_history_multiscope import _service


def test_second_scope_restore_failure_compensates_first_scope(tmp_path, monkeypatch) -> None:
    service, repositories = _service(tmp_path)
    workspace = tmp_path / "workspace"
    outside = tmp_path / "outside"
    workspace.mkdir()
    outside.mkdir()
    workspace_file = workspace / "workspace.txt"
    external_file = outside / "external.txt"
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
        tool_name="apply_patch",
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
    operation, target, files = service.preflight_preview(
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
    resource_ids = [item.resource_id for item in files]
    service.create_safety_snapshots(
        operation_id=operation.id,
        workspace_root=workspace,
        canonical_paths=resource_ids,
    )
    original_restore = service.store.restore_backup
    calls = 0

    def fail_second(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("injected second-scope restore failure")
        return original_restore(**kwargs)

    monkeypatch.setattr(service.store, "restore_backup", fail_second)
    with pytest.raises(FileHistoryError) as failure:
        service.execute_file_restore(
            operation_id=operation.id,
            target=target,
            workspace_root=workspace,
            canonical_paths=resource_ids,
        )
    assert failure.value.code == "file_restore_failed"

    monkeypatch.setattr(service.store, "restore_backup", original_restore)
    compensated = service.compensate_operation(
        operation_id=operation.id,
        workspace_root=workspace,
    )

    assert len(compensated) == 2
    assert workspace_file.read_text(encoding="utf-8") == "workspace-after"
    assert external_file.read_text(encoding="utf-8") == "external-after"
    persisted = repositories.file_history.get_operation(operation.id)
    assert persisted is not None and persisted.state == "compensated"
