from __future__ import annotations

from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.filesystem import register_filesystem_tools


def _context(tmp_path, *, file_access_mode: str | None = None) -> ToolExecutionContext:
    metadata = {"file_access_mode": file_access_mode} if file_access_mode else {}
    return ToolExecutionContext(
        session_id="ses_files",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        metadata=metadata,
    )


def _registry() -> ToolRegistry:
    return register_filesystem_tools(ToolRegistry())


async def _run(
    name: str,
    args: dict,
    tmp_path,
    *,
    file_access_mode: str | None = None,
):
    return await _registry().require(name).run(
        args,
        _context(tmp_path, file_access_mode=file_access_mode),
    )


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
    assert result.result["numbered_content"] == "2: 二\n"
    assert result.result["truncated"] is True
    assert result.result["next_start_line"] == 3


async def test_list_dir_tool_lists_direct_children_sorted(tmp_path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "README.md").write_text("hello", encoding="utf-8")

    result = await _run("list_dir", {"path": ".", "depth": 1}, tmp_path)

    assert result.ok is True
    assert [entry["name"] for entry in result.result["entries"]] == ["src", "README.md"]
    assert result.result["entries"][0]["type"] == "directory"


async def test_read_file_tool_supports_line_window_and_indentation_mode(tmp_path) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir()
    target.write_text(
        "class App:\n"
        "    def run(self):\n"
        "        first()\n"
        "        second()\n"
        "\n"
        "def outside():\n"
        "    pass\n",
        encoding="utf-8",
    )

    window = await _run(
        "read_file",
        {"path": "src/app.py", "start_line": 3, "max_lines": 1},
        tmp_path,
    )
    block = await _run(
        "read_file",
        {"path": "src/app.py", "mode": "indentation", "anchor_line": 2, "max_lines": 10},
        tmp_path,
    )

    assert window.ok is True
    assert window.result["content"] == "        first()\n"
    assert block.ok is True
    assert block.result["start_line"] == 2
    assert "2:     def run(self):" in block.result["numbered_content"]
    assert "4:         second()" in block.result["numbered_content"]
    assert "def outside" not in block.result["content"]


async def test_list_dir_tool_returns_depth_limited_tree_and_pagination(tmp_path) -> None:
    (tmp_path / "src" / "pkg").mkdir(parents=True)
    (tmp_path / "src" / "pkg" / "agent.py").write_text("", encoding="utf-8")
    (tmp_path / "README.md").write_text("hello", encoding="utf-8")

    result = await _run("list_dir", {"path": ".", "depth": 2, "limit": 2}, tmp_path)

    assert result.ok is True
    assert result.result["path"] == "."
    assert result.result["entries"][0]["path"] == "src"
    assert result.result["entries"][1]["path"] == "src/pkg"
    assert result.result["truncated"] is True
    assert result.result["next_offset"] == 2
    assert "src/" in result.result["tree"]


async def test_list_dir_tool_stops_collecting_after_page_budget(tmp_path) -> None:
    for index in range(6):
        (tmp_path / f"file-{index}.txt").write_text("", encoding="utf-8")

    result = await _run("list_dir", {"path": ".", "depth": 1, "limit": 2}, tmp_path)

    assert result.ok is True
    assert len(result.result["entries"]) == 2
    assert result.result["truncated"] is True
    assert result.result["next_offset"] == 2
    assert result.result["total_entries"] == 3
    assert result.result["total_entries_exact"] is False


async def test_create_file_tool_creates_new_file_inside_workspace(tmp_path) -> None:
    result = await _run(
        "create_file",
        {"path": "out/result.txt", "content": "hello"},
        tmp_path,
    )

    assert result.ok is True
    assert result.result["created"] is True
    assert result.result["change_type"] == "create"
    assert result.result["operation"] == "add"
    assert result.result["added_lines"] == 1
    assert result.result["deleted_lines"] == 0
    assert result.result["files"][0]["path"] == "out/result.txt"
    assert result.result["files"][0]["operation"] == "add"
    assert result.result["files"][0]["additions"] == 1
    assert result.result["files"][0]["diff"] == (
        "--- /dev/null\n+++ b/out/result.txt\n@@ -0,0 +1 @@\n+hello"
    )
    assert (tmp_path / "out" / "result.txt").read_text(encoding="utf-8") == "hello"


async def test_create_file_tool_rejects_existing_file(tmp_path) -> None:
    target = tmp_path / "docs" / "note.md"
    target.parent.mkdir()
    target.write_text("old", encoding="utf-8")

    result = await _run(
        "create_file",
        {"path": "docs/note.md", "content": "new"},
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "file_exists"
    assert target.read_text(encoding="utf-8") == "old"


async def test_filesystem_tools_reject_workspace_escape(tmp_path) -> None:
    outside = tmp_path.parent / "outside.txt"

    result = await _run("read_file", {"path": str(outside)}, tmp_path)

    assert result.ok is False
    assert result.error["code"] == "workspace_path_forbidden"


async def test_filesystem_tools_respect_no_file_access_mode(tmp_path) -> None:
    (tmp_path / "note.md").write_text("secret", encoding="utf-8")

    result = await _run(
        "read_file",
        {"path": "note.md"},
        tmp_path,
        file_access_mode="no_file_access",
    )

    assert result.ok is False
    assert result.error["code"] == "file_access_disabled"


async def test_filesystem_tools_reject_writes_in_workspace_read_only_mode(tmp_path) -> None:
    result = await _run(
        "create_file",
        {"path": "out.txt", "content": "blocked"},
        tmp_path,
        file_access_mode="workspace_read_only",
    )

    assert result.ok is False
    assert result.error["code"] == "file_write_forbidden"
    assert not (tmp_path / "out.txt").exists()


async def test_filesystem_tools_allow_external_read_in_full_access_mode(tmp_path) -> None:
    outside = tmp_path.parent / "outside.txt"
    outside.write_text("external", encoding="utf-8")

    result = await _run(
        "read_file",
        {"path": str(outside)},
        tmp_path,
        file_access_mode="full_access",
    )

    assert result.ok is True
    assert result.result["path"] == outside.resolve().as_posix()
    assert result.result["content"] == "external"


async def test_filesystem_tools_allow_external_write_in_full_access_mode(tmp_path) -> None:
    outside = tmp_path.parent / "outside-created.txt"
    if outside.exists():
        outside.unlink()

    result = await _run(
        "create_file",
        {"path": str(outside), "content": "external write"},
        tmp_path,
        file_access_mode="full_access",
    )

    assert result.ok is True
    assert result.result["files"][0]["path"] == outside.resolve().as_posix()
    assert outside.read_text(encoding="utf-8") == "external write"


async def test_read_file_tool_reports_missing_file(tmp_path) -> None:
    result = await _run("read_file", {"path": "missing.txt"}, tmp_path)

    assert result.ok is False
    assert result.error["code"] == "file_not_found"
