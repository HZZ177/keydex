from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import httpx

TAVILY_BASE_URL = "https://api.tavily.com"
TAVILY_DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=5.0)


class TavilyHttpStatusError(RuntimeError):
    def __init__(
        self,
        status_code: int,
        *,
        retry_after: str | None = None,
        request_id: str | None = None,
    ) -> None:
        self.status_code = status_code
        self.retry_after = retry_after
        self.request_id = request_id
        super().__init__(f"Tavily HTTP 请求失败: status={status_code}")


class TavilyResponseError(RuntimeError):
    pass


class TavilyHttpClient:
    def __init__(
        self,
        api_key: str,
        *,
        client: httpx.AsyncClient | None = None,
        base_url: str = TAVILY_BASE_URL,
        timeout: httpx.Timeout | float = TAVILY_DEFAULT_TIMEOUT,
    ) -> None:
        normalized_key = api_key.strip()
        if not normalized_key:
            raise ValueError("Tavily API Key 不能为空")
        self._api_key = normalized_key
        self._client = client
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout

    async def request_json(
        self,
        method: str,
        path: str,
        *,
        payload: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if self._client is not None:
            return await self._request(self._client, method, path, payload=payload)
        async with httpx.AsyncClient(
            base_url=self._base_url,
            timeout=self._timeout,
        ) as client:
            return await self._request(client, method, path, payload=payload)

    async def _request(
        self,
        client: httpx.AsyncClient,
        method: str,
        path: str,
        *,
        payload: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        request_path = path if client.base_url.is_absolute_url else self._absolute_url(path)
        response = await client.request(
            method.upper(),
            request_path,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Accept": "application/json",
            },
            json=dict(payload) if payload is not None else None,
            timeout=self._timeout,
        )
        if not response.is_success:
            raise TavilyHttpStatusError(
                response.status_code,
                retry_after=response.headers.get("Retry-After"),
                request_id=response.headers.get("X-Request-ID"),
            )
        try:
            data = response.json()
        except ValueError as exc:
            raise TavilyResponseError("Tavily 返回了非 JSON 响应") from exc
        if not isinstance(data, dict):
            raise TavilyResponseError("Tavily 返回的 JSON 顶层不是对象")
        return data

    def _absolute_url(self, path: str) -> str:
        return f"{self._base_url}/{path.lstrip('/')}"
