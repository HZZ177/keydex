from __future__ import annotations

import json

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from backend.app.agent.compact_runtime_attachments import (
    COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY,
    RECENT_READ_CURRENT_FILE_MAX_BYTES,
    build_current_text_reader,
    build_latest_plan_attachment,
    build_recent_read_attachments,
    is_compact_runtime_attachment_message,
)
from backend.app.agent.context_compression_segments import truncate_completed_tool_result
from backend.app.command_approval import save_command_settings
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools.command_runtime.models import CommandSettings


def _tool_exchange(name: str, args: dict, call_id: str, result: str = "ok"):
    return [
        AIMessage(
            content="",
            tool_calls=[{"id": call_id, "name": name, "args": args}],
        ),
        ToolMessage(content=result, tool_call_id=call_id),
    ]


def _read_result(
    path: str,
    *,
    start_line: int = 1,
    returned_lines: int = 1,
    mode: str = "window",
) -> str:
    return json.dumps(
        {
            "path": path,
            "start_line": start_line,
            "max_lines": max(returned_lines, 1),
            "returned_lines": returned_lines,
            "total_lines": max(start_line + returned_lines + 10, 20),
            "truncated": True,
            "next_start_line": start_line + returned_lines,
            "mode": mode,
        },
        ensure_ascii=False,
    )


def test_latest_plan_is_full_replacement_snapshot_and_empty_plan_is_valid() -> None:
    messages = [
        *_tool_exchange(
            "update_plan",
            {"plan": [{"step": "old", "status": "completed"}]},
            "p1",
        ),
        *_tool_exchange("update_plan", {"plan": []}, "p2"),
    ]
    attachment = build_latest_plan_attachment(messages)
    assert attachment is not None
    assert '"plan": []' in str(attachment.message.content)
    assert "old" not in str(attachment.message.content)
    assert attachment.optional is False
    assert is_compact_runtime_attachment_message(attachment.message)


def test_plan_in_tail_is_not_duplicated() -> None:
    messages = _tool_exchange(
        "update_plan",
        {"plan": [{"step": "current", "status": "in_progress"}]},
        "p1",
    )
    assert build_latest_plan_attachment(messages, tail_tool_call_ids={"p1"}) is None


def test_recent_reads_manifest_is_newest_first_limited_and_excludes_instruction_files() -> None:
    messages = []
    for index, path in enumerate(
        ["a.py", "b.py", "SKILL.md", "c.py", "d.py", "e.py", "f.py"]
    ):
        messages.extend(_tool_exchange("read_file", {"path": path}, f"r{index}"))
    selection = build_recent_read_attachments(messages, available_tokens=10_000)
    manifest = selection.attachments[0]
    content = str(manifest.message.content)
    assert "f.py" in content and "b.py" in content
    assert "a.py" not in content
    assert "SKILL.md" not in content
    assert content.index("f.py") < content.index("e.py")


def test_recent_read_snippets_use_current_reader_and_shared_budget() -> None:
    messages = _tool_exchange(
        "read_file",
        {"path": "a.py", "start_line": 3, "max_lines": 2},
        "r1",
        _read_result("a.py", start_line=3, returned_lines=2),
    )
    selection = build_recent_read_attachments(
        messages,
        available_tokens=500,
        read_current=lambda _path: "one\ntwo\nTHREE\nFOUR\nfive\n",
    )
    assert selection.attachments[0].kind == "recent_read_manifest"
    snippets = [item for item in selection.attachments if item.kind == "recent_read_snippet"]
    assert len(snippets) == 1
    assert "第 3-4 行" in str(snippets[0].message.content)
    assert "THREE\nFOUR" in str(snippets[0].message.content)
    assert "one" not in str(snippets[0].message.content)
    assert sum(item.approximate_tokens for item in selection.attachments) <= 500


