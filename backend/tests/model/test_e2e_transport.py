import json

import httpx
import pytest
from langchain_core.messages import AIMessage, HumanMessage

from backend.app.agent.factory import AgentFactory
from backend.app.model import ModelSettings, OpenAICompatibleProviderClient
from backend.app.model.e2e_transport import E2E_MODEL_ID, create_e2e_model_transport


@pytest.mark.asyncio
async def test_e2e_transport_lists_models() -> None:
    provider_client = OpenAICompatibleProviderClient(
        ModelSettings(base_url="http://e2e-model.test/v1", model=E2E_MODEL_ID),
        transport=create_e2e_model_transport(delay_ms=0),
    )

    models = await provider_client.list_models(force_refresh=True)

    assert [model.id for model in models] == [E2E_MODEL_ID]


@pytest.mark.asyncio
async def test_e2e_transport_supports_health_check() -> None:
    provider_client = OpenAICompatibleProviderClient(
        ModelSettings(base_url="http://e2e-model.test/v1", model=E2E_MODEL_ID),
        transport=create_e2e_model_transport(delay_ms=0),
    )

    await provider_client.check_chat_completion(model=E2E_MODEL_ID)


@pytest.mark.asyncio
async def test_e2e_transport_drives_web_search_then_fetch_and_controlled_citation() -> None:
    transport = create_e2e_model_transport(delay_ms=0)
    base_payload = {
        "model": E2E_MODEL_ID,
        "stream": True,
        "tools": [
            {"type": "function", "function": {"name": "web_search"}},
            {"type": "function", "function": {"name": "web_fetch"}},
        ],
    }
    async with httpx.AsyncClient(base_url="http://e2e-model.test", transport=transport) as client:
        search = await client.post(
            "/v1/chat/completions",
            json={**base_payload, "messages": [{"role": "user", "content": "WebE2E SearchFetch"}]},
        )
        fetch = await client.post(
            "/v1/chat/completions",
            json={
                **base_payload,
                "messages": [
                    {"role": "user", "content": "WebE2E SearchFetch"},
                    {
                        "role": "tool",
                        "tool_call_id": "call-search",
                        "content": '{"kind":"web_search","sources":[{"source_id":"src_search","url":"https://e2e.web.test/article"}]}',
                    },
                ],
            },
        )
        answer = await client.post(
            "/v1/chat/completions",
            json={
                **base_payload,
                "messages": [
                    {"role": "user", "content": "WebE2E SearchFetch"},
                    {
                        "role": "tool",
                        "tool_call_id": "call-search",
                        "content": '{"kind":"web_search","sources":[{"source_id":"src_search","url":"https://e2e.web.test/article"}]}',
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call-fetch",
                        "content": '{"kind":"web_fetch","items":[{"source":{"source_id":"src_fetch","url":"https://e2e.web.test/article"}}]}',
                    },
                ],
            },
        )

    assert '"name": "web_search"' in search.text
    assert '"name": "web_fetch"' in fetch.text
    assert "https://e2e.web.test/article" in fetch.text
    answer_content = _sse_content(answer.text)
    assert "[[source:src_search]]" in answer_content
    assert "[[source:src_fetch]]" in answer_content


@pytest.mark.asyncio
async def test_e2e_transport_covers_web_error_partial_unknown_and_multi_search_calls() -> None:
    transport = create_e2e_model_transport(delay_ms=0)
    tools = [
        {"type": "function", "function": {"name": "web_search"}},
        {"type": "function", "function": {"name": "web_fetch"}},
    ]
    async with httpx.AsyncClient(base_url="http://e2e-model.test", transport=transport) as client:
        partial = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "tools": tools,
                "messages": [{"role": "user", "content": "WebE2E FetchPartial"}],
            },
        )
        multi = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "tools": tools,
                "messages": [{"role": "user", "content": "WebE2E MultiSearch"}],
            },
        )
        unknown = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "tools": tools,
                "messages": [
                    {"role": "user", "content": "WebE2E CitationUnknown"},
                    {
                        "role": "tool",
                        "tool_call_id": "call-search",
                        "content": '{"kind":"web_search","sources":[]}',
                    },
                ],
            },
        )

    assert partial.text.count('"name": "web_fetch"') == 1
    assert "fail.e2e.web.test" in partial.text
    assert multi.text.count('"name": "web_search"') == 2
    assert "[[source:src_not_registered]]" in _sse_content(unknown.text)


