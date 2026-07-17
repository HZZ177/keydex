from __future__ import annotations

import subprocess

from langchain_core.messages import AIMessageChunk

from backend.app.agent.tool_call_progress import (
    ToolCallChunkPipeline,
    extract_partial_json_string_field,
    parse_apply_patch_file_changes,
    parse_partial_json_object,
)


def _assert_git_accepts_patch(root, patch: str) -> None:
    result = subprocess.run(
        ["git", "apply", "--check", "--recount", "--unsafe-paths", "-"],
        cwd=root,
        input=(patch.rstrip("\r\n") + "\n").encode("utf-8"),
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")


def test_partial_json_string_field_returns_incomplete_streamed_value() -> None:
    raw = '{"patch":"*** Begin Patch\\n*** Update File: src/app.py\\n@@\\n-print('

    assert extract_partial_json_string_field(raw, "patch") == (
        "*** Begin Patch\n*** Update File: src/app.py\n@@\n-print("
    )
    assert parse_partial_json_object(raw)["patch"].startswith("*** Begin Patch")


def test_apply_patch_file_change_parser_counts_added_and_deleted_lines() -> None:
    files = parse_apply_patch_file_changes(
        """*** Begin Patch
*** Update File: src/app.py
@@
 keep
-old
+new
*** End Patch"""
    )

    assert files == [
        {
            "path": "src/app.py",
            "operation": "update",
            "added_lines": 1,
            "deleted_lines": 1,
            "removed_lines": 1,
            "additions": 1,
            "deletions": 1,
            "diff": "--- a/src/app.py\n+++ b/src/app.py\n@@\n keep\n-old\n+new",
        }
    ]


def test_apply_patch_file_change_parser_tracks_move_to() -> None:
    files = parse_apply_patch_file_changes(
        """*** Begin Patch
*** Update File: docs/old.md
*** Move to: docs/new.md
@@
-old
+new
*** End Patch"""
    )

    assert files == [
        {
            "path": "docs/new.md",
            "operation": "move",
            "change_type": "move",
            "old_path": "docs/old.md",
            "new_path": "docs/new.md",
            "added_lines": 1,
            "deleted_lines": 1,
            "removed_lines": 1,
            "additions": 1,
            "deletions": 1,
            "diff": (
                "--- a/docs/old.md\n+++ b/docs/new.md\n*** Move to: docs/new.md\n@@\n-old\n+new"
            ),
        }
    ]


def test_apply_patch_file_change_parser_tracks_add_file() -> None:
    files = parse_apply_patch_file_changes(
        """*** Begin Patch
*** Add File: docs/new.md
+one
+two
*** End Patch"""
    )

    assert files == [
        {
            "path": "docs/new.md",
            "operation": "add",
            "change_type": "create",
            "added_lines": 2,
            "deleted_lines": 0,
            "removed_lines": 0,
            "additions": 2,
            "deletions": 0,
            "diff": "--- /dev/null\n+++ b/docs/new.md\n+one\n+two",
        }
    ]


def test_pipeline_emits_progress_for_streamed_apply_patch_chunks() -> None:
    pipeline = ToolCallChunkPipeline()
    first = AIMessageChunk(
        content="",
        tool_call_chunks=[
            {
                "id": "call_patch",
                "index": 0,
                "name": "apply_patch",
                "args": (
                    '{"patch":"*** Begin Patch\\n*** Update File: src/app.py\\n@@\\n-old\\n+one'
                ),
            }
        ],
    )
    second = AIMessageChunk(
        content="",
        tool_call_chunks=[
            {
                "id": "call_patch",
                "index": 0,
                "name": None,
                "args": '\\n+two\\n*** End Patch"}',
            }
        ],
    )

    first_progress = pipeline.process_chunk(first, model_run_id="model_run")
    second_progress = pipeline.process_chunk(second, model_run_id="model_run")

    assert first_progress[0]["tool"] == "apply_patch"
    assert first_progress[0]["tool_call_id"] == "call_patch"
    assert first_progress[0]["files"][0]["path"] == "src/app.py"
    assert first_progress[0]["files"][0]["operation"] == "update"
    assert first_progress[0]["files"][0]["added_lines"] == 1
    assert first_progress[0]["files"][0]["patch_format"] == "relaxed_apply_patch"
    assert first_progress[0]["files"][0]["patch_precision"] == "approximate"
    assert first_progress[0]["files"][0]["patch_complete"] is False
    assert first_progress[0]["files"][0]["selectable_for_patch"] is False
    assert second_progress[0]["files"][0]["operation"] == "update"
    assert second_progress[0]["files"][0]["added_lines"] == 2
    assert second_progress[0]["files"][0]["patch_complete"] is True


def test_pipeline_waits_for_a_complete_streamed_apply_patch_filename() -> None:
    pipeline = ToolCallChunkPipeline()
    first = AIMessageChunk(
        content="",
        tool_call_chunks=[
            {
                "id": "call_split_path",
                "index": 0,
                "name": "apply_patch",
                "args": '{"patch":"*** Begin Patch\\n*** Update File: docs/guide',
            }
        ],
    )
    second = AIMessageChunk(
        content="",
        tool_call_chunks=[
            {
                "id": None,
                "index": 0,
                "name": None,
                "args": '.md\\n@@\\n-old\\n+new\\n*** End Patch"}',
            }
        ],
    )

    assert pipeline.process_chunk(first, model_run_id="model_run") == []

    progress = pipeline.process_chunk(second, model_run_id="model_run")

    assert progress[0]["files"][0]["path"] == "docs/guide.md"
    assert progress[0]["files"][0]["added_lines"] == 1
    assert progress[0]["files"][0]["deleted_lines"] == 1
    assert progress[0]["files"][0]["patch_complete"] is True


def test_pipeline_merges_openai_argument_chunks_by_index_after_first_id() -> None:
    pipeline = ToolCallChunkPipeline()

    pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_patch",
                    "index": 0,
                    "name": "apply_patch",
                    "args": "",
                }
            ],
        ),
        model_run_id="model_run",
    )
    progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": None,
                    "index": 0,
                    "name": None,
                    "args": (
                        '{"patch":"*** Begin Patch\\n'
                        '*** Update File: src/app.py\\n@@\\n-old\\n+one"}'
                    ),
                }
            ],
        ),
        model_run_id="model_run",
    )

    assert progress[0]["tool"] == "apply_patch"
    assert progress[0]["tool_call_id"] == "call_patch"
    assert progress[0]["files"][0]["path"] == "src/app.py"


