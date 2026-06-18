import httpx
from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_models_refresh_and_cached_get(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        assert request.headers["authorization"] == "Bearer sk-test"
        return httpx.Response(200, json={"data": [{"id": "qwen3-coder"}]})

    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.model_http_transport = httpx.MockTransport(handler)
    with TestClient(app) as client:
        client.put(
            "/api/settings",
            json={
                "model": {
                    "base_url": "http://provider.test/v1",
                    "api_key": "sk-test",
                    "model": "manual-model",
                }
            },
        )

        refreshed = client.post("/api/models/refresh")
        assert refreshed.status_code == 200
        assert refreshed.json()["models"][0]["id"] == "qwen3-coder"

        cached = client.get("/api/models")
        assert cached.json()["cached"] is True
        assert cached.json()["models"][0]["id"] == "qwen3-coder"


def test_models_get_returns_empty_without_cached_refresh(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        client.put("/api/settings", json={"model": {"model": "manual-model"}})
        response = client.get("/api/models")

    assert response.json()["models"] == []
    assert response.json()["cached"] is False


def test_models_refresh_returns_502_for_invalid_provider_json(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        return httpx.Response(200, content=b"")

    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.model_http_transport = httpx.MockTransport(handler)
    with TestClient(app) as client:
        response = client.post(
            "/api/models/refresh",
            json={
                "model": {
                    "base_url": "http://provider.test/v1",
                    "api_key": "sk-test",
                    "model": "qwen3-coder",
                }
            },
        )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "model_refresh_failed"
    assert "不是合法 JSON" in response.json()["detail"]["message"]


def test_models_refresh_returns_provider_http_error_without_replacing_cache(tmp_path) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.url.path == "/v1/models"
        if calls == 1:
            return httpx.Response(200, json={"data": [{"id": "qwen3-coder"}]})
        return httpx.Response(400, json={"error": {"message": "invalid api key"}})

    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.model_http_transport = httpx.MockTransport(handler)
    with TestClient(app) as client:
        client.put(
            "/api/settings",
            json={
                "model": {
                    "base_url": "http://provider.test/v1",
                    "api_key": "sk-test",
                    "model": "qwen3-coder",
                }
            },
        )
        assert client.post("/api/models/refresh").status_code == 200

        response = client.post("/api/models/refresh")
        cached = client.get("/api/models")

    assert response.status_code == 502
    assert response.json()["detail"] == {
        "code": "model_refresh_failed",
        "message": "刷新模型列表失败：HTTP 400：invalid api key",
        "details": {},
    }
    assert cached.json()["cached"] is True
    assert cached.json()["models"][0]["id"] == "qwen3-coder"


def test_models_refresh_requires_endpoint(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        response = client.post("/api/models/refresh", json={"model": {"model": "qwen3-coder"}})

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "model_config_invalid"
    assert "模型服务地址未配置" in response.json()["detail"]["message"]


def test_models_refresh_uses_saved_api_key_when_request_omits_it(tmp_path) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer sk-saved"
        return httpx.Response(200, json={"data": [{"id": "qwen3-coder-plus"}]})

    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.model_http_transport = httpx.MockTransport(handler)
    with TestClient(app) as client:
        client.put(
            "/api/settings",
            json={
                "model": {
                    "base_url": "http://provider.test/v1",
                    "api_key": "sk-saved",
                    "model": "qwen3-coder",
                }
            },
        )

        response = client.post(
            "/api/models/refresh",
            json={"model": {"base_url": "http://provider.test/v1", "model": ""}},
        )

    assert response.status_code == 200
    assert response.json()["models"][0]["id"] == "qwen3-coder-plus"