@pytest.mark.asyncio
async def test_e2e_transport_sequences_web_and_local_timeline_tools() -> None:
    transport = create_e2e_model_transport(delay_ms=0)
    tools = [
        {"type": "function", "function": {"name": "web_search"}},
        {"type": "function", "function": {"name": "read_file"}},
        {"type": "function", "function": {"name": "run_cmd"}},
    ]
    search_result = '{"kind":"web_search","sources":[{"source_id":"src_timeline"}]}'
    async with httpx.AsyncClient(base_url="http://e2e-model.test", transport=transport) as client:
        read_file = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "tools": tools,
                "messages": [{"role": "user", "content": "WebE2E Timeline"}],
            },
        )
        search = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "tools": tools,
                "messages": [
                    {"role": "user", "content": "WebE2E Timeline"},
                    {"role": "tool", "tool_call_id": "call-read", "content": "README"},
                ],
            },
        )
        command = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "tools": tools,
                "messages": [
                    {"role": "user", "content": "WebE2E Timeline"},
                    {"role": "tool", "tool_call_id": "call-read", "content": "README"},
                    {"role": "tool", "tool_call_id": "call-search", "content": search_result},
                ],
            },
        )
        answer = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "tools": tools,
                "messages": [
                    {"role": "user", "content": "WebE2E Timeline"},
                    {"role": "tool", "tool_call_id": "call-read", "content": "README"},
                    {"role": "tool", "tool_call_id": "call-search", "content": search_result},
                    {"role": "tool", "tool_call_id": "call-command", "content": "ok"},
                ],
            },
        )

    assert read_file.text.count('"name": "read_file"') == 1
    assert search.text.count('"name": "web_search"') == 1
    assert command.text.count('"name": "run_cmd"') == 1
    assert "[[source:src_timeline]]" in _sse_content(answer.text)


def _sse_content(body: str) -> str:
    events = [
        json.loads(line.removeprefix("data: "))
        for line in body.splitlines()
        if line.startswith("data: {")
    ]
    return "".join(
        str(event["choices"][0]["delta"].get("content") or "")
        for event in events
    )


@pytest.mark.asyncio
async def test_e2e_transport_can_drive_langchain_chat_completions_stream() -> None:
    llm = AgentFactory().get_or_create_llm(
        ModelSettings(
            base_url="http://e2e-model.test/v1",
            api_key="sk-test",
            model=E2E_MODEL_ID,
        ),
        model=E2E_MODEL_ID,
        http_transport=create_e2e_model_transport(delay_ms=0),
    )

    text = ""
    async for chunk in llm.astream("请输出流式 Markdown 长文"):
        content = getattr(chunk, "content", "")
        if isinstance(content, str):
            text += content

    assert text.startswith("# 流式 Markdown 验收")
    assert "最终检查点：Markdown、代码块和长文本已经完整显示。" in text


@pytest.mark.asyncio
async def test_e2e_transport_preserves_reasoning_chunks_for_langchain_stream() -> None:
    llm = AgentFactory().get_or_create_llm(
        ModelSettings(
            base_url="http://e2e-model.test/v1",
            api_key="sk-test",
            model=E2E_MODEL_ID,
        ),
        model=E2E_MODEL_ID,
        http_transport=create_e2e_model_transport(delay_ms=0),
    )

    reasoning_parts: list[str] = []
    async for chunk in llm.astream("命令审批 exact"):
        additional_kwargs = getattr(chunk, "additional_kwargs", {}) or {}
        reasoning = additional_kwargs.get("reasoning_content")
        if isinstance(reasoning, str):
            reasoning_parts.append(reasoning)

    assert "".join(reasoning_parts) == "准备执行命令审批 E2E 场景。"


