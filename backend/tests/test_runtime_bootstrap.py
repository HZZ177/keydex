from __future__ import annotations

import importlib

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.mcp.manager import McpManager
from backend.app.runtime import DesktopAgentRuntime


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
