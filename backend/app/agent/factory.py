from __future__ import annotations

import asyncio
import json
import threading
import time
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass
from typing import Any

import httpx
import openai
from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import PrivateAttr

from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.request_context import (
    get_active_session_id,
    get_event_dispatcher,
    get_session_id,
    get_trace_id,
    get_turn_index,
    get_user_id,
    get_user_message,
)
from backend.app.events import DomainEventType
from backend.app.model import ModelSettings, is_stream_chunk_timeout_error

_llm_gateway_trace_registry: dict[str, str] = {}
_REASONING_PAYLOAD_KEYS = (
    "reasoning_content",
    "reasoning",
    "reasoning_text",
    "reasoning_details",
)
_REASONING_TEXT_KEYS = ("reasoning_content", "reasoning", "reasoning_text")
_KEYDEX_REASONING_KEYS = "__keydex_reasoning_keys__"
_KEYDEX_REASONING_TEXT = "__keydex_reasoning_text__"
_TOOL_CALL_PREVIEW_ARGS_LIMIT = 800
_TOOL_CALL_PREVIEW_MAX_CALLS = 5
_LLM_BUSINESS_MAX_RETRIES = 3
_LLM_RETRY_DELAYS_SECONDS = (0.8, 1.6, 3.2)
_LLM_TERMINAL_TAIL_GRACE_SECONDS = 1.0


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


@dataclass(slots=True)
class _LLMRequestLogContext:
    request_id: str
    run_id: str
    started_at: float
    call_kind: str
    gateway_thread_id: str | None
    gateway_trace_id: str | None


