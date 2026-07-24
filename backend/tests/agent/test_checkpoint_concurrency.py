from __future__ import annotations

import asyncio
import sqlite3
import threading
from pathlib import Path
from typing import Any

import pytest
from langchain_core.runnables import RunnableConfig

from backend.app.agent.checkpoint import (
    CheckpointStorageBusy,
    CheckpointStoreClosing,
)
from backend.app.agent.checkpoint_runtime import CheckpointRuntime
from backend.tests.agent.test_async_sqlite_saver_conformance import checkpoint, config


@pytest.mark.asyncio
async def test_runtime_saver_autocommit_does_not_strand_business_writer(
    tmp_path: Path,
) -> None:
    runtime = CheckpointRuntime(tmp_path / "app.db")
    assert await runtime.start()
    connection = runtime.connection
    assert connection is not None
    assert connection.isolation_level is None

    await connection.execute(
        """
        CREATE TABLE IF NOT EXISTS checkpoint_autocommit_probe (
            value TEXT NOT NULL
        )
        """
    )
    await connection.execute(
        "INSERT INTO checkpoint_autocommit_probe (value) VALUES ('checkpoint')"
    )

    with sqlite3.connect(runtime.database_path, timeout=0.5) as business_connection:
        business_connection.execute("BEGIN IMMEDIATE")
        business_connection.execute(
            "INSERT INTO checkpoint_autocommit_probe (value) VALUES ('business')"
        )

    rows = await (
        await connection.execute(
            "SELECT value FROM checkpoint_autocommit_probe ORDER BY rowid"
        )
    ).fetchall()
    assert rows == [("checkpoint",), ("business",)]
    await runtime.close()


@pytest.mark.asyncio
async def test_concurrent_writes_keep_event_loop_heartbeat_alive(tmp_path: Path) -> None:
    runtime = CheckpointRuntime(tmp_path / "app.db")
    assert await runtime.start()
    store = runtime.require_store()
    saved = await store.aput(
        config("thread-a"),
        checkpoint("00000000000000000000000000000001", "root"),
        {"source": "input"},
        {"messages": "1"},
    )
    stop = asyncio.Event()
    heartbeat_count = 0

    async def heartbeat() -> None:
        nonlocal heartbeat_count
        while not stop.is_set():
            heartbeat_count += 1
            await asyncio.sleep(0)

    heartbeat_task = asyncio.create_task(heartbeat())
    try:
        await asyncio.wait_for(
            asyncio.gather(
                *(
                    store.aput_writes(
                        saved,
                        [("messages", {"index": index})],
                        f"task-{index:03}",
                    )
                    for index in range(100)
                )
            ),
            timeout=15,
        )
    finally:
        stop.set()
        await heartbeat_task

    loaded = await store.aget_tuple(saved)
    assert loaded is not None
    assert len(loaded.pending_writes or []) == 100
    assert heartbeat_count >= 10
    await runtime.close()


@pytest.mark.asyncio
async def test_standard_and_extension_operations_share_outer_lock(
    tmp_path: Path,
) -> None:
    runtime = CheckpointRuntime(tmp_path / "app.db")
    assert await runtime.start()
    store = runtime.require_store()
    extension_entered = threading.Event()
    release_extension = threading.Event()
    observed_outer_lock: list[bool] = []

    def extension_operation() -> str:
        observed_outer_lock.append(runtime.operation_lock.locked())
        extension_entered.set()
        assert release_extension.wait(timeout=5)
        with sqlite3.connect(runtime.database_path) as connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS extension_probe (value TEXT NOT NULL)"
            )
            connection.execute("INSERT INTO extension_probe (value) VALUES ('done')")
        return "done"

    extension_task = asyncio.create_task(store.run_extension(extension_operation))
    assert await asyncio.to_thread(extension_entered.wait, 2)
    standard_task = asyncio.create_task(
        store.aput(
            config("thread-a"),
            checkpoint("00000000000000000000000000000001", "root"),
            {"source": "input"},
            {"messages": "1"},
        )
    )
    await asyncio.sleep(0)
    assert not standard_task.done()

    release_extension.set()
    assert await asyncio.wait_for(extension_task, timeout=5) == "done"
    saved = await asyncio.wait_for(standard_task, timeout=5)
    assert observed_outer_lock == [True]
    assert await store.aget_tuple(saved) is not None
    await runtime.close()


@pytest.mark.asyncio
async def test_sqlite_busy_is_classified_and_bounded(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime = CheckpointRuntime(tmp_path / "app.db")
    assert await runtime.start()
    store = runtime.require_store()
    official = store._official_saver

    async def raise_busy(*_args: Any, **_kwargs: Any) -> RunnableConfig:
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(official, "aput", raise_busy)
    with pytest.raises(CheckpointStorageBusy) as raised:
        await asyncio.wait_for(
            store.aput(
                config("thread-a"),
                checkpoint("00000000000000000000000000000001", "busy"),
                {"source": "input"},
                {"messages": "1"},
            ),
            timeout=1,
        )

    assert raised.value.code == "checkpoint_storage_busy"
    assert "database" not in str(raised.value).lower()
    assert not runtime.operation_lock.locked()
    await runtime.close()


@pytest.mark.asyncio
async def test_shutdown_rejects_queued_operation_and_closes_connection(
    tmp_path: Path,
) -> None:
    runtime = CheckpointRuntime(tmp_path / "app.db")
    assert await runtime.start()
    store = runtime.require_store()
    await runtime.operation_lock.acquire()
    queued = asyncio.create_task(
        store.aput(
            config("thread-a"),
            checkpoint("00000000000000000000000000000001", "queued"),
            {"source": "input"},
            {"messages": "1"},
        )
    )
    await asyncio.sleep(0)
    closing = asyncio.create_task(runtime.close())
    await asyncio.sleep(0)
    runtime.operation_lock.release()

    with pytest.raises(CheckpointStoreClosing):
        await asyncio.wait_for(queued, timeout=2)
    await asyncio.wait_for(closing, timeout=2)
    assert runtime.connection is None
