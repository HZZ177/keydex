from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend.app.agent.checkpoint import KeydexAsyncCheckpointStore
from backend.app.agent.checkpoint_runtime import CheckpointRuntime
from backend.app.services.session_fork_service import SessionForkService, SessionForkServiceError
from backend.app.storage import StorageRepositories, init_database
from backend.app.subagents.models import SubagentRunSnapshot


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _checkpoint(checkpoint_id: str) -> dict:
    return {
        "v": 1,
        "id": checkpoint_id,
        "ts": f"2026-06-28T00:00:00+00:00:{checkpoint_id}",
        "channel_values": {"messages": [checkpoint_id]},
        "channel_versions": {},
        "versions_seen": {},
    }


_RUNTIMES: list[CheckpointRuntime] = []


@pytest.fixture(autouse=True)
async def _close_checkpoint_runtimes():
    yield
    while _RUNTIMES:
        await _RUNTIMES.pop().close()


async def _prepare_source(tmp_path):
    repositories = _repositories(tmp_path)
    source = repositories.sessions.create(
        session_id="ses_source",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
        current_model_provider_id="provider-source",
        current_model="qwen-coder",
    )
    runtime = CheckpointRuntime(repositories.db.path)
    assert await runtime.start() is True
    _RUNTIMES.append(runtime)
    saver = runtime.require_store()
    first_config = await saver.aput(
        {"configurable": {"thread_id": source.id, "checkpoint_ns": ""}},
        _checkpoint("ckpt_1"),
        {"step": 1},
        {},
    )
    await saver.aput(first_config, _checkpoint("ckpt_2"), {"step": 2}, {})
    for turn_index, input_checkpoint_id, output_checkpoint_id in [
        (1, None, "ckpt_1"),
        (2, "ckpt_1", "ckpt_2"),
    ]:
        trace_id = f"trace_{turn_index}"
        repositories.trace_records.create(
            trace_id=trace_id,
            session_id=source.id,
            active_session_id=source.id,
            scene_id=source.scene_id,
            user_id=source.user_id,
            turn_index=turn_index,
            root_node_id=f"root_{turn_index}",
            input_checkpoint_id=input_checkpoint_id,
            input_checkpoint_ns="",
        )
        repositories.trace_records.finish(
            trace_id,
            status="completed",
            output_checkpoint_id=output_checkpoint_id,
            output_checkpoint_ns="",
        )
        repositories.message_events.append(
            event_id=f"evt_user_{turn_index}",
            session_id=source.id,
            trace_record_id=trace_id,
            turn_index=turn_index,
            action="user_message",
            data={"session_id": source.id, "content": f"问题 {turn_index}"},
        )
        repositories.message_events.append(
            event_id=f"evt_ai_{turn_index}",
            session_id=source.id,
            trace_record_id=trace_id,
            turn_index=turn_index,
            action="ai_message",
            data={"session_id": source.id, "content": f"回答 {turn_index}"},
        )
    return repositories, saver


async def _create_subagent_instance(
    repositories: StorageRepositories,
    saver: KeydexAsyncCheckpointStore,
    *,
    subagent_id: str,
    child_session_id: str,
    parent_trace_id: str,
    sequence: int,
    include_resumed_run: bool = False,
) -> None:
    repositories.sessions.create(
        session_id=child_session_id,
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        session_tag="subagent",
        parent_session_id="ses_source",
        visibility="internal",
        agent_kind="subagent",
        subagent_id=subagent_id,
        subagent_role="explorer",
    )
    child_config = await saver.aput(
        {"configurable": {"thread_id": child_session_id, "checkpoint_ns": ""}},
        _checkpoint(f"ckpt_{subagent_id}"),
        {"step": 1},
        {},
    )
    assert child_config["configurable"]["thread_id"] == child_session_id
    created_at = datetime(2026, 7, 18, 8, 0, tzinfo=UTC) + timedelta(seconds=sequence)
    repositories.subagent_runs.create(
        SubagentRunSnapshot(
            run_id=f"run_{subagent_id}_spawn",
            subagent_id=subagent_id,
            child_session_id=child_session_id,
            parent_session_id="ses_source",
            parent_trace_id=parent_trace_id,
            parent_tool_call_id=f"tool_{subagent_id}",
            parent_timeline_sequence=sequence,
            initiated_by="main_agent",
            role="explorer",
            task=f"inspect {subagent_id}",
            state="completed",
            version=2,
            final_report="done",
            created_at=created_at,
            queued_at=created_at,
            started_at=created_at,
            finished_at=created_at + timedelta(seconds=1),
            updated_at=created_at + timedelta(seconds=1),
        )
    )
    if include_resumed_run:
        resumed_at = created_at + timedelta(seconds=2)
        repositories.subagent_runs.create(
            SubagentRunSnapshot(
                run_id=f"run_{subagent_id}_resumed",
                subagent_id=subagent_id,
                child_session_id=child_session_id,
                parent_session_id="ses_source",
                parent_trace_id=None,
                parent_tool_call_id=None,
                parent_timeline_sequence=sequence + 1,
                initiated_by="user",
                role="explorer",
                task=f"continue {subagent_id}",
                state="completed",
                version=2,
                final_report="continued",
                created_at=resumed_at,
                queued_at=resumed_at,
                started_at=resumed_at,
                finished_at=resumed_at + timedelta(seconds=1),
                updated_at=resumed_at + timedelta(seconds=1),
            )
        )


