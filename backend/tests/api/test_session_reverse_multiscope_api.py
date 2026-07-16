from __future__ import annotations

from backend.app.command_approval import save_command_settings
from backend.app.services.file_history_service import FileMutationSpec
from backend.app.tools.command_runtime.models import CommandSettings
from backend.tests.api.test_session_reverse_execute_api import _case


def test_reverse_api_requires_confirmation_and_restores_workspace_and_external_resources(
    tmp_path,
) -> None:
    client, project, session = _case(tmp_path, with_file_change=False)
    repositories = client.app.state.repositories
    save_command_settings(repositories, CommandSettings(file_access_mode="full_access"))
    history = client.app.state.file_history_service
    workspace_file = project / "same.txt"
    external_file = tmp_path / "outside" / "same.txt"
    external_file.parent.mkdir()
    workspace_file.write_text("workspace-before", encoding="utf-8")
    external_file.write_text("external-before", encoding="utf-8")
    snapshot = history.make_input_snapshot(
        session_id=session["id"],
        active_session_id=session["id"],
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=project,
    )
    prepared = history.prepare_writes(
        session_id=session["id"],
        active_session_id=session["id"],
        snapshot_id=snapshot.id,
        trace_id="trace-1",
        turn_index=1,
        workspace_root=project,
        tool_name="apply_patch",
        tool_call_id="call-1",
        mutations=(
            FileMutationSpec(workspace_file, "update"),
            FileMutationSpec(external_file, "update"),
        ),
    )
    workspace_file.write_text("workspace-after", encoding="utf-8")
    external_file.write_text("external-after", encoding="utf-8")
    history.commit_writes(prepared, workspace_root=project)

    preview_response = client.post(
        f"/api/sessions/{session['id']}/reverse/preview",
        json={"message_event_id": "message-1"},
    )
    assert preview_response.status_code == 200
    preview = preview_response.json()
    assert preview["requires_external_confirmation"] is True
    assert preview["external_paths"] == [str(external_file.resolve())]
    assert {item["scope_kind"] for item in preview["files"]} == {
        "workspace",
        "external",
    }
    assert len({item["resource_id"] for item in preview["files"]}) == 2

    payload = {
        "message_event_id": "message-1",
        "operation_id": preview["operation_id"],
        "preview_token": preview["preview_token"],
        "request_id": "request-multiscope",
        "mode": "code",
        "decision": "full",
    }
    rejected = client.post(f"/api/sessions/{session['id']}/reverse", json=payload)
    assert rejected.status_code == 409
    assert rejected.json()["detail"]["code"] == "file_restore_external_confirmation_required"

    restored = client.post(
        f"/api/sessions/{session['id']}/reverse",
        json={**payload, "confirm_external_paths": True},
    )
    assert restored.status_code == 200
    assert set(restored.json()["restored_files"]) == {
        item["resource_id"] for item in preview["files"]
    }
    assert workspace_file.read_text(encoding="utf-8") == "workspace-before"
    assert external_file.read_text(encoding="utf-8") == "external-before"
