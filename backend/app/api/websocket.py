from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.app.a2ui.interaction_service import (
    A2UIInteractionService,
    A2UIInteractionServiceError,
)
from backend.app.a2ui.resume_service import (
    A2UIResumeService,
    A2UIResumeServiceError,
    A2UIResumeSnapshot,
    A2UIResumeStartResult,
)
from backend.app.a2ui.schemas import interaction_state_from_record
from backend.app.command_approval import (
    ApprovalService,
    CommandApprovalDecision,
    CommandApprovalError,
    approval_to_payload,
    load_command_settings,
)
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.request_context import trace_id_var
from backend.app.events import ChatProjection, EventDispatcher, PersistenceProjection
from backend.app.git.models import GitApiError, GitRepositoryRequest
from backend.app.mcp.elicitation import McpElicitationError
from backend.app.model import ModelSelectionError, resolve_model_selection
from backend.app.services.chat_service import PRACTICAL_NO_RECURSION_LIMIT
from backend.app.services.chat_stream_manager import (
    ChatStreamAlreadyRunningError,
    ChatStreamMissingSessionError,
)
from backend.app.services.chat_types import (
    PENDING_INPUT_MODE_STEER,
    PENDING_INPUT_MODES,
    ChatRequest,
)
from backend.app.services.file_change_hub import normalize_local_file_path
from backend.app.services.session_service import (
    SessionNotFoundError,
    SessionService,
    SessionValidationError,
)
from backend.app.services.workspace_service import (
    WorkspaceServiceError,
)
from backend.app.storage import MODEL_DEFAULT_CHAT
from backend.app.tools.command_runtime import command_process_manager

router = APIRouter(prefix="/agent-base/ws", tags=["websocket"])

_ERROR_REQUEST_CONTEXT_KEYS = (
    "session_id",
    "workspace_id",
    "repository_id",
    "watch_id",
    "pending_input_id",
    "interaction_id",
    "command_id",
    "approval_id",
    "elicitation_id",
)


class WebSocketChannelAdapter:
    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self._send_lock = asyncio.Lock()

    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        payload = dict(data or {})
        if session_id:
            payload.setdefault("session_id", session_id)
        async with self._send_lock:
            await self.websocket.send_text(
                json.dumps({"action": action, "data": payload}, ensure_ascii=False)
            )
        return True


