from __future__ import annotations

from typing import Any

import pytest

from backend.app.core.time import to_iso_z, utc_now
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.sampling import McpSamplingPolicy, McpSamplingService
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    ModelProviderRecord,
    StorageRepositories,
    init_database,
)


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _provider() -> ModelProviderRecord:
    now = to_iso_z(utc_now())
    return ModelProviderRecord(
        id="provider-1",
        name="Main",
        base_url="https://api.example/v1",
        api_key="sk-secret",
        enabled=True,
        models=["qwen-coder", "deepseek-coder"],
        model_enabled={"qwen-coder": True, "deepseek-coder": True},
        health={},
        created_at=now,
        updated_at=now,
    )


def _create_server(repositories: StorageRepositories, *, sampling_enabled: bool) -> None:
    repositories.mcp_servers.create(
        server_id="srv_sampling",
        name="Sampling MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        sampling_enabled=sampling_enabled,
    )


def _configure_default_model(repositories: StorageRepositories) -> None:
    repositories.model_providers.upsert(_provider())
    repositories.model_providers.set_model_default(
        scope=MODEL_DEFAULT_CHAT,
        provider_id="provider-1",
        model="qwen-coder",
    )


@pytest.mark.asyncio
async def test_sampling_disabled_returns_policy_denied_and_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, sampling_enabled=False)
    _configure_default_model(repositories)
    service = McpSamplingService(
        repositories,
        model_bridge=RecordingSamplingBridge(),
        policy=McpSamplingPolicy(approval_mode="auto"),
    )

    with pytest.raises(McpRuntimeError) as exc_info:
        await service.create_message(
            server_id="srv_sampling",
            messages=[{"role": "user", "content": "hi"}],
        )

    assert exc_info.value.code == McpErrorCode.POLICY_DENIED
    assert exc_info.value.detail["reason"] == "sampling_disabled"
    audits, total = repositories.mcp_audit_log.list(event_type="sampling.denied")
    assert total == 1
    assert audits[0].detail["reason"] == "sampling_disabled"


@pytest.mark.asyncio
async def test_sampling_enabled_uses_keydex_default_model_after_approval(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, sampling_enabled=True)
    _configure_default_model(repositories)
    bridge = RecordingSamplingBridge()
    approvals: list[dict[str, Any]] = []
    service = McpSamplingService(
        repositories,
        model_bridge=bridge,
        approval_decider=lambda request: approvals.append(request) or True,
    )

    result = await service.create_message(
        server_id="srv_sampling",
        session_id="sess-sampling",
        messages=[{"role": "user", "content": "hi"}],
        max_tokens=128,
    )

    assert result["provider_id"] == "provider-1"
    assert result["model"] == "qwen-coder"
    assert bridge.calls[0]["provider_id"] == "provider-1"
    assert bridge.calls[0]["model"] == "qwen-coder"
    assert approvals[0]["max_tokens"] == 128
    requested, requested_total = repositories.mcp_audit_log.list(
        event_type="sampling.requested"
    )
    completed, completed_total = repositories.mcp_audit_log.list(
        event_type="sampling.completed"
    )
    assert requested_total == 1
    assert requested[0].detail["message_count"] == 1
    assert completed_total == 1
    assert completed[0].detail["result"]["usage"] == {"total_tokens": 5}


@pytest.mark.asyncio
async def test_sampling_rejects_token_limit_and_model_not_allowed(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, sampling_enabled=True)
    _configure_default_model(repositories)
    service = McpSamplingService(
        repositories,
        model_bridge=RecordingSamplingBridge(),
        policy=McpSamplingPolicy(
            approval_mode="auto",
            max_tokens=10,
            allowed_models={"qwen-coder"},
        ),
    )

    with pytest.raises(McpRuntimeError) as token_error:
        await service.create_message(
            server_id="srv_sampling",
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=11,
        )
    with pytest.raises(McpRuntimeError) as model_error:
        await service.create_message(
            server_id="srv_sampling",
            messages=[{"role": "user", "content": "hi"}],
            requested_model="deepseek-coder",
        )

    assert token_error.value.detail["reason"] == "max_tokens_exceeded"
    assert model_error.value.detail["reason"] == "model_not_allowed"
    audits, total = repositories.mcp_audit_log.list(event_type="sampling.denied")
    assert total == 2
    assert {audit.detail["reason"] for audit in audits} == {
        "max_tokens_exceeded",
        "model_not_allowed",
    }