@pytest.mark.asyncio
async def test_chat_openai_preserves_non_stream_reasoning_message() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-non-stream-reasoning",
                "object": "chat.completion",
                "model": "non-stream-reasoning-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": "最终回答",
                            "reasoning_content": "先分析问题",
                        },
                        "finish_reason": "stop",
                    }
                ],
            },
        )

    llm = AgentFactory().get_or_create_llm(
        ModelSettings(
            base_url="http://non-stream-reasoning.test/v1",
            api_key="sk-test",
            model="non-stream-reasoning-model",
        ),
        model="non-stream-reasoning-model",
        streaming=False,
        http_transport=httpx.MockTransport(handler),
    )

    result = await llm.ainvoke([HumanMessage(content="请回答")])

    assert result.content == "最终回答"
    assert result.additional_kwargs["reasoning_content"] == "先分析问题"


@pytest.mark.asyncio
async def test_chat_openai_round_trips_original_reasoning_field_without_duplicate_alias() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "id": "chatcmpl-duplicate-reasoning",
                "object": "chat.completion",
                "model": "duplicate-reasoning-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": None,
                            "reasoning": "需要先看目录结构",
                            "reasoning_content": "需要先看目录结构",
                            "tool_calls": [
                                {
                                    "id": "call_list_dir",
                                    "type": "function",
                                    "function": {
                                        "name": "list_dir",
                                        "arguments": "{\"depth\":2}",
                                    },
                                }
                            ],
                        },
                        "finish_reason": "tool_calls",
                    }
                ],
            },
        )

    llm = AgentFactory().get_or_create_llm(
        ModelSettings(
            base_url="http://duplicate-reasoning.test/v1",
            api_key="sk-test",
            model="duplicate-reasoning-model",
        ),
        model="duplicate-reasoning-model",
        streaming=False,
        http_transport=httpx.MockTransport(handler),
    )

    result = await llm.ainvoke([HumanMessage(content="查项目")])
    payload = llm._get_request_payload([HumanMessage(content="查项目"), result])
    request_message = payload["messages"][1]

    assert result.additional_kwargs["reasoning"] == "需要先看目录结构"
    assert result.additional_kwargs["reasoning_content"] == "需要先看目录结构"
    assert request_message["reasoning"] == "需要先看目录结构"
    assert "reasoning_content" not in request_message
    assert "__keydex_reasoning_keys__" not in request_message
    assert "__keydex_reasoning_text__" not in request_message


def test_chat_openai_round_trips_reasoning_payload_in_chat_messages() -> None:
    llm = AgentFactory().get_or_create_llm(
        ModelSettings(
            base_url="http://roundtrip-reasoning.test/v1",
            api_key="sk-test",
            model="roundtrip-reasoning-model",
        ),
        model="roundtrip-reasoning-model",
        http_transport=create_e2e_model_transport(delay_ms=0),
    )
    assistant_message = AIMessage(
        content="",
        additional_kwargs={
            "reasoning_content": "准备读取文件",
            "reasoning_details": [{"text": "detail"}],
        },
        tool_calls=[
            {
                "name": "read_file",
                "args": {"path": "README.md"},
                "id": "call_read",
                "type": "tool_call",
            }
        ],
    )

    payload = llm._get_request_payload(
        [
            HumanMessage(content="读取 README"),
            assistant_message,
            HumanMessage(content="继续"),
            AIMessage(
                content="普通回答",
                additional_kwargs={"reasoning_content": "普通回答前的思考"},
            ),
        ]
    )

    request_message = payload["messages"][1]
    assert request_message["role"] == "assistant"
    assert request_message["reasoning_content"] == "准备读取文件"
    assert request_message["reasoning_details"] == [{"text": "detail"}]
    assert request_message["tool_calls"][0]["id"] == "call_read"
    assert payload["messages"][3]["reasoning_content"] == "普通回答前的思考"


