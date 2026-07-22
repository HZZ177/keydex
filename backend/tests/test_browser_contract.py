import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from backend.app.browser_contract import (
    BROWSER_CONFIG_SCHEMA_VERSION,
    BROWSER_HOST_SCHEMA_VERSION,
    RIGHT_SIDEBAR_STATE_SCHEMA_VERSION,
    WEB_ANNOTATION_BRIDGE_SCHEMA_VERSION,
    WEB_ANNOTATION_SCHEMA_VERSION,
    BrowserContractFixture,
    resolve_browser_feature_flags,
)

FIXTURE_PATH = (
    Path(__file__).resolve().parents[2]
    / "test-fixtures"
    / "sidebar-browser"
    / "contracts"
    / "browser-config-v1.json"
)


def _fixture() -> dict[str, object]:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def test_shared_browser_contract_matches_backend_versions_and_release_defaults() -> None:
    contract = BrowserContractFixture.model_validate(_fixture())

    assert contract.schema_version == BROWSER_CONFIG_SCHEMA_VERSION
    assert contract.protocols.right_sidebar_state == RIGHT_SIDEBAR_STATE_SCHEMA_VERSION
    assert contract.protocols.browser_host == BROWSER_HOST_SCHEMA_VERSION
    assert contract.protocols.web_annotation == WEB_ANNOTATION_SCHEMA_VERSION
    assert contract.protocols.web_annotation_bridge == WEB_ANNOTATION_BRIDGE_SCHEMA_VERSION
    assert contract.release_feature_flags.model_dump() == {
        "browser_enabled": True,
        "annotations_enabled": True,
        "internal_probe_enabled": False,
    }


def test_shared_browser_contract_rejects_unknown_version_and_extra_fields() -> None:
    unknown_version = {**_fixture(), "schemaVersion": 2}
    extra_field = {**_fixture(), "agentBrowserEnabled": True}

    with pytest.raises(ValidationError):
        BrowserContractFixture.model_validate(unknown_version)
    with pytest.raises(ValidationError):
        BrowserContractFixture.model_validate(extra_field)


def test_product_defaults_on_and_internal_probe_stays_out_of_production() -> None:
    assert resolve_browser_feature_flags("development").model_dump() == {
        "browser_enabled": True,
        "annotations_enabled": True,
        "internal_probe_enabled": True,
    }
    assert resolve_browser_feature_flags("production").model_dump() == {
        "browser_enabled": True,
        "annotations_enabled": True,
        "internal_probe_enabled": False,
    }


def test_annotations_cannot_be_enabled_without_browser() -> None:
    flags = resolve_browser_feature_flags(
        "production",
        {
            "KEYDEX_BROWSER_ENABLED": "0",
            "KEYDEX_BROWSER_ANNOTATIONS_ENABLED": "1",
        },
    )

    assert flags.annotations_enabled is False
