from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from backend.app.mcp.approval import evaluate_mcp_tool_risk, stable_schema_hash
from backend.app.mcp.audit import McpAuditWriter
from backend.app.mcp.client import (
    McpCancellationToken,
    McpClient,
    McpClientInitializeResult,
    McpClientPromptSpec,
    McpClientToolSpec,
    status_from_mcp_error_code,
)
from backend.app.mcp.errors import McpRuntimeError, to_mcp_runtime_error
from backend.app.mcp.naming import ExistingMcpToolName, McpToolNameAllocator
from backend.app.storage import McpServerRecord, StorageRepositories


@dataclass(frozen=True)
class McpRefreshReport:
    server_id: str
    status: str
    tools_count: int
    prompts_count: int
    resources_reserved_count: int
    removed_tools_count: int
    removed_prompts_count: int
    schema_changed_tools_count: int
    schema_changed_prompts_count: int
    refresh_revision: int
    duration_ms: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "server_id": self.server_id,
            "status": self.status,
            "tools_count": self.tools_count,
            "prompts_count": self.prompts_count,
            "resources_reserved_count": self.resources_reserved_count,
            "removed_tools_count": self.removed_tools_count,
            "removed_prompts_count": self.removed_prompts_count,
            "schema_changed_tools_count": self.schema_changed_tools_count,
            "schema_changed_prompts_count": self.schema_changed_prompts_count,
            "refresh_revision": self.refresh_revision,
            "duration_ms": self.duration_ms,
        }


