from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_settings_api_reads_and_writes_model_settings(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        initial = client.get("/api/settings")
        assert initial.status_code == 200
        assert initial.json()["model"]["api_key_set"] is False

        response = client.put(
            "/api/settings",
            json={
                "model": {
                    "base_url": "http://provider.test/v1/",
                    "api_key": "sk-1234567890",
                    "model": "qwen3-coder",
                    "timeout_seconds": 12,
                }
            },
        )

        assert response.status_code == 200
        payload = response.json()["model"]
        assert payload["base_url"] == "http://provider.test/v1"
        assert payload["model"] == "qwen3-coder"
        assert payload["api_key_set"] is True
        assert payload["api_key_preview"] == "sk-1...7890"


def test_settings_api_allows_browser_preflight(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        response = client.options(
            "/api/settings",
            headers={
                "Origin": "http://127.0.0.1:5173",
                "Access-Control-Request-Method": "PUT",
                "Access-Control-Request-Headers": "content-type",
            },
        )

        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:5173"
        assert "PUT" in response.headers["access-control-allow-methods"]


def test_settings_api_keeps_existing_api_key_when_omitted(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    with TestClient(app) as client:
        client.put(
            "/api/settings",
            json={
                "model": {
                    "base_url": "http://provider.test/v1",
                    "api_key": "sk-1234567890",
                    "model": "qwen3-coder",
                }
            },
        )

        response = client.put(
            "/api/settings",
            json={
                "model": {
                    "base_url": "http://provider.test/v2",
                    "model": "qwen3-coder-plus",
                }
            },
        )

    payload = response.json()["model"]
    assert payload["base_url"] == "http://provider.test/v2"
    assert payload["model"] == "qwen3-coder-plus"
    assert payload["api_key_set"] is True
    assert payload["api_key_preview"] == "sk-1...7890"
