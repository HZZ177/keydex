from __future__ import annotations

from pathlib import Path

import pytest
from langchain_core.messages import ToolMessage

from backend.app.agent.langchain_tools import local_tool_to_langchain_tool
from backend.app.agent.tool_results.artifact_repository import ToolResultArtifactRepository
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools.base import FunctionTool, ToolExecutionContext


def _setup(tmp_path: Path):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="user-1",
        scene_id="scene-1",
    )
    context = ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path / "workspace",
        turn_index=1,
        metadata={"tool_call_id": "call-1"},
    )
    return repositories, context, ToolResultArtifactRepository(
        repositories=repositories,
        data_dir=tmp_path / "data",
    )


def test_managed_artifact_write_is_atomic_idempotent_and_granted(tmp_path: Path) -> None:
    repositories, context, artifact_repo = _setup(tmp_path)
    first = artifact_repo.ensure_persisted(
        {"items": ["中", "😀"]},
        context=context,
        tool_name="search_text",
    )
    second = artifact_repo.ensure_persisted(
        {"items": ["中", "😀"]},
        context=context,
        tool_name="search_text",
    )
    record = repositories.tool_result_artifacts.get(first.artifact_id)
    assert first == second
    assert record is not None
    assert repositories.tool_result_artifacts.has_grant(
        artifact_id=first.artifact_id,
        session_id="session-1",
    )
    artifact_path = tmp_path / "data" / record.relative_path
    assert artifact_path.is_file()
    assert not list(artifact_path.parent.glob("*.tmp"))


def test_database_failure_removes_new_file_and_temp_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    repositories, context, artifact_repo = _setup(tmp_path)

    def fail_create(**_kwargs):
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(repositories.tool_result_artifacts, "create_or_get", fail_create)
    with pytest.raises(RuntimeError, match="db unavailable"):
        artifact_repo.ensure_persisted(
            "large output",
            context=context,
            tool_name="search_text",
        )
    context_root = tmp_path / "data" / "tool-results" / "context"
    assert not list(context_root.glob("*"))


def test_command_log_is_registered_without_copying(tmp_path: Path) -> None:
    repositories, context, artifact_repo = _setup(tmp_path)
    command_path = tmp_path / "data" / "tool-results" / "commands" / "cmd-1.log"
    command_path.parent.mkdir(parents=True)
    command_path.write_text("command output", encoding="utf-8")
    ref = artifact_repo.register_command_log(
        command_path,
        context=context,
        tool_name="run_powershell",
        is_complete=True,
    )
    record = repositories.tool_result_artifacts.get(ref.artifact_id)
    assert record is not None
    assert record.storage_kind == "command_log"
    assert record.relative_path == "tool-results/commands/cmd-1.log"
    assert len(list((tmp_path / "data" / "tool-results" / "commands").iterdir())) == 1


@pytest.mark.asyncio
async def test_langchain_adapter_persists_full_payload_before_projected_truncation(
    tmp_path: Path,
) -> None:
    repositories, context, artifact_repo = _setup(tmp_path)
    context = ToolExecutionContext(
        session_id=context.session_id,
        user_id=context.user_id,
        workspace_root=context.workspace_root,
        turn_index=1,
        metadata={
            "repositories": repositories,
            "data_dir": str(tmp_path / "data"),
            "tool_result_artifact_repository": artifact_repo,
        },
    )
    original = {"rows": ["full-row-中😀" * 1000 for _ in range(100)]}
    tool = FunctionTool(
        name="unknown_large_tool",
        description="large",
        parameters={"type": "object", "properties": {}},
        handler=lambda _args, _context: original,
    )
    langchain_tool = local_tool_to_langchain_tool(tool, context_factory=lambda: context)
    output = await langchain_tool.ainvoke(
        {"type": "tool_call", "id": "call-persist", "name": tool.name, "args": {}}
    )
    assert isinstance(output, ToolMessage)
    artifact_id = output.artifact["projection"]["artifact_id"]
    assert artifact_id
    record = repositories.tool_result_artifacts.get(artifact_id)
    assert record is not None
    stored = (tmp_path / "data" / record.relative_path).read_text(encoding="utf-8")
    assert "full-row-中😀" in stored
    assert len(output.content.encode("utf-8")) <= 32 * 1024