def test_pipeline_merges_tool_call_chunks_by_index_when_id_arrives_late() -> None:
    pipeline = ToolCallChunkPipeline()

    first_progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": None,
                    "index": 0,
                    "name": "write_file",
                    "args": '{"path":"a.txt"',
                }
            ],
        ),
        model_run_id="model_run",
    )
    second_progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_write",
                    "index": 0,
                    "name": None,
                    "args": ',"content":"hello"}',
                }
            ],
        ),
        model_run_id="model_run",
    )
    tool_call_id = pipeline.bind_tool_run(
        run_id="tool_run_write",
        tool_name="write_file",
        params={"path": "a.txt", "content": "hello"},
    )

    assert first_progress[0]["tool_call_id"] == "model_run:0"
    assert first_progress[0]["files"][0]["path"] == "a.txt"
    assert second_progress[0]["tool_call_id"] == "call_write"
    assert second_progress[0]["files"][0]["path"] == "a.txt"
    assert second_progress[0]["files"][0]["added_lines"] == 1
    assert tool_call_id == "call_write"
    assert pipeline.tool_call_id_for_run("tool_run_write") == "call_write"


def test_pipeline_keeps_active_index_stream_when_model_run_id_drifts() -> None:
    pipeline = ToolCallChunkPipeline()

    first_progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": None,
                    "index": 0,
                    "name": "write_file",
                    "args": '{"path":"a.txt"',
                }
            ],
        ),
        model_run_id="model_run_a",
    )
    second_progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": None,
                    "index": 0,
                    "name": None,
                    "args": ',"content":"hello"}',
                }
            ],
        ),
        model_run_id="model_run_b",
    )
    tool_call_id = pipeline.bind_tool_run(
        run_id="tool_run_write",
        tool_name="write_file",
        params={"path": "a.txt", "content": "hello"},
    )

    assert first_progress[0]["tool_call_id"] == "model_run_a:0"
    assert second_progress[0]["tool_call_id"] == "model_run_a:0"
    assert second_progress[0]["files"][0]["path"] == "a.txt"
    assert second_progress[0]["files"][0]["added_lines"] == 1
    assert tool_call_id == "model_run_a:0"
    assert pipeline.tool_call_id_for_run("tool_run_write") == "model_run_a:0"


