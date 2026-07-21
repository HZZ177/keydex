from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.agent.langchain_tools import local_tool_to_langchain_tool
from backend.app.agent.tool_results.budgets import get_tool_result_policy
from backend.app.agent.tool_results.specialized import (
    command_result_projector,
    grep_files_projector,
    mcp_result_projector,
    mutation_result_projector,
    search_files_projector,
    search_text_projector,
    subagent_result_projector,
    web_result_projector,
)
from backend.app.tools.base import ToolExecutionContext
from backend.app.tools.filesystem import create_filesystem_tools
from backend.app.tools.search import create_search_tools


def _context(tmp_path: Path, *, args: dict | None = None) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=1,
        metadata={"tool_args": args or {}},
    )


@pytest.mark.asyncio
async def test_read_file_model_projection_contains_numbered_body_once(tmp_path: Path) -> None:
    source = tmp_path / "large.py"
    source.write_text(
        "".join(f"value_{index} = '{'中' * 20}'\n" for index in range(1200)),
        encoding="utf-8",
    )
    read_tool = next(tool for tool in create_filesystem_tools() if tool.name == "read_file")
    langchain_tool = local_tool_to_langchain_tool(
        read_tool,
        context_factory=lambda: _context(tmp_path),
    )
    content = await langchain_tool.ainvoke(
        {"path": "large.py", "start_line": 1, "max_lines": 1200}
    )
    payload = json.loads(content)

    assert "content" not in payload
    assert "numbered_content" in payload
    assert len(content.encode("utf-8")) <= 24 * 1024
    assert payload["truncated"] is True
    assert payload["next_start_line"] == payload["returned_lines"] + 1


@pytest.mark.asyncio
async def test_list_dir_keeps_tree_protocol_inside_unified_10kb_projection(tmp_path: Path) -> None:
    for index in range(200):
        (tmp_path / f"very_long_directory_entry_{index:03d}_{'x' * 40}.txt").write_text(
            "x",
            encoding="utf-8",
        )
    list_tool = next(tool for tool in create_filesystem_tools() if tool.name == "list_dir")
    langchain_tool = local_tool_to_langchain_tool(
        list_tool,
        context_factory=lambda: _context(tmp_path),
    )
    content = await langchain_tool.ainvoke({"path": ".", "depth": 1, "limit": 200})
    payload = json.loads(content)

    assert len(content.encode("utf-8")) <= 10 * 1024
    assert payload["path"] == "."
    assert isinstance(payload["tree"], str)
    assert payload["truncated"] is True
    assert payload["next_offset"] == payload["returned_entries"]
    projection_notice = payload["_keydex_projection"]
    assert projection_notice["continuation"]["kind"] == "next_offset"
    assert set(projection_notice) == {"truncated", "continuation"}


def test_search_text_keeps_all_identities_before_optional_snippets(tmp_path: Path) -> None:
    result = {
        "query": "needle",
        "path": ".",
        "results": [
            {
                "path": f"backend/module_{index:03d}.py",
                "line": index + 1,
                "snippet": "中😀" * 1000,
                "context_before": ["ignored" * 100],
                "context_after": ["ignored" * 100],
            }
            for index in range(200)
        ],
        "scanned_files": 200,
        "limit": 200,
        "engine": "ripgrep",
        "truncated": False,
        "regex": False,
    }
    projection = search_text_projector(
        result,
        tool_name="search_text",
        policy=get_tool_result_policy("search_text"),
        context=_context(tmp_path, args={"query": "needle", "path": "."}),
    )
    payload = projection.display_payload
    assert len(projection.model_content.encode("utf-8")) <= 32 * 1024
    assert payload["returned_results"] == 200
    assert payload["omitted_results"] == 0
    assert {(item["path"], item["line"]) for item in payload["results"]} == {
        (item["path"], item["line"]) for item in result["results"]
    }
    assert all("context_before" not in item for item in payload["results"])


def test_grep_projection_removes_duplicate_paths_and_mtime(tmp_path: Path) -> None:
    result = {
        "query": "needle",
        "path": ".",
        "paths": ["a.py", "b.py"],
        "results": [
            {"path": "a.py", "matches": 2, "first_line": 3, "snippet": "a", "modified_time": 1},
            {"path": "b.py", "matches": 1, "first_line": 9, "snippet": "b", "modified_time": 2},
        ],
        "truncated": False,
    }
    projection = grep_files_projector(
        result,
        tool_name="grep_files",
        policy=get_tool_result_policy("grep_files"),
        context=_context(tmp_path, args={"query": "needle"}),
    )
    payload = projection.display_payload
    assert "paths" not in payload
    assert all("modified_time" not in item for item in payload["results"])
    assert [item["matches"] for item in payload["results"]] == [2, 1]


