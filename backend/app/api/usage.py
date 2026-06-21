from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from backend.app.api.dependencies import get_repositories
from backend.app.services import (
    UsageRequestNotFoundError,
    UsageRequestQuery,
    UsageService,
    UsageValidationError,
)
from backend.app.storage import StorageRepositories

router = APIRouter(prefix="/api/usage", tags=["usage"])
RepositoriesDep = Depends(get_repositories)


class UsageSummaryResponse(BaseModel):
    request_count: int
    total_tokens: int
    input_tokens: int
    cache_read_tokens: int
    output_tokens: int
    success_count: int
    failed_count: int
    avg_duration_ms: int


class UsageTrendPoint(BaseModel):
    time: str
    request_count: int
    input_tokens: int
    cache_read_tokens: int
    output_tokens: int
    total_tokens: int
    failed_count: int


class UsageTrendResponse(BaseModel):
    points: list[UsageTrendPoint]


class UsageRequestListResponse(BaseModel):
    list: list[dict[str, Any]]
    total: int
    page: int
    page_size: int


class UsageRequestDetailResponse(BaseModel):
    request: dict[str, Any]
    trace: dict[str, Any] | None
    events: list[dict[str, Any]]


@router.get("/summary", response_model=UsageSummaryResponse)
def get_usage_summary(
    start_time: str | None = None,
    end_time: str | None = None,
    model: str | None = None,
    repositories: StorageRepositories = RepositoriesDep,
) -> UsageSummaryResponse:
    return UsageSummaryResponse(
        **_service(repositories).get_summary(
            start_time=start_time,
            end_time=end_time,
            model=model,
        )
    )


@router.get("/trend", response_model=UsageTrendResponse)
def get_usage_trend(
    start_time: str | None = None,
    end_time: str | None = None,
    bucket: Literal["hour", "day"] = "day",
    timezone_offset_minutes: int = 0,
    model: str | None = None,
    repositories: StorageRepositories = RepositoriesDep,
) -> UsageTrendResponse:
    try:
        points = _service(repositories).get_trend(
            start_time=start_time,
            end_time=end_time,
            model=model,
            bucket=bucket,
            timezone_offset_minutes=timezone_offset_minutes,
        )
    except UsageValidationError as exc:
        raise _bad_request("invalid_usage_query", str(exc)) from exc
    return UsageTrendResponse(points=points)


@router.get("/requests", response_model=UsageRequestListResponse)
def list_usage_requests(
    start_time: str | None = None,
    end_time: str | None = None,
    model: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=200),
    repositories: StorageRepositories = RepositoriesDep,
) -> UsageRequestListResponse:
    try:
        result = _service(repositories).list_requests(
            UsageRequestQuery(
                start_time=start_time,
                end_time=end_time,
                model=model,
                status=status_filter,
                page=page,
                page_size=page_size,
            )
        )
    except UsageValidationError as exc:
        raise _bad_request("invalid_usage_query", str(exc)) from exc
    return UsageRequestListResponse(**result)


@router.get("/requests/{request_id}", response_model=UsageRequestDetailResponse)
def get_usage_request_detail(
    request_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> UsageRequestDetailResponse:
    try:
        detail = _service(repositories).get_request_detail(request_id)
    except UsageRequestNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "usage_request_not_found", "message": str(exc), "details": {}},
        ) from exc
    return UsageRequestDetailResponse(**detail)


def _service(repositories: StorageRepositories) -> UsageService:
    return UsageService(repositories)


def _bad_request(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": code, "message": message, "details": {}},
    )