@pytest.mark.asyncio
async def test_session_fork_service_clones_checkpoint_and_copies_history_until_source(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    repositories.message_events.append(
        event_id="evt_skill_system_1",
        session_id="ses_source",
        trace_record_id="trace_1",
        turn_index=1,
        action="system_message",
        data={
            "session_id": "ses_source",
            "source": "skill_activation",
            "id": "skill:system:shared",
            "skill_name": "shared",
            "skill_source": "system",
            "locator": ".keydex/skills/shared/SKILL.md",
            "origin": "slash",
        },
    )
    service = SessionForkService(repositories, checkpointer=saver)

    result = await service.fork_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_ai_1",
        title="从第一轮继续",
    )

    forked = result.session
    assert forked.session_tag == "chat"
    assert forked.current_model_provider_id == "provider-source"
    assert forked.current_model == "qwen-coder"
    assert forked.parent_session_id is None
    assert forked.source_trace_id is None
    assert forked.source_active_session_id is None
    assert forked.source_checkpoint_id is None
    assert forked.source_checkpoint_ns is None
    assert repositories.sessions.get("ses_source").child_session_id is None
    fork_record = repositories.session_forks.get_by_target(forked.id)
    assert fork_record is not None
    assert fork_record.source_session_id == "ses_source"
    assert fork_record.source_message_event_id == "evt_ai_1"
    assert fork_record.target_message_event_id != "evt_ai_1"
    assert fork_record.source_turn_index == 1
    assert fork_record.target_turn_index == 1
    assert fork_record.source_trace_id == "trace_1"
    assert fork_record.source_active_session_id == "ses_source"
    assert fork_record.source_checkpoint_id == "ckpt_1"
    assert fork_record.source_checkpoint_ns == ""

    copied_events = repositories.message_events.list_by_session(forked.id)
    assert [event.turn_index for event in copied_events] == [1, 1, 1]
    assert [event.data["session_id"] for event in copied_events] == [
        forked.id,
        forked.id,
        forked.id,
    ]
    skill_event = next(
        event for event in copied_events if event.data.get("source") == "skill_activation"
    )
    assert skill_event.data["id"] == "skill:system:shared"
    assert skill_event.data["skill_source"] == "system"
    assert skill_event.data["locator"] == ".keydex/skills/shared/SKILL.md"
    cloned_checkpoint = await saver.aget_tuple(
        {"configurable": {"thread_id": forked.id, "checkpoint_ns": ""}}
    )
    assert cloned_checkpoint.config["configurable"]["checkpoint_id"] == "ckpt_1"


@pytest.mark.asyncio
async def test_session_fork_service_allows_multiple_forks_from_same_message(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    first = (
        await service.fork_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_ai_1",
        title="分支一",
        )
    ).session
    second = (
        await service.fork_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_ai_1",
        title="分支二",
        )
    ).session

    fork_records = repositories.session_forks.list_by_source("ses_source")
    assert [record.target_session_id for record in fork_records] == [first.id, second.id]
    assert {record.source_message_event_id for record in fork_records} == {"evt_ai_1"}
    assert len({record.target_message_event_id for record in fork_records}) == 2
    assert repositories.sessions.get("ses_source").child_session_id is None
    assert (
        await saver.aget_tuple(
            {"configurable": {"thread_id": first.id, "checkpoint_ns": ""}}
        )
        is not None
    )
    assert (
        await saver.aget_tuple(
            {"configurable": {"thread_id": second.id, "checkpoint_ns": ""}}
        )
        is not None
    )


