from __future__ import annotations

import asyncio
from urllib.parse import quote, urlsplit

from backend.app.web.config import WebProviderConfigField, WebProviderFieldType
from backend.app.web.errors import WebErrorCode, WebProviderError, web_error
from backend.app.web.models import (
    WebCapability,
    WebFetchItem,
    WebFetchRequest,
    WebFetchResponse,
    WebFetchStatus,
    WebSearchRequest,
    WebSearchResponse,
    WebSource,
)
from backend.app.web.policies import stable_source_id
from backend.app.web.provider import (
    BaseWebProvider,
    WebConnectionCheckResult,
    WebProviderContext,
    WebProviderDescriptor,
)


class E2EWebProvider(BaseWebProvider):
    """Deterministic provider available only with KEYDEX_E2E_MODEL_TRANSPORT."""

    descriptor = WebProviderDescriptor(
        provider_id="e2e_mock",
        display_name="E2E Mock",
        description="仅用于隔离页面测试的确定性网络搜索引擎",
        capabilities={WebCapability.SEARCH, WebCapability.FETCH},
        config_fields=(
            WebProviderConfigField(
                key="project_id",
                field_type=WebProviderFieldType.TEXT,
                label="测试项目 ID",
                required=True,
                placeholder="请输入隔离测试项目 ID",
            ),
            WebProviderConfigField(
                key="api_key",
                field_type=WebProviderFieldType.SECRET,
                label="测试 API Key",
                required=True,
                placeholder="请输入虚构测试密钥",
            ),
        ),
    )

    def __init__(self) -> None:
        self.search_requests: list[WebSearchRequest] = []
        self.fetch_requests: list[WebFetchRequest] = []

    async def search(
        self,
        request: WebSearchRequest,
        context: WebProviderContext,
    ) -> WebSearchResponse:
        self._require_context(context)
        self.search_requests.append(request)
        lowered = request.query.lower()
        if "cancel-delay" in lowered:
            await asyncio.sleep(5)
        elif "delay" in lowered:
            await asyncio.sleep(0.8)
        if "error-auth" in lowered:
            raise WebProviderError(
                web_error(WebErrorCode.AUTHENTICATION_FAILED, provider_id="e2e_mock")
            )
        if "error-quota" in lowered:
            raise WebProviderError(
                web_error(WebErrorCode.QUOTA_EXHAUSTED, provider_id="e2e_mock")
            )
        if "error-rate" in lowered:
            raise WebProviderError(
                web_error(
                    WebErrorCode.RATE_LIMITED,
                    provider_id="e2e_mock",
                    retry_after_seconds=2,
                )
            )
        if "error-canary" in lowered:
            secret = str(context.secrets.get("api_key") or "")
            raise WebProviderError(
                web_error(
                    WebErrorCode.PROVIDER_UNAVAILABLE,
                    provider_id="e2e_mock",
                    diagnostic={"provider_body": f"api_key={secret}"},
                    sensitive_values=(secret,),
                )
            )
        if "empty" in lowered:
            return WebSearchResponse(
                provider_id="e2e_mock",
                query=request.query,
                sources=[],
                duration_ms=3,
            )

        sources = self._search_sources(request.query)
        return WebSearchResponse(
            provider_id="e2e_mock",
            query=request.query,
            sources=sources,
            duration_ms=4,
            metadata={"provider_request_id": "e2e-search-request"},
        )

    async def fetch(
        self,
        request: WebFetchRequest,
        context: WebProviderContext,
    ) -> WebFetchResponse:
        self._require_context(context)
        self.fetch_requests.append(request)
        if request.query and "delay" in request.query.lower():
            await asyncio.sleep(5)
        items: list[WebFetchItem] = []
        for url in request.urls:
            host = (urlsplit(url).hostname or "").lower()
            if "fail" in host or "/missing" in url:
                items.append(
                    WebFetchItem(
                        requested_url=url,
                        status="failed",
                        error_code="fetch_failed",
                        error_message="网页内容读取失败",
                    )
                )
                continue
            items.append(
                WebFetchItem(
                    requested_url=url,
                    status="success",
                    source=WebSource(
                        source_id=stable_source_id(url),
                        url=url,
                        domain=host,
                        title="E2E Article" if host == "example.test" else f"E2E Fetched {host}",
                        snippet="E2E 已读取网页正文摘要",
                        favicon=f"https://{host}/favicon.ico",
                    ),
                    content=(
                        "# E2E Web Fetch\n\n"
                        "这是确定性 Mock Provider 返回的正文，用于验证 Fetch、截断和引用链路。"
                    ),
                )
            )
        successes = sum(item.status == "success" for item in items)
        status = (
            WebFetchStatus.SUCCESS
            if successes == len(items)
            else WebFetchStatus.FAILED
            if successes == 0
            else WebFetchStatus.PARTIAL_FAILURE
        )
        return WebFetchResponse(
            provider_id="e2e_mock",
            status=status,
            items=items,
            duration_ms=5,
            metadata={"provider_request_id": "e2e-fetch-request"},
        )

    async def check_connection(
        self,
        context: WebProviderContext,
    ) -> WebConnectionCheckResult:
        try:
            self._require_context(context)
        except WebProviderError as exc:
            return WebConnectionCheckResult(
                provider_id="e2e_mock",
                ok=False,
                duration_ms=1,
                error=exc.payload,
            )
        if context.secrets.get("api_key") == "e2e-bad-key":
            return WebConnectionCheckResult(
                provider_id="e2e_mock",
                ok=False,
                duration_ms=1,
                error=web_error(
                    WebErrorCode.AUTHENTICATION_FAILED,
                    provider_id="e2e_mock",
                ),
            )
        if context.secrets.get("api_key") == "e2e-offline-key":
            return WebConnectionCheckResult(
                provider_id="e2e_mock",
                ok=False,
                duration_ms=1,
                error=web_error(
                    WebErrorCode.NETWORK_UNAVAILABLE,
                    provider_id="e2e_mock",
                ),
            )
        return WebConnectionCheckResult(provider_id="e2e_mock", ok=True, duration_ms=1)

    @staticmethod
    def _require_context(context: WebProviderContext) -> None:
        context.require_secret("api_key")
        if not str(context.config.get("project_id") or "").strip():
            raise WebProviderError(
                web_error(WebErrorCode.PROVIDER_NOT_CONFIGURED, provider_id="e2e_mock")
            )

    @staticmethod
    def _search_sources(query: str) -> list[WebSource]:
        lowered = query.lower()
        if "multi-second" in lowered:
            variants = [
                ("https://e2e.web.test/articles/shared", "E2E Shared Source"),
                ("https://second.e2e.web.test/articles/unique", "E2E Second Source"),
            ]
        elif "multi-first" in lowered:
            variants = [
                ("https://e2e.web.test/articles/shared", "E2E Shared Source"),
                ("https://first.e2e.web.test/articles/unique", "E2E First Source"),
            ]
        else:
            slug = quote(query.strip().lower().replace(" ", "-")[:48] or "default", safe="-")
            variants = [
                (f"https://e2e.web.test/articles/{slug}", "E2E Citation Source"),
                ("https://docs.e2e.web.test/reference", "E2E Reference Source"),
                ("https://guide.e2e.web.test/overview", "E2E Guide Source"),
            ]
        return [
            WebSource(
                source_id=stable_source_id(url),
                url=url,
                domain=urlsplit(url).hostname or "e2e.web.test",
                title=title,
                snippet="E2E deterministic search result",
                favicon="https://e2e.web.test/favicon.ico",
                published_at="2026-07-15",
                score=0.9 - index * 0.1,
            )
            for index, (url, title) in enumerate(variants)
        ]
