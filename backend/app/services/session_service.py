from __future__ import annotations

import base64
import binascii
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.security import WorkspacePathError, resolve_workspace_path
from backend.app.services.message_event_service import MessageEventService
from backend.app.services.workspace_service import WorkspaceService, WorkspaceServiceError
from backend.app.storage import MessageEventRecord, SessionForkRecord, SessionRecord


class SessionServiceError(Exception):
    """Session service base error."""


class SessionNotFoundError(SessionServiceError):
    """Raised when a requested session does not exist."""


class SessionArchivedError(SessionServiceError):
    def __init__(self, session_id: str) -> None:
        super().__init__(f"会话已归档: {session_id}")
        self.code = "entity_archived"
        self.details = {"session_id": session_id}


class SessionValidationError(SessionServiceError):
    """Raised when a session mutation payload is invalid."""


@dataclass(frozen=True)
class ListSessionsRequest:
    user_id: str | None = None
    scene_id: str | None = None
    status: str | None = None
    session_tag: str | None = None
    workspace_id: str | None = None
    session_type: str | None = None
    title: str | None = None
    current_session_id: str | None = None
    page: int = 1
    page_size: int = 20


@dataclass(frozen=True)
class GetHistoryRequest:
    session_id: str
    turn_index: int | None = None
    page: int = 1
    page_size: int = 5
    order: str = "desc"
    cursor: str | None = None
    direction: str = "older"
    all_turns: bool = False


