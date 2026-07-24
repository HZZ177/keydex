from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import aiosqlite

from backend.app.agent.checkpoint import KeydexAsyncCheckpointStore


class CheckpointChainNotFound(ValueError):
    code = "checkpoint_chain_not_found"


class CheckpointChainInvalid(ValueError):
    code = "checkpoint_chain_invalid"


async def _resolve_head(
    connection: aiosqlite.Connection,
    *,
    thread_id: str,
    checkpoint_ns: str,
    checkpoint_id: str | None,
) -> str | None:
    if checkpoint_id is not None:
        cursor = await connection.execute(
            """
            select checkpoint_id from checkpoints
            where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
            """,
            (thread_id, checkpoint_ns, checkpoint_id),
        )
    else:
        cursor = await connection.execute(
            """
            select checkpoint_id from checkpoints
            where thread_id = ? and checkpoint_ns = ?
            order by checkpoint_id desc limit 1
            """,
            (thread_id, checkpoint_ns),
        )
    row = await cursor.fetchone()
    await cursor.close()
    return str(row[0]) if row is not None else None


async def _load_ancestor_chain(
    connection: aiosqlite.Connection,
    *,
    thread_id: str,
    checkpoint_ns: str,
    checkpoint_id: str,
) -> list[tuple[Any, ...]]:
    cursor = await connection.execute(
        """
        with recursive chain(
          thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
          type, checkpoint, metadata
        ) as (
          select thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
                 type, checkpoint, metadata
          from checkpoints
          where thread_id = ? and checkpoint_ns = ? and checkpoint_id = ?
          union
          select parent.thread_id, parent.checkpoint_ns, parent.checkpoint_id,
                 parent.parent_checkpoint_id, parent.type, parent.checkpoint,
                 parent.metadata
          from checkpoints as parent
          join chain as child
            on parent.thread_id = child.thread_id
           and parent.checkpoint_ns = child.checkpoint_ns
           and parent.checkpoint_id = child.parent_checkpoint_id
        )
        select thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
               type, checkpoint, metadata
        from chain
        """,
        (thread_id, checkpoint_ns, checkpoint_id),
    )
    rows = await cursor.fetchall()
    await cursor.close()
    if not rows:
        raise CheckpointChainNotFound(
            f"checkpoint not found: {thread_id}/{checkpoint_ns}/{checkpoint_id}"
        )
    ids = {str(row[2]) for row in rows}
    roots = [row for row in rows if row[3] is None]
    if len(roots) != 1 or any(
        row[3] is not None and str(row[3]) not in ids for row in rows
    ):
        raise CheckpointChainInvalid(
            f"checkpoint ancestor chain is incomplete: {thread_id}/{checkpoint_ns}"
        )
    return [tuple(row) for row in rows]


