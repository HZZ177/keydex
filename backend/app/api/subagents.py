from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field

from backend.app.api.dependencies import get_repositories, get_subagent_runtime
from backend.app.services.session_service import (
    GetHistoryRequest,
    SessionNotFoundError,
    SessionService,
    SessionValidationError,
)
from backend.app.storage import StorageRepositories
from backend.app.subagents.errors import SubagentError, SubagentErrorCode
from backend.app.subagents.models import (
    SubagentHandle,
    SubagentInstanceSummary,
    SubagentRunSnapshot,
)
from backend.app.subagents.runtime import SessionBackedSubagentRuntime

router = APIRouter(
    prefix="/api/sessions/{parent_session_id}/subagents",
    tags=["subagents"],
)
RepositoriesDep = Depends(get_repositories)
SubagentRuntimeDep = Depends(get_subagent_runtime)


class SubagentRunListResponse(BaseModel):
    list: list[SubagentRunSnapshot]


class SubagentRunResponse(BaseModel):
    run: SubagentRunSnapshot


class SubagentSessionResponse(BaseModel):
    session: dict
    history: dict


class SubagentToolDetailResponse(BaseModel):
    detail: dict


class SubagentControlRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subagent_id: str = Field(min_length=1)
    child_session_id: str = Field(min_length=1)
    expected_version: int = Field(ge=1)


class SubagentSteerRequest(SubagentControlRequest):
    message: str = Field(min_length=1)


class SubagentCancelRequest(SubagentControlRequest):
    reason: str | None = None


class SubagentResumeRequest(SubagentControlRequest):
    task: str = Field(min_length=1)


class SubagentControlRunResponse(BaseModel):
    run: SubagentRunSnapshot


class SubagentResumeResponse(BaseModel):
    handle: SubagentHandle


class SubagentCloseResponse(BaseModel):
    instance: SubagentInstanceSummary


@router.get("/runs", response_model=SubagentRunListResponse)
async def list_subagent_runs(
    parent_session_id: str,
    repositories: StorageRepositories = RepositoriesDep,
    runtime: SessionBackedSubagentRuntime = SubagentRuntimeDep,
) -> SubagentRunListResponse:
    _require_visible_workspace_parent(repositories, parent_session_id)
    return SubagentRunListResponse(
        list=await runtime.list_by_parent(parent_session_id),
    )


@router.get("/runs/{run_id}", response_model=SubagentRunResponse)
async def get_subagent_run(
    parent_session_id: str,
    run_id: str,
    repositories: StorageRepositories = RepositoriesDep,
    runtime: SessionBackedSubagentRuntime = SubagentRuntimeDep,
) -> SubagentRunResponse:
    _require_visible_workspace_parent(repositories, parent_session_id)
    try:
        run = await runtime.get_run(run_id, parent_session_id=parent_session_id)
    except SubagentError as exc:
        raise _subagent_http_error(exc) from exc
    return SubagentRunResponse(run=run)


@router.get("/runs/{run_id}/session", response_model=SubagentSessionResponse)
async def get_subagent_session(
    parent_session_id: str,
    run_id: str,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    order: str = "desc",
    cursor: str | None = None,
    direction: str = "older",
    all_turns: bool = False,
    repositories: StorageRepositories = RepositoriesDep,
    runtime: SessionBackedSubagentRuntime = SubagentRuntimeDep,
) -> SubagentSessionResponse:
    _require_visible_workspace_parent(repositories, parent_session_id)
    try:
        run = await runtime.get_run(run_id, parent_session_id=parent_session_id)
        service = _session_service(repositories)
        session = service.get_controlled_subagent_session_detail(
            parent_session_id=parent_session_id,
            run_id=run_id,
            child_session_id=run.child_session_id,
        )
        history = service.get_controlled_subagent_history(
            GetHistoryRequest(
                session_id=run.child_session_id,
                page=page,
                page_size=page_size,
                order=order,
                cursor=cursor,
                direction=direction,
                all_turns=all_turns,
            ),
            parent_session_id=parent_session_id,
            run_id=run_id,
            child_session_id=run.child_session_id,
        )
    except SubagentError as exc:
        raise _subagent_http_error(exc) from exc
    except SessionNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "CHILD_SESSION_ACCESS_DENIED", "message": str(exc), "details": {}},
        ) from exc
    if hasattr(repositories, "pending_inputs"):
        history["pending_inputs"] = [
            record.to_dict()
            for record in repositories.pending_inputs.list_active_by_session(run.child_session_id)
        ]
    return SubagentSessionResponse(session=session, history=history)


@router.get(
    "/runs/{run_id}/session/tool-details",
    response_model=SubagentToolDetailResponse,
)
async def get_subagent_session_tool_details(
    parent_session_id: str,
    run_id: str,
    start_event_id: str | None = None,
    end_event_id: str | None = None,
    repositories: StorageRepositories = RepositoriesDep,
    runtime: SessionBackedSubagentRuntime = SubagentRuntimeDep,
) -> SubagentToolDetailResponse:
    _require_visible_workspace_parent(repositories, parent_session_id)
    try:
        run = await runtime.get_run(run_id, parent_session_id=parent_session_id)
        detail = _session_service(repositories).get_controlled_subagent_tool_detail(
            parent_session_id=parent_session_id,
            run_id=run_id,
            child_session_id=run.child_session_id,
            start_event_id=start_event_id,
            end_event_id=end_event_id,
        )
    except SubagentError as exc:
        raise _subagent_http_error(exc) from exc
    except SessionNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "CHILD_SESSION_ACCESS_DENIED", "message": str(exc), "details": {}},
        ) from exc
    except SessionValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "SUBAGENT_TOOL_DETAIL_INVALID", "message": str(exc), "details": {}},
        ) from exc
    return SubagentToolDetailResponse(detail=detail)


