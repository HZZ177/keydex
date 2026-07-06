from __future__ import annotations

from backend.app.mcp.naming import (
    MAX_MODEL_NAME_LENGTH,
    MAX_SERVER_SLUG_LENGTH,
    MAX_TOOL_SLUG_LENGTH,
    ExistingMcpToolName,
    McpToolNameAllocator,
    slug_identifier,
)


def test_slug_identifier_replaces_invalid_chars_and_compresses_underscores() -> None:
    assert slug_identifier(
        "Server  One!!",
        fallback_prefix="server",
        max_length=MAX_SERVER_SLUG_LENGTH,
    ) == "server_one"
    assert slug_identifier(
        "读取文件",
        fallback_prefix="tool",
        max_length=MAX_TOOL_SLUG_LENGTH,
    ).startswith("tool_")


def test_allocator_generates_model_name_shape() -> None:
    allocated = McpToolNameAllocator().allocate(
        server_id="srv-main",
        raw_tool_name="Create Issue",
    )

    assert allocated.server_slug == "srv-main"
    assert allocated.tool_slug == "create_issue"
    assert allocated.callable_namespace == "mcp__srv-main"
    assert allocated.callable_name == "create_issue"
    assert allocated.model_name == "mcp__srv-main__create_issue"


def test_allocator_truncates_long_names_with_hash_suffix() -> None:
    allocated = McpToolNameAllocator().allocate(
        server_id="server-" + "a" * 100,
        raw_tool_name="tool-" + "b" * 100,
    )

    assert len(allocated.server_slug) <= MAX_SERVER_SLUG_LENGTH
    assert len(allocated.tool_slug) <= MAX_TOOL_SLUG_LENGTH
    assert len(allocated.model_name) <= MAX_MODEL_NAME_LENGTH
    assert "_" in allocated.server_slug
    assert "_" in allocated.tool_slug


def test_allocator_distinguishes_two_servers_with_same_tool_name() -> None:
    allocator = McpToolNameAllocator()
    first = allocator.allocate(server_id="srv-alpha", raw_tool_name="search")
    second = allocator.allocate(server_id="srv-beta", raw_tool_name="search")

    assert first.model_name == "mcp__srv-alpha__search"
    assert second.model_name == "mcp__srv-beta__search"
    assert first.model_name != second.model_name


def test_allocator_appends_hash_on_global_model_name_conflict() -> None:
    allocator = McpToolNameAllocator(used_model_names={"mcp__srv_a__search"})
    allocated = allocator.allocate(server_id="srv a", raw_tool_name="search")

    assert allocated.model_name.startswith("mcp__srv_a__search_")
    assert allocated.model_name != "mcp__srv_a__search"
    assert len(allocated.model_name) <= MAX_MODEL_NAME_LENGTH


def test_allocator_reuses_existing_tool_name_as_abi() -> None:
    existing = ExistingMcpToolName(
        raw_name="search",
        callable_namespace="mcp__old_server_slug",
        callable_name="search",
        model_name="mcp__old_server_slug__search",
    )
    allocated = McpToolNameAllocator().allocate(
        server_id="new display name should not matter",
        raw_tool_name="search",
        existing=existing,
    )

    assert allocated.callable_namespace == "mcp__old_server_slug"
    assert allocated.callable_name == "search"
    assert allocated.model_name == "mcp__old_server_slug__search"


def test_allocator_keeps_existing_model_name_when_server_display_name_changes() -> None:
    existing = ExistingMcpToolName(
        raw_name="search",
        callable_namespace="mcp__stable_server_id",
        callable_name="search",
        model_name="mcp__stable_server_id__search",
    )

    allocated = McpToolNameAllocator().allocate(
        server_id="renamed server display value",
        raw_tool_name="search",
        existing=existing,
    )

    assert allocated.model_name == "mcp__stable_server_id__search"
