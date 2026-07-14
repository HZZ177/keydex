from __future__ import annotations

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
from backend.app.tools.file_history import tracked_file_mutation
from backend.app.tools.file_snapshots import (
    ensure_file_snapshot_store,
    read_current_file_content,
    record_file_snapshot,
)
from backend.app.tools.registry import ToolRegistry

EDIT_FILE_DESCRIPTION = (
    "精确替换文件访问权限允许范围内已有 UTF-8 文本文件的一段内容。"
    "old_string 非空时必须与当前文件内容完全一致且默认只允许匹配一次；"
    "建议先用 read_file 确认上下文，但不是硬性要求。"
    "old_string 为空时仅用于创建不存在的文件，或写入已有空文件/纯空白文件；目标非空会失败。"
    "如果此前读取过该文件且文件随后发生变化，会拒绝覆盖当前内容。"
    "replace_all=true 时会替换所有匹配；new_string 为空表示删除该片段。"
)

DELETE_FILE_DESCRIPTION = (
    "删除文件访问权限允许范围内已有 UTF-8 文本文件，并返回删除 diff。"
    "无需先读取文件；目录不会被递归删除。"
)

MOVE_FILE_DESCRIPTION = (
    "移动或重命名文件访问权限允许范围内已有 UTF-8 文本文件，并返回文件变更摘要。"
    "无需先读取文件；目标已存在时会失败。"
)


def create_edit_operation_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="edit_file",
            description=EDIT_FILE_DESCRIPTION,
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "工作区相对路径；完全访问时也可使用绝对文件路径。",
                    },
                    "old_string": {
                        "type": "string",
                        "description": (
                            "要替换的原文；非空时必须逐字匹配当前文件内容。"
                            "为空时仅用于创建不存在文件或写入空文件/纯空白文件。"
                        ),
                    },
                    "new_string": {
                        "type": "string",
                        "description": "替换后的文本；传空字符串表示删除 old_string 片段。",
                    },
                    "replace_all": {
                        "type": "boolean",
                        "default": False,
                        "description": (
                            "是否替换所有匹配。默认 false，多处匹配时会拒绝并提示补充上下文。"
                        ),
                    },
                },
                "required": ["path", "old_string", "new_string"],
            },
            handler=edit_file_tool,
        ),
        FunctionTool(
            name="delete_file",
            description=DELETE_FILE_DESCRIPTION,
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "要删除的工作区相对路径；完全访问时也可使用绝对文件路径。",
                    }
                },
                "required": ["path"],
            },
            handler=delete_file_tool,
        ),
        FunctionTool(
            name="move_file",
            description=MOVE_FILE_DESCRIPTION,
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": (
                            "源文件路径，工作区相对路径；完全访问时也可使用绝对文件路径。"
                        ),
                    },
                    "new_path": {
                        "type": "string",
                        "description": (
                            "目标文件路径，工作区相对路径；完全访问时也可使用绝对文件路径。"
                        ),
                    },
                },
                "required": ["path", "new_path"],
            },
            handler=move_file_tool,
        ),
    ]


def register_edit_operation_tools(registry: ToolRegistry) -> ToolRegistry:
    for tool in create_edit_operation_tools():
        registry.register(tool)
    return registry


