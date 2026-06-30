from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, ValidationError, field_validator

from backend.app.agent.runtime_settings import (
    AgentRuntimeSettings,
    load_agent_runtime_settings,
    save_agent_runtime_settings,
)
from backend.app.api.dependencies import get_app_settings, get_repositories
from backend.app.command_approval import (
    CommandSettings,
    audit_to_payload,
    load_command_settings,
    rule_to_payload,
    save_command_settings,
)
from backend.app.core.config import AppSettings
from backend.app.core.logger import logger
from backend.app.model import ModelSettings
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    MODEL_DEFAULT_FAST,
    MODEL_DEFAULT_SCOPES,
    ModelDefaultRecord,
    StorageRepositories,
)

router = APIRouter(prefix="/api/settings", tags=["settings"])
RepositoriesDep = Depends(get_repositories)
AppSettingsDep = Depends(get_app_settings)

MODEL_SETTINGS_KEY = "model_settings"
APPEARANCE_SETTINGS_KEY = "appearance_settings"
GENERAL_SETTINGS_KEY = "general_settings"


class AppearanceSettings(BaseModel):
    font_family: Literal["system", "maple-mono", "jetbrains-mono"] = "system"


class GeneralSettings(BaseModel):
    close_window_behavior: Literal["exit", "minimize_to_tray"] | None = None


class SettingsResponse(BaseModel):
    model: dict[str, Any]
    general: GeneralSettings
    appearance: AppearanceSettings
    command: CommandSettings


class PublicModelDefault(BaseModel):
    scope: Literal["default_chat", "fast"]
    configured: bool
    provider_id: str | None = None
    provider_name: str | None = None
    model: str | None = None
    provider_enabled: bool | None = None
    model_enabled: bool | None = None
    missing_reason: str | None = None


class ModelDefaultsResponse(BaseModel):
    defaults: dict[str, PublicModelDefault]


class ModelDefaultSelection(BaseModel):
    provider_id: str = Field(min_length=1)
    model: str = Field(min_length=1)

    @field_validator("provider_id", "model")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("value must not be empty")
        return cleaned


class UpdateModelDefaultsRequest(BaseModel):
    defaults: dict[Literal["default_chat", "fast"], ModelDefaultSelection | None]


class UpdateSettingsRequest(BaseModel):
    model: ModelSettings | None = None
    general: GeneralSettings | None = None
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


def load_general_settings(repositories: StorageRepositories) -> GeneralSettings:
    settings = repositories.settings.get(GENERAL_SETTINGS_KEY, default={})
    return GeneralSettings(**settings)


def load_effective_model_settings(repositories: StorageRepositories) -> ModelSettings:
    return load_model_settings(repositories)


def load_model_defaults(repositories: StorageRepositories) -> ModelDefaultsResponse:
    return ModelDefaultsResponse(
        defaults={
            scope: _public_model_default(
                scope=scope,
                default=repositories.model_providers.get_model_default(scope),
                repositories=repositories,
            )
            for scope in sorted(MODEL_DEFAULT_SCOPES)
        }
    )


def _validate_model_default_selection(
    repositories: StorageRepositories,
    *,
    scope: str,
    selection: ModelDefaultSelection,
) -> None:
    provider = repositories.model_providers.get(selection.provider_id)
    if provider is None:
        raise _model_default_error(
            "model_default_provider_not_found",
            f"{_default_scope_label(scope)}供应商不存在",
            scope=scope,
            provider_id=selection.provider_id,
        )
    if not provider.enabled:
        raise _model_default_error(
            "model_default_provider_disabled",
            f"{_default_scope_label(scope)}供应商已停用",
            scope=scope,
            provider_id=selection.provider_id,
        )
    if selection.model not in provider.models:
        raise _model_default_error(
            "model_default_model_not_found",
            f"{_default_scope_label(scope)}必须来自供应商模型列表",
            scope=scope,
            provider_id=selection.provider_id,
            model=selection.model,
        )
    if provider.model_enabled.get(selection.model) is False:
        raise _model_default_error(
            "model_default_model_disabled",
            f"{_default_scope_label(scope)}模型已停用",
            scope=scope,
            provider_id=selection.provider_id,
            model=selection.model,
        )


def _public_model_default(
    *,
    scope: str,
    default: ModelDefaultRecord | None,
    repositories: StorageRepositories,
) -> PublicModelDefault:
    if default is None:
        return PublicModelDefault(
            scope=_typed_model_default_scope(scope),
            configured=False,
            missing_reason="not_configured",
        )
    provider = repositories.model_providers.get(default.provider_id)
    if provider is None:
        return PublicModelDefault(
            scope=_typed_model_default_scope(scope),
            configured=False,
            provider_id=default.provider_id,
            model=default.model,
            missing_reason="provider_not_found",
        )
    model_enabled = (
        default.model in provider.models and provider.model_enabled.get(default.model) is not False
    )
    configured = provider.enabled and model_enabled
    return PublicModelDefault(
        scope=_typed_model_default_scope(scope),
        configured=configured,
        provider_id=provider.id,
        provider_name=provider.name,
        model=default.model,
        provider_enabled=provider.enabled,
        model_enabled=model_enabled,
        missing_reason=None if configured else "provider_or_model_disabled",
    )


