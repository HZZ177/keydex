from __future__ import annotations

import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from backend.app.api.dependencies import get_repositories
from backend.app.api.settings import MODEL_SETTINGS_KEY, save_provider_model_settings
from backend.app.core.ids import new_id
from backend.app.core.time import to_iso_z, utc_now
from backend.app.model import (
    ModelProviderError,
    ModelSettings,
    OpenAICompatibleProviderClient,
)
from backend.app.storage import (
    ModelProviderRecord,
    StorageRepositories,
    legacy_model_provider_from_settings,
)

router = APIRouter(prefix="/api/model-providers", tags=["model-providers"])
RepositoriesDep = Depends(get_repositories)


class PublicModelProvider(BaseModel):
    id: str
    name: str
    base_url: str
    api_key_set: bool
    api_key_preview: str | None = None
    enabled: bool
    models: list[str]
    model_enabled: dict[str, bool]
    health: dict[str, Any]
    default_model: str | None = None
    created_at: str
    updated_at: str


class ModelProvidersResponse(BaseModel):
    providers: list[PublicModelProvider]


class UpsertProviderRequest(BaseModel):
    name: str = Field(min_length=1)
    base_url: str = Field(min_length=1)
    api_key: str | None = Field(default=None, repr=False)
    enabled: bool = True
    models: list[str] = Field(default_factory=list)
    model_enabled: dict[str, bool] = Field(default_factory=dict)
    default_model: str | None = None


class PatchProviderRequest(BaseModel):
    name: str | None = None
    base_url: str | None = None
    api_key: str | None = Field(default=None, repr=False)
    enabled: bool | None = None
    models: list[str] | None = None
    model_enabled: dict[str, bool] | None = None
    default_model: str | None = None


class SetDefaultRequest(BaseModel):
    provider_id: str
    model: str
    scope: str = "global"


class RefreshProviderResponse(BaseModel):
    provider: PublicModelProvider
    models: list[str]


class HealthResponse(BaseModel):
    provider: PublicModelProvider
    health: dict[str, Any]


@router.get("", response_model=ModelProvidersResponse)
async def list_providers(
    repositories: StorageRepositories = RepositoriesDep,
) -> ModelProvidersResponse:
    return ModelProvidersResponse(providers=_list_public_providers(repositories))