@router.websocket("/chat")
async def chat_websocket(websocket: WebSocket) -> None:
    await websocket.accept()
    connection_trace_id = websocket.headers.get("x-trace-id") or new_id()
    trace_token = trace_id_var.set(connection_trace_id)
    runtime = websocket.app.state.runtime
    keydex_watcher = getattr(websocket.app.state, "keydex_workspace_watcher", None)
    file_change_hub = getattr(websocket.app.state, "file_change_hub", None)
    git_metadata_events = getattr(websocket.app.state, "git_metadata_event_service", None)
    settings = runtime.settings
    repositories = runtime.repositories
    stream_manager = runtime.chat_stream_manager
    session_service = SessionService(
        repositories.sessions,
        repositories.message_events,
        repositories.workspaces,
    )
    adapter = WebSocketChannelAdapter(websocket)
    bound_session_id = str(websocket.query_params.get("session_id") or "").strip() or None
    bound_session_ids: set[str] = set()
    bound_git_repository_ids: set[str] = set()
    request_action = ""
    request_payload: dict[str, Any] = {}
    if bound_session_id:
        bound_session_ids.add(bound_session_id)
        await stream_manager.subscribe(bound_session_id, adapter)
        try:
            await _register_keydex_watcher(
                keydex_watcher,
                session_service.get_session_detail(bound_session_id),
            )
        except SessionNotFoundError:
            pass
    logger.info(
        f"[WebSocket] 连接建立 | trace_id={connection_trace_id} | "
        f"bound_session_id={bound_session_id or '-'}"
    )

    async def send(action: str, data: dict[str, Any]) -> None:
        async with adapter._send_lock:
            await websocket.send_text(
                json.dumps({"action": action, "data": data}, ensure_ascii=False)
            )

    async def send_error(code: str, message: str, data: dict[str, Any] | None = None) -> None:
        error_payload = {"code": code, "message": message, **(data or {})}
        if request_action:
            error_payload.setdefault("source_action", request_action)
        for key in _ERROR_REQUEST_CONTEXT_KEYS:
            value = request_payload.get(key)
            if isinstance(value, str) and value.strip():
                error_payload.setdefault(key, value.strip())
        await send("error", error_payload)

    try:
        while True:
            request_action = ""
            request_payload = {}
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                logger.info(
                    f"[WebSocket] 客户端断开 | trace_id={connection_trace_id} | "
                    f"bound_session_id={bound_session_id or '-'}"
                )
                break

            try:
                message = json.loads(raw)
            except json.JSONDecodeError as exc:
                logger.warning(
                    f"[WebSocket] 收到非法 JSON | trace_id={connection_trace_id} | error={exc}"
                )
                await send_error("parse_error", f"消息不是合法 JSON：{exc}")
                continue

            action = str(message.get("action") or "").strip()
            payload = _payload(message)
            request_action = action
            request_payload = payload
            if not action:
                logger.warning(f"[WebSocket] 缺少 action | trace_id={connection_trace_id}")
                await send_error("missing_action", "action 字段必填")
                continue

            try:
                logger.info(
                    f"[WebSocket] 收到 action | trace_id={connection_trace_id} | "
                    f"action={action} | bound_session_id={bound_session_id or '-'}"
                )
                if action == "bind_workspace_watch":
                    workspace_id = str(payload.get("workspace_id") or "").strip()
                    if not workspace_id:
                        await send_error("missing_workspace", "workspace_id 必填")
                        continue
                    workspace = repositories.workspaces.get(workspace_id)
                    if workspace is None:
                        await send_error("workspace_not_found", "工作区不存在")
                        continue
                    if file_change_hub is None:
                        await send_error("file_watch_unavailable", "文件变动监听服务未启用")
                        continue
                    sequence = await file_change_hub.subscribe_workspace(
                        workspace_id,
                        workspace.root_path,
                        adapter,
                    )
                    await send(
                        "workspaceWatchBound",
                        {
                            "workspace_id": workspace_id,
                            "sequence": sequence,
                            "resync_required": True,
                        },
                    )
                    continue

                if action == "bind_git_repository_watch":
                    workspace_id = str(payload.get("workspace_id") or "").strip()
                    project_root = str(payload.get("project_root") or "").strip()
                    repository_id = str(payload.get("repository_id") or "").strip()
                    query_service = getattr(websocket.app.state, "git_query_service", None)
                    if not workspace_id or not project_root or not repository_id:
                        await send_error("git_invalid_request", "Git watch scope is incomplete")
                        continue
                    if query_service is None or git_metadata_events is None:
                        await send_error("git_unavailable", "Git metadata watch is unavailable")
                        continue
                    try:
                        repository = query_service.repository(
                            GitRepositoryRequest(
                                workspace_id=workspace_id,
                                project_root=project_root,
                                repository_id=repository_id,
                            )
                        )
                        sequence = await git_metadata_events.subscribe(repository, adapter)
                    except (GitApiError, ValueError, OSError) as exc:
                        await send_error("git_access_denied", str(exc))
                        continue
                    bound_git_repository_ids.add(repository_id)
                    await send(
                        "gitRepositoryWatchBound",
                        {
                            "repository_id": repository_id,
                            "sequence": sequence,
                            "resync_required": True,
                        },
                    )
                    continue

                if action == "unbind_git_repository_watch":
                    repository_id = str(payload.get("repository_id") or "").strip()
                    if git_metadata_events is not None and repository_id:
                        await git_metadata_events.unsubscribe(repository_id, adapter)
                    bound_git_repository_ids.discard(repository_id)
                    await send("gitRepositoryWatchUnbound", {"repository_id": repository_id})
                    continue

                if action == "unbind_workspace_watch":
                    workspace_id = str(payload.get("workspace_id") or "").strip()
                    if file_change_hub is not None and workspace_id:
                        await file_change_hub.unsubscribe_workspace(workspace_id, adapter)
                    await send("workspaceWatchUnbound", {"workspace_id": workspace_id})
                    continue

                if action == "bind_local_file_watch":
                    watch_id = str(payload.get("watch_id") or "").strip()
                    raw_path = str(payload.get("path") or "").strip()
                    if not watch_id:
                        await send_error("missing_watch_id", "watch_id 必填")
                        continue
                    try:
                        path = normalize_local_file_path(raw_path, require_file=True)
                    except ValueError as exc:
                        await send_error("invalid_local_file_watch", str(exc))
                        continue
                    if file_change_hub is None:
                        await send_error("file_watch_unavailable", "文件变动监听服务未启用")
                        continue
                    normalized_path, sequence = await file_change_hub.subscribe_local_file(
                        watch_id,
                        path,
                        adapter,
                    )
                    await send(
                        "localFileWatchBound",
                        {
                            "watch_id": watch_id,
                            "path": str(normalized_path),
                            "sequence": sequence,
                            "resync_required": True,
                        },
                    )
                    continue

                if action == "unbind_local_file_watch":
                    watch_id = str(payload.get("watch_id") or "").strip()
                    if file_change_hub is not None and watch_id:
                        await file_change_hub.unsubscribe_local_file(watch_id, adapter)
                    await send("localFileWatchUnbound", {"watch_id": watch_id})
                    continue

                if action == "create_session":
                    session = session_service.create_session(
                        session_id=str(payload.get("session_id") or new_id()),
                        user_id=str(payload.get("user_id") or settings.default_user_id),
                        scene_id=str(payload.get("scene_id") or settings.default_scene_id),
                        title=payload.get("title"),
                        session_type=str(payload.get("session_type") or "chat"),
                        workspace_id=payload.get("workspace_id"),
                        cwd=payload.get("cwd"),
                        workspace_roots=payload.get("workspace_roots"),
                        current_model_provider_id=payload.get("current_model_provider_id"),
                        current_model=payload.get("current_model"),
                    )
                    bound_session_id = session["id"]
                    bound_session_ids.add(bound_session_id)
                    await stream_manager.subscribe(bound_session_id, adapter)
                    await _register_keydex_watcher(keydex_watcher, session)
                    logger.info(
                        f"[WebSocket] 会话创建成功 | trace_id={connection_trace_id} | "
                        f"session_id={bound_session_id}"
                    )
                    await send(
                        "session_created",
                        {"session_id": session["id"], "session": session},
                    )
                    continue

                if action == "bind_session":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    if not session_id:
                        await send_error("missing_session", "session_id 必填")
                        continue
                    session = session_service.get_session_detail(session_id)
                    bound_session_id = session_id
                    bound_session_ids.add(session_id)
                    await stream_manager.subscribe(session_id, adapter)
                    await _register_keydex_watcher(keydex_watcher, session)
                    logger.info(
                        f"[WebSocket] 会话绑定成功 | trace_id={connection_trace_id} | "
                        f"session_id={session_id}"
                    )
                    await send("bind_ok", {"session_id": session_id})
                    continue

                if action == "unbind_session":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    if bound_session_id == session_id:
                        bound_session_id = None
                    if session_id:
                        bound_session_ids.discard(session_id)
                        await stream_manager.unsubscribe(session_id, adapter)
                        if not await stream_manager.has_subscribers(session_id):
                            await _unregister_keydex_watcher(keydex_watcher, session_id)
                    await send("unbind_ok", {"session_id": session_id})
                    continue

                if action == "chat":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    if not session_id:
                        await send_error("missing_session", "session_id 必填")
                        continue
                    session = session_service.get_session_detail(session_id)
                    waiting_interactions = repositories.a2ui_interactions.get_waiting_by_session(
                        session_id
                    )
                    if waiting_interactions:
                        await send(
                            "a2ui_waiting_input",
                            {
                                "session_id": session_id,
                                "pending_interactions": [
                                    interaction_state_from_record(record).model_dump(
                                        mode="json"
                                    )
                                    for record in waiting_interactions
                                ],
                            },
                        )
                    bound_session_id = session_id
                    bound_session_ids.add(session_id)
                    await stream_manager.subscribe(session_id, adapter)
                    await _register_keydex_watcher(keydex_watcher, session)
                    await stream_manager.submit_input(
                        ChatRequest(
                            session_id=session_id,
                            message=str(payload.get("message") or payload.get("content") or ""),
                            user_id=str(payload.get("user_id") or settings.default_user_id),
                            scene_id=str(payload.get("scene_id") or settings.default_scene_id),
                            provider_id=str(payload.get("provider_id") or ""),
                            model=str(payload.get("model") or ""),
                            system_prompt=payload.get("system_prompt"),
                            runtime_params=_runtime_params(payload),
                            attachments=_attachments(payload),
                            delivery_mode=_delivery_mode(payload),
                            client_input_id=_client_input_id(payload),
                        )
                    )
                    continue

                if action == "pending_input_update":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    pending_input_id = str(
                        payload.get("pending_input_id") or payload.get("id") or ""
                    ).strip()
                    if not session_id:
                        await send_error("missing_session", "session_id 必填")
                        continue
                    if not pending_input_id:
                        await send_error("missing_pending_input", "pending_input_id 必填")
                        continue
                    updated = await stream_manager.update_pending_input(
                        session_id=session_id,
                        pending_input_id=pending_input_id,
                        message=(
                            str(payload.get("message"))
                            if payload.get("message") is not None
                            else None
                        ),
                        mode=(
                            _delivery_mode(payload)
                            if (
                                payload.get("mode") is not None
                                or payload.get("delivery_mode") is not None
                                or payload.get("deliveryMode") is not None
                            )
                            else None
                        ),
                        runtime_params=_runtime_params(payload),
                        attachments=_attachments(payload),
                        provider_id=(
                            str(payload.get("provider_id"))
                            if payload.get("provider_id") is not None
                            else None
                        ),
                        model=(
                            str(payload.get("model"))
                            if payload.get("model") is not None
                            else None
                        ),
                    )
                    if updated is None:
                        await send_error(
                            "pending_input_not_editable",
                            "待发送消息不存在或已被交付，无法编辑",
                            {"session_id": session_id, "pending_input_id": pending_input_id},
                        )
                    continue

                if action == "pending_input_reorder":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    pending_input_ids = payload.get("pending_input_ids")
                    if not session_id:
                        await send_error("missing_session", "session_id 必填")
                        continue
                    if not isinstance(pending_input_ids, list) or len(pending_input_ids) < 2:
                        await send_error(
                            "invalid_pending_input_order",
                            "pending_input_ids 至少需要包含两条待发送消息",
                        )
                        continue
                    cleaned_pending_input_ids = [
                        str(item or "").strip() for item in pending_input_ids
                    ]
                    if any(not item for item in cleaned_pending_input_ids):
                        await send_error(
                            "invalid_pending_input_order",
                            "pending_input_ids 不能包含空值",
                        )
                        continue
                    try:
                        reordered = await stream_manager.reorder_pending_inputs(
                            session_id=session_id,
                            pending_input_ids=cleaned_pending_input_ids,
                        )
                    except ValueError as exc:
                        await send_error("invalid_pending_input_order", str(exc))
                        continue
                    if reordered is None:
                        await send_error(
                            "pending_input_not_reorderable",
                            "待发送消息已变化，无法调整顺序",
                            {"session_id": session_id},
                        )
                    continue

                if action == "pending_input_cancel":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    pending_input_id = str(
                        payload.get("pending_input_id") or payload.get("id") or ""
                    ).strip()
                    if not session_id:
                        await send_error("missing_session", "session_id 必填")
                        continue
                    if not pending_input_id:
                        await send_error("missing_pending_input", "pending_input_id 必填")
                        continue
                    cancelled = await stream_manager.cancel_pending_input(
                        session_id=session_id,
                        pending_input_id=pending_input_id,
                        reason=str(payload.get("reason") or "user"),
                    )
                    if cancelled is None:
                        await send_error(
                            "pending_input_not_cancellable",
                            "待发送消息不存在或已被交付，无法删除",
                            {"session_id": session_id, "pending_input_id": pending_input_id},
                        )
                    continue

                if action == "pending_input_resume":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    pending_input_id = str(
                        payload.get("pending_input_id") or payload.get("id") or ""
                    ).strip() or None
                    raw_mode = payload.get("mode")
                    mode = _delivery_mode(payload) if raw_mode is not None else None
                    if not session_id:
                        await send_error("missing_session", "session_id 必填")
                        continue
                    if pending_input_id is None and mode is None:
                        await send_error(
                            "missing_pending_input_resume_target",
                            "pending_input_id 或 mode 至少提供一个",
                        )
                        continue
                    resumed = await stream_manager.resume_pending_inputs(
                        session_id=session_id,
                        pending_input_id=pending_input_id,
                        mode=mode,
                    )
                    if resumed is None:
                        await send_error(
                            "pending_input_not_resumable",
                            "待发送消息不存在、未暂停或已被交付，无法恢复",
                            {"session_id": session_id, "pending_input_id": pending_input_id},
                        )
                    continue

                if action == "a2ui_submit":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    if not session_id:
                        await send_error("missing_session", "session_id 必填")
                        continue
                    if not str(payload.get("interaction_id") or "").strip():
                        await send_error("missing_interaction", "interaction_id 必填")
                        continue
                    payload["session_id"] = session_id
                    try:
                        result = await A2UIInteractionService(
                            repositories=repositories,
                            dispatcher=EventDispatcher(),
                        ).submit(payload)
                        resume_result = await _start_a2ui_resume(
                            websocket=websocket,
                            runtime=runtime,
                            repositories=repositories,
                            adapter=adapter,
                            interaction_id=result.interaction.id,
                            turn_index=result.interaction.turn_index,
                            should_resume=result.should_resume,
                        )
                    except A2UIInteractionServiceError as exc:
                        await send_error(exc.code, exc.message, {"session_id": session_id})
                        continue
                    except (A2UIResumeServiceError, ModelSelectionError) as exc:
                        await send_error(
                            getattr(exc, "code", "a2ui_resume_failed"),
                            str(exc),
                            {"session_id": session_id},
                        )
                        continue
                    _apply_resume_result(result.ack_payload, resume_result)
                    await send("a2ui_submit_ack", result.ack_payload)
                    continue

                if action == "a2ui_cancel":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    if not session_id:
                        await send_error("missing_session", "session_id 必填")
                        continue
                    if not str(payload.get("interaction_id") or "").strip():
                        await send_error("missing_interaction", "interaction_id 必填")
                        continue
                    payload["session_id"] = session_id
                    try:
                        result = await A2UIInteractionService(
                            repositories=repositories,
                            dispatcher=EventDispatcher(),
                        ).cancel(payload)
                        resume_result = await _start_a2ui_resume(
                            websocket=websocket,
                            runtime=runtime,
                            repositories=repositories,
                            adapter=adapter,
                            interaction_id=result.interaction.id,
                            turn_index=result.interaction.turn_index,
                            should_resume=result.should_resume,
                        )
                    except A2UIInteractionServiceError as exc:
                        await send_error(exc.code, exc.message, {"session_id": session_id})
                        continue
                    except (A2UIResumeServiceError, ModelSelectionError) as exc:
                        await send_error(
                            getattr(exc, "code", "a2ui_resume_failed"),
                            str(exc),
                            {"session_id": session_id},
                        )
                        continue
                    _apply_resume_result(result.ack_payload, resume_result)
                    await send("a2ui_cancel_ack", result.ack_payload)
                    continue

                if action == "cancel":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    cancelled = await stream_manager.cancel(session_id)
                    if not cancelled:
                        await send("status", await stream_manager.status(session_id))
                    logger.info(
                        f"[WebSocket] 收到取消请求 | trace_id={connection_trace_id} | "
                        f"session_id={session_id or '-'} | cancelled={cancelled}"
                    )
                    continue

                if action == "terminate_command":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    command_id = str(payload.get("command_id") or "").strip()
                    if not session_id:
                        await send_error("missing_session", "session_id 必填")
                        continue
                    if not command_id:
                        await send_error("missing_command", "command_id 必填")
                        continue
                    terminated = command_process_manager.terminate_command(
                        command_id,
                        reason="user",
                    )
                    await send(
                        "command_terminated",
                        {
                            "session_id": session_id,
                            "command_id": command_id,
                            "terminated": terminated,
                            "cancelled": False,
                        },
                    )
                    logger.info(
                        "[WebSocket] 收到 command 终止请求 | "
                        f"trace_id={connection_trace_id} | session_id={session_id} | "
                        f"command_id={command_id} | terminated={terminated}"
                    )
                    continue

                if action == "approval_decision":
                    approval_id = str(payload.get("approval_id") or payload.get("id") or "").strip()
                    if not approval_id:
                        await send_error("missing_approval", "approval_id 必填")
                        continue
                    try:
                        decision = CommandApprovalDecision(
                            decision=str(payload.get("decision") or ""),
                            trust_scope=str(payload.get("trust_scope") or "once"),
                            rule_match_type=payload.get("rule_match_type"),
                            reject_message=str(payload.get("reject_message") or ""),
                        )
                        record = await ApprovalService(repositories=repositories).resolve(
                            approval_id,
                            decision,
                            settings=load_command_settings(repositories),
                            user_id=str(payload.get("user_id") or settings.default_user_id),
                        )
                    except CommandApprovalError as exc:
                        await send_error("invalid_approval_decision", str(exc))
                        continue
                    approval = approval_to_payload(record)
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
                    continue

                if action == "mcp_elicitation_resolved":
                    elicitation_service = getattr(
                        websocket.app.state,
                        "mcp_elicitation_service",
                        None,
                    )
                    if elicitation_service is None:
                        await send_error("elicitation_unavailable", "MCP elicitation 服务未启用")
                        continue
                    elicitation_id = str(
                        payload.get("elicitation_id") or payload.get("id") or ""
                    ).strip()
                    if not elicitation_id:
                        await send_error("missing_elicitation", "elicitation_id 必填")
                        continue
                    values = payload.get("values")
                    try:
                        result = await elicitation_service.resolve(
                            elicitation_id,
                            values=values if isinstance(values, dict) else {},
                            cancelled=bool(payload.get("cancelled")),
                            user_id=str(payload.get("user_id") or settings.default_user_id),
                        )
                    except McpElicitationError as exc:
                        await send_error("invalid_elicitation_resolution", str(exc))
                        continue
                    await send("mcp_elicitation_resolved", {"elicitation": result.to_dict()})
                    continue

                if action == "ping":
                    await send("pong", {"timestamp": int(time.time())})
                    continue

                if action == "get_status":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    await send("status", await stream_manager.status(session_id))
                    continue

                await send_error("unknown_action", f"未知的 action: {action}")
            except SessionNotFoundError as exc:
                logger.warning(
                    f"[WebSocket] session 不存在 | trace_id={connection_trace_id} | "
                    f"action={action} | error={exc}"
                )
                await send_error("session_not_found", str(exc))
            except SessionValidationError as exc:
                logger.warning(
                    f"[WebSocket] session 请求非法 | trace_id={connection_trace_id} | "
                    f"action={action} | error={exc}"
                )
                await send_error("invalid_session", str(exc))
            except WorkspaceServiceError as exc:
                logger.warning(
                    f"[WebSocket] workspace 请求非法 | trace_id={connection_trace_id} | "
                    f"action={action} | code={exc.code} | error={exc}"
                )
                await send_error(exc.code, exc.message, {"details": exc.details})
            except ChatStreamMissingSessionError as exc:
                await send_error("missing_session", str(exc))
            except ChatStreamAlreadyRunningError as exc:
                await send_error("chat_running", str(exc))
            except Exception as exc:
                logger.opt(exception=True).error(
                    f"[WebSocket] action 处理失败 | trace_id={connection_trace_id} | "
                    f"action={action} | error={exc}"
                )
                await send_error("ws_action_error", str(exc))
    finally:
        await stream_manager.unsubscribe_all(adapter)
        if file_change_hub is not None:
            await file_change_hub.unsubscribe_all(adapter)
        if git_metadata_events is not None:
            for repository_id in list(bound_git_repository_ids):
                await git_metadata_events.unsubscribe(repository_id, adapter)
        for session_id in list(bound_session_ids):
            if not await stream_manager.has_subscribers(session_id):
                await _unregister_keydex_watcher(keydex_watcher, session_id)
        trace_id_var.reset(trace_token)
        logger.info(
            f"[WebSocket] 连接清理完成 | trace_id={connection_trace_id} | "
            f"bound_session_id={bound_session_id or '-'} | "
            f"subscriptions={len(bound_session_ids)}"
        )


