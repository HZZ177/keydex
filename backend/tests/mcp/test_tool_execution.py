from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from backend.app.command_approval import ApprovalService, CommandApprovalDecision
from backend.app.core.config import AppSettings
from backend.app.core.time import to_iso_z, utc_now
from backend.app.mcp.approval import McpToolApprovalDecision, McpToolApprovalRequest
from backend.app.mcp.client import (
    McpCancellationToken,
    McpClientBase,
    McpClientCapabilities,
    McpClientInitializeResult,
    McpClientPromptResult,
    McpClientPromptSpec,
    McpClientToolResult,
    McpClientToolSpec,
)
from backend.app.mcp.elicitation import McpElicitationService
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.manager import McpManager
from backend.app.mcp.sampling import McpSamplingPolicy, McpSamplingService
from backend.app.mcp.types import McpErrorCode, McpServerStatus
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    McpServerRecord,
    ModelProviderRecord,
    StorageRepositories,
    init_database,
)


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_server_and_tool(
    repositories: StorageRepositories,
    *,
    risk_level: str = "low",
    default_tool_approval_mode: str = "auto",
    annotations: dict[str, Any] | None = None,
    input_schema: dict[str, Any] | None = None,
    sampling_enabled: bool = False,
) -> None:
    repositories.mcp_servers.create(
        server_id="srv_exec",
        name="Execution MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        default_tool_approval_mode=default_tool_approval_mode,
        sampling_enabled=sampling_enabled,
    )
    repositories.mcp_server_status.upsert("srv_exec", status="online")
    repositories.mcp_tools.upsert_many(
        "srv_exec",
        [
            {
                "raw_name": "search",
                "model_name": "mcp__srv_exec__search",
                "callable_namespace": "mcp__srv_exec",
                "callable_name": "search",
                "description": "Search",
                "input_schema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                }
                if input_schema is None
                else input_schema,
                "annotations": annotations,
                "schema_hash": "hash-search",
                "risk_level": risk_level,
            }
        ],
    )


def _create_session(repositories: StorageRepositories, session_id: str = "session-a") -> None:
    repositories.sessions.create(
        session_id=session_id,
        user_id="local-user",
        scene_id="desktop-agent",
        title="MCP 工具执行",
        session_type="workspace",
    )


def _configure_default_model(repositories: StorageRepositories) -> None:
    now = to_iso_z(utc_now())
    repositories.model_providers.upsert(
        ModelProviderRecord(
            id="provider-1",
            name="Main",
            base_url="https://api.example.test/v1",
            api_key="sk-secret",
            enabled=True,
            models=["qwen-coder"],
            model_enabled={"qwen-coder": True},
            health={},
            created_at=now,
            updated_at=now,
        )
    )
    repositories.model_providers.set_model_default(
        scope=MODEL_DEFAULT_CHAT,
        provider_id="provider-1",
        model="qwen-coder",
    )


def _context(
    *,
    session_id: str = "session-a",
    dispatcher: Any | None = None,
    approval_wait_seconds: float = 2,
) -> SimpleNamespace:
    return SimpleNamespace(
        session_id=session_id,
        user_id="local-user",
        trace_id="trace-a",
        turn_index=1,
        run_id="run-a",
        tool_call_id="call-a",
        metadata={
            "dispatcher": dispatcher,
            "approval_wait_seconds": approval_wait_seconds,
        },
    )


async def _wait_for_pending_mcp_approval(
    repositories: StorageRepositories,
    *,
    session_id: str = "session-a",
):
    for _ in range(40):
        pending = repositories.command_approvals.list_pending(session_id=session_id)
        if pending:
            return pending[0]
        await asyncio.sleep(0.05)
    raise AssertionError("没有创建 pending MCP 审批")


