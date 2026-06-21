from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def _client(tmp_path) -> TestClient:
    return TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))


def _seed_usage(client: TestClient) -> None:
    repositories = client.app.state.repositories
    repositories.sessions.create(
        session_id="ses_usage_api",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    repositories.trace_records.create(
        trace_id="trace_usage_api",
        session_id="ses_usage_api",
        active_session_id="ses_usage_api",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="trace_usage_api-root",
        user_message_preview="生成统计",
    )
    repositories.llm_request_logs.start(
        request_id="llm_req_api",
        trace_id="trace_usage_api",
        trace_record_id="trace_usage_api",
        session_id="ses_usage_api",
        active_session_id="ses_usage_api",
        gateway_thread_id="trace_usage_api",
        gateway_trace_id="gateway_trace_api",
        turn_index=1,
        model="deepseek-v4-flash",
        request_preview="生成统计",
        start_time="2026-06-18T10:00:00Z",
    )
    repositories.llm_request_logs.finish(
        "llm_req_api",
        input_tokens=49,
        cache_read_tokens=12,
        output_tokens=6,
        duration_ms=2400,
        response_preview="统计完成",
        end_time="2026-06-18T10:00:03Z",
    )
    repositories.trace_event_logs.append(
        trace_id="trace_usage_api",
        trace_record_id="trace_usage_api",
        event_type="turn.completed",
        source="chat_service",
        idempotency_key="trace_usage_api:completed",
        timestamp_ms=1,
        sequence_no=1,
        run_id="run_api",
        payload={"status": "completed"},
    )


def test_usage_api_returns_empty_usage_data(tmp_path) -> None:
    client = _client(tmp_path)

    summary = client.get("/api/usage/summary")
    trend = client.get("/api/usage/trend")
    requests = client.get("/api/usage/requests")

    assert summary.status_code == 200
    assert summary.json()["request_count"] == 0
    assert summary.json()["total_tokens"] == 0
    assert trend.status_code == 200
    assert trend.json()["points"] == []
    assert requests.status_code == 200
    assert requests.json()["list"] == []
    assert requests.json()["total"] == 0


def test_usage_api_returns_summary_trend_list_and_detail(tmp_path) -> None:
    client = _client(tmp_path)
    _seed_usage(client)

    summary = client.get("/api/usage/summary?model=deepseek-v4-flash")
    trend = client.get("/api/usage/trend?bucket=day")
    requests = client.get("/api/usage/requests?page=1&page_size=10")
    detail = client.get("/api/usage/requests/llm_req_api")

    assert summary.status_code == 200
    assert summary.json()["request_count"] == 1
    assert summary.json()["input_tokens"] == 49
    assert summary.json()["cache_read_tokens"] == 12
    assert summary.json()["output_tokens"] == 6
    assert summary.json()["total_tokens"] == 55
    assert trend.status_code == 200
    assert trend.json()["points"][0]["time"] == "2026-06-18"
    assert requests.status_code == 200
    assert requests.json()["total"] == 1
    assert requests.json()["list"][0]["model"] == "deepseek-v4-flash"
    assert requests.json()["list"][0]["gateway_thread_id"] == "trace_usage_api"
    assert requests.json()["list"][0]["gateway_trace_id"] == "gateway_trace_api"
    assert detail.status_code == 200
    assert detail.json()["request"]["request_preview"] == "生成统计"
    assert detail.json()["request"]["gateway_thread_id"] == "trace_usage_api"
    assert detail.json()["request"]["gateway_trace_id"] == "gateway_trace_api"
    assert detail.json()["trace"]["user_message_preview"] == "生成统计"
    assert detail.json()["events"][0]["event_type"] == "turn.completed"


def test_usage_api_filters_requests_and_returns_404(tmp_path) -> None:
    client = _client(tmp_path)
    _seed_usage(client)

    missing_model = client.get("/api/usage/requests?model=unknown")
    missing_detail = client.get("/api/usage/requests/missing")

    assert missing_model.status_code == 200
    assert missing_model.json()["total"] == 0
    assert missing_detail.status_code == 404
    assert missing_detail.json()["detail"]["code"] == "usage_request_not_found"


def test_usage_api_trend_respects_timezone_offset(tmp_path) -> None:
    client = _client(tmp_path)
    _seed_usage(client)
    repositories = client.app.state.repositories
    repositories.llm_request_logs.start(
        request_id="llm_req_api_local_day",
        trace_id="trace_usage_api",
        trace_record_id="trace_usage_api",
        session_id="ses_usage_api",
        active_session_id="ses_usage_api",
        model="deepseek-v4-flash",
        start_time="2026-06-20T16:30:00Z",
    )
    repositories.llm_request_logs.finish(
        "llm_req_api_local_day",
        input_tokens=5,
        output_tokens=2,
        end_time="2026-06-20T16:30:01Z",
    )

    trend = client.get(
        "/api/usage/trend"
        "?bucket=day"
        "&start_time=2026-06-20T00:00:00Z"
        "&end_time=2026-06-21T00:00:00Z"
        "&timezone_offset_minutes=480"
    )

    assert trend.status_code == 200
    assert trend.json()["points"] == [
        {
            "time": "2026-06-21",
            "request_count": 1,
            "input_tokens": 5,
            "cache_read_tokens": 0,
            "output_tokens": 2,
            "total_tokens": 7,
            "failed_count": 0,
        }
    ]


def test_usage_api_rejects_invalid_pagination(tmp_path) -> None:
    client = _client(tmp_path)

    response = client.get("/api/usage/requests?page_size=201")

    assert response.status_code == 422
    assert response.json()["code"] == "request_validation_failed"
