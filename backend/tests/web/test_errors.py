import json

import pytest

from backend.app.core.logger import REDACTED
from backend.app.web.errors import (
    WebErrorCode,
    WebProviderError,
    sanitize_web_diagnostic,
    web_error,
    web_error_from_exception,
)


def test_every_error_code_has_a_safe_default_message() -> None:
    payloads = [web_error(code) for code in WebErrorCode]

    assert len(payloads) == 14
    assert all(payload.message for payload in payloads)
    assert all("Tavily" not in payload.message for payload in payloads)


@pytest.mark.parametrize(
    ("code", "retryable"),
    [
        (WebErrorCode.RATE_LIMITED, True),
        (WebErrorCode.REQUEST_TIMEOUT, True),
        (WebErrorCode.NETWORK_UNAVAILABLE, True),
        (WebErrorCode.PROVIDER_UNAVAILABLE, True),
        (WebErrorCode.PARTIAL_FAILURE, True),
        (WebErrorCode.AUTHENTICATION_FAILED, False),
        (WebErrorCode.UNSAFE_URL, False),
    ],
)
def test_error_codes_have_stable_retry_semantics(
    code: WebErrorCode,
    retryable: bool,
) -> None:
    assert web_error(code).retryable is retryable


def test_public_error_includes_retry_after_but_excludes_diagnostic() -> None:
    payload = web_error(
        WebErrorCode.RATE_LIMITED,
        provider_id="provider-a",
        retry_after_seconds=12,
        diagnostic={"status": 429, "body": "provider-private"},
    )

    assert payload.to_public_dict() == {
        "schema_version": 1,
        "code": "rate_limited",
        "message": "搜索请求过于频繁，请稍后重试",
        "details": {
            "provider_id": "provider-a",
            "retry_after_seconds": 12,
        },
        "retryable": True,
    }
    assert payload.to_log_dict()["diagnostic"]["status"] == 429


def test_diagnostic_redacts_nested_keys_assignments_and_explicit_values() -> None:
    raw_secret = "test-sensitive-value"
    diagnostic = sanitize_web_diagnostic(
        {
            "headers": {"Authorization": f"Bearer {raw_secret}"},
            "message": f"api_key={raw_secret}; request failed",
            "nested": [f"token: {raw_secret}", raw_secret],
        },
        sensitive_values=(raw_secret,),
    )
    serialized = json.dumps(diagnostic, ensure_ascii=False)

    assert raw_secret not in serialized
    assert REDACTED in serialized
    assert diagnostic["headers"]["Authorization"] == REDACTED


def test_provider_error_exposes_only_public_payload() -> None:
    error = WebProviderError(
        web_error(
            WebErrorCode.RESPONSE_INVALID,
            provider_id="provider-a",
            diagnostic={"body": "private response"},
        )
    )

    assert error.code == "response_invalid"
    assert error.to_public_dict()["message"] == "搜索引擎返回了无法识别的结果"
    assert "diagnostic" not in error.to_public_dict()


def test_unknown_exception_maps_to_safe_provider_unavailable() -> None:
    payload = web_error_from_exception(
        RuntimeError("Authorization=Bearer test-sensitive-value"),
        provider_id="provider-a",
        sensitive_values=("test-sensitive-value",),
    )

    assert payload.code == "provider_unavailable"
    assert payload.retryable is True
    assert "test-sensitive-value" not in json.dumps(payload.to_log_dict())
