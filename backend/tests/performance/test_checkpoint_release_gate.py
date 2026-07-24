from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from pathlib import Path
from typing import Any

import aiosqlite
import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.serde.types import _DeltaSnapshot
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from backend.app.agent.checkpoint import LegacySQLiteCheckpointSaver
from backend.app.agent.checkpoint_migration import (
    CheckpointMigrationCoordinator,
    CheckpointMigrationError,
    MigrationStatus,
)
from backend.app.agent.checkpoint_migration_collapse import NamespaceCollapseMigrator
from backend.app.agent.checkpoint_migration_copy import CompactTargetBuilder
from backend.app.agent.checkpoint_migration_swap import AtomicCheckpointDatabaseSwap
from backend.app.agent.checkpoint_serializer import KeydexCompressedSerializer
from backend.app.storage import init_database


def _config(thread_id: str, checkpoint_id: str | None = None) -> dict[str, Any]:
    configurable = {"thread_id": thread_id, "checkpoint_ns": ""}
    if checkpoint_id is not None:
        configurable["checkpoint_id"] = checkpoint_id
    return {"configurable": configurable}


def _checkpoint(checkpoint_id: str, messages: Any | None) -> dict[str, Any]:
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


def _payload(turn: int, *, blocks: int) -> str:
    return "".join(
        hashlib.sha256(f"release-gate:{turn}:{index}".encode()).hexdigest()
        for index in range(blocks)
    )


def _stable_sqlite_size(path: Path) -> int:
    with sqlite3.connect(path) as connection:
        connection.execute("pragma wal_checkpoint(truncate)").fetchall()
    return path.stat().st_size


def _logical_bytes(path: Path, *, legacy: bool) -> int:
    with sqlite3.connect(path) as connection:
        if legacy:
            return int(
                connection.execute(
                    """
                    select coalesce(sum(length(checkpoint_blob) + length(metadata)), 0)
                    from checkpoints_v2
                    """
                ).fetchone()[0]
            )
        return int(
            connection.execute(
                """
                select
                  coalesce((select sum(length(checkpoint) + length(metadata))
                            from checkpoints), 0)
                  + coalesce((select sum(length(value)) from writes), 0)
                """
            ).fetchone()[0]
        )


