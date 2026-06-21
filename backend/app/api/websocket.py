from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.request_context import trace_id_var
from backend.app.services import (
    ChatCancellationToken,
    ChatRequest,
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
    session_service = SessionService(
        repositories.sessions,
        repositories.message_events,
        repositories.workspaces,
    )
    adapter = WebSocketChannelAdapter(websocket)
    bound_session_id = str(websocket.query_params.get("session_id") or "").strip() or None
    current_task: asyncio.Task | None = None
    current_token: ChatCancellationToken | None = None
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

    async def run_chat(payload: dict[str, Any], token: ChatCancellationToken) -> None:
        nonlocal bound_session_id
        session_id = str(payload.get("session_id") or bound_session_id or "").strip() or None
        result = await runtime.chat_service.handle_chat(
            ChatRequest(
                session_id=session_id,
                message=str(payload.get("message") or payload.get("content") or ""),
                user_id=str(payload.get("user_id") or settings.default_user_id),
                scene_id=str(payload.get("scene_id") or settings.default_scene_id),
                model=str(payload.get("model") or ""),
                system_prompt=payload.get("system_prompt"),
            ),
            chat_adapter=adapter,
            cancellation=token,
        )
        bound_session_id = result.session_id

    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                logger.info(
                    f"[WebSocket] 客户端断开 | trace_id={connection_trace_id} | "
                    f"bound_session_id={bound_session_id or '-'}"
                )
                if current_token is not None:
                    current_token.cancel()
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
                    await send("unbind_ok", {"session_id": session_id})
                    continue

                if action == "chat":
                    if current_task is not None and not current_task.done():
                        await send_error("chat_running", "当前会话已有对话正在执行")
                        continue
                    current_token = ChatCancellationToken()
                    current_task = asyncio.create_task(run_chat(payload, current_token))
                    current_task.add_done_callback(_log_task_exception)
                    continue

                if action == "cancel":
                    if current_token is not None:
                        current_token.cancel()
                    logger.info(
                        f"[WebSocket] 收到取消请求 | trace_id={connection_trace_id} | "
                        f"session_id={bound_session_id or '-'}"
                    )
                    continue

                if action == "ping":
                    await send("pong", {"timestamp": int(time.time())})
                    continue

                if action == "get_status":
                    await send(
                        "status",
                        {
                            "session_id": bound_session_id,
                            "status": "running"
                            if current_task is not None and not current_task.done()
                            else "idle",
                        },
                    )
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
            except Exception as exc:
                logger.opt(exception=True).error(
                    f"[WebSocket] action 处理失败 | trace_id={connection_trace_id} | "
                    f"action={action} | error={exc}"
                )
                await send_error("ws_action_error", str(exc))
    finally:
        if current_token is not None:
            current_token.cancel()
        trace_id_var.reset(trace_token)
        logger.info(
            f"[WebSocket] 连接清理完成 | trace_id={connection_trace_id} | "
            f"bound_session_id={bound_session_id or '-'}"
        )


def _payload(message: dict[str, Any]) -> dict[str, Any]:
    nested = message.get("data")
    if isinstance(nested, dict):
        return nested
    return {key: value for key, value in message.items() if key != "action"}


def _log_task_exception(task: asyncio.Task) -> None:
    try:
        task.result()
    except asyncio.CancelledError:
        logger.info("[WebSocket] 后台 chat task 已取消")
        return
    except Exception as exc:
        logger.opt(exception=True).error(f"[WebSocket] 后台 chat task 异常 | error={exc}")
        return
