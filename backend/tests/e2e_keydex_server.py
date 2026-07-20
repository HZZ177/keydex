from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
import uvicorn
from langchain_core.messages import HumanMessage

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.agent.compact_runtime_attachments import (
    COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY,
)
from backend.app.agent.context_compression_utils import (
    is_context_compression_summary_message,
)
from backend.app.core.config import AppSettings
from backend.app.core.time import to_iso_z, utc_now
from backend.app.main import create_app
from backend.app.model.e2e_transport import E2E_MODEL_ID
from backend.app.services.structured_user_message_group import (
    StructuredUserMessageGroup,
    build_structured_user_message_member,
)
from backend.app.storage import MODEL_DEFAULT_CHAT, ModelProviderRecord

_COMPRESSION_SCENARIO_MARKERS = (
    "KeydexMixedCompressionE2E",
    "KeydexBudgetFilteredE2E",
    "KeydexLongCompactE2E",
    "KeydexCompressionRetryE2E",
    "KeydexCompressionFailE2E",
    "KeydexGoalCompactE2E",
    "KeydexSoftOverflowE2E",
    "KeydexMandatoryOverflowE2E",
)


class _DelayedSSEStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[str], delay_ms: int) -> None:
        self._chunks = chunks
        self._delay_seconds = max(delay_ms, 0) / 1000

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self._chunks:
            if self._delay_seconds:
                await asyncio.sleep(self._delay_seconds)
            yield chunk.encode("utf-8")