def test_chat_openai_deduplicates_reasoning_aliases_without_capture_metadata() -> None:
    llm = AgentFactory().get_or_create_llm(
        ModelSettings(
            base_url="http://roundtrip-reasoning.test/v1",
            api_key="sk-test",
            model="roundtrip-reasoning-model",
        ),
        model="roundtrip-reasoning-model",
        http_transport=create_e2e_model_transport(delay_ms=0),
    )
    assistant_message = AIMessage(
        content="",
        additional_kwargs={
            "reasoning": "同一段思考",
            "reasoning_content": "同一段思考",
        },
    )

    payload = llm._get_request_payload(
        [HumanMessage(content="继续"), assistant_message]
    )
    request_message = payload["messages"][1]

    assert request_message["reasoning"] == "同一段思考"
    assert "reasoning_content" not in request_message


@pytest.mark.asyncio
async def test_e2e_transport_command_approval_ignores_old_tool_messages() -> None:
    async with httpx.AsyncClient(
        base_url="http://e2e-model.test",
        transport=create_e2e_model_transport(delay_ms=0),
    ) as client:
        response = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "messages": [
                    {"role": "user", "content": "命令审批 exact"},
                    {"role": "tool", "content": "old result", "tool_call_id": "old-call"},
                    {"role": "user", "content": "命令审批 exact-different"},
                ],
            },
        )

    body = response.text
    assert response.status_code == 200
    assert "run_cmd" in body
    assert "e2e-approval-exact-different" in body


@pytest.mark.asyncio
async def test_e2e_transport_can_drive_mcp_tool_calls_from_injected_tools() -> None:
    async with httpx.AsyncClient(
        base_url="http://e2e-model.test",
        transport=create_e2e_model_transport(delay_ms=0),
    ) as client:
        response = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "messages": [{"role": "user", "content": "MCP Runtime read_fixture"}],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "mcp__srv_e2e__read_fixture",
                            "description": "Read an E2E fixture value.",
                            "parameters": {"type": "object"},
                        },
                    }
                ],
            },
        )

    body = response.text
    assert response.status_code == 200
    assert "mcp__srv_e2e__read_fixture" in body
    assert "runtime-snapshot" in body
    assert "finish_reason\": \"tool_calls" in body


@pytest.mark.asyncio
async def test_e2e_transport_can_drive_mcp_deferred_search_tool() -> None:
    async with httpx.AsyncClient(
        base_url="http://e2e-model.test",
        transport=create_e2e_model_transport(delay_ms=0),
    ) as client:
        response = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "messages": [{"role": "user", "content": "MCP Deferred search read_fixture"}],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "discover_mcp_tools",
                            "description": "Discover MCP tools.",
                            "parameters": {"type": "object"},
                        },
                    },
                ],
            },
        )

    body = response.text
    assert response.status_code == 200
    assert "discover_mcp_tools" in body
    assert "read_fixture" in body
    assert "finish_reason\": \"tool_calls" in body


@pytest.mark.asyncio
async def test_e2e_transport_can_drive_mcp_deferred_activated_tool_next_turn() -> None:
    async with httpx.AsyncClient(
        base_url="http://e2e-model.test",
        transport=create_e2e_model_transport(delay_ms=0),
    ) as client:
        response = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "messages": [
                    {"role": "user", "content": "MCP Deferred search read_fixture"},
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "call_e2e_mcp_deferred_discover_read_fixture",
                                "type": "function",
                                "function": {
                                    "name": "discover_mcp_tools",
                                    "arguments": "{\"query\":\"read_fixture\",\"limit\":10}",
                                },
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_e2e_mcp_deferred_discover_read_fixture",
                        "content": "{\"tools\":[{\"model_name\":\"mcp__srv_e2e__read_fixture\"}]}",
                    },
                    {"role": "user", "content": "MCP Deferred call read_fixture"},
                ],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "discover_mcp_tools",
                            "description": "Discover MCP tools.",
                            "parameters": {"type": "object"},
                        },
                    },
                    {
                        "type": "function",
                        "function": {
                            "name": "mcp__srv_e2e__read_fixture",
                            "description": "Read an E2E fixture value.",
                            "parameters": {"type": "object"},
                        },
                    },
                ],
            },
        )

    body = response.text
    assert response.status_code == 200
    assert "mcp__srv_e2e__read_fixture" in body
    assert "runtime-snapshot" in body
    assert "finish_reason\": \"tool_calls" in body