@router.post("/runs/{run_id}/steer", response_model=SubagentControlRunResponse)
async def steer_subagent_run(
    parent_session_id: str,
    run_id: str,
    payload: SubagentSteerRequest,
    repositories: StorageRepositories = RepositoriesDep,
    runtime: SessionBackedSubagentRuntime = SubagentRuntimeDep,
) -> SubagentControlRunResponse:
    _require_visible_workspace_parent(repositories, parent_session_id)
    try:
        require_control_identity(
            await runtime.get_run(run_id, parent_session_id=parent_session_id),
            payload,
        )
        run = await runtime.steer(
            run_id,
            payload.child_session_id,
            payload.message,
            parent_session_id=parent_session_id,
            expected_version=payload.expected_version,
        )
    except SubagentError as exc:
        raise _subagent_http_error(exc) from exc
    return SubagentControlRunResponse(run=run)


@router.post("/runs/{run_id}/cancel", response_model=SubagentControlRunResponse)
async def cancel_subagent_run(
    parent_session_id: str,
    run_id: str,
    payload: SubagentCancelRequest,
    repositories: StorageRepositories = RepositoriesDep,
    runtime: SessionBackedSubagentRuntime = SubagentRuntimeDep,
) -> SubagentControlRunResponse:
    _require_visible_workspace_parent(repositories, parent_session_id)
    try:
        require_control_identity(
            await runtime.get_run(run_id, parent_session_id=parent_session_id),
            payload,
        )
        run = await runtime.cancel(
            run_id,
            reason=payload.reason or "user",
            parent_session_id=parent_session_id,
            child_session_id=payload.child_session_id,
            expected_version=payload.expected_version,
        )
    except SubagentError as exc:
        raise _subagent_http_error(exc) from exc
    return SubagentControlRunResponse(run=run)


@router.post("/runs/{run_id}/resume", response_model=SubagentResumeResponse)
async def resume_subagent_run(
    parent_session_id: str,
    run_id: str,
    payload: SubagentResumeRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> SubagentResumeResponse:
    _require_visible_workspace_parent(repositories, parent_session_id)
    raise _user_subagent_control_forbidden("resume")


@router.post("/runs/{run_id}/close", response_model=SubagentCloseResponse)
async def close_subagent_instance(
    parent_session_id: str,
    run_id: str,
    payload: SubagentControlRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> SubagentCloseResponse:
    _require_visible_workspace_parent(repositories, parent_session_id)
    raise _user_subagent_control_forbidden("close")


def _user_subagent_control_forbidden(action: str) -> HTTPException:
    if action == "resume":
        code = "SUBAGENT_USER_RELAUNCH_FORBIDDEN"
        message = "Only the main Agent can delegate a new Sub-Agent Run"
    else:
        code = "SUBAGENT_USER_CLOSE_FORBIDDEN"
        message = "Users cannot close a Sub-Agent instance"
    return HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={"code": code, "message": message, "details": {"action": action}},
    )


def require_visible_workspace_parent(
    repositories: StorageRepositories,
    parent_session_id: str,
) -> None:
    _require_visible_workspace_parent(repositories, parent_session_id)


def _require_visible_workspace_parent(
    repositories: StorageRepositories,
    parent_session_id: str,
) -> None:
    parent = repositories.sessions.get(str(parent_session_id or "").strip())
    if (
        parent is None
        or parent.session_type != "workspace"
        or parent.visibility != "visible"
        or parent.agent_kind != "main"
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "SUBAGENT_PARENT_INVALID",
                "message": "visible Workspace parent Session not found",
                "details": {},
            },
        )


def _subagent_http_error(exc: SubagentError) -> HTTPException:
    status_code = (
        status.HTTP_404_NOT_FOUND
        if exc.code.value in {"RUN_NOT_FOUND", "SUBAGENT_NOT_FOUND"}
        else status.HTTP_409_CONFLICT
    )
    return HTTPException(
        status_code=status_code,
        detail={
            "code": exc.code.value,
            "message": exc.message,
            "details": exc.details,
        },
    )


def require_control_identity(
    run: SubagentRunSnapshot,
    payload: SubagentControlRequest,
) -> None:
    if run.subagent_id != payload.subagent_id or run.child_session_id != payload.child_session_id:
        raise SubagentError(
            code=SubagentErrorCode.CHILD_SESSION_ACCESS_DENIED,
            message="Sub-Agent control identity does not match the addressed Run",
            details={"run_id": run.run_id},
        )


def _session_service(repositories: StorageRepositories) -> SessionService:
    return SessionService(
        repositories.sessions,
        repositories.message_events,
        repositories.workspaces,
        repositories.session_forks,
    )
