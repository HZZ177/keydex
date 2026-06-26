from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from backend.app.core.config import AppSettings, get_settings

router = APIRouter(prefix="/api", tags=["health"])


class HealthResponse(BaseModel):
    status: str
    version: str
    protocol_version: str
    agent_status: str = "unknown"
    agent_error: str | None = None
    agent_warmup_duration_ms: int | None = None


@router.get("/health", response_model=HealthResponse)
async def get_health(request: Request) -> HealthResponse:
    settings: AppSettings = getattr(request.app.state, "settings", None) or get_settings()
    agent_status = _agent_status(request.app.state)
    return HealthResponse(
        status="ok",
        version=settings.version,
        protocol_version=settings.protocol_version,
        agent_status=str(agent_status.get("status") or "unknown"),
        agent_error=agent_status.get("error"),
        agent_warmup_duration_ms=agent_status.get("duration_ms"),
    )


def _agent_status(app_state: Any) -> dict[str, Any]:
    provider = getattr(app_state, "agent_runtime_provider", None)
    if provider is None:
        return {"status": "unknown", "error": None, "duration_ms": None}
    status_payload = getattr(provider, "status_payload", None)
    if callable(status_payload):
        return status_payload()
    return {
        "status": getattr(provider, "status", "unknown"),
        "error": getattr(provider, "error", None),
        "duration_ms": getattr(provider, "duration_ms", None),
    }
