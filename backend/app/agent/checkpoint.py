from __future__ import annotations

import base64
import json
import sqlite3
import warnings
from collections.abc import AsyncIterator, Iterator, Mapping, Sequence
from contextlib import contextmanager
from inspect import signature
from typing import Any

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


def _default_checkpoint_serde() -> Any:
    parameters = signature(JsonPlusSerializer).parameters
    kwargs: dict[str, Any] = {}
    if "allowed_objects" in parameters:
        kwargs["allowed_objects"] = "core"
    elif "allowed_json_modules" in parameters:
        kwargs["allowed_json_modules"] = True
    return JsonPlusSerializer(**kwargs)


class SQLiteCheckpointSaver(BaseCheckpointSaver):
    """LangGraph checkpointer backed by the project's SQLite database.

    This mirrors the kt-agent-framework v2 table names while staying small enough for
    the desktop runtime. Checkpoints are stored as complete serialized snapshots, and
    pending writes are stored separately using LangGraph's write-index semantics.
    """

    def __init__(self, db: Database, serde: Any | None = None) -> None:
        super().__init__(serde=serde or _default_checkpoint_serde())
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

    def delete_thread(self, thread_id: str) -> None:
        with self.db.transaction() as conn:
            conn.execute("delete from checkpoint_writes_v2 where thread_id = ?", (thread_id,))
            conn.execute("delete from checkpoints_v2 where thread_id = ?", (thread_id,))

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

        source_rows = self._load_checkpoint_chain(
            thread_id=source_thread_id,
            checkpoint_ns=checkpoint_ns,
            checkpoint_id=checkpoint_id,
        )
        if not source_rows:
            raise ValueError(
                f"checkpoint not found: thread_id={source_thread_id} "
                f"checkpoint_ns={checkpoint_ns} checkpoint_id={checkpoint_id}"
            )
        checkpoint_ids = [str(row["checkpoint_id"]) for row in source_rows]
        now = to_iso_z(utc_now())
        try:
            with self.db.transaction() as conn:
                conn.execute(
                    "delete from checkpoint_writes_v2 where thread_id = ? and checkpoint_ns = ?",
                    (target_thread_id, checkpoint_ns),
                )
                conn.execute(
                    "delete from checkpoints_v2 where thread_id = ? and checkpoint_ns = ?",
                    (target_thread_id, checkpoint_ns),
                )
                for row in reversed(source_rows):
                    conn.execute(
                        """
                        insert into checkpoints_v2 (
                          thread_id, checkpoint_ns, checkpoint_id, created_at,
                          parent_checkpoint_id, type, checkpoint_blob, metadata
                        ) values (?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            target_thread_id,
                            checkpoint_ns,
                            row["checkpoint_id"],
                            now,
                            row["parent_checkpoint_id"],
                            row["type"],
                            bytes(row["checkpoint_blob"]),
                            row["metadata"],
                        ),
                    )
                placeholders = ", ".join("?" for _ in checkpoint_ids)
                writes = conn.execute(
                    f"""
                    select checkpoint_id, task_id, task_path, idx, channel, type, value_blob
                    from checkpoint_writes_v2
                    where thread_id = ? and checkpoint_ns = ? and checkpoint_id in ({placeholders})
                    order by checkpoint_id asc, task_id asc, idx asc
                    """,
                    (source_thread_id, checkpoint_ns, *checkpoint_ids),
                ).fetchall()
                for write in writes:
                    conn.execute(
                        """
                        insert into checkpoint_writes_v2 (
                          thread_id, checkpoint_ns, checkpoint_id, task_id, task_path,
                          idx, channel, type, value_blob, created_at
                        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            target_thread_id,
                            checkpoint_ns,
                            write["checkpoint_id"],
                            write["task_id"],
                            write["task_path"],
                            write["idx"],
                            write["channel"],
                            write["type"],
                            bytes(write["value_blob"] or b""),
                            now,
                        ),
                    )
        except Exception:
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
        rows: list[Any] = []
        next_checkpoint_id: str | None = checkpoint_id
        with self.db.connect() as conn:
            while next_checkpoint_id:
                row = conn.execute(
                    """
                    select checkpoint_id, parent_checkpoint_id, type, checkpoint_blob, metadata
                    from checkpoints_v2
                    where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
                    limit 1
                    """,
                    (thread_id, checkpoint_ns, next_checkpoint_id),
                ).fetchone()
                if row is None:
                    break
                rows.append(row)
                next_checkpoint_id = row["parent_checkpoint_id"]
        return rows

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
