from __future__ import annotations

from dataclasses import dataclass, field
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from backend.app.agent.tool_call_progress import (
    build_text_diff,
    count_text_lines,
    finalize_file_change,
)
from backend.app.core.logger import logger
from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.file_access import relative_tool_path, resolve_file_access_path
from backend.app.tools.registry import ToolRegistry

EDIT_FILE_USAGE = """在文件访问权限允许范围内修改、删除或移动已有 UTF-8 文本文件，
并返回文件变更 diff。

patch 必须使用以下文件操作头；不接受普通 unified diff 文件头：
- *** Update File: <path>
- *** Delete File: <path>
- *** Move to: <path>（只能跟在 Update File 后面）

更新文件示例：
*** Begin Patch
*** Update File: docs/note.md
@@
 原有内容
+新增内容
*** End Patch

删除文件示例：
*** Begin Patch
*** Delete File: docs/old.md
*** End Patch

移动并修改文件示例：
*** Begin Patch
*** Update File: docs/old.md
*** Move to: docs/new.md
@@
-旧标题
+新标题
*** End Patch

禁止写法：不要写 `*** docs/file.md`、`--- docs/file.md`、`+++ docs/file.md`，
也不要只写普通 unified diff hunk，例如 `@@ -1,2 +1,3 @@`。"""

PATCH_PARAMETER_DESCRIPTION = """完整的结构化文本编辑补丁。必须以 `*** Begin Patch` 开始，
并以 `*** End Patch` 结束。
每个文件操作必须使用 `*** Update File: <path>` 或 `*** Delete File: <path>`。
Update File 正文只能写 patch hunk，不要直接粘贴修改后的完整文件内容。
Update File 内容行必须以空格、+、-、@@、`*** Move to: <path>` 或
`*** End of File` 开头；上下文行必须保留前导空格。空白上下文行写成一个空格，
新增空白行写成 `+`，删除空白行写成 `-`。"""

PATCH_EXPECTED_HEADERS = [
    "*** Update File: <path>",
    "*** Delete File: <path>",
]


@dataclass(frozen=True)
class PatchHunk:
    header: str
    lines: list[str]
    end_of_file: bool = False


@dataclass(frozen=True)
class PatchOperation:
    kind: str
    path: str
    lines: list[str] = field(default_factory=list)
    move_to: str | None = None
    body_start_line: int = 0


@dataclass(frozen=True)
class PlannedChange:
    kind: str
    target: Path
    destination: Path
    relative_path: str
    relative_destination: str
    before: str
    after: str
    patch_lines: list[str]


def create_patch_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="edit_file",
            description=EDIT_FILE_USAGE,
            parameters={
                "type": "object",
                "properties": {
                    "patch": {
                        "type": "string",
                        "description": PATCH_PARAMETER_DESCRIPTION,
                    }
                },
                "required": ["patch"],
            },
            handler=apply_patch_tool,
        )
    ]


def register_patch_tools(registry: ToolRegistry) -> ToolRegistry:
    for tool in create_patch_tools():
        registry.register(tool)
    return registry


async def apply_patch_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    patch = args.get("patch")
    if not isinstance(patch, str) or not patch.strip():
        raise ToolExecutionError("patch 必须是非空字符串", code="invalid_tool_args")

    operations = _parse_patch(patch)
    planned_changes = _preflight_changes(operations, context)
    _write_planned_changes(planned_changes)
    changes = [_change_result(change, context) for change in planned_changes]

    logger.info(
        "[EditFileTool] 应用文件编辑补丁完成 | "
        f"changes={len(changes)} | summary={_summarize_changes(changes)}"
    )
    return {"changes": changes, "files": changes}


