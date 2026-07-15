from __future__ import annotations

import asyncio
import json

import pytest

from backend.app.agent.langchain_tools import local_tool_to_langchain_tool
from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.web import (
    WEB_FETCH_DESCRIPTION,
    WEB_FETCH_PARAMETERS,
    create_web_fetch_tool,
    register_web_fetch_tool,
)
from backend.app.web.errors import WebErrorCode, WebProviderError, web_error
from backend.app.web.models import (
    WebFetchItem,
    WebFetchRequest,
    WebFetchResponse,
    WebSource,
)


class FakeWebService:
    def __init__(self) -> None:
        self.requests: list[WebFetchRequest] = []
        self.response = WebFetchResponse(
            provider_id="fake",
            status="success",
            items=[
                WebFetchItem(
                    requested_url="https://example.com/",
                    status="success",
                    source=WebSource(
                        source_id="src_1",
                        url="https://example.com/",
                        domain="example.com",
                    ),
                    content="Example content",
                )
            ],
        )
        self.error: BaseException | None = None

    async def fetch(self, request: WebFetchRequest) -> WebFetchResponse:
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        return self.response


def _context(tmp_path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-web",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace-web",
    )


def test_web_fetch_tool_schema_is_provider_neutral_and_bounded() -> None:
    tool = create_web_fetch_tool(FakeWebService())  # type: ignore[arg-type]

    assert tool.name == "web_fetch"
    assert tool.parameters == WEB_FETCH_PARAMETERS
    assert set(tool.parameters["properties"]) == {"urls", "query"}
    assert tool.parameters["properties"]["urls"]["maxItems"] == 5
    assert tool.description == WEB_FETCH_DESCRIPTION
    assert "使用 web_search 返回的来源 URL" in tool.description
    assert "部分页面失败" in tool.description
    assert "truncated=true" in tool.description
    assert "需要理解整个页面时应省略" in tool.parameters["properties"]["query"]["description"]
    serialized = json.dumps(tool.parameters)
    assert "headers" not in serialized
    assert "extract_depth" not in serialized
    assert "file_path" not in serialized


@pytest.mark.asyncio
async def test_web_fetch_tool_runs_single_and_multi_url_requests(tmp_path) -> None:
    service = FakeWebService()
    tool = create_web_fetch_tool(service)  # type: ignore[arg-type]

    single = await tool.run({"urls": ["https://example.com"]}, _context(tmp_path))
    multi = await tool.run(
        {
            "urls": ["https://one.test", "https://two.test"],
            "query": "relevant section",
        },
        _context(tmp_path),
    )

    assert single.ok is True
    assert single.result["kind"] == "web_fetch"
    assert single.result["items"][0]["source"]["source_id"] == "src_1"
    assert multi.ok is True
    assert service.requests[1] == WebFetchRequest(
        urls=["https://one.test", "https://two.test"],
        query="relevant section",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "args",
    [
        {},
        {"urls": []},
        {"urls": [f"https://example.com/{index}" for index in range(6)]},
        {"urls": ["https://example.com"], "headers": {"Authorization": "secret"}},
        {"urls": ["https://example.com"], "extract_depth": "advanced"},
    ],
)
async def test_web_fetch_tool_rejects_invalid_arguments(tmp_path, args: dict) -> None:
    service = FakeWebService()
    result = await create_web_fetch_tool(service).run(  # type: ignore[arg-type]
        args,
        _context(tmp_path),
    )

    assert result.ok is False
    assert result.error is not None
    assert result.error["code"] == "invalid_request"
    assert service.requests == []


