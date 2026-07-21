from __future__ import annotations

import json
from collections.abc import Callable, Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import StructuredTool

from backend.app.agent.context_governance_observability import log_context_governance_metric
from backend.app.agent.tool_results.artifact_repository import artifact_repository_from_context
from backend.app.agent.tool_results.budgets import get_tool_result_policy
from backend.app.agent.tool_results.models import INTERNAL_ARTIFACT_SOURCE_KEY
from backend.app.agent.tool_results.projectors import attach_persisted_ref, project_tool_result
from backend.app.core.errors import normalize_error_envelope
from backend.app.core.logger import logger
from backend.app.tools import LocalTool, ToolExecutionContext, ToolRegistry
from backend.app.tools.file_snapshots import ensure_file_snapshot_store


class _LocalStructuredTool(StructuredTool):
    """Preserve the model ToolCall id for LocalTool execution contexts."""

    async def ainvoke(
        self,
        input: str | dict[str, Any],
        config: RunnableConfig | None = None,
        **kwargs: Any,
    ) -> Any:
        resolved_config = config
        if isinstance(input, dict) and input.get("type") == "tool_call":
            tool_call_id = str(input.get("id") or "").strip()
            if tool_call_id:
                resolved_config = dict(config or {})
                configurable = resolved_config.get("configurable")
                resolved_config["configurable"] = {
                    **(configurable if isinstance(configurable, dict) else {}),
                    "tool_call_id": tool_call_id,
                }
        return await super().ainvoke(input, resolved_config, **kwargs)