def _payload(message: dict[str, Any]) -> dict[str, Any]:
    nested = message.get("data")
    if isinstance(nested, dict):
        return nested
    return {key: value for key, value in message.items() if key != "action"}


async def _start_a2ui_resume(
    *,
    websocket: WebSocket,
    runtime: Any,
    repositories: Any,
    adapter: WebSocketChannelAdapter,
    interaction_id: str,
    turn_index: int,
    should_resume: bool,
) -> A2UIResumeStartResult | None:
    interaction = repositories.a2ui_interactions.get(interaction_id)
    if interaction is None:
        return None
    if not should_resume:
        return None
    override = getattr(websocket.app.state, "a2ui_resume_service", None)
    service = override or await _build_a2ui_resume_service(
        runtime=runtime,
        repositories=repositories,
        adapter=adapter,
        session_id=interaction.session_id,
        turn_index=turn_index,
    )
    return await service.start_resume(interaction_id, background=True)


async def _build_a2ui_resume_service(
    *,
    runtime: Any,
    repositories: Any,
    adapter: WebSocketChannelAdapter,
    session_id: str,
    turn_index: int,
) -> A2UIResumeService:
    chat_service = await _resolve_chat_service(runtime)
    dispatcher = EventDispatcher()
    dispatcher.register_projection(
        PersistenceProjection(
            repository=repositories.message_events,
            session_id=session_id,
            turn_index=turn_index,
        )
    )
    dispatcher.register_projection(ChatProjection(adapter))

    async def agent_factory(snapshot: A2UIResumeSnapshot) -> Any:
        session = repositories.sessions.get(snapshot.session_id)
        if session is None:
            raise A2UIResumeServiceError(
                f"A2UI resume session not found: {snapshot.session_id}"
            )
        provider_id = str(session.current_model_provider_id or "").strip()
        model = str(session.current_model or "").strip()
        model_selection = resolve_model_selection(
            repositories,
            provider_id=provider_id,
            model=model,
            scope=MODEL_DEFAULT_CHAT,
            label="对话模型",
            code_prefix="chat_model",
        )
        request = ChatRequest(
            session_id=session.id,
            message="",
            user_id=session.user_id,
            scene_id=session.scene_id,
            provider_id=provider_id,
            model=model,
        )
        keydex_snapshot = await asyncio.to_thread(
            chat_service._resolve_session_keydex_snapshot,
            session,
        )
        tool_context, enable_tools = chat_service._build_tool_context(
            request=request,
            session=session,
            trace_id=snapshot.trace_id or "",
            turn_index=snapshot.turn_index,
            keydex_snapshot=keydex_snapshot,
        )
        tool_context.metadata["repositories"] = repositories
        tool_context.metadata["thread_task_service"] = chat_service.thread_task_service
        tool_context.metadata["dispatcher"] = dispatcher
        tool_context.metadata["data_dir"] = str(chat_service.settings.data_dir)
        tool_context.metadata["active_session_id"] = (
            snapshot.langgraph_thread_id
            or snapshot.active_session_id
            or snapshot.session_id
        )
        tool_context.metadata["thread_id"] = tool_context.metadata["active_session_id"]
        tool_context.metadata["checkpoint_ns"] = snapshot.checkpoint_ns
        runtime_tools = chat_service._build_mcp_runtime_tools(
            session=session,
            tool_context=tool_context,
            enable_tools=enable_tools,
        )
        return await asyncio.to_thread(
            chat_service.agent_runner.create_agent,
            model=model,
            model_settings=model_selection.settings,
            system_prompt=None,
            tool_context=tool_context,
            enable_tools=enable_tools,
            runtime_tools=runtime_tools,
        )

    return A2UIResumeService(
        repositories=repositories,
        dispatcher=dispatcher,
        agent_factory=agent_factory,
        recursion_limit=PRACTICAL_NO_RECURSION_LIMIT,
    )


