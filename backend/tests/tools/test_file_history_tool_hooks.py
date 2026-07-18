from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from backend.app.services.file_history_service import (
    FileHistoryError,
    FileHistoryService,
    FileMutationSpec,
)
from backend.app.services.file_history_store import FileHistoryStoreError
from backend.app.storage import StorageRepositories, init_database
from backend.app.subagents.models import SubagentRunSnapshot
from backend.app.tools.base import (
    FileHistoryExecutionScope,
    ToolExecutionContext,
    ToolExecutionError,
)
from backend.app.tools.edit_ops import delete_file_tool, edit_file_tool, move_file_tool
from backend.app.tools.filesystem import write_file_tool
from backend.app.tools.patch import apply_patch_tool

NOW = "2026-07-14T00:00:00Z"


def _context(tmp_path):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    with repositories.db.connect() as conn:
        conn.execute(
            """
            insert into sessions (id, user_id, scene_id, status, created_at, updated_at)
            values ('session-1', 'user-1', 'scene-1', 'active', ?, ?)
            """,
            (NOW, NOW),
        )
    service = FileHistoryService(repositories, data_dir=tmp_path / "data")
    snapshot = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
    )
    context = ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace-1",
        active_session_id="session-1",
        input_file_snapshot_id=snapshot.id,
        file_history_service=service,
        file_history_tracking=True,
        metadata={"tool_call_id": "call-1"},
    )
    return context, service, repositories, snapshot


@pytest.mark.asyncio
async def test_create_then_edit_uses_one_turn_preimage_and_restores_missing(tmp_path) -> None:
    context, service, repositories, snapshot = _context(tmp_path)
    await write_file_tool({"path": "created.txt", "content": "one"}, context)
    await edit_file_tool(
        {"path": "created.txt", "old_string": "one", "new_string": "two"},
        context,
    )

    mutations = repositories.file_history.list_mutations(snapshot_id=snapshot.id)
    assert len(mutations) == 1
    assert mutations[0].before_state == "missing"
    assert mutations[0].after_state == "file"
    assert mutations[0].tool_call_id == "call-1"
    preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    _, target, _ = service.preflight_preview(
        session_id="session-1",
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        mode="code",
        decision="full",
        workspace_root=tmp_path,
    )
    paths = [item.path for item in preview.files]
    service.create_safety_snapshots(
        operation_id=preview.operation_id,
        workspace_root=tmp_path,
        canonical_paths=paths,
    )
    service.execute_file_restore(
        operation_id=preview.operation_id,
        target=target,
        workspace_root=tmp_path,
        canonical_paths=paths,
    )
    assert not (tmp_path / "created.txt").exists()


