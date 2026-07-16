from __future__ import annotations

import asyncio

import pytest

from backend.app.git.operations import GitOperationQueue


@pytest.mark.asyncio
async def test_same_repository_writes_are_serial_and_duplicate_submissions_are_idempotent() -> None:
    queue = GitOperationQueue()
    release_first = asyncio.Event()
    events: list[str] = []

    async def first(_context):
        events.append("first:start")
        await release_first.wait()
        events.append("first:end")
        return "first"

    async def second(_context):
        events.append("second:start")
        return "second"

    first_handle = queue.submit(
        repository_id="repo-a", idempotency_key="request-first", operation=first
    )
    duplicate = queue.submit(
        repository_id="repo-a", idempotency_key="request-first", operation=second
    )
    second_handle = queue.submit(
        repository_id="repo-a", idempotency_key="request-second", operation=second
    )
    await asyncio.sleep(0)
    assert duplicate.operation_id == first_handle.operation_id
    assert events == ["first:start"]
    release_first.set()
    assert await first_handle.result() == "first"
    assert await duplicate.result() == "first"
    assert await second_handle.result() == "second"
    assert events == ["first:start", "first:end", "second:start"]


@pytest.mark.asyncio
async def test_different_repositories_run_independently() -> None:
    queue = GitOperationQueue()
    both_started = asyncio.Event()
    started: set[str] = set()

    async def operation(context):
        started.add(context.repository_id)
        if len(started) == 2:
            both_started.set()
        await both_started.wait()
        return context.repository_id

    left = queue.submit(repository_id="repo-a", idempotency_key="request-a", operation=operation)
    right = queue.submit(repository_id="repo-b", idempotency_key="request-b", operation=operation)
    assert {await left.result(), await right.result()} == {"repo-a", "repo-b"}


@pytest.mark.asyncio
async def test_queued_and_running_operations_can_be_cancelled_cooperatively() -> None:
    queue = GitOperationQueue()
    release = asyncio.Event()

    async def blocking(context):
        await context.cancel_event.wait()
        return "cancelled"

    async def queued(_context):
        await release.wait()
        return "should-not-run"

    running = queue.submit(
        repository_id="repo-a", idempotency_key="request-running", operation=blocking
    )
    queued_handle = queue.submit(
        repository_id="repo-a", idempotency_key="request-queued", operation=queued
    )
    await asyncio.sleep(0)
    assert queued_handle.cancel() is True
    assert running.cancel() is True
    assert await running.result() == "cancelled"
    assert await queued_handle.result() is None
    assert running.snapshot.state == "cancelled"
    assert queued_handle.snapshot.state == "cancelled"
