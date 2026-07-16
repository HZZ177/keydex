from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.git.locks import (
    GitLockRetryPolicy,
    classify_git_lock_failure,
    run_with_git_lock_retry,
)
from backend.app.git.runner import GitCommandResult


def result(returncode: int, stderr: str = "") -> GitCommandResult:
    return GitCommandResult(
        argv=("git", "status"),
        cwd=Path.cwd(),
        returncode=returncode,
        stdout="",
        stderr=stderr,
        duration_ms=1,
    )


@pytest.mark.parametrize(
    ("stderr", "kind", "retryable"),
    [
        ("fatal: Unable to create 'D:/repo/.git/index.lock': File exists.", "index_lock", True),
        ("cannot lock ref 'HEAD': D:/repo/.git/packed-refs.lock", "reference_lock", True),
        (
            "The process cannot access the file because it is used by another process",
            "windows_sharing_violation",
            True,
        ),
        ("fatal: .git permission denied", "repository_permission", False),
    ],
)
def test_classifies_transient_and_permanent_repository_locks(
    stderr: str, kind: str, retryable: bool
) -> None:
    failure = classify_git_lock_failure(stderr)
    assert failure is not None
    assert failure.kind == kind
    assert failure.retryable is retryable


@pytest.mark.asyncio
async def test_retries_only_within_the_bounded_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    attempts = 0
    sleeps: list[float] = []
    retries: list[tuple[int, float]] = []

    async def operation():
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            return result(128, "fatal: Unable to create '.git/index.lock': File exists")
        return result(0)

    async def fake_sleep(delay: float):
        sleeps.append(delay)

    monkeypatch.setattr("backend.app.git.locks.asyncio.sleep", fake_sleep)
    final = await run_with_git_lock_retry(
        operation,
        policy=GitLockRetryPolicy((0.01, 0.02)),
        on_retry=lambda _failure, attempt, delay: retries.append((attempt, delay)),
    )
    assert final.returncode == 0
    assert attempts == 3
    assert sleeps == [0.01, 0.02]
    assert retries == [(1, 0.01), (2, 0.02)]


@pytest.mark.asyncio
async def test_does_not_retry_or_delete_unknown_and_permission_failures() -> None:
    attempts = 0

    async def operation():
        nonlocal attempts
        attempts += 1
        return result(128, "fatal: .git permission denied")

    final = await run_with_git_lock_retry(operation)
    assert final.returncode == 128
    assert attempts == 1
