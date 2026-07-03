from __future__ import annotations

from typing import Any

from backend.app.events import DomainEventType, EventDispatcher
from backend.app.services.thread_task_service import (
    ThreadTaskService,
    ThreadTaskServiceError,
)
from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.registry import ToolRegistry

THREAD_TASK_TOOL_UPDATE_STATUSES = {"complete", "blocked"}


def create_thread_task_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="get_thread_task",
            description=(
                "读取当前会话的长程任务状态。只返回当前执行上下文 session 的 open task，"
                "不会创建、修改、暂停、恢复或删除任务。"
            ),
            parameters={
                "type": "object",
                "properties": {},
                "required": [],
            },
            handler=get_thread_task_tool,
        ),
        FunctionTool(
            name="update_thread_task",
            description=(
                "将当前会话的 active 长程任务标记为 complete 或 blocked。"
                "只能由 agent 在已有充分证据时使用；不能暂停、恢复、删除、取消或 system-stop 任务。"
                "status=complete 时必须提供非空 summary、checklist、evidence。"
                "checklist 是检查项数组，建议每项包含 item/status/evidence。"
                "evidence 是证据数组；最稳妥的写法是每项使用对象 {summary: '...'}、{detail: '...'} 或 {title: '...'}，"
                "也可以直接使用非空字符串。不要只传 {type: 'test'} 这种没有 title/detail/summary 的空证据对象。"
                "status=blocked 时必须提供非空 summary、reason、attempts、blocked_audit_key。"
                "blocked_audit_key 必须是同一个阻塞条件的稳定短 key；只有同一阻塞条件连续至少三轮重复出现且无法继续推进时才标记 blocked。"
            ),
            parameters={
                "type": "object",
                "properties": {
                    "status": {
                        "type": "string",
                        "enum": ["complete", "blocked"],
                        "description": "目标状态更新类型。只能是 complete 或 blocked。",
                    },
                    "summary": {
                        "type": "string",
                        "description": "本次状态判断的简短总结。complete 时说明为什么目标已完成；blocked 时说明当前阻塞结论。",
                    },
                    "checklist": {
                        "type": "array",
                        "description": "仅 status=complete 时必填。非空检查清单，逐项说明目标验收条件是否已满足。",
                        "items": {
                            "type": "object",
                            "properties": {
                                "item": {"type": "string", "description": "检查项或验收点。"},
                                "status": {"type": "string", "description": "检查结果，例如 passed。"},
                                "evidence": {"type": "string", "description": "支撑该检查项的简短证据。"},
                            },
                        },
                    },
                    "evidence": {
                        "type": "array",
                        "description": (
                            "仅 status=complete 时必填。非空证据数组。"
                            "推荐每项使用 {summary: '...'}、{detail: '...'} 或 {title: '...'}；也接受非空字符串。"
                        ),
                        "items": {
                            "oneOf": [
                                {
                                    "type": "string",
                                    "description": "一条非空证据文本。",
                                },
                                {
                                    "type": "object",
                                    "description": "证据对象，至少提供 title/detail/summary 之一；推荐 summary 或 detail。",
                                    "properties": {
                                        "type": {"type": "string"},
                                        "title": {"type": "string", "description": "证据标题。"},
                                        "detail": {"type": "string", "description": "证据详情。"},
                                        "summary": {"type": "string", "description": "证据摘要。"},
                                    },
                                    "anyOf": [
                                        {"required": ["title"]},
                                        {"required": ["detail"]},
                                        {"required": ["summary"]},
                                    ],
                                },
                            ],
                        },
                    },
                    "reason": {
                        "type": "string",
                        "description": "仅 status=blocked 时必填。说明为什么无法继续推进。",
                    },
                    "blocked_reason": {
                        "type": "string",
                        "description": "reason 的兼容别名；优先使用 reason。",
                    },
                    "attempts": {
                        "type": "array",
                        "description": "仅 status=blocked 时必填。已经尝试过的动作，必须是非空字符串数组。",
                        "items": {"type": "string"},
                    },
                    "attempted_actions": {
                        "type": "array",
                        "description": "attempts 的兼容别名；优先使用 attempts。",
                        "items": {"type": "string"},
                    },
                    "blocked_audit_key": {
                        "type": "string",
                        "description": "仅 status=blocked 时必填。同一个阻塞条件必须使用完全相同的稳定 key，例如 missing-credential。",
                    },
                },
                "required": ["status", "summary"],
            },
            handler=update_thread_task_tool,
        )
    ]


def register_thread_task_tools(registry: ToolRegistry) -> ToolRegistry:
    for tool in create_thread_task_tools():
        registry.register(tool)
    return registry


async def get_thread_task_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    _require_session_context(context)
    repositories = _repositories_from_context(context)
    task = repositories.thread_tasks.get_open_by_session(context.session_id)
    if task is None:
        return {
            "has_task": False,
            "status": "no_active_task",
            "task": None,
            "session_id": context.session_id,
            "turn_index": context.turn_index,
        }

    service = _thread_task_service_from_context(context)
    serialized_task = service.serialize_task(task)
    recent_runs = repositories.thread_task_runs.list_by_task(task.id, limit=1)
    recent_result = _serialize_recent_run(recent_runs[0]) if recent_runs else None
    return {
        "has_task": True,
        "status": serialized_task["status"],
        "task_id": serialized_task["id"],
        "type": serialized_task["type"],
        "objective": serialized_task["objective"],
        "turn_count": serialized_task["turn_count"],
        "elapsed_seconds": serialized_task["elapsed_seconds"],
        "recent_result": recent_result,
        "task": {
            "id": serialized_task["id"],
            "type": serialized_task["type"],
            "objective": serialized_task["objective"],
            "status": serialized_task["status"],
            "turn_count": serialized_task["turn_count"],
            "elapsed_seconds": serialized_task["elapsed_seconds"],
            "current_run_id": serialized_task["current_run_id"],
            "progress_summary": serialized_task["metadata"].get("progress_summary"),
        },
        "session_id": context.session_id,
        "turn_index": context.turn_index,
    }


