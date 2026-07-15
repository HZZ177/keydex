from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.registry import ToolRegistry
from backend.app.web.errors import WebProviderError
from backend.app.web.models import (
    WEB_SEARCH_DEFAULT_MAX_RESULTS,
    WEB_SEARCH_MAX_RESULTS,
    WebFetchRequest,
    WebSearchRequest,
)
from backend.app.web.service import WebService

WEB_SEARCH_TOOL_NAME = "web_search"
WEB_FETCH_TOOL_NAME = "web_fetch"

WEB_SEARCH_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "query": {
            "type": "string",
            "minLength": 1,
            "description": (
                "完整、具体的搜索意图。应包含回答问题所需的关键上下文，"
                "而不只是缺少语境的单个词。"
            ),
        },
        "max_results": {
            "type": "integer",
            "minimum": 1,
            "maximum": WEB_SEARCH_MAX_RESULTS,
            "default": WEB_SEARCH_DEFAULT_MAX_RESULTS,
            "description": (
                "希望返回的来源数量，范围 1 到 20，默认 5。快速事实查询通常使用 5；"
                "资料调研、方案比较或需要更多来源时可使用 10 到 20。"
            ),
        },
        "time_range": {
            "type": "string",
            "enum": ["day", "week", "month", "year"],
            "description": (
                "仅在确实需要近期信息时设置：day、week、month 或 year；"
                "查询稳定知识时应省略。"
            ),
        },
        "domains": {
            "type": "array",
            "items": {"type": "string", "minLength": 1},
            "maxItems": 10,
            "description": (
                "将搜索限制在这些公开网站域名。只填写域名，"
                "不要包含协议、路径或通配符。"
            ),
        },
    },
    "required": ["query"],
    "additionalProperties": False,
}

WEB_SEARCH_DESCRIPTION = (
    "搜索公开互联网，返回相关来源的标题、URL、摘要和 source_id。\n\n"
    "在需要获取当前或可能变化的信息、查找公开资料、核实现有认知，或者需要发现"
    "可进一步读取的网页时使用。用户明确要求搜索、查找最新信息或提供外部来源时，"
    "应使用此工具。\n\n"
    "使用说明：\n"
    "- query 应表达完整、具体的搜索意图，而不只是缺少上下文的单个词。\n"
    "- max_results 范围为 1 到 20，默认 5；快速事实查询通常使用 5，"
    "资料调研、方案比较或需要更多来源时可使用 10 到 20。\n"
    "- 只有确实需要近期结果时才设置 time_range；查询稳定知识时应省略。\n"
    "- domains 用于将结果限制在指定公开网站。\n"
    "- 搜索结果中的摘要不是网页完整正文。需要核对原文、提取具体细节或引用页面"
    "内容时，继续使用 web_fetch。\n"
    "- 如果用户已经提供明确 URL，通常直接使用 web_fetch，无需先搜索。"
)

WEB_FETCH_PARAMETERS: dict[str, Any] = {
    "type": "object",
    "properties": {
        "urls": {
            "type": "array",
            "items": {"type": "string", "minLength": 1},
            "minItems": 1,
            "maxItems": 5,
            "description": (
                "要读取的 1 到 5 个公开 HTTP(S) 网页 URL。"
                "可直接使用用户提供的 URL 或 web_search 返回的来源 URL。"
            ),
        },
        "query": {
            "type": "string",
            "description": (
                "可选，描述希望从页面中重点提取的信息；"
                "需要理解整个页面时应省略。"
            ),
        },
    },
    "required": ["urls"],
    "additionalProperties": False,
}

WEB_FETCH_DESCRIPTION = (
    "读取 1 到 5 个公开 HTTP(S) 网页，逐 URL 返回正文内容、source_id、读取状态和"
    "截断信息。\n\n"
    "在用户提供了明确网页、需要读取搜索结果原文、核对具体事实，或者需要从多个页面"
    "提取和比较信息时使用。\n\n"
    "使用说明：\n"
    "- urls 可以直接使用用户提供的 URL，也可以使用 web_search 返回的来源 URL。\n"
    "- query 可用于说明需要从页面中重点提取的信息；需要理解整个页面时可以省略。\n"
    "- 多个 URL 会分别返回结果，部分页面失败不代表其他页面也失败。\n"
    "- truncated=true 表示只返回了部分正文，不应声称已经完整读取页面。\n"
    "- 只支持公开网页，不支持本地文件、私网地址、登录态页面、自定义请求头或受保护"
    "内容。"
)


def create_web_search_tool(service: WebService) -> FunctionTool:
    async def web_search_handler(
        args: dict[str, Any],
        context: ToolExecutionContext,
    ) -> dict[str, Any]:
        del context
        try:
            request = WebSearchRequest(**args)
        except ValidationError as exc:
            raise ToolExecutionError(
                "网络搜索参数无效",
                code="invalid_request",
                details={"validation_errors": len(exc.errors())},
            ) from exc
        try:
            response = await service.search(request)
        except WebProviderError as exc:
            raise _web_tool_error(exc) from exc
        return {
            "kind": "web_search",
            "schema_version": 1,
            "status": "success",
            **response.model_dump(mode="json"),
        }

    return FunctionTool(
        name=WEB_SEARCH_TOOL_NAME,
        description=WEB_SEARCH_DESCRIPTION,
        parameters=WEB_SEARCH_PARAMETERS,
        handler=web_search_handler,
    )


def register_web_search_tool(registry: ToolRegistry, service: WebService) -> FunctionTool:
    tool = create_web_search_tool(service)
    registry.register(tool)
    return tool


def create_web_fetch_tool(service: WebService) -> FunctionTool:
    async def web_fetch_handler(
        args: dict[str, Any],
        context: ToolExecutionContext,
    ) -> dict[str, Any]:
        del context
        try:
            request = WebFetchRequest(**args)
        except ValidationError as exc:
            raise ToolExecutionError(
                "网页读取参数无效",
                code="invalid_request",
                details={"validation_errors": len(exc.errors())},
            ) from exc
        try:
            response = await service.fetch(request)
        except WebProviderError as exc:
            raise _web_tool_error(exc) from exc
        return {
            "kind": "web_fetch",
            "schema_version": 1,
            **response.model_dump(mode="json"),
        }

    return FunctionTool(
        name=WEB_FETCH_TOOL_NAME,
        description=WEB_FETCH_DESCRIPTION,
        parameters=WEB_FETCH_PARAMETERS,
        handler=web_fetch_handler,
    )


def register_web_fetch_tool(registry: ToolRegistry, service: WebService) -> FunctionTool:
    tool = create_web_fetch_tool(service)
    registry.register(tool)
    return tool


def _web_tool_error(error: WebProviderError) -> ToolExecutionError:
    payload = error.payload
    details: dict[str, Any] = {
        "retryable": payload.retryable,
    }
    if payload.provider_id:
        details["provider_id"] = payload.provider_id
    if payload.retry_after_seconds is not None:
        details["retry_after_seconds"] = payload.retry_after_seconds
    return ToolExecutionError(
        payload.message,
        code=str(payload.code),
        details=details,
    )
