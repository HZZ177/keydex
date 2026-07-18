from __future__ import annotations

import pytest

from backend.app.agent.langchain_tools import _context_for_tool
from backend.app.services.file_history_service import FileHistoryService
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools.base import (
    FileHistoryExecutionScope,
    FunctionTool,
    ToolExecutionContext,
    ToolExecutionError,
)


def _tool() -> FunctionTool:
    return FunctionTool(
        name="test_tool",
        description="test",
        parameters={"type": "object", "properties": {}},
        handler=lambda _args, _context: {},
    )


def test_langchain_tool_context_preserves_turn_scoped_file_history(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    service = FileHistoryService(repositories, data_dir=tmp_path / "data")
    context = ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=3,
        trace_id="trace-1",
        active_session_id="active-1",
        assistant_message_id="assistant-1",
        input_file_snapshot_id="snapshot-1",
        file_history_service=service,
        file_history_tracking=True,
        file_history_scope=FileHistoryExecutionScope(
            session_id="parent-session",
            active_session_id="parent-active",
            trace_id="parent-trace",
            turn_index=2,
            input_snapshot_id="snapshot-1",
        ),
    )

    cloned = _context_for_tool(
        _tool(),
        context,
        {"configurable": {"tool_call_id": "call-1"}},
    )

    assert cloned.require_file_history() == (service, "snapshot-1")
    assert cloned.require_file_history_scope()[1].session_id == "parent-session"
    assert cloned.active_session_id == "active-1"
    assert cloned.assistant_message_id == "assistant-1"
    assert cloned.tool_call_id == "call-1"


def test_tracked_context_missing_snapshot_fails_explicitly(tmp_path) -> None:
    context = ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=1,
        file_history_tracking=True,
    )
    with pytest.raises(ToolExecutionError) as error:
        context.require_file_history()
    assert error.value.code == "file_history_context_missing"


def test_untracked_context_is_explicit_and_does_not_share_global_state(tmp_path) -> None:
    first = ToolExecutionContext("session-1", "user-1", tmp_path, 1)
    second = ToolExecutionContext("session-2", "user-1", tmp_path, 1)
    first.metadata["tool_call_id"] = "call-1"

    assert first.tool_call_id == "call-1"
    assert second.tool_call_id is None
    with pytest.raises(ToolExecutionError) as error:
        second.require_file_history()
    assert error.value.code == "file_history_untracked"