def test_recent_read_manifest_carries_read_identity_across_next_compression() -> None:
    first = build_recent_read_attachments(
        _tool_exchange(
            "read_file",
            {"path": "a.py", "start_line": 2, "max_lines": 1},
            "r1",
            _read_result("a.py", start_line=2, returned_lines=1),
        ),
        available_tokens=2_000,
        read_current=lambda _path: "skip\ncurrent-v1\nskip\n",
    )
    manifest = next(item for item in first.attachments if item.kind == "recent_read_manifest")

    second = build_recent_read_attachments(
        [manifest.message],
        available_tokens=2_000,
        read_current=lambda _path: "skip\ncurrent-v2\nskip\n",
    )

    assert [item.kind for item in second.attachments] == [
        "recent_read_manifest",
        "recent_read_snippet",
    ]
    assert "a.py" in str(second.attachments[0].message.content)
    assert "current-v2" in str(second.attachments[1].message.content)


def test_unreliable_carried_legacy_read_keeps_manifest_without_injecting_file_start() -> None:
    legacy_manifest = HumanMessage(
        content="legacy recent read manifest",
        additional_kwargs={
            COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY: {
                "kind": "recent_read_manifest",
                "recent_reads": [
                    {
                        "tool_call_id": "r1",
                        "path": "a.py",
                        "time": "",
                    }
                ],
            }
        },
    )
    selection = build_recent_read_attachments(
        [legacy_manifest],
        available_tokens=2_000,
        read_current=lambda _path: "SHOULD-NOT-BE-INJECTED",
    )

    assert [item.kind for item in selection.attachments] == ["recent_read_manifest"]
    assert "原读取范围不可可靠恢复" in str(selection.attachments[0].message.content)
    assert selection.dropped == (
        {"kind": "recent_read_snippet", "reason": "range_unavailable"},
    )


def test_truncated_tool_result_preserves_exact_read_range_for_later_compression() -> None:
    original = ToolMessage(
        content=json.dumps(
            {
                "path": "a.py",
                "content": "x" * 20_000,
                "start_line": 31,
                "returned_lines": 7,
                "mode": "window",
            }
        ),
        name="read_file",
        tool_call_id="r1",
    )
    truncated = truncate_completed_tool_result(original, max_tokens=256)
    messages = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "r1",
                    "name": "read_file",
                    "args": {"path": "a.py", "start_line": 1, "max_lines": 400},
                }
            ],
        ),
        truncated,
    ]
    current = "".join(f"line-{index}\n" for index in range(1, 50))

    selection = build_recent_read_attachments(
        messages,
        available_tokens=2_000,
        read_current=lambda _path: current,
    )

    snippet = next(item for item in selection.attachments if item.kind == "recent_read_snippet")
    assert "第 31-37 行" in str(snippet.message.content)
    assert "line-31\n" in str(snippet.message.content)
    assert "line-38\n" not in str(snippet.message.content)


def test_plain_truncated_window_result_falls_back_to_requested_range() -> None:
    selection = build_recent_read_attachments(
        _tool_exchange(
            "read_file",
            {"path": "a.py", "start_line": 8, "max_lines": 3},
            "r1",
            "truncated non-json tool result",
        ),
        available_tokens=2_000,
        read_current=lambda _path: "".join(
            f"line-{index}\n" for index in range(1, 15)
        ),
    )

    snippet = next(item for item in selection.attachments if item.kind == "recent_read_snippet")
    assert "第 8-10 行" in str(snippet.message.content)
    assert "line-8\nline-9\nline-10" in str(snippet.message.content)


def test_failed_read_result_is_not_restored_from_requested_range() -> None:
    failed = json.dumps(
        {
            "ok": False,
            "status": "failed",
            "error": {"code": "file_not_found", "message": "missing"},
        }
    )
    selection = build_recent_read_attachments(
        _tool_exchange(
            "read_file",
            {"path": "missing.py", "start_line": 8, "max_lines": 3},
            "r1",
            failed,
        ),
        available_tokens=2_000,
        read_current=lambda _path: "SHOULD-NOT-BE-INJECTED",
    )

    assert selection.attachments == ()


