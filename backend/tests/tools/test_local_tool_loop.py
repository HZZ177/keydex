from __future__ import annotations

from pathlib import Path

from backend.app.tools import ToolExecutionContext
from backend.app.tools.factory import create_default_tool_registry


def _context(root: Path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses_tool_loop",
        user_id="local-user",
        workspace_root=root,
        turn_index=1,
    )


async def _run(tool_name: str, args: dict, root: Path):
    return await create_default_tool_registry().require(tool_name).run(args, _context(root))


async def test_local_workspace_tool_loop_search_read_create_patch_verify(tmp_path) -> None:
    source = tmp_path / "src" / "app.py"
    source.parent.mkdir()
    source.write_text("VALUE = 'old'\n# LOOP_MARKER\n", encoding="utf-8")

    listed = await _run("list_dir", {"path": ".", "depth": 2}, tmp_path)
    grep = await _run("grep_files", {"query": "LOOP_MARKER", "regex": False}, tmp_path)
    searched = await _run("search_text", {"query": "VALUE", "include": ["*.py"]}, tmp_path)
    read_before = await _run(
        "read_file",
        {"path": "src/app.py", "start_line": 1, "max_lines": 2},
        tmp_path,
    )
    created = await _run(
        "write_file",
        {"path": "docs/result.md", "content": "# Result\n\nCreated by loop.\n"},
        tmp_path,
    )
    patched = await _run(
        "apply_patch",
        {
            "patch": """*** Begin Patch
*** Update File: src/app.py
@@
-VALUE = 'old'
+VALUE = 'new'
 # LOOP_MARKER
*** End Patch"""
        },
        tmp_path,
    )
    read_after = await _run(
        "read_file",
        {"path": "src/app.py", "start_line": 1, "max_lines": 2},
        tmp_path,
    )

    assert listed.ok is True
    assert "src/" in listed.result["tree"]
    assert grep.ok is True
    assert grep.result["paths"] == ["src/app.py"]
    assert searched.ok is True
    assert searched.result["results"][0]["path"] == "src/app.py"
    assert read_before.ok is True
    assert "1: VALUE = 'old'" in read_before.result["numbered_content"]
    assert created.ok is True
    assert created.result["files"][0]["change_type"] == "create"
    assert patched.ok is True
    assert patched.result["files"][0]["change_type"] == "update"
    assert read_after.ok is True
    assert "1: VALUE = 'new'" in read_after.result["numbered_content"]
    assert (tmp_path / "docs" / "result.md").read_text(encoding="utf-8").startswith("# Result")