async def update_thread_task_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    _require_session_context(context)
    status = _required_status(args.get("status"))
    summary = _required_text(args.get("summary"), field="summary")
    service = _thread_task_service_from_context(context)
    current = service.get_open_task(context.session_id)
    if current is None or current.get("status") != "active":
        raise ToolExecutionError(
            "当前会话没有 active 长程任务",
            code="task_not_active",
            details={"session_id": context.session_id},
        )

    payload = _update_payload(status, args, summary=summary)
    try:
        task = service.update_task_from_agent(
            session_id=context.session_id,
            task_id=current["id"],
            status=status,
            payload=payload,
        )
    except ThreadTaskServiceError as exc:
        raise ToolExecutionError(
            str(exc),
            code=exc.code,
            details={"session_id": context.session_id, "task_id": current["id"]},
        ) from exc

    await _emit_thread_task_status_updated(
        context=context,
        task=task,
        status=status,
        summary=summary,
        payload=payload,
        run_id=str(current.get("current_run_id") or task.get("current_run_id") or ""),
    )
    return {
        "task_id": task["id"],
        "status": task["status"],
        "task": task,
        "ui_payload": {"task": task},
        "session_id": context.session_id,
        "turn_index": context.turn_index,
    }


async def _emit_thread_task_status_updated(
    *,
    context: ToolExecutionContext,
    task: dict[str, Any],
    status: str,
    summary: str,
    payload: dict[str, Any],
    run_id: str,
) -> None:
    dispatcher = context.metadata.get("dispatcher")
    if not isinstance(dispatcher, EventDispatcher):
        return
    await dispatcher.emit_event(
        event_type=DomainEventType.THREAD_TASK_STATUS_UPDATED.value,
        source="thread_task_tool",
        payload={
            "session_id": context.session_id,
            "turn_index": context.turn_index,
            "trace_id": context.trace_id,
            "task_id": task.get("id"),
            "run_id": run_id or None,
            "type": task.get("type") or "goal",
            "status": status,
            "summary": summary,
            "payload": payload,
            "task": task,
            "ui_payload": {"task": task},
        },
        trace_id=context.trace_id,
        user_id=context.user_id,
        original_session_id=context.session_id,
        active_session_id=context.session_id,
        run_id=run_id or None,
        turn_index=context.turn_index,
    )


def _repositories_from_context(context: ToolExecutionContext) -> Any:
    repositories = context.metadata.get("repositories")
    if repositories is None:
        raise ToolExecutionError(
            "get_thread_task 需要 repositories 执行上下文",
            code="thread_task_context_missing",
        )
    return repositories


def _require_session_context(context: ToolExecutionContext) -> None:
    if not str(context.session_id or "").strip():
        raise ToolExecutionError(
            "thread task 工具需要当前 session_id",
            code="thread_task_session_missing",
        )


def _thread_task_service_from_context(context: ToolExecutionContext) -> ThreadTaskService:
    service = context.metadata.get("thread_task_service")
    if isinstance(service, ThreadTaskService):
        return service
    return ThreadTaskService(_repositories_from_context(context))


def _required_status(value: Any) -> str:
    status = str(value or "").strip()
    if status not in THREAD_TASK_TOOL_UPDATE_STATUSES:
        raise ToolExecutionError(
            "update_thread_task 只支持 complete 或 blocked",
            code="invalid_task_status",
            details={"status": value, "allowed": sorted(THREAD_TASK_TOOL_UPDATE_STATUSES)},
        )
    return status


def _required_text(value: Any, *, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ToolExecutionError(
            f"{field} 不能为空",
            code="invalid_tool_args",
            details={"field": field},
        )
    return text


def _required_list(value: Any, *, field: str) -> list[Any]:
    if not isinstance(value, list) or not value:
        raise ToolExecutionError(
            f"{field} 必须是非空数组",
            code="invalid_tool_args",
            details={"field": field},
        )
    return value


def _update_payload(status: str, args: dict[str, Any], *, summary: str) -> dict[str, Any]:
    if status == "complete":
        return {
            "summary": summary,
            "checklist": _required_list(args.get("checklist"), field="checklist"),
            "evidence": _required_list(args.get("evidence"), field="evidence"),
        }
    return {
        "summary": summary,
        "reason": _required_text(
            args.get("reason", args.get("blocked_reason")),
            field="reason",
        ),
        "attempts": _required_list(
            args.get("attempts", args.get("attempted_actions")),
            field="attempts",
        ),
        "blocked_audit_key": _required_text(
            args.get("blocked_audit_key"),
            field="blocked_audit_key",
        ),
    }


def _serialize_recent_run(run: Any) -> dict[str, Any]:
    return {
        "run_id": run.id,
        "status": run.status,
        "turn_index": run.turn_index,
        "trace_id": run.trace_id,
        "summary": dict(run.summary),
        "error": dict(run.error),
        "started_at": run.started_at,
        "finished_at": run.finished_at,
    }