@pytest.mark.asyncio
async def test_session_reverse_rejects_copied_history_at_fork_boundary(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)
    forked = (
        await service.fork_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_ai_1",
        )
    ).session
    copied_user_event = next(
        event
        for event in repositories.message_events.list_by_session(forked.id)
        if event.action == "user_message"
    )

    with pytest.raises(SessionForkServiceError) as exc_info:
        await service.resolve_reverse_source(
            session_id=forked.id,
            message_event_id=copied_user_event.id,
        )

    assert exc_info.value.code == "reverse_before_fork_point"
    assert exc_info.value.details == {
        "session_id": forked.id,
        "source_session_id": "ses_source",
        "message_event_id": copied_user_event.id,
        "requested_turn_index": 1,
        "fork_turn_index": 1,
    }


@pytest.mark.asyncio
async def test_session_fork_copies_artifact_grants_without_copying_artifact(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    artifact = repositories.tool_result_artifacts.create_or_get(
        artifact_id="tra_source",
        owner_user_id="local-user",
        source_session_id="ses_source",
        tool_call_id="call-source",
        tool_name="search_text",
        storage_kind="managed_json",
        relative_path="tool-results/context/tra_source.json",
        content_type="application/json",
        content_sha256="a" * 64,
        content_bytes=123,
        approximate_tokens=31,
    )
    repositories.tool_result_artifacts.grant(
        artifact_id=artifact.id,
        session_id="ses_source",
    )

    forked = (
        await SessionForkService(
            repositories,
            checkpointer=saver,
        ).fork_session(
            session_id="ses_source",
            user_id="local-user",
            message_event_id="evt_ai_1",
        )
    ).session

    assert repositories.tool_result_artifacts.has_grant(
        artifact_id=artifact.id,
        session_id=forked.id,
    )
    assert repositories.tool_result_artifacts.get(artifact.id) == artifact


@pytest.mark.asyncio
async def test_session_fork_rejects_cross_user_artifact_grant_inheritance(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)

    with pytest.raises(SessionForkServiceError) as captured:
        await SessionForkService(repositories, checkpointer=saver).fork_session(
            session_id="ses_source",
            user_id="different-user",
            message_event_id="evt_ai_1",
        )

    assert captured.value.code == "session_fork_user_mismatch"


@pytest.mark.asyncio
async def test_session_fork_service_uses_latest_completed_checkpoint_by_default(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    with repositories.db.transaction() as conn:
        conn.execute("delete from message_events where id = ?", ("evt_ai_2",))
    repositories.message_events.append(
        event_id="evt_stream_2",
        session_id="ses_source",
        trace_record_id="trace_2",
        turn_index=2,
        action="stream_batch",
        data={"session_id": "ses_source", "content": "回答 2"},
    )
    latest = await saver.aget_tuple(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}}
    )
    assert latest is not None
    await saver.aput(latest.config, _checkpoint("ckpt_running"), {"step": 3}, {})
    repositories.trace_records.create(
        trace_id="trace_running",
        session_id="ses_source",
        active_session_id="ses_source",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=3,
        root_node_id="root_running",
    )
    repositories.message_events.append(
        event_id="evt_user_running",
        session_id="ses_source",
        trace_record_id="trace_running",
        turn_index=3,
        action="user_message",
        data={"session_id": "ses_source", "content": "运行中的问题"},
    )

    result = await SessionForkService(
        repositories,
        checkpointer=saver,
    ).fork_session(
        session_id="ses_source",
        user_id="local-user",
    )

    assert result.source.source_type == "latest_completed"
    assert result.source.trace_id == "trace_2"
    assert result.source.message_event_id == "evt_stream_2"
    assert result.source.checkpoint_id == "ckpt_2"
    copied_events = repositories.message_events.list_by_session(result.session.id)
    assert {event.turn_index for event in copied_events} == {1, 2}
    cloned = await saver.aget_tuple(
        {"configurable": {"thread_id": result.session.id, "checkpoint_ns": ""}}
    )
    assert cloned is not None
    assert cloned.config["configurable"]["checkpoint_id"] == "ckpt_2"


