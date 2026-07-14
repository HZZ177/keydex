from __future__ import annotations

import json
from typing import Any

from langchain.agents.middleware import AgentMiddleware, hook_config
from langchain_core.messages import AIMessage, RemoveMessage, ToolMessage
from langchain_core.messages.tool import tool_call as create_tool_call
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.core.logger import logger


class InvalidToolCallRecoveryMiddleware(AgentMiddleware):
    """把 invalid_tool_calls 修补为失败工具结果并保持工具消息批次闭合。

    abefore_model 负责混合 valid/invalid 调用在下一次模型请求前的修复；
    aafter_agent 保留用于全部调用均 invalid、Agent 原本准备结束的场景。
    """

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

    def _repair_invalid_tool_calls(
        self,
        messages: list[Any],
    ) -> tuple[list[Any], list[dict[str, Any]], bool]:
        patched_messages: list[Any] = []
        recovered_calls: list[dict[str, Any]] = []
        messages_updated = False
        index = 0

        while index < len(messages):
            message = messages[index]
            if not isinstance(message, AIMessage):
                patched_messages.append(message)
                index += 1
                continue

            invalid_tool_calls = list(getattr(message, "invalid_tool_calls", None) or [])
            if not invalid_tool_calls:
                patched_messages.append(message)
                index += 1
                continue

            promoted_tool_calls: list[dict[str, Any]] = []
            recovery_messages_by_id: dict[str, ToolMessage] = {}
            for invalid_tool_call in invalid_tool_calls:
                tool_name = self._normalize_tool_name(invalid_tool_call.get("name"))
                tool_call_id = self._normalize_tool_call_id(invalid_tool_call.get("id"))
                parsed_args, parse_error = self._parse_invalid_args(
                    invalid_tool_call.get("args")
                )
                promoted_tool_calls.append(
                    create_tool_call(name=tool_name, args=parsed_args, id=tool_call_id)
                )
                recovery_messages_by_id[tool_call_id] = self._build_recovery_tool_message(
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

            tool_calls = [
                *list(getattr(message, "tool_calls", None) or []),
                *promoted_tool_calls,
            ]
            patched_messages.append(
                message.model_copy(
                    update={"tool_calls": tool_calls, "invalid_tool_calls": []}
                )
            )
            messages_updated = True
            index += 1

            following_tool_messages: list[ToolMessage] = []
            while index < len(messages) and isinstance(messages[index], ToolMessage):
                following_tool_messages.append(messages[index])
                index += 1

            # OpenAI 兼容接口会按 tool_calls + invalid_tool_calls 的顺序重新序列化，
            # 因此对应 ToolMessage 也按修补后的 tool_calls 顺序重建，兼容严格校验模型。
            remaining_tool_messages = list(following_tool_messages)
            for tool_call in tool_calls:
                tool_call_id = str(tool_call.get("id") or "")
                matching_index = next(
                    (
                        position
                        for position, tool_message in enumerate(remaining_tool_messages)
                        if str(getattr(tool_message, "tool_call_id", "") or "")
                        == tool_call_id
                    ),
                    None,
                )
                if matching_index is not None:
                    patched_messages.append(remaining_tool_messages.pop(matching_index))
                    continue
                recovery_message = recovery_messages_by_id.get(tool_call_id)
                if recovery_message is not None:
                    patched_messages.append(recovery_message)

            patched_messages.extend(remaining_tool_messages)

        return patched_messages, recovered_calls, messages_updated

    async def abefore_model(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        messages = list((state or {}).get("messages") or [])
        if not messages:
            return None

        patched_messages, recovered_calls, messages_updated = (
            self._repair_invalid_tool_calls(messages)
        )
        if not messages_updated:
            return None

        logger.warning(
            "[InvalidToolCallRecoveryMiddleware] 模型调用前补齐 invalid_tool_calls "
            "对应的失败 ToolMessage | "
            f"recovered_calls={recovered_calls}"
        )
        return {
            "messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *patched_messages],
        }

    @hook_config(can_jump_to=["model"])
    async def aafter_agent(self, state: Any, runtime: Any) -> dict[str, Any] | None:
        messages = list((state or {}).get("messages") or [])
        if not messages:
            return None

        recent_retry_count = self._count_recent_recovery_messages(messages)
        patched_messages, recovered_calls, messages_updated = (
            self._repair_invalid_tool_calls(messages)
        )

        if not messages_updated:
            return None

        result: dict[str, Any] = {
            "messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *patched_messages],
        }
        if recovered_calls and recent_retry_count < self._max_retries_per_turn:
            result["jump_to"] = "model"
            logger.warning(
                "[InvalidToolCallRecoveryMiddleware] invalid_tool_calls 已补失败 "
                "ToolMessage 并跳回 model | "
                f"retry_count={recent_retry_count + 1} | recovered_calls={recovered_calls}"
            )
        return result
