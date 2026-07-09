from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.a2ui.registry import (
    A2UIToolDefinition,
    BUILTIN_A2UI_RENDER_KEYS,
    A2UIRegistry,
    build_builtin_a2ui_registry,
)


def test_builtin_registry_contains_only_supported_render_keys() -> None:
    registry = build_builtin_a2ui_registry()

    assert set(registry.render_keys) == BUILTIN_A2UI_RENDER_KEYS
    assert registry.require("chart").mode == "render"
    assert registry.require("choice").mode == "interactive"
    assert registry.require("form").mode == "interactive"


def test_builtin_definitions_have_object_schemas_and_descriptions() -> None:
    registry = build_builtin_a2ui_registry()

    for definition in registry.definitions:
        assert definition.input_schema["type"] == "object"
        assert definition.submit_schema["type"] == "object"
        assert definition.tool_description.strip()
        assert _contains_chinese(definition.tool_description)
        assert _schema_descriptions_are_chinese(definition.input_schema)
        assert _schema_descriptions_are_chinese(definition.submit_schema)
        assert definition.stream_enabled is True


def test_builtin_chart_schema_uses_sdk_chart_group_contract() -> None:
    chart = build_builtin_a2ui_registry().require("chart")

    assert "charts 数组" in chart.tool_description
    assert "summary 是字符串" in chart.tool_description
    assert "chart_type" in chart.tool_description
    assert "不等待用户提交" in chart.tool_description
    assert "优先调用" in chart.tool_description
    assert "不要再输出重复 Markdown 表格或图表" in chart.tool_description
    assert "unit" in chart.tool_description
    assert "zoom" in chart.tool_description
    assert "桑基图" in chart.tool_description
    assert chart.input_schema["required"] == ["title", "charts"]
    properties = chart.input_schema["properties"]
    assert "chart_type" not in properties
    assert "categories" not in properties
    assert "rows" not in properties

    chart_item = properties["charts"]["items"]
    assert chart_item["properties"]["type"]["enum"] == ["trend", "column", "pie", "sankey"]
    assert chart_item["required"] == ["type"]
    assert set(chart_item["properties"]) == {
        "type",
        "title",
        "series_label",
        "unit",
        "precision",
        "prefix",
        "suffix",
        "value_format",
        "mode",
        "sort",
        "show_labels",
        "show_percent",
        "smooth",
        "zoom",
        "items",
        "series",
        "nodes",
        "links",
    }
    assert chart_item["properties"]["value_format"]["enum"] == ["number", "percent"]
    assert chart_item["properties"]["mode"]["enum"] == ["grouped", "stacked"]
    assert chart_item["properties"]["sort"]["enum"] == ["none", "asc", "desc"]
    assert chart_item["properties"]["show_labels"]["enum"] == ["auto", "always", "never"]
    assert chart_item["properties"]["items"]["items"]["required"] == ["name", "value"]
    assert chart_item["properties"]["series"]["items"]["required"] == ["name", "items"]
    assert chart_item["properties"]["nodes"]["items"]["required"] == ["name"]
    assert chart_item["properties"]["links"]["items"]["required"] == ["source", "target", "value"]
    assert properties["summary"]["type"] == "string"


def test_interactive_tool_descriptions_encourage_suitable_a2ui_usage() -> None:
    registry = build_builtin_a2ui_registry()

    assert "多个可行方案" in registry.require("choice").tool_description
    assert "优先调用" in registry.require("choice").tool_description
    assert "presentation_mode" in registry.require("choice").tool_description
    assert "gallery" in registry.require("choice").tool_description
    assert "notification_stack" in registry.require("choice").tool_description
    assert "以上都不对" in registry.require("choice").tool_description
    assert "缺少多个关键参数" in registry.require("form").tool_description
    assert "优先调用" in registry.require("form").tool_description


def test_interactive_schemas_include_mature_inline_ui_metadata() -> None:
    registry = build_builtin_a2ui_registry()

    choice_properties = registry.require("choice").input_schema["properties"]
    choice_option_properties = choice_properties["options"]["items"]["properties"]
    assert "default_values" in choice_properties
    assert choice_properties["presentation_mode"]["enum"] == ["gallery", "notification_stack"]
    assert {"badge", "recommended", "disabled"}.issubset(choice_option_properties)
    assert "卡片主标题" in choice_option_properties["label"]["description"]
    assert "卡片主体说明" in choice_option_properties["description"]["description"]

    form_field_properties = registry.require("form").input_schema["properties"]["fields"]["items"]["properties"]
    form_option_properties = form_field_properties["options"]["items"]["properties"]
    assert {"help", "default_value", "min", "max", "step"}.issubset(form_field_properties)
    assert {"badge", "disabled"}.issubset(form_option_properties)


def test_registry_rejects_render_key_conflicts_with_existing_tools() -> None:
    with pytest.raises(ValueError, match="conflicts"):
        build_builtin_a2ui_registry(reserved_tool_names={"read_file", "chart"})


def test_registry_rejects_duplicate_render_keys() -> None:
    chart = build_builtin_a2ui_registry().require("chart")

    with pytest.raises(ValueError, match="duplicate"):
        A2UIRegistry(definitions=(chart, chart))


def test_tool_definition_rejects_invalid_render_key() -> None:
    with pytest.raises(ValidationError, match="render_key"):
        A2UIToolDefinition(
            render_key="Bad-Key",
            mode="render",
            input_schema={"type": "object", "properties": {}},
            submit_schema={"type": "object", "properties": {}},
            tool_description="bad",
        )


def test_tool_definition_rejects_non_object_json_schema() -> None:
    with pytest.raises(ValidationError, match="schema type must be object"):
        A2UIToolDefinition(
            render_key="custom",
            mode="render",
            input_schema={"type": "array", "items": {}},
            submit_schema={"type": "object", "properties": {}},
            tool_description="bad",
        )


def _contains_chinese(value: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in value)


def _schema_descriptions_are_chinese(schema: object) -> bool:
    if isinstance(schema, dict):
        description = schema.get("description")
        if isinstance(description, str) and description and not _contains_chinese(description):
            return False
        return all(_schema_descriptions_are_chinese(value) for value in schema.values())
    if isinstance(schema, list):
        return all(_schema_descriptions_are_chinese(item) for item in schema)
    return True
