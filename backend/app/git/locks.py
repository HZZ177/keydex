from __future__ import annotations

import asyncio
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeVar

from .runner import GitCommandResult

T = TypeVar("T", bound=GitCommandResult)


@dataclass(frozen=True)
class GitLockFailure:
    kind: str
    path_hint: str | None
    retryable: bool


@dataclass(frozen=True)
class GitLockRetryPolicy:
    # Keep transient editor/IDE locks recoverable while leaving a long enough
    # running window for the operation log to expose explicit cancellation.
    delays_seconds: tuple[float, ...] = (
        0.08,
        0.2,
        0.5,
        1.0,
        1.0,
        1.0,
        1.0,
        1.0,
        1.0,
        1.0,
        1.0,
        1.0,
        1.0,
    )


DEFAULT_GIT_LOCK_RETRY_POLICY = GitLockRetryPolicy()


_LOCK_PATH = re.compile(r"(?i)([^\s'\"]+(?:index|packed-refs|config|shallow)\.lock)")


def classify_git_lock_failure(stderr: str) -> GitLockFailure | None:
    text = stderr.strip()
    lowered = text.casefold()
    path_match = _LOCK_PATH.search(text)
    if path_match:
        path_hint = path_match.group(1)
        kind = "index_lock" if "index.lock" in path_hint.casefold() else "reference_lock"
        return GitLockFailure(kind=kind, path_hint=path_hint, retryable=True)
    if "sharing violation" in lowered or "used by another process" in lowered:
        return GitLockFailure(kind="windows_sharing_violation", path_hint=None, retryable=True)
    if "permission denied" in lowered and ".git" in lowered:
        return GitLockFailure(kind="repository_permission", path_hint=None, retryable=False)
    return None


async def run_with_git_lock_retry(
    operation: Callable[[], Awaitable[T]],
    *,
    policy: GitLockRetryPolicy = DEFAULT_GIT_LOCK_RETRY_POLICY,
    on_retry: Callable[[GitLockFailure, int, float], None] | None = None,
) -> T:
    attempt = 0
    while True:
        result = await operation()
        if result.returncode == 0:
            return result
        failure = classify_git_lock_failure(result.stderr)
        if failure is None or not failure.retryable or attempt >= len(policy.delays_seconds):
            return result
        delay = policy.delays_seconds[attempt]
        attempt += 1
        on_retry and on_retry(failure, attempt, delay)
        await asyncio.sleep(delay)
