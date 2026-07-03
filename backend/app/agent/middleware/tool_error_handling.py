from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents.middleware import AgentMiddleware, ToolCallRequest
from langchain_core.messages import ToolMessage
from langgraph.types import Command

from backend.app.agent.middleware.common import DuplicateToolForceStopError
from backend.app.core.logger import logger


class ToolErrorHandlingMiddleware(AgentMiddleware):
    """把普通工具异常转换成可被模型继续读取的错误工具消息。"""

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command[Any]]],
    ) -> ToolMessage | Command[Any]:
        try:
            return await handler(request)
        except DuplicateToolForceStopError:
            raise
        except Exception as exc:
            tool_call = request.tool_call or {}
            logger.opt(exception=True).error(
                f"[AgentMiddleware] 工具调用异常已转换为工具消息 | "
                f"工具={tool_call.get('name') or '-'} | 错误={exc}"
            )
            return ToolMessage(
                content=json.dumps(
                    {
                        "code": "tool_execution_failed",
                        "message": str(exc),
                        "type": type(exc).__name__,
                    },
                    ensure_ascii=False,
                ),
                tool_call_id=str(tool_call.get("id") or ""),
                name=str(tool_call.get("name") or ""),
                status="error",
            )
