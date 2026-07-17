from __future__ import annotations

import time
import subprocess

from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.edit_ops import register_edit_operation_tools
from backend.app.tools.filesystem import register_filesystem_tools


def _assert_final_patch_applies_in_reverse(root, patch: str) -> None:
    result = subprocess.run(
        ["git", "apply", "--check", "--reverse", "--recount", "--unsafe-paths", "-"],
        cwd=root,
        input=(patch.rstrip("\r\n") + "\n").encode("utf-8"),
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")


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
    change = result.result["files"][0]
    assert change["patch_format"] == "canonical_unified"
    assert change["patch_precision"] == "exact"
    _assert_final_patch_applies_in_reverse(tmp_path, change["raw_patch"])


async def test_edit_file_allows_direct_edit_without_prior_read(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("old\n", encoding="utf-8")
    registry = _registry()

    result = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "old", "new_string": "new"},
        _context(tmp_path),
    )

    assert result.ok is True
    assert result.result["operation"] == "update"
    assert target.read_text(encoding="utf-8") == "new\n"


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


async def test_edit_file_rejects_noop(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("old\n", encoding="utf-8")
    registry = _registry()
    context = _context(tmp_path)
    await _read(registry, context, "note.txt")

    noop = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "old", "new_string": "old"},
        context,
    )
    empty_noop = await registry.require("edit_file").run(
        {"path": "empty.txt", "old_string": "", "new_string": ""},
        _context(tmp_path),
    )

    assert noop.ok is False
    assert noop.error["code"] == "no_op_edit"
    assert empty_noop.ok is False
    assert empty_noop.error["code"] == "no_op_edit"


async def test_edit_file_empty_old_string_creates_missing_file(tmp_path) -> None:
    registry = _registry()
    context = _context(tmp_path)

    result = await registry.require("edit_file").run(
        {"path": "dir/new.txt", "old_string": "", "new_string": "created\n"},
        context,
    )
    edited = await registry.require("edit_file").run(
        {"path": "dir/new.txt", "old_string": "created", "new_string": "updated"},
        context,
    )

    assert result.ok is True
    assert result.result["created"] is True
    assert result.result["change_type"] == "create"
    assert result.result["added_lines"] == 1
    assert "--- /dev/null" in result.result["diff"]
    assert edited.ok is True
    assert (tmp_path / "dir" / "new.txt").read_text(encoding="utf-8") == "updated\n"


async def test_edit_file_empty_old_string_writes_empty_existing_file(tmp_path) -> None:
    target = tmp_path / "empty.txt"
    target.write_text("", encoding="utf-8")
    registry = _registry()
    context = _context(tmp_path)

    result = await registry.require("edit_file").run(
        {"path": "empty.txt", "old_string": "", "new_string": "filled\n"},
        context,
    )

    assert result.ok is True
    assert result.result["operation"] == "update"
    assert result.result["added_lines"] == 1
    assert target.read_text(encoding="utf-8") == "filled\n"


async def test_edit_file_empty_old_string_writes_whitespace_only_existing_file(tmp_path) -> None:
    target = tmp_path / "blank.txt"
    target.write_text("  \n\t\n", encoding="utf-8")
    registry = _registry()

    result = await registry.require("edit_file").run(
        {"path": "blank.txt", "old_string": "", "new_string": "filled\n"},
        _context(tmp_path),
    )

    assert result.ok is True
    assert target.read_text(encoding="utf-8") == "filled\n"


async def test_edit_file_empty_old_string_rejects_non_empty_existing_file(tmp_path) -> None:
    target = tmp_path / "note.txt"
    target.write_text("old\n", encoding="utf-8")
    registry = _registry()

    result = await registry.require("edit_file").run(
        {"path": "note.txt", "old_string": "", "new_string": "new\n"},
        _context(tmp_path),
    )

    assert result.ok is False
    assert result.error["code"] == "file_exists"
    assert target.read_text(encoding="utf-8") == "old\n"


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


async def test_delete_file_allows_direct_delete_and_returns_delete_diff(tmp_path) -> None:
    target = tmp_path / "old.txt"
    target.write_text("one\ntwo\n", encoding="utf-8")
    registry = _registry()
    context = _context(tmp_path)

    deleted = await registry.require("delete_file").run({"path": "old.txt"}, context)

    assert deleted.ok is True
    assert deleted.result["operation"] == "delete"
    assert deleted.result["deleted_lines"] == 2
    assert "--- a/old.txt" in deleted.result["diff"]
    assert deleted.result["files"][0]["status"] == "deleted"
    assert deleted.result["files"][0]["old_path"] == "old.txt"
    assert deleted.result["files"][0]["new_path"] is None
    assert deleted.result["files"][0]["patch_complete"] is True
    assert not target.exists()
    _assert_final_patch_applies_in_reverse(
        tmp_path,
        deleted.result["files"][0]["raw_patch"],
    )


async def test_delete_file_returns_explicit_binary_final_contract(tmp_path) -> None:
    target = tmp_path / "asset.bin"
    target.write_bytes(b"\xff\x00\xfe")
    registry = _registry()

    deleted = await registry.require("delete_file").run(
        {"path": "asset.bin"},
        _context(tmp_path),
    )

    assert deleted.ok is True
    change = deleted.result["files"][0]
    assert change["status"] == "deleted"
    assert change["binary"] is True
    assert change["content_kind"] == "binary"
    assert change["raw_patch"] is None
    assert change["patch_format"] == "none"
    assert change["truncated"] is False
    assert change["patch_complete"] is True


async def test_move_file_allows_direct_move_and_updates_snapshot_for_new_path(tmp_path) -> None:
    source = tmp_path / "old.txt"
    source.write_text("old\n", encoding="utf-8")
    registry = _registry()
    context = _context(tmp_path)

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
    assert moved.result["files"][0]["status"] == "renamed"
    assert moved.result["files"][0]["patch_precision"] == "exact"
    assert moved.result["files"][0]["raw_patch"] == moved.result["files"][0]["diff"]
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
