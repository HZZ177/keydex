from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path
from typing import Any, Protocol

import aiosqlite
import pytest
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    WRITES_IDX_MAP,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from backend.app.agent.checkpoint import KeydexAsyncCheckpointStore


class AsyncSaverContract(Protocol):
    async def setup(self) -> None: ...

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: dict[str, str | int | float],
    ) -> RunnableConfig: ...

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None: ...

    def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]: ...

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: list[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None: ...

    async def adelete_thread(self, thread_id: str) -> None: ...


CHECKPOINT_COLUMNS = [
    "thread_id",
    "checkpoint_ns",
    "checkpoint_id",
    "parent_checkpoint_id",
    "type",
    "checkpoint",
    "metadata",
]
WRITES_COLUMNS = [
    "thread_id",
    "checkpoint_ns",
    "checkpoint_id",
    "task_id",
    "idx",
    "channel",
    "type",
    "value",
]


def checkpoint(checkpoint_id: str, message: str) -> Checkpoint:
    """Build a deterministic checkpoint shared by official/wrapper conformance."""
    return Checkpoint(
        v=2,
        id=checkpoint_id,
        ts=f"2026-07-24T00:00:{checkpoint_id[-2:]}+00:00",
        channel_values={"messages": [message]},
        channel_versions={"messages": checkpoint_id},
        versions_seen={},
        pending_sends=[],
        updated_channels=["messages"],
    )


def config(
    thread_id: str,
    *,
    checkpoint_ns: str = "",
    checkpoint_id: str | None = None,
) -> RunnableConfig:
    configurable: dict[str, Any] = {
        "thread_id": thread_id,
        "checkpoint_ns": checkpoint_ns,
    }
    if checkpoint_id is not None:
        configurable["checkpoint_id"] = checkpoint_id
    return {"configurable": configurable}


@asynccontextmanager
async def open_official_saver(
    database_path: Path,
) -> AsyncIterator[AsyncSaverContract]:
    async with aiosqlite.connect(database_path) as connection:
        yield AsyncSqliteSaver(connection)


@asynccontextmanager
async def open_keydex_store(
    database_path: Path,
) -> AsyncIterator[AsyncSaverContract]:
    async with aiosqlite.connect(database_path) as connection:
        official = AsyncSqliteSaver(connection)
        yield KeydexAsyncCheckpointStore(official)


SaverOpener = Callable[
    [Path],
    AbstractAsyncContextManager[AsyncSaverContract],
]
SAVER_OPENERS = [
    pytest.param(open_official_saver, id="official"),
    pytest.param(open_keydex_store, id="keydex-wrapper"),
]


async def collect(
    saver: AsyncSaverContract,
    base_config: RunnableConfig | None,
    *,
    filter: dict[str, Any] | None = None,
    before: RunnableConfig | None = None,
    limit: int | None = None,
) -> list[CheckpointTuple]:
    return [
        item
        async for item in saver.alist(
            base_config,
            filter=filter,
            before=before,
            limit=limit,
        )
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("saver_opener", SAVER_OPENERS)
async def test_async_saver_schema_and_missing_checkpoint(
    tmp_path: Path,
    saver_opener: SaverOpener,
) -> None:
    database_path = tmp_path / "official.db"

    async with saver_opener(database_path) as saver:
        assert await saver.aget_tuple(config("missing")) is None
        assert await collect(saver, config("missing")) == []

        async with aiosqlite.connect(database_path) as inspection:
            table_rows = await inspection.execute_fetchall(
                """
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
                ORDER BY name
                """
            )
            checkpoint_columns = await inspection.execute_fetchall(
                "PRAGMA table_info(checkpoints)"
            )
            write_columns = await inspection.execute_fetchall("PRAGMA table_info(writes)")

    assert [row[0] for row in table_rows] == ["checkpoints", "writes"]
    assert [row[1] for row in checkpoint_columns] == CHECKPOINT_COLUMNS
    assert [row[1] for row in write_columns] == WRITES_COLUMNS


@pytest.mark.asyncio
@pytest.mark.parametrize("saver_opener", SAVER_OPENERS)
async def test_async_saver_put_get_list_filter_parent_and_namespace(
    tmp_path: Path,
    saver_opener: SaverOpener,
) -> None:
    database_path = tmp_path / "official.db"
    root = config("thread-a")

    async with saver_opener(database_path) as saver:
        first = await saver.aput(
            root,
            checkpoint("00000000000000000000000000000001", "first"),
            {"source": "input", "step": 1, "kind": "keep"},
            {"messages": "1"},
        )
        second = await saver.aput(
            first,
            checkpoint("00000000000000000000000000000002", "second"),
            {"source": "loop", "step": 2, "kind": "keep"},
            {"messages": "2"},
        )
        await saver.aput(
            second,
            checkpoint("00000000000000000000000000000003", "third"),
            {"source": "loop", "step": 3, "kind": "drop"},
            {"messages": "3"},
        )
        await saver.aput(
            config("thread-a", checkpoint_ns="branch"),
            checkpoint("00000000000000000000000000000009", "branch"),
            {"source": "fork", "step": 9, "kind": "keep"},
            {"messages": "9"},
        )

        latest = await saver.aget_tuple(root)
        exact = await saver.aget_tuple(first)
        default_namespace = await collect(saver, root)
        all_namespaces = await collect(
            saver,
            {"configurable": {"thread_id": "thread-a"}},
        )
        before_second = await collect(saver, root, before=second)
        limited = await collect(saver, root, limit=1)
        filtered = await collect(saver, root, filter={"kind": "keep"})

    assert latest is not None
    assert latest.config["configurable"]["checkpoint_id"].endswith("03")
    assert latest.parent_config == second
    assert exact is not None
    assert exact.checkpoint["channel_values"]["messages"] == ["first"]
    assert exact.parent_config is None
    assert [
        item.config["configurable"]["checkpoint_id"][-2:]
        for item in default_namespace
    ] == ["03", "02", "01"]
    assert {
        (
            item.config["configurable"]["checkpoint_ns"],
            item.config["configurable"]["checkpoint_id"][-2:],
        )
        for item in all_namespaces
    } == {("", "01"), ("", "02"), ("", "03"), ("branch", "09")}
    assert [
        item.config["configurable"]["checkpoint_id"][-2:] for item in before_second
    ] == ["01"]
    assert [
        item.config["configurable"]["checkpoint_id"][-2:] for item in limited
    ] == ["03"]
    assert [
        item.config["configurable"]["checkpoint_id"][-2:] for item in filtered
    ] == ["02", "01"]


@pytest.mark.asyncio
@pytest.mark.parametrize("saver_opener", SAVER_OPENERS)
async def test_async_saver_pending_write_conflicts(
    tmp_path: Path,
    saver_opener: SaverOpener,
) -> None:
    database_path = tmp_path / "official.db"
    reserved_channel = next(iter(WRITES_IDX_MAP))

    async with saver_opener(database_path) as saver:
        saved = await saver.aput(
            config("thread-a"),
            checkpoint("00000000000000000000000000000001", "first"),
            {"source": "input", "step": 1},
            {"messages": "1"},
        )
        await saver.aput_writes(
            saved,
            [("ordinary", {"attempt": 1})],
            "task-a",
        )
        await saver.aput_writes(
            saved,
            [("ordinary", {"attempt": 2})],
            "task-a",
        )
        await saver.aput_writes(
            saved,
            [(reserved_channel, {"attempt": 1})],
            "task-a",
        )
        await saver.aput_writes(
            saved,
            [(reserved_channel, {"attempt": 2})],
            "task-a",
        )

        loaded = await saver.aget_tuple(saved)

    assert loaded is not None
    assert loaded.pending_writes == [
        ("task-a", reserved_channel, {"attempt": 2}),
        ("task-a", "ordinary", {"attempt": 1}),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("saver_opener", SAVER_OPENERS)
async def test_async_saver_delete_thread_keeps_neighbor(
    tmp_path: Path,
    saver_opener: SaverOpener,
) -> None:
    database_path = tmp_path / "official.db"

    async with saver_opener(database_path) as saver:
        deleted = await saver.aput(
            config("thread-a"),
            checkpoint("00000000000000000000000000000001", "delete"),
            {"source": "input", "step": 1},
            {"messages": "1"},
        )
        await saver.aput_writes(deleted, [("ordinary", "pending")], "task-a")
        neighbor = await saver.aput(
            config("thread-b"),
            checkpoint("00000000000000000000000000000002", "keep"),
            {"source": "input", "step": 1},
            {"messages": "1"},
        )

        await saver.adelete_thread("thread-a")

        assert await saver.aget_tuple(config("thread-a")) is None
        assert await saver.aget_tuple(neighbor) is not None

        async with aiosqlite.connect(database_path) as inspection:
            deleted_counts = await inspection.execute_fetchall(
                """
                SELECT
                    (SELECT COUNT(*) FROM checkpoints WHERE thread_id = 'thread-a'),
                    (SELECT COUNT(*) FROM writes WHERE thread_id = 'thread-a')
                """
            )

    assert deleted_counts == [(0, 0)]


@pytest.mark.asyncio
async def test_wrapper_cancellation_and_exception_release_outer_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with aiosqlite.connect(tmp_path / "wrapper.db") as connection:
        official = AsyncSqliteSaver(connection)
        operation_lock = asyncio.Lock()
        store = KeydexAsyncCheckpointStore(
            official,
            operation_lock=operation_lock,
        )
        await operation_lock.acquire()
        waiting = asyncio.create_task(
            store.aput(
                config("thread-a"),
                checkpoint("00000000000000000000000000000001", "cancelled"),
                {"source": "input"},
                {"messages": "1"},
            )
        )
        await asyncio.sleep(0)
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        operation_lock.release()

        original_aput = official.aput

        async def fail_once(*_args: Any, **_kwargs: Any) -> RunnableConfig:
            raise RuntimeError("injected failure")

        monkeypatch.setattr(official, "aput", fail_once)
        with pytest.raises(RuntimeError, match="injected failure"):
            await store.aput(
                config("thread-a"),
                checkpoint("00000000000000000000000000000002", "failed"),
                {"source": "input"},
                {"messages": "2"},
            )
        assert not operation_lock.locked()

        monkeypatch.setattr(official, "aput", original_aput)
        saved = await store.aput(
            config("thread-a"),
            checkpoint("00000000000000000000000000000003", "success"),
            {"source": "input"},
            {"messages": "3"},
        )
        assert await store.aget_tuple(saved) is not None


@pytest.mark.asyncio
async def test_wrapper_forwards_delta_history_version_and_rejects_sync_api(
    tmp_path: Path,
) -> None:
    async with aiosqlite.connect(tmp_path / "wrapper.db") as connection:
        official = AsyncSqliteSaver(connection)
        store = KeydexAsyncCheckpointStore(official)
        saved = await store.aput(
            config("thread-a"),
            checkpoint("00000000000000000000000000000001", "first"),
            {"source": "input"},
            {"messages": "1"},
        )

        expected_history = await official.aget_delta_channel_history(
            config=saved,
            channels=["messages"],
        )
        assert (
            await store.aget_delta_channel_history(
                config=saved,
                channels=["messages"],
            )
            == expected_history
        )
        assert store.serde is official.serde
        assert int(store.get_next_version(None, None).split(".")[0]) == 1

        with pytest.raises(NotImplementedError, match="async-only"):
            store.get_tuple(saved)
        with pytest.raises(NotImplementedError, match="async-only"):
            store.put(
                saved,
                checkpoint("00000000000000000000000000000002", "sync"),
                {},
                {},
            )
        with pytest.raises(NotImplementedError, match="async-only"):
            store.put_writes(saved, [], "task-a")
        with pytest.raises(NotImplementedError, match="async-only"):
            store.delete_thread("thread-a")
        with pytest.raises(NotImplementedError, match="async-only"):
            store.list(saved)