def test_grep_projection_keeps_file_identities_before_long_snippets(tmp_path: Path) -> None:
    result = {
        "query": "needle",
        "path": ".",
        "paths": [f"backend/file_{index:03d}.py" for index in range(200)],
        "results": [
            {
                "path": f"backend/file_{index:03d}.py",
                "matches": index + 1,
                "first_line": index + 10,
                "snippet": "long-context" * 1000,
                "modified_time": index,
            }
            for index in range(200)
        ],
        "truncated": False,
    }
    projection = grep_files_projector(
        result,
        tool_name="grep_files",
        policy=get_tool_result_policy("grep_files"),
        context=_context(tmp_path, args={"query": "needle"}),
    )
    assert len(projection.model_content.encode("utf-8")) <= 24 * 1024
    assert projection.display_payload["returned_results"] == 200
    assert all(
        {"path", "matches", "first_line"}.issubset(item)
        for item in projection.display_payload["results"]
    )


def test_search_files_projection_has_only_path_identity_fields(tmp_path: Path) -> None:
    result = {
        "query": "agent",
        "path": ".",
        "results": [
            {"path": "backend/app/agent", "type": "directory", "score": 0.99},
            {"path": "backend/app/agent/runner.py", "type": "file", "size": 10, "score": 0.8},
        ],
        "truncated": False,
    }
    projection = search_files_projector(
        result,
        tool_name="search_files",
        policy=get_tool_result_policy("search_files"),
        context=_context(tmp_path, args={"query": "agent"}),
    )
    assert all("score" not in item for item in projection.display_payload["results"])
    assert len(projection.model_content.encode("utf-8")) <= 10 * 1024


@pytest.mark.asyncio
async def test_search_text_cursor_is_stable_bound_and_non_overlapping(tmp_path: Path) -> None:
    for index in range(70):
        (tmp_path / f"file_{index:03d}.txt").write_text(
            f"needle line {index}\n",
            encoding="utf-8",
        )
    search_tool = next(tool for tool in create_search_tools() if tool.name == "search_text")
    langchain_tool = local_tool_to_langchain_tool(
        search_tool,
        context_factory=lambda: _context(tmp_path),
    )

    first = json.loads(
        await langchain_tool.ainvoke({"query": "needle", "path": ".", "limit": 25})
    )
    second = json.loads(
        await langchain_tool.ainvoke(
            {
                "query": "needle",
                "path": ".",
                "limit": 25,
                "cursor": first["next_cursor"],
            }
        )
    )

    first_ids = {(item["path"], item["line"]) for item in first["results"]}
    second_ids = {(item["path"], item["line"]) for item in second["results"]}
    assert len(first_ids) == 25
    assert len(second_ids) == 25
    assert first_ids.isdisjoint(second_ids), sorted(first_ids & second_ids)
    assert first["next_cursor"] != second["next_cursor"]

    failed = json.loads(
        await langchain_tool.ainvoke(
            {
                "query": "different",
                "path": ".",
                "cursor": first["next_cursor"],
            }
        )
    )
    assert failed["error"]["code"] == "invalid_search_cursor"


@pytest.mark.asyncio
async def test_search_files_cursor_pages_stable_path_identities(tmp_path: Path) -> None:
    for index in range(70):
        (tmp_path / f"agent_target_{index:03d}.py").write_text("pass\n", encoding="utf-8")
    search_tool = next(tool for tool in create_search_tools() if tool.name == "search_files")
    langchain_tool = local_tool_to_langchain_tool(
        search_tool,
        context_factory=lambda: _context(tmp_path),
    )

    first = json.loads(await langchain_tool.ainvoke({"query": "agent_target", "limit": 20}))
    second = json.loads(
        await langchain_tool.ainvoke(
            {"query": "agent_target", "limit": 20, "cursor": first["next_cursor"]}
        )
    )
    first_paths = {item["path"] for item in first["results"]}
    second_paths = {item["path"] for item in second["results"]}
    assert len(first_paths) == len(second_paths) == 20
    assert first_paths.isdisjoint(second_paths)
    assert len(json.dumps(first, ensure_ascii=False).encode("utf-8")) <= 10 * 1024


