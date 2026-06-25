from __future__ import annotations

import json

import pytest

from backend.app.agent.langchain_tools import registry_to_langchain_tools
from backend.app.tools import (
    FunctionTool,
    ToolDefinitionError,
    ToolExecutionContext,
    ToolExecutionError,
    ToolRegistry,
    ToolRegistryError,
    create_default_tool_registry,
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
            description="错误 schema",
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


@pytest.mark.asyncio
async def test_function_tool_uses_exception_type_when_exception_message_is_empty(tmp_path) -> None:
    def failing_handler(args, context):
        raise NotImplementedError()

    failed = await FunctionTool(
        name="failing_tool",
        description="失败工具",
        parameters={"type": "object", "properties": {}},
        handler=failing_handler,
    ).run({}, _context(tmp_path))

    assert failed.ok is False
    assert failed.error == {
        "code": "tool_execution_failed",
        "message": "NotImplementedError",
        "details": {"tool": "failing_tool", "type": "NotImplementedError"},
    }


@pytest.mark.asyncio
async def test_langchain_tool_failure_payload_includes_tool_context(tmp_path) -> None:
    async def failing_handler(args, context):
        raise ToolExecutionError(
            "无法读取",
            code="file_read_failed",
            details={"path": args["path"]},
        )

    registry = ToolRegistry()
    registry.register(
        FunctionTool(
            name="read_file",
            description="读取文件",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            handler=failing_handler,
        )
    )
    langchain_tool = registry_to_langchain_tools(
        registry,
        context_factory=lambda: _context(tmp_path),
    )[0]

    payload = json.loads(await langchain_tool.ainvoke({"path": "missing.txt"}))

    assert payload["tool"] == "read_file"
    assert payload["status"] == "failed"
    assert payload["code"] == "file_read_failed"
    assert payload["details"] == {"path": "missing.txt"}
    assert "工具 read_file 执行失败" in payload["tool_summary"]


def test_default_tool_registry_exposes_phase_one_tool_contracts(tmp_path) -> None:
    registry = create_default_tool_registry()

    assert registry.names() == [
        "apply_patch",
        "grep_files",
        "list_dir",
        "read_file",
        "run_command",
        "search_files",
        "search_text",
        "update_plan",
        "write_file",
    ]
    specs = {spec.name: spec for spec in registry.to_tool_specs()}
    assert "带行号的 numbered_content" in specs["read_file"].description
    assert "创建新的 UTF-8 文本文件" in specs["write_file"].description
    assert "目标文件已存在会失败" in specs["write_file"].description
    assert "有界目录树" in specs["list_dir"].description
    assert "不搜索文件内容" in specs["search_files"].description
    assert "发现候选文件" in specs["grep_files"].description
    assert "*** Move to: <path>" in specs["apply_patch"].description
    assert "一次性 shell 命令" in specs["run_command"].description
    assert "最多只能有一个步骤处于 in_progress" in specs["update_plan"].description
    status_enum = specs["update_plan"].parameters["properties"]["plan"]["items"]["properties"][
        "status"
    ]["enum"]
    assert "failed" in status_enum
    assert specs["list_dir"].parameters["properties"]["depth"]["maximum"] == 5
    assert "mode" not in specs["write_file"].parameters["properties"]
    assert "append" not in specs["write_file"].parameters["properties"]
    assert "offset" not in specs["read_file"].parameters["properties"]
    assert "grep_files" in specs

    langchain_tools = registry_to_langchain_tools(
        registry,
        context_factory=lambda: _context(tmp_path),
    )
    assert {tool.name for tool in langchain_tools} == set(specs)
    grep_tool = next(tool for tool in langchain_tools if tool.name == "grep_files")
    assert grep_tool.description == specs["grep_files"].description
