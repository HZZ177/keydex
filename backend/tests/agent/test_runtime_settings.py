from backend.app.agent.runtime_settings import AgentRuntimeSettings, default_agent_runtime_settings


def test_a2ui_debug_info_defaults_to_disabled() -> None:
    settings = default_agent_runtime_settings()

    assert settings.a2ui.enabled is True
    assert settings.a2ui.debug_info_enabled is False


def test_a2ui_debug_info_accepts_legacy_a2ui_settings() -> None:
    settings = AgentRuntimeSettings.model_validate({"a2ui": {"enabled": True}})

    assert settings.a2ui.enabled is True
    assert settings.a2ui.debug_info_enabled is False


def test_a2ui_debug_info_can_be_enabled() -> None:
    settings = AgentRuntimeSettings.model_validate(
        {"a2ui": {"enabled": True, "debug_info_enabled": True}}
    )

    assert settings.a2ui.debug_info_enabled is True
