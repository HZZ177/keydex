from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import AsyncIterator
from typing import Any

import httpx

E2E_MODEL_ID = "e2e-keydex-stream"
MCP_DISCOVERY_TOOL_NAME = "discover_mcp_tools"


def create_e2e_model_transport(*, delay_ms: int = 80) -> httpx.MockTransport:
    """Create an explicit E2E-only OpenAI-compatible HTTP transport.

    This is enabled only by KEYDEX_E2E_MODEL_TRANSPORT. It is injected into
    LangChain's ChatOpenAI httpx client for page-level E2E tests, not used as a
    runtime fallback when model configuration is missing.
    """

    async def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.rstrip("/")
        if path.endswith("/models"):
            return httpx.Response(
                200,
                json={"data": [{"id": E2E_MODEL_ID, "owned_by": "keydex-e2e"}]},
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
                if "上下文压缩摘要" in user_message:
                    return httpx.Response(
                        200,
                        json={
                            "choices": [
                                {
                                    "message": {
                                        "role": "assistant",
                                        "content": "E2E 压缩摘要：已保留关键目标、约束和最近对话。",
                                    }
                                }
                            ]
                        },
                    )
                if "用户首轮问题" in user_message and "助手最终回复" in user_message:
                    return httpx.Response(
                        200,
                        json={
                            "choices": [
                                {"message": {"role": "assistant", "content": "E2E 自动标题"}}
                            ]
                        },
                    )
                return httpx.Response(
                    200,
                    json={"choices": [{"message": {"role": "assistant", "content": "ok"}}]},
                )
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
    if "e2e-rewind-" in user_message.lower():
        return _rewind_fixture_chunks(payload, user_message)
    if "PendingInputEcho" in user_message:
        return _content_chunks(
            payload,
            f"PendingInputEcho received: {user_message}",
            usage={"prompt_tokens": 12, "completion_tokens": 10},
        )
    if "PendingInputToolGate" in user_message:
        return _pending_input_tool_gate_chunks(payload)
    if "MCP Deferred" in user_message:
        return _mcp_deferred_chunks(payload, user_message)
    if "MCP Runtime" in user_message:
        return _mcp_runtime_chunks(payload, user_message)
    if "CommandRuntime" in user_message:
        return _command_runtime_chunks(payload, user_message)
    if "命令审批" in user_message:
        return _command_approval_chunks(payload, user_message)
    if "编辑进度" in user_message:
        return _file_edit_progress_chunks(payload)
    if "工具时序" in user_message:
        return _tool_sequence_chunks(payload)
    if "SessionFork第一轮" in user_message:
        return _content_chunks(
            payload,
            f"SessionFork 第一轮检查点 {_scenario_marker(user_message)}",
            usage={"prompt_tokens": 10, "completion_tokens": 8},
        )
    if "SessionFork第二轮" in user_message:
        return _content_chunks(
            payload,
            f"SessionFork 第二轮检查点 {_scenario_marker(user_message)}",
            usage={"prompt_tokens": 10, "completion_tokens": 8},
        )
    if "SessionFork分支继续" in user_message:
        return _content_chunks(
            payload,
            f"SessionFork 分支继续检查点 {_scenario_marker(user_message)}",
            usage={"prompt_tokens": 10, "completion_tokens": 8},
        )
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
        'const status = "streaming";\n'
        "console.log(`当前状态: ${status}`);\n"
        "```\n\n"
        "最终检查点：Markdown、代码块和长文本已经完整显示。"
    )
    return _content_chunks(payload, markdown, usage={"prompt_tokens": 11, "completion_tokens": 38})


