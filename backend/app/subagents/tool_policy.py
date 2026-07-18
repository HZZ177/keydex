from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from backend.app.subagents.errors import SubagentErrorCode
from backend.app.subagents.roles import (
    SubagentRolePreset,
    SubagentToolSource,
    select_subagent_tools,
)
from backend.app.tools.base import (
    LocalTool,
    ToolExecutionContext,
    ToolExecutionError,
    ToolExecutionResult,
)


@dataclass(frozen=True, slots=True)
class RoleGuardedTool:
    """LocalTool proxy that re-checks the role policy at invocation time."""

    wrapped: LocalTool
    preset: SubagentRolePreset
    source: SubagentToolSource

    @property
    def name(self) -> str:
        return self.wrapped.name

    @property
    def description(self) -> str:
        return self.wrapped.description

    @property
    def parameters(self) -> dict[str, Any]:
        return self.wrapped.parameters

    @property
    def enabled(self) -> bool:
        return self.wrapped.enabled

    def to_tool_spec(self):
        return self.wrapped.to_tool_spec()

    async def run(
        self,
        args: dict[str, Any],
        context: ToolExecutionContext,
    ) -> ToolExecutionResult:
        allowed = select_subagent_tools(
            self.preset,
            (self.wrapped,),
            source=self.source,
        )
        if not allowed:
            return ToolExecutionResult.failed(
                ToolExecutionError(
                    f"tool is not allowed for {self.preset.role.value}: {self.name}",
                    code=SubagentErrorCode.ROLE_TOOL_POLICY_VIOLATION.value,
                    details={"role": self.preset.role.value, "tool": self.name},
                )
            )
        return await self.wrapped.run(args, context)


def guard_subagent_tools(
    preset: SubagentRolePreset,
    tools: Sequence[LocalTool],
    *,
    source: SubagentToolSource,
) -> list[LocalTool]:
    selected = select_subagent_tools(preset, tools, source=source)
    return [RoleGuardedTool(tool, preset, source) for tool in selected]
