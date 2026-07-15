from __future__ import annotations

from pathlib import Path

from backend.app.tools import ToolExecutionContext
from backend.app.tools.factory import create_default_tool_registry


def _context(root: Path, session_id: str) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id=session_id,
        user_id="local-user",
        workspace_root=root,
        turn_index=1,
    )


async def _run(tool_name: str, args: dict, root: Path, session_id: str):
    return (
        await create_default_tool_registry()
        .require(tool_name)
        .run(
            args,
            _context(root, session_id),
        )
    )


async def test_workspace_tools_are_isolated_by_session_cwd(tmp_path) -> None:
    project_a = tmp_path / "project-a"
    project_b = tmp_path / "project-b"
    project_a.mkdir()
    project_b.mkdir()
    (project_a / "shared.txt").write_text("A_ONLY\n", encoding="utf-8")
    (project_b / "shared.txt").write_text("B_ONLY\n", encoding="utf-8")

    list_a = await _run("list_dir", {"path": ".", "depth": 1}, project_a, "ses_a")
    list_b = await _run("list_dir", {"path": ".", "depth": 1}, project_b, "ses_b")
    read_a = await _run("read_file", {"path": "shared.txt"}, project_a, "ses_a")
    read_b = await _run("read_file", {"path": "shared.txt"}, project_b, "ses_b")
    search_a = await _run("search_text", {"query": "A_ONLY"}, project_a, "ses_a")
    search_b = await _run("search_text", {"query": "A_ONLY"}, project_b, "ses_b")
    grep_a = await _run("grep_files", {"query": "A_ONLY", "regex": False}, project_a, "ses_a")
    grep_b = await _run("grep_files", {"query": "A_ONLY", "regex": False}, project_b, "ses_b")
    patch_a = await _run(
        "edit_file",
        {
            "patch": """*** Begin Patch
*** Update File: shared.txt
@@
-A_ONLY
+A_PATCHED
*** End Patch"""
        },
        project_a,
        "ses_a",
    )

    assert [entry["name"] for entry in list_a.result["entries"]] == ["shared.txt"]
    assert [entry["name"] for entry in list_b.result["entries"]] == ["shared.txt"]
    assert read_a.result["content"] == "A_ONLY\n"
    assert read_b.result["content"] == "B_ONLY\n"
    assert search_a.result["results"][0]["path"] == "shared.txt"
    assert search_b.result["results"] == []
    assert grep_a.result["paths"] == ["shared.txt"]
    assert grep_b.result["paths"] == []
    assert patch_a.ok is True
    assert (project_a / "shared.txt").read_text(encoding="utf-8") == "A_PATCHED\n"
    assert (project_b / "shared.txt").read_text(encoding="utf-8") == "B_ONLY\n"


async def test_edit_file_cannot_modify_another_workspace(tmp_path) -> None:
    project_a = tmp_path / "project-a"
    project_b = tmp_path / "project-b"
    project_a.mkdir()
    project_b.mkdir()
    target_b = (project_b / "shared.txt").resolve()
    target_b.write_text("B_ONLY\n", encoding="utf-8")

    result = await _run(
        "edit_file",
        {
            "patch": f"""*** Begin Patch
*** Update File: {target_b}
@@
-B_ONLY
+BROKEN
*** End Patch"""
        },
        project_a,
        "ses_a",
    )

    assert result.ok is False
    assert result.error["code"] == "workspace_path_forbidden"
    assert target_b.read_text(encoding="utf-8") == "B_ONLY\n"


async def test_t79_generic_file_tools_cannot_read_system_keydex_root(tmp_path) -> None:
    chat_data_root = tmp_path / "data"
    system_root = tmp_path / "system-keydex"
    chat_data_root.mkdir()
    skill_entry = system_root / "skills" / "global" / "SKILL.md"
    skill_entry.parent.mkdir(parents=True)
    skill_entry.write_text(
        "---\nname: global\ndescription: Global\n---\n\nSYSTEM SECRET",
        encoding="utf-8",
    )

    result = await _run(
        "read_file",
        {"path": str(skill_entry.resolve())},
        chat_data_root,
        "ses-chat",
    )

    assert result.ok is False
    assert result.error["code"] == "workspace_path_forbidden"
    assert "SYSTEM SECRET" not in str(result.error)
