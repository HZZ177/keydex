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
                            "name": "search_mcp_tools",
                            "description": "Search deferred MCP tools.",
                            "parameters": {"type": "object"},
                        },
                    },
                    {
                        "type": "function",
                        "function": {
                            "name": "list_mcp_tools",
                            "description": "List deferred MCP tools.",
                            "parameters": {"type": "object"},
                        },
                    },
                ],
            },
        )

    body = response.text
    assert response.status_code == 200
    assert "search_mcp_tools" in body
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
                                "id": "call_e2e_mcp_deferred_search_read_fixture",
                                "type": "function",
                                "function": {
                                    "name": "search_mcp_tools",
                                    "arguments": "{\"query\":\"read_fixture\",\"limit\":10}",
                                },
                            }
                        ],
                    },
                    {
                        "role": "tool",
                        "tool_call_id": "call_e2e_mcp_deferred_search_read_fixture",
                        "content": "{\"tools\":[{\"model_name\":\"mcp__srv_e2e__read_fixture\"}]}",
                    },
                    {"role": "user", "content": "MCP Deferred call read_fixture"},
                ],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "search_mcp_tools",
                            "description": "Search deferred MCP tools.",
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