def test_pipeline_handles_interleaved_write_file_tool_calls() -> None:
    pipeline = ToolCallChunkPipeline()
    chunk = AIMessageChunk(
        content="",
        tool_call_chunks=[
            {
                "id": "call_a",
                "index": 0,
                "name": "write_file",
                "args": '{"path":"a.txt","content":"one\\ntwo"}',
            },
            {
                "id": "call_b",
                "index": 1,
                "name": "write_file",
                "args": '{"path":"b.txt","content":"three"}',
            },
        ],
    )

    progress = pipeline.process_chunk(chunk, model_run_id="model_run")

    actual = [
        (
            item["tool_call_id"],
            item["files"][0]["path"],
            item["files"][0]["operation"],
            item["files"][0]["added_lines"],
            item["files"][0]["diff"],
        )
        for item in progress
    ]
    assert actual == [
        (
            "call_a",
            "a.txt",
            "add",
            2,
            "--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n"
            "\\ No newline at end of file",
        ),
        (
            "call_b",
            "b.txt",
            "add",
            1,
            "--- /dev/null\n+++ b/b.txt\n@@ -0,0 +1 @@\n+three\n"
            "\\ No newline at end of file",
        ),
    ]


def test_pipeline_binds_real_tool_run_to_streamed_tool_call_by_params() -> None:
    pipeline = ToolCallChunkPipeline()
    pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_a",
                    "index": 0,
                    "name": "write_file",
                    "args": '{"path":"a.txt","content":"one\\ntwo"}',
                },
                {
                    "id": "call_b",
                    "index": 1,
                    "name": "write_file",
                    "args": '{"path":"b.txt","content":"three"}',
                },
            ],
        ),
        model_run_id="model_run",
    )

    tool_call_id = pipeline.bind_tool_run(
        run_id="tool_run_b",
        tool_name="write_file",
        params={"path": "b.txt", "content": "three"},
    )

    assert tool_call_id == "call_b"
    assert pipeline.tool_call_id_for_run("tool_run_b") == "call_b"


def test_pipeline_marks_write_file_progress_as_create_by_tool_name() -> None:
    pipeline = ToolCallChunkPipeline()
    chunk = AIMessageChunk(
        content="",
        tool_call_chunks=[
            {
                "id": "call_write",
                "index": 0,
                "name": "write_file",
                "args": '{"path":"a.txt","content":"new\\nsame\\n"}',
            },
        ],
    )

    progress = pipeline.process_chunk(chunk, model_run_id="model_run")

    file_change = progress[0]["files"][0]
    assert file_change["operation"] == "add"
    assert file_change["added_lines"] == 2
    assert file_change["deleted_lines"] == 0
    assert "+new" in file_change["diff"]


def test_pipeline_marks_write_file_progress_as_create_for_new_targets() -> None:
    pipeline = ToolCallChunkPipeline()
    chunk = AIMessageChunk(
        content="",
        tool_call_chunks=[
            {
                "id": "call_write",
                "index": 0,
                "name": "write_file",
                "args": '{"path":"new.txt","content":"hello"}',
            },
        ],
    )

    progress = pipeline.process_chunk(chunk, model_run_id="model_run")

    file_change = progress[0]["files"][0]
    assert file_change["operation"] == "add"
    assert file_change["added_lines"] == 1
    assert file_change["deleted_lines"] == 0
    assert file_change["diff"] == (
        "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n"
        "\\ No newline at end of file"
    )


