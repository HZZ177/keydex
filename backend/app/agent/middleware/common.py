from __future__ import annotations

import json
from typing import Any

from langchain_core.messages import BaseMessage

from backend.app.storage import SessionRecord


class DuplicateToolForceStopError(RuntimeError):
    """重复工具调用达到强制终止阈值。"""

    def __init__(self, *, tool_name: str, repeat_count: int) -> None:
        super().__init__(
            f"工具 `{tool_name}` 使用相同参数连续调用已达 {repeat_count} 次，已强制终止本轮对话"
        )
        self.tool_name = tool_name
        self.repeat_count = repeat_count


def _tool_signature(tool_call: Any) -> str:
    name = str(tool_call.get("name") or "")
    args = tool_call.get("args") or {}
    try:
        args_text = json.dumps(args, sort_keys=True, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        args_text = str(args)
    return f"{name}:{args_text}"


def _state_messages(state: Any) -> list[BaseMessage]:
    if isinstance(state, dict):
        raw_messages = state.get("messages") or []
    else:
        raw_messages = getattr(state, "messages", [])
    return [message for message in list(raw_messages or []) if isinstance(message, BaseMessage)]


def _session_payload(record: SessionRecord) -> dict[str, Any]:
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
        "workspace_id": record.workspace_id,
        "session_type": record.session_type,
        "cwd": record.cwd,
        "workspace_roots": record.workspace_roots,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "is_debug": record.is_debug,
        "is_scheduled": record.is_scheduled,
    }


def _compression_display_label(value: Any) -> str:
    labels = {
        "abefore_model": "模型调用前",
        "aafter_agent": "代理完成后",
        "no_messages": "无消息",
        "missing_session": "缺少会话上下文",
        "session_not_found": "会话不存在",
        "compression_started": "开始压缩上下文",
        "compression_completed": "上下文压缩完成",
        "compression_failed": "上下文压缩失败",
        "skip_compression": "跳过上下文压缩",
        "return_compressed_context": "使用压缩后的上下文",
    }
    return labels.get(str(value), str(value))
