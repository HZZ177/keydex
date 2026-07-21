from __future__ import annotations

import pytest

from backend.app.agent.tool_results.budgets import (
    GLOBAL_TOOL_RESULT_BUDGET_BYTES,
    ToolResultPolicy,
    approximate_tokens,
    get_tool_result_policy,
    utf8_bytes,
)


def test_utf8_byte_and_token_estimates_cover_multibyte_text() -> None:
    assert utf8_bytes("abc") == 3
    assert utf8_bytes("中文") == 6
    assert utf8_bytes("😀") == 4
    assert approximate_tokens("中文") == 2
    assert approximate_tokens(0) == 0


def test_named_and_generic_policies_are_code_owned_and_bounded() -> None:
    assert get_tool_result_policy("search_text").budget_bytes == 32 * 1024
    assert get_tool_result_policy("search_text").breadth_first_compaction is True
    assert get_tool_result_policy("grep_files").budget_bytes == 24 * 1024
    assert get_tool_result_policy("list_dir").budget_bytes == 10 * 1024
    assert get_tool_result_policy("load_skill").must_be_complete is True
    assert get_tool_result_policy("apply_patch").never_clear is True
    assert get_tool_result_policy("delegate_subagent").unbounded_model_result is True
    assert get_tool_result_policy("continue_subagent").unbounded_model_result is True
    assert get_tool_result_policy("unknown_tool").budget_bytes == GLOBAL_TOOL_RESULT_BUDGET_BYTES
    assert get_tool_result_policy("mcp__server__read").persist_before_clear is True


def test_policy_rejects_any_budget_above_global_guard() -> None:
    with pytest.raises(ValueError, match="global 32KB"):
        ToolResultPolicy(budget_bytes=GLOBAL_TOOL_RESULT_BUDGET_BYTES + 1)
