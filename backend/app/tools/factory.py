from __future__ import annotations

from backend.app.tools.filesystem import register_filesystem_tools
from backend.app.tools.patch import register_patch_tools
from backend.app.tools.plan import register_plan_tools
from backend.app.tools.registry import ToolRegistry
from backend.app.tools.search import register_search_tools
from backend.app.tools.shell import register_shell_tools


def create_default_tool_registry() -> ToolRegistry:
    registry = ToolRegistry()
    register_filesystem_tools(registry)
    register_search_tools(registry)
    register_shell_tools(registry)
    register_patch_tools(registry)
    register_plan_tools(registry)
    return registry
