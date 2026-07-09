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
from backend.app.tools.file_snapshots import (
    ensure_file_snapshot_store,
    record_file_snapshot,
    require_current_file_content,
)
from backend.app.tools.registry import ToolRegistry

EDIT_FILE_DESCRIPTION = (
    "精确替换文件访问权限允许范围内已有 UTF-8 文本文件的一段内容。"
    "调用前必须先用 read_file 完整读取目标文件；old_string 必须与当前文件内容完全一致且默认只允许匹配一次。"
    "replace_all=true 时会替换所有匹配；new_string 为空表示删除该片段。"
)

DELETE_FILE_DESCRIPTION = (
    "删除文件访问权限允许范围内已有 UTF-8 文本文件，并返回删除 diff。"
    "调用前必须先用 read_file 完整读取目标文件；目录不会被递归删除。"
)

MOVE_FILE_DESCRIPTION = (
    "移动或重命名文件访问权限允许范围内已有 UTF-8 文本文件，并返回文件变更摘要。"
    "调用前必须先用 read_file 完整读取源文件；目标已存在时会失败。"
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
                        "description": "要替换的原文，必须逐字匹配当前文件内容且不能是空字符串。",
                    },
                    "new_string": {
                        "type": "string",
                        "description": "替换后的文本；传空字符串表示删除 old_string 片段。",
                    },
                    "replace_all": {
                        "type": "boolean",
                        "default": False,
                        "description": "是否替换所有匹配。默认 false，多处匹配时会拒绝并提示补充上下文。",
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
                        "description": "源文件路径，工作区相对路径；完全访问时也可使用绝对文件路径。",
                    },
                    "new_path": {
                        "type": "string",
                        "description": "目标文件路径，工作区相对路径；完全访问时也可使用绝对文件路径。",
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
    if old_string == "":
        raise ToolExecutionError(
            "old_string 不能为空",
            code="empty_old_string",
            details={"path": _relative(path, context), "hint": "创建新文件请使用 create_file。"},
        )
    if old_string == new_string:
        raise ToolExecutionError(
            "old_string 和 new_string 完全相同，拒绝无效编辑",
            code="no_op_edit",
            details={"path": _relative(path, context)},
        )

    before = require_current_file_content(path, context=context)
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
                "hint": "请提供更长的 old_string 上下文，或确认需要全部替换时设置 replace_all=true。",
            },
        )

    after = before.replace(old_string, new_string) if replace_all else before.replace(old_string, new_string, 1)
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
    return {"path": relative, "changed": True, "match_count": match_count, **change, "files": [change]}


async def delete_file_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    path = _resolve(args.get("path"), context)
    before = require_current_file_content(path, context=context)
    relative = _relative(path, context)
    path.unlink()
    ensure_file_snapshot_store(context).discard(path)
    change = _file_change(
        path=relative,
        before=before,
        after="",
        operation="delete",
        change_type="delete",
    )
    change["removed_bytes"] = len(before.encode("utf-8"))
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
    before = require_current_file_content(source, context=context)
    if destination.exists():
        raise ToolExecutionError(
            "移动目标已存在",
            code="target_exists",
            details={"path": _relative(destination, context)},
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    source.replace(destination)
    store = ensure_file_snapshot_store(context)
    store.discard(source)
    record_file_snapshot(destination, context=context, content=before, full_read=True)
    old_path = _relative(source, context)
    new_path = _relative(destination, context)
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


def _file_change(
    *,
    path: str,
    before: str,
    after: str,
    operation: str,
    change_type: str,
) -> dict[str, Any]:
    added, deleted = _change_counts(before, after)
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
                operation="delete" if operation == "delete" else "update",
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
