from __future__ import annotations

import sqlite3
import threading

import pytest

from backend.app.storage import (
    StorageRepositories,
    WebProviderConfigWrite,
    WebSettingsDataError,
    init_database,
)


def _repository(tmp_path):
    return StorageRepositories(init_database(tmp_path / "app.db")).web_settings


def test_web_settings_repository_reads_defaults(tmp_path) -> None:
    repository = _repository(tmp_path)

    snapshot = repository.get_snapshot()

    assert snapshot.settings.enabled is False
    assert snapshot.settings.active_provider_id == "tavily"
    assert snapshot.providers == ()


def test_web_settings_repository_keeps_provider_configs_isolated(tmp_path) -> None:
    repository = _repository(tmp_path)
    repository.upsert_provider(
        "provider-a",
        config={"region": "a"},
        secrets={"api_key": "secret-a"},
    )
    repository.upsert_provider(
        "provider-b",
        config={"region": "b"},
        secrets={"api_key": "secret-b"},
    )

    repository.save(enabled=True, active_provider_id="provider-b", providers={})
    provider_a = repository.get_provider("provider-a")
    provider_b = repository.get_provider("provider-b")

    assert provider_a is not None
    assert provider_b is not None
    assert provider_a.config == {"region": "a"}
    assert provider_a.secrets == {"api_key": "secret-a"}
    assert provider_b.config == {"region": "b"}
    assert provider_b.secrets == {"api_key": "secret-b"}


def test_web_settings_repository_restores_values_after_restart(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    repository = StorageRepositories(init_database(db_path)).web_settings
    repository.save(
        enabled=True,
        active_provider_id="provider-a",
        providers={
            "provider-a": WebProviderConfigWrite(
                config={"language": "zh"},
                secrets={"api_key": "restart-secret"},
            )
        },
    )

    restarted = StorageRepositories(init_database(db_path)).web_settings.get_snapshot()

    assert restarted.settings.enabled is True
    assert restarted.settings.active_provider_id == "provider-a"
    assert restarted.providers[0].config == {"language": "zh"}
    assert restarted.providers[0].secrets == {"api_key": "restart-secret"}


def test_web_settings_repository_saves_multiple_providers_atomically(tmp_path) -> None:
    repository = _repository(tmp_path)

    snapshot = repository.save(
        enabled=True,
        active_provider_id="provider-b",
        providers={
            "provider-a": WebProviderConfigWrite(config={"value": "a"}),
            "provider-b": WebProviderConfigWrite(config={"value": "b"}),
        },
    )

    assert snapshot.settings.active_provider_id == "provider-b"
    assert [item.provider_id for item in snapshot.providers] == ["provider-a", "provider-b"]


def test_web_settings_repository_rolls_back_all_values_on_serialization_failure(
    tmp_path,
) -> None:
    repository = _repository(tmp_path)

    with pytest.raises(TypeError):
        repository.save(
            enabled=True,
            active_provider_id="provider-b",
            providers={
                "provider-a": WebProviderConfigWrite(config={"value": "a"}),
                "provider-b": WebProviderConfigWrite(config={"invalid": object()}),
            },
        )

    snapshot = repository.get_snapshot()
    assert snapshot.settings.enabled is False
    assert snapshot.settings.active_provider_id == "tavily"
    assert snapshot.providers == ()


@pytest.mark.parametrize("column", ["config_json", "secrets_json"])
def test_web_settings_repository_reports_corrupt_json_without_leaking_value(
    tmp_path,
    column: str,
) -> None:
    repository = _repository(tmp_path)
    repository.upsert_provider("tavily", config={}, secrets={})
    leaked_value = "do-not-leak-this-value"
    with repository.db.connect() as conn:
        conn.execute(
            f"update web_provider_configs set {column} = ? where provider_id = 'tavily'",
            (f"{{{leaked_value}",),
        )

    with pytest.raises(WebSettingsDataError) as exc_info:
        repository.get_provider("tavily")

    assert exc_info.value.provider_id == "tavily"
    assert exc_info.value.field == column
    assert leaked_value not in str(exc_info.value)


def test_web_settings_repository_concurrent_writes_finish_with_complete_snapshot(tmp_path) -> None:
    repository = _repository(tmp_path)
    barrier = threading.Barrier(2)
    errors: list[Exception] = []

    def save(value: str) -> None:
        try:
            barrier.wait()
            repository.save(
                enabled=True,
                active_provider_id="tavily",
                providers={
                    "tavily": WebProviderConfigWrite(
                        config={"writer": value},
                        secrets={"api_key": f"secret-{value}"},
                    )
                },
            )
        except Exception as exc:  # pragma: no cover - assertion captures failures
            errors.append(exc)

    threads = [threading.Thread(target=save, args=(value,)) for value in ("a", "b")]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    provider = repository.get_provider("tavily")
    assert errors == []
    assert provider is not None
    assert provider.config["writer"] in {"a", "b"}
    assert provider.secrets["api_key"] == f"secret-{provider.config['writer']}"


def test_web_settings_schema_rejects_second_global_row(tmp_path) -> None:
    repository = _repository(tmp_path)

    with repository.db.connect() as conn, pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "insert into web_settings (id, enabled, active_provider_id, updated_at) "
            "values (2, 0, 'tavily', '2026-07-15T00:00:00Z')"
        )
