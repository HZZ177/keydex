from __future__ import annotations

import pytest

from backend.app.services.file_history_service import FileHistoryService
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools.base import ToolExecutionContext
from backend.app.tools import edit_ops
from backend.app.tools.edit_ops import delete_file_tool, edit_file_tool, move_file_tool
from backend.app.tools.filesystem import write_file_tool
from backend.app.tools.patch import apply_patch_tool


NOW = "2026-07-15T00:00:00Z"


def _context(tmp_path) -> tuple[ToolExecutionContext, StorageRepositories, object]:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    with repositories.db.connect() as conn:
        conn.execute(
            "insert into sessions (id, user_id, scene_id, status, created_at, updated_at) "
            "values ('session-1', 'user-1', 'scene-1', 'active', ?, ?)",
            (NOW, NOW),
        )
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    service = FileHistoryService(repositories, data_dir=tmp_path / "data")
    snapshot = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=workspace,
    )
    return (
        ToolExecutionContext(
            session_id="session-1",
            user_id="user-1",
            workspace_root=workspace,
            turn_index=1,
            trace_id="trace-1",
            active_session_id="session-1",
            input_file_snapshot_id=snapshot.id,
            file_history_service=service,
            file_history_tracking=True,
            metadata={"tool_call_id": "call-1", "file_access_mode": "full_access"},
        ),
        repositories,
        snapshot,
    )


@pytest.mark.asyncio
async def test_full_access_external_create_is_committed_to_history(tmp_path) -> None:
    context, repositories, snapshot = _context(tmp_path)
    target = tmp_path / "outside" / "created.txt"

    result = await write_file_tool(
        {"path": str(target), "content": "created externally"}, context
    )

    mutations = repositories.file_history.list_mutations(snapshot_id=snapshot.id)
    assert result["path"] == target.as_posix()
    assert target.read_text(encoding="utf-8") == "created externally"
    assert len(mutations) == 1
    assert mutations[0].scope_kind == "external"
    assert mutations[0].before_state == "missing"
    assert mutations[0].status == "committed"


@pytest.mark.asyncio
async def test_full_access_external_edit_preserves_preimage_history(tmp_path) -> None:
    context, repositories, snapshot = _context(tmp_path)
    target = tmp_path / "outside" / "edited.txt"
    target.parent.mkdir()
    target.write_text("before", encoding="utf-8")

    await edit_file_tool(
        {"path": str(target), "old_string": "before", "new_string": "after"},
        context,
    )

    mutation = repositories.file_history.list_mutations(snapshot_id=snapshot.id)[0]
    assert target.read_text(encoding="utf-8") == "after"
    assert mutation.scope_kind == "external"
    assert mutation.before_state == "file"
    assert mutation.before_hash is not None
    assert mutation.after_hash is not None


@pytest.mark.asyncio
async def test_full_access_external_binary_delete_is_structurally_tracked(tmp_path) -> None:
    context, repositories, snapshot = _context(tmp_path)
    target = tmp_path / "outside" / "deleted.bin"
    target.parent.mkdir()
    target.write_bytes(b"\x00external\xff")

    await delete_file_tool({"path": str(target)}, context)

    mutation = repositories.file_history.list_mutations(snapshot_id=snapshot.id)[0]
    assert not target.exists()
    assert mutation.scope_kind == "external"
    assert mutation.before_state == "file"
    assert mutation.after_state == "missing"


@pytest.mark.asyncio
async def test_full_access_cross_scope_move_uses_safe_cross_volume_branch(
    tmp_path, monkeypatch
) -> None:
    context, repositories, snapshot = _context(tmp_path)
    source = context.workspace_root / "source.bin"
    destination = tmp_path / "outside" / "moved.bin"
    source.write_bytes(b"\x00cross-scope\xff")
    monkeypatch.setattr(edit_ops, "_same_volume", lambda *_args: False)

    await move_file_tool(
        {"path": str(source), "new_path": str(destination)},
        context,
    )

    mutations = repositories.file_history.list_mutations(snapshot_id=snapshot.id)
    assert not source.exists()
    assert destination.read_bytes() == b"\x00cross-scope\xff"
    assert {item.mutation_kind for item in mutations} == {
        "move_source",
        "move_destination",
    }
    assert {item.scope_kind for item in mutations} == {"workspace", "external"}
    assert len({item.batch_id for item in mutations}) == 1


@pytest.mark.asyncio
async def test_full_access_patch_commits_workspace_and_external_files_as_one_batch(
    tmp_path,
) -> None:
    context, repositories, snapshot = _context(tmp_path)
    workspace_file = context.workspace_root / "workspace.txt"
    external_file = tmp_path / "outside" / "external.txt"
    external_file.parent.mkdir()
    workspace_file.write_text("workspace-old\n", encoding="utf-8")
    external_file.write_text("external-old\n", encoding="utf-8")
    patch = (
        "*** Begin Patch\n"
        f"*** Update File: {workspace_file.as_posix()}\n"
        "@@\n"
        "-workspace-old\n"
        "+workspace-new\n"
        f"*** Update File: {external_file.as_posix()}\n"
        "@@\n"
        "-external-old\n"
        "+external-new\n"
        "*** End Patch"
    )

    await apply_patch_tool({"patch": patch}, context)

    mutations = repositories.file_history.list_mutations(snapshot_id=snapshot.id)
    assert workspace_file.read_text(encoding="utf-8") == "workspace-new\n"
    assert external_file.read_text(encoding="utf-8") == "external-new\n"
    assert len(mutations) == 2
    assert {item.scope_kind for item in mutations} == {"workspace", "external"}
    assert len({item.batch_id for item in mutations}) == 1
    assert all(item.status == "committed" for item in mutations)

    service = context.file_history_service
    assert isinstance(service, FileHistoryService)
    preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=context.workspace_root,
        source={"message_event_id": "message-1"},
        file_access_mode="full_access",
    )
    operation, target, files = service.preflight_preview(
        session_id="session-1",
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        mode="code",
        decision="full",
        workspace_root=context.workspace_root,
        file_access_mode="full_access",
        confirm_external_paths=True,
    )
    assert target is not None
    resource_ids = [item.resource_id for item in files]
    service.create_safety_snapshots(
        operation_id=operation.id,
        workspace_root=context.workspace_root,
        canonical_paths=resource_ids,
    )
    service.execute_file_restore(
        operation_id=operation.id,
        target=target,
        workspace_root=context.workspace_root,
        canonical_paths=resource_ids,
    )

    assert workspace_file.read_text(encoding="utf-8") == "workspace-old\n"
    assert external_file.read_text(encoding="utf-8") == "external-old\n"
