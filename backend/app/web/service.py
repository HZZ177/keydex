from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from urllib.parse import urlsplit

from backend.app.storage import StorageRepositories, WebSettingsDataError
from backend.app.web.config import validate_provider_values
from backend.app.web.errors import (
    WebErrorCode,
    WebProviderError,
    web_error,
)
from backend.app.web.models import (
    WebCapability,
    WebFetchItem,
    WebFetchRequest,
    WebFetchResponse,
    WebSearchRequest,
    WebSearchResponse,
)
from backend.app.web.policies import (
    apply_fetch_content_budget,
    apply_search_source_budget,
    stable_source_id,
    validate_safe_fetch_url,
)
from backend.app.web.provider import (
    WebProvider,
    WebProviderContext,
    ensure_provider_capability,
)
from backend.app.web.registry import WebProviderRegistry


@dataclass(frozen=True, repr=False, slots=True)
class ResolvedWebProvider:
    provider: WebProvider
    context: WebProviderContext


@dataclass(frozen=True, repr=False, slots=True)
class WebServiceSnapshot:
    """Immutable provider/config snapshot captured at agent-turn assembly."""

    resolved: Mapping[WebCapability, ResolvedWebProvider]

    def available_capabilities(self) -> frozenset[WebCapability]:
        return frozenset(self.resolved)

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        return await _search_with_resolved(self._require(WebCapability.SEARCH), request)

    async def fetch(self, request: WebFetchRequest) -> WebFetchResponse:
        return await _fetch_with_resolved(self._require(WebCapability.FETCH), request)

    def _require(self, capability: WebCapability) -> ResolvedWebProvider:
        resolved = self.resolved.get(capability)
        if resolved is None:
            raise WebProviderError(web_error(WebErrorCode.UNSUPPORTED_CAPABILITY))
        return resolved


class WebService:
    def __init__(
        self,
        repositories: StorageRepositories,
        registry: WebProviderRegistry,
    ) -> None:
        self._repositories = repositories
        self._registry = registry

    def resolve(self, capability: WebCapability) -> ResolvedWebProvider:
        resolved = self._resolve_active_provider()
        ensure_provider_capability(resolved.provider, capability)
        return resolved

    def snapshot(self) -> WebServiceSnapshot:
        resolved = self._resolve_active_provider()
        capabilities = {
            capability: resolved
            for capability in WebCapability
            if resolved.provider.descriptor.supports(capability)
        }
        return WebServiceSnapshot(resolved=MappingProxyType(capabilities))

    def _resolve_active_provider(self) -> ResolvedWebProvider:
        settings = self._repositories.web_settings.get_settings()
        if not settings.enabled:
            raise WebProviderError(web_error(WebErrorCode.WEB_DISABLED))
        provider_id = settings.active_provider_id.strip()
        if not provider_id:
            raise WebProviderError(web_error(WebErrorCode.PROVIDER_NOT_SELECTED))
        provider = self._registry.get(provider_id)
        if provider is None:
            raise WebProviderError(
                web_error(
                    WebErrorCode.PROVIDER_NOT_SELECTED,
                    diagnostic={"provider_id": provider_id},
                )
            )
        try:
            stored = self._repositories.web_settings.get_provider(provider_id)
        except WebSettingsDataError as exc:
            raise WebProviderError(
                web_error(
                    WebErrorCode.PROVIDER_NOT_CONFIGURED,
                    provider_id=provider_id,
                    diagnostic={"stored_config": "invalid", "field": exc.field},
                )
            ) from exc
        if stored is None:
            raise WebProviderError(
                web_error(WebErrorCode.PROVIDER_NOT_CONFIGURED, provider_id=provider_id)
            )
        values = validate_provider_values(
            provider.descriptor.config_fields,
            config=stored.config,
            secrets=stored.secrets,
        )
        return ResolvedWebProvider(
            provider=provider,
            context=WebProviderContext(
                config=MappingProxyType(dict(values.config)),
                secrets=MappingProxyType(dict(values.secrets)),
            ),
        )

    def is_available(self, capability: WebCapability) -> bool:
        try:
            self.resolve(capability)
        except WebProviderError:
            return False
        return True

    def available_capabilities(self) -> frozenset[WebCapability]:
        return frozenset(
            capability for capability in WebCapability if self.is_available(capability)
        )

    async def search(self, request: WebSearchRequest) -> WebSearchResponse:
        return await _search_with_resolved(self.resolve(WebCapability.SEARCH), request)

    async def fetch(self, request: WebFetchRequest) -> WebFetchResponse:
        return await _fetch_with_resolved(self.resolve(WebCapability.FETCH), request)


async def _search_with_resolved(
    resolved: ResolvedWebProvider,
    request: WebSearchRequest,
) -> WebSearchResponse:
    provider_id = resolved.provider.descriptor.provider_id
    try:
        response = await resolved.provider.search(request, resolved.context)
    except WebProviderError:
        raise
    except Exception as exc:
        raise WebProviderError(
            web_error(
                WebErrorCode.PROVIDER_UNAVAILABLE,
                provider_id=provider_id,
                diagnostic={"type": type(exc).__name__},
            )
        ) from exc
    if response.provider_id != provider_id:
        raise WebProviderError(
            web_error(
                WebErrorCode.RESPONSE_INVALID,
                provider_id=provider_id,
                diagnostic={"field": "provider_id"},
            )
        )
    controlled = response.model_copy(
        update={
            "query": request.query,
            "sources": [
                source.model_copy(update={"metadata": {}}) for source in response.sources
            ],
            "metadata": _controlled_provider_metadata(response.metadata),
        }
    )
    return apply_search_source_budget(controlled, max_sources=request.max_results)


