from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status

from backend.app.api.dependencies import get_repositories
from backend.app.command_approval import (
    ApprovalService,
    CommandApprovalDecision,
    CommandApprovalError,
    approval_to_payload,
    load_command_settings,
)
from backend.app.core.config import AppSettings, get_settings
from backend.app.storage import StorageRepositories

router = APIRouter(prefix="/api/approvals", tags=["approvals"])
RepositoriesDep = Depends(get_repositories)
SettingsDep = Depends(get_settings)


class ResolveApprovalRequest(CommandApprovalDecision):
    user_id: str | None = None


@router.get("/{approval_id}", response_model=dict[str, Any])
async def get_approval(
    approval_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    record = repositories.command_approvals.get(approval_id)
    if record is None:
        raise _not_found()
    return approval_to_payload(record)


@router.post("/{approval_id}/decision", response_model=dict[str, Any])
async def resolve_approval(
    approval_id: str,
    payload: ResolveApprovalRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> dict[str, Any]:
    service = ApprovalService(repositories=repositories)
    try:
        record = await service.resolve(
            approval_id,
            CommandApprovalDecision(
                decision=payload.decision,
                trust_scope=payload.trust_scope,
                rule_match_type=payload.rule_match_type,
                reject_message=payload.reject_message,
            ),
            settings=load_command_settings(repositories),
            user_id=payload.user_id or settings.default_user_id,
        )
    except CommandApprovalError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_approval_decision", "message": str(exc), "details": {}},
        ) from exc
    approval = approval_to_payload(record)
    stream_manager = getattr(request.app.state, "chat_stream_manager", None)
    if stream_manager is not None:
        await stream_manager.broadcast(
            session_id=record.session_id,
            action="approval_resolved",
            data={
                "id": record.id,
                "approval_id": record.id,
                "session_id": record.session_id,
                "approval": approval,
            },
        )
    return approval


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "approval_not_found", "message": "审批请求不存在", "details": {}},
    )