def _rewind_fixture_chunks(payload: dict[str, Any], user_message: str) -> list[str]:
    """Drive rewind E2E fixtures through the same controlled tools as a real turn."""

    if _has_tool_message(payload):
        return _content_chunks(
            payload,
            f"e2e-rewind fixture completed: {_scenario_marker(user_message)}",
            usage={"prompt_tokens": 18, "completion_tokens": 10},
        )
    scenario = user_message.lower()
    if "no-code" in scenario or scenario.endswith("-anchor"):
        return _content_chunks(
            payload,
            f"e2e-rewind conversation anchor: {_scenario_marker(user_message)}",
            usage={"prompt_tokens": 12, "completion_tokens": 8},
        )
    if "running" in scenario:
        chunks = [
            _chat_sse(
                payload,
                delta={"reasoning_content": f"e2e-rewind running checkpoint {index + 1}/80。"},
            )
            for index in range(80)
        ]
        chunks.extend(
            _content_chunks(
                payload,
                "e2e-rewind running fixture completed.",
                usage={"prompt_tokens": 12, "completion_tokens": 8},
            )
        )
        return chunks

    tool_name, arguments = _rewind_tool_call(payload, user_message)
    if not tool_name:
        available = ", ".join(_payload_tool_names(payload)) or "none"
        return _content_chunks(
            payload,
            f"e2e-rewind tool unavailable. available tools: {available}",
            usage={"prompt_tokens": 12, "completion_tokens": 10},
        )
    return [
        _chat_sse(
            payload,
            delta={"reasoning_content": f"e2e-rewind fixture is calling {tool_name}."},
        ),
        _chat_sse(
            payload,
            delta={
                "tool_calls": [
                    {
                        "index": 0,
                        "id": (
                            "call_e2e_rewind_"
                            + hashlib.sha256(user_message.encode("utf-8")).hexdigest()[:16]
                        ),
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": json.dumps(
                                arguments,
                                ensure_ascii=False,
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


def _rewind_tool_call(
    payload: dict[str, Any],
    user_message: str,
) -> tuple[str, dict[str, Any]]:
    scenario = user_message.lower()
    available = set(_payload_tool_names(payload))
    if "cycle-struct-recreate" in scenario:
        arguments = {"path": "cycle-struct.txt", "content": "STRUCT V2\n"}
        return ("create_file", arguments) if "create_file" in available else ("", {})
    if "cycle-struct-delete" in scenario:
        return (
            ("delete_file", {"path": "cycle-struct.txt"})
            if "delete_file" in available
            else ("", {})
        )
    if "cycle-struct-create" in scenario:
        arguments = {"path": "cycle-struct.txt", "content": "STRUCT V1\n"}
        return ("create_file", arguments) if "create_file" in available else ("", {})
    if "multi-patch" in scenario or "apply-patch" in scenario:
        patch = (
            "*** Begin Patch\n"
            "*** Add File: a.txt\n"
            "+A created by e2e-rewind\n"
            "*** Add File: extra-1.txt\n"
            "+extra 1\n"
            "*** Add File: extra-2.txt\n"
            "+extra 2\n"
            "*** Add File: extra-3.txt\n"
            "+extra 3\n"
            "*** Add File: extra-4.txt\n"
            "+extra 4\n"
            "*** Add File: extra-5.txt\n"
            "+extra 5\n"
            "*** Add File: extra-6.txt\n"
            "+extra 6\n"
            "*** Add File: extra-7.txt\n"
            "+extra 7\n"
            "*** Add File: extra-8.txt\n"
            "+extra 8\n"
            "*** Update File: b.txt\n"
            "@@\n"
            "-B before\n"
            "+B after\n"
            "*** Delete File: c.txt\n"
            "*** End Patch"
        )
        return ("apply_patch", {"patch": patch}) if "apply_patch" in available else ("", {})
    if "delete" in scenario:
        return (
            ("delete_file", {"path": "delete-me.txt"})
            if "delete_file" in available
            else ("", {})
        )
    if "move" in scenario:
        arguments = {"path": "source.txt", "new_path": "nested/target.txt"}
        return ("move_file", arguments) if "move_file" in available else ("", {})
    if "create" in scenario:
        arguments = {"path": "created.txt", "content": "created by e2e-rewind\n"}
        return ("create_file", arguments) if "create_file" in available else ("", {})

    explicit = re.search(
        r"e2e-rewind-write-(?P<path>[a-z0-9_.-]+)-(?P<old>[a-z0-9_.-]+)-to-(?P<new>[a-z0-9_.-]+)",
        scenario,
    )
    if explicit:
        path_alias = explicit.group("path")
        path = path_alias if "." in path_alias else f"{path_alias}.txt"
        old_marker = explicit.group("old")
        new_marker = explicit.group("new")
        old_string = "" if old_marker == "missing" else f"{old_marker.upper()}\n"
        return _rewind_edit_tool_call(
            available,
            path=path,
            old_string=old_string,
            new_string=f"{new_marker.upper()}\n",
        )

    match = re.search(r"e2e-rewind-(?:both|code|conversation)-([a-z])\b", scenario)
    if match:
        marker = match.group(1).upper()
        previous = "" if marker == "A" else f"{chr(ord(marker) - 1)}\n"
        return _rewind_edit_tool_call(
            available,
            path="main.txt",
            old_string=previous,
            new_string=f"{marker}\n",
        )
    return "", {}


def _rewind_edit_tool_call(
    available: set[str],
    *,
    path: str,
    old_string: str,
    new_string: str,
) -> tuple[str, dict[str, Any]]:
    if "edit_file" in available:
        return "edit_file", {
            "path": path,
            "old_string": old_string,
            "new_string": new_string,
        }
    if not old_string and "create_file" in available:
        return "create_file", {"path": path, "content": new_string}
    return "", {}


def _command_runtime_chunks(payload: dict[str, Any], user_message: str) -> list[str]:
    if _has_tool_message(payload):
        return _content_chunks(
            payload,
            "CommandRuntime 场景已经完成，命令工具结果已返回给模型。",
            usage={"prompt_tokens": 18, "completion_tokens": 12},
        )
    scenario = user_message.lower()
    tool_name = "run_cmd"
    command = "echo e2e-command-runtime-ok"
    timeout_seconds = 5
    description = "E2E command runtime"
    if "long" in scenario or "cancel" in scenario:
        command = "ping -n 30 127.0.0.1 > nul"
        timeout_seconds = 30
        description = "E2E long running command"
    elif "big-output" in scenario:
        command = "for /L %i in (1,1,420) do @echo e2e-big-output-%i-abcdefghijklmnopqrstuvwxyz"
        timeout_seconds = 10
        description = "E2E big output command"
    elif "powershell" in scenario:
        tool_name = "run_powershell"
        command = "Write-Output e2e-powershell-ok"
        description = "E2E PowerShell command"
    elif "git-bash" in scenario or "bash" in scenario:
        tool_name = "run_git_bash"
        command = "echo e2e-git-bash-ok"
        description = "E2E Git Bash command"
    elif "switch-cmd" in scenario:
        command = "echo e2e-switch-cmd-ok"
        description = "E2E switched CMD command"
    elif "trust-path" in scenario:
        command = "echo e2e-trust-path"
        description = "E2E trust path command"

    return [
        _chat_sse(
            payload,
            delta={"reasoning_content": f"准备执行 {description}。"},
        ),
        _chat_sse(
            payload,
            delta={
                "tool_calls": [
                    {
                        "index": 0,
                        "id": f"call_e2e_{tool_name}_runtime",
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": json.dumps(
                                {
                                    "command": command,
                                    "description": description,
                                    "cwd": ".",
                                    "timeout_seconds": timeout_seconds,
                                },
                                ensure_ascii=False,
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


def _command_approval_chunks(payload: dict[str, Any], user_message: str) -> list[str]:
    if _has_tool_message(payload):
        return _content_chunks(
            payload,
            "命令审批场景已经完成，工具结果已返回给模型。",
            usage={"prompt_tokens": 18, "completion_tokens": 12},
        )
    command = _command_for_approval_prompt(user_message)
    return [
        _chat_sse(
            payload,
            delta={"reasoning_content": "准备执行命令审批 E2E 场景。"},
        ),
        _chat_sse(
            payload,
            delta={
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_e2e_command_approval",
                        "type": "function",
                        "function": {
                            "name": "run_cmd",
                            "arguments": json.dumps(
                                {
                                    "command": command,
                                    "cwd": ".",
                                    "timeout_seconds": 5,
                                },
                                ensure_ascii=False,
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


def _command_for_approval_prompt(user_message: str) -> str:
    scenarios = {
        "allow-once": "echo e2e-approval-once",
        "reject": "echo e2e-approval-reject",
        "exact-different": "echo e2e-approval-exact-different",
        "exact": "echo e2e-approval-exact",
        "prefix-more": "echo e2e-approval-prefix more",
        "prefix-other": "echo e2e-approval-other",
        "prefix": "echo e2e-approval-prefix",
        "no-persistent": "echo e2e-no-persistent",
        "never-ask": "echo e2e-never-ask",
        "disabled": "echo e2e-disabled-command",
        "rule-disable": "echo e2e-rule-disable",
        "rule-delete": "echo e2e-rule-delete",
        "waiting": "echo e2e-waiting-badge",
        "composer-only": "echo e2e-composer-only",
        "nonzero": "cmd /c exit 3",
        "timeout": "ping -n 3 127.0.0.1 > nul",
        "truncated": "echo e2e-long-output-abcdefghijklmnopqrstuvwxyz",
    }
    for key, command in scenarios.items():
        if key in user_message:
            return command
    return "echo e2e-approval-default"


def _mcp_runtime_chunks(payload: dict[str, Any], user_message: str) -> list[str]:
    target = _mcp_target_from_user_message(user_message)
    if _has_tool_message(payload):
        return _content_chunks(
            payload,
            f"MCP Runtime 场景已经完成：{target} 工具结果已返回给模型。"
            "最终检查点：MCP Runtime 工具调用已返回。",
            usage={"prompt_tokens": 20, "completion_tokens": 14},
        )

    tool_name = _mcp_model_tool_name(payload, target)
    if not tool_name:
        available = ", ".join(_payload_tool_names(payload)) or "none"
        return _content_chunks(
            payload,
            f"MCP Runtime tool unavailable: {target}. available tools: {available}",
            usage={"prompt_tokens": 18, "completion_tokens": 12},
        )

    chunks = [
        _chat_sse(
            payload,
            delta={"reasoning_content": f"准备调用 MCP 工具 {target}。"},
        )
    ]
    if _mcp_should_delay_tool_call(user_message):
        chunks.extend(
            _chat_sse(
                payload,
                delta={
                    "reasoning_content": (
                        f"MCP Runtime snapshot freeze wait {index + 1}/24。"
                    )
                },
            )
            for index in range(24)
        )
    chunks.extend(
        [
            _chat_sse(
                payload,
                delta={
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": f"call_e2e_mcp_{target}",
                            "type": "function",
                            "function": {
                                "name": tool_name,
                                "arguments": json.dumps(
                                    _mcp_tool_arguments(target, user_message),
                                    ensure_ascii=False,
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
    )
    return chunks


def _mcp_deferred_chunks(payload: dict[str, Any], user_message: str) -> list[str]:
    target = _mcp_target_from_user_message(user_message)
    lowered = user_message.lower()
    if _has_tool_message(payload):
        if "call" in lowered or "调用" in user_message:
            message = (
                f"MCP Deferred 场景已经完成：{target} 工具结果已返回给模型。"
                "最终检查点：MCP Deferred 已激活工具调用已返回。"
            )
        else:
            message = (
                f"MCP Deferred 搜索已经完成：{target} 候选结果已返回给模型。"
                "最终检查点：MCP Deferred 搜索结果已返回。"
            )
        return _content_chunks(
            payload,
            message,
            usage={"prompt_tokens": 18, "completion_tokens": 14},
        )

    if "list" in lowered or "列表" in user_message:
        tool_name = _mcp_exact_tool_name(payload, MCP_DISCOVERY_TOOL_NAME)
        arguments = {"limit": 5}
        action = "directory"
    elif "search" in lowered or "搜索" in user_message:
        tool_name = _mcp_exact_tool_name(payload, MCP_DISCOVERY_TOOL_NAME)
        arguments = {"query": _mcp_deferred_search_query(user_message, target), "limit": 10}
        action = "discover"
    else:
        tool_name = _mcp_model_tool_name(payload, target)
        arguments = _mcp_tool_arguments(target, user_message)
        action = "call"

    if action in {"discover", "directory"} and "strict" in lowered:
        tool_names = _payload_tool_names(payload)
        direct_mcp_tools = [name for name in tool_names if name.startswith("mcp__")]
        discovery_missing = MCP_DISCOVERY_TOOL_NAME not in tool_names
        if direct_mcp_tools or discovery_missing:
            return _content_chunks(
                payload,
                "MCP Deferred strict exposure failed: "
                f"direct={direct_mcp_tools}; discovery_missing={discovery_missing}; "
                f"available tools: {', '.join(tool_names) or 'none'}",
                usage={"prompt_tokens": 18, "completion_tokens": 12},
            )

    if not tool_name:
        available = ", ".join(_payload_tool_names(payload)) or "none"
        return _content_chunks(
            payload,
            f"MCP Deferred tool unavailable: {target}. available tools: {available}",
            usage={"prompt_tokens": 18, "completion_tokens": 12},
        )

    return [
        _chat_sse(
            payload,
            delta={"reasoning_content": f"准备执行 MCP Deferred {action}：{target}。"},
        ),
        _chat_sse(
            payload,
            delta={
                "tool_calls": [
                    {
                        "index": 0,
                        "id": f"call_e2e_mcp_deferred_{action}_{target}",
                        "type": "function",
                        "function": {
                            "name": tool_name,
                            "arguments": json.dumps(
                                arguments,
                                ensure_ascii=False,
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


def _mcp_deferred_search_query(user_message: str, default: str) -> str:
    match = re.search(r"\bquery:([A-Za-z0-9_.-]+)", user_message)
    if match:
        return match.group(1)
    return default


def _mcp_target_from_user_message(user_message: str) -> str:
    lowered = user_message.lower()
    generated_tool_match = re.search(r"\btool_[0-9]{2,4}\b", lowered)
    if generated_tool_match:
        return generated_tool_match.group(0)
    for raw_name in (
        "read_fixture",
        "write_fixture",
        "slow_echo",
        "always_fail",
        "large_payload",
        "request_elicitation",
        "request_sampling",
    ):
        if raw_name in lowered:
            return raw_name
    return "read_fixture"


def _mcp_should_delay_tool_call(user_message: str) -> bool:
    lowered = user_message.lower()
    return "live-guard" in lowered or "delay-tool-call" in lowered


def _mcp_tool_arguments(target: str, user_message: str) -> dict[str, Any]:
    if target == "write_fixture":
        return {"key": "runtime-snapshot", "value": "e2e-mcp-runtime"}
    if target == "slow_echo":
        lowered = user_message.lower()
        delay_ms = 4500 if "panel-cancel" in lowered else 1800 if "long" in lowered else 100
        return {"text": "e2e-mcp-runtime-snapshot", "delay_ms": delay_ms}
    if target == "always_fail":
        return {"reason": "e2e-mcp-runtime-failure"}
    if target == "large_payload":
        return {"size": 5000}
    if target == "request_elicitation":
        mode = "cancel" if "cancel" in user_message.lower() or "取消" in user_message else "submit"
        return {"mode": mode}
    if target == "request_sampling":
        lowered = user_message.lower()
        if "oversize" in lowered or "budget" in lowered or "超预算" in user_message:
            return {"mode": "oversize"}
        if "reject" in lowered or "拒绝" in user_message:
            return {"mode": "reject"}
        if "disabled" in lowered or "禁用" in user_message:
            return {"mode": "disabled"}
        return {"mode": "approve"}
    return {"key": "runtime-snapshot"}


def _mcp_model_tool_name(payload: dict[str, Any], raw_name: str) -> str:
    for name in _payload_tool_names(payload):
        if name == raw_name or name.endswith(f"__{raw_name}"):
            return name
    return ""


def _mcp_exact_tool_name(payload: dict[str, Any], expected_name: str) -> str:
    for name in _payload_tool_names(payload):
        if name == expected_name:
            return name
    return ""


def _payload_tool_names(payload: dict[str, Any]) -> list[str]:
    tools = payload.get("tools")
    if not isinstance(tools, list):
        return []
    names: list[str] = []
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        function = tool.get("function")
        if not name and isinstance(function, dict):
            name = function.get("name")
        if isinstance(name, str) and name:
            names.append(name)
    return names


def _scenario_marker(user_message: str) -> str:
    parts = user_message.strip().split()
    return parts[-1] if parts else "default"


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
                            "arguments": '{"path":"README.md","max_lines":8}',
                        },
                    },
                    {
                        "index": 1,
                        "id": "call_e2e_run_cmd",
                        "type": "function",
                        "function": {
                            "name": "run_cmd",
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


def _pending_input_tool_gate_chunks(payload: dict[str, Any]) -> list[str]:
    if _has_tool_message(payload):
        return _content_chunks(
            payload,
            "PendingInputToolGate completed without injected steer.",
            usage={"prompt_tokens": 16, "completion_tokens": 10},
        )
    return [
        _chat_sse(
            payload,
            delta={"reasoning_content": "PendingInputToolGate 正在打开下一次模型请求窗口。"},
        ),
        _chat_sse(
            payload,
            delta={
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_e2e_pending_input_gate",
                        "type": "function",
                        "function": {
                            "name": "run_cmd",
                            "arguments": json.dumps(
                                {
                                    "command": "ping -n 5 127.0.0.1 > nul",
                                    "cwd": ".",
                                    "timeout_seconds": 8,
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


def _file_edit_progress_chunks(payload: dict[str, Any]) -> list[str]:
    if _has_tool_message(payload):
        return _content_chunks(
            payload,
            "编辑进度已经完成：已更新 src/app.ts，并保留最终文件变更统计。",
            usage={"prompt_tokens": 22, "completion_tokens": 18},
        )
    patch = (
        "*** Begin Patch\n"
        "*** Update File: src/app.ts\n"
        "@@\n"
        '-export const status = "old";\n'
        '+export const status = "new";\n'
        '+export const marker = "e2e-edit-progress";\n'
        "*** End Patch\n"
    )
    arguments = json.dumps({"patch": patch}, ensure_ascii=False, separators=(",", ":"))
    chunks = [
        _chat_sse(
            payload,
            delta={
                "reasoning_content": (
                    "准备通过 edit_file 编辑 src/app.ts，并实时返回文件变更进度。"
                )
            },
        ),
        _chat_sse(
            payload,
            delta={
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "call_e2e_edit_file_progress",
                        "type": "function",
                        "function": {
                            "name": "edit_file",
                            "arguments": "",
                        },
                    }
                ]
            },
        ),
    ]
    chunks.extend(
        _chat_sse(
            payload,
            delta={
                "tool_calls": [
                    {
                        "index": 0,
                        "function": {
                            "arguments": arguments[index : index + 18],
                        },
                    }
                ]
            },
        )
        for index in range(0, len(arguments), 18)
    )
    chunks.append(_chat_sse(payload, delta={}, finish_reason="tool_calls"))
    chunks.append(_sse_done())
    return chunks


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
    return _tool_message_count_since_last_user(payload) > 0


def _tool_message_count_since_last_user(payload: dict[str, Any]) -> int:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return 0
    last_user_index = -1
    for index, message in enumerate(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            last_user_index = index
    return sum(
        isinstance(message, dict) and message.get("role") == "tool"
        for message in messages[last_user_index + 1 :]
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
