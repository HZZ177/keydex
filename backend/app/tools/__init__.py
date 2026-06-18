"""Local desktop tool protocol and registry."""

from backend.app.tools.base import (
    FunctionTool,
    LocalTool,
    ToolDefinitionError,
    ToolExecutionContext,
    ToolExecutionError,
    ToolExecutionResult,
)
from backend.app.tools.factory import create_default_tool_registry
from backend.app.tools.orchestrator import ToolOrchestrator
from backend.app.tools.patch import create_patch_tools, register_patch_tools
from backend.app.tools.plan import create_plan_tools, register_plan_tools
from backend.app.tools.registry import ToolRegistry, ToolRegistryError
from backend.app.tools.search import create_search_tools, register_search_tools
from backend.app.tools.shell import create_shell_tools, register_shell_tools

__all__ = [
    "FunctionTool",
    "LocalTool",
    "ToolDefinitionError",
    "ToolExecutionContext",
    "ToolExecutionError",
    "ToolExecutionResult",
    "ToolOrchestrator",
    "ToolRegistry",
    "ToolRegistryError",
    "create_default_tool_registry",
    "create_patch_tools",
    "create_plan_tools",
    "create_search_tools",
    "create_shell_tools",
    "register_patch_tools",
    "register_plan_tools",
    "register_search_tools",
    "register_shell_tools",
]