def test_command_projection_keeps_one_combined_output_and_command_log_ref(tmp_path: Path) -> None:
    repeated = "output-line\n" * 10_000
    result = {
        "kind": "command_result",
        "command_id": "cmd-1",
        "tool": "run_powershell",
        "command": "Get-Content secret",
        "cwd": ".",
        "status": "completed",
        "exit_code": 0,
        "duration_ms": 20,
        "output_path": str(tmp_path / "tool-results" / "commands" / "cmd-1.log"),
        "output_bytes": len(repeated.encode("utf-8")),
        "output_truncated": True,
        "stdout": repeated,
        "stderr": "",
        "stdout_tail": repeated[-20_000:],
        "stderr_tail": "",
        "combined_tail": repeated[-30_000:],
        "tool_summary": "命令执行完成",
    }
    projection = command_result_projector(
        result,
        tool_name="run_powershell",
        policy=get_tool_result_policy("run_powershell"),
        context=_context(tmp_path),
    )
    payload = projection.display_payload
    assert len(projection.model_content.encode("utf-8")) <= 24 * 1024
    assert "combined_output" in payload
    duplicate_keys = (
        "stdout",
        "stderr",
        "stdout_tail",
        "stderr_tail",
        "combined_tail",
    )
    assert all(key not in payload for key in duplicate_keys)
    assert payload["output_ref"] == "command_log:cmd-1"


def test_mutation_projection_keeps_all_file_identities_with_finite_diffs(tmp_path: Path) -> None:
    changes = [
        {
            "path": f"backend/file_{index}.py",
            "operation": "update",
            "added_lines": 1000,
            "deleted_lines": 1000,
            "diff": (f"--- a/file_{index}.py\n+++ b/file_{index}.py\n" + "+long line\n" * 10_000),
            "completed": True,
        }
        for index in range(3)
    ]
    result = {"changes": changes, "files": changes}
    projection = mutation_result_projector(
        result,
        tool_name="apply_patch",
        policy=get_tool_result_policy("apply_patch"),
        context=_context(tmp_path),
    )
    payload = projection.display_payload
    assert len(projection.model_content.encode("utf-8")) <= 32 * 1024
    assert [item["path"] for item in payload["files"]] == [
        "backend/file_0.py",
        "backend/file_1.py",
        "backend/file_2.py",
    ]
    assert payload["diff_truncated"] is True
    assert all(
        item["full_diff_bytes"] > len(item.get("diff", "").encode("utf-8"))
        for item in payload["files"]
    )


def test_mcp_projection_marks_upstream_lossy_payload_incomplete(tmp_path: Path) -> None:
    result = {
        "call_id": "mcp-call-1",
        "status": "success",
        "content": [{"type": "text", "text": "x" * 80_000}],
        "structured_content": {"rows": ["y" * 5000 for _ in range(20)]},
        "is_error": False,
        "metadata": {"result_truncated": True, "original_result_size_bytes": 500_000},
    }
    projection = mcp_result_projector(
        result,
        tool_name="github_search",
        policy=get_tool_result_policy(
            "github_search",
            metadata={"mcp": {"server": "github"}},
        ),
        context=_context(tmp_path),
    )
    assert len(projection.model_content.encode("utf-8")) <= 32 * 1024
    assert projection.meta.artifact_complete is False
    assert projection.display_payload["artifact_complete"] is False


def test_web_fetch_projection_matches_bounded_ui_visible_summary(tmp_path: Path) -> None:
    result = {
        "kind": "web_fetch",
        "schema_version": 1,
        "items": [
            {
                "requested_url": "https://example.com/page",
                "status": "success",
                "source": {
                    "source_id": "src-1",
                    "url": "https://example.com/page",
                    "domain": "example.com",
                    "title": "Example",
                    "truncated": False,
                },
                "content": "page-content " * 20_000,
            }
        ],
    }
    projection = web_result_projector(
        result,
        tool_name="web_fetch",
        policy=get_tool_result_policy("web_fetch"),
        context=_context(tmp_path),
    )
    item = projection.display_payload["items"][0]
    assert len(projection.model_content.encode("utf-8")) <= 32 * 1024
    assert len(item["content"].encode("utf-8")) <= 2000
    assert item["content_truncated_for_model"] is True
    assert projection.meta.truncated is True


@pytest.mark.parametrize("state", ["completed", "failed", "cancelled", "interrupted"])
def test_subagent_terminal_projection_preserves_complete_report_for_all_states(
    state: str,
    tmp_path: Path,
) -> None:
    result = {
        "schema_version": "keydex.subagent.v1",
        "state": state,
        "subagent_id": "sub-1",
        "run_id": "run-1",
        "child_session_id": "child-1",
        "role": "explorer",
        "ok": state == "completed",
        "final_report": "evidence-line\n" * 20_000 if state == "completed" else "",
    }
    projection = subagent_result_projector(
        result,
        tool_name="delegate_subagent",
        policy=get_tool_result_policy("delegate_subagent"),
        context=_context(tmp_path),
    )
    assert projection.display_payload["state"] == state
    if state == "completed":
        assert len(projection.model_content.encode("utf-8")) > 32 * 1024
        assert projection.display_payload["final_report"] == result["final_report"]
        assert "report_truncated" not in projection.display_payload
        assert "_keydex_projection" not in projection.display_payload
        assert projection.meta.truncated is False
