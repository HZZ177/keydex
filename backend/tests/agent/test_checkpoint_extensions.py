from __future__ import annotations

import asyncio
import sqlite3
from pathlib import Path
from typing import Any

import pytest
from langchain_core.messages import HumanMessage

from backend.app.agent.checkpoint_extensions import (
    CheckpointChainNotFound,
    aclone_checkpoint_chain,
    adelete_checkpoint_thread,
    arollback_checkpoint_chain,
)
from backend.tests.agent.test_delta_checkpoint_integration import (
    DeltaMessagesState,
    _compile_passthrough,
    _store,
)


def _config(thread_id: str, checkpoint_id: str | None = None) -> dict[str, Any]:
    configurable = {"thread_id": thread_id, "checkpoint_ns": ""}
    if checkpoint_id is not None:
        configurable["checkpoint_id"] = checkpoint_id
    return {"configurable": configurable}


def _checkpoint(checkpoint_id: str, *, messages) -> dict[str, Any]:
    channel_values = {}
    if messages is not None:
        channel_values["messages"] = messages
    return {
        "v": 4,
        "ts": "2026-07-24T00:00:00+00:00",
        "id": checkpoint_id,
        "channel_values": channel_values,
        "channel_versions": {"messages": checkpoint_id},
        "versions_seen": {},
        "updated_channels": ["messages"],
    }


async def _seed_chain(store, thread_id: str) -> list[str]:
    checkpoint_ids = [f"{index:032d}" for index in range(1, 4)]
    root_messages = [HumanMessage(id="message-1", content="one")]
    config = await store.aput(
        _config(thread_id),
        _checkpoint(checkpoint_ids[0], messages=root_messages),
        {"source": "input", "step": 1},
        {"messages": checkpoint_ids[0]},
    )
    for index, checkpoint_id in enumerate(checkpoint_ids[1:], start=2):
        await store.aput_writes(
            config,
            [
                (
                    "messages",
                    [HumanMessage(id=f"message-{index}", content=str(index))],
                )
            ],
            f"task-{index}",
        )
        config = await store.aput(
            config,
            _checkpoint(checkpoint_id, messages=None),
            {"source": "loop", "step": index},
            {"messages": checkpoint_id},
        )
    return checkpoint_ids


def _counts(path: Path, thread_id: str) -> tuple[int, int]:
    with sqlite3.connect(path) as connection:
        return (
            connection.execute(
                "select count(*) from checkpoints where thread_id = ?",
                (thread_id,),
            ).fetchone()[0],
            connection.execute(
                "select count(*) from writes where thread_id = ?",
                (thread_id,),
            ).fetchone()[0],
        )


@pytest.mark.asyncio
async def test_clone_copies_complete_delta_ancestry_and_all_writes(
    tmp_path: Path,
) -> None:
    path = tmp_path / "checkpoint.db"
    async with _store(path) as store:
        checkpoint_ids = await _seed_chain(store, "source")
        await _seed_chain(store, "target")

        cloned_head = await aclone_checkpoint_chain(
            store,
            source_thread_id="source",
            target_thread_id="target",
            checkpoint_id=checkpoint_ids[-1],
        )
        cloned = await store.aget_tuple(
            _config("target", checkpoint_id=cloned_head)
        )

    assert cloned is not None
    assert cloned.config["configurable"]["checkpoint_id"] == checkpoint_ids[-1]
    assert _counts(path, "source") == (3, 2)
    assert _counts(path, "target") == (3, 2)
    with sqlite3.connect(path) as inspection:
        parent_rows = inspection.execute(
            """
            select checkpoint_id, parent_checkpoint_id
            from checkpoints where thread_id = 'target'
            order by checkpoint_id
            """
        ).fetchall()
    assert parent_rows == [
        (checkpoint_ids[0], None),
        (checkpoint_ids[1], checkpoint_ids[0]),
        (checkpoint_ids[2], checkpoint_ids[1]),
    ]


@pytest.mark.asyncio
async def test_missing_clone_source_does_not_clear_target(tmp_path: Path) -> None:
    path = tmp_path / "checkpoint.db"
    async with _store(path) as store:
        await _seed_chain(store, "target")

        with pytest.raises(CheckpointChainNotFound):
            await aclone_checkpoint_chain(
                store,
                source_thread_id="missing",
                target_thread_id="target",
            )

    assert _counts(path, "target") == (3, 2)