async def clone_checkpoint_chain(
    connection: aiosqlite.Connection,
    *,
    source_thread_id: str,
    target_thread_id: str,
    checkpoint_id: str | None = None,
    source_checkpoint_ns: str = "",
    target_checkpoint_ns: str = "",
) -> str:
    """Replace one target namespace with the source head's complete ancestry."""
    if source_thread_id == target_thread_id and (
        source_checkpoint_ns == target_checkpoint_ns
    ):
        raise ValueError("source and target checkpoint namespaces must differ")
    head_id = await _resolve_head(
        connection,
        thread_id=source_thread_id,
        checkpoint_ns=source_checkpoint_ns,
        checkpoint_id=checkpoint_id,
    )
    if head_id is None:
        raise CheckpointChainNotFound(
            f"checkpoint not found: {source_thread_id}/{source_checkpoint_ns}"
        )
    chain = await _load_ancestor_chain(
        connection,
        thread_id=source_thread_id,
        checkpoint_ns=source_checkpoint_ns,
        checkpoint_id=head_id,
    )
    checkpoint_ids = [str(row[2]) for row in chain]
    placeholders = ",".join("?" for _ in checkpoint_ids)
    writes_cursor = await connection.execute(
        f"""
        select checkpoint_id, task_id, idx, channel, type, value
        from writes
        where thread_id = ? and checkpoint_ns = ?
          and checkpoint_id in ({placeholders})
        order by checkpoint_id, task_id, idx
        """,
        (source_thread_id, source_checkpoint_ns, *checkpoint_ids),
    )
    writes = [tuple(row) for row in await writes_cursor.fetchall()]
    await writes_cursor.close()

    await connection.execute(
        "delete from writes where thread_id = ? and checkpoint_ns = ?",
        (target_thread_id, target_checkpoint_ns),
    )
    await connection.execute(
        "delete from checkpoints where thread_id = ? and checkpoint_ns = ?",
        (target_thread_id, target_checkpoint_ns),
    )
    await connection.executemany(
        """
        insert into checkpoints (
          thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
          type, checkpoint, metadata
        ) values (?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                target_thread_id,
                target_checkpoint_ns,
                row[2],
                row[3],
                row[4],
                row[5],
                row[6],
            )
            for row in chain
        ],
    )
    await connection.executemany(
        """
        insert into writes (
          thread_id, checkpoint_ns, checkpoint_id, task_id,
          idx, channel, type, value
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                target_thread_id,
                target_checkpoint_ns,
                row[0],
                row[1],
                row[2],
                row[3],
                row[4],
                row[5],
            )
            for row in writes
        ],
    )
    return head_id


async def rollback_checkpoint_chain(
    connection: aiosqlite.Connection,
    *,
    thread_id: str,
    checkpoint_id: str | None,
    checkpoint_ns: str = "",
) -> int:
    """Keep the selected checkpoint and its complete ancestors; remove successors."""
    if checkpoint_id is None:
        await connection.execute(
            "delete from writes where thread_id = ? and checkpoint_ns = ?",
            (thread_id, checkpoint_ns),
        )
        cursor = await connection.execute(
            "delete from checkpoints where thread_id = ? and checkpoint_ns = ?",
            (thread_id, checkpoint_ns),
        )
        return max(0, cursor.rowcount)
    chain = await _load_ancestor_chain(
        connection,
        thread_id=thread_id,
        checkpoint_ns=checkpoint_ns,
        checkpoint_id=checkpoint_id,
    )
    keep_ids = [str(row[2]) for row in chain]
    placeholders = ",".join("?" for _ in keep_ids)
    parameters: Sequence[Any] = (thread_id, checkpoint_ns, *keep_ids)
    await connection.execute(
        f"""
        delete from writes
        where thread_id = ? and checkpoint_ns = ?
          and checkpoint_id not in ({placeholders})
        """,
        parameters,
    )
    cursor = await connection.execute(
        f"""
        delete from checkpoints
        where thread_id = ? and checkpoint_ns = ?
          and checkpoint_id not in ({placeholders})
        """,
        parameters,
    )
    return max(0, cursor.rowcount)


async def delete_checkpoint_thread(
    connection: aiosqlite.Connection,
    *,
    thread_id: str,
) -> None:
    await connection.execute("delete from writes where thread_id = ?", (thread_id,))
    await connection.execute("delete from checkpoints where thread_id = ?", (thread_id,))


async def aclone_checkpoint_chain(
    store: KeydexAsyncCheckpointStore,
    **kwargs: Any,
) -> str:
    return await store.run_async_extension(
        lambda connection: clone_checkpoint_chain(connection, **kwargs)
    )


async def arollback_checkpoint_chain(
    store: KeydexAsyncCheckpointStore,
    **kwargs: Any,
) -> int:
    return await store.run_async_extension(
        lambda connection: rollback_checkpoint_chain(connection, **kwargs)
    )


async def adelete_checkpoint_thread(
    store: KeydexAsyncCheckpointStore,
    *,
    thread_id: str,
) -> None:
    await store.run_async_extension(
        lambda connection: delete_checkpoint_thread(
            connection,
            thread_id=thread_id,
        )
    )
