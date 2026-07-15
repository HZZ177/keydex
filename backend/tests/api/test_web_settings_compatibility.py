from __future__ import annotations

import json
import sqlite3

from fastapi.testclient import TestClient

from backend.app.agent.runtime_settings import AGENT_RUNTIME_SETTINGS_KEY
from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_legacy_settings_database_upgrades_without_losing_existing_value(tmp_path) -> None:
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    db_path = data_dir / "app.db"
    legacy_value = {"legacy": True, "label": "keep-me"}
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "create table settings ("
            "key text primary key, value_json text not null, updated_at text not null)"
        )
        conn.execute(
            "insert into settings (key, value_json, updated_at) values (?, ?, ?)",
            ("legacy_value", json.dumps(legacy_value), "2026-07-15T00:00:00Z"),
        )

    app = create_app(AppSettings(data_dir=data_dir))

    assert app.state.repositories.settings.get("legacy_value") == legacy_value
    assert app.state.repositories.web_settings.get_settings().enabled is False


def test_repeated_app_initialization_preserves_web_and_extension_settings(tmp_path) -> None:
    settings = AppSettings(data_dir=tmp_path / "data")
    first = create_app(settings)
    extension = first.state.repositories.settings.get(AGENT_RUNTIME_SETTINGS_KEY, default={})
    first.state.repositories.web_settings.save(
        enabled=True,
        active_provider_id="tavily",
        providers={},
    )

    second = create_app(settings)

    assert second.state.repositories.settings.get(
        AGENT_RUNTIME_SETTINGS_KEY,
        default={},
    ) == extension
    assert second.state.repositories.web_settings.get_settings().enabled is True


def test_corrupt_web_json_does_not_break_unrelated_settings_endpoints(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.repositories.web_settings.upsert_provider(
        "tavily",
        config={},
        secrets={"api_key": "before-corrupt"},
    )
    with app.state.database.connect() as conn:
        conn.execute(
            "update web_provider_configs set config_json = '[' where provider_id = 'tavily'"
        )

    with TestClient(app) as client:
        settings_response = client.get("/api/settings")
        extensions_response = client.get("/api/settings/extensions")
        models_response = client.get("/api/model-providers")
        web_response = client.get("/api/settings/web")

    assert settings_response.status_code == 200
    assert extensions_response.status_code == 200
    assert models_response.status_code == 200
    assert web_response.status_code == 200
    assert web_response.json()["providers"][0]["config_status"] == "invalid"


def test_web_settings_roundtrip_does_not_mutate_extension_settings(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        before = client.get("/api/settings/extensions").json()
        saved = client.put(
            "/api/settings/web",
            json={
                "enabled": True,
                "active_provider_id": "tavily",
                "providers": {
                    "tavily": {
                        "config": {},
                        "secrets": {
                            "api_key": {"action": "set", "value": "web-only-secret"}
                        },
                    }
                },
            },
        )
        after = client.get("/api/settings/extensions").json()

    assert saved.status_code == 200
    assert before == after


def test_model_provider_api_remains_independently_masked_after_web_setup(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    web_secret = "web-provider-secret"
    model_secret = "model-provider-secret"
    app.state.repositories.web_settings.upsert_provider(
        "tavily",
        config={},
        secrets={"api_key": web_secret},
    )

    with TestClient(app) as client:
        created = client.post(
            "/api/model-providers",
            json={
                "name": "Compatible Provider",
                "base_url": "https://model.example/v1",
                "api_key": model_secret,
                "enabled": True,
                "models": ["compatible-model"],
            },
        )
        listed = client.get("/api/model-providers")

    combined = created.text + listed.text
    assert created.status_code == 201
    assert listed.status_code == 200
    assert created.json()["api_key_set"] is True
    assert web_secret not in combined
    assert model_secret not in combined
