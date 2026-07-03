from __future__ import annotations

from backend.app.core.logger import logger
from backend.app.tools.filesystem import register_filesystem_tools
from backend.app.tools.patch import register_patch_tools
from backend.app.tools.plan import register_plan_tools
from backend.app.tools.registry import ToolRegistry
from backend.app.tools.search import register_search_tools
from backend.app.tools.thread_task import register_thread_task_tools


def create_default_tool_registry() -> ToolRegistry:
    registry = ToolRegistry()
    register_filesystem_tools(registry)
    register_search_tools(registry)
    register_patch_tools(registry)
    register_plan_tools(registry)
    register_thread_task_tools(registry)
    logger.info(
        f"[ToolRegistry] 默认工具注册完成 | tools={','.join(registry.names(include_disabled=True))}"
    )
    return registry
