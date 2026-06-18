from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel

from backend.app.api.dependencies import get_repositories
from backend.app.api.settings import load_effective_model_settings, merge_model_settings
from backend.app.model import (
    ModelConfigError,
    ModelInfo,
    ModelProviderError,
    ModelSettings,
    OpenAICompatibleProviderClient,
)
from backend.app.storage import StorageRepositories

router = APIRouter(prefix="/api/models", tags=["models"])
RepositoriesDep = Depends(get_repositories)
MODEL_LIST_CACHE_KEY = "model_list_cache"


class ModelsResponse(BaseModel):
    models: list[ModelInfo]
    cached: bool = False


class RefreshModelsRequest(BaseModel):
    model: ModelSettings | None = None


def _client_for_request(
    request: Request,
    repositories: StorageRepositories,
    payload: RefreshModelsRequest | None = None,
) -> OpenAICompatibleProviderClient:
    settings = load_effective_model_settings(repositories)
    if payload is not None and payload.model is not None:
        settings = merge_model_settings(settings, payload.model)
    return OpenAICompatibleProviderClient(
        settings,
        transport=getattr(request.app.state, "model_http_transport", None),
    )


@router.get("", response_model=ModelsResponse)
async def get_models(
    repositories: StorageRepositories = RepositoriesDep,
) -> ModelsResponse:
    provider_models = _models_from_providers(repositories)
    if provider_models:
        return ModelsResponse(models=provider_models, cached=True)
    cached = repositories.settings.get(MODEL_LIST_CACHE_KEY, default=[])
    if cached:
        return ModelsResponse(models=[ModelInfo(**item) for item in cached], cached=True)
    return ModelsResponse(models=[], cached=False)


@router.post("/refresh", response_model=ModelsResponse)
async def refresh_models(
    request: Request,
    payload: RefreshModelsRequest | None = None,
    repositories: StorageRepositories = RepositoriesDep,
) -> ModelsResponse:
    provider_client = _client_for_request(request, repositories, payload)
    try:
        models = await provider_client.list_models(force_refresh=True)
    except ModelConfigError as exc:
        raise _api_error(
            status.HTTP_400_BAD_REQUEST,
            "model_config_invalid",
            str(exc),
        ) from exc
    except ModelProviderError as exc:
        raise _api_error(
            status.HTTP_502_BAD_GATEWAY,
            "model_refresh_failed",
            str(exc),
        ) from exc
    repositories.settings.set(
        MODEL_LIST_CACHE_KEY,
        [model.model_dump(mode="json") for model in models],
    )
    return ModelsResponse(models=models, cached=False)


def _api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message, "details": {}},
    )


def _models_from_providers(repositories: StorageRepositories) -> list[ModelInfo]:
    seen: set[str] = set()
    models: list[ModelInfo] = []
    for provider in repositories.model_providers.list():
        if not provider.enabled:
            continue
        for model in provider.models:
            model_id = model.strip()
            if not model_id or model_id in seen or provider.model_enabled.get(model_id) is False:
                continue
            seen.add(model_id)
            models.append(ModelInfo(id=model_id, raw={"id": model_id, "provider_id": provider.id}))
    return models
