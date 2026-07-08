from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

A2UIMode = Literal["render", "interactive"]
BUILTIN_A2UI_RENDER_KEYS = frozenset({"chart", "choice", "form"})
_RENDER_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


class A2UIToolDefinition(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    render_key: str = Field(min_length=1, max_length=64)
    mode: A2UIMode
    input_schema: dict[str, Any]
    submit_schema: dict[str, Any]
    tool_description: str = Field(min_length=1)
    stream_enabled: bool = True

    @field_validator("render_key")
    @classmethod
    def validate_render_key(cls, value: str) -> str:
        cleaned = value.strip()
        if not _RENDER_KEY_PATTERN.fullmatch(cleaned):
            raise ValueError("render_key must match ^[a-z][a-z0-9_]{0,63}$")
        return cleaned

    @field_validator("input_schema", "submit_schema")
    @classmethod
    def validate_json_schema_object(cls, value: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise ValueError("schema must be a JSON object")
        if value.get("type") != "object":
            raise ValueError("schema type must be object")
        return dict(value)


@dataclass(frozen=True)
class A2UIRegistry:
    definitions: tuple[A2UIToolDefinition, ...]

    def __post_init__(self) -> None:
        _validate_registry(self.definitions)

    @property
    def render_keys(self) -> tuple[str, ...]:
        return tuple(definition.render_key for definition in self.definitions)

    def get(self, render_key: str) -> A2UIToolDefinition | None:
        for definition in self.definitions:
            if definition.render_key == render_key:
                return definition
        return None

    def require(self, render_key: str) -> A2UIToolDefinition:
        definition = self.get(render_key)
        if definition is None:
            raise KeyError(f"unknown A2UI render_key: {render_key}")
        return definition

    def is_a2ui_tool(self, tool_name: str | None) -> bool:
        return bool(tool_name and self.get(tool_name) is not None)


def build_builtin_a2ui_registry(
    *,
    reserved_tool_names: set[str] | frozenset[str] | None = None,
) -> A2UIRegistry:
    definitions = _builtin_definitions()
    _validate_registry(definitions, reserved_tool_names=reserved_tool_names or frozenset())
    return A2UIRegistry(definitions=definitions)


def _validate_registry(
    definitions: tuple[A2UIToolDefinition, ...],
    *,
    reserved_tool_names: set[str] | frozenset[str] | None = None,
) -> None:
    keys = [definition.render_key for definition in definitions]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate A2UI render_key")
    reserved = set(reserved_tool_names or ())
    conflicts = sorted(set(keys) & reserved)
    if conflicts:
        raise ValueError(f"A2UI render_key conflicts with existing tool names: {','.join(conflicts)}")


def _object_schema(
    *,
    properties: dict[str, Any],
    required: list[str] | None = None,
    additional_properties: bool = False,
) -> dict[str, Any]:
    schema: dict[str, Any] = {
        "type": "object",
        "properties": properties,
        "additionalProperties": additional_properties,
    }
    if required:
        schema["required"] = required
    return schema


def _option_schema() -> dict[str, Any]:
    return _object_schema(
        properties={
            "label": {"type": "string", "minLength": 1, "description": "卡片主标题，短而明确。"},
            "value": {"type": "string", "minLength": 1, "description": "提交给运行时的稳定选项值。"},
            "description": {
                "type": "string",
                "description": "卡片主体说明，说明关键差异、适用场景、风险或下一步影响，可选。",
            },
            "badge": {
                "type": "string",
                "description": "卡片短标签，例如 推荐、低风险、快速、保守、实验性，可选。",
            },
            "recommended": {"type": "boolean", "description": "是否标记为推荐选项，可选。"},
            "disabled": {"type": "boolean", "description": "是否暂不可选；只在需要解释候选但不允许用户选择时使用。"},
        },
        required=["label", "value"],
    )


def _default_value_schema(description: str) -> dict[str, Any]:
    return {
        "type": ["string", "number", "boolean", "array", "null"],
        "description": description,
    }


def _chart_data_item_schema() -> dict[str, Any]:
    return _object_schema(
        properties={
            "name": {
                "type": "string",
                "minLength": 1,
                "description": "数据点名称。所有图表类型的类别标签都使用该字段。",
            },
            "value": {"type": "number", "description": "数据点数值。"},
            "color": {"type": "string", "description": "可选自定义颜色。"},
        },
        required=["name", "value"],
    )


def _chart_series_schema() -> dict[str, Any]:
    return _object_schema(
        properties={
            "name": {"type": "string", "minLength": 1, "description": "数据系列名称。"},
            "items": {
                "type": "array",
                "items": _chart_data_item_schema(),
                "description": "该系列下的数据点列表。",
            },
        },
        required=["name", "items"],
    )


def _chart_node_schema() -> dict[str, Any]:
    return _object_schema(
        properties={
            "name": {"type": "string", "minLength": 1, "description": "桑基图节点名称。"},
            "value": {"type": "number", "description": "节点辅助数值，可选。"},
            "color": {"type": "string", "description": "节点可选自定义颜色。"},
        },
        required=["name"],
    )


def _chart_link_schema() -> dict[str, Any]:
    return _object_schema(
        properties={
            "source": {"type": "string", "minLength": 1, "description": "桑基图流向起点节点名称。"},
            "target": {"type": "string", "minLength": 1, "description": "桑基图流向终点节点名称。"},
            "value": {"type": "number", "description": "该流向的权重或数值。"},
            "color": {"type": "string", "description": "流向线条可选自定义颜色。"},
        },
        required=["source", "target", "value"],
    )


def _builtin_definitions() -> tuple[A2UIToolDefinition, ...]:
    return (
        A2UIToolDefinition(
            render_key="chart",
            mode="render",
            tool_description=(
                "当回复需要自然呈现趋势、分布、对比、占比等结构化数据时优先调用，"
                "A2UI 图表就是正文内容，不要再输出重复 Markdown 表格或图表，也不要写“可视化如下”。"
                "支持趋势图、柱状图、环形饼图或桑基图；一次调用必须用 charts 数组承载一个或多个图表；"
                "饼图固定使用环形样式；仅在用户明确需要或表达确实依赖时使用 unit、precision、value_format、mode、sort、show_labels、show_percent、smooth、zoom；"
                "不要为了装饰默认开启标签或缩放。"
                "桑基图用 nodes 和 links 表达流向。"
                "summary 是字符串；不要使用 chart_type、categories、series.data、table 等旧字段。"
                "该工具只渲染界面，不等待用户提交。"
            ),
            input_schema=_object_schema(
                properties={
                    "title": {"type": "string", "minLength": 1, "description": "图表组标题。"},
                    "summary": {"type": "string", "description": "图表摘要说明，只能是字符串，不能传对象。"},
                    "charts": {
                        "type": "array",
                        "description": "有序图表数组；多个图表必须放在同一次 chart 调用中，每个元素渲染一个图表。",
                        "items": _object_schema(
                            properties={
                                "type": {
                                    "type": "string",
                                    "enum": ["trend", "column", "pie", "sankey"],
                                    "description": "图表类型：trend 趋势图，column 柱状图，pie 环形饼图，sankey 桑基图。",
                                },
                                "title": {"type": "string", "description": "该图表标题，不传则不显示。"},
                                "series_label": {
                                    "type": "string",
                                    "description": "单系列场景的提示标签，不传则使用默认值。",
                                },
                                "unit": {"type": "string", "description": "数值单位，例如 元、万元、GB、%。"},
                                "precision": {
                                    "type": "integer",
                                    "minimum": 0,
                                    "maximum": 6,
                                    "description": "数值小数位数，范围 0-6。",
                                },
                                "prefix": {"type": "string", "description": "数值前缀，例如 ¥ 或 $。"},
                                "suffix": {"type": "string", "description": "数值后缀；不传时可使用 unit。"},
                                "value_format": {
                                    "type": "string",
                                    "enum": ["number", "percent"],
                                    "description": "数值格式：number 普通数字，percent 百分比。",
                                },
                                "mode": {
                                    "type": "string",
                                    "enum": ["grouped", "stacked"],
                                    "description": "柱状图模式，仅 type=column 时使用；grouped 分组，stacked 堆叠。",
                                },
                                "sort": {
                                    "type": "string",
                                    "enum": ["none", "asc", "desc"],
                                    "description": "排序方式；柱状图和饼图可用，none 保持原始顺序。",
                                },
                                "show_labels": {
                                    "type": "string",
                                    "enum": ["auto", "always", "never"],
                                    "description": "是否显示图形数值标签；auto 根据数据量自动决定。",
                                },
                                "show_percent": {"type": "boolean", "description": "饼图是否显示占比，仅 type=pie 时使用。"},
                                "smooth": {"type": "boolean", "description": "趋势图是否使用平滑曲线；默认 true，保持平滑趋势线。"},
                                "zoom": {
                                    "type": "boolean",
                                    "description": "坐标图是否显示缩放控件；仅在数据量大且用户需要拖拽查看时使用。",
                                },
                                "items": {
                                    "type": "array",
                                    "items": _chart_data_item_schema(),
                                    "description": "单系列数据点，饼图常用；每项使用 name 和 value。",
                                },
                                "series": {
                                    "type": "array",
                                    "items": _chart_series_schema(),
                                    "description": "多系列数据，趋势图和柱状图常用；每个系列使用 items，不使用 data。",
                                },
                                "nodes": {
                                    "type": "array",
                                    "items": _chart_node_schema(),
                                    "description": "桑基图节点列表；每个节点使用 name，可选 value 和 color。",
                                },
                                "links": {
                                    "type": "array",
                                    "items": _chart_link_schema(),
                                    "description": "桑基图流向列表；每条流向使用 source、target、value。",
                                },
                            },
                            required=["type"],
                        ),
                    },
                },
                required=["title", "charts"],
            ),
            submit_schema=_object_schema(properties={}),
        ),
        A2UIToolDefinition(
            render_key="choice",
            mode="interactive",
            tool_description=(
                "当存在多个可行方案、范围、对象、格式、路径或下一步动作，需要用户从候选项中决定时优先调用。"
                "choice 会以画廊卡片形式展示单选或多选候选项，适合每个候选项都有名称、标签和简短说明的场景；"
                "每个 option 都会成为一张候选卡片，因此 label 应清晰短促，badge 用于表达类别、推荐、风险或成本，"
                "description 用于说明选择依据、适用场景或关键差异，不要只给一组没有解释的短词。"
                "可以用 recommended、disabled、default_values 引导用户快速决策。"
                "候选项数量较多时仍可使用，但应保证每个候选项信息密度足够；简单 yes/no 或权限审批不要使用 choice。"
                "该工具会等待用户选择、取消，或选择“以上都不对”并提交修正意见后继续执行。"
            ),
            input_schema=_object_schema(
                properties={
                    "title": {"type": "string", "minLength": 1, "description": "选择卡片标题。"},
                    "description": {"type": "string", "description": "选择背景、判断依据或选择说明。"},
                    "multiple": {"type": "boolean", "description": "是否允许多选。false 或省略表示单选。"},
                    "options": {
                        "type": "array",
                        "minItems": 1,
                        "items": _option_schema(),
                        "description": "候选项列表。",
                    },
                    "default_values": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "默认选中的 option.value 列表；单选只使用第一个有效值。",
                    },
                    "min_selected": {"type": "integer", "minimum": 0, "description": "最少需要选择的数量。"},
                    "max_selected": {"type": "integer", "minimum": 1, "description": "最多允许选择的数量。"},
                },
                required=["title", "options"],
            ),
            submit_schema=_object_schema(
                properties={
                    "selected_values": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "用户选择的 option.value 列表。",
                    },
                    "result_type": {
                        "type": "string",
                        "enum": ["selection", "correction"],
                        "description": "提交类型：selection 表示选择候选项，correction 表示用户认为以上选项都不对并提交补充意见。",
                    },
                    "correction_note": {
                        "type": "string",
                        "description": "当 result_type=correction 时，用户输入的修正意见。",
                    },
                    "note": {"type": "string", "description": "用户填写的备注，可选。"},
                },
                required=["selected_values"],
            ),
        ),
        A2UIToolDefinition(
            render_key="form",
            mode="interactive",
            tool_description=(
                "当缺少多个关键参数或需要用户补充结构化信息时优先调用，通过小型表单收集输入；"
                "字段应保持少而关键；可为字段提供 help、default_value、placeholder、min/max/step，"
                "让用户能快速确认并提交；该工具会等待用户提交或取消。"
            ),
            input_schema=_object_schema(
                properties={
                    "title": {"type": "string", "minLength": 1, "description": "表单标题。"},
                    "description": {"type": "string", "description": "表单用途、填写说明或上下文。"},
                    "fields": {
                        "type": "array",
                        "minItems": 1,
                        "description": "表单字段列表。",
                        "items": _object_schema(
                            properties={
                                "name": {"type": "string", "minLength": 1, "description": "字段名，用作提交 values 的键。"},
                                "label": {"type": "string", "minLength": 1, "description": "展示给用户看的字段标签。"},
                                "type": {
                                    "type": "string",
                                    "enum": [
                                        "text",
                                        "textarea",
                                        "number",
                                        "boolean",
                                        "select",
                                        "multiselect",
                                        "date",
                                    ],
                                    "description": "字段类型。",
                                },
                                "required": {"type": "boolean", "description": "该字段是否必填。"},
                                "placeholder": {"type": "string", "description": "输入框占位提示，可选。"},
                                "help": {"type": "string", "description": "字段下方的简短填写说明，可选。"},
                                "default_value": _default_value_schema("字段默认值，可选。"),
                                "min": {"type": "number", "description": "number 字段最小值，可选。"},
                                "max": {"type": "number", "description": "number 字段最大值，可选。"},
                                "step": {"type": "number", "description": "number 字段步长，可选。"},
                                "options": {
                                    "type": "array",
                                    "items": _option_schema(),
                                    "description": "select 或 multiselect 字段使用的候选项。",
                                },
                            },
                            required=["name", "label", "type"],
                        ),
                    },
                    "submit_label": {"type": "string", "description": "提交按钮文案，可选。"},
                },
                required=["title", "fields"],
            ),
            submit_schema=_object_schema(
                properties={
                    "values": {"type": "object", "description": "用户提交的表单值，键为 fields.name。"},
                    "note": {"type": "string", "description": "用户填写的备注，可选。"},
                },
                required=["values"],
                additional_properties=False,
            ),
        ),
    )