def _parse_patch(patch: str) -> list[PatchOperation]:
    lines = patch.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    while lines and lines[-1] == "":
        lines.pop()
    if not lines or lines[0] != "*** Begin Patch":
        raise ToolExecutionError("patch 必须以 *** Begin Patch 开始", code="invalid_patch")
    if len(lines) < 2 or lines[-1] != "*** End Patch":
        raise ToolExecutionError("patch 必须以 *** End Patch 结束", code="invalid_patch")

    operations: list[PatchOperation] = []
    index = 1
    while index < len(lines) - 1:
        header = lines[index]
        if header.startswith("*** Update File: "):
            index = _collect_update_operation(lines, index, operations)
        elif header.startswith("*** Delete File: "):
            path = header.removeprefix("*** Delete File: ").strip()
            if not path:
                raise ToolExecutionError("Delete File 缺少路径", code="invalid_patch")
            operations.append(PatchOperation(kind="delete", path=path))
            index += 1
        else:
            _raise_unrecognized_patch_line(header, index + 1)

    if not operations:
        raise ToolExecutionError("patch 没有任何文件操作", code="invalid_patch")
    return operations


def _collect_update_operation(
    lines: list[str],
    index: int,
    operations: list[PatchOperation],
) -> int:
    path = lines[index].removeprefix("*** Update File: ").strip()
    if not path:
        raise ToolExecutionError("Update File 缺少路径", code="invalid_patch")
    index += 1
    move_to: str | None = None
    if index < len(lines) - 1 and lines[index].startswith("*** Move to: "):
        move_to = lines[index].removeprefix("*** Move to: ").strip()
        if not move_to:
            raise ToolExecutionError("Move to 缺少路径", code="invalid_patch")
        index += 1

    body_start_line = index + 1
    body: list[str] = []
    while index < len(lines) - 1 and not _is_file_operation_header(lines[index]):
        body.append(lines[index])
        index += 1
    if not body and not move_to:
        raise ToolExecutionError("Update File 缺少有效变更", code="invalid_patch")
    operations.append(
        PatchOperation(
            kind="update",
            path=path,
            lines=body,
            move_to=move_to,
            body_start_line=body_start_line,
        )
    )
    return index


def _is_file_operation_header(line: str) -> bool:
    return line.startswith("*** Update File: ") or line.startswith("*** Delete File: ")


def _raise_unrecognized_patch_line(line: str, line_number: int) -> None:
    hint = "文件操作头必须写成 `*** Update File: <path>` 或 `*** Delete File: <path>`。"
    if line.startswith("*** ") and ":" not in line:
        hint = (
            "看起来你写成了 `*** <path>`。这不是有效的 edit_file 文件操作头；"
            "如果要修改已有文件，请改成 `*** Update File: <path>`。"
        )
    elif line.startswith("--- ") or line.startswith("+++ ") or line.startswith("@@ -"):
        hint = (
            "当前工具不接受普通 unified diff 文件头。请先写 `*** Update File: <path>`，"
            "然后在其后放置以空格、+、- 或 @@ 开头的变更行。"
        )
    raise ToolExecutionError(
        "无法识别的 patch 行",
        code="invalid_patch",
        details={
            "line": line,
            "line_number": line_number,
            "expected_headers": PATCH_EXPECTED_HEADERS,
            "hint": hint,
        },
    )


def _preflight_changes(
    operations: list[PatchOperation],
    context: ToolExecutionContext,
) -> list[PlannedChange]:
    state: dict[Path, str | None] = {}
    planned: list[PlannedChange] = []
    for operation in operations:
        target = _resolve(operation.path, context)
        if operation.kind == "update":
            planned_change = _plan_update(target, operation, context, state)
        elif operation.kind == "delete":
            planned_change = _plan_delete(target, operation, context, state)
        else:
            raise ToolExecutionError(
                "不支持的 patch 操作",
                code="invalid_patch",
                details={"operation": operation.kind},
            )
        planned.append(planned_change)
    return planned