def _keydex_e2e_transport(
    delay_ms: int,
    observations: list[dict[str, Any]] | None = None,
    scenario_counts: dict[str, int] | None = None,
) -> httpx.MockTransport:
    async def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path.rstrip("/")
        if path.endswith("/models"):
            return httpx.Response(
                200,
                json={"data": [{"id": E2E_MODEL_ID, "owned_by": "keydex-e2e"}]},
            )
        if not path.endswith("/chat/completions"):
            return httpx.Response(404, json={"error": {"message": f"unsupported path: {path}"}})

        payload = _json_body(await request.aread())
        user_message = _last_user_message(payload)
        context = _keydex_context(payload)
        scenario_markers = _scenario_markers(payload)
        observation: dict[str, Any] | None = None
        if observations is not None:
            observation = {
                "last_user": user_message,
                "context_summary": _context_summary(context),
                "has_tool_message": _has_tool_message(payload),
                "tool_message_count": _tool_message_count(payload),
                "activation_marker": _activation_marker(payload),
                "scenario_markers": scenario_markers,
                "stream": payload.get("stream") is not False,
                "user_message_count": _role_message_count(payload, "user"),
                "compact_summary_count": _compact_summary_count(payload),
            }
            observations.append(observation)
        if payload.get("stream") is False:
            retry_marker = next(
                (
                    marker
                    for marker in (
                        "KeydexCompressionRetryE2E",
                        "KeydexCompressionFailE2E",
                    )
                    if marker in scenario_markers
                ),
                None,
            )
            if retry_marker is not None:
                counts = scenario_counts if scenario_counts is not None else {}
                counts[retry_marker] = counts.get(retry_marker, 0) + 1
                if observation is not None:
                    observation["compression_attempt"] = counts[retry_marker]
                if retry_marker == "KeydexCompressionFailE2E" or counts[retry_marker] <= 3:
                    return httpx.Response(
                        503,
                        json={"error": {"message": "controlled compression retry"}},
                    )
            summary_markers = ",".join(scenario_markers) or "ordinary-history"
            record_ids = re.findall(
                r'<(?:TURN|EXECUTION_SEGMENT)\s+id="([^"]+)"',
                user_message,
            )
            record_body = "".join(
                f'<记录 id="{record_id}">Keydex E2E compacted {summary_markers}</记录>'
                for record_id in record_ids
            )
            if not record_body:
                record_body = (
                    '<记录 id="TURN-0001">'
                    f"Keydex E2E compacted {summary_markers}</记录>"
                )
            return httpx.Response(
                200,
                json={
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": (
                                    f"<摘要>{record_body}<当前状态>"
                                    f"Keydex E2E current {summary_markers}"
                                    "</当前状态></摘要>"
                                ),
                            }
                        }
                    ],
                    "usage": {
                        "prompt_tokens": 1200,
                        "completion_tokens": 80,
                        "total_tokens": 1280,
                    },
                },
            )
        if "KeydexLongCompactE2E" in scenario_markers:
            counts = scenario_counts if scenario_counts is not None else {}
            long_stream_key = "KeydexLongCompactE2E:stream"
            counts[long_stream_key] = counts.get(long_stream_key, 0) + 1
            if counts[long_stream_key] <= 2:
                return _stream_tool_call_response(
                    payload,
                    name="read_file",
                    args={"path": "README.md", "start_line": 201, "max_lines": 50},
                    call_id=f"call_e2e_long_read_{counts[long_stream_key]}",
                    delay_ms=delay_ms,
                )
            return _stream_response(
                payload,
                "KeydexLongCompactE2E completed after two automatic compactions",
                delay_ms,
            )
        if "KeydexGoalCompactE2E" in scenario_markers:
            if _tool_name_count(payload, "update_thread_task") == 0:
                return _stream_tool_call_response(
                    payload,
                    name="update_thread_task",
                    args={
                        "status": "complete",
                        "summary": "KeydexGoalCompactE2E completed",
                        "checklist": [{"item": "compressed continuation", "status": "passed"}],
                        "evidence": [{"type": "test", "title": "controlled E2E completion"}],
                    },
                    call_id="call_e2e_goal_complete",
                    delay_ms=delay_ms,
                )
            return _stream_response(
                payload,
                "KeydexGoalCompactE2E continuation completed after compression",
                delay_ms,
            )
        if "KeydexInspectCompressionE2E" in user_message:
            markers = ">".join(scenario_markers) or "none"
            return _stream_response(
                payload,
                "KeydexInspectCompressionE2E "
                f"markers={markers} activation={_activation_marker(payload)} "
                f"compact_summaries={_compact_summary_count(payload)}",
                delay_ms,
            )
        if "KeydexToolsE2E" in user_message:
            tools = ",".join(sorted(_payload_tool_names(payload)))
            return _stream_response(
                payload,
                f"KeydexToolsE2E available: {tools}; {_context_summary(context)}",
                delay_ms,
            )
        if "KeydexSkillE2E" in user_message or "KeydexAutoSkillE2E" in user_message:
            if not _has_tool_message(payload):
                skill_name, source = _skill_request(user_message)
                return httpx.Response(
                    200,
                    stream=_DelayedSSEStream(
                        [
                            _sse_chunk(
                                payload,
                                {"reasoning_content": "Keydex E2E activating selected skill."},
                            ),
                            _sse_chunk(
                                payload,
                                {
                                    "tool_calls": [
                                        {
                                            "index": 0,
                                            "id": f"call_e2e_load_skill_{skill_name}",
                                            "type": "function",
                                            "function": {
                                                "name": "load_skill",
                                                "arguments": json.dumps(
                                                    {"skill_name": skill_name, "source": source},
                                                    ensure_ascii=False,
                                                    separators=(",", ":"),
                                                ),
                                            },
                                        }
                                    ]
                                },
                                finish_reason="tool_calls",
                            ),
                            "data: [DONE]\n\n",
                        ],
                        delay_ms,
                    ),
                    headers={"content-type": "text/event-stream; charset=utf-8"},
                )
            marker = _activation_marker(payload)
            return _stream_response(
                payload,
                "KeydexSkillE2E activated "
                f"{marker}; {_context_summary(context)} request_context_counts=1,1",
                delay_ms,
            )
        if "KeydexContextE2E" in user_message:
            return _stream_response(
                payload,
                f"KeydexContextE2E {_context_summary(context)}",
                delay_ms,
            )
        return _stream_response(
            payload,
            f"KeydexPlainE2E completed: {user_message[:1_000]}; {_context_summary(context)}",
            delay_ms,
        )

    return httpx.MockTransport(handler)


def _stream_response(payload: dict[str, Any], content: str, delay_ms: int) -> httpx.Response:
    return httpx.Response(
        200,
        stream=_DelayedSSEStream(
            [
                _sse_chunk(payload, {"content": content}),
                _sse_chunk(payload, {}, finish_reason="stop"),
                "data: [DONE]\n\n",
            ],
            delay_ms,
        ),
        headers={"content-type": "text/event-stream; charset=utf-8"},
    )


