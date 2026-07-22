from __future__ import annotations

import json
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend.app.browser_contract import (
    MAX_BROWSER_PANEL_METADATA,
    RIGHT_SIDEBAR_STATE_SCHEMA_VERSION,
)

ScopeKind = Literal["session", "workspace", "global"]
PromotionSourceScopeKind = Literal["workspace", "global"]
PanelKind = Literal["files", "conversation", "review", "browser"]

MAX_SCOPE_STATE_BYTES = 1024 * 1024
MAX_PANEL_STATE_BYTES = 256 * 1024
_RUNTIME_ONLY_PANEL_KEYS = frozenset(
    {
        "webviewLabel",
        "nativeHandle",
        "loading",
        "canGoBack",
        "canGoForward",
        "frameId",
        "permissionRequest",
        "downloadProgress",
        "resolutionCache",
    }
)
_BROWSER_REQUIRED_KEYS = frozenset(
    {
        "id",
        "kind",
        "schemaVersion",
        "title",
        "restoreUrl",
        "restoreUrlSanitized",
        "profileMode",
        "zoomFactor",
        "createdAt",
        "lastActivatedAt",
    }
)
_BROWSER_OPTIONAL_KEYS = frozenset({"faviconUrl"})


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class RightSidebarScopeStateDocument(StrictModel):
    version: Literal[2]
    active_panel_id: str | None = Field(alias="activePanelId")
    panel_order: list[str] = Field(alias="panelOrder", max_length=MAX_BROWSER_PANEL_METADATA)
    panels: dict[str, dict[str, Any]]
    next_panel_seq: int = Field(alias="nextPanelSeq", ge=0)

    @field_validator("panel_order")
    @classmethod
    def validate_panel_order(cls, value: list[str]) -> list[str]:
        if any(not panel_id.strip() for panel_id in value):
            raise ValueError("panelOrder cannot contain empty panel ids")
        if len(set(value)) != len(value):
            raise ValueError("panelOrder cannot contain duplicate panel ids")
        return value

    @model_validator(mode="after")
    def validate_document(self) -> RightSidebarScopeStateDocument:
        if len(self.panels) > MAX_BROWSER_PANEL_METADATA:
            raise ValueError(f"panels cannot exceed {MAX_BROWSER_PANEL_METADATA} entries")
        if set(self.panel_order) != set(self.panels):
            raise ValueError("panelOrder must contain each persisted panel exactly once")
        if self.active_panel_id is not None and self.active_panel_id not in self.panels:
            raise ValueError("activePanelId must reference a persisted panel")
        for panel_id, panel in self.panels.items():
            _validate_panel(panel_id, panel)
        serialized = json.dumps(
            self.model_dump(by_alias=True),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        if len(serialized) > MAX_SCOPE_STATE_BYTES:
            raise ValueError(f"scope state cannot exceed {MAX_SCOPE_STATE_BYTES} bytes")
        return self


class RightSidebarScopePutRequest(StrictModel):
    schema_version: Literal[RIGHT_SIDEBAR_STATE_SCHEMA_VERSION]
    state: RightSidebarScopeStateDocument
    expected_revision: int = Field(ge=0)


class RightSidebarScopeRecord(StrictModel):
    id: str
    scope_kind: ScopeKind
    scope_id: str | None
    schema_version: Literal[RIGHT_SIDEBAR_STATE_SCHEMA_VERSION]
    state: RightSidebarScopeStateDocument
    revision: int = Field(ge=1)
    created_at: str
    updated_at: str


class RightSidebarPromotionRequest(StrictModel):
    source_scope_kind: PromotionSourceScopeKind
    source_scope_id: str | None = Field(default=None, max_length=255)
    source_revision: int = Field(ge=1)
    target_session_id: str = Field(min_length=1, max_length=255)

    @model_validator(mode="after")
    def validate_source_scope(self) -> RightSidebarPromotionRequest:
        if self.source_scope_kind == "workspace":
            if not (self.source_scope_id or "").strip():
                raise ValueError("workspace promotion requires source_scope_id")
        elif self.source_scope_id is not None:
            raise ValueError("global promotion cannot carry source_scope_id")
        return self


class RightSidebarPromotionResponse(StrictModel):
    source_scope_kind: PromotionSourceScopeKind
    source_scope_id: str | None
    source_revision: int = Field(ge=1)
    target_session_id: str
    target: RightSidebarScopeRecord
    panel_id_mapping: dict[str, str]
    idempotent_replay: bool = False


class RightSidebarErrorDetail(StrictModel):
    code: str
    message: str
    details: dict[str, Any] = Field(default_factory=dict)


def _validate_panel(panel_id: str, panel: dict[str, Any]) -> None:
    if not panel_id.strip() or panel.get("id") != panel_id:
        raise ValueError("panel map keys must match panel.id")
    if panel.get("kind") not in {"files", "conversation", "review", "browser"}:
        raise ValueError(f"panel {panel_id} has an unsupported kind")
    if panel.get("schemaVersion") != 1:
        raise ValueError(f"panel {panel_id} has an unsupported schemaVersion")
    runtime_keys = _RUNTIME_ONLY_PANEL_KEYS.intersection(panel)
    if runtime_keys:
        raise ValueError(f"panel {panel_id} contains runtime-only fields: {sorted(runtime_keys)}")
    panel_bytes = len(
        json.dumps(panel, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    )
    if panel_bytes > MAX_PANEL_STATE_BYTES:
        raise ValueError(f"panel {panel_id} cannot exceed {MAX_PANEL_STATE_BYTES} bytes")
    if panel["kind"] == "browser":
        _validate_browser_panel(panel_id, panel)


def _validate_browser_panel(panel_id: str, panel: dict[str, Any]) -> None:
    actual_keys = frozenset(panel)
    if not _BROWSER_REQUIRED_KEYS.issubset(actual_keys):
        raise ValueError(f"browser panel {panel_id} is missing persisted fields")
    if actual_keys - _BROWSER_REQUIRED_KEYS - _BROWSER_OPTIONAL_KEYS:
        raise ValueError(f"browser panel {panel_id} contains unknown persisted fields")
    if not isinstance(panel.get("title"), str) or len(panel["title"]) > 512:
        raise ValueError(f"browser panel {panel_id} title is invalid")
    restore_url = panel.get("restoreUrl")
    if not isinstance(restore_url, str) or len(restore_url.encode("utf-8")) > 8192:
        raise ValueError(f"browser panel {panel_id} restoreUrl is invalid")
    if restore_url != "about:blank" and urlsplit(restore_url).scheme not in {"http", "https"}:
        raise ValueError(f"browser panel {panel_id} restoreUrl protocol is forbidden")
    if not isinstance(panel.get("restoreUrlSanitized"), bool):
        raise ValueError(f"browser panel {panel_id} restoreUrlSanitized is invalid")
    if panel.get("profileMode") != "persistent":
        raise ValueError(f"browser panel {panel_id} profileMode is invalid")
    zoom_factor = panel.get("zoomFactor")
    if not isinstance(zoom_factor, (int, float)) or not 0.5 <= zoom_factor <= 3:
        raise ValueError(f"browser panel {panel_id} zoomFactor is invalid")
