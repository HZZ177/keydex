from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx

E2E_MODEL_ID = "e2e-codex-stream"


def create_e2e_model_transport(*, delay_ms: int = 80) -> httpx.MockTransport:
    """Create an explicit E2E-only OpenAI-compatible HTTP transport.

    This is enabled only by CODEX_COPY_E2E_MODEL_TRANSPORT. It is injected into
    LangChain's ChatOpenAI httpx client for page-level E2E tests, not used as a
    runtime fallback when model configuration is missing.
    """

    async def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.rstrip("/")
        if path.endswith("/models"):
            return httpx.Response(
                200,
                json={"data": [{"id": E2E_MODEL_ID, "owned_by": "codex-copy-e2e"}]},
            )
        if path.endswith("/chat/completions"):
            payload = _json_body(await request.aread())
            user_message = _last_user_message(payload)
            if "LLM 400" in user_message:
                return httpx.Response(
                    400,
                    json={"error": {"message": "E2E 模型返回 HTTP 400"}},
                )
            if payload.get("stream") is False:
                return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})
            chunks = _chat_chunks(payload)
            return httpx.Response(
                200,
                stream=DelayedSSEStream(chunks, delay_ms=delay_ms),
                headers={"content-type": "text/event-stream; charset=utf-8"},
            )
        return httpx.Response(404, json={"error": {"message": f"未支持的 E2E 模型路径: {path}"}})

    return httpx.MockTransport(handler)


class DelayedSSEStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[str], *, delay_ms: int) -> None:
        self.chunks = chunks
        self.delay_seconds = max(delay_ms, 0) / 1000

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            if self.delay_seconds:
                await asyncio.sleep(self.delay_seconds)
            yield chunk.encode("utf-8")


def _chat_chunks(payload: dict[str, Any]) -> list[str]:
    user_message = _last_user_message(payload)
    if "工具时序" in user_message:
        return _tool_sequence_chunks(payload)
    if "预览面板" in user_message:
        return _preview_panel_chunks(payload)
    if "工具失败" in user_message:
        return _tool_failure_chunks(payload)
    if "取消验收" in user_message:
        return _cancel_chunks(payload)
    if "取消后继续" in user_message:
        return _content_chunks(
            payload,
            "取消后继续成功，新的请求已经恢复。",
            usage={"prompt_tokens": 12, "completion_tokens": 10},
        )
    if "继续成功" in user_message:
        return _content_chunks(
            payload,
            "错误后继续成功，新的请求已经恢复。",
            usage={"prompt_tokens": 12, "completion_tokens": 10},
        )
    if "错误" in user_message and "继续" not in user_message:
        return [_chat_sse(payload, delta={}, finish_reason="stop"), _sse_done()]

    long_paragraph = (
        "滚动段落：这段文字用于撑开真实页面高度，确认只有外层对话页面滚动，"
        "消息正文区域不会再制造一层纵向滚动条。"
    )
    markdown = (
        "# 流式 Markdown 验收\n\n"
        "这是一段由 E2E 测试模型逐段返回的中文内容，用来确认页面不会瞬间刷屏，"
        "并且会经过真实 WebSocket、事件投影和前端动态打字机缓冲。\n\n"
        "1. 先显示标题和普通段落。\n"
        "2. 再显示有序列表。\n"
        "3. 最后显示代码块和收尾检查点。\n\n"
        f"{long_paragraph}\n\n"
        f"{long_paragraph}\n\n"
        f"{long_paragraph}\n\n"
        f"{long_paragraph}\n\n"
        f"{long_paragraph}\n\n"
        f"{long_paragraph}\n\n"
        f"{long_paragraph}\n\n"
        f"{long_paragraph}\n\n"
        f"{long_paragraph}\n\n"
        f"{long_paragraph}\n\n"
        "```ts\n"
        "const status = \"streaming\";\n"
        "console.log(`当前状态: ${status}`);\n"
        "```\n\n"
        "最终检查点：Markdown、代码块和长文本已经完整显示。"
    )
    return _content_chunks(payload, markdown, usage={"prompt_tokens": 11, "completion_tokens": 38})


