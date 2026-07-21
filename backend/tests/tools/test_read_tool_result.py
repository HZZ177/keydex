from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.agent.tool_results.artifact_repository import ToolResultArtifactRepository
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools.base import ToolExecutionContext, ToolExecutionError
from backend.app.tools.tool_results import read_tool_result


def _setup(tmp_path: Path):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    for session_id, user_id in (
        ("session-1", "user-1"),
        ("session-2", "user-1"),
        ("session-other", "user-2"),
    ):
        repositories.sessions.create(
            session_id=session_id,
            user_id=user_id,
            scene_id="scene-1",
        )
    data_dir = tmp_path / "data"
    owner_context = ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=1,
        metadata={"tool_call_id": "call-1"},
    )
    artifact_repo = ToolResultArtifactRepository(
        repositories=repositories,
        data_dir=data_dir,
    )
    return repositories, data_dir, owner_context, artifact_repo


def _read_context(
    tmp_path: Path,
    repositories: StorageRepositories,
    data_dir: Path,
    *,
    session_id: str = "session-1",
    user_id: str = "user-1",
) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id=session_id,
        user_id=user_id,
        workspace_root=tmp_path,
        turn_index=1,
        metadata={"repositories": repositories, "data_dir": str(data_dir)},
    )


@pytest.mark.asyncio
async def test_read_tool_result_utf8_pages_have_no_gaps_or_overlap(tmp_path: Path) -> None:
    repositories, data_dir, owner_context, artifact_repo = _setup(tmp_path)
    original = ("中文😀abc\n" * 10_000)
    ref = artifact_repo.ensure_persisted(
        original,
        context=owner_context,
        tool_name="web_fetch",
    )
    context = _read_context(tmp_path, repositories, data_dir)
    cursor = None
    chunks: list[str] = []
    while True:
        page = await read_tool_result(
            {"artifact_id": ref.artifact_id, "cursor": cursor, "max_bytes": 1021},
            context,
        )
        chunks.append(page["chunk"])
        assert page["chunk_bytes"] <= 1021
        cursor = page["next_cursor"]
        if cursor is None:
            assert page["is_complete"] is True
            break
    assert "".join(chunks) == original


@pytest.mark.asyncio
async def test_read_tool_result_rejects_missing_grant_and_wrong_owner(tmp_path: Path) -> None:
    repositories, data_dir, owner_context, artifact_repo = _setup(tmp_path)
    ref = artifact_repo.ensure_persisted("secret", context=owner_context, tool_name="search_text")
    for session_id, user_id in (("session-2", "user-1"), ("session-other", "user-2")):
        with pytest.raises(ToolExecutionError) as captured:
            await read_tool_result(
                {"artifact_id": ref.artifact_id},
                _read_context(
                    tmp_path,
                    repositories,
                    data_dir,
                    session_id=session_id,
                    user_id=user_id,
                ),
            )
        assert captured.value.code == "tool_result_artifact_unavailable"
        assert str(data_dir) not in str(captured.value.details)


@pytest.mark.asyncio
async def test_read_tool_result_rejects_tampered_cursor_path_and_digest(tmp_path: Path) -> None:
    repositories, data_dir, owner_context, artifact_repo = _setup(tmp_path)
    ref = artifact_repo.ensure_persisted(
        "value" * 10_000,
        context=owner_context,
        tool_name="search_text",
    )
    context = _read_context(tmp_path, repositories, data_dir)
    first = await read_tool_result(
        {"artifact_id": ref.artifact_id, "max_bytes": 100},
        context,
    )
    with pytest.raises(ToolExecutionError) as cursor_error:
        await read_tool_result(
            {"artifact_id": ref.artifact_id, "cursor": first["next_cursor"] + "x"},
            context,
        )
    assert cursor_error.value.code == "invalid_tool_result_cursor"

    record = repositories.tool_result_artifacts.get(ref.artifact_id)
    assert record is not None
    artifact_path = data_dir / record.relative_path
    artifact_path.write_text("tampered", encoding="utf-8")
    with pytest.raises(ToolExecutionError) as digest_error:
        await read_tool_result({"artifact_id": ref.artifact_id}, context)
    assert digest_error.value.code == "tool_result_artifact_unavailable"

    with repositories.db.transaction() as conn:
        conn.execute(
            "update tool_result_artifacts set relative_path = '../escape.txt' where id = ?",
            (ref.artifact_id,),
        )
    with pytest.raises(ToolExecutionError) as path_error:
        await read_tool_result({"artifact_id": ref.artifact_id}, context)
    assert path_error.value.code == "tool_result_artifact_unavailable"


@pytest.mark.asyncio
async def test_read_tool_result_rejects_symlinked_managed_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repositories, data_dir, owner_context, artifact_repo = _setup(tmp_path)
    ref = artifact_repo.ensure_persisted(
        "secret artifact",
        context=owner_context,
        tool_name="search_text",
    )
    record = repositories.tool_result_artifacts.get(ref.artifact_id)
    assert record is not None
    artifact_path = data_dir / record.relative_path

    original_is_symlink = Path.is_symlink

    def fake_is_symlink(path: Path) -> bool:
        return path == artifact_path.parent or original_is_symlink(path)

    monkeypatch.setattr(Path, "is_symlink", fake_is_symlink)
    with pytest.raises(ToolExecutionError) as captured:
        await read_tool_result(
            {"artifact_id": ref.artifact_id},
            _read_context(tmp_path, repositories, data_dir),
        )
    assert captured.value.code == "tool_result_artifact_unavailable"
