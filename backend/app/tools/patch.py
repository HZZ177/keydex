from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.security.workspace import WorkspacePathError, resolve_workspace_path
from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.registry import ToolRegistry


@dataclass(frozen=True)
class PatchOperation:
    kind: str
    path: str
    lines: list[str]


def create_patch_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="apply_patch",
            description="在当前工作区内应用 Codex apply_patch 风格的文本补丁。",
            parameters={
                "type": "object",
                "properties": {
                    "patch": {
                        "type": "string",
                        "description": "以 *** Begin Patch 开始、*** End Patch 结束的补丁文本",
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
    changes: list[dict[str, Any]] = []
    for operation in operations:
        target = _resolve(operation.path, context)
        if operation.kind == "add":
            changes.append(_apply_add(target, operation, context))
        elif operation.kind == "update":
            changes.append(_apply_update(target, operation, context))
        elif operation.kind == "delete":
            changes.append(_apply_delete(target, operation, context))
        else:
            raise ToolExecutionError(
                "不支持的 patch 操作",
                code="invalid_patch",
                details={"operation": operation.kind},
            )

    return {"changes": changes}


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
        if header.startswith("*** Add File: "):
            index = _collect_operation(lines, index, "add", "*** Add File: ", operations)
        elif header.startswith("*** Update File: "):
            index = _collect_operation(lines, index, "update", "*** Update File: ", operations)
        elif header.startswith("*** Delete File: "):
            path = header.removeprefix("*** Delete File: ").strip()
            if not path:
                raise ToolExecutionError("Delete File 缺少路径", code="invalid_patch")
            operations.append(PatchOperation(kind="delete", path=path, lines=[]))
            index += 1
        else:
            raise ToolExecutionError(
                "无法识别的 patch 行",
                code="invalid_patch",
                details={"line": header, "line_number": index + 1},
            )

    if not operations:
        raise ToolExecutionError("patch 没有任何文件操作", code="invalid_patch")
    return operations


def _collect_operation(
    lines: list[str],
    index: int,
    kind: str,
    prefix: str,
    operations: list[PatchOperation],
) -> int:
    path = lines[index].removeprefix(prefix).strip()
    if not path:
        raise ToolExecutionError(f"{prefix.strip()} 缺少路径", code="invalid_patch")

    index += 1
    body: list[str] = []
    while index < len(lines) - 1 and not lines[index].startswith("*** "):
        body.append(lines[index])
        index += 1
    if not body:
        raise ToolExecutionError("文件操作缺少 patch 内容", code="invalid_patch")
    operations.append(PatchOperation(kind=kind, path=path, lines=body))
    return index


def _apply_add(
    target: Path,
    operation: PatchOperation,
    context: ToolExecutionContext,
) -> dict[str, Any]:
    if target.exists():
        raise ToolExecutionError(
            "新增文件已存在",
            code="patch_target_exists",
            details={"path": _relative(target, context)},
        )
    content_lines = []
    for line in operation.lines:
        if not line.startswith("+"):
            raise ToolExecutionError("Add File 行必须以 + 开头", code="invalid_patch")
        content_lines.append(line[1:])
    content = "\n".join(content_lines)
    if content_lines:
        content += "\n"

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8", newline="")
    return {
        "operation": "add",
        "path": _relative(target, context),
        "added_lines": len(content_lines),
        "removed_lines": 0,
    }


def _apply_update(
    target: Path,
    operation: PatchOperation,
    context: ToolExecutionContext,
) -> dict[str, Any]:
    if not target.exists():
        raise ToolExecutionError(
            "更新文件不存在",
            code="file_not_found",
            details={"path": _relative_missing(target, context)},
        )
    if not target.is_file():
        raise ToolExecutionError(
            "更新目标不是文件",
            code="path_not_file",
            details={"path": _relative(target, context)},
        )
    try:
        original = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ToolExecutionError(
            "文件不是 UTF-8 文本",
            code="file_not_text",
            details={"path": _relative(target, context)},
        ) from exc

    old_block, new_block, added, removed = _build_update_blocks(operation.lines)
    if old_block not in original:
        raise ToolExecutionError(
            "patch 上下文不匹配，拒绝覆盖当前文件",
            code="patch_context_mismatch",
            details={"path": _relative(target, context)},
        )

    updated = original.replace(old_block, new_block, 1)
    target.write_text(updated, encoding="utf-8", newline="")
    return {
        "operation": "update",
        "path": _relative(target, context),
        "added_lines": added,
        "removed_lines": removed,
    }


def _apply_delete(
    target: Path,
    operation: PatchOperation,
    context: ToolExecutionContext,
) -> dict[str, Any]:
    if not target.exists():
        raise ToolExecutionError(
            "删除文件不存在",
            code="file_not_found",
            details={"path": _relative_missing(target, context)},
        )
    if not target.is_file():
        raise ToolExecutionError(
            "删除目标不是文件",
            code="path_not_file",
            details={"path": _relative(target, context)},
        )
    size = target.stat().st_size
    target.unlink()
    return {
        "operation": "delete",
        "path": _relative_missing(target, context),
        "removed_bytes": size,
        "added_lines": 0,
        "removed_lines": 0,
    }


def _build_update_blocks(lines: list[str]) -> tuple[str, str, int, int]:
    old_lines: list[str] = []
    new_lines: list[str] = []
    added = 0
    removed = 0
    for line in lines:
        if line == "@@" or line.startswith("@@ "):
            continue
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
        else:
            raise ToolExecutionError(
                "Update File 内容行必须以空格、+、- 或 @@ 开头",
                code="invalid_patch",
            )

    if not old_lines and not new_lines:
        raise ToolExecutionError("Update File 缺少有效变更", code="invalid_patch")
    return "\n".join(old_lines) + "\n", "\n".join(new_lines) + "\n", added, removed


def _resolve(raw_path: str, context: ToolExecutionContext) -> Path:
    try:
        return resolve_workspace_path(
            raw_path,
            cwd=context.workspace_root,
            workspace_roots=[context.workspace_root],
        )
    except WorkspacePathError as exc:
        raise ToolExecutionError(
            str(exc),
            code="workspace_path_forbidden",
            details={"path": raw_path},
        ) from exc


def _relative(path: Path, context: ToolExecutionContext) -> str:
    return path.resolve().relative_to(context.workspace_root).as_posix()


def _relative_missing(path: Path, context: ToolExecutionContext) -> str:
    return path.resolve().relative_to(context.workspace_root).as_posix()
