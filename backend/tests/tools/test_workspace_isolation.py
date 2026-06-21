from __future__ import annotations

import sys
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
    return await create_default_tool_registry().require(tool_name).run(
        args,
        _context(root, session_id),
    )


def _python_command(source: str) -> str:
    return f'"{sys.executable}" -c "{source}"'


async def test_workspace_tools_are_isolated_by_session_cwd(tmp_path) -> None:
    project_a = tmp_path / "project-a"
    project_b = tmp_path / "project-b"
    project_a.mkdir()
    project_b.mkdir()
    (project_a / "shared.txt").write_text("A_ONLY\n", encoding="utf-8")
    (project_b / "shared.txt").write_text("B_ONLY\n", encoding="utf-8")

    list_a = await _run("list_directory", {"path": "."}, project_a, "ses_a")
    list_b = await _run("list_directory", {"path": "."}, project_b, "ses_b")
    read_a = await _run("read_file", {"path": "shared.txt"}, project_a, "ses_a")
    read_b = await _run("read_file", {"path": "shared.txt"}, project_b, "ses_b")
    search_a = await _run("search_text", {"query": "A_ONLY"}, project_a, "ses_a")
    search_b = await _run("search_text", {"query": "A_ONLY"}, project_b, "ses_b")
    shell_a = await _run(
        "run_command",
        {
            "command": _python_command(
                "from pathlib import Path; "
                "print(Path('shared.txt').read_text(encoding='utf-8').strip())"
            )
        },
        project_a,
        "ses_a",
    )
    patch_a = await _run(
        "apply_patch",
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
    assert shell_a.result["stdout"].strip() == "A_ONLY"
    assert patch_a.ok is True
    assert (project_a / "shared.txt").read_text(encoding="utf-8") == "A_PATCHED\n"
    assert (project_b / "shared.txt").read_text(encoding="utf-8") == "B_ONLY\n"


async def test_apply_patch_cannot_modify_another_workspace(tmp_path) -> None:
    project_a = tmp_path / "project-a"
    project_b = tmp_path / "project-b"
    project_a.mkdir()
    project_b.mkdir()
    target_b = (project_b / "shared.txt").resolve()
    target_b.write_text("B_ONLY\n", encoding="utf-8")

    result = await _run(
        "apply_patch",
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
