from __future__ import annotations

import random
import time

import pytest

from backend.app.services.file_history_service import (
    FileHistoryError,
    FileHistoryService,
    FileMutationSpec,
    FileRestoreDecision,
    FileRestoreMode,
)
from backend.app.services.session_fork_service import SessionReverseSource
from backend.app.services.session_reverse_service import (
    SessionReverseExecution,
    SessionReverseService,
)
from backend.app.storage import StorageRepositories, init_database

NOW = "2026-07-14T00:00:00Z"


class _CodeOnlyConversation:
    def resolve_reverse_source(self, *, session_id: str, message_event_id: str):
        turn_index = int(message_event_id.rsplit("-", 1)[-1])
        return SessionReverseSource(
            session_id=session_id,
            active_session_id=session_id,
            checkpoint_id=None,
            checkpoint_ns="",
            trace_id=f"trace-{session_id}-{turn_index}",
            turn_index=turn_index,
            message_event_id=message_event_id,
        )

    def rewind_conversation(self, *, source_session, source):  # pragma: no cover
        raise AssertionError(f"code-only rewind touched conversation: {source_session.id} {source}")


class _FailingConversation(_CodeOnlyConversation):
    def rewind_conversation(self, *, source_session, source):
        _ = source_session, source
        raise RuntimeError("injected conversation failure")


def _case(tmp_path, *session_ids: str):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    with repositories.db.connect() as conn:
        for session_id in session_ids:
            conn.execute(
                """
                insert into sessions (
                    id, user_id, scene_id, status, active_session_id,
                    session_type, cwd, created_at, updated_at
                ) values (?, 'user-1', 'scene-1', 'active', ?, 'workspace', ?, ?, ?)
                """,
                (session_id, session_id, str(tmp_path), NOW, NOW),
            )
    return (
        StorageRepositories(repositories.db),
        FileHistoryService(repositories, data_dir=tmp_path / "data"),
    )


def _message(repositories, session_id: str, index: int) -> tuple[str, str]:
    trace_id = f"trace-{session_id}-{index}"
    message_id = f"message-{session_id}-{index}"
    repositories.trace_records.create(
        trace_id=trace_id,
        session_id=session_id,
        active_session_id=session_id,
        scene_id="desktop-agent",
        user_id="user-1",
        turn_index=index,
        root_node_id=f"{trace_id}-root",
        input_checkpoint_id=None,
        input_checkpoint_ns="",
        status="completed",
    )
    repositories.message_events.append(
        event_id=message_id,
        session_id=session_id,
        trace_record_id=trace_id,
        turn_index=index,
        action="user_message",
        data={"content": f"input {session_id} {index}"},
    )
    return trace_id, message_id


def _snapshot_and_write(
    repositories,
    history,
    tmp_path,
    *,
    session_id: str,
    index: int,
    path: str,
    content: bytes,
):
    trace_id, message_id = _message(repositories, session_id, index)
    snapshot = history.make_input_snapshot(
        session_id=session_id,
        active_session_id=session_id,
        trace_id=trace_id,
        message_event_id=message_id,
        workspace_root=tmp_path,
    )
    target = tmp_path / path
    prepared = history.prepare_writes(
        session_id=session_id,
        active_session_id=session_id,
        snapshot_id=snapshot.id,
        trace_id=trace_id,
        turn_index=index,
        workspace_root=tmp_path,
        tool_name="write_file",
        tool_call_id=f"call-{session_id}-{index}",
        mutations=[
            FileMutationSpec(path=path, kind="update" if target.exists() else "create")
        ],
    )
    target.write_bytes(content)
    history.commit_writes(prepared, workspace_root=tmp_path)
    return message_id, snapshot


def _execute_code(
    history,
    repositories,
    tmp_path,
    session_id: str,
    message_id: str,
    request_id: str,
):
    preview = history.create_preview(
        session_id=session_id,
        active_session_id=session_id,
        message_event_id=message_id,
        workspace_root=tmp_path,
        source={"message_event_id": message_id},
    )
    result = SessionReverseService(
        repositories,
        file_history=history,
        conversation=_CodeOnlyConversation(),
    ).execute(
        session_id=session_id,
        workspace_root=tmp_path,
        request=SessionReverseExecution(
            operation_id=preview.operation_id,
            preview_token=preview.preview_token,
            request_id=request_id,
            message_event_id=message_id,
            mode=FileRestoreMode.CODE,
            decision=FileRestoreDecision.FULL,
        ),
    )
    return preview, result