@pytest.mark.asyncio
async def test_parallel_subagent_writes_are_owned_by_parent_turn_and_previewed_together(
    tmp_path,
) -> None:
    parent_context, service, repositories, snapshot = _context(tmp_path)
    history_scope = FileHistoryExecutionScope(
        session_id=parent_context.session_id,
        active_session_id=parent_context.active_session_id,
        trace_id=parent_context.trace_id,
        turn_index=parent_context.turn_index,
        input_snapshot_id=snapshot.id,
    )
    child_contexts = [
        ToolExecutionContext(
            session_id=f"child-{index}",
            user_id="user-1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id=f"child-trace-{index}",
            active_session_id=f"child-{index}",
            input_file_snapshot_id=snapshot.id,
            file_history_service=service,
            file_history_tracking=True,
            file_history_scope=history_scope,
            metadata={"tool_call_id": f"child-call-{index}"},
        )
        for index in range(2)
    ]

    await asyncio.gather(
        write_file_tool({"path": "worker-a.md", "content": "A"}, child_contexts[0]),
        write_file_tool({"path": "worker-b.md", "content": "B"}, child_contexts[1]),
    )

    mutations = repositories.file_history.list_mutations(snapshot_id=snapshot.id)
    assert {item.canonical_path for item in mutations} == {"worker-a.md", "worker-b.md"}
    assert {item.session_id for item in mutations} == {parent_context.session_id}
    assert {item.trace_id for item in mutations} == {parent_context.trace_id}
    assert {item.turn_index for item in mutations} == {parent_context.turn_index}
    preview = service.create_preview(
        session_id=parent_context.session_id,
        active_session_id=parent_context.active_session_id,
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    assert {item.path for item in preview.files} == {"worker-a.md", "worker-b.md"}
    assert preview.code_available is True


@pytest.mark.asyncio
async def test_active_parent_preview_adopts_provable_legacy_child_session_history(
    tmp_path,
) -> None:
    existing = tmp_path / "legacy-edit.md"
    existing.write_text("before", encoding="utf-8")
    parent_context, service, repositories, _snapshot = _context(tmp_path)
    now = datetime.now(UTC)
    child_contexts: list[ToolExecutionContext] = []
    for index in range(2):
        child_id = f"legacy-child-{index}"
        repositories.sessions.create(
            session_id=child_id,
            user_id="user-1",
            scene_id="scene-1",
            session_type="workspace",
            session_tag="subagent",
            visibility="internal",
            agent_kind="subagent",
            subagent_id=f"legacy-subagent-{index}",
            subagent_role="worker",
            parent_session_id=parent_context.session_id,
            cwd=str(tmp_path),
            workspace_roots=[str(tmp_path)],
        )
        child_snapshot = service.make_input_snapshot(
            session_id=child_id,
            active_session_id=child_id,
            trace_id=f"legacy-child-trace-{index}",
            message_event_id=f"legacy-child-message-{index}",
            workspace_root=tmp_path,
        )
        repositories.subagent_runs.create(
            SubagentRunSnapshot(
                run_id=f"legacy-run-{index}",
                subagent_id=f"legacy-subagent-{index}",
                child_session_id=child_id,
                parent_session_id=parent_context.session_id,
                parent_trace_id=parent_context.trace_id,
                parent_tool_call_id=f"legacy-call-{index}",
                parent_timeline_sequence=index,
                initiated_by="main_agent",
                role="worker",
                task="legacy write",
                state="completed",
                version=3,
                final_report="done",
                created_at=now - timedelta(seconds=1),
                queued_at=now - timedelta(seconds=1),
                started_at=now - timedelta(seconds=1),
                finished_at=now + timedelta(seconds=5),
                updated_at=now + timedelta(seconds=5),
            )
        )
        child_contexts.append(
            ToolExecutionContext(
                session_id=child_id,
                user_id="user-1",
                workspace_root=tmp_path,
                turn_index=1,
                trace_id=f"legacy-child-trace-{index}",
                active_session_id=child_id,
                input_file_snapshot_id=child_snapshot.id,
                file_history_service=service,
                file_history_tracking=True,
                metadata={"tool_call_id": f"legacy-tool-call-{index}"},
            )
        )

    await write_file_tool(
        {"path": "legacy-created.md", "content": "created"},
        child_contexts[0],
    )
    await edit_file_tool(
        {"path": "legacy-edit.md", "old_string": "before", "new_string": "after"},
        child_contexts[1],
    )

    preview = service.create_preview(
        session_id=parent_context.session_id,
        active_session_id=parent_context.active_session_id,
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={
            "message_event_id": "message-1",
            "trace_id": parent_context.trace_id,
            "turn_index": parent_context.turn_index,
        },
    )

    assert {item.path for item in preview.files} == {
        "legacy-created.md",
        "legacy-edit.md",
    }
    assert preview.code_available is True
    adopted = repositories.file_history.list_mutations(
        session_id=parent_context.session_id
    )
    assert {item.canonical_path for item in adopted} == {
        "legacy-created.md",
        "legacy-edit.md",
    }
    assert {item.trace_id for item in adopted} == {parent_context.trace_id}

    _, target, _ = service.preflight_preview(
        session_id=parent_context.session_id,
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        mode="code",
        decision="full",
        workspace_root=tmp_path,
    )
    paths = [item.path for item in preview.files]
    service.create_safety_snapshots(
        operation_id=preview.operation_id,
        workspace_root=tmp_path,
        canonical_paths=paths,
    )
    service.execute_file_restore(
        operation_id=preview.operation_id,
        target=target,
        workspace_root=tmp_path,
        canonical_paths=paths,
    )
    assert not (tmp_path / "legacy-created.md").exists()
    assert existing.read_text(encoding="utf-8") == "before"


@pytest.mark.asyncio
async def test_delete_and_move_capture_all_preimages_as_atomic_batches(tmp_path) -> None:
    context, _, repositories, snapshot = _context(tmp_path)
    (tmp_path / "delete.txt").write_bytes(b"delete-me")
    (tmp_path / "source.txt").write_bytes(b"move-me")

    await delete_file_tool({"path": "delete.txt"}, context)
    await move_file_tool({"path": "source.txt", "new_path": "nested/dest.txt"}, context)

    mutations = repositories.file_history.list_mutations(snapshot_id=snapshot.id)
    assert {item.canonical_path for item in mutations} == {
        "delete.txt",
        "source.txt",
        "nested/dest.txt",
    }
    move_mutations = [item for item in mutations if item.mutation_kind.startswith("move_")]
    assert len(move_mutations) == 2
    assert len({item.batch_id for item in move_mutations}) == 1
    assert move_mutations[0].batch_id is not None


@pytest.mark.asyncio
async def test_apply_patch_preflights_all_paths_and_commits_one_batch(tmp_path) -> None:
    context, _, repositories, snapshot = _context(tmp_path)
    (tmp_path / "a.txt").write_text("old\n", encoding="utf-8")
    (tmp_path / "c.txt").write_text("delete\n", encoding="utf-8")
    await apply_patch_tool(
        {
            "patch": (
                "*** Begin Patch\n"
                "*** Update File: a.txt\n"
                "@@\n"
                "-old\n"
                "+new\n"
                "*** Add File: b.txt\n"
                "+created\n"
                "*** Delete File: c.txt\n"
                "*** End Patch"
            )
        },
        context,
    )

    mutations = repositories.file_history.list_mutations(snapshot_id=snapshot.id)
    assert {item.canonical_path for item in mutations} == {"a.txt", "b.txt", "c.txt"}
    assert len({item.batch_id for item in mutations}) == 1
    assert mutations[0].batch_id is not None
    assert all(item.status == "committed" for item in mutations)


@pytest.mark.asyncio
async def test_delete_and_move_restore_exact_source_destination_and_deleted_bytes(tmp_path) -> None:
    context, service, _, _snapshot = _context(tmp_path)
    deleted = tmp_path / "deleted.bin"
    source = tmp_path / "source.txt"
    destination = tmp_path / "nested" / "destination.txt"
    deleted.write_bytes(b"\x00deleted\xff")
    source.write_bytes(b"move-source\r\n")

    await delete_file_tool({"path": "deleted.bin"}, context)
    await move_file_tool(
        {"path": "source.txt", "new_path": "nested/destination.txt"},
        context,
    )
    assert not deleted.exists()
    assert not source.exists()
    assert destination.read_bytes() == b"move-source\r\n"

    preview = service.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id="message-1",
        workspace_root=tmp_path,
        source={"message_event_id": "message-1"},
    )
    _, target, _ = service.preflight_preview(
        session_id="session-1",
        operation_id=preview.operation_id,
        preview_token=preview.preview_token,
        mode="code",
        decision="full",
        workspace_root=tmp_path,
    )
    paths = [item.path for item in preview.files]
    service.create_safety_snapshots(
        operation_id=preview.operation_id,
        workspace_root=tmp_path,
        canonical_paths=paths,
    )
    service.execute_file_restore(
        operation_id=preview.operation_id,
        target=target,
        workspace_root=tmp_path,
        canonical_paths=paths,
    )

    assert deleted.read_bytes() == b"\x00deleted\xff"
    assert source.read_bytes() == b"move-source\r\n"
    assert not destination.exists()


