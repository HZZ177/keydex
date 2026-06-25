from __future__ import annotations

import sys
from pathlib import Path

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.agent import AgentRunner
from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.api.approvals import router as approvals_router
from backend.app.api.health import router as health_router
from backend.app.api.model_providers import router as model_providers_router
from backend.app.api.models import router as models_router
from backend.app.api.sessions import router as sessions_router
from backend.app.api.settings import load_effective_model_settings
from backend.app.api.settings import router as settings_router
from backend.app.api.usage import router as usage_router
from backend.app.api.websocket import router as websocket_router
from backend.app.api.workspace import router as workspace_router
from backend.app.api.workspaces import router as workspaces_router
from backend.app.core.config import AppSettings, get_settings
from backend.app.core.exception_handler import register_exception_handlers
from backend.app.core.logger import configure_logging, logger
from backend.app.core.middleware import RequestLoggingMiddleware
from backend.app.model import OpenAICompatibleProviderClient
from backend.app.model.e2e_transport import create_e2e_model_transport
from backend.app.runtime import create_desktop_runtime
from backend.app.services import ChatService, ChatStreamManager
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools import create_default_tool_registry


def create_app(settings: AppSettings | None = None) -> FastAPI:
    resolved_settings = settings or get_settings()
    configure_logging(resolved_settings.log_level, log_dir=resolved_settings.data_dir / "logs")

    app = FastAPI(
        title=resolved_settings.app_name,
        version=resolved_settings.version,
    )
    register_exception_handlers(app)
    app.add_middleware(RequestLoggingMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://127.0.0.1:5173",
            "http://localhost:5173",
            "tauri://localhost",
            "http://tauri.localhost",
        ],
        allow_origin_regex=r"^https?://(127\.0\.0\.1|localhost):\d+$",
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )
    app.state.settings = resolved_settings
    app.state.database = init_database(
        resolved_settings.data_dir / "app.db",
        default_workspace_root=resolved_settings.workspace_root,
    )
    app.state.repositories = StorageRepositories(app.state.database)
    app.state.checkpointer = SQLiteCheckpointSaver(app.state.database)
    if resolved_settings.e2e_model_transport:
        app.state.model_http_transport = create_e2e_model_transport(
            delay_ms=resolved_settings.e2e_stream_delay_ms
        )
    app.state.model_provider_client_provider = lambda: OpenAICompatibleProviderClient(
        load_effective_model_settings(app.state.repositories),
        transport=getattr(app.state, "model_http_transport", None),
    )
    app.state.tool_registry = create_default_tool_registry()
    app.state.agent_runner = AgentRunner(
        model_settings_provider=lambda: load_effective_model_settings(app.state.repositories),
        model_http_transport_provider=lambda: getattr(app.state, "model_http_transport", None),
        checkpointer=app.state.checkpointer,
        tool_registry=app.state.tool_registry,
    )
    app.state.chat_service = ChatService(
        settings=resolved_settings,
        repositories=app.state.repositories,
        agent_runner=app.state.agent_runner,
    )
    app.state.chat_stream_manager = ChatStreamManager(app.state.chat_service)
    app.state.runtime = create_desktop_runtime(
        settings=resolved_settings,
        database=app.state.database,
        repositories=app.state.repositories,
        model_provider_client_provider=app.state.model_provider_client_provider,
        tool_registry=app.state.tool_registry,
        chat_service=app.state.chat_service,
        chat_stream_manager=app.state.chat_stream_manager,
    )
    logger.info(
        "[App] 后端应用创建完成 | "
        f"host={resolved_settings.host} | port={resolved_settings.port} | "
        f"data_dir={resolved_settings.data_dir} | "
        f"workspace_root={resolved_settings.workspace_root} | "
        f"protocol_version={resolved_settings.protocol_version}"
    )
    app.include_router(health_router)
    app.include_router(approvals_router)
    app.include_router(settings_router)
    app.include_router(model_providers_router)
    app.include_router(models_router)
    app.include_router(sessions_router)
    app.include_router(usage_router)
    app.include_router(workspaces_router)
    app.include_router(workspace_router)
    app.include_router(websocket_router)
    return app


app = create_app()


def main() -> None:
    import uvicorn

    settings = get_settings()
    uvicorn.run(
        "backend.app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.reload,
        log_level=settings.log_level.lower(),
        access_log=False,
        log_config=None,
    )


if __name__ == "__main__":
    main()
