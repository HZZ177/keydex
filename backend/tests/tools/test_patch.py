from __future__ import annotations

from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.patch import register_patch_tools


def _context(tmp_path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses_patch",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
    )


def _registry() -> ToolRegistry:
    return register_patch_tools(ToolRegistry())


async def _run(patch: str, tmp_path):
    return await _registry().require("apply_patch").run({"patch": patch}, _context(tmp_path))


async def test_apply_patch_adds_file_inside_workspace(tmp_path) -> None:
    result = await _run(
        """*** Begin Patch
*** Add File: docs/note.txt
+第一行
+第二行
*** End Patch""",
        tmp_path,
    )

    assert result.ok is True
    assert result.result["changes"] == [
        {
            "operation": "add",
            "path": "docs/note.txt",
            "added_lines": 2,
            "removed_lines": 0,
        }
    ]
    assert (tmp_path / "docs" / "note.txt").read_text(encoding="utf-8") == "第一行\n第二行\n"


async def test_apply_patch_updates_file_with_matching_context(tmp_path) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir()
    target.write_text("alpha\nold\nomega\n", encoding="utf-8")

    result = await _run(
        """*** Begin Patch
*** Update File: src/app.py
@@
 alpha
-old
+new
 omega
*** End Patch""",
        tmp_path,
    )

    assert result.ok is True
    assert result.result["changes"][0]["operation"] == "update"
    assert target.read_text(encoding="utf-8") == "alpha\nnew\nomega\n"


async def test_apply_patch_rejects_invalid_patch(tmp_path) -> None:
    result = await _run(
        """*** Begin Patch
*** Add File: broken.txt
missing-plus
*** End Patch""",
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "invalid_patch"


async def test_apply_patch_rejects_workspace_escape(tmp_path) -> None:
    outside = (tmp_path.parent / "outside.txt").resolve()

    result = await _run(
        f"""*** Begin Patch
*** Add File: {outside}
+bad
*** End Patch""",
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "workspace_path_forbidden"


async def test_apply_patch_rejects_context_mismatch(tmp_path) -> None:
    target = tmp_path / "readme.md"
    target.write_text("current\n", encoding="utf-8")

    result = await _run(
        """*** Begin Patch
*** Update File: readme.md
@@
-old
+new
*** End Patch""",
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "patch_context_mismatch"
    assert target.read_text(encoding="utf-8") == "current\n"
