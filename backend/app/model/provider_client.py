import json
from typing import Any

import httpx

from backend.app.model.base import ModelInfo, ModelSettings


class ModelConfigError(ValueError):
    pass


class ModelProviderError(RuntimeError):
    pass


def parse_model_list(payload: Any) -> list[ModelInfo]:
    if isinstance(payload, dict):
        raw_items = payload.get("data") or payload.get("models") or []
    elif isinstance(payload, list):
        raw_items = payload
    else:
        raw_items = []
    models: list[ModelInfo] = []
    for item in raw_items:
        if isinstance(item, str):
            models.append(ModelInfo(id=item, raw={"id": item}))
        elif isinstance(item, dict) and item.get("id"):
            models.append(
                ModelInfo(
                    id=str(item["id"]),
                    owned_by=item.get("owned_by"),
                    raw=item,
                )
            )
    return models


class OpenAICompatibleProviderClient:
    """Provider-management client for OpenAI-compatible model services."""

    def __init__(
        self,
        settings: ModelSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self._transport = transport
        self._model_cache: list[ModelInfo] | None = None

    async def list_models(self, *, force_refresh: bool = False) -> list[ModelInfo]:
        if self._model_cache is not None and not force_refresh:
            return self._model_cache
        if not self.settings.base_url:
            raise ModelConfigError("模型服务地址未配置")

        async with self._client() as client:
            try:
                response = await client.get(f"{self._api_base_url()}/models")
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise ModelProviderError(
                    self._format_http_error("刷新模型列表失败", exc.response)
                ) from exc
            except httpx.HTTPError as exc:
                raise ModelProviderError(f"刷新模型列表失败：{exc}") from exc
            try:
                payload = response.json()
            except ValueError as exc:
                raise ModelProviderError("刷新模型列表失败：模型服务返回的不是合法 JSON") from exc
            models = parse_model_list(payload)
            if not models:
                raise ModelProviderError("刷新模型列表失败：模型服务未返回可用模型")
        self._model_cache = models
        return models

    async def check_chat_completion(self, *, model: str) -> None:
        if not self.settings.base_url:
            raise ModelProviderError("模型服务地址未配置")
        request_model = (model or self.settings.model).strip()
        if not request_model:
            raise ModelProviderError("模型未配置")

        async with self._client(timeout=15) as client:
            try:
                response = await client.post(
                    f"{self._api_base_url()}/chat/completions",
                    json={
                        "model": request_model,
                        "messages": [{"role": "user", "content": "ping"}],
                        "stream": False,
                        "max_tokens": 1,
                    },
                )
                response.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise ModelProviderError(
                    self._format_http_error("模型健康检查失败", exc.response)
                ) from exc
            except httpx.HTTPError as exc:
                raise ModelProviderError(f"模型健康检查失败：{exc}") from exc

    def _client(self, *, timeout: float | None = None) -> httpx.AsyncClient:
        headers = {}
        if self.settings.api_key:
            headers["Authorization"] = f"Bearer {self.settings.api_key}"
        return httpx.AsyncClient(
            timeout=timeout if timeout is not None else self.settings.timeout_seconds,
            headers=headers,
            transport=self._transport,
        )

    def _api_base_url(self) -> str:
        url = self.settings.base_url.strip().rstrip("/")
        completions_suffix = "/chat/completions"
        if url.endswith(completions_suffix):
            url = url[: -len(completions_suffix)].rstrip("/")
        if not url.endswith("/v1"):
            url = f"{url}/v1"
        return url

    @staticmethod
    def format_http_error(
        prefix: str,
        response: httpx.Response,
        body: bytes | str | None = None,
    ) -> str:
        return OpenAICompatibleProviderClient._format_http_error(prefix, response, body)

    @staticmethod
    def _format_http_error(
        prefix: str,
        response: httpx.Response,
        body: bytes | str | None = None,
    ) -> str:
        if body is None:
            try:
                text = response.text
            except httpx.ResponseNotRead:
                text = ""
        elif isinstance(body, bytes):
            text = body.decode(response.encoding or "utf-8", errors="replace")
        else:
            text = body

        body_text = OpenAICompatibleProviderClient._extract_error_text(text.strip())
        if len(body_text) > 500:
            body_text = f"{body_text[:500]}...[已截断]"
        suffix = f"：{body_text}" if body_text else ""
        return f"{prefix}：HTTP {response.status_code}{suffix}"

    @staticmethod
    def _extract_error_text(body: str) -> str:
        if not body:
            return ""
        try:
            payload = json.loads(body)
        except ValueError:
            return body
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict):
                message = error.get("message")
                if message:
                    return str(message)
            detail = payload.get("detail")
            if detail:
                return str(detail)
            message = payload.get("message")
            if message:
                return str(message)
        return body
