from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import Field

from backend.app.api.dependencies import get_repositories
from backend.app.storage import (
    StorageRepositories,
    WebProviderConfigRecord,
    WebProviderConfigWrite,
    WebSettingsDataError,
)
from backend.app.web.config import (
    WebProviderConfigField,
    WebSecretState,
    WebSecretUpdate,
    apply_secret_updates,
    describe_secret_states,
    validate_provider_values,
)
from backend.app.web.errors import (
    WebErrorCode,
    WebErrorPayload,
    WebProviderError,
    web_error,
    web_error_from_exception,
)
from backend.app.web.models import WebCapability, WebDomainModel
from backend.app.web.provider import (
    WebProviderContext,
    WebProviderDescriptor,
    WebProviderSetupLink,
)
from backend.app.web.registry import WebProviderRegistry, build_default_web_provider_registry

router = APIRouter(prefix="/api/settings/web", tags=["settings", "web"])
RepositoriesDep = Depends(get_repositories)


class WebProviderSettingsResponse(WebDomainModel):
    provider_id: str
    display_name: str
    description: str
    capabilities: tuple[WebCapability, ...]
    config_fields: tuple[WebProviderConfigField, ...]
    credential_setup: WebProviderSetupLink | None
    config: dict[str, str | bool]
    secrets: dict[str, WebSecretState]
    configured: bool
    config_status: Literal["ready", "incomplete", "invalid"]
    connection_status: Literal["unchecked"] = "unchecked"


class WebSettingsResponse(WebDomainModel):
    enabled: bool
    active_provider_id: str
    active_provider_known: bool
    providers: tuple[WebProviderSettingsResponse, ...]


class WebProviderSettingsUpdate(WebDomainModel):
    config: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, WebSecretUpdate] = Field(default_factory=dict)


class UpdateWebSettingsRequest(WebDomainModel):
    enabled: bool
    active_provider_id: str = Field(min_length=1, max_length=64)
    providers: dict[str, WebProviderSettingsUpdate] = Field(default_factory=dict)


class WebConnectionCheckDraft(WebDomainModel):
    config: dict[str, Any] | None = None
    secrets: dict[str, WebSecretUpdate] = Field(default_factory=dict)


class WebConnectionCheckErrorResponse(WebDomainModel):
    code: WebErrorCode
    message: str
    retryable: bool
    provider_id: str | None = None
    retry_after_seconds: int | None = None


class WebConnectionCheckResponse(WebDomainModel):
    provider_id: str
    ok: bool
    duration_ms: int | None = None
    error: WebConnectionCheckErrorResponse | None = None


class WebSecretRevealResponse(WebDomainModel):
    provider_id: str
    field_key: str
    value: str = Field(min_length=1, max_length=4000, repr=False)


def get_web_provider_registry(request: Request) -> WebProviderRegistry:
    registry = getattr(request.app.state, "web_provider_registry", None)
    if isinstance(registry, WebProviderRegistry):
        return registry
    registry = build_default_web_provider_registry()
    request.app.state.web_provider_registry = registry
    return registry


def load_web_settings_response(
    repositories: StorageRepositories,
    registry: WebProviderRegistry,
) -> WebSettingsResponse:
    settings = repositories.web_settings.get_settings()
    providers = tuple(
        _load_provider_settings(repositories, descriptor)
        for descriptor in registry.descriptors()
    )
    return WebSettingsResponse(
        enabled=settings.enabled,
        active_provider_id=settings.active_provider_id,
        active_provider_known=registry.get(settings.active_provider_id) is not None,
        providers=providers,
    )