@pytest.mark.asyncio
async def test_session_fork_service_creates_btw_from_latest_checkpoint_without_history(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)
    latest = await saver.aget_tuple(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}}
    )
    assert latest is not None
    await saver.aput(latest.config, _checkpoint("ckpt_running"), {"step": 3}, {})

    result = await service.fork_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_ai_1",
        title="临时分支",
        session_tag="btw",
    )
    forked = result.session

    assert forked.session_tag == "btw"
    assert result.source.source_type == "latest_checkpoint"
    assert result.source.checkpoint_id == "ckpt_running"
    assert result.source.message_event_id is None
    assert result.source.turn_index is None
    assert repositories.message_events.list_by_session(forked.id) == []
    assert repositories.session_forks.get_by_target(forked.id) is None
    cloned = await saver.aget_tuple(
        {"configurable": {"thread_id": forked.id, "checkpoint_ns": ""}}
    )
    assert cloned is not None
    assert cloned.config["configurable"]["checkpoint_id"] == "ckpt_running"
    assert cloned.checkpoint["channel_values"]["messages"] == ["ckpt_running"]


@pytest.mark.asyncio
async def test_migrated_current_root_forks_but_explicit_old_history_is_rejected(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)

    async def collapse_to_current_root(connection) -> None:
        await connection.execute(
            """
            update checkpoints set parent_checkpoint_id = null
            where thread_id = 'ses_source' and checkpoint_id = 'ckpt_2'
            """
        )
        await connection.execute(
            """
            delete from checkpoints
            where thread_id = 'ses_source' and checkpoint_id <> 'ckpt_2'
            """
        )
        await connection.execute(
            """
            update sessions
            set checkpoint_lineage_epoch = 1,
                checkpoint_history_floor_turn_index = 3,
                checkpoint_root_id = 'ckpt_2',
                checkpoint_migration_id = 'checkpoint-v2-collapse-to-official-v1'
            where id = 'ses_source'
            """
        )

    await saver.run_async_extension(collapse_to_current_root)
    service = SessionForkService(repositories, checkpointer=saver)
    current = await service.fork_session(
        session_id="ses_source",
        user_id="local-user",
    )

    assert current.source.checkpoint_id == "ckpt_2"
    assert current.source.history_floor_turn_index == 3
    assert await saver.aget_tuple(
        {
            "configurable": {
                "thread_id": current.session.id,
                "checkpoint_ns": "",
                "checkpoint_id": "ckpt_2",
            }
        }
    )

    session_count = len(repositories.sessions.list(limit=100))
    relation_count = len(repositories.session_forks.list_by_source("ses_source"))
    for kwargs in (
        {"message_event_id": "evt_ai_1"},
        {"trace_id": "trace_2"},
        {"turn_index": 1},
    ):
        with pytest.raises(SessionForkServiceError) as compacted:
            await service.fork_session(
                session_id="ses_source",
                user_id="local-user",
                **kwargs,
            )
        assert compacted.value.code == "checkpoint_history_compacted"
    assert len(repositories.sessions.list(limit=100)) == session_count
    assert len(repositories.session_forks.list_by_source("ses_source")) == relation_count


@pytest.mark.asyncio
async def test_session_reverse_rolls_back_same_session_to_user_turn_input_checkpoint(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    result = await service.reverse_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_user_2",
    )

    source = repositories.sessions.get("ses_source")
    assert result.session.id == "ses_source"
    assert source.active_session_id == "ses_source"
    assert result.source.checkpoint_id == "ckpt_1"
    assert result.source.turn_index == 2
    assert result.restored_input == "问题 2"
    assert repositories.message_events.count_by_session("ses_source") == 2
    trace_ids = [
        trace.trace_id for trace in repositories.trace_records.list_by_session("ses_source")
    ]
    assert trace_ids == ["trace_1"]
    rolled_back_checkpoint = await saver.aget_tuple(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}}
    )
    assert rolled_back_checkpoint.config["configurable"]["checkpoint_id"] == "ckpt_1"

    rewritten = repositories.message_events.append(
        event_id="evt_user_2_new",
        session_id="ses_source",
        trace_record_id="trace_2_new",
        turn_index=2,
        action="user_message",
        data={"session_id": "ses_source", "content": "新的第二轮"},
    )
    assert rewritten.seq == 3


