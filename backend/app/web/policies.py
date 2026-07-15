from __future__ import annotations

import hashlib
import ipaddress
from urllib.parse import SplitResult, urlsplit, urlunsplit

from backend.app.web.errors import WebErrorCode, WebProviderError, web_error
from backend.app.web.models import (
    WEB_SEARCH_MAX_RESULTS,
    WebFetchItem,
    WebFetchResponse,
    WebSearchResponse,
)


class WebUrlPolicyError(ValueError):
    pass


_LOCAL_HOSTNAMES = frozenset({"localhost", "localhost.localdomain", "ip6-localhost"})
_LOCAL_HOSTNAME_SUFFIXES = (".localhost", ".local", ".internal", ".lan", ".home.arpa")
WEB_FETCH_MAX_URLS = 5
WEB_FETCH_PAGE_CHAR_BUDGET = 20_000
WEB_FETCH_TOTAL_CHAR_BUDGET = 60_000


def normalize_web_url(url: str) -> str:
    candidate = str(url or "").strip()
    try:
        parsed = urlsplit(candidate)
        port = parsed.port
    except ValueError as exc:
        raise WebUrlPolicyError("URL 无法解析") from exc
    scheme = parsed.scheme.lower()
    if scheme not in {"http", "https"} or not parsed.hostname:
        raise WebUrlPolicyError("URL 必须使用 HTTP(S) 协议并包含主机名")

    host = _normalize_host(parsed.hostname)
    if ":" in host and _is_ip_address(host):
        host = f"[{host}]"
    default_port = (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    port_suffix = f":{port}" if port is not None and not default_port else ""
    userinfo = ""
    if parsed.username is not None:
        userinfo = parsed.username
        if parsed.password is not None:
            userinfo += f":{parsed.password}"
        userinfo += "@"
    netloc = f"{userinfo}{host}{port_suffix}"
    normalized = SplitResult(
        scheme=scheme,
        netloc=netloc,
        path=parsed.path or "/",
        query=parsed.query,
        fragment="",
    )
    return urlunsplit(normalized)


def stable_source_id(url: str) -> str:
    normalized = normalize_web_url(url)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    return f"src_{digest}"


def dedupe_web_urls(urls: list[str] | tuple[str, ...]) -> list[str]:
    normalized_urls: list[str] = []
    seen: set[str] = set()
    for url in urls:
        normalized = normalize_web_url(url)
        if normalized not in seen:
            normalized_urls.append(normalized)
            seen.add(normalized)
    return normalized_urls


def validate_safe_fetch_url(url: str) -> str:
    try:
        parsed = urlsplit(str(url or "").strip())
        normalized = normalize_web_url(url)
    except (ValueError, WebUrlPolicyError) as exc:
        raise _unsafe_url_error("invalid_url") from exc
    if parsed.username is not None or parsed.password is not None:
        raise _unsafe_url_error("credentials_not_allowed")

    host = (parsed.hostname or "").rstrip(".").lower()
    if not host or "%" in host:
        raise _unsafe_url_error("invalid_host")
    if host in _LOCAL_HOSTNAMES or host.endswith(_LOCAL_HOSTNAME_SUFFIXES):
        raise _unsafe_url_error("local_hostname")

    address = _parse_literal_ip(host)
    if address is not None and not _is_public_address(address):
        raise _unsafe_url_error("non_public_ip")
    if address is None and _looks_like_noncanonical_ip(host):
        raise _unsafe_url_error("noncanonical_ip")
    return normalized


def validate_safe_fetch_urls(urls: list[str] | tuple[str, ...]) -> list[str]:
    return [validate_safe_fetch_url(url) for url in urls]


def apply_search_source_budget(
    response: WebSearchResponse,
    *,
    max_sources: int,
) -> WebSearchResponse:
    original_count = len(response.sources)
    bounded_max_sources = min(max(max_sources, 1), WEB_SEARCH_MAX_RESULTS)
    limited = response.sources[:bounded_max_sources]
    metadata = {
        **response.metadata,
        "source_count_original": original_count,
        "source_count_returned": len(limited),
        "sources_truncated": original_count > len(limited),
    }
    return response.model_copy(update={"sources": limited, "metadata": metadata})


def apply_fetch_content_budget(response: WebFetchResponse) -> WebFetchResponse:
    remaining = WEB_FETCH_TOTAL_CHAR_BUDGET
    budgeted_items: list[WebFetchItem] = []
    for item in response.items:
        if item.status != "success" or item.source is None:
            budgeted_items.append(item)
            continue
        original_content = item.content or ""
        allowed = min(WEB_FETCH_PAGE_CHAR_BUDGET, remaining)
        delivered_content = original_content[:allowed]
        delivered_chars = len(delivered_content)
        remaining -= delivered_chars
        truncated = delivered_chars < len(original_content)
        source = item.source.model_copy(
            update={
                "truncated": truncated,
                "metadata": {
                    **item.source.metadata,
                    "original_content_chars": len(original_content),
                    "content_chars": delivered_chars,
                },
            }
        )
        budgeted_items.append(
            item.model_copy(
                update={
                    "source": source,
                    "content": delivered_content or None,
                }
            )
        )
    metadata = {
        **response.metadata,
        "content_char_budget": WEB_FETCH_TOTAL_CHAR_BUDGET,
        "content_chars_returned": WEB_FETCH_TOTAL_CHAR_BUDGET - remaining,
    }
    return response.model_copy(update={"items": budgeted_items, "metadata": metadata})


def _unsafe_url_error(reason: str) -> WebProviderError:
    return WebProviderError(
        web_error(
            WebErrorCode.UNSAFE_URL,
            diagnostic={"reason": reason},
        )
    )


def _parse_literal_ip(host: str) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    try:
        return ipaddress.ip_address(host)
    except ValueError:
        if host.isdigit():
            try:
                value = int(host, 10)
                if 0 <= value <= (2**32 - 1):
                    return ipaddress.ip_address(value)
            except ValueError:
                return None
        return None


def _looks_like_noncanonical_ip(host: str) -> bool:
    if host.startswith(("0x", "0X")):
        return True
    labels = host.split(".")
    if not all(labels):
        return True
    return all(
        label.isdigit()
        or label.lower().startswith("0x")
        or (len(label) > 1 and label.startswith("0"))
        for label in labels
    )


def _is_public_address(address: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return (
        address.is_global
        and not address.is_multicast
        and not address.is_reserved
        and not address.is_unspecified
        and not address.is_loopback
        and not address.is_link_local
        and not address.is_private
    )


def _normalize_host(host: str) -> str:
    value = host.rstrip(".").lower()
    try:
        return str(ipaddress.ip_address(value))
    except ValueError:
        try:
            return value.encode("idna").decode("ascii")
        except UnicodeError as exc:
            raise WebUrlPolicyError("URL 主机名无效") from exc


def _is_ip_address(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True