@pytest.mark.asyncio
async def test_execute_tool_success_updates_counters_and_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories)
    factory = RecordingExecutionClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    tool = repositories.mcp_tools.get_by_raw_name("srv_exec", "search")
    audits, total = repositories.mcp_audit_log.list(event_type="tool.called")
    assert result.ok is True
    assert result.result["content"] == [{"type": "text", "text": "result"}]
    assert factory.clients[0].calls == [
        {
            "raw_tool_name": "search",
            "arguments": {"query": "hello"},
            "call_id": "call-a",
            "timeout_sec": 60,
        }
    ]
    assert tool.call_count == 1
    assert tool.failure_count == 0
    assert tool.last_used_at is not None
    assert total == 1
    assert audits[0].status == "completed"
    assert audits[0].detail["snapshot_id"] == "snap-a"
    assert audits[0].detail["argument_keys"] == ["query"]
    assert audits[0].detail["content_items"] == 1
    assert audits[0].duration_ms is not None


@pytest.mark.asyncio
async def test_execute_tool_waits_for_mcp_elicitation_submit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories)
    _create_session(repositories)
    factory = RecordingExecutionClientFactory(
        result=McpClientToolResult(
            call_id="call-a",
            status="success",
            content=[{"type": "text", "text": "needs input"}],
            structured_content={
                "_keydex_elicitation_request": {
                    "trigger": True,
                    "id": "elicitation-submit",
                    "title": "Need summary",
                    "schema": {
                        "type": "object",
                        "required": ["summary"],
                        "properties": {
                            "summary": {"type": "string", "title": "Summary"},
                            "confirmed": {"type": "boolean", "title": "Confirmed"},
                        },
                    },
                }
            },
        )
    )
    events: list[tuple[str, str, dict[str, Any]]] = []

    async def broadcaster(session_id: str, action: str, data: dict[str, Any]) -> bool:
        events.append((session_id, action, data))
        if action == "mcp_elicitation_requested":
            asyncio.create_task(
                service.resolve(
                    data["elicitation"]["elicitation_id"],
                    values={"summary": "Deploy done", "confirmed": True},
                )
            )
        return True

    service = McpElicitationService(repositories, broadcaster=broadcaster)
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
        elicitation_service=service,
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    assert result.ok is True
    assert result.result["structured_content"]["elicitation"]["values"] == {
        "summary": "Deploy done",
        "confirmed": True,
    }
    assert events[0][1] == "mcp_elicitation_requested"
    assert events[-1][1] == "mcp_elicitation_resolved"
    requested, requested_total = repositories.mcp_audit_log.list(
        event_type="elicitation.requested"
    )
    resolved, resolved_total = repositories.mcp_audit_log.list(
        event_type="elicitation.resolved"
    )
    assert requested_total == 1
    assert requested[0].detail["elicitation_id"] == "elicitation-submit"
    assert resolved_total == 1
    assert resolved[0].detail["value_keys"] == ["confirmed", "summary"]


@pytest.mark.asyncio
async def test_execute_tool_returns_cancelled_when_mcp_elicitation_cancelled(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories)
    _create_session(repositories)
    factory = RecordingExecutionClientFactory(
        result=McpClientToolResult(
            call_id="call-a",
            status="success",
            content=[{"type": "text", "text": "needs input"}],
            structured_content={
                "_keydex_elicitation_request": {
                    "trigger": True,
                    "id": "elicitation-cancel",
                    "title": "Need summary",
                    "schema": {"type": "object"},
                }
            },
        )
    )

    async def broadcaster(_session_id: str, action: str, data: dict[str, Any]) -> bool:
        if action == "mcp_elicitation_requested":
            asyncio.create_task(
                service.resolve(data["elicitation"]["elicitation_id"], cancelled=True)
            )
        return True

    service = McpElicitationService(repositories, broadcaster=broadcaster)
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
        elicitation_service=service,
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    assert result.ok is False
    assert result.error["code"] == "cancelled"
    assert result.error["details"]["reason"] == "elicitation_cancelled"
    audits, total = repositories.mcp_audit_log.list(event_type="tool.failed")
    assert total == 1
    assert audits[0].detail["error_code"] == "cancelled"