def _plan_update(
    target: Path,
    operation: PatchOperation,
    context: ToolExecutionContext,
    state: dict[Path, str | None],
) -> PlannedChange:
    original = _state_content(target, context, state)
    destination = _resolve(operation.move_to, context) if operation.move_to else target
    if destination != target and _state_exists(destination, state):
        raise ToolExecutionError(
            "移动目标已存在",
            code="patch_target_exists",
            details={"path": _relative_missing(destination, context)},
        )
    updated = _apply_update_hunks(
        original,
        operation.lines,
        path=_relative_missing(target, context),
        start_line=operation.body_start_line,
    )
    state[target] = None
    state[destination] = updated
    return PlannedChange(
        kind="move" if operation.move_to else "update",
        target=target,
        destination=destination,
        relative_path=_relative_missing(target, context),
        relative_destination=_relative_missing(destination, context),
        before=original,
        after=updated,
        patch_lines=_move_patch_lines(operation),
    )


def _plan_delete(
    target: Path,
    operation: PatchOperation,
    context: ToolExecutionContext,
    state: dict[Path, str | None],
) -> PlannedChange:
    original = _state_content(target, context, state)
    state[target] = None
    return PlannedChange(
        kind="delete",
        target=target,
        destination=target,
        relative_path=_relative_missing(target, context),
        relative_destination=_relative_missing(target, context),
        before=original,
        after="",
        patch_lines=operation.lines,
    )


def _state_exists(path: Path, state: dict[Path, str | None]) -> bool:
    if path in state:
        return state[path] is not None
    return path.exists()


def _state_content(
    path: Path,
    context: ToolExecutionContext,
    state: dict[Path, str | None],
) -> str:
    if path in state:
        content = state[path]
        if content is None:
            raise ToolExecutionError(
                "更新文件不存在",
                code="file_not_found",
                details={"path": _relative_missing(path, context)},
            )
        return content
    if not path.exists():
        raise ToolExecutionError(
            "更新文件不存在",
            code="file_not_found",
            details={"path": _relative_missing(path, context)},
        )
    if not path.is_file():
        raise ToolExecutionError(
            "更新目标不是文件",
            code="path_not_file",
            details={"path": _relative_missing(path, context)},
        )
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ToolExecutionError(
            "文件不是 UTF-8 文本",
            code="file_not_text",
            details={"path": _relative_missing(path, context)},
        ) from exc


def _apply_update_hunks(original: str, lines: list[str], *, path: str, start_line: int) -> str:
    if not lines:
        return original
    hunks = _parse_hunks(lines, start_line=start_line)
    current = original.splitlines()
    trailing_newline = original.endswith("\n")
    cursor = 0
    for hunk in hunks:
        old_lines, new_lines, added, removed = _hunk_lines(hunk)
        if added == 0 and removed == 0:
            continue
        search_start = _search_start_for_hunk(current, hunk, cursor)
        if hunk.end_of_file and old_lines:
            search_start = max(search_start, len(current) - len(old_lines))
        position = _find_sequence(current, old_lines, search_start)
        if position is None:
            raise ToolExecutionError(
                "patch 上下文不匹配，拒绝覆盖当前文件",
                code="patch_context_mismatch",
                details={"path": path},
            )
        current[position : position + len(old_lines)] = new_lines
        cursor = position + len(new_lines)
        if hunk.end_of_file:
            trailing_newline = False
    if not current:
        return ""
    return "\n".join(current) + ("\n" if trailing_newline else "")