@pytest.mark.asyncio
async def test_sampling_rejects_missing_messages_and_default_model_without_bridge_call(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, sampling_enabled=True)
    _configure_default_model(repositories)
    bridge = RecordingSamplingBridge()
    service = McpSamplingService(
        repositories,
        model_bridge=bridge,
        policy=McpSamplingPolicy(approval_mode="auto"),
    )

    with pytest.raises(McpRuntimeError) as messages_error:
        await service.create_message(server_id="srv_sampling", messages=[])

    repositories_without_default = _repositories(tmp_path / "no-default")
    _create_server(repositories_without_default, sampling_enabled=True)
    service_without_default = McpSamplingService(
        repositories_without_default,
        model_bridge=bridge,
        policy=McpSamplingPolicy(approval_mode="auto"),
    )
    with pytest.raises(McpRuntimeError) as default_model_error:
        await service_without_default.create_message(
            server_id="srv_sampling",
            messages=[{"role": "user", "content": "hi"}],
        )

    assert messages_error.value.detail["reason"] == "messages_required"
    assert default_model_error.value.detail["reason"] == "default_model_missing"
    assert bridge.calls == []
    audits, total = repositories.mcp_audit_log.list(event_type="sampling.denied")
    assert total == 1
    assert audits[0].detail["reason"] == "messages_required"
    no_default_audits, no_default_total = (
        repositories_without_default.mcp_audit_log.list(event_type="sampling.denied")
    )
    assert no_default_total == 1
    assert no_default_audits[0].detail["reason"] == "default_model_missing"


@pytest.mark.asyncio
async def test_sampling_prompt_approval_required_and_rejected_never_calls_bridge(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, sampling_enabled=True)
    _configure_default_model(repositories)
    bridge = RecordingSamplingBridge()
    service_without_decider = McpSamplingService(repositories, model_bridge=bridge)
    service_with_rejection = McpSamplingService(
        repositories,
        model_bridge=bridge,
        approval_decider=lambda request: False,
    )

    with pytest.raises(McpRuntimeError) as required_error:
        await service_without_decider.create_message(
            server_id="srv_sampling",
            session_id="sess-sampling",
            messages=[{"role": "user", "content": "hi"}],
        )
    with pytest.raises(McpRuntimeError) as rejected_error:
        await service_with_rejection.create_message(
            server_id="srv_sampling",
            session_id="sess-sampling",
            messages=[{"role": "user", "content": "hi"}],
        )

    assert required_error.value.detail["reason"] == "sampling_approval_required"
    assert rejected_error.value.detail["reason"] == "sampling_approval_rejected"
    assert bridge.calls == []
    audits, total = repositories.mcp_audit_log.list(event_type="sampling.denied")
    assert total == 2
    assert {audit.detail["reason"] for audit in audits} == {
        "sampling_approval_required",
        "sampling_approval_rejected",
    }
    assert {audit.session_id for audit in audits} == {"sess-sampling"}


@pytest.mark.asyncio
async def test_sampling_provider_failure_is_audited_without_completed_event(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, sampling_enabled=True)
    _configure_default_model(repositories)
    service = McpSamplingService(
        repositories,
        model_bridge=FailingSamplingBridge(),
        policy=McpSamplingPolicy(approval_mode="auto"),
    )

    with pytest.raises(RuntimeError, match="provider unavailable"):
        await service.create_message(
            server_id="srv_sampling",
            session_id="sess-sampling",
            messages=[{"role": "user", "content": "hi"}],
        )

    requested, requested_total = repositories.mcp_audit_log.list(
        event_type="sampling.requested"
    )
    failed, failed_total = repositories.mcp_audit_log.list(event_type="sampling.failed")
    _, completed_total = repositories.mcp_audit_log.list(event_type="sampling.completed")
    assert requested_total == 1
    assert requested[0].status == "pending"
    assert failed_total == 1
    assert failed[0].status == "failed"
    assert failed[0].detail == {
        "error_type": "RuntimeError",
        "message": "provider unavailable",
    }
    assert completed_total == 0


@pytest.mark.asyncio
async def test_sampling_audit_detail_modes_control_result_storage(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, sampling_enabled=True)
    _configure_default_model(repositories)
    service = McpSamplingService(
        repositories,
        model_bridge=RecordingSamplingBridge(
            {
                "role": "assistant",
                "content": "ok",
                "api_key": "sk-secret",
                "usage": {"total_tokens": 7},
            }
        ),
        policy=McpSamplingPolicy(approval_mode="auto", audit_detail="full"),
    )

    await service.create_message(
        server_id="srv_sampling",
        messages=[{"role": "user", "content": "hi"}],
    )

    full_records, full_total = repositories.mcp_audit_log.list(
        event_type="sampling.completed"
    )
    assert full_total == 1
    assert full_records[0].detail["result"]["content"] == "ok"
    assert full_records[0].detail["result"]["api_key"] == "***REDACTED***"

    repositories_none = _repositories(tmp_path / "audit-none")
    _create_server(repositories_none, sampling_enabled=True)
    _configure_default_model(repositories_none)
    service_none = McpSamplingService(
        repositories_none,
        model_bridge=RecordingSamplingBridge(
            {
                "role": "assistant",
                "content": "ok",
                "usage": {"total_tokens": 7},
            }
        ),
        policy=McpSamplingPolicy(approval_mode="auto", audit_detail="none"),
    )

    await service_none.create_message(
        server_id="srv_sampling",
        messages=[{"role": "user", "content": "hi"}],
    )

    none_records, none_total = repositories_none.mcp_audit_log.list(
        event_type="sampling.completed"
    )
    assert none_total == 1
    assert none_records[0].detail["result"] == {}


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


class FailingSamplingBridge:
    async def create_message(
        self,
        *,
        provider_id: str,
        model: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        temperature: float | None = None,
    ) -> dict[str, Any]:
        raise RuntimeError("provider unavailable")
