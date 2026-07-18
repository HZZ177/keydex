from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

import pytest

from backend.app.agent.event_processor import process_agent_events
from backend.app.events import DomainEvent, DomainEventType, EventDispatcher


class CancellationToken:
    def __init__(self) -> None:
        self.cancelled = False

    def is_cancelled(self) -> bool:
        return self.cancelled


async def _events(values: list[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
    for value in values:
        yield value


async def _cancel_after_start(token: CancellationToken) -> AsyncIterator[dict[str, Any]]:
    yield {
        "event": "on_tool_start",
        "run_id": "run-web",
        "name": "web_search",
        "data": {"input": {"query": "latest"}},
    }
    token.cancelled = True
    yield {"event": "on_chain_stream", "run_id": "ignored", "data": {}}


async def _capture_web_events(
    values: AsyncIterator[dict[str, Any]],
    token: CancellationToken | None = None,
) -> list[DomainEvent]:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    await process_agent_events(
        values,
        dispatcher=EventDispatcher([capture]),
        cancellation=token or CancellationToken(),
        session_id="ses-web",
        trace_id="trace-web",
        user_id="local-user",
        active_session_id="ses-web",
        turn_index=1,
    )
    return [event for event in emitted if event.run_id == "run-web"]


@pytest.mark.asyncio
async def test_web_search_projects_running_and_completed_ui_payload() -> None:
    emitted = await _capture_web_events(
        _events(
            [
                {
                    "event": "on_tool_start",
                    "run_id": "run-web",
                    "name": "web_search",
                    "data": {"input": {"query": "latest"}},
                },
                {
                    "event": "on_tool_end",
                    "run_id": "run-web",
                    "name": "web_search",
                    "data": {
                        "output": json.dumps(
                            {
                                "kind": "web_search",
                                "schema_version": 1,
                                "status": "success",
                                "provider_id": "private-provider",
                                "query": "latest",
                                "sources": [
                                    {
                                        "source_id": f"src_{index}",
                                        "url": f"https://example.com/{index}",
                                        "domain": "example.com",
                                        "title": f"Example {index}",
                                        "snippet": "Summary",
                                        "truncated": False,
                                        "metadata": {"raw": "not-public"},
                                    }
                                    for index in range(20)
                                ],
                            },
                            ensure_ascii=False,
                        )
                    },
                },
            ]
        )
    )

    assert [event.event_type for event in emitted] == [
        DomainEventType.LLM_TOOL_STARTED.value,
        DomainEventType.LLM_TOOL_FINISHED.value,
    ]
    assert emitted[0].payload["ui_payload"]["status"] == "running"
    completed = emitted[1].payload["ui_payload"]
    assert completed["kind"] == "web_activity"
    assert completed["activity_type"] == "search"
    assert completed["status"] == "completed"
    assert len(completed["sources"]) == 20
    assert completed["sources"][0]["source_id"] == "src_0"
    assert completed["sources"][-1]["source_id"] == "src_19"
    assert "provider_id" not in completed
    assert "raw" not in json.dumps(emitted[1].payload, ensure_ascii=False)


@pytest.mark.asyncio
async def test_web_fetch_projects_partial_failure_without_persisting_body() -> None:
    long_body = "正文" * 400
    emitted = await _capture_web_events(
        _events(
            [
                {
                    "event": "on_tool_start",
                    "run_id": "run-web",
                    "name": "web_fetch",
                    "data": {
                        "input": {
                            "urls": [
                                "https://example.com/a",
                                "https://failed.example/b",
                            ]
                        }
                    },
                },
                {
                    "event": "on_tool_end",
                    "run_id": "run-web",
                    "name": "web_fetch",
                    "data": {
                        "output": json.dumps(
                            {
                                "kind": "web_fetch",
                                "schema_version": 1,
                                "status": "partial_failure",
                                "items": [
                                    {
                                        "requested_url": "https://example.com/a",
                                        "status": "success",
                                        "source": {
                                            "source_id": "src_1",
                                            "url": "https://example.com/a",
                                            "domain": "example.com",
                                            "truncated": True,
                                        },
                                        "content": long_body,
                                    },
                                    {
                                        "requested_url": "https://failed.example/b",
                                        "status": "failed",
                                        "error_code": "fetch_failed",
                                        "error_message": "网页内容读取失败",
                                    },
                                ],
                            },
                            ensure_ascii=False,
                        )
                    },
                },
            ]
        )
    )

    finished = emitted[1].payload
    assert finished["ui_payload"]["status"] == "partial_failure"
    assert len(finished["ui_payload"]["items"][0]["source"]["snippet"]) <= 501
    assert "content" not in finished["ui_payload"]["items"][0]
    assert long_body not in finished["result"]
    assert long_body not in json.dumps(finished["output_data"], ensure_ascii=False)


@pytest.mark.asyncio
async def test_web_failure_projects_stable_sanitized_error() -> None:
    emitted = await _capture_web_events(
        _events(
            [
                {
                    "event": "on_tool_start",
                    "run_id": "run-web",
                    "name": "web_search",
                    "data": {"input": {"query": "latest"}},
                },
                {
                    "event": "on_tool_end",
                    "run_id": "run-web",
                    "name": "web_search",
                    "data": {
                        "output": json.dumps(
                            {
                                "tool": "web_search",
                                "ok": False,
                                "status": "failed",
                                "code": "rate_limited",
                                "message": "请求过于频繁，请稍后重试",
                                "details": {
                                    "retryable": True,
                                    "retry_after_seconds": 12,
                                    "provider_id": "provider-a",
                                },
                            },
                            ensure_ascii=False,
                        )
                    },
                },
            ]
        )
    )

    failed = emitted[1]
    assert failed.event_type == DomainEventType.LLM_TOOL_FAILED.value
    assert failed.payload["ui_payload"]["error"] == {
        "schema_version": 1,
        "code": "rate_limited",
        "message": "请求过于频繁，请稍后重试",
        "details": {
            "provider_id": "provider-a",
            "retry_after_seconds": 12,
        },
        "retryable": True,
        "status": None,
    }
    assert failed.payload["error"] == {
        "schema_version": 1,
        "code": "rate_limited",
        "message": "请求过于频繁，请稍后重试",
        "details": {
            "provider_id": "provider-a",
            "retry_after_seconds": 12,
            "tool": "web_search",
        },
        "retryable": True,
    }
    assert "error_type" not in failed.payload
    assert "provider-a" in failed.payload["result"]


@pytest.mark.asyncio
async def test_active_web_tool_is_projected_cancelled_when_turn_stops() -> None:
    token = CancellationToken()

    emitted = await _capture_web_events(_cancel_after_start(token), token)

    assert len(emitted) == 2
    assert emitted[1].event_type == DomainEventType.LLM_TOOL_FINISHED.value
    assert emitted[1].payload["status"] == "cancelled"
    assert emitted[1].payload["ui_payload"]["status"] == "cancelled"
