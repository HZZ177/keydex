import pytest
from pydantic import ValidationError

from backend.app.agent.runtime_settings import (
    AGENT_RUNTIME_SETTINGS_KEY,
    AgentRuntimeSettings,
    ContextCompressionRuntimeSettings,
    DuplicateToolCallGuardRuntimeSettings,
    default_agent_runtime_settings,
    load_agent_runtime_settings,
    save_agent_runtime_settings,
)
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def test_agent_runtime_settings_defaults_do_not_enable_new_side_tasks() -> None:
    settings = default_agent_runtime_settings()

    assert settings.auto_title.enabled is False
    assert settings.auto_title.max_title_length == 20
    assert settings.context_compression.enabled is False
    assert settings.context_compression.context_window_tokens == 128000
    assert settings.context_compression.trigger_fraction == 0.75
    assert settings.context_compression.emergency_fraction == 0.9
    assert settings.context_compression.retain_rounds == 2
    assert settings.duplicate_tool_call_guard.enabled is True
    assert settings.duplicate_tool_call_guard.max_repeats == 3


def test_load_agent_runtime_settings_returns_hard_defaults_when_missing(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    settings = load_agent_runtime_settings(repositories)

    assert settings == default_agent_runtime_settings()


def test_save_and_load_agent_runtime_settings_round_trip(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    settings = AgentRuntimeSettings(
        auto_title={"enabled": True, "only_when_default_title": False, "max_title_length": 50},
        duplicate_tool_call_guard={"enabled": True, "max_repeats": 4},
        context_compression={
            "enabled": True,
            "context_window_tokens": 64000,
            "trigger_fraction": 0.6,
            "emergency_fraction": 0.85,
            "retain_rounds": 3,
        },
    )

    saved = save_agent_runtime_settings(repositories, settings)
    loaded = load_agent_runtime_settings(repositories)

    assert loaded == saved
    assert loaded.auto_title.max_title_length == 50
    assert loaded.duplicate_tool_call_guard.max_repeats == 4
    assert loaded.context_compression.context_window_tokens == 64000
    assert loaded.context_compression.retain_rounds == 3


def test_agent_runtime_settings_reject_invalid_boundaries() -> None:
    with pytest.raises(ValidationError):
        ContextCompressionRuntimeSettings(trigger_fraction=0.9, emergency_fraction=0.9)

    with pytest.raises(ValidationError):
        DuplicateToolCallGuardRuntimeSettings(max_repeats=0)

    with pytest.raises(ValidationError):
        AgentRuntimeSettings(auto_title={"enabled": True, "max_title_length": 2})

    with pytest.raises(ValidationError):
        AgentRuntimeSettings(auto_title={"enabled": True, "max_title_length": 51})


def test_agent_runtime_settings_reject_unknown_and_coerced_values() -> None:
    with pytest.raises(ValidationError):
        AgentRuntimeSettings(
            duplicate_tool_call_guard={"enabled": True, "max_repeats": 3, "mode": "warn"}
        )


def test_load_agent_runtime_settings_fails_loudly_for_invalid_persisted_data(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.settings.set(
        AGENT_RUNTIME_SETTINGS_KEY,
        {
            "auto_title": {
                "enabled": False,
                "only_when_default_title": True,
                "max_title_length": 20,
            },
            "duplicate_tool_call_guard": {"enabled": True, "max_repeats": 3},
            "context_compression": {
                "enabled": True,
                "context_window_tokens": 128000,
                "trigger_fraction": 0.95,
                "emergency_fraction": 0.9,
                "retain_rounds": 2,
            },
        },
    )

    with pytest.raises(ValidationError):
        load_agent_runtime_settings(repositories)


def test_load_agent_runtime_settings_drops_removed_tool_limit_config(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.settings.set(
        AGENT_RUNTIME_SETTINGS_KEY,
        {
            "auto_title": {
                "enabled": False,
                "only_when_default_title": True,
                "max_title_length": 20,
            },
            "tool_call_limit": {"enabled": True, "max_tool_calls": 8, "exit_behavior": "error"},
            "duplicate_tool_call_guard": {"enabled": True, "max_repeats": 3},
            "context_compression": {
                "enabled": False,
                "context_window_tokens": 128000,
                "trigger_fraction": 0.75,
                "emergency_fraction": 0.9,
                "retain_rounds": 2,
            },
        },
    )

    settings = load_agent_runtime_settings(repositories)

    assert settings == default_agent_runtime_settings()