def _legacy_payload_digest(path: Path) -> str:
    with sqlite3.connect(path) as connection:
        rows = connection.execute(
            """
            select thread_id, checkpoint_ns, checkpoint_id,
                   parent_checkpoint_id, type, hex(checkpoint_blob), metadata
            from checkpoints_v2
            order by thread_id, checkpoint_ns, checkpoint_id
            """
        ).fetchall()
    return hashlib.sha256(
        json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def _seed_large_legacy_chain(path: Path, *, turns: int = 100):
    database = init_database(path)
    saver = LegacySQLiteCheckpointSaver(database)
    messages: list[HumanMessage] = []
    parent = _config("legacy-large")
    for turn in range(1, turns + 1):
        checkpoint_id = f"{turn:032x}"
        messages.append(
            HumanMessage(
                id=f"legacy-message-{turn}",
                content=_payload(turn, blocks=64),
            )
        )
        parent = saver.put(
            parent,
            _checkpoint(checkpoint_id, list(messages)),
            {"source": "release_gate", "step": turn},
            {"messages": checkpoint_id},
        )
    return database


async def _write_delta_load(
    path: Path,
    *,
    threads: int,
    turns: int,
    tool_heavy: bool,
) -> dict[str, int]:
    serializer = KeydexCompressedSerializer()
    connection = await aiosqlite.connect(path, isolation_level=None)
    saver = AsyncSqliteSaver(connection, serde=serializer)
    await saver.setup()
    heads: dict[str, dict[str, Any]] = {}
    try:
        for thread_index in range(threads):
            thread_id = f"thread-{thread_index:02d}"
            parent = _config(thread_id)
            messages: list[Any] = []
            for turn in range(1, turns + 1):
                human = HumanMessage(
                    id=f"{thread_id}-human-{turn}",
                    content=_payload(thread_index * 1_000 + turn, blocks=8),
                )
                delta: list[Any] = [human]
                if tool_heavy:
                    tool_call_id = f"{thread_id}-call-{turn}"
                    delta.extend(
                        [
                            AIMessage(
                                id=f"{thread_id}-tool-call-{turn}",
                                content="",
                                tool_calls=[
                                    {
                                        "name": "read_file",
                                        "args": {"path": f"file-{turn}.txt"},
                                        "id": tool_call_id,
                                    }
                                ],
                            ),
                            ToolMessage(
                                id=f"{thread_id}-tool-result-{turn}",
                                content=_payload(
                                    thread_index * 1_000 + turn,
                                    blocks=64,
                                ),
                                tool_call_id=tool_call_id,
                            ),
                            AIMessage(
                                id=f"{thread_id}-answer-{turn}",
                                content=f"answer-{turn}",
                            ),
                        ]
                    )
                else:
                    delta.append(
                        AIMessage(
                            id=f"{thread_id}-answer-{turn}",
                            content=f"answer-{turn}",
                        )
                    )
                messages.extend(delta)
                if turn > 1:
                    await saver.aput_writes(
                        parent,
                        [("messages", delta)],
                        f"{thread_id}-task-{turn}",
                    )
                stored_messages: Any | None
                if turn == 1:
                    stored_messages = list(messages)
                elif turn % 64 == 0:
                    stored_messages = _DeltaSnapshot(list(messages))
                else:
                    stored_messages = None
                checkpoint_id = f"{turn:032x}"
                parent = await saver.aput(
                    parent,
                    _checkpoint(checkpoint_id, stored_messages),
                    {"source": "release_gate", "step": turn},
                    {"messages": checkpoint_id},
                )
            heads[thread_id] = parent
        await connection.execute("pragma wal_checkpoint(truncate)")
    finally:
        await connection.close()

    reconstruction_connection = await aiosqlite.connect(path)
    reconstruction_saver = AsyncSqliteSaver(
        reconstruction_connection,
        serde=serializer,
    )
    try:
        reconstruction_counts: list[int] = []
        for head in heads.values():
            history = await reconstruction_saver.aget_delta_channel_history(
                config=head,
                channels=["messages"],
            )
            reconstruction_counts.append(len(history["messages"]["writes"]))
        reconstruction_writes = max(reconstruction_counts)
    finally:
        await reconstruction_connection.close()

    with sqlite3.connect(path) as inspection:
        checkpoint_count = int(
            inspection.execute("select count(*) from checkpoints").fetchone()[0]
        )
        write_count = int(
            inspection.execute("select count(*) from writes").fetchone()[0]
        )
        integrity = str(inspection.execute("pragma integrity_check").fetchone()[0])
    assert integrity == "ok"
    wal_path = Path(f"{path}-wal")
    return {
        "threads": threads,
        "turns_per_thread": turns,
        "logical_bytes": _logical_bytes(path, legacy=False),
        "physical_bytes": _stable_sqlite_size(path),
        "wal_bytes": wal_path.stat().st_size if wal_path.exists() else 0,
        "checkpoint_count": checkpoint_count,
        "write_count": write_count,
        "max_reconstruction_writes": reconstruction_writes,
    }


@pytest.mark.asyncio
async def test_checkpoint_capacity_release_gate(tmp_path: Path) -> None:
    legacy_path = tmp_path / "legacy-large.db"
    legacy_database = _seed_large_legacy_chain(legacy_path)
    legacy_physical = _stable_sqlite_size(legacy_path)
    legacy_logical = _logical_bytes(legacy_path, legacy=True)
    coordinator = CheckpointMigrationCoordinator(legacy_database)
    coordinator.start()
    await CompactTargetBuilder(legacy_database).build()
    collapse = NamespaceCollapseMigrator(legacy_database).collapse()
    await AtomicCheckpointDatabaseSwap(legacy_database).swap()
    compact_physical = _stable_sqlite_size(legacy_path)
    compact_logical = _logical_bytes(legacy_path, legacy=False)

    normal = await _write_delta_load(
        tmp_path / "normal-100.db",
        threads=1,
        turns=100,
        tool_heavy=False,
    )
    fork_heavy = await _write_delta_load(
        tmp_path / "fork-heavy.db",
        threads=10,
        turns=25,
        tool_heavy=False,
    )
    tool_heavy = await _write_delta_load(
        tmp_path / "tool-heavy.db",
        threads=1,
        turns=100,
        tool_heavy=True,
    )
    report = {
        "legacy_collapse": {
            "source_physical_bytes": legacy_physical,
            "source_logical_bytes": legacy_logical,
            "compact_physical_bytes": compact_physical,
            "compact_logical_bytes": compact_logical,
            "source_checkpoints": 100,
            "compact_roots": len(collapse.namespaces),
        },
        "normal_100": normal,
        "fork_heavy_10x25": fork_heavy,
        "tool_heavy_100": tool_heavy,
        "snapshot_frequency": 64,
    }
    report_path = os.getenv("KEYDEX_CHECKPOINT_RELEASE_GATE_REPORT")
    if report_path:
        destination = Path(report_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            json.dumps(report, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    assert compact_physical < legacy_physical * 0.5
    assert compact_logical < legacy_logical * 0.1
    assert len(collapse.namespaces) == 1
    with sqlite3.connect(legacy_path) as inspection:
        assert (
            inspection.execute("select count(*) from checkpoints").fetchone()[0]
            == 1
        )
    assert normal["checkpoint_count"] == 100
    assert normal["write_count"] == 99
    assert normal["max_reconstruction_writes"] <= 64
    assert fork_heavy["checkpoint_count"] == 250
    assert fork_heavy["write_count"] == 240
    assert fork_heavy["max_reconstruction_writes"] <= 25
    assert (
        fork_heavy["logical_bytes"] / 250
        < (normal["logical_bytes"] / 100) * 2
    )
    assert tool_heavy["checkpoint_count"] == 100
    assert tool_heavy["write_count"] == 99
    assert tool_heavy["max_reconstruction_writes"] <= 64
    assert tool_heavy["logical_bytes"] < legacy_logical * 0.25
    assert normal["wal_bytes"] == fork_heavy["wal_bytes"] == tool_heavy["wal_bytes"] == 0


@pytest.mark.asyncio
async def test_low_disk_failure_keeps_source_and_recovers_on_retry(
    tmp_path: Path,
) -> None:
    database = _seed_large_legacy_chain(tmp_path / "low-disk.db", turns=10)
    coordinator = CheckpointMigrationCoordinator(database)
    source_digest = _legacy_payload_digest(database.path)

    with pytest.raises(CheckpointMigrationError) as raised:
        coordinator.start(free_disk_bytes=0)
    assert raised.value.code == "checkpoint_migration_insufficient_space"
    assert _legacy_payload_digest(database.path) == source_digest
    assert not Path(f"{database.path}.checkpoint-collapse-v1.tmp").exists()

    retried = coordinator.retry()
    assert retried.status is MigrationStatus.PREFLIGHTING
    await CompactTargetBuilder(database).build()
    NamespaceCollapseMigrator(database).collapse()
    await AtomicCheckpointDatabaseSwap(database).swap()

    completed = CheckpointMigrationCoordinator(database).inspect()
    assert completed is not None
    assert completed.status is MigrationStatus.COMPLETED
    with database.connect() as connection:
        tables = {
            str(row["name"])
            for row in connection.execute(
                "select name from sqlite_master where type = 'table'"
            )
        }
        guarded_legacy_rows = connection.execute(
            """
            select
              (select count(*) from checkpoints_v2)
              + (select count(*) from checkpoint_writes_v2)
            """
        ).fetchone()[0]
    assert "checkpoint_backend_guard" in tables
    assert guarded_legacy_rows == 0
