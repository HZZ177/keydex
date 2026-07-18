from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from backend.app.web.models import WEB_SEARCH_MAX_RESULTS

WebActivityStatus = Literal[
    "running",
    "completed",
    "empty",
    "partial_failure",
    "failed",
    "cancelled",
]


class WebActivityModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        str_strip_whitespace=True,
    )


class WebActivitySource(WebActivityModel):
    source_id: str = Field(min_length=1)
    url: str = Field(min_length=1)
    domain: str = Field(min_length=1)
    title: str | None = None
    snippet: str | None = None
    favicon: str | None = None
    published_at: str | None = None
    truncated: bool = False


class WebActivityError(WebActivityModel):
    schema_version: Literal[1] = 1
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    details: dict[str, Any] = Field(default_factory=dict)
    retryable: bool = False
    status: int | None = Field(default=None, ge=100, le=599)


class WebFetchActivityItem(WebActivityModel):
    requested_url: str = Field(min_length=1)
    status: Literal["success", "failed"]
    source: WebActivitySource | None = None
    error: WebActivityError | None = None

    @model_validator(mode="after")
    def validate_outcome(self) -> WebFetchActivityItem:
        if self.status == "success" and self.source is None:
            raise ValueError("成功项必须包含来源")
        if self.status == "failed" and self.error is None:
            raise ValueError("失败项必须包含错误")
        return self


class WebActivityPayload(WebActivityModel):
    kind: Literal["web_activity"] = "web_activity"
    schema_version: Literal[1] = 1
    activity_type: Literal["search", "fetch"]
    status: WebActivityStatus
    query: str | None = None
    requested_urls: list[str] = Field(default_factory=list, max_length=5)
    sources: list[WebActivitySource] = Field(
        default_factory=list,
        max_length=WEB_SEARCH_MAX_RESULTS,
    )
    items: list[WebFetchActivityItem] = Field(default_factory=list, max_length=5)
    error: WebActivityError | None = None
    started_at_ms: int | None = Field(default=None, ge=0)
    ended_at_ms: int | None = Field(default=None, ge=0)
    duration_ms: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_activity_shape(self) -> WebActivityPayload:
        if self.activity_type == "search" and (self.requested_urls or self.items):
            raise ValueError("搜索活动不能包含 Fetch 字段")
        if self.activity_type == "fetch" and self.sources:
            raise ValueError("Fetch 活动来源必须位于逐 URL items 中")
        if self.status == "failed" and self.error is None:
            raise ValueError("失败活动必须包含错误")
        return self


def build_web_activity_started(
    tool_name: str,
    params: Any,
    *,
    started_at_ms: int,
) -> dict[str, Any] | None:
    if tool_name not in {"web_search", "web_fetch"}:
        return None
    values = params if isinstance(params, dict) else {}
    if tool_name == "web_search":
        payload = WebActivityPayload(
            activity_type="search",
            status="running",
            query=_optional_text(values.get("query")),
            started_at_ms=started_at_ms,
        )
    else:
        payload = WebActivityPayload(
            activity_type="fetch",
            status="running",
            query=_optional_text(values.get("query")),
            requested_urls=_string_list(values.get("urls"), limit=5),
            started_at_ms=started_at_ms,
        )
    return payload.model_dump(mode="json")


def build_web_activity_finished(
    tool_name: str,
    output: Any,
    *,
    started_at_ms: int | None,
    ended_at_ms: int,
    duration_ms: int,
) -> dict[str, Any] | None:
    if tool_name not in {"web_search", "web_fetch"}:
        return None
    values = output if isinstance(output, dict) else {}
    if _is_failed_tool_output(values):
        return _failed_activity(
            tool_name,
            values,
            started_at_ms=started_at_ms,
            ended_at_ms=ended_at_ms,
            duration_ms=duration_ms,
        ).model_dump(mode="json")
    if tool_name == "web_search":
        sources = [
            source
            for value in _dict_list(
                values.get("sources"),
                limit=WEB_SEARCH_MAX_RESULTS,
            )
            if (source := _activity_source(value)) is not None
        ]
        payload = WebActivityPayload(
            activity_type="search",
            status="completed" if sources else "empty",
            query=_optional_text(values.get("query")),
            sources=sources,
            started_at_ms=started_at_ms,
            ended_at_ms=ended_at_ms,
            duration_ms=duration_ms,
        )
    else:
        items = [
            item
            for value in _dict_list(values.get("items"), limit=5)
            if (item := _fetch_activity_item(value)) is not None
        ]
        successful = sum(item.status == "success" for item in items)
        failed = sum(item.status == "failed" for item in items)
        if successful and failed:
            status: WebActivityStatus = "partial_failure"
        elif successful:
            status = "completed"
        elif failed:
            status = "failed"
        else:
            status = "empty"
        payload = WebActivityPayload(
            activity_type="fetch",
            status=status,
            query=_optional_text(values.get("query")),
            requested_urls=[item.requested_url for item in items],
            items=items,
            error=(
                WebActivityError(
                    code="fetch_failed",
                    message="网页内容读取失败",
                    retryable=any(item.error and item.error.retryable for item in items),
                )
                if status == "failed"
                else None
            ),
            started_at_ms=started_at_ms,
            ended_at_ms=ended_at_ms,
            duration_ms=duration_ms,
        )
    return payload.model_dump(mode="json")


