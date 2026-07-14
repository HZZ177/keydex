from backend.app.agent.system_prompt import (
    CODEX_FILE_EDIT_PROMPT,
    DEFAULT_SYSTEM_PROMPT,
    PLAN_PROGRESS_PROMPT,
    build_file_edit_prompt_section,
)


def test_default_prompt_does_not_hardcode_patch_edit_file_contract() -> None:
    assert "edit_file` 的 `patch` 参数" not in DEFAULT_SYSTEM_PROMPT
    assert "不支持 `*** Add File`" not in DEFAULT_SYSTEM_PROMPT
    assert "文件编辑工具风格" in DEFAULT_SYSTEM_PROMPT


def test_plan_progress_prompt_defines_usage_and_lifecycle() -> None:
    assert "至少 3 个有意义的动作" in PLAN_PROGRESS_PROMPT
    assert "不要创建计划" in PLAN_PROGRESS_PROMPT
    assert "开始下一步骤前立即再次调用 `update_plan`" in PLAN_PROGRESS_PROMPT
    assert "不应遗留 `pending` 或 `in_progress`" in PLAN_PROGRESS_PROMPT
    assert "计划状态属于当前 session" in PLAN_PROGRESS_PROMPT
    assert "新的完整数组替换上一份计划" in PLAN_PROGRESS_PROMPT
    assert "已经 `completed` 或 `failed` 的步骤" in PLAN_PROGRESS_PROMPT
    assert "步骤完成不代表它不再相关" in PLAN_PROGRESS_PROMPT
    assert "不得仅因步骤已经完成而将其省略" in PLAN_PROGRESS_PROMPT
    assert "被取消、被替代或确认不再需要执行" in PLAN_PROGRESS_PROMPT
    assert "全部步骤正常完成时，保留完整计划" in PLAN_PROGRESS_PROMPT
    assert "不要发送" in PLAN_PROGRESS_PROMPT
    assert "旧计划被明确放弃" in PLAN_PROGRESS_PROMPT
    assert "空数组是有效的完整快照" in PLAN_PROGRESS_PROMPT
    assert "用户开启明显无关的新任务时" in PLAN_PROGRESS_PROMPT
    assert "新任务不需要计划" in PLAN_PROGRESS_PROMPT
    assert "这不算为简单任务" in PLAN_PROGRESS_PROMPT


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