@pytest.mark.asyncio
async def test_migrated_reverse_rejects_old_turn_and_first_new_turn_uses_root(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)

    async def collapse_to_root(connection) -> None:
        await connection.execute(
            """
            update checkpoints set parent_checkpoint_id = null
            where thread_id = 'ses_source' and checkpoint_id = 'ckpt_2'
            """
        )
        await connection.execute(
            """
            delete from checkpoints
            where thread_id = 'ses_source' and checkpoint_id <> 'ckpt_2'
            """
        )
        await connection.execute(
            """
            update sessions
            set checkpoint_lineage_epoch = 1,
                checkpoint_history_floor_turn_index = 3,
                checkpoint_root_id = 'ckpt_2',
                checkpoint_migration_id = 'checkpoint-v2-collapse-to-official-v1'
            where id = 'ses_source'
            """
        )

    await saver.run_async_extension(collapse_to_root)
    repositories.trace_records.create(
        trace_id="trace_3",
        session_id="ses_source",
        active_session_id="ses_source",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=3,
        root_node_id="root_3",
        input_checkpoint_id="removed-input",
        input_checkpoint_ns="",
    )
    repositories.trace_records.finish(
        "trace_3",
        status="completed",
        output_checkpoint_id="ckpt_2",
        output_checkpoint_ns="",
    )
    repositories.message_events.append(
        event_id="evt_user_3",
        session_id="ses_source",
        trace_record_id="trace_3",
        turn_index=3,
        action="user_message",
        data={"content": "迁移后第一轮"},
    )
    repositories.message_events.append(
        event_id="evt_ai_3",
        session_id="ses_source",
        trace_record_id="trace_3",
        turn_index=3,
        action="ai_message",
        data={"content": "回答"},
    )
    service = SessionForkService(repositories, checkpointer=saver)

    before_events = repositories.message_events.count_by_session("ses_source")
    with pytest.raises(SessionForkServiceError) as compacted:
        await service.reverse_session(
            session_id="ses_source",
            user_id="local-user",
            message_event_id="evt_user_1",
        )
    assert compacted.value.code == "checkpoint_history_compacted"
    assert repositories.message_events.count_by_session("ses_source") == before_events

    result = await service.reverse_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_user_3",
    )

    assert result.source.checkpoint_id == "ckpt_2"
    assert result.source.history_floor_turn_index == 3
    assert repositories.message_events.count_by_session("ses_source") == 4
    latest = await saver.aget_tuple(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}}
    )
    assert latest is not None
    assert latest.config["configurable"]["checkpoint_id"] == "ckpt_2"


@pytest.mark.asyncio
async def test_session_reverse_destroys_subagent_instances_created_by_rewound_traces(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    await _create_subagent_instance(
        repositories,
        saver,
        subagent_id="kept",
        child_session_id="child_kept",
        parent_trace_id="trace_1",
        sequence=0,
    )
    await _create_subagent_instance(
        repositories,
        saver,
        subagent_id="rewound",
        child_session_id="child_rewound",
        parent_trace_id="trace_2",
        sequence=1,
        include_resumed_run=True,
    )
    service = SessionForkService(repositories, checkpointer=saver)

    await service.reverse_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_user_2",
    )

    assert repositories.sessions.get("child_kept", include_internal=True) is not None
    assert repositories.sessions.get("child_rewound", include_internal=True) is None
    assert [
        run.run_id for run in repositories.subagent_runs.list_by_parent("ses_source")
    ] == ["run_kept_spawn"]
    assert await saver.aget_tuple(
        {"configurable": {"thread_id": "child_kept", "checkpoint_ns": ""}}
    ) is not None
    assert await saver.aget_tuple(
        {"configurable": {"thread_id": "child_rewound", "checkpoint_ns": ""}}
    ) is None


@pytest.mark.asyncio
async def test_session_reverse_rolls_back_checkpoint_and_rows_as_one_transaction(
    tmp_path,
    monkeypatch,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    async def fail_after_checkpoint(*_args, **_kwargs):
        raise RuntimeError("injected conversation transaction failure")

    monkeypatch.setattr(service, "_rewind_turn_artifacts", fail_after_checkpoint)
    with pytest.raises(SessionForkServiceError) as error:
        await service.reverse_session(
            session_id="ses_source",
            user_id="local-user",
            message_event_id="evt_user_2",
        )

    assert error.value.code == "session_reverse_failed"
    assert repositories.message_events.count_by_session("ses_source") == 4
    assert len(repositories.trace_records.list_by_session("ses_source")) == 2
    latest = await saver.aget_tuple(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}}
    )
    assert latest is not None
    assert latest.config["configurable"]["checkpoint_id"] == "ckpt_2"


@pytest.mark.asyncio
async def test_session_reverse_first_turn_clears_history_and_checkpoints(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    result = await service.reverse_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_user_1",
    )

    assert result.session.id == "ses_source"
    assert result.source.checkpoint_id is None
    assert repositories.message_events.count_by_session("ses_source") == 0
    assert repositories.trace_records.list_by_session("ses_source") == []
    assert (
        await saver.aget_tuple(
            {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}}
        )
        is None
    )