class PatchedChatOpenAI(ChatOpenAI):
    """ChatOpenAI with gateway trace headers and streaming usage de-duplication."""

    _llm_request_logs: Any = PrivateAttr(default=None)
    _llm_provider_id: str | None = PrivateAttr(default=None)
    _llm_provider_name: str | None = PrivateAttr(default=None)

    def __init__(
        self,
        *args: Any,
        llm_request_logs: Any = None,
        provider_id: str | None = None,
        provider_name: str | None = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(*args, **kwargs)
        self._llm_request_logs = llm_request_logs
        self._llm_provider_id = provider_id
        self._llm_provider_name = provider_name

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

    def _convert_chunk_to_generation_chunk(
        self,
        chunk: dict,
        default_chunk_class: type,
        base_generation_info: dict | None,
    ) -> Any:
        generation_chunk = super()._convert_chunk_to_generation_chunk(
            chunk,
            default_chunk_class,
            base_generation_info,
        )
        _preserve_reasoning_delta(generation_chunk, chunk)
        return generation_chunk

    def _create_chat_result(
        self,
        response: dict | Any,
        generation_info: dict | None = None,
    ) -> Any:
        chat_result = super()._create_chat_result(response, generation_info)
        response_dict = _response_to_mapping(response)
        if response_dict:
            _preserve_reasoning_chat_result(chat_result, response_dict)
        return chat_result

    def _get_request_payload(
        self,
        input_: Any,
        *,
        stop: list[str] | None = None,
        **kwargs: Any,
    ) -> dict:
        source_messages = self._convert_input(input_).to_messages()
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        _restore_reasoning_request_payload(payload, source_messages)
        return payload

    def _start_request_log(
        self,
        *,
        run_id: str,
        gateway_trace_id: str,
        messages: list[Any],
        call_kind: str,
        attempt: int = 1,
        max_retries: int = 0,
    ) -> _LLMRequestLogContext | None:
        if self._llm_request_logs is None:
            return None
        trace_id = get_trace_id()
        session_id = get_session_id()
        if not trace_id or not session_id:
            return None
        gateway_thread_id = trace_id or None
        base_request_id = run_id or gateway_trace_id or new_id()
        request_id = base_request_id if attempt <= 1 else f"{base_request_id}:attempt-{attempt}"
        context = _LLMRequestLogContext(
            request_id=request_id,
            run_id=run_id,
            started_at=time.perf_counter(),
            call_kind=call_kind,
            gateway_thread_id=gateway_thread_id,
            gateway_trace_id=gateway_trace_id,
        )
        try:
            self._llm_request_logs.start(
                request_id=request_id,
                trace_id=trace_id,
                trace_record_id=trace_id,
                session_id=session_id,
                active_session_id=get_active_session_id() or session_id,
                gateway_thread_id=gateway_thread_id,
                gateway_trace_id=gateway_trace_id,
                turn_index=get_turn_index(),
                provider_id=self._llm_provider_id,
                provider_name=self._llm_provider_name or self.__class__.__name__,
                model=_model_name(self),
                request_preview=_request_preview(messages),
                metadata={
                    "run_id": run_id,
                    "call_kind": call_kind,
                    "logging_source": "patched_chat_openai",
                    "user_id": get_user_id() or None,
                    "attempt": attempt,
                    "max_retries": max_retries,
                },
            )
        except Exception as exc:
            logger.debug(f"[LLMRequestLog] 请求日志开始失败 | run_id={run_id} | 错误={exc}")
            return None
        return context

    def _finish_request_log(
        self,
        context: _LLMRequestLogContext | None,
        *,
        response: Any,
        response_preview: str | None = None,
        usage: dict[str, int] | None = None,
        time_to_first_token: int | None = None,
    ) -> None:
        if self._llm_request_logs is None or context is None:
            return
        resolved_usage = usage or _extract_token_usage(response)
        duration_ms = _duration_ms(context.started_at)
        resolved_time_to_first_token = time_to_first_token
        if resolved_time_to_first_token is None and context.call_kind in {"agenerate", "generate"}:
            resolved_time_to_first_token = duration_ms
        try:
            self._llm_request_logs.finish(
                context.request_id,
                input_tokens=resolved_usage["input_tokens"],
                cache_read_tokens=resolved_usage["cache_read_tokens"],
                output_tokens=resolved_usage["output_tokens"],
                total_tokens=resolved_usage["total_tokens"] or None,
                response_preview=response_preview
                if response_preview is not None
                else _response_preview(response),
                duration_ms=duration_ms,
                time_to_first_token=resolved_time_to_first_token,
                gateway_thread_id=context.gateway_thread_id,
                gateway_trace_id=context.gateway_trace_id,
            )
        except Exception as exc:
            logger.debug(
                f"[LLMRequestLog] 请求日志完成失败 | request_id={context.request_id} | 错误={exc}"
            )

    def _fail_request_log(
        self,
        context: _LLMRequestLogContext | None,
        *,
        error: BaseException,
        response_preview: str | None = None,
        time_to_first_token: int | None = None,
    ) -> None:
        if self._llm_request_logs is None or context is None:
            return
        try:
            self._llm_request_logs.fail(
                context.request_id,
                error_message=str(error) or type(error).__name__,
                response_preview=response_preview,
                duration_ms=_duration_ms(context.started_at),
                time_to_first_token=time_to_first_token,
                gateway_thread_id=context.gateway_thread_id,
                gateway_trace_id=context.gateway_trace_id,
            )
        except Exception as exc:
            logger.debug(
                f"[LLMRequestLog] 请求日志失败记录失败 | "
                f"request_id={context.request_id} | 错误={exc}"
            )

    def _cancel_request_log(
        self,
        context: _LLMRequestLogContext | None,
        *,
        error: BaseException,
        response_preview: str | None = None,
        time_to_first_token: int | None = None,
    ) -> None:
        if self._llm_request_logs is None or context is None:
            return
        try:
            self._llm_request_logs.cancel(
                context.request_id,
                error_message=str(error) or type(error).__name__,
                response_preview=response_preview,
                duration_ms=_duration_ms(context.started_at),
                time_to_first_token=time_to_first_token,
                gateway_thread_id=context.gateway_thread_id,
                gateway_trace_id=context.gateway_trace_id,
            )
        except Exception as exc:
            logger.debug(
                f"[LLMRequestLog] 请求日志取消记录失败 | "
                f"request_id={context.request_id} | 错误={exc}"
            )

    async def _emit_retry_progress(
        self,
        *,
        stage: str,
        run_id: str,
        gateway_trace_id: str,
        attempt: int,
        max_retries: int,
        error: BaseException | None = None,
    ) -> None:
        dispatcher = get_event_dispatcher()
        trace_id = get_trace_id()
        session_id = get_session_id()
        if dispatcher is None or not trace_id or not session_id or max_retries <= 0:
            return
        retry_index = min(max(attempt, 1), max_retries)
        retry_after_ms = (
            int(_llm_retry_delay_seconds(attempt) * 1000)
            if stage == "retrying"
            else None
        )
        payload: dict[str, Any] = {
            "middleware": "LLMRetry",
            "kind": "llm_retry",
            "stage": stage,
            "notice_id": f"llm-retry:{trace_id}:{run_id or gateway_trace_id or 'model'}",
            "session_id": session_id,
            "active_session_id": get_active_session_id() or session_id,
            "trace_id": trace_id,
            "gateway_trace_id": gateway_trace_id,
            "attempt": attempt + 1 if stage == "retrying" else attempt,
            "retry_index": retry_index,
            "max_retries": max_retries,
            "max_attempts": max_retries + 1,
            "retry_after_ms": retry_after_ms,
        }
        if error is not None:
            payload["error"] = str(error) or type(error).__name__
            payload["error_type"] = _exception_type_name(error)
        try:
            await dispatcher.emit_event(
                event_type=DomainEventType.MIDDLEWARE_PROGRESS.value,
                source="llm_retry",
                payload=payload,
                trace_id=trace_id,
                user_id=get_user_id() or None,
                original_session_id=session_id,
                active_session_id=get_active_session_id() or session_id,
                run_id=run_id,
                turn_index=get_turn_index(),
            )
        except Exception as exc:
            logger.debug(
                f"[LLMRetry] 进度事件发送失败 | stage={stage} | "
                f"run_id={run_id} | gateway_trace_id={gateway_trace_id} | error={exc}"
            )

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
        except BaseException as exc:
            if isinstance(exc, (asyncio.CancelledError, GeneratorExit)):
                logger.info(
                    f"[LLM] agenerate_with_cache 已取消 | run_id={run_id} | "
                    f"gateway_trace_id={gateway_trace_id} | error={type(exc).__name__}"
                )
            else:
                logger.opt(exception=True).error(
                    f"[LLM] agenerate_with_cache 失败 | run_id={run_id} | "
                    f"gateway_trace_id={gateway_trace_id}"
                )
            raise
        finally:
            pop_llm_gateway_trace_id(run_id)

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
        max_retries = _llm_business_max_retries()
        attempt = 1
        try:
            while True:
                request_log = self._start_request_log(
                    run_id=run_id,
                    gateway_trace_id=gateway_trace_id,
                    messages=messages,
                    call_kind="agenerate",
                    attempt=attempt,
                    max_retries=max_retries,
                )
                try:
                    result = await super()._agenerate(
                        messages,
                        stop=stop,
                        run_manager=run_manager,
                        **kwargs,
                    )
                except (asyncio.CancelledError, GeneratorExit) as exc:
                    self._cancel_request_log(request_log, error=exc)
                    logger.info(
                        f"[LLM] agenerate 已取消 | run_id={run_id} | "
                        f"gateway_trace_id={gateway_trace_id} | error={type(exc).__name__}"
                    )
                    raise
                except BaseException as exc:
                    self._fail_request_log(request_log, error=exc)
                    if _should_retry_llm_error(exc) and attempt <= max_retries:
                        await self._emit_retry_progress(
                            stage="retrying",
                            run_id=run_id,
                            gateway_trace_id=gateway_trace_id,
                            attempt=attempt,
                            max_retries=max_retries,
                            error=exc,
                        )
                        await _sleep_before_llm_retry(attempt)
                        attempt += 1
                        continue
                    if attempt > 1:
                        await self._emit_retry_progress(
                            stage="failed",
                            run_id=run_id,
                            gateway_trace_id=gateway_trace_id,
                            attempt=attempt,
                            max_retries=max_retries,
                            error=exc,
                        )
                    logger.opt(exception=True).error(
                        f"[LLM] agenerate 失败 | run_id={run_id} | "
                        f"gateway_trace_id={gateway_trace_id}"
                    )
                    raise
                else:
                    self._finish_request_log(request_log, response=result)
                    if attempt > 1:
                        await self._emit_retry_progress(
                            stage="recovered",
                            run_id=run_id,
                            gateway_trace_id=gateway_trace_id,
                            attempt=attempt,
                            max_retries=max_retries,
                        )
                    return result
        finally:
            pop_llm_gateway_trace_id(run_id)

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
        max_retries = _llm_business_max_retries()
        attempt = 1
        try:
            while True:
                request_log = self._start_request_log(
                    run_id=run_id,
                    gateway_trace_id=gateway_trace_id,
                    messages=messages,
                    call_kind="astream",
                    attempt=attempt,
                    max_retries=max_retries,
                )
                seen_input_tokens: int | None = None
                seen_output_tokens: int | None = None
                seen_total_tokens: int | None = None
                seen_cache_read_tokens: int | None = None
                stream_usage = _empty_token_usage()
                response_preview = _ResponsePreviewCollector()
                time_to_first_token: int | None = None
                yielded_chunk = False
                terminal_finish_reason: str | None = None
                terminal_tail_deadline: float | None = None
                received_usage = False
                source_stream = super()._astream(
                    messages,
                    stop=stop,
                    run_manager=run_manager,
                    **kwargs,
                )
                try:
                    while True:
                        try:
                            if terminal_tail_deadline is None:
                                chunk = await anext(source_stream)
                            else:
                                remaining = (
                                    terminal_tail_deadline - asyncio.get_running_loop().time()
                                )
                                if remaining <= 0:
                                    raise TimeoutError("LLM terminal stream tail did not close")
                                chunk = await asyncio.wait_for(
                                    anext(source_stream),
                                    timeout=remaining,
                                )
                        except StopAsyncIteration:
                            break
                        yielded_chunk = True
                        chunk_msg = getattr(chunk, "message", None)
                        usage = getattr(chunk_msg, "usage_metadata", None) if chunk_msg else None
                        if usage:
                            received_usage = True
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
                            _merge_token_usage(
                                stream_usage,
                                _extract_token_usage_from_metadata(usage),
                            )
                        if (
                            time_to_first_token is None
                            and request_log is not None
                            and _stream_first_output_text(chunk_msg)
                        ):
                            time_to_first_token = _duration_ms(request_log.started_at)
                        response_preview.append(chunk_msg)
                        finish_reason = _stream_chunk_finish_reason(chunk)
                        if finish_reason and terminal_finish_reason is None:
                            terminal_finish_reason = finish_reason
                            terminal_tail_deadline = (
                                asyncio.get_running_loop().time()
                                + _LLM_TERMINAL_TAIL_GRACE_SECONDS
                            )
                        yield chunk
                        if terminal_finish_reason and received_usage:
                            break
                except (asyncio.CancelledError, GeneratorExit) as exc:
                    self._cancel_request_log(
                        request_log,
                        error=exc,
                        response_preview=response_preview.preview(),
                        time_to_first_token=time_to_first_token,
                    )
                    logger.info(
                        f"[LLM] astream 已取消 | run_id={run_id} | "
                        f"gateway_trace_id={gateway_trace_id} | error={type(exc).__name__}"
                    )
                    raise
                except BaseException as exc:
                    if terminal_finish_reason and _is_terminal_stream_tail_timeout(exc):
                        self._finish_request_log(
                            request_log,
                            response=None,
                            response_preview=response_preview.preview(),
                            usage=stream_usage,
                            time_to_first_token=time_to_first_token,
                        )
                        logger.warning(
                            f"[LLM] astream terminal tail timeout ignored | run_id={run_id} | "
                            f"gateway_trace_id={gateway_trace_id} | "
                            f"finish_reason={terminal_finish_reason} | "
                            f"error={type(exc).__name__}"
                        )
                        if attempt > 1:
                            await self._emit_retry_progress(
                                stage="recovered",
                                run_id=run_id,
                                gateway_trace_id=gateway_trace_id,
                                attempt=attempt,
                                max_retries=max_retries,
                            )
                        return
                    self._fail_request_log(
                        request_log,
                        error=exc,
                        response_preview=response_preview.preview(),
                        time_to_first_token=time_to_first_token,
                    )
                    can_retry = (
                        not yielded_chunk
                        and _should_retry_llm_error(exc)
                        and attempt <= max_retries
                    )
                    if can_retry:
                        await self._emit_retry_progress(
                            stage="retrying",
                            run_id=run_id,
                            gateway_trace_id=gateway_trace_id,
                            attempt=attempt,
                            max_retries=max_retries,
                            error=exc,
                        )
                        await _sleep_before_llm_retry(attempt)
                        attempt += 1
                        continue
                    if attempt > 1:
                        await self._emit_retry_progress(
                            stage="failed",
                            run_id=run_id,
                            gateway_trace_id=gateway_trace_id,
                            attempt=attempt,
                            max_retries=max_retries,
                            error=exc,
                        )
                    logger.opt(exception=True).error(
                        f"[LLM] astream 失败 | run_id={run_id} | "
                        f"gateway_trace_id={gateway_trace_id}"
                    )
                    raise
                else:
                    self._finish_request_log(
                        request_log,
                        response=None,
                        response_preview=response_preview.preview(),
                        usage=stream_usage,
                        time_to_first_token=time_to_first_token,
                    )
                    if attempt > 1:
                        await self._emit_retry_progress(
                            stage="recovered",
                            run_id=run_id,
                            gateway_trace_id=gateway_trace_id,
                            attempt=attempt,
                            max_retries=max_retries,
                        )
                    return
                finally:
                    await _close_async_iterator(source_stream)
        finally:
            pop_llm_gateway_trace_id(run_id)

    def _generate(
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
        request_log = self._start_request_log(
            run_id=run_id,
            gateway_trace_id=gateway_trace_id,
            messages=messages,
            call_kind="generate",
        )
        try:
            result = super()._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
        except (asyncio.CancelledError, GeneratorExit) as exc:
            self._cancel_request_log(request_log, error=exc)
            logger.info(
                f"[LLM] generate 已取消 | run_id={run_id} | "
                f"gateway_trace_id={gateway_trace_id} | error={type(exc).__name__}"
            )
            raise
        except BaseException as exc:
            self._fail_request_log(request_log, error=exc)
            logger.opt(exception=True).error(
                f"[LLM] generate 失败 | run_id={run_id} | gateway_trace_id={gateway_trace_id}"
            )
            raise
        else:
            self._finish_request_log(request_log, response=result)
            return result
        finally:
            pop_llm_gateway_trace_id(run_id)

    def _stream(
        self,
        messages: list[Any],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> Iterator[Any]:
        run_id = str(getattr(run_manager, "run_id", "") or "")
        resolved_kwargs = dict(kwargs)
        gateway_trace_id = self._resolve_gateway_trace_id(run_id, resolved_kwargs)
        kwargs = self._inject_gateway_headers(resolved_kwargs, gateway_trace_id)
        request_log = self._start_request_log(
            run_id=run_id,
            gateway_trace_id=gateway_trace_id,
            messages=messages,
            call_kind="stream",
        )
        seen_input_tokens: int | None = None
        seen_output_tokens: int | None = None
        seen_total_tokens: int | None = None
        seen_cache_read_tokens: int | None = None
        stream_usage = _empty_token_usage()
        response_preview = _ResponsePreviewCollector()
        time_to_first_token: int | None = None
        try:
            for chunk in super()._stream(
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
                    _merge_token_usage(stream_usage, _extract_token_usage_from_metadata(usage))
                if (
                    time_to_first_token is None
                    and request_log is not None
                    and _stream_first_output_text(chunk_msg)
                ):
                    time_to_first_token = _duration_ms(request_log.started_at)
                response_preview.append(chunk_msg)
                yield chunk
        except (asyncio.CancelledError, GeneratorExit) as exc:
            self._cancel_request_log(
                request_log,
                error=exc,
                response_preview=response_preview.preview(),
                time_to_first_token=time_to_first_token,
            )
            logger.info(
                f"[LLM] stream 已取消 | run_id={run_id} | "
                f"gateway_trace_id={gateway_trace_id} | error={type(exc).__name__}"
            )
            raise
        except BaseException as exc:
            self._fail_request_log(
                request_log,
                error=exc,
                response_preview=response_preview.preview(),
                time_to_first_token=time_to_first_token,
            )
            logger.opt(exception=True).error(
                f"[LLM] stream 失败 | run_id={run_id} | gateway_trace_id={gateway_trace_id}"
            )
            raise
        else:
            self._finish_request_log(
                request_log,
                response=None,
                response_preview=response_preview.preview(),
                usage=stream_usage,
                time_to_first_token=time_to_first_token,
            )
        finally:
            pop_llm_gateway_trace_id(run_id)


def _duration_ms(started_at: float) -> int:
    elapsed_ms = (time.perf_counter() - started_at) * 1000
    if elapsed_ms <= 0:
        return 0
    return max(1, int(elapsed_ms + 0.999))


def _llm_business_max_retries() -> int:
    return max(0, int(_LLM_BUSINESS_MAX_RETRIES))


async def _sleep_before_llm_retry(attempt: int) -> None:
    delay = _llm_retry_delay_seconds(attempt)
    if delay > 0:
        await asyncio.sleep(delay)


def _llm_retry_delay_seconds(attempt: int) -> float:
    if not _LLM_RETRY_DELAYS_SECONDS:
        return 0
    index = min(max(attempt - 1, 0), len(_LLM_RETRY_DELAYS_SECONDS) - 1)
    return max(0.0, float(_LLM_RETRY_DELAYS_SECONDS[index]))


def _should_retry_llm_error(error: BaseException) -> bool:
    for exc in _exception_chain(error):
        if isinstance(exc, (asyncio.CancelledError, GeneratorExit)):
            return False
        if is_stream_chunk_timeout_error(exc):
            return True
        if isinstance(exc, (openai.APITimeoutError, openai.APIConnectionError)):
            return True
        if isinstance(exc, (httpx.TimeoutException, httpx.ConnectError)):
            return True
        if isinstance(exc, openai.APIStatusError):
            status_code = getattr(exc, "status_code", None)
            return status_code in {408, 409, 429, 500, 502, 503, 504}
        if isinstance(exc, httpx.HTTPStatusError):
            status_code = exc.response.status_code
            return status_code in {408, 409, 429, 500, 502, 503, 504}
    return False


def _stream_chunk_finish_reason(chunk: Any) -> str | None:
    generation_info = getattr(chunk, "generation_info", None)
    if isinstance(generation_info, dict):
        finish_reason = generation_info.get("finish_reason")
        if isinstance(finish_reason, str) and finish_reason.strip():
            return finish_reason.strip()

    message = getattr(chunk, "message", None)
    response_metadata = getattr(message, "response_metadata", None)
    if isinstance(response_metadata, dict):
        finish_reason = response_metadata.get("finish_reason")
        if isinstance(finish_reason, str) and finish_reason.strip():
            return finish_reason.strip()
    return None


def _is_terminal_stream_tail_timeout(error: BaseException) -> bool:
    return any(
        is_stream_chunk_timeout_error(exc)
        or isinstance(exc, (asyncio.TimeoutError, httpx.ReadTimeout, openai.APITimeoutError))
        for exc in _exception_chain(error)
    )


async def _close_async_iterator(iterator: Any) -> None:
    close = getattr(iterator, "aclose", None)
    if not callable(close):
        return
    try:
        await close()
    except Exception as exc:
        logger.debug(f"[LLM] close source stream failed | error={type(exc).__name__}: {exc}")


def _exception_chain(error: BaseException) -> Iterator[BaseException]:
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def _exception_type_name(error: BaseException) -> str:
    cls = type(error)
    return f"{cls.__module__}.{cls.__name__}"


class _ResponsePreviewCollector:
    def __init__(self) -> None:
        self._text_parts: list[str] = []
        self._tool_call_order: list[str] = []
        self._tool_calls_by_key: dict[str, dict[str, Any]] = {}

    def append(self, message: Any) -> None:
        text = _response_content_preview_text(message)
        if text:
            self._text_parts.append(text)
        for tool_call in _message_tool_call_chunks(message):
            self._merge_tool_call_chunk(tool_call)

    def preview(self) -> str:
        text = "".join(self._text_parts)
        tool_call_text = _format_tool_call_preview(
            [self._tool_calls_by_key[key] for key in self._tool_call_order]
        )
        if text and tool_call_text:
            return f"{text}\n{tool_call_text}"
        return text or tool_call_text

    def _merge_tool_call_chunk(self, tool_call: dict[str, Any]) -> None:
        key = _tool_call_key(tool_call, len(self._tool_call_order))
        current = self._tool_calls_by_key.get(key)
        if current is None:
            current = {}
            self._tool_calls_by_key[key] = current
            self._tool_call_order.append(key)

        if tool_call.get("name"):
            current["name"] = tool_call["name"]
        if tool_call.get("id"):
            current["id"] = tool_call["id"]
        if tool_call.get("index") is not None:
            current["index"] = tool_call["index"]

        args = tool_call.get("args")
        if args is None:
            return
        current_args = current.get("args")
        if isinstance(args, str) or isinstance(current_args, str):
            current["args"] = f"{current_args or ''}{args or ''}"
            return
        if isinstance(args, dict) and isinstance(current_args, dict):
            current["args"] = {**current_args, **args}
            return
        current["args"] = args


def _model_name(model: Any) -> str:
    value = (
        getattr(model, "model_name", None)
        or getattr(model, "model", None)
        or getattr(model, "name", None)
    )
    return str(value or "unknown")


def _empty_token_usage() -> dict[str, int]:
    return {
        "input_tokens": 0,
        "cache_read_tokens": 0,
        "output_tokens": 0,
        "total_tokens": 0,
    }


def _merge_token_usage(target: dict[str, int], source: dict[str, int]) -> dict[str, int]:
    for key in ("input_tokens", "cache_read_tokens", "output_tokens", "total_tokens"):
        target[key] = int(target.get(key, 0) or 0) + int(source.get(key, 0) or 0)
    return target


def _extract_token_usage(value: Any) -> dict[str, int]:
    usage = _usage_metadata(value)
    if usage:
        return _extract_token_usage_from_metadata(usage)
    total = _empty_token_usage()
    found_generation_usage = False
    generations = getattr(value, "generations", None)
    if generations:
        for generation_group in generations:
            if isinstance(generation_group, list):
                generation_items = generation_group
            else:
                generation_items = [generation_group]
            for generation in generation_items:
                message = getattr(generation, "message", None)
                usage = _usage_metadata(message)
                if usage:
                    found_generation_usage = True
                    _merge_token_usage(total, _extract_token_usage_from_metadata(usage))
    llm_output = getattr(value, "llm_output", None)
    if isinstance(llm_output, dict) and not found_generation_usage:
        token_usage = llm_output.get("token_usage") or llm_output.get("usage")
        if token_usage:
            _merge_token_usage(total, _extract_token_usage_from_metadata(token_usage))
    return total


def _usage_metadata(value: Any) -> Any:
    if value is None:
        return None
    usage = getattr(value, "usage_metadata", None)
    if usage:
        return usage
    if isinstance(value, dict):
        return value.get("usage_metadata") or value.get("usage")
    return None


def _extract_token_usage_from_metadata(usage: Any) -> dict[str, int]:
    input_tokens = _usage_get(usage, "input_tokens") or _usage_get(usage, "prompt_tokens")
    output_tokens = _usage_get(usage, "output_tokens") or _usage_get(
        usage, "completion_tokens"
    )
    total_tokens = _usage_get(usage, "total_tokens") or input_tokens + output_tokens
    return {
        "input_tokens": input_tokens,
        "cache_read_tokens": _cache_read_tokens(usage),
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
    }


def _cache_read_tokens(usage: Any) -> int:
    details = (
        usage.get("input_token_details")
        if isinstance(usage, dict)
        else getattr(usage, "input_token_details", None)
    )
    if isinstance(details, dict):
        return int(
            details.get("cache_read", 0)
            or details.get("cached_tokens", 0)
            or details.get("cache_read_tokens", 0)
            or 0
        )
    if details is not None:
        return int(
            getattr(details, "cache_read", 0)
            or getattr(details, "cached_tokens", 0)
            or getattr(details, "cache_read_tokens", 0)
            or 0
        )
    prompt_details = (
        usage.get("prompt_tokens_details")
        if isinstance(usage, dict)
        else getattr(usage, "prompt_tokens_details", None)
    )
    if isinstance(prompt_details, dict):
        return int(prompt_details.get("cached_tokens", 0) or 0)
    if prompt_details is not None:
        return int(getattr(prompt_details, "cached_tokens", 0) or 0)
    return 0


def _response_preview(value: Any) -> str:
    generations = getattr(value, "generations", None)
    if generations:
        for generation_group in generations:
            if isinstance(generation_group, list):
                generation_items = generation_group
            else:
                generation_items = [generation_group]
            for generation in generation_items:
                text = _response_preview_text(getattr(generation, "message", None))
                if text:
                    return text
    return _response_preview_text(value) or _preview_value(value)


def _request_preview(messages: list[Any]) -> str:
    user_message = get_user_message()
    if user_message is not None:
        return _preview_value(user_message)
    return _preview_value(messages)


def _message_text(message: Any) -> str:
    if message is None:
        return ""
    content = getattr(message, "content", message)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


def _stream_first_output_text(message: Any) -> str:
    return _response_preview_text(message)


def _response_preview_text(message: Any) -> str:
    content_text = _response_content_preview_text(message)
    tool_call_text = _tool_call_message_text(message)
    if content_text and tool_call_text:
        return f"{content_text}\n{tool_call_text}"
    return content_text or tool_call_text


def _response_content_preview_text(message: Any) -> str:
    reasoning_text = _reasoning_message_text(message)
    content_text = _message_text(message)
    return f"{reasoning_text}{content_text}" if reasoning_text else content_text


def _reasoning_message_text(message: Any) -> str:
    if message is None:
        return ""
    additional_kwargs = getattr(message, "additional_kwargs", None)
    if isinstance(additional_kwargs, dict):
        internal_text = additional_kwargs.get(_KEYDEX_REASONING_TEXT)
        if isinstance(internal_text, str) and internal_text:
            return internal_text
        text = _reasoning_delta_text(additional_kwargs)
        if text:
            return text
    if isinstance(message, dict):
        return _reasoning_delta_text(message)
    return ""


def _tool_call_message_text(message: Any) -> str:
    return _format_tool_call_preview(_message_tool_calls(message))


def _message_tool_calls(message: Any) -> list[dict[str, Any]]:
    if message is None:
        return []

    tool_calls = _normalise_tool_call_list(getattr(message, "tool_calls", None))
    invalid_tool_calls = _normalise_tool_call_list(
        getattr(message, "invalid_tool_calls", None)
    )
    if tool_calls or invalid_tool_calls:
        return [*tool_calls, *invalid_tool_calls]

    for mapping in _message_tool_call_mappings(message):
        calls = _raw_tool_calls_from_mapping(mapping)
        if calls:
            return calls

    return _message_tool_call_chunks(message)


def _message_tool_call_chunks(message: Any) -> list[dict[str, Any]]:
    if message is None:
        return []
    chunks = _normalise_tool_call_list(getattr(message, "tool_call_chunks", None))
    if chunks:
        return chunks
    for mapping in _message_tool_call_mappings(message):
        calls = _raw_tool_calls_from_mapping(mapping)
        if calls:
            return calls
    return []


def _message_tool_call_mappings(message: Any) -> list[dict[str, Any]]:
    mappings: list[dict[str, Any]] = []
    additional_kwargs = getattr(message, "additional_kwargs", None)
    if isinstance(additional_kwargs, dict):
        mappings.append(additional_kwargs)
    if isinstance(message, dict):
        mappings.append(message)
    return mappings


def _raw_tool_calls_from_mapping(mapping: dict[str, Any]) -> list[dict[str, Any]]:
    raw_tool_calls = mapping.get("tool_calls")
    if isinstance(raw_tool_calls, list):
        calls = _normalise_tool_call_list(raw_tool_calls)
        if calls:
            return calls
    function_call = mapping.get("function_call")
    if isinstance(function_call, dict):
        return [_normalise_tool_call(function_call)]
    return []


def _normalise_tool_call_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [_normalise_tool_call(item) for item in value]


def _normalise_tool_call(value: Any) -> dict[str, Any]:
    function = _tool_call_value(value, "function")
    return {
        "id": _tool_call_value(value, "id"),
        "index": _tool_call_value(value, "index"),
        "name": _tool_call_value(value, "name") or _tool_call_value(function, "name"),
        "args": _tool_call_value(value, "args")
        if _tool_call_value(value, "args") is not None
        else _tool_call_value(function, "arguments"),
    }


def _tool_call_value(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _tool_call_key(tool_call: dict[str, Any], fallback_index: int) -> str:
    index = tool_call.get("index")
    if index is not None:
        return f"index:{index}"
    call_id = tool_call.get("id")
    if call_id:
        return f"id:{call_id}"
    return f"fallback:{fallback_index}"


def _format_tool_call_preview(tool_calls: list[dict[str, Any]]) -> str:
    if not tool_calls:
        return ""
    parts: list[str] = []
    for tool_call in tool_calls[:_TOOL_CALL_PREVIEW_MAX_CALLS]:
        name = str(tool_call.get("name") or "unknown_tool")
        args = _format_tool_call_args(tool_call.get("args"))
        parts.append(f"{name}({args})" if args else f"{name}()")
    remaining = len(tool_calls) - _TOOL_CALL_PREVIEW_MAX_CALLS
    if remaining > 0:
        parts.append(f"+{remaining} more")
    return f"工具调用: {'; '.join(parts)}"


def _format_tool_call_args(args: Any) -> str:
    if args is None:
        return ""
    if isinstance(args, str):
        text = args
    else:
        try:
            text = json.dumps(args, ensure_ascii=False, separators=(",", ":"))
        except TypeError:
            text = str(args)
    text = text.replace("\r", " ").replace("\n", " ")
    if len(text) <= _TOOL_CALL_PREVIEW_ARGS_LIMIT:
        return text
    return f"{text[:_TOOL_CALL_PREVIEW_ARGS_LIMIT]}..."


def _response_to_mapping(response: Any) -> dict[str, Any]:
    if isinstance(response, dict):
        return response
    model_dump = getattr(response, "model_dump", None)
    if callable(model_dump):
        value = model_dump()
        return value if isinstance(value, dict) else {}
    return {}


def _preserve_reasoning_chat_result(chat_result: Any, response_dict: dict[str, Any]) -> None:
    choices = response_dict.get("choices")
    generations = getattr(chat_result, "generations", None)
    if not isinstance(choices, list) or not isinstance(generations, list):
        return
    for generation, choice in zip(generations, choices, strict=False):
        if not isinstance(choice, dict):
            continue
        raw_message = choice.get("message")
        if isinstance(raw_message, dict):
            _preserve_reasoning_message(getattr(generation, "message", None), raw_message)


def _preserve_reasoning_message(message: Any, raw_message: dict[str, Any]) -> None:
    additional_kwargs = getattr(message, "additional_kwargs", None)
    if not isinstance(additional_kwargs, dict):
        return
    reasoning_payload = _reasoning_payload_from_mapping(raw_message)
    if not reasoning_payload:
        return

    additional_kwargs.update(reasoning_payload)
    _remember_reasoning_keys(additional_kwargs, reasoning_payload)


def _restore_reasoning_request_payload(payload: dict[str, Any], source_messages: list[Any]) -> None:
    target_messages = payload.get("messages")
    if not isinstance(target_messages, list):
        return
    for source_message, target_message in zip(source_messages, target_messages, strict=False):
        if not isinstance(target_message, dict) or target_message.get("role") != "assistant":
            continue
        additional_kwargs = getattr(source_message, "additional_kwargs", None)
        if not isinstance(additional_kwargs, dict):
            continue
        reasoning_payload = _reasoning_request_payload(additional_kwargs)
        for key in (
            *_REASONING_PAYLOAD_KEYS,
            _KEYDEX_REASONING_KEYS,
            _KEYDEX_REASONING_TEXT,
        ):
            target_message.pop(key, None)
        if reasoning_payload:
            target_message.update(reasoning_payload)


def _preserve_reasoning_delta(generation_chunk: Any, raw_chunk: Any) -> None:
    if generation_chunk is None:
        return
    message = getattr(generation_chunk, "message", None)
    additional_kwargs = getattr(message, "additional_kwargs", None)
    if not isinstance(additional_kwargs, dict):
        return
    delta = _chat_completion_delta(raw_chunk)
    if not delta:
        return

    reasoning_payload = _reasoning_payload_from_mapping(delta)
    if not reasoning_payload:
        return

    additional_kwargs.update(reasoning_payload)
    _remember_reasoning_keys(additional_kwargs, reasoning_payload)


def _chat_completion_delta(raw_chunk: Any) -> dict[str, Any]:
    if not isinstance(raw_chunk, dict):
        return {}
    choices = raw_chunk.get("choices")
    if not choices:
        nested = raw_chunk.get("chunk")
        if isinstance(nested, dict):
            choices = nested.get("choices")
    if not isinstance(choices, list) or not choices:
        return {}
    choice = choices[0]
    if not isinstance(choice, dict):
        return {}
    delta = choice.get("delta")
    return delta if isinstance(delta, dict) else {}


def _reasoning_payload_from_mapping(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: item
        for key, item in value.items()
        if key in _REASONING_PAYLOAD_KEYS
    }


def _remember_reasoning_keys(
    additional_kwargs: dict[str, Any],
    reasoning_payload: dict[str, Any],
) -> None:
    existing = additional_kwargs.get(_KEYDEX_REASONING_KEYS)
    keys = [
        key
        for key in existing
        if isinstance(key, str) and key in _REASONING_PAYLOAD_KEYS
    ] if isinstance(existing, list) else []
    for key in reasoning_payload:
        if key not in keys:
            keys.append(key)
    if keys:
        additional_kwargs[_KEYDEX_REASONING_KEYS] = keys

    reasoning_text = _reasoning_delta_text(reasoning_payload)
    if reasoning_text:
        existing_text = additional_kwargs.get(_KEYDEX_REASONING_TEXT)
        if isinstance(existing_text, str) and existing_text:
            additional_kwargs[_KEYDEX_REASONING_TEXT] = f"{existing_text}{reasoning_text}"
        else:
            additional_kwargs[_KEYDEX_REASONING_TEXT] = reasoning_text


def _reasoning_request_payload(additional_kwargs: dict[str, Any]) -> dict[str, Any]:
    raw_payload = _reasoning_payload_from_mapping(additional_kwargs)
    if not raw_payload:
        return {}

    ordered_keys: list[str] = []
    stored_keys = additional_kwargs.get(_KEYDEX_REASONING_KEYS)
    if isinstance(stored_keys, list):
        for key in stored_keys:
            if isinstance(key, str) and key in raw_payload and key not in ordered_keys:
                ordered_keys.append(key)
    for key in raw_payload:
        if key not in ordered_keys:
            ordered_keys.append(key)

    result: dict[str, Any] = {}
    seen_signatures: set[tuple[str, str]] = set()
    for key in ordered_keys:
        value = raw_payload[key]
        signature = _reasoning_value_signature(key, value)
        if signature is not None:
            if signature in seen_signatures:
                continue
            seen_signatures.add(signature)
        result[key] = value
    return result


def _reasoning_value_signature(key: str, value: Any) -> tuple[str, str] | None:
    if key in _REASONING_TEXT_KEYS and isinstance(value, str):
        return ("text", value)
    if key == "reasoning_details":
        text = _reasoning_delta_text({"reasoning_details": value})
        return ("text", text) if text else None
    if isinstance(value, dict):
        text = _reasoning_text_from_mapping(value)
        return ("text", text) if text else None
    return None


def _reasoning_delta_text(payload: dict[str, Any]) -> str:
    for key in ("reasoning_content", "reasoning", "reasoning_text"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, dict):
            nested = _reasoning_text_from_mapping(value)
            if nested:
                return nested

    details = payload.get("reasoning_details")
    if isinstance(details, str):
        return details
    if isinstance(details, list):
        parts = [
            _reasoning_text_from_mapping(item)
            for item in details
            if isinstance(item, dict)
        ]
        return "".join(part for part in parts if part)
    if isinstance(details, dict):
        return _reasoning_text_from_mapping(details)
    return ""


def _reasoning_text_from_mapping(value: dict[str, Any]) -> str:
    for key in ("text", "content", "reasoning_content", "reasoning_text", "summary"):
        item = value.get(key)
        if isinstance(item, str) and item:
            return item
    return ""


def _preview_value(value: Any, limit: int = 1000) -> str:
    if value is None:
        return ""
    text = str(value)
    return text if len(text) <= limit else f"{text[:limit]}..."


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
    details = (
        usage.get("input_token_details")
        if isinstance(usage, dict)
        else getattr(
            usage,
            "input_token_details",
            None,
        )
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
        llm_request_logs: Any = None,
        provider_id: str | None = None,
        provider_name: str | None = None,
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
            f"{id(http_transport) if http_transport else ''}:"
            f"{id(llm_request_logs) if llm_request_logs else ''}:"
            f"{provider_id or ''}:{provider_name or ''}"
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
                max_retries=0,
                streaming=streaming,
                stream_usage=True,
                use_responses_api=False,
                http_socket_options=(),
                llm_request_logs=llm_request_logs,
                provider_id=provider_id,
                provider_name=provider_name,
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
        state_schema: type[Any] | None = None,
        name: str = "desktop_agent",
    ) -> Any:
        return create_agent(
            model=model,
            tools=tools,
            system_prompt=system_prompt,
            middleware=middleware,
            state_schema=state_schema,
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


agent_factory = AgentFactory()
