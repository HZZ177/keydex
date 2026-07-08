from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ToolCallRequest
from langchain_core.messages import ToolMessage
from langgraph.errors import GraphBubbleUp
from langgraph.types import Command

from backend.app.agent.middleware.common import DuplicateToolForceStopError
from backend.app.core.logger import logger


class ToolErrorHandlingMiddleware(AgentMiddleware):
    """把普通工具异常转换成可被模型继续读取的错误工具消息。"""

    @staticmethod
    def _build_error_message(request: ToolCallRequest, error: Exception) -> ToolMessage:
        tool_call = request.tool_call or {}
        tool_name = (
            str(tool_call.get("name") or getattr(request.tool, "name", None) or "unknown_tool")
        )
        tool_call_id = str(tool_call.get("id") or "unknown_tool_call")
        error_type = type(error).__name__
        error_text = str(error).strip() or "工具执行失败"
        content = (
            f"工具 `{tool_name}` 执行失败。"
            f"错误类型: {error_type}。"
            f"错误信息: {error_text}。"
            f"请根据错误信息调整参数后重试，或改用其他可行工具。"
        )
        return ToolMessage(
            content=content,
            tool_call_id=tool_call_id,
            name=tool_name,
            status="error",
        )

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        try:
            return await handler(request)
        except DuplicateToolForceStopError:
            raise
        except GraphBubbleUp:
            raise
        except Exception as exc:
            tool_call = request.tool_call or {}
            logger.warning(
                f"[AgentMiddleware] 工具调用异常已转换为工具消息 | "
                f"工具={tool_call.get('name') or '-'} | 错误类型={type(exc).__name__} | 错误={exc}"
            )
            return self._build_error_message(request, exc)
