from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from backend.app.core.env import ENV_PREFIX

DEFAULT_PROTOCOL_VERSION = "2026-06-15"


def default_data_dir() -> Path:
    return Path(__file__).resolve().parents[1] / ".data"


class AppSettings(BaseSettings):
    app_name: str = "Keydex"
    version: str = "0.1.0"
    protocol_version: str = DEFAULT_PROTOCOL_VERSION
    host: str = "127.0.0.1"
    port: int = 8765
    data_dir: Path = Field(default_factory=default_data_dir)
    workspace_root: Path = Field(default_factory=lambda: Path.cwd().resolve())
    default_user_id: str = "local-user"
    default_scene_id: str = "desktop-agent"
    default_scene_name: str = "Keydex"
    max_history_messages: int = Field(default=40, ge=1)
    file_history_enabled: bool = True
    file_history_max_storage_bytes: int = Field(default=1_073_741_824, ge=1)
    file_history_max_versions_per_file: int = Field(default=1_000, ge=1)
    file_history_max_rewind_points: int = Field(default=100, ge=1, le=100)
    file_history_retention_days: int = Field(default=30, ge=1)
    file_history_orphan_grace_seconds: int = Field(default=86_400, ge=0)
    tool_timeout_seconds: float = Field(default=120.0, gt=0)
    shell_timeout_seconds: float = Field(default=120.0, gt=0)
    log_level: str = "INFO"
    reload: bool = True
    e2e_model_transport: bool = False
    e2e_stream_delay_ms: int = Field(default=80, ge=0)
    mcp_enabled: bool = True
    mcp_default_startup_timeout_sec: int = Field(default=30, gt=0)
    mcp_default_tool_timeout_sec: int = Field(default=60, gt=0)
    mcp_max_tool_result_bytes: int = Field(default=262_144, gt=0)
    mcp_auto_refresh_interval_sec: int = Field(default=60, gt=0)
    mcp_direct_tool_budget: int = Field(default=10, ge=1)

    model_config = SettingsConfigDict(
        env_prefix=ENV_PREFIX,
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @field_validator("data_dir", "workspace_root", mode="before")
    @classmethod
    def resolve_path(cls, value: str | Path) -> Path:
        return Path(value).expanduser().resolve()


@lru_cache(maxsize=1)
def get_settings() -> AppSettings:
    return AppSettings()


def reset_settings_cache() -> None:
    get_settings.cache_clear()
