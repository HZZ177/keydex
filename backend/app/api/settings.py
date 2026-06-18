from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from backend.app.api.dependencies import get_repositories
from backend.app.model import ModelSettings
from backend.app.storage import ModelProviderRecord, StorageRepositories

router = APIRouter(prefix="/api/settings", tags=["settings"])
RepositoriesDep = Depends(get_repositories)

MODEL_SETTINGS_KEY = "model_settings"


class SettingsResponse(BaseModel):
    model: dict[str, Any]


class UpdateSettingsRequest(BaseModel):
    model: ModelSettings | None = None


def merge_model_settings(
    current: ModelSettings,
    update: ModelSettings,
    *,
    keep_existing_api_key: bool = True,
) -> ModelSettings:
    values = update.model_dump(mode="json")
    if keep_existing_api_key and update.api_key is None:
        values["api_key"] = current.api_key
    return ModelSettings(**values)


def load_model_settings(repositories: StorageRepositories) -> ModelSettings:
    return ModelSettings(**repositories.settings.get(MODEL_SETTINGS_KEY, default={}))


def load_effective_model_settings(repositories: StorageRepositories) -> ModelSettings:
    default = repositories.model_providers.get_default()
    if default is not None:
        provider = repositories.model_providers.get(default.provider_id)
        if provider is not None:
            return ModelSettings(
                base_url=provider.base_url,
                api_key=provider.api_key,
                model=default.model,
            )
    return load_model_settings(repositories)


def save_provider_model_settings(
    repositories: StorageRepositories,
    provider: ModelProviderRecord,
    model: str,
) -> None:
    settings = ModelSettings(
        base_url=provider.base_url,
        api_key=provider.api_key,
        model=model,
    )
    repositories.settings.set(MODEL_SETTINGS_KEY, settings.model_dump(mode="json"))


@router.get("", response_model=SettingsResponse)
async def get_settings(
    repositories: StorageRepositories = RepositoriesDep,
) -> SettingsResponse:
    return SettingsResponse(model=load_effective_model_settings(repositories).public_dict())


@router.put("", response_model=SettingsResponse)
async def put_settings(
    request: UpdateSettingsRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> SettingsResponse:
    if request.model is not None:
        current = load_model_settings(repositories)
        merged = merge_model_settings(current, request.model)
        repositories.settings.set(MODEL_SETTINGS_KEY, merged.model_dump(mode="json"))
    return SettingsResponse(model=load_model_settings(repositories).public_dict())
