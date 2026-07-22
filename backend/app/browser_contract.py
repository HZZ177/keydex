from __future__ import annotations

from collections.abc import Mapping
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

BROWSER_CONFIG_SCHEMA_VERSION = 1
RIGHT_SIDEBAR_STATE_SCHEMA_VERSION = 2
BROWSER_HOST_SCHEMA_VERSION = 1
WEB_ANNOTATION_SCHEMA_VERSION = 1
WEB_ANNOTATION_BRIDGE_SCHEMA_VERSION = 1

MAX_BROWSER_PANEL_METADATA = 20
MAX_LIVE_BROWSER_SURFACES = 10
MAX_WARM_BROWSER_SURFACES = 5
BROWSER_PERMISSION_TIMEOUT_MS = 30_000
BROWSER_BRIDGE_MAX_MESSAGE_BYTES = 256 * 1024
BROWSER_RESOLVE_BATCH_SIZE = 50
BROWSER_RESOLVE_MUTATION_DEBOUNCE_MS = 250
BROWSER_RESOLVE_MUTATION_MAX_DELAY_MS = 2_000
BROWSER_RESOLVE_SLICE_BUDGET_MS = 8
BROWSER_CRASH_LOOP_COUNT = 3
BROWSER_CRASH_LOOP_WINDOW_MS = 5 * 60_000
WEB_ANNOTATION_STAGED_ASSET_TTL_HOURS = 24
WEB_ANNOTATION_MAX_CONTEXT_ITEMS = 20
WEB_ANNOTATION_MAX_CONTEXT_BYTES = 128 * 1024


class _StrictContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)


class BrowserProtocolVersions(_StrictContractModel):
    right_sidebar_state: Literal[2] = Field(alias="rightSidebarState")
    browser_host: Literal[1] = Field(alias="browserHost")
    web_annotation: Literal[1] = Field(alias="webAnnotation")
    web_annotation_bridge: Literal[1] = Field(alias="webAnnotationBridge")


class BrowserFeatureFlags(_StrictContractModel):
    browser_enabled: bool = Field(alias="browserEnabled")
    annotations_enabled: bool = Field(alias="annotationsEnabled")
    internal_probe_enabled: bool = Field(alias="internalProbeEnabled")


class BrowserContractLimits(_StrictContractModel):
    max_panel_metadata: Literal[20] = Field(alias="maxPanelMetadata")
    max_live_surfaces: Literal[10] = Field(alias="maxLiveSurfaces")
    max_warm_surfaces: Literal[5] = Field(alias="maxWarmSurfaces")
    permission_timeout_ms: Literal[30000] = Field(alias="permissionTimeoutMs")
    bridge_max_message_bytes: Literal[262144] = Field(alias="bridgeMaxMessageBytes")
    resolve_batch_size: Literal[50] = Field(alias="resolveBatchSize")
    resolve_mutation_debounce_ms: Literal[250] = Field(alias="resolveMutationDebounceMs")
    resolve_mutation_max_delay_ms: Literal[2000] = Field(alias="resolveMutationMaxDelayMs")
    resolve_slice_budget_ms: Literal[8] = Field(alias="resolveSliceBudgetMs")
    crash_loop_count: Literal[3] = Field(alias="crashLoopCount")
    crash_loop_window_ms: Literal[300000] = Field(alias="crashLoopWindowMs")
    staged_asset_ttl_hours: Literal[24] = Field(alias="stagedAssetTtlHours")
    max_context_items: Literal[20] = Field(alias="maxContextItems")
    max_context_bytes: Literal[131072] = Field(alias="maxContextBytes")


class BrowserContractFixture(_StrictContractModel):
    schema_version: Literal[1] = Field(alias="schemaVersion")
    protocols: BrowserProtocolVersions
    release_feature_flags: BrowserFeatureFlags = Field(alias="releaseFeatureFlags")
    limits: BrowserContractLimits


def resolve_browser_feature_flags(
    mode: str,
    environment: Mapping[str, str] | None = None,
) -> BrowserFeatureFlags:
    values = environment or {}
    browser_enabled = _resolve_feature_flag(values.get("KEYDEX_BROWSER_ENABLED"), True)
    return BrowserFeatureFlags(
        browserEnabled=browser_enabled,
        annotationsEnabled=(
            browser_enabled
            and _resolve_feature_flag(
                values.get("KEYDEX_BROWSER_ANNOTATIONS_ENABLED"),
                True,
            )
        ),
        internalProbeEnabled=(
            mode != "production"
            and _resolve_feature_flag(values.get("KEYDEX_BROWSER_M0_PROBE_ENABLED"), True)
        ),
    )


def _resolve_feature_flag(value: str | None, fallback: bool) -> bool:
    if value == "1":
        return True
    if value == "0":
        return False
    return fallback
