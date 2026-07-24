from __future__ import annotations

import asyncio
import base64
import json
import sqlite3
import warnings
from collections.abc import (
    AsyncIterator,
    Awaitable,
    Callable,
    Iterator,
    Mapping,
    Sequence,
)
from contextlib import contextmanager
from inspect import signature
from typing import Any, TypeVar

import aiosqlite
from langchain_core._api.deprecation import LangChainPendingDeprecationWarning
from langchain_core.runnables import RunnableConfig

with warnings.catch_warnings():
    warnings.simplefilter("ignore", LangChainPendingDeprecationWarning)
    warnings.filterwarnings(
        "ignore",
        message=r"The default value of .*allowed_objects.* will change.*",
        category=LangChainPendingDeprecationWarning,
    )
    from langgraph.checkpoint.base import (
        WRITES_IDX_MAP,
        BaseCheckpointSaver,
        ChannelVersions,
        Checkpoint,
        CheckpointMetadata,
        CheckpointTuple,
        get_checkpoint_id,
        get_checkpoint_metadata,
    )
    from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from backend.app.core.time import to_iso_z, utc_now
from backend.app.storage.db import LEGACY_CHECKPOINT_SCHEMA_SQL, Database

T = TypeVar("T")


class CheckpointStorageBusy(RuntimeError):
    code = "checkpoint_storage_busy"

    def __init__(self) -> None:
        super().__init__("会话存储暂时繁忙，请稍后重试")


class CheckpointStoreClosing(RuntimeError):
    code = "checkpoint_runtime_closing"

    def __init__(self) -> None:
        super().__init__("会话存储正在关闭")


