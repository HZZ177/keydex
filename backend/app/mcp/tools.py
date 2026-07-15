from __future__ import annotations

import json
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from backend.app.mcp.audit import McpAuditWriter, redact_sensitive_data, redact_sensitive_text
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

MCP_CAPABILITY_DISCOVERY_TOOL_NAME = "discover_mcp_tools"
DEFAULT_ACTIVE_TOOL_TTL_SEC = 600.0


@dataclass(frozen=True)
class McpOnDemandToolSummary:
    server_id: str
    raw_name: str
    model_name: str
    description: str | None


@dataclass(frozen=True)
class _IndexedCapabilityTool:
    tool: McpVisibleTool
    haystack: str
    raw_name: str
    model_name: str
    server_id: str
    server_name: str
    description: str
    schema_text: str


@dataclass(frozen=True)
class McpLocalToolMetadata:
    snapshot_id: str
    server_id: str
    server_name: str | None
    raw_tool_name: str
    model_name: str
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


def mcp_capability_discovery_tools_from_snapshot(
    snapshot: McpRuntimeSnapshotRecord,
    active_window: McpActiveToolWindow,
    *,
    ttl_sec: float = DEFAULT_ACTIVE_TOOL_TTL_SEC,
) -> list[FunctionTool]:
    on_demand_tools = _on_demand_visible_tools(snapshot)
    capability_directory = _snapshot_capability_directory(snapshot)
    index = McpCapabilitySearchIndex(
        on_demand_tools,
        capability_directory=capability_directory,
    )
    return [
        FunctionTool(
            name=MCP_CAPABILITY_DISCOVERY_TOOL_NAME,
            description=_capability_discovery_description(snapshot, on_demand_tools),
            parameters=_capability_discovery_schema(),
            handler=lambda args, context: _run_capability_discovery(
                args,
                context,
                index=index,
                capability_directory=capability_directory,
                active_window=active_window,
                ttl_sec=ttl_sec,
            ),
        ),
    ]


def _capability_discovery_description(
    snapshot: McpRuntimeSnapshotRecord,
    on_demand_tools: Sequence[McpVisibleTool],
) -> str:
    if not on_demand_tools:
        return (
            "MCP 能力发现入口：当前没有需要按需加载的 MCP 工具。"
            "如果用户请求的能力不在当前工具列表中，先告知当前 MCP 目录为空。"
        )
    source_summary = _capability_source_summary(on_demand_tools)
    total = len(on_demand_tools)
    return (
        f"MCP 能力发现入口：当前按需目录包含 {total} 个工具，来源：{source_summary}。"
        "当用户请求的能力不在已直接可用工具中，或需要查找某个 MCP 服务器能力时调用。"
        "不带 query 会返回目录摘要；带 query 会搜索并激活命中工具，"
        "激活后可按返回的 model_name 调用目标工具。"
    )


def _capability_source_summary(on_demand_tools: Sequence[McpVisibleTool]) -> str:
    counts: dict[str, int] = {}
    for tool in on_demand_tools:
        source_name = (tool.server_name or tool.server_id).strip()
        counts[source_name] = counts.get(source_name, 0) + 1
    parts = [
        f"{server_name}（{count} 个工具）"
        for server_name, count in sorted(counts.items(), key=lambda item: item[0])
    ]
    if len(parts) <= 6:
        return "、".join(parts)
    visible_parts = parts[:6]
    visible_parts.append(f"另有 {len(parts) - 6} 个来源")
    return "、".join(visible_parts)


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


def _on_demand_visible_tools(snapshot: McpRuntimeSnapshotRecord) -> list[McpVisibleTool]:
    tools: list[McpVisibleTool] = []
    for contract in snapshot.visible_tools:
        if not isinstance(contract, dict):
            continue
        if str(contract.get("exposure") or "direct") != "on_demand":
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
        approval_mode=str(contract.get("approval_mode") or "auto"),
        annotations=contract.get("annotations")
        if isinstance(contract.get("annotations"), dict)
        else None,
    )


def _capability_discovery_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search keywords."},
            "server_id": {"type": "string", "description": "Optional MCP server id filter."},
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
                "description": "Maximum tools returned and activated when query is provided.",
            },
        },
    }


def _run_capability_discovery(
    args: dict[str, Any],
    context: ToolExecutionContext,
    *,
    index: McpCapabilitySearchIndex,
    capability_directory: list[dict[str, Any]],
    active_window: McpActiveToolWindow,
    ttl_sec: float,
) -> dict[str, Any]:
    query = _optional_text_arg(args, "query")
    default_limit = 1 if query else 20
    matches = index.search(
        query=query,
        server_id=_optional_text_arg(args, "server_id") or None,
        limit=_int_arg(args, "limit", default_limit),
    )
    should_activate = bool(query)
    return _capability_discovery_result(
        action="search" if should_activate else "directory",
        query=query or None,
        summaries=matches,
        capability_directory=capability_directory,
        context=context,
        active_window=active_window,
        ttl_sec=ttl_sec,
        activate=should_activate,
    )