def test_pipeline_distinguishes_legacy_patch_edit_file_from_claude_edit_file() -> None:
    pipeline = ToolCallChunkPipeline()

    legacy = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_legacy",
                    "index": 0,
                    "name": "edit_file",
                    "args": '{"patch":"*** Begin Patch\\n*** Update File: a.txt\\n@@\\n-old\\n+new\\n*** End Patch"}',
                }
            ],
        ),
        model_run_id="model_run",
    )
    claude = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_claude",
                    "index": 1,
                    "name": "edit_file",
                    "args": '{"path":"b.txt","old_string":"old\\n","new_string":"new\\nnext\\n"}',
                }
            ],
        ),
        model_run_id="model_run",
    )

    assert legacy[0]["files"][0]["path"] == "a.txt"
    assert legacy[0]["files"][0]["added_lines"] == 1
    assert claude[0]["files"][0]["path"] == "b.txt"
    assert claude[0]["files"][0]["added_lines"] == 2
    assert claude[0]["files"][0]["deleted_lines"] == 1


def test_pipeline_emits_progress_for_delete_and_move_file() -> None:
    pipeline = ToolCallChunkPipeline()
    progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_delete",
                    "index": 0,
                    "name": "delete_file",
                    "args": '{"path":"old.txt"}',
                },
                {
                    "id": "call_move",
                    "index": 1,
                    "name": "move_file",
                    "args": '{"path":"old.txt","new_path":"new.txt"}',
                },
            ],
        ),
        model_run_id="model_run",
    )

    assert progress[0]["files"][0]["operation"] == "delete"
    assert progress[0]["files"][0]["path"] == "old.txt"
    assert progress[1]["files"][0]["operation"] == "move"
    assert progress[1]["files"][0]["old_path"] == "old.txt"
    assert progress[1]["files"][0]["new_path"] == "new.txt"
    assert progress[0]["files"][0]["patch_format"] == "none"
    assert progress[1]["files"][0]["patch_format"] == "none"
    assert progress[1]["files"][0]["patch_precision"] == "approximate"
    assert progress[1]["files"][0]["selectable_for_patch"] is False


def test_streaming_canonical_producers_emit_git_parseable_patches(tmp_path) -> None:
    add_root = tmp_path / "add"
    add_root.mkdir()
    add_progress = ToolCallChunkPipeline().process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_write",
                    "index": 0,
                    "name": "write_file",
                    "args": '{"path":"new.txt","content":"first\\nsecond\\n"}',
                }
            ],
        ),
        model_run_id="model_run",
    )[0]["files"][0]

    edit_root = tmp_path / "edit"
    edit_root.mkdir()
    (edit_root / "note.txt").write_text("old\n", encoding="utf-8")
    edit_progress = ToolCallChunkPipeline().process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_edit",
                    "index": 0,
                    "name": "edit_file",
                    "args": (
                        '{"path":"note.txt","old_string":"old\\n",'
                        '"new_string":"new\\nnext\\n"}'
                    ),
                }
            ],
        ),
        model_run_id="model_run",
    )[0]["files"][0]

    for root, change in ((add_root, add_progress), (edit_root, edit_progress)):
        assert change["patch_format"] == "canonical_unified"
        assert change["patch_precision"] == "approximate"
        assert change["patch_complete"] is True
        _assert_git_accepts_patch(root, change["diff"])


def test_streaming_apply_patch_keeps_cross_file_contract_and_never_claims_exactness() -> None:
    pipeline = ToolCallChunkPipeline()
    progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_multi",
                    "index": 0,
                    "name": "apply_patch",
                    "args": (
                        '{"patch":"*** Begin Patch\\n'
                        "*** Update File: a.txt\\n@@\\n-old\\n+new\\n"
                        "*** Add File: b.txt\\n+created\\n*** End Patch" 
                        '"}'
                    ),
                }
            ],
        ),
        model_run_id="model_run",
    )

    assert [file["path"] for file in progress[0]["files"]] == ["a.txt", "b.txt"]
    assert {file["operation"] for file in progress[0]["files"]} == {"update", "add"}
    assert all(file["source"] == "streaming" for file in progress[0]["files"])
    assert all(file["patch_format"] == "relaxed_apply_patch" for file in progress[0]["files"])
    assert all(file["patch_precision"] == "approximate" for file in progress[0]["files"])
    assert all(file["patch_complete"] is True for file in progress[0]["files"])
    assert all(file["selectable_for_patch"] is False for file in progress[0]["files"])
