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
        "staging_failed": "压缩暂存应用失败",
        "staging_applied": "压缩暂存已应用",
        "emergency_triggered": "触发紧急压缩",
        "emergency_failed": "紧急压缩失败",
        "emergency_replacement_failed": "紧急压缩替换失败",
        "emergency_completed": "紧急压缩完成",
        "background_triggered": "触发后台压缩",
        "background_failed": "后台压缩失败",
        "background_fork_failed": "后台压缩派生活动会话失败",
        "background_completed": "后台压缩完成",
        "anchor_not_found": "未找到锚点",
        "fork_active_session_failed": "派生活动会话失败",
        "trigger_emergency_compression": "触发紧急压缩",
        "skip_emergency_compression": "跳过紧急压缩",
        "return_staging_replaced_context": "使用暂存替换后的上下文",
        "emergency_compression_fallback": "紧急压缩回退",
        "return_emergency_compressed_context": "使用紧急压缩后的上下文",
        "schedule_background_compression": "调度后台压缩",
        "skip_background_compression": "跳过后台压缩",
    }
    return labels.get(str(value), str(value))
