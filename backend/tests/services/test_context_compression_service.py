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
    assemble_turn_ledger_summary,
    build_compaction_prompt,
    extract_summary_text,
    parse_compaction_summary,
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
    assert "每个 ID 输出且只输出一条" in content
    assert "请使用简体中文" in content
    assert "当前可见早期历史前缀" in content
    assert "用户说了什么" in content
    assert "Agent 做了什么" in content
    assert "不得把两个 TURN" in content


def test_compaction_prompt_appends_safe_optional_instructions() -> None:
    assert build_compaction_prompt("").human_message.content == COMPACTION_PROMPT
    content = str(build_compaction_prompt("重点保留数据库迁移结论").human_message.content)
    assert content.startswith(COMPACTION_PROMPT)
    assert "仅补充每条记录的保留重点，不改变逐条输出协议" in content
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


def test_parse_and_assemble_summary_keeps_every_expected_turn_in_order() -> None:
    parsed = parse_compaction_summary(
        """
<记录 id="TURN-0001">第一轮详情</记录>
<记录 id="TURN-0002">第二轮详情</记录>
<当前状态>继续第二轮目标</当前状态>
""",
        expected_record_ids=["TURN-0001", "TURN-0002"],
    )
    assert parsed.missing_record_ids == ()
    summary = assemble_turn_ledger_summary(
        previous_records=[],
        new_records=parsed.records,
        current_state=parsed.current_state,
    )
    assert summary.index("### TURN-0001") < summary.index("### TURN-0002")
    assert "继续第二轮目标" in summary


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
    assert "### TURN-0001" in result.summary
    assert "继续实现" in result.summary
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
            AIMessage(
                content=(
                    '<摘要><记录 id="TURN-0001">最终摘要</记录>'
                    '<当前状态>继续执行</当前状态></摘要>'
                )
            ),
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
    assert "### TURN-0001" in result.summary
    assert "最终摘要" in result.summary
    assert result.attempt_count == CONTEXT_COMPRESSION_MAX_ATTEMPTS
    assert result.requested_max_output_tokens == 20_000
    assert result.actual_output_chars == len(result.summary)
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
    assert events[-1].payload["metadata"]["actual_output_chars"] == len(result.summary)
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
async def test_unstructured_summary_uses_local_repair_then_host_fallback(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _prepare_chat_model(repositories)
    session = repositories.sessions.create(
        session_id="ses_short",
        user_id="local-user",
        scene_id="desktop-agent",
        title="会话",
    )
    llm = SequenceLLM(
        [AIMessage(content="简短但没有逐轮结构"), AIMessage(content="仍未按协议输出")]
    )
    result = await ContextCompressionService(
        repositories, factory=FakeFactory(llm)
    ).generate_compression_result(
        session=session,
        messages=[HumanMessage(content="压缩")],
        reason="manual",
    )
    assert result.success is True
    assert "### TURN-0001" in result.summary
    assert "压缩" in result.summary
    assert result.fallback_record_count == 1
    assert result.attempt_count == 2
    assert len(llm.calls) == 2


@pytest.mark.asyncio
async def test_missing_turn_is_repaired_without_rewriting_completed_records(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _prepare_chat_model(repositories)
    session = repositories.sessions.create(
        session_id="ses-repair",
        user_id="local-user",
        scene_id="desktop-agent",
        title="repair",
    )
    llm = SequenceLLM(
        [
            AIMessage(
                content=(
                    '<摘要><记录 id="TURN-0001">第一轮完整详情</记录>'
                    '<当前状态>正在处理第二轮</当前状态></摘要>'
                )
            ),
            AIMessage(
                content='<摘要><记录 id="TURN-0002">第二轮补写详情</记录></摘要>'
            ),
        ]
    )
    result = await ContextCompressionService(
        repositories, factory=FakeFactory(llm)
    ).generate_compression_result(
        session=session,
        messages=[
            HumanMessage(id="u1", content="第一轮"),
            AIMessage(id="a1", content="第一轮结果"),
            HumanMessage(id="u2", content="第二轮"),
            AIMessage(id="a2", content="第二轮结果"),
        ],
        reason="manual",
    )
    assert result.success is True
    assert result.fallback_record_count == 0
    assert result.attempt_count == 2
    assert result.summary.index("第一轮完整详情") < result.summary.index("第二轮补写详情")


@pytest.mark.asyncio
async def test_second_compaction_preserves_prior_turn_record_and_only_appends_new_turn(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _prepare_chat_model(repositories)
    session = repositories.sessions.create(
        session_id="ses-incremental",
        user_id="local-user",
        scene_id="desktop-agent",
        title="incremental",
    )
    llm = SequenceLLM(
        [
            AIMessage(
                content=(
                    '<摘要><记录 id="TURN-0001">第一轮不可改写的细节</记录>'
                    '<当前状态>第一轮完成</当前状态></摘要>'
                )
            ),
            AIMessage(
                content=(
                    '<摘要><记录 id="TURN-0002">第二轮新增细节</记录>'
                    '<当前状态>第二轮完成</当前状态></摘要>'
                )
            ),
        ]
    )
    service = ContextCompressionService(repositories, factory=FakeFactory(llm))
    first = await service.generate_compression_result(
        session=session,
        messages=[HumanMessage(id="u1", content="第一轮"), AIMessage(content="第一轮结果")],
        reason="manual",
        boundary_id="b1",
    )
    assert first.success is True and first.replacement_messages
    second = await service.generate_compression_result(
        session=session,
        messages=[
            *first.replacement_messages,
            HumanMessage(id="u2", content="第二轮"),
            AIMessage(content="第二轮结果"),
        ],
        reason="manual",
        boundary_id="b2",
    )
    assert second.success is True
    assert second.summary.count("第一轮不可改写的细节") == 1
    assert second.summary.count("第二轮新增细节") == 1
    assert "TURN-0002" in str(llm.calls[1][0].content)
    assert "第一轮不可改写的细节" not in str(llm.calls[1][0].content)


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
            content=(
                '<摘要><记录 id="TURN-0001">'
                '用户说了什么：继续实现\nAgent 做了什么：已完成一部分\n'
                '结果、错误与验证：保留当前结果\n本轮结束状态：继续推进'
                '</记录><当前状态>继续当前目标</当前状态></摘要>'
            ),
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