@pytest.mark.asyncio
async def test_execute_tool_waits_for_mcp_sampling_approval_and_appends_result(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories, sampling_enabled=True)
    _create_session(repositories)
    _configure_default_model(repositories)
    factory = RecordingExecutionClientFactory(
        result=McpClientToolResult(
            call_id="call-a",
            status="success",
            content=[{"type": "text", "text": "needs sampling"}],
            structured_content={
                "_keydex_sampling_request": {
                    "trigger": True,
                    "id": "sampling-approve",
                    "messages": [{"role": "user", "content": "summarize"}],
                    "max_tokens": 64,
                    "temperature": 0.1,
                }
            },
        )
    )
    dispatcher = RecordingDispatcher()
    bridge = RecordingSamplingBridge(
        {"role": "assistant", "content": "sample ok", "usage": {"total_tokens": 5}}
    )
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
        sampling_service=McpSamplingService(repositories, model_bridge=bridge),
    )
    task = asyncio.create_task(
        manager.execute_tool(
            snapshot_id="snap-a",
            server_id="srv_exec",
            raw_tool_name="search",
            arguments={"query": "hello"},
            call_context=_context(dispatcher=dispatcher),
        )
    )

    approval = await _wait_for_pending_mcp_approval(repositories)
    payload = dispatcher.events[0]["payload"]["approval"]
    await ApprovalService(repositories=repositories).resolve(
        approval.id,
        CommandApprovalDecision(decision="approved", trust_scope="once"),
    )
    result = await task

    assert approval.kind == "mcp_sampling"
    assert approval.details["approval_kind"] == "mcp_sampling"
    assert approval.details["server_id"] == "srv_exec"
    assert approval.details["model"] == "qwen-coder"
    assert approval.details["max_tokens"] == 64
    assert payload["approval_kind"] == "mcp_sampling"
    assert payload["metadata"]["mcp"]["kind"] == "mcp_sampling"
    assert result.ok is True
    assert result.result["structured_content"]["sampling"]["result"]["content"] == "sample ok"
    assert "MCP sampling completed" in str(result.result["content"])
    assert bridge.calls[0]["provider_id"] == "provider-1"
    requested, requested_total = repositories.mcp_audit_log.list(
        event_type="sampling.requested"
    )
    completed, completed_total = repositories.mcp_audit_log.list(
        event_type="sampling.completed"
    )
    audits, total = repositories.command_approval_audit.list(session_id="session-a")
    assert requested_total == 1
    assert requested[0].detail["message_count"] == 1
    assert completed_total == 1
    assert completed[0].detail["result"]["usage"] == {"total_tokens": 5}
    assert total == 1
    assert audits[0].metadata["mcp"]["kind"] == "mcp_sampling"


@pytest.mark.asyncio
async def test_execute_tool_returns_policy_denied_when_mcp_sampling_disabled(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories, sampling_enabled=False)
    _create_session(repositories)
    factory = RecordingExecutionClientFactory(
        result=McpClientToolResult(
            call_id="call-a",
            status="success",
            content=[{"type": "text", "text": "needs sampling"}],
            structured_content={
                "_keydex_sampling_request": {
                    "trigger": True,
                    "messages": [{"role": "user", "content": "summarize"}],
                    "max_tokens": 64,
                }
            },
        )
    )
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
        sampling_service=McpSamplingService(
            repositories,
            model_bridge=RecordingSamplingBridge(),
            policy=McpSamplingPolicy(approval_mode="auto"),
        ),
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    denied, denied_total = repositories.mcp_audit_log.list(event_type="sampling.denied")
    failed, failed_total = repositories.mcp_audit_log.list(event_type="tool.failed")
    assert result.ok is False
    assert result.error["code"] == "policy_denied"
    assert result.error["details"]["reason"] == "sampling_disabled"
    assert denied_total == 1
    assert denied[0].detail["reason"] == "sampling_disabled"
    assert failed_total == 1
    assert failed[0].detail["error_code"] == "policy_denied"


