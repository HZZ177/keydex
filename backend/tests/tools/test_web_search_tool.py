from __future__ import annotations

import asyncio
import json

import pytest

from backend.app.agent.langchain_tools import local_tool_to_langchain_tool
from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.web import (
    WEB_SEARCH_DESCRIPTION,
    WEB_SEARCH_PARAMETERS,
    WEB_SEARCH_TOOL_NAME,
    create_web_search_tool,
    register_web_search_tool,
)
from backend.app.web.errors import WebErrorCode, WebProviderError, web_error
from backend.app.web.models import WebSearchRequest, WebSearchResponse, WebSource


class FakeWebService:
    def __init__(self) -> None:
        self.requests: list[WebSearchRequest] = []
        self.response = WebSearchResponse(provider_id="fake", query="default", sources=[])
        self.error: BaseException | None = None

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return self.response.model_copy(update={"query": request.query})


def _context(tmp_path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-web",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace-web",
    )


def test_web_search_tool_schema_is_provider_neutral_and_exposes_result_count() -> None:
    tool = create_web_search_tool(FakeWebService())  # type: ignore[arg-type]

    assert tool.name == WEB_SEARCH_TOOL_NAME
    assert tool.parameters == WEB_SEARCH_PARAMETERS
    assert set(tool.parameters["properties"]) == {
        "query",
        "max_results",
        "time_range",
        "domains",
    }
    assert tool.parameters["properties"]["max_results"] == {
        "type": "integer",
        "minimum": 1,
        "maximum": 20,
        "default": 5,
        "description": (
            "希望返回的来源数量，范围 1 到 20，默认 5。快速事实查询通常使用 5；"
            "资料调研、方案比较或需要更多来源时可使用 10 到 20。"
        ),
    }
    assert tool.description == WEB_SEARCH_DESCRIPTION
    assert "当前或可能变化的信息" in tool.description
    assert "max_results" in tool.description
    assert "继续使用 web_fetch" in tool.description
    assert "已经提供明确 URL" in tool.description
    assert "查询稳定知识时应省略" in tool.parameters["properties"]["time_range"]["description"]
    assert "不要包含协议、路径或通配符" in tool.parameters["properties"]["domains"]["description"]
    serialized = json.dumps(tool.parameters)
    assert "search_depth" not in serialized
    assert "include_answer" not in serialized


@pytest.mark.asyncio
async def test_web_search_tool_runs_minimal_and_optional_arguments(tmp_path) -> None:
    service = FakeWebService()
    service.response = WebSearchResponse(
        provider_id="fake",
        query="ignored",
        sources=[
            WebSource(
                source_id="src_1",
                url="https://example.com/article",
                domain="example.com",
                title="Example",
                snippet="Result",
            )
        ],
    )
    tool = create_web_search_tool(service)  # type: ignore[arg-type]

    minimal = await tool.run({"query": "Keydex"}, _context(tmp_path))
    optional = await tool.run(
        {
            "query": "recent Keydex",
            "max_results": 12,
            "time_range": "week",
            "domains": ["example.com"],
        },
        _context(tmp_path),
    )

    assert minimal.ok is True
    assert minimal.result["kind"] == "web_search"
    assert minimal.result["sources"][0]["source_id"] == "src_1"
    assert optional.ok is True
    assert service.requests[1] == WebSearchRequest(
        query="recent Keydex",
        max_results=12,
        time_range="week",
        domains=["example.com"],
    )


@pytest.mark.asyncio
async def test_web_search_tool_returns_parseable_empty_success(tmp_path) -> None:
    tool = create_web_search_tool(FakeWebService())  # type: ignore[arg-type]

    result = await tool.run({"query": "nothing"}, _context(tmp_path))

    assert result.ok is True
    assert result.result["status"] == "success"
    assert result.result["sources"] == []
    assert json.loads(json.dumps(result.result))["kind"] == "web_search"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args",
    [
        {},
        {"query": ""},
        {"query": "query", "time_range": "hour"},
        {"query": "query", "domains": ["https://example.com"]},
        {"query": "query", "search_depth": "advanced"},
        {"query": "query", "max_results": 0},
        {"query": "query", "max_results": 21},
        {"query": "query", "max_results": True},
    ],
)
async def test_web_search_tool_rejects_invalid_arguments(tmp_path, args: dict) -> None:
    service = FakeWebService()
    result = await create_web_search_tool(service).run(  # type: ignore[arg-type]
        args,
        _context(tmp_path),
    )

    assert result.ok is False
    assert result.error is not None
    assert result.error["code"] == "invalid_request"
    assert service.requests == []


@pytest.mark.asyncio
async def test_web_search_tool_preserves_stable_web_error(tmp_path) -> None:
    service = FakeWebService()
    service.error = WebProviderError(
        web_error(
            WebErrorCode.RATE_LIMITED,
            provider_id="fake",
            retry_after_seconds=7,
        )
    )

    result = await create_web_search_tool(service).run(  # type: ignore[arg-type]
        {"query": "query"},
        _context(tmp_path),
    )

    assert result.ok is False
    assert result.error == {
        "code": "rate_limited",
        "message": "搜索请求过于频繁，请稍后重试",
        "details": {
            "retryable": True,
            "provider_id": "fake",
            "retry_after_seconds": 7,
        },
    }


@pytest.mark.asyncio
async def test_web_search_tool_propagates_cancellation(tmp_path) -> None:
    service = FakeWebService()
    service.error = asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await create_web_search_tool(service).run(  # type: ignore[arg-type]
            {"query": "query"},
            _context(tmp_path),
        )


@pytest.mark.asyncio
async def test_web_search_tool_langchain_roundtrip(tmp_path) -> None:
    service = FakeWebService()
    tool = create_web_search_tool(service)  # type: ignore[arg-type]
    langchain_tool = local_tool_to_langchain_tool(
        tool,
        context_factory=lambda: _context(tmp_path),
    )

    payload = json.loads(await langchain_tool.ainvoke({"query": "Keydex"}))

    assert langchain_tool.description == WEB_SEARCH_DESCRIPTION
    assert payload["kind"] == "web_search"
    assert payload["status"] == "success"
    assert payload["query"] == "Keydex"


def test_web_search_tool_registers_without_entering_default_registry() -> None:
    service = FakeWebService()
    registry = ToolRegistry()

    registered = register_web_search_tool(registry, service)  # type: ignore[arg-type]

    assert registered.name == "web_search"
    assert registry.names() == ["web_search"]
