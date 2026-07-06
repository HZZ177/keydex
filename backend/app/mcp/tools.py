from __future__ import annotations

import json
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from backend.app.mcp.audit import redact_sensitive_data, redact_sensitive_text
from backend.app.mcp.errors import McpRuntimeError, to_mcp_runtime_error
from backend.app.mcp.exposure import McpVisibleTool
from backend.app.mcp.types import McpErrorCode
from backend.app.model import ToolSpec
from backend.app.storage import McpRuntimeSnapshotRecord
from backend.app.tools.base import (
    FunctionTool,
    ToolDefinitionError,
    ToolExecutionContext,
    ToolExecutionError,
    ToolExecutionResult,
    validate_tool_name,
    validate_tool_schema,
)

DEFERRED_SEARCH_TOOL_NAME = "search_mcp_tools"
DEFERRED_LIST_TOOL_NAME = "list_mcp_tools"
DEFAULT_ACTIVE_TOOL_TTL_SEC = 600.0


@dataclass(frozen=True)
class McpDeferredToolSummary:
    server_id: str
    raw_name: str
    model_name: str
    description: str | None
    risk_level: str


@dataclass(frozen=True)
class McpLocalToolMetadata:
    snapshot_id: str
    server_id: str
    server_name: str | None
    raw_tool_name: str
    model_name: str
    risk_level: str
    approval_mode: str
    exposure: str
    annotations: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": "mcp_tool",
            "snapshot_id": self.snapshot_id,
            "server_id": self.server_id,
            "server_name": self.server_name,
            "raw_tool_name": self.raw_tool_name,
            "model_name": self.model_name,
            "model_tool_name": self.model_name,
            "risk_level": self.risk_level,
            "approval_mode": self.approval_mode,
            "exposure": self.exposure,
            "annotations": self.annotations,
        }


@dataclass(frozen=True)
class McpToolCallContext:
    session_id: str
    user_id: str
    workspace_root: Path
    turn_index: int
    trace_id: str | None
    snapshot_id: str
    server_id: str
    raw_tool_name: str
    model_name: str
    risk_level: str
    approval_mode: str
    tool_call_id: str | None = None
    run_id: str | None = None
    metadata: dict[str, Any] | None = None

    @classmethod
    def from_tool_context(
        cls,
        context: ToolExecutionContext,
        tool_metadata: McpLocalToolMetadata,
    ) -> McpToolCallContext:
        metadata = dict(context.metadata)
        tool_call_id = _optional_str(metadata.get("tool_call_id"))
        run_id = _optional_str(metadata.get("run_id"))
        metadata["mcp"] = tool_metadata.to_dict()
        return cls(
            session_id=context.session_id,
            user_id=context.user_id,
            workspace_root=context.workspace_root,
            turn_index=context.turn_index,
            trace_id=context.trace_id,
            snapshot_id=tool_metadata.snapshot_id,
            server_id=tool_metadata.server_id,
            raw_tool_name=tool_metadata.raw_tool_name,
            model_name=tool_metadata.model_name,
            risk_level=tool_metadata.risk_level,
            approval_mode=tool_metadata.approval_mode,
            tool_call_id=tool_call_id,
            run_id=run_id,
            metadata=metadata,
        )


class McpToolExecutor(Protocol):
    async def execute_tool(
        self,
        *,
        snapshot_id: str,
        server_id: str,
        raw_tool_name: str,
        arguments: dict[str, Any],
        call_context: McpToolCallContext,
    ) -> ToolExecutionResult | Any: ...