async def edit_file_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    path = _resolve(args.get("path"), context)
    old_string = args.get("old_string")
    new_string = args.get("new_string")
    replace_all = bool(args.get("replace_all", False))
    if "patch" in args:
        raise ToolExecutionError(
            "Claude Code 风格 edit_file 不接受 patch 参数",
            code="invalid_tool_args",
            details={"hint": "如果要使用补丁语法，请在设置中切换到 Codex 风格并调用 apply_patch。"},
        )
    if not isinstance(old_string, str) or not isinstance(new_string, str):
        raise ToolExecutionError(
            "old_string 和 new_string 必须是字符串",
            code="invalid_tool_args",
        )
    if old_string == new_string:
        raise ToolExecutionError(
            "old_string 和 new_string 完全相同，拒绝无效编辑",
            code="no_op_edit",
            details={"path": _relative(path, context)},
        )
    if old_string == "":
        return _edit_empty_old_string(path=path, new_string=new_string, context=context)

    before = read_current_file_content(path, context=context)
    match_count = before.count(old_string)
    if match_count == 0:
        raise ToolExecutionError(
            "old_string 未在当前文件中找到",
            code="string_not_found",
            details={
                "path": _relative(path, context),
                "hint": "请重新读取文件，确认 old_string 与文件内容完全一致，必要时扩大上下文。",
            },
        )
    if match_count > 1 and not replace_all:
        raise ToolExecutionError(
            "old_string 在文件中出现多次，拒绝默认替换",
            code="multiple_matches",
            details={
                "path": _relative(path, context),
                "match_count": match_count,
                "hint": (
                    "请提供更长的 old_string 上下文，"
                    "或确认需要全部替换时设置 replace_all=true。"
                ),
            },
        )

    after = (
        before.replace(old_string, new_string)
        if replace_all
        else before.replace(old_string, new_string, 1)
    )
    with tracked_file_mutation(
        context, tool_name="edit_file", changes=((path, "update"),)
    ):
        path.write_text(after, encoding="utf-8", newline="")
        record_file_snapshot(path, context=context, content=after, full_read=True)
    relative = _relative(path, context)
    change = _file_change(
        path=relative,
        before=before,
        after=after,
        operation="update",
        change_type="update",
    )
    logger.info(
        "[EditOpsTool] 编辑文件完成 | "
        f"path={relative} | replace_all={replace_all} | matches={match_count} | "
        f"added={change['added_lines']} | deleted={change['deleted_lines']}"
    )
    return {
        "path": relative,
        "changed": True,
        "match_count": match_count,
        **change,
        "files": [change],
    }


def _edit_empty_old_string(
    *,
    path: Path,
    new_string: str,
    context: ToolExecutionContext,
) -> dict[str, Any]:
    relative = _relative(path, context)
    if path.exists() and not path.is_file():
        raise ToolExecutionError("路径不是文件", code="path_not_file", details={"path": relative})

    if not path.exists():
        with tracked_file_mutation(
            context, tool_name="edit_file", changes=((path, "create"),)
        ):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(new_string, encoding="utf-8", newline="")
            record_file_snapshot(path, context=context, content=new_string, full_read=True)
        change = _file_change(
            path=relative,
            before="",
            after=new_string,
            operation="add",
            change_type="create",
        )
        logger.info(
            "[EditOpsTool] 通过空 old_string 创建文件完成 | "
            f"path={relative} | added={change['added_lines']}"
        )
        return {
            "path": relative,
            "created": True,
            "changed": True,
            "match_count": 0,
            **change,
            "files": [change],
        }

    before = read_current_file_content(path, context=context)
    if before.strip() != "":
        raise ToolExecutionError(
            "old_string 为空时不能覆盖已有非空文件",
            code="file_exists",
            details={
                "path": relative,
                "hint": "请提供能逐字匹配当前文件内容的非空 old_string，或确认删除后再重新创建。",
            },
        )

    with tracked_file_mutation(
        context, tool_name="edit_file", changes=((path, "update"),)
    ):
        path.write_text(new_string, encoding="utf-8", newline="")
        record_file_snapshot(path, context=context, content=new_string, full_read=True)
    change = _file_change(
        path=relative,
        before=before,
        after=new_string,
        operation="update",
        change_type="update",
    )
    logger.info(
        "[EditOpsTool] 通过空 old_string 写入空文件完成 | "
        f"path={relative} | added={change['added_lines']} | deleted={change['deleted_lines']}"
    )
    return {
        "path": relative,
        "changed": True,
        "match_count": 0,
        **change,
        "files": [change],
    }


async def delete_file_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    path = _resolve(args.get("path"), context)
    before, removed_bytes = _read_structural_file(path, context=context)
    relative = _relative(path, context)
    with tracked_file_mutation(
        context, tool_name="delete_file", changes=((path, "delete"),)
    ):
        path.unlink()
        ensure_file_snapshot_store(context).discard(path)
    change = (
        _file_change(
            path=relative,
            before=before,
            after="",
            operation="delete",
            change_type="delete",
        )
        if before is not None
        else finalize_file_change(
            {
                "path": relative,
                "operation": "delete",
                "change_type": "delete",
                "added_lines": 0,
                "deleted_lines": 0,
                "diff": None,
                "binary": True,
            }
        )
    )
    change["removed_bytes"] = removed_bytes
    logger.info(
        "[EditOpsTool] 删除文件完成 | "
        f"path={relative} | deleted_lines={change['deleted_lines']}"
    )
    return {"path": relative, "deleted": True, **change, "files": [change]}