def test_two_sessions_same_file_require_force_and_restore_writer_identity(tmp_path) -> None:
    repositories, history = _case(tmp_path, "session-a", "session-b")
    message_a, _ = _snapshot_and_write(
        repositories,
        history,
        tmp_path,
        session_id="session-a",
        index=1,
        path="shared.txt",
        content=b"from-a",
    )
    message_b, _ = _snapshot_and_write(
        repositories,
        history,
        tmp_path,
        session_id="session-b",
        index=1,
        path="shared.txt",
        content=b"from-b",
    )

    preview_a = history.create_preview(
        session_id="session-a",
        active_session_id="session-a",
        message_event_id=message_a,
        workspace_root=tmp_path,
        source={"message_event_id": message_a},
    )
    assert preview_a.files[0].classification == "forceable_conflict"
    assert preview_a.files[0].reason_code == "other_session_write"
    assert preview_a.files[0].writer_session_id == "session-b"

    with pytest.raises(FileHistoryError) as rejected:
        SessionReverseService(repositories, file_history=history).execute(
            session_id="session-a",
            workspace_root=tmp_path,
            request=SessionReverseExecution(
                operation_id=preview_a.operation_id,
                preview_token=preview_a.preview_token,
                request_id="request-a-full",
                message_event_id=message_a,
                mode=FileRestoreMode.CODE,
                decision=FileRestoreDecision.FULL,
            ),
        )
    assert rejected.value.code == "file_restore_conflict"
    assert (tmp_path / "shared.txt").read_bytes() == b"from-b"

    force_preview = history.create_preview(
        session_id="session-a",
        active_session_id="session-a",
        message_event_id=message_a,
        workspace_root=tmp_path,
        source={"message_event_id": message_a},
    )
    forced = SessionReverseService(repositories, file_history=history).execute(
        session_id="session-a",
        workspace_root=tmp_path,
        request=SessionReverseExecution(
            operation_id=force_preview.operation_id,
            preview_token=force_preview.preview_token,
            request_id="request-a-force",
            message_event_id=message_a,
            mode=FileRestoreMode.CODE,
            decision=FileRestoreDecision.FORCE_CONFLICTS,
        ),
    )
    assert forced.forced_files == (force_preview.files[0].resource_id,)
    assert not (tmp_path / "shared.txt").exists()
    workspace_identity = history.active_lineage("session-a")[-1].workspace_identity
    head = repositories.file_history.get_path_head(workspace_identity, "shared.txt")
    assert head is not None
    assert head.session_id == "session-a"
    assert head.state == "missing"

    message_a2, snapshot_a2 = _snapshot_and_write(
        repositories,
        history,
        tmp_path,
        session_id="session-a",
        index=2,
        path="shared.txt",
        content=b"after-force-edit",
    )
    assert snapshot_a2.parent_snapshot_id == history.active_lineage("session-a")[-2].id
    _preview_a2, rewind_a2 = _execute_code(
        history,
        repositories,
        tmp_path,
        "session-a",
        message_a2,
        "request-after-force",
    )
    assert rewind_a2.status == "full"
    assert not (tmp_path / "shared.txt").exists()

    preview_b = history.create_preview(
        session_id="session-b",
        active_session_id="session-b",
        message_event_id=message_b,
        workspace_root=tmp_path,
        source={"message_event_id": message_b},
    )
    assert preview_b.files[0].classification == "forceable_conflict"
    assert preview_b.files[0].reason_code == "other_session_write"
    assert preview_b.files[0].writer_session_id == "session-a"


