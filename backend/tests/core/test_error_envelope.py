from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.core.errors import (
    MAX_ERROR_DETAIL_ITEMS,
    MAX_ERROR_DETAIL_STRING_LENGTH,
    ErrorEnvelope,
    error_envelope,
    sanitize_public_details,
)


def test_error_envelope_has_stable_public_defaults() -> None:
    payload = error_envelope("llm_bad_request", "模型请求参数无效").to_public_dict()

    assert payload == {
        "schema_version": 1,
        "code": "llm_bad_request",
        "message": "模型请求参数无效",
        "details": {},
        "retryable": False,
    }


def test_error_envelope_serializes_optional_status_and_details() -> None:
    payload = ErrorEnvelope(
        code="rate_limited",
        message="请求过于频繁",
        details={"provider": {"request_id": "req_123"}},
        retryable=True,
        status=429,
    ).to_public_dict()

    assert payload["status"] == 429
    assert payload["retryable"] is True
    assert payload["details"] == {"provider": {"request_id": "req_123"}}


@pytest.mark.parametrize(("code", "message"), [("", "message"), ("code", "   ")])
def test_error_envelope_rejects_blank_required_text(code: str, message: str) -> None:
    with pytest.raises(ValidationError):
        ErrorEnvelope(code=code, message=message)


def test_public_details_are_json_safe_bounded_and_cycle_safe() -> None:
    circular: dict[str, object] = {}
    circular["self"] = circular
    details = sanitize_public_details(
        {
            "set": {"b", "a"},
            "bytes": b"secret bytes",
            "cycle": circular,
            "items": list(range(MAX_ERROR_DETAIL_ITEMS + 3)),
            "long": "x" * (MAX_ERROR_DETAIL_STRING_LENGTH + 5),
        }
    )

    assert sorted(details["set"]) == ["a", "b"]
    assert details["bytes"] == "<bytes:12>"
    assert details["cycle"]["self"] == {"_circular": True}
    assert details["items"][-1] == {"_truncated_items": 3}
    assert details["long"].endswith("…[TRUNCATED:5]")


def test_public_details_redact_sensitive_keys_assignments_and_values() -> None:
    secret = "workspace-secret-value"
    details = error_envelope(
        "provider_failed",
        "供应商请求失败",
        details={
            "api_key": "sk-abcdefghijk",
            "nested": {
                "safe": f"Authorization: Bearer abc.def; reason={secret}",
                "token_hint": "visible",
            },
        },
        sensitive_values=(secret,),
    ).to_public_dict()["details"]

    rendered = str(details)
    assert secret not in rendered
    assert "abc.def" not in rendered
    assert "sk-abcdefghijk" not in rendered
    assert details["api_key"] == "***REDACTED***"
    assert details["nested"]["token_hint"] == "***REDACTED***"
