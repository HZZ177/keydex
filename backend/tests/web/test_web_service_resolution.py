from __future__ import annotations

import pytest

from backend.app.storage import StorageRepositories, init_database
from backend.app.web.config import WebProviderConfigField
from backend.app.web.errors import WebProviderError
from backend.app.web.models import WebCapability
from backend.app.web.provider import BaseWebProvider, WebProviderDescriptor
from backend.app.web.registry import WebProviderRegistry
from backend.app.web.service import WebService


class SearchOnlyProvider(BaseWebProvider):
    descriptor = WebProviderDescriptor(
        provider_id="search-only",
        display_name="Search Only",
        description="仅支持搜索",
        capabilities=frozenset({WebCapability.SEARCH}),
        config_fields=(
            WebProviderConfigField(
                key="api_key",
                field_type="secret",
                label="API Key",
                required=True,
            ),
        ),
    )


class FullProvider(BaseWebProvider):
    descriptor = WebProviderDescriptor(
        provider_id="full",
        display_name="Full",
        description="支持搜索与读取",
        capabilities=frozenset({WebCapability.SEARCH, WebCapability.FETCH}),
        config_fields=SearchOnlyProvider.descriptor.config_fields,
    )


def _service(tmp_path) -> tuple[WebService, StorageRepositories]:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    registry = WebProviderRegistry((SearchOnlyProvider(), FullProvider()))
    return WebService(repositories, registry), repositories


def _enable(
    repositories: StorageRepositories,
    provider_id: str,
    *,
    api_key: str | None,
) -> None:
    if api_key is not None:
        repositories.web_settings.upsert_provider(
            provider_id,
            config={},
            secrets={"api_key": api_key},
        )
    repositories.web_settings.save(
        enabled=True,
        active_provider_id=provider_id,
        providers={},
    )


def test_web_service_rejects_disabled_web(tmp_path) -> None:
    service, _repositories = _service(tmp_path)

    with pytest.raises(WebProviderError) as caught:
        service.resolve(WebCapability.SEARCH)

    assert caught.value.code == "web_disabled"
    assert service.available_capabilities() == frozenset()


def test_web_service_rejects_unknown_selected_provider(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    _enable(repositories, "removed-provider", api_key=None)

    with pytest.raises(WebProviderError) as caught:
        service.resolve(WebCapability.SEARCH)

    assert caught.value.code == "provider_not_selected"


def test_web_service_rejects_missing_required_secret(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    _enable(repositories, "full", api_key=None)

    with pytest.raises(WebProviderError) as caught:
        service.resolve(WebCapability.SEARCH)

    assert caught.value.code == "provider_not_configured"


def test_web_service_distinguishes_unsupported_capability(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    _enable(repositories, "search-only", api_key="search-key")

    search = service.resolve(WebCapability.SEARCH)
    with pytest.raises(WebProviderError) as caught:
        service.resolve(WebCapability.FETCH)

    assert search.provider.descriptor.provider_id == "search-only"
    assert caught.value.code == "unsupported_capability"
    assert service.available_capabilities() == frozenset({WebCapability.SEARCH})


def test_web_service_resolves_valid_provider_without_storing_secret_on_service(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    raw = "runtime-only-secret"
    _enable(repositories, "full", api_key=raw)

    resolved = service.resolve(WebCapability.FETCH)

    assert resolved.provider.descriptor.provider_id == "full"
    assert resolved.context.secrets == {"api_key": raw}
    assert raw not in repr(service)
    assert raw not in repr(resolved)
    assert service.available_capabilities() == frozenset(
        {WebCapability.SEARCH, WebCapability.FETCH}
    )


def test_web_service_switches_provider_on_next_resolution(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    _enable(repositories, "full", api_key="full-key")
    first = service.resolve(WebCapability.SEARCH)
    _enable(repositories, "search-only", api_key="search-key")

    second = service.resolve(WebCapability.SEARCH)

    assert first.provider.descriptor.provider_id == "full"
    assert second.provider.descriptor.provider_id == "search-only"


def test_web_service_reads_updated_config_only_for_next_call(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    _enable(repositories, "full", api_key="first-key")
    first = service.resolve(WebCapability.SEARCH)
    repositories.web_settings.upsert_provider(
        "full",
        config={},
        secrets={"api_key": "second-key"},
    )

    second = service.resolve(WebCapability.SEARCH)

    assert first.context.secrets == {"api_key": "first-key"}
    assert second.context.secrets == {"api_key": "second-key"}
    with pytest.raises(TypeError):
        first.context.secrets["api_key"] = "mutated"  # type: ignore[index]


def test_web_service_snapshot_keeps_turn_config_until_next_snapshot(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    _enable(repositories, "full", api_key="first-key")

    first_turn = service.snapshot()
    repositories.web_settings.upsert_provider(
        "full",
        config={},
        secrets={"api_key": "second-key"},
    )
    second_turn = service.snapshot()

    assert first_turn.resolved[WebCapability.SEARCH].context.secrets == {
        "api_key": "first-key"
    }
    assert second_turn.resolved[WebCapability.SEARCH].context.secrets == {
        "api_key": "second-key"
    }
    assert first_turn.available_capabilities() == frozenset(
        {WebCapability.SEARCH, WebCapability.FETCH}
    )


def test_web_service_safely_reports_corrupt_provider_config(tmp_path) -> None:
    service, repositories = _service(tmp_path)
    _enable(repositories, "full", api_key="valid-key")
    with repositories.db.connect() as conn:
        conn.execute(
            "update web_provider_configs set secrets_json = '[' where provider_id = 'full'"
        )

    with pytest.raises(WebProviderError) as caught:
        service.resolve(WebCapability.SEARCH)

    assert caught.value.code == "provider_not_configured"
