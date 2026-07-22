from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.right_sidebar.models import RightSidebarScopePutRequest


def _state(panel: dict | None = None) -> dict:
    resolved = panel or {
        "id": "browser-1",
        "kind": "browser",
        "schemaVersion": 1,
        "title": "Example",
        "restoreUrl": "https://example.com/path",
        "restoreUrlSanitized": True,
        "profileMode": "persistent",
        "zoomFactor": 1,
        "createdAt": "2026-07-21T00:00:00Z",
        "lastActivatedAt": "2026-07-21T00:00:00Z",
    }
    return {
        "version": 2,
        "activePanelId": resolved["id"],
        "panelOrder": [resolved["id"]],
        "panels": {resolved["id"]: resolved},
        "nextPanelSeq": 2,
    }


def _request(state: dict | None = None, **extra) -> dict:
    return {
        "schema_version": 2,
        "state": state or _state(),
        "expected_revision": 0,
        **extra,
    }


def test_scope_state_rejects_extra_request_and_runtime_fields() -> None:
    with pytest.raises(ValidationError):
        RightSidebarScopePutRequest.model_validate(_request(extra_field=True))

    panel = _state()["panels"]["browser-1"] | {"webviewLabel": "runtime-only"}
    with pytest.raises(ValidationError, match="runtime-only"):
        RightSidebarScopePutRequest.model_validate(_request(_state(panel)))


def test_scope_state_rejects_invalid_order_and_active_panel() -> None:
    missing_order = _state()
    missing_order["panelOrder"] = []
    with pytest.raises(ValidationError, match="panelOrder"):
        RightSidebarScopePutRequest.model_validate(_request(missing_order))

    missing_active = _state()
    missing_active["activePanelId"] = "browser-missing"
    with pytest.raises(ValidationError, match="activePanelId"):
        RightSidebarScopePutRequest.model_validate(_request(missing_active))


def test_scope_state_rejects_oversized_panels_and_too_many_panels() -> None:
    oversized_panel = {"id": "files-1", "kind": "files", "schemaVersion": 1, "blob": "x" * 300_000}
    with pytest.raises(ValidationError, match="cannot exceed"):
        RightSidebarScopePutRequest.model_validate(_request(_state(oversized_panel)))

    panels = {
        f"files-{index}": {"id": f"files-{index}", "kind": "files", "schemaVersion": 1}
        for index in range(21)
    }
    state = {
        "version": 2,
        "activePanelId": "files-0",
        "panelOrder": list(panels),
        "panels": panels,
        "nextPanelSeq": 22,
    }
    with pytest.raises(ValidationError):
        RightSidebarScopePutRequest.model_validate(_request(state))


def test_scope_state_rejects_forbidden_browser_restore_protocol() -> None:
    panel = _state()["panels"]["browser-1"] | {"restoreUrl": "file:///etc/passwd"}
    with pytest.raises(ValidationError, match="protocol is forbidden"):
        RightSidebarScopePutRequest.model_validate(_request(_state(panel)))


def test_scope_state_rejects_incognito_browser_persistence() -> None:
    panel = _state()["panels"]["browser-1"] | {"profileMode": "incognito"}
    with pytest.raises(ValidationError, match="profileMode is invalid"):
        RightSidebarScopePutRequest.model_validate(_request(_state(panel)))
