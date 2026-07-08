from fastapi.testclient import TestClient

from backend.app.agent.runtime_settings import AGENT_RUNTIME_SETTINGS_KEY
from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_extension_settings_api_returns_defaults_from_app_hard_default(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        response = client.get("/api/settings/extensions")

    assert response.status_code == 200
    body = response.json()
    assert body["auto_title"]["enabled"] is False
    assert body["auto_title"]["max_title_length"] == 20
    assert body["context_compression"]["enabled"] is False
    assert body["context_compression"]["context_window_tokens"] == 128000
    assert "tool_call_limit" not in body
    assert body["duplicate_tool_call_guard"]["enabled"] is True
    assert body["duplicate_tool_call_guard"]["max_repeats"] == 3
    assert body["a2ui"]["enabled"] is True


def test_extension_settings_api_saves_and_reads_full_config(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    payload = {
        "auto_title": {
            "enabled": True,
            "only_when_default_title": False,
            "max_title_length": 50,
        },
        "duplicate_tool_call_guard": {
            "enabled": True,
            "max_repeats": 4,
        },
        "context_compression": {
            "enabled": True,
            "context_window_tokens": 32000,
            "trigger_fraction": 0.55,
        },
        "a2ui": {
            "enabled": False,
        },
    }
    with TestClient(app) as client:
        put_response = client.put("/api/settings/extensions", json=payload)
        get_response = client.get("/api/settings/extensions")

    assert put_response.status_code == 200
    assert put_response.json() == payload
    assert get_response.status_code == 200
    assert get_response.json() == payload


def test_extension_settings_api_loads_legacy_config_without_a2ui(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.repositories.settings.set(
        AGENT_RUNTIME_SETTINGS_KEY,
        {
            "auto_title": {
                "enabled": False,
                "only_when_default_title": True,
                "max_title_length": 20,
            },
            "duplicate_tool_call_guard": {"enabled": True, "max_repeats": 3},
            "context_compression": {
                "enabled": False,
                "context_window_tokens": 128000,
                "trigger_fraction": 0.75,
            },
        },
    )

    with TestClient(app) as client:
        response = client.get("/api/settings/extensions")

    assert response.status_code == 200
    assert response.json()["a2ui"] == {"enabled": True}


def test_extension_settings_api_rejects_removed_tool_limit_field(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    payload = _valid_payload()
    payload["tool_call_limit"] = {
        "enabled": True,
        "max_tool_calls": 80,
        "exit_behavior": "error",
    }

    with TestClient(app) as client:
        response = client.put("/api/settings/extensions", json=payload)

    assert response.status_code == 422


def test_extension_settings_api_rejects_invalid_title_length(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    payload = _valid_payload()
    payload["auto_title"]["max_title_length"] = 51

    with TestClient(app) as client:
        response = client.put("/api/settings/extensions", json=payload)

    assert response.status_code == 422


def test_extension_settings_api_rejects_invalid_compression_threshold(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    payload = _valid_payload()
    payload["context_compression"]["trigger_fraction"] = 1.0

    with TestClient(app) as client:
        response = client.put("/api/settings/extensions", json=payload)

    assert response.status_code == 422


def test_extension_settings_api_rejects_unknown_fields(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    payload = _valid_payload()
    payload["a2ui"]["render_key"] = "custom"

    with TestClient(app) as client:
        response = client.put("/api/settings/extensions", json=payload)

    assert response.status_code == 422


def test_extension_settings_api_fails_loudly_for_corrupt_persisted_config(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.repositories.settings.set(
        AGENT_RUNTIME_SETTINGS_KEY,
        {
            "auto_title": {
                "enabled": False,
                "only_when_default_title": True,
                "max_title_length": 20,
            },
            "duplicate_tool_call_guard": {"enabled": True, "max_repeats": 3},
            "context_compression": {
                "enabled": True,
                "context_window_tokens": 128000,
                "trigger_fraction": 1.0,
            },
        },
    )

    with TestClient(app) as client:
        response = client.get("/api/settings/extensions")

    assert response.status_code == 500
    assert response.json()["detail"]["code"] == "agent_runtime_settings_invalid"


def _valid_payload() -> dict:
    return {
        "auto_title": {
            "enabled": False,
            "only_when_default_title": True,
            "max_title_length": 20,
        },
        "duplicate_tool_call_guard": {
            "enabled": True,
            "max_repeats": 3,
        },
        "context_compression": {
            "enabled": False,
            "context_window_tokens": 128000,
            "trigger_fraction": 0.75,
        },
        "a2ui": {
            "enabled": True,
        },
    }
