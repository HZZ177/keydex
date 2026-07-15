import pytest
from pydantic import ValidationError

from backend.app.web.config import (
    WebProviderConfigField,
    WebProviderFieldType,
    WebProviderSelectOption,
    validate_config_field_set,
    validate_provider_values,
)
from backend.app.web.errors import WebProviderError
from backend.app.web.providers.tavily import TavilyProvider


def _fields() -> tuple[WebProviderConfigField, ...]:
    return (
        WebProviderConfigField(
            key="api_key",
            field_type="secret",
            label="API Key",
            required=True,
        ),
        WebProviderConfigField(
            key="project_id",
            field_type="text",
            label="Project ID",
            required=True,
        ),
        WebProviderConfigField(
            key="region",
            field_type="select",
            label="Region",
            default="global",
            options=(
                WebProviderSelectOption(value="global", label="Global"),
                WebProviderSelectOption(value="cn", label="China"),
            ),
        ),
        WebProviderConfigField(
            key="safe_mode",
            field_type="boolean",
            label="Safe mode",
            default=True,
        ),
    )


def test_four_field_types_validate_and_apply_defaults() -> None:
    values = validate_provider_values(
        _fields(),
        config={"project_id": " project-a "},
        secrets={"api_key": " secret-value "},
    )

    assert values.config == {
        "project_id": "project-a",
        "region": "global",
        "safe_mode": True,
    }
    assert values.secrets == {"api_key": "secret-value"}


def test_required_secret_and_text_fields_are_enforced() -> None:
    with pytest.raises(WebProviderError) as caught:
        validate_provider_values(_fields(), config={}, secrets={})

    assert caught.value.code == "provider_not_configured"
    assert caught.value.payload.diagnostic["missing_fields"] == ["api_key", "project_id"]


def test_unknown_and_misplaced_fields_are_rejected() -> None:
    with pytest.raises(WebProviderError) as caught:
        validate_provider_values(
            _fields(),
            config={"api_key": "not-allowed", "unknown": "value"},
            secrets={"project_id": "wrong-place"},
        )

    assert caught.value.code == "invalid_request"


def test_select_and_boolean_values_are_strict() -> None:
    with pytest.raises(WebProviderError):
        validate_provider_values(
            _fields(),
            config={"project_id": "project-a", "region": "unknown"},
            secrets={"api_key": "secret"},
        )
    with pytest.raises(WebProviderError):
        validate_provider_values(
            _fields(),
            config={"project_id": "project-a", "safe_mode": "true"},
            secrets={"api_key": "secret"},
        )


def test_field_contract_rejects_invalid_options_and_defaults() -> None:
    with pytest.raises(ValidationError):
        WebProviderConfigField(key="region", field_type="select", label="Region")
    with pytest.raises(ValidationError):
        WebProviderConfigField(
            key="api_key",
            field_type="secret",
            label="API Key",
            default="unsafe-default",
        )
    with pytest.raises(ValidationError):
        WebProviderConfigField(
            key="enabled",
            field_type="boolean",
            label="Enabled",
            default="true",
        )


def test_field_set_rejects_duplicate_keys() -> None:
    field = WebProviderConfigField(key="project", field_type="text", label="Project")

    with pytest.raises(ValueError, match="不能重复"):
        validate_config_field_set((field, field))


def test_tavily_production_descriptor_only_exposes_api_key() -> None:
    fields = TavilyProvider.descriptor.config_fields

    assert len(fields) == 1
    assert fields[0].key == "api_key"
    assert fields[0].field_type == WebProviderFieldType.SECRET
    assert fields[0].required is True
