from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Any

import httpx
import openai
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
    ToolMessage,
)
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from backend.app.agent import AgentRunner
from backend.app.agent.event_processor import AgentEventResult, process_agent_events
from backend.app.agent.middleware.common import DuplicateToolForceStopError
from backend.app.agent.tool_call_preset import ToolCallPreset, ToolCallPresetItem
from backend.app.agent.tool_capabilities import ToolCapability
from backend.app.command_approval import ApprovalService, load_command_settings
from backend.app.core.config import AppSettings
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.events import (
    ChatProjection,
    ChatProjectionAdapter,
    DomainEventType,
    EventDispatcher,
    PersistenceProjection,
    TurnCompletedAggregator,
)
from backend.app.keydex import KeydexRuntimeCache
from backend.app.keydex.runtime import KeydexEffectiveRuntimeSnapshot
from backend.app.keydex.skills import EffectiveSkillCatalog
from backend.app.mcp.runtime import McpRuntimeSnapshotBuilder, McpRuntimeSnapshotContext
from backend.app.mcp.tools import (
    McpActiveToolWindow,
    McpToolExecutor,
    mcp_capability_discovery_tools_from_snapshot,
    mcp_local_tools_from_snapshot,
)
from backend.app.model import (
    ModelSelectionError,
    ResolvedModelSelection,
    is_stream_chunk_timeout_error,
    resolve_model_selection,
    stream_chunk_timeout_details,
)
from backend.app.services.archive_lifecycle_service import ArchiveLifecycleError
from backend.app.services.chat_message_payload import (
    build_user_runtime_message as _build_user_runtime_message,
)
from backend.app.services.chat_message_payload import (
    resolve_image_attachments,
)
from backend.app.services.chat_types import ChatCancellationToken, ChatRequest, ChatTurnResult
from backend.app.services.file_history_service import FileHistoryService
from backend.app.services.message_event_service import MessageEventService
from backend.app.services.thread_task_prompt import build_task_initial_prompt
from backend.app.services.thread_task_service import ThreadTaskService
from backend.app.services.workspace_service import WorkspaceService
from backend.app.storage import AttachmentRecord, SessionRecord, StorageRepositories
from backend.app.tools import LocalTool, ToolExecutionContext
from backend.app.tools.command_runtime import command_process_manager
from backend.app.tools.web import create_web_fetch_tool, create_web_search_tool
from backend.app.web.errors import WebProviderError
from backend.app.web.models import WebCapability
from backend.app.web.registry import build_default_web_provider_registry
from backend.app.web.service import WebService

# LangGraph requires a positive integer recursion_limit and does not expose an
# infinite value. 99999 is intentionally used as a practical no-limit sentinel
# for desktop agent runs.
PRACTICAL_NO_RECURSION_LIMIT = 99_999


class NullChatProjectionAdapter:
    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        return False


class MessageInjectionType(StrEnum):
    SLOT = "slot"
    FOLLOW = "follow"


class MessageInjectionRole(StrEnum):
    SYSTEM = "SystemMessage"
    HUMAN = "HumanMessage"
    AI = "AIMessage"


@dataclass(frozen=True)
class InjectedMessage:
    type: MessageInjectionType
    role: MessageInjectionRole
    content: str
    message_time: str | None = None
    metadata: dict[str, Any] | None = None
    hidden_for_transcript: bool = False


@dataclass(frozen=True)
class SkillActivationRequest:
    skill_name: str
    source: str = "workspace"
    origin: str | None = None


class SkillActivationError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass(frozen=True)
class AgentLoopOutcome:
    event_result: AgentEventResult
    output_checkpoint_id: str | None
    output_checkpoint_ns: str


_SLOT_MESSAGE_ID = "keydex_slot_system_fixed"
CANCELLED_CHECKPOINT_NOTICE = "[用户在此处取消]"
CURRENT_TURN_MESSAGE_MARKER = "_keydex_current_turn"


def _build_message_injection_items(runtime_params: dict[str, Any] | None) -> list[InjectedMessage]:
    if not runtime_params:
        return []
    if not isinstance(runtime_params, dict):
        raise ValueError("runtime_params 必须是对象")
    raw_items = runtime_params.get("message_injection")
    if raw_items is None:
        raw_items = runtime_params.get("messageInjection")
    if raw_items is None:
        return []
    if not isinstance(raw_items, list):
        raise ValueError("runtime_params.message_injection 必须是数组")

    items: list[InjectedMessage] = []
    for index, raw_item in enumerate(raw_items):
        if not isinstance(raw_item, dict):
            raise ValueError(f"message_injection[{index}] 必须是对象")
        raw_type = str(raw_item.get("type") or "").strip()
        raw_role = str(raw_item.get("role") or "").strip()
        content = str(raw_item.get("content") or "").strip()
        if not content:
            raise ValueError(f"message_injection[{index}].content 不能为空")
        try:
            injection_type = MessageInjectionType(raw_type)
        except ValueError as exc:
            raise ValueError(f"message_injection[{index}].type 不支持: {raw_type}") from exc
        try:
            role = MessageInjectionRole(raw_role)
        except ValueError as exc:
            raise ValueError(f"message_injection[{index}].role 不支持: {raw_role}") from exc
        metadata = raw_item.get("metadata")
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError(f"message_injection[{index}].metadata 必须是对象")
        raw_hidden_for_transcript = raw_item.get("hidden_for_transcript")
        if raw_hidden_for_transcript is None:
            raw_hidden_for_transcript = raw_item.get("hiddenForTranscript")
        if raw_hidden_for_transcript is None and isinstance(metadata, dict):
            raw_hidden_for_transcript = metadata.get("hidden_for_transcript")
        if raw_hidden_for_transcript is None and isinstance(metadata, dict):
            raw_hidden_for_transcript = metadata.get("hiddenForTranscript")
        if raw_hidden_for_transcript is not None and not isinstance(
            raw_hidden_for_transcript,
            bool,
        ):
            raise ValueError(f"message_injection[{index}].hidden_for_transcript 必须是布尔值")
        message_time = raw_item.get("message_time")
        if message_time is None:
            message_time = raw_item.get("messageTime")
        items.append(
            InjectedMessage(
                type=injection_type,
                role=role,
                content=content,
                message_time=str(message_time).strip() if message_time else None,
                metadata=dict(metadata or {}),
                hidden_for_transcript=bool(raw_hidden_for_transcript),
            )
        )

    slot_items = [item for item in items if item.type == MessageInjectionType.SLOT]
    if len(slot_items) > 1:
        raise ValueError("同一请求中 type=slot 至多一条")
    if slot_items and slot_items[0].role != MessageInjectionRole.SYSTEM:
        raise ValueError("type=slot 时 role 必须为 SystemMessage")
    return items


