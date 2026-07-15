from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Literal, TypeAlias
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

WebTimeRange: TypeAlias = Literal["day", "week", "month", "year"]
WebMetadataValue: TypeAlias = str | int | float | bool | None
NonEmptyText = Annotated[str, Field(min_length=1)]
WEB_SEARCH_DEFAULT_MAX_RESULTS = 5
WEB_SEARCH_MAX_RESULTS = 20


class WebCapability(StrEnum):
    SEARCH = "search"
    FETCH = "fetch"


class WebFetchStatus(StrEnum):
    SUCCESS = "success"
    PARTIAL_FAILURE = "partial_failure"
    FAILED = "failed"


class WebDomainModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        str_strip_whitespace=True,
        use_enum_values=True,
        validate_default=True,
    )


class WebSearchRequest(WebDomainModel):
    query: NonEmptyText
    max_results: int = Field(
        default=WEB_SEARCH_DEFAULT_MAX_RESULTS,
        ge=1,
        le=WEB_SEARCH_MAX_RESULTS,
        strict=True,
    )
    time_range: WebTimeRange | None = None
    domains: list[NonEmptyText] = Field(default_factory=list, max_length=10)

    @field_validator("domains")
    @classmethod
    def normalize_domains(cls, domains: list[str]) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for domain in domains:
            value = domain.strip().lower().rstrip(".")
            if "://" in value or "/" in value or not value:
                raise ValueError("domains 只能包含主机名")
            if value not in seen:
                normalized.append(value)
                seen.add(value)
        return normalized


class WebFetchRequest(WebDomainModel):
    urls: list[NonEmptyText] = Field(min_length=1, max_length=5)
    query: str | None = None

    @field_validator("query")
    @classmethod
    def normalize_optional_query(cls, value: str | None) -> str | None:
        return value or None


class WebSource(WebDomainModel):
    source_id: NonEmptyText
    url: NonEmptyText
    domain: NonEmptyText
    title: str | None = None
    snippet: str | None = None
    favicon: str | None = None
    published_at: str | None = None
    score: float | None = Field(default=None, ge=0, le=1)
    truncated: bool = False
    metadata: dict[str, WebMetadataValue] = Field(default_factory=dict)

    @field_validator("url")
    @classmethod
    def validate_source_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            raise ValueError("来源 URL 必须是有效的 HTTP(S) URL")
        return value

    @field_validator("favicon")
    @classmethod
    def validate_favicon_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
            raise ValueError("favicon 必须是有效的 HTTP(S) URL")
        return value

    @field_validator("title", "snippet", "published_at")
    @classmethod
    def normalize_optional_text(cls, value: str | None) -> str | None:
        return value or None


class WebSearchResponse(WebDomainModel):
    provider_id: NonEmptyText
    query: NonEmptyText
    sources: list[WebSource] = Field(default_factory=list)
    duration_ms: int | None = Field(default=None, ge=0)
    metadata: dict[str, WebMetadataValue] = Field(default_factory=dict)


class WebFetchItem(WebDomainModel):
    requested_url: NonEmptyText
    status: Literal["success", "failed"]
    source: WebSource | None = None
    content: str | None = None
    error_code: str | None = None
    error_message: str | None = None

    @field_validator("content", "error_code", "error_message")
    @classmethod
    def normalize_item_optional_text(cls, value: str | None) -> str | None:
        return value or None

    @model_validator(mode="after")
    def validate_status_shape(self) -> WebFetchItem:
        if self.status == "success":
            if self.source is None:
                raise ValueError("成功的 Fetch 结果必须包含 source")
            if self.error_code is not None or self.error_message is not None:
                raise ValueError("成功的 Fetch 结果不能包含错误")
        else:
            if self.error_code is None:
                raise ValueError("失败的 Fetch 结果必须包含 error_code")
            if self.content is not None:
                raise ValueError("失败的 Fetch 结果不能包含正文")
        return self


class WebFetchResponse(WebDomainModel):
    provider_id: NonEmptyText
    status: WebFetchStatus
    items: list[WebFetchItem] = Field(min_length=1)
    duration_ms: int | None = Field(default=None, ge=0)
    metadata: dict[str, WebMetadataValue] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_aggregate_status(self) -> WebFetchResponse:
        successful = sum(item.status == "success" for item in self.items)
        expected = (
            WebFetchStatus.SUCCESS
            if successful == len(self.items)
            else WebFetchStatus.FAILED
            if successful == 0
            else WebFetchStatus.PARTIAL_FAILURE
        )
        if self.status != expected:
            raise ValueError(f"Fetch 聚合状态应为 {expected}")
        return self