def _stream_tool_call_response(
    payload: dict[str, Any],
    *,
    name: str,
    args: dict[str, Any],
    call_id: str,
    delay_ms: int,
) -> httpx.Response:
    return httpx.Response(
        200,
        stream=_DelayedSSEStream(
            [
                _sse_chunk(
                    payload,
                    {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": call_id,
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": json.dumps(
                                        args,
                                        ensure_ascii=False,
                                        separators=(",", ":"),
                                    ),
                                },
                            }
                        ]
                    },
                    finish_reason="tool_calls",
                ),
                "data: [DONE]\n\n",
            ],
            delay_ms,
        ),
        headers={"content-type": "text/event-stream; charset=utf-8"},
    )


def _sse_chunk(
    payload: dict[str, Any],
    delta: dict[str, Any],
    *,
    finish_reason: str | None = None,
) -> str:
    body = {
        "id": "chatcmpl-keydex-e2e",
        "object": "chat.completion.chunk",
        "created": 0,
        "model": str(payload.get("model") or E2E_MODEL_ID),
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if finish_reason is not None:
        body["usage"] = {
            "prompt_tokens": 1500,
            "completion_tokens": 100,
            "total_tokens": 1600,
        }
    return f"data: {json.dumps(body, ensure_ascii=False)}\n\n"


def _json_body(raw: bytes) -> dict[str, Any]:
    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _last_user_message(payload: dict[str, Any]) -> str:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return ""
    for message in reversed(messages):
        if isinstance(message, dict) and message.get("role") == "user":
            content = message.get("content")
            if isinstance(content, str):
                return content
    return ""


def _keydex_context(payload: dict[str, Any]) -> dict[str, Any]:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        messages = []
    contexts: list[tuple[int, dict[str, Any]]] = []
    real_users: list[tuple[int, str]] = []
    for index, message in enumerate(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if not isinstance(content, str):
            continue
        parsed = _parse_keydex_context_message(content)
        if parsed is None:
            real_users.append((index, content))
        else:
            contexts.append((index, parsed))
    documents: list[dict[str, str]] = []
    for _index, context in contexts:
        raw_documents = context.get("documents")
        if not isinstance(raw_documents, list):
            continue
        for document in raw_documents:
            if not isinstance(document, dict):
                continue
            scope = document.get("scope")
            locator = document.get("locator")
            content = document.get("content")
            if all(isinstance(value, str) for value in (scope, locator, content)):
                documents.append({"scope": scope, "locator": locator, "content": content})
    latest_user_index, latest_user = real_users[-1] if real_users else (-1, "")
    return {
        "context_count": len(contexts),
        "documents": documents,
        "last_user": latest_user,
        "context_role": "user" if contexts else "none",
        "context_before_last_user": bool(contexts)
        and all(index < latest_user_index for index, _context in contexts),
    }


def _parse_keydex_context_message(content: str) -> dict[str, Any] | None:
    header = "<keydex-instructions>"
    footer = "</keydex-instructions>"
    if not content.startswith(header) or not content.rstrip().endswith(footer):
        return None
    body = content[len(header) : content.rfind(footer)]
    heading_pattern = re.compile(
        r"^## (?P<locator>system:keydex\.md|workspace:\.keydex/keydex\.md)"
        r"（(?P<label>用户的全局指导|当前项目指导)）\r?$",
        re.MULTILINE,
    )
    matches = list(heading_pattern.finditer(body))
    if not matches:
        return None
    source_contract = {
        "system:keydex.md": ("system", "用户的全局指导"),
        "workspace:.keydex/keydex.md": ("workspace", "当前项目指导"),
    }
    documents: list[dict[str, str]] = []
    seen_locators: set[str] = set()
    for index, match in enumerate(matches):
        locator = match.group("locator")
        scope, expected_label = source_contract[locator]
        if match.group("label") != expected_label or locator in seen_locators:
            return None
        seen_locators.add(locator)
        content_end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
        document_content = body[match.end() : content_end].strip("\r\n")
        documents.append(
            {
                "scope": scope,
                "locator": locator,
                "content": document_content,
            }
        )
    return {"version": 2, "documents": documents}


def _context_summary(context: dict[str, Any]) -> str:
    documents = context.get("documents")
    if not isinstance(documents, list):
        documents = []
    scopes = [str(document.get("scope") or "") for document in documents]
    markers = [str(document.get("content") or "").replace("\n", "\\n") for document in documents]
    return " ".join(
        (
            f"context_count={int(context.get('context_count') or 0)}",
            f"documents={len(documents)}",
            f"scopes={','.join(scopes) or 'none'}",
            f"order={'>'.join(scopes) or 'none'}",
            f"markers={'|'.join(markers) or 'none'}",
            f"workspace_present={'true' if 'workspace' in scopes else 'false'}",
            f"last_user={context.get('last_user') or ''}",
            f"context_role={context.get('context_role') or 'none'}",
            "context_before_conversation="
            f"{'true' if context.get('context_before_last_user') else 'false'}",
        )
    )


def _has_tool_message(payload: dict[str, Any]) -> bool:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return False
    last_user = max(
        (
            index
            for index, message in enumerate(messages)
            if isinstance(message, dict) and message.get("role") == "user"
        ),
        default=-1,
    )
    return any(
        isinstance(message, dict) and message.get("role") == "tool"
        for message in messages[last_user + 1 :]
    )


def _tool_message_count(payload: dict[str, Any]) -> int:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return 0
    return sum(
        1
        for message in messages
        if isinstance(message, dict) and message.get("role") == "tool"
    )


def _tool_name_count(payload: dict[str, Any], name: str) -> int:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return 0
    count = 0
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in calls:
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            call_name = function.get("name") if isinstance(function, dict) else call.get("name")
            if call_name == name:
                count += 1
    return count


def _role_message_count(payload: dict[str, Any], role: str) -> int:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return 0
    return sum(
        1
        for message in messages
        if isinstance(message, dict) and message.get("role") == role
    )


def _scenario_markers(payload: dict[str, Any]) -> list[str]:
    serialized = json.dumps(payload.get("messages") or [], ensure_ascii=False)
    return [marker for marker in _COMPRESSION_SCENARIO_MARKERS if marker in serialized]


def _compact_summary_count(payload: dict[str, Any]) -> int:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return 0
    return sum(
        1
        for message in messages
        if isinstance(message, dict)
        and (
            "<keydex_context_compression>" in str(message.get("content") or "")
            or "当前任务从一次上下文压缩后的状态继续。"
            in str(message.get("content") or "")
        )
    )


def _payload_tool_names(payload: dict[str, Any]) -> list[str]:
    tools = payload.get("tools")
    if not isinstance(tools, list):
        return []
    names: list[str] = []
    for item in tools:
        if not isinstance(item, dict):
            continue
        function = item.get("function")
        name = item.get("name")
        if not isinstance(name, str) and isinstance(function, dict):
            name = function.get("name")
        if isinstance(name, str) and name:
            names.append(name)
    return names


def _skill_request(message: str) -> tuple[str, str]:
    parts = message.strip().split()
    marker_index = next(
        (
            parts.index(marker)
            for marker in ("KeydexSkillE2E", "KeydexAutoSkillE2E")
            if marker in parts
        ),
        -1,
    )
    if marker_index < 0:
        return "system-demo", "system"
    skill_name = parts[marker_index + 1] if len(parts) > marker_index + 1 else "system-demo"
    source = parts[marker_index + 2] if len(parts) > marker_index + 2 else "system"
    return skill_name, source


def _activation_marker(payload: dict[str, Any]) -> str:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        messages = []
    last_user = max(
        (
            index
            for index, message in enumerate(messages)
            if isinstance(message, dict) and message.get("role") == "user"
        ),
        default=-1,
    )
    serialized = json.dumps(messages[last_user + 1 :], ensure_ascii=False)
    if "# Keydex 产品使用指南" in serialized:
        return "BUILTIN-KEYDEX-GUIDE"
    for marker in (
        "WORKSPACE-REPAIRED",
        "WORKSPACE-SHARED-V2",
        "WORKSPACE-SHARED-V1",
        "SYSTEM-SHARED-V1",
        "WORKSPACE-V2",
        "WORKSPACE-V1",
        "SYSTEM-V2",
        "SYSTEM-V1",
        "SYSTEM-DEMO",
    ):
        if marker in serialized:
            return marker
    return "UNKNOWN"


def _seed_model(app: Any) -> None:
    now = to_iso_z(utc_now())
    provider = ModelProviderRecord(
        id="keydex-e2e-provider",
        name="Keydex E2E Provider",
        base_url="http://model.test/v1",
        api_key="keydex-e2e-key",
        enabled=True,
        models=[E2E_MODEL_ID],
        model_enabled={E2E_MODEL_ID: True},
        health={},
        created_at=now,
        updated_at=now,
    )
    app.state.repositories.model_providers.upsert(provider)
    app.state.repositories.model_providers.set_model_default(
        scope=MODEL_DEFAULT_CHAT,
        provider_id=provider.id,
        model=E2E_MODEL_ID,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--workspace-root", type=Path, required=True)
    parser.add_argument("--system-root", type=Path, required=True)
    parser.add_argument("--stream-delay-ms", type=int, default=180)
    args = parser.parse_args()

    settings = AppSettings(
        host="127.0.0.1",
        port=args.port,
        data_dir=args.data_dir,
        workspace_root=args.workspace_root,
        reload=False,
        log_level="WARNING",
        file_history_enabled=False,
        mcp_enabled=False,
        e2e_model_transport=True,
        e2e_stream_delay_ms=args.stream_delay_ms,
    )
    app = create_app(settings, keydex_system_root_for_testing=args.system_root)
    app.state.keydex_workspace_watcher._poll_interval_seconds = 0.05
    app.state.keydex_workspace_watcher._debounce_seconds = 0.02
    observations: list[dict[str, Any]] = []
    scenario_counts: dict[str, int] = {}

    async def model_observations() -> dict[str, Any]:
        return {"observations": list(observations)}

    async def compression_state(session_id: str) -> dict[str, Any]:
        checkpoint = app.state.checkpointer.get_tuple(
            {"configurable": {"thread_id": session_id, "checkpoint_ns": ""}}
        )
        values = (
            checkpoint.checkpoint.get("channel_values", {})
            if checkpoint is not None and isinstance(checkpoint.checkpoint, dict)
            else {}
        )
        messages = list(values.get("messages") or []) if isinstance(values, dict) else []
        raw_groups = (
            list(values.get("structured_user_message_groups") or [])
            if isinstance(values, dict)
            else []
        )
        groups = [
            {
                "group_id": str(group.get("group_id") or ""),
                "completeness": str(group.get("completeness") or ""),
                "member_kinds": [
                    str(member.get("member_kind") or "")
                    for member in list(group.get("members") or [])
                    if isinstance(member, dict)
                ],
            }
            for group in raw_groups
            if isinstance(group, dict)
        ]
        runtime_attachment_kinds = []
        runtime_attachments = []
        checkpoint_messages = []
        for message in messages:
            dialogue_metadata = getattr(message, "additional_kwargs", {}).get(
                "keydex_recent_dialogue"
            )
            checkpoint_messages.append(
                {
                    "id": str(getattr(message, "id", "") or ""),
                    "role": str(getattr(message, "type", "") or ""),
                    "content": str(getattr(message, "content", "") or "")[:12_000],
                    "tool_call_count": len(getattr(message, "tool_calls", None) or []),
                    "recent_dialogue_kind": (
                        str(dialogue_metadata.get("kind") or "")
                        if isinstance(dialogue_metadata, dict)
                        else ""
                    ),
                }
            )
            metadata = getattr(message, "additional_kwargs", {}).get(
                COMPACT_RUNTIME_ATTACHMENT_METADATA_KEY
            )
            if isinstance(metadata, dict) and metadata.get("kind"):
                runtime_attachment_kinds.append(str(metadata["kind"]))
                runtime_attachments.append(
                    {
                        "kind": str(metadata["kind"]),
                        "content": str(getattr(message, "content", "") or ""),
                    }
                )
        session = app.state.repositories.sessions.get(session_id)
        compression_events = [
            {
                "action": event.action,
                "data": event.data,
            }
            for event in app.state.repositories.message_events.list_by_session(session_id)
            if event.data.get("middleware") == "ContextCompressionMiddleware"
        ]
        return {
            "checkpoint_id": (
                checkpoint.config.get("configurable", {}).get("checkpoint_id")
                if checkpoint is not None
                else None
            ),
            "message_count": len(messages),
            "summary_count": sum(
                is_context_compression_summary_message(message) for message in messages
            ),
            "structured_groups": groups,
            "diagnostics": (
                dict(values.get("context_compression_diagnostics") or {})
                if isinstance(values, dict)
                else {}
            ),
            "runtime_attachment_kinds": runtime_attachment_kinds,
            "runtime_attachments": runtime_attachments,
            "checkpoint_messages": checkpoint_messages,
            "context_compression_epoch": (
                int(session.context_compression_epoch) if session is not None else 0
            ),
            "compression_events": compression_events,
        }

    async def compression_scenario_counts() -> dict[str, Any]:
        return {"counts": dict(scenario_counts)}

    async def expand_structured_group(
        session_id: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        checkpoint = app.state.checkpointer.get_tuple(
            {"configurable": {"thread_id": session_id, "checkpoint_ns": ""}}
        )
        if checkpoint is None:
            raise ValueError("checkpoint not found")
        values = checkpoint.checkpoint.get("channel_values", {})
        raw_groups = list(values.get("structured_user_message_groups") or [])
        index = int(payload.get("index", 0))
        extra_chars = max(int(payload.get("extra_chars", 0)), 0)
        if index < 0 or index >= len(raw_groups):
            raise ValueError("structured group index out of range")
        group = StructuredUserMessageGroup.from_dict(raw_groups[index])
        root_payload = dict(group.root_user_message.payload)
        root_payload["content"] = f"{root_payload.get('content') or ''} {'x' * extra_chars}"
        expanded = StructuredUserMessageGroup.create(
            group_id=group.group_id,
            root_user_message=build_structured_user_message_member(
                "root_user_message",
                group.root_user_message.member_order,
                root_payload,
                source_id=group.root_user_message.source_id,
            ),
            members=group.members,
            completeness=group.completeness,
            incomplete_reasons=group.incomplete_reasons,
            source_session_id=group.source_session_id,
            trace_id=group.trace_id,
            turn_index=group.turn_index,
            message_event_id=group.message_event_id,
        )
        raw_groups[index] = expanded.to_dict()
        messages = list(values.get("messages") or [])
        root_message_id = str(root_payload.get("message_id") or "")
        message_expanded = False
        for message_index, message in enumerate(messages):
            if str(getattr(message, "id", "") or "") != root_message_id:
                continue
            messages[message_index] = message.model_copy(
                update={"content": root_payload["content"]}
            )
            message_expanded = True
            break
        if payload.get("message_mode") == "latest_human" and not message_expanded:
            for message_index in range(len(messages) - 1, -1, -1):
                message = messages[message_index]
                if not isinstance(message, HumanMessage):
                    continue
                messages[message_index] = message.model_copy(
                    update={"content": root_payload["content"]}
                )
                message_expanded = True
                break
        configurable = checkpoint.config.get("configurable", {})
        app.state.checkpointer.replace_checkpoint_state(
            thread_id=session_id,
            checkpoint_id=str(configurable.get("checkpoint_id") or ""),
            checkpoint_ns=str(configurable.get("checkpoint_ns") or ""),
            channel_values={
                "messages": messages,
                "structured_user_message_groups": raw_groups,
            },
        )
        return {
            "group_id": expanded.group_id,
            "extra_chars": extra_chars,
            "group_count": len(raw_groups),
            "message_expanded": message_expanded,
        }

    app.add_api_route(
        "/api/e2e/model-observations",
        model_observations,
        methods=["GET"],
    )
    app.add_api_route(
        "/api/e2e/compression-state/{session_id}",
        compression_state,
        methods=["GET"],
    )
    app.add_api_route(
        "/api/e2e/compression-scenario-counts",
        compression_scenario_counts,
        methods=["GET"],
    )
    app.add_api_route(
        "/api/e2e/expand-structured-group/{session_id}",
        expand_structured_group,
        methods=["POST"],
    )
    app.state.model_http_transport = _keydex_e2e_transport(
        args.stream_delay_ms,
        observations,
        scenario_counts,
    )
    _seed_model(app)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