def _parse_hunks(lines: list[str], *, start_line: int = 1) -> list[PatchHunk]:
    hunks: list[PatchHunk] = []
    header = "@@"
    body: list[str] = []
    end_of_file = False
    saw_hunk_header = False
    current_hunk_line_number = start_line
    for offset, line in enumerate(lines):
        line_number = start_line + offset
        if line == "*** End of File":
            if not body:
                _raise_empty_update_hunk_before_end_of_file(line_number)
            end_of_file = True
            continue
        if line == "@@" or line.startswith("@@ "):
            if saw_hunk_header and not body:
                _raise_empty_update_hunk(current_hunk_line_number)
            if saw_hunk_header or body:
                hunks.append(PatchHunk(header=header, lines=body, end_of_file=end_of_file))
            header = line[2:].strip()
            body = []
            end_of_file = False
            saw_hunk_header = True
            current_hunk_line_number = line_number
            continue
        normalized_line = _normalize_hunk_body_line(line)
        if normalized_line is None:
            _raise_invalid_update_hunk_line(line, line_number)
        body.append(normalized_line)
    if saw_hunk_header and not body:
        _raise_empty_update_hunk(current_hunk_line_number)
    if saw_hunk_header or body:
        hunks.append(PatchHunk(header=header, lines=body, end_of_file=end_of_file))
    if not hunks:
        raise ToolExecutionError("Update File 缺少有效变更", code="invalid_patch")
    return hunks


def _normalize_hunk_body_line(line: str) -> str | None:
    if line.startswith((" ", "+", "-")):
        return line
    if line == "":
        return " "
    return None


def _raise_empty_update_hunk_before_end_of_file(line_number: int) -> None:
    raise ToolExecutionError(
        "Update hunk 缺少变更行，不能在空的 @@ 块后直接写 *** End of File",
        code="invalid_patch",
        details={
            "line": "*** End of File",
            "line_number": line_number,
            "hint": (
                "请先在 @@ 块内写至少一行以空格、+ 或 - 开头的内容；"
                "如果只是追加到文件末尾，通常不需要写 *** End of File。"
            ),
        },
    )


def _raise_empty_update_hunk(line_number: int) -> None:
    raise ToolExecutionError(
        "Update hunk 缺少变更行",
        code="invalid_patch",
        details={
            "line": "@@",
            "line_number": line_number,
            "hint": "每个 @@ 块内至少要有一行以空格、+ 或 - 开头的内容。",
        },
    )


def _raise_invalid_update_hunk_line(line: str, line_number: int) -> None:
    expected_prefixes = [" ", "+", "-", "@@", "*** End of File"]
    hint = "上下文行必须以一个空格开头；新增行用 +，删除行用 -。"
    message = "Update File 内容行缺少行类型前缀"
    if line.startswith("*** Add File: "):
        message = "Update File 正文中不能嵌入 *** Add File 文件操作头"
        hint = "Keydex 当前新增文件应使用 create_file；edit_file 只用于修改、删除或移动已有文件。"
    elif line.startswith("*** Update File: ") or line.startswith("*** Delete File: "):
        message = "文件操作头位置错误"
        hint = "文件操作头只能出现在文件操作层；如果要结束当前修改，请先完成当前 @@ 块。"
    elif line.startswith("*** Move to: "):
        message = "*** Move to 只能紧跟在 *** Update File 后面"
        hint = "请把 *** Move to: <new-path> 放到 *** Update File: <path> 的下一行，不能放在 @@ 块内。"
    elif line.startswith("*** "):
        message = "无法识别或位置错误的 Update File 标记"
        hint = "只有单独一行的 *** End of File 可以出现在 Update File 正文中，且前一个 @@ 块必须已有内容。"
    elif line.startswith("--- ") or line.startswith("+++ "):
        message = "Update File 正文不接受普通 unified diff 文件头"
        hint = "不要写 ---/+++ 文件头；在 *** Update File: <path> 后直接写 @@ 和变更行。"
    raise ToolExecutionError(
        message,
        code="invalid_patch",
        details={
            "line": line,
            "line_number": line_number,
            "expected_prefixes": expected_prefixes,
            "hint": hint,
        },
    )


def _hunk_lines(hunk: PatchHunk) -> tuple[list[str], list[str], int, int]:
    old_lines: list[str] = []
    new_lines: list[str] = []
    added = 0
    removed = 0
    for line in hunk.lines:
        if line.startswith(" "):
            value = line[1:]
            old_lines.append(value)
            new_lines.append(value)
        elif line.startswith("-"):
            old_lines.append(line[1:])
            removed += 1
        elif line.startswith("+"):
            new_lines.append(line[1:])
            added += 1
    return old_lines, new_lines, added, removed


