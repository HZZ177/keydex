from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from backend.app.core.logger import REDACTED, redact_sensitive
from backend.app.tools.base import _summarize_tool_args
from backend.app.web.config import (
    WebProviderConfigField,
    WebSecretState,
    WebSecretUpdate,
    apply_secret_updates,
    describe_secret_states,
    redact_configured_secrets,
)
from backend.app.web.errors import WebProviderError, web_error_from_exception


def _fields() -> tuple[WebProviderConfigField, ...]:
    return (
        WebProviderConfigField(
            key="api_key",
            field_type="secret",
            label="API Key",
            required=True,
        ),
        WebProviderConfigField(
            key="client_secret",
            field_type="secret",
            label="Client Secret",
        ),
        WebProviderConfigField(key="region", field_type="text", label="Region"),
    )


def test_secret_updates_set_keep_replace_and_clear() -> None:
    first = apply_secret_updates(
        _fields(),
        current={},
        updates={
            "api_key": WebSecretUpdate(action="set", value=" first-secret "),
            "client_secret": WebSecretUpdate(action="set", value="client-one"),
        },
    )
    kept = apply_secret_updates(
        _fields(),
        current=first,
        updates={"api_key": WebSecretUpdate(action="keep")},
    )
    replaced = apply_secret_updates(
        _fields(),
        current=kept,
        updates={"api_key": WebSecretUpdate(action="set", value="second-secret")},
    )
    cleared = apply_secret_updates(
        _fields(),
        current=replaced,
        updates={"client_secret": WebSecretUpdate(action="clear")},
    )

    assert first == {"api_key": "first-secret", "client_secret": "client-one"}
    assert kept == first
    assert replaced["api_key"] == "second-secret"
    assert cleared == {"api_key": "second-secret"}


@pytest.mark.parametrize(
    ("action", "value"),
    [("set", None), ("set", "  "), ("keep", "secret"), ("clear", "secret")],
)
def test_secret_update_rejects_invalid_action_value_pairs(action: str, value: str | None) -> None:
    with pytest.raises(ValidationError):
        WebSecretUpdate(action=action, value=value)


def test_secret_updates_reject_unknown_or_non_secret_fields() -> None:
    with pytest.raises(WebProviderError) as caught:
        apply_secret_updates(
            _fields(),
            current={},
            updates={"region": WebSecretUpdate(action="set", value="not-secret")},
        )

    assert caught.value.code == "invalid_request"


def test_secret_states_only_return_configured_and_masked_preview() -> None:
    raw = "raw-sensitive-api-key"
    states = describe_secret_states(_fields(), {"api_key": raw})

    assert states == {
        "api_key": WebSecretState(configured=True, preview="raw-...-key"),
        "client_secret": WebSecretState(configured=False, preview=None),
    }
    serialized = json.dumps(
        {key: state.model_dump() for key, state in states.items()},
        ensure_ascii=False,
    )
    assert raw not in serialized


def test_secret_values_are_redacted_from_nested_diagnostics_and_exceptions() -> None:
    raw = "diagnostic-secret-value"
    nested = {
        "message": f"request failed for {raw}",
        "items": [{"custom": raw}],
        "api_key": raw,
    }

    redacted = redact_configured_secrets(nested, {"api_key": raw})
    payload = web_error_from_exception(RuntimeError(str(redacted)), sensitive_values=(raw,))
    serialized = json.dumps(payload.to_log_dict(), ensure_ascii=False)

    assert raw not in serialized
    assert REDACTED in serialized


def test_tool_arg_logging_redacts_provider_specific_secret_key_names() -> None:
    raw = "tool-log-secret"
    summary = _summarize_tool_args(
        "web_search",
        {
            "query": "safe query",
            "tavily_api_key": raw,
            "client_secret": raw,
            "secret_ref_keys": ["api_key"],
        },
    )

    assert raw not in repr(summary)
    assert summary["tavily_api_key"] == REDACTED
    assert summary["client_secret"] == REDACTED
    assert summary["secret_ref_keys"] == {"type": "list", "items": 1}


def test_generic_logger_redaction_keeps_non_secret_metadata_visible() -> None:
    value = redact_sensitive(
        {
            "oauth_token": "raw-token",
            "provider_password": "raw-password",
            "secret_ref_keys": ["api_key"],
        }
    )

    assert value["oauth_token"] == REDACTED
    assert value["provider_password"] == REDACTED
    assert value["secret_ref_keys"] == ["api_key"]