def test_error_status_read_result_is_not_restored_from_requested_range() -> None:
    messages = [
        AIMessage(
            content="",
            tool_calls=[
                {
                    "id": "r1",
                    "name": "read_file",
                    "args": {"path": "missing.py", "start_line": 8, "max_lines": 3},
                }
            ],
        ),
        ToolMessage(
            content="工具 read_file 执行失败",
            name="read_file",
            tool_call_id="r1",
            status="error",
        ),
    ]

    selection = build_recent_read_attachments(
        messages,
        available_tokens=2_000,
        read_current=lambda _path: "SHOULD-NOT-BE-INJECTED",
    )

    assert selection.attachments == ()


def test_empty_successful_read_does_not_expand_to_requested_window() -> None:
    selection = build_recent_read_attachments(
        _tool_exchange(
            "read_file",
            {"path": "a.py", "start_line": 500, "max_lines": 10},
            "r1",
            _read_result("a.py", start_line=500, returned_lines=0),
        ),
        available_tokens=2_000,
        read_current=lambda _path: "SHOULD-NOT-BE-INJECTED",
    )

    assert [item.kind for item in selection.attachments] == ["recent_read_manifest"]
    assert selection.dropped == (
        {"kind": "recent_read_snippet", "reason": "range_unavailable"},
    )


def test_indentation_read_uses_effective_result_range_instead_of_requested_anchor() -> None:
    messages = _tool_exchange(
        "read_file",
        {
            "path": "a.py",
            "start_line": 10,
            "max_lines": 20,
            "mode": "indentation",
            "anchor_line": 10,
        },
        "r1",
        _read_result("a.py", start_line=4, returned_lines=3, mode="indentation"),
    )
    current = "".join(f"line-{index}\n" for index in range(1, 15))

    selection = build_recent_read_attachments(
        messages,
        available_tokens=2_000,
        read_current=lambda _path: current,
    )

    snippet = next(item for item in selection.attachments if item.kind == "recent_read_snippet")
    assert "第 4-6 行" in str(snippet.message.content)
    assert "line-4\nline-5\nline-6" in str(snippet.message.content)
    assert "line-10" not in str(snippet.message.content)


def test_truncated_indentation_read_without_result_metadata_does_not_guess_range() -> None:
    selection = build_recent_read_attachments(
        _tool_exchange(
            "read_file",
            {
                "path": "a.py",
                "start_line": 10,
                "max_lines": 20,
                "mode": "indentation",
                "anchor_line": 10,
            },
            "r1",
            "truncated non-json tool result",
        ),
        available_tokens=2_000,
        read_current=lambda _path: "SHOULD-NOT-BE-INJECTED",
    )

    assert [item.kind for item in selection.attachments] == ["recent_read_manifest"]
    assert selection.dropped == (
        {"kind": "recent_read_snippet", "reason": "range_unavailable"},
    )


def test_disjoint_ranges_for_same_file_are_recovered_separately() -> None:
    messages = [
        *_tool_exchange(
            "read_file",
            {"path": "a.py", "start_line": 1, "max_lines": 2},
            "r1",
            _read_result("a.py", start_line=1, returned_lines=2),
        ),
        *_tool_exchange(
            "read_file",
            {"path": "a.py", "start_line": 10, "max_lines": 2},
            "r2",
            _read_result("a.py", start_line=10, returned_lines=2),
        ),
    ]
    current = "".join(f"line-{index}\n" for index in range(1, 15))

    selection = build_recent_read_attachments(
        messages,
        available_tokens=4_000,
        read_current=lambda _path: current,
    )

    snippets = [item for item in selection.attachments if item.kind == "recent_read_snippet"]
    assert len(snippets) == 2
    assert "第 10-11 行" in str(snippets[0].message.content)
    assert "第 1-2 行" in str(snippets[1].message.content)