def _tool_sequence_chunks(payload: dict[str, Any]) -> list[str]:
    if _has_tool_message(payload):
        return _content_chunks(
            payload,
            "工具调用已经完成：已读取 README.md，并执行本地命令确认工具链可用。",
            usage={"prompt_tokens": 18, "completion_tokens": 16},
        )
    return [
        _chat_sse(
            payload,
            delta={"reasoning_content": "先读取 README，再执行一个安全的本地命令。"},
        ),
        _chat_sse(
            payload,
            delta={
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_e2e_read_file",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": "{\"path\":\"README.md\",\"max_lines\":8}",
                        },
                    },
                    {
                        "index": 1,
                        "id": "call_e2e_run_command",
                        "type": "function",
                        "function": {
                            "name": "run_command",
                            "arguments": json.dumps(
                                {
                                    "command": "echo e2e-tool-ok",
                                    "cwd": ".",
                                    "timeout_seconds": 5,
                                },
                                separators=(",", ":"),
                            ),
                        },
                    },
                ]
            },
            finish_reason="tool_calls",
        ),
        _sse_done(),
    ]


def _preview_panel_chunks(payload: dict[str, Any]) -> list[str]:
    return _content_chunks(
        payload,
        (
            "下面是一段用于打开预览面板的 HTML 片段。\n\n"
            "```html\n"
            "<main><h1>预览面板检查点</h1><p>HTML 预览已通过页面级 E2E 打开。</p></main>\n"
            "```\n\n"
            "预览面板检查点。"
        ),
        usage={"prompt_tokens": 14, "completion_tokens": 18},
    )


def _tool_failure_chunks(payload: dict[str, Any]) -> list[str]:
    if _has_tool_message(payload):
        return _content_chunks(
            payload,
            "工具失败已经被记录，后续对话仍可继续。",
            usage={"prompt_tokens": 20, "completion_tokens": 12},
        )
    return [
        _chat_sse(
            payload,
            delta={"reasoning_content": "准备读取一个不存在的文件，用于验证工具错误展示。"},
        ),
        _chat_sse(
            payload,
            delta={
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_e2e_missing_file",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": json.dumps(
                                {
                                    "path": "missing-e2e-tool-file.txt",
                                    "max_lines": 8,
                                },
                                separators=(",", ":"),
                            ),
                        },
                    }
                ]
            },
            finish_reason="tool_calls",
        ),
        _sse_done(),
    ]


def _cancel_chunks(payload: dict[str, Any]) -> list[str]:
    paragraph = "取消验收正在流式输出，页面应该允许用户中途停止并保留已输出内容。"
    return _content_chunks(payload, "\n".join(paragraph for _ in range(80)))


def _content_chunks(
    payload: dict[str, Any],
    content: str,
    *,
    usage: dict[str, int] | None = None,
) -> list[str]:
    parts = _split_content(content)
    chunks = [_chat_sse(payload, delta={"content": part}) for part in parts]
    chunks.append(_chat_sse(payload, delta={}, finish_reason="stop", usage=usage))
    chunks.append(_sse_done())
    return chunks


def _split_content(content: str) -> list[str]:
    if len(content) <= 48:
        return [content]
    parts: list[str] = []
    step = 34
    for index in range(0, len(content), step):
        parts.append(content[index : index + step])
    return parts


def _chat_sse(
    request_payload: dict[str, Any],
    *,
    delta: dict[str, Any],
    finish_reason: str | None = None,
    usage: dict[str, int] | None = None,
) -> str:
    model = str(request_payload.get("model") or E2E_MODEL_ID)
    payload: dict[str, Any] = {
        "id": "chatcmpl-e2e",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }
        ],
    }
    if usage is not None:
        payload["usage"] = usage
    return _sse(payload)


def _last_user_message(payload: dict[str, Any]) -> str:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content")
            return content if isinstance(content, str) else ""
    return ""


def _has_tool_message(payload: dict[str, Any]) -> bool:
    messages = payload.get("messages")
    return isinstance(messages, list) and any(
        isinstance(message, dict) and message.get("role") == "tool"
        for message in messages
    )


def _json_body(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _sse_done() -> str:
    return "data: [DONE]\n\n"
