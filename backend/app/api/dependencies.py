from fastapi import Request

from backend.app.core.config import AppSettings
from backend.app.services.thread_task_runtime import ThreadTaskRuntime
from backend.app.services.thread_task_service import ThreadTaskService
from backend.app.storage import StorageRepositories
from backend.app.subagents.runtime import SessionBackedSubagentRuntime


def get_repositories(request: Request) -> StorageRepositories:
    return request.app.state.repositories


def get_app_settings(request: Request) -> AppSettings:
    return request.app.state.settings


def get_thread_task_service(request: Request) -> ThreadTaskService:
    service = getattr(request.app.state, "thread_task_service", None)
    if isinstance(service, ThreadTaskService):
        return service
    service = ThreadTaskService(get_repositories(request))
    request.app.state.thread_task_service = service
    return service


def get_thread_task_runtime(request: Request) -> ThreadTaskRuntime:
    runtime = getattr(request.app.state, "thread_task_runtime", None)
    if isinstance(runtime, ThreadTaskRuntime):
        return runtime
    raise RuntimeError("thread_task_runtime is not initialized")


def get_subagent_runtime(request: Request) -> SessionBackedSubagentRuntime:
    runtime = getattr(request.app.state, "subagent_runtime", None)
    if isinstance(runtime, SessionBackedSubagentRuntime):
        return runtime
    raise RuntimeError("subagent_runtime is not initialized")