def _capability_discovery_result(
    *,
    action: str,
    query: str | None,
    summaries: list[McpOnDemandToolSummary],
    capability_directory: list[dict[str, Any]],
    context: ToolExecutionContext,
    active_window: McpActiveToolWindow,
    ttl_sec: float,
    activate: bool,
) -> dict[str, Any]:
    activated_model_names: list[str] = []
    if activate:
        for summary in summaries:
            active_window.activate(
                session_id=context.session_id,
                model_name=summary.model_name,
                ttl_sec=ttl_sec,
            )
            activated_model_names.append(summary.model_name)
    _audit_capability_discovery(
        action=action,
        query=query,
        summaries=summaries,
        capability_directory=capability_directory,
        context=context,
        activated_model_names=activated_model_names,
    )
    return {
        "action": action,
        "query": query,
        "servers": capability_directory,
        "tools": [_summary_payload(summary) for summary in summaries],
        "count": len(summaries),
        "empty_state": _capability_empty_state(
            action=action,
            query=query,
            summaries=summaries,
            capability_directory=capability_directory,
        ),
        "activation": {
            "scope": "session",
            "activated": activate,
            "ttl_sec": ttl_sec,
            "activated_model_names": activated_model_names,
            "hint": "Use the selected model tool name after it is activated.",
        },
    }


def _audit_capability_discovery(
    *,
    action: str,
    query: str | None,
    summaries: list[McpOnDemandToolSummary],
    capability_directory: list[dict[str, Any]],
    context: ToolExecutionContext,
    activated_model_names: list[str],
) -> None:
    repositories = context.metadata.get("repositories")
    if repositories is None or not hasattr(repositories, "mcp_audit_log"):
        return
    server_ids = sorted({summary.server_id for summary in summaries})
    McpAuditWriter.from_repositories(repositories).append_event(
        event_type="tool.discovery",
        server_id=server_ids[0] if len(server_ids) == 1 else None,
        session_id=context.session_id,
        turn_id=str(context.turn_index),
        actor="agent",
        status="ok",
        summary=f"MCP capability discovery {action}: {len(summaries)} match(es)",
        detail={
            "action": action,
            "query": query,
            "match_count": len(summaries),
            "activated_model_names": activated_model_names,
            "matched_tools": [
                {
                    "server_id": summary.server_id,
                    "raw_name": summary.raw_name,
                    "model_name": summary.model_name,
                }
                for summary in summaries
            ],
            "server_count": len(capability_directory),
        },
    )


def _capability_empty_state(
    *,
    action: str,
    query: str | None,
    summaries: list[McpOnDemandToolSummary],
    capability_directory: list[dict[str, Any]],
) -> dict[str, Any] | None:
    if summaries:
        return None
    if not capability_directory:
        return {
            "reason": "no_servers",
            "message": "当前没有配置 MCP 服务器。",
        }
    on_demand_total = sum(
        _non_negative_int(item.get("on_demand_tool_count"))
        for item in capability_directory
    )
    if action == "search" and query and on_demand_total > 0:
        return {
            "reason": "no_match",
            "message": "未找到匹配的 MCP 工具，未激活任何工具。",
        }
    available_total = sum(
        _non_negative_int(item.get("available_tool_count"))
        for item in capability_directory
    )
    if available_total > 0:
        return {
            "reason": "no_on_demand_tools",
            "message": "当前 MCP 工具已直接可用，没有需要按需加载的工具。",
        }
    statuses = {_optional_str(item.get("status")) or "unknown" for item in capability_directory}
    if "auth_required" in statuses:
        return {
            "reason": "auth_required",
            "message": "MCP 服务器需要认证后才会提供可用工具。",
        }
    if statuses <= {"offline", "disabled", "error", "unknown"}:
        return {
            "reason": "no_online_servers",
            "message": "当前没有在线可用的 MCP 服务器工具。",
        }
    return {
        "reason": "no_tools",
        "message": "当前 MCP 服务器暂无可用工具，请刷新服务器后再试。",
    }


def _snapshot_capability_directory(snapshot: McpRuntimeSnapshotRecord) -> list[dict[str, Any]]:
    raw_directory = snapshot.capability_directory
    if not isinstance(raw_directory, list):
        return []
    directory: list[dict[str, Any]] = []
    for item in raw_directory:
        if isinstance(item, dict):
            raw_status = _optional_str(item.get("status")) or "unknown"
            status = "unknown" if raw_status == "refreshing" else raw_status
            directory.append(
                {
                    "server_id": _optional_str(item.get("server_id")),
                    "server_name": _optional_str(item.get("server_name")),
                    "status": status,
                    "status_label": (
                        "未知"
                        if raw_status == "refreshing"
                        else _optional_str(item.get("status_label")) or "未知"
                    ),
                    "available_tool_count": _non_negative_int(
                        item.get("available_tool_count")
                    ),
                    "direct_tool_count": _non_negative_int(item.get("direct_tool_count")),
                    "on_demand_tool_count": _non_negative_int(
                        item.get("on_demand_tool_count")
                    ),
                    "requires_auth": bool(item.get("requires_auth")),
                    "has_on_demand_tools": bool(item.get("has_on_demand_tools")),
                    "capability_keywords": _string_list(item.get("capability_keywords")),
                }
            )
    return directory


