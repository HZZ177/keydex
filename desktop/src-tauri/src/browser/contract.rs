use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::config::{BROWSER_BRIDGE_MAX_MESSAGE_BYTES, BROWSER_HOST_SCHEMA_VERSION};

pub(crate) const BROWSER_EVENT_TOPIC: &str = "keydex://browser-event";
const MAX_ID_LENGTH: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BrowserContractError {
    InvalidJson,
    Oversize,
    InvalidFields,
    UnsupportedVersion,
    UnsupportedKind,
    InvalidValue(&'static str),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserSurfaceRef {
    pub(crate) panel_id: String,
    pub(crate) surface_id: String,
    pub(crate) generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserLogicalRect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserViewportSize {
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserProfileMode {
    Persistent,
    Incognito,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateSurfaceInput {
    pub(crate) panel_id: String,
    pub(crate) generation: u64,
    pub(crate) profile_mode: BrowserProfileMode,
    pub(crate) initial_url: String,
    pub(crate) theme: BrowserAppearanceTheme,
    pub(crate) background_color: BrowserRgbaColor,
}

macro_rules! surface_input {
    ($name:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
        #[serde(rename_all = "camelCase")]
        pub(crate) struct $name {
            #[serde(flatten)]
            pub(crate) surface: BrowserSurfaceRef,
            $(pub(crate) $field: $ty,)*
        }
    };
}

surface_input!(SetVisibilityInput {
    visible: bool,
    reason: BrowserVisibilityReason
});
surface_input!(NavigateInput {
    navigation_id: String,
    url: String
});
surface_input!(ReloadInput {
    mode: BrowserReloadMode
});
surface_input!(SetZoomInput { factor: f64 });
surface_input!(SetResourceStateInput {
    state: BrowserResourceState,
    reason: String
});
surface_input!(FindInput {
    query: String,
    match_case: bool,
    backwards: bool
});
surface_input!(RespondPermissionInput {
    permission_request_id: String,
    origin: String,
    decision: BrowserPermissionDecision
});
surface_input!(RespondDownloadInput {
    download_id: String,
    decision: BrowserDownloadDecision,
    target_path: Option<String>
});
surface_input!(ControlDownloadInput {
    download_id: String,
    action: BrowserDownloadControlAction
});
surface_input!(StartSelectionInput {
    selection_request_id: String,
    mode: BrowserSelectionMode
});
surface_input!(ConfigureAppearanceInput {
    theme: BrowserAppearanceTheme,
    background_color: BrowserRgbaColor,
    tokens: BrowserOverlayTokens,
    radius_px: f64,
    motion_ms: f64,
    reduced_motion: bool
});
surface_input!(ResolveAnnotationsInput {
    resolve_request_id: String,
    targets: Vec<BrowserResolveTarget>
});
surface_input!(RenderHighlightsInput {
    resolutions: Vec<BrowserHighlightResolution>
});
surface_input!(ClearHighlightsInput {
    annotation_ids: Vec<String>
});
surface_input!(NavigateAnnotationTargetInput {
    annotation_id: String,
    target: serde_json::Value
});
surface_input!(CaptureRegionInput {
    capture_request_id: String,
    rect: BrowserLogicalRect,
    viewport: BrowserViewportSize
});
surface_input!(DiscardCaptureInput {
    capture_request_id: String
});
surface_input!(TakeIncognitoCaptureInput {
    capture_request_id: String,
    asset_id: String
});

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserVisibilityReason {
    Active,
    InactiveTab,
    SidebarClosed,
    WindowHidden,
    Occluded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserReloadMode {
    Normal,
    IgnoreCache,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserPermissionDecision {
    AllowOnce,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserDownloadDecision {
    Accept,
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserDownloadControlAction {
    Pause,
    Resume,
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserSelectionMode {
    Text,
    Element,
    Region,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserAppearanceTheme {
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserRgbaColor {
    pub(crate) red: u8,
    pub(crate) green: u8,
    pub(crate) blue: u8,
    pub(crate) alpha: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserOverlayTokens {
    pub(crate) accent: String,
    pub(crate) surface: String,
    pub(crate) text: String,
    pub(crate) border: String,
    pub(crate) focus: String,
    pub(crate) warning: String,
    pub(crate) danger: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserResolveTarget {
    pub(crate) annotation_id: String,
    pub(crate) target: serde_json::Value,
    pub(crate) binding: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserHighlightResolution {
    pub(crate) annotation_id: String,
    pub(crate) target: serde_json::Value,
    pub(crate) state: BrowserHighlightState,
    pub(crate) body_markdown: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserHighlightState {
    Resolved,
    Changed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClearProfileDataInput {
    pub(crate) profile_mode: BrowserProfileMode,
    pub(crate) kinds: Vec<BrowserProfileDataKind>,
    pub(crate) time_range: BrowserTimeRange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserProfileDataKind {
    Cookies,
    Cache,
    Storage,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserTimeRange {
    All,
    LastHour,
    LastDay,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "command", content = "payload")]
pub(crate) enum BrowserCommand {
    #[serde(rename = "browser_create_surface")]
    CreateSurface(CreateSurfaceInput),
    #[serde(rename = "browser_destroy_surface")]
    DestroySurface(BrowserSurfaceRef),
    #[serde(rename = "browser_set_visibility")]
    SetVisibility(SetVisibilityInput),
    #[serde(rename = "browser_navigate")]
    Navigate(NavigateInput),
    #[serde(rename = "browser_go_back")]
    GoBack(BrowserSurfaceRef),
    #[serde(rename = "browser_go_forward")]
    GoForward(BrowserSurfaceRef),
    #[serde(rename = "browser_reload")]
    Reload(ReloadInput),
    #[serde(rename = "browser_stop")]
    Stop(BrowserSurfaceRef),
    #[serde(rename = "browser_set_zoom")]
    SetZoom(SetZoomInput),
    #[serde(rename = "browser_set_resource_state")]
    SetResourceState(SetResourceStateInput),
    #[serde(rename = "browser_find")]
    Find(FindInput),
    #[serde(rename = "browser_stop_find")]
    StopFind(BrowserSurfaceRef),
    #[serde(rename = "browser_respond_permission")]
    RespondPermission(RespondPermissionInput),
    #[serde(rename = "browser_respond_download")]
    RespondDownload(RespondDownloadInput),
    #[serde(rename = "browser_control_download")]
    ControlDownload(ControlDownloadInput),
    #[serde(rename = "browser_start_selection")]
    StartSelection(StartSelectionInput),
    #[serde(rename = "browser_configure_appearance")]
    ConfigureAppearance(ConfigureAppearanceInput),
    #[serde(rename = "browser_cancel_selection")]
    CancelSelection(BrowserSurfaceRef),
    #[serde(rename = "browser_resolve_annotations")]
    ResolveAnnotations(ResolveAnnotationsInput),
    #[serde(rename = "browser_render_highlights")]
    RenderHighlights(RenderHighlightsInput),
    #[serde(rename = "browser_clear_highlights")]
    ClearHighlights(ClearHighlightsInput),
    #[serde(rename = "browser_navigate_to_annotation_target")]
    NavigateToAnnotationTarget(NavigateAnnotationTargetInput),
    #[serde(rename = "browser_capture_region")]
    CaptureRegion(CaptureRegionInput),
    #[serde(rename = "browser_discard_capture")]
    DiscardCapture(DiscardCaptureInput),
    #[serde(rename = "browser_clear_profile_data")]
    ClearProfileData(ClearProfileDataInput),
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct BrowserCommandEnvelope {
    pub(crate) schema_version: u16,
    pub(crate) request_id: String,
    pub(crate) command: BrowserCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserCommandErrorCode {
    InvalidRequest,
    UnauthorizedCaller,
    SurfaceNotFound,
    StaleGeneration,
    UnsupportedOperation,
    PolicyDenied,
    ResourceLimit,
    HostFailure,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserCommandError {
    pub(crate) code: BrowserCommandErrorCode,
    pub(crate) message: String,
    pub(crate) retryable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserCommandResponse {
    pub(crate) ok: bool,
    pub(crate) request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<BrowserCommandError>,
}

impl BrowserCommandResponse {
    pub(crate) fn validate(&self) -> Result<(), BrowserContractError> {
        validate_id(&self.request_id, "requestId")?;
        if self.ok == self.error.is_some() {
            return Err(BrowserContractError::InvalidValue("response error"));
        }
        if let Some(error) = &self.error {
            if error.message.is_empty() || error.message.len() > 1_024 {
                return Err(BrowserContractError::InvalidValue("error.message"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", content = "payload")]
pub(crate) enum BrowserEvent {
    #[serde(rename = "surface.ready")]
    SurfaceReady(SurfaceReadyPayload),
    #[serde(rename = "surface.destroyed")]
    SurfaceDestroyed(ReasonPayload),
    #[serde(rename = "navigation.started")]
    NavigationStarted(NavigationPayload),
    #[serde(rename = "navigation.committed")]
    NavigationCommitted(NavigationPayload),
    #[serde(rename = "navigation.completed")]
    NavigationCompleted(NavigationPayload),
    #[serde(rename = "navigation.failed")]
    NavigationFailed(NavigationFailedPayload),
    #[serde(rename = "page.title")]
    PageTitle(PageTitlePayload),
    #[serde(rename = "page.favicon")]
    PageFavicon(PageFaviconPayload),
    #[serde(rename = "page.source")]
    PageSource(PageSourcePayload),
    #[serde(rename = "page.history")]
    PageHistory(PageHistoryPayload),
    #[serde(rename = "page.loading")]
    PageLoading(PageLoadingPayload),
    #[serde(rename = "shortcut.requested")]
    ShortcutRequested(ShortcutRequestedPayload),
    #[serde(rename = "new_window.requested")]
    NewWindowRequested(NewWindowPayload),
    #[serde(rename = "external_protocol.requested")]
    ExternalProtocolRequested(ExternalProtocolPayload),
    #[serde(rename = "permission.requested")]
    PermissionRequested(PermissionRequestedPayload),
    #[serde(rename = "permission.expired")]
    PermissionExpired(PermissionExpiredPayload),
    #[serde(rename = "download.requested")]
    DownloadRequested(DownloadRequestedPayload),
    #[serde(rename = "download.started")]
    DownloadStarted(DownloadStartedPayload),
    #[serde(rename = "download.progress")]
    DownloadProgress(DownloadProgressPayload),
    #[serde(rename = "download.interrupted")]
    DownloadInterrupted(DownloadInterruptedPayload),
    #[serde(rename = "download.resumed")]
    DownloadResumed(DownloadResumedPayload),
    #[serde(rename = "download.completed")]
    DownloadCompleted(DownloadCompletedPayload),
    #[serde(rename = "download.failed")]
    DownloadFailed(DownloadFailedPayload),
    #[serde(rename = "capture.completed")]
    CaptureCompleted(CaptureCompletedPayload),
    #[serde(rename = "capture.failed")]
    CaptureFailed(CaptureFailedPayload),
    #[serde(rename = "selection.result")]
    SelectionResult(SelectionResultPayload),
    #[serde(rename = "selection.cancelled")]
    SelectionCancelled(SelectionCancelledPayload),
    #[serde(rename = "selection.failed")]
    SelectionFailed(SelectionFailedPayload),
    #[serde(rename = "process.failed")]
    ProcessFailed(ProcessFailedPayload),
    #[serde(rename = "process.recovered")]
    ProcessRecovered(ProcessRecoveredPayload),
    #[serde(rename = "bridge.message")]
    BridgeMessage(BridgeMessagePayload),
    #[serde(rename = "bridge.error")]
    BridgeError(BridgeErrorPayload),
    #[serde(rename = "resource.state_changed")]
    ResourceStateChanged(ResourceStatePayload),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SurfaceReadyPayload {
    pub(crate) profile_mode: BrowserProfileMode,
    pub(crate) capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReasonPayload {
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NavigationPayload {
    pub(crate) url: String,
    pub(crate) is_main_frame: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NavigationFailedPayload {
    pub(crate) url: String,
    pub(crate) is_main_frame: bool,
    pub(crate) error_category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageTitlePayload {
    pub(crate) title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageFaviconPayload {
    pub(crate) favicon_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageSourcePayload {
    pub(crate) url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageHistoryPayload {
    pub(crate) can_go_back: bool,
    pub(crate) can_go_forward: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PageLoadingPayload {
    pub(crate) loading: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserShortcut {
    FocusAddress,
    Reload,
    ClosePanel,
    Find,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShortcutRequestedPayload {
    pub(crate) shortcut: BrowserShortcut,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserNewWindowDisposition {
    Tab,
    Window,
    Popup,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NewWindowPayload {
    pub(crate) url: String,
    pub(crate) user_gesture: bool,
    pub(crate) disposition: BrowserNewWindowDisposition,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExternalProtocolPayload {
    pub(crate) scheme: String,
    pub(crate) target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PermissionRequestedPayload {
    pub(crate) permission_request_id: String,
    pub(crate) origin: String,
    pub(crate) permission: String,
    pub(crate) deadline: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PermissionExpiredPayload {
    pub(crate) permission_request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadRequestedPayload {
    pub(crate) download_id: String,
    pub(crate) url: String,
    pub(crate) suggested_filename: String,
    pub(crate) total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadStartedPayload {
    pub(crate) download_id: String,
    pub(crate) file_path: String,
    pub(crate) filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadProgressPayload {
    pub(crate) download_id: String,
    pub(crate) received_bytes: u64,
    pub(crate) total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadInterruptedPayload {
    pub(crate) download_id: String,
    pub(crate) error_category: String,
    pub(crate) can_resume: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadResumedPayload {
    pub(crate) download_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadCompletedPayload {
    pub(crate) download_id: String,
    pub(crate) file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DownloadFailedPayload {
    pub(crate) download_id: String,
    pub(crate) error_category: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserCaptureAssetKind {
    Staged,
    ManagedTemp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserCaptureAssetPayload {
    pub(crate) asset_id: String,
    pub(crate) kind: BrowserCaptureAssetKind,
    pub(crate) mime_type: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
    pub(crate) perceptual_hash: String,
    pub(crate) expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CaptureCompletedPayload {
    pub(crate) capture_request_id: String,
    pub(crate) asset: BrowserCaptureAssetPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CaptureFailedPayload {
    pub(crate) capture_request_id: String,
    pub(crate) error_category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectionResultPayload {
    pub(crate) selection_request_id: String,
    pub(crate) frame_key: String,
    pub(crate) target: Value,
    pub(crate) binding: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectionCancelledPayload {
    pub(crate) selection_request_id: String,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SelectionFailedPayload {
    pub(crate) selection_request_id: String,
    pub(crate) error_category: String,
    pub(crate) message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserProcessScope {
    Renderer,
    Browser,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessFailedPayload {
    pub(crate) scope: BrowserProcessScope,
    pub(crate) reason_category: String,
    pub(crate) crash_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessRecoveredPayload {
    pub(crate) scope: BrowserProcessScope,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BridgeMessagePayload {
    pub(crate) bridge_envelope: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BridgeErrorPayload {
    pub(crate) code: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserResourceState {
    Visible,
    Warm,
    NativeSuspended,
    Discarded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResourceStatePayload {
    pub(crate) prior: BrowserResourceState,
    pub(crate) next: BrowserResourceState,
    pub(crate) reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BrowserEventEnvelope {
    pub(crate) schema_version: u16,
    pub(crate) panel_id: String,
    pub(crate) surface_id: String,
    pub(crate) generation: u64,
    pub(crate) sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) navigation_id: Option<String>,
    pub(crate) occurred_at: String,
    #[serde(flatten)]
    pub(crate) event: BrowserEvent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BrowserEventCursor {
    pub(crate) panel_id: String,
    pub(crate) surface_id: String,
    pub(crate) generation: u64,
    pub(crate) last_sequence: u64,
}

impl BrowserEventEnvelope {
    pub(crate) fn belongs_to(&self, cursor: &BrowserEventCursor) -> bool {
        self.panel_id == cursor.panel_id
            && self.surface_id == cursor.surface_id
            && self.generation == cursor.generation
            && self.sequence > cursor.last_sequence
    }
}

pub(crate) fn parse_browser_command_envelope(
    input: &str,
) -> Result<BrowserCommandEnvelope, BrowserContractError> {
    let value = parse_sized_json(input)?;
    let object = exact_object(
        &value,
        &["schemaVersion", "requestId", "command", "payload"],
        &[],
    )?;
    let schema_version = read_version(object)?;
    let request_id = read_string(object, "requestId")?;
    validate_id(&request_id, "requestId")?;
    let command_kind = read_string(object, "command")?;
    let payload = object
        .get("payload")
        .ok_or(BrowserContractError::InvalidFields)?;
    validate_command_payload_keys(&command_kind, payload)?;
    let command: BrowserCommand = serde_json::from_value(json!({
        "command": command_kind,
        "payload": payload,
    }))
    .map_err(|_| BrowserContractError::InvalidValue("command payload"))?;
    validate_command(&command)?;
    Ok(BrowserCommandEnvelope {
        schema_version,
        request_id,
        command,
    })
}

pub(crate) fn parse_browser_event_envelope(
    input: &str,
) -> Result<BrowserEventEnvelope, BrowserContractError> {
    let value = parse_sized_json(input)?;
    let object = exact_object(
        &value,
        &[
            "schemaVersion",
            "kind",
            "panelId",
            "surfaceId",
            "generation",
            "sequence",
            "occurredAt",
            "payload",
        ],
        &["navigationId"],
    )?;
    let schema_version = read_version(object)?;
    let panel_id = read_string(object, "panelId")?;
    let surface_id = read_string(object, "surfaceId")?;
    validate_id(&panel_id, "panelId")?;
    validate_id(&surface_id, "surfaceId")?;
    let generation = read_positive_u64(object, "generation")?;
    let sequence = read_positive_u64(object, "sequence")?;
    let navigation_id = object
        .get("navigationId")
        .map(|_| read_string(object, "navigationId"))
        .transpose()?;
    if let Some(id) = &navigation_id {
        validate_id(id, "navigationId")?;
    }
    let occurred_at = read_string(object, "occurredAt")?;
    if occurred_at.is_empty() || occurred_at.len() > 64 {
        return Err(BrowserContractError::InvalidValue("occurredAt"));
    }
    let kind = read_string(object, "kind")?;
    let payload = object
        .get("payload")
        .ok_or(BrowserContractError::InvalidFields)?;
    validate_event_payload_keys(&kind, payload)?;
    let event: BrowserEvent = serde_json::from_value(json!({ "kind": kind, "payload": payload }))
        .map_err(|_| BrowserContractError::InvalidValue("event payload"))?;
    validate_event(&event)?;
    Ok(BrowserEventEnvelope {
        schema_version,
        panel_id,
        surface_id,
        generation,
        sequence,
        navigation_id,
        occurred_at,
        event,
    })
}

fn parse_sized_json(input: &str) -> Result<Value, BrowserContractError> {
    if input.len() > BROWSER_BRIDGE_MAX_MESSAGE_BYTES {
        return Err(BrowserContractError::Oversize);
    }
    serde_json::from_str(input).map_err(|_| BrowserContractError::InvalidJson)
}

fn read_version(object: &Map<String, Value>) -> Result<u16, BrowserContractError> {
    let version = object
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or(BrowserContractError::InvalidValue("schemaVersion"))?;
    if version != u64::from(BROWSER_HOST_SCHEMA_VERSION) {
        return Err(BrowserContractError::UnsupportedVersion);
    }
    Ok(version as u16)
}

fn exact_object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Map<String, Value>, BrowserContractError> {
    let object = value
        .as_object()
        .ok_or(BrowserContractError::InvalidFields)?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(BrowserContractError::InvalidFields);
    }
    Ok(object)
}

fn exact_payload(
    value: &Value,
    required: &[&str],
    optional: &[&str],
) -> Result<(), BrowserContractError> {
    exact_object(value, required, optional).map(|_| ())
}

fn read_string(
    object: &Map<String, Value>,
    key: &'static str,
) -> Result<String, BrowserContractError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or(BrowserContractError::InvalidValue(key))
}

fn read_positive_u64(
    object: &Map<String, Value>,
    key: &'static str,
) -> Result<u64, BrowserContractError> {
    match object.get(key).and_then(Value::as_u64) {
        Some(value) if value > 0 => Ok(value),
        _ => Err(BrowserContractError::InvalidValue(key)),
    }
}

fn validate_id(value: &str, field: &'static str) -> Result<(), BrowserContractError> {
    if value.is_empty() || value.len() > MAX_ID_LENGTH {
        Err(BrowserContractError::InvalidValue(field))
    } else {
        Ok(())
    }
}

fn validate_command_payload_keys(kind: &str, payload: &Value) -> Result<(), BrowserContractError> {
    let surface = ["panelId", "surfaceId", "generation"];
    let result = match kind {
        "browser_create_surface" => exact_payload(
            payload,
            &[
                "panelId",
                "generation",
                "profileMode",
                "initialUrl",
                "theme",
                "backgroundColor",
            ],
            &[],
        ),
        "browser_destroy_surface"
        | "browser_go_back"
        | "browser_go_forward"
        | "browser_stop"
        | "browser_stop_find"
        | "browser_cancel_selection" => exact_payload(payload, &surface, &[]),
        "browser_set_visibility" => exact_payload(
            payload,
            &["panelId", "surfaceId", "generation", "visible", "reason"],
            &[],
        ),
        "browser_navigate" => exact_payload(
            payload,
            &["panelId", "surfaceId", "generation", "navigationId", "url"],
            &[],
        ),
        "browser_reload" => exact_payload(
            payload,
            &["panelId", "surfaceId", "generation", "mode"],
            &[],
        ),
        "browser_set_zoom" => exact_payload(
            payload,
            &["panelId", "surfaceId", "generation", "factor"],
            &[],
        ),
        "browser_set_resource_state" => exact_payload(
            payload,
            &["panelId", "surfaceId", "generation", "state", "reason"],
            &[],
        ),
        "browser_find" => exact_payload(
            payload,
            &[
                "panelId",
                "surfaceId",
                "generation",
                "query",
                "matchCase",
                "backwards",
            ],
            &[],
        ),
        "browser_respond_permission" => exact_payload(
            payload,
            &[
                "panelId",
                "surfaceId",
                "generation",
                "permissionRequestId",
                "origin",
                "decision",
            ],
            &[],
        ),
        "browser_respond_download" => exact_payload(
            payload,
            &[
                "panelId",
                "surfaceId",
                "generation",
                "downloadId",
                "decision",
            ],
            &["targetPath"],
        ),
        "browser_control_download" => exact_payload(
            payload,
            &["panelId", "surfaceId", "generation", "downloadId", "action"],
            &[],
        ),
        "browser_start_selection" => exact_payload(
            payload,
            &[
                "panelId",
                "surfaceId",
                "generation",
                "selectionRequestId",
                "mode",
            ],
            &[],
        ),
        "browser_configure_appearance" => exact_payload(
            payload,
            &[
                "panelId",
                "surfaceId",
                "generation",
                "theme",
                "backgroundColor",
                "tokens",
                "radiusPx",
                "motionMs",
                "reducedMotion",
            ],
            &[],
        ),
        "browser_resolve_annotations" => exact_payload(
            payload,
            &[
                "panelId",
                "surfaceId",
                "generation",
                "resolveRequestId",
                "targets",
            ],
            &[],
        ),
        "browser_render_highlights" => exact_payload(
            payload,
            &["panelId", "surfaceId", "generation", "resolutions"],
            &[],
        ),
        "browser_clear_highlights" => exact_payload(
            payload,
            &["panelId", "surfaceId", "generation", "annotationIds"],
            &[],
        ),
        "browser_navigate_to_annotation_target" => exact_payload(
            payload,
            &[
                "panelId",
                "surfaceId",
                "generation",
                "annotationId",
                "target",
            ],
            &[],
        ),
        "browser_capture_region" => exact_payload(
            payload,
            &[
                "panelId",
                "surfaceId",
                "generation",
                "captureRequestId",
                "rect",
                "viewport",
            ],
            &[],
        ),
        "browser_discard_capture" => exact_payload(
            payload,
            &["panelId", "surfaceId", "generation", "captureRequestId"],
            &[],
        ),
        "browser_clear_profile_data" => {
            exact_payload(payload, &["profileMode", "kinds", "timeRange"], &[])
        }
        _ => return Err(BrowserContractError::UnsupportedKind),
    };
    result
}

fn validate_event_payload_keys(kind: &str, payload: &Value) -> Result<(), BrowserContractError> {
    match kind {
        "surface.ready" => exact_payload(payload, &["profileMode", "capabilities"], &[]),
        "surface.destroyed" => exact_payload(payload, &["reason"], &[]),
        "navigation.started" | "navigation.committed" | "navigation.completed" => {
            exact_payload(payload, &["url", "isMainFrame"], &[])
        }
        "navigation.failed" => {
            exact_payload(payload, &["url", "isMainFrame", "errorCategory"], &[])
        }
        "page.title" => exact_payload(payload, &["title"], &[]),
        "page.favicon" => exact_payload(payload, &["faviconUrl"], &[]),
        "page.source" => exact_payload(payload, &["url"], &[]),
        "page.history" => exact_payload(payload, &["canGoBack", "canGoForward"], &[]),
        "page.loading" => exact_payload(payload, &["loading"], &[]),
        "shortcut.requested" => exact_payload(payload, &["shortcut"], &[]),
        "new_window.requested" => {
            exact_payload(payload, &["url", "userGesture", "disposition"], &[])
        }
        "external_protocol.requested" => exact_payload(payload, &["scheme", "target"], &[]),
        "permission.requested" => exact_payload(
            payload,
            &["permissionRequestId", "origin", "permission", "deadline"],
            &[],
        ),
        "permission.expired" => exact_payload(payload, &["permissionRequestId"], &[]),
        "download.requested" => exact_payload(
            payload,
            &["downloadId", "url", "suggestedFilename", "totalBytes"],
            &[],
        ),
        "download.started" => exact_payload(payload, &["downloadId", "filePath", "filename"], &[]),
        "download.progress" => {
            exact_payload(payload, &["downloadId", "receivedBytes", "totalBytes"], &[])
        }
        "download.interrupted" => {
            exact_payload(payload, &["downloadId", "errorCategory", "canResume"], &[])
        }
        "download.resumed" => exact_payload(payload, &["downloadId"], &[]),
        "download.completed" => exact_payload(payload, &["downloadId", "filePath"], &[]),
        "download.failed" => exact_payload(payload, &["downloadId", "errorCategory"], &[]),
        "capture.completed" => exact_payload(payload, &["captureRequestId", "asset"], &[]),
        "capture.failed" => exact_payload(payload, &["captureRequestId", "errorCategory"], &[]),
        "selection.result" => exact_payload(
            payload,
            &["selectionRequestId", "frameKey", "target", "binding"],
            &[],
        ),
        "selection.cancelled" => exact_payload(payload, &["selectionRequestId", "reason"], &[]),
        "selection.failed" => exact_payload(
            payload,
            &["selectionRequestId", "errorCategory", "message"],
            &[],
        ),
        "process.failed" => exact_payload(payload, &["scope", "reasonCategory", "crashCount"], &[]),
        "process.recovered" => exact_payload(payload, &["scope"], &[]),
        "bridge.message" => exact_payload(payload, &["bridgeEnvelope"], &[]),
        "bridge.error" => exact_payload(payload, &["code"], &[]),
        "resource.state_changed" => exact_payload(payload, &["prior", "next", "reason"], &[]),
        _ => Err(BrowserContractError::UnsupportedKind),
    }
}

fn validate_surface(surface: &BrowserSurfaceRef) -> Result<(), BrowserContractError> {
    validate_id(&surface.panel_id, "panelId")?;
    validate_id(&surface.surface_id, "surfaceId")?;
    if surface.generation == 0 {
        return Err(BrowserContractError::InvalidValue("generation"));
    }
    Ok(())
}

fn validate_command(command: &BrowserCommand) -> Result<(), BrowserContractError> {
    match command {
        BrowserCommand::CreateSurface(input) => {
            validate_id(&input.panel_id, "panelId")?;
            if input.generation == 0 || input.initial_url.is_empty() {
                return Err(BrowserContractError::InvalidValue("create surface"));
            }
        }
        BrowserCommand::DestroySurface(surface)
        | BrowserCommand::GoBack(surface)
        | BrowserCommand::GoForward(surface)
        | BrowserCommand::Stop(surface)
        | BrowserCommand::StopFind(surface)
        | BrowserCommand::CancelSelection(surface) => validate_surface(surface)?,
        BrowserCommand::SetVisibility(input) => validate_surface(&input.surface)?,
        BrowserCommand::Navigate(input) => {
            validate_surface(&input.surface)?;
            validate_id(&input.navigation_id, "navigationId")?;
            if input.url.is_empty() {
                return Err(BrowserContractError::InvalidValue("url"));
            }
        }
        BrowserCommand::Reload(input) => validate_surface(&input.surface)?,
        BrowserCommand::SetZoom(input) => {
            validate_surface(&input.surface)?;
            if !input.factor.is_finite() || !(0.5..=3.0).contains(&input.factor) {
                return Err(BrowserContractError::InvalidValue("factor"));
            }
        }
        BrowserCommand::SetResourceState(input) => {
            validate_surface(&input.surface)?;
            if input.reason.is_empty() || input.reason.len() > 128 {
                return Err(BrowserContractError::InvalidValue("resource reason"));
            }
            if input.state == BrowserResourceState::Discarded {
                return Err(BrowserContractError::InvalidValue("resource state"));
            }
        }
        BrowserCommand::Find(input) => {
            validate_surface(&input.surface)?;
            if input.query.len() > 16_384 {
                return Err(BrowserContractError::InvalidValue("query"));
            }
        }
        BrowserCommand::RespondPermission(input) => {
            validate_surface(&input.surface)?;
            validate_id(&input.permission_request_id, "permissionRequestId")?;
        }
        BrowserCommand::RespondDownload(input) => {
            validate_surface(&input.surface)?;
            validate_id(&input.download_id, "downloadId")?;
        }
        BrowserCommand::ControlDownload(input) => {
            validate_surface(&input.surface)?;
            validate_id(&input.download_id, "downloadId")?;
        }
        BrowserCommand::StartSelection(input) => {
            validate_surface(&input.surface)?;
            validate_id(&input.selection_request_id, "selectionRequestId")?;
        }
        BrowserCommand::ConfigureAppearance(input) => {
            validate_surface(&input.surface)?;
            if !input.radius_px.is_finite()
                || !(0.0..=32.0).contains(&input.radius_px)
                || !input.motion_ms.is_finite()
                || !(0.0..=2_000.0).contains(&input.motion_ms)
            {
                return Err(BrowserContractError::InvalidValue("overlay metrics"));
            }
            for color in [
                &input.tokens.accent,
                &input.tokens.surface,
                &input.tokens.text,
                &input.tokens.border,
                &input.tokens.focus,
                &input.tokens.warning,
                &input.tokens.danger,
            ] {
                if color.is_empty()
                    || color.len() > 128
                    || color
                        .chars()
                        .any(|character| matches!(character, ';' | '{' | '}' | '\'' | '"' | '\\'))
                    || color.to_ascii_lowercase().contains("url(")
                {
                    return Err(BrowserContractError::InvalidValue("overlay color"));
                }
            }
        }
        BrowserCommand::ResolveAnnotations(input) => {
            validate_surface(&input.surface)?;
            validate_id(&input.resolve_request_id, "resolveRequestId")?;
            if input.targets.is_empty() || input.targets.len() > 50 {
                return Err(BrowserContractError::InvalidValue("targets"));
            }
            for target in &input.targets {
                validate_id(&target.annotation_id, "annotationId")?;
                super::bridge::validate_web_annotation_target(&target.target)
                    .map_err(|_| BrowserContractError::InvalidValue("target"))?;
            }
        }
        BrowserCommand::RenderHighlights(input) => {
            validate_surface(&input.surface)?;
            if input.resolutions.len() > 50 {
                return Err(BrowserContractError::InvalidValue("resolutions"));
            }
            for resolution in &input.resolutions {
                validate_id(&resolution.annotation_id, "annotationId")?;
                super::bridge::validate_web_annotation_target(&resolution.target)
                    .map_err(|_| BrowserContractError::InvalidValue("target"))?;
            }
        }
        BrowserCommand::ClearHighlights(input) => {
            validate_surface(&input.surface)?;
            if input.annotation_ids.len() > 50 {
                return Err(BrowserContractError::InvalidValue("annotationIds"));
            }
            for annotation_id in &input.annotation_ids {
                validate_id(annotation_id, "annotationId")?;
            }
        }
        BrowserCommand::NavigateToAnnotationTarget(input) => {
            validate_surface(&input.surface)?;
            validate_id(&input.annotation_id, "annotationId")?;
            super::bridge::validate_web_annotation_target(&input.target)
                .map_err(|_| BrowserContractError::InvalidValue("target"))?;
        }
        BrowserCommand::CaptureRegion(input) => {
            validate_surface(&input.surface)?;
            validate_id(&input.capture_request_id, "captureRequestId")?;
            validate_capture_geometry(&input.rect, &input.viewport)?;
        }
        BrowserCommand::DiscardCapture(input) => {
            validate_surface(&input.surface)?;
            validate_id(&input.capture_request_id, "captureRequestId")?;
        }
        BrowserCommand::ClearProfileData(input) => {
            if input.kinds.len() > 3 {
                return Err(BrowserContractError::InvalidValue("kinds"));
            }
        }
    }
    Ok(())
}

fn validate_event(event: &BrowserEvent) -> Result<(), BrowserContractError> {
    match event {
        BrowserEvent::SurfaceReady(payload) if payload.capabilities.len() > 32 => {
            Err(BrowserContractError::InvalidValue("capabilities"))
        }
        BrowserEvent::PermissionRequested(payload) => {
            validate_id(&payload.permission_request_id, "permissionRequestId")
        }
        BrowserEvent::PermissionExpired(payload) => {
            validate_id(&payload.permission_request_id, "permissionRequestId")
        }
        BrowserEvent::DownloadRequested(payload) => validate_id(&payload.download_id, "downloadId"),
        BrowserEvent::DownloadStarted(payload) => {
            validate_id(&payload.download_id, "downloadId")?;
            if payload.file_path.trim().is_empty()
                || payload.file_path.len() > 4_096
                || payload.filename.trim().is_empty()
                || payload.filename.len() > 512
            {
                return Err(BrowserContractError::InvalidValue("download target"));
            }
            Ok(())
        }
        BrowserEvent::DownloadProgress(payload) => validate_id(&payload.download_id, "downloadId"),
        BrowserEvent::DownloadInterrupted(payload) => {
            validate_id(&payload.download_id, "downloadId")?;
            if payload.error_category.trim().is_empty() || payload.error_category.len() > 128 {
                return Err(BrowserContractError::InvalidValue("errorCategory"));
            }
            Ok(())
        }
        BrowserEvent::DownloadResumed(payload) => validate_id(&payload.download_id, "downloadId"),
        BrowserEvent::DownloadCompleted(payload) => {
            validate_id(&payload.download_id, "downloadId")?;
            if payload.file_path.trim().is_empty() || payload.file_path.len() > 4_096 {
                return Err(BrowserContractError::InvalidValue("filePath"));
            }
            Ok(())
        }
        BrowserEvent::DownloadFailed(payload) => validate_id(&payload.download_id, "downloadId"),
        BrowserEvent::CaptureCompleted(payload) => {
            validate_id(&payload.capture_request_id, "captureRequestId")?;
            validate_id(&payload.asset.asset_id, "assetId")?;
            if payload.asset.mime_type != "image/png"
                || payload.asset.width == 0
                || payload.asset.height == 0
                || payload.asset.byte_length == 0
                || payload.asset.sha256.len() != 64
                || !payload.asset.perceptual_hash.starts_with("dhash64:")
                || payload.asset.perceptual_hash.len() != 24
                || payload.asset.expires_at.is_empty()
            {
                return Err(BrowserContractError::InvalidValue("capture asset"));
            }
            Ok(())
        }
        BrowserEvent::CaptureFailed(payload) => {
            validate_id(&payload.capture_request_id, "captureRequestId")
        }
        BrowserEvent::SelectionResult(payload) => {
            validate_id(&payload.selection_request_id, "selectionRequestId")?;
            validate_id(&payload.frame_key, "frameKey")?;
            super::bridge::validate_web_annotation_target(&payload.target)
                .map_err(|_| BrowserContractError::InvalidValue("target"))
        }
        BrowserEvent::SelectionCancelled(payload) => {
            validate_id(&payload.selection_request_id, "selectionRequestId")?;
            if !matches!(
                payload.reason.as_str(),
                "user" | "navigation" | "surface_destroyed"
            ) {
                return Err(BrowserContractError::InvalidValue("selection reason"));
            }
            Ok(())
        }
        BrowserEvent::SelectionFailed(payload) => {
            validate_id(&payload.selection_request_id, "selectionRequestId")?;
            if payload.error_category.is_empty()
                || payload.error_category.len() > 128
                || payload.message.is_empty()
                || payload.message.len() > 512
            {
                return Err(BrowserContractError::InvalidValue("selection failure"));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_capture_geometry(
    rect: &BrowserLogicalRect,
    viewport: &BrowserViewportSize,
) -> Result<(), BrowserContractError> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || !viewport.width.is_finite()
        || !viewport.height.is_finite()
        || viewport.width <= 0.0
        || viewport.height <= 0.0
        || rect.x < 0.0
        || rect.y < 0.0
        || rect.width < 8.0
        || rect.height < 8.0
        || rect.width * rect.height < 256.0
        || rect.x + rect.width > viewport.width + 0.01
        || rect.y + rect.height > viewport.height + 0.01
    {
        return Err(BrowserContractError::InvalidValue("capture geometry"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHARED_FIXTURE: &str =
        include_str!("../../../../test-fixtures/sidebar-browser/contracts/browser-host-v1.json");

    fn fixture() -> Value {
        serde_json::from_str(SHARED_FIXTURE).unwrap()
    }

    #[test]
    fn shared_commands_events_and_responses_match_rust_contract() {
        let fixture = fixture();
        assert_eq!(fixture["schemaVersion"], BROWSER_HOST_SCHEMA_VERSION);

        for command in fixture["commands"].as_array().unwrap() {
            let parsed = parse_browser_command_envelope(&command.to_string()).unwrap();
            assert_eq!(parsed.schema_version, BROWSER_HOST_SCHEMA_VERSION);
            assert!(!parsed.request_id.is_empty());
        }
        for event in fixture["events"].as_array().unwrap() {
            let parsed = parse_browser_event_envelope(&event.to_string()).unwrap();
            assert_eq!(parsed.schema_version, BROWSER_HOST_SCHEMA_VERSION);
            assert!(parsed.sequence > 0);
            assert_eq!(serde_json::to_value(parsed).unwrap(), *event);
        }
        for response in fixture["responses"].as_array().unwrap() {
            let parsed: BrowserCommandResponse = serde_json::from_value(response.clone()).unwrap();
            parsed.validate().unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), *response);
        }
    }

    #[test]
    fn rejects_unknown_versions_kinds_extra_fields_and_oversize() {
        let fixture = fixture();
        let mut command = fixture["commands"][0].clone();
        command["schemaVersion"] = json!(2);
        assert_eq!(
            parse_browser_command_envelope(&command.to_string()),
            Err(BrowserContractError::UnsupportedVersion)
        );
        command["schemaVersion"] = json!(1);
        command["command"] = json!("browser_evaluate_javascript");
        assert_eq!(
            parse_browser_command_envelope(&command.to_string()),
            Err(BrowserContractError::UnsupportedKind)
        );

        let mut event = fixture["events"][0].clone();
        event["payload"]["agentAction"] = json!("click");
        assert_eq!(
            parse_browser_event_envelope(&event.to_string()),
            Err(BrowserContractError::InvalidFields)
        );

        let oversized = format!(
            "{{\"padding\":\"{}\"}}",
            "x".repeat(BROWSER_BRIDGE_MAX_MESSAGE_BYTES)
        );
        assert_eq!(
            parse_browser_event_envelope(&oversized),
            Err(BrowserContractError::Oversize)
        );

        let mut resolve = fixture["commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|command| command["command"] == "browser_resolve_annotations")
            .unwrap()
            .clone();
        resolve["payload"]["targets"][0]["target"]["outerHTML"] = json!("<button>secret</button>");
        assert_eq!(
            parse_browser_command_envelope(&resolve.to_string()),
            Err(BrowserContractError::InvalidValue("target"))
        );

        let mut highlight = fixture["commands"]
            .as_array()
            .unwrap()
            .iter()
            .find(|command| command["command"] == "browser_render_highlights")
            .unwrap()
            .clone();
        highlight["payload"]["resolutions"][0]["target"]["outerHTML"] =
            json!("<button>secret</button>");
        assert_eq!(
            parse_browser_command_envelope(&highlight.to_string()),
            Err(BrowserContractError::InvalidValue("target"))
        );
    }

    #[test]
    fn filters_stale_generation_and_out_of_order_sequence() {
        let event = parse_browser_event_envelope(&fixture()["events"][1].to_string()).unwrap();
        assert!(event.belongs_to(&BrowserEventCursor {
            panel_id: event.panel_id.clone(),
            surface_id: event.surface_id.clone(),
            generation: event.generation,
            last_sequence: event.sequence - 1,
        }));
        assert!(!event.belongs_to(&BrowserEventCursor {
            panel_id: event.panel_id.clone(),
            surface_id: event.surface_id.clone(),
            generation: event.generation + 1,
            last_sequence: 0,
        }));
        assert!(!event.belongs_to(&BrowserEventCursor {
            panel_id: event.panel_id.clone(),
            surface_id: event.surface_id.clone(),
            generation: event.generation,
            last_sequence: event.sequence,
        }));
    }
}