class KeydexAsyncCheckpointStore(BaseCheckpointSaver[str]):
    """Public async checkpoint boundary around the official SQLite saver."""

    _SYNC_ERROR = (
        "Keydex checkpoint storage is async-only; use the corresponding async method"
    )

    def __init__(
        self,
        official_saver: AsyncSqliteSaver,
        *,
        operation_lock: asyncio.Lock | None = None,
    ) -> None:
        super().__init__(serde=official_saver.serde)
        self._official_saver = official_saver
        self._operation_lock = operation_lock or asyncio.Lock()
        self._accepting_operations = True

    @property
    def config_specs(self) -> list:
        return self._official_saver.config_specs

    def begin_closing(self) -> None:
        self._accepting_operations = False

    def _require_open(self) -> None:
        if not self._accepting_operations:
            raise CheckpointStoreClosing

    @staticmethod
    async def _classify_busy(operation: Callable[[], Awaitable[T]]) -> T:
        try:
            return await operation()
        except sqlite3.OperationalError as exc:
            sqlite_error_code = getattr(exc, "sqlite_errorcode", None)
            message = str(exc).lower()
            if sqlite_error_code in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED} or any(
                marker in message for marker in ("database is locked", "database is busy")
            ):
                raise CheckpointStorageBusy from exc
            raise

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        self._require_open()
        async with self._operation_lock:
            self._require_open()
            return await self._classify_busy(
                lambda: self._official_saver.aget_tuple(config)
            )

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        self._require_open()
        async with self._operation_lock:
            self._require_open()

            async def load_items() -> list[CheckpointTuple]:
                return [
                    item
                    async for item in self._official_saver.alist(
                        config,
                        filter=filter,
                        before=before,
                        limit=limit,
                    )
                ]

            items = await self._classify_busy(load_items)
        for item in items:
            yield item

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        self._require_open()
        async with self._operation_lock:
            self._require_open()
            return await self._classify_busy(
                lambda: self._official_saver.aput(
                    config,
                    checkpoint,
                    metadata,
                    new_versions,
                )
            )

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        self._require_open()
        async with self._operation_lock:
            self._require_open()
            await self._classify_busy(
                lambda: self._official_saver.aput_writes(
                    config,
                    writes,
                    task_id,
                    task_path,
                )
            )

    async def adelete_thread(self, thread_id: str) -> None:
        self._require_open()
        async with self._operation_lock:
            self._require_open()
            await self._classify_busy(
                lambda: self._official_saver.adelete_thread(thread_id)
            )

    async def aget_delta_channel_history(
        self,
        *,
        config: RunnableConfig,
        channels: Sequence[str],
    ) -> Mapping[str, Any]:
        self._require_open()
        async with self._operation_lock:
            self._require_open()
            return await self._classify_busy(
                lambda: self._official_saver.aget_delta_channel_history(
                    config=config,
                    channels=channels,
                )
            )

    def get_next_version(self, current: str | None, channel: None) -> str:
        return self._official_saver.get_next_version(current, channel)

    async def run_extension(
        self,
        operation: Callable[..., T],
        /,
        *args: Any,
        **kwargs: Any,
    ) -> T:
        """Run project SQLite work under the same outer mutation lock."""
        self._require_open()
        async with self._operation_lock:
            self._require_open()

            async def run_in_thread() -> T:
                return await asyncio.to_thread(operation, *args, **kwargs)

            return await self._classify_busy(run_in_thread)

    async def run_async_extension(
        self,
        operation: Callable[[aiosqlite.Connection], Awaitable[T]],
        /,
    ) -> T:
        """Run one Keydex extension transaction on the saver-owned connection."""
        self._require_open()
        async with self._operation_lock:
            self._require_open()

            async def run_transaction() -> T:
                connection = self._official_saver.conn
                await connection.execute("begin immediate")
                try:
                    result = await operation(connection)
                    await connection.commit()
                    return result
                except BaseException:
                    await connection.rollback()
                    raise

            return await self._classify_busy(run_transaction)

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        raise NotImplementedError(self._SYNC_ERROR)

    def list(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        raise NotImplementedError(self._SYNC_ERROR)

    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        raise NotImplementedError(self._SYNC_ERROR)

    def put_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        raise NotImplementedError(self._SYNC_ERROR)

    def delete_thread(self, thread_id: str) -> None:
        raise NotImplementedError(self._SYNC_ERROR)


def _metadata_dump(type_name: str, payload: bytes) -> str:
    return json.dumps(
        {
            "type": type_name,
            "data": base64.b64encode(payload).decode("ascii"),
        },
        separators=(",", ":"),
    )


def _metadata_load(raw: str | None) -> tuple[str, bytes]:
    if not raw:
        return "json", b"{}"
    payload = json.loads(raw)
    return str(payload["type"]), base64.b64decode(str(payload["data"]).encode("ascii"))


def create_legacy_checkpoint_serializer() -> Any:
    """Legacy v2 decoder/encoder; never use this for the official target tables."""
    parameters = signature(JsonPlusSerializer).parameters
    kwargs: dict[str, Any] = {}
    if "allowed_objects" in parameters:
        kwargs["allowed_objects"] = "core"
    elif "allowed_json_modules" in parameters:
        kwargs["allowed_json_modules"] = True
    return JsonPlusSerializer(**kwargs)


def decode_legacy_checkpoint_metadata(raw: str | None, serde: Any) -> dict[str, Any]:
    value = serde.loads_typed(_metadata_load(raw))
    if not isinstance(value, dict):
        raise ValueError("legacy checkpoint metadata must be a mapping")
    return value


def _default_checkpoint_serde() -> Any:
    return create_legacy_checkpoint_serializer()


class LegacySQLiteCheckpointSaver(BaseCheckpointSaver):
    """Migration/test-only reader-writer for the retired v2 checkpoint schema.

    The application runtime must use ``KeydexAsyncCheckpointStore``. This synchronous
    implementation exists only to build/read pre-migration fixtures and must never be
    injected into AgentRunner or runtime services.
    """

    def __init__(self, db: Database, serde: Any | None = None) -> None:
        super().__init__(serde=serde or _default_checkpoint_serde())
        self.db = db
        with self.db.connect() as connection:
            guarded = (
                connection.execute(
                    """
                    select 1 from sqlite_master
                    where type = 'table' and name = 'checkpoint_backend_guard'
                    """
                ).fetchone()
                is not None
            )
            if guarded:
                connection.executescript(
                    """
                    drop table if exists checkpoint_writes_v2;
                    drop table if exists checkpoints_v2;
                    drop table checkpoint_backend_guard;
                    """
                )
            connection.executescript(LEGACY_CHECKPOINT_SCHEMA_SQL)

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        configurable = config.get("configurable", {})
        thread_id = str(configurable["thread_id"])
        checkpoint_ns = str(configurable.get("checkpoint_ns", ""))
        checkpoint_id = get_checkpoint_id(config)

        if checkpoint_id:
            query = """
                select checkpoint_id, parent_checkpoint_id, type, checkpoint_blob, metadata
                from checkpoints_v2
                where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                order by created_at desc, checkpoint_id desc
                limit 1
            """
            params: tuple[Any, ...] = (thread_id, checkpoint_ns, checkpoint_id)
        else:
            query = """
                select checkpoint_id, parent_checkpoint_id, type, checkpoint_blob, metadata
                from checkpoints_v2
                where thread_id = ? and checkpoint_ns = ?
                order by created_at desc, checkpoint_id desc
                limit 1
            """
            params = (thread_id, checkpoint_ns)

        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
            if row is None:
                return None

            writes = conn.execute(
                """
                select task_id, channel, type, value_blob
                from checkpoint_writes_v2
                where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                order by idx asc
                """,
                (thread_id, checkpoint_ns, row["checkpoint_id"]),
            ).fetchall()

        checkpoint = self.serde.loads_typed((row["type"], bytes(row["checkpoint_blob"])))
        metadata = self.serde.loads_typed(_metadata_load(row["metadata"]))
        pending_writes = [
            (
                write["task_id"],
                write["channel"],
                self.serde.loads_typed((write["type"], bytes(write["value_blob"] or b""))),
            )
            for write in writes
        ]

        parent_config = None
        if row["parent_checkpoint_id"]:
            parent_config = {
                "configurable": {
                    "thread_id": thread_id,
                    "checkpoint_ns": checkpoint_ns,
                    "checkpoint_id": row["parent_checkpoint_id"],
                }
            }

        return CheckpointTuple(
            config={
                "configurable": {
                    "thread_id": thread_id,
                    "checkpoint_ns": checkpoint_ns,
                    "checkpoint_id": row["checkpoint_id"],
                }
            },
            checkpoint=checkpoint,
            metadata=metadata,
            parent_config=parent_config,
            pending_writes=pending_writes,
        )

    def list(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        configurable = (config or {}).get("configurable", {})
        thread_id = configurable.get("thread_id")
        checkpoint_ns = configurable.get("checkpoint_ns", "")
        checkpoint_id = get_checkpoint_id(config) if config else None
        before_checkpoint_id = get_checkpoint_id(before) if before else None

        conditions: list[str] = []
        params: list[Any] = []
        if thread_id:
            conditions.append("thread_id = ?")
            params.append(thread_id)
            conditions.append("checkpoint_ns = ?")
            params.append(checkpoint_ns)
        if checkpoint_id:
            conditions.append("checkpoint_id = ?")
            params.append(checkpoint_id)
        if before_checkpoint_id:
            conditions.append("checkpoint_id < ?")
            params.append(before_checkpoint_id)

        where = f"where {' and '.join(conditions)}" if conditions else ""
        sql = f"""
            select thread_id, checkpoint_ns, checkpoint_id
            from checkpoints_v2
            {where}
            order by checkpoint_id desc
        """
        if limit is not None:
            sql += " limit ?"
            params.append(max(0, int(limit)))

        with self.db.connect() as conn:
            rows = conn.execute(sql, params).fetchall()

        yielded = 0
        for row in rows:
            item = self.get_tuple(
                {
                    "configurable": {
                        "thread_id": row["thread_id"],
                        "checkpoint_ns": row["checkpoint_ns"],
                        "checkpoint_id": row["checkpoint_id"],
                    }
                }
            )
            if item is None:
                continue
            if filter and not all(item.metadata.get(key) == value for key, value in filter.items()):
                continue
            yield item
            yielded += 1
            if limit is not None and yielded >= limit:
                break

    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        configurable = config.get("configurable", {})
        thread_id = str(configurable["thread_id"])
        checkpoint_ns = str(configurable.get("checkpoint_ns", ""))
        checkpoint_id = str(checkpoint["id"])
        parent_checkpoint_id = configurable.get("checkpoint_id")
        type_name, checkpoint_bytes = self.serde.dumps_typed(checkpoint)
        metadata_type, metadata_bytes = self.serde.dumps_typed(
            get_checkpoint_metadata(config, metadata)
        )
        now = to_iso_z(utc_now())

        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into checkpoints_v2 (
                  thread_id, checkpoint_ns, checkpoint_id, created_at,
                  parent_checkpoint_id, type, checkpoint_blob, metadata
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(thread_id, checkpoint_ns, checkpoint_id) do update set
                  created_at=excluded.created_at,
                  parent_checkpoint_id=excluded.parent_checkpoint_id,
                  type=excluded.type,
                  checkpoint_blob=excluded.checkpoint_blob,
                  metadata=excluded.metadata
                """,
                (
                    thread_id,
                    checkpoint_ns,
                    checkpoint_id,
                    now,
                    parent_checkpoint_id,
                    type_name,
                    bytes(checkpoint_bytes),
                    _metadata_dump(metadata_type, bytes(metadata_bytes)),
                ),
            )

        return {
            "configurable": {
                "thread_id": thread_id,
                "checkpoint_ns": checkpoint_ns,
                "checkpoint_id": checkpoint_id,
            }
        }

    def put_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        configurable = config.get("configurable", {})
        thread_id = str(configurable["thread_id"])
        checkpoint_ns = str(configurable.get("checkpoint_ns", ""))
        checkpoint_id = str(configurable["checkpoint_id"])
        now = to_iso_z(utc_now())

        with self.db.transaction() as conn:
            for idx, (channel, value) in enumerate(writes):
                effective_idx = WRITES_IDX_MAP.get(channel, idx)
                if effective_idx >= 0:
                    existing = conn.execute(
                        """
                        select 1 from checkpoint_writes_v2
                        where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                          and task_id = ? and idx = ?
                        """,
                        (thread_id, checkpoint_ns, checkpoint_id, task_id, effective_idx),
                    ).fetchone()
                    if existing:
                        continue

                type_name, value_bytes = self.serde.dumps_typed(value)
                conn.execute(
                    """
                    insert into checkpoint_writes_v2 (
                      thread_id, checkpoint_ns, checkpoint_id, task_id, task_path,
                      idx, channel, type, value_blob, created_at
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    on conflict(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
                    do update set
                      task_path=excluded.task_path,
                      channel=excluded.channel,
                      type=excluded.type,
                      value_blob=excluded.value_blob,
                      created_at=excluded.created_at
                    """,
                    (
                        thread_id,
                        checkpoint_ns,
                        checkpoint_id,
                        task_id,
                        task_path,
                        effective_idx,
                        channel,
                        type_name,
                        bytes(value_bytes),
                        now,
                    ),
                )

    def delete_thread(
        self,
        thread_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        with self._transaction(conn) as active:
            active.execute(
                "delete from checkpoint_writes_v2 where thread_id = ?",
                (thread_id,),
            )
            active.execute("delete from checkpoints_v2 where thread_id = ?", (thread_id,))

    def rollback_thread_to_checkpoint(
        self,
        *,
        thread_id: str,
        checkpoint_id: str | None,
        checkpoint_ns: str = "",
        conn: sqlite3.Connection | None = None,
    ) -> None:
        if not thread_id.strip():
            raise ValueError("thread_id must not be empty")
        cleaned_checkpoint_id = (checkpoint_id or "").strip()
        if not cleaned_checkpoint_id:
            with self._transaction(conn) as active:
                active.execute(
                    "delete from checkpoint_writes_v2 where thread_id = ? and checkpoint_ns = ?",
                    (thread_id, checkpoint_ns),
                )
                active.execute(
                    "delete from checkpoints_v2 where thread_id = ? and checkpoint_ns = ?",
                    (thread_id, checkpoint_ns),
                )
            return

        source_rows = self._load_checkpoint_chain(
            thread_id=thread_id,
            checkpoint_ns=checkpoint_ns,
            checkpoint_id=cleaned_checkpoint_id,
        )
        if not source_rows:
            raise ValueError(
                f"checkpoint not found: thread_id={thread_id} "
                f"checkpoint_ns={checkpoint_ns} checkpoint_id={cleaned_checkpoint_id}"
            )

        checkpoint_ids = [str(row["checkpoint_id"]) for row in source_rows]
        placeholders = ", ".join("?" for _ in checkpoint_ids)
        now = to_iso_z(utc_now())
        with self._transaction(conn) as active:
            active.execute(
                f"""
                delete from checkpoint_writes_v2
                where thread_id = ?
                  and checkpoint_ns = ?
                  and checkpoint_id not in ({placeholders})
                """,
                (thread_id, checkpoint_ns, *checkpoint_ids),
            )
            active.execute(
                f"""
                delete from checkpoints_v2
                where thread_id = ?
                  and checkpoint_ns = ?
                  and checkpoint_id not in ({placeholders})
                """,
                (thread_id, checkpoint_ns, *checkpoint_ids),
            )
            active.execute(
                """
                update checkpoints_v2
                set created_at = ?
                where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                """,
                (now, thread_id, checkpoint_ns, cleaned_checkpoint_id),
            )

    @contextmanager
    def _transaction(
        self,
        conn: sqlite3.Connection | None,
    ) -> Iterator[sqlite3.Connection]:
        if conn is not None:
            yield conn
            return
        with self.db.transaction() as active:
            yield active

    def clone_checkpoint_to_thread(
        self,
        *,
        source_thread_id: str,
        target_thread_id: str,
        checkpoint_id: str,
        checkpoint_ns: str = "",
    ) -> None:
        if not source_thread_id.strip():
            raise ValueError("source_thread_id must not be empty")
        if not target_thread_id.strip():
            raise ValueError("target_thread_id must not be empty")
        if source_thread_id == target_thread_id:
            raise ValueError("source_thread_id and target_thread_id must be different")
        if not checkpoint_id.strip():
            raise ValueError("checkpoint_id must not be empty")
        now = to_iso_z(utc_now())
        source_ready = False
        try:
            with self.db.transaction(immediate=True) as conn:
                source = conn.execute(
                    """
                    select 1
                    from checkpoints_v2
                    where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                    limit 1
                    """,
                    (source_thread_id, checkpoint_ns, checkpoint_id),
                ).fetchone()
                if source is None:
                    raise ValueError(
                        f"checkpoint not found: thread_id={source_thread_id} "
                        f"checkpoint_ns={checkpoint_ns} checkpoint_id={checkpoint_id}"
                    )
                source_ready = True
                conn.execute(
                    "delete from checkpoint_writes_v2 where thread_id = ? and checkpoint_ns = ?",
                    (target_thread_id, checkpoint_ns),
                )
                conn.execute(
                    "delete from checkpoints_v2 where thread_id = ? and checkpoint_ns = ?",
                    (target_thread_id, checkpoint_ns),
                )
                conn.execute(
                    """
                    with recursive checkpoint_chain(checkpoint_id, parent_checkpoint_id) as (
                      select checkpoint_id, parent_checkpoint_id
                      from checkpoints_v2
                      where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                      union all
                      select parent.checkpoint_id, parent.parent_checkpoint_id
                      from checkpoints_v2 as parent
                      join checkpoint_chain as child
                        on child.parent_checkpoint_id = parent.checkpoint_id
                      where parent.thread_id = ? and parent.checkpoint_ns = ?
                    )
                    insert into checkpoints_v2 (
                      thread_id, checkpoint_ns, checkpoint_id, created_at,
                      parent_checkpoint_id, type, checkpoint_blob, metadata
                    )
                    select ?, source.checkpoint_ns, source.checkpoint_id, ?,
                           source.parent_checkpoint_id, source.type,
                           source.checkpoint_blob, source.metadata
                    from checkpoints_v2 as source
                    join checkpoint_chain as chain
                      on chain.checkpoint_id = source.checkpoint_id
                    where source.thread_id = ? and source.checkpoint_ns = ?
                    """,
                    (
                        source_thread_id,
                        checkpoint_ns,
                        checkpoint_id,
                        source_thread_id,
                        checkpoint_ns,
                        target_thread_id,
                        now,
                        source_thread_id,
                        checkpoint_ns,
                    ),
                )
                conn.execute(
                    """
                    insert into checkpoint_writes_v2 (
                      thread_id, checkpoint_ns, checkpoint_id, task_id, task_path,
                      idx, channel, type, value_blob, created_at
                    )
                    select ?, source.checkpoint_ns, source.checkpoint_id,
                           source.task_id, source.task_path, source.idx,
                           source.channel, source.type, coalesce(source.value_blob, x''), ?
                    from checkpoint_writes_v2 as source
                    join checkpoints_v2 as cloned
                      on cloned.thread_id = ?
                     and cloned.checkpoint_ns = source.checkpoint_ns
                     and cloned.checkpoint_id = source.checkpoint_id
                    where source.thread_id = ? and source.checkpoint_ns = ?
                    """,
                    (
                        target_thread_id,
                        now,
                        target_thread_id,
                        source_thread_id,
                        checkpoint_ns,
                    ),
                )
        except Exception:
            if source_ready:
                self.delete_thread(target_thread_id)
            raise

    def replace_checkpoint_messages(
        self,
        *,
        thread_id: str,
        checkpoint_id: str,
        checkpoint_ns: str = "",
        messages: Sequence[Any],
    ) -> None:
        self.replace_checkpoint_state(
            thread_id=thread_id,
            checkpoint_id=checkpoint_id,
            checkpoint_ns=checkpoint_ns,
            channel_values={"messages": list(messages)},
        )

    def replace_checkpoint_state(
        self,
        *,
        thread_id: str,
        checkpoint_id: str,
        checkpoint_ns: str = "",
        channel_values: Mapping[str, Any],
    ) -> None:
        if not thread_id.strip():
            raise ValueError("thread_id must not be empty")
        if not checkpoint_id.strip():
            raise ValueError("checkpoint_id must not be empty")
        if not channel_values:
            raise ValueError("channel_values must not be empty")

        with self.db.transaction() as conn:
            row = conn.execute(
                """
                select type, checkpoint_blob
                from checkpoints_v2
                where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                limit 1
                """,
                (thread_id, checkpoint_ns, checkpoint_id),
            ).fetchone()
            if row is None:
                raise ValueError(
                    f"checkpoint not found: thread_id={thread_id} "
                    f"checkpoint_ns={checkpoint_ns} checkpoint_id={checkpoint_id}"
                )
            checkpoint = self.serde.loads_typed((row["type"], bytes(row["checkpoint_blob"])))
            if not isinstance(checkpoint, dict):
                raise ValueError("checkpoint payload must be a dict")
            updated_values = dict(checkpoint.get("channel_values") or {})
            updated_values.update(dict(channel_values))
            checkpoint = {**checkpoint, "channel_values": updated_values}
            type_name, checkpoint_bytes = self.serde.dumps_typed(checkpoint)
            conn.execute(
                """
                update checkpoints_v2
                set type = ?, checkpoint_blob = ?, created_at = ?
                where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                """,
                (
                    type_name,
                    bytes(checkpoint_bytes),
                    to_iso_z(utc_now()),
                    thread_id,
                    checkpoint_ns,
                    checkpoint_id,
                ),
            )

    def _load_checkpoint_chain(
        self,
        *,
        thread_id: str,
        checkpoint_ns: str,
        checkpoint_id: str,
    ) -> list[Any]:
        with self.db.connect() as conn:
            return conn.execute(
                """
                with recursive checkpoint_chain(
                  checkpoint_id, parent_checkpoint_id, type, checkpoint_blob, metadata, depth
                ) as (
                  select checkpoint_id, parent_checkpoint_id, type, checkpoint_blob, metadata, 0
                  from checkpoints_v2
                  where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                  union all
                  select parent.checkpoint_id, parent.parent_checkpoint_id,
                         parent.type, parent.checkpoint_blob, parent.metadata, child.depth + 1
                  from checkpoints_v2 as parent
                  join checkpoint_chain as child
                    on child.parent_checkpoint_id = parent.checkpoint_id
                  where parent.thread_id = ? and parent.checkpoint_ns = ?
                )
                select checkpoint_id, parent_checkpoint_id, type, checkpoint_blob, metadata
                from checkpoint_chain
                order by depth asc
                """,
                (
                    thread_id,
                    checkpoint_ns,
                    checkpoint_id,
                    thread_id,
                    checkpoint_ns,
                ),
            ).fetchall()

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        return self.get_tuple(config)

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        for item in self.list(config, filter=filter, before=before, limit=limit):
            yield item

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        return self.put(config, checkpoint, metadata, new_versions)

    async def aput_writes(
        self,
        config: RunnableConfig,
        writes: Sequence[tuple[str, Any]],
        task_id: str,
        task_path: str = "",
    ) -> None:
        self.put_writes(config, writes, task_id, task_path)

    async def adelete_thread(self, thread_id: str) -> None:
        self.delete_thread(thread_id)
