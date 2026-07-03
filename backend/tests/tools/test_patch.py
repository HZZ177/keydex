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
    return await _registry().require("edit_file").run({"patch": patch}, _context(tmp_path))


def test_edit_file_tool_contract_documents_required_headers() -> None:
    tool = _registry().require("edit_file")

    assert "*** Update File: <path>" in tool.description
    assert "*** Delete File: <path>" in tool.description
    assert "不要写 `*** docs/file.md`" in tool.description
    assert "*** Update File: <path>" in tool.parameters["properties"]["patch"]["description"]
    assert "空白上下文行" in tool.parameters["properties"]["patch"]["description"]


async def test_apply_patch_rejects_add_file_to_keep_creation_separate(tmp_path) -> None:
    result = await _run(
        """*** Begin Patch
*** Add File: docs/note.txt
+第一行
+第二行
*** End Patch""",
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "invalid_patch"
    assert result.error["details"]["line"] == "*** Add File: docs/note.txt"
    assert not (tmp_path / "docs" / "note.txt").exists()


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
    assert result.result["changes"][0]["change_type"] == "update"
    assert result.result["changes"][0]["added_lines"] == 1
    assert result.result["changes"][0]["deleted_lines"] == 1
    assert result.result["changes"][0]["diff"] == (
        "--- a/src/app.py\n"
        "+++ b/src/app.py\n"
        "@@ -1,3 +1,3 @@\n"
        " alpha\n"
        "-old\n"
        "+new\n"
        " omega"
    )
    assert target.read_text(encoding="utf-8") == "alpha\nnew\nomega\n"


async def test_apply_patch_updates_file_with_multiple_hunks(tmp_path) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir()
    target.write_text("alpha\nold-a\nmiddle\nold-b\nomega\n", encoding="utf-8")

    result = await _run(
        """*** Begin Patch
*** Update File: src/app.py
@@ alpha
 alpha
-old-a
+new-a
 middle
@@ old-b
-old-b
+new-b
 omega
*** End Patch""",
        tmp_path,
    )

    assert result.ok is True
    assert result.result["changes"][0]["added_lines"] == 2
    assert result.result["changes"][0]["deleted_lines"] == 2
    assert target.read_text(encoding="utf-8") == "alpha\nnew-a\nmiddle\nnew-b\nomega\n"


async def test_apply_patch_accepts_bare_empty_context_lines_for_compatibility(tmp_path) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir()
    target.write_text("alpha\nold\n\nomega\n", encoding="utf-8")

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
    assert result.result["changes"][0]["added_lines"] == 1
    assert result.result["changes"][0]["deleted_lines"] == 1
    assert target.read_text(encoding="utf-8") == "alpha\nnew\n\nomega\n"


async def test_apply_patch_rejects_unprefixed_non_empty_update_lines(tmp_path) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir()
    target.write_text("alpha\nold\n", encoding="utf-8")

    result = await _run(
        """*** Begin Patch
*** Update File: src/app.py
@@
alpha
-old
+new
*** End Patch""",
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "invalid_patch"
    assert result.error["message"] == "Update File 内容行缺少行类型前缀"
    assert result.error["details"]["line"] == "alpha"
    assert result.error["details"]["line_number"] == 4
    assert "上下文行必须以一个空格开头" in result.error["details"]["hint"]
    assert target.read_text(encoding="utf-8") == "alpha\nold\n"


async def test_apply_patch_rejects_structural_marker_inside_update_body(tmp_path) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir()
    target.write_text("alpha\n", encoding="utf-8")

    result = await _run(
        """*** Begin Patch
*** Update File: src/app.py
@@
 alpha
*** Add File: src/new.py
*** End Patch""",
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "invalid_patch"
    assert result.error["message"] == "Update File 正文中不能嵌入 *** Add File 文件操作头"
    assert result.error["details"]["line"] == "*** Add File: src/new.py"
    assert result.error["details"]["line_number"] == 5
    assert "create_file" in result.error["details"]["hint"]
    assert result.error["details"]["expected_prefixes"] == [" ", "+", "-", "@@", "*** End of File"]
    assert target.read_text(encoding="utf-8") == "alpha\n"


async def test_apply_patch_rejects_empty_hunk_before_end_of_file_with_specific_hint(
    tmp_path,
) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir()
    target.write_text("alpha\n", encoding="utf-8")

    result = await _run(
        """*** Begin Patch
*** Update File: src/app.py
@@
*** End of File
*** End Patch""",
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "invalid_patch"
    assert result.error["message"] == "Update hunk 缺少变更行，不能在空的 @@ 块后直接写 *** End of File"
    assert result.error["details"]["line"] == "*** End of File"
    assert result.error["details"]["line_number"] == 4
    assert "通常不需要写 *** End of File" in result.error["details"]["hint"]
    assert target.read_text(encoding="utf-8") == "alpha\n"


async def test_apply_patch_rejects_empty_hunk_with_specific_hint(tmp_path) -> None:
    target = tmp_path / "src" / "app.py"
    target.parent.mkdir()
    target.write_text("alpha\n", encoding="utf-8")

    result = await _run(
        """*** Begin Patch
*** Update File: src/app.py
@@
*** End Patch""",
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "invalid_patch"
    assert result.error["message"] == "Update hunk 缺少变更行"
    assert result.error["details"]["line"] == "@@"
    assert result.error["details"]["line_number"] == 3
    assert "至少要有一行" in result.error["details"]["hint"]
    assert target.read_text(encoding="utf-8") == "alpha\n"


async def test_apply_patch_deletes_file_with_removed_line_count(tmp_path) -> None:
    target = tmp_path / "docs" / "old.txt"
    target.parent.mkdir()
    target.write_text("one\ntwo\nthree\n", encoding="utf-8")

    result = await _run(
        """*** Begin Patch
*** Delete File: docs/old.txt
*** End Patch""",
        tmp_path,
    )

    assert result.ok is True
    change = result.result["changes"][0]
    assert change["operation"] == "update"
    assert change["change_type"] == "delete"
    assert change["path"] == "docs/old.txt"
    assert change["added_lines"] == 0
    assert change["removed_lines"] == 3
    assert change["deleted_lines"] == 3
    assert change["additions"] == 0
    assert change["deletions"] == 3
    assert change["diff"] == (
        "--- a/docs/old.txt\n"
        "+++ /dev/null\n"
        "@@ -1,3 +0,0 @@\n"
        "-one\n"
        "-two\n"
        "-three"
    )
    assert result.result["changes"][0]["removed_bytes"] > 0
    assert not target.exists()


async def test_apply_patch_moves_file_and_updates_content(tmp_path) -> None:
    target = tmp_path / "docs" / "old.md"
    target.parent.mkdir()
    target.write_text("title: old\nbody\n", encoding="utf-8")

    result = await _run(
        """*** Begin Patch
*** Update File: docs/old.md
*** Move to: docs/new.md
@@
-title: old
+title: new
 body
*** End Patch""",
        tmp_path,
    )

    assert result.ok is True
    change = result.result["changes"][0]
    assert change["operation"] == "update"
    assert change["change_type"] == "move"
    assert change["old_path"] == "docs/old.md"
    assert change["new_path"] == "docs/new.md"
    assert change["path"] == "docs/new.md"
    assert change["diff"] == (
        "--- a/docs/old.md\n"
        "+++ b/docs/new.md\n"
        "@@ -1,2 +1,2 @@\n"
        "-title: old\n"
        "+title: new\n"
        " body"
    )
    assert not target.exists()
    assert (tmp_path / "docs" / "new.md").read_text(encoding="utf-8") == "title: new\nbody\n"


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


async def test_apply_patch_error_explains_shorthand_file_header(tmp_path) -> None:
    result = await _run(
        """*** Begin Patch
*** docs/project-structure.md
--- docs/project-structure.md
@@ -1,2 +1,3 @@
 # Keydex 项目结构
+> 使用 Mermaid 绘制的完整项目结构图，可在支持 Mermaid 的 Markdown 预览中查看。

*** End Patch""",
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "invalid_patch"
    assert result.error["details"]["line"] == "*** docs/project-structure.md"
    assert result.error["details"]["expected_headers"] == [
        "*** Update File: <path>",
        "*** Delete File: <path>",
    ]
    assert "*** Update File: <path>" in result.error["details"]["hint"]


async def test_apply_patch_rejects_workspace_escape(tmp_path) -> None:
    outside = (tmp_path.parent / "outside.txt").resolve()

    result = await _run(
        f"""*** Begin Patch
*** Update File: {outside}
@@
-bad
+worse
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


async def test_apply_patch_preflight_rejects_second_operation_without_partial_write(
    tmp_path,
) -> None:
    first = tmp_path / "a.txt"
    first.write_text("old\n", encoding="utf-8")

    result = await _run(
        """*** Begin Patch
*** Update File: a.txt
@@
-old
+new
*** Update File: missing.txt
@@
-missing
+new
*** End Patch""",
        tmp_path,
    )

    assert result.ok is False
    assert result.error["code"] == "file_not_found"
    assert first.read_text(encoding="utf-8") == "old\n"
