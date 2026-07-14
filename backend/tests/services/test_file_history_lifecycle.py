from __future__ import annotations

from backend.app.services.file_history_service import (
    FileHistoryService,
    FileRestoreDecision,
    FileRestoreMode,
)
from backend.app.services.session_reverse_service import (
    SessionReverseExecution,
    SessionReverseService,
)
from backend.app.storage import StorageRepositories, init_database
from backend.tests.services.test_file_history_advanced_scenarios import (
    _case,
    _CodeOnlyConversation,
    _snapshot_and_write,
)


def test_store_005_preview_and_resume_survive_fresh_repository_process_state(tmp_path) -> None:
    repositories, history = _case(tmp_path, "session-a")
    message_id, _snapshot = _snapshot_and_write(
        repositories,
        history,
        tmp_path,
        session_id="session-a",
        index=1,
        path="resume.txt",
        content=b"after",
    )
    preview = history.create_preview(
        session_id="session-a",
        active_session_id="session-a",
        message_event_id=message_id,
        workspace_root=tmp_path,
        source={"message_event_id": message_id},
    )

    resumed_repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    resumed_history = FileHistoryService(
        resumed_repositories,
        data_dir=tmp_path / "data",
    )
    result = SessionReverseService(
        resumed_repositories,
        file_history=resumed_history,
        conversation=_CodeOnlyConversation(),
    ).execute(
        session_id="session-a",
        workspace_root=tmp_path,
        request=SessionReverseExecution(
            operation_id=preview.operation_id,
            preview_token=preview.preview_token,
            request_id="request-after-restart",
            message_event_id=message_id,
            mode=FileRestoreMode.CODE,
            decision=FileRestoreDecision.FULL,
        ),
    )

    assert result.status == "full"
    assert not (tmp_path / "resume.txt").exists()
    state = resumed_repositories.file_history.get_session_state("session-a")
    assert state is not None
    assert resumed_history.active_lineage("session-a")[0].id == state.active_snapshot_id


def test_store_005_fork_scope_starts_empty_and_both_sides_write_independently(tmp_path) -> None:
    repositories, history = _case(tmp_path, "session-a", "fork-a")
    message_a, snapshot_a = _snapshot_and_write(
        repositories,
        history,
        tmp_path,
        session_id="session-a",
        index=1,
        path="shared.txt",
        content=b"from-a",
    )
    assert history.active_lineage("fork-a") == []
    assert repositories.file_history.list_tracked_files("fork-a") == []

    message_fork, snapshot_fork = _snapshot_and_write(
        repositories,
        history,
        tmp_path,
        session_id="fork-a",
        index=1,
        path="shared.txt",
        content=b"from-fork",
    )

    assert snapshot_fork.parent_snapshot_id is None
    assert snapshot_fork.id != snapshot_a.id
    assert {
        item.session_id
        for item in repositories.file_history.list_mutations(session_id="session-a")
    } == {"session-a"}
    assert {
        item.session_id
        for item in repositories.file_history.list_mutations(session_id="fork-a")
    } == {"fork-a"}

    preview_a = history.create_preview(
        session_id="session-a",
        active_session_id="session-a",
        message_event_id=message_a,
        workspace_root=tmp_path,
        source={"message_event_id": message_a},
    )
    preview_fork = history.create_preview(
        session_id="fork-a",
        active_session_id="fork-a",
        message_event_id=message_fork,
        workspace_root=tmp_path,
        source={"message_event_id": message_fork},
    )
    assert preview_a.files[0].classification == "forceable_conflict"
    assert preview_a.files[0].writer_session_id == "fork-a"
    assert preview_fork.files[0].classification == "ready"
