from __future__ import annotations

import argparse
import asyncio
import json
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


def _keydex_e2e_transport(delay_ms: int) -> httpx.MockTransport:
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
        if payload.get("stream") is False:
            return httpx.Response(
                200,
                json={"choices": [{"message": {"role": "assistant", "content": "Keydex E2E"}}]},
            )
        if "KeydexToolsE2E" in user_message:
            tools = ",".join(sorted(_payload_tool_names(payload)))
            return _stream_response(payload, f"KeydexToolsE2E available: {tools}", delay_ms)
        if "KeydexSkillE2E" in user_message:
            if not _has_tool_message(payload):
                skill_name, source = _skill_request(user_message)
                return httpx.Response(
                    200,
                    stream=_DelayedSSEStream(
                        [
                            _sse_chunk(payload, {"reasoning_content": "Keydex E2E activating selected skill."}),
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
                f"KeydexSkillE2E activated {marker}",
                delay_ms,
            )
        return _stream_response(payload, f"KeydexPlainE2E completed: {user_message}", delay_ms)

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
    try:
        marker_index = parts.index("KeydexSkillE2E")
    except ValueError:
        return "system-demo", "system"
    skill_name = parts[marker_index + 1] if len(parts) > marker_index + 1 else "system-demo"
    source = parts[marker_index + 2] if len(parts) > marker_index + 2 else "system"
    return skill_name, source


def _activation_marker(payload: dict[str, Any]) -> str:
    serialized = json.dumps(payload.get("messages", []), ensure_ascii=False)
    if "Keydex 产品使用手册" in serialized:
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
    app.state.model_http_transport = _keydex_e2e_transport(args.stream_delay_ms)
    _seed_model(app)
    uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning")


if __name__ == "__main__":
    main()
