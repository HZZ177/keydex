from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable
from urllib.parse import urlsplit

from pydantic import Field, field_validator, model_validator

from backend.app.web.config import WebProviderConfigField, validate_config_field_set
from backend.app.web.errors import WebErrorCode, WebErrorPayload, WebProviderError, web_error
from backend.app.web.models import (
    WebCapability,
    WebDomainModel,
    WebFetchRequest,
    WebFetchResponse,
    WebSearchRequest,
    WebSearchResponse,
)

_PROVIDER_ID_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")


class WebProviderSetupLink(WebDomainModel):
    label: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=1, max_length=500)
    help_text: str | None = Field(default=None, max_length=500)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        normalized = value.strip()
        parsed = urlsplit(normalized)
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
        ):
            raise ValueError("Provider 配置入口必须是无凭据的 HTTPS URL")
        return normalized


class WebProviderDescriptor(WebDomainModel):
    provider_id: str = Field(min_length=1, max_length=64)
    display_name: str = Field(min_length=1, max_length=80)
    description: str = Field(min_length=1, max_length=240)
    capabilities: frozenset[WebCapability] = Field(min_length=1)
    config_fields: tuple[WebProviderConfigField, ...] = ()
    credential_setup: WebProviderSetupLink | None = None

    @field_validator("provider_id")
    @classmethod
    def validate_provider_id(cls, value: str) -> str:
        if not _PROVIDER_ID_PATTERN.fullmatch(value):
            raise ValueError("provider_id 必须匹配 ^[a-z][a-z0-9_-]{0,63}$")
        return value

    def supports(self, capability: WebCapability) -> bool:
        return capability in self.capabilities

    @field_validator("config_fields")
    @classmethod
    def validate_config_fields(
        cls,
        fields: tuple[WebProviderConfigField, ...],
    ) -> tuple[WebProviderConfigField, ...]:
        return validate_config_field_set(fields)


@dataclass(frozen=True)
class WebProviderContext:
    config: Mapping[str, Any] = field(default_factory=dict)
    secrets: Mapping[str, str] = field(default_factory=dict)

    def require_secret(self, key: str) -> str:
        value = str(self.secrets.get(key) or "").strip()
        if not value:
            raise WebProviderError(web_error(WebErrorCode.PROVIDER_NOT_CONFIGURED))
        return value


class WebConnectionCheckResult(WebDomainModel):
    provider_id: str = Field(min_length=1)
    ok: bool
    duration_ms: int | None = Field(default=None, ge=0)
    error: WebErrorPayload | None = None

    @model_validator(mode="after")
    def validate_result_shape(self) -> WebConnectionCheckResult:
        if self.ok and self.error is not None:
            raise ValueError("成功的连接检查不能包含错误")
        if not self.ok and self.error is None:
            raise ValueError("失败的连接检查必须包含错误")
        return self


@runtime_checkable
class WebProvider(Protocol):
    descriptor: WebProviderDescriptor

    async def search(
        self,
        request: WebSearchRequest,
        context: WebProviderContext,
    ) -> WebSearchResponse: ...

    async def fetch(
        self,
        request: WebFetchRequest,
        context: WebProviderContext,
    ) -> WebFetchResponse: ...

    async def check_connection(
        self,
        context: WebProviderContext,
    ) -> WebConnectionCheckResult: ...


class BaseWebProvider:
    descriptor: WebProviderDescriptor

    async def search(
        self,
        request: WebSearchRequest,
        context: WebProviderContext,
    ) -> WebSearchResponse:
        del request, context
        self._raise_unsupported(WebCapability.SEARCH)

    async def fetch(
        self,
        request: WebFetchRequest,
        context: WebProviderContext,
    ) -> WebFetchResponse:
        del request, context
        self._raise_unsupported(WebCapability.FETCH)

    async def check_connection(
        self,
        context: WebProviderContext,
    ) -> WebConnectionCheckResult:
        del context
        raise NotImplementedError

    def _raise_unsupported(self, capability: WebCapability) -> None:
        raise WebProviderError(
            web_error(
                WebErrorCode.UNSUPPORTED_CAPABILITY,
                provider_id=self.descriptor.provider_id,
                diagnostic={"capability": capability.value},
            )
        )


def ensure_provider_capability(
    provider: WebProvider,
    capability: WebCapability,
) -> None:
    if provider.descriptor.supports(capability):
        return
    raise WebProviderError(
        web_error(
            WebErrorCode.UNSUPPORTED_CAPABILITY,
            provider_id=provider.descriptor.provider_id,
            diagnostic={"capability": capability.value},
        )
    )
