from __future__ import annotations

from backend.app.core.logger import logger
from backend.app.tools.edit_ops import register_edit_operation_tools
from backend.app.tools.filesystem import register_filesystem_tools
from backend.app.tools.patch import register_patch_tools
from backend.app.tools.plan import register_plan_tools
from backend.app.tools.registry import ToolRegistry
from backend.app.tools.search import register_search_tools
from backend.app.tools.thread_task import register_thread_task_tools

CLAUDE_CODE_FILE_TOOL_NAMES = frozenset({"create_file", "edit_file", "delete_file", "move_file"})
CODEX_FILE_TOOL_NAMES = frozenset({"apply_patch"})
FILE_EDIT_STYLE_TOOL_NAMES = CLAUDE_CODE_FILE_TOOL_NAMES | CODEX_FILE_TOOL_NAMES


def visible_tools_for_file_edit_style(registry: ToolRegistry, style: str) -> list:
    enabled_file_tools = (
        CODEX_FILE_TOOL_NAMES if style == "codex" else CLAUDE_CODE_FILE_TOOL_NAMES
    )
    return [
        tool
        for tool in registry.list()
        if tool.name not in FILE_EDIT_STYLE_TOOL_NAMES or tool.name in enabled_file_tools
    ]


def create_default_tool_registry() -> ToolRegistry:
    registry = ToolRegistry()
    register_filesystem_tools(registry)
    register_edit_operation_tools(registry)
    register_search_tools(registry)
    register_patch_tools(registry)
    register_plan_tools(registry)
    register_thread_task_tools(registry)
    logger.info(
        f"[ToolRegistry] 默认工具注册完成 | tools={','.join(registry.names(include_disabled=True))}"
    )
    return registry
