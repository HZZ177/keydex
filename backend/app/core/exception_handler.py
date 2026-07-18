from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from backend.app.core.errors import (
    error_envelope,
    normalize_error_envelope,
    sanitize_public_details,
)
from backend.app.core.logger import logger


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)


async def http_exception_handler(
    request: Request,
    exc: StarletteHTTPException,
) -> JSONResponse:
    detail = _normalize_detail(exc.detail, status_code=exc.status_code)
    if exc.status_code >= status.HTTP_500_INTERNAL_SERVER_ERROR:
        logger.opt(exception=True).error(
            "[ExceptionHandler] HTTP 异常 | "
            f"method={request.method} | path={request.url.path} | "
            f"status_code={exc.status_code} | detail={detail}"
        )
    else:
        logger.warning(
            "[ExceptionHandler] HTTP 异常 | "
            f"method={request.method} | path={request.url.path} | "
            f"status_code={exc.status_code} | detail={detail}"
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": detail},
        headers=exc.headers,
    )


async def validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    errors = _safe_validation_errors(exc.errors())
    logger.warning(
        "[ExceptionHandler] 请求校验失败 | "
        f"method={request.method} | path={request.url.path} | errors={len(errors)}"
    )
    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    envelope = error_envelope(
        "request_validation_failed",
        "请求参数校验失败",
        details={"errors": errors},
        status=status_code,
    )
    return JSONResponse(
        status_code=status_code,
        content={"detail": envelope.to_public_dict()},
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.opt(exception=True).error(
        "[ExceptionHandler] 未处理异常 | "
        f"method={request.method} | path={request.url.path} | error={exc}"
    )
    status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
    envelope = error_envelope(
        "internal_server_error",
        "服务内部错误",
        details=_request_correlation_details(request),
        status=status_code,
    )
    return JSONResponse(
        status_code=status_code,
        content={"detail": envelope.to_public_dict()},
    )


def _normalize_detail(detail: Any, *, status_code: int) -> dict[str, Any]:
    if isinstance(detail, dict) and not any(
        key in detail for key in ("code", "message", "details", "detail", "error")
    ):
        return error_envelope(
            "http_error",
            "HTTP 请求失败",
            details=sanitize_public_details(detail),
            status=status_code,
        ).to_public_dict()
    return normalize_error_envelope(
        detail,
        fallback_code="http_error",
        fallback_message=str(detail) if isinstance(detail, str) else "HTTP 请求失败",
        status=status_code,
    ).to_public_dict()


def _request_correlation_details(request: Request) -> dict[str, Any]:
    details: dict[str, Any] = {}
    request_id = request.headers.get("x-request-id")
    if request_id:
        details["request_id"] = request_id
    trace_id = getattr(request.state, "trace_id", None)
    if isinstance(trace_id, str) and trace_id:
        details["trace_id"] = trace_id
    return sanitize_public_details(details)


def _safe_validation_errors(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    safe_errors: list[dict[str, Any]] = []
    for error in errors:
        safe = {key: value for key, value in error.items() if key not in {"input", "url"}}
        context = safe.get("ctx")
        if isinstance(context, dict):
            safe["ctx"] = {key: str(value) for key, value in context.items()}
        safe_errors.append(safe)
    return safe_errors