def test_cross_session_force_compensation_restores_previous_writer_head(tmp_path) -> None:
    repositories, history = _case(tmp_path, "session-a", "session-b")
    message_a, _ = _snapshot_and_write(
        repositories,
        history,
        tmp_path,
        session_id="session-a",
        index=1,
        path="shared.txt",
        content=b"from-a",
    )
    _snapshot_and_write(
        repositories,
        history,
        tmp_path,
        session_id="session-b",
        index=1,
        path="shared.txt",
        content=b"from-b",
    )
    preview = history.create_preview(
        session_id="session-a",
        active_session_id="session-a",
        message_event_id=message_a,
        workspace_root=tmp_path,
        source={"message_event_id": message_a},
    )

    with pytest.raises(FileHistoryError) as failure:
        SessionReverseService(
            repositories,
            file_history=history,
            conversation=_FailingConversation(),
        ).execute(
            session_id="session-a",
            workspace_root=tmp_path,
            request=SessionReverseExecution(
                operation_id=preview.operation_id,
                preview_token=preview.preview_token,
                request_id="request-compensate",
                message_event_id=message_a,
                mode=FileRestoreMode.BOTH,
                decision=FileRestoreDecision.FORCE_CONFLICTS,
            ),
        )

    assert failure.value.code == "conversation_restore_failed"
    assert (tmp_path / "shared.txt").read_bytes() == b"from-b"
    workspace_identity = history.active_lineage("session-a")[-1].workspace_identity
    head = repositories.file_history.get_path_head(workspace_identity, "shared.txt")
    assert head is not None
    assert head.session_id == "session-b"
    assert head.content_hash == preview.files[0].current_hash


def test_partial_result_becomes_exact_baseline_for_next_edit_and_rewind(tmp_path) -> None:
    repositories, history = _case(tmp_path, "session-a", "session-b")
    trace_a1, message_a1 = _message(repositories, "session-a", 1)
    snapshot_a1 = history.make_input_snapshot(
        session_id="session-a",
        active_session_id="session-a",
        trace_id=trace_a1,
        message_event_id=message_a1,
        workspace_root=tmp_path,
    )
    prepared_a1 = history.prepare_writes(
        session_id="session-a",
        active_session_id="session-a",
        snapshot_id=snapshot_a1.id,
        trace_id=trace_a1,
        turn_index=1,
        workspace_root=tmp_path,
        tool_name="apply_patch",
        tool_call_id="call-a-1",
        mutations=[
            FileMutationSpec("ready.txt", "create"),
            FileMutationSpec("shared.txt", "create"),
        ],
    )
    (tmp_path / "ready.txt").write_bytes(b"ready-a")
    (tmp_path / "shared.txt").write_bytes(b"shared-a")
    history.commit_writes(prepared_a1, workspace_root=tmp_path)
    _snapshot_and_write(
        repositories,
        history,
        tmp_path,
        session_id="session-b",
        index=1,
        path="shared.txt",
        content=b"shared-b",
    )

    partial_preview = history.create_preview(
        session_id="session-a",
        active_session_id="session-a",
        message_event_id=message_a1,
        workspace_root=tmp_path,
        source={"message_event_id": message_a1},
    )
    partial = SessionReverseService(
        repositories,
        file_history=history,
        conversation=_CodeOnlyConversation(),
    ).execute(
        session_id="session-a",
        workspace_root=tmp_path,
        request=SessionReverseExecution(
            operation_id=partial_preview.operation_id,
            preview_token=partial_preview.preview_token,
            request_id="request-partial",
            message_event_id=message_a1,
            mode=FileRestoreMode.CODE,
            decision=FileRestoreDecision.SAFE_PARTIAL,
        ),
    )
    assert partial.status == "partial"
    assert not (tmp_path / "ready.txt").exists()
    assert (tmp_path / "shared.txt").read_bytes() == b"shared-b"

    history = FileHistoryService(repositories, data_dir=tmp_path / "data")
    cleanup = history.cleanup_history()
    assert cleanup["usage_bytes"] >= 0

    trace_a2, message_a2 = _message(repositories, "session-a", 2)
    snapshot_a2 = history.make_input_snapshot(
        session_id="session-a",
        active_session_id="session-a",
        trace_id=trace_a2,
        message_event_id=message_a2,
        workspace_root=tmp_path,
    )
    baseline = {
        entry.canonical_path: (entry.state, entry.content_hash)
        for entry in repositories.file_history.list_snapshot_entries(snapshot_a2.id)
    }
    assert baseline["ready.txt"] == ("missing", None)
    assert baseline["shared.txt"][0] == "file"

    prepared_a2 = history.prepare_writes(
        session_id="session-a",
        active_session_id="session-a",
        snapshot_id=snapshot_a2.id,
        trace_id=trace_a2,
        turn_index=2,
        workspace_root=tmp_path,
        tool_name="apply_patch",
        tool_call_id="call-a-2",
        mutations=[
            FileMutationSpec("ready.txt", "create"),
            FileMutationSpec("shared.txt", "update"),
        ],
    )
    (tmp_path / "ready.txt").write_bytes(b"ready-new")
    (tmp_path / "shared.txt").write_bytes(b"shared-new")
    history.commit_writes(prepared_a2, workspace_root=tmp_path)

    _preview, result = _execute_code(
        history,
        repositories,
        tmp_path,
        "session-a",
        message_a2,
        "request-after-partial",
    )
    assert result.status == "full"
    assert not (tmp_path / "ready.txt").exists()
    assert (tmp_path / "shared.txt").read_bytes() == b"shared-b"


