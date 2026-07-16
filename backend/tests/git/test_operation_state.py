from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.git.security import resolve_repository_layout
from backend.app.git.state import detect_in_progress_operation, transition_operation_state


def test_detects_rebase_progress_and_current_commit_from_metadata(tmp_path: Path) -> None:
    git_dir = tmp_path / ".git"
    state = git_dir / "rebase-merge"
    state.mkdir(parents=True)
    (state / "msgnum").write_text("2\n", encoding="utf-8")
    (state / "end").write_text("5\n", encoding="utf-8")
    (state / "stopped-sha").write_text("abcdef12\n", encoding="utf-8")

    operation = detect_in_progress_operation(git_dir, has_unmerged_files=True)
    assert operation is not None
    assert operation.model_dump() == {
        "kind": "rebase",
        "state": "conflicted",
        "current_step": 2,
        "total_steps": 5,
        "current_object_id": "abcdef12",
    }


def test_detects_merge_cherry_revert_bisect_and_idle_markers(tmp_path: Path) -> None:
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    for marker, expected in [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry_pick"),
        ("REVERT_HEAD", "revert"),
    ]:
        path = git_dir / marker
        path.write_text("deadbeef\n", encoding="utf-8")
        operation = detect_in_progress_operation(git_dir, has_unmerged_files=False)
        assert operation is not None
        assert operation.kind == expected
        assert operation.state == "continuable"
        path.unlink()
    (git_dir / "BISECT_LOG").write_text("git bisect start\n", encoding="utf-8")
    assert detect_in_progress_operation(git_dir, has_unmerged_files=False).kind == "bisect"  # type: ignore[union-attr]
    (git_dir / "BISECT_LOG").unlink()
    assert detect_in_progress_operation(git_dir, has_unmerged_files=False) is None


def test_detects_real_merge_conflict_and_clears_after_abort(git_repo_factory) -> None:
    repository = git_repo_factory.create("operation-state")
    repository.create_conflict()
    layout = resolve_repository_layout(repository.path)
    operation = detect_in_progress_operation(layout.git_dir, has_unmerged_files=True)
    assert operation is not None
    assert operation.kind == "merge"
    assert operation.state == "conflicted"
    repository.run("merge", "--abort")
    assert detect_in_progress_operation(layout.git_dir, has_unmerged_files=False) is None


def test_recovers_cherry_pick_sequence_progress_from_git_metadata(tmp_path: Path) -> None:
    git_dir = tmp_path / ".git"
    sequencer = git_dir / "sequencer"
    sequencer.mkdir(parents=True)
    current = "b" * 40
    (git_dir / "CHERRY_PICK_HEAD").write_text(f"{current}\n", encoding="utf-8")
    (sequencer / "done").write_text(
        f"pick {'a' * 40} first\npick {current} second\n", encoding="utf-8"
    )
    (sequencer / "todo").write_text(f"pick {'c' * 40} third\n", encoding="utf-8")

    operation = detect_in_progress_operation(git_dir, has_unmerged_files=True)
    assert operation is not None
    assert operation.kind == "cherry_pick"
    assert operation.current_step == 2
    assert operation.total_steps == 3


def test_operation_transition_table_accepts_only_declared_state_changes() -> None:
    expected = {
        ("idle", "start"): "running",
        ("running", "conflict"): "conflicted",
        ("conflicted", "resolve"): "continuable",
        ("continuable", "continue"): "running",
        ("running", "abort"): "aborting",
        ("aborting", "complete"): "idle",
        ("continuable", "complete"): "idle",
    }
    for (state, event), result in expected.items():
        assert transition_operation_state(state, event) == result  # type: ignore[arg-type]
    with pytest.raises(ValueError, match="Illegal Git operation transition"):
        transition_operation_state("idle", "continue")
