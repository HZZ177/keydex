from fastapi import APIRouter
from pydantic import BaseModel

from backend.app.core.config import AppSettings, get_settings

router = APIRouter(prefix="/api", tags=["health"])


class HealthResponse(BaseModel):
    status: str
    version: str
    protocol_version: str


@router.get("/health", response_model=HealthResponse)
async def get_health() -> HealthResponse:
    settings: AppSettings = get_settings()
    return HealthResponse(
        status="ok",
        version=settings.version,
        protocol_version=settings.protocol_version,
    )

