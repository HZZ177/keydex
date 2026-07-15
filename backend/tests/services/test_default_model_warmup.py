from __future__ import annotations

from typing import Any

import backend.app.agent.factory as factory_module
from backend.app.agent.factory import AgentFactory
from backend.app.agent.side_task_model import create_side_task_llm
from backend.app.core.time import to_iso_z, utc_now
from backend.app.model import ModelSettings, resolve_model_default
from backend.app.services.default_model_warmup import warmup_default_models
from backend.app.services.session_title_service import (
    SESSION_TITLE_LLM_MAX_TOKENS,
    SESSION_TITLE_LLM_TEMPERATURE,
)
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    MODEL_DEFAULT_FAST,
    ModelProviderRecord,
    StorageRepositories,
    init_database,
)


def test_warmup_default_models_populates_only_the_two_default_cache_entries(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = _repositories(tmp_path)
    provider = _provider()
    repositories.model_providers.upsert(provider)
    repositories.model_providers.set_model_default(
        scope=MODEL_DEFAULT_CHAT,
        provider_id=provider.id,
        model="chat-model",
    )
    repositories.model_providers.set_model_default(
        scope=MODEL_DEFAULT_FAST,
        provider_id=provider.id,
        model="fast-model",
    )
    created: list[tuple[object, dict[str, Any]]] = []

    def fake_llm(**kwargs: Any) -> object:
        instance = object()
        created.append((instance, kwargs))
        return instance

    monkeypatch.setattr(factory_module, "PatchedChatOpenAI", fake_llm)
    factory = AgentFactory()

    result = warmup_default_models(repositories, factory=factory)

    assert result.warmed_scopes == (MODEL_DEFAULT_CHAT, MODEL_DEFAULT_FAST)
    assert result.skipped_scopes == ()
    assert [kwargs["model"] for _, kwargs in created] == ["chat-model", "fast-model"]

    chat = resolve_model_default(repositories, MODEL_DEFAULT_CHAT)
    cached_chat = factory.get_or_create_llm(
        chat.settings,
        model=chat.settings.model,
        llm_request_logs=repositories.llm_request_logs,
    )
    cached_fast = create_side_task_llm(
        repositories,
        factory=factory,
        temperature=SESSION_TITLE_LLM_TEMPERATURE,
        max_tokens=SESSION_TITLE_LLM_MAX_TOKENS,
    ).llm

    assert cached_chat is created[0][0]
    assert cached_fast is created[1][0]
    assert len(created) == 2

    manual_settings = ModelSettings(
        base_url=provider.base_url,
        api_key=provider.api_key,
        model="manual-model",
    )
    factory.get_or_create_llm(
        manual_settings,
        model="manual-model",
        llm_request_logs=repositories.llm_request_logs,
    )

    assert len(created) == 3
    assert created[2][1]["model"] == "manual-model"


def test_warmup_default_models_skips_missing_configuration(tmp_path, monkeypatch) -> None:
    repositories = _repositories(tmp_path)
    created: list[dict[str, Any]] = []

    def fake_llm(**kwargs: Any) -> object:
        created.append(kwargs)
        return object()

    monkeypatch.setattr(factory_module, "PatchedChatOpenAI", fake_llm)

    result = warmup_default_models(repositories, factory=AgentFactory())

    assert result.warmed_scopes == ()
    assert result.skipped_scopes == (MODEL_DEFAULT_CHAT, MODEL_DEFAULT_FAST)
    assert created == []


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _provider() -> ModelProviderRecord:
    now = to_iso_z(utc_now())
    return ModelProviderRecord(
        id="provider-1",
        name="测试供应商",
        base_url="https://api.example/v1",
        api_key="sk-secret",
        enabled=True,
        models=["chat-model", "fast-model", "manual-model"],
        model_enabled={},
        health={},
        created_at=now,
        updated_at=now,
    )
