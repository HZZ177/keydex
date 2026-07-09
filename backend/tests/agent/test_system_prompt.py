from backend.app.agent.system_prompt import (
    CODEX_FILE_EDIT_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
    build_file_edit_prompt_section,
)


def test_default_prompt_does_not_hardcode_patch_edit_file_contract() -> None:
    assert "edit_file` 的 `patch` 参数" not in DEFAULT_SYSTEM_PROMPT
    assert "不支持 `*** Add File`" not in DEFAULT_SYSTEM_PROMPT
    assert "文件编辑工具风格" in DEFAULT_SYSTEM_PROMPT


def test_claude_file_edit_prompt_matches_tool_set() -> None:
    prompt = build_file_edit_prompt_section("claude_code")

    assert "Claude Code 风格" in prompt
    assert "create_file(path, content)" in prompt
    assert "edit_file(path, old_string, new_string" in prompt
    assert "delete_file(path)" in prompt
    assert "move_file(path, new_path)" in prompt
    assert "read_file" in prompt
    assert "apply_patch" in prompt
    assert "Begin Patch" not in prompt


def test_codex_file_edit_prompt_matches_tool_set() -> None:
    prompt = build_file_edit_prompt_section("codex")

    assert prompt is CODEX_FILE_EDIT_PROMPT
    assert "Codex 风格" in prompt
    assert "apply_patch(patch)" in prompt
    assert "*** Add File" in prompt
    assert "*** Update File" in prompt
    assert "*** Delete File" in prompt
    assert "*** Move to" in prompt
    assert "old_string" not in prompt
