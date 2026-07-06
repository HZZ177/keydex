from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from backend.app.mcp.audit import McpAuditWriter, redact_sensitive_data
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import MODEL_DEFAULT_CHAT, StorageRepositories

McpSamplingApprovalDecider = Callable[[dict[str, Any]], Awaitable[bool] | bool]


class McpSamplingModelBridge(Protocol):
    async def create_message(
        self,
        *,
        provider_id: str,
        model: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        temperature: float | None = None,
    ) -> dict[str, Any]: ...


class McpOpenAICompatibleSamplingBridge:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        transport_provider: Callable[[], httpx.AsyncBaseTransport | None] | None = None,
        timeout_seconds: float = 60,
    ) -> None:
        self.repositories = repositories
        self.transport_provider = transport_provider
        self.timeout_seconds = timeout_seconds

    async def create_message(
        self,
        *,
        provider_id: str,
        model: str,
        messages: list[dict[str, Any]],
        max_tokens: int,
        temperature: float | None = None,
    ) -> dict[str, Any]:
        provider = self.repositories.model_providers.get(provider_id)
        if provider is None or not provider.enabled:
            raise RuntimeError("sampling default model provider unavailable")
        if model not in provider.models or provider.model_enabled.get(model) is False:
            raise RuntimeError("sampling model is not enabled on provider")
        if not provider.base_url.strip():
            raise RuntimeError("sampling model provider base_url is not configured")
        body: dict[str, Any] = {
            "model": model,
            "messages": [dict(message) for message in messages],
            "stream": False,
            "max_tokens": max_tokens,
        }
        if temperature is not None:
            body["temperature"] = temperature
        headers = {}
        if provider.api_key:
            headers["Authorization"] = f"Bearer {provider.api_key}"
        async with httpx.AsyncClient(
            timeout=self.timeout_seconds,
            headers=headers,
            transport=self.transport_provider() if self.transport_provider else None,
        ) as client:
            try:
                response = await client.post(
                    f"{_api_base_url(provider.base_url)}/chat/completions",
                    json=body,
                )
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise RuntimeError(
                    f"sampling model provider returned HTTP {exc.response.status_code}"
                ) from exc
            except httpx.HTTPError as exc:
                raise RuntimeError(f"sampling model provider request failed: {exc}") from exc
        payload = response.json()
        message = _first_choice_message(payload)
        usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
        return {
            "role": message.get("role") or "assistant",
            "content": message.get("content") or "",
            "usage": dict(usage),
        }


@dataclass(frozen=True)
class McpSamplingPolicy:
    approval_mode: str = "prompt"
    max_tokens: int = 2048
    allowed_models: set[str] | None = None
    audit_detail: str = "summary"


