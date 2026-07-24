from __future__ import annotations

import hashlib
import json
import os
import platform
import sqlite3
import sys
import time
from pathlib import Path
from typing import Any

import aiosqlite
import pytest
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.serde.types import _DeltaSnapshot
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from backend.app.agent.checkpoint_serializer import KeydexCompressedSerializer


def _config(thread_id: str, checkpoint_id: str | None = None) -> dict[str, Any]:
    configurable = {"thread_id": thread_id, "checkpoint_ns": ""}
    if checkpoint_id is not None:
        configurable["checkpoint_id"] = checkpoint_id
    return {"configurable": configurable}


def _checkpoint(
    checkpoint_id: str,
    *,
    messages: list[HumanMessage] | _DeltaSnapshot | None,
) -> dict[str, Any]:
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


def _payload(turn: int) -> str:
    chunks = [
        hashlib.sha256(f"{turn}:{part}:keydex".encode()).hexdigest()
        for part in range(8)
    ]
    return f"turn-{turn:04d}:" + "".join(chunks)


async def _write_case(
    path: Path,
    *,
    turns: int,
    delta: bool,
    snapshot_frequency: int = 64,
) -> dict[str, int | float | str]:
    serializer = (
        KeydexCompressedSerializer()
        if delta
        else JsonPlusSerializer(pickle_fallback=False)
    )
    connection = await aiosqlite.connect(path)
    saver = AsyncSqliteSaver(connection, serde=serializer)
    await saver.setup()
    messages: list[HumanMessage] = []
    parent_config = _config("thread")
    started = time.perf_counter()
    try:
        for turn in range(1, turns + 1):
            checkpoint_id = f"{turn:032d}"
            message = HumanMessage(id=f"message-{turn}", content=_payload(turn))
            messages.append(message)
            if delta and turn > 1:
                await saver.aput_writes(
                    parent_config,
                    [("messages", [message])],
                    f"task-{turn}",
                )
            if not delta:
                stored_messages: list[HumanMessage] | _DeltaSnapshot | None = messages
            elif turn == 1:
                stored_messages = messages
            elif turn % snapshot_frequency == 0:
                stored_messages = _DeltaSnapshot(list(messages))
            else:
                stored_messages = None
            parent_config = await saver.aput(
                parent_config,
                _checkpoint(checkpoint_id, messages=stored_messages),
                {"source": "benchmark", "step": turn},
                {"messages": checkpoint_id},
            )
        await connection.execute("pragma wal_checkpoint(truncate)")
        await connection.commit()
    finally:
        await connection.close()
    elapsed_ms = (time.perf_counter() - started) * 1_000

    reconstruction_started = time.perf_counter()
    reconstruction_connection = await aiosqlite.connect(path)
    reconstruction_saver = AsyncSqliteSaver(
        reconstruction_connection,
        serde=serializer,
    )
    try:
        history = await reconstruction_saver.aget_delta_channel_history(
            config=parent_config,
            channels=["messages"],
        )
    finally:
        await reconstruction_connection.close()
    reconstruction_ms = (time.perf_counter() - reconstruction_started) * 1_000

    with sqlite3.connect(path) as inspection:
        logical_bytes = inspection.execute(
            """
            select
              coalesce((select sum(length(checkpoint) + length(metadata))
                        from checkpoints), 0)
              + coalesce((select sum(length(value)) from writes), 0)
            """
        ).fetchone()[0]
        checkpoint_count = inspection.execute(
            "select count(*) from checkpoints"
        ).fetchone()[0]
        write_count = inspection.execute("select count(*) from writes").fetchone()[0]
        freelist_pages = inspection.execute("pragma freelist_count").fetchone()[0]
        page_size = inspection.execute("pragma page_size").fetchone()[0]
    return {
        "mode": "delta" if delta else "legacy_full",
        "turns": turns,
        "snapshot_frequency": snapshot_frequency if delta else 0,
        "physical_bytes": path.stat().st_size,
        "logical_bytes": int(logical_bytes),
        "checkpoint_count": int(checkpoint_count),
        "write_count": int(write_count),
        "freelist_bytes": int(freelist_pages * page_size),
        "elapsed_ms": round(elapsed_ms, 3),
        "reconstruction_ms": round(reconstruction_ms, 3),
        "reconstruction_write_count": len(history["messages"]["writes"]),
    }


@pytest.mark.asyncio
async def test_delta_storage_growth_is_linear_and_below_full_snapshot(
    tmp_path: Path,
) -> None:
    results = {
        "environment": {
            "platform": platform.platform(),
            "python": sys.version.split()[0],
            "sqlite": sqlite3.sqlite_version,
        },
        "legacy_100": await _write_case(
            tmp_path / "legacy-100.db",
            turns=100,
            delta=False,
        ),
        "legacy_500": await _write_case(
            tmp_path / "legacy-500.db",
            turns=500,
            delta=False,
        ),
        "delta_100": await _write_case(
            tmp_path / "delta-100.db",
            turns=100,
            delta=True,
        ),
        "delta_500": await _write_case(
            tmp_path / "delta-500.db",
            turns=500,
            delta=True,
        ),
        "delta_500_frequency_32": await _write_case(
            tmp_path / "delta-500-frequency-32.db",
            turns=500,
            delta=True,
            snapshot_frequency=32,
        ),
        "delta_500_frequency_128": await _write_case(
            tmp_path / "delta-500-frequency-128.db",
            turns=500,
            delta=True,
            snapshot_frequency=128,
        ),
        "delta_500_frequency_1000": await _write_case(
            tmp_path / "delta-500-frequency-1000.db",
            turns=500,
            delta=True,
            snapshot_frequency=1_000,
        ),
    }
    report_path = os.getenv("KEYDEX_CHECKPOINT_BENCHMARK_REPORT")
    if report_path:
        destination = Path(report_path)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(
            json.dumps(results, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    assert results["delta_500"]["logical_bytes"] < (
        results["legacy_500"]["logical_bytes"] * 0.25
    )
    delta_growth = (
        results["delta_500"]["logical_bytes"]
        / results["delta_100"]["logical_bytes"]
    )
    legacy_growth = (
        results["legacy_500"]["logical_bytes"]
        / results["legacy_100"]["logical_bytes"]
    )
    assert delta_growth < 12
    assert legacy_growth > delta_growth * 2
    assert results["delta_500"]["write_count"] == 499
    assert results["delta_500"]["checkpoint_count"] == 500
    assert results["delta_500"]["logical_bytes"] < (
        results["delta_500_frequency_32"]["logical_bytes"]
    )
    assert results["delta_500"]["reconstruction_write_count"] <= 64
    assert results["delta_500_frequency_128"]["reconstruction_write_count"] <= 128
    assert results["delta_500_frequency_1000"]["reconstruction_write_count"] == 499
