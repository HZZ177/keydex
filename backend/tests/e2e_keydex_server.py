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

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backend.app.core.config import AppSettings
from backend.app.core.time import to_iso_z, utc_now
from backend.app.main import create_app
from backend.app.model.e2e_transport import E2E_MODEL_ID
from backend.app.storage import MODEL_DEFAULT_CHAT, ModelProviderRecord


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
        if observations is not None:
            observations.append(
                {
                    "last_user": user_message,
                    "context_summary": _context_summary(context),
                    "has_tool_message": _has_tool_message(payload),
                }
            )
        if payload.get("stream") is False:
            return httpx.Response(
                200,
                json={"choices": [{"message": {"role": "assistant", "content": "Keydex E2E"}}]},
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
            f"KeydexPlainE2E completed: {user_message}; {_context_summary(context)}",
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

    async def model_observations() -> dict[str, Any]:
        return {"observations": list(observations)}

    app.add_api_route(
        "/api/e2e/model-observations",
        model_observations,
        methods=["GET"],
    )
    app.state.model_http_transport = _keydex_e2e_transport(
        args.stream_delay_ms,
        observations,
    )
    _seed_model(app)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
