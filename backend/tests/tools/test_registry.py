from __future__ import annotations

import pytest

from backend.app.tools import (
    FunctionTool,
    ToolDefinitionError,
    ToolExecutionContext,
    ToolExecutionError,
    ToolRegistry,
    ToolRegistryError,
)


def _context(tmp_path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses_tools",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace_1",
    )


def _tool(name: str = "read_file", *, enabled: bool = True) -> FunctionTool:
    return FunctionTool(
        name=name,
        description="读取文件",
        parameters={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
        handler=lambda args, context: {"path": args["path"], "root": str(context.workspace_root)},
        enabled=enabled,
    )


def test_tool_registry_lists_enabled_tools_and_exports_model_schema() -> None:
    registry = ToolRegistry()
    registry.register(_tool("write_file"))
    registry.register(_tool("read_file"))

    assert registry.names() == ["read_file", "write_file"]
    specs = registry.to_tool_specs()

    assert [spec.name for spec in specs] == ["read_file", "write_file"]
    assert specs[0].to_openai_tool()["function"]["parameters"]["type"] == "object"


def test_tool_registry_rejects_duplicate_tool_name() -> None:
    registry = ToolRegistry()
    registry.register(_tool("read_file"))

    with pytest.raises(ToolRegistryError, match="工具已注册"):
        registry.register(_tool("read_file"))


def test_tool_registry_hides_disabled_tools_from_agent_capabilities() -> None:
    registry = ToolRegistry()
    registry.register(_tool("read_file"))
    registry.register(_tool("delete_file", enabled=False))

    assert registry.names() == ["read_file"]
    assert registry.names(include_disabled=True) == ["delete_file", "read_file"]
    assert registry.get("delete_file", include_disabled=False) is None
    assert registry.require("delete_file", include_disabled=True).name == "delete_file"


def test_function_tool_validates_schema_and_name() -> None:
    with pytest.raises(ToolDefinitionError, match="工具名称"):
        _tool("bad name")

    with pytest.raises(ToolDefinitionError, match="顶层 type"):
        FunctionTool(
            name="bad_schema",
            description="bad",
            parameters={"type": "array"},
            handler=lambda args, context: None,
        )


@pytest.mark.asyncio
async def test_function_tool_executes_and_wraps_errors(tmp_path) -> None:
    success = await _tool().run({"path": "README.md"}, _context(tmp_path))

    assert success.ok is True
    assert success.result["path"] == "README.md"

    async def failing_handler(args, context):
        raise ToolExecutionError(
            "无法读取",
            code="file_read_failed",
            details={"path": args["path"]},
        )

    failed = await FunctionTool(
        name="failing_tool",
        description="失败工具",
        parameters={"type": "object", "properties": {"path": {"type": "string"}}},
        handler=failing_handler,
    ).run({"path": "missing.txt"}, _context(tmp_path))

    assert failed.ok is False
    assert failed.error == {
        "code": "file_read_failed",
        "message": "无法读取",
        "details": {"path": "missing.txt"},
    }