@dataclass
class McpLocalTool:
    name: str
    description: str
    parameters: dict[str, Any]
    metadata: McpLocalToolMetadata
    executor: McpToolExecutor
    enabled: bool = True

    def __post_init__(self) -> None:
        validate_tool_name(self.name)
        validate_tool_schema(self.parameters)
        if not hasattr(self.executor, "execute_tool"):
            raise ToolDefinitionError("McpLocalTool executor must expose execute_tool")

    def to_tool_spec(self) -> ToolSpec:
        return ToolSpec(
            name=self.name,
            description=self.description,
            parameters=self.parameters,
        )

    async def run(
        self,
        args: dict[str, Any],
        context: ToolExecutionContext,
    ) -> ToolExecutionResult:
        if not self.enabled:
            return ToolExecutionResult.failed(
                ToolExecutionError(
                    f"工具已禁用: {self.name}",
                    code="tool_disabled",
                    details={"tool": self.name, "mcp": self.metadata.to_dict()},
                ),
                metadata={"mcp": self.metadata.to_dict()},
            )
        call_context = McpToolCallContext.from_tool_context(context, self.metadata)
        try:
            value = await self.executor.execute_tool(
                snapshot_id=self.metadata.snapshot_id,
                server_id=self.metadata.server_id,
                raw_tool_name=self.metadata.raw_tool_name,
                arguments=dict(args),
                call_context=call_context,
            )
        except Exception as exc:
            return _failed_mcp_tool_result(exc, self.metadata)
        if isinstance(value, ToolExecutionResult):
            return _with_mcp_metadata(value, self.metadata)
        return ToolExecutionResult.success(
            value,
            metadata={"mcp": self.metadata.to_dict()},
        )


def mcp_local_tools_from_snapshot(
    snapshot: McpRuntimeSnapshotRecord,
    executor: McpToolExecutor,
    *,
    include_deferred: bool = False,
) -> list[McpLocalTool]:
    tools: list[McpLocalTool] = []
    for contract in snapshot.visible_tools:
        if not isinstance(contract, dict):
            raise ToolDefinitionError("MCP snapshot visible tool contract must be an object")
        exposure = str(contract.get("exposure") or "direct")
        if exposure != "direct" and not include_deferred:
            continue
        tools.append(_tool_from_contract(snapshot.id, contract, executor))
    return tools


def mcp_deferred_tools_from_snapshot(
    snapshot: McpRuntimeSnapshotRecord,
    active_window: McpActiveToolWindow,
    *,
    ttl_sec: float = DEFAULT_ACTIVE_TOOL_TTL_SEC,
) -> list[FunctionTool]:
    deferred_tools = _deferred_visible_tools(snapshot)
    if not deferred_tools:
        return []
    index = McpDeferredToolSearchIndex(deferred_tools)
    return [
        FunctionTool(
            name=DEFERRED_SEARCH_TOOL_NAME,
            description=(
                "Search deferred MCP tools by keyword, server, or risk. "
                "Returned tools are activated for this session and become callable next turn."
            ),
            parameters=_deferred_search_schema(),
            handler=lambda args, context: _run_deferred_search(
                args,
                context,
                index=index,
                active_window=active_window,
                ttl_sec=ttl_sec,
            ),
        ),
        FunctionTool(
            name=DEFERRED_LIST_TOOL_NAME,
            description=(
                "List deferred MCP tools without exposing every tool in the prompt. "
                "Returned tools are activated for this session and become callable next turn."
            ),
            parameters=_deferred_list_schema(),
            handler=lambda args, context: _run_deferred_list(
                args,
                context,
                index=index,
                active_window=active_window,
                ttl_sec=ttl_sec,
            ),
        ),
    ]


