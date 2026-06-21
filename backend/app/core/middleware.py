from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Any

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware

from backend.app.core.ids import new_id
from backend.app.core.logger import logger, redact_sensitive
from backend.app.core.request_context import trace_id_var

MAX_BODY_LOG_CHARS = 2_000


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: Any, filtered_urls: list[str] | None = None) -> None:
        super().__init__(app)
        self.filtered_urls = filtered_urls or [
            "/api/health",
            "/docs",
            "/openapi.json",
            "/redoc",
        ]

    def _should_skip_logging(self, url: str, headers: dict[str, str] | None = None) -> bool:
        if headers and headers.get("x-silent-request") == "true":
            return True
        return any(filtered_url in url for filtered_url in self.filtered_urls)

    async def dispatch(self, request: Request, call_next: Callable[[Request], Any]) -> Response:
        trace_id = request.headers.get("x-trace-id") or new_id()
        token = trace_id_var.set(trace_id)
        start_time = time.perf_counter()
        method = request.method
        url = str(request.url)
        path = request.url.path
        client_ip = request.client.host if request.client else "unknown"
        query_params = dict(request.query_params)
        body = await self._read_body(request) if method in {"POST", "PUT", "PATCH"} else None
        skip_logging = self._should_skip_logging(url, dict(request.headers))

        if not skip_logging:
            logger.info(
                "[HTTP] 请求开始 | "
                f"method={method} | path={path} | client_ip={client_ip} | trace_id={trace_id}"
            )
            if query_params:
                logger.info(
                    "[HTTP] 请求查询参数 | "
                    f"method={method} | path={path} | "
                    f"query={json.dumps(redact_sensitive(query_params), ensure_ascii=False)}"
                )
            if body is not None:
                logger.info(
                    "[HTTP] 请求体摘要 | "
                    f"method={method} | path={path} | body={self._format_body_for_log(body)}"
                )

        try:
            response = await call_next(request)
            response.headers["X-Trace-Id"] = trace_id
            duration_ms = int((time.perf_counter() - start_time) * 1000)
            if not skip_logging:
                logger.info(
                    "[HTTP] 请求完成 | "
                    f"method={method} | path={path} | status_code={response.status_code} | "
                    f"duration_ms={duration_ms} | trace_id={trace_id}"
                )
            return response
        except Exception as exc:
            duration_ms = int((time.perf_counter() - start_time) * 1000)
            logger.opt(exception=True).error(
                "[HTTP] 请求异常 | "
                f"method={method} | path={path} | duration_ms={duration_ms} | "
                f"trace_id={trace_id} | error={exc}"
            )
            raise
        finally:
            trace_id_var.reset(token)

    async def _read_body(self, request: Request) -> Any:
        try:
            body_bytes = await request.body()
        except Exception as exc:
            logger.warning(f"[HTTP] 读取请求体失败 | error={exc}")
            return None
        if not body_bytes:
            return None
        await self._reset_body(request, body_bytes)
        try:
            return json.loads(body_bytes.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return body_bytes.decode("utf-8", errors="ignore")

    async def _reset_body(self, request: Request, body_bytes: bytes) -> None:
        async def receive() -> dict[str, Any]:
            return {"type": "http.request", "body": body_bytes}

        request._receive = receive

    def _format_body_for_log(self, body: Any) -> str:
        safe_body = redact_sensitive(body)
        if isinstance(safe_body, dict | list):
            text = json.dumps(safe_body, ensure_ascii=False)
        else:
            text = str(safe_body)
        if len(text) <= MAX_BODY_LOG_CHARS:
            return text
        return f"{text[:MAX_BODY_LOG_CHARS]}...<truncated chars={len(text)}>"