class McpSamplingService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        model_bridge: McpSamplingModelBridge,
        approval_decider: McpSamplingApprovalDecider | None = None,
        policy: McpSamplingPolicy | None = None,
    ) -> None:
        self.repositories = repositories
        self.model_bridge = model_bridge
        self.approval_decider = approval_decider
        self.policy = policy or McpSamplingPolicy()
        self.audit_writer = McpAuditWriter.from_repositories(repositories)

    async def create_message(
        self,
        *,
        server_id: str,
        messages: list[dict[str, Any]],
        requested_model: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        session_id: str | None = None,
        approval_decider: McpSamplingApprovalDecider | None = None,
        approval_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        server = self.repositories.mcp_servers.get(server_id)
        if server is None:
            raise McpRuntimeError(McpErrorCode.SERVER_NOT_FOUND, detail={"server_id": server_id})
        try:
            if not server.sampling_enabled:
                self._deny(server_id, session_id, "sampling_disabled")
            if not isinstance(messages, list) or not messages:
                self._deny(server_id, session_id, "messages_required")
            token_limit = max_tokens or self.policy.max_tokens
            if token_limit > self.policy.max_tokens:
                self._deny(server_id, session_id, "max_tokens_exceeded")
            default_model = self.repositories.model_providers.get_model_default(
                MODEL_DEFAULT_CHAT
            )
            if default_model is None:
                self._deny(server_id, session_id, "default_model_missing")
            assert default_model is not None
            model = requested_model or default_model.model
            allowed_models = self.policy.allowed_models or {default_model.model}
            if model not in allowed_models:
                self._deny(server_id, session_id, "model_not_allowed", model=model)
            await self._maybe_approve(
                server_id=server_id,
                session_id=session_id,
                model=model,
                max_tokens=token_limit,
                approval_decider=approval_decider,
                approval_context=approval_context,
            )
            self.audit_writer.append_event(
                event_type="sampling.requested",
                server_id=server_id,
                session_id=session_id,
                status="pending",
                summary="MCP sampling request accepted",
                detail={
                    "model": model,
                    "max_tokens": token_limit,
                    "message_count": len(messages),
                },
            )
            result = await self.model_bridge.create_message(
                provider_id=default_model.provider_id,
                model=model,
                messages=[dict(message) for message in messages],
                max_tokens=token_limit,
                temperature=temperature,
            )
            self.audit_writer.append_event(
                event_type="sampling.completed",
                server_id=server_id,
                session_id=session_id,
                status="completed",
                summary="MCP sampling completed",
                detail={
                    "model": model,
                    "max_tokens": token_limit,
                    "result": _audit_result(result, self.policy.audit_detail),
                },
            )
            return {
                "server_id": server_id,
                "provider_id": default_model.provider_id,
                "model": model,
                "max_tokens": token_limit,
                "result": result,
            }
        except McpRuntimeError:
            raise
        except Exception as exc:
            self.audit_writer.append_event(
                event_type="sampling.failed",
                server_id=server_id,
                session_id=session_id,
                status="failed",
                summary="MCP sampling failed",
                detail={"error_type": type(exc).__name__, "message": str(exc)},
            )
            raise

    async def _maybe_approve(
        self,
        *,
        server_id: str,
        session_id: str | None,
        model: str,
        max_tokens: int,
        approval_decider: McpSamplingApprovalDecider | None = None,
        approval_context: dict[str, Any] | None = None,
    ) -> None:
        if self.policy.approval_mode == "auto":
            return
        if self.policy.approval_mode != "prompt":
            self._deny(server_id, session_id, "sampling_approval_mode_invalid")
        decider = approval_decider or self.approval_decider
        if decider is None:
            self._deny(server_id, session_id, "sampling_approval_required")
        decision = decider(
            {
                "server_id": server_id,
                "session_id": session_id,
                "model": model,
                "max_tokens": max_tokens,
                "approval_mode": self.policy.approval_mode,
                "audit_detail": self.policy.audit_detail,
                **(approval_context or {}),
            }
        )
        approved = await decision if hasattr(decision, "__await__") else bool(decision)
        if not approved:
            self._deny(server_id, session_id, "sampling_approval_rejected")

    def _deny(
        self,
        server_id: str,
        session_id: str | None,
        reason: str,
        **detail: Any,
    ) -> None:
        payload = {"reason": reason, **detail}
        self.audit_writer.append_event(
            event_type="sampling.denied",
            server_id=server_id,
            session_id=session_id,
            status="denied",
            summary=f"MCP sampling denied: {reason}",
            detail=payload,
        )
        raise McpRuntimeError(McpErrorCode.POLICY_DENIED, detail=payload)


def _audit_result(result: dict[str, Any], audit_detail: str) -> dict[str, Any]:
    if audit_detail == "none":
        return {}
    if audit_detail == "full":
        return redact_sensitive_data(result)
    return {
        "keys": sorted(result),
        "usage": dict(result.get("usage", {})) if isinstance(result.get("usage"), dict) else None,
    }


def _api_base_url(base_url: str) -> str:
    url = base_url.strip().rstrip("/")
    suffix = "/chat/completions"
    if url.endswith(suffix):
        url = url[: -len(suffix)].rstrip("/")
    if not url.endswith("/v1"):
        url = f"{url}/v1"
    return url


def _first_choice_message(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RuntimeError("sampling model provider returned non-object response")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("sampling model provider returned no choices")
    first = choices[0]
    message = first.get("message") if isinstance(first, dict) else None
    if not isinstance(message, dict):
        raise RuntimeError("sampling model provider returned no message")
    return dict(message)
