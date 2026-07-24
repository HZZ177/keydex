from __future__ import annotations

import pytest

from backend.app.agent.checkpoint import LegacySQLiteCheckpointSaver
from backend.app.storage import init_database


def _checkpoint(checkpoint_id: str) -> dict:
    return {
        "v": 1,
        "id": checkpoint_id,
        "ts": f"2026-06-28T00:00:00+00:00:{checkpoint_id}",
        "channel_values": {"messages": [checkpoint_id]},
        "channel_versions": {},
        "versions_seen": {},
    }


def test_legacy_checkpoint_saver_clones_checkpoint_chain_and_writes(tmp_path) -> None:
    saver = LegacySQLiteCheckpointSaver(init_database(tmp_path / "app.db"))
    first_config = saver.put(
        {"configurable": {"thread_id": "source", "checkpoint_ns": ""}},
        _checkpoint("ckpt_1"),
        {"step": 1},
        {},
    )
    second_config = saver.put(first_config, _checkpoint("ckpt_2"), {"step": 2}, {})
    saver.put_writes(second_config, [("messages", {"content": "pending"})], "task_1")

    saver.clone_checkpoint_to_thread(
        source_thread_id="source",
        target_thread_id="target",
        checkpoint_id="ckpt_2",
    )

    cloned = saver.get_tuple({"configurable": {"thread_id": "target", "checkpoint_ns": ""}})

    assert cloned is not None
    assert cloned.config["configurable"]["checkpoint_id"] == "ckpt_2"
    assert cloned.parent_config["configurable"]["checkpoint_id"] == "ckpt_1"
    assert cloned.checkpoint["channel_values"]["messages"] == ["ckpt_2"]
    assert cloned.metadata["step"] == 2
    assert cloned.pending_writes == [("task_1", "messages", {"content": "pending"})]


def test_legacy_checkpoint_saver_clone_missing_source_does_not_touch_target(
    tmp_path,
) -> None:
    saver = LegacySQLiteCheckpointSaver(init_database(tmp_path / "app.db"))
    saver.put(
        {"configurable": {"thread_id": "target", "checkpoint_ns": ""}},
        _checkpoint("stale"),
        {},
        {},
    )

    with pytest.raises(ValueError):
        saver.clone_checkpoint_to_thread(
            source_thread_id="source",
            target_thread_id="target",
            checkpoint_id="missing",
        )

    stale = saver.get_tuple({"configurable": {"thread_id": "target", "checkpoint_ns": ""}})
    assert stale is not None
    assert stale.config["configurable"]["checkpoint_id"] == "stale"


def test_legacy_checkpoint_saver_replaces_target_checkpoint_messages(tmp_path) -> None:
    saver = LegacySQLiteCheckpointSaver(init_database(tmp_path / "app.db"))
    saver.put(
        {"configurable": {"thread_id": "source", "checkpoint_ns": ""}},
        _checkpoint("ckpt_1"),
        {},
        {},
    )
    saver.clone_checkpoint_to_thread(
        source_thread_id="source",
        target_thread_id="target",
        checkpoint_id="ckpt_1",
    )

    saver.replace_checkpoint_messages(
        thread_id="target",
        checkpoint_id="ckpt_1",
        messages=["summary", "recent"],
    )

    source = saver.get_tuple({"configurable": {"thread_id": "source", "checkpoint_ns": ""}})
    target = saver.get_tuple({"configurable": {"thread_id": "target", "checkpoint_ns": ""}})
    assert source is not None
    assert target is not None
    assert source.checkpoint["channel_values"]["messages"] == ["ckpt_1"]
    assert target.checkpoint["channel_values"]["messages"] == ["summary", "recent"]
