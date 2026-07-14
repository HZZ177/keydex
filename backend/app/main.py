from __future__ import annotations

import asyncio
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

if __package__ in {None, ""}:
    app_dir = Path(__file__).resolve().parent
    project_root = Path(__file__).resolve().parents[2]
    sys.path = [entry for entry in sys.path if Path(entry or ".").resolve() != app_dir]
    sys.path.insert(0, str(project_root))

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.app.annotations.api import router as annotations_router
from backend.app.api.approvals import router as approvals_router
from backend.app.api.archive import router as archive_router
from backend.app.api.attachments import router as attachments_router
from backend.app.api.health import router as health_router
from backend.app.api.local_preview import router as local_preview_router
from backend.app.api.mcp import router as mcp_router
from backend.app.api.model_providers import router as model_providers_router
from backend.app.api.models import router as models_router
from backend.app.api.sessions import router as sessions_router
from backend.app.api.settings import (
    load_effective_model_settings,
    load_general_settings,
    load_model_settings,
)
from backend.app.api.settings import router as settings_router
from backend.app.api.thread_tasks import router as thread_tasks_router
from backend.app.api.usage import router as usage_router
from backend.app.api.websocket import router as websocket_router
from backend.app.api.workspace import router as workspace_router
from backend.app.api.workspaces import router as workspaces_router
from backend.app.core.config import AppSettings, get_settings
from backend.app.core.exception_handler import register_exception_handlers
from backend.app.core.logger import configure_logging, logger
from backend.app.core.middleware import RequestLoggingMiddleware
from backend.app.keydex import KeydexWorkspaceRuntimeCache
from backend.app.keydex.watcher import KeydexWorkspaceWatcher
from backend.app.mcp.elicitation import McpElicitationService
from backend.app.mcp.manager import McpManager
from backend.app.mcp.sampling import McpOpenAICompatibleSamplingBridge, McpSamplingService
from backend.app.model import OpenAICompatibleProviderClient
from backend.app.model.e2e_transport import create_e2e_model_transport
from backend.app.runtime import create_desktop_runtime
from backend.app.services.agent_runtime import AgentRuntimeProvider, LazyChatService
from backend.app.services.chat_stream_manager import ChatStreamManager
from backend.app.services.file_change_hub import FileChangeHub
from backend.app.services.file_history_service import FileHistoryService
from backend.app.services.lifecycle_events import LifecycleEventPublisher
from backend.app.services.thread_task_elapsed_ticker import ThreadTaskElapsedTicker
from backend.app.services.thread_task_events import ThreadTaskEventPublisher
from backend.app.services.thread_task_runtime import ThreadTaskRuntime, ThreadTaskStateLocks
from backend.app.services.thread_task_service import ThreadTaskService
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools import create_default_tool_registry
from backend.app.tools.command_runtime import command_process_manager


