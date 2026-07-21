from __future__ import annotations

from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path):
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _session(repositories: StorageRepositories, session_id: str, user_id: str = "user-1") -> None:
    repositories.sessions.create(
        session_id=session_id,
        user_id=user_id,
        scene_id="scene-1",
    )


def test_tool_result_artifact_schema_is_idempotent_and_indexed(tmp_path) -> None:
    database = init_database(tmp_path / "app.db")
    database.init_schema()
    with database.connect() as conn:
        artifact_columns = {
            row["name"] for row in conn.execute("pragma table_info(tool_result_artifacts)")
        }
        grant_columns = {
            row["name"] for row in conn.execute("pragma table_info(tool_result_artifact_grants)")
        }
        indexes = {
            row["name"] for row in conn.execute("pragma index_list(tool_result_artifacts)")
        }
    assert {
        "id",
        "owner_user_id",
        "source_session_id",
        "tool_call_id",
        "tool_name",
        "storage_kind",
        "relative_path",
        "content_sha256",
        "content_bytes",
        "approximate_tokens",
        "is_complete",
        "status",
    }.issubset(artifact_columns)
    assert {"artifact_id", "session_id", "created_at"} == grant_columns
    assert "idx_tool_result_artifacts_owner_status" in indexes
    assert "idx_tool_result_artifacts_source_session" in indexes


def test_artifact_repository_create_find_grant_and_status_round_trip(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _session(repositories, "session-1")
    repo = repositories.tool_result_artifacts
    created = repo.create_or_get(
        artifact_id="tra-first",
        owner_user_id="user-1",
        source_session_id="session-1",
        tool_call_id="call-1",
        tool_name="search_text",
        storage_kind="managed_json",
        relative_path="context/tra-first.json",
        content_type="application/json",
        content_sha256="a" * 64,
        content_bytes=120,
        approximate_tokens=30,
    )
    duplicate = repo.create_or_get(
        artifact_id="tra-second",
        owner_user_id="user-1",
        source_session_id="session-1",
        tool_call_id="call-1",
        tool_name="search_text",
        storage_kind="managed_json",
        relative_path="context/tra-second.json",
        content_type="application/json",
        content_sha256="a" * 64,
        content_bytes=120,
        approximate_tokens=30,
    )
    repo.grant(artifact_id=created.id, session_id="session-1")
    repo.grant(artifact_id=created.id, session_id="session-1")

    assert created.id == duplicate.id == "tra-first"
    assert repo.find_by_source(
        source_session_id="session-1",
        tool_call_id="call-1",
        content_sha256="a" * 64,
    ) == created
    assert repo.has_grant(artifact_id=created.id, session_id="session-1") is True
    assert repo.grant_count(created.id) == 1
    assert [item.id for item in repo.list_for_session("session-1")] == [created.id]
    assert repo.set_status(created.id, "quarantined").status == "quarantined"
    assert repo.set_status(created.id, "deleted").deleted_at is not None


def test_artifact_status_update_reads_from_caller_transaction(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _session(repositories, "session-1")
    created = repositories.tool_result_artifacts.create_or_get(
        artifact_id="tra-transaction",
        owner_user_id="user-1",
        source_session_id="session-1",
        tool_call_id="call-transaction",
        tool_name="search_text",
        storage_kind="managed_text",
        relative_path="tool-results/context/tra-transaction.txt",
        content_type="text/plain; charset=utf-8",
        content_sha256="b" * 64,
        content_bytes=1,
        approximate_tokens=1,
    )

    with repositories.db.transaction() as conn:
        updated = repositories.tool_result_artifacts.set_status(
            created.id,
            "quarantined",
            connection=conn,
        )
        assert updated is not None
        assert updated.status == "quarantined"
