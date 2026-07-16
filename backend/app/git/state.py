from __future__ import annotations

from pathlib import Path
from typing import Literal

from .models import GitInProgressOperationResponse

GitOperationMachineState = Literal["idle", "running", "conflicted", "continuable", "aborting"]
GitOperationMachineEvent = Literal[
    "start", "conflict", "resolve", "continue", "abort", "complete", "fail"
]

_TRANSITIONS: dict[
    tuple[GitOperationMachineState, GitOperationMachineEvent], GitOperationMachineState
] = {
    ("idle", "start"): "running",
    ("running", "conflict"): "conflicted",
    ("running", "complete"): "idle",
    ("running", "fail"): "continuable",
    ("running", "abort"): "aborting",
    ("conflicted", "resolve"): "continuable",
    ("conflicted", "abort"): "aborting",
    ("conflicted", "complete"): "idle",
    ("continuable", "continue"): "running",
    ("continuable", "conflict"): "conflicted",
    ("continuable", "abort"): "aborting",
    ("continuable", "complete"): "idle",
    ("aborting", "complete"): "idle",
    ("aborting", "fail"): "continuable",
}


def transition_operation_state(
    state: GitOperationMachineState,
    event: GitOperationMachineEvent,
) -> GitOperationMachineState:
    try:
        return _TRANSITIONS[(state, event)]
    except KeyError as exc:
        raise ValueError(f"Illegal Git operation transition: {state} + {event}") from exc


def detect_in_progress_operation(
    git_dir: str | Path,
    *,
    has_unmerged_files: bool,
) -> GitInProgressOperationResponse | None:
    root = Path(git_dir)
    rebase_merge = root / "rebase-merge"
    rebase_apply = root / "rebase-apply"
    if rebase_merge.is_dir() or rebase_apply.is_dir():
        state_dir = rebase_merge if rebase_merge.is_dir() else rebase_apply
        current = _positive_int(state_dir / "msgnum") or _positive_int(state_dir / "next")
        total = _positive_int(state_dir / "end") or _positive_int(state_dir / "last")
        current_oid = _first_text(state_dir / "stopped-sha") or _first_text(root / "REBASE_HEAD")
        return GitInProgressOperationResponse(
            kind="rebase",
            state="conflicted" if has_unmerged_files else "continuable",
            current_step=current,
            total_steps=total,
            current_object_id=current_oid,
        )
    marker_kinds = (
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry_pick"),
        ("REVERT_HEAD", "revert"),
    )
    for marker, kind in marker_kinds:
        marker_path = root / marker
        if marker_path.is_file():
            current_object_id = _first_text(marker_path)
            current_step, total_steps = _sequencer_progress(root, current_object_id)
            return GitInProgressOperationResponse(
                kind=kind,
                state="conflicted" if has_unmerged_files else "continuable",
                current_step=current_step,
                total_steps=total_steps,
                current_object_id=current_object_id,
            )
    if (root / "BISECT_LOG").is_file() or (root / "BISECT_START").is_file():
        return GitInProgressOperationResponse(
            kind="bisect",
            state="running",
            current_object_id=None,
        )
    if has_unmerged_files:
        return GitInProgressOperationResponse(
            kind="stash_apply",
            state="conflicted",
            current_object_id=None,
        )
    return None


def _first_text(path: Path) -> str | None:
    try:
        value = path.read_text(encoding="utf-8", errors="replace").splitlines()[0].strip()
    except (OSError, IndexError):
        return None
    return value or None


def _positive_int(path: Path) -> int | None:
    value = _first_text(path)
    if not value:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed > 0 else None


def _sequencer_progress(root: Path, current_object_id: str | None) -> tuple[int | None, int | None]:
    sequencer = root / "sequencer"
    if not sequencer.is_dir():
        return None, None
    done = _sequencer_items(sequencer / "done")
    todo = _sequencer_items(sequencer / "todo")
    total = len(done) + len(todo)
    if total == 0:
        return None, None
    prefix = current_object_id[: min(12, len(current_object_id))] if current_object_id else None
    current_in_done = bool(prefix and done and done[-1].startswith(prefix))
    current = len(done) if current_in_done else len(done) + 1
    return max(1, min(current, total)), total


def _sequencer_items(path: Path) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    items: list[str] = []
    for line in lines:
        normalized = line.strip()
        if not normalized or normalized.startswith("#"):
            continue
        parts = normalized.split(maxsplit=2)
        items.append(parts[1] if len(parts) > 1 else parts[0])
    return items