def create_app(settings: AppSettings | None = None) -> FastAPI:
    create_started = time.perf_counter()
    resolved_settings = settings or get_settings()
    configure_logging(resolved_settings.log_level, log_dir=resolved_settings.data_dir / "logs")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async def run_warmup() -> None:
            try:
                await app.state.agent_runtime_provider.warmup_async()
            except Exception:
                pass

        await app.state.chat_stream_manager.recover_interrupted_sessions()
        await app.state.mcp_manager.start()
        if app.state.file_history_service.enabled:
            recovered = await asyncio.to_thread(
                app.state.file_history_service.recover_incomplete_operations
            )
            cleanup = await asyncio.to_thread(
                app.state.file_history_service.cleanup_history,
                orphan_grace_seconds=resolved_settings.file_history_orphan_grace_seconds,
            )
            logger.info(
                "[FileHistory] 启动恢复与清理完成 | "
                f"recovered_operations={len(recovered)} | "
                f"deleted_artifacts={len(cleanup['deleted_artifacts'])} | "
                f"expired_locks={cleanup['expired_locks']} | "
                f"usage_bytes={cleanup['usage_bytes']}"
            )
        warmup_task = asyncio.create_task(run_warmup())
        app.state.thread_task_elapsed_ticker.start()
        try:
            yield
        finally:
            try:
                await app.state.file_change_hub.close()
            except Exception as exc:
                logger.opt(exception=True).error(
                    f"[App] FileChangeHub 关闭失败 | error={exc}"
                )
            await app.state.thread_task_elapsed_ticker.stop()
            await app.state.mcp_manager.shutdown()
            if not warmup_task.done():
                warmup_task.cancel()
            killed = command_process_manager.shutdown()
            if killed:
                logger.info(f"[App] 已清理运行中 command 进程 | count={killed}")

    app = FastAPI(
        title=resolved_settings.app_name,
        version=resolved_settings.version,
        lifespan=lifespan,
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
    app.state.mcp_enabled = resolved_settings.mcp_enabled
    app.state.mcp_runtime_status = "enabled" if resolved_settings.mcp_enabled else "disabled"
    app.state.database = init_database(
        resolved_settings.data_dir / "app.db",
        default_workspace_root=resolved_settings.workspace_root,
    )
    app.state.repositories = StorageRepositories(app.state.database)
    stored_general = app.state.repositories.settings.get("general_settings", default={})
    general_settings = load_general_settings(app.state.repositories)
    stored_general = stored_general if isinstance(stored_general, dict) else {}
    app.state.file_history_service = FileHistoryService(
        app.state.repositories,
        data_dir=resolved_settings.data_dir,
        enabled=(
            general_settings.file_history_enabled
            if "file_history_enabled" in stored_general
            else resolved_settings.file_history_enabled
        ),
        max_storage_bytes=(
            general_settings.file_history_max_storage_bytes
            if "file_history_max_storage_bytes" in stored_general
            else resolved_settings.file_history_max_storage_bytes
        ),
        max_versions_per_file=(
            general_settings.file_history_max_versions_per_file
            if "file_history_max_versions_per_file" in stored_general
            else resolved_settings.file_history_max_versions_per_file
        ),
        max_rewind_points=(
            general_settings.file_history_max_rewind_points
            if "file_history_max_rewind_points" in stored_general
            else resolved_settings.file_history_max_rewind_points
        ),
        retention_days=(
            general_settings.file_history_retention_days
            if "file_history_retention_days" in stored_general
            else resolved_settings.file_history_retention_days
        ),
    )
    app.state.mcp_manager = McpManager(
        settings=resolved_settings,
        repositories=app.state.repositories,
    )
    app.state.thread_task_state_locks = ThreadTaskStateLocks()
    app.state.thread_task_service = ThreadTaskService(
        app.state.repositories,
        state_locks=app.state.thread_task_state_locks,
    )
    if resolved_settings.e2e_model_transport:
        app.state.model_http_transport = create_e2e_model_transport(
            delay_ms=resolved_settings.e2e_stream_delay_ms
        )
    app.state.model_provider_client_provider = lambda: OpenAICompatibleProviderClient(
        load_effective_model_settings(app.state.repositories),
        transport=getattr(app.state, "model_http_transport", None),
    )
    app.state.mcp_sampling_service = McpSamplingService(
        app.state.repositories,
        model_bridge=McpOpenAICompatibleSamplingBridge(
            app.state.repositories,
            transport_provider=lambda: getattr(app.state, "model_http_transport", None),
        ),
    )
    app.state.mcp_manager.sampling_service = app.state.mcp_sampling_service
    app.state.tool_registry = create_default_tool_registry()
    app.state.keydex_runtime_cache = KeydexWorkspaceRuntimeCache()

    def build_chat_service():
        from backend.app.agent import AgentRunner
        from backend.app.agent.checkpoint import SQLiteCheckpointSaver
        from backend.app.agent.runtime_settings import load_agent_runtime_settings
        from backend.app.services.chat_service import ChatService

        checkpointer = SQLiteCheckpointSaver(app.state.database)
        agent_runner = AgentRunner(
            model_settings_provider=lambda: load_model_settings(app.state.repositories),
            runtime_settings_provider=lambda: load_agent_runtime_settings(app.state.repositories),
            model_http_transport_provider=lambda: getattr(app.state, "model_http_transport", None),
            checkpointer=checkpointer,
            tool_registry=app.state.tool_registry,
        )
        app.state.checkpointer = checkpointer
        app.state.agent_runner = agent_runner
        return ChatService(
            settings=resolved_settings,
            repositories=app.state.repositories,
            agent_runner=agent_runner,
            keydex_runtime_cache=app.state.keydex_runtime_cache,
            thread_task_service=app.state.thread_task_service,
            mcp_manager=app.state.mcp_manager,
            file_history_service=app.state.file_history_service,
        )

    app.state.agent_runtime_provider = AgentRuntimeProvider(build_chat_service)
    app.state.chat_service = LazyChatService(
        app.state.agent_runtime_provider,
        repositories=app.state.repositories,
    )
    app.state.chat_stream_manager = ChatStreamManager(app.state.chat_service)
    app.state.lifecycle_event_publisher = LifecycleEventPublisher(app.state.chat_stream_manager)
    app.state.mcp_elicitation_service = McpElicitationService(
        app.state.repositories,
        broadcaster=lambda session_id, action, data: app.state.chat_stream_manager.broadcast(
            session_id=session_id,
            action=action,
            data=data,
        ),
    )
    app.state.mcp_manager.elicitation_service = app.state.mcp_elicitation_service
    app.state.thread_task_event_publisher = ThreadTaskEventPublisher(
        repositories=app.state.repositories,
        chat_stream_manager=app.state.chat_stream_manager,
    )
    app.state.thread_task_service.set_event_publisher(app.state.thread_task_event_publisher)
    app.state.thread_task_runtime = ThreadTaskRuntime(
        state_locks=app.state.thread_task_state_locks,
        repositories=app.state.repositories,
        thread_task_service=app.state.thread_task_service,
        chat_stream_manager=app.state.chat_stream_manager,
        event_publisher=app.state.thread_task_event_publisher,
    )
    app.state.thread_task_elapsed_ticker = ThreadTaskElapsedTicker(
        thread_task_service=app.state.thread_task_service,
        chat_stream_manager=app.state.chat_stream_manager,
    )
    app.state.chat_stream_manager.set_thread_task_runtime(app.state.thread_task_runtime)
    app.state.keydex_workspace_watcher = KeydexWorkspaceWatcher(
        runtime_cache=app.state.keydex_runtime_cache,
        notifier=lambda session_id, data: app.state.chat_stream_manager.broadcast(
            session_id=session_id,
            action="workspaceSkillsChanged",
            data=data,
        ),
    )
    app.state.file_change_hub = FileChangeHub()
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
        f"protocol_version={resolved_settings.protocol_version} | "
        f"duration_ms={int((time.perf_counter() - create_started) * 1000)}"
    )
    app.include_router(health_router)
    app.include_router(annotations_router)
    app.include_router(approvals_router)
    app.include_router(archive_router)
    app.include_router(attachments_router)
    app.include_router(local_preview_router)
    app.include_router(mcp_router)
    app.include_router(settings_router)
    app.include_router(model_providers_router)
    app.include_router(models_router)
    app.include_router(sessions_router)
    app.include_router(thread_tasks_router)
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
