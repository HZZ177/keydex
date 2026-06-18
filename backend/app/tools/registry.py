from __future__ import annotations

from backend.app.model import ToolSpec
from backend.app.tools.base import LocalTool


class ToolRegistryError(ValueError):
    pass


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, LocalTool] = {}

    def register(self, tool: LocalTool) -> LocalTool:
        if tool.name in self._tools:
            raise ToolRegistryError(f"工具已注册: {tool.name}")
        self._tools[tool.name] = tool
        return tool

    def get(self, name: str, *, include_disabled: bool = True) -> LocalTool | None:
        tool = self._tools.get(name)
        if tool is None:
            return None
        if not include_disabled and not tool.enabled:
            return None
        return tool

    def require(self, name: str, *, include_disabled: bool = False) -> LocalTool:
        tool = self.get(name, include_disabled=include_disabled)
        if tool is None:
            raise ToolRegistryError(f"工具不存在或已禁用: {name}")
        return tool

    def list(self, *, include_disabled: bool = False) -> list[LocalTool]:
        tools = self._tools.values()
        if not include_disabled:
            tools = [tool for tool in tools if tool.enabled]
        return sorted(tools, key=lambda item: item.name)

    def to_tool_specs(self, *, include_disabled: bool = False) -> list[ToolSpec]:
        return [tool.to_tool_spec() for tool in self.list(include_disabled=include_disabled)]

    def names(self, *, include_disabled: bool = False) -> list[str]:
        return [tool.name for tool in self.list(include_disabled=include_disabled)]