@pytest.mark.asyncio
async def test_execute_tool_returns_policy_denied_when_mcp_sampling_exceeds_budget(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories, sampling_enabled=True)
    _create_session(repositories)
    _configure_default_model(repositories)
    factory = RecordingExecutionClientFactory(
        result=McpClientToolResult(
            call_id="call-a",
            status="success",
            content=[{"type": "text", "text": "needs sampling"}],
            structured_content={
                "_keydex_sampling_request": {
                    "trigger": True,
                    "messages": [{"role": "user", "content": "summarize"}],
                    "max_tokens": 4096,
                }
            },
        )
    )
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
        sampling_service=McpSamplingService(
            repositories,
            model_bridge=RecordingSamplingBridge(),
            policy=McpSamplingPolicy(approval_mode="auto", max_tokens=128),
        ),
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    denied, denied_total = repositories.mcp_audit_log.list(event_type="sampling.denied")
    assert result.ok is False
    assert result.error["code"] == "policy_denied"
    assert result.error["details"]["reason"] == "max_tokens_exceeded"
    assert denied_total == 1
    assert denied[0].detail["reason"] == "max_tokens_exceeded"


@pytest.mark.asyncio
async def test_execute_tool_truncates_large_text_result_and_redacts_secret(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories)
    secret_text = "token=super-secret-value " + ("x" * 2_000)
    factory = RecordingExecutionClientFactory(
        result=McpClientToolResult(
            call_id="call-a",
            status="success",
            content=[{"type": "text", "text": secret_text}],
            metadata={"authorization": "Bearer hidden-token"},
        )
    )
    manager = McpManager(
        settings=AppSettings(
            data_dir=tmp_path / "data",
            mcp_max_tool_result_bytes=700,
        ),
        repositories=repositories,
        client_factory=factory,
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    payload = result.result
    serialized = str(payload)
    audits, _total = repositories.mcp_audit_log.list(event_type="tool.called")
    assert result.ok is True
    assert payload["metadata"]["result_truncated"] is True
    assert payload["metadata"]["original_result_size_bytes"] > 700
    assert "super-secret-value" not in serialized
    assert "hidden-token" not in serialized
    assert "<truncated>" in serialized
    assert audits[0].detail["result_truncated"] is True


@pytest.mark.asyncio
async def test_execute_tool_truncates_large_json_result_and_redacts_password(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories)
    factory = RecordingExecutionClientFactory(
        result=McpClientToolResult(
            call_id="call-a",
            status="success",
            content=[],
            structured_content={
                "items": [
                    {
                        "title": "row",
                        "password": "plain-password",
                        "body": "y" * 1_500,
                    }
                ]
            },
        )
    )
    manager = McpManager(
        settings=AppSettings(
            data_dir=tmp_path / "data",
            mcp_max_tool_result_bytes=900,
        ),
        repositories=repositories,
        client_factory=factory,
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    payload = result.result
    serialized = str(payload)
    assert result.ok is True
    assert payload["metadata"]["result_truncated"] is True
    assert payload["structured_content"]["items"][0]["password"] == "***REDACTED***"
    assert "plain-password" not in serialized
    assert "<truncated>" in serialized


@pytest.mark.asyncio
async def test_execute_tool_returns_result_too_large_when_truncated_payload_cannot_fit(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories)
    factory = RecordingExecutionClientFactory(
        result=McpClientToolResult(
            call_id="call-a",
            status="success",
            content=[{"type": "text", "text": "z" * 2_000}],
        )
    )
    manager = McpManager(
        settings=AppSettings(
            data_dir=tmp_path / "data",
            mcp_max_tool_result_bytes=16,
        ),
        repositories=repositories,
        client_factory=factory,
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    tool = repositories.mcp_tools.get_by_raw_name("srv_exec", "search")
    audits, total = repositories.mcp_audit_log.list(event_type="tool.failed")
    assert result.ok is False
    assert result.error["code"] == "result_too_large"
    assert tool.call_count == 1
    assert tool.failure_count == 1
    assert total == 1
    assert audits[0].detail["error_code"] == "result_too_large"


@pytest.mark.asyncio
async def test_execute_tool_rejects_non_object_arguments(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories)
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=RecordingExecutionClientFactory(),
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments=["not-object"],  # type: ignore[arg-type]
        call_context=_context(),
    )

    tool = repositories.mcp_tools.get_by_raw_name("srv_exec", "search")
    audits, total = repositories.mcp_audit_log.list(event_type="tool.failed")
    assert result.ok is False
    assert result.error["code"] == "validation_error"
    assert tool.call_count == 0
    assert tool.failure_count == 0
    assert total == 1
    assert audits[0].detail["error_code"] == "validation_error"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("arguments", "expected_detail"),
    [
        (
            {},
            {"reason": "required_arguments_missing", "missing": ["query"]},
        ),
        (
            {"query": 123},
            {
                "reason": "argument_type_mismatch",
                "argument": "query",
                "expected": ["string"],
            },
        ),
    ],
)
async def test_execute_tool_rejects_schema_invalid_arguments_before_client_call(
    tmp_path,
    arguments: dict[str, Any],
    expected_detail: dict[str, Any],
) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories)
    factory = RecordingExecutionClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments=arguments,
        call_context=_context(),
    )

    tool = repositories.mcp_tools.get_by_raw_name("srv_exec", "search")
    audits, total = repositories.mcp_audit_log.list(event_type="tool.failed")
    assert result.ok is False
    assert result.error["code"] == "validation_error"
    assert result.error["details"] == expected_detail
    assert factory.created == []
    assert tool.call_count == 1
    assert tool.failure_count == 1
    assert total == 1
    assert audits[0].detail["error_code"] == "validation_error"
    assert audits[0].detail["error_detail"] == expected_detail


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "expected_code"),
    [
        (TimeoutError(), "timeout"),
        (McpRuntimeError(McpErrorCode.CANCELLED), "cancelled"),
    ],
)
async def test_execute_tool_maps_timeout_and_cancellation(
    tmp_path,
    error: BaseException,
    expected_code: str,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories)
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=RecordingExecutionClientFactory(error=error),
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    tool = repositories.mcp_tools.get_by_raw_name("srv_exec", "search")
    audits, total = repositories.mcp_audit_log.list(event_type="tool.failed")
    assert result.ok is False
    assert result.error["code"] == expected_code
    assert tool.call_count == 1
    assert tool.failure_count == 1
    assert total == 1
    assert audits[0].detail["error_code"] == expected_code