@router.get("", response_model=WebSettingsResponse)
async def get_web_settings(
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> WebSettingsResponse:
    return load_web_settings_response(repositories, get_web_provider_registry(request))


@router.put("", response_model=WebSettingsResponse)
async def put_web_settings(
    payload: UpdateWebSettingsRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> WebSettingsResponse:
    registry = get_web_provider_registry(request)
    try:
        writes = _validate_settings_update(payload, repositories, registry)
    except WebProviderError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=exc.to_public_dict(),
        ) from exc
    repositories.web_settings.save(
        enabled=payload.enabled,
        active_provider_id=payload.active_provider_id,
        providers=writes,
    )
    return load_web_settings_response(repositories, registry)


@router.post(
    "/providers/{provider_id}/secrets/{field_key}/reveal",
    response_model=WebSecretRevealResponse,
)
async def reveal_web_provider_secret(
    provider_id: str,
    field_key: str,
    request: Request,
    response: Response,
    repositories: StorageRepositories = RepositoriesDep,
) -> WebSecretRevealResponse:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Pragma"] = "no-cache"
    provider = get_web_provider_registry(request).get(provider_id)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=web_error(
                WebErrorCode.PROVIDER_NOT_SELECTED,
                provider_id=provider_id,
                diagnostic={"provider_id": provider_id},
            ).to_public_dict(),
        )

    secret_fields = {
        field.key
        for field in provider.descriptor.config_fields
        if field.field_type == "secret"
    }
    if field_key not in secret_fields:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=web_error(
                WebErrorCode.INVALID_REQUEST,
                message="未找到该密钥字段",
                provider_id=provider_id,
                diagnostic={"field_key": field_key},
            ).to_public_dict(),
        )

    try:
        current = _load_current_provider(repositories, provider_id)
    except WebProviderError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=exc.to_public_dict(),
        ) from exc
    value = current.secrets.get(field_key) if current is not None else None
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=web_error(
                WebErrorCode.PROVIDER_NOT_CONFIGURED,
                message="该密钥尚未保存",
                provider_id=provider_id,
                diagnostic={"field_key": field_key},
            ).to_public_dict(),
        )
    return WebSecretRevealResponse(
        provider_id=provider_id,
        field_key=field_key,
        value=value,
    )


@router.post(
    "/providers/{provider_id}/check",
    response_model=WebConnectionCheckResponse,
)
async def check_web_provider_connection(
    provider_id: str,
    payload: WebConnectionCheckDraft,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> WebConnectionCheckResponse:
    registry = get_web_provider_registry(request)
    provider = registry.get(provider_id)
    if provider is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=web_error(
                WebErrorCode.PROVIDER_NOT_SELECTED,
                diagnostic={"provider_id": provider_id},
            ).to_public_dict(),
        )
    try:
        current = _load_current_provider(repositories, provider_id)
        current_secrets = current.secrets if current is not None else {}
        secrets = apply_secret_updates(
            provider.descriptor.config_fields,
            current=current_secrets,
            updates=payload.secrets,
        )
        values = validate_provider_values(
            provider.descriptor.config_fields,
            config=(
                payload.config
                if payload.config is not None
                else (current.config if current is not None else {})
            ),
            secrets=secrets,
        )
    except WebProviderError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=exc.to_public_dict(),
        ) from exc

    try:
        result = await provider.check_connection(
            WebProviderContext(config=values.config, secrets=values.secrets)
        )
    except WebProviderError as exc:
        return _connection_response(provider_id, error=exc.payload)
    except Exception as exc:
        return _connection_response(
            provider_id,
            error=web_error_from_exception(
                exc,
                provider_id=provider_id,
                sensitive_values=tuple(values.secrets.values()),
            ),
        )
    if result.ok:
        return WebConnectionCheckResponse(
            provider_id=provider_id,
            ok=True,
            duration_ms=result.duration_ms,
        )
    return _connection_response(
        provider_id,
        error=result.error
        or web_error(WebErrorCode.PROVIDER_UNAVAILABLE, provider_id=provider_id),
        duration_ms=result.duration_ms,
    )


def _connection_response(
    provider_id: str,
    *,
    error: WebErrorPayload,
    duration_ms: int | None = None,
) -> WebConnectionCheckResponse:
    return WebConnectionCheckResponse(
        provider_id=provider_id,
        ok=False,
        duration_ms=duration_ms,
        error=WebConnectionCheckErrorResponse(**error.to_public_dict()),
    )