def test_adjacent_ranges_for_same_file_merge_without_duplicate_snippets() -> None:
    messages = [
        *_tool_exchange(
            "read_file",
            {"path": "a.py", "start_line": 1, "max_lines": 2},
            "r1",
            _read_result("a.py", start_line=1, returned_lines=2),
        ),
        *_tool_exchange(
            "read_file",
            {"path": "a.py", "start_line": 3, "max_lines": 2},
            "r2",
            _read_result("a.py", start_line=3, returned_lines=2),
        ),
    ]

    selection = build_recent_read_attachments(
        messages,
        available_tokens=2_000,
        read_current=lambda _path: "one\ntwo\nthree\nfour\nfive\n",
    )

    snippets = [item for item in selection.attachments if item.kind == "recent_read_snippet"]
    assert len(snippets) == 1
    assert "第 1-4 行" in str(snippets[0].message.content)
    assert "one\ntwo\nthree\nfour" in str(snippets[0].message.content)


def test_recent_read_optional_content_drops_before_mandatory_components() -> None:
    messages = _tool_exchange("read_file", {"path": "a.py"}, "r1")
    selection = build_recent_read_attachments(messages, available_tokens=0)
    assert selection.attachments == ()
    assert selection.dropped == (
        {"kind": "recent_read_manifest", "reason": "shared_budget_exhausted"},
    )


def test_deleted_or_denied_recent_file_only_drops_that_attachment() -> None:
    messages = _tool_exchange(
        "read_file",
        {"path": "a.py"},
        "r1",
        _read_result("a.py"),
    )

    def denied(_path: str) -> str:
        raise PermissionError("denied")

    selection = build_recent_read_attachments(
        messages,
        available_tokens=2_000,
        read_current=denied,
    )
    assert [item.kind for item in selection.attachments] == ["recent_read_manifest"]
    assert selection.dropped == (
        {"kind": "recent_read_snippet", "reason": "read_denied_or_missing"},
    )


def test_current_text_reader_revalidates_workspace_permissions_and_safe_size(tmp_path) -> None:
    workspace_root = tmp_path / "workspace"
    workspace_root.mkdir()
    target = workspace_root / "current.txt"
    target.write_text("current workspace content", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("outside", encoding="utf-8")
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    workspace = repositories.workspaces.create(
        workspace_id="workspace-1", root_path=workspace_root
    )
    session = repositories.sessions.create(
        session_id="session-1",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(workspace_root),
        workspace_roots=[str(workspace_root)],
    )
    save_command_settings(
        repositories,
        CommandSettings(file_access_mode="workspace_read_only"),
    )
    reader = build_current_text_reader(
        repositories,
        session=session,
        user_id=session.user_id,
    )
    assert reader is not None
    assert reader("current.txt") == "current workspace content"
    with pytest.raises(Exception, match="工作区|workspace"):
        reader(str(outside))

    target.write_bytes(b"x" * (RECENT_READ_CURRENT_FILE_MAX_BYTES + 1))
    with pytest.raises(ValueError, match="safe read limit"):
        reader("current.txt")


def test_recent_read_defensive_caps_stay_within_shared_budget() -> None:
    messages = []
    for index in range(6):
        messages.extend(
            _tool_exchange(
                "read_file",
                {"path": f"file-{index}.txt"},
                f"r{index}",
                _read_result(f"file-{index}.txt"),
            )
        )
    selection = build_recent_read_attachments(
        messages,
        available_tokens=1_200,
        read_current=lambda _path: "x" * 100_000,
    )
    assert sum(item.approximate_tokens for item in selection.attachments) <= 1_200
    assert len(
        [item for item in selection.attachments if item.kind == "recent_read_snippet"]
    ) <= 5
    assert any(item["reason"] == "shared_budget_exhausted" for item in selection.dropped)
