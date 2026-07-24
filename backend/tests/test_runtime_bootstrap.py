from __future__ import annotations

import importlib
import threading
import time

from fastapi.testclient import TestClient

from backend.app.agent.checkpoint_runtime import CheckpointRuntimeState
from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.mcp.manager import McpManager
from backend.app.runtime import DesktopAgentRuntime
from backend.app.services.default_model_warmup import DefaultModelWarmupResult


def test_create_app_mounts_desktop_runtime_and_keeps_health(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))

    assert isinstance(app.state.runtime, DesktopAgentRuntime)
    assert app.state.runtime.protocol == "kt-agentloop"
    assert app.state.runtime.settings is app.state.settings
    assert app.state.runtime.database is app.state.database
    assert app.state.runtime.repositories is app.state.repositories
    assert app.state.runtime.chat_service is app.state.chat_service
    assert app.state.runtime.chat_stream_manager is app.state.chat_stream_manager
    assert app.state.runtime.tool_registry is app.state.tool_registry
    assert isinstance(app.state.mcp_manager, McpManager)
    assert hasattr(app.state, "agent_runtime_provider")
    assert not hasattr(app.state, "agent_runner")
    assert "read_file" in app.state.runtime.tool_registry.names()
    assert "update_plan" in app.state.runtime.tool_registry.names()
    assert "domain_events" in app.state.runtime.capabilities
    assert "message_events" in app.state.runtime.capabilities
    assert hasattr(app.state, "file_change_hub")

    response = TestClient(app).get("/api/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_application_lifespan_closes_file_change_hub(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    close_calls = 0

    async def close_file_change_hub() -> None:
        nonlocal close_calls
        close_calls += 1

    app.state.file_change_hub.close = close_file_change_hub

    with TestClient(app) as client:
        assert client.get("/api/health").status_code == 200

    assert close_calls == 1


def test_application_lifespan_owns_one_checkpoint_runtime_and_closes_it(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))

    with TestClient(app) as client:
        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["checkpoint_status"] == "ready"
        assert health.json()["checkpoint_ready"] is True
        assert app.state.checkpointer is app.state.checkpoint_runtime.require_store()
        assert app.state.checkpoint_runtime.connection is not None

    assert app.state.checkpoint_runtime.connection is None
    assert app.state.checkpoint_runtime.status_payload()["state"] == "closing"


def test_checkpoint_dependent_http_endpoint_is_gated_while_migrating(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))

    with TestClient(app) as client:
        app.state.checkpoint_runtime.transition(CheckpointRuntimeState.COPYING)
        response = client.post("/api/sessions/session-1/fork", json={})
        health = client.get("/api/health")

    assert response.status_code == 503
    assert response.headers["retry-after"] == "1"
    assert response.json()["detail"] == {
        "code": "checkpoint_runtime_unavailable",
        "message": "会话存储正在准备中，请稍后重试",
        "details": {
            "checkpoint_state": "copying",
            "retryable": True,
        },
        "status": 503,
    }
    assert health.status_code == 200
    assert health.json()["checkpoint_status"] == "copying"


def test_checkpoint_gate_rearms_stale_runtime_after_persisted_completion(
    tmp_path,
) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))

    with TestClient(app) as client:
        app.state.checkpoint_runtime.transition(
            CheckpointRuntimeState.MIGRATION_REQUIRED
        )
        response = client.post("/api/sessions/missing/fork", json={})
        app.state.checkpoint_runtime.transition(
            CheckpointRuntimeState.MIGRATION_REQUIRED
        )
        with client.websocket_connect("/agent-base/ws/chat") as websocket:
            websocket.send_json({"action": "ping"})
            pong = websocket.receive_json()
        health = client.get("/api/health")

    assert response.status_code != 503
    assert pong["action"] == "pong"
    assert health.json()["checkpoint_status"] == "ready"
    assert health.json()["checkpoint_ready"] is True


def test_default_model_warmup_runs_inside_background_agent_warmup(
    tmp_path,
    monkeypatch,
) -> None:
    import backend.app.services.default_model_warmup as warmup_module

    started = threading.Event()
    release = threading.Event()

    def blocking_warmup(*_args, **_kwargs) -> DefaultModelWarmupResult:
        started.set()
        release.wait(timeout=5)
        return DefaultModelWarmupResult(warmed_scopes=(), skipped_scopes=())

    monkeypatch.setattr(warmup_module, "warmup_default_models", blocking_warmup)

    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    assert started.is_set() is False

    with TestClient(app) as client:
        assert started.wait(timeout=2)
        try:
            response = client.get("/api/health")
            assert response.status_code == 200
            assert response.json()["agent_status"] == "warming"
        finally:
            release.set()

        deadline = time.monotonic() + 2
        while client.get("/api/health").json()["agent_status"] != "ready":
            assert time.monotonic() < deadline
            time.sleep(0.01)


def test_create_app_exposes_disabled_mcp_manager_without_client_startup(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data", mcp_enabled=False))

    assert app.state.mcp_enabled is False
    assert app.state.mcp_runtime_status == "disabled"
    assert isinstance(app.state.mcp_manager, McpManager)
    assert app.state.mcp_manager.status().to_dict() == {
        "enabled": False,
        "runtime_status": "disabled",
        "started": False,
        "active_client_count": 0,
    }

    with TestClient(app) as client:
        response = client.get("/api/health")
        assert app.state.mcp_manager.started is True

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert app.state.mcp_manager.started is False


def test_create_app_mounts_e2e_model_transport_only_when_enabled(tmp_path) -> None:
    disabled_app = create_app(AppSettings(data_dir=tmp_path / "disabled"))
    enabled_app = create_app(
        AppSettings(
            data_dir=tmp_path / "enabled",
            e2e_model_transport=True,
            e2e_stream_delay_ms=0,
        )
    )

    assert not hasattr(disabled_app.state, "model_http_transport")
    assert hasattr(enabled_app.state, "model_http_transport")


def test_new_backend_packages_are_importable_without_old_runtime_modules() -> None:
    for module_name in [
        "backend.app.agent",
        "backend.app.events",
        "backend.app.runtime",
        "backend.app.services",
    ]:
        importlib.import_module(module_name)

    for removed_module in [
        "backend.app.agent.thread_manager",
        "backend.app.agent.turn_runner",
        "backend.app.agent.runtime",
        "backend.app.protocol.thread",
        "backend.app.protocol.turn",
    ]:
        try:
            importlib.import_module(removed_module)
        except ModuleNotFoundError:
            continue
        raise AssertionError(f"旧后端模块不应可导入: {removed_module}")
