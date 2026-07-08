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
    assert "正文内容的一部分" in prompt
    assert "应优先考虑 A2UI" in prompt
    assert "等待用户提交或取消" in prompt
    assert "恢复执行图" in prompt
    assert "推荐项、默认值和字段帮助" in prompt
    assert "`confirm`" not in prompt
    assert "模拟权限审批" in prompt
    assert "configure" not in prompt.lower()
    assert "仅当可视化界面或用户输入能明显提升" not in prompt


def test_a2ui_prompt_treats_ui_as_natural_content_without_duplicate_markdown() -> None:
    prompt = build_a2ui_prompt_section(
        enabled=True,
        registry=build_builtin_a2ui_registry(),
    )

    assert "把 A2UI 当作正文内容" in prompt
    assert "不要再用 Markdown 表格、Tab、代码块或 ASCII 图重复表达同一份结构化内容" in prompt
    assert "不要写“可视化如下”“图表如下”“我将为你展示一个组件”" in prompt


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
