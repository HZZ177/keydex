from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlsplit

import httpx

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
from backend.app.web.policies import WebUrlPolicyError, normalize_web_url, stable_source_id
from backend.app.web.provider import (
    BaseWebProvider,
    WebConnectionCheckResult,
    WebProviderContext,
    WebProviderDescriptor,
    WebProviderSetupLink,
)
from backend.app.web.providers.tavily_http import (
    TavilyHttpClient,
    TavilyHttpStatusError,
    TavilyResponseError,
)


class TavilyProvider(BaseWebProvider):
    """Tavily registration entry; HTTP behavior is added by the Tavily issues."""

    descriptor = WebProviderDescriptor(
        provider_id="tavily",
        display_name="Tavily",
        description="面向 Agent 的网络搜索与网页内容提取服务",
        capabilities={WebCapability.SEARCH, WebCapability.FETCH},
        credential_setup=WebProviderSetupLink(
            label="获取 Tavily 密钥",
            url="https://app.tavily.com/home",
            help_text=(
                "注册 Tavily 免费计划后，每个账号每月可获得 1,000 API Credits。"
                "Keydex 当前采用基础搜索，每次消耗 1 Credit，相当于每月最多约 1,000 次免费搜索；"
                "网页读取等调用也会消耗同一额度。"
            ),
        ),
        config_fields=(
            WebProviderConfigField(
                key="api_key",
                field_type=WebProviderFieldType.SECRET,
                label="API Key",
                required=True,
                placeholder="请输入 Tavily API Key",
                help_text="密钥仅保存在当前 Keydex 本地数据库中。",
            ),
        ),
    )

    def __init__(
        self,
        *,
        http_client: httpx.AsyncClient | None = None,
        client_factory: Callable[..., TavilyHttpClient] = TavilyHttpClient,
    ) -> None:
        self._http_client = http_client
        self._client_factory = client_factory

    async def search(
        self,
        request: WebSearchRequest,
        context: WebProviderContext,
    ) -> WebSearchResponse:
        client = self._client_factory(
            context.require_secret("api_key"),
            client=self._http_client,
        )
        try:
            response = await client.request_json(
                "POST",
                "/search",
                payload=build_tavily_search_payload(request),
            )
        except Exception as exc:
            raise map_tavily_error(exc) from exc
        return normalize_tavily_search_response(request, response)

    async def fetch(
        self,
        request: WebFetchRequest,
        context: WebProviderContext,
    ) -> WebFetchResponse:
        client = self._client_factory(
            context.require_secret("api_key"),
            client=self._http_client,
        )
        try:
            response = await client.request_json(
                "POST",
                "/extract",
                payload=build_tavily_extract_payload(request),
            )
        except Exception as exc:
            raise map_tavily_error(exc) from exc
        return normalize_tavily_extract_response(request, response)

    async def check_connection(
        self,
        context: WebProviderContext,
    ) -> WebConnectionCheckResult:
        started_at = time.perf_counter()
        try:
            client = self._client_factory(
                context.require_secret("api_key"),
                client=self._http_client,
            )
            await client.request_json("GET", "/usage")
        except WebProviderError as exc:
            return WebConnectionCheckResult(
                provider_id="tavily",
                ok=False,
                duration_ms=_elapsed_ms(started_at),
                error=exc.payload,
            )
        except Exception as exc:
            mapped = map_tavily_error(exc)
            return WebConnectionCheckResult(
                provider_id="tavily",
                ok=False,
                duration_ms=_elapsed_ms(started_at),
                error=mapped.payload,
            )
        return WebConnectionCheckResult(
            provider_id="tavily",
            ok=True,
            duration_ms=_elapsed_ms(started_at),
        )


def build_tavily_search_payload(request: WebSearchRequest) -> dict[str, object]:
    payload: dict[str, object] = {
        "query": request.query,
        "search_depth": "basic",
        "topic": "general",
        "max_results": request.max_results,
        "include_answer": False,
        "include_raw_content": False,
        "include_images": False,
        "include_image_descriptions": False,
        "include_favicon": True,
        "auto_parameters": False,
        "exact_match": False,
        "include_usage": False,
        "safe_search": True,
    }
    if request.time_range is not None:
        payload["time_range"] = request.time_range
    domains = _dedupe_domains(request.domains)
    if domains:
        payload["include_domains"] = domains
    return payload


def build_tavily_extract_payload(request: WebFetchRequest) -> dict[str, object]:
    payload: dict[str, object] = {
        "urls": list(request.urls),
        "extract_depth": "basic",
        "include_images": False,
        "include_favicon": True,
        "format": "markdown",
        "include_usage": False,
    }
    if request.query is not None:
        payload["query"] = request.query
        payload["chunks_per_source"] = 3
    return payload


def _dedupe_domains(domains: list[str]) -> list[str]:
    unique: list[str] = []
    seen: set[str] = set()
    for domain in domains:
        normalized = domain.strip().lower().rstrip(".")
        if normalized and normalized not in seen:
            seen.add(normalized)
            unique.append(normalized)
    return unique