def build_web_activity_cancelled(
    tool_name: str,
    params: Any,
    *,
    started_at_ms: int | None,
    ended_at_ms: int,
) -> dict[str, Any] | None:
    started = started_at_ms or ended_at_ms
    payload = build_web_activity_started(tool_name, params, started_at_ms=started)
    if payload is None:
        return None
    payload.update(
        status="cancelled",
        ended_at_ms=ended_at_ms,
        duration_ms=max(0, ended_at_ms - started),
    )
    return WebActivityPayload.model_validate(payload).model_dump(mode="json")


def _failed_activity(
    tool_name: str,
    values: dict[str, Any],
    *,
    started_at_ms: int | None,
    ended_at_ms: int,
    duration_ms: int,
) -> WebActivityPayload:
    details = values.get("details") if isinstance(values.get("details"), dict) else {}
    error = WebActivityError(
        code=_optional_text(values.get("code")) or "web_failed",
        message=_optional_text(values.get("message")) or "网络操作失败",
        details={
            key: details[key]
            for key in ("provider_id", "provider_request_id", "retry_after_seconds")
            if key in details
        },
        retryable=bool(values.get("retryable", details.get("retryable", False))),
        status=(values.get("status") if isinstance(values.get("status"), int) else None),
    )
    return WebActivityPayload(
        activity_type="search" if tool_name == "web_search" else "fetch",
        status="failed",
        error=error,
        started_at_ms=started_at_ms,
        ended_at_ms=ended_at_ms,
        duration_ms=duration_ms,
    )


def _activity_source(
    value: dict[str, Any],
    *,
    content_preview: str | None = None,
) -> WebActivitySource | None:
    source_id = _optional_text(value.get("source_id"))
    url = _optional_text(value.get("url"))
    domain = _optional_text(value.get("domain"))
    if not source_id or not url or not domain:
        return None
    snippet = _optional_text(value.get("snippet")) or content_preview
    return WebActivitySource(
        source_id=source_id,
        url=url,
        domain=domain,
        title=_optional_text(value.get("title")),
        snippet=_bounded_text(snippet, 500),
        favicon=_optional_text(value.get("favicon")),
        published_at=_optional_text(value.get("published_at")),
        truncated=bool(value.get("truncated", False)),
    )


def _fetch_activity_item(value: dict[str, Any]) -> WebFetchActivityItem | None:
    requested_url = _optional_text(value.get("requested_url"))
    status = _optional_text(value.get("status"))
    if not requested_url or status not in {"success", "failed"}:
        return None
    if status == "success":
        source_value = value.get("source") if isinstance(value.get("source"), dict) else {}
        source = _activity_source(
            source_value,
            content_preview=_bounded_text(_optional_text(value.get("content")), 500),
        )
        if source is None:
            return None
        return WebFetchActivityItem(
            requested_url=requested_url,
            status="success",
            source=source,
        )
    return WebFetchActivityItem(
        requested_url=requested_url,
        status="failed",
        error=WebActivityError(
            code=_optional_text(value.get("error_code")) or "fetch_failed",
            message=_optional_text(value.get("error_message")) or "网页内容读取失败",
        ),
    )


def _is_failed_tool_output(values: dict[str, Any]) -> bool:
    return (
        values.get("ok") is False
        and isinstance(values.get("code"), str)
        and isinstance(values.get("message"), str)
    )


def _dict_list(value: Any, *, limit: int) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value[:limit] if isinstance(item, dict)]


def _string_list(value: Any, *, limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    return [text for item in value[:limit] if (text := _optional_text(item))]


def _optional_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _bounded_text(value: str | None, limit: int) -> str | None:
    if value is None or len(value) <= limit:
        return value
    return f"{value[:limit]}…"


def _optional_non_negative_int(value: Any) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None
