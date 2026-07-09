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

patch 是结构化文本补丁，整体 envelope：
*** Begin Patch
[一个或多个已有文件操作]
*** End Patch

支持的文件操作：
- *** Update File: <path>：修改已有文件；下一行可选 `*** Move to: <path>` 用于移动/重命名。
- *** Delete File: <path>：删除已有文件；后面不写正文。

不支持 `*** Add File`；新增文件必须使用 `create_file`。

Update File 正文只写一个或多个 `@@` hunk：
*** Begin Patch
*** Update File: docs/note.md
@@
 原有内容
+新增内容
*** End Patch

关键规则：
- 上下文行以一个空格开头；新增行以 `+` 开头；删除行以 `-` 开头。
- 空白上下文行可以是空行或单独一个空格；新增空白行写 `+`；删除空白行写 `-`。
- 不要粘贴完整重写后的文件内容；不要写 `---`/`+++` unified diff 文件头。
- `*** End of File` 很少需要；如使用，必须放在已有 hunk 内容之后。"""

PATCH_PARAMETER_DESCRIPTION = """结构化文本补丁。整体必须是 `*** Begin Patch`、一个或多个
已有文件操作、`*** End Patch`。
文件操作层只支持 `*** Update File: <path>` 和 `*** Delete File: <path>`；
`*** Add File` 无效，新增文件必须使用 `create_file`。
`*** Move to: <path>` 只能紧跟在 `*** Update File: <path>` 后面。
Update File 正文只写 `@@` hunk：上下文行以一个空格开头，新增行以 `+` 开头，
删除行以 `-` 开头；空白上下文行可以是空行或单独一个空格，新增空白行写 `+`，
删除空白行写 `-`。不要粘贴完整重写后的文件内容，不要写 `---`/`+++` 文件头。
`*** End of File` 很少需要；如使用，必须放在已有 hunk 内容之后。"""

PATCH_EXPECTED_HEADERS = [
    "*** Update File: <path>",
    "*** Delete File: <path>",
]

BEGIN_PATCH_MARKER = "*** Begin Patch"
END_PATCH_MARKER = "*** End Patch"
ADD_FILE_MARKER = "*** Add File: "
DELETE_FILE_MARKER = "*** Delete File: "
UPDATE_FILE_MARKER = "*** Update File: "
MOVE_TO_MARKER = "*** Move to: "
EOF_MARKER = "*** End of File"

HEREDOC_OPENERS = {"<<EOF", "<<'EOF'", '<<"EOF"'}


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
    lines = _prepare_patch_lines(patch)
    if not lines or not _is_patch_boundary_marker(lines[0], BEGIN_PATCH_MARKER):
        raise ToolExecutionError("patch 必须以 *** Begin Patch 开始", code="invalid_patch")
    if len(lines) < 2 or not _is_patch_boundary_marker(lines[-1], END_PATCH_MARKER):
        raise ToolExecutionError("patch 必须以 *** End Patch 结束", code="invalid_patch")

    operations: list[PatchOperation] = []
    index = 1
    while index < len(lines) - 1:
        header = _operation_layer_marker(lines[index])
        if header.startswith(UPDATE_FILE_MARKER):
            index = _collect_update_operation(lines, index, operations)
        elif header.startswith(DELETE_FILE_MARKER):
            path = header.removeprefix(DELETE_FILE_MARKER).strip()
            if not path:
                raise ToolExecutionError("Delete File 缺少路径", code="invalid_patch")
            operations.append(PatchOperation(kind="delete", path=path))
            index += 1
        elif header.startswith(ADD_FILE_MARKER):
            _raise_unsupported_add_file(lines[index], index + 1)
        else:
            _raise_unrecognized_patch_line(header, index + 1)

    if not operations:
        raise ToolExecutionError("patch 没有任何文件操作", code="invalid_patch")
    return operations


def _prepare_patch_lines(patch: str) -> list[str]:
    normalized = patch.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []
    lines = normalized.split("\n")
    heredoc_lines = _extract_lenient_heredoc_lines(lines)
    if heredoc_lines is not None:
        lines = heredoc_lines
    while lines and lines[-1].strip() == "":
        lines.pop()
    return lines


def _extract_lenient_heredoc_lines(lines: list[str]) -> list[str] | None:
    if len(lines) >= 4 and lines[0] in HEREDOC_OPENERS and lines[-1].endswith("EOF"):
        return lines[1:-1]
    return None


def _is_patch_boundary_marker(line: str, marker: str) -> bool:
    # Only envelope markers are whitespace-tolerant; hunk body prefixes are semantic.
    return line.strip() == marker


def _operation_layer_marker(line: str) -> str:
    return line.strip()


def _update_layer_marker(line: str) -> str:
    return line.rstrip()


def _collect_update_operation(
    lines: list[str],
    index: int,
    operations: list[PatchOperation],
) -> int:
    path = _operation_layer_marker(lines[index]).removeprefix(UPDATE_FILE_MARKER).strip()
    if not path:
        raise ToolExecutionError("Update File 缺少路径", code="invalid_patch")
    index += 1
    move_to: str | None = None
    if index < len(lines) - 1 and _operation_layer_marker(lines[index]).startswith(MOVE_TO_MARKER):
        move_to = _operation_layer_marker(lines[index]).removeprefix(MOVE_TO_MARKER).strip()
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
    marker = _update_layer_marker(line)
    return (
        marker.startswith(UPDATE_FILE_MARKER)
        or marker.startswith(DELETE_FILE_MARKER)
        or marker.startswith(ADD_FILE_MARKER)
    )


def _raise_unsupported_add_file(line: str, line_number: int) -> None:
    raise ToolExecutionError(
        "edit_file 不支持 *** Add File",
        code="invalid_patch",
        details={
            "line": line,
            "line_number": line_number,
            "expected_headers": PATCH_EXPECTED_HEADERS,
            "hint": "新增文件请使用 create_file；edit_file 只用于修改、删除或移动已有文件。",
        },
    )


def _raise_unrecognized_patch_line(line: str, line_number: int) -> None:
    hint = "文件操作头必须写成 `*** Update File: <path>` 或 `*** Delete File: <path>`。"
    marker = line.strip()
    if marker.startswith("*** ") and ":" not in marker:
        hint = (
            "看起来你写成了 `*** <path>`。这不是有效的 edit_file 文件操作头；"
            "如果要修改已有文件，请改成 `*** Update File: <path>`。"
        )
    elif marker.startswith("--- ") or marker.startswith("+++ ") or marker.startswith("@@ -"):
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
        if not old_lines:
            current[len(current) : len(current)] = new_lines
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
        marker = _update_layer_marker(line)
        if end_of_file and marker == "":
            continue
        if end_of_file and marker != "@@" and not marker.startswith("@@ "):
            _raise_invalid_line_after_end_of_file(line, line_number)
        if marker == EOF_MARKER:
            if not body:
                _raise_empty_update_hunk_before_end_of_file(line_number)
            end_of_file = True
            continue
        if marker == "@@" or marker.startswith("@@ "):
            if saw_hunk_header and not body:
                _raise_empty_update_hunk(current_hunk_line_number)
            if saw_hunk_header or body:
                hunks.append(PatchHunk(header=header, lines=body, end_of_file=end_of_file))
            header = marker[2:].strip()
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


def _raise_invalid_line_after_end_of_file(line: str, line_number: int) -> None:
    raise ToolExecutionError(
        "Update hunk 在 *** End of File 后只能开始新的 @@ 块或结束 patch",
        code="invalid_patch",
        details={
            "line": line,
            "line_number": line_number,
            "expected_prefixes": ["@@", END_PATCH_MARKER],
            "hint": "*** End of File 表示当前 hunk 已锚定文件末尾；后续非空内容必须从新的 @@ 块开始。",
        },
    )


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