def _search_start_for_hunk(current: list[str], hunk: PatchHunk, cursor: int) -> int:
    if not hunk.header:
        return cursor
    header = hunk.header.strip()
    if not header:
        return cursor
    for index in range(cursor, len(current)):
        if header in current[index]:
            return index
    return cursor


def _find_sequence(lines: list[str], sequence: list[str], start: int) -> int | None:
    if not sequence:
        return min(start, len(lines))
    for index in range(min(start, len(lines)), len(lines) - len(sequence) + 1):
        if lines[index : index + len(sequence)] == sequence:
            return index
    return None


def _write_planned_changes(changes: list[PlannedChange]) -> None:
    for change in changes:
        if change.kind == "delete":
            change.target.unlink()
            continue
        change.destination.parent.mkdir(parents=True, exist_ok=True)
        change.destination.write_text(change.after, encoding="utf-8", newline="")
        if change.kind == "move" and change.target != change.destination and change.target.exists():
            change.target.unlink()


def _change_result(change: PlannedChange, context: ToolExecutionContext) -> dict[str, Any]:
    added, deleted = _change_counts(change)
    diff = _patch_diff(change)
    result = finalize_file_change(
        {
            "operation": "update",
            "change_type": change.kind,
            "path": change.relative_destination if change.kind == "move" else change.relative_path,
            "added_lines": added,
            "deleted_lines": deleted,
            "diff": diff,
        }
    )
    if change.kind == "delete":
        result["removed_bytes"] = len(change.before.encode("utf-8"))
    if change.kind == "move":
        result["old_path"] = change.relative_path
        result["new_path"] = change.relative_destination
    return result


def _change_counts(change: PlannedChange) -> tuple[int, int]:
    if change.kind == "delete":
        return 0, count_text_lines(change.before)
    before_lines = change.before.splitlines()
    after_lines = change.after.splitlines()
    added = 0
    deleted = 0
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, before_lines, after_lines).get_opcodes():
        if tag == "equal":
            continue
        if tag in {"replace", "delete"}:
            deleted += i2 - i1
        if tag in {"replace", "insert"}:
            added += j2 - j1
    return added, deleted


def _patch_diff(change: PlannedChange) -> str:
    if change.kind == "delete":
        return build_text_diff(
            path=change.relative_path,
            before=change.before,
            after="",
            operation="delete",
        )
    if change.kind == "move":
        return build_text_diff(
            path=change.relative_destination,
            before=change.before,
            after=change.after,
        ).replace(f"--- a/{change.relative_destination}", f"--- a/{change.relative_path}", 1)
    return build_text_diff(
        path=change.relative_path,
        before=change.before,
        after=change.after,
    )


def _operation_diff(path: str, operation: str, lines: list[str]) -> str:
    if operation == "delete":
        header = [f"--- a/{path}", "+++ /dev/null"]
    else:
        header = [f"--- a/{path}", f"+++ b/{path}"]
    return "\n".join([*header, *lines])


def _move_patch_lines(operation: PatchOperation) -> list[str]:
    if operation.move_to:
        return [f"*** Move to: {operation.move_to}", *operation.lines]
    return operation.lines


def _resolve(raw_path: str | None, context: ToolExecutionContext) -> Path:
    return resolve_file_access_path(raw_path, context, operation="write")


def _relative_missing(path: Path, context: ToolExecutionContext) -> str:
    return relative_tool_path(path, context)


def _summarize_changes(changes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "operation": change.get("operation"),
            "change_type": change.get("change_type"),
            "path": change.get("path"),
            "old_path": change.get("old_path"),
            "new_path": change.get("new_path"),
            "added_lines": change.get("added_lines"),
            "removed_lines": change.get("removed_lines"),
            "removed_bytes": change.get("removed_bytes"),
        }
        for change in changes
    ]
