from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from backend.app.api.dependencies import get_thread_task_runtime, get_thread_task_service
from backend.app.services.thread_task_runtime import ThreadTaskRuntime
from backend.app.services.thread_task_service import (
    ThreadTaskConflictError,
    ThreadTaskNotFoundError,
    ThreadTaskService,
    ThreadTaskServiceError,
    ThreadTaskSessionNotFoundError,
    ThreadTaskTransitionError,
    ThreadTaskValidationError,
)

router = APIRouter(prefix="/api/sessions/{session_id}/tasks", tags=["thread-tasks"])
ThreadTaskServiceDep = Depends(get_thread_task_service)
ThreadTaskRuntimeDep = Depends(get_thread_task_runtime)


class CreateThreadTaskRequest(BaseModel):
    type: Literal["goal"] = "goal"
    objective: str
    title: str | None = None
    metadata: dict[str, Any] | None = None


class UpdateThreadTaskRequest(BaseModel):
    objective: str | None = None
    title: str | None = None
    status: Literal["active", "paused", "cancelled"] | None = None
    metadata: dict[str, Any] | None = None


class ThreadTaskResponse(BaseModel):
    task: dict[str, Any]


class ThreadTaskListResponse(BaseModel):
    list: list[dict[str, Any]]


class ThreadTaskRunsResponse(BaseModel):
    list: list[dict[str, Any]]


@router.get("", response_model=ThreadTaskListResponse)
def list_thread_tasks(
    session_id: str,
    service: ThreadTaskService = ThreadTaskServiceDep,
) -> ThreadTaskListResponse:
    try:
        return ThreadTaskListResponse(list=service.list_tasks(session_id))
    except ThreadTaskServiceError as exc:
        raise _service_error(exc) from exc


@router.post("", response_model=ThreadTaskResponse)
def create_thread_task(
    session_id: str,
    payload: CreateThreadTaskRequest,
    service: ThreadTaskService = ThreadTaskServiceDep,
) -> ThreadTaskResponse:
    try:
        task = service.create_task(
            session_id=session_id,
            type=payload.type,
            title=payload.title,
            objective=payload.objective,
            metadata=payload.metadata,
        )
    except ThreadTaskServiceError as exc:
        raise _service_error(exc) from exc
    return ThreadTaskResponse(task=task)


@router.patch("/{task_id}", response_model=ThreadTaskResponse)
async def update_thread_task(
    session_id: str,
    task_id: str,
    payload: UpdateThreadTaskRequest,
    service: ThreadTaskService = ThreadTaskServiceDep,
    runtime: ThreadTaskRuntime = ThreadTaskRuntimeDep,
) -> ThreadTaskResponse:
    kwargs: dict[str, Any] = {}
    if "objective" in payload.model_fields_set:
        kwargs["objective"] = payload.objective
    if "title" in payload.model_fields_set:
        kwargs["title"] = payload.title
    if "metadata" in payload.model_fields_set:
        kwargs["metadata"] = payload.metadata
    if "status" in payload.model_fields_set:
        kwargs["status"] = payload.status
    try:
        task = service.update_task_from_user(
            session_id=session_id,
            task_id=task_id,
            **kwargs,
        )
    except ThreadTaskServiceError as exc:
        raise _service_error(exc) from exc
    if payload.status == "active" and task.get("status") == "active":
        await runtime.continue_if_idle(session_id, reason="user_resume")
    return ThreadTaskResponse(task=task)


@router.delete("/{task_id}", response_model=ThreadTaskResponse)
def delete_thread_task(
    session_id: str,
    task_id: str,
    service: ThreadTaskService = ThreadTaskServiceDep,
) -> ThreadTaskResponse:
    try:
        return ThreadTaskResponse(task=service.delete_task(session_id=session_id, task_id=task_id))
    except ThreadTaskServiceError as exc:
        raise _service_error(exc) from exc


@router.get("/{task_id}/runs", response_model=ThreadTaskRunsResponse)
def list_thread_task_runs(
    session_id: str,
    task_id: str,
    service: ThreadTaskService = ThreadTaskServiceDep,
) -> ThreadTaskRunsResponse:
    try:
        return ThreadTaskRunsResponse(list=service.list_runs(session_id, task_id))
    except ThreadTaskServiceError as exc:
        raise _service_error(exc) from exc


def _service_error(exc: ThreadTaskServiceError) -> HTTPException:
    if isinstance(exc, ThreadTaskSessionNotFoundError):
        status_code = status.HTTP_404_NOT_FOUND
        code = "session_not_found"
    elif isinstance(exc, ThreadTaskNotFoundError):
        status_code = status.HTTP_404_NOT_FOUND
        code = exc.code
    elif isinstance(exc, ThreadTaskConflictError):
        status_code = status.HTTP_409_CONFLICT
        code = exc.code
    elif isinstance(exc, (ThreadTaskValidationError, ThreadTaskTransitionError)):
        status_code = status.HTTP_400_BAD_REQUEST
        code = exc.code
    else:
        status_code = status.HTTP_400_BAD_REQUEST
        code = exc.code
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": str(exc), "details": {}},
    )