@pytest.mark.asyncio
async def test_session_reverse_first_turn_ignores_and_removes_legacy_subagent_turn_zero_events(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    for index in range(2):
        repositories.message_events.append(
            event_id=f"subagent_run:legacy-{index}:1",
            session_id="ses_source",
            trace_record_id="trace_1",
            turn_index=0,
            action="subagent_run_updated",
            data={
                "session_id": "ses_source",
                "run_id": f"legacy-{index}",
                "state": "completed",
            },
        )
    service = SessionForkService(repositories, checkpointer=saver)

    result = await service.reverse_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_user_1",
    )

    assert result.source.checkpoint_id is None
    assert repositories.message_events.list_by_session("ses_source") == []
    assert repositories.trace_records.list_by_session("ses_source") == []


@pytest.mark.asyncio
async def test_session_reverse_rejects_assistant_message_source(tmp_path) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    with pytest.raises(SessionForkServiceError) as exc_info:
        await service.reverse_session(
            session_id="ses_source",
            user_id="local-user",
            message_event_id="evt_ai_2",
        )

    assert exc_info.value.code == "reverse_source_must_be_user_message"


@pytest.mark.asyncio
async def test_session_reverse_rejects_missing_input_checkpoint_when_history_exists(
    tmp_path,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    repositories.trace_records.create(
        trace_id="trace_legacy",
        session_id="ses_source",
        active_session_id="ses_source",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=3,
        root_node_id="root_legacy",
    )
    repositories.trace_records.finish(
        "trace_legacy",
        status="completed",
        output_checkpoint_id="ckpt_2",
        output_checkpoint_ns="",
    )
    repositories.message_events.append(
        event_id="evt_user_legacy",
        session_id="ses_source",
        trace_record_id="trace_legacy",
        turn_index=3,
        action="user_message",
        data={"session_id": "ses_source", "content": "旧格式问题"},
    )
    repositories.message_events.append(
        event_id="evt_ai_legacy",
        session_id="ses_source",
        trace_record_id="trace_legacy",
        turn_index=3,
        action="ai_message",
        data={"session_id": "ses_source", "content": "旧格式回答"},
    )
    service = SessionForkService(repositories, checkpointer=saver)

    with pytest.raises(SessionForkServiceError) as exc_info:
        await service.reverse_session(
            session_id="ses_source",
            user_id="local-user",
            message_event_id="evt_user_legacy",
        )

    assert exc_info.value.code == "reverse_input_checkpoint_missing"
    assert repositories.message_events.count_by_session("ses_source") == 6
    latest_checkpoint = await saver.aget_tuple(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}}
    )
    assert latest_checkpoint.config["configurable"]["checkpoint_id"] == "ckpt_2"


@pytest.mark.asyncio
async def test_session_fork_service_rolls_back_when_clone_fails(
    tmp_path,
    monkeypatch,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    async def fail_clone(*_args, **_kwargs):
        raise RuntimeError("clone failed")

    monkeypatch.setattr(
        "backend.app.services.session_fork_service.aclone_checkpoint_chain",
        fail_clone,
    )
    with pytest.raises(SessionForkServiceError) as exc_info:
        await service.fork_session(
            session_id="ses_source",
            user_id="local-user",
            message_event_id="evt_ai_1",
        )

    assert exc_info.value.code == "session_fork_failed"
    assert [session.id for session in repositories.sessions.list(limit=10)] == ["ses_source"]


@pytest.mark.parametrize("action", ["fork", "reverse"])
@pytest.mark.asyncio
async def test_session_fork_and_reverse_reject_archived_source(
    tmp_path,
    action: str,
) -> None:
    repositories, saver = await _prepare_source(tmp_path)
    repositories.sessions.archive_manual(
        "ses_source",
        archived_at="2026-07-14T00:00:00Z",
    )
    service = SessionForkService(repositories, checkpointer=saver)

    with pytest.raises(SessionForkServiceError) as archived:
        if action == "fork":
            await service.fork_session(
                session_id="ses_source",
                user_id="local-user",
                message_event_id="evt_ai_1",
            )
        else:
            await service.reverse_session(
                session_id="ses_source",
                user_id="local-user",
                message_event_id="evt_user_1",
            )

    assert archived.value.code == "entity_archived"
    assert repositories.sessions.get_archived("ses_source") is not None
