"""Local desktop tool protocol and registry.

Exports are resolved lazily so the backend health path can register lightweight
local tools without importing LangChain-only tool adapters.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

_EXPORTS = {
    "FileHistoryExecutionScope": ("backend.app.tools.base", "FileHistoryExecutionScope"),
    "FunctionTool": ("backend.app.tools.base", "FunctionTool"),
    "LocalTool": ("backend.app.tools.base", "LocalTool"),
    "ToolDefinitionError": ("backend.app.tools.base", "ToolDefinitionError"),
    "ToolExecutionContext": ("backend.app.tools.base", "ToolExecutionContext"),
    "ToolExecutionError": ("backend.app.tools.base", "ToolExecutionError"),
    "ToolExecutionResult": ("backend.app.tools.base", "ToolExecutionResult"),
    "ToolRegistry": ("backend.app.tools.registry", "ToolRegistry"),
    "ToolRegistryError": ("backend.app.tools.registry", "ToolRegistryError"),
    "ToolOrchestrator": ("backend.app.tools.orchestrator", "ToolOrchestrator"),
    "create_default_tool_registry": ("backend.app.tools.factory", "create_default_tool_registry"),
    "create_edit_operation_tools": ("backend.app.tools.edit_ops", "create_edit_operation_tools"),
    "create_filesystem_tools": ("backend.app.tools.filesystem", "create_filesystem_tools"),
    "create_patch_tools": ("backend.app.tools.patch", "create_patch_tools"),
    "create_plan_tools": ("backend.app.tools.plan", "create_plan_tools"),
    "create_search_tools": ("backend.app.tools.search", "create_search_tools"),
    "create_thread_task_tools": ("backend.app.tools.thread_task", "create_thread_task_tools"),
    "create_tool_result_tools": ("backend.app.tools.tool_results", "create_tool_result_tools"),
    "create_web_search_tool": ("backend.app.tools.web", "create_web_search_tool"),
    "create_web_fetch_tool": ("backend.app.tools.web", "create_web_fetch_tool"),
    "create_command_tools": ("backend.app.tools.command_runtime.tools", "create_command_tools"),
    "register_edit_operation_tools": (
        "backend.app.tools.edit_ops",
        "register_edit_operation_tools",
    ),
    "register_filesystem_tools": ("backend.app.tools.filesystem", "register_filesystem_tools"),
    "register_patch_tools": ("backend.app.tools.patch", "register_patch_tools"),
    "register_plan_tools": ("backend.app.tools.plan", "register_plan_tools"),
    "register_search_tools": ("backend.app.tools.search", "register_search_tools"),
    "register_thread_task_tools": (
        "backend.app.tools.thread_task",
        "register_thread_task_tools",
    ),
    "register_tool_result_tools": (
        "backend.app.tools.tool_results",
        "register_tool_result_tools",
    ),
    "register_web_search_tool": ("backend.app.tools.web", "register_web_search_tool"),
    "register_web_fetch_tool": ("backend.app.tools.web", "register_web_fetch_tool"),
    "register_command_tools": (
        "backend.app.tools.command_runtime.tools",
        "register_command_tools",
    ),
    "LOAD_SKILL_TOOL_NAME": ("backend.app.tools.skill", "LOAD_SKILL_TOOL_NAME"),
    "load_skill": ("backend.app.tools.skill", "load_skill"),
    "run_load_skill": ("backend.app.tools.skill", "run_load_skill"),
}

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module_name, export_name = _EXPORTS[name]
    value = getattr(import_module(module_name), export_name)
    globals()[name] = value
    return value
