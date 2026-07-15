from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from backend.app.core.logger import logger


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(HTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)


async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    detail = _normalize_detail(exc.detail)
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
    return JSONResponse(status_code=exc.status_code, content={"detail": detail})


async def validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    errors = _safe_validation_errors(exc.errors())
    logger.warning(
        "[ExceptionHandler] 请求校验失败 | "
        f"method={request.method} | path={request.url.path} | errors={len(errors)}"
    )
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={
            "code": "request_validation_failed",
            "message": "请求参数校验失败",
            "details": {"errors": errors},
        },
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.opt(exception=True).error(
        "[ExceptionHandler] 未处理异常 | "
        f"method={request.method} | path={request.url.path} | error={exc}"
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={
            "code": "internal_server_error",
            "message": "服务内部错误",
            "details": {},
        },
    )


def _normalize_detail(detail: Any) -> dict[str, Any]:
    if isinstance(detail, dict):
        return detail
    return {"code": "http_error", "message": str(detail), "details": {}}


def _safe_validation_errors(errors: list[dict[str, Any]]) -> list[dict[str, Any]]:
    safe_errors: list[dict[str, Any]] = []
    for error in errors:
        safe = {key: value for key, value in error.items() if key not in {"input", "url"}}
        context = safe.get("ctx")
        if isinstance(context, dict):
            safe["ctx"] = {key: str(value) for key, value in context.items()}
        safe_errors.append(safe)
    return safe_errors