def _build_message_context_items(runtime_params: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not runtime_params:
        return []
    if not isinstance(runtime_params, dict):
        raise ValueError("runtime_params 必须是对象")
    raw_items = runtime_params.get("message_context_items")
    if raw_items is None:
        raw_items = runtime_params.get("messageContextItems")
    if raw_items is None:
        return []
    if not isinstance(raw_items, list):
        raise ValueError("runtime_params.message_context_items 必须是数组")

    items: list[dict[str, Any]] = []
    for index, raw_item in enumerate(raw_items):
        if not isinstance(raw_item, dict):
            raise ValueError(f"message_context_items[{index}] 必须是对象")
        metadata = raw_item.get("metadata")
        if metadata is not None and not isinstance(metadata, dict):
            raise ValueError(f"message_context_items[{index}].metadata 必须是对象")
        item_type = str(raw_item.get("type") or "").strip() or "follow"
        label = str(raw_item.get("label") or raw_item.get("name") or "").strip() or "上下文"
        content = str(raw_item.get("content") or "").strip()
        item = {
            "id": str(raw_item.get("id") or f"context:{index}").strip(),
            "type": item_type,
            "label": label,
            "content": content,
            "role": str(raw_item.get("role") or "HumanMessage").strip(),
            "source": str(raw_item.get("source") or "runtime").strip(),
            "metadata": dict(metadata or {}),
        }
        for key in (
            "path",
            "name",
            "fileType",
            "file_type",
            "skill_name",
            "skillName",
            "description",
            "locator",
        ):
            if raw_item.get(key) is not None:
                item[key] = raw_item.get(key)
        items.append(item)
    return items


def _should_hide_user_message_for_injection_turn(
    request: ChatRequest,
    message_injection: list[InjectedMessage],
) -> bool:
    if _should_hide_user_message_for_runtime_params(request.runtime_params):
        return True
    return (
        not request.message.strip()
        and not request.attachments
        and bool(message_injection)
        and all(item.hidden_for_transcript for item in message_injection)
    )


def _should_hide_user_message_for_runtime_params(runtime_params: dict[str, Any] | None) -> bool:
    if not isinstance(runtime_params, dict):
        return False
    raw = runtime_params.get("hide_user_message_for_transcript")
    if raw is None:
        raw = runtime_params.get("hideUserMessageForTranscript")
    if raw is True:
        return True
    thread_task = runtime_params.get("thread_task")
    if thread_task is None:
        thread_task = runtime_params.get("threadTask")
    if isinstance(thread_task, dict):
        raw = thread_task.get("hide_user_message_for_transcript")
        if raw is None:
            raw = thread_task.get("hideUserMessageForTranscript")
        return raw is True
    return False


def _build_thread_task_runtime_context(
    runtime_params: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not runtime_params:
        return None
    if not isinstance(runtime_params, dict):
        raise ValueError("runtime_params 必须是对象")
    raw_context = runtime_params.get("thread_task")
    if raw_context is None:
        raw_context = runtime_params.get("threadTask")
    if raw_context is None:
        return None
    if not isinstance(raw_context, dict):
        raise ValueError("runtime_params.thread_task 必须是对象")
    task_id = str(raw_context.get("task_id") or raw_context.get("taskId") or "").strip()
    run_id = str(raw_context.get("run_id") or raw_context.get("runId") or "").strip()
    trigger = str(raw_context.get("trigger") or "").strip()
    if not task_id:
        raise ValueError("runtime_params.thread_task.task_id 不能为空")
    if not run_id:
        raise ValueError("runtime_params.thread_task.run_id 不能为空")
    if trigger != "task_continue":
        raise ValueError("runtime_params.thread_task.trigger 必须为 task_continue")
    return {
        "task_id": task_id,
        "run_id": run_id,
        "trigger": trigger,
        "type": str(raw_context.get("type") or raw_context.get("task_type") or "").strip(),
    }


def _build_initial_thread_task_context(
    runtime_params: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not runtime_params:
        return None
    if not isinstance(runtime_params, dict):
        raise ValueError("runtime_params 必须是对象")
    raw_context = runtime_params.get("initial_thread_task")
    if raw_context is None:
        raw_context = runtime_params.get("initialThreadTask")
    if raw_context is None:
        return None
    if not isinstance(raw_context, dict):
        raise ValueError("runtime_params.initial_thread_task 必须是对象")
    task_id = str(raw_context.get("task_id") or raw_context.get("taskId") or "").strip()
    trigger = str(raw_context.get("trigger") or "task_start").strip()
    if not task_id:
        raise ValueError("runtime_params.initial_thread_task.task_id 不能为空")
    if trigger != "task_start":
        raise ValueError("runtime_params.initial_thread_task.trigger 必须为 task_start")
    return {
        "task_id": task_id,
        "trigger": trigger,
        "type": str(raw_context.get("type") or raw_context.get("task_type") or "").strip(),
    }


def _is_goal_thread_task_context(context: dict[str, Any] | None) -> bool:
    return bool(
        context
        and context.get("trigger") == "task_continue"
        and context.get("type") == "goal"
    )


def _build_skill_activation_request(
    runtime_params: dict[str, Any] | None,
) -> SkillActivationRequest | None:
    if not runtime_params:
        return None
    if not isinstance(runtime_params, dict):
        raise SkillActivationError("skill_activation_invalid", "runtime_params must be an object")
    if "tool_call_preset" in runtime_params or "toolCallPreset" in runtime_params:
        raise SkillActivationError(
            "skill_activation_invalid",
            "runtime_params.tool_call_preset is not supported",
        )
    raw_activation = runtime_params.get("skill_activation")
    if raw_activation is None:
        raw_activation = runtime_params.get("skillActivation")
    if raw_activation is None:
        return None
    if not isinstance(raw_activation, dict):
        raise SkillActivationError(
            "skill_activation_invalid",
            "runtime_params.skill_activation must be an object",
        )

    raw_skill_name = raw_activation.get("skill_name")
    if raw_skill_name is None:
        raw_skill_name = raw_activation.get("skillName")
    skill_name = str(raw_skill_name or "").strip()
    if not skill_name:
        raise SkillActivationError(
            "skill_activation_invalid",
            "runtime_params.skill_activation.skill_name must not be empty",
        )

    source = str(raw_activation.get("source") or "workspace").strip() or "workspace"
    if source not in {"builtin", "system", "workspace"}:
        raise SkillActivationError(
            "skill_source_unsupported",
            "Skill source must be builtin, system, or workspace",
            {"source": source},
        )
    raw_origin = raw_activation.get("origin")
    origin = str(raw_origin).strip() if raw_origin else None
    return SkillActivationRequest(skill_name=skill_name, source=source, origin=origin)


def _build_skill_activation_preset(
    activation: SkillActivationRequest | None,
) -> ToolCallPreset | None:
    if activation is None:
        return None
    metadata: dict[str, Any] = {"source": activation.source}
    if activation.origin:
        metadata["origin"] = activation.origin
    return ToolCallPreset(
        type="force",
        producer="skill_activation",
        calls=[
            ToolCallPresetItem(
                name="load_skill",
                args={"skill_name": activation.skill_name, "source": activation.source},
            )
        ],
        metadata=metadata,
    )


def _chat_turn_error(exc: Exception) -> tuple[str, str, dict[str, Any]]:
    if isinstance(exc, ModelSelectionError):
        return exc.code, str(exc), exc.details
    if isinstance(exc, SkillActivationError):
        return exc.code, exc.message, exc.details
    if isinstance(exc, DuplicateToolForceStopError):
        return (
            "duplicate_tool_call_stopped",
            str(exc),
            {
                "tool_name": exc.tool_name,
                "repeat_count": exc.repeat_count,
            },
        )
    if isinstance(exc, openai.APITimeoutError):
        return (
            "llm_request_timeout",
            "模型请求超时，未收到模型服务响应",
            _exception_details(exc),
        )
    if isinstance(exc, httpx.ReadTimeout):
        return (
            "llm_read_timeout",
            "模型响应超时，未收到后续响应数据",
            _exception_details(exc),
        )
    if is_stream_chunk_timeout_error(exc):
        return (
            "llm_stream_chunk_timeout",
            "模型响应超时，未收到后续响应数据",
            _exception_details(exc, **stream_chunk_timeout_details(exc)),
        )
    if isinstance(exc, httpx.ConnectTimeout):
        return (
            "llm_connect_timeout",
            "模型服务连接超时",
            _exception_details(exc),
        )
    if isinstance(exc, httpx.TimeoutException):
        return (
            "llm_request_timeout",
            "模型请求超时，未收到模型服务响应",
            _exception_details(exc),
        )
    if isinstance(exc, openai.APIConnectionError):
        return (
            "llm_connection_error",
            "模型服务连接失败",
            _exception_details(exc),
        )
    if isinstance(exc, httpx.ConnectError):
        return (
            "llm_connection_error",
            "模型服务连接失败",
            _exception_details(exc),
        )
    if isinstance(exc, openai.RateLimitError):
        return (
            "llm_rate_limited",
            "模型服务请求过于频繁",
            _exception_details(exc, status_code=_openai_status_code(exc)),
        )
    if isinstance(exc, openai.AuthenticationError):
        return (
            "llm_authentication_failed",
            "模型服务认证失败，请检查供应商配置",
            _exception_details(exc, status_code=_openai_status_code(exc)),
        )
    if isinstance(exc, openai.PermissionDeniedError):
        return (
            "llm_permission_denied",
            "模型服务拒绝访问，请检查账号权限或模型权限",
            _exception_details(exc, status_code=_openai_status_code(exc)),
        )
    if isinstance(exc, openai.BadRequestError):
        return (
            "llm_bad_request",
            "模型请求参数无效",
            _exception_details(exc, status_code=_openai_status_code(exc)),
        )
    if isinstance(exc, openai.APIStatusError):
        status_code = _openai_status_code(exc)
        if status_code in {502, 503, 504}:
            return (
                "llm_upstream_unavailable",
                "模型服务暂时不可用",
                _exception_details(exc, status_code=status_code),
            )
        if status_code and status_code >= 500:
            return (
                "llm_server_error",
                "模型服务返回内部错误",
                _exception_details(exc, status_code=status_code),
            )
        return (
            "llm_request_failed",
            "模型请求失败",
            _exception_details(exc, status_code=status_code),
        )
    if isinstance(exc, httpx.HTTPStatusError):
        status_code = exc.response.status_code
        return (
            "llm_upstream_unavailable" if status_code in {502, 503, 504} else "llm_request_failed",
            "模型服务暂时不可用" if status_code in {502, 503, 504} else "模型请求失败",
            _exception_details(exc, status_code=status_code),
        )
    message = _exception_message(exc) or f"运行失败：{type(exc).__name__}"
    return "runtime_error", message, _exception_details(exc)


def _exception_message(exc: BaseException) -> str:
    return str(exc).strip()


def _exception_details(exc: BaseException, **extra: Any) -> dict[str, Any]:
    details: dict[str, Any] = {"exception_type": _exception_type(exc)}
    message = _exception_message(exc)
    if message:
        details["raw_message"] = message
    cause = exc.__cause__ or exc.__context__
    if cause is not None:
        details["cause_type"] = _exception_type(cause)
        cause_message = _exception_message(cause)
        if cause_message:
            details["cause_message"] = cause_message
    for key, value in extra.items():
        if value is not None:
            details[key] = value
    return details


def _exception_type(exc: BaseException) -> str:
    cls = type(exc)
    return f"{cls.__module__}.{cls.__name__}"


def _openai_status_code(exc: openai.APIStatusError) -> int | None:
    status_code = getattr(exc, "status_code", None)
    return status_code if isinstance(status_code, int) else None


def _runtime_role_for_injection(role: MessageInjectionRole) -> str:
    if role == MessageInjectionRole.SYSTEM:
        return "system"
    if role == MessageInjectionRole.HUMAN:
        return "user"
    return "assistant"


def _to_runtime_message(item: InjectedMessage) -> dict[str, Any]:
    return {
        "role": _runtime_role_for_injection(item.role),
        "content": item.content,
        "_injected": True,
    }


def _message_created_event_type_for_role(role: str) -> DomainEventType:
    if role == "system":
        return DomainEventType.MESSAGE_SYSTEM_CREATED
    if role == "assistant":
        return DomainEventType.MESSAGE_AI_CREATED
    return DomainEventType.MESSAGE_USER_CREATED


async def _sync_slot_to_checkpoint(graph: Any, config: dict[str, Any], content: str) -> bool:
    if not content.strip():
        return False
    if not hasattr(graph, "aget_state") or not hasattr(graph, "aupdate_state"):
        logger.debug("[MessageInjection] graph 不支持 checkpoint slot patch，跳过 slot 同步")
        return False

    snapshot = await graph.aget_state(config)
    values = snapshot.values or {}
    state_messages = list(values.get("messages") or []) if isinstance(values, dict) else []
    existing_slot = next(
        (
            message
            for message in state_messages
            if (
                isinstance(message, SystemMessage)
                and getattr(message, "id", None) == _SLOT_MESSAGE_ID
            )
        ),
        None,
    )
    if existing_slot is not None and str(existing_slot.content or "") == content:
        return False

    rebuilt = [
        message
        for message in state_messages
        if not (
            isinstance(message, SystemMessage) and getattr(message, "id", None) == _SLOT_MESSAGE_ID
        )
    ]
    rebuilt.insert(0, SystemMessage(content=content, id=_SLOT_MESSAGE_ID))
    await graph.aupdate_state(
        config,
        {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *rebuilt]},
    )
    return True


def _cancelled_checkpoint_content(content: str) -> str:
    stripped = str(content or "").rstrip()
    if not stripped:
        return ""
    if CANCELLED_CHECKPOINT_NOTICE in stripped:
        return stripped
    return f"{stripped}\n\n{CANCELLED_CHECKPOINT_NOTICE}"


def _message_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return str(content or "")


def _checkpoint_message_role(message: Any) -> str:
    if isinstance(message, dict):
        return str(message.get("role") or "")
    message_type = str(getattr(message, "type", "") or "")
    if message_type == "human":
        return "user"
    if message_type == "ai":
        return "assistant"
    return message_type


def _checkpoint_message_signature(message: Any) -> tuple[str, str]:
    content = (
        message.get("content")
        if isinstance(message, dict)
        else getattr(message, "content", "")
    )
    return _checkpoint_message_role(message), _message_content_text(content)


def _state_contains_runtime_messages(
    state_messages: list[Any],
    runtime_messages: list[dict[str, Any]],
) -> bool:
    signatures = [_checkpoint_message_signature(message) for message in runtime_messages]
    if not signatures:
        return True
    if len(state_messages) < len(signatures):
        return False
    state_signatures = [_checkpoint_message_signature(message) for message in state_messages]
    width = len(signatures)
    return any(
        state_signatures[index : index + width] == signatures
        for index in range(len(state_signatures) - width + 1)
    )


def _checkpoint_message_from_runtime(message: dict[str, Any]) -> Any:
    role = str(message.get("role") or "user")
    content = message.get("content", "")
    if role == "assistant":
        return AIMessage(content=content)
    if role == "system":
        return SystemMessage(content=content)
    return HumanMessage(content=content)


def _copy_ai_message_with_content(message: Any, content: str) -> Any:
    model_copy = getattr(message, "model_copy", None)
    if callable(model_copy):
        return model_copy(update={"content": content})
    kwargs: dict[str, Any] = {}
    message_id = getattr(message, "id", None)
    if message_id:
        kwargs["id"] = message_id
    name = getattr(message, "name", None)
    if name:
        kwargs["name"] = name
    return AIMessage(content=content, **kwargs)


def _checkpoint_message_tool_call_id(message: Any) -> str:
    if isinstance(message, dict):
        return str(message.get("tool_call_id") or message.get("toolCallId") or "")
    return str(getattr(message, "tool_call_id", "") or "")


def _checkpoint_ai_tool_calls(message: Any) -> list[dict[str, str]]:
    if isinstance(message, dict):
        raw_calls = message.get("tool_calls") or message.get("toolCalls") or []
    else:
        raw_calls = getattr(message, "tool_calls", None) or []
        if not raw_calls:
            additional_kwargs = getattr(message, "additional_kwargs", None)
            if isinstance(additional_kwargs, dict):
                raw_calls = additional_kwargs.get("tool_calls") or []
    if not isinstance(raw_calls, list):
        return []

    calls: list[dict[str, str]] = []
    for raw_call in raw_calls:
        call_id = ""
        name = ""
        if isinstance(raw_call, dict):
            call_id = str(raw_call.get("id") or raw_call.get("tool_call_id") or "")
            name = str(raw_call.get("name") or "")
            function = raw_call.get("function")
            if not name and isinstance(function, dict):
                name = str(function.get("name") or "")
        else:
            call_id = str(
                getattr(raw_call, "id", "") or getattr(raw_call, "tool_call_id", "") or ""
            )
            name = str(getattr(raw_call, "name", "") or "")
        if call_id:
            calls.append({"id": call_id, "name": name})
    return calls


def _cancelled_tool_message_for_call(tool_call: dict[str, str]) -> ToolMessage:
    name = str(tool_call.get("name") or "")
    payload: dict[str, Any] = {
        "status": "cancelled",
        "message": "用户终止了该工具调用，本轮对话已取消。",
    }
    if name:
        payload["tool"] = name
    kwargs: dict[str, Any] = {
        "content": json.dumps(payload, ensure_ascii=False),
        "tool_call_id": tool_call["id"],
    }
    if name:
        kwargs["name"] = name
    return ToolMessage(**kwargs)


def _close_pending_tool_calls_for_cancelled_checkpoint(
    state_messages: list[Any],
) -> tuple[list[Any], int]:
    rebuilt: list[Any] = []
    pending_tool_calls: list[dict[str, str]] = []
    inserted = 0

    def flush_pending() -> None:
        nonlocal inserted
        if not pending_tool_calls:
            return
        rebuilt.extend(
            _cancelled_tool_message_for_call(tool_call) for tool_call in pending_tool_calls
        )
        inserted += len(pending_tool_calls)
        pending_tool_calls.clear()

    for message in state_messages:
        role = _checkpoint_message_role(message)
        if pending_tool_calls and role != "tool":
            flush_pending()

        rebuilt.append(message)

        if role == "assistant":
            pending_tool_calls = _checkpoint_ai_tool_calls(message)
            continue
        if role == "tool" and pending_tool_calls:
            tool_call_id = _checkpoint_message_tool_call_id(message)
            if tool_call_id:
                pending_tool_calls = [
                    tool_call for tool_call in pending_tool_calls if tool_call["id"] != tool_call_id
                ]

    flush_pending()
    return rebuilt, inserted


async def _sync_cancelled_output_to_checkpoint(
    graph: Any,
    config: dict[str, Any],
    *,
    content: str,
    runtime_messages: list[dict[str, Any]],
) -> bool:
    checkpoint_content = _cancelled_checkpoint_content(content)
    if not hasattr(graph, "aget_state") or not hasattr(graph, "aupdate_state"):
        logger.debug("[ChatTurn] graph 不支持 checkpoint 取消补写，跳过")
        return False

    try:
        snapshot = await graph.aget_state(config)
        values = snapshot.values or {}
        state_messages = list(values.get("messages") or []) if isinstance(values, dict) else []
        state_messages, closed_tool_call_count = _close_pending_tool_calls_for_cancelled_checkpoint(
            state_messages
        )
        if runtime_messages and not _state_contains_runtime_messages(
            state_messages, runtime_messages
        ):
            state_messages.extend(
                _checkpoint_message_from_runtime(message) for message in runtime_messages
            )

        if checkpoint_content:
            if state_messages and _checkpoint_message_role(state_messages[-1]) == "assistant":
                current_content = _message_content_text(getattr(state_messages[-1], "content", ""))
                if CANCELLED_CHECKPOINT_NOTICE in current_content and not closed_tool_call_count:
                    return False
                if CANCELLED_CHECKPOINT_NOTICE not in current_content:
                    state_messages[-1] = _copy_ai_message_with_content(
                        state_messages[-1],
                        _cancelled_checkpoint_content(current_content or content),
                    )
            else:
                state_messages.append(AIMessage(content=checkpoint_content))
        elif not closed_tool_call_count:
            return False

        await graph.aupdate_state(
            config,
            {"messages": [RemoveMessage(id=REMOVE_ALL_MESSAGES), *state_messages]},
        )
    except Exception:
        logger.opt(exception=True).warning("[ChatTurn] 取消输出补写 checkpoint 失败")
        return False

    logger.info(
        "[ChatTurn] 已将取消前 assistant 输出补写到 checkpoint | "
        f"partial_content_len={len(content)} | closed_tool_calls={closed_tool_call_count}"
    )
    return True


class ChatService:
    def __init__(
        self,
        *,
        settings: AppSettings,
        repositories: StorageRepositories,
        agent_runner: AgentRunner,
        keydex_runtime_cache: KeydexRuntimeCache | None = None,
        thread_task_service: ThreadTaskService | None = None,
        mcp_manager: McpToolExecutor | None = None,
        file_history_service: FileHistoryService | None = None,
        web_service: WebService | None = None,
    ) -> None:
        self.settings = settings
        self.repositories = repositories
        self.agent_runner = agent_runner
        self.keydex_runtime_cache = keydex_runtime_cache or KeydexRuntimeCache()
        self.message_event_service = MessageEventService(repositories.message_events)
        self.workspace_service = WorkspaceService(repositories.workspaces)
        self.thread_task_service = thread_task_service or ThreadTaskService(repositories)
        self.mcp_manager = mcp_manager
        self.mcp_active_tool_window = McpActiveToolWindow()
        self.file_history_service = file_history_service or FileHistoryService(
            repositories,
            data_dir=settings.data_dir,
        )
        self.web_service = web_service or WebService(
            repositories,
            build_default_web_provider_registry(),
        )

    def _build_initial_thread_task_injection(
        self,
        *,
        session: SessionRecord,
        context: dict[str, Any],
    ) -> InjectedMessage:
        task_id = str(context.get("task_id") or "").strip()
        task = self.repositories.thread_tasks.get(task_id)
        if task is None or task.session_id != session.id:
            raise ValueError("runtime_params.initial_thread_task.task_id 无效")
        context_type = str(context.get("type") or "").strip()
        if context_type and context_type != task.type:
            raise ValueError("runtime_params.initial_thread_task.type 与任务类型不一致")
        return InjectedMessage(
            type=MessageInjectionType.FOLLOW,
            role=MessageInjectionRole.HUMAN,
            content=build_task_initial_prompt(task),
            metadata={
                "source": "thread_task",
                "task_id": task.id,
                "task_type": task.type,
                "trigger": "task_start",
                "hidden_for_transcript": True,
            },
            hidden_for_transcript=True,
        )

    async def handle_chat(
        self,
        request: ChatRequest,
        *,
        chat_adapter: ChatProjectionAdapter | None = None,
        cancellation: ChatCancellationToken | None = None,
    ) -> ChatTurnResult:
        message_injection_items = _build_message_injection_items(request.runtime_params)
        message_context_items = _build_message_context_items(request.runtime_params)
        thread_task_context = _build_thread_task_runtime_context(request.runtime_params)
        initial_thread_task_context = _build_initial_thread_task_context(request.runtime_params)
        skill_activation = _build_skill_activation_request(request.runtime_params)
        has_request_attachments = bool(request.attachments)
        if (
            not request.message.strip()
            and not message_injection_items
            and not has_request_attachments
            and not initial_thread_task_context
        ):
            if skill_activation is not None:
                raise ValueError("请输入要使用该 Skill 处理的内容")
            raise ValueError("用户消息不能为空")

        token = cancellation or ChatCancellationToken()
        session = self._ensure_session(request)
        if initial_thread_task_context:
            message_injection_items = [
                self._build_initial_thread_task_injection(
                    session=session,
                    context=initial_thread_task_context,
                ),
                *message_injection_items,
            ]
        turn_keydex_snapshot = self._resolve_session_keydex_snapshot(session)
        _, max_turn = self.repositories.message_events.get_max_seq_and_turn(session.id)
        turn_index = max_turn + 1
        trace_id = new_id()
        user_message_event_id = new_id()
        root_node_id = f"{trace_id}-root"
        started_at = time.perf_counter()
        active_session_id = session.active_session_id or session.id
        input_checkpoint_config = await self._get_latest_checkpoint_config(
            thread_id=active_session_id,
            checkpoint_ns="",
        )
        context_token = set_request_context(
            trace_id=trace_id,
            session_id=session.id,
            active_session_id=active_session_id,
            user_id=request.user_id or session.user_id,
            turn_index=turn_index,
            user_message=request.message,
        )
        runtime_metadata = {"runtime": "desktop", "agent_runtime": "langchain"}
        runtime_metadata["keydex"] = {
            "mode": turn_keydex_snapshot.mode,
            "fingerprint": turn_keydex_snapshot.fingerprint,
        }
        if thread_task_context:
            runtime_metadata["thread_task"] = thread_task_context
        if initial_thread_task_context:
            runtime_metadata["initial_thread_task"] = initial_thread_task_context
        if request.runtime_params:
            runtime_metadata["runtime_params"] = request.runtime_params

        logger.info(
            f"[ChatTurn] 开始处理对话 | session_id={session.id} | turn_index={turn_index} | "
            f"trace_id={trace_id} | model={request.model or '-'} | "
            f"message_len={len(request.message)} | attachments={len(request.attachments or [])}"
        )

        self.repositories.sessions.update(session.id, status="running")
        self.repositories.trace_records.create(
            trace_id=trace_id,
            session_id=session.id,
            active_session_id=session.active_session_id or session.id,
            scene_id=request.scene_id or session.scene_id,
            scene_name=self.settings.default_scene_name,
            user_id=request.user_id or session.user_id,
            turn_index=turn_index,
            root_node_id=root_node_id,
            user_message_preview=request.message[:200],
            input_checkpoint_id=input_checkpoint_config.get("checkpoint_id"),
            input_checkpoint_ns=str(input_checkpoint_config.get("checkpoint_ns") or ""),
            metadata=runtime_metadata,
        )
        if thread_task_context:
            self._attach_thread_task_run_to_turn(
                thread_task_context=thread_task_context,
                trace_id=trace_id,
                turn_index=turn_index,
            )

        aggregator = TurnCompletedAggregator()
        dispatcher = self._build_turn_dispatcher(
            session_id=session.id,
            turn_index=turn_index,
            chat_adapter=chat_adapter,
            aggregator=aggregator,
        )
        dispatcher_context_token = set_request_context(event_dispatcher=dispatcher)
        input_file_snapshot_id: str | None = None

        try:
            image_attachments, attachment_payloads = self._resolve_image_attachments(
                request,
                session=session,
            )
            request, model_selection = self._resolve_turn_model(request)
            self.repositories.sessions.update(
                session.id,
                current_model_provider_id=model_selection.provider_id,
                current_model=model_selection.settings.model,
            )

            self._validate_skill_activation(
                skill_activation,
                session,
                snapshot=turn_keydex_snapshot,
            )
            await self._emit_turn_started(
                dispatcher=dispatcher,
                request=request,
                session=session,
                trace_id=trace_id,
                root_node_id=root_node_id,
                turn_index=turn_index,
            )
            injected_runtime_messages, _slot_updated = await self._apply_message_injection(
                dispatcher=dispatcher,
                request=request,
                session=session,
                trace_id=trace_id,
                root_node_id=root_node_id,
                turn_index=turn_index,
                message_injection=message_injection_items,
            )
            await self._emit_skill_activation_context(
                dispatcher=dispatcher,
                request=request,
                session=session,
                trace_id=trace_id,
                root_node_id=root_node_id,
                turn_index=turn_index,
                skill_activation=skill_activation,
                keydex_snapshot=turn_keydex_snapshot,
            )
            await self._emit_message_context_items(
                dispatcher=dispatcher,
                request=request,
                session=session,
                trace_id=trace_id,
                root_node_id=root_node_id,
                turn_index=turn_index,
                items=message_context_items,
            )
            if not _should_hide_user_message_for_injection_turn(
                request,
                message_injection_items,
            ):
                await self._emit_user_message(
                    dispatcher=dispatcher,
                    request=request,
                    session=session,
                    trace_id=trace_id,
                    turn_index=turn_index,
                    attachments=attachment_payloads,
                    message_event_id=user_message_event_id,
                )
            if session.session_type == "workspace" and self.file_history_service.enabled:
                workspace_context = self.workspace_service.runtime_context_for_session(session)
                try:
                    snapshot = self.file_history_service.make_input_snapshot(
                        session_id=session.id,
                        active_session_id=active_session_id,
                        trace_id=trace_id,
                        message_event_id=user_message_event_id,
                        workspace_root=workspace_context.cwd,
                    )
                except Exception:
                    self.repositories.trace_records.set_input_file_snapshot(
                        trace_id,
                        snapshot_id=None,
                        status="failed",
                    )
                    raise
                input_file_snapshot_id = snapshot.id
                self.repositories.trace_records.set_input_file_snapshot(
                    trace_id,
                    snapshot_id=snapshot.id,
                    status=snapshot.status,
                )
            elif session.session_type == "workspace":
                self.repositories.trace_records.set_input_file_snapshot(
                    trace_id,
                    snapshot_id=None,
                    status="disabled",
                )

            outcome = await self._run_agent_loop(
                request=request,
                model_selection=model_selection,
                session=session,
                trace_id=trace_id,
                turn_index=turn_index,
                dispatcher=dispatcher,
                cancellation=token,
                injected_runtime_messages=injected_runtime_messages,
                image_attachments=image_attachments,
                skill_activation=skill_activation,
                keydex_snapshot=turn_keydex_snapshot,
                input_file_snapshot_id=input_file_snapshot_id,
            )

            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            if self.repositories.a2ui_interactions.get_waiting_by_session(session.id):
                self.repositories.sessions.update(session.id, status="waiting_input")
                self._finish_trace(
                    trace_id,
                    status="waiting_input",
                    duration_ms=duration_ms,
                    output_checkpoint_id=outcome.output_checkpoint_id,
                    output_checkpoint_ns=outcome.output_checkpoint_ns,
                )
                return ChatTurnResult(
                    session_id=session.id,
                    trace_id=trace_id,
                    turn_index=turn_index,
                    status="waiting_input",
                    final_content=outcome.event_result.final_content,
                )
            if token.is_cancelled():
                command_process_manager.terminate_turn(
                    session_id=session.id,
                    turn_index=turn_index,
                    trace_id=trace_id,
                    reason="turn_cancelled",
                )
                logger.info(
                    f"[ChatTurn] 用户取消本轮 | session_id={session.id} | "
                    f"turn_index={turn_index} | trace_id={trace_id} | duration_ms={duration_ms}"
                )
                await ApprovalService(
                    repositories=self.repositories,
                    dispatcher=dispatcher,
                ).cancel_pending_for_session(
                    session.id,
                    user_id=request.user_id or session.user_id,
                )
                payload = aggregator.build_cancelled_data(
                    session_id=session.id,
                    trace_id=trace_id,
                    user_id=request.user_id or session.user_id,
                    scene_id=request.scene_id or session.scene_id,
                    reason="user",
                )
                if thread_task_context:
                    payload["thread_task"] = thread_task_context
                await dispatcher.emit_event(
                    event_type=DomainEventType.TURN_CANCELLED.value,
                    source="chat_service",
                    payload=payload,
                    trace_id=trace_id,
                    user_id=request.user_id or session.user_id,
                    original_session_id=session.id,
                    active_session_id=session.active_session_id or session.id,
                    turn_index=turn_index,
                )
                self._finish_trace(
                    trace_id,
                    status="cancelled",
                    duration_ms=duration_ms,
                    output_checkpoint_id=outcome.output_checkpoint_id,
                    output_checkpoint_ns=outcome.output_checkpoint_ns,
                )
                self.repositories.sessions.update(session.id, status="active")
                logger.info(
                    f"[ChatTurn] 取消处理完成 | session_id={session.id} | "
                    f"turn_index={turn_index} | trace_id={trace_id}"
                )
                return ChatTurnResult(
                    session_id=session.id,
                    trace_id=trace_id,
                    turn_index=turn_index,
                    status="cancelled",
                    final_content=payload.get("final_content", ""),
                )

            completed_payload = aggregator.build_completed_data(
                session_id=session.id,
                trace_id=trace_id,
                user_id=request.user_id or session.user_id,
                scene_id=request.scene_id or session.scene_id,
                chain_token_usage=outcome.event_result.chain_token_usage,
                latest_llm_token_usage=outcome.event_result.latest_llm_token_usage,
                final_content=outcome.event_result.final_content,
            )
            if thread_task_context:
                completed_payload["thread_task"] = thread_task_context
            await dispatcher.emit_event(
                event_type=DomainEventType.TURN_COMPLETED.value,
                source="chat_service",
                payload=completed_payload,
                trace_id=trace_id,
                user_id=request.user_id or session.user_id,
                original_session_id=session.id,
                active_session_id=session.active_session_id or session.id,
                turn_index=turn_index,
            )
            self._finish_trace_from_usage(
                trace_id,
                status="completed",
                usage=outcome.event_result.latest_llm_token_usage,
                duration_ms=duration_ms,
                output_checkpoint_id=outcome.output_checkpoint_id,
                output_checkpoint_ns=outcome.output_checkpoint_ns,
            )
            self.repositories.sessions.update(session.id, status="active")
            usage = outcome.event_result.latest_llm_token_usage
            logger.info(
                f"[ChatTurn] 对话完成 | session_id={session.id} | turn_index={turn_index} | "
                f"trace_id={trace_id} | duration_ms={duration_ms} | "
                f"input_tokens={usage.get('input_tokens', 0) or 0} | "
                f"output_tokens={usage.get('output_tokens', 0) or 0} | "
                f"final_content_len={len(completed_payload.get('final_content', ''))}"
            )
            return ChatTurnResult(
                session_id=session.id,
                trace_id=trace_id,
                turn_index=turn_index,
                status="completed",
                final_content=completed_payload.get("final_content", ""),
            )
        except asyncio.CancelledError:
            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            token.cancel()
            command_process_manager.terminate_turn(
                session_id=session.id,
                turn_index=turn_index,
                trace_id=trace_id,
                reason="turn_cancelled",
            )
            logger.info(
                f"[ChatTurn] 对话任务被强制取消 | session_id={session.id} | "
                f"turn_index={turn_index} | trace_id={trace_id} | duration_ms={duration_ms}"
            )
            payload = aggregator.build_cancelled_data(
                session_id=session.id,
                trace_id=trace_id,
                user_id=request.user_id or session.user_id,
                scene_id=request.scene_id or session.scene_id,
                reason="user",
            )
            if thread_task_context:
                payload["thread_task"] = thread_task_context
            try:
                await ApprovalService(
                    repositories=self.repositories,
                    dispatcher=dispatcher,
                ).cancel_pending_for_session(
                    session.id,
                    user_id=request.user_id or session.user_id,
                )
                await dispatcher.emit_event(
                    event_type=DomainEventType.TURN_CANCELLED.value,
                    source="chat_service",
                    payload=payload,
                    trace_id=trace_id,
                    user_id=request.user_id or session.user_id,
                    original_session_id=session.id,
                    active_session_id=session.active_session_id or session.id,
                    turn_index=turn_index,
                )
            finally:
                self._finish_trace(trace_id, status="cancelled", duration_ms=duration_ms)
                self.repositories.sessions.update(session.id, status="active")
            return ChatTurnResult(
                session_id=session.id,
                trace_id=trace_id,
                turn_index=turn_index,
                status="cancelled",
                final_content=payload.get("final_content", ""),
            )
        except Exception as exc:
            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            error_code, error_message, error_details = _chat_turn_error(exc)
            logger.opt(exception=True).error(
                f"[ChatTurn] 对话失败 | session_id={session.id} | turn_index={turn_index} | "
                f"trace_id={trace_id} | duration_ms={duration_ms} | error={error_message}"
            )
            try:
                failed_payload = {
                    "session_id": session.id,
                    "trace_id": trace_id,
                    "message": error_message,
                    "error": error_message,
                    "code": error_code,
                    "details": error_details,
                }
                if aggregator.first_token_at_ms is not None:
                    failed_payload["first_token_at_ms"] = aggregator.first_token_at_ms
                if thread_task_context:
                    failed_payload["thread_task"] = thread_task_context
                await dispatcher.emit_event(
                    event_type=DomainEventType.TURN_FAILED.value,
                    source="chat_service",
                    payload=failed_payload,
                    trace_id=trace_id,
                    user_id=request.user_id or session.user_id,
                    original_session_id=session.id,
                    active_session_id=session.active_session_id or session.id,
                    turn_index=turn_index,
                )
            finally:
                self._finish_trace(trace_id, status="failed", duration_ms=duration_ms)
                self.repositories.sessions.update(session.id, status="failed")
            return ChatTurnResult(
                session_id=session.id,
                trace_id=trace_id,
                turn_index=turn_index,
                status="failed",
                error=error_message,
            )
        finally:
            reset_request_context(dispatcher_context_token)
            reset_request_context(context_token)

    def _resolve_turn_model(
        self, request: ChatRequest
    ) -> tuple[ChatRequest, ResolvedModelSelection]:
        requested_provider_id = request.provider_id.strip()
        requested_model = request.model.strip()
        resolved = resolve_model_selection(
            self.repositories,
            provider_id=requested_provider_id,
            model=requested_model,
            scope="chat",
            label="对话模型",
            code_prefix="chat_model",
        )
        resolved_model = resolved.settings.model.strip()
        logger.debug(
            "[ChatTurn] 解析对话模型 | "
            f"requested_provider_id={requested_provider_id or '-'} | "
            f"requested_model={requested_model or '-'} | "
            f"resolved_model={resolved_model} | provider_id={resolved.provider_id}"
        )
        return replace(request, provider_id=resolved.provider_id, model=resolved_model), resolved

    def _resolve_image_attachments(
        self,
        request: ChatRequest,
        *,
        session: SessionRecord,
    ) -> tuple[list[AttachmentRecord], list[dict[str, Any]]]:
        user_id = request.user_id or session.user_id
        return resolve_image_attachments(
            self.repositories,
            request.attachments or [],
            session_id=session.id,
            user_id=user_id,
        )

    async def _run_agent_loop(
        self,
        *,
        request: ChatRequest,
        model_selection: ResolvedModelSelection,
        session: SessionRecord,
        trace_id: str,
        turn_index: int,
        dispatcher: EventDispatcher,
        cancellation: ChatCancellationToken,
        injected_runtime_messages: list[dict[str, Any]] | None = None,
        image_attachments: list[AttachmentRecord] | None = None,
        skill_activation: SkillActivationRequest | None = None,
        keydex_snapshot: KeydexEffectiveRuntimeSnapshot | None = None,
        input_file_snapshot_id: str | None = None,
    ) -> AgentLoopOutcome:
        active_session_id = session.active_session_id or session.id
        tool_context, enable_tools = self._build_tool_context(
            request=request,
            session=session,
            trace_id=trace_id,
            turn_index=turn_index,
            keydex_snapshot=keydex_snapshot,
            input_file_snapshot_id=input_file_snapshot_id,
        )
        tool_context.metadata["repositories"] = self.repositories
        tool_context.metadata["thread_task_service"] = self.thread_task_service
        tool_context.metadata["dispatcher"] = dispatcher
        tool_context.metadata["data_dir"] = str(self.settings.data_dir)
        tool_context.metadata["active_session_id"] = active_session_id
        tool_context.metadata["thread_id"] = active_session_id
        tool_context.metadata["checkpoint_ns"] = ""
        tool_context.metadata["file_access_mode"] = load_command_settings(
            self.repositories
        ).file_access_mode
        mcp_active_before = self.mcp_active_tool_window.active_model_names(session.id)
        mcp_runtime_tools = self._build_mcp_runtime_tools(
            session=session,
            tool_context=tool_context,
            enable_tools=enable_tools,
        )
        web_runtime_tools = self._build_web_runtime_tools(tool_context=tool_context)
        runtime_tools = [*mcp_runtime_tools, *web_runtime_tools]
        workspace_root_label = str(tool_context.workspace_root) if enable_tools else "-"
        logger.info(
            f"[AgentLoop] 创建 agent | session_id={session.id} | turn_index={turn_index} | "
            f"trace_id={trace_id} | model={request.model.strip()} | "
            f"session_type={session.session_type} | tools_enabled={enable_tools} | "
            f"workspace_root={workspace_root_label} | "
            f"mcp_runtime_tools={len(mcp_runtime_tools)} | "
            f"web_runtime_tools={len(web_runtime_tools)}"
        )
        agent_context_token = self._set_agent_runtime_context(
            tool_context=tool_context,
            skill_activation=skill_activation,
            user_message=request.message,
        )
        try:
            agent = await asyncio.to_thread(
                self.agent_runner.create_agent,
                model=request.model.strip(),
                model_settings=model_selection.settings,
                system_prompt=request.system_prompt,
                tool_context=tool_context,
                enable_tools=enable_tools,
                tool_capabilities=tool_context.metadata["tool_capabilities"],
                runtime_tools=runtime_tools,
            )
            run_config = {
                "configurable": {
                    "thread_id": active_session_id,
                    "checkpoint_ns": "",
                },
                "recursion_limit": PRACTICAL_NO_RECURSION_LIMIT,
            }
            slot_items = [
                item
                for item in _build_message_injection_items(request.runtime_params)
                if item.type == MessageInjectionType.SLOT
            ]
            if slot_items:
                await _sync_slot_to_checkpoint(
                    agent,
                    {"configurable": {"thread_id": active_session_id, "checkpoint_ns": ""}},
                    slot_items[0].content,
                )
            messages_to_send = list(injected_runtime_messages or [])
            user_message = _build_user_runtime_message(
                request.message,
                image_attachments or [],
            )
            if user_message is not None:
                messages_to_send.append(user_message)
            if not messages_to_send:
                messages_to_send.append(
                    {
                        "role": "user",
                        "content": "请根据已附加的上下文继续处理。",
                        CURRENT_TURN_MESSAGE_MARKER: True,
                    }
                )
            event_stream = agent.astream_events(
                {"messages": messages_to_send},
                config=run_config,
                version="v2",
            )
            logger.info(
                f"[AgentLoop] 开始事件流 | session_id={session.id} | turn_index={turn_index} | "
                f"trace_id={trace_id} | active_session_id={active_session_id}"
            )
            event_result = await process_agent_events(
                event_stream,
                dispatcher=dispatcher,
                cancellation=cancellation,
                session_id=session.id,
                trace_id=trace_id,
                user_id=request.user_id or session.user_id,
                active_session_id=active_session_id,
                turn_index=turn_index,
            )
            if cancellation.is_cancelled():
                await _sync_cancelled_output_to_checkpoint(
                    agent,
                    run_config,
                    content=event_result.final_content,
                    runtime_messages=messages_to_send,
                )
            elif self._mcp_activation_requires_continuation(
                session_id=session.id,
                active_before=mcp_active_before,
            ):
                continuation_runtime_tools = self._build_mcp_runtime_tools(
                    session=session,
                    tool_context=tool_context,
                    enable_tools=enable_tools,
                )
                continuation_runtime_tools = [
                    *continuation_runtime_tools,
                    *web_runtime_tools,
                ]
                if any(
                    str(getattr(tool, "name", "") or "").startswith("mcp__")
                    for tool in continuation_runtime_tools
                ):
                    logger.info(
                        "[AgentLoop] MCP 能力已激活，重建 agent 继续当前任务 | "
                        f"session_id={session.id} | turn_index={turn_index} | "
                        f"trace_id={trace_id}"
                    )
                    continuation_agent = await asyncio.to_thread(
                        self.agent_runner.create_agent,
                        model=request.model.strip(),
                        model_settings=model_selection.settings,
                        system_prompt=request.system_prompt,
                        tool_context=tool_context,
                        enable_tools=enable_tools,
                        tool_capabilities=tool_context.metadata["tool_capabilities"],
                        runtime_tools=continuation_runtime_tools,
                    )
                    continuation_stream = continuation_agent.astream_events(
                        {
                            "messages": [
                                {
                                    "role": "user",
                                    "content": "请继续当前任务，必要时调用刚激活的 MCP 工具。",
                                    CURRENT_TURN_MESSAGE_MARKER: True,
                                }
                            ]
                        },
                        config=run_config,
                        version="v2",
                    )
                    event_result = await process_agent_events(
                        continuation_stream,
                        dispatcher=dispatcher,
                        cancellation=cancellation,
                        session_id=session.id,
                        trace_id=trace_id,
                        user_id=request.user_id or session.user_id,
                        active_session_id=active_session_id,
                        turn_index=turn_index,
                    )
        finally:
            reset_request_context(agent_context_token)
        checkpoint_config = await self.agent_runner.get_latest_checkpoint_config(
            thread_id=active_session_id,
            checkpoint_ns="",
        )
        logger.info(
            f"[AgentLoop] 事件流完成 | session_id={session.id} | turn_index={turn_index} | "
            f"trace_id={trace_id} | llm_call_count="
            f"{event_result.chain_token_usage.get('llm_call_count', 0)} | "
            f"final_content_len={len(event_result.final_content)} | "
            f"checkpoint_id={checkpoint_config.get('checkpoint_id') or '-'}"
        )
        return AgentLoopOutcome(
            event_result=event_result,
            output_checkpoint_id=checkpoint_config.get("checkpoint_id"),
            output_checkpoint_ns=str(checkpoint_config.get("checkpoint_ns") or ""),
        )

    def _mcp_activation_requires_continuation(
        self,
        *,
        session_id: str,
        active_before: set[str],
    ) -> bool:
        active_after = self.mcp_active_tool_window.active_model_names(session_id)
        return bool(active_after - active_before)

    def _build_tool_context(
        self,
        *,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        turn_index: int,
        keydex_snapshot: KeydexEffectiveRuntimeSnapshot | None = None,
        input_file_snapshot_id: str | None = None,
    ) -> tuple[ToolExecutionContext, bool]:
        if session.session_type == "workspace":
            workspace_context = self.workspace_service.runtime_context_for_session(session)
            resolved_keydex_snapshot = (
                keydex_snapshot
                or self.keydex_runtime_cache.get_workspace_snapshot(
                    workspace_context.workspace.root_path,
                )
            )
            tool_capabilities = {ToolCapability.WORKSPACE}
            if resolved_keydex_snapshot.skill_catalog.available:
                tool_capabilities.add(ToolCapability.SKILL)
            return (
                ToolExecutionContext(
                    session_id=session.id,
                    user_id=request.user_id or session.user_id,
                    workspace_root=workspace_context.cwd,
                    turn_index=turn_index,
                    trace_id=trace_id,
                    active_session_id=session.active_session_id or session.id,
                    assistant_message_id=f"{trace_id}-assistant",
                    input_file_snapshot_id=input_file_snapshot_id,
                    file_history_service=self.file_history_service,
                    file_history_tracking=True,
                    metadata={
                        "workspace_id": workspace_context.workspace_id,
                        "workspace_roots": [
                            str(root) for root in workspace_context.workspace_roots
                        ],
                        "keydex_snapshot": resolved_keydex_snapshot,
                        "keydex_profile": resolved_keydex_snapshot.workspace_layer.profile,
                        "skill_catalog": resolved_keydex_snapshot.skill_catalog,
                        "keydex_fingerprint": resolved_keydex_snapshot.fingerprint,
                        "keydex_mode": resolved_keydex_snapshot.mode,
                        "enable_workspace_tools": True,
                        "enable_skill_tools": resolved_keydex_snapshot.skill_catalog.available,
                        "tool_capabilities": frozenset(tool_capabilities),
                    },
                ),
                True,
            )
        if session.session_type == "chat":
            resolved_keydex_snapshot = (
                keydex_snapshot or self.keydex_runtime_cache.get_system_snapshot()
            )
            tool_capabilities: set[ToolCapability] = set()
            if resolved_keydex_snapshot.skill_catalog.available:
                tool_capabilities.add(ToolCapability.SKILL)
            return (
                ToolExecutionContext(
                    session_id=session.id,
                    user_id=request.user_id or session.user_id,
                    workspace_root=self.settings.data_dir,
                    turn_index=turn_index,
                    trace_id=trace_id,
                    active_session_id=session.active_session_id or session.id,
                    assistant_message_id=f"{trace_id}-assistant",
                    input_file_snapshot_id=None,
                    file_history_service=self.file_history_service,
                    file_history_tracking=False,
                    metadata={
                        "tools_enabled": False,
                        "keydex_snapshot": resolved_keydex_snapshot,
                        "skill_catalog": resolved_keydex_snapshot.skill_catalog,
                        "keydex_fingerprint": resolved_keydex_snapshot.fingerprint,
                        "keydex_mode": resolved_keydex_snapshot.mode,
                        "enable_workspace_tools": False,
                        "enable_skill_tools": resolved_keydex_snapshot.skill_catalog.available,
                        "tool_capabilities": frozenset(tool_capabilities),
                    },
                ),
                False,
            )
        raise ValueError(f"不支持的 session 类型: {session.session_type}")

    def _build_web_runtime_tools(
        self,
        *,
        tool_context: ToolExecutionContext,
    ) -> list[LocalTool]:
        try:
            snapshot = self.web_service.snapshot()
        except WebProviderError as exc:
            logger.debug(
                "[AgentLoop] Web 能力本轮不可用 | "
                f"code={exc.payload.code} | turn_index={tool_context.turn_index}"
            )
            return []

        capabilities = snapshot.available_capabilities()
        tools: list[LocalTool] = []
        if WebCapability.SEARCH in capabilities:
            tools.append(create_web_search_tool(snapshot))  # type: ignore[arg-type]
        if WebCapability.FETCH in capabilities:
            tools.append(create_web_fetch_tool(snapshot))  # type: ignore[arg-type]
        if not tools:
            return []

        turn_capabilities = set(tool_context.metadata.get("tool_capabilities") or ())
        turn_capabilities.add(ToolCapability.WEB)
        tool_context.metadata["tool_capabilities"] = frozenset(turn_capabilities)
        tool_context.metadata["web_capabilities"] = frozenset(capabilities)
        return tools

    def _build_mcp_runtime_tools(
        self,
        *,
        session: SessionRecord,
        tool_context: ToolExecutionContext,
        enable_tools: bool,
    ) -> list[LocalTool]:
        if not enable_tools or session.session_type != "workspace":
            return []
        if not self.settings.mcp_enabled or self.mcp_manager is None:
            return []
        snapshot = McpRuntimeSnapshotBuilder(
            self.repositories,
            direct_tool_budget=self.settings.mcp_direct_tool_budget,
        ).build_snapshot(
            McpRuntimeSnapshotContext(
                session_id=session.id,
                turn_id=str(tool_context.turn_index),
                workspace_session=True,
                active_model_names=self.mcp_active_tool_window.active_model_names(session.id),
            )
        )
        tool_context.metadata["mcp_snapshot_id"] = snapshot.id
        tool_context.metadata["mcp_snapshot"] = snapshot
        return [
            *mcp_local_tools_from_snapshot(snapshot, self.mcp_manager),
            *mcp_capability_discovery_tools_from_snapshot(
                snapshot,
                self.mcp_active_tool_window,
            ),
        ]

    def _validate_skill_activation(
        self,
        activation: SkillActivationRequest | None,
        session: SessionRecord,
        *,
        snapshot: KeydexEffectiveRuntimeSnapshot | None = None,
    ) -> KeydexEffectiveRuntimeSnapshot:
        resolved_snapshot = snapshot or self._resolve_session_keydex_snapshot(session)
        if activation is None:
            return resolved_snapshot
        if not resolved_snapshot.skill_catalog.available:
            raise SkillActivationError(
                "skill_layer_unavailable",
                "当前 Skill 配置无效，请修复后重试",
                {"mode": resolved_snapshot.mode},
            )
        if activation.skill_name.casefold() in resolved_snapshot.skill_catalog.shadowed_names:
            raise SkillActivationError(
                "skill_shadow_barrier",
                "同名项目 Skill 配置无效，已阻止继承系统 Skill",
                {"skill_name": activation.skill_name},
            )
        skill = resolved_snapshot.skill_catalog.skills.get(activation.skill_name)
        if skill is None:
            raise SkillActivationError(
                "skill_not_found",
                "Skill does not exist or has been deleted",
                {"skill_name": activation.skill_name},
            )
        if activation.source != skill.source:
            raise SkillActivationError(
                "skill_source_stale",
                "Skill 来源已变化，请刷新列表后重试",
                {
                    "skill_name": activation.skill_name,
                    "requested_source": activation.source,
                    "winner_source": skill.source,
                },
            )
        return resolved_snapshot

    def _resolve_session_keydex_snapshot(
        self,
        session: SessionRecord,
    ) -> KeydexEffectiveRuntimeSnapshot:
        if session.session_type == "chat":
            return self.keydex_runtime_cache.get_system_snapshot()
        if session.session_type == "workspace":
            workspace_context = self.workspace_service.runtime_context_for_session(session)
            return self.keydex_runtime_cache.get_workspace_snapshot(
                workspace_context.workspace.root_path
            )
        raise ValueError(f"不支持的 session 类型: {session.session_type}")

    def _set_agent_runtime_context(
        self,
        *,
        tool_context: ToolExecutionContext,
        skill_activation: SkillActivationRequest | None,
        user_message: str | None = None,
    ):
        skill_catalog = tool_context.metadata.get("skill_catalog")
        if not isinstance(skill_catalog, EffectiveSkillCatalog):
            skill_catalog = None
        keydex_snapshot = tool_context.metadata.get("keydex_snapshot")
        if not isinstance(keydex_snapshot, KeydexEffectiveRuntimeSnapshot):
            keydex_snapshot = None
        return set_request_context(
            tool_call_preset=_build_skill_activation_preset(skill_activation),
            user_message=user_message,
            skill_catalog=skill_catalog,
            keydex_snapshot=keydex_snapshot,
        )

    def _build_turn_dispatcher(
        self,
        *,
        session_id: str,
        turn_index: int,
        chat_adapter: ChatProjectionAdapter | None,
        aggregator: TurnCompletedAggregator,
    ) -> EventDispatcher:
        dispatcher = EventDispatcher()
        dispatcher.register_projection(
            PersistenceProjection(
                repository=self.repositories.message_events,
                session_id=session_id,
                turn_index=turn_index,
            )
        )
        dispatcher.register_projection(ChatProjection(chat_adapter or NullChatProjectionAdapter()))
        dispatcher.register_projection(aggregator)
        return dispatcher

    async def _emit_turn_started(
        self,
        *,
        dispatcher: EventDispatcher,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        root_node_id: str,
        turn_index: int,
    ) -> None:
        thread_task_context = _build_thread_task_runtime_context(request.runtime_params)
        turn_source = "thread_task" if thread_task_context else "user"
        source_label = "目标继续执行" if _is_goal_thread_task_context(thread_task_context) else ""
        await dispatcher.emit_event(
            event_type=DomainEventType.TURN_STARTED.value,
            source="chat_service",
            payload={
                "trace_id": trace_id,
                "trace_record_id": trace_id,
                "session_id": session.id,
                "scene_id": request.scene_id or session.scene_id,
                "scene_name": self.settings.default_scene_name,
                "root_node_id": root_node_id,
                "turn_index": turn_index,
                "source": turn_source,
                "source_label": source_label,
                "thread_task": thread_task_context,
                "user_id": request.user_id or session.user_id,
                "user_message": request.message,
                "runtime_params": request.runtime_params,
                "agent_name": "desktop_agent",
                "model": request.model.strip(),
                "start_time": int(time.time() * 1000),
            },
            trace_id=trace_id,
            user_id=request.user_id or session.user_id,
            original_session_id=session.id,
            active_session_id=session.active_session_id or session.id,
            turn_index=turn_index,
        )

    async def _apply_message_injection(
        self,
        *,
        dispatcher: EventDispatcher,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        root_node_id: str,
        turn_index: int,
        message_injection: list[InjectedMessage],
    ) -> tuple[list[dict[str, Any]], bool]:
        follow_messages = [
            item for item in message_injection if item.type == MessageInjectionType.FOLLOW
        ]
        slot_messages = [
            item for item in message_injection if item.type == MessageInjectionType.SLOT
        ]
        if not follow_messages and not slot_messages:
            return [], False

        injected_runtime_messages: list[dict[str, Any]] = []
        for slot_item in slot_messages:
            if not slot_item.hidden_for_transcript:
                await self._emit_injected_message(
                    dispatcher=dispatcher,
                    request=request,
                    session=session,
                    trace_id=trace_id,
                    root_node_id=root_node_id,
                    turn_index=turn_index,
                    item=slot_item,
                )

        for follow_item in follow_messages:
            runtime_message = _to_runtime_message(follow_item)
            injected_runtime_messages.append(runtime_message)
            if not follow_item.hidden_for_transcript:
                await self._emit_injected_message(
                    dispatcher=dispatcher,
                    request=request,
                    session=session,
                    trace_id=trace_id,
                    root_node_id=root_node_id,
                    turn_index=turn_index,
                    item=follow_item,
                )

        logger.info(
            f"[MessageInjection] 注入消息完成 | session_id={session.id} | "
            f"turn_index={turn_index} | "
            f"slot_count={len(slot_messages)} | follow_count={len(follow_messages)}"
        )
        return injected_runtime_messages, bool(slot_messages)

    async def _emit_injected_message(
        self,
        *,
        dispatcher: EventDispatcher,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        root_node_id: str,
        turn_index: int,
        item: InjectedMessage,
    ) -> None:
        role = _runtime_role_for_injection(item.role)
        await dispatcher.emit_event(
            event_type=_message_created_event_type_for_role(role),
            source="message_injection",
            payload={
                "content": item.content,
                "session_id": session.id,
                "trace_id": trace_id,
                "trace_record_id": trace_id,
                "root_node_id": root_node_id,
                "messageTimeMs": int(time.time() * 1000),
                "source": "message_injection",
                "injectionSource": item.type.value,
                "injectionRole": item.role.value,
                "slotMessageId": (
                    _SLOT_MESSAGE_ID if item.type == MessageInjectionType.SLOT else None
                ),
                "metadata": item.metadata or {},
                "fallbackUserMessage": request.message,
            },
            trace_id=trace_id,
            user_id=request.user_id or session.user_id,
            original_session_id=session.id,
            active_session_id=session.active_session_id or session.id,
            turn_index=turn_index,
            tags={"messageTimeMs": int(time.time() * 1000)},
        )

    async def _emit_skill_activation_context(
        self,
        *,
        dispatcher: EventDispatcher,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        root_node_id: str,
        turn_index: int,
        skill_activation: SkillActivationRequest | None,
        keydex_snapshot: KeydexEffectiveRuntimeSnapshot | None,
    ) -> None:
        if skill_activation is None or keydex_snapshot is None:
            return
        skill = keydex_snapshot.skill_catalog.skills.get(skill_activation.skill_name)
        if skill is None:
            return
        label = f"/{skill.name}"
        await dispatcher.emit_event(
            event_type=DomainEventType.MESSAGE_SYSTEM_CREATED.value,
            source="skill_activation",
            payload={
                "id": f"skill:{skill.source}:{skill.name}",
                "content": skill.description,
                "session_id": session.id,
                "trace_id": trace_id,
                "trace_record_id": trace_id,
                "root_node_id": root_node_id,
                "messageTimeMs": int(time.time() * 1000),
                "source": "skill_activation",
                "skill_name": skill.name,
                "skillName": skill.name,
                "skill_source": skill.source,
                "skillSource": skill.source,
                "label": label,
                "description": skill.description,
                "locator": skill.relative_entry,
                "origin": skill_activation.origin,
                "metadata": {
                    "id": f"skill:{skill.source}:{skill.name}",
                    "type": "skill",
                    "label": label,
                    "skill_name": skill.name,
                    "skillName": skill.name,
                    "source": skill.source,
                    "description": skill.description,
                    "locator": skill.relative_entry,
                    "origin": skill_activation.origin,
                },
            },
            trace_id=trace_id,
            user_id=request.user_id or session.user_id,
            original_session_id=session.id,
            active_session_id=session.active_session_id or session.id,
            turn_index=turn_index,
            tags={"messageTimeMs": int(time.time() * 1000)},
        )

    async def _emit_message_context_items(
        self,
        *,
        dispatcher: EventDispatcher,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        root_node_id: str,
        turn_index: int,
        items: list[dict[str, Any]],
    ) -> None:
        for item in items:
            metadata = dict(item.get("metadata") or {})
            metadata.setdefault("id", item.get("id"))
            metadata.setdefault("kind", item.get("type"))
            metadata.setdefault("label", item.get("label"))
            await dispatcher.emit_event(
                event_type=DomainEventType.MESSAGE_SYSTEM_CREATED.value,
                source="message_context_item",
                payload={
                    "id": item.get("id"),
                    "content": item.get("content", ""),
                    "session_id": session.id,
                    "trace_id": trace_id,
                    "trace_record_id": trace_id,
                    "root_node_id": root_node_id,
                    "messageTimeMs": int(time.time() * 1000),
                    "source": "message_context_item",
                    "context_type": item.get("type"),
                    "contextType": item.get("type"),
                    "label": item.get("label"),
                    "role": item.get("role"),
                    "item_source": item.get("source"),
                    "itemSource": item.get("source"),
                    "metadata": metadata,
                    "fallbackUserMessage": request.message,
                    **{key: item[key] for key in (
                        "path",
                        "name",
                        "fileType",
                        "file_type",
                        "skill_name",
                        "skillName",
                        "description",
                        "locator",
                    ) if key in item},
                },
                trace_id=trace_id,
                user_id=request.user_id or session.user_id,
                original_session_id=session.id,
                active_session_id=session.active_session_id or session.id,
                turn_index=turn_index,
                tags={"messageTimeMs": int(time.time() * 1000)},
            )

    async def _emit_user_message(
        self,
        *,
        dispatcher: EventDispatcher,
        request: ChatRequest,
        session: SessionRecord,
        trace_id: str,
        turn_index: int,
        attachments: list[dict[str, Any]] | None = None,
        message_event_id: str,
    ) -> None:
        context_items = _build_message_context_items(request.runtime_params)
        await dispatcher.emit_event(
            event_type=DomainEventType.MESSAGE_USER_CREATED.value,
            source="pending_input_promotion" if request.pending_input_id else "chat_service",
            payload={
                "content": request.message,
                "attachments": attachments or [],
                "contextItems": context_items,
                "context_items": context_items,
                "pending_input_id": request.pending_input_id,
                "session_id": session.id,
                "trace_id": trace_id,
                "trace_record_id": trace_id,
                "message_event_id": message_event_id,
                "messageTimeMs": int(time.time() * 1000),
            },
            trace_id=trace_id,
            user_id=request.user_id or session.user_id,
            original_session_id=session.id,
            active_session_id=session.active_session_id or session.id,
            turn_index=turn_index,
        )

    def _ensure_session(self, request: ChatRequest) -> SessionRecord:
        if request.session_id:
            existing = self.repositories.sessions.get(request.session_id)
            if existing is not None:
                logger.debug(f"[Session] 复用已有会话 | session_id={existing.id}")
                return existing
            if self.repositories.sessions.get_archived(request.session_id) is not None:
                raise ArchiveLifecycleError(
                    "entity_archived",
                    "会话已归档，恢复后才能继续发送",
                    {"session_id": request.session_id},
                )
        created = self.repositories.sessions.create(
            session_id=request.session_id or new_id(),
            user_id=request.user_id or self.settings.default_user_id,
            scene_id=request.scene_id or self.settings.default_scene_id,
            title=_title_from_message(request.message),
            session_tag="chat",
        )
        logger.info(
            f"[Session] 创建新会话 | session_id={created.id} | "
            f"user_id={created.user_id} | scene_id={created.scene_id}"
        )
        return created

    async def _get_latest_checkpoint_config(
        self,
        *,
        thread_id: str,
        checkpoint_ns: str,
    ) -> dict[str, Any]:
        get_latest = getattr(self.agent_runner, "get_latest_checkpoint_config", None)
        if get_latest is None:
            return {"checkpoint_id": None, "checkpoint_ns": checkpoint_ns}
        return await get_latest(thread_id=thread_id, checkpoint_ns=checkpoint_ns)

    def _finish_trace_from_usage(
        self,
        trace_id: str,
        *,
        status: str,
        usage: dict[str, Any],
        duration_ms: int,
        output_checkpoint_id: str | None = None,
        output_checkpoint_ns: str | None = None,
    ) -> None:
        self.repositories.trace_records.finish(
            trace_id,
            status=status,
            duration_ms=duration_ms,
            total_input_tokens=int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0),
            total_output_tokens=int(
                usage.get("output_tokens") or usage.get("completion_tokens") or 0
            ),
            total_cache_read_tokens=int(usage.get("cache_read_tokens") or 0),
            output_checkpoint_id=output_checkpoint_id,
            output_checkpoint_ns=output_checkpoint_ns,
        )

    def _finish_trace(
        self,
        trace_id: str,
        *,
        status: str,
        duration_ms: int,
        output_checkpoint_id: str | None = None,
        output_checkpoint_ns: str | None = None,
    ) -> None:
        self.repositories.trace_records.finish(
            trace_id,
            status=status,
            duration_ms=duration_ms,
            output_checkpoint_id=output_checkpoint_id,
            output_checkpoint_ns=output_checkpoint_ns,
        )

    def _attach_thread_task_run_to_turn(
        self,
        *,
        thread_task_context: dict[str, Any],
        trace_id: str,
        turn_index: int,
    ) -> None:
        run_id = str(thread_task_context.get("run_id") or "").strip()
        if not run_id:
            return
        updated = self.repositories.thread_task_runs.attach_turn(
            run_id,
            turn_index=turn_index,
            trace_id=trace_id,
        )
        if updated is None:
            logger.warning(
                "[ChatTurn] task continuation run 绑定 turn 失败 | "
                f"run_id={run_id} | trace_id={trace_id} | turn_index={turn_index}"
            )


def _title_from_message(message: str) -> str:
    normalized = " ".join(message.split())
    return normalized[:40] or "新对话"
