import asyncio
import json
from typing import Any

import httpx
import openai
import pytest
from langchain.agents import create_agent
from langchain_core.messages import HumanMessage
from langchain_openai.chat_models._client_utils import StreamChunkTimeoutError

import backend.app.agent.factory as factory_module
from backend.app.agent.factory import AgentFactory
from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.events import DomainEvent, EventDispatcher
from backend.app.model import ModelSettings
from backend.app.model.e2e_transport import E2E_MODEL_ID, create_e2e_model_transport
from backend.app.storage import StorageRepositories, init_database


def test_retry_classifier_accepts_stream_chunk_timeout() -> None:
    error = StreamChunkTimeoutError(120.0, model_name="slow-model", chunks_received=0)

    assert factory_module._should_retry_llm_error(error) is True


@pytest.mark.asyncio
async def test_patched_chat_openai_logs_non_streaming_completion(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    captured_headers: dict[str, str] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        captured_headers.update(dict(request.headers))
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"role": "assistant", "content": "完成"}}],
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 5,
                    "total_tokens": 17,
                    "prompt_tokens_details": {"cached_tokens": 3},
                },
            },
        )

    llm = _llm(
        repositories,
        http_transport=httpx.MockTransport(handler),
        streaming=False,
        model="logged-model",
    )
    token = _request_context()
    try:
        response = await llm.ainvoke([HumanMessage(content="你好")])
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert response.content == "完成"
    assert total == 1
    record = records[0]
    assert record.status == "completed"
    assert record.trace_id == "trace_llm"
    assert record.session_id == "ses_llm"
    assert record.active_session_id == "ses_llm"
    assert record.turn_index == 3
    assert record.provider_id == "provider-1"
    assert record.provider_name == "测试供应商"
    assert record.model == "logged-model"
    assert record.request_preview == "这一轮用户消息"
    assert record.input_tokens == 12
    assert record.cache_read_tokens == 3
    assert record.output_tokens == 5
    assert record.total_tokens == 17
    assert record.response_preview == "完成"
    assert record.time_to_first_token == record.duration_ms
    assert captured_headers["ah-thread-id"] == "trace_llm"
    assert captured_headers["ah-trace-id"] == record.gateway_trace_id


@pytest.mark.asyncio
async def test_patched_chat_openai_logs_non_streaming_tool_call_preview(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": "call_read",
                                    "type": "function",
                                    "function": {
                                        "name": "read_file",
                                        "arguments": "{\"path\":\"README.md\"}",
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
                "usage": {
                    "prompt_tokens": 8,
                    "completion_tokens": 2,
                    "total_tokens": 10,
                },
            },
        )

    llm = _llm(
        repositories,
        http_transport=httpx.MockTransport(handler),
        streaming=False,
        model="tool-call-model",
    )
    token = _request_context()
    try:
        response = await llm.ainvoke([HumanMessage(content="读取 README")])
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert response.tool_calls[0]["name"] == "read_file"
    assert total == 1
    record = records[0]
    assert record.status == "completed"
    assert record.response_preview == '工具调用: read_file({"path":"README.md"})'
    assert record.time_to_first_token == record.duration_ms


@pytest.mark.asyncio
async def test_patched_chat_openai_logs_non_streaming_failure(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"message": "bad request"}})

    llm = _llm(
        repositories,
        http_transport=httpx.MockTransport(handler),
        streaming=False,
        model="logged-model",
    )
    token = _request_context()
    try:
        with pytest.raises(openai.BadRequestError):
            await llm.ainvoke([HumanMessage(content="触发失败")])
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert total == 1
    assert records[0].status == "failed"
    assert "bad request" in str(records[0].error_message)


