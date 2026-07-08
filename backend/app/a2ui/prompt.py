from __future__ import annotations

from backend.app.a2ui.registry import A2UIRegistry, build_builtin_a2ui_registry


def build_a2ui_prompt_section(
    *,
    enabled: bool,
    registry: A2UIRegistry | None = None,
) -> str:
    if not enabled:
        return ""
    resolved = registry or build_builtin_a2ui_registry()
    tool_names = "、".join(f"`{definition.render_key}`" for definition in resolved.definitions)
    lines = [
        "## A2UI 交互式界面工具",
        "",
        "仅当可视化界面或用户输入能明显提升回答质量时使用 Keydex 内置 A2UI。",
        f"可用工具：{tool_names}。参数以对应工具 schema 和工具描述为准。",
        "",
        "使用规则：",
        "- `chart` 是只读渲染工具，不会阻塞执行；多个图表必须放在同一次调用的 `charts` 数组中，`summary` 只能是字符串。",
        "- 不要使用旧图表字段：`chart_type`、`categories`、`series.data`、`table`。",
        "- `confirm`、`choice`、`form` 是交互式工具，会等待用户提交或取消，然后用结构化结果恢复执行图。",
        "- 调用交互式工具后，不要替用户猜测结果，也不要基于尚未提交的结果继续执行。",
    ]
    return "\n".join(lines)
