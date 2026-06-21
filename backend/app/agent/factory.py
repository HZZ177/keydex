from __future__ import annotations

import threading
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI

from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.request_context import get_trace_id
from backend.app.model import ModelSettings

_llm_gateway_trace_registry: dict[str, str] = {}


def register_llm_gateway_trace_id(run_id: str, gateway_trace_id: str) -> None:
    if run_id and gateway_trace_id:
        _llm_gateway_trace_registry[run_id] = gateway_trace_id


def get_llm_gateway_trace_id(run_id: str) -> str | None:
    if not run_id:
        return None
    return _llm_gateway_trace_registry.get(run_id)


def ensure_llm_gateway_trace_id(run_id: str) -> str | None:
    if not run_id:
        return None
    gateway_trace_id = _llm_gateway_trace_registry.get(run_id)
    if gateway_trace_id:
        return gateway_trace_id
    gateway_trace_id = new_id()
    _llm_gateway_trace_registry[run_id] = gateway_trace_id
    return gateway_trace_id


def pop_llm_gateway_trace_id(run_id: str) -> str | None:
    if not run_id:
        return None
    return _llm_gateway_trace_registry.pop(run_id, None)


class PatchedChatOpenAI(ChatOpenAI):
    """ChatOpenAI with gateway trace headers and streaming usage de-duplication."""

    @staticmethod
    def _get_gateway_trace_id_from_kwargs(kwargs: dict[str, Any]) -> str | None:
        extra_headers = kwargs.get("extra_headers")
        if not isinstance(extra_headers, dict):
            return None
        value = extra_headers.get("AH-Trace-Id")
        return str(value) if value else None

    @classmethod
    def _resolve_gateway_trace_id(cls, run_id: str, kwargs: dict[str, Any]) -> str:
        gateway_trace_id = (
            cls._get_gateway_trace_id_from_kwargs(kwargs)
            or ensure_llm_gateway_trace_id(run_id)
            or new_id()
        )
        if run_id and not get_llm_gateway_trace_id(run_id):
            register_llm_gateway_trace_id(run_id, gateway_trace_id)
        return gateway_trace_id

    @staticmethod
    def _inject_gateway_headers(kwargs: dict[str, Any], gateway_trace_id: str) -> dict[str, Any]:
        gateway_thread_id = get_trace_id()
        extra_headers = dict(kwargs.get("extra_headers") or {})
        if gateway_thread_id:
            extra_headers["AH-Thread-Id"] = gateway_thread_id
        extra_headers["AH-Trace-Id"] = gateway_trace_id
        kwargs["extra_headers"] = extra_headers
        logger.debug(
            f"[LLM] 注入网关追踪头 | AH-Thread-Id={gateway_thread_id or '-'} | "
            f"AH-Trace-Id={gateway_trace_id}"
        )
        return kwargs

    async def _agenerate_with_cache(
        self,
        messages: list[Any],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> Any:
        run_id = str(getattr(run_manager, "run_id", "") or "")
        resolved_kwargs = dict(kwargs)
        gateway_trace_id = self._resolve_gateway_trace_id(run_id, resolved_kwargs)
        kwargs = self._inject_gateway_headers(resolved_kwargs, gateway_trace_id)
        try:
            return await super()._agenerate_with_cache(
                messages,
                stop=stop,
                run_manager=run_manager,
                **kwargs,
            )
        except Exception:
            logger.opt(exception=True).error(
                f"[LLM] agenerate_with_cache 失败 | run_id={run_id} | "
                f"gateway_trace_id={gateway_trace_id}"
            )
            pop_llm_gateway_trace_id(run_id)
            raise

    async def _agenerate(
        self,
        messages: list[Any],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> Any:
        run_id = str(getattr(run_manager, "run_id", "") or "")
        resolved_kwargs = dict(kwargs)
        gateway_trace_id = self._resolve_gateway_trace_id(run_id, resolved_kwargs)
        kwargs = self._inject_gateway_headers(resolved_kwargs, gateway_trace_id)
        try:
            return await super()._agenerate(messages, stop=stop, run_manager=run_manager, **kwargs)
        except Exception:
            logger.opt(exception=True).error(
                f"[LLM] agenerate 失败 | run_id={run_id} | gateway_trace_id={gateway_trace_id}"
            )
            pop_llm_gateway_trace_id(run_id)
            raise

    async def _astream(
        self,
        messages: list[Any],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> AsyncIterator[Any]:
        run_id = str(getattr(run_manager, "run_id", "") or "")
        resolved_kwargs = dict(kwargs)
        gateway_trace_id = self._resolve_gateway_trace_id(run_id, resolved_kwargs)
        kwargs = self._inject_gateway_headers(resolved_kwargs, gateway_trace_id)

        seen_input_tokens: int | None = None
        seen_output_tokens: int | None = None
        seen_total_tokens: int | None = None
        seen_cache_read_tokens: int | None = None
        try:
            async for chunk in super()._astream(
                messages,
                stop=stop,
                run_manager=run_manager,
                **kwargs,
            ):
                chunk_msg = getattr(chunk, "message", None)
                usage = getattr(chunk_msg, "usage_metadata", None) if chunk_msg else None
                if usage:
                    seen_input_tokens = _zero_repeated_usage_field(
                        usage,
                        "input_tokens",
                        seen_input_tokens,
                    )
                    seen_output_tokens = _zero_repeated_usage_field(
                        usage,
                        "output_tokens",
                        seen_output_tokens,
                    )
                    seen_total_tokens = _zero_repeated_usage_field(
                        usage,
                        "total_tokens",
                        seen_total_tokens,
                    )
                    seen_cache_read_tokens = _zero_repeated_cache_read(
                        usage,
                        seen_cache_read_tokens,
                    )
                yield chunk
        except Exception:
            logger.opt(exception=True).error(
                f"[LLM] astream 失败 | run_id={run_id} | gateway_trace_id={gateway_trace_id}"
            )
            pop_llm_gateway_trace_id(run_id)
            raise


def _usage_get(usage: Any, key: str) -> int:
    if isinstance(usage, dict):
        return int(usage.get(key, 0) or 0)
    return int(getattr(usage, key, 0) or 0)


def _usage_set(usage: Any, key: str, value: int) -> None:
    if isinstance(usage, dict):
        usage[key] = value
    else:
        object.__setattr__(usage, key, value)


def _zero_repeated_usage_field(usage: Any, key: str, seen: int | None) -> int | None:
    raw = _usage_get(usage, key)
    if not raw:
        return seen
    if seen is None:
        return raw
    _usage_set(usage, key, 0)
    return seen


def _zero_repeated_cache_read(usage: Any, seen: int | None) -> int | None:
    details = usage.get("input_token_details") if isinstance(usage, dict) else getattr(
        usage,
        "input_token_details",
        None,
    )
    if not details:
        return seen
    raw_value = (
        details.get("cache_read", 0)
        if isinstance(details, dict)
        else getattr(details, "cache_read", 0)
    )
    raw = int(raw_value or 0)
    if not raw:
        return seen
    if seen is None:
        return raw
    if isinstance(details, dict):
        details["cache_read"] = 0
    else:
        object.__setattr__(details, "cache_read", 0)
    return seen


class AgentFactory:
    def __init__(self) -> None:
        self._llm_cache: dict[str, BaseChatModel] = {}
        self._llm_cache_locks: dict[str, threading.Lock] = {}
        self._llm_cache_locks_guard = threading.Lock()

    def _get_llm_cache_lock(self, cache_key: str) -> threading.Lock:
        with self._llm_cache_locks_guard:
            lock = self._llm_cache_locks.get(cache_key)
            if lock is None:
                lock = threading.Lock()
                self._llm_cache_locks[cache_key] = lock
            return lock

    def get_or_create_llm(
        self,
        settings: ModelSettings,
        *,
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        streaming: bool = True,
        http_transport: httpx.BaseTransport | httpx.AsyncBaseTransport | None = None,
    ) -> BaseChatModel:
        if not settings.base_url:
            raise ValueError("模型服务地址未配置")
        request_model = (model or settings.model or "").strip()
        if not request_model:
            raise ValueError("模型未配置")
        url = _normalize_base_url(settings.base_url)
        api_key = settings.api_key or ""
        timeout = settings.timeout_seconds
        cache_key = (
            f"{api_key}:{url}:{request_model}:"
            f"{temperature}:{max_tokens}:{timeout}:{streaming}:"
            f"{id(http_transport) if http_transport else ''}"
        )
        cached = self._llm_cache.get(cache_key)
        if cached is not None:
            logger.debug(f"[LLM] 复用缓存实例 | model={request_model} | base_url={url}")
            return cached

        lock = self._get_llm_cache_lock(cache_key)
        with lock:
            cached = self._llm_cache.get(cache_key)
            if cached is not None:
                logger.debug(f"[LLM] 复用缓存实例 | model={request_model} | base_url={url}")
                return cached
            client_kwargs: dict[str, Any] = {}
            if http_transport is not None:
                client_kwargs["http_client"] = httpx.Client(
                    transport=http_transport,
                    timeout=timeout,
                )
                client_kwargs["http_async_client"] = httpx.AsyncClient(
                    transport=http_transport,
                    timeout=timeout,
                )
            llm = PatchedChatOpenAI(
                model=request_model,
                api_key=api_key,
                base_url=url,
                temperature=temperature,
                max_completion_tokens=max_tokens,
                timeout=timeout,
                streaming=streaming,
                stream_usage=True,
                use_responses_api=False,
                http_socket_options=(),
                **client_kwargs,
            )
            self._llm_cache[cache_key] = llm
            logger.info(
                f"[LLM] 创建模型实例 | model={request_model} | base_url={url} | "
                f"streaming={streaming} | timeout={timeout}"
            )
            return llm

    @staticmethod
    def create_agent(
        *,
        model: BaseChatModel,
        tools: list[Any],
        system_prompt: str | SystemMessage,
        checkpointer: Any,
        middleware: tuple[Any, ...] = (),
        name: str = "desktop_agent",
    ) -> Any:
        return create_agent(
            model=model,
            tools=tools,
            system_prompt=system_prompt,
            middleware=middleware,
            checkpointer=checkpointer,
            name=name,
        )


def _normalize_base_url(base_url: str) -> str:
    url = base_url.strip().rstrip("/")
    suffix = "/chat/completions"
    if url.endswith(suffix):
        url = url[: -len(suffix)].rstrip("/")
    if not url.endswith("/v1"):
        url = f"{url}/v1"
    return url


def load_system_prompt(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


agent_factory = AgentFactory()
