from __future__ import annotations

import json
from typing import Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain_core.messages import AIMessage, RemoveMessage, ToolMessage
from langchain_core.messages.tool import tool_call as create_tool_call
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.core.logger import logger


class InvalidToolCallRecoveryMiddleware(AgentMiddleware):
    """把模型输出的 invalid_tool_calls 修补为失败工具结果并触发重试。"""

    RECOVERY_MESSAGE_PREFIX = "[invalid_tool_call_recovery]"

    def __init__(self, max_retries_per_turn: int = 3) -> None:
        super().__init__()
        self._max_retries_per_turn = max(int(max_retries_per_turn), 0)

    @classmethod
    def _count_recent_recovery_messages(cls, messages: list[Any]) -> int:
        count = 0
        for message in reversed(messages):
            if getattr(message, "type", None) == "human":
                break
            if not isinstance(message, ToolMessage):
                continue
            content = str(getattr(message, "content", "") or "")
            if content.startswith(cls.RECOVERY_MESSAGE_PREFIX):
                count += 1
        return count

    @staticmethod
    def _normalize_tool_name(tool_name: Any) -> str:
        return str(tool_name or "unknown_tool")

    @staticmethod
    def _normalize_tool_call_id(tool_call_id: Any) -> str:
        return str(tool_call_id or "invalid_tool_call")

    @staticmethod
    def _parse_invalid_args(raw_args: Any) -> tuple[dict[str, Any], str | None]:
        if isinstance(raw_args, dict):
            return raw_args, None
        if raw_args is None:
            return {}, "参数为空"
        if not isinstance(raw_args, str):
            return {}, f"参数类型 {type(raw_args).__name__} 非法，应为 JSON 字符串"
        try:
            parsed = json.loads(raw_args)
        except json.JSONDecodeError as exc:
            return {}, f"{exc.msg} (pos={exc.pos})"
        except Exception as exc:  # pragma: no cover - defensive json guard
            return {}, str(exc)
        if not isinstance(parsed, dict):
            return {}, f"参数 JSON 顶层类型为 {type(parsed).__name__}，应为 object"
        return parsed, None

    def _build_recovery_tool_message(
        self,
        *,
        tool_name: str,
        tool_call_id: str,
        parse_error: str | None,
    ) -> ToolMessage:
        content = (
            f"{self.RECOVERY_MESSAGE_PREFIX} 工具 `{tool_name}` 调用失败："
            "参数 JSON 非法，系统未执行该工具。"
        )
        if parse_error:
            content += f" 解析错误：{parse_error}。"
        content += " 请修正参数后重新发起工具调用。"
        return ToolMessage(
            content=content,
            name=tool_name,
            tool_call_id=tool_call_id,
            status="error",
        )

    @hook_config(can_jump_to=["model"])
    async def aafter_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        messages = list((state or {}).get("messages") or [])
        if not messages:
            return None

        recent_retry_count = self._count_recent_recovery_messages(messages)
        patched_messages: list[Any] = []
        recovered_calls: list[dict[str, Any]] = []
        should_retry = False
        messages_updated = False

        for index, message in enumerate(messages):
            patched_messages.append(message)
            if not isinstance(message, AIMessage):
                continue

            invalid_tool_calls = list(getattr(message, "invalid_tool_calls", None) or [])
            if not invalid_tool_calls:
                continue

            ai_message_index = len(patched_messages) - 1
            tool_calls = list(getattr(message, "tool_calls", None) or [])
            for invalid_tool_call in invalid_tool_calls:
                tool_name = self._normalize_tool_name(invalid_tool_call.get("name"))
                tool_call_id = self._normalize_tool_call_id(invalid_tool_call.get("id"))
                parsed_args, parse_error = self._parse_invalid_args(
                    invalid_tool_call.get("args")
                )
                tool_calls.append(
                    create_tool_call(name=tool_name, args=parsed_args, id=tool_call_id)
                )
                recovery_tool_message = self._build_recovery_tool_message(
                    tool_name=tool_name,
                    tool_call_id=tool_call_id,
                    parse_error=parse_error,
                )
                recovered_calls.append(
                    {
                        "tool_name": tool_name,
                        "tool_call_id": tool_call_id,
                        "parse_error": parse_error,
                    }
                )

                corresponding_tool_message = next(
                    (
                        later_message
                        for later_message in messages[index + 1 :]
                        if isinstance(later_message, ToolMessage)
                        and getattr(later_message, "tool_call_id", None) == tool_call_id
                    ),
                    None,
                )
                if corresponding_tool_message is None:
                    patched_messages.append(recovery_tool_message)

                should_retry = True

            patched_messages[ai_message_index] = message.model_copy(
                update={"tool_calls": tool_calls, "invalid_tool_calls": []}
            )
            messages_updated = True

        if not messages_updated:
            return None

        result: dict[str, Any] = {
            "messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *patched_messages],
        }
        if should_retry and recent_retry_count < self._max_retries_per_turn:
            result["jump_to"] = "model"
            logger.warning(
                "[InvalidToolCallRecoveryMiddleware] invalid_tool_calls 已补失败 "
                "ToolMessage 并跳回 model | "
                f"retry_count={recent_retry_count + 1} | recovered_calls={recovered_calls}"
            )
        return result
