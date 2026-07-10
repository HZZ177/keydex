from __future__ import annotations

from backend.app.services.chat_types import (
    PENDING_INPUT_MODE_QUEUE,
    PENDING_INPUT_MODE_STEER,
    PENDING_INPUT_STATUS_CANCELLED,
    PENDING_INPUT_STATUS_DELIVERED,
    PENDING_INPUT_STATUS_PENDING_STEER,
    PENDING_INPUT_STATUS_QUEUED,
    PENDING_INPUT_STATUS_STARTING,
)
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-pending",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


def test_pending_inputs_schema_is_created(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    with repositories.db.connect() as conn:
        columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(session_pending_inputs)").fetchall()
        }
        indexes = {
            str(row["name"])
            for row in conn.execute("pragma index_list(session_pending_inputs)").fetchall()
        }

    assert {
        "id",
        "session_id",
        "client_input_id",
        "mode",
        "status",
        "message",
        "runtime_params_json",
        "attachments_json",
        "target_turn_index",
        "target_trace_id",
        "promoted_turn_index",
        "promoted_trace_id",
        "queue_position",
        "lock_owner",
        "lock_expires_at",
        "error_code",
        "error_message",
        "delivered_at",
        "cancelled_at",
        "paused_at",
        "pause_reason",
        "is_deleted",
    }.issubset(columns)
    assert {
        "idx_pending_inputs_client_id",
        "idx_pending_inputs_session_status_created",
        "idx_pending_inputs_session_active",
    }.issubset(indexes)


def test_pending_inputs_create_is_idempotent_by_client_input_id(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    first, created_first = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="补充第一个约束",
        mode=PENDING_INPUT_MODE_STEER,
        client_input_id="client-input-1",
        provider_id="provider-1",
        model="qwen-coder",
        runtime_params={"message_context_items": [{"label": "文件", "content": "a.py"}]},
    )
    second, created_second = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="客户端重试不应覆盖内容",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="client-input-1",
    )

    assert created_first is True
    assert created_second is False
    assert second.id == first.id
    assert second.message == "补充第一个约束"
    assert second.mode == PENDING_INPUT_MODE_STEER
    assert second.status == PENDING_INPUT_STATUS_PENDING_STEER
    assert second.runtime_params["message_context_items"][0]["content"] == "a.py"
    assert repositories.pending_inputs.list_active_by_session("ses-pending") == [second]


def test_pending_inputs_queue_claims_fifo_and_marks_delivered(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    first, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第一条排队消息",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="queue-1",
    )
    second, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第二条排队消息",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="queue-2",
    )

    claimed = repositories.pending_inputs.claim_next_queued(
        "ses-pending",
        lock_owner="test-worker",
    )
    assert claimed is not None
    assert claimed.id == first.id
    assert claimed.status == PENDING_INPUT_STATUS_STARTING
    assert claimed.lock_owner == "test-worker"

    delivered = repositories.pending_inputs.mark_delivered(
        claimed.id,
        promoted_turn_index=2,
        promoted_trace_id="trace-promoted",
    )
    assert delivered is not None
    assert delivered.status == PENDING_INPUT_STATUS_DELIVERED
    assert delivered.promoted_turn_index == 2
    assert delivered.promoted_trace_id == "trace-promoted"

    next_claimed = repositories.pending_inputs.claim_next_queued(
        "ses-pending",
        lock_owner="test-worker",
    )
    assert next_claimed is not None
    assert next_claimed.id == second.id


def test_pending_inputs_recover_expired_queue_claims_before_next_claim(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    first, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="崩溃前已认领",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="queue-expired-1",
    )
    second, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="仍在队列中",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="queue-expired-2",
    )

    claimed = repositories.pending_inputs.claim_next_queued(
        "ses-pending",
        lock_owner="crashed-worker",
    )
    assert claimed is not None
    assert claimed.id == first.id

    with repositories.db.transaction() as conn:
        conn.execute(
            """
            update session_pending_inputs
            set lock_expires_at = '2000-01-01T00:00:00Z'
            where id = ?
            """,
            (claimed.id,),
        )

    reclaimed = repositories.pending_inputs.claim_next_queued(
        "ses-pending",
        lock_owner="next-worker",
    )

    assert reclaimed is not None
    assert reclaimed.id == first.id
    assert reclaimed.lock_owner == "next-worker"
    assert repositories.pending_inputs.get(second.id).status == PENDING_INPUT_STATUS_QUEUED


def test_pending_inputs_reorder_persists_and_changes_next_queue_claim(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    first, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第一条排队消息",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="reorder-1",
    )
    second, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第二条排队消息",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="reorder-2",
    )
    third, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第三条排队消息",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="reorder-3",
    )

    reordered = repositories.pending_inputs.reorder_pending(
        "ses-pending",
        [third.id, first.id, second.id],
    )

    assert reordered is not None
    assert [record.id for record in reordered] == [third.id, first.id, second.id]
    assert [
        record.id
        for record in repositories.pending_inputs.list_active_by_session("ses-pending")
    ] == [third.id, first.id, second.id]
    claimed = repositories.pending_inputs.claim_next_queued(
        "ses-pending",
        lock_owner="reorder-worker",
    )
    assert claimed is not None
    assert claimed.id == third.id


