from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from backend.app.storage import StorageRepositories

AGENT_RUNTIME_SETTINGS_KEY = "agent_runtime_settings"
REMOVED_RUNTIME_SETTINGS_KEYS = {"tool_call_limit"}


class AutoTitleRuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: bool = False
    only_when_default_title: bool = True
    max_title_length: int = Field(default=20, ge=4, le=50)


class DuplicateToolCallGuardRuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: bool = True
    max_repeats: int = Field(default=3, ge=1, le=20)


class ContextCompressionRuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: bool = True
    context_window_tokens: int = Field(default=256000, ge=1000, le=2_000_000)
    trigger_fraction: float = Field(default=0.8, gt=0.0, lt=1.0)


class A2UIRuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: bool = True
    debug_info_enabled: bool = False


class AgentRuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    auto_title: AutoTitleRuntimeSettings = Field(default_factory=AutoTitleRuntimeSettings)
    duplicate_tool_call_guard: DuplicateToolCallGuardRuntimeSettings = Field(
        default_factory=DuplicateToolCallGuardRuntimeSettings
    )
    context_compression: ContextCompressionRuntimeSettings = Field(
        default_factory=ContextCompressionRuntimeSettings
    )
    a2ui: A2UIRuntimeSettings = Field(default_factory=A2UIRuntimeSettings)


def default_agent_runtime_settings() -> AgentRuntimeSettings:
    return AgentRuntimeSettings()


def load_agent_runtime_settings(repositories: StorageRepositories) -> AgentRuntimeSettings:
    raw = repositories.settings.get(AGENT_RUNTIME_SETTINGS_KEY)
    if raw is None:
        return default_agent_runtime_settings()
    return AgentRuntimeSettings.model_validate(_drop_removed_runtime_settings(raw))


def save_agent_runtime_settings(
    repositories: StorageRepositories,
    settings: AgentRuntimeSettings,
) -> AgentRuntimeSettings:
    validated = AgentRuntimeSettings.model_validate(settings.model_dump(mode="json"))
    repositories.settings.set(AGENT_RUNTIME_SETTINGS_KEY, validated.model_dump(mode="json"))
    return validated


def _drop_removed_runtime_settings(raw: Any) -> Any:
    if not isinstance(raw, dict):
        return raw
    cleaned = {
        key: value
        for key, value in raw.items()
        if key not in REMOVED_RUNTIME_SETTINGS_KEYS
    }
    context_compression = cleaned.get("context_compression")
    if isinstance(context_compression, dict):
        cleaned["context_compression"] = {
            key: value
            for key, value in context_compression.items()
            if key not in {"emergency_fraction", "retain_rounds"}
        }
    return cleaned