def _summary_payload(summary: McpOnDemandToolSummary) -> dict[str, Any]:
    return {
        "server_id": summary.server_id,
        "raw_name": summary.raw_name,
        "model_name": summary.model_name,
        "description": summary.description,
        "activation_hint": "Activated for this session; callable after activation.",
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


def _non_negative_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, str) and value.strip().isdigit():
        return max(0, int(value))
    return 0


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result: list[str] = []
    for item in value:
        normalized = _optional_str(item)
        if normalized is not None:
            result.append(normalized)
    return result[:5]


class McpCapabilitySearchIndex:
    def __init__(
        self,
        tools: Sequence[McpVisibleTool],
        *,
        capability_directory: Sequence[dict[str, Any]] = (),
    ) -> None:
        self.tools = list(tools)
        self._entries = [
            _index_capability_tool(tool)
            for tool in self.tools
        ]

    def search(
        self,
        *,
        query: str = "",
        server_id: str | None = None,
        limit: int = 20,
    ) -> list[McpOnDemandToolSummary]:
        normalized_query = query.strip().lower()
        matches: list[tuple[int, _IndexedCapabilityTool]] = []
        for entry in self._entries:
            if not _matches_filters(
                entry,
                query=normalized_query,
                server_id=server_id,
            ):
                continue
            matches.append((_search_score(entry, normalized_query), entry))
        matches.sort(
            key=lambda item: (
                -item[0],
                _sort_server_name(item[1].tool),
                item[1].tool.raw_name,
            )
        )
        unique_tools: list[McpVisibleTool] = []
        seen_model_names: set[str] = set()
        for _score, entry in matches:
            tool = entry.tool
            if tool.model_name in seen_model_names:
                continue
            seen_model_names.add(tool.model_name)
            unique_tools.append(tool)
        return [_summary(tool) for tool in unique_tools[: _limit(limit)]]

    def list_tools(
        self,
        *,
        server_id: str | None = None,
        limit: int = 50,
    ) -> list[McpOnDemandToolSummary]:
        return self.search(
            query="",
            server_id=server_id,
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
    entry: _IndexedCapabilityTool,
    *,
    query: str,
    server_id: str | None,
) -> bool:
    if server_id is not None and entry.tool.server_id != server_id:
        return False
    if not query:
        return True
    return query in entry.haystack


def _index_capability_tool(tool: McpVisibleTool) -> _IndexedCapabilityTool:
    schema_text = _schema_search_text(tool.input_schema).lower()
    return _IndexedCapabilityTool(
        tool=tool,
        raw_name=tool.raw_name.lower(),
        model_name=tool.model_name.lower(),
        server_id=tool.server_id.lower(),
        server_name=(tool.server_name or "").lower(),
        description=(tool.description or "").lower(),
        schema_text=schema_text,
        haystack=" ".join(
            [
                tool.server_id,
                tool.server_name or "",
                tool.raw_name,
                tool.model_name,
                tool.description or "",
                schema_text,
            ]
        ).lower(),
    )


def _search_score(entry: _IndexedCapabilityTool, query: str) -> int:
    if not query:
        return 0
    if query == entry.raw_name or query == entry.model_name:
        return 1000
    if query in entry.raw_name or query in entry.model_name:
        return 900
    if query == entry.server_id or (entry.server_name and query == entry.server_name):
        return 850
    if query in entry.server_id or query in entry.server_name:
        return 800
    if query in entry.description:
        return 700
    if query in entry.schema_text:
        return 600
    return 100


def _sort_server_name(tool: McpVisibleTool) -> str:
    return (tool.server_name or tool.server_id).lower()


def _schema_search_text(schema: dict[str, Any]) -> str:
    parts: list[str] = []

    def collect(value: Any, field_name: str | None = None) -> None:
        if field_name:
            parts.append(field_name)
        if not isinstance(value, dict):
            return
        for key in ("title", "description"):
            text = value.get(key)
            if isinstance(text, str):
                parts.append(text)
        properties = value.get("properties")
        if isinstance(properties, dict):
            for property_name, property_schema in properties.items():
                collect(property_schema, str(property_name))
        items = value.get("items")
        if isinstance(items, dict):
            collect(items)

    collect(schema)
    return " ".join(parts)


def _summary(tool: McpVisibleTool) -> McpOnDemandToolSummary:
    return McpOnDemandToolSummary(
        server_id=tool.server_id,
        raw_name=tool.raw_name,
        model_name=tool.model_name,
        description=tool.description,
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
