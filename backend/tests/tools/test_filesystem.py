from __future__ import annotations

from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.filesystem import register_filesystem_tools


def _context(tmp_path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses_files",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
    )


def _registry() -> ToolRegistry:
    return register_filesystem_tools(ToolRegistry())


async def _run(name: str, args: dict, tmp_path):
    return await _registry().require(name).run(args, _context(tmp_path))


async def test_read_file_tool_reads_utf8_text_with_line_window(tmp_path) -> None:
    target = tmp_path / "docs" / "note.md"
    target.parent.mkdir()
    target.write_text("一\n二\n三\n", encoding="utf-8")

    result = await _run(
        "read_file",
        {"path": "docs/note.md", "start_line": 2, "max_lines": 1},
        tmp_path,
    )

    assert result.ok is True
    assert result.result["path"] == "docs/note.md"
    assert result.result["content"] == "二\n"
    assert result.result["truncated"] is True
    assert result.result["next_start_line"] == 3


async def test_list_directory_tool_lists_direct_children_sorted(tmp_path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "README.md").write_text("hello", encoding="utf-8")

    result = await _run("list_directory", {"path": "."}, tmp_path)

    assert result.ok is True
    assert [entry["name"] for entry in result.result["entries"]] == ["src", "README.md"]
    assert result.result["entries"][0]["type"] == "directory"


async def test_write_file_tool_writes_and_appends_inside_workspace(tmp_path) -> None:
    first = await _run(
        "write_file",
        {"path": "out/result.txt", "content": "hello"},
        tmp_path,
    )
    second = await _run(
        "write_file",
        {"path": "out/result.txt", "content": "\nworld", "append": True},
        tmp_path,
    )

    assert first.ok is True
    assert second.ok is True
    assert (tmp_path / "out" / "result.txt").read_text(encoding="utf-8") == "hello\nworld"


async def test_filesystem_tools_reject_workspace_escape(tmp_path) -> None:
    outside = tmp_path.parent / "outside.txt"

    result = await _run("read_file", {"path": str(outside)}, tmp_path)

    assert result.ok is False
    assert result.error["code"] == "workspace_path_forbidden"


async def test_read_file_tool_reports_missing_file(tmp_path) -> None:
    result = await _run("read_file", {"path": "missing.txt"}, tmp_path)

    assert result.ok is False
    assert result.error["code"] == "file_not_found"