def _validate_settings_update(
    payload: UpdateWebSettingsRequest,
    repositories: StorageRepositories,
    registry: WebProviderRegistry,
) -> dict[str, WebProviderConfigWrite]:
    active_provider = registry.get(payload.active_provider_id)
    unknown = sorted(
        provider_id for provider_id in payload.providers if registry.get(provider_id) is None
    )
    if active_provider is None or unknown:
        raise WebProviderError(
            web_error(
                WebErrorCode.PROVIDER_NOT_SELECTED,
                diagnostic={
                    "active_provider_id": payload.active_provider_id,
                    "unknown_provider_ids": unknown,
                },
            )
        )

    writes: dict[str, WebProviderConfigWrite] = {}
    for provider_id, update in payload.providers.items():
        provider = registry.require(provider_id)
        current = _load_current_provider(repositories, provider_id)
        secrets = apply_secret_updates(
            provider.descriptor.config_fields,
            current=current.secrets if current is not None else {},
            updates=update.secrets,
        )
        values = validate_provider_values(
            provider.descriptor.config_fields,
            config=update.config,
            secrets=secrets,
            require_complete=payload.enabled and provider_id == payload.active_provider_id,
        )
        writes[provider_id] = WebProviderConfigWrite(
            config=values.config,
            secrets=values.secrets,
        )

    if payload.enabled and payload.active_provider_id not in writes:
        current = _load_current_provider(repositories, payload.active_provider_id)
        validate_provider_values(
            active_provider.descriptor.config_fields,
            config=current.config if current is not None else {},
            secrets=current.secrets if current is not None else {},
        )
    return writes


def _load_current_provider(
    repositories: StorageRepositories,
    provider_id: str,
) -> WebProviderConfigRecord | None:
    try:
        return repositories.web_settings.get_provider(provider_id)
    except WebSettingsDataError as exc:
        raise WebProviderError(
            web_error(
                WebErrorCode.INVALID_REQUEST,
                provider_id=provider_id,
                diagnostic={"stored_config": "invalid", "field": exc.field},
            )
        ) from exc


def _load_provider_settings(
    repositories: StorageRepositories,
    descriptor: WebProviderDescriptor,
) -> WebProviderSettingsResponse:
    try:
        stored = repositories.web_settings.get_provider(descriptor.provider_id)
    except WebSettingsDataError:
        return _provider_response(
            descriptor,
            config={},
            secrets={},
            configured=False,
            config_status="invalid",
        )

    config = stored.config if stored is not None else {}
    secrets = stored.secrets if stored is not None else {}
    try:
        values = validate_provider_values(
            descriptor.config_fields,
            config=config,
            secrets=secrets,
        )
    except WebProviderError:
        return _provider_response(
            descriptor,
            config=_public_config(descriptor, config),
            secrets=secrets,
            configured=False,
            config_status="incomplete",
        )
    return _provider_response(
        descriptor,
        config=values.config,
        secrets=values.secrets,
        configured=True,
        config_status="ready",
    )


def _provider_response(
    descriptor: WebProviderDescriptor,
    *,
    config: dict[str, object],
    secrets: dict[str, object],
    configured: bool,
    config_status: Literal["ready", "incomplete", "invalid"],
) -> WebProviderSettingsResponse:
    string_secrets = {
        key: value for key, value in secrets.items() if isinstance(value, str) and value
    }
    return WebProviderSettingsResponse(
        provider_id=descriptor.provider_id,
        display_name=descriptor.display_name,
        description=descriptor.description,
        capabilities=tuple(sorted(descriptor.capabilities, key=str)),
        config_fields=descriptor.config_fields,
        credential_setup=descriptor.credential_setup,
        config={
            key: value
            for key, value in config.items()
            if isinstance(value, (str, bool))
        },
        secrets=describe_secret_states(descriptor.config_fields, string_secrets),
        configured=configured,
        config_status=config_status,
    )


def _public_config(
    descriptor: WebProviderDescriptor,
    config: dict[str, object],
) -> dict[str, object]:
    ordinary_keys = {
        field.key for field in descriptor.config_fields if field.field_type != "secret"
    }
    return {key: value for key, value in config.items() if key in ordinary_keys}
