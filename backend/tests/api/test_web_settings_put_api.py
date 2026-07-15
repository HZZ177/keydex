from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.web.config import WebProviderConfigField
from backend.app.web.models import WebCapability
from backend.app.web.provider import BaseWebProvider, WebProviderDescriptor
from backend.app.web.registry import build_default_web_provider_registry


class SecondProvider(BaseWebProvider):
    descriptor = WebProviderDescriptor(
        provider_id="second",
        display_name="Second",
        description="第二个测试搜索引擎",
        capabilities=frozenset({WebCapability.SEARCH}),
        config_fields=(
            WebProviderConfigField(
                key="region",
                field_type="text",
                label="Region",
                required=True,
            ),
            WebProviderConfigField(
                key="client_secret",
                field_type="secret",
                label="Client Secret",
                required=True,
            ),
        ),
    )


def _client(tmp_path, *, multiple: bool = False) -> TestClient:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    if multiple:
        app.state.web_provider_registry = build_default_web_provider_registry(
            extra_providers=(SecondProvider(),)
        )
    return TestClient(app)


def _tavily_update(secret: str = "test-tavily-secret") -> dict:
    return {
        "enabled": True,
        "active_provider_id": "tavily",
        "providers": {
            "tavily": {
                "config": {},
                "secrets": {"api_key": {"action": "set", "value": secret}},
            }
        },
    }


def test_put_web_settings_saves_and_returns_masked_values(tmp_path) -> None:
    client = _client(tmp_path)
    raw = "put-api-sensitive-key"

    response = client.put("/api/settings/web", json=_tavily_update(raw))

    assert response.status_code == 200
    assert response.json()["enabled"] is True
    assert response.json()["providers"][0]["configured"] is True
    assert raw not in response.text
    stored = client.app.state.repositories.web_settings.get_provider("tavily")
    assert stored is not None
    assert stored.secrets == {"api_key": raw}


def test_put_web_settings_applies_keep_replace_and_clear(tmp_path) -> None:
    client = _client(tmp_path)
    client.put("/api/settings/web", json=_tavily_update("first-key-value"))

    kept = client.put(
        "/api/settings/web",
        json={
            "enabled": True,
            "active_provider_id": "tavily",
            "providers": {
                "tavily": {
                    "config": {},
                    "secrets": {"api_key": {"action": "keep"}},
                }
            },
        },
    )
    replaced = client.put(
        "/api/settings/web",
        json=_tavily_update("replacement-key-value"),
    )
    cleared = client.put(
        "/api/settings/web",
        json={
            "enabled": False,
            "active_provider_id": "tavily",
            "providers": {
                "tavily": {
                    "config": {},
                    "secrets": {"api_key": {"action": "clear"}},
                }
            },
        },
    )

    assert kept.status_code == 200
    assert replaced.status_code == 200
    assert cleared.status_code == 200
    assert cleared.json()["providers"][0]["configured"] is False
    stored = client.app.state.repositories.web_settings.get_provider("tavily")
    assert stored is not None
    assert stored.secrets == {}


def test_put_web_settings_saves_multiple_provider_drafts_atomically(tmp_path) -> None:
    client = _client(tmp_path, multiple=True)

    response = client.put(
        "/api/settings/web",
        json={
            "enabled": True,
            "active_provider_id": "second",
            "providers": {
                "tavily": {
                    "config": {},
                    "secrets": {"api_key": {"action": "set", "value": "tavily-key"}},
                },
                "second": {
                    "config": {"region": "global"},
                    "secrets": {
                        "client_secret": {"action": "set", "value": "second-key"}
                    },
                },
            },
        },
    )

    assert response.status_code == 200
    snapshot = client.app.state.repositories.web_settings.get_snapshot()
    assert snapshot.settings.active_provider_id == "second"
    assert [provider.provider_id for provider in snapshot.providers] == ["second", "tavily"]


def test_put_web_settings_rejects_unknown_provider_without_mutation(tmp_path) -> None:
    client = _client(tmp_path)
    before = client.get("/api/settings/web").json()

    response = client.put(
        "/api/settings/web",
        json={
            "enabled": False,
            "active_provider_id": "unknown",
            "providers": {"unknown": {"config": {}, "secrets": {}}},
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "provider_not_selected"
    assert client.get("/api/settings/web").json() == before


def test_put_web_settings_rejects_unknown_field_and_rolls_back_all_providers(tmp_path) -> None:
    client = _client(tmp_path, multiple=True)

    response = client.put(
        "/api/settings/web",
        json={
            "enabled": True,
            "active_provider_id": "second",
            "providers": {
                "tavily": {
                    "config": {},
                    "secrets": {"api_key": {"action": "set", "value": "must-roll-back"}},
                },
                "second": {
                    "config": {"unknown": "value"},
                    "secrets": {
                        "client_secret": {"action": "set", "value": "second-key"}
                    },
                },
            },
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_request"
    assert client.app.state.repositories.web_settings.list_providers() == []


def test_put_web_settings_requires_complete_active_provider_when_enabled(tmp_path) -> None:
    client = _client(tmp_path)

    response = client.put(
        "/api/settings/web",
        json={
            "enabled": True,
            "active_provider_id": "tavily",
            "providers": {"tavily": {"config": {}, "secrets": {}}},
        },
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "provider_not_configured"


def test_put_web_settings_allows_incomplete_draft_while_disabled(tmp_path) -> None:
    client = _client(tmp_path, multiple=True)

    response = client.put(
        "/api/settings/web",
        json={
            "enabled": False,
            "active_provider_id": "second",
            "providers": {"second": {"config": {"region": "draft"}, "secrets": {}}},
        },
    )

    assert response.status_code == 200
    assert response.json()["enabled"] is False
    assert response.json()["providers"][0]["config_status"] == "incomplete"
    stored = client.app.state.repositories.web_settings.get_provider("second")
    assert stored is not None
    assert stored.config == {"region": "draft"}


def test_put_web_settings_preserves_provider_omitted_from_patch(tmp_path) -> None:
    client = _client(tmp_path, multiple=True)
    repositories = client.app.state.repositories
    repositories.web_settings.upsert_provider(
        "second",
        config={"region": "saved"},
        secrets={"client_secret": "preserved-secret"},
    )

    response = client.put("/api/settings/web", json=_tavily_update())

    assert response.status_code == 200
    second = repositories.web_settings.get_provider("second")
    assert second is not None
    assert second.config == {"region": "saved"}
    assert second.secrets == {"client_secret": "preserved-secret"}
    assert "preserved-secret" not in json.dumps(response.json())


def test_put_web_settings_rejects_empty_set_before_database_write(tmp_path) -> None:
    client = _client(tmp_path)

    response = client.put(
        "/api/settings/web",
        json=_tavily_update("  "),
    )

    assert response.status_code == 422
    assert client.app.state.repositories.web_settings.list_providers() == []


def test_put_web_settings_validation_error_does_not_echo_secret_input(tmp_path) -> None:
    client = _client(tmp_path)
    raw = "must-not-echo-invalid-secret"

    response = client.put(
        "/api/settings/web",
        json={
            "enabled": False,
            "active_provider_id": "tavily",
            "providers": {
                "tavily": {
                    "config": {},
                    "secrets": {"api_key": {"action": "keep", "value": raw}},
                }
            },
        },
    )

    assert response.status_code == 422
    assert raw not in response.text
