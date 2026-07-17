from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, ToolMessage

from backend.app.agent.compact_runtime_attachments import (
    RECENT_READ_CURRENT_FILE_MAX_BYTES,
    build_current_text_reader,
    build_latest_plan_attachment,
    build_recent_read_attachments,
    is_compact_runtime_attachment_message,
)
from backend.app.command_approval import save_command_settings
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools.command_runtime.models import CommandSettings


def _tool_exchange(name: str, args: dict, call_id: str, result: str = "ok"):
    return [
        AIMessage(
            content="",
            tool_calls=[{"id": call_id, "name": name, "args": args}],
        ),
        ToolMessage(content=result, tool_call_id=call_id),
    ]


def test_latest_plan_is_full_replacement_snapshot_and_empty_plan_is_valid() -> None:
    messages = [
        *_tool_exchange(
            "update_plan",
            {"plan": [{"step": "old", "status": "completed"}]},
            "p1",
        ),
        *_tool_exchange("update_plan", {"plan": []}, "p2"),
    ]
    attachment = build_latest_plan_attachment(messages)
    assert attachment is not None
    assert '"plan": []' in str(attachment.message.content)
    assert "old" not in str(attachment.message.content)
    assert attachment.optional is False
    assert is_compact_runtime_attachment_message(attachment.message)


def test_plan_in_tail_is_not_duplicated() -> None:
    messages = _tool_exchange(
        "update_plan",
        {"plan": [{"step": "current", "status": "in_progress"}]},
        "p1",
    )
    assert build_latest_plan_attachment(messages, tail_tool_call_ids={"p1"}) is None


def test_recent_reads_manifest_is_newest_first_limited_and_excludes_instruction_files() -> None:
    messages = []
    for index, path in enumerate(
        ["a.py", "b.py", "SKILL.md", "c.py", "d.py", "e.py", "f.py"]
    ):
        messages.extend(_tool_exchange("read_file", {"path": path}, f"r{index}"))
    selection = build_recent_read_attachments(messages, available_tokens=10_000)
    manifest = selection.attachments[0]
    content = str(manifest.message.content)
    assert "f.py" in content and "b.py" in content
    assert "a.py" not in content
    assert "SKILL.md" not in content
    assert content.index("f.py") < content.index("e.py")


def test_recent_read_snippets_use_current_reader_and_shared_budget() -> None:
    messages = _tool_exchange("read_file", {"path": "a.py"}, "r1", "old")
    selection = build_recent_read_attachments(
        messages,
        available_tokens=500,
        read_current=lambda _path: "current-value\n" * 100,
    )
    assert selection.attachments[0].kind == "recent_read_manifest"
    snippets = [item for item in selection.attachments if item.kind == "recent_read_snippet"]
    if snippets:
        assert "current-value" in str(snippets[0].message.content)
    assert sum(item.approximate_tokens for item in selection.attachments) <= 500


def test_recent_read_optional_content_drops_before_mandatory_components() -> None:
    messages = _tool_exchange("read_file", {"path": "a.py"}, "r1")
    selection = build_recent_read_attachments(messages, available_tokens=0)
    assert selection.attachments == ()
    assert selection.dropped == (
        {"kind": "recent_read_manifest", "reason": "shared_budget_exhausted"},
    )


def test_deleted_or_denied_recent_file_only_drops_that_attachment() -> None:
    messages = _tool_exchange("read_file", {"path": "a.py"}, "r1")

    def denied(_path: str) -> str:
        raise PermissionError("denied")

    selection = build_recent_read_attachments(
        messages,
        available_tokens=2_000,
        read_current=denied,
    )
    assert [item.kind for item in selection.attachments] == ["recent_read_manifest"]
    assert selection.dropped == (
        {"kind": "recent_read_snippet", "reason": "read_denied_or_missing"},
    )


def test_current_text_reader_revalidates_workspace_permissions_and_safe_size(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "current.txt"
    target.write_text("current workspace content", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    workspace = repositories.workspaces.create(
        workspace_id="workspace-1", root_path=workspace_root
    )
    session = repositories.sessions.create(
        session_id="session-1",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(workspace_root),
        workspace_roots=[str(workspace_root)],
    )
    save_command_settings(
        repositories,
        CommandSettings(file_access_mode="workspace_read_only"),
    )
    reader = build_current_text_reader(
        repositories,
        session=session,
        user_id=session.user_id,
    )
    assert reader is not None
    assert reader("current.txt") == "current workspace content"
    with pytest.raises(Exception, match="工作区|workspace"):
        reader(str(outside))

    target.write_bytes(b"x" * (RECENT_READ_CURRENT_FILE_MAX_BYTES + 1))
    with pytest.raises(ValueError, match="safe read limit"):
        reader("current.txt")


def test_recent_read_defensive_caps_never_create_an_independent_50k_budget() -> None:
    messages = []
    for index in range(6):
        messages.extend(
            _tool_exchange("read_file", {"path": f"file-{index}.txt"}, f"r{index}")
        )
    selection = build_recent_read_attachments(
        messages,
        available_tokens=1_200,
        read_current=lambda _path: "x" * 100_000,
    )
    assert sum(item.approximate_tokens for item in selection.attachments) <= 1_200
    assert len(
        [item for item in selection.attachments if item.kind == "recent_read_snippet"]
    ) <= 5
    assert any(item["reason"] == "shared_budget_exhausted" for item in selection.dropped)