def _tool_from_contract(
    snapshot_id: str,
    contract: dict[str, Any],
    executor: McpToolExecutor,
) -> McpLocalTool:
    model_name = _required_str(contract, "model_name")
    server_id = _required_str(contract, "server_id")
    raw_tool_name = _required_str(contract, "raw_name")
    input_schema = contract.get("input_schema")
    if not isinstance(input_schema, dict):
        raise ToolDefinitionError(f"MCP tool {model_name} input_schema must be an object")
    metadata = McpLocalToolMetadata(
        snapshot_id=snapshot_id,
        server_id=server_id,
        server_name=_optional_str(contract.get("server_name")),
        raw_tool_name=raw_tool_name,
        model_name=model_name,
        risk_level=str(contract.get("risk_level") or "unknown"),
        approval_mode=str(contract.get("approval_mode") or "auto"),
        exposure=str(contract.get("exposure") or "direct"),
        annotations=contract.get("annotations")
        if isinstance(contract.get("annotations"), dict)
        else None,
    )
    return McpLocalTool(
        name=model_name,
        description=str(contract.get("description") or ""),
        parameters=dict(input_schema),
        metadata=metadata,
        executor=executor,
    )


def _deferred_visible_tools(snapshot: McpRuntimeSnapshotRecord) -> list[McpVisibleTool]:
    tools: list[McpVisibleTool] = []
    for contract in snapshot.visible_tools:
        if not isinstance(contract, dict):
            continue
        if str(contract.get("exposure") or "direct") != "deferred":
            continue
        tools.append(_visible_tool_from_contract(contract))
    return tools


def _visible_tool_from_contract(contract: dict[str, Any]) -> McpVisibleTool:
    input_schema = contract.get("input_schema")
    return McpVisibleTool(
        server_id=_required_str(contract, "server_id"),
        server_name=_optional_str(contract.get("server_name")),
        raw_name=_required_str(contract, "raw_name"),
        model_name=_required_str(contract, "model_name"),
        description=_optional_str(contract.get("description")),
        input_schema=dict(input_schema) if isinstance(input_schema, dict) else {"type": "object"},
        risk_level=str(contract.get("risk_level") or "unknown"),
        approval_mode=str(contract.get("approval_mode") or "auto"),
        annotations=contract.get("annotations")
        if isinstance(contract.get("annotations"), dict)
        else None,
    )


def _deferred_search_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search keywords."},
            "server_id": {"type": "string", "description": "Optional MCP server id filter."},
            "risk_level": {"type": "string", "description": "Optional risk level filter."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        },
    }


def _deferred_list_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "server_id": {"type": "string", "description": "Optional MCP server id filter."},
            "risk_level": {"type": "string", "description": "Optional risk level filter."},
            "limit": {"type": "integer", "minimum": 1, "maximum": 100},
        },
    }


def _run_deferred_search(
    args: dict[str, Any],
    context: ToolExecutionContext,
    *,
    index: McpDeferredToolSearchIndex,
    active_window: McpActiveToolWindow,
    ttl_sec: float,
) -> dict[str, Any]:
    matches = index.search(
        query=_optional_text_arg(args, "query"),
        server_id=_optional_text_arg(args, "server_id") or None,
        risk_level=_optional_text_arg(args, "risk_level") or None,
        limit=_int_arg(args, "limit", 20),
    )
    return _deferred_result(
        action="search",
        summaries=matches,
        context=context,
        active_window=active_window,
        ttl_sec=ttl_sec,
    )


def _run_deferred_list(
    args: dict[str, Any],
    context: ToolExecutionContext,
    *,
    index: McpDeferredToolSearchIndex,
    active_window: McpActiveToolWindow,
    ttl_sec: float,
) -> dict[str, Any]:
    matches = index.list_tools(
        server_id=_optional_text_arg(args, "server_id") or None,
        risk_level=_optional_text_arg(args, "risk_level") or None,
        limit=_int_arg(args, "limit", 50),
    )
    return _deferred_result(
        action="list",
        summaries=matches,
        context=context,
        active_window=active_window,
        ttl_sec=ttl_sec,
    )


def _deferred_result(
    *,
    action: str,
    summaries: list[McpDeferredToolSummary],
    context: ToolExecutionContext,
    active_window: McpActiveToolWindow,
    ttl_sec: float,
) -> dict[str, Any]:
    for summary in summaries:
        active_window.activate(
            session_id=context.session_id,
            model_name=summary.model_name,
            ttl_sec=ttl_sec,
        )
    return {
        "action": action,
        "tools": [_summary_payload(summary) for summary in summaries],
        "count": len(summaries),
        "activation": {
            "scope": "session",
            "available_next_turn": True,
            "ttl_sec": ttl_sec,
            "activated_model_names": [summary.model_name for summary in summaries],
            "hint": "Use the selected model tool name in the next turn.",
        },
    }