async def move_file_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    source = _resolve(args.get("path"), context)
    destination = _resolve(args.get("new_path"), context)
    if source == destination:
        raise ToolExecutionError(
            "源路径和目标路径相同，拒绝无效移动",
            code="no_op_move",
            details={"path": _relative(source, context)},
        )
    before, _source_bytes = _read_structural_file(source, context=context)
    if destination.exists():
        raise ToolExecutionError(
            "移动目标已存在",
            code="target_exists",
            details={"path": _relative(destination, context)},
        )
    with tracked_file_mutation(
        context,
        tool_name="move_file",
        changes=((source, "move_source"), (destination, "move_destination")),
    ):
        destination.parent.mkdir(parents=True, exist_ok=True)
        source.replace(destination)
        store = ensure_file_snapshot_store(context)
        store.discard(source)
        if before is not None:
            record_file_snapshot(destination, context=context, content=before, full_read=True)
        else:
            store.discard(destination)
    old_path = _relative(source, context)
    new_path = _relative(destination, context)
    diff = None
    if before is not None:
        diff = build_text_diff(path=new_path, before=before, after=before)
        if not diff:
            diff = f"--- a/{old_path}\n+++ b/{new_path}"
        else:
            diff = diff.replace(f"--- a/{new_path}", f"--- a/{old_path}", 1)
    change = finalize_file_change(
        {
            "path": new_path,
            "operation": "move",
            "change_type": "move",
            "old_path": old_path,
            "new_path": new_path,
            "added_lines": 0,
            "deleted_lines": 0,
            "diff": diff,
            "binary": before is None,
        }
    )
    logger.info(f"[EditOpsTool] 移动文件完成 | old_path={old_path} | new_path={new_path}")
    return {
        "path": new_path,
        "old_path": old_path,
        "new_path": new_path,
        "moved": True,
        **change,
        "files": [change],
    }


def _read_structural_file(
    path: Path,
    *,
    context: ToolExecutionContext,
) -> tuple[str | None, int]:
    try:
        content = read_current_file_content(path, context=context)
    except ToolExecutionError as exc:
        if exc.code != "file_not_text":
            raise
        try:
            return None, path.stat().st_size
        except OSError as stat_exc:
            raise ToolExecutionError(
                "无法读取待操作文件",
                code="file_read_failed",
                details={"path": _relative(path, context)},
            ) from stat_exc
    try:
        size = path.stat().st_size
    except OSError:
        size = len(content.encode("utf-8"))
    return content, size


def _file_change(
    *,
    path: str,
    before: str,
    after: str,
    operation: str,
    change_type: str,
) -> dict[str, Any]:
    added, deleted = _change_counts(before, after)
    diff_operation = (
        "delete" if operation == "delete" else "add" if operation == "add" else "update"
    )
    return finalize_file_change(
        {
            "path": path,
            "operation": operation,
            "change_type": change_type,
            "added_lines": added,
            "deleted_lines": deleted,
            "diff": build_text_diff(
                path=path,
                before=before,
                after=after,
                operation=diff_operation,
            ),
        }
    )


def _change_counts(before: str, after: str) -> tuple[int, int]:
    before_lines = before.splitlines()
    after_lines = after.splitlines()
    added = 0
    deleted = 0
    for tag, i1, i2, j1, j2 in SequenceMatcher(None, before_lines, after_lines).get_opcodes():
        if tag == "equal":
            continue
        if tag in {"replace", "delete"}:
            deleted += i2 - i1
        if tag in {"replace", "insert"}:
            added += j2 - j1
    if not before and after:
        return count_text_lines(after), 0
    if before and not after:
        return 0, count_text_lines(before)
    return added, deleted


def _resolve(raw_path: Any, context: ToolExecutionContext) -> Path:
    return resolve_file_access_path(raw_path, context, operation="write")


def _relative(path: Path, context: ToolExecutionContext) -> str:
    return relative_tool_path(path, context)
