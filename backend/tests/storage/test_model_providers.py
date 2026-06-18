from backend.app.core.time import to_iso_z, utc_now
from backend.app.storage import (
    ModelProviderRecord,
    StorageRepositories,
    init_database,
    legacy_model_provider_from_settings,
)


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _provider() -> ModelProviderRecord:
    now = to_iso_z(utc_now())
    return ModelProviderRecord(
        id="provider-1",
        name="主模型",
        base_url="https://api.example/v1",
        api_key="sk-secret",
        enabled=True,
        models=["qwen-coder", "deepseek-coder"],
        model_enabled={"qwen-coder": True, "deepseek-coder": False},
        health={"qwen-coder": {"status": "healthy"}},
        created_at=now,
        updated_at=now,
    )


def test_model_provider_repository_crud_and_default(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    provider = _provider()

    repositories.model_providers.upsert(provider)
    repositories.model_providers.set_default(
        scope="global",
        provider_id=provider.id,
        model="qwen-coder",
    )

    saved = repositories.model_providers.get(provider.id)
    assert saved == provider
    assert repositories.model_providers.list() == [provider]
    assert repositories.model_providers.get_default() is not None
    assert repositories.model_providers.get_default().model == "qwen-coder"

    assert repositories.model_providers.delete(provider.id) is True
    assert repositories.model_providers.get(provider.id) is None
    assert repositories.model_providers.get_default() is None


def test_legacy_settings_can_map_to_single_provider() -> None:
    provider = legacy_model_provider_from_settings(
        {
            "base_url": "https://api.example/v1/",
            "api_key": "sk-secret",
            "model": "qwen-coder",
        }
    )

    assert provider is not None
    assert provider.id == "legacy-openai-compatible"
    assert provider.base_url == "https://api.example/v1"
    assert provider.api_key == "sk-secret"
    assert provider.models == ["qwen-coder"]
    assert provider.model_enabled == {"qwen-coder": True}


def test_empty_legacy_settings_do_not_create_fake_provider() -> None:
    assert legacy_model_provider_from_settings({}) is None