@pytest.mark.asyncio
async def test_concurrent_clone_rollback_delete_stress_preserves_all_chains(
    tmp_path: Path,
) -> None:
    path = tmp_path / "checkpoint.db"
    async with _store(path) as store:
        clone_heads = {
            f"clone-source-{index}": (
                await _seed_chain(store, f"clone-source-{index}")
            )[-1]
            for index in range(10)
        }
        rollback_ids = {
            f"rollback-source-{index}": await _seed_chain(
                store,
                f"rollback-source-{index}",
            )
            for index in range(10)
        }
        for index in range(10):
            await _seed_chain(store, f"delete-source-{index}")

        await asyncio.wait_for(
            asyncio.gather(
                *(
                    aclone_checkpoint_chain(
                        store,
                        source_thread_id=source,
                        target_thread_id=source.replace("source", "fork"),
                        checkpoint_id=head,
                    )
                    for source, head in clone_heads.items()
                ),
                *(
                    arollback_checkpoint_chain(
                        store,
                        thread_id=source,
                        checkpoint_id=checkpoint_ids[1],
                    )
                    for source, checkpoint_ids in rollback_ids.items()
                ),
                *(
                    adelete_checkpoint_thread(
                        store,
                        thread_id=f"delete-source-{index}",
                    )
                    for index in range(10)
                ),
            ),
            timeout=20,
        )

    for index in range(10):
        assert _counts(path, f"clone-source-{index}") == (3, 2)
        assert _counts(path, f"clone-fork-{index}") == (3, 2)
        assert _counts(path, f"rollback-source-{index}") == (2, 2)
        assert _counts(path, f"delete-source-{index}") == (0, 0)
    with sqlite3.connect(path) as inspection:
        assert inspection.execute("pragma integrity_check").fetchone()[0] == "ok"


@pytest.mark.asyncio
async def test_rollback_keeps_target_and_ancestors_then_delete_covers_namespaces(
    tmp_path: Path,
) -> None:
    path = tmp_path / "checkpoint.db"
    async with _store(path) as store:
        checkpoint_ids = await _seed_chain(store, "thread")
        await arollback_checkpoint_chain(
            store,
            thread_id="thread",
            checkpoint_id=checkpoint_ids[1],
        )
        latest = await store.aget_tuple(_config("thread"))

        assert latest is not None
        assert latest.config["configurable"]["checkpoint_id"] == checkpoint_ids[1]
        assert _counts(path, "thread") == (2, 2)

        await adelete_checkpoint_thread(store, thread_id="thread")

    assert _counts(path, "thread") == (0, 0)


@pytest.mark.asyncio
async def test_extension_failure_rolls_back_and_parallel_graph_write_waits(
    tmp_path: Path,
) -> None:
    path = tmp_path / "checkpoint.db"
    async with _store(path) as store:
        checkpoint_ids = await _seed_chain(store, "thread")

        async def fail_after_delete(connection) -> None:
            await connection.execute(
                "delete from checkpoints where thread_id = 'thread'"
            )
            raise RuntimeError("injected")

        with pytest.raises(RuntimeError, match="injected"):
            await store.run_async_extension(fail_after_delete)
        assert _counts(path, "thread") == (3, 2)

        entered = asyncio.Event()
        release = asyncio.Event()

        async def hold_transaction(connection) -> None:
            await connection.execute("select 1")
            entered.set()
            await release.wait()

        extension = asyncio.create_task(store.run_async_extension(hold_transaction))
        await entered.wait()
        graph = _compile_passthrough(DeltaMessagesState, store)
        graph_write = asyncio.create_task(
            graph.ainvoke(
                {"messages": [HumanMessage(id="parallel", content="write")]},
                config=_config("parallel"),
            )
        )
        await asyncio.sleep(0)
        assert not graph_write.done()
        release.set()
        await extension
        written_state: dict[str, Any] = await graph_write

    assert written_state["messages"][0].id == "parallel"
    assert checkpoint_ids[-1] == f"{3:032d}"


@pytest.mark.asyncio
async def test_cloned_non_snapshot_chain_restarts_and_continues_without_sibling_changes(
    tmp_path: Path,
) -> None:
    path = tmp_path / "checkpoint.db"
    async with _store(path) as store:
        await _seed_chain(store, "source")
        await _seed_chain(store, "sibling")
        await aclone_checkpoint_chain(
            store,
            source_thread_id="source",
            target_thread_id="target",
        )

    async with _store(path) as store:
        graph = _compile_passthrough(DeltaMessagesState, store)
        before = await graph.aget_state(_config("target"))
        await graph.ainvoke(
            {"messages": [HumanMessage(id="message-4", content="four")]},
            config=_config("target"),
        )
        after = await graph.aget_state(_config("target"))

    assert [message.id for message in before.values["messages"]] == [
        "message-1",
        "message-2",
        "message-3",
    ]
    assert [message.id for message in after.values["messages"]] == [
        "message-1",
        "message-2",
        "message-3",
        "message-4",
    ]
    assert _counts(path, "source") == (3, 2)
    assert _counts(path, "sibling") == (3, 2)
    assert _counts(path, "target")[0] > 3


@pytest.mark.asyncio
async def test_clone_sql_failure_restores_previous_target_atomically(
    tmp_path: Path,
) -> None:
    path = tmp_path / "checkpoint.db"
    async with _store(path) as store:
        await _seed_chain(store, "source")
        await _seed_chain(store, "target")

        async def install_failure_trigger(connection) -> None:
            await connection.execute(
                """
                create trigger fail_target_checkpoint_insert
                before insert on checkpoints
                when new.thread_id = 'target'
                begin
                  select raise(abort, 'injected checkpoint insert failure');
                end
                """
            )

        await store.run_async_extension(install_failure_trigger)
        with pytest.raises(sqlite3.IntegrityError, match="injected"):
            await aclone_checkpoint_chain(
                store,
                source_thread_id="source",
                target_thread_id="target",
            )

    assert _counts(path, "source") == (3, 2)
    assert _counts(path, "target") == (3, 2)
