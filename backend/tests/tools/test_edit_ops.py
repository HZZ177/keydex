from __future__ import annotations

import time

from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.edit_ops import register_edit_operation_tools
from backend.app.tools.filesystem import register_filesystem_tools


def _context(tmp_path, *, file_access_mode: str | None = None) -> ToolExecutionContext:
    metadata = {"file_access_mode": file_access_mode} if file_access_mode else {}
    return ToolExecutionContext(
        session_id="ses_edit_ops",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        metadata=metadata,
    )


def _registry() -> ToolRegistry:
    registry = ToolRegistry()
    register_filesystem_tools(registry)
    register_edit_operation_tools(registry)
    return registry


async def _read(registry: ToolRegistry, context: ToolExecutionContext, path: str, *, max_lines: int = 100):
    return await registry.require("read_file").run(
        {"path": path, "start_line": 1, "max_lines": max_lines},
        context,
    )


async def test_edit_file_replaces_single_match_after_read(tmp_path) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir()
    target.write_text("alpha\nold\nomega\n", encoding="utf-8")
    registry = _registry()
    context = _context(tmp_path)

    read = await _read(registry, context, "src/app.py")
    result = await registry.require("edit_file").run(
        {"path": "src/app.py", "old_string": "old", "new_string": "new"},
        context,
    )

    assert read.ok is True
    assert result.ok is True
    assert result.result["operation"] == "update"
    assert result.result["change_type"] == "update"
    assert result.result["added_lines"] == 1
    assert result.result["deleted_lines"] == 1
    assert target.read_text(encoding="utf-8") == "alpha\nnew\nomega\n"


async def test_edit_file_requires_prior_full_read(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("old\n", encoding="utf-8")
    registry = _registry()

    result = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "old", "new_string": "new"},
        _context(tmp_path),
    )

    assert result.ok is False
    assert result.error["code"] == "file_not_read"
    assert target.read_text(encoding="utf-8") == "old\n"


async def test_edit_file_rejects_stale_snapshot_until_reread(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("old\n", encoding="utf-8")
    registry = _registry()
    context = _context(tmp_path)
    await _read(registry, context, "note.txt")
    time.sleep(0.01)
    target.write_text("external\n", encoding="utf-8")

    stale = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "old", "new_string": "new"},
        context,
    )
    await _read(registry, context, "note.txt")
    fresh = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "external", "new_string": "new"},
        context,
    )

    assert stale.ok is False
    assert stale.error["code"] == "file_modified_since_read"
    assert fresh.ok is True
    assert target.read_text(encoding="utf-8") == "new\n"


async def test_edit_file_multiple_matches_require_replace_all(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("same\nsame\n", encoding="utf-8")
    registry = _registry()
    context = _context(tmp_path)
    await _read(registry, context, "note.txt")

    rejected = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "same", "new_string": "done"},
        context,
    )
    replaced = await registry.require("edit_file").run(
        {
            "path": "note.txt",
            "old_string": "same",
            "new_string": "done",
            "replace_all": True,
        },
        context,
    )

    assert rejected.ok is False
    assert rejected.error["code"] == "multiple_matches"
    assert rejected.error["details"]["match_count"] == 2
    assert replaced.ok is True
    assert target.read_text(encoding="utf-8") == "done\ndone\n"


async def test_edit_file_rejects_noop_and_empty_old_string(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("old\n", encoding="utf-8")
    registry = _registry()
    context = _context(tmp_path)
    await _read(registry, context, "note.txt")

    noop = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "old", "new_string": "old"},
        context,
    )
    empty = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "", "new_string": "new"},
        context,
    )

    assert noop.ok is False
    assert noop.error["code"] == "no_op_edit"
    assert empty.ok is False
    assert empty.error["code"] == "empty_old_string"


async def test_edit_file_empty_new_string_deletes_fragment(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("alpha\nremove me\nomega\n", encoding="utf-8")
    registry = _registry()
    context = _context(tmp_path)
    await _read(registry, context, "note.txt")

    result = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "remove me\n", "new_string": ""},
        context,
    )

    assert result.ok is True
    assert result.result["deleted_lines"] == 1
    assert target.read_text(encoding="utf-8") == "alpha\nomega\n"


async def test_create_file_updates_snapshot_for_followup_edit(tmp_path) -> None:
    registry = _registry()
    context = _context(tmp_path)

    created = await registry.require("create_file").run(
        {"path": "note.txt", "content": "old\n"},
        context,
    )
    edited = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "old", "new_string": "new"},
        context,
    )

    assert created.ok is True
    assert edited.ok is True
    assert (tmp_path / "note.txt").read_text(encoding="utf-8") == "new\n"


async def test_delete_file_requires_read_and_returns_delete_diff(tmp_path) -> None:
    target = tmp_path / "old.txt"
    target.write_text("one\ntwo\n", encoding="utf-8")
    registry = _registry()
    context = _context(tmp_path)
    unread = await registry.require("delete_file").run({"path": "old.txt"}, context)
    await _read(registry, context, "old.txt")

    deleted = await registry.require("delete_file").run({"path": "old.txt"}, context)

    assert unread.ok is False
    assert unread.error["code"] == "file_not_read"
    assert deleted.ok is True
    assert deleted.result["operation"] == "delete"
    assert deleted.result["deleted_lines"] == 2
    assert "--- a/old.txt" in deleted.result["diff"]
    assert not target.exists()


async def test_move_file_requires_read_and_updates_snapshot_for_new_path(tmp_path) -> None:
    source = tmp_path / "old.txt"
    source.write_text("old\n", encoding="utf-8")
    registry = _registry()
    context = _context(tmp_path)
    await _read(registry, context, "old.txt")

    moved = await registry.require("move_file").run(
        {"path": "old.txt", "new_path": "dir/new.txt"},
        context,
    )
    edited = await registry.require("edit_file").run(
        {"path": "dir/new.txt", "old_string": "old", "new_string": "new"},
        context,
    )

    assert moved.ok is True
    assert moved.result["operation"] == "move"
    assert moved.result["old_path"] == "old.txt"
    assert moved.result["new_path"] == "dir/new.txt"
    assert edited.ok is True
    assert not source.exists()
    assert (tmp_path / "dir" / "new.txt").read_text(encoding="utf-8") == "new\n"


async def test_file_edit_tools_reject_workspace_escape_and_read_only_writes(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("old\n", encoding="utf-8")
    outside = tmp_path.parent / "outside-edit.txt"
    registry = _registry()
    context = _context(tmp_path, file_access_mode="workspace_read_only")

    read_only = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "old", "new_string": "new"},
        context,
    )
    escape = await registry.require("move_file").run(
        {"path": "note.txt", "new_path": str(outside)},
        _context(tmp_path),
    )

    assert read_only.ok is False
    assert read_only.error["code"] == "file_write_forbidden"
    assert escape.ok is False
    assert escape.error["code"] == "workspace_path_forbidden"
