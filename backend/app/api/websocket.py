from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

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
from backend.app.services import (
    ChatRequest,
    ChatStreamAlreadyRunningError,
    ChatStreamMissingSessionError,
    SessionNotFoundError,
    SessionService,
    SessionValidationError,
    WorkspaceServiceError,
)

router = APIRouter(prefix="/agent-base/ws", tags=["websocket"])


class WebSocketChannelAdapter:
    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self._send_lock = asyncio.Lock()

    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        payload = dict(data or {})
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
    if bound_session_id:
        bound_session_ids.add(bound_session_id)
        await stream_manager.subscribe(bound_session_id, adapter)
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
        payload = {"code": code, "message": message, **(data or {})}
        await send("error", payload)

    try:
        while True:
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
                    "[WebSocket] 收到非法 JSON | "
                    f"trace_id={connection_trace_id} | error={exc}"
                )
                await send_error("parse_error", f"消息不是合法 JSON：{exc}")
                continue

            action = str(message.get("action") or "").strip()
            payload = _payload(message)
            if not action:
                logger.warning(f"[WebSocket] 缺少 action | trace_id={connection_trace_id}")
                await send_error("missing_action", "action 字段必填")
                continue

            try:
                logger.info(
                    f"[WebSocket] 收到 action | trace_id={connection_trace_id} | "
                    f"action={action} | bound_session_id={bound_session_id or '-'}"
                )
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
                    )
                    bound_session_id = session["id"]
                    bound_session_ids.add(bound_session_id)
                    await stream_manager.subscribe(bound_session_id, adapter)
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
                    session_service.get_session_detail(session_id)
                    bound_session_id = session_id
                    bound_session_ids.add(session_id)
                    await stream_manager.subscribe(session_id, adapter)
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
                    await send("unbind_ok", {"session_id": session_id})
                    continue

                if action == "chat":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    if not session_id:
                        await send_error("missing_session", "session_id 必填")
                        continue
                    session_service.get_session_detail(session_id)
                    bound_session_id = session_id
                    bound_session_ids.add(session_id)
                    await stream_manager.subscribe(session_id, adapter)
                    await stream_manager.start_chat(
                        ChatRequest(
                            session_id=session_id,
                            message=str(payload.get("message") or payload.get("content") or ""),
                            user_id=str(payload.get("user_id") or settings.default_user_id),
                            scene_id=str(payload.get("scene_id") or settings.default_scene_id),
                            model=str(payload.get("model") or ""),
                            system_prompt=payload.get("system_prompt"),
                            runtime_params=_runtime_params(payload),
                        )
                    )
                    continue

                if action == "cancel":
                    session_id = str(payload.get("session_id") or bound_session_id or "").strip()
                    cancelled = await stream_manager.cancel(session_id)
                    logger.info(
                        f"[WebSocket] 收到取消请求 | trace_id={connection_trace_id} | "
                        f"session_id={session_id or '-'} | cancelled={cancelled}"
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


def _runtime_params(payload: dict[str, Any]) -> dict[str, Any] | None:
    value = payload.get("runtime_params")
    if value is None:
        value = payload.get("runtimeParams")
    return value if isinstance(value, dict) else None