@pytest.mark.asyncio
async def test_execute_tool_stops_before_client_when_approval_rejected(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server_and_tool(repositories)
    factory = RecordingExecutionClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
        approval_decider=RejectingApprovalDecider(),
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    tool = repositories.mcp_tools.get_by_raw_name("srv_exec", "search")
    audits, total = repositories.mcp_audit_log.list(event_type="tool.failed")
    assert result.ok is False
    assert result.error["code"] == "approval_rejected"
    assert factory.created == []
    assert tool.call_count == 1
    assert tool.failure_count == 1
    assert total == 1
    assert audits[0].detail["error_code"] == "approval_rejected"


@pytest.mark.asyncio
async def test_execute_tool_creates_mcp_approval_request_payload(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_session(repositories)
    _create_server_and_tool(repositories, risk_level="high")
    dispatcher = RecordingDispatcher()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=RecordingExecutionClientFactory(),
    )
    task = asyncio.create_task(
        manager.execute_tool(
            snapshot_id="snap-a",
            server_id="srv_exec",
            raw_tool_name="search",
            arguments={"query": "hello", "token": "secret-token"},
            call_context=_context(dispatcher=dispatcher),
        )
    )

    approval = await _wait_for_pending_mcp_approval(repositories)
    payload = dispatcher.events[0]["payload"]["approval"]
    await ApprovalService(repositories=repositories).resolve(
        approval.id,
        CommandApprovalDecision(decision="rejected", trust_scope="once"),
    )
    result = await task

    assert approval.kind == "mcp_tool_call"
    assert approval.shell == "mcp"
    assert approval.details["approval_kind"] == "mcp_tool_call"
    assert approval.details["server_id"] == "srv_exec"
    assert approval.details["server_name"] == "Execution MCP"
    assert approval.details["raw_tool_name"] == "search"
    assert approval.details["model_tool_name"] == "mcp__srv_exec__search"
    assert approval.details["risk_level"] == "high"
    assert approval.details["arguments_preview"]["token"] == "***REDACTED***"
    assert approval.details["trust_options"] == [
        "once",
        "session",
        "persistent_tool",
        "server_readonly",
    ]
    assert payload["approval_kind"] == "mcp_tool_call"
    assert payload["metadata"]["mcp"]["server_id"] == "srv_exec"
    assert result.ok is False
    assert result.error["code"] == "approval_rejected"


@pytest.mark.asyncio
async def test_execute_tool_continues_after_mcp_approval(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_session(repositories)
    _create_server_and_tool(repositories, risk_level="high")
    factory = RecordingExecutionClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )
    task = asyncio.create_task(
        manager.execute_tool(
            snapshot_id="snap-a",
            server_id="srv_exec",
            raw_tool_name="search",
            arguments={"query": "hello"},
            call_context=_context(),
        )
    )

    approval = await _wait_for_pending_mcp_approval(repositories)
    resolved = await ApprovalService(repositories=repositories).resolve(
        approval.id,
        CommandApprovalDecision(decision="approved", trust_scope="session"),
    )
    result = await task

    audits, total = repositories.command_approval_audit.list(session_id="session-a")
    mcp_audits, mcp_audit_total = repositories.mcp_audit_log.list(session_id="session-a")
    mcp_audit_types = [record.event_type for record in mcp_audits]
    assert resolved.status == "approved"
    assert resolved.trust_scope == "session"
    assert result.ok is True
    assert factory.clients[0].calls[0]["raw_tool_name"] == "search"
    assert repositories.trusted_command_rules.list() == []
    assert total == 1
    assert audits[0].metadata["kind"] == "mcp_tool_call"
    assert audits[0].metadata["mcp"]["model_tool_name"] == "mcp__srv_exec__search"
    assert mcp_audit_total >= 3
    assert "approval.requested" in mcp_audit_types
    assert "approval.resolved" in mcp_audit_types


@pytest.mark.asyncio
async def test_session_trust_created_from_approval_skips_next_tool_approval(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_session(repositories)
    _create_server_and_tool(repositories, risk_level="high")
    factory = RecordingExecutionClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )
    first_task = asyncio.create_task(
        manager.execute_tool(
            snapshot_id="snap-a",
            server_id="srv_exec",
            raw_tool_name="search",
            arguments={"query": "hello"},
            call_context=_context(),
        )
    )
    approval = await _wait_for_pending_mcp_approval(repositories)
    await ApprovalService(repositories=repositories).resolve(
        approval.id,
        CommandApprovalDecision(decision="approved", trust_scope="session"),
    )
    first = await first_task

    second = await manager.execute_tool(
        snapshot_id="snap-b",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    trust_rules = repositories.mcp_trust_rules.list(scope="session", session_id="session-a")
    trust_audits, trust_total = repositories.mcp_audit_log.list(event_type="trust.hit")
    assert first.ok is True
    assert second.ok is True
    assert len(trust_rules) == 1
    assert trust_rules[0].created_from_approval_id == approval.id
    assert repositories.command_approvals.list_pending(session_id="session-a") == []
    assert len(factory.clients[0].calls) == 2
    assert trust_total == 1
    assert trust_audits[0].detail["rule_id"] == trust_rules[0].id


@pytest.mark.asyncio
async def test_persistent_tool_trust_created_from_mcp_approval_is_global_and_mcp_only(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_session(repositories)
    _create_session(repositories, session_id="session-b")
    _create_server_and_tool(repositories, risk_level="high")
    factory = RecordingExecutionClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )
    first_task = asyncio.create_task(
        manager.execute_tool(
            snapshot_id="snap-a",
            server_id="srv_exec",
            raw_tool_name="search",
            arguments={"query": "hello"},
            call_context=_context(),
        )
    )
    approval = await _wait_for_pending_mcp_approval(repositories)
    await ApprovalService(repositories=repositories).resolve(
        approval.id,
        CommandApprovalDecision(decision="approved", trust_scope="persistent_tool"),
    )
    first = await first_task

    second = await manager.execute_tool(
        snapshot_id="snap-b",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(session_id="session-b"),
    )

    trust_rules = repositories.mcp_trust_rules.list(scope="global")
    created_audits, created_total = repositories.mcp_audit_log.list(
        event_type="trust.created"
    )
    hit_audits, hit_total = repositories.mcp_audit_log.list(event_type="trust.hit")
    approval_audits, approval_audit_total = repositories.command_approval_audit.list(
        session_id="session-a"
    )
    assert first.ok is True
    assert second.ok is True
    assert len(trust_rules) == 1
    assert trust_rules[0].rule_kind == "tool"
    assert trust_rules[0].scope == "global"
    assert trust_rules[0].raw_tool_name == "search"
    assert trust_rules[0].created_from_approval_id == approval.id
    assert repositories.trusted_command_rules.list() == []
    assert repositories.command_approvals.list_pending(session_id="session-b") == []
    assert len(factory.clients[0].calls) == 2
    assert created_total == 1
    assert created_audits[0].detail["rule_id"] == trust_rules[0].id
    assert hit_total == 1
    assert hit_audits[0].session_id == "session-b"
    assert hit_audits[0].detail["rule_id"] == trust_rules[0].id
    assert approval_audit_total == 1
    assert approval_audits[0].metadata["mcp"]["trust_rule_id"] == trust_rules[0].id


@pytest.mark.asyncio
async def test_execute_tool_rejects_mcp_approval_without_client_call(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_session(repositories)
    _create_server_and_tool(repositories, risk_level="high")
    factory = RecordingExecutionClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )
    task = asyncio.create_task(
        manager.execute_tool(
            snapshot_id="snap-a",
            server_id="srv_exec",
            raw_tool_name="search",
            arguments={"query": "hello"},
            call_context=_context(),
        )
    )

    approval = await _wait_for_pending_mcp_approval(repositories)
    await ApprovalService(repositories=repositories).resolve(
        approval.id,
        CommandApprovalDecision(
            decision="rejected",
            trust_scope="once",
            reject_message="不允许写入外部系统",
        ),
    )
    result = await task

    audits, total = repositories.command_approval_audit.list(session_id="session-a")
    assert result.ok is False
    assert result.error["code"] == "approval_rejected"
    assert result.error["details"]["approval_reason"] == "不允许写入外部系统"
    assert factory.created == []
    assert total == 1
    assert audits[0].decision == "rejected"
    assert audits[0].metadata["mcp"]["raw_tool_name"] == "search"


@pytest.mark.asyncio
async def test_tool_policy_prompt_overrides_server_approve(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_session(repositories)
    _create_server_and_tool(
        repositories,
        risk_level="low",
        default_tool_approval_mode="approve",
        annotations={"readOnlyHint": True},
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_exec",
        raw_tool_name="search",
        approval_mode="prompt",
    )
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=RecordingExecutionClientFactory(),
    )
    task = asyncio.create_task(
        manager.execute_tool(
            snapshot_id="snap-a",
            server_id="srv_exec",
            raw_tool_name="search",
            arguments={"query": "hello"},
            call_context=_context(),
        )
    )

    approval = await _wait_for_pending_mcp_approval(repositories)
    await ApprovalService(repositories=repositories).resolve(
        approval.id,
        CommandApprovalDecision(decision="rejected", trust_scope="once"),
    )
    result = await task

    assert approval.details["approval_mode"] == "prompt"
    assert approval.details["risk_level"] == "low"
    assert approval.details["risk_reasons"] == ["readOnlyHint=true"]
    assert result.ok is False
    assert result.error["code"] == "approval_rejected"


@pytest.mark.asyncio
async def test_tool_policy_approve_skips_high_risk_approval(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_session(repositories)
    _create_server_and_tool(repositories, risk_level="high")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_exec",
        raw_tool_name="search",
        approval_mode="approve",
    )
    factory = RecordingExecutionClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    audits, _total = repositories.mcp_audit_log.list(event_type="tool.called")
    assert result.ok is True
    assert repositories.command_approvals.list_pending(session_id="session-a") == []
    assert factory.clients[0].calls[0]["raw_tool_name"] == "search"
    assert audits[0].detail["approval_mode"] == "approve"
    assert audits[0].detail["risk_level"] == "high"


@pytest.mark.asyncio
async def test_tool_policy_deny_blocks_before_client_call(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_session(repositories)
    _create_server_and_tool(
        repositories,
        risk_level="low",
        annotations={"readOnlyHint": True},
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_exec",
        raw_tool_name="search",
        approval_mode="deny",
    )
    factory = RecordingExecutionClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )

    result = await manager.execute_tool(
        snapshot_id="snap-a",
        server_id="srv_exec",
        raw_tool_name="search",
        arguments={"query": "hello"},
        call_context=_context(),
    )

    audits, _total = repositories.mcp_audit_log.list(event_type="tool.failed")
    assert result.ok is False
    assert result.error["code"] == "policy_denied"
    assert factory.created == []
    assert repositories.command_approvals.list_pending(session_id="session-a") == []
    assert audits[0].detail["error_code"] == "policy_denied"


class RejectingApprovalDecider:
    async def decide(
        self,
        request: McpToolApprovalRequest,
    ) -> McpToolApprovalDecision:
        return McpToolApprovalDecision(
            approved=False,
            reason=f"rejected:{request.raw_tool_name}",
            error_code=McpErrorCode.APPROVAL_REJECTED,
        )


class RecordingDispatcher:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def emit_event(self, **event: Any) -> None:
        self.events.append(event)


class RecordingSamplingBridge:
    def __init__(self, result: dict[str, Any] | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.result = result or {
            "role": "assistant",
            "content": "ok",
            "usage": {"total_tokens": 5},
        }

    async def create_message(
        self,
        *,
        provider_id: str,
        model: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        temperature: float | None = None,
    ) -> dict[str, Any]:
        self.calls.append(
            {
                "provider_id": provider_id,
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
                "temperature": temperature,
            }
        )
        return dict(self.result)


class RecordingExecutionClientFactory:
    def __init__(
        self,
        *,
        error: BaseException | None = None,
        result: McpClientToolResult | None = None,
    ) -> None:
        self.error = error
        self.result = result
        self.created: list[str] = []
        self.clients: list[RecordingExecutionClient] = []

    def create_client(self, server: McpServerRecord) -> RecordingExecutionClient:
        self.created.append(server.id)
        client = RecordingExecutionClient(server.id, error=self.error, result=self.result)
        self.clients.append(client)
        return client


class RecordingExecutionClient(McpClientBase):
    def __init__(
        self,
        server_id: str,
        *,
        error: BaseException | None = None,
        result: McpClientToolResult | None = None,
    ) -> None:
        super().__init__(server_id=server_id)
        self.error = error
        self.result = result
        self.calls: list[dict[str, Any]] = []

    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult:
        self.transition_status(McpServerStatus.ONLINE, reason="test_initialized")
        return McpClientInitializeResult(
            protocol_version="2026-03-26",
            server_info={"name": "fake"},
            capabilities=McpClientCapabilities(),
        )

    async def list_tools(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientToolSpec]:
        return []

    async def list_prompts(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientPromptSpec]:
        return []

    async def call_tool(
        self,
        raw_tool_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        call_id: str | None = None,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientToolResult:
        self.calls.append(
            {
                "raw_tool_name": raw_tool_name,
                "arguments": arguments,
                "call_id": call_id,
                "timeout_sec": timeout_sec,
            }
        )
        if self.error is not None:
            raise self.error
        if self.result is not None:
            return self.result
        return McpClientToolResult(
            call_id=call_id or "call-generated",
            status="success",
            content=[{"type": "text", "text": "result"}],
        )

    async def get_prompt(
        self,
        raw_prompt_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientPromptResult:
        raise NotImplementedError

    async def cancel_call(self, call_id: str) -> bool:
        return False

    async def shutdown(self, *, timeout_sec: float | None = None) -> None:
        self.transition_status(McpServerStatus.OFFLINE, reason="test_shutdown")
