use serde::Deserialize;

pub(crate) const BROWSER_CONFIG_SCHEMA_VERSION: u16 = 1;
pub(crate) const RIGHT_SIDEBAR_STATE_SCHEMA_VERSION: u16 = 2;
pub(crate) const BROWSER_HOST_SCHEMA_VERSION: u16 = 2;
pub(crate) const WEB_ANNOTATION_SCHEMA_VERSION: u16 = 1;
pub(crate) const WEB_ANNOTATION_BRIDGE_SCHEMA_VERSION: u16 = 1;

pub(crate) const MAX_BROWSER_PANEL_METADATA: u16 = 20;
pub(crate) const MAX_LIVE_BROWSER_SURFACES: u16 = 10;
pub(crate) const MAX_WARM_BROWSER_SURFACES: u16 = 5;
pub(crate) const BROWSER_PERMISSION_TIMEOUT_MS: u64 = 30_000;
pub(crate) const BROWSER_BRIDGE_MAX_MESSAGE_BYTES: usize = 256 * 1024;
pub(crate) const BROWSER_RESOLVE_BATCH_SIZE: u16 = 50;
pub(crate) const BROWSER_RESOLVE_MUTATION_DEBOUNCE_MS: u64 = 250;
pub(crate) const BROWSER_RESOLVE_MUTATION_MAX_DELAY_MS: u64 = 2_000;
pub(crate) const BROWSER_RESOLVE_SLICE_BUDGET_MS: u16 = 8;
pub(crate) const BROWSER_CRASH_LOOP_COUNT: u16 = 3;
pub(crate) const BROWSER_CRASH_LOOP_WINDOW_MS: u64 = 5 * 60_000;
pub(crate) const WEB_ANNOTATION_STAGED_ASSET_TTL_HOURS: u16 = 24;
pub(crate) const WEB_ANNOTATION_MAX_CONTEXT_ITEMS: u16 = 20;
pub(crate) const WEB_ANNOTATION_MAX_CONTEXT_BYTES: usize = 128 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BrowserFeatureFlags {
    pub(crate) browser_enabled: bool,
    pub(crate) annotations_enabled: bool,
    pub(crate) internal_probe_enabled: bool,
}

impl BrowserFeatureFlags {
    pub(crate) const fn release_defaults() -> Self {
        Self {
            browser_enabled: true,
            annotations_enabled: true,
            internal_probe_enabled: false,
        }
    }

    pub(crate) const fn build_defaults() -> Self {
        Self {
            browser_enabled: true,
            annotations_enabled: true,
            internal_probe_enabled: cfg!(debug_assertions),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserContractFixture {
    schema_version: u16,
    protocols: BrowserProtocolVersions,
    release_feature_flags: FixtureFeatureFlags,
    limits: BrowserContractLimits,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserProtocolVersions {
    right_sidebar_state: u16,
    browser_host: u16,
    web_annotation: u16,
    web_annotation_bridge: u16,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureFeatureFlags {
    browser_enabled: bool,
    annotations_enabled: bool,
    internal_probe_enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserContractLimits {
    max_panel_metadata: u16,
    max_live_surfaces: u16,
    max_warm_surfaces: u16,
    permission_timeout_ms: u64,
    bridge_max_message_bytes: usize,
    resolve_batch_size: u16,
    resolve_mutation_debounce_ms: u64,
    resolve_mutation_max_delay_ms: u64,
    resolve_slice_budget_ms: u16,
    crash_loop_count: u16,
    crash_loop_window_ms: u64,
    staged_asset_ttl_hours: u16,
    max_context_items: u16,
    max_context_bytes: usize,
}

fn validate_contract_fixture(fixture: &BrowserContractFixture) -> Result<(), &'static str> {
    if fixture.schema_version != BROWSER_CONFIG_SCHEMA_VERSION {
        return Err("browser contract fixture schema version is unsupported");
    }
    let protocols = &fixture.protocols;
    if protocols.right_sidebar_state != RIGHT_SIDEBAR_STATE_SCHEMA_VERSION
        || protocols.browser_host != BROWSER_HOST_SCHEMA_VERSION
        || protocols.web_annotation != WEB_ANNOTATION_SCHEMA_VERSION
        || protocols.web_annotation_bridge != WEB_ANNOTATION_BRIDGE_SCHEMA_VERSION
    {
        return Err("browser protocol versions do not match the runtime contract");
    }
    if fixture.release_feature_flags
        != (FixtureFeatureFlags {
            browser_enabled: true,
            annotations_enabled: true,
            internal_probe_enabled: false,
        })
    {
        return Err("browser release feature flags do not match the production defaults");
    }
    let limits = &fixture.limits;
    if limits.max_panel_metadata != MAX_BROWSER_PANEL_METADATA
        || limits.max_live_surfaces != MAX_LIVE_BROWSER_SURFACES
        || limits.max_warm_surfaces != MAX_WARM_BROWSER_SURFACES
        || limits.permission_timeout_ms != BROWSER_PERMISSION_TIMEOUT_MS
        || limits.bridge_max_message_bytes != BROWSER_BRIDGE_MAX_MESSAGE_BYTES
        || limits.resolve_batch_size != BROWSER_RESOLVE_BATCH_SIZE
        || limits.resolve_mutation_debounce_ms != BROWSER_RESOLVE_MUTATION_DEBOUNCE_MS
        || limits.resolve_mutation_max_delay_ms != BROWSER_RESOLVE_MUTATION_MAX_DELAY_MS
        || limits.resolve_slice_budget_ms != BROWSER_RESOLVE_SLICE_BUDGET_MS
        || limits.crash_loop_count != BROWSER_CRASH_LOOP_COUNT
        || limits.crash_loop_window_ms != BROWSER_CRASH_LOOP_WINDOW_MS
        || limits.staged_asset_ttl_hours != WEB_ANNOTATION_STAGED_ASSET_TTL_HOURS
        || limits.max_context_items != WEB_ANNOTATION_MAX_CONTEXT_ITEMS
        || limits.max_context_bytes != WEB_ANNOTATION_MAX_CONTEXT_BYTES
    {
        return Err("browser limits do not match the runtime contract");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHARED_FIXTURE: &str =
        include_str!("../../../../test-fixtures/sidebar-browser/contracts/browser-config-v1.json");

    #[test]
    fn shared_fixture_matches_rust_contract() {
        let fixture: BrowserContractFixture = serde_json::from_str(SHARED_FIXTURE).unwrap();
        validate_contract_fixture(&fixture).unwrap();
        assert!(BrowserFeatureFlags::build_defaults().internal_probe_enabled);
        assert_eq!(
            BrowserFeatureFlags::release_defaults(),
            BrowserFeatureFlags {
                browser_enabled: true,
                annotations_enabled: true,
                internal_probe_enabled: false,
            }
        );
    }

    #[test]
    fn unknown_version_and_extra_fields_are_rejected() {
        let unknown = SHARED_FIXTURE.replacen("\"schemaVersion\": 1", "\"schemaVersion\": 2", 1);
        let fixture: BrowserContractFixture = serde_json::from_str(&unknown).unwrap();
        assert_eq!(
            validate_contract_fixture(&fixture),
            Err("browser contract fixture schema version is unsupported")
        );

        let extra = SHARED_FIXTURE.replacen(
            "\"schemaVersion\": 1,",
            "\"schemaVersion\": 1, \"agentBrowserEnabled\": true,",
            1,
        );
        assert!(serde_json::from_str::<BrowserContractFixture>(&extra).is_err());
    }
}