async def _fetch_with_resolved(
    resolved: ResolvedWebProvider,
    request: WebFetchRequest,
) -> WebFetchResponse:
    provider_id = resolved.provider.descriptor.provider_id
    safe_urls = _dedupe_safe_urls(request.urls)
    provider_request = request.model_copy(update={"urls": safe_urls})
    try:
        response = await resolved.provider.fetch(provider_request, resolved.context)
    except WebProviderError:
        raise
    except Exception as exc:
        raise WebProviderError(
            web_error(
                WebErrorCode.PROVIDER_UNAVAILABLE,
                provider_id=provider_id,
                diagnostic={"type": type(exc).__name__},
            )
        ) from exc
    controlled = _controlled_fetch_response(
        response,
        provider_id=provider_id,
        requested_urls=safe_urls,
    )
    return apply_fetch_content_budget(controlled)


def _controlled_provider_metadata(metadata: dict[str, object]) -> dict[str, str | int]:
    controlled: dict[str, str | int] = {}
    request_id = metadata.get("provider_request_id")
    if isinstance(request_id, str) and request_id:
        controlled["provider_request_id"] = request_id
    credits = metadata.get("credits")
    if isinstance(credits, int) and not isinstance(credits, bool) and credits >= 0:
        controlled["credits"] = credits
    return controlled


def _dedupe_safe_urls(urls: list[str]) -> list[str]:
    safe_urls: list[str] = []
    seen: set[str] = set()
    for url in urls:
        safe = validate_safe_fetch_url(url)
        if safe not in seen:
            safe_urls.append(safe)
            seen.add(safe)
    return safe_urls


def _controlled_fetch_response(
    response: WebFetchResponse,
    *,
    provider_id: str,
    requested_urls: list[str],
) -> WebFetchResponse:
    if response.provider_id != provider_id:
        _raise_invalid_provider_response(provider_id, "provider_id")
    items_by_url: dict[str, WebFetchItem] = {}
    for item in response.items:
        requested_url = _normalize_provider_url(
            item.requested_url,
            provider_id=provider_id,
            field="items.requested_url",
        )
        if requested_url not in requested_urls or requested_url in items_by_url:
            _raise_invalid_provider_response(provider_id, "items.requested_url")
        items_by_url[requested_url] = item
    if set(items_by_url) != set(requested_urls):
        _raise_invalid_provider_response(provider_id, "items")

    controlled_items = [
        _controlled_fetch_item(
            items_by_url[url],
            requested_url=url,
            provider_id=provider_id,
        )
        for url in requested_urls
    ]
    return response.model_copy(
        update={
            "items": controlled_items,
            "metadata": _controlled_provider_metadata(response.metadata),
        }
    )


def _controlled_fetch_item(
    item: WebFetchItem,
    *,
    requested_url: str,
    provider_id: str,
) -> WebFetchItem:
    if item.status == "failed":
        error_code = _controlled_fetch_error_code(item.error_code)
        return item.model_copy(
            update={
                "requested_url": requested_url,
                "error_code": error_code,
                "error_message": (
                    "搜索引擎未返回该网页的结果"
                    if error_code == "response_missing"
                    else "网页内容读取失败"
                ),
            }
        )
    if item.source is None:  # pragma: no cover - enforced by WebFetchItem
        raise RuntimeError("Fetch success item missing source")
    source_url = _normalize_provider_url(
        item.source.url,
        provider_id=provider_id,
        field="items.source.url",
    )
    source_domain = urlsplit(source_url).hostname or item.source.domain
    return item.model_copy(
        update={
            "requested_url": requested_url,
            "source": item.source.model_copy(
                update={
                    "source_id": stable_source_id(source_url),
                    "url": source_url,
                    "domain": source_domain,
                    "metadata": {
                        "empty_content": bool(item.source.metadata.get("empty_content", False))
                    },
                }
            ),
        }
    )


def _controlled_fetch_error_code(value: str | None) -> str:
    allowed = {
        "authentication_failed",
        "fetch_failed",
        "network_unavailable",
        "provider_unavailable",
        "quota_exhausted",
        "rate_limited",
        "request_timeout",
        "response_invalid",
        "response_missing",
        "unsafe_url",
    }
    return value if value in allowed else "fetch_failed"


def _raise_invalid_provider_response(provider_id: str, field: str) -> None:
    raise WebProviderError(
        web_error(
            WebErrorCode.RESPONSE_INVALID,
            provider_id=provider_id,
            diagnostic={"field": field},
        )
    )


def _normalize_provider_url(value: str, *, provider_id: str, field: str) -> str:
    try:
        return validate_safe_fetch_url(value)
    except WebProviderError as exc:
        raise WebProviderError(
            web_error(
                WebErrorCode.RESPONSE_INVALID,
                provider_id=provider_id,
                diagnostic={"field": field},
            )
        ) from exc