@pytest.mark.asyncio
async def test_e2e_transport_can_discover_and_call_target_from_59_mcp_tools() -> None:
    target_raw_name = "tool_58"
    target_model_name = f"mcp__srv_e2e__{target_raw_name}"
    discovery_tool = {
        "type": "function",
        "function": {
            "name": "discover_mcp_tools",
            "description": "Discover 59 MCP tools.",
            "parameters": {"type": "object"},
        },
    }
    direct_tools = [
        {
            "type": "function",
            "function": {
                "name": f"mcp__srv_e2e__tool_{index:02d}",
                "description": f"Direct MCP tool {index:02d}.",
                "parameters": {"type": "object"},
            },
        }
        for index in range(5)
    ]

    async with httpx.AsyncClient(
        base_url="http://e2e-model.test",
        transport=create_e2e_model_transport(delay_ms=0),
    ) as client:
        search_response = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "messages": [{"role": "user", "content": "MCP Deferred search tool_58"}],
                "tools": [discovery_tool, *direct_tools],
            },
        )
        call_response = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "messages": [
                    {"role": "user", "content": "MCP Deferred search tool_58"},
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "call_e2e_mcp_deferred_discover_tool_58",
                                "type": "function",
                                "function": {
                                    "name": "discover_mcp_tools",
                                    "arguments": json.dumps(
                                        {"query": target_raw_name, "limit": 10},
                                        separators=(",", ":"),
                                    ),
                                },
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_e2e_mcp_deferred_discover_tool_58",
                        "content": json.dumps(
                            {"tools": [{"model_name": target_model_name}]},
                            separators=(",", ":"),
                        ),
                    },
                    {"role": "user", "content": "MCP Deferred call tool_58"},
                ],
                "tools": [
                    discovery_tool,
                    *direct_tools,
                    {
                        "type": "function",
                        "function": {
                            "name": target_model_name,
                            "description": "Activated MCP target tool.",
                            "parameters": {"type": "object"},
                        },
                    },
                ],
            },
        )

    search_body = search_response.text
    call_body = call_response.text
    assert search_response.status_code == 200
    assert "discover_mcp_tools" in search_body
    assert target_raw_name in search_body
    assert target_model_name not in search_body
    assert "finish_reason\": \"tool_calls" in search_body
    assert call_response.status_code == 200
    assert target_model_name in call_body
    assert "runtime-snapshot" in call_body
    assert "finish_reason\": \"tool_calls" in call_body


@pytest.mark.asyncio
async def test_e2e_transport_delays_mcp_live_guard_tool_call() -> None:
    async with httpx.AsyncClient(
        base_url="http://e2e-model.test",
        transport=create_e2e_model_transport(delay_ms=0),
    ) as client:
        response = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "messages": [
                    {
                        "role": "user",
                        "content": "MCP Runtime live-guard read_fixture delay-tool-call",
                    }
                ],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "mcp__srv_e2e__read_fixture",
                            "description": "Read an E2E fixture value.",
                            "parameters": {"type": "object"},
                        },
                    }
                ],
            },
        )

    body = response.text
    assert response.status_code == 200
    assert body.count("MCP Runtime snapshot freeze wait") == 24
    assert body.index("MCP Runtime snapshot freeze wait") < body.index(
        "mcp__srv_e2e__read_fixture"
    )