def _json_result(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        return str(value)


def local_tool_to_langchain_tool(
    tool: LocalTool,
    *,
    context_factory: Callable[[], ToolExecutionContext],
) -> StructuredTool:
    async def _run(config: RunnableConfig, **kwargs: Any) -> tuple[str, Any]:
        context = _context_for_tool(tool, context_factory(), config, tool_args=dict(kwargs))
        result = await tool.run(
            dict(kwargs),
            context,
        )
        if result.ok:
            tool_metadata = _langchain_tool_metadata(tool)
            policy = get_tool_result_policy(tool.name, metadata=tool_metadata)
            successful_payload = _successful_tool_payload(result)
            projection = project_tool_result(
                successful_payload,
                tool_name=tool.name,
                policy=policy,
                context=context,
                projector=getattr(tool, "result_projector", None),
            )
            projection = _persist_projection_if_needed(
                projection,
                payload=_artifact_source_payload(result, successful_payload),
                tool_name=tool.name,
                policy=policy,
                context=context,
            )
            _record_projection_metric(
                projection,
                payload=successful_payload,
                tool_name=tool.name,
                context=context,
            )
            runtime_artifact = projection.runtime_artifact()
            governance = result.metadata.get("_keydex_internal_governance")
            if isinstance(governance, dict):
                runtime_artifact["governance"] = governance
            return projection.model_content, runtime_artifact
        return (
            _json_result(
                _failed_tool_payload(
                    tool.name,
                    result.error,
                    _public_result_metadata(result.metadata),
                )
            ),
            None,
        )

    _run.__name__ = tool.name
    _run.__doc__ = tool.description or tool.name
    return _LocalStructuredTool.from_function(
        coroutine=_run,
        name=tool.name,
        description=tool.description or tool.name,
        args_schema=tool.parameters,
        metadata=_langchain_tool_metadata(tool),
        response_format="content_and_artifact",
    )


def _context_for_tool(
    tool: LocalTool,
    context: ToolExecutionContext,
    config: RunnableConfig | None,
    *,
    tool_args: dict[str, Any] | None = None,
) -> ToolExecutionContext:
    ensure_file_snapshot_store(context)
    metadata = dict(context.metadata)
    metadata["tool_name"] = tool.name
    if tool_args is not None:
        metadata["tool_args"] = dict(tool_args)
    if config:
        run_id = str(config.get("run_id") or "").strip()
        if run_id:
            metadata["run_id"] = run_id
        tool_call_id = str(config.get("tool_call_id") or "").strip()
        if tool_call_id:
            metadata["tool_call_id"] = tool_call_id
        configurable = config.get("configurable")
        if isinstance(configurable, dict):
            for key in ("run_id", "tool_call_id"):
                value = str(configurable.get(key) or "").strip()
                if value:
                    metadata[key] = value
        config_metadata = config.get("metadata")
        if isinstance(config_metadata, dict):
            for key in ("run_id", "tool_call_id", "langgraph_node"):
                value = str(config_metadata.get(key) or "").strip()
                if value:
                    metadata[key] = value
    return ToolExecutionContext(
        session_id=context.session_id,
        user_id=context.user_id,
        workspace_root=context.workspace_root,
        turn_index=context.turn_index,
        trace_id=context.trace_id,
        active_session_id=context.active_session_id,
        assistant_message_id=context.assistant_message_id,
        input_file_snapshot_id=context.input_file_snapshot_id,
        file_history_service=context.file_history_service,
        file_history_tracking=context.file_history_tracking,
        file_history_scope=context.file_history_scope,
        metadata=metadata,
    )


def _successful_tool_payload(result: Any) -> Any:
    metadata = _public_result_metadata(getattr(result, "metadata", None))
    if not metadata:
        return result.result
    if isinstance(result.result, dict):
        existing_metadata = result.result.get("metadata")
        if isinstance(existing_metadata, dict):
            return {
                **result.result,
                "metadata": _merge_result_metadata(existing_metadata, metadata),
            }
        return {**result.result, "metadata": metadata}
    return {"result": result.result, "metadata": metadata}


def _public_result_metadata(metadata: Any) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    return {
        key: value
        for key, value in metadata.items()
        if not str(key).startswith("_keydex_internal_")
    }


def _artifact_source_payload(result: Any, fallback: Any) -> Any:
    metadata = getattr(result, "metadata", None)
    if not isinstance(metadata, dict):
        return fallback
    return metadata.get(INTERNAL_ARTIFACT_SOURCE_KEY, fallback)


def _failed_tool_payload(
    tool_name: str,
    error: dict[str, Any] | None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_error = normalize_error_envelope(
        error,
        fallback_code="tool_failed",
        fallback_message="工具执行失败",
    ).to_public_dict()
    code = normalized_error["code"]
    message = normalized_error["message"]
    return {
        "tool": tool_name,
        "ok": False,
        "status": "failed",
        "error": normalized_error,
        "tool_summary": f"工具 {tool_name} 执行失败：{message}（错误码：{code}）。",
        **({"metadata": metadata} if metadata else {}),
    }


def _langchain_tool_metadata(tool: LocalTool) -> dict[str, Any] | None:
    metadata = getattr(tool, "metadata", None)
    if metadata is None:
        return None
    to_dict = getattr(metadata, "to_dict", None)
    if callable(to_dict):
        return {"mcp": to_dict()}
    if isinstance(metadata, dict):
        return dict(metadata)
    return None


def _merge_result_metadata(
    existing: dict[str, Any],
    extra: dict[str, Any],
) -> dict[str, Any]:
    merged = dict(existing)
    for key, value in extra.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = {**merged[key], **value}
        else:
            merged[key] = value
    return merged


def _persist_projection_if_needed(
    projection: Any,
    *,
    payload: Any,
    tool_name: str,
    policy: Any,
    context: ToolExecutionContext,
) -> Any:
    repository = artifact_repository_from_context(context)
    if repository is None:
        return projection
    command_path = payload.get("output_path") if isinstance(payload, dict) else None
    should_persist = bool(policy.persist_on_truncate and projection.meta.truncated)
    if not should_persist and not command_path:
        return projection
    try:
        if command_path:
            ref = repository.register_command_log(
                command_path,
                context=context,
                tool_name=tool_name,
                is_complete=not bool(payload.get("output_limit_exceeded")),
            )
        else:
            ref = repository.ensure_persisted(
                payload,
                context=context,
                tool_name=tool_name,
                is_complete=projection.meta.artifact_complete,
            )
    except Exception as exc:
        logger.warning(
            "[ToolResultProjection] artifact persistence failed; keeping projected result | "
            f"tool={tool_name} | session_id={context.session_id} | reason={type(exc).__name__}"
        )
        log_context_governance_metric(
            "artifact_persist_failed",
            tool=tool_name,
            session_id=context.session_id,
            trace_id=context.trace_id,
            reason_code="artifact_persist_failed",
            exception_type=type(exc).__name__,
        )
        return projection
    return attach_persisted_ref(
        projection,
        persisted_ref=ref.to_dict(),
        tool_name=tool_name,
        policy=policy,
    )


def _record_projection_metric(
    projection: Any,
    *,
    payload: Any,
    tool_name: str,
    context: ToolExecutionContext,
) -> None:
    source_count = len(payload.get("results", [])) if isinstance(payload, dict) else 0
    display = projection.display_payload
    displayed_count = len(display.get("results", [])) if isinstance(display, dict) else 0
    continuation = projection.meta.continuation or {}
    search_state = context.metadata.get("search_continuation")
    logical_query_id = getattr(search_state, "logical_query_id", None)
    page_index = getattr(search_state, "page_index", None)
    log_context_governance_metric(
        "tool_result_projection",
        tool=tool_name,
        session_id=context.session_id,
        trace_id=context.trace_id,
        tool_call_id=context.tool_call_id,
        full_bytes=projection.meta.full_bytes,
        model_bytes=projection.meta.model_bytes,
        approximate_full_tokens=projection.meta.approximate_full_tokens,
        approximate_model_tokens=projection.meta.approximate_model_tokens,
        budget_bytes=projection.meta.budget_bytes,
        truncated=projection.meta.truncated,
        reason_code=projection.meta.reason_code,
        artifact_id=projection.meta.artifact_id,
        artifact_complete=projection.meta.artifact_complete,
        continuation_used=bool(search_state),
        logical_query_id=logical_query_id,
        page_index=(int(page_index) + 1 if page_index is not None else 1),
        returned_identities=displayed_count,
        omitted_identities=max(source_count - displayed_count, 0),
        has_continuation=bool(continuation),
    )


def registry_to_langchain_tools(
    registry: ToolRegistry,
    *,
    context_factory: Callable[[], ToolExecutionContext],
) -> list[StructuredTool]:
    return tools_to_langchain_tools(
        registry.list(),
        context_factory=context_factory,
    )


def tools_to_langchain_tools(
    tools: Sequence[LocalTool],
    *,
    context_factory: Callable[[], ToolExecutionContext],
) -> list[StructuredTool]:
    return [
        local_tool_to_langchain_tool(tool, context_factory=context_factory)
        for tool in tools
        if tool.enabled
    ]