async def _resolve_chat_service(runtime: Any) -> Any:
    chat_service = runtime.chat_service
    provider = getattr(chat_service, "provider", None)
    get_chat_service = getattr(provider, "get_chat_service_async", None)
    if callable(get_chat_service):
        return await get_chat_service()
    return chat_service


def _apply_resume_result(
    ack_payload: dict[str, Any],
    resume_result: A2UIResumeStartResult | None,
) -> None:
    if resume_result is None:
        return
    resume = ack_payload.setdefault("resume", {})
    resume["status"] = resume_result.resume_status
    resume["started"] = resume_result.started
    resume["resume_group_id"] = resume_result.resume_group_id
    resume["pending_count"] = resume_result.pending_count
    if resume_result.reason:
        resume["reason"] = resume_result.reason


def _runtime_params(payload: dict[str, Any]) -> dict[str, Any] | None:
    value = payload.get("runtime_params")
    if value is None:
        value = payload.get("runtimeParams")
    return value if isinstance(value, dict) else None


def _delivery_mode(payload: dict[str, Any]) -> str:
    value = payload.get("delivery_mode")
    if value is None:
        value = payload.get("deliveryMode")
    if value is None:
        value = payload.get("mode")
    cleaned = str(value or "").strip() or PENDING_INPUT_MODE_STEER
    return cleaned if cleaned in PENDING_INPUT_MODES else PENDING_INPUT_MODE_STEER


