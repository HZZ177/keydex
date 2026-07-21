from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
from pathlib import Path
from typing import Any

from backend.app.agent.tool_results.artifact_access import ToolResultArtifactAccess
from backend.app.storage import StorageRepositories
from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.registry import ToolRegistry

READ_TOOL_RESULT_NAME = "read_tool_result"
DEFAULT_READ_TOOL_RESULT_BYTES = 16 * 1024
MAX_READ_TOOL_RESULT_BYTES = 24 * 1024
_CURSOR_SECRET = secrets.token_bytes(32)


def create_tool_result_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name=READ_TOOL_RESULT_NAME,
            description=(
                "按 opaque artifact_id 分页回读此前被截断或清理的精确工具结果。"
                "只在当前投影信息不足以完成任务时使用；不得传入文件路径。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "artifact_id": {
                        "type": "string",
                        "description": "工具投影或 tombstone 返回的 opaque artifact ID。",
                    },
                    "cursor": {
                        "type": "string",
                        "description": "上次 read_tool_result 返回的 next_cursor。",
                    },
                    "max_bytes": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_READ_TOOL_RESULT_BYTES,
                        "default": DEFAULT_READ_TOOL_RESULT_BYTES,
                    },
                },
                "required": ["artifact_id"],
                "additionalProperties": False,
            },
            handler=read_tool_result,
        )
    ]


def register_tool_result_tools(registry: ToolRegistry) -> ToolRegistry:
    for tool in create_tool_result_tools():
        registry.register(tool)
    return registry


async def read_tool_result(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    artifact_id = str(args.get("artifact_id") or "").strip()
    if not artifact_id:
        raise ToolExecutionError("artifact_id 不能为空", code="invalid_tool_args")
    max_bytes = _positive_int(args.get("max_bytes"), DEFAULT_READ_TOOL_RESULT_BYTES)
    max_bytes = min(max_bytes, MAX_READ_TOOL_RESULT_BYTES)
    repositories = context.metadata.get("repositories")
    data_dir = context.metadata.get("data_dir")
    if not isinstance(repositories, StorageRepositories) or not data_dir:
        raise ToolExecutionError(
            "工具结果存储当前不可用",
            code="tool_result_store_unavailable",
        )
    verified = ToolResultArtifactAccess(
        repositories=repositories,
        data_dir=Path(str(data_dir)),
    ).verify(
        artifact_id,
        user_id=context.user_id,
        session_id=context.session_id,
    )
    normalized = verified.path.read_bytes().decode("utf-8", errors="replace").encode("utf-8")
    offset = _cursor_offset(
        str(args.get("cursor") or ""),
        artifact_id=artifact_id,
        sha256=verified.record.content_sha256,
    )
    if offset > len(normalized):
        raise ToolExecutionError("回读游标超出范围", code="invalid_tool_result_cursor")
    end = _utf8_page_end(normalized, offset=offset, max_bytes=max_bytes)
    chunk_bytes = normalized[offset:end]
    chunk = chunk_bytes.decode("utf-8")
    next_cursor = (
        _issue_cursor(artifact_id=artifact_id, sha256=verified.record.content_sha256, offset=end)
        if end < len(normalized)
        else None
    )
    repositories.tool_result_artifacts.touch(artifact_id)
    return {
        "artifact_id": artifact_id,
        "tool_name": verified.record.tool_name,
        "content_type": verified.record.content_type,
        "artifact_complete": verified.record.is_complete,
        "chunk": chunk,
        "chunk_bytes": len(chunk_bytes),
        "total_bytes": len(normalized),
        "offset": offset,
        "next_cursor": next_cursor,
        "is_complete": next_cursor is None,
    }


def _utf8_page_end(value: bytes, *, offset: int, max_bytes: int) -> int:
    end = min(len(value), offset + max_bytes)
    while end > offset:
        try:
            value[offset:end].decode("utf-8")
            return end
        except UnicodeDecodeError:
            end -= 1
    return offset


def _issue_cursor(*, artifact_id: str, sha256: str, offset: int) -> str:
    payload = json.dumps(
        {"artifact_id": artifact_id, "sha256": sha256, "offset": offset},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    signature = hmac.new(_CURSOR_SECRET, encoded.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{encoded}.{signature}"


def _cursor_offset(cursor: str, *, artifact_id: str, sha256: str) -> int:
    if not cursor:
        return 0
    try:
        encoded, signature = cursor.split(".", 1)
        expected = hmac.new(_CURSOR_SECRET, encoded.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("signature")
        payload = json.loads(
            base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)).decode("utf-8")
        )
        if payload.get("artifact_id") != artifact_id or payload.get("sha256") != sha256:
            raise ValueError("binding")
        return max(0, int(payload.get("offset") or 0))
    except Exception as exc:
        raise ToolExecutionError(
            "工具结果回读游标无效",
            code="invalid_tool_result_cursor",
        ) from exc


def _positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, parsed)
