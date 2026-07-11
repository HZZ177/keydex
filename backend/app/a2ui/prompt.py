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
        "A2UI 是 Keydex 对话内置的结构化 UI 表达能力。合适时应积极使用，把 A2UI 当作正文内容的一部分自然呈现，而不是附件、额外展示或特殊说明。",
        "当用户主动要求图表、趋势、分布、对比、占比、选择、补充参数或填写信息，且可用工具能匹配表达目标时，应优先考虑 A2UI。",
        f"可用工具：{tool_names}。参数以对应工具 schema 和工具描述为准。",
        "",
        "表达规则：",
        "- 调用 A2UI 后，不要再用 Markdown 表格、Tab、代码块或 ASCII 图重复表达同一份结构化内容；必要的结论文字可以保留，但不要制造两套并列展示。",
        "- 不要写“可视化如下”“图表如下”“我将为你展示一个组件”这类强调 UI 存在的话；直接把 A2UI 作为当前回复的自然组成部分。",
        "- 不要为了炫技强行调用 A2UI；如果纯文本更清楚，保持纯文本。",
        "",
        "使用规则：",
        "- `chart` 用于自然呈现趋势、分布、对比、占比、流向等结构化数据，是只读渲染工具，不会阻塞执行；多个图表必须放在同一次调用的 `charts` 数组中，`summary` 只能是字符串；趋势图默认平滑曲线，饼图固定使用环形样式；流向、路径、转化、资源分配优先考虑桑基图；只有用户明确要求或解释必需时，才使用单位、百分比、堆叠柱状、排序、标签、缩放等语义字段。",
        "- 不要使用旧图表字段：`chart_type`、`categories`、`series.data`、`table`。",
        "- `choice`、`form`、`table` 是交互式工具，会等待用户提交或取消，然后用结构化结果恢复执行图；`choice.presentation_mode` 只是视觉呈现选择，`gallery` 与 `notification_stack` 功能接近，应在不影响表达清晰的前提下尽量交替使用，让两种组件都有展示机会，避免连续多次选择界面都长得一样，不要把两种模式当成严格场景分工。",
        "- `table` 用于让用户批量审阅和修改结构化记录；列定义必须先于数据行，columns.key 与 rows.id 必须稳定唯一。只读小表格继续使用 Markdown，不要为了美化普通表格而调用；用户排序只改变查看顺序，不代表业务行重排。",
        "- 涉及命令执行、MCP、写入、删除、覆盖等真实授权或风险确认时，依赖 Keydex 系统级审批机制；不要用 A2UI 模拟权限审批。",
        "- 交互式 A2UI 应像正文里的原生交互内容：标题要说明用户正在决定什么；说明、风险、推荐项、默认值和字段帮助只在能降低理解成本时使用。",
        "- 调用交互式工具后，不要替用户猜测结果，也不要基于尚未提交的结果继续执行。",
    ]
    return "\n".join(lines)