@router.post("", response_model=PublicModelProvider, status_code=status.HTTP_201_CREATED)
async def create_provider(
    request: UpsertProviderRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> PublicModelProvider:
    now = to_iso_z(utc_now())
    provider = ModelProviderRecord(
        id=new_id("provider"),
        name=request.name.strip(),
        base_url=_normalize_base_url(request.base_url),
        api_key=request.api_key,
        enabled=request.enabled,
        models=_clean_models(request.models),
        model_enabled=request.model_enabled,
        health={},
        created_at=now,
        updated_at=now,
    )
    repositories.model_providers.upsert(provider)
    if request.default_model:
        repositories.model_providers.set_default(
            scope="global",
            provider_id=provider.id,
            model=request.default_model,
        )
        save_provider_model_settings(repositories, provider, request.default_model)
    return _public_provider(provider, repositories.model_providers.get_default())


@router.patch("/{provider_id}", response_model=PublicModelProvider)
async def update_provider(
    provider_id: str,
    request: PatchProviderRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> PublicModelProvider:
    current = repositories.model_providers.get(provider_id)
    if current is None:
        raise _api_error(status.HTTP_404_NOT_FOUND, "provider_not_found", "供应商不存在")
    updated = ModelProviderRecord(
        id=current.id,
        name=(request.name.strip() if request.name is not None else current.name),
        base_url=(
            _normalize_base_url(request.base_url)
            if request.base_url is not None
            else current.base_url
        ),
        api_key=current.api_key if request.api_key is None else request.api_key,
        enabled=current.enabled if request.enabled is None else request.enabled,
        models=_clean_models(request.models) if request.models is not None else current.models,
        model_enabled=(
            request.model_enabled if request.model_enabled is not None else current.model_enabled
        ),
        health=current.health,
        created_at=current.created_at,
        updated_at=to_iso_z(utc_now()),
    )
    repositories.model_providers.upsert(updated)
    current_default = repositories.model_providers.get_default()
    if request.default_model:
        repositories.model_providers.set_default(
            scope="global",
            provider_id=updated.id,
            model=request.default_model,
        )
        save_provider_model_settings(repositories, updated, request.default_model)
    elif current_default is not None and current_default.provider_id == updated.id:
        save_provider_model_settings(repositories, updated, current_default.model)
    return _public_provider(updated, repositories.model_providers.get_default())


@router.delete("/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_provider(
    provider_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> Response:
    if not repositories.model_providers.delete(provider_id):
        raise _api_error(status.HTTP_404_NOT_FOUND, "provider_not_found", "供应商不存在")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/default", response_model=ModelProvidersResponse)
async def set_default_provider(
    request: SetDefaultRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> ModelProvidersResponse:
    provider = repositories.model_providers.get(request.provider_id)
    if provider is None:
        raise _api_error(status.HTTP_404_NOT_FOUND, "provider_not_found", "供应商不存在")
    if request.model not in provider.models:
        raise _api_error(status.HTTP_400_BAD_REQUEST, "model_not_found", "默认模型必须来自模型列表")
    if provider.model_enabled.get(request.model) is False:
        raise _api_error(status.HTTP_400_BAD_REQUEST, "model_disabled", "默认模型必须已启用")
    repositories.model_providers.set_default(
        scope=request.scope,
        provider_id=request.provider_id,
        model=request.model,
    )
    if request.scope == "global":
        save_provider_model_settings(repositories, provider, request.model)
    return ModelProvidersResponse(providers=_list_public_providers(repositories))


@router.post("/{provider_id}/refresh", response_model=RefreshProviderResponse)
async def refresh_provider_models(
    provider_id: str,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> RefreshProviderResponse:
    provider = _require_provider(repositories, provider_id)
    provider_client = OpenAICompatibleProviderClient(
        ModelSettings(base_url=provider.base_url, api_key=provider.api_key, model=""),
        transport=getattr(request.app.state, "model_http_transport", None),
    )
    try:
        models = await provider_client.list_models(force_refresh=True)
    except ModelProviderError as exc:
        raise _api_error(status.HTTP_502_BAD_GATEWAY, "provider_refresh_failed", str(exc)) from exc

    model_ids = _clean_models([model.id for model in models])
    enabled = {model_id: provider.model_enabled.get(model_id, True) for model_id in model_ids}
    updated = ModelProviderRecord(
        **{
            **provider.__dict__,
            "models": model_ids,
            "model_enabled": enabled,
            "updated_at": to_iso_z(utc_now()),
        }
    )
    repositories.model_providers.upsert(updated)
    selected_default_model = _select_default_model_after_refresh(
        provider_id=provider.id,
        model_ids=model_ids,
        current_default=repositories.model_providers.get_default(),
    )
    if selected_default_model:
        repositories.model_providers.set_default(
            scope="global",
            provider_id=provider.id,
            model=selected_default_model,
        )
        save_provider_model_settings(repositories, updated, selected_default_model)
    return RefreshProviderResponse(
        provider=_public_provider(updated, repositories.model_providers.get_default()),
        models=model_ids,
    )


@router.post("/{provider_id}/models/{model}/health", response_model=HealthResponse)
async def check_model_health(
    provider_id: str,
    model: str,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> HealthResponse:
    provider = _require_provider(repositories, provider_id)
    started = time.perf_counter()
    health: dict[str, Any]
    try:
        await _call_health(
            provider,
            model,
            getattr(request.app.state, "model_http_transport", None),
        )
        health = {
            "status": "healthy",
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "error": None,
            "checked_at": to_iso_z(utc_now()),
        }
    except ModelProviderError as exc:
        health = {
            "status": "unhealthy",
            "latency_ms": int((time.perf_counter() - started) * 1000),
            "error": str(exc),
            "checked_at": to_iso_z(utc_now()),
        }
    updated = ModelProviderRecord(
        **{
            **provider.__dict__,
            "health": {**provider.health, model: health},
            "updated_at": to_iso_z(utc_now()),
        }
    )
    repositories.model_providers.upsert(updated)
    return HealthResponse(
        provider=_public_provider(updated, repositories.model_providers.get_default()),
        health=health,
    )


def _list_public_providers(repositories: StorageRepositories) -> list[PublicModelProvider]:
    providers = repositories.model_providers.list()
    if not providers:
        legacy = legacy_model_provider_from_settings(
            repositories.settings.get(MODEL_SETTINGS_KEY, default={})
        )
        providers = [legacy] if legacy is not None else []
    default = repositories.model_providers.get_default()
    return [_public_provider(provider, default) for provider in providers]


def _require_provider(
    repositories: StorageRepositories,
    provider_id: str,
) -> ModelProviderRecord:
    provider = repositories.model_providers.get(provider_id)
    if provider is None:
        raise _api_error(status.HTTP_404_NOT_FOUND, "provider_not_found", "供应商不存在")
    return provider


async def _call_health(
    provider: ModelProviderRecord,
    model: str,
    transport: httpx.AsyncBaseTransport | None,
) -> None:
    provider_client = OpenAICompatibleProviderClient(
        ModelSettings(base_url=provider.base_url, api_key=provider.api_key, model=model),
        transport=transport,
    )
    await provider_client.check_chat_completion(model=model)


def _public_provider(
    provider: ModelProviderRecord,
    default: Any,
) -> PublicModelProvider:
    default_model = default.model if default and default.provider_id == provider.id else None
    if default_model is None and provider.id == "legacy-openai-compatible" and provider.models:
        default_model = provider.models[0]
    return PublicModelProvider(
        id=provider.id,
        name=provider.name,
        base_url=provider.base_url,
        api_key_set=bool(provider.api_key),
        api_key_preview=_api_key_preview(provider.api_key),
        enabled=provider.enabled,
        models=provider.models,
        model_enabled=provider.model_enabled,
        health=provider.health,
        default_model=default_model,
        created_at=provider.created_at,
        updated_at=provider.updated_at,
    )


def _api_key_preview(api_key: str | None) -> str | None:
    if not api_key:
        return None
    return f"{api_key[:4]}...{api_key[-4:]}" if len(api_key) > 8 else "***"


def _normalize_base_url(value: str) -> str:
    return value.strip().rstrip("/")


def _clean_models(models: list[str]) -> list[str]:
    seen: set[str] = set()
    cleaned: list[str] = []
    for model in models:
        item = model.strip()
        if item and item not in seen:
            seen.add(item)
            cleaned.append(item)
    return cleaned


def _select_default_model_after_refresh(
    *,
    provider_id: str,
    model_ids: list[str],
    current_default: Any,
) -> str | None:
    if not model_ids:
        return None
    if current_default is None or current_default.provider_id != provider_id:
        return model_ids[0]
    if current_default.model not in model_ids:
        return model_ids[0]
    return current_default.model


def _api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message, "details": {}},
    )
