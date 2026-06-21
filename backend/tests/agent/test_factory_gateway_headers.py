from __future__ import annotations

from backend.app.agent.factory import (
    PatchedChatOpenAI,
    get_llm_gateway_trace_id,
    pop_llm_gateway_trace_id,
)
from backend.app.core.request_context import reset_request_context, set_request_context


def test_patched_chat_openai_injects_turn_trace_as_gateway_thread_id() -> None:
    token = set_request_context(
        trace_id="trace_turn",
        session_id="ses_1",
        active_session_id="ses_1",
        user_id="local-user",
    )
    try:
        kwargs = PatchedChatOpenAI._inject_gateway_headers({}, "gateway_trace_run")
    finally:
        reset_request_context(token)

    assert kwargs["extra_headers"] == {
        "AH-Thread-Id": "trace_turn",
        "AH-Trace-Id": "gateway_trace_run",
    }


def test_patched_chat_openai_keeps_existing_gateway_trace_for_nested_calls() -> None:
    kwargs = {
        "extra_headers": {
            "AH-Trace-Id": "gateway_trace_outer",
            "X-Extra": "kept",
        }
    }

    gateway_trace_id = PatchedChatOpenAI._resolve_gateway_trace_id("run_nested", kwargs)
    resolved = PatchedChatOpenAI._inject_gateway_headers(dict(kwargs), gateway_trace_id)

    try:
        assert gateway_trace_id == "gateway_trace_outer"
        assert get_llm_gateway_trace_id("run_nested") == "gateway_trace_outer"
        assert resolved["extra_headers"]["AH-Trace-Id"] == "gateway_trace_outer"
        assert resolved["extra_headers"]["X-Extra"] == "kept"
    finally:
        pop_llm_gateway_trace_id("run_nested")