class SessionService:
    """Desktop session facade aligned with the kt session/history contract."""

    def __init__(
        self,
        sessions_repository,
        message_events_repository,
        workspaces_repository=None,
        session_forks_repository=None,
        message_event_service: MessageEventService | None = None,
    ) -> None:
        self._sessions = sessions_repository
        self._message_events = message_events_repository
        self._session_forks = session_forks_repository
        self._workspace_service = (
            WorkspaceService(workspaces_repository) if workspaces_repository is not None else None
        )
        self._message_event_service = message_event_service or MessageEventService(
            message_events_repository
        )

    def create_session(
        self,
        *,
        user_id: str,
        scene_id: str,
        title: str | None = None,
        session_tag: str = "chat",
        session_id: str | None = None,
        session_type: str = "chat",
        workspace_id: str | None = None,
        cwd: str | None = None,
        workspace_roots: list[str] | None = None,
        current_model_provider_id: str | None = None,
        current_model: str | None = None,
    ) -> dict[str, Any]:
        workspace_context = self._resolve_workspace_create_context(
            session_type=session_type,
            workspace_id=workspace_id,
            cwd=cwd,
            workspace_roots=workspace_roots,
        )
        if session_type == "workspace" and workspace_context["workspace_id"]:
            self._workspace_service.touch_workspace(workspace_context["workspace_id"])
        record = self._sessions.create(
            session_id=session_id or new_id(),
            user_id=user_id,
            scene_id=scene_id,
            title=title,
            session_tag=session_tag,
            workspace_id=workspace_context["workspace_id"],
            session_type=session_type,
            cwd=workspace_context["cwd"],
            workspace_roots=workspace_context["workspace_roots"],
            current_model_provider_id=current_model_provider_id,
            current_model=current_model,
        )
        logger.info(
            f"[SessionService] 创建会话 | session_id={record.id} | "
            f"user_id={user_id} | scene_id={scene_id} | session_tag={session_tag} | "
            f"session_type={session_type} | workspace_id={record.workspace_id or '-'}"
        )
        return self._serialize_session(record)

    def list_sessions(self, request: ListSessionsRequest) -> dict[str, Any]:
        page = max(1, int(request.page or 1))
        page_size = min(max(1, int(request.page_size or 20)), 100)
        start = (page - 1) * page_size
        filters = {
            "user_id": request.user_id,
            "scene_id": request.scene_id,
            "status": request.status,
            "session_tag": request.session_tag,
            "workspace_id": request.workspace_id,
            "session_type": request.session_type,
            "title": request.title,
        }
        total = self._sessions.count(**filters)
        page_records = self._sessions.list(**filters, limit=page_size, offset=start)
        logger.debug(
            f"[SessionService] 查询会话列表 | total={total} | page={page} | "
            f"page_size={page_size} | user_id={request.user_id or '-'} | "
            f"scene_id={request.scene_id or '-'}"
        )
        return {
            "list": self._serialize_sessions(
                page_records,
                current_session_id=request.current_session_id,
            ),
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    def group_sessions(self, request: ListSessionsRequest) -> dict[str, Any]:
        records = self._load_session_records(request)
        serialized_by_id = {
            item["id"]: item
            for item in self._serialize_sessions(
                records,
                current_session_id=request.current_session_id,
            )
        }
        groups: dict[str, dict[str, Any]] = {}
        for record in records:
            if record.session_type == "workspace" and record.workspace_id:
                key = f"workspace:{record.workspace_id}"
                workspace = serialized_by_id[record.id]["workspace"]
                title = workspace["name"] if workspace else "已移除工作区"
                group = groups.setdefault(
                    key,
                    {
                        "type": "workspace",
                        "title": title,
                        "workspace_id": record.workspace_id,
                        "workspace": workspace,
                        "list": [],
                        "total": 0,
                    },
                )
            else:
                group = groups.setdefault(
                    "chat",
                    {
                        "type": "chat",
                        "title": "对话",
                        "workspace_id": None,
                        "workspace": None,
                        "list": [],
                        "total": 0,
                    },
                )
            group["list"].append(serialized_by_id[record.id])
            group["total"] += 1

        return {
            "groups": list(groups.values()),
            "total": len(records),
        }

    def _load_session_records(self, request: ListSessionsRequest) -> list[SessionRecord]:
        return self._sessions.list(
            user_id=request.user_id,
            scene_id=request.scene_id,
            status=request.status,
            session_tag=request.session_tag,
            workspace_id=request.workspace_id,
            session_type=request.session_type,
            title=request.title,
            limit=500,
        )

    def get_session_detail(
        self,
        session_id: str,
        *,
        current_session_id: str | None = None,
    ) -> dict[str, Any]:
        record = self._require_session(session_id)
        logger.debug(f"[SessionService] 获取会话详情 | session_id={session_id}")
        return self._serialize_session(record, current_session_id=current_session_id)

    def get_controlled_subagent_session_detail(
        self,
        *,
        parent_session_id: str,
        run_id: str,
        child_session_id: str,
    ) -> dict[str, Any]:
        record = self._require_controlled_subagent_session(
            parent_session_id=parent_session_id,
            run_id=run_id,
            child_session_id=child_session_id,
        )
        return self._serialize_session(record)

    def rename_session(self, session_id: str, title: str) -> dict[str, Any]:
        self._require_session(session_id)
        cleaned = title.strip()
        if not cleaned:
            raise SessionValidationError("会话标题不能为空")
        record = self._sessions.update(session_id, title=cleaned, title_source="manual")
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        logger.info(f"[SessionService] 重命名会话 | session_id={session_id} | title={cleaned}")
        return self._serialize_session(record)

    def update_session_model(
        self,
        session_id: str,
        *,
        provider_id: str,
        model: str,
        current_session_id: str | None = None,
    ) -> dict[str, Any]:
        self._require_session(session_id)
        cleaned_provider_id = provider_id.strip()
        cleaned_model = model.strip()
        if not cleaned_provider_id or not cleaned_model:
            raise SessionValidationError("当前模型必须包含供应商和模型")
        record = self._sessions.update(
            session_id,
            current_model_provider_id=cleaned_provider_id,
            current_model=cleaned_model,
        )
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        logger.info(
            f"[SessionService] 更新会话模型 | session_id={session_id} | "
            f"provider_id={cleaned_provider_id} | model={cleaned_model}"
        )
        return self._serialize_session(record, current_session_id=current_session_id)

    def set_session_pinned(
        self,
        session_id: str,
        *,
        pinned: bool,
        current_session_id: str | None = None,
    ) -> dict[str, Any]:
        self._require_session(session_id)
        record = self._sessions.set_pinned(session_id, pinned)
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        logger.info(
            f"[SessionService] {'置顶' if pinned else '取消置顶'}会话 | session_id={session_id}"
        )
        return self._serialize_session(record, current_session_id=current_session_id)

    def get_history(
        self,
        request: GetHistoryRequest,
        *,
        _authorized_session: SessionRecord | None = None,
    ) -> dict[str, Any]:
        session = _authorized_session or self._require_session(request.session_id)
        if session.id != request.session_id:
            raise SessionNotFoundError("authorized Session does not match history request")
        page = max(1, int(request.page or 1))
        page_size = min(max(1, int(request.page_size or 5)), 100)
        direction = request.direction if request.direction in {"older", "newer"} else "older"
        cursor_turn_index = decode_turn_cursor(request.cursor)

        if request.turn_index is None and request.all_turns:
            turn_indexes = self._message_events.list_turn_indexes(
                request.session_id,
                direction="newer",
                limit=None,
            )
            messages = self._messages_for_turns(
                request.session_id,
                turn_indexes,
                include_tool_details=False,
            )
            event_total = self._message_events.count_by_session(request.session_id)
            total = len(turn_indexes)
            next_cursor = None
            prev_cursor = None
            has_more_older = False
            page_size = total
        elif request.turn_index is None:
            offset = 0 if request.cursor else (page - 1) * page_size
            page_turn_indexes = self._message_events.list_turn_indexes(
                request.session_id,
                cursor_turn_index=cursor_turn_index,
                direction=direction,
                limit=page_size + 1,
                offset=offset,
            )
            has_more = len(page_turn_indexes) > page_size
            selected_turn_indexes = page_turn_indexes[:page_size]
            turn_indexes = sorted(selected_turn_indexes)
            messages = self._messages_for_turns(
                request.session_id,
                turn_indexes,
                include_tool_details=False,
            )
            event_total = self._message_events.count_by_session(request.session_id)
            total = self._message_events.count_turns(request.session_id)
            next_cursor = (
                encode_turn_cursor(min(selected_turn_indexes))
                if has_more and selected_turn_indexes and direction == "older"
                else None
            )
            prev_cursor = (
                encode_turn_cursor(max(selected_turn_indexes))
                if has_more and selected_turn_indexes and direction == "newer"
                else None
            )
            has_more_older = has_more if direction == "older" else bool(next_cursor)
        else:
            messages = self._message_event_service.get_turn_messages(
                request.session_id,
                request.turn_index,
                include_tool_details=False,
            )
            for message in messages:
                message.setdefault("turnIndex", request.turn_index)
            event_total = len(
                self._message_events.list_by_turn(request.session_id, request.turn_index)
            )
            turn_indexes = [request.turn_index] if event_total else []
            total = 1 if event_total else 0
            next_cursor = None
            prev_cursor = None
            has_more_older = False
        logger.debug(
            f"[SessionService] 查询会话历史 | session_id={request.session_id} | "
            f"turn_index={request.turn_index if request.turn_index is not None else '-'} | "
            f"messages={total} | events={event_total} | page={page} | page_size={page_size}"
        )
        self._attach_fork_origin_marker(session.id, messages)
        return {
            "list": messages,
            "total": total,
            "page": page,
            "page_size": page_size,
            "session": self._serialize_session(session),
            "event_total": event_total,
            "turn_indexes": turn_indexes,
            "next_cursor": next_cursor,
            "prev_cursor": prev_cursor,
            "has_more_older": has_more_older,
        }

    def get_controlled_subagent_history(
        self,
        request: GetHistoryRequest,
        *,
        parent_session_id: str,
        run_id: str,
        child_session_id: str,
    ) -> dict[str, Any]:
        record = self._require_controlled_subagent_session(
            parent_session_id=parent_session_id,
            run_id=run_id,
            child_session_id=child_session_id,
        )
        return self.get_history(request, _authorized_session=record)

    def get_tool_detail(
        self,
        session_id: str,
        *,
        start_event_id: str | None = None,
        end_event_id: str | None = None,
    ) -> dict[str, Any]:
        self._require_session(session_id)
        if not start_event_id and not end_event_id:
            raise SessionValidationError("工具详情事件 id 不能为空")
        detail = self._message_event_service.get_tool_detail(
            session_id=session_id,
            start_event_id=start_event_id,
            end_event_id=end_event_id,
        )
        if detail is None:
            raise SessionValidationError("工具详情不存在或事件不匹配")
        return detail

    def get_controlled_subagent_tool_detail(
        self,
        *,
        parent_session_id: str,
        run_id: str,
        child_session_id: str,
        start_event_id: str | None = None,
        end_event_id: str | None = None,
    ) -> dict[str, Any]:
        self._require_controlled_subagent_session(
            parent_session_id=parent_session_id,
            run_id=run_id,
            child_session_id=child_session_id,
        )
        if not start_event_id and not end_event_id:
            raise SessionValidationError("tool detail event id is required")
        detail = self._message_event_service.get_tool_detail(
            session_id=child_session_id,
            start_event_id=start_event_id,
            end_event_id=end_event_id,
        )
        if detail is None:
            raise SessionValidationError("tool detail not found in controlled child Session")
        return detail

    def close_session(self, session_id: str) -> dict[str, Any]:
        self._require_session(session_id)
        record = self._sessions.close(session_id)
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        logger.info(f"[SessionService] 关闭会话 | session_id={session_id}")
        return self._serialize_session(record)

    def mark_session_failed(self, session_id: str) -> dict[str, Any]:
        self._require_session(session_id)
        record = self._sessions.update(session_id, status="failed")
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        logger.warning(f"[SessionService] 标记会话失败 | session_id={session_id}")
        return self._serialize_session(record)

    def touch_session(self, session_id: str) -> dict[str, Any]:
        self._require_session(session_id)
        record = self._sessions.touch(session_id)
        if record is None:
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        return self._serialize_session(record)

    def _require_session(self, session_id: str) -> SessionRecord:
        record = self._sessions.get(session_id)
        if record is None:
            if self._sessions.get_archived(session_id) is not None:
                raise SessionArchivedError(session_id)
            raise SessionNotFoundError(f"会话不存在: {session_id}")
        return record

    def _require_controlled_subagent_session(
        self,
        *,
        parent_session_id: str,
        run_id: str,
        child_session_id: str,
    ) -> SessionRecord:
        record = self._sessions.get_internal_for_parent(
            child_session_id=str(child_session_id or "").strip(),
            parent_session_id=str(parent_session_id or "").strip(),
            run_id=str(run_id or "").strip(),
        )
        if record is None:
            raise SessionNotFoundError("controlled Sub-Agent child Session not found")
        return record

    def _resolve_workspace_create_context(
        self,
        *,
        session_type: str,
        workspace_id: str | None,
        cwd: str | None,
        workspace_roots: list[str] | None,
    ) -> dict[str, Any]:
        if session_type not in {"workspace", "chat"}:
            raise SessionValidationError(f"不支持的 session 类型: {session_type}")
        if session_type == "chat":
            if workspace_id or cwd or workspace_roots:
                raise SessionValidationError("纯聊天会话不能绑定工作区")
            return {"workspace_id": None, "cwd": None, "workspace_roots": []}

        if not workspace_id:
            raise SessionValidationError("项目会话必须选择工作区")
        if self._workspace_service is None:
            raise SessionValidationError("当前运行时未配置工作区服务")
        workspace = self._workspace_service.require_workspace(workspace_id)
        workspace_root = Path(workspace.root_path).expanduser().resolve()
        resolved_cwd = Path(cwd or workspace_root).expanduser().resolve()
        try:
            resolved_cwd = resolve_workspace_path(
                resolved_cwd,
                cwd=workspace_root,
                workspace_roots=[workspace_root],
            )
        except WorkspacePathError as exc:
            raise SessionValidationError("会话运行目录不在工作区内") from exc
        if not resolved_cwd.exists():
            raise SessionValidationError("会话运行目录不存在")
        if not resolved_cwd.is_dir():
            raise SessionValidationError("会话运行目录不是目录")
        resolved_roots = [str(workspace_root)]
        if workspace_roots:
            resolved_roots = []
            for root in workspace_roots:
                try:
                    resolved_root = resolve_workspace_path(
                        root,
                        cwd=workspace_root,
                        workspace_roots=[workspace_root],
                    )
                except WorkspacePathError as exc:
                    raise SessionValidationError("会话工作区根目录不在工作区内") from exc
                if not resolved_root.exists() or not resolved_root.is_dir():
                    raise SessionValidationError("会话工作区根目录不存在或不是目录")
                resolved_roots.append(str(resolved_root))
        return {
            "workspace_id": workspace.id,
            "cwd": str(resolved_cwd),
            "workspace_roots": resolved_roots,
        }

    def _turn_indexes(self, session_id: str) -> list[int]:
        events = self._message_events.list_by_session(session_id)
        return sorted({event.turn_index for event in events})

    def _messages_for_turns(
        self,
        session_id: str,
        turn_indexes: list[int],
        *,
        include_tool_details: bool,
    ) -> list[dict[str, Any]]:
        messages: list[dict[str, Any]] = []
        for turn_index in turn_indexes:
            turn_messages = self._message_event_service.get_turn_messages(
                session_id,
                turn_index,
                include_tool_details=include_tool_details,
            )
            for message in turn_messages:
                message.setdefault("turnIndex", turn_index)
            messages.extend(turn_messages)
        return messages

    def _serialize_session(
        self,
        record: SessionRecord,
        *,
        current_session_id: str | None = None,
    ) -> dict[str, Any]:
        workspace = None
        if record.workspace_id and self._workspace_service is not None:
            workspace = self._workspace_summary(record.workspace_id)
        fork_source = self._serialize_fork_record(
            self._session_forks.get_by_target(record.id)
            if self._session_forks is not None
            else None
        )
        return self._serialize_session_payload(
            record,
            workspace=workspace,
            fork_source=fork_source,
            current_session_id=current_session_id,
        )

    def _serialize_sessions(
        self,
        records: list[SessionRecord],
        *,
        current_session_id: str | None = None,
    ) -> list[dict[str, Any]]:
        workspace_by_id = {
            workspace_id: self._workspace_summary(workspace_id)
            for workspace_id in dict.fromkeys(
                record.workspace_id for record in records if record.workspace_id
            )
        }
        fork_records = (
            self._session_forks.list_by_targets([record.id for record in records])
            if self._session_forks is not None and records
            else []
        )
        related_session_ids = [
            session_id
            for fork_record in fork_records
            for session_id in (fork_record.target_session_id, fork_record.source_session_id)
        ]
        related_sessions = {
            related.id: related
            for related in self._sessions.get_many(related_session_ids)
        }
        fork_source_by_target = {
            fork_record.target_session_id: self._serialize_fork_record(
                fork_record,
                sessions_by_id=related_sessions,
            )
            for fork_record in fork_records
        }
        return [
            self._serialize_session_payload(
                record,
                workspace=workspace_by_id.get(record.workspace_id) if record.workspace_id else None,
                fork_source=fork_source_by_target.get(record.id),
                current_session_id=current_session_id,
            )
            for record in records
        ]

    @staticmethod
    def _serialize_session_payload(
        record: SessionRecord,
        *,
        workspace: dict[str, Any] | None,
        fork_source: dict[str, Any] | None,
        current_session_id: str | None,
    ) -> dict[str, Any]:
        return {
            "id": record.id,
            "user_id": record.user_id,
            "scene_id": record.scene_id,
            "status": record.status,
            "title": record.title,
            "title_source": record.title_source,
            "session_tag": record.session_tag,
            "active_session_id": record.active_session_id,
            "parent_session_id": record.parent_session_id,
            "child_session_id": record.child_session_id,
            "source_trace_id": record.source_trace_id,
            "source_active_session_id": record.source_active_session_id,
            "source_checkpoint_id": record.source_checkpoint_id,
            "source_checkpoint_ns": record.source_checkpoint_ns,
            "workspace_id": record.workspace_id,
            "session_type": record.session_type,
            "visibility": record.visibility,
            "agent_kind": record.agent_kind,
            "subagent_id": record.subagent_id,
            "subagent_role": record.subagent_role,
            "subagent_closed_at": record.subagent_closed_at,
            "cwd": record.cwd,
            "workspace_roots": record.workspace_roots,
            "current_model_provider_id": record.current_model_provider_id,
            "current_model": record.current_model,
            "context_window_usage": record.context_window_usage,
            "context_compression_epoch": record.context_compression_epoch,
            "checkpoint_lineage": {
                "epoch": record.checkpoint_lineage_epoch,
                "history_floor_turn_index": (
                    record.checkpoint_history_floor_turn_index
                ),
                "root_checkpoint_id": record.checkpoint_root_id,
                "collapsed_at": record.checkpoint_collapsed_at,
            },
            "checkpoint_capabilities": {
                "can_continue": True,
                "can_fork_before_history_floor": (
                    record.checkpoint_history_floor_turn_index == 0
                ),
                "can_reverse_before_history_floor": (
                    record.checkpoint_history_floor_turn_index == 0
                ),
            },
            "pinned": record.pinned_at is not None,
            "pinned_at": record.pinned_at,
            "workspace": workspace,
            "fork_source": fork_source,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "archived_at": record.archived_at,
            "archive_origin": record.archive_origin,
            "is_debug": record.is_debug,
            "is_scheduled": record.is_scheduled,
            "is_current": record.id == current_session_id if current_session_id else False,
        }

    def _attach_fork_origin_marker(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        if self._session_forks is None or not messages:
            return
        fork_record = self._session_forks.get_by_target(session_id)
        if fork_record is None:
            return
        serialized = self._serialize_fork_record(fork_record)
        for message in messages:
            message_event_id = message.get("messageEventId")
            if message_event_id == fork_record.target_message_event_id:
                message["forkSource"] = serialized

    def _serialize_fork_record(
        self,
        record: SessionForkRecord | None,
        *,
        sessions_by_id: dict[str, SessionRecord] | None = None,
    ) -> dict[str, Any] | None:
        if record is None:
            return None
        target = (
            sessions_by_id.get(record.target_session_id)
            if sessions_by_id is not None
            else self._sessions.get(record.target_session_id)
        )
        source = (
            sessions_by_id.get(record.source_session_id)
            if sessions_by_id is not None
            else self._sessions.get(record.source_session_id)
        )
        return {
            "id": record.id,
            "source_session_id": record.source_session_id,
            "target_session_id": record.target_session_id,
            "source_message_event_id": record.source_message_event_id,
            "target_message_event_id": record.target_message_event_id,
            "source_turn_index": record.source_turn_index,
            "target_turn_index": record.target_turn_index,
            "source_trace_id": record.source_trace_id,
            "source_active_session_id": record.source_active_session_id,
            "source_checkpoint_id": record.source_checkpoint_id,
            "source_checkpoint_ns": record.source_checkpoint_ns,
            "relation_type": record.relation_type,
            "created_at": record.created_at,
            "updated_at": record.updated_at,
            "target_title": target.title if target else None,
            "source_title": source.title if source else None,
        }

    def _workspace_summary(self, workspace_id: str) -> dict[str, Any] | None:
        if self._workspace_service is None:
            return None
        try:
            return self._workspace_service.get_workspace(workspace_id)
        except WorkspaceServiceError:
            return None


def terminal_turn_indexes(events: list[MessageEventRecord]) -> list[int]:
    terminal_actions = {"completed", "cancelled", "error", "scheduled_task_result"}
    return sorted({event.turn_index for event in events if event.action in terminal_actions})


def encode_turn_cursor(turn_index: int) -> str:
    return base64.urlsafe_b64encode(str(int(turn_index)).encode("utf-8")).decode("ascii")


def decode_turn_cursor(cursor: str | None) -> int | None:
    if not cursor:
        return None
    try:
        decoded = base64.urlsafe_b64decode(cursor.encode("ascii")).decode("utf-8")
        return int(decoded.split(":", 1)[0])
    except (ValueError, UnicodeDecodeError, binascii.Error):
        try:
            return int(cursor)
        except ValueError:
            logger.warning(f"[SessionService] invalid turn cursor | cursor={cursor}")
            return None