def normalize_tavily_search_response(
    request: WebSearchRequest,
    response: dict[str, Any],
) -> WebSearchResponse:
    results = response.get("results")
    if not isinstance(results, list):
        _raise_response_invalid("results")

    sources: list[WebSource] = []
    seen_urls: set[str] = set()
    for index, raw_result in enumerate(results):
        if not isinstance(raw_result, dict):
            _raise_response_invalid("results.item", index=index)
        raw_url = raw_result.get("url")
        if not isinstance(raw_url, str):
            _raise_response_invalid("results.url", index=index)
        try:
            normalized_url = normalize_web_url(raw_url)
        except WebUrlPolicyError:
            _raise_response_invalid("results.url", index=index)
        if normalized_url in seen_urls:
            continue

        title = _optional_string(raw_result, "title", index=index)
        snippet = _optional_string(raw_result, "content", index=index)
        published_at = _optional_string(raw_result, "published_date", index=index)
        favicon = _optional_url(raw_result, "favicon", index=index)
        score = _optional_score(raw_result, index=index)
        domain = urlsplit(normalized_url).hostname
        if domain is None:  # pragma: no cover - normalize_web_url already enforces this
            _raise_response_invalid("results.url", index=index)
        sources.append(
            WebSource(
                source_id=stable_source_id(normalized_url),
                url=normalized_url,
                domain=domain,
                title=title,
                snippet=snippet,
                favicon=favicon,
                published_at=published_at,
                score=score,
            )
        )
        seen_urls.add(normalized_url)

    return WebSearchResponse(
        provider_id="tavily",
        query=request.query,
        sources=sources,
        duration_ms=_response_duration_ms(response),
        metadata=_safe_response_metadata(response),
    )


def normalize_tavily_extract_response(
    request: WebFetchRequest,
    response: dict[str, Any],
) -> WebFetchResponse:
    raw_results = response.get("results")
    raw_failures = response.get("failed_results", [])
    if not isinstance(raw_results, list):
        _raise_response_invalid("results")
    if not isinstance(raw_failures, list):
        _raise_response_invalid("failed_results")

    requested_urls = [_normalize_extract_url(url, field="request.urls") for url in request.urls]
    requested_set = set(requested_urls)
    successful = _index_extract_successes(raw_results, requested_set)
    failed = _index_extract_failures(raw_failures, requested_set)
    if set(successful) & failed:
        _raise_response_invalid("results.conflict")

    items: list[WebFetchItem] = []
    for requested_url in requested_urls:
        success = successful.get(requested_url)
        if success is not None:
            content = success["content"]
            favicon = success["favicon"]
            domain = urlsplit(requested_url).hostname
            if domain is None:  # pragma: no cover - normalized above
                _raise_response_invalid("results.url")
            items.append(
                WebFetchItem(
                    requested_url=requested_url,
                    status="success",
                    source=WebSource(
                        source_id=stable_source_id(requested_url),
                        url=requested_url,
                        domain=domain,
                        favicon=favicon,
                        metadata={"empty_content": not bool(content)},
                    ),
                    content=content or None,
                )
            )
            continue
        error_code = "fetch_failed" if requested_url in failed else "response_missing"
        error_message = (
            "网页内容读取失败" if requested_url in failed else "搜索引擎未返回该网页的结果"
        )
        items.append(
            WebFetchItem(
                requested_url=requested_url,
                status="failed",
                error_code=error_code,
                error_message=error_message,
            )
        )

    success_count = sum(item.status == "success" for item in items)
    aggregate_status = (
        WebFetchStatus.SUCCESS
        if success_count == len(items)
        else WebFetchStatus.FAILED
        if success_count == 0
        else WebFetchStatus.PARTIAL_FAILURE
    )
    return WebFetchResponse(
        provider_id="tavily",
        status=aggregate_status,
        items=items,
        duration_ms=_response_duration_ms(response),
        metadata=_safe_response_metadata(response),
    )


def _index_extract_successes(
    raw_results: list[Any],
    requested_urls: set[str],
) -> dict[str, dict[str, str | None]]:
    indexed: dict[str, dict[str, str | None]] = {}
    for index, raw_result in enumerate(raw_results):
        if not isinstance(raw_result, dict):
            _raise_response_invalid("results.item", index=index)
        raw_url = raw_result.get("url")
        if not isinstance(raw_url, str):
            _raise_response_invalid("results.url", index=index)
        url = _normalize_extract_url(raw_url, field="results.url", index=index)
        if url not in requested_urls:
            _raise_response_invalid("results.unexpected_url", index=index)
        raw_content = raw_result.get("raw_content")
        if not isinstance(raw_content, str):
            _raise_response_invalid("results.raw_content", index=index)
        if url not in indexed:
            indexed[url] = {
                "content": raw_content,
                "favicon": _optional_url(raw_result, "favicon", index=index),
            }
    return indexed