def _typed_model_default_scope(scope: str) -> Literal["default_chat", "fast"]:
    if scope == MODEL_DEFAULT_CHAT:
        return "default_chat"
    if scope == MODEL_DEFAULT_FAST:
        return "fast"
    raise ValueError(f"unknown model default scope: {scope}")


def _default_scope_label(scope: str) -> str:
    if scope == MODEL_DEFAULT_CHAT:
        return "默认对话模型"
    if scope == MODEL_DEFAULT_FAST:
        return "快速模型"
    return "模型默认值"


def _model_default_error(
    code: str,
    message: str,
    **details: Any,
) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": code, "message": message, "details": details},
    )


@router.get("", response_model=SettingsResponse)
async def get_settings(
    repositories: StorageRepositories = RepositoriesDep,
) -> SettingsResponse:
    settings = load_effective_model_settings(repositories).public_dict()
    logger.debug(
        "[SettingsAPI] 读取模型设置 | "
        f"base_url={settings.get('base_url', '')} | model={settings.get('model', '')}"
    )
    general = load_general_settings(repositories)
    appearance = load_appearance_settings(repositories)
    command = load_command_settings(repositories)
    return SettingsResponse(model=settings, general=general, appearance=appearance, command=command)


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
        logger.info(f"[SettingsAPI] 更新外观设置 | font_family={request.appearance.font_family}")
    if request.general is not None:
        repositories.settings.set(
            GENERAL_SETTINGS_KEY,
            request.general.model_dump(mode="json"),
        )
        logger.info(
            "[SettingsAPI] 更新常规设置 | "
            f"close_window_behavior={request.general.close_window_behavior}"
        )
    if request.command is not None:
        save_command_settings(repositories, request.command)
        logger.info(
            "[SettingsAPI] 更新命令配置 | "
            f"command_enabled={request.command.command_enabled} | "
            f"allow_persistent_trust={request.command.allow_persistent_trust}"
        )
    settings = load_model_settings(repositories).public_dict()
    general = load_general_settings(repositories)
    appearance = load_appearance_settings(repositories)
    command = load_command_settings(repositories)
    return SettingsResponse(model=settings, general=general, appearance=appearance, command=command)


@router.get("/model-defaults", response_model=ModelDefaultsResponse)
async def get_model_defaults(
    repositories: StorageRepositories = RepositoriesDep,
) -> ModelDefaultsResponse:
    return load_model_defaults(repositories)


@router.put("/model-defaults", response_model=ModelDefaultsResponse)
async def put_model_defaults(
    request: UpdateModelDefaultsRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> ModelDefaultsResponse:
    for scope, selection in request.defaults.items():
        if selection is None:
            repositories.model_providers.delete_model_default(scope)
            logger.info(f"[SettingsAPI] 清除模型默认值 | scope={scope}")
            continue
        _validate_model_default_selection(repositories, scope=scope, selection=selection)
        repositories.model_providers.set_model_default(
            scope=scope,
            provider_id=selection.provider_id,
            model=selection.model,
        )
        logger.info(
            "[SettingsAPI] 更新模型默认值 | "
            f"scope={scope} | provider_id={selection.provider_id} | model={selection.model}"
        )
    return load_model_defaults(repositories)


@router.get("/extensions", response_model=AgentRuntimeSettings)
async def get_extension_settings(
    repositories: StorageRepositories = RepositoriesDep,
    app_settings: AppSettings = AppSettingsDep,
) -> AgentRuntimeSettings:
    try:
        return load_agent_runtime_settings(
            repositories,
            default_max_tool_calls=app_settings.max_tool_calls,
        )
    except ValidationError as exc:
        raise _agent_runtime_settings_invalid(exc) from exc


@router.put("/extensions", response_model=AgentRuntimeSettings)
async def put_extension_settings(
    request: AgentRuntimeSettings,
    repositories: StorageRepositories = RepositoriesDep,
) -> AgentRuntimeSettings:
    saved = save_agent_runtime_settings(repositories, request)
    logger.info(
        "[SettingsAPI] 更新扩展功能配置 | "
        f"auto_title={saved.auto_title.enabled} | "
        f"tool_call_limit={saved.tool_call_limit.enabled}:{saved.tool_call_limit.max_tool_calls} | "
        f"duplicate_tool_call_guard="
        f"{saved.duplicate_tool_call_guard.enabled}:"
        f"{saved.duplicate_tool_call_guard.max_repeats} | "
        f"context_compression={saved.context_compression.enabled}"
    )
    return saved


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


def _agent_runtime_settings_invalid(exc: ValidationError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail={
            "code": "agent_runtime_settings_invalid",
            "message": "扩展功能配置已损坏",
            "details": {"errors": _compact_validation_errors(exc)},
        },
    )


def _compact_validation_errors(exc: ValidationError) -> list[dict[str, Any]]:
    return [
        {
            "loc": list(error.get("loc", ())),
            "msg": str(error.get("msg", "")),
            "type": str(error.get("type", "")),
        }
        for error in exc.errors()
    ]
