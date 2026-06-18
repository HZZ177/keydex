from __future__ import annotations

import base64
import json
from collections.abc import AsyncIterator, Iterator, Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
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

from backend.app.core.time import to_iso_z, utc_now
from backend.app.storage.db import Database


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


class SQLiteCheckpointSaver(BaseCheckpointSaver):
    """LangGraph checkpointer backed by the project's SQLite database.

    This mirrors the kt-agent-framework v2 table names while staying small enough for
    the desktop runtime. Checkpoints are stored as complete serialized snapshots, and
    pending writes are stored separately using LangGraph's write-index semantics.
    """

    def __init__(self, db: Database, serde: Any | None = None) -> None:
        super().__init__(serde=serde)
        self.db = db

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
                self.serde.loads_typed(
                    (write["type"], bytes(write["value_blob"] or b""))
                ),
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

    def delete_thread(self, thread_id: str) -> None:
        with self.db.transaction() as conn:
            conn.execute("delete from checkpoint_writes_v2 where thread_id = ?", (thread_id,))
            conn.execute("delete from checkpoints_v2 where thread_id = ?", (thread_id,))

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
