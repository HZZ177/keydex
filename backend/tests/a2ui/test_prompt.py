from __future__ import annotations

from backend.app.a2ui.prompt import build_a2ui_prompt_section
from backend.app.a2ui.registry import BUILTIN_A2UI_RENDER_KEYS, build_builtin_a2ui_registry


def test_a2ui_prompt_is_empty_when_disabled() -> None:
    assert build_a2ui_prompt_section(enabled=False) == ""


def test_a2ui_prompt_lists_builtin_tools_and_resume_semantics() -> None:
    prompt = build_a2ui_prompt_section(
        enabled=True,
        registry=build_builtin_a2ui_registry(),
    )

    for render_key in BUILTIN_A2UI_RENDER_KEYS:
        assert f"`{render_key}`" in prompt
    assert "A2UI 交互式界面工具" in prompt
    assert "等待用户提交或取消" in prompt
    assert "恢复执行图" in prompt
    assert "configure" not in prompt.lower()


def test_a2ui_prompt_keeps_main_system_prompt_compact_without_examples() -> None:
    prompt = build_a2ui_prompt_section(
        enabled=True,
        registry=build_builtin_a2ui_registry(),
    )

    assert "```" not in prompt
    assert "示例" not in prompt
    assert "例如" not in prompt
    assert "{" not in prompt
    assert "}" not in prompt
    assert "chart_type" in prompt
    assert "summary" in prompt
    assert "charts" in prompt
