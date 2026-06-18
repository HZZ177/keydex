import httpx
from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def _client(tmp_path, handler=None) -> TestClient:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    if handler is not None:
        app.state.model_http_transport = httpx.MockTransport(handler)
    return TestClient(app)


def test_model_providers_list_maps_legacy_settings_without_key_leak(tmp_path) -> None:
    with _client(tmp_path) as client:
        client.put(
            "/api/settings",
            json={
                "model": {
                    "base_url": "http://provider.test/v1",
                    "api_key": "sk-legacy",
                    "model": "qwen-coder",
                }
            },
        )

        response = client.get("/api/model-providers")

    assert response.status_code == 200
    provider = response.json()["providers"][0]
    assert provider["id"] == "legacy-openai-compatible"
    assert provider["api_key_set"] is True
    assert "api_key" not in provider
    assert provider["models"] == ["qwen-coder"]
    assert provider["default_model"] == "qwen-coder"


def test_model_provider_create_update_and_default(tmp_path) -> None:
    with _client(tmp_path) as client:
        created = client.post(
            "/api/model-providers",
            json={
                "name": "主模型",
                "base_url": "http://provider.test/v1/",
                "api_key": "sk-secret",
                "models": ["qwen-coder"],
                "default_model": "qwen-coder",
            },
        )
        assert created.status_code == 201
        provider = created.json()
        assert provider["base_url"] == "http://provider.test/v1"
        assert provider["api_key_set"] is True
        assert "api_key" not in provider

        patched = client.patch(
            f"/api/model-providers/{provider['id']}",
            json={"name": "主模型更新", "enabled": False},
        )
        assert patched.status_code == 200
        assert patched.json()["name"] == "主模型更新"
        assert patched.json()["api_key_set"] is True

        default_response = client.put(
            "/api/model-providers/default",
            json={"provider_id": provider["id"], "model": "qwen-coder"},
        )
        assert default_response.status_code == 200
        assert default_response.json()["providers"][0]["default_model"] == "qwen-coder"

        settings_response = client.get("/api/settings")
        assert settings_response.status_code == 200
        settings_payload = settings_response.json()["model"]
        assert settings_payload["base_url"] == "http://provider.test/v1"
        assert settings_payload["model"] == "qwen-coder"
        assert settings_payload["api_key_set"] is True

        models_response = client.get("/api/models")
        assert models_response.status_code == 200
        assert models_response.json()["models"] == []


def test_models_api_lists_enabled_provider_models(tmp_path) -> None:
    with _client(tmp_path) as client:
        provider = client.post(
            "/api/model-providers",
            json={
                "name": "主模型",
                "base_url": "http://provider.test/v1",
                "models": ["qwen-coder", "disabled-model"],
                "model_enabled": {"disabled-model": False},
            },
        ).json()

        response = client.get("/api/models")

    assert response.status_code == 200
    assert response.json()["models"] == [
        {
            "id": "qwen-coder",
            "owned_by": None,
            "raw": {"id": "qwen-coder", "provider_id": provider["id"]},
        }
    ]


def test_model_provider_refresh_uses_real_models_endpoint_and_preserves_key(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        assert request.headers["authorization"] == "Bearer sk-secret"
        return httpx.Response(200, json={"data": [{"id": "qwen-coder"}]})

    with _client(tmp_path, handler) as client:
        provider = client.post(
            "/api/model-providers",
            json={
                "name": "主模型",
                "base_url": "http://provider.test/v1",
                "api_key": "sk-secret",
            },
        ).json()

        response = client.post(f"/api/model-providers/{provider['id']}/refresh")

    assert response.status_code == 200
    assert response.json()["models"] == ["qwen-coder"]
    assert response.json()["provider"]["default_model"] == "qwen-coder"

    with _client(tmp_path) as client:
        settings_response = client.get("/api/settings")
    assert settings_response.status_code == 200
    settings_payload = settings_response.json()["model"]
    assert settings_payload["base_url"] == "http://provider.test/v1"
    assert settings_payload["model"] == "qwen-coder"
    assert settings_payload["api_key_set"] is True


def test_model_provider_refresh_returns_structured_provider_error(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"")

    with _client(tmp_path, handler) as client:
        provider = client.post(
            "/api/model-providers",
            json={"name": "主模型", "base_url": "http://provider.test/v1"},
        ).json()

        response = client.post(f"/api/model-providers/{provider['id']}/refresh")

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "provider_refresh_failed"
    assert "不是合法 JSON" in response.json()["detail"]["message"]


def test_model_provider_health_check_persists_result(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    with _client(tmp_path, handler) as client:
        provider = client.post(
            "/api/model-providers",
            json={
                "name": "主模型",
                "base_url": "http://provider.test/v1",
                "models": ["qwen-coder"],
            },
        ).json()

        response = client.post(
            f"/api/model-providers/{provider['id']}/models/qwen-coder/health"
        )

    assert response.status_code == 200
    assert response.json()["health"]["status"] == "healthy"
    assert response.json()["provider"]["health"]["qwen-coder"]["status"] == "healthy"


def test_model_provider_health_check_persists_unhealthy_result(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(
            400,
            json={"error": {"message": "invalid api key"}},
        )

    with _client(tmp_path, handler) as client:
        provider = client.post(
            "/api/model-providers",
            json={
                "name": "主模型",
                "base_url": "http://provider.test/v1",
                "models": ["qwen-coder"],
            },
        ).json()

        response = client.post(
            f"/api/model-providers/{provider['id']}/models/qwen-coder/health"
        )

    assert response.status_code == 200
    body = response.json()
    assert body["health"]["status"] == "unhealthy"
    assert "invalid api key" in body["health"]["error"]
    assert body["provider"]["health"]["qwen-coder"]["status"] == "unhealthy"
