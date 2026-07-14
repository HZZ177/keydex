from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.core.config import AppSettings, default_data_dir


def test_app_settings_exposes_desktop_runtime_defaults(tmp_path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path / "workspace")

    assert settings.host == "127.0.0.1"
    assert settings.port == 8765
    assert settings.data_dir == (tmp_path / "data").resolve()
    assert settings.workspace_root == (tmp_path / "workspace").resolve()
    assert settings.default_user_id == "local-user"
    assert settings.default_scene_id == "desktop-agent"
    assert settings.max_history_messages >= 1
    assert settings.file_history_max_rewind_points == 100
    assert settings.file_history_retention_days == 30
    assert settings.tool_timeout_seconds > 0
    assert settings.shell_timeout_seconds > 0
    assert settings.e2e_model_transport is False
    assert settings.e2e_stream_delay_ms >= 0
    assert settings.mcp_enabled is True
    assert settings.mcp_default_startup_timeout_sec == 30
    assert settings.mcp_default_tool_timeout_sec == 60
    assert settings.mcp_max_tool_result_bytes == 262_144
    assert settings.mcp_auto_refresh_interval_sec == 60
    assert settings.mcp_direct_tool_budget == 10


def test_app_settings_default_data_dir_is_backend_app_data() -> None:
    settings = AppSettings()

    assert settings.data_dir == default_data_dir().resolve()


def test_app_settings_can_be_overridden_by_environment(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("KEYDEX_HOST", "0.0.0.0")
    monkeypatch.setenv("KEYDEX_PORT", "9900")
    monkeypatch.setenv("KEYDEX_DATA_DIR", str(tmp_path / "custom-data"))
    monkeypatch.setenv("KEYDEX_WORKSPACE_ROOT", str(tmp_path / "workspace"))
    monkeypatch.setenv("KEYDEX_TOOL_TIMEOUT_SECONDS", "9.5")
    monkeypatch.setenv("KEYDEX_E2E_MODEL_TRANSPORT", "true")
    monkeypatch.setenv("KEYDEX_E2E_STREAM_DELAY_MS", "0")
    monkeypatch.setenv("KEYDEX_FILE_HISTORY_MAX_REWIND_POINTS", "64")
    monkeypatch.setenv("KEYDEX_FILE_HISTORY_RETENTION_DAYS", "45")
    monkeypatch.setenv("KEYDEX_MCP_ENABLED", "false")
    monkeypatch.setenv("KEYDEX_MCP_DEFAULT_STARTUP_TIMEOUT_SEC", "7")
    monkeypatch.setenv("KEYDEX_MCP_DEFAULT_TOOL_TIMEOUT_SEC", "11")
    monkeypatch.setenv("KEYDEX_MCP_MAX_TOOL_RESULT_BYTES", "12345")
    monkeypatch.setenv("KEYDEX_MCP_AUTO_REFRESH_INTERVAL_SEC", "90")
    monkeypatch.setenv("KEYDEX_MCP_DIRECT_TOOL_BUDGET", "8")

    settings = AppSettings()

    assert settings.host == "0.0.0.0"
    assert settings.port == 9900
    assert settings.data_dir == (tmp_path / "custom-data").resolve()
    assert settings.workspace_root == (tmp_path / "workspace").resolve()
    assert settings.tool_timeout_seconds == 9.5
    assert settings.e2e_model_transport is True
    assert settings.e2e_stream_delay_ms == 0
    assert settings.file_history_max_rewind_points == 64
    assert settings.file_history_retention_days == 45
    assert settings.mcp_enabled is False
    assert settings.mcp_default_startup_timeout_sec == 7
    assert settings.mcp_default_tool_timeout_sec == 11
    assert settings.mcp_max_tool_result_bytes == 12345
    assert settings.mcp_auto_refresh_interval_sec == 90
    assert settings.mcp_direct_tool_budget == 8


def test_app_settings_reject_invalid_timeouts() -> None:
    with pytest.raises(ValidationError):
        AppSettings(tool_timeout_seconds=0)


def test_app_settings_reject_invalid_mcp_values() -> None:
    with pytest.raises(ValidationError):
        AppSettings(mcp_default_startup_timeout_sec=0)

    with pytest.raises(ValidationError):
        AppSettings(mcp_default_tool_timeout_sec=0)

    with pytest.raises(ValidationError):
        AppSettings(mcp_max_tool_result_bytes=0)

    with pytest.raises(ValidationError):
        AppSettings(mcp_auto_refresh_interval_sec=0)

    with pytest.raises(ValidationError):
        AppSettings(mcp_direct_tool_budget=0)


def test_app_settings_reject_invalid_file_history_retention_values() -> None:
    with pytest.raises(ValidationError):
        AppSettings(file_history_max_rewind_points=101)

    with pytest.raises(ValidationError):
        AppSettings(file_history_retention_days=0)
