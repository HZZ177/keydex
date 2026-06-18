import httpx
import pytest

from backend.app.model import (
    ModelConfigError,
    ModelProviderError,
    ModelSettings,
    OpenAICompatibleProviderClient,
    parse_model_list,
)


def test_parse_model_list_accepts_common_shapes() -> None:
    assert [model.id for model in parse_model_list({"data": [{"id": "a"}]})] == ["a"]
    assert [model.id for model in parse_model_list([{"id": "b"}, "c"])] == ["b", "c"]
    assert parse_model_list({"unexpected": []}) == []


@pytest.mark.asyncio
async def test_list_models_normalizes_compatible_provider_base_url() -> None:
    seen_paths: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        return httpx.Response(200, json={"data": [{"id": "qwen3-coder"}]})

    provider_client = OpenAICompatibleProviderClient(
        ModelSettings(base_url="http://provider.test", model="qwen3-coder"),
        transport=httpx.MockTransport(handler),
    )

    models = await provider_client.list_models(force_refresh=True)

    assert [model.id for model in models] == ["qwen3-coder"]
    assert seen_paths == ["/v1/models"]


@pytest.mark.asyncio
async def test_list_models_requires_endpoint() -> None:
    provider_client = OpenAICompatibleProviderClient(ModelSettings())

    with pytest.raises(ModelConfigError, match="模型服务地址未配置"):
        await provider_client.list_models(force_refresh=True)


@pytest.mark.asyncio
async def test_list_models_maps_http_error_body() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"message": "invalid api key"}})

    provider_client = OpenAICompatibleProviderClient(
        ModelSettings(base_url="http://provider.test/v1"),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ModelProviderError) as exc_info:
        await provider_client.list_models(force_refresh=True)

    assert str(exc_info.value) == "刷新模型列表失败：HTTP 400：invalid api key"


@pytest.mark.asyncio
async def test_list_models_rejects_invalid_json() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"")

    provider_client = OpenAICompatibleProviderClient(
        ModelSettings(base_url="http://provider.test/v1"),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ModelProviderError, match="不是合法 JSON"):
        await provider_client.list_models(force_refresh=True)


@pytest.mark.asyncio
async def test_check_chat_completion_posts_non_stream_health_request() -> None:
    captured_payload: bytes | None = None

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal captured_payload
        assert request.method == "POST"
        assert request.url.path == "/v1/chat/completions"
        captured_payload = await request.aread()
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    provider_client = OpenAICompatibleProviderClient(
        ModelSettings(base_url="http://provider.test", api_key="sk-test"),
        transport=httpx.MockTransport(handler),
    )

    await provider_client.check_chat_completion(model="qwen3-coder")

    assert captured_payload is not None
    assert b'"model":"qwen3-coder"' in captured_payload.replace(b" ", b"")
    assert b'"stream":false' in captured_payload.replace(b" ", b"")


@pytest.mark.asyncio
async def test_check_chat_completion_maps_http_error() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": {"message": "model unavailable"}})

    provider_client = OpenAICompatibleProviderClient(
        ModelSettings(base_url="http://provider.test/v1"),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(ModelProviderError) as exc_info:
        await provider_client.check_chat_completion(model="qwen3-coder")

    assert str(exc_info.value) == "模型健康检查失败：HTTP 400：model unavailable"
