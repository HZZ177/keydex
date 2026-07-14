from __future__ import annotations

from backend.app.services.file_history_service import FileMutationSpec
from backend.tests.services.test_file_history_advanced_scenarios import (
    _case,
    _execute_code,
    _message,
)


def _prepare(history, repositories, tmp_path, *, index: int, specs):
    trace_id, message_id = _message(repositories, "session-a", index)
    snapshot = history.make_input_snapshot(
        session_id="session-a",
        active_session_id="session-a",
        trace_id=trace_id,
        message_event_id=message_id,
        workspace_root=tmp_path,
    )
    mutations = history.prepare_writes(
        session_id="session-a",
        active_session_id="session-a",
        snapshot_id=snapshot.id,
        trace_id=trace_id,
        turn_index=index,
        workspace_root=tmp_path,
        tool_name="apply_patch",
        tool_call_id=f"call-structural-{index}",
        mutations=specs,
    )
    return message_id, snapshot, mutations


def test_cycle_007_create_rewind_recreate_keeps_missing_state_exact(tmp_path) -> None:
    repositories, history = _case(tmp_path, "session-a")
    path = tmp_path / "created.txt"
    first_message, first, first_mutations = _prepare(
        history,
        repositories,
        tmp_path,
        index=1,
        specs=[FileMutationSpec("created.txt", "create")],
    )
    path.write_bytes(b"first")
    history.commit_writes(first_mutations, workspace_root=tmp_path)

    _execute_code(history, repositories, tmp_path, "session-a", first_message, "create-1")
    assert not path.exists()

    second_message, second, second_mutations = _prepare(
        history,
        repositories,
        tmp_path,
        index=2,
        specs=[FileMutationSpec("created.txt", "create")],
    )
    assert repositories.file_history.list_snapshot_entries(second.id)[0].state == "missing"
    path.write_bytes(b"second")
    history.commit_writes(second_mutations, workspace_root=tmp_path)

    _execute_code(history, repositories, tmp_path, "session-a", second_message, "create-2")
    assert not path.exists()
    assert first.id != second.id
    assert repositories.file_history.get_snapshot(first.id) is not None
    assert repositories.file_history.get_snapshot(second.id) is not None
    assert {
        item.target_snapshot_id
        for item in repositories.file_history.list_operations(session_id="session-a")
    } == {first.id, second.id}


def test_cycle_007_delete_rewind_rebuild_then_edit_restores_each_preimage(tmp_path) -> None:
    repositories, history = _case(tmp_path, "session-a")
    path = tmp_path / "delete.txt"
    path.write_bytes(b"original")
    first_message, _first, first_mutations = _prepare(
        history,
        repositories,
        tmp_path,
        index=1,
        specs=[FileMutationSpec("delete.txt", "delete")],
    )
    path.unlink()
    history.commit_writes(first_mutations, workspace_root=tmp_path)

    _execute_code(history, repositories, tmp_path, "session-a", first_message, "delete-1")
    assert path.read_bytes() == b"original"

    second_message, _second, second_mutations = _prepare(
        history,
        repositories,
        tmp_path,
        index=2,
        specs=[FileMutationSpec("delete.txt", "update")],
    )
    path.write_bytes(b"edited")
    history.commit_writes(second_mutations, workspace_root=tmp_path)
    _execute_code(history, repositories, tmp_path, "session-a", second_message, "delete-2")
    assert path.read_bytes() == b"original"


def test_cycle_007_move_overwrite_rewind_restores_both_paths_as_one_batch(tmp_path) -> None:
    repositories, history = _case(tmp_path, "session-a")
    source = tmp_path / "source.bin"
    destination = tmp_path / "nested" / "target.bin"
    source.write_bytes(b"source-before")
    destination.parent.mkdir()
    destination.write_bytes(b"target-before")
    message_id, _snapshot, mutations = _prepare(
        history,
        repositories,
        tmp_path,
        index=1,
        specs=[
            FileMutationSpec("source.bin", "move_source"),
            FileMutationSpec("nested/target.bin", "move_destination"),
        ],
    )
    source.replace(destination)
    history.commit_writes(mutations, workspace_root=tmp_path)
    assert not source.exists()
    assert destination.read_bytes() == b"source-before"

    _execute_code(history, repositories, tmp_path, "session-a", message_id, "move-1")
    assert source.read_bytes() == b"source-before"
    assert destination.read_bytes() == b"target-before"
    batches = {
        item.batch_id
        for item in repositories.file_history.list_mutations(session_id="session-a")
    }
    assert len(batches) == 1


def test_cycle_007_multi_patch_rewind_never_splits_add_update_delete(tmp_path) -> None:
    repositories, history = _case(tmp_path, "session-a")
    (tmp_path / "update.txt").write_bytes(b"update-before")
    (tmp_path / "delete.txt").write_bytes(b"delete-before")
    message_id, _snapshot, mutations = _prepare(
        history,
        repositories,
        tmp_path,
        index=1,
        specs=[
            FileMutationSpec("add.txt", "create"),
            FileMutationSpec("update.txt", "update"),
            FileMutationSpec("delete.txt", "delete"),
        ],
    )
    (tmp_path / "add.txt").write_bytes(b"added")
    (tmp_path / "update.txt").write_bytes(b"updated")
    (tmp_path / "delete.txt").unlink()
    history.commit_writes(mutations, workspace_root=tmp_path)

    _preview, result = _execute_code(
        history,
        repositories,
        tmp_path,
        "session-a",
        message_id,
        "patch-1",
    )
    assert result.status == "full"
    assert not (tmp_path / "add.txt").exists()
    assert (tmp_path / "update.txt").read_bytes() == b"update-before"
    assert (tmp_path / "delete.txt").read_bytes() == b"delete-before"
    assert set(result.restored_files) == {"add.txt", "delete.txt", "update.txt"}