def test_pending_inputs_reorder_keeps_running_slot_and_rejects_invalid_contract(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    running, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="已经开始发送",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="reorder-running",
    )
    second, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第二条排队消息",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="reorder-waiting-2",
    )
    third, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第三条排队消息",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="reorder-waiting-3",
    )
    claimed = repositories.pending_inputs.claim_next_queued(
        "ses-pending",
        lock_owner="active-worker",
    )
    assert claimed is not None and claimed.id == running.id

    reordered = repositories.pending_inputs.reorder_pending(
        "ses-pending",
        [third.id, second.id],
    )

    assert reordered is not None
    assert [record.id for record in reordered] == [running.id, third.id, second.id]
    assert repositories.pending_inputs.reorder_pending(
        "ses-pending",
        [running.id, second.id],
    ) is None
    assert [
        record.id
        for record in repositories.pending_inputs.list_active_by_session("ses-pending")
    ] == [running.id, third.id, second.id]


def test_pending_inputs_claims_multiple_steers_for_same_llm_request(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    first, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第一条运行中引导",
        mode=PENDING_INPUT_MODE_STEER,
        client_input_id="steer-1",
    )
    second, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第二条运行中引导",
        mode=PENDING_INPUT_MODE_STEER,
        client_input_id="steer-2",
    )
    repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="指定下一轮才可见",
        mode=PENDING_INPUT_MODE_STEER,
        client_input_id="steer-targeted",
        target_turn_index=4,
    )

    claimed = repositories.pending_inputs.claim_pending_steers(
        "ses-pending",
        turn_index=3,
        trace_id="trace-3",
        lock_owner="middleware",
        limit=20,
    )

    assert [record.id for record in claimed] == [first.id, second.id]
    assert [record.message for record in claimed] == ["第一条运行中引导", "第二条运行中引导"]
    assert {record.status for record in claimed} == {PENDING_INPUT_STATUS_DELIVERED}
    assert {record.target_turn_index for record in claimed} == {3}
    assert {record.target_trace_id for record in claimed} == {"trace-3"}


def test_pending_inputs_convert_leftover_steers_to_queue(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    first, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="本轮未被模型请求消费的引导",
        mode=PENDING_INPUT_MODE_STEER,
        client_input_id="leftover-1",
    )
    second, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第二条遗留引导",
        mode=PENDING_INPUT_MODE_STEER,
        client_input_id="leftover-2",
    )

    converted = repositories.pending_inputs.convert_pending_steers_to_queue("ses-pending")

    assert [record.id for record in converted] == [first.id, second.id]
    assert {record.mode for record in converted} == {PENDING_INPUT_MODE_QUEUE}
    assert {record.status for record in converted} == {PENDING_INPUT_STATUS_QUEUED}
    active_ids = [
        record.id
        for record in repositories.pending_inputs.list_active_by_session("ses-pending")
    ]
    assert active_ids == [first.id, second.id]


def test_pending_inputs_edit_and_cancel_only_allow_editable_statuses(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    record, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="初始消息",
        mode=PENDING_INPUT_MODE_QUEUE,
        client_input_id="editable-1",
    )

    updated = repositories.pending_inputs.update_pending(
        record.id,
        message="改成引导",
        mode=PENDING_INPUT_MODE_STEER,
    )
    assert updated is not None
    assert updated.message == "改成引导"
    assert updated.mode == PENDING_INPUT_MODE_STEER
    assert updated.status == PENDING_INPUT_STATUS_PENDING_STEER

    cancelled = repositories.pending_inputs.cancel(updated.id, reason="user")
    assert cancelled is not None
    assert cancelled.status == PENDING_INPUT_STATUS_CANCELLED
    assert cancelled.error_message == "user"

    assert repositories.pending_inputs.update_pending(cancelled.id, message="终态不可编辑") is None
    assert repositories.pending_inputs.cancel(cancelled.id, reason="again") is None


def test_pending_inputs_pause_blocks_claims_until_resumed(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    steer, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="暂停的引导",
        mode=PENDING_INPUT_MODE_STEER,
    )
    queued, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="暂停的队列",
        mode=PENDING_INPUT_MODE_QUEUE,
    )

    paused = repositories.pending_inputs.pause_active_for_session("ses-pending")

    assert [record.id for record in paused] == [steer.id, queued.id]
    assert all(record.paused_at and record.pause_reason == "user_stopped" for record in paused)
    assert repositories.pending_inputs.has_active_queue("ses-pending") is False
    assert repositories.pending_inputs.claim_next_queued(
        "ses-pending", lock_owner="paused-worker"
    ) is None
    assert repositories.pending_inputs.claim_pending_steers(
        "ses-pending",
        turn_index=3,
        trace_id="trace-paused",
        lock_owner="paused-middleware",
    ) == []

    resumed_queue = repositories.pending_inputs.resume_paused(
        "ses-pending",
        mode=PENDING_INPUT_MODE_QUEUE,
    )
    assert [record.id for record in resumed_queue] == [queued.id]
    assert resumed_queue[0].paused_at is None
    assert repositories.pending_inputs.claim_next_queued(
        "ses-pending", lock_owner="resumed-worker"
    ).id == queued.id


def test_pending_inputs_resume_all_steers_prepares_one_turn_batch(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    first, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第一条暂停引导",
        mode=PENDING_INPUT_MODE_STEER,
    )
    second, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-pending",
        message="第二条暂停引导",
        mode=PENDING_INPUT_MODE_STEER,
    )
    repositories.pending_inputs.pause_active_for_session("ses-pending")

    resumed = repositories.pending_inputs.resume_steers_as_new_turn("ses-pending")

    assert [record.id for record in resumed] == [first.id, second.id]
    assert resumed[0].mode == PENDING_INPUT_MODE_QUEUE
    assert resumed[0].status == PENDING_INPUT_STATUS_QUEUED
    assert resumed[1].mode == PENDING_INPUT_MODE_STEER
    assert resumed[1].status == PENDING_INPUT_STATUS_PENDING_STEER
    assert all(record.paused_at is None for record in resumed)
