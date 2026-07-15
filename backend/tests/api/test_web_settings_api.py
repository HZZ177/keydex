from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.web.config import WebProviderConfigField
from backend.app.web.models import WebCapability
from backend.app.web.provider import BaseWebProvider, WebProviderDescriptor
from backend.app.web.registry import build_default_web_provider_registry


class ExampleProvider(BaseWebProvider):
    descriptor = WebProviderDescriptor(
        provider_id="example",
        display_name="Example Search",
        description="测试搜索引擎",
        capabilities=frozenset({WebCapability.SEARCH}),
        config_fields=(
            WebProviderConfigField(
                key="endpoint",
                field_type="text",
                label="Endpoint",
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


def _client(tmp_path) -> TestClient:
    return TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))


def test_get_web_settings_returns_disabled_tavily_default(tmp_path) -> None:
    client = _client(tmp_path)

    response = client.get("/api/settings/web")

    assert response.status_code == 200
    assert response.json() == {
        "enabled": False,
        "active_provider_id": "tavily",
        "active_provider_known": True,
        "providers": [
            {
                "provider_id": "tavily",
                "display_name": "Tavily",
                "description": "面向 Agent 的网络搜索与网页内容提取服务",
                "capabilities": ["fetch", "search"],
                "config_fields": [
                    {
                        "key": "api_key",
                        "field_type": "secret",
                        "label": "API Key",
                        "required": True,
                        "placeholder": "请输入 Tavily API Key",
                        "help_text": "密钥仅保存在当前 Keydex 本地数据库中。",
                        "default": None,
                        "options": [],
                    }
                ],
                "credential_setup": {
                    "label": "获取 Tavily 密钥",
                    "url": "https://app.tavily.com/home",
                    "help_text": (
                        "注册 Tavily 免费计划后，每个账号每月可获得 1,000 API Credits。"
                        "Keydex 当前采用基础搜索，每次消耗 1 Credit，"
                        "相当于每月最多约 1,000 次免费搜索；"
                        "网页读取等调用也会消耗同一额度。"
                    ),
                },
                "config": {},
                "secrets": {"api_key": {"configured": False, "preview": None}},
                "configured": False,
                "config_status": "incomplete",
                "connection_status": "unchecked",
            }
        ],
    }


def test_get_web_settings_masks_configured_secret(tmp_path) -> None:
    client = _client(tmp_path)
    raw = "sensitive-tavily-key"
    client.app.state.repositories.web_settings.upsert_provider(
        "tavily",
        config={},
        secrets={"api_key": raw},
    )

    response = client.get("/api/settings/web")
    body = response.json()

    assert response.status_code == 200
    assert body["providers"][0]["configured"] is True
    assert body["providers"][0]["secrets"]["api_key"] == {
        "configured": True,
        "preview": "sens...-key",
    }
    assert raw not in response.text


def test_reveal_web_secret_returns_only_requested_value_without_caching(tmp_path) -> None:
    client = _client(tmp_path)
    raw = "saved-tavily-secret"
    client.app.state.repositories.web_settings.upsert_provider(
        "tavily",
        config={},
        secrets={"api_key": raw},
    )

    revealed = client.post("/api/settings/web/providers/tavily/secrets/api_key/reveal")
    masked = client.get("/api/settings/web")

    assert revealed.status_code == 200
    assert revealed.json() == {
        "provider_id": "tavily",
        "field_key": "api_key",
        "value": raw,
    }
    assert revealed.headers["cache-control"] == "no-store"
    assert revealed.headers["pragma"] == "no-cache"
    assert raw not in masked.text
    assert masked.json()["providers"][0]["secrets"]["api_key"]["configured"] is True


def test_reveal_web_secret_rejects_missing_or_unknown_secret_fields(tmp_path) -> None:
    client = _client(tmp_path)
    client.app.state.web_provider_registry = build_default_web_provider_registry(
        extra_providers=(ExampleProvider(),)
    )

    missing = client.post("/api/settings/web/providers/tavily/secrets/api_key/reveal")
    ordinary = client.post("/api/settings/web/providers/example/secrets/endpoint/reveal")
    unknown_field = client.post("/api/settings/web/providers/tavily/secrets/unknown/reveal")
    unknown_provider = client.post(
        "/api/settings/web/providers/unknown/secrets/api_key/reveal"
    )

    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "provider_not_configured"
    assert ordinary.status_code == 404
    assert ordinary.json()["detail"]["code"] == "invalid_request"
    assert unknown_field.status_code == 404
    assert unknown_field.json()["detail"]["code"] == "invalid_request"
    assert unknown_provider.status_code == 404
    assert unknown_provider.json()["detail"]["code"] == "provider_not_selected"


def test_reveal_web_secret_does_not_leak_corrupt_storage(tmp_path) -> None:
    client = _client(tmp_path)
    raw = "corrupt-secret-must-not-leak"
    client.app.state.repositories.web_settings.upsert_provider(
        "tavily",
        config={},
        secrets={"api_key": "before-corruption"},
    )
    with client.app.state.database.connect() as conn:
        conn.execute(
            "update web_provider_configs set secrets_json = ? where provider_id = 'tavily'",
            (f"{{{raw}",),
        )

    response = client.post("/api/settings/web/providers/tavily/secrets/api_key/reveal")

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "invalid_request"
    assert raw not in response.text


def test_get_web_settings_is_registry_driven_for_multiple_providers(tmp_path) -> None:
    client = _client(tmp_path)
    client.app.state.web_provider_registry = build_default_web_provider_registry(
        extra_providers=(ExampleProvider(),)
    )
    client.app.state.repositories.web_settings.upsert_provider(
        "example",
        config={"endpoint": "https://example.com/search"},
        secrets={"client_secret": "example-client-secret"},
    )

    body = client.get("/api/settings/web").json()

    assert [provider["provider_id"] for provider in body["providers"]] == [
        "example",
        "tavily",
    ]
    example = body["providers"][0]
    assert example["capabilities"] == ["search"]
    assert example["config"] == {"endpoint": "https://example.com/search"}
    assert example["configured"] is True
    assert "example-client-secret" not in json.dumps(body)


def test_get_web_settings_safely_expresses_unknown_active_provider(tmp_path) -> None:
    client = _client(tmp_path)
    client.app.state.repositories.web_settings.save(
        enabled=False,
        active_provider_id="removed-provider",
        providers={},
    )

    body = client.get("/api/settings/web").json()

    assert body["active_provider_id"] == "removed-provider"
    assert body["active_provider_known"] is False
    assert [provider["provider_id"] for provider in body["providers"]] == ["tavily"]


def test_get_web_settings_safely_expresses_corrupt_provider_record(tmp_path) -> None:
    client = _client(tmp_path)
    raw = "corrupt-secret-must-not-leak"
    client.app.state.repositories.web_settings.upsert_provider(
        "tavily",
        config={},
        secrets={"api_key": "before-corruption"},
    )
    with client.app.state.database.connect() as conn:
        conn.execute(
            "update web_provider_configs set secrets_json = ? where provider_id = 'tavily'",
            (f"{{{raw}",),
        )

    response = client.get("/api/settings/web")
    provider = response.json()["providers"][0]

    assert response.status_code == 200
    assert provider["configured"] is False
    assert provider["config_status"] == "invalid"
    assert provider["secrets"]["api_key"] == {"configured": False, "preview": None}
    assert raw not in response.text


def test_get_web_settings_does_not_change_existing_extensions_endpoint(tmp_path) -> None:
    client = _client(tmp_path)

    before = client.get("/api/settings/extensions")
    web = client.get("/api/settings/web")
    after = client.get("/api/settings/extensions")

    assert web.status_code == 200
    assert before.status_code == 200
    assert after.json() == before.json()
