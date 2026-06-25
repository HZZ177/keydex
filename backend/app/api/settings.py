from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from backend.app.api.dependencies import get_repositories
from backend.app.command_approval import (
    CommandSettings,
    audit_to_payload,
    load_command_settings,
    rule_to_payload,
    save_command_settings,
)
from backend.app.core.logger import logger
from backend.app.model import ModelSettings
from backend.app.storage import ModelProviderRecord, StorageRepositories

router = APIRouter(prefix="/api/settings", tags=["settings"])
RepositoriesDep = Depends(get_repositories)

MODEL_SETTINGS_KEY = "model_settings"
APPEARANCE_SETTINGS_KEY = "appearance_settings"


class AppearanceSettings(BaseModel):
    font_family: Literal["system", "maple-mono"] = "system"


class SettingsResponse(BaseModel):
    model: dict[str, Any]
    appearance: AppearanceSettings
    command: CommandSettings


class UpdateSettingsRequest(BaseModel):
    model: ModelSettings | None = None
    appearance: AppearanceSettings | None = None
    command: CommandSettings | None = None


class TrustedRuleListResponse(BaseModel):
    list: list[dict[str, Any]]


class UpdateTrustedRuleRequest(BaseModel):
    enabled: bool


class ApprovalHistoryResponse(BaseModel):
    list: list[dict[str, Any]]
    total: int
    page: int
    page_size: int


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


def load_appearance_settings(repositories: StorageRepositories) -> AppearanceSettings:
    settings = repositories.settings.get(APPEARANCE_SETTINGS_KEY, default={})
    if isinstance(settings, dict) and settings.get("font_family") in {"segoe-ui", "misans"}:
        settings = {**settings, "font_family": "system"}
    return AppearanceSettings(**settings)


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
    settings = load_effective_model_settings(repositories).public_dict()
    logger.debug(
        "[SettingsAPI] 读取模型设置 | "
        f"base_url={settings.get('base_url', '')} | model={settings.get('model', '')}"
    )
    appearance = load_appearance_settings(repositories)
    command = load_command_settings(repositories)
    return SettingsResponse(model=settings, appearance=appearance, command=command)


@router.put("", response_model=SettingsResponse)
async def put_settings(
    request: UpdateSettingsRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> SettingsResponse:
    if request.model is not None:
        current = load_model_settings(repositories)
        merged = merge_model_settings(current, request.model)
        repositories.settings.set(MODEL_SETTINGS_KEY, merged.model_dump(mode="json"))
        logger.info(
            "[SettingsAPI] 更新模型设置 | "
            f"base_url={merged.base_url} | model={merged.model} | "
            f"api_key_set={bool(merged.api_key)}"
        )
    if request.appearance is not None:
        repositories.settings.set(
            APPEARANCE_SETTINGS_KEY,
            request.appearance.model_dump(mode="json"),
        )
        logger.info(
            "[SettingsAPI] 更新外观设置 | "
            f"font_family={request.appearance.font_family}"
        )
    if request.command is not None:
        save_command_settings(repositories, request.command)
        logger.info(
            "[SettingsAPI] 更新命令配置 | "
            f"command_enabled={request.command.command_enabled} | "
            f"allow_persistent_trust={request.command.allow_persistent_trust}"
        )
    settings = load_model_settings(repositories).public_dict()
    appearance = load_appearance_settings(repositories)
    command = load_command_settings(repositories)
    return SettingsResponse(model=settings, appearance=appearance, command=command)


@router.get("/command/trusted-rules", response_model=TrustedRuleListResponse)
async def list_trusted_command_rules(
    repositories: StorageRepositories = RepositoriesDep,
) -> TrustedRuleListResponse:
    return TrustedRuleListResponse(
        list=[rule_to_payload(rule) for rule in repositories.trusted_command_rules.list()]
    )


@router.patch("/command/trusted-rules/{rule_id}", response_model=dict[str, Any])
async def update_trusted_command_rule(
    rule_id: str,
    request: UpdateTrustedRuleRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    rule = repositories.trusted_command_rules.set_enabled(rule_id, request.enabled)
    if rule is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "trusted_rule_not_found", "message": "已信任命令不存在", "details": {}},
        )
    return rule_to_payload(rule)


@router.delete("/command/trusted-rules/{rule_id}", response_model=dict[str, Any])
async def delete_trusted_command_rule(
    rule_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    deleted = repositories.trusted_command_rules.delete(rule_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "trusted_rule_not_found", "message": "已信任命令不存在", "details": {}},
        )
    return {"deleted": True}


@router.get("/command/approval-history", response_model=ApprovalHistoryResponse)
async def list_command_approval_history(
    session_id: str | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    repositories: StorageRepositories = RepositoriesDep,
) -> ApprovalHistoryResponse:
    offset = (page - 1) * page_size
    records, total = repositories.command_approval_audit.list(
        session_id=session_id,
        limit=page_size,
        offset=offset,
    )
    return ApprovalHistoryResponse(
        list=[audit_to_payload(record) for record in records],
        total=total,
        page=page,
        page_size=page_size,
    )
