from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.core.config import AppSettings


def test_app_settings_exposes_desktop_runtime_defaults(tmp_path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path / "workspace")

    assert settings.host == "127.0.0.1"
    assert settings.port == 8765
    assert settings.data_dir == (tmp_path / "data").resolve()
    assert settings.workspace_root == (tmp_path / "workspace").resolve()
    assert settings.default_user_id == "local-user"
    assert settings.default_scene_id == "desktop-agent"
    assert settings.max_history_messages >= 1
    assert settings.max_tool_calls >= 1
    assert settings.tool_timeout_seconds > 0
    assert settings.shell_timeout_seconds > 0
    assert settings.e2e_model_transport is False
    assert settings.e2e_stream_delay_ms >= 0


def test_app_settings_can_be_overridden_by_environment(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("KEYDEX_HOST", "0.0.0.0")
    monkeypatch.setenv("KEYDEX_PORT", "9900")
    monkeypatch.setenv("KEYDEX_DATA_DIR", str(tmp_path / "custom-data"))
    monkeypatch.setenv("KEYDEX_WORKSPACE_ROOT", str(tmp_path / "workspace"))
    monkeypatch.setenv("KEYDEX_MAX_TOOL_CALLS", "12")
    monkeypatch.setenv("KEYDEX_TOOL_TIMEOUT_SECONDS", "9.5")
    monkeypatch.setenv("KEYDEX_E2E_MODEL_TRANSPORT", "true")
    monkeypatch.setenv("KEYDEX_E2E_STREAM_DELAY_MS", "0")

    settings = AppSettings()

    assert settings.host == "0.0.0.0"
    assert settings.port == 9900
    assert settings.data_dir == (tmp_path / "custom-data").resolve()
    assert settings.workspace_root == (tmp_path / "workspace").resolve()
    assert settings.max_tool_calls == 12
    assert settings.tool_timeout_seconds == 9.5
    assert settings.e2e_model_transport is True
    assert settings.e2e_stream_delay_ms == 0


def test_app_settings_reject_invalid_tool_limits() -> None:
    with pytest.raises(ValidationError):
        AppSettings(max_tool_calls=0)

    with pytest.raises(ValidationError):
        AppSettings(tool_timeout_seconds=0)