@pytest.mark.asyncio
async def test_e2e_transport_finishes_mcp_scenario_after_tool_result() -> None:
    async with httpx.AsyncClient(
        base_url="http://e2e-model.test",
        transport=create_e2e_model_transport(delay_ms=0),
    ) as client:
        response = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": True,
                "messages": [
                    {"role": "user", "content": "MCP Runtime read_fixture"},
                    {
                        "role": "assistant",
                        "tool_calls": [
                            {
                                "id": "call_e2e_mcp_read_fixture",
                                "type": "function",
                                "function": {
                                    "name": "mcp__srv_e2e__read_fixture",
                                    "arguments": "{\"key\":\"runtime-snapshot\"}",
                                },
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_e2e_mcp_read_fixture",
                        "content": "{\"ok\":true}",
                    },
                ],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "mcp__srv_e2e__read_fixture",
                            "description": "Read an E2E fixture value.",
                            "parameters": {"type": "object"},
                        },
                    }
                ],
            },
        )

    body = response.text
    assert response.status_code == 200
    assert "MCP Runtime" in body
    assert "read_fixture" in body
    assert "tool_calls" not in body


@pytest.mark.asyncio
async def test_e2e_transport_returns_deterministic_side_task_outputs() -> None:
    async with httpx.AsyncClient(
        base_url="http://e2e-model.test",
        transport=create_e2e_model_transport(delay_ms=0),
    ) as client:
        title_response = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": False,
                "messages": [
                    {
                        "role": "user",
                        "content": "用户首轮问题：整理计划\n助手最终回复：已完成计划",
                    }
                ],
            },
        )
        compression_response = await client.post(
            "/v1/chat/completions",
            json={
                "model": E2E_MODEL_ID,
                "stream": False,
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            "请为下面的历史消息生成上下文压缩摘要，"
                            "供后续 agent 继续任务使用。"
                        ),
                    }
                ],
            },
        )

    assert title_response.status_code == 200
    assert title_response.json()["choices"][0]["message"]["content"] == "E2E 自动标题"
    assert compression_response.status_code == 200
    assert "E2E 压缩摘要" in compression_response.json()["choices"][0]["message"]["content"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("prompt", "tool_name", "argument_name", "argument_value"),
    [
        ("e2e-rewind-both-A", "edit_file", "old_string", ""),
        ("e2e-rewind-both-B", "edit_file", "old_string", "A\n"),
        ("e2e-rewind-create-file", "create_file", "path", "created.txt"),
        ("e2e-rewind-delete", "delete_file", "path", "delete-me.txt"),
        ("e2e-rewind-move", "move_file", "new_path", "nested/target.txt"),
        ("e2e-rewind-multi-patch", "apply_patch", "patch", "*** Add File: a.txt"),
        (
            "e2e-rewind-write-cycle-missing-to-d",
            "edit_file",
            "new_string",
            "D\n",
        ),
    ],
)
async def test_e2e_transport_drives_rewind_fixtures_through_controlled_tools(
    prompt: str,
    tool_name: str,
    argument_name: str,
    argument_value: str,
) -> None:
    tools = [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": name,
                "parameters": {"type": "object"},
            },
        }
        for name in ("edit_file", "create_file", "delete_file", "move_file", "apply_patch")
    ]
    request = {
        "model": E2E_MODEL_ID,
        "stream": True,
        "messages": [{"role": "user", "content": prompt}],
        "tools": tools,
    }
    async with httpx.AsyncClient(
        base_url="http://e2e-model.test",
        transport=create_e2e_model_transport(delay_ms=0),
    ) as client:
        first = await client.post("/v1/chat/completions", json=request)
        replay = await client.post("/v1/chat/completions", json=request)

    assert first.status_code == replay.status_code == 200
    assert first.text == replay.text
    events = [
        json.loads(line.removeprefix("data: "))
        for line in first.text.splitlines()
        if line.startswith("data: {")
    ]
    functions = [
        call["function"]
        for event in events
        for call in event["choices"][0]["delta"].get("tool_calls", [])
    ]
    assert len(functions) == 1
    assert functions[0]["name"] == tool_name
    arguments = json.loads(functions[0]["arguments"])
    if argument_name == "patch":
        assert argument_value in arguments[argument_name]
    else:
        assert arguments[argument_name] == argument_value