def test_twenty_round_rewind_edit_rewind_matches_reference_state(tmp_path) -> None:
    repositories, history = _case(tmp_path, "session-1")
    rng = random.Random(20260714)
    reference = {"a.txt": None, "b.txt": None, "c.bin": None}
    operations: list[str] = []

    for round_index in range(1, 21):
        path = rng.choice(sorted(reference))
        before = reference[path]
        content = rng.randbytes(12)
        message_id, _ = _snapshot_and_write(
            repositories,
            history,
            tmp_path,
            session_id="session-1",
            index=round_index,
            path=path,
            content=content,
        )
        reference[path] = content

        preview, result = _execute_code(
            history,
            repositories,
            tmp_path,
            "session-1",
            message_id,
            f"request-{round_index}",
        )
        operations.append(preview.operation_id)
        reference[path] = before

        assert result.status == "full", (round_index, operations)
        for expected_path, expected_content in reference.items():
            disk_path = tmp_path / expected_path
            assert disk_path.exists() is (expected_content is not None), (
                round_index,
                operations,
            )
            if expected_content is not None:
                assert disk_path.read_bytes() == expected_content, (round_index, operations)
        state = repositories.file_history.get_session_state("session-1")
        assert state is not None
        active = repositories.file_history.get_snapshot(state.active_snapshot_id)
        assert active is not None and active.kind == "restore_result"

        with pytest.raises(FileHistoryError) as replay_with_new_request:
            SessionReverseService(
                repositories,
                file_history=history,
                conversation=_CodeOnlyConversation(),
            ).execute(
                session_id="session-1",
                workspace_root=tmp_path,
                request=SessionReverseExecution(
                    operation_id=preview.operation_id,
                    preview_token=preview.preview_token,
                    request_id=f"stale-{round_index}",
                    message_event_id=message_id,
                    mode=FileRestoreMode.CODE,
                    decision=FileRestoreDecision.FULL,
                ),
            )
        assert replay_with_new_request.value.code == "file_preview_stale"


@pytest.mark.performance
def test_thousand_path_preview_and_restore_stays_bounded(tmp_path) -> None:
    repositories, history = _case(tmp_path, "session-1")
    trace_id, message_id = _message(repositories, "session-1", 1)
    snapshot = history.make_input_snapshot(
        session_id="session-1",
        active_session_id="session-1",
        trace_id=trace_id,
        message_event_id=message_id,
        workspace_root=tmp_path,
    )
    specs = [FileMutationSpec(f"files/{index:04d}.txt", "create") for index in range(1000)]
    started = time.perf_counter()
    prepared = history.prepare_writes(
        session_id="session-1",
        active_session_id="session-1",
        snapshot_id=snapshot.id,
        trace_id=trace_id,
        turn_index=1,
        workspace_root=tmp_path,
        tool_name="apply_patch",
        tool_call_id="scale-call",
        mutations=specs,
    )
    for index in range(1000):
        path = tmp_path / "files" / f"{index:04d}.txt"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"value-{index}".encode())
    history.commit_writes(prepared, workspace_root=tmp_path)

    preview = history.create_preview(
        session_id="session-1",
        active_session_id="session-1",
        message_event_id=message_id,
        workspace_root=tmp_path,
        source={"message_event_id": message_id},
    )
    assert len(preview.files) == 1000
    assert all(item.target_state == "missing" for item in preview.files)
    _, result = _execute_code(
        history,
        repositories,
        tmp_path,
        "session-1",
        message_id,
        "scale-request",
    )
    assert result.status == "full"
    assert len(result.restored_files) == 1000
    assert not any((tmp_path / "files").iterdir())
    assert time.perf_counter() - started < 60
