from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, TypeVar

import aiosqlite
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import (
    BaseCheckpointSaver,
    ChannelVersions,
    Checkpoint,
    CheckpointMetadata,
    CheckpointTuple,
)
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from backend.app.agent.checkpoint import KeydexAsyncCheckpointStore
from backend.app.agent.checkpoint_serializer import KeydexCompressedSerializer

T = TypeVar("T")
_OPEN_TEST_STORES: set[TestAsyncCheckpointStore] = set()


class TestAsyncCheckpointStore(BaseCheckpointSaver[str]):
    """Lazy official async saver for tests whose setup is intentionally synchronous."""

    __test__ = False

    def __init__(self, database_path: Path | str) -> None:
        serializer = KeydexCompressedSerializer()
        super().__init__(serde=serializer)
        self.database_path = Path(database_path)
        self._serializer = serializer
        self._initialization_lock = asyncio.Lock()
        self._connection: aiosqlite.Connection | None = None
        self._store: KeydexAsyncCheckpointStore | None = None
        _OPEN_TEST_STORES.add(self)

    async def _ensure(self) -> KeydexAsyncCheckpointStore:
        if self._store is not None:
            return self._store
        async with self._initialization_lock:
            if self._store is not None:
                return self._store
            self.database_path.parent.mkdir(parents=True, exist_ok=True)
            connection = await aiosqlite.connect(
                self.database_path,
                timeout=30,
                isolation_level=None,
            )
            await connection.execute("pragma foreign_keys = on")
            await connection.execute("pragma busy_timeout = 30000")
            await connection.execute("pragma journal_mode = wal")
            saver = AsyncSqliteSaver(connection, serde=self._serializer)
            await saver.setup()
            self._connection = connection
            self._store = KeydexAsyncCheckpointStore(saver)
            return self._store

    async def close(self) -> None:
        connection = self._connection
        self._store = None
        self._connection = None
        if connection is not None:
            await connection.close()
        _OPEN_TEST_STORES.discard(self)

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        return await (await self._ensure()).aget_tuple(config)

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        store = await self._ensure()
        async for item in store.alist(
            config,
            filter=filter,
            before=before,
            limit=limit,
        ):
            yield item

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        return await (await self._ensure()).aput(
            config,
            checkpoint,
            metadata,
            new_versions,
        )

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        await (await self._ensure()).aput_writes(
            config,
            writes,
            task_id,
            task_path,
        )

    async def adelete_thread(self, thread_id: str) -> None:
        await (await self._ensure()).adelete_thread(thread_id)

    async def aget_delta_channel_history(
        self,
        *,
        config: RunnableConfig,
        channels: Sequence[str],
    ) -> Mapping[str, Any]:
        return await (await self._ensure()).aget_delta_channel_history(
            config=config,
            channels=channels,
        )

    async def run_extension(
        self,
        operation: Callable[..., T],
        /,
        *args: Any,
        **kwargs: Any,
    ) -> T:
        return await (await self._ensure()).run_extension(
            operation,
            *args,
            **kwargs,
        )

    async def run_async_extension(
        self,
        operation: Callable[[aiosqlite.Connection], Any],
        /,
    ) -> T:
        return await (await self._ensure()).run_async_extension(operation)

    def get_next_version(self, current: str | None, channel: None) -> str:
        return AsyncSqliteSaver.get_next_version(self, current, channel)


async def close_test_checkpoint_stores() -> None:
    stores = list(_OPEN_TEST_STORES)
    if stores:
        await asyncio.gather(*(store.close() for store in stores))
