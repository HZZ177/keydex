from __future__ import annotations

import pytest

from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses_usage",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    repositories.trace_records.create(
        trace_id="trace_usage",
        session_id="ses_usage",
        active_session_id="ses_usage",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="trace_usage-root",
    )
    return repositories


def test_llm_request_logs_start_finish_and_get(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    started = repositories.llm_request_logs.start(
        request_id="llm_req_1",
        trace_id="trace_usage",
        trace_record_id="trace_usage",
        session_id="ses_usage",
        active_session_id="ses_usage",
        gateway_thread_id="trace_usage",
        gateway_trace_id="gateway_trace_1",
        turn_index=1,
        provider_id="provider-1",
        provider_name="默认模型服务",
        model="deepseek-v4-flash",
        request_preview="用户问题",
        metadata={"api_key": "secret", "temperature": 0.1},
        start_time="2026-06-18T10:00:00Z",
    )

    assert started.status == "running"
    assert started.provider_name == "默认模型服务"
    assert started.gateway_thread_id == "trace_usage"
    assert started.gateway_trace_id == "gateway_trace_1"
    assert started.metadata == {"temperature": 0.1}

    finished = repositories.llm_request_logs.finish(
        "llm_req_1",
        input_tokens=100,
        cache_read_tokens=20,
        output_tokens=31,
        response_preview="模型回答",
        duration_ms=245,
        end_time="2026-06-18T10:00:01Z",
    )

    assert finished is not None
    assert finished.status == "completed"
    assert finished.input_tokens == 100
    assert finished.cache_read_tokens == 20
    assert finished.output_tokens == 31
    assert finished.total_tokens == 131
    assert finished.duration_ms == 245
    assert finished.response_preview == "模型回答"
    assert finished.gateway_thread_id == "trace_usage"
    assert finished.gateway_trace_id == "gateway_trace_1"
    assert finished.metadata == {"temperature": 0.1}
    assert repositories.llm_request_logs.get("llm_req_1") == finished


def test_llm_request_logs_fail_list_summary_and_trend(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.llm_request_logs.start(
        request_id="llm_req_success",
        trace_id="trace_usage",
        trace_record_id="trace_usage",
        session_id="ses_usage",
        model="model-a",
        start_time="2026-06-18T10:00:00Z",
    )
    repositories.llm_request_logs.finish(
        "llm_req_success",
        input_tokens=10,
        output_tokens=5,
        cache_read_tokens=3,
        duration_ms=120,
        end_time="2026-06-18T10:00:01Z",
    )
    repositories.llm_request_logs.start(
        request_id="llm_req_failed",
        trace_id="trace_usage",
        trace_record_id="trace_usage",
        session_id="ses_usage",
        model="model-b",
        start_time="2026-06-19T12:00:00Z",
    )
    repositories.llm_request_logs.fail(
        "llm_req_failed",
        error_message="HTTP 400",
        duration_ms=50,
        end_time="2026-06-19T12:00:01Z",
    )

    listed, total = repositories.llm_request_logs.list(page=1, page_size=1)
    failed, failed_total = repositories.llm_request_logs.list(status="failed")
    model_a, model_a_total = repositories.llm_request_logs.list(model="model-a")
    summary = repositories.llm_request_logs.summary()
    filtered_summary = repositories.llm_request_logs.summary(
        start_time="2026-06-18T00:00:00Z",
        end_time="2026-06-18T23:59:59Z",
    )
    trend = repositories.llm_request_logs.trend(bucket="day")

    assert total == 2
    assert len(listed) == 1
    assert failed_total == 1
    assert failed[0].error_message == "HTTP 400"
    assert model_a_total == 1
    assert model_a[0].model == "model-a"
    assert summary == {
        "request_count": 2,
        "input_tokens": 10,
        "cache_read_tokens": 3,
        "output_tokens": 5,
        "total_tokens": 15,
        "success_count": 1,
        "failed_count": 1,
        "avg_duration_ms": 85,
    }
    assert filtered_summary["request_count"] == 1
    assert filtered_summary["total_tokens"] == 15
    assert trend == [
        {
            "time": "2026-06-18",
            "request_count": 1,
            "input_tokens": 10,
            "cache_read_tokens": 3,
            "output_tokens": 5,
            "total_tokens": 15,
            "failed_count": 0,
        },
        {
            "time": "2026-06-19",
            "request_count": 1,
            "input_tokens": 0,
            "cache_read_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "failed_count": 1,
        },
    ]


def test_llm_request_logs_validates_trend_bucket(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    with pytest.raises(ValueError, match="不支持的用量统计粒度"):
        repositories.llm_request_logs.trend(bucket="minute")


def test_llm_request_logs_trend_groups_by_requested_timezone(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.llm_request_logs.start(
        request_id="llm_req_local_20",
        trace_id="trace_usage",
        trace_record_id="trace_usage",
        session_id="ses_usage",
        model="model-a",
        start_time="2026-06-20T15:30:00Z",
    )
    repositories.llm_request_logs.finish(
        "llm_req_local_20",
        input_tokens=10,
        output_tokens=1,
        end_time="2026-06-20T15:30:01Z",
    )
    repositories.llm_request_logs.start(
        request_id="llm_req_local_21",
        trace_id="trace_usage",
        trace_record_id="trace_usage",
        session_id="ses_usage",
        model="model-a",
        start_time="2026-06-20T16:30:00Z",
    )
    repositories.llm_request_logs.finish(
        "llm_req_local_21",
        input_tokens=20,
        output_tokens=2,
        end_time="2026-06-20T16:30:01Z",
    )

    trend = repositories.llm_request_logs.trend(
        bucket="day",
        timezone_offset_minutes=8 * 60,
    )

    assert trend == [
        {
            "time": "2026-06-20",
            "request_count": 1,
            "input_tokens": 10,
            "cache_read_tokens": 0,
            "output_tokens": 1,
            "total_tokens": 11,
            "failed_count": 0,
        },
        {
            "time": "2026-06-21",
            "request_count": 1,
            "input_tokens": 20,
            "cache_read_tokens": 0,
            "output_tokens": 2,
            "total_tokens": 22,
            "failed_count": 0,
        },
    ]
