from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from backend.app.agent.factory import (
    _llm_business_max_retries,
    _llm_business_max_retries_for_run,
)
from backend.app.agent.internal_llm_events import INTERNAL_CONTEXT_COMPRESSION_TAG
from backend.app.core.time import to_iso_z, utc_now
from backend.app.model import ModelSettings
from backend.app.services.context_compression_prompt_builder import (
    COMPACTION_PROMPT,
    build_compaction_prompt,
    extract_summary_text,
)
from backend.app.services.context_compression_service import (
    CONTEXT_COMPRESSION_MAX_ATTEMPTS,
    CONTEXT_COMPRESSION_REQUEST_TIMEOUT_SECONDS,
    ContextCompressionService,
)
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    MODEL_DEFAULT_FAST,
    ModelProviderRecord,
    StorageRepositories,
    init_database,
)


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _provider(
    *, provider_id: str = "provider-chat", model: str = "chat-model"
) -> ModelProviderRecord:
    now = to_iso_z(utc_now())
    return ModelProviderRecord(
        id=provider_id,
        name="对话供应商",
        base_url="https://api.example/v1",
        api_key="sk-chat",
        enabled=True,
        models=[model],
        model_enabled={model: True},
        health={},
        created_at=now,
        updated_at=now,
    )


def _prepare_chat_model(repositories: StorageRepositories) -> None:
    provider = _provider()
    repositories.model_providers.upsert(provider)
    repositories.model_providers.set_model_default(
        scope=MODEL_DEFAULT_CHAT,
        provider_id=provider.id,
        model="chat-model",
    )


def test_compaction_prompt_is_chinese_plain_text_summary_contract() -> None:
    bundle = build_compaction_prompt()
    content = str(bundle.human_message.content)

    assert bundle.human_message.content == COMPACTION_PROMPT
    assert "不要调用" not in content
    assert "Do NOT" not in content
    assert "tools" not in content.lower()
    assert "<摘要>" in content
    assert "最初目标与请求时间线" in content
    assert "请使用简体中文" in content
    assert "当前可见的早期历史前缀" in content
    assert "第一条真实用户请求" in content
    assert "Agent 行为" in content
    assert "不要声称总结了完整会话" in content


def test_compaction_prompt_appends_safe_optional_instructions() -> None:
    assert build_compaction_prompt("").human_message.content == COMPACTION_PROMPT
    content = str(build_compaction_prompt("重点保留数据库迁移结论").human_message.content)
    assert content.startswith(COMPACTION_PROMPT)
    assert "仅补充摘要重点，不改变输出协议" in content
    assert content.endswith("重点保留数据库迁移结论")
    with pytest.raises(TypeError):
        build_compaction_prompt({"unsafe": True})  # type: ignore[arg-type]


def test_extract_summary_text_prefers_chinese_summary_block() -> None:
    text = """
<分析>
覆盖检查
</分析>

<摘要>
保留的摘要
</摘要>
"""

    assert extract_summary_text(text) == "保留的摘要"


def test_internal_compression_disables_nested_factory_business_retries() -> None:
    assert _llm_business_max_retries_for_run(
        SimpleNamespace(tags=[INTERNAL_CONTEXT_COMPRESSION_TAG], metadata={})
    ) == 0
    assert _llm_business_max_retries_for_run(
        SimpleNamespace(
            tags=[],
            metadata={"keydex_internal_context_compression": True},
        )
    ) == 0
    assert _llm_business_max_retries_for_run(
        SimpleNamespace(tags=[], metadata={})
    ) == _llm_business_max_retries()