class McpDiscoveryService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        audit_writer: McpAuditWriter | None = None,
    ) -> None:
        self.repositories = repositories
        self.audit_writer = audit_writer or McpAuditWriter.from_repositories(repositories)

    async def refresh_server(
        self,
        *,
        server: McpServerRecord,
        client: McpClient,
        cancellation: McpCancellationToken | None = None,
    ) -> McpRefreshReport:
        started = time.perf_counter()
        self.repositories.mcp_server_status.upsert(server.id, status="refreshing")
        try:
            init_result = await client.initialize(
                timeout_sec=server.startup_timeout_sec,
                cancellation=cancellation,
            )
            tools = await client.list_tools(
                timeout_sec=server.read_timeout_sec,
                cancellation=cancellation,
            )
            prompts = await client.list_prompts(
                timeout_sec=server.read_timeout_sec,
                cancellation=cancellation,
            )
        except Exception as exc:
            duration_ms = _elapsed_ms(started)
            runtime_error = to_mcp_runtime_error(exc)
            self._record_refresh_error(
                server.id,
                runtime_error,
                original_error=exc,
                duration_ms=duration_ms,
            )
            raise runtime_error from exc

        report = self._persist_success(
            server=server,
            init_result=init_result,
            tools=tools,
            prompts=prompts,
            duration_ms=_elapsed_ms(started),
        )
        self.audit_writer.append_event(
            event_type="refresh.completed",
            server_id=server.id,
            status="success",
            duration_ms=report.duration_ms,
            summary="MCP capability refresh completed",
            detail=report.to_dict(),
        )
        return report

    def _persist_success(
        self,
        *,
        server: McpServerRecord,
        init_result: McpClientInitializeResult,
        tools: list[McpClientToolSpec],
        prompts: list[McpClientPromptSpec],
        duration_ms: int,
    ) -> McpRefreshReport:
        tool_payloads = self._tool_payloads(server, tools)
        prompt_payloads = [_prompt_payload(prompt) for prompt in prompts]
        seen_tool_names = [tool["raw_name"] for tool in tool_payloads]
        seen_prompt_names = [prompt["raw_name"] for prompt in prompt_payloads]

        self.repositories.mcp_tools.upsert_many(server.id, tool_payloads)
        self.repositories.mcp_prompts.upsert_many(server.id, prompt_payloads)
        removed_tools_count = self.repositories.mcp_tools.mark_removed_missing(
            server.id,
            seen_tool_names,
        )
        removed_prompts_count = self.repositories.mcp_prompts.mark_removed_missing(
            server.id,
            seen_prompt_names,
        )
        stored_tools = self.repositories.mcp_tools.list_by_server(server.id)
        stored_prompts = self.repositories.mcp_prompts.list_by_server(server.id)
        changed_tools = [
            tool
            for tool in stored_tools
            if tool.raw_name in seen_tool_names and tool.discovery_status == "schema_changed"
        ]
        self._apply_schema_change_actions(server.id, changed_tools)
        changed_tool_count = len(changed_tools)
        changed_prompt_count = sum(
            1
            for prompt in stored_prompts
            if prompt.raw_name in seen_prompt_names
            and prompt.discovery_status == "schema_changed"
        )
        resources_reserved_count = 1 if init_result.capabilities.resources_reserved else 0
        status_record = self.repositories.mcp_server_status.update_refresh_counts(
            server.id,
            status="online",
            capabilities=_capabilities_dict(init_result),
            server_info=init_result.server_info,
            tools_count=len(tool_payloads),
            prompts_count=len(prompt_payloads),
            resources_reserved_count=resources_reserved_count,
        )
        return McpRefreshReport(
            server_id=server.id,
            status=status_record.status,
            tools_count=len(tool_payloads),
            prompts_count=len(prompt_payloads),
            resources_reserved_count=resources_reserved_count,
            removed_tools_count=removed_tools_count,
            removed_prompts_count=removed_prompts_count,
            schema_changed_tools_count=changed_tool_count,
            schema_changed_prompts_count=changed_prompt_count,
            refresh_revision=status_record.last_refresh_revision,
            duration_ms=duration_ms,
        )

    def _tool_payloads(
        self,
        server: McpServerRecord,
        tools: list[McpClientToolSpec],
    ) -> list[dict[str, Any]]:
        existing_tools = {
            tool.raw_name: tool for tool in self.repositories.mcp_tools.list_by_server(server.id)
        }
        allocator = McpToolNameAllocator(self.repositories.mcp_tools.list_model_names())
        payloads: list[dict[str, Any]] = []
        for tool in tools:
            existing = existing_tools.get(tool.name)
            allocated_name = allocator.allocate(
                server_id=server.id,
                raw_tool_name=tool.name,
                existing=(
                    ExistingMcpToolName(
                        raw_name=existing.raw_name,
                        callable_namespace=existing.callable_namespace,
                        callable_name=existing.callable_name,
                        model_name=existing.model_name,
                    )
                    if existing is not None
                    else None
                ),
            )
            model_name = allocated_name.model_name
            namespace = allocated_name.callable_namespace
            callable_name = allocated_name.callable_name
            risk = evaluate_mcp_tool_risk(
                raw_tool_name=tool.name,
                input_schema=tool.input_schema,
                annotations=tool.annotations,
            )
            meta = dict(tool.raw)
            if risk.reasons:
                meta["risk_reasons"] = risk.reasons
            payloads.append(
                {
                    "raw_name": tool.name,
                    "model_name": model_name,
                    "callable_namespace": namespace,
                    "callable_name": callable_name,
                    "display_name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                    "annotations": tool.annotations,
                    "meta": meta,
                    "schema_hash": stable_schema_hash(tool.input_schema),
                    "risk_level": risk.risk_level,
                }
            )
        return payloads

    def _apply_schema_change_actions(self, server_id: str, changed_tools: list[Any]) -> None:
        for tool in changed_tools:
            policy = self.repositories.mcp_tool_policies.get(server_id, tool.raw_name)
            action = policy.schema_change_action if policy is not None else "require_review"
            if action == "keep_enabled":
                continue
            if action == "disable":
                self.repositories.mcp_tool_policies.upsert(
                    server_id=server_id,
                    raw_tool_name=tool.raw_name,
                    enabled=False,
                    hidden=policy.hidden if policy else False,
                    approval_mode=policy.approval_mode if policy else "inherit",
                    risk_override=policy.risk_override if policy else None,
                    parameter_constraints=policy.parameter_constraints if policy else None,
                    schema_change_action=action,
                )
                continue
            self.repositories.mcp_tool_policies.upsert(
                server_id=server_id,
                raw_tool_name=tool.raw_name,
                enabled=policy.enabled if policy else True,
                hidden=policy.hidden if policy else False,
                approval_mode="prompt",
                risk_override=policy.risk_override if policy else None,
                parameter_constraints=policy.parameter_constraints if policy else None,
                schema_change_action=action,
            )

    def _record_refresh_error(
        self,
        server_id: str,
        runtime_error: McpRuntimeError,
        *,
        original_error: BaseException,
        duration_ms: int,
    ) -> None:
        status = status_from_mcp_error_code(runtime_error.code)
        detail = dict(runtime_error.detail)
        detail.setdefault("error_type", type(original_error).__name__)
        self.repositories.mcp_server_status.update_error(
            server_id,
            status=status.value,
            error_code=runtime_error.code.value,
            error_message=runtime_error.message,
            error_detail=detail,
        )
        self.audit_writer.append_event(
            event_type="refresh.failed",
            server_id=server_id,
            status="error",
            duration_ms=duration_ms,
            summary="MCP capability refresh failed",
            detail={
                "server_id": server_id,
                "error_code": runtime_error.code.value,
                "error_message": runtime_error.message,
                "error_detail": detail,
            },
        )


def _prompt_payload(prompt: McpClientPromptSpec) -> dict[str, Any]:
    properties: dict[str, Any] = {}
    required: list[str] = []
    for argument in prompt.arguments:
        field_schema: dict[str, Any] = {"type": "string"}
        if argument.description:
            field_schema["description"] = argument.description
        properties[argument.name] = field_schema
        if argument.required:
            required.append(argument.name)
    arguments_schema: dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        arguments_schema["required"] = required
    return {
        "raw_name": prompt.name,
        "display_name": prompt.name,
        "description": prompt.description,
        "arguments_schema": arguments_schema,
        "meta": prompt.raw,
    }


def _capabilities_dict(init_result: McpClientInitializeResult) -> dict[str, Any]:
    return {
        "tools": init_result.capabilities.tools,
        "prompts": init_result.capabilities.prompts,
        "resources_reserved": init_result.capabilities.resources_reserved,
        "sampling": init_result.capabilities.sampling,
        "elicitation": init_result.capabilities.elicitation,
        "raw": init_result.capabilities.raw,
    }


def _elapsed_ms(started: float) -> int:
    return max(0, int((time.perf_counter() - started) * 1000))
