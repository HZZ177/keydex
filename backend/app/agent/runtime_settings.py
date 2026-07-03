from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_core import PydanticCustomError

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

    enabled: bool = False
    context_window_tokens: int = Field(default=128000, ge=1000, le=2_000_000)
    trigger_fraction: float = Field(default=0.75, gt=0.0, lt=1.0)
    emergency_fraction: float = Field(default=0.9, gt=0.0, le=1.0)
    retain_rounds: int = Field(default=2, ge=0, le=20)

    @model_validator(mode="after")
    def validate_threshold_order(self) -> ContextCompressionRuntimeSettings:
        if self.trigger_fraction >= self.emergency_fraction:
            raise PydanticCustomError(
                "compression_threshold_order",
                "trigger_fraction must be less than emergency_fraction",
            )
        return self


class AgentRuntimeSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    auto_title: AutoTitleRuntimeSettings = Field(default_factory=AutoTitleRuntimeSettings)
    duplicate_tool_call_guard: DuplicateToolCallGuardRuntimeSettings = Field(
        default_factory=DuplicateToolCallGuardRuntimeSettings
    )
    context_compression: ContextCompressionRuntimeSettings = Field(
        default_factory=ContextCompressionRuntimeSettings
    )


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
    return {
        key: value
        for key, value in raw.items()
        if key not in REMOVED_RUNTIME_SETTINGS_KEYS
    }