def _summary_payload(summary: McpDeferredToolSummary) -> dict[str, Any]:
    return {
        "server_id": summary.server_id,
        "raw_name": summary.raw_name,
        "model_name": summary.model_name,
        "description": summary.description,
        "risk_level": summary.risk_level,
        "activation_hint": "Activated for this session; callable next turn.",
    }


def _optional_text_arg(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    return value.strip() if isinstance(value, str) else ""


def _int_arg(args: dict[str, Any], key: str, default: int) -> int:
    value = args.get(key)
    if isinstance(value, bool):
        return default
    if isinstance(value, int):
        return _limit(value)
    if isinstance(value, str) and value.strip().isdigit():
        return _limit(int(value))
    return default


class McpDeferredToolSearchIndex:
    def __init__(self, tools: Sequence[McpVisibleTool]) -> None:
        self.tools = list(tools)

    def search(
        self,
        *,
        query: str = "",
        server_id: str | None = None,
        risk_level: str | None = None,
        limit: int = 20,
    ) -> list[McpDeferredToolSummary]:
        normalized_query = query.strip().lower()
        matches = [
            tool
            for tool in self.tools
            if _matches_filters(
                tool,
                query=normalized_query,
                server_id=server_id,
                risk_level=risk_level,
            )
        ]
        return [_summary(tool) for tool in matches[: _limit(limit)]]

    def list_tools(
        self,
        *,
        server_id: str | None = None,
        risk_level: str | None = None,
        limit: int = 50,
    ) -> list[McpDeferredToolSummary]:
        return self.search(
            query="",
            server_id=server_id,
            risk_level=risk_level,
            limit=limit,
        )


class McpActiveToolWindow:
    def __init__(self, *, time_provider: Callable[[], float] | None = None) -> None:
        self._time_provider = time_provider or time.time
        self._entries: dict[tuple[str, str], float] = {}

    def activate(
        self,
        *,
        session_id: str,
        model_name: str,
        ttl_sec: float,
    ) -> None:
        self._entries[(session_id, model_name)] = self._time_provider() + max(0, ttl_sec)

    def active_model_names(self, session_id: str) -> set[str]:
        self._prune()
        return {
            model_name
            for (entry_session_id, model_name), _expires_at in self._entries.items()
            if entry_session_id == session_id
        }

    def clear_session(self, session_id: str) -> None:
        for key in list(self._entries):
            if key[0] == session_id:
                self._entries.pop(key, None)

    def _prune(self) -> None:
        now = self._time_provider()
        for key, expires_at in list(self._entries.items()):
            if expires_at <= now:
                self._entries.pop(key, None)


def normalize_mcp_tool_result(
    tool_result: Any,
    *,
    max_bytes: int,
) -> dict[str, Any]:
    if max_bytes <= 0:
        raise ValueError("max_bytes must be greater than zero")

    payload = {
        "call_id": str(getattr(tool_result, "call_id", "")),
        "status": str(getattr(tool_result, "status", "")),
        "content": _redact_any(getattr(tool_result, "content", [])),
        "structured_content": _redact_any(getattr(tool_result, "structured_content", None)),
        "is_error": bool(getattr(tool_result, "is_error", False)),
        "metadata": _redact_metadata(getattr(tool_result, "metadata", {})),
    }
    payload["metadata"]["result_truncated"] = False
    payload["metadata"]["max_result_bytes"] = max_bytes
    payload["metadata"]["result_size_bytes"] = _json_byte_size(payload)

    if _json_byte_size(payload) <= max_bytes:
        return payload

    original_size = _json_byte_size(payload)
    truncated = _with_truncation_metadata(payload, original_size, max_bytes)
    for string_budget in _string_budgets(max_bytes):
        for list_limit in (20, 10, 5, 2, 1):
            candidate = dict(truncated)
            candidate["content"] = _truncate_value(
                truncated["content"],
                string_budget=string_budget,
                list_limit=list_limit,
            )
            candidate["structured_content"] = _truncate_value(
                truncated["structured_content"],
                string_budget=string_budget,
                list_limit=list_limit,
            )
            candidate["metadata"] = _truncate_metadata(
                truncated["metadata"],
                string_budget=string_budget,
                list_limit=list_limit,
            )
            candidate["metadata"]["result_size_bytes"] = _json_byte_size(candidate)
            if _json_byte_size(candidate) <= max_bytes:
                return candidate

    fallback = _compact_truncated_payload(
        payload,
        original_size=original_size,
        max_bytes=max_bytes,
    )
    if fallback is not None:
        return fallback

    raise McpRuntimeError(
        McpErrorCode.RESULT_TOO_LARGE,
        detail={
            "original_size_bytes": original_size,
            "max_result_bytes": max_bytes,
            "reason": "truncated_payload_exceeds_limit",
        },
    )


def _matches_filters(
    tool: McpVisibleTool,
    *,
    query: str,
    server_id: str | None,
    risk_level: str | None,
) -> bool:
    if server_id is not None and tool.server_id != server_id:
        return False
    if risk_level is not None and tool.risk_level != risk_level:
        return False
    if not query:
        return True
    return query in _haystack(tool)


def _haystack(tool: McpVisibleTool) -> str:
    return " ".join(
        [
            tool.server_id,
            tool.raw_name,
            tool.model_name,
            tool.description or "",
            json.dumps(tool.input_schema, ensure_ascii=False, sort_keys=True),
        ]
    ).lower()


def _summary(tool: McpVisibleTool) -> McpDeferredToolSummary:
    return McpDeferredToolSummary(
        server_id=tool.server_id,
        raw_name=tool.raw_name,
        model_name=tool.model_name,
        description=tool.description,
        risk_level=tool.risk_level,
    )


def _limit(value: int) -> int:
    return max(1, min(value, 100))


def _required_str(contract: dict[str, Any], key: str) -> str:
    value = str(contract.get(key) or "").strip()
    if not value:
        raise ToolDefinitionError(f"MCP tool contract missing {key}")
    return value


def _optional_str(value: Any) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _redact_any(value: Any) -> Any:
    if isinstance(value, dict):
        return redact_sensitive_data(value)
    if isinstance(value, list):
        return [_redact_any(item) for item in value]
    if isinstance(value, tuple):
        return [_redact_any(item) for item in value]
    if isinstance(value, set):
        return [_redact_any(item) for item in sorted(value, key=repr)]
    if isinstance(value, str):
        return redact_sensitive_text(value)
    if value is None or isinstance(value, bool | int | float):
        return value
    return repr(value)


def _redact_metadata(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return redact_sensitive_data(value)
    if value is None:
        return {}
    return {"value": _redact_any(value)}


def _json_byte_size(value: Any) -> int:
    return len(_json_dumps(value).encode("utf-8"))


def _json_dumps(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=repr,
    )


def _with_truncation_metadata(
    payload: dict[str, Any],
    original_size: int,
    max_bytes: int,
) -> dict[str, Any]:
    metadata = dict(payload["metadata"])
    metadata.update(
        {
            "result_truncated": True,
            "original_result_size_bytes": original_size,
            "max_result_bytes": max_bytes,
        }
    )
    return {
        **payload,
        "metadata": metadata,
    }


def _string_budgets(max_bytes: int) -> list[int]:
    candidates = [
        max(16, max_bytes // 2),
        max(16, max_bytes // 4),
        4096,
        2048,
        1024,
        512,
        256,
        128,
        64,
        32,
        16,
        0,
    ]
    return sorted(set(candidates), reverse=True)


def _truncate_value(value: Any, *, string_budget: int, list_limit: int) -> Any:
    if isinstance(value, str):
        return _truncate_text(value, string_budget)
    if isinstance(value, dict):
        return {
            str(key): _truncate_value(nested, string_budget=string_budget, list_limit=list_limit)
            for key, nested in value.items()
        }
    if isinstance(value, list):
        if list_limit <= 0:
            return [{"truncated_items": len(value)}] if value else []
        items = [
            _truncate_value(item, string_budget=string_budget, list_limit=list_limit)
            for item in value[:list_limit]
        ]
        if len(value) > list_limit:
            items.append({"truncated_items": len(value) - list_limit})
        return items
    return value


def _truncate_metadata(
    metadata: dict[str, Any],
    *,
    string_budget: int,
    list_limit: int,
) -> dict[str, Any]:
    preserved = {
        key: value
        for key, value in metadata.items()
        if key
        in {
            "result_truncated",
            "original_result_size_bytes",
            "max_result_bytes",
            "result_size_bytes",
        }
    }
    for key, value in metadata.items():
        if key in preserved:
            continue
        preserved[key] = _truncate_value(
            value,
            string_budget=string_budget,
            list_limit=list_limit,
        )
    return preserved


def _truncate_text(value: str, max_bytes: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    marker = "...<truncated>"
    marker_bytes = marker.encode("utf-8")
    if max_bytes <= len(marker_bytes):
        return marker[:max(0, max_bytes)]
    prefix = encoded[: max_bytes - len(marker_bytes)].decode("utf-8", errors="ignore")
    return f"{prefix}{marker}"


def _compact_truncated_payload(
    payload: dict[str, Any],
    *,
    original_size: int,
    max_bytes: int,
) -> dict[str, Any] | None:
    source = {
        "content": payload["content"],
        "structured_content": payload["structured_content"],
    }
    metadata = {
        "result_truncated": True,
        "original_result_size_bytes": original_size,
        "max_result_bytes": max_bytes,
    }
    base = {
        "call_id": payload["call_id"],
        "status": payload["status"],
        "content": [{"type": "text", "text": ""}],
        "structured_content": {"truncated": True},
        "is_error": payload["is_error"],
        "metadata": metadata,
    }
    preview_source = _json_dumps(source)
    low = 0
    high = len(preview_source.encode("utf-8"))
    best: dict[str, Any] | None = None
    while low <= high:
        mid = (low + high) // 2
        candidate = dict(base)
        candidate["content"] = [
            {"type": "text", "text": _truncate_text(preview_source, mid)}
        ]
        candidate["metadata"] = {**metadata, "result_size_bytes": _json_byte_size(candidate)}
        if _json_byte_size(candidate) <= max_bytes:
            best = candidate
            low = mid + 1
        else:
            high = mid - 1
    return best


def _failed_mcp_tool_result(
    error: BaseException,
    metadata: McpLocalToolMetadata,
) -> ToolExecutionResult:
    runtime_error = error if isinstance(error, McpRuntimeError) else to_mcp_runtime_error(error)
    details = dict(runtime_error.detail)
    details["mcp"] = metadata.to_dict()
    return ToolExecutionResult.failed(
        ToolExecutionError(
            runtime_error.message,
            code=runtime_error.code.value,
            details=details,
        ),
        metadata={"mcp": metadata.to_dict()},
    )


def _with_mcp_metadata(
    result: ToolExecutionResult,
    metadata: McpLocalToolMetadata,
) -> ToolExecutionResult:
    merged_metadata = dict(result.metadata)
    merged_metadata["mcp"] = metadata.to_dict()
    return ToolExecutionResult(
        ok=result.ok,
        result=result.result,
        error=result.error,
        metadata=merged_metadata,
    )