@pytest.mark.asyncio
async def test_context_compression_service_uses_current_chat_model(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _prepare_chat_model(repositories)
    session = repositories.sessions.create(
        session_id="ses_1",
        user_id="local-user",
        scene_id="desktop-agent",
        title="会话",
        current_model_provider_id="provider-chat",
        current_model="chat-model",
    )
    llm = PromptAwareLLM()
    factory = FakeFactory(llm)
    service = ContextCompressionService(repositories, factory=factory)

    result = await service.generate_compression_result(
        session=session,
        messages=[HumanMessage(content="继续实现", id="h1"), AIMessage(content="已完成一部分")],
        reason="manual",
    )

    assert result.success is True
    assert result.summary == "新的上下文摘要"
    assert result.replacement_messages is not None
    assert len(result.replacement_messages) == 1
    assert result.model_provider_id == "provider-chat"
    assert result.model == "chat-model"
    assert factory.calls == [
        {
            "model": "chat-model",
            "streaming": False,
            "provider_id": "provider-chat",
            "timeout_seconds": CONTEXT_COMPRESSION_REQUEST_TIMEOUT_SECONDS,
            "max_tokens": 12_000,
        }
    ]
    assert llm.calls
    assert isinstance(llm.calls[0][-1], HumanMessage)
    assert "请使用简体中文" in str(llm.calls[0][-1].content)
    assert llm.configs[0]["tags"] == [INTERNAL_CONTEXT_COMPRESSION_TAG]


@pytest.mark.asyncio
async def test_context_compression_service_does_not_use_fast_default(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _prepare_chat_model(repositories)
    fast = _provider(provider_id="provider-fast", model="fast-model")
    repositories.model_providers.upsert(fast)
    repositories.model_providers.set_model_default(
        scope=MODEL_DEFAULT_FAST,
        provider_id=fast.id,
        model="fast-model",
    )
    session = repositories.sessions.create(
        session_id="ses_2",
        user_id="local-user",
        scene_id="desktop-agent",
        title="会话",
    )
    factory = FakeFactory(PromptAwareLLM())
    service = ContextCompressionService(repositories, factory=factory)

    result = await service.generate_compression_result(
        session=session,
        messages=[HumanMessage(content="压缩我")],
        reason="automatic",
    )

    assert result.success is True
    assert factory.calls[0]["model"] == "chat-model"
    assert factory.calls[0]["provider_id"] == "provider-chat"


@pytest.mark.asyncio
async def test_context_compression_service_reports_missing_chat_model(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_missing",
        user_id="local-user",
        scene_id="desktop-agent",
        title="会话",
    )
    service = ContextCompressionService(repositories, factory=FakeFactory(PromptAwareLLM()))

    result = await service.generate_compression_result(
        session=session,
        messages=[HumanMessage(content="压缩我")],
        reason="manual",
    )

    assert result.success is False
    assert result.failure_reason == "model_config_error:model_default_not_configured"


@pytest.mark.asyncio
async def test_empty_and_tool_call_results_retry_until_fourth_success(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _prepare_chat_model(repositories)
    session = repositories.sessions.create(
        session_id="ses_retry",
        user_id="local-user",
        scene_id="desktop-agent",
        title="会话",
    )
    repositories.trace_records.create(
        trace_id="trace-retry",
        session_id=session.id,
        active_session_id=session.id,
        scene_id=session.scene_id,
        user_id=session.user_id,
        turn_index=1,
        root_node_id="root-retry",
    )
    llm = SequenceLLM(
        [
            AIMessage(content=""),
            AIMessage(content=[{"type": "text", "text": "   "}]),
            AIMessage(
                content="",
                tool_calls=[{"id": "call-1", "name": "read_file", "args": {}}],
            ),
            AIMessage(content="<分析>ok</分析><摘要>最终摘要</摘要>"),
        ]
    )
    result = await ContextCompressionService(
        repositories, factory=FakeFactory(llm)
    ).generate_compression_result(
        session=session,
        messages=[HumanMessage(content="压缩")],
        reason="manual",
        max_output_tokens=30_000,
        trace_id="trace-retry",
        trace_record_id="trace-retry",
    )
    assert result.success is True
    assert result.summary == "最终摘要"
    assert result.attempt_count == CONTEXT_COMPRESSION_MAX_ATTEMPTS
    assert result.requested_max_output_tokens == 20_000
    assert result.actual_output_chars == len("最终摘要")
    assert len(llm.calls) == 4
    events = repositories.trace_event_logs.list_by_trace_record("trace-retry")
    assert [event.payload["status"] for event in events] == [
        "running",
        "attempt_failed",
        "running",
        "attempt_failed",
        "running",
        "attempt_failed",
        "running",
        "completed",
    ]
    assert [event.payload["metadata"]["attempt"] for event in events] == [
        1,
        1,
        2,
        2,
        3,
        3,
        4,
        4,
    ]
    assert events[-1].payload["metadata"]["actual_output_chars"] == len("最终摘要")
    assert "最终摘要" not in str([event.payload for event in events])


@pytest.mark.asyncio
async def test_retryable_errors_exhaust_four_attempts(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _prepare_chat_model(repositories)
    session = repositories.sessions.create(
        session_id="ses_exhausted",
        user_id="local-user",
        scene_id="desktop-agent",
        title="会话",
    )
    llm = SequenceLLM([RuntimeError("temporary")] * 4)
    result = await ContextCompressionService(
        repositories, factory=FakeFactory(llm)
    ).generate_compression_result(
        session=session,
        messages=[HumanMessage(content="压缩")],
        reason="automatic",
    )
    assert result.success is False
    assert result.failure_reason == "llm_error:temporary"
    assert result.attempt_count == 4
    assert len(llm.calls) == 4


@pytest.mark.asyncio
async def test_permission_error_is_not_retried(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _prepare_chat_model(repositories)
    session = repositories.sessions.create(
        session_id="ses_permission",
        user_id="local-user",
        scene_id="desktop-agent",
        title="会话",
    )
    llm = SequenceLLM([PermissionError("denied")])
    result = await ContextCompressionService(
        repositories, factory=FakeFactory(llm)
    ).generate_compression_result(
        session=session,
        messages=[HumanMessage(content="压缩")],
        reason="manual",
    )
    assert result.success is False
    assert result.attempt_count == 1
    assert len(llm.calls) == 1


@pytest.mark.asyncio
async def test_short_valid_summary_is_accepted_without_quality_retry(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _prepare_chat_model(repositories)
    session = repositories.sessions.create(
        session_id="ses_short",
        user_id="local-user",
        scene_id="desktop-agent",
        title="会话",
    )
    llm = SequenceLLM([AIMessage(content="简短但合法")])
    result = await ContextCompressionService(
        repositories, factory=FakeFactory(llm)
    ).generate_compression_result(
        session=session,
        messages=[HumanMessage(content="压缩")],
        reason="manual",
    )
    assert result.success is True
    assert result.summary == "简短但合法"
    assert result.attempt_count == 1
    assert len(llm.calls) == 1


@pytest.mark.asyncio
async def test_no_input_does_not_resolve_model_or_call_llm(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    factory = FakeFactory(PromptAwareLLM())
    session = repositories.sessions.create(
        session_id="ses_empty",
        user_id="local-user",
        scene_id="desktop-agent",
        title="会话",
    )
    result = await ContextCompressionService(
        repositories, factory=factory
    ).generate_compression_result(session=session, messages=[], reason="manual")
    assert result.failure_reason == "no_compressible_messages"
    assert result.attempt_count == 0
    assert factory.calls == []


class PromptAwareLLM:
    def __init__(self) -> None:
        self.calls: list[list[Any]] = []
        self.configs: list[dict[str, Any] | None] = []

    async def ainvoke(self, messages: list[Any], config: dict[str, Any] | None = None) -> AIMessage:
        self.calls.append(messages)
        self.configs.append(config)
        return AIMessage(
            content="<分析>\n检查\n</分析>\n<摘要>\n新的上下文摘要\n</摘要>",
            usage_metadata={"input_tokens": 4, "output_tokens": 2, "total_tokens": 6},
        )


class SequenceLLM(PromptAwareLLM):
    def __init__(self, outcomes: list[Any]) -> None:
        super().__init__()
        self.outcomes = list(outcomes)

    async def ainvoke(self, messages: list[Any], config: dict[str, Any] | None = None) -> AIMessage:
        self.calls.append(messages)
        self.configs.append(config)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class FakeFactory:
    def __init__(self, llm: PromptAwareLLM) -> None:
        self.llm = llm
        self.calls: list[dict[str, Any]] = []

    def get_or_create_llm(
        self,
        _settings: ModelSettings,
        **kwargs: Any,
    ) -> PromptAwareLLM:
        self.calls.append(
            {
                "model": kwargs.get("model"),
                "streaming": kwargs.get("streaming"),
                "provider_id": kwargs.get("provider_id"),
                "timeout_seconds": _settings.timeout_seconds,
                "max_tokens": kwargs.get("max_tokens"),
            }
        )
        return self.llm
