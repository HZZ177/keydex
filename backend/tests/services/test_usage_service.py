from __future__ import annotations

import pytest

from backend.app.services import UsageRequestNotFoundError, UsageRequestQuery, UsageService
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses_usage_service",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    repositories.trace_records.create(
        trace_id="trace_usage_service",
        session_id="ses_usage_service",
        active_session_id="ses_usage_service",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="trace_usage_service-root",
        user_message_preview="统计一下",
    )
    return repositories


def _seed_request(repositories: StorageRepositories) -> None:
    repositories.llm_request_logs.start(
        request_id="llm_req_service",
        trace_id="trace_usage_service",
        trace_record_id="trace_usage_service",
        session_id="ses_usage_service",
        active_session_id="ses_usage_service",
        gateway_thread_id="trace_usage_service",
        gateway_trace_id="gateway_trace_service",
        turn_index=1,
        model="deepseek-v4-flash",
        request_preview="统计一下",
        start_time="2026-06-18T10:00:00Z",
    )
    repositories.llm_request_logs.finish(
        "llm_req_service",
        input_tokens=20,
        cache_read_tokens=6,
        output_tokens=9,
        duration_ms=321,
        response_preview="统计结果",
        end_time="2026-06-18T10:00:01Z",
    )
    repositories.trace_event_logs.append(
        trace_id="trace_usage_service",
        trace_record_id="trace_usage_service",
        event_type="turn.completed",
        source="chat_service",
        idempotency_key="trace_usage_service:completed",
        timestamp_ms=1,
        sequence_no=1,
        run_id="run_1",
        payload={
            "status": "completed",
            "authorization": "secret",
            "final_content": "统计结果",
        },
    )


def test_usage_service_returns_empty_summary_and_lists(tmp_path) -> None:
    service = UsageService(_repositories(tmp_path))

    assert service.get_summary() == {
        "request_count": 0,
        "input_tokens": 0,
        "cache_read_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
        "success_count": 0,
        "failed_count": 0,
        "avg_duration_ms": 0,
    }
    assert service.get_trend() == []
    assert service.list_requests(UsageRequestQuery()) == {
        "list": [],
        "total": 0,
        "page": 1,
        "page_size": 20,
    }


def test_usage_service_summarizes_trend_and_request_list(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _seed_request(repositories)
    service = UsageService(repositories)

    assert service.get_summary(model="deepseek-v4-flash")["total_tokens"] == 29
    assert service.get_trend(bucket="day") == [
        {
            "time": "2026-06-18",
            "request_count": 1,
            "input_tokens": 20,
            "cache_read_tokens": 6,
            "output_tokens": 9,
            "total_tokens": 29,
            "failed_count": 0,
        }
    ]
    listed = service.list_requests(UsageRequestQuery(page=1, page_size=10))

    assert listed["total"] == 1
    assert listed["list"][0]["id"] == "llm_req_service"
    assert listed["list"][0]["request_preview"] == "统计一下"
    assert listed["list"][0]["model"] == "deepseek-v4-flash"
    assert listed["list"][0]["gateway_thread_id"] == "trace_usage_service"
    assert listed["list"][0]["gateway_trace_id"] == "gateway_trace_service"


def test_usage_service_returns_request_detail_with_trace_and_event_summary(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _seed_request(repositories)
    service = UsageService(repositories)

    detail = service.get_request_detail("llm_req_service")

    assert detail["request"]["response_preview"] == "统计结果"
    assert detail["request"]["gateway_thread_id"] == "trace_usage_service"
    assert detail["request"]["gateway_trace_id"] == "gateway_trace_service"
    assert detail["trace"]["user_message_preview"] == "统计一下"
    assert detail["events"][0]["event_type"] == "turn.completed"
    assert detail["events"][0]["run_id"] == "run_1"
    assert "authorization" not in detail["events"][0]["payload_summary"]


def test_usage_service_raises_for_missing_request(tmp_path) -> None:
    service = UsageService(_repositories(tmp_path))

    with pytest.raises(UsageRequestNotFoundError):
        service.get_request_detail("missing")
