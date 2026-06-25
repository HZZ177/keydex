import httpx
import pytest

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
    assert "run_command" in body
    assert "e2e-approval-exact-different" in body
