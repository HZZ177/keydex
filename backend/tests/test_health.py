from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_app_import_and_health_response(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["version"] == "0.1.0"
    assert response.json()["protocol_version"] == "2026-06-15"
    assert response.json()["agent_status"] in {"idle", "warming", "ready", "failed"}


def test_health_reports_agent_warmup_failure_without_failing_backend(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))

    class FailedAgentRuntime:
        def status_payload(self):
            return {
                "status": "failed",
                "error": "langchain import failed",
                "duration_ms": 123,
            }

    app.state.agent_runtime_provider = FailedAgentRuntime()
    client = TestClient(app)

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.json()["agent_status"] == "failed"
    assert response.json()["agent_error"] == "langchain import failed"
    assert response.json()["agent_warmup_duration_ms"] == 123


def test_agent_warmup_failure_does_not_break_non_agent_api(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))

    class FailedAgentRuntime:
        def status_payload(self):
            return {
                "status": "failed",
                "error": "langchain import failed",
                "duration_ms": 123,
            }

    app.state.agent_runtime_provider = FailedAgentRuntime()
    client = TestClient(app)

    response = client.get("/api/usage/summary")

    assert response.status_code == 200
    assert response.json()["request_count"] == 0


def test_unknown_api_path_returns_404(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))

    response = client.get("/api/missing")

    assert response.status_code == 404
