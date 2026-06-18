from fastapi.testclient import TestClient

from backend.app.main import create_app


def test_app_import_and_health_response() -> None:
    client = TestClient(create_app())

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "version": "0.1.0",
        "protocol_version": "2026-06-15",
    }


def test_unknown_api_path_returns_404() -> None:
    client = TestClient(create_app())

    response = client.get("/api/missing")

    assert response.status_code == 404

