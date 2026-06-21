from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.security import WorkspacePathError, resolve_workspace_path
from backend.app.storage import SessionRecord, WorkspaceRecord


class WorkspaceServiceError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class WorkspaceNotFoundError(WorkspaceServiceError):
    def __init__(self, workspace_id: str) -> None:
        super().__init__(
            "workspace_not_found",
            f"工作区不存在: {workspace_id}",
            {"workspace_id": workspace_id},
        )


class WorkspaceDeletedError(WorkspaceServiceError):
    def __init__(self, workspace_id: str) -> None:
        super().__init__(
            "workspace_deleted",
            f"工作区已删除: {workspace_id}",
            {"workspace_id": workspace_id},
        )


@dataclass(frozen=True)
class WorkspaceRuntimeContext:
    workspace_id: str
    cwd: Path
    workspace_roots: list[Path]
    workspace: WorkspaceRecord


class WorkspaceService:
    def __init__(self, workspaces_repository) -> None:
        self._workspaces = workspaces_repository

    def create_workspace(
        self,
        *,
        root_path: str | Path,
        name: str | None = None,
        workspace_id: str | None = None,
    ) -> dict[str, Any]:
        try:
            record = self._workspaces.create(
                workspace_id=workspace_id or new_id(),
                root_path=root_path,
                name=name,
            )
        except WorkspacePathError as exc:
            raise self._path_error(exc) from exc
        logger.info(
            f"[WorkspaceService] 创建或复用工作区 | workspace_id={record.id} | "
            f"root={record.root_path}"
        )
        return self.serialize_workspace(record)

    def list_workspaces(self, *, include_deleted: bool = False) -> dict[str, Any]:
        records = self._workspaces.list(include_deleted=include_deleted)
        return {
            "list": [self.serialize_workspace(record) for record in records],
            "total": len(records),
        }

    def get_workspace(self, workspace_id: str) -> dict[str, Any]:
        return self.serialize_workspace(self.require_workspace(workspace_id))

    def rename_workspace(self, workspace_id: str, name: str) -> dict[str, Any]:
        cleaned = name.strip()
        if not cleaned:
            raise WorkspaceServiceError(
                "workspace_name_empty",
                "工作区名称不能为空",
                {"workspace_id": workspace_id},
            )
        self.require_workspace(workspace_id)
        record = self._workspaces.update(workspace_id, name=cleaned)
        if record is None:
            raise WorkspaceNotFoundError(workspace_id)
        return self.serialize_workspace(record)

    def delete_workspace(self, workspace_id: str) -> dict[str, Any]:
        self.require_workspace(workspace_id)
        record = self._workspaces.soft_delete(workspace_id)
        if record is None:
            raise WorkspaceNotFoundError(workspace_id)
        return self.serialize_workspace(record)

    def touch_workspace(self, workspace_id: str) -> dict[str, Any]:
        self.require_workspace(workspace_id)
        record = self._workspaces.touch(workspace_id)
        if record is None:
            raise WorkspaceNotFoundError(workspace_id)
        return self.serialize_workspace(record)

    def require_workspace(self, workspace_id: str) -> WorkspaceRecord:
        record = self._workspaces.get(workspace_id)
        if record is not None:
            return record
        deleted = self._workspaces.get(workspace_id, include_deleted=True)
        if deleted is not None:
            raise WorkspaceDeletedError(workspace_id)
        raise WorkspaceNotFoundError(workspace_id)

    def runtime_context_for_session(self, session: SessionRecord) -> WorkspaceRuntimeContext:
        if session.session_type != "workspace":
            raise WorkspaceServiceError(
                "session_not_workspace",
                "纯聊天会话没有工作区上下文",
                {"session_id": session.id, "session_type": session.session_type},
            )
        if not session.workspace_id:
            raise WorkspaceServiceError(
                "session_workspace_missing",
                "项目会话缺少绑定工作区",
                {"session_id": session.id},
            )
        workspace = self.require_workspace(session.workspace_id)
        cwd = Path(session.cwd or workspace.root_path).expanduser().resolve()
        try:
            resolved_cwd = resolve_workspace_path(
                cwd,
                cwd=workspace.root_path,
                workspace_roots=[workspace.root_path],
            )
        except WorkspacePathError as exc:
            raise WorkspaceServiceError(
                "session_cwd_forbidden",
                "会话运行目录不在绑定工作区内",
                {"session_id": session.id, "cwd": str(cwd), "workspace_id": workspace.id},
            ) from exc
        if not resolved_cwd.exists():
            raise WorkspaceServiceError(
                "session_cwd_not_found",
                "会话运行目录不存在",
                {"session_id": session.id, "cwd": str(resolved_cwd)},
            )
        if not resolved_cwd.is_dir():
            raise WorkspaceServiceError(
                "session_cwd_not_directory",
                "会话运行目录不是目录",
                {"session_id": session.id, "cwd": str(resolved_cwd)},
            )
        roots = [
            Path(root).expanduser().resolve()
            for root in (session.workspace_roots or [workspace.root_path])
        ]
        return WorkspaceRuntimeContext(
            workspace_id=workspace.id,
            cwd=resolved_cwd,
            workspace_roots=roots,
            workspace=workspace,
        )

    @staticmethod
    def serialize_workspace(record: WorkspaceRecord) -> dict[str, Any]:
        return {
            "id": record.id,
            "name": record.name,
            "root_path": record.root_path,
            "normalized_root_path": record.normalized_root_path,
            "type": record.type,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "last_opened_at": record.last_opened_at,
            "is_deleted": record.is_deleted,
        }

    @staticmethod
    def _path_error(error: WorkspacePathError) -> WorkspaceServiceError:
        message = str(error)
        if "不能为空" in message:
            return WorkspaceServiceError("workspace_path_empty", "工作区路径不能为空")
        if "不存在" in message:
            return WorkspaceServiceError("workspace_path_not_found", message)
        if "不是目录" in message:
            return WorkspaceServiceError("workspace_not_directory", message)
        return WorkspaceServiceError("workspace_path_invalid", message)