@pytest.mark.asyncio
async def test_patched_chat_openai_logs_non_streaming_task_cancel(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    async def handler(_request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(
            200,
            json={"choices": [{"message": {"role": "assistant", "content": "late"}}]},
        )

    llm = _llm(
        repositories,
        http_transport=httpx.MockTransport(handler),
        streaming=False,
        model="logged-model",
    )
    token = _request_context()
    try:
        task = asyncio.create_task(llm.ainvoke([HumanMessage(content="取消")]))
        await asyncio.sleep(0.1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert total == 1
    assert records[0].status == "cancelled"
    assert records[0].error_message == "CancelledError"


@pytest.mark.asyncio
async def test_patched_chat_openai_logs_agent_stream_close_as_cancelled(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    llm = _llm(
        repositories,
        http_transport=create_e2e_model_transport(delay_ms=100),
        streaming=True,
        model=E2E_MODEL_ID,
    )
    agent = create_agent(model=llm, tools=[], system_prompt="", name="logging_probe")
    stream = agent.astream_events(
        {"messages": [{"role": "user", "content": "请输出流式 Markdown 长文"}]},
        version="v2",
    )

    token = _request_context()
    try:
        async for event in stream:
            if event.get("event") == "on_chat_model_stream":
                await stream.aclose()
                break
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert total == 1
    assert records[0].status == "cancelled"
    assert records[0].error_message == "GeneratorExit"
    assert records[0].response_preview
    assert records[0].time_to_first_token is not None
    assert records[0].duration_ms is not None
    assert records[0].time_to_first_token <= records[0].duration_ms


@pytest.mark.asyncio
async def test_patched_chat_openai_logs_streaming_completion_usage(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    llm = _llm(
        repositories,
        http_transport=create_e2e_model_transport(delay_ms=0),
        streaming=True,
        model=E2E_MODEL_ID,
    )
    token = _request_context()
    text = ""
    try:
        async for chunk in llm.astream([HumanMessage(content="请输出流式 Markdown 长文")]):
            if isinstance(chunk.content, str):
                text += chunk.content
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert "最终检查点" in text
    assert total == 1
    record = records[0]
    assert record.status == "completed"
    assert record.input_tokens == 11
    assert record.output_tokens == 38
    assert record.total_tokens == 49
    assert record.response_preview.startswith("# 流式 Markdown 验收")
    assert record.time_to_first_token is not None
    assert record.time_to_first_token >= 0
    assert record.duration_ms is not None
    assert record.time_to_first_token <= record.duration_ms


@pytest.mark.asyncio
async def test_patched_chat_openai_retries_streaming_before_first_chunk(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repositories = _repositories(tmp_path)
    attempts = 0
    captured_events: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        captured_events.append(event)

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(500, json={"error": {"message": "upstream unavailable"}})
        payload = json.loads((await request.aread()).decode("utf-8"))
        chunks = [
            _openai_stream_chunk(payload, delta={"content": "重试后成功"}),
            _openai_stream_chunk(
                payload,
                delta={},
                finish_reason="stop",
                usage={"prompt_tokens": 4, "completion_tokens": 3},
            ),
            "data: [DONE]\n\n",
        ]
        return httpx.Response(
            200,
            stream=_DelayedReasoningStream(chunks),
            headers={"content-type": "text/event-stream; charset=utf-8"},
        )

    monkeypatch.setattr(factory_module, "_LLM_RETRY_DELAYS_SECONDS", (0, 0, 0))
    dispatcher = EventDispatcher([capture])
    llm = _llm(
        repositories,
        http_transport=httpx.MockTransport(handler),
        streaming=True,
        model="retry-stream-model",
    )
    token = _request_context(dispatcher=dispatcher)
    text = ""
    try:
        async for chunk in llm.astream([HumanMessage(content="触发一次可重试失败")]):
            if isinstance(chunk.content, str):
                text += chunk.content
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    progress_events = [
        event for event in captured_events if event.event_type == "middleware.progress"
    ]
    assert attempts == 2
    assert text == "重试后成功"
    assert total == 2
    assert sorted(record.status for record in records) == ["completed", "failed"]
    assert [event.payload["stage"] for event in progress_events] == ["retrying", "recovered"]
    assert progress_events[0].payload["retry_index"] == 1
    assert progress_events[0].payload["max_retries"] == 3
    assert progress_events[0].payload["retry_after_ms"] == 0
    assert progress_events[1].payload["stage"] == "recovered"

@pytest.mark.asyncio
async def test_patched_chat_openai_stops_after_terminal_usage_without_waiting_for_tail(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    tail_stream: _TimeoutAfterChunksStream | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal tail_stream
        payload = json.loads((await request.aread()).decode("utf-8"))
        chunks = [
            _openai_stream_chunk(payload, delta={"content": "complete answer"}),
            _openai_stream_chunk(payload, delta={}, finish_reason="stop"),
            _openai_usage_stream_chunk(
                payload,
                usage={"prompt_tokens": 6, "completion_tokens": 4, "total_tokens": 10},
            ),
        ]
        tail_stream = _TimeoutAfterChunksStream(chunks)
        return httpx.Response(
            200,
            stream=tail_stream,
            headers={"content-type": "text/event-stream; charset=utf-8"},
        )

    llm = _llm(
        repositories,
        http_transport=httpx.MockTransport(handler),
        streaming=True,
        model="terminal-tail-model",
    )
    token = _request_context()
    text = ""
    try:
        async for chunk in llm.astream([HumanMessage(content="return a complete answer")]):
            if isinstance(chunk.content, str):
                text += chunk.content
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert text == "complete answer"
    assert tail_stream is not None
    assert tail_stream.tail_read_attempted is False
    assert tail_stream.closed is True
    assert total == 1
    assert records[0].status == "completed"
    assert records[0].input_tokens == 6
    assert records[0].output_tokens == 4
    assert records[0].total_tokens == 10


@pytest.mark.asyncio
async def test_patched_chat_openai_ignores_read_timeout_after_terminal_chunk(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    tail_stream: _TimeoutAfterChunksStream | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal tail_stream
        payload = json.loads((await request.aread()).decode("utf-8"))
        tail_stream = _TimeoutAfterChunksStream(
            [
                _openai_stream_chunk(payload, delta={"content": "complete answer"}),
                _openai_stream_chunk(payload, delta={}, finish_reason="stop"),
            ]
        )
        return httpx.Response(
            200,
            stream=tail_stream,
            headers={"content-type": "text/event-stream; charset=utf-8"},
        )

    llm = _llm(
        repositories,
        http_transport=httpx.MockTransport(handler),
        streaming=True,
        model="terminal-timeout-model",
    )
    token = _request_context()
    try:
        chunks = [
            chunk
            async for chunk in llm.astream([HumanMessage(content="return a complete answer")])
        ]
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert "".join(chunk.content for chunk in chunks if isinstance(chunk.content, str)) == (
        "complete answer"
    )
    assert tail_stream is not None
    assert tail_stream.tail_read_attempted is True
    assert total == 1
    assert records[0].status == "completed"


@pytest.mark.asyncio
async def test_patched_chat_openai_does_not_hide_timeout_before_terminal_chunk(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads((await request.aread()).decode("utf-8"))
        return httpx.Response(
            200,
            stream=_TimeoutAfterChunksStream(
                [_openai_stream_chunk(payload, delta={"content": "partial answer"})]
            ),
            headers={"content-type": "text/event-stream; charset=utf-8"},
        )

    llm = _llm(
        repositories,
        http_transport=httpx.MockTransport(handler),
        streaming=True,
        model="partial-timeout-model",
    )
    token = _request_context()
    try:
        with pytest.raises(httpx.ReadTimeout):
            async for _chunk in llm.astream([HumanMessage(content="trigger a partial timeout")]):
                pass
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert total == 1
    assert records[0].status == "failed"


@pytest.mark.asyncio
async def test_patched_chat_openai_uses_reasoning_chunk_for_time_to_first_token(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads((await request.aread()).decode("utf-8"))
        chunks = [
            _openai_stream_chunk(payload, delta={"reasoning_content": "先想一想"}),
            _openai_stream_chunk(payload, delta={"content": "正文回答"}),
            _openai_stream_chunk(
                payload,
                delta={},
                finish_reason="stop",
                usage={"prompt_tokens": 3, "completion_tokens": 2},
            ),
            "data: [DONE]\n\n",
        ]
        return httpx.Response(
            200,
            stream=_DelayedReasoningStream(chunks),
            headers={"content-type": "text/event-stream; charset=utf-8"},
        )

    llm = _llm(
        repositories,
        http_transport=httpx.MockTransport(handler),
        streaming=True,
        model="reasoning-first-model",
    )
    token = _request_context()
    text = ""
    try:
        async for chunk in llm.astream([HumanMessage(content="先思考再回答")]):
            if isinstance(chunk.content, str):
                text += chunk.content
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert text == "正文回答"
    assert total == 1
    record = records[0]
    assert record.status == "completed"
    assert record.response_preview == "先想一想正文回答"
    assert record.duration_ms is not None
    assert record.duration_ms >= 250
    assert record.time_to_first_token is not None
    assert record.time_to_first_token < 200


@pytest.mark.asyncio
async def test_patched_chat_openai_logs_reasoning_preview_for_tool_call_only_response(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads((await request.aread()).decode("utf-8"))
        chunks = [
            _openai_stream_chunk(payload, delta={"reasoning_content": "需要先读取文件"}),
            _openai_stream_chunk(
                payload,
                delta={
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_read",
                            "type": "function",
                            "function": {
                                "name": "read_file",
                                "arguments": "{\"path\":\"README.md\"}",
                            },
                        }
                    ]
                },
                finish_reason="tool_calls",
                usage={
                    "prompt_tokens": 12,
                    "completion_tokens": 4,
                    "prompt_tokens_details": {"cached_tokens": 8},
                },
            ),
            "data: [DONE]\n\n",
        ]
        return httpx.Response(
            200,
            stream=_DelayedReasoningStream(chunks),
            headers={"content-type": "text/event-stream; charset=utf-8"},
        )

    llm = _llm(
        repositories,
        http_transport=httpx.MockTransport(handler),
        streaming=True,
        model="reasoning-tool-call-model",
    )
    token = _request_context()
    try:
        async for _chunk in llm.astream([HumanMessage(content="读取 README")]):
            pass
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert total == 1
    record = records[0]
    assert record.status == "completed"
    assert record.input_tokens == 12
    assert record.cache_read_tokens == 8
    assert record.output_tokens == 4
    assert record.response_preview == '需要先读取文件\n工具调用: read_file({"path":"README.md"})'
    assert record.duration_ms is not None
    assert record.duration_ms >= 1
    assert record.time_to_first_token is not None
    assert record.time_to_first_token >= 1
    assert record.time_to_first_token <= record.duration_ms


@pytest.mark.asyncio
async def test_patched_chat_openai_logs_streaming_tool_call_preview_without_reasoning(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)

    async def handler(request: httpx.Request) -> httpx.Response:
        payload = json.loads((await request.aread()).decode("utf-8"))
        chunks = [
            _openai_stream_chunk(
                payload,
                delta={
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_search",
                            "type": "function",
                            "function": {
                                "name": "search_docs",
                                "arguments": "{\"query\":\"缓存命中率\"}",
                            },
                        }
                    ]
                },
                finish_reason="tool_calls",
                usage={"prompt_tokens": 10, "completion_tokens": 3},
            ),
            "data: [DONE]\n\n",
        ]
        return httpx.Response(
            200,
            stream=_DelayedReasoningStream(chunks),
            headers={"content-type": "text/event-stream; charset=utf-8"},
        )

    llm = _llm(
        repositories,
        http_transport=httpx.MockTransport(handler),
        streaming=True,
        model="tool-call-stream-model",
    )
    token = _request_context()
    try:
        async for _chunk in llm.astream([HumanMessage(content="搜索缓存命中率")]):
            pass
    finally:
        reset_request_context(token)

    records, total = repositories.llm_request_logs.list()
    assert total == 1
    record = records[0]
    assert record.status == "completed"
    assert record.input_tokens == 10
    assert record.output_tokens == 3
    assert record.response_preview == '工具调用: search_docs({"query":"缓存命中率"})'
    assert record.time_to_first_token is not None
    assert record.duration_ms is not None
    assert record.time_to_first_token <= record.duration_ms


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses_llm",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    repositories.trace_records.create(
        trace_id="trace_llm",
        session_id="ses_llm",
        active_session_id="ses_llm",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=3,
        root_node_id="trace_llm-root",
    )
    return repositories


def _request_context(
    user_message: str = "这一轮用户消息",
    dispatcher: EventDispatcher | None = None,
):
    return set_request_context(
        trace_id="trace_llm",
        session_id="ses_llm",
        active_session_id="ses_llm",
        user_id="local-user",
        turn_index=3,
        user_message=user_message,
        event_dispatcher=dispatcher,
    )


def _llm(
    repositories: StorageRepositories,
    *,
    http_transport: httpx.BaseTransport | httpx.AsyncBaseTransport,
    streaming: bool,
    model: str,
) -> Any:
    factory = AgentFactory()
    return factory.get_or_create_llm(
        ModelSettings(
            base_url="http://e2e-model.test/v1",
            api_key="sk-test",
            model=model,
        ),
        model=model,
        http_transport=http_transport,
        streaming=streaming,
        llm_request_logs=repositories.llm_request_logs,
        provider_id="provider-1",
        provider_name="测试供应商",
    )


class _DelayedReasoningStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[str]) -> None:
        self.chunks = chunks

    async def __aiter__(self):
        for index, chunk in enumerate(self.chunks):
            if index == 1:
                await asyncio.sleep(0.3)
            yield chunk.encode("utf-8")


class _TimeoutAfterChunksStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[str]) -> None:
        self.chunks = chunks
        self.tail_read_attempted = False
        self.closed = False

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk.encode("utf-8")
        self.tail_read_attempted = True
        raise httpx.ReadTimeout("stream tail stalled")

    async def aclose(self) -> None:
        self.closed = True


def _openai_stream_chunk(
    request_payload: dict[str, Any],
    *,
    delta: dict[str, Any],
    finish_reason: str | None = None,
    usage: dict[str, int] | None = None,
) -> str:
    payload: dict[str, Any] = {
        "id": "chatcmpl-reasoning-first",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": str(request_payload.get("model") or "reasoning-first-model"),
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if usage is not None:
        payload["usage"] = usage
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _openai_usage_stream_chunk(
    request_payload: dict[str, Any],
    *,
    usage: dict[str, int],
) -> str:
    payload = {
        "id": "chatcmpl-reasoning-first",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": str(request_payload.get("model") or "reasoning-first-model"),
        "choices": [],
        "usage": usage,
    }
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"