@pytest.mark.asyncio
async def test_web_fetch_tool_returns_partial_failure_as_consumable_result(tmp_path) -> None:
    service = FakeWebService()
    service.response = WebFetchResponse(
        provider_id="fake",
        status="partial_failure",
        items=[
            service.response.items[0],
            WebFetchItem(
                requested_url="https://failed.test/",
                status="failed",
                error_code="fetch_failed",
                error_message="网页内容读取失败",
            ),
        ],
    )

    result = await create_web_fetch_tool(service).run(  # type: ignore[arg-type]
        {"urls": ["https://example.com", "https://failed.test"]},
        _context(tmp_path),
    )

    assert result.ok is True
    assert result.result["status"] == "partial_failure"
    assert result.result["items"][0]["content"] == "Example content"
    assert result.result["items"][1]["error_code"] == "fetch_failed"


@pytest.mark.asyncio
async def test_web_fetch_tool_returns_all_failed_as_structured_result(tmp_path) -> None:
    service = FakeWebService()
    service.response = WebFetchResponse(
        provider_id="fake",
        status="failed",
        items=[
            WebFetchItem(
                requested_url="https://failed.test/",
                status="failed",
                error_code="response_missing",
            )
        ],
    )

    result = await create_web_fetch_tool(service).run(  # type: ignore[arg-type]
        {"urls": ["https://failed.test"]},
        _context(tmp_path),
    )

    assert result.ok is True
    assert result.result["status"] == "failed"
    assert result.result["items"][0]["error_code"] == "response_missing"


@pytest.mark.asyncio
async def test_web_fetch_tool_preserves_unsafe_url_error(tmp_path) -> None:
    service = FakeWebService()
    service.error = WebProviderError(web_error(WebErrorCode.UNSAFE_URL))

    result = await create_web_fetch_tool(service).run(  # type: ignore[arg-type]
        {"urls": ["http://127.0.0.1"]},
        _context(tmp_path),
    )

    assert result.ok is False
    assert result.error is not None
    assert result.error["code"] == "unsafe_url"


@pytest.mark.asyncio
async def test_web_fetch_tool_preserves_truncation_metadata(tmp_path) -> None:
    service = FakeWebService()
    source = service.response.items[0].source
    assert source is not None
    service.response = service.response.model_copy(
        update={
            "items": [
                service.response.items[0].model_copy(
                    update={
                        "source": source.model_copy(
                            update={
                                "truncated": True,
                                "metadata": {
                                    "original_content_chars": 25_000,
                                    "content_chars": 20_000,
                                },
                            }
                        ),
                        "content": "x" * 20_000,
                    }
                )
            ]
        }
    )

    result = await create_web_fetch_tool(service).run(  # type: ignore[arg-type]
        {"urls": ["https://example.com"]},
        _context(tmp_path),
    )

    assert result.result["items"][0]["source"]["truncated"] is True
    assert result.result["items"][0]["source"]["metadata"]["content_chars"] == 20_000


@pytest.mark.asyncio
async def test_web_fetch_tool_propagates_cancellation(tmp_path) -> None:
    service = FakeWebService()
    service.error = asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await create_web_fetch_tool(service).run(  # type: ignore[arg-type]
            {"urls": ["https://example.com"]},
            _context(tmp_path),
        )


@pytest.mark.asyncio
async def test_web_fetch_tool_langchain_roundtrip(tmp_path) -> None:
    service = FakeWebService()
    langchain_tool = local_tool_to_langchain_tool(
        create_web_fetch_tool(service),  # type: ignore[arg-type]
        context_factory=lambda: _context(tmp_path),
    )

    payload = json.loads(
        await langchain_tool.ainvoke({"urls": ["https://example.com"]})
    )

    assert langchain_tool.description == WEB_FETCH_DESCRIPTION
    assert payload["kind"] == "web_fetch"
    assert payload["status"] == "success"
    assert payload["items"][0]["content"] == "Example content"


def test_web_fetch_tool_registers_explicitly() -> None:
    service = FakeWebService()
    registry = ToolRegistry()

    tool = register_web_fetch_tool(registry, service)  # type: ignore[arg-type]

    assert tool.name == "web_fetch"
    assert registry.names() == ["web_fetch"]