def _client_input_id(payload: dict[str, Any]) -> str | None:
    value = payload.get("client_input_id")
    if value is None:
        value = payload.get("clientInputId")
    cleaned = str(value or "").strip()
    return cleaned or None


def _attachments(payload: dict[str, Any]) -> list[dict[str, Any]] | None:
    value = payload.get("attachments")
    if not isinstance(value, list):
        return None
    return [item for item in value if isinstance(item, dict)]


async def _register_keydex_watcher(watcher: Any, session: dict[str, Any]) -> None:
    if watcher is None:
        return
    session_id = str(session.get("id") or "").strip()
    session_type = str(session.get("session_type") or "").strip()
    if not session_id or session_type not in {"chat", "workspace"}:
        return
    workspace_root = _workspace_root_for_session(session) if session_type == "workspace" else None
    if session_type == "chat" or workspace_root:
        await watcher.register_session(session_id, workspace_root)


async def _unregister_keydex_watcher(watcher: Any, session_id: str) -> None:
    if watcher is not None and session_id.strip():
        await watcher.unregister_session(session_id)


def _workspace_root_for_session(session: dict[str, Any]) -> str | None:
    workspace = session.get("workspace")
    if isinstance(workspace, dict):
        root_path = str(workspace.get("root_path") or "").strip()
        if root_path:
            return root_path
    cwd = str(session.get("cwd") or "").strip()
    return cwd or None
