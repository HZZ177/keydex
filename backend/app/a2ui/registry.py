from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

A2UIMode = Literal["render", "interactive"]
BUILTIN_A2UI_RENDER_KEYS = frozenset({"chart", "confirm", "choice", "form"})
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
            "label": {"type": "string", "minLength": 1, "description": "展示给用户看的选项名称。"},
            "value": {"type": "string", "minLength": 1, "description": "提交给运行时的稳定选项值。"},
            "description": {"type": "string", "description": "选项的补充说明，可选。"},
        },
        required=["label", "value"],
    )


def _chart_data_item_schema() -> dict[str, Any]:
    return _object_schema(
        properties={
            "name": {
                "type": "string",
                "minLength": 1,
                "description": "数据点名称。所有图表类型的类别标签都使用该字段。",
            },
            "value": {"type": "number", "description": "数据点数值。"},
            "ratio": {
                "type": "number",
                "minimum": 0,
                "maximum": 100,
                "description": "漏斗图专用的转化比例，范围 0-100。",
            },
            "color": {"type": "string", "description": "饼图专用的自定义扇区颜色。"},
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


def _builtin_definitions() -> tuple[A2UIToolDefinition, ...]:
    return (
        A2UIToolDefinition(
            render_key="chart",
            mode="render",
            tool_description=(
                "当回复需要自然呈现趋势、分布、对比、漏斗、占比等结构化数据时优先调用，"
                "A2UI 图表就是正文内容，不要再输出重复 Markdown 表格或图表，也不要写“可视化如下”。"
                "支持漏斗图、趋势图、柱状图或饼图；一次调用必须用 charts 数组承载一个或多个图表；"
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
                                    "enum": ["funnel", "trend", "column", "pie"],
                                    "description": "图表类型：funnel 漏斗图，trend 趋势图，column 柱状图，pie 饼图。",
                                },
                                "title": {"type": "string", "description": "该图表标题，不传则不显示。"},
                                "series_label": {
                                    "type": "string",
                                    "description": "单系列场景的提示标签，不传则使用默认值。",
                                },
                                "items": {
                                    "type": "array",
                                    "items": _chart_data_item_schema(),
                                    "description": "单系列数据点，漏斗图和饼图常用；每项使用 name 和 value。",
                                },
                                "series": {
                                    "type": "array",
                                    "items": _chart_series_schema(),
                                    "description": "多系列数据，趋势图和柱状图常用；每个系列使用 items，不使用 data。",
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
            render_key="confirm",
            mode="interactive",
            tool_description=(
                "当继续执行需要用户明确授权、确认风险、删除、覆盖、写入、提交或执行不可轻易撤销的动作时优先调用，"
                "请用户确认或拒绝一个明确动作；该工具会等待用户提交或取消。"
            ),
            input_schema=_object_schema(
                properties={
                    "title": {"type": "string", "minLength": 1, "description": "确认卡片标题。"},
                    "description": {"type": "string", "description": "需要用户确认的动作、影响或风险说明。"},
                    "confirm_label": {"type": "string", "description": "确认按钮文案，可选。"},
                    "cancel_label": {"type": "string", "description": "取消按钮文案，可选。"},
                    "danger": {"type": "boolean", "description": "是否为高风险操作。高风险操作会要求用户额外确认。"},
                },
                required=["title"],
            ),
            submit_schema=_object_schema(
                properties={
                    "confirmed": {"type": "boolean", "description": "用户是否确认继续执行。"},
                    "note": {"type": "string", "description": "用户填写的备注，可选。"},
                },
                required=["confirmed"],
            ),
        ),
        A2UIToolDefinition(
            render_key="choice",
            mode="interactive",
            tool_description=(
                "当存在多个可行方案、范围、对象、格式、路径或下一步动作，需要用户从候选项中决定时优先调用，"
                "展示单选或多选决策项；该工具会等待用户选择或取消后继续执行。"
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
                "该工具会等待用户提交或取消。"
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