def _index_extract_failures(
    raw_failures: list[Any],
    requested_urls: set[str],
) -> set[str]:
    indexed: set[str] = set()
    for index, raw_failure in enumerate(raw_failures):
        if not isinstance(raw_failure, dict):
            _raise_response_invalid("failed_results.item", index=index)
        raw_url = raw_failure.get("url")
        if not isinstance(raw_url, str):
            _raise_response_invalid("failed_results.url", index=index)
        url = _normalize_extract_url(raw_url, field="failed_results.url", index=index)
        if url not in requested_urls:
            _raise_response_invalid("failed_results.unexpected_url", index=index)
        indexed.add(url)
    return indexed


def _normalize_extract_url(
    value: str,
    *,
    field: str,
    index: int | None = None,
) -> str:
    try:
        return normalize_web_url(value)
    except WebUrlPolicyError:
        _raise_response_invalid(field, index=index)


def _optional_string(result: dict[str, Any], key: str, *, index: int) -> str | None:
    value = result.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        _raise_response_invalid(f"results.{key}", index=index)
    return value.strip() or None


def _optional_url(result: dict[str, Any], key: str, *, index: int) -> str | None:
    value = _optional_string(result, key, index=index)
    if value is None:
        return None
    try:
        return normalize_web_url(value)
    except WebUrlPolicyError:
        _raise_response_invalid(f"results.{key}", index=index)


def _optional_score(result: dict[str, Any], *, index: int) -> float | None:
    value = result.get("score")
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _raise_response_invalid("results.score", index=index)
    score = float(value)
    if not 0 <= score <= 1:
        _raise_response_invalid("results.score", index=index)
    return score


def _response_duration_ms(response: dict[str, Any]) -> int | None:
    value = response.get("response_time")
    if value is None:
        return None
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        _raise_response_invalid("response_time")
    if seconds < 0:
        _raise_response_invalid("response_time")
    return round(seconds * 1000)


def _safe_response_metadata(response: dict[str, Any]) -> dict[str, str | int]:
    metadata: dict[str, str | int] = {}
    request_id = response.get("request_id")
    if isinstance(request_id, str) and request_id.strip():
        metadata["provider_request_id"] = request_id.strip()
    usage = response.get("usage")
    if isinstance(usage, dict):
        credits = usage.get("credits")
        if isinstance(credits, int) and not isinstance(credits, bool) and credits >= 0:
            metadata["credits"] = credits
    return metadata


def _raise_response_invalid(field: str, *, index: int | None = None) -> None:
    diagnostic: dict[str, object] = {"field": field}
    if index is not None:
        diagnostic["index"] = index
    raise WebProviderError(
        web_error(
            WebErrorCode.RESPONSE_INVALID,
            provider_id="tavily",
            diagnostic=diagnostic,
        )
    )


def map_tavily_error(error: Exception) -> WebProviderError:
    if isinstance(error, WebProviderError):
        return error
    if isinstance(error, TavilyHttpStatusError):
        code = _status_error_code(error.status_code)
        return WebProviderError(
            web_error(
                code,
                provider_id="tavily",
                provider_request_id=error.request_id,
                retry_after_seconds=(
                    _parse_retry_after(error.retry_after)
                    if code == WebErrorCode.RATE_LIMITED
                    else None
                ),
                status=error.status_code,
                diagnostic={
                    "status_code": error.status_code,
                    "provider_request_id": error.request_id,
                },
            )
        )
    if isinstance(error, httpx.TimeoutException):
        code = WebErrorCode.REQUEST_TIMEOUT
    elif isinstance(error, httpx.NetworkError):
        code = WebErrorCode.NETWORK_UNAVAILABLE
    elif isinstance(error, TavilyResponseError):
        code = WebErrorCode.RESPONSE_INVALID
    else:
        code = WebErrorCode.PROVIDER_UNAVAILABLE
    return WebProviderError(
        web_error(
            code,
            provider_id="tavily",
            diagnostic={"type": type(error).__name__},
        )
    )


def _status_error_code(status_code: int) -> WebErrorCode:
    if status_code in {401, 403}:
        return WebErrorCode.AUTHENTICATION_FAILED
    if status_code in {402, 432, 433}:
        return WebErrorCode.QUOTA_EXHAUSTED
    if status_code == 429:
        return WebErrorCode.RATE_LIMITED
    if status_code in {400, 404, 409, 422}:
        return WebErrorCode.INVALID_REQUEST
    if 500 <= status_code <= 599:
        return WebErrorCode.PROVIDER_UNAVAILABLE
    return WebErrorCode.PROVIDER_UNAVAILABLE


def _parse_retry_after(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        seconds = int(value.strip())
    except ValueError:
        return None
    return seconds if seconds >= 0 else None


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((time.perf_counter() - started_at) * 1000))