@pytest.mark.asyncio
async def test_backup_failure_prevents_create_and_records_no_mutation(
    tmp_path,
    monkeypatch,
) -> None:
    context, service, repositories, snapshot = _context(tmp_path)

    def fail_backup(**_kwargs):
        raise FileHistoryStoreError("injected", "backup failed")

    monkeypatch.setattr(service.store, "create_backup", fail_backup)
    with pytest.raises(ToolExecutionError) as error:
        await write_file_tool({"path": "blocked.txt", "content": "no"}, context)
    assert error.value.code == "file_history_preflight_failed"
    assert not (tmp_path / "blocked.txt").exists()
    assert repositories.file_history.list_mutations(snapshot_id=snapshot.id) == []


@pytest.mark.asyncio
async def test_apply_patch_write_failure_rolls_back_all_files(tmp_path, monkeypatch) -> None:
    context, _, repositories, snapshot = _context(tmp_path)
    first = tmp_path / "a.txt"
    first.write_text("old\n", encoding="utf-8")
    original_write_text = type(first).write_text

    def fail_second(path, data, *args, **kwargs):
        if path.name == "b.txt":
            raise OSError("injected write failure")
        return original_write_text(path, data, *args, **kwargs)

    monkeypatch.setattr(type(first), "write_text", fail_second)
    with pytest.raises(ToolExecutionError) as error:
        await apply_patch_tool(
            {
                "patch": (
                    "*** Begin Patch\n"
                    "*** Update File: a.txt\n"
                    "@@\n"
                    "-old\n"
                    "+new\n"
                    "*** Add File: b.txt\n"
                    "+created\n"
                    "*** End Patch"
                )
            },
            context,
        )

    assert error.value.code == "file_operation_failed_compensated"
    assert error.value.details["compensated"] is True
    assert error.value.details["reason"] == "OSError"
    assert first.read_text(encoding="utf-8") == "old\n"
    assert not (tmp_path / "b.txt").exists()
    mutations = repositories.file_history.list_mutations(snapshot_id=snapshot.id)
    assert len(mutations) == 2
    assert all(item.status == "aborted" for item in mutations)
    assert all(item.error_code == "file_operation_failed_compensated" for item in mutations)


