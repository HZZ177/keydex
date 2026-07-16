from __future__ import annotations

import time
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from backend.app.api.dependencies import get_repositories
from backend.app.api.settings import MODEL_SETTINGS_KEY
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
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
    created_at: str
    updated_at: str


class ModelProvidersResponse(BaseModel):
    providers: list[PublicModelProvider]


class UpsertProviderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1)
    base_url: str = Field(min_length=1)
    api_key: str | None = Field(default=None, repr=False)
    enabled: bool = True
    models: list[str] = Field(default_factory=list)
    model_enabled: dict[str, bool] = Field(default_factory=dict)


class PatchProviderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    base_url: str | None = None
    api_key: str | None = Field(default=None, repr=False)
    enabled: bool | None = None
    models: list[str] | None = None
    model_enabled: dict[str, bool] | None = None


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
    providers = _list_public_providers(repositories)
    logger.debug(f"[ModelProviderAPI] 列出供应商 | count={len(providers)}")
    return ModelProvidersResponse(providers=providers)


@router.post("", response_model=PublicModelProvider, status_code=status.HTTP_201_CREATED)
async def create_provider(
    request: UpsertProviderRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> PublicModelProvider:
    now = to_iso_z(utc_now())
    provider = ModelProviderRecord(
        id=new_id(),
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
    logger.info(
        "[ModelProviderAPI] 创建供应商 | "
        f"provider_id={provider.id} | name={provider.name} | "
        f"base_url={provider.base_url} | enabled={provider.enabled} | "
        f"models={len(provider.models)}"
    )
    return _public_provider(provider)


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
    logger.info(
        "[ModelProviderAPI] 更新供应商 | "
        f"provider_id={updated.id} | name={updated.name} | "
        f"base_url={updated.base_url} | enabled={updated.enabled} | "
        f"models={len(updated.models)}"
    )
    return _public_provider(updated)


@router.delete("/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_provider(
    provider_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> Response:
    if not repositories.model_providers.delete(provider_id):
        raise _api_error(status.HTTP_404_NOT_FOUND, "provider_not_found", "供应商不存在")
    logger.info(f"[ModelProviderAPI] 删除供应商 | provider_id={provider_id}")
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{provider_id}/refresh", response_model=RefreshProviderResponse)
async def refresh_provider_models(
    provider_id: str,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> RefreshProviderResponse:
    provider = _require_provider(repositories, provider_id)
    started_at = time.perf_counter()
    logger.info(
        "[ModelProviderAPI] 开始刷新供应商模型 | "
        f"provider_id={provider.id} | base_url={provider.base_url}"
    )
    provider_client = OpenAICompatibleProviderClient(
        ModelSettings(base_url=provider.base_url, api_key=provider.api_key, model=""),
        transport=getattr(request.app.state, "model_http_transport", None),
    )
    try:
        models = await provider_client.list_models(force_refresh=True)
    except ModelProviderError as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        logger.warning(
            "[ModelProviderAPI] 刷新供应商模型失败 | "
            f"provider_id={provider.id} | duration_ms={duration_ms} | error={exc}"
        )
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
    duration_ms = int((time.perf_counter() - started_at) * 1000)
    logger.info(
        "[ModelProviderAPI] 刷新供应商模型成功 | "
        f"provider_id={provider.id} | models={len(model_ids)} | duration_ms={duration_ms}"
    )
    return RefreshProviderResponse(
        provider=_public_provider(updated),
        models=model_ids,
    )


@router.post("/{provider_id}/models/{model:path}/health", response_model=HealthResponse)
async def check_model_health(
    provider_id: str,
    model: str,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> HealthResponse:
    provider = _require_provider(repositories, provider_id)
    started = time.perf_counter()
    logger.info(f"[ModelProviderAPI] 开始模型健康检查 | provider_id={provider.id} | model={model}")
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
    logger.info(
        "[ModelProviderAPI] 模型健康检查完成 | "
        f"provider_id={provider.id} | model={model} | "
        f"status={health.get('status')} | latency_ms={health.get('latency_ms')}"
    )
    return HealthResponse(
        provider=_public_provider(provider),
        health=health,
    )


def _list_public_providers(repositories: StorageRepositories) -> list[PublicModelProvider]:
    providers = repositories.model_providers.list()
    if not providers:
        legacy = legacy_model_provider_from_settings(
            repositories.settings.get(MODEL_SETTINGS_KEY, default={})
        )
        providers = [legacy] if legacy is not None else []
    return [_public_provider(provider) for provider in providers]


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


def _public_provider(provider: ModelProviderRecord) -> PublicModelProvider:
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


def _api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message, "details": {}},
    )
