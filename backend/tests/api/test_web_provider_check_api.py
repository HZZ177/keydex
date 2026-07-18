from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.web.config import WebProviderConfigField
from backend.app.web.errors import WebErrorCode, WebProviderError, web_error
from backend.app.web.models import WebCapability
from backend.app.web.provider import (
    BaseWebProvider,
    WebConnectionCheckResult,
    WebProviderContext,
    WebProviderDescriptor,
)
from backend.app.web.registry import WebProviderRegistry


class CheckProvider(BaseWebProvider):
    descriptor = WebProviderDescriptor(
        provider_id="check-provider",
        display_name="Check Provider",
        description="连接检查测试 Provider",
        capabilities=frozenset({WebCapability.SEARCH}),
        config_fields=(
            WebProviderConfigField(
                key="endpoint",
                field_type="text",
                label="Endpoint",
                required=True,
            ),
            WebProviderConfigField(
                key="api_key",
                field_type="secret",
                label="API Key",
                required=True,
            ),
        ),
    )

    def __init__(self) -> None:
        self.contexts: list[WebProviderContext] = []
        self.result = WebConnectionCheckResult(
            provider_id=self.descriptor.provider_id,
            ok=True,
            duration_ms=12,
        )
        self.error: Exception | None = None

    async def check_connection(
        self,
        context: WebProviderContext,
    ) -> WebConnectionCheckResult:
        self.contexts.append(context)
        if self.error is not None:
            raise self.error
        return self.result


def _client(tmp_path) -> tuple[TestClient, CheckProvider]:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    provider = CheckProvider()
    app.state.web_provider_registry = WebProviderRegistry((provider,))
    return TestClient(app), provider


def _draft(secret: str = "draft-secret") -> dict:
    return {
        "config": {"endpoint": "https://search.example.com"},
        "secrets": {"api_key": {"action": "set", "value": secret}},
    }


def test_check_provider_uses_unsaved_draft_without_persisting(tmp_path) -> None:
    client, provider = _client(tmp_path)

    response = client.post(
        "/api/settings/web/providers/check-provider/check",
        json=_draft(),
    )

    assert response.status_code == 200
    assert response.json() == {
        "provider_id": "check-provider",
        "ok": True,
        "duration_ms": 12,
        "error": None,
    }
    assert provider.contexts[0].config == {"endpoint": "https://search.example.com"}
    assert provider.contexts[0].secrets == {"api_key": "draft-secret"}
    assert client.app.state.repositories.web_settings.get_provider("check-provider") is None


def test_check_provider_uses_saved_values_and_keep_action(tmp_path) -> None:
    client, provider = _client(tmp_path)
    client.app.state.repositories.web_settings.upsert_provider(
        "check-provider",
        config={"endpoint": "https://saved.example.com"},
        secrets={"api_key": "saved-secret"},
    )

    response = client.post(
        "/api/settings/web/providers/check-provider/check",
        json={"secrets": {"api_key": {"action": "keep"}}},
    )

    assert response.status_code == 200
    assert provider.contexts[0].config == {"endpoint": "https://saved.example.com"}
    assert provider.contexts[0].secrets == {"api_key": "saved-secret"}


def test_check_provider_rejects_unknown_provider(tmp_path) -> None:
    client, _provider = _client(tmp_path)

    response = client.post(
        "/api/settings/web/providers/unknown/check",
        json={},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "provider_not_selected"


def test_check_provider_rejects_incomplete_fields_without_calling_provider(tmp_path) -> None:
    client, provider = _client(tmp_path)

    response = client.post(
        "/api/settings/web/providers/check-provider/check",
        json={"config": {}, "secrets": {}},
    )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "provider_not_configured"
    assert provider.contexts == []


@pytest.mark.parametrize(
    ("code", "retryable"),
    [
        (WebErrorCode.AUTHENTICATION_FAILED, False),
        (WebErrorCode.QUOTA_EXHAUSTED, False),
        (WebErrorCode.RATE_LIMITED, True),
        (WebErrorCode.REQUEST_TIMEOUT, True),
        (WebErrorCode.NETWORK_UNAVAILABLE, True),
    ],
)
def test_check_provider_returns_public_stable_error(
    tmp_path,
    code: WebErrorCode,
    retryable: bool,
) -> None:
    client, provider = _client(tmp_path)
    raw = "provider-error-secret"
    provider.error = WebProviderError(
        web_error(
            code,
            provider_id="check-provider",
            diagnostic={"api_key": raw, "body": f"failed for {raw}"},
            sensitive_values=(raw,),
        )
    )

    response = client.post(
        "/api/settings/web/providers/check-provider/check",
        json=_draft(raw),
    )
    body = response.json()

    assert response.status_code == 200
    assert body["ok"] is False
    assert body["error"]["schema_version"] == 1
    assert body["error"]["code"] == code
    assert body["error"]["details"]["provider_id"] == "check-provider"
    assert body["error"]["retryable"] is retryable
    assert "diagnostic" not in body["error"]
    assert raw not in json.dumps(body)


def test_check_provider_converts_unexpected_error_without_leaking_secret(tmp_path) -> None:
    client, provider = _client(tmp_path)
    raw = "unexpected-error-secret"
    provider.error = RuntimeError(f"transport exposed {raw}")

    response = client.post(
        "/api/settings/web/providers/check-provider/check",
        json=_draft(raw),
    )

    assert response.status_code == 200
    assert response.json()["error"]["code"] == "provider_unavailable"
    assert raw not in response.text


def test_check_provider_repeated_requests_do_not_mutate_saved_config(tmp_path) -> None:
    client, provider = _client(tmp_path)
    repositories = client.app.state.repositories
    repositories.web_settings.upsert_provider(
        "check-provider",
        config={"endpoint": "https://saved.example.com"},
        secrets={"api_key": "saved-secret"},
    )

    for index in range(2):
        response = client.post(
            "/api/settings/web/providers/check-provider/check",
            json=_draft(f"draft-secret-{index}"),
        )
        assert response.status_code == 200

    stored = repositories.web_settings.get_provider("check-provider")
    assert stored is not None
    assert stored.config == {"endpoint": "https://saved.example.com"}
    assert stored.secrets == {"api_key": "saved-secret"}
    assert len(provider.contexts) == 2