@pytest.mark.asyncio
async def test_create_permission_failure_reports_compensated_state_and_real_cause(
    tmp_path,
    monkeypatch,
) -> None:
    context, _, repositories, snapshot = _context(tmp_path)
    target = tmp_path / "external-user" / "Desktop" / "test.md"
    original_write_text = type(target).write_text

    def deny_target(path, data, *args, **kwargs):
        if path == target:
            raise PermissionError(13, "access denied", str(path))
        return original_write_text(path, data, *args, **kwargs)

    monkeypatch.setattr(type(target), "write_text", deny_target)
    with pytest.raises(ToolExecutionError) as error:
        await write_file_tool({"path": str(target), "content": "test"}, context)

    assert error.value.code == "file_operation_failed_compensated"
    assert "权限不足" in str(error.value)
    assert error.value.details["compensated"] is True
    assert error.value.details["reason"] == "PermissionError"
    assert error.value.details["paths"] == [str(target)]
    assert not target.exists()
    mutations = repositories.file_history.list_mutations(snapshot_id=snapshot.id)
    assert len(mutations) == 1
    assert mutations[0].status == "aborted"
    assert mutations[0].error_code == "file_operation_failed_compensated"


@pytest.mark.asyncio
async def test_history_commit_failure_restores_file_and_reports_compensated_contract(
    tmp_path, monkeypatch
) -> None:
    context, service, repositories, snapshot = _context(tmp_path)
    target = tmp_path / "created.txt"

    def fail_commit(*args, **kwargs):
        raise RuntimeError("injected commit failure")

    monkeypatch.setattr(service, "commit_writes", fail_commit)
    with pytest.raises(ToolExecutionError) as error:
        await write_file_tool({"path": "created.txt", "content": "written"}, context)

    assert error.value.code == "file_history_commit_compensated"
    assert not target.exists()
    mutations = repositories.file_history.list_mutations(snapshot_id=snapshot.id)
    assert len(mutations) == 1
    assert mutations[0].status == "aborted"
    assert mutations[0].error_code == "file_history_commit_compensated"


def test_tool_006_double_prepare_commit_abort_keeps_terminal_state_monotonic(tmp_path) -> None:
    context, service, repositories, snapshot = _context(tmp_path)
    target = tmp_path / "idempotent.txt"
    target.write_text("before", encoding="utf-8")
    kwargs = {
        "session_id": context.session_id,
        "active_session_id": context.active_session_id,
        "snapshot_id": snapshot.id,
        "trace_id": context.trace_id,
        "turn_index": context.turn_index,
        "workspace_root": tmp_path,
        "tool_name": "edit_file",
        "tool_call_id": "call-idempotent",
        "mutations": [FileMutationSpec("idempotent.txt", "update")],
    }

    first = service.prepare_writes(**kwargs)
    second = service.prepare_writes(**kwargs)
    assert [item.id for item in second] == [item.id for item in first]
    target.write_text("after", encoding="utf-8")
    committed = service.commit_writes(first, workspace_root=tmp_path)
    replayed = service.commit_writes(second, workspace_root=tmp_path)
    assert replayed == committed

    service.abort_writes(first)
    persisted = repositories.file_history.get_mutation(first[0].id)
    assert persisted is not None and persisted.status == "committed"

    target.write_text("another", encoding="utf-8")
    next_snapshot = service.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id="trace-2",
        message_event_id="message-2",
        workspace_root=tmp_path,
    )
    aborted = service.prepare_writes(
        **{**kwargs, "snapshot_id": next_snapshot.id, "trace_id": "trace-2"}
    )
    service.abort_writes(aborted)
    service.abort_writes(aborted)
    with pytest.raises(FileHistoryError) as error:
        service.commit_writes(aborted, workspace_root=tmp_path)
    assert error.value.code == "file_restore_request_conflict"
    persisted_aborted = repositories.file_history.get_mutation(aborted[0].id)
    assert persisted_aborted is not None and persisted_aborted.status == "aborted"
