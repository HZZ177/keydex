use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use tauri::{Emitter, Manager, Url, Webview};

use super::bridge::{
    attach_windows_web_message_broker, bridge_initialization_script, post_windows_bridge_envelope,
    validate_web_annotation_target, BrowserBridgeBroker,
};
use super::capture::{
    capture_webview_png, crop_png_to_css_rect, BrowserCaptureManager, TakenIncognitoCapture,
};
use super::commands::{
    attach_native_shortcuts, dispatch_native_find, dispatch_native_history,
    native_find_surface_key, set_native_zoom, stop_native_find, NativeHistoryAction,
};
use super::config::BROWSER_RESOLVE_BATCH_SIZE;
use super::contract::{
    BridgeErrorPayload, BridgeMessagePayload, BrowserCommandError, BrowserCommandErrorCode,
    BrowserCommandResponse, BrowserEvent, BrowserHighlightState, BrowserNewWindowDisposition,
    BrowserOverlayTheme, BrowserReloadMode, BrowserSelectionMode, BrowserSurfaceRef,
    BrowserVisibilityReason, CaptureCompletedPayload, CaptureFailedPayload, CaptureRegionInput,
    ClearHighlightsInput, ClearProfileDataInput, ConfigureOverlayInput, CreateSurfaceInput,
    DiscardCaptureInput, ExternalProtocolPayload, FindInput, NavigateAnnotationTargetInput,
    NavigateInput, NavigationFailedPayload, NavigationPayload, NewWindowPayload,
    PageHistoryPayload, PageLoadingPayload, PageSourcePayload, PageTitlePayload, ReasonPayload,
    ReloadInput, RenderHighlightsInput, ResolveAnnotationsInput, ResourceStatePayload,
    RespondDownloadInput, RespondPermissionInput, SelectionCancelledPayload,
    SelectionFailedPayload, SelectionResultPayload, SetResourceStateInput, SetVisibilityInput,
    SetZoomInput, StartSelectionInput, SurfaceReadyPayload, TakeIncognitoCaptureInput,
    BROWSER_EVENT_TOPIC,
};
use super::devtools_inspector::{
    attach_windows_devtools_inspector, cancel_native_element_selection,
    start_native_element_selection, BrowserDevToolsInspector, NativeInspectorEvent,
};
use super::downloads::{attach_download_manager, DownloadManager};
use super::failures::{attach_process_failure_observer, BrowserFailureCoordinator};
use super::geometry::{
    BrowserGeometryFrame, BrowserGeometryInput, BrowserInteractiveResizeEndInput,
    BrowserInteractiveResizeInput, NativeInteractiveResizeRequest, NativeInteractiveResizeSurface,
};
use super::navigation::{
    attach_windows_navigation_observers, is_confirmable_external_protocol, BrowserLifecycle,
    NativeNavigationEvent,
};
use super::permissions::{attach_permission_broker, PermissionBroker};
use super::profiles::{clear_profile_data, configure_profile_security, BrowserProfileManager};
use super::resources::{apply_native_resource_state, BrowserResourceRegistry};
use super::security::ensure_main_webview_caller;
use super::surface::{BeginCreate, DestroySurface, SurfaceHandle, SurfaceTable};
use super::ui_actor::{BrowserUiActorHandle, NativeBrowserSurface};

const MAIN_WEBVIEW_LABEL: &str = "main";
const BROWSER_LINK_POLICY_SCRIPT: &str = include_str!("page_link_policy.js");

#[derive(Clone)]
pub(crate) struct BrowserHostState {
    surfaces: Arc<Mutex<SurfaceTable<NativeBrowserSurface>>>,
    actor: Arc<Mutex<Option<BrowserUiActorHandle>>>,
    bridge: BrowserBridgeBroker,
    lifecycle: BrowserLifecycle,
    profiles: BrowserProfileManager,
    permissions: PermissionBroker,
    downloads: DownloadManager,
    resources: BrowserResourceRegistry,
    failures: BrowserFailureCoordinator,
    captures: BrowserCaptureManager,
    inspector: BrowserDevToolsInspector,
    closing: Arc<AtomicBool>,
}

impl Default for BrowserHostState {
    fn default() -> Self {
        Self {
            surfaces: Arc::new(Mutex::new(SurfaceTable::default())),
            actor: Arc::new(Mutex::new(None)),
            bridge: BrowserBridgeBroker::default(),
            lifecycle: BrowserLifecycle::default(),
            profiles: BrowserProfileManager::default(),
            permissions: PermissionBroker::default(),
            downloads: DownloadManager::default(),
            resources: BrowserResourceRegistry::default(),
            failures: BrowserFailureCoordinator::default(),
            captures: BrowserCaptureManager::default(),
            inspector: BrowserDevToolsInspector::default(),
            closing: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[tauri::command]
pub(crate) async fn browser_create_surface(
    caller: Webview,
    request_id: String,
    payload: CreateSurfaceInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    if state.closing.load(Ordering::SeqCst) {
        return failure(
            request_id,
            error(
                BrowserCommandErrorCode::HostFailure,
                "BrowserHost is shutting down",
                false,
            ),
        );
    }
    if payload.panel_id.is_empty() || payload.generation == 0 {
        return invalid_request(request_id, "panelId and generation are required");
    }
    let initial_url = match parse_browser_url(&payload.initial_url, true) {
        Ok(url) => url,
        Err(error) => return failure(request_id, error),
    };

    let reservation = {
        let Ok(mut surfaces) = state.surfaces.lock() else {
            return host_failure(request_id, "BrowserHost surface table is unavailable");
        };
        surfaces.begin_create(&payload.panel_id, payload.generation)
    };
    let (identity, replaced) = match reservation {
        BeginCreate::Existing(_) => return success(request_id),
        BeginCreate::Stale(_) => return stale_generation(request_id),
        BeginCreate::Reserved { identity, replaced } => (identity, replaced),
    };
    if let Some(surface) = replaced {
        let _ = surface.destroy();
    }

    let profile_directory = match caller.path().app_data_dir() {
        Ok(app_data_dir) => match state.profiles.reserve_surface(
            &debug_managed_root("KEYDEX_BROWSER_PROFILE_ROOT", &app_data_dir),
            &std::env::temp_dir(),
            identity.reference.clone(),
            payload.profile_mode,
        ) {
            Ok(path) => path,
            Err(reason) => {
                abort_surface(&state, &identity);
                return host_failure(request_id, &reason);
            }
        },
        Err(reason) => {
            abort_surface(&state, &identity);
            return host_failure(
                request_id,
                &format!("Failed to resolve browser profile directory: {reason}"),
            );
        }
    };

    state
        .lifecycle
        .reserve(identity.reference.clone(), payload.profile_mode);
    let bootstrap_navigation_id = format!("bootstrap-{}", identity.reference.generation);
    state
        .bridge
        .register_surface(identity.reference.clone(), bootstrap_navigation_id.clone());

    let actor = match native_actor_for(&state, &caller) {
        Ok(actor) => actor,
        Err(reason) => {
            abort_surface(&state, &identity);
            return host_failure(request_id, &reason);
        }
    };
    let surface = match actor.create_surface(
        identity.reference.surface_id.clone(),
        identity.reference.generation,
        profile_directory,
        "about:blank".to_string(),
    ) {
        Ok(surface) => surface,
        Err(reason) => {
            abort_surface(&state, &identity);
            return host_failure(
                request_id,
                &format!("Failed to create windowed WebView2 surface: {reason}"),
            );
        }
    };

    let document_script = bridge_initialization_script(&identity.reference);
    if let Err(reason) = surface.run(move |surface| {
        surface.install_document_script(BROWSER_LINK_POLICY_SCRIPT.to_string())?;
        surface.install_document_script(document_script)
    }) {
        let _ = surface.destroy();
        abort_surface(&state, &identity);
        return host_failure(
            request_id,
            &format!("Failed to install browser page bridge: {reason}"),
        );
    }

    let app_emitter = caller.app_handle().clone();
    let bridge_route_state = state.clone();
    let bridge_route_surface = identity.reference.clone();
    let bridge_route_emitter = app_emitter.clone();
    let bridge_route = Arc::new(move |result| {
        emit_bridge_result(
            &bridge_route_emitter,
            &bridge_route_state,
            &bridge_route_surface,
            result,
        )
    });
    if let Err(reason) =
        attach_windows_web_message_broker(&surface, state.bridge.clone(), bridge_route)
    {
        let _ = surface.destroy();
        abort_surface(&state, &identity);
        return host_failure(
            request_id,
            &format!("Failed to attach WebView2 bridge broker: {reason}"),
        );
    }

    let inspector_state = state.clone();
    let inspector_surface = identity.reference.clone();
    let inspector_emitter = app_emitter.clone();
    if let Err(reason) = attach_windows_devtools_inspector(
        &surface,
        state.inspector.clone(),
        identity.reference.clone(),
        Arc::new(move |event| {
            let event = match event {
                NativeInspectorEvent::Selected {
                    selection_request_id,
                    frame_key,
                    target,
                } => BrowserEvent::SelectionResult(SelectionResultPayload {
                    selection_request_id,
                    frame_key,
                    target,
                }),
                NativeInspectorEvent::Cancelled {
                    selection_request_id,
                    reason,
                } => BrowserEvent::SelectionCancelled(SelectionCancelledPayload {
                    selection_request_id,
                    reason,
                }),
                NativeInspectorEvent::Failed {
                    selection_request_id,
                    error_category,
                    message,
                } => BrowserEvent::SelectionFailed(SelectionFailedPayload {
                    selection_request_id,
                    error_category,
                    message,
                }),
            };
            emit_browser_event(
                &inspector_emitter,
                &inspector_state,
                &inspector_surface,
                event,
            );
        }),
    ) {
        let _ = surface.destroy();
        abort_surface(&state, &identity);
        return host_failure(
            request_id,
            &format!("Failed to attach Chromium element inspector: {reason}"),
        );
    }

    if let Err(reason) = configure_profile_security(&surface) {
        let _ = surface.destroy();
        abort_surface(&state, &identity);
        return host_failure(
            request_id,
            &format!("Failed to secure browser profile: {reason}"),
        );
    }

    let permission_state = state.clone();
    let permission_surface = identity.reference.clone();
    let permission_emitter = app_emitter.clone();
    if let Err(reason) = attach_permission_broker(
        &surface,
        state.permissions.clone(),
        identity.reference.clone(),
        Arc::new(move |event| {
            emit_browser_event(
                &permission_emitter,
                &permission_state,
                &permission_surface,
                event,
            )
        }),
    ) {
        let _ = surface.destroy();
        abort_surface(&state, &identity);
        return host_failure(
            request_id,
            &format!("Failed to attach permission broker: {reason}"),
        );
    }

    let download_state = state.clone();
    let download_surface = identity.reference.clone();
    let download_emitter = app_emitter.clone();
    if let Err(reason) = attach_download_manager(
        &surface,
        state.downloads.clone(),
        identity.reference.clone(),
        Arc::new(move |event| {
            emit_browser_event(&download_emitter, &download_state, &download_surface, event)
        }),
    ) {
        let _ = surface.destroy();
        abort_surface(&state, &identity);
        return host_failure(
            request_id,
            &format!("Failed to attach download manager: {reason}"),
        );
    }

    let shortcut_state = state.clone();
    let shortcut_surface = identity.reference.clone();
    let shortcut_emitter = app_emitter.clone();
    if let Err(reason) = attach_native_shortcuts(
        &surface,
        Arc::new(move |event| {
            emit_browser_event(&shortcut_emitter, &shortcut_state, &shortcut_surface, event)
        }),
    ) {
        let _ = surface.destroy();
        abort_surface(&state, &identity);
        return host_failure(
            request_id,
            &format!("Failed to attach browser shortcuts: {reason}"),
        );
    }

    let failure_state = state.clone();
    let failure_surface = identity.reference.clone();
    let failure_emitter = app_emitter.clone();
    if let Err(reason) = attach_process_failure_observer(
        &surface,
        state.failures.clone(),
        format!("profile:{:?}", payload.profile_mode),
        identity.reference.clone(),
        Arc::new(move |event| {
            emit_browser_event(&failure_emitter, &failure_state, &failure_surface, event)
        }),
    ) {
        let _ = surface.destroy();
        abort_surface(&state, &identity);
        return host_failure(
            request_id,
            &format!("Failed to attach process observer: {reason}"),
        );
    }

    let navigation_state = state.clone();
    let navigation_surface = identity.reference.clone();
    let navigation_emitter = app_emitter.clone();
    if let Err(reason) = attach_windows_navigation_observers(
        &surface,
        Arc::new(move |event| {
            emit_native_navigation_event(
                &navigation_emitter,
                &navigation_state,
                &navigation_surface,
                event,
            )
        }),
    ) {
        let _ = surface.destroy();
        abort_surface(&state, &identity);
        return host_failure(
            request_id,
            &format!("Failed to attach navigation observers: {reason}"),
        );
    }

    if let Err(reason) = attach_page_lifecycle_observers(
        &surface,
        app_emitter.clone(),
        state.clone(),
        identity.reference.clone(),
    ) {
        let _ = surface.destroy();
        abort_surface(&state, &identity);
        return host_failure(request_id, &reason);
    }

    let stale = {
        let Ok(mut surfaces) = state.surfaces.lock() else {
            let _ = surface.destroy();
            abort_surface(&state, &identity);
            return host_failure(request_id, "BrowserHost surface table is unavailable");
        };
        surfaces.finish_create(&identity, surface.clone())
    };
    if let Some(stale) = stale {
        let _ = stale.destroy();
        return stale_generation(request_id);
    }

    state.lifecycle.mark_ready(&identity.reference);
    state.resources.register_visible(&identity.reference);
    emit_browser_event(
        &caller,
        &state,
        &identity.reference,
        BrowserEvent::SurfaceReady(SurfaceReadyPayload {
            profile_mode: payload.profile_mode,
            capabilities: composition_webview2_capabilities(),
        }),
    );

    if initial_url.as_str() != "about:blank" {
        state
            .lifecycle
            .begin_navigation(&identity.reference, bootstrap_navigation_id);
        emit_browser_event(
            &caller,
            &state,
            &identity.reference,
            BrowserEvent::NavigationStarted(NavigationPayload {
                url: initial_url.as_str().to_string(),
                is_main_frame: true,
            }),
        );
        if let Err(reason) = surface.run({
            let url = initial_url.as_str().to_string();
            move |surface| surface.navigate(&url)
        }) {
            emit_navigation_failed(
                &caller,
                &state,
                &identity.reference,
                initial_url.as_str(),
                "host_dispatch",
            );
            return host_failure(
                request_id,
                &format!("Failed to navigate initial browser URL: {reason}"),
            );
        }
    }
    success(request_id)
}

impl BrowserHostState {
    /// Drops every native browser surface owned by the current renderer document.
    ///
    /// A reload of the main webview replaces the React document without restarting
    /// the Rust process. Child webviews therefore have to be reclaimed by the host;
    /// renderer unmount callbacks cannot be relied on during that transition.
    pub(crate) fn reset_renderer_surfaces(&self) -> usize {
        if self.closing.load(Ordering::SeqCst) {
            return 0;
        }
        self.close_all_surfaces()
    }

    /// Detaches renderer-owned surfaces immediately and performs the native
    /// COM/HWND teardown off the Tauri page-load callback thread.
    pub(crate) fn reset_renderer_surfaces_in_background(&self) -> usize {
        if self.closing.load(Ordering::SeqCst) {
            return 0;
        }
        let surfaces = self.take_all_surfaces();
        let surface_count = surfaces.len();
        if surface_count == 0 {
            return 0;
        }
        let state = self.clone();
        if std::thread::Builder::new()
            .name("keydex-browser-renderer-reset".to_string())
            .spawn(move || {
                state.close_surface_records(surfaces);
            })
            .is_err()
        {
            // The renderer table is already detached. Never block the Tauri UI
            // thread trying to recover from a cleanup-thread spawn failure.
            return 0;
        }
        surface_count
    }

    pub(crate) fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.close_all_surfaces();
        if let Ok(mut actor) = self.actor.lock() {
            if let Some(actor) = actor.take() {
                let _ = actor.shutdown();
            }
        }
        self.captures.shutdown(&std::env::temp_dir());
    }

    fn close_all_surfaces(&self) -> usize {
        let surfaces = self.take_all_surfaces();
        let surface_count = surfaces.len();
        self.close_surface_records(surfaces);
        surface_count
    }

    fn take_all_surfaces(&self) -> Vec<(BrowserSurfaceRef, Option<NativeBrowserSurface>)> {
        self.surfaces
            .lock()
            .map(|mut surfaces| surfaces.drain())
            .unwrap_or_default()
    }

    fn close_surface_records(
        &self,
        surfaces: Vec<(BrowserSurfaceRef, Option<NativeBrowserSurface>)>,
    ) {
        for (surface, webview) in surfaces {
            self.inspector.remove_surface(&surface);
            self.bridge.unregister_surface(&surface);
            self.permissions.cancel_surface(webview.as_ref(), &surface);
            self.downloads
                .cancel_pending_for_surface(webview.as_ref(), &surface);
            if let Some(webview) = webview {
                let _ = webview.destroy();
            }
            self.resources.remove(&surface);
            self.captures.release_surface(&surface);
            self.lifecycle.remove(&surface);
            self.profiles
                .release_surface(&std::env::temp_dir(), &surface);
        }
    }
}

#[tauri::command]
pub(crate) async fn reload_main_webview(caller: Webview) -> Result<(), String> {
    ensure_main_webview_caller(&caller).map_err(|error| error.message)?;
    let state = caller.state::<BrowserHostState>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.reset_renderer_surfaces())
        .await
        .map_err(|error| format!("Failed to reclaim browser surfaces before reload: {error}"))?;
    caller
        .reload()
        .map_err(|error| format!("Failed to reload the main webview: {error}"))
}

#[tauri::command]
pub(crate) async fn browser_destroy_surface(
    caller: Webview,
    request_id: String,
    payload: BrowserSurfaceRef,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    state.resources.remove(&payload);
    state.captures.release_surface(&payload);
    let abandoned_selection = state.inspector.remove_surface(&payload);
    let outcome = match state.surfaces.lock() {
        Ok(mut surfaces) => surfaces.destroy_checked(&payload),
        Err(_) => return host_failure(request_id, "BrowserHost surface table is unavailable"),
    };
    let handle = match outcome {
        DestroySurface::Absent => return success(request_id),
        DestroySurface::Stale(_) => return stale_generation(request_id),
        DestroySurface::Destroyed(handle) => handle,
    };
    state.bridge.unregister_surface(&payload);
    if let Some(selection_request_id) = abandoned_selection {
        emit_browser_event(
            &caller,
            &state,
            &payload,
            BrowserEvent::SelectionCancelled(SelectionCancelledPayload {
                selection_request_id,
                reason: "surface_destroyed".to_string(),
            }),
        );
    }
    if let Some(webview) = handle.as_ref() {
        state.permissions.cancel_surface(Some(webview), &payload);
        state
            .downloads
            .cancel_pending_for_surface(Some(webview), &payload);
    }
    let close_error = handle.and_then(|webview| webview.destroy().err());
    state
        .profiles
        .release_surface(&std::env::temp_dir(), &payload);
    emit_browser_event(
        &caller,
        &state,
        &payload,
        BrowserEvent::SurfaceDestroyed(ReasonPayload {
            reason: if close_error.is_some() {
                "native_close_failed".into()
            } else {
                "user_or_scope_closed".into()
            },
        }),
    );
    state.lifecycle.remove(&payload);
    match close_error {
        Some(reason) => host_failure(
            request_id,
            &format!("Failed to destroy browser surface: {reason}"),
        ),
        None => success(request_id),
    }
}

#[tauri::command]
pub(crate) async fn browser_respond_download(
    caller: Webview,
    request_id: String,
    payload: RespondDownloadInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    let downloads_dir = match caller.path().download_dir() {
        Ok(path) => debug_managed_root("KEYDEX_BROWSER_DOWNLOAD_ROOT", &path),
        Err(reason) => {
            return host_failure(
                request_id,
                &format!("Downloads directory is unavailable: {reason}"),
            )
        }
    };
    match state.downloads.respond(&webview, &downloads_dir, &payload) {
        Ok(()) => success(request_id),
        Err(reason) => failure(
            request_id,
            error(BrowserCommandErrorCode::PolicyDenied, &reason, false),
        ),
    }
}

#[tauri::command]
pub(crate) async fn browser_respond_permission(
    caller: Webview,
    request_id: String,
    payload: RespondPermissionInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    match state.permissions.respond(&webview, &payload) {
        Ok(()) => success(request_id),
        Err(reason) => failure(
            request_id,
            error(BrowserCommandErrorCode::PolicyDenied, &reason, false),
        ),
    }
}

#[tauri::command]
pub(crate) async fn browser_clear_profile_data(
    caller: Webview,
    request_id: String,
    payload: ClearProfileDataInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    if payload.kinds.is_empty() {
        return invalid_request(request_id, "At least one browser data category is required");
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let surfaces = state.lifecycle.surfaces_for_profile(payload.profile_mode);
    let Some(primary) = surfaces.first() else {
        return failure(
            request_id,
            error(
                BrowserCommandErrorCode::UnsupportedOperation,
                "Open a browser panel for this profile before clearing its data",
                false,
            ),
        );
    };
    let webview = match exact_surface(&state, primary) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    if let Err(reason) = clear_profile_data(&webview, &payload.kinds, payload.time_range).await {
        return host_failure(request_id, &reason);
    }
    for surface in surfaces {
        if let Ok(webview) = exact_surface(&state, &surface) {
            let _ = webview.run(|surface| surface.reload());
        }
    }
    success(request_id)
}

#[tauri::command]
pub(crate) async fn browser_navigate(
    caller: Webview,
    request_id: String,
    payload: NavigateInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let url = match parse_browser_url(&payload.url, false) {
        Ok(url) => url,
        Err(error) => return failure(request_id, error),
    };
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    if !state
        .lifecycle
        .begin_navigation(&payload.surface, payload.navigation_id.clone())
        || !state
            .bridge
            .begin_navigation(&payload.surface, payload.navigation_id.clone())
    {
        return stale_generation(request_id);
    }
    emit_browser_event(
        &caller,
        &state,
        &payload.surface,
        BrowserEvent::NavigationStarted(NavigationPayload {
            url: url.as_str().to_string(),
            is_main_frame: true,
        }),
    );
    let navigation_url = url.as_str().to_string();
    match webview.run(move |surface| surface.navigate(&navigation_url)) {
        Ok(()) => success(request_id),
        Err(reason) => {
            emit_navigation_failed(
                &caller,
                &state,
                &payload.surface,
                url.as_str(),
                "host_dispatch",
            );
            host_failure(
                request_id,
                &format!("Failed to navigate browser surface: {reason}"),
            )
        }
    }
}

#[tauri::command]
pub(crate) async fn browser_go_back(
    caller: Webview,
    request_id: String,
    payload: BrowserSurfaceRef,
) -> BrowserCommandResponse {
    dispatch_history_command(caller, request_id, payload, NativeHistoryAction::Back)
}

#[tauri::command]
pub(crate) async fn browser_go_forward(
    caller: Webview,
    request_id: String,
    payload: BrowserSurfaceRef,
) -> BrowserCommandResponse {
    dispatch_history_command(caller, request_id, payload, NativeHistoryAction::Forward)
}

#[tauri::command]
pub(crate) async fn browser_stop(
    caller: Webview,
    request_id: String,
    payload: BrowserSurfaceRef,
) -> BrowserCommandResponse {
    dispatch_history_command(caller, request_id, payload, NativeHistoryAction::Stop)
}

fn dispatch_history_command(
    caller: Webview,
    request_id: String,
    payload: BrowserSurfaceRef,
    action: NativeHistoryAction,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    match dispatch_native_history(&webview, action) {
        Ok(()) => success(request_id),
        Err(reason) => host_failure(
            request_id,
            &format!("Failed to dispatch native browser history command: {reason}"),
        ),
    }
}

#[tauri::command]
pub(crate) async fn browser_reload(
    caller: Webview,
    request_id: String,
    payload: ReloadInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    if payload.mode == BrowserReloadMode::IgnoreCache {
        return failure(
            request_id,
            error(
                BrowserCommandErrorCode::UnsupportedOperation,
                "Ignore-cache reload is not enabled in the production BrowserHost",
                false,
            ),
        );
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    match webview.run(|surface| surface.reload()) {
        Ok(()) => success(request_id),
        Err(reason) => host_failure(
            request_id,
            &format!("Failed to reload browser surface: {reason}"),
        ),
    }
}

#[tauri::command]
pub(crate) async fn browser_set_visibility(
    caller: Webview,
    request_id: String,
    payload: SetVisibilityInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    let visible = payload.visible;
    let focus = payload.visible && payload.reason == BrowserVisibilityReason::Active;
    let result = webview.run(move |surface| {
        surface.set_visible(visible)?;
        if focus {
            surface.focus()?;
        }
        Ok(())
    });
    match result {
        Ok(()) => {
            state
                .resources
                .set_visible(&payload.surface, payload.visible);
            success(request_id)
        }
        Err(reason) => host_failure(
            request_id,
            &format!("Failed to change browser surface visibility: {reason}"),
        ),
    }
}

#[tauri::command]
pub(crate) fn browser_sync_geometry(
    caller: Webview,
    payload: BrowserGeometryInput,
) -> Result<(), String> {
    ensure_main_webview_caller(&caller).map_err(|error| error.message)?;
    let state = caller.state::<BrowserHostState>().inner().clone();
    let scale = caller.window().scale_factor().unwrap_or(1.0);
    let (webview, surface_ref, frame) = resolve_geometry_input(&state, payload, scale)?;
    let visible = frame.visible;
    webview.publish_geometry(frame)?;
    state.resources.set_visible(&surface_ref, visible);
    Ok(())
}

#[tauri::command]
pub(crate) fn browser_begin_interactive_resize(
    caller: Webview,
    payload: BrowserInteractiveResizeInput,
) -> Result<(), String> {
    ensure_main_webview_caller(&caller).map_err(|error| error.message)?;
    if payload.session_id == 0
        || !payload.start_screen_x.is_finite()
        || !payload.min_delta.is_finite()
        || !payload.max_delta.is_finite()
        || payload.min_delta > payload.max_delta
        || payload.surfaces.is_empty()
        || payload.surfaces.len() > 32
    {
        return Err("Browser interactive resize request is invalid".to_string());
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let scale = caller.window().scale_factor().unwrap_or(1.0);
    let mut owner = None;
    let mut surfaces = Vec::with_capacity(payload.surfaces.len());
    for input in payload.surfaces {
        let (webview, surface_ref, frame) = resolve_geometry_input(&state, input, scale)?;
        state.resources.set_visible(&surface_ref, frame.visible);
        owner.get_or_insert_with(|| webview.clone());
        let baseline = frame.physical_rect();
        surfaces.push(NativeInteractiveResizeSurface {
            surface_id: frame.surface_id,
            generation: frame.generation,
            baseline,
            visible: frame.visible,
        });
    }
    let request = NativeInteractiveResizeRequest {
        session_id: payload.session_id,
        placement: payload.placement,
        start_screen_x: physical_scalar(payload.start_screen_x, scale),
        min_delta: physical_scalar(payload.min_delta, scale),
        max_delta: physical_scalar(payload.max_delta, scale),
        surfaces,
    };
    owner
        .ok_or_else(|| "Browser interactive resize has no surface".to_string())?
        .begin_interactive_resize(request)
}

#[tauri::command]
pub(crate) fn browser_end_interactive_resize(
    caller: Webview,
    payload: BrowserInteractiveResizeEndInput,
) -> Result<(), String> {
    ensure_main_webview_caller(&caller).map_err(|error| error.message)?;
    if payload.session_id == 0 || payload.surfaces.is_empty() || payload.surfaces.len() > 32 {
        return Err("Browser interactive resize completion is invalid".to_string());
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let scale = caller.window().scale_factor().unwrap_or(1.0);
    let mut owner = None;
    let mut final_frames = Vec::with_capacity(payload.surfaces.len());
    for input in payload.surfaces {
        let (webview, surface_ref, frame) = resolve_geometry_input(&state, input, scale)?;
        state.resources.set_visible(&surface_ref, frame.visible);
        owner.get_or_insert_with(|| webview.clone());
        final_frames.push(frame);
    }
    owner
        .ok_or_else(|| "Browser interactive resize has no surface".to_string())?
        .end_interactive_resize(payload.session_id, final_frames)
}

fn resolve_geometry_input(
    state: &BrowserHostState,
    payload: BrowserGeometryInput,
    scale: f64,
) -> Result<
    (
        NativeBrowserSurface,
        BrowserSurfaceRef,
        BrowserGeometryFrame,
    ),
    String,
> {
    if payload.panel_id.is_empty()
        || payload.surface_id.is_empty()
        || payload.generation == 0
        || payload.revision == 0
    {
        return Err("Browser geometry identity is invalid".to_string());
    }
    if !payload.rect.x.is_finite()
        || !payload.rect.y.is_finite()
        || !payload.rect.width.is_finite()
        || !payload.rect.height.is_finite()
        || payload.rect.width < 0.0
        || payload.rect.height < 0.0
    {
        return Err("Browser geometry is invalid".to_string());
    }
    let surface_ref = BrowserSurfaceRef {
        panel_id: payload.panel_id,
        surface_id: payload.surface_id,
        generation: payload.generation,
    };
    let webview = exact_surface(&state, &surface_ref)
        .map_err(|code| format!("Browser surface is unavailable: {code:?}"))?;
    let frame = BrowserGeometryFrame {
        surface_id: surface_ref.surface_id.clone(),
        generation: surface_ref.generation,
        revision: payload.revision,
        rect: payload.rect,
        device_scale_factor: scale,
        visible: payload.visible,
    };
    Ok((webview, surface_ref, frame))
}

fn physical_scalar(value: f64, scale: f64) -> i32 {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    (value * scale)
        .round()
        .clamp(i32::MIN as f64, i32::MAX as f64) as i32
}

#[tauri::command]
pub(crate) async fn browser_set_zoom(
    caller: Webview,
    request_id: String,
    payload: SetZoomInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    if !payload.factor.is_finite() || !(0.5..=3.0).contains(&payload.factor) {
        return invalid_request(request_id, "Zoom factor must be between 0.5 and 3.0");
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    match set_native_zoom(&webview, payload.factor) {
        Ok(()) => success(request_id),
        Err(reason) => host_failure(request_id, &format!("Failed to set browser zoom: {reason}")),
    }
}

#[tauri::command]
pub(crate) async fn browser_set_resource_state(
    caller: Webview,
    request_id: String,
    payload: SetResourceStateInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    if payload.reason.is_empty() || payload.reason.len() > 128 {
        return invalid_request(request_id, "Resource transition reason is invalid");
    }
    if payload.state == super::contract::BrowserResourceState::Discarded {
        return invalid_request(
            request_id,
            "Discarded surfaces must use browser_destroy_surface",
        );
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    let Some(prior) = state.resources.transition(&payload.surface, payload.state) else {
        return surface_resolution_failure(request_id, BrowserCommandErrorCode::SurfaceNotFound);
    };
    if prior == payload.state {
        return success(request_id);
    }
    if let Err(reason) = apply_native_resource_state(&webview, payload.state) {
        let _ = state.resources.transition(&payload.surface, prior);
        return host_failure(
            request_id,
            &format!("Failed to change browser resource state: {reason}"),
        );
    }
    if payload.state != super::contract::BrowserResourceState::Visible {
        let _ = webview.run(|surface| surface.set_visible(false));
    }
    emit_browser_event(
        &caller,
        &state,
        &payload.surface,
        BrowserEvent::ResourceStateChanged(ResourceStatePayload {
            prior,
            next: payload.state,
            reason: payload.reason,
        }),
    );
    success(request_id)
}

#[tauri::command]
pub(crate) async fn browser_find(
    caller: Webview,
    request_id: String,
    payload: FindInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    if payload.query.chars().count() > 16_384 {
        return invalid_request(request_id, "Find query is too long");
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    let key = native_find_surface_key(
        &payload.surface.panel_id,
        &payload.surface.surface_id,
        payload.surface.generation,
    );
    let result = if payload.query.is_empty() {
        stop_native_find(&webview, key)
    } else {
        // The query is intentionally never included in errors, events, or ordinary logs.
        dispatch_native_find(
            &webview,
            key,
            payload.query,
            payload.match_case,
            payload.backwards,
        )
    };
    match result {
        Ok(()) => success(request_id),
        Err(reason) => host_failure(
            request_id,
            &format!("Failed to control page find: {reason}"),
        ),
    }
}

#[tauri::command]
pub(crate) async fn browser_stop_find(
    caller: Webview,
    request_id: String,
    payload: BrowserSurfaceRef,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    let key = native_find_surface_key(&payload.panel_id, &payload.surface_id, payload.generation);
    match stop_native_find(&webview, key) {
        Ok(()) => success(request_id),
        Err(reason) => host_failure(request_id, &format!("Failed to stop page find: {reason}")),
    }
}

#[tauri::command]
pub(crate) async fn browser_start_selection(
    caller: Webview,
    request_id: String,
    payload: StartSelectionInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    if matches!(&payload.mode, BrowserSelectionMode::Element) {
        return match start_native_element_selection(
            &webview,
            &state.inspector,
            &payload.surface,
            &payload.selection_request_id,
        )
        .await
        {
            Ok(()) => success(request_id),
            Err(reason) => host_failure(
                request_id,
                &format!("Failed to start Chromium element inspection: {reason}"),
            ),
        };
    }
    let mode = match payload.mode {
        BrowserSelectionMode::Text => "text",
        BrowserSelectionMode::Element => {
            unreachable!("element selection uses the native inspector")
        }
        BrowserSelectionMode::Region => "region",
    };
    let frame_keys = state.bridge.ready_frame_keys(&payload.surface);
    if frame_keys.is_empty() {
        return host_failure(request_id, "Structured page selection bridge is not ready");
    }
    for frame_key in frame_keys {
        let envelope = match state.bridge.prepare_host_envelope(
            &payload.surface,
            &frame_key,
            &payload.selection_request_id,
            "selection.start",
            serde_json::json!({
                "selectionId": payload.selection_request_id.clone(),
                "mode": mode,
            }),
        ) {
            Ok(envelope) => envelope,
            Err(error) => return bridge_command_failure(request_id, error),
        };
        if let Err(reason) = post_windows_bridge_envelope(&webview, &envelope) {
            return host_failure(
                request_id,
                &format!("Failed to start structured page selection: {reason}"),
            );
        }
    }
    success(request_id)
}

#[tauri::command]
pub(crate) async fn browser_configure_overlay(
    caller: Webview,
    request_id: String,
    payload: ConfigureOverlayInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    state
        .inspector
        .configure_accent(&payload.surface, &payload.tokens.accent);
    let frame_keys = state.bridge.ready_frame_keys(&payload.surface);
    if frame_keys.is_empty() {
        return host_failure(request_id, "Structured page overlay bridge is not ready");
    }
    let theme = match payload.theme {
        BrowserOverlayTheme::Light => "light",
        BrowserOverlayTheme::Dark => "dark",
    };
    let overlay_payload = serde_json::json!({
        "theme": theme,
        "tokens": &payload.tokens,
        "radiusPx": payload.radius_px,
        "motionMs": payload.motion_ms,
        "reducedMotion": payload.reduced_motion,
    });
    for frame_key in frame_keys {
        let envelope = match state.bridge.prepare_host_envelope(
            &payload.surface,
            &frame_key,
            &request_id,
            "overlay.configure",
            overlay_payload.clone(),
        ) {
            Ok(envelope) => envelope,
            Err(error) => return bridge_command_failure(request_id, error),
        };
        if let Err(reason) = post_windows_bridge_envelope(&webview, &envelope) {
            return host_failure(
                request_id,
                &format!("Failed to configure structured page overlay: {reason}"),
            );
        }
    }
    success(request_id)
}

#[tauri::command]
pub(crate) async fn browser_cancel_selection(
    caller: Webview,
    request_id: String,
    payload: BrowserSurfaceRef,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    if let Err(reason) = cancel_native_element_selection(&webview, &state.inspector, &payload).await
    {
        return host_failure(
            request_id,
            &format!("Failed to cancel Chromium element inspection: {reason}"),
        );
    }
    for (frame_key, selection_id) in state.bridge.pending_selection_requests(&payload) {
        let envelope = match state.bridge.prepare_host_envelope(
            &payload,
            &frame_key,
            &selection_id,
            "selection.cancel",
            serde_json::json!({
                "selectionId": selection_id.clone(),
                "reason": "user",
            }),
        ) {
            Ok(envelope) => envelope,
            Err(error) => return bridge_command_failure(request_id, error),
        };
        if let Err(reason) = post_windows_bridge_envelope(&webview, &envelope) {
            return host_failure(
                request_id,
                &format!("Failed to cancel structured page selection: {reason}"),
            );
        }
    }
    success(request_id)
}

#[tauri::command]
pub(crate) async fn browser_resolve_annotations(
    caller: Webview,
    request_id: String,
    payload: ResolveAnnotationsInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    if payload.targets.is_empty() || payload.targets.len() > usize::from(BROWSER_RESOLVE_BATCH_SIZE)
    {
        return host_failure(request_id, "Structured page resolver batch is invalid");
    }
    let ready_frames = state.bridge.ready_frame_keys(&payload.surface);
    let fallback_frame = ready_frames
        .iter()
        .find(|frame_key| frame_key.as_str() == "main")
        .cloned();
    if ready_frames.is_empty() {
        return host_failure(request_id, "Structured page resolver bridge is not ready");
    }
    for (index, target) in payload.targets.iter().enumerate() {
        if validate_web_annotation_target(&target.target).is_err() {
            return host_failure(request_id, "Structured page resolver target is invalid");
        }
        let desired_frame = annotation_target_frame_key(&target.target);
        let frame_key = if ready_frames.contains(&desired_frame) {
            desired_frame
        } else if let Some(fallback) = &fallback_frame {
            fallback.clone()
        } else {
            return host_failure(request_id, "Structured page resolver frame is not ready");
        };
        let bridge_request_id = format!(
            "{}:{index}",
            truncate_bridge_request_id(&payload.resolve_request_id)
        );
        let envelope = match state.bridge.prepare_host_envelope(
            &payload.surface,
            &frame_key,
            &bridge_request_id,
            "annotation.resolve",
            serde_json::json!({
                "annotationId": target.annotation_id.clone(),
                "target": target.target.clone(),
            }),
        ) {
            Ok(envelope) => envelope,
            Err(error) => return bridge_command_failure(request_id, error),
        };
        if let Err(reason) = post_windows_bridge_envelope(&webview, &envelope) {
            return host_failure(
                request_id,
                &format!("Failed to resolve structured page annotations: {reason}"),
            );
        }
    }
    success(request_id)
}

#[tauri::command]
pub(crate) async fn browser_render_highlights(
    caller: Webview,
    request_id: String,
    payload: RenderHighlightsInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    if payload.resolutions.len() > usize::from(BROWSER_RESOLVE_BATCH_SIZE) {
        return host_failure(request_id, "Structured page highlight batch is invalid");
    }
    let ready_frames = state.bridge.ready_frame_keys(&payload.surface);
    for (index, resolution) in payload.resolutions.iter().enumerate() {
        if validate_web_annotation_target(&resolution.target).is_err() {
            return host_failure(request_id, "Structured page highlight target is invalid");
        }
        let frame_key = annotation_target_frame_key(&resolution.target);
        if !ready_frames.contains(&frame_key) {
            return host_failure(request_id, "Structured page highlight frame is not ready");
        }
        let bridge_request_id = format!("{}:{index}", truncate_bridge_request_id(&request_id));
        let resolution_state = match resolution.state {
            BrowserHighlightState::Resolved => "resolved",
            BrowserHighlightState::Changed => "changed",
        };
        let envelope = match state.bridge.prepare_host_envelope(
            &payload.surface,
            &frame_key,
            &bridge_request_id,
            "highlight.render",
            serde_json::json!({
                "annotationId": resolution.annotation_id.clone(),
                "target": resolution.target.clone(),
                "state": resolution_state,
            }),
        ) {
            Ok(envelope) => envelope,
            Err(error) => return bridge_command_failure(request_id, error),
        };
        if let Err(reason) = post_windows_bridge_envelope(&webview, &envelope) {
            return host_failure(
                request_id,
                &format!("Failed to render structured page highlights: {reason}"),
            );
        }
    }
    success(request_id)
}

#[tauri::command]
pub(crate) async fn browser_clear_highlights(
    caller: Webview,
    request_id: String,
    payload: ClearHighlightsInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    if payload.annotation_ids.len() > usize::from(BROWSER_RESOLVE_BATCH_SIZE) {
        return host_failure(
            request_id,
            "Structured page highlight clear batch is invalid",
        );
    }
    for frame_key in state.bridge.ready_frame_keys(&payload.surface) {
        let envelope = match state.bridge.prepare_host_envelope(
            &payload.surface,
            &frame_key,
            &truncate_bridge_request_id(&request_id),
            "highlight.clear",
            serde_json::json!({ "annotationIds": payload.annotation_ids.clone() }),
        ) {
            Ok(envelope) => envelope,
            Err(error) => return bridge_command_failure(request_id, error),
        };
        if let Err(reason) = post_windows_bridge_envelope(&webview, &envelope) {
            return host_failure(
                request_id,
                &format!("Failed to clear structured page highlights: {reason}"),
            );
        }
    }
    success(request_id)
}

#[tauri::command]
pub(crate) async fn browser_navigate_to_annotation_target(
    caller: Webview,
    request_id: String,
    payload: NavigateAnnotationTargetInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    if validate_web_annotation_target(&payload.target).is_err() {
        return host_failure(request_id, "Structured page navigation target is invalid");
    }
    let frame_key = annotation_target_frame_key(&payload.target);
    if !state
        .bridge
        .ready_frame_keys(&payload.surface)
        .contains(&frame_key)
    {
        return host_failure(request_id, "Structured page navigation frame is not ready");
    }
    let envelope = match state.bridge.prepare_host_envelope(
        &payload.surface,
        &frame_key,
        &truncate_bridge_request_id(&request_id),
        "navigate.toTarget",
        serde_json::json!({
            "annotationId": payload.annotation_id,
            "target": payload.target,
        }),
    ) {
        Ok(envelope) => envelope,
        Err(error) => return bridge_command_failure(request_id, error),
    };
    if let Err(reason) = post_windows_bridge_envelope(&webview, &envelope) {
        return host_failure(
            request_id,
            &format!("Failed to navigate to structured page annotation: {reason}"),
        );
    }
    success(request_id)
}

fn annotation_target_frame_key(target: &serde_json::Value) -> String {
    let indices = target
        .get("frame")
        .and_then(|frame| frame.get("indexPath"))
        .and_then(serde_json::Value::as_array);
    match indices {
        Some(indices) if !indices.is_empty() => format!(
            "frame:{}",
            indices
                .iter()
                .filter_map(serde_json::Value::as_u64)
                .map(|index| index.to_string())
                .collect::<Vec<_>>()
                .join(".")
        ),
        _ => "main".to_string(),
    }
}

fn truncate_bridge_request_id(value: &str) -> String {
    value.chars().take(110).collect()
}

#[tauri::command]
pub(crate) async fn browser_capture_region(
    caller: Webview,
    request_id: String,
    payload: CaptureRegionInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    let webview = match exact_surface(&state, &payload.surface) {
        Ok(webview) => webview,
        Err(code) => return surface_resolution_failure(request_id, code),
    };
    if !state.resources.can_capture(&payload.surface) {
        emit_capture_failed(
            &caller,
            &state,
            &payload.surface,
            &payload.capture_request_id,
            "surface_not_visible",
        );
        return failure(
            request_id,
            error(
                BrowserCommandErrorCode::PolicyDenied,
                "Browser capture requires a visible active surface",
                false,
            ),
        );
    }
    let Some(profile_mode) = state.profiles.mode_for_surface(&payload.surface) else {
        return stale_generation(request_id);
    };
    let source_png = match capture_webview_png(&webview).await {
        Ok(png) => png,
        Err(_) => {
            emit_capture_failed(
                &caller,
                &state,
                &payload.surface,
                &payload.capture_request_id,
                "native_capture_failed",
            );
            return host_failure(request_id, "Failed to capture the visible browser region");
        }
    };
    let capture = match crop_png_to_css_rect(&source_png, &payload.rect, &payload.viewport) {
        Ok(capture) => capture,
        Err(_) => {
            emit_capture_failed(
                &caller,
                &state,
                &payload.surface,
                &payload.capture_request_id,
                "invalid_geometry",
            );
            return invalid_request(request_id, "Browser capture geometry is invalid");
        }
    };
    let app_data_dir = match caller.path().app_data_dir() {
        Ok(path) => path,
        Err(_) => {
            emit_capture_failed(
                &caller,
                &state,
                &payload.surface,
                &payload.capture_request_id,
                "storage_unavailable",
            );
            return host_failure(request_id, "Browser capture storage is unavailable");
        }
    };
    let asset = match state.captures.store_capture(
        &app_data_dir,
        &std::env::temp_dir(),
        &payload.surface,
        profile_mode,
        &payload.capture_request_id,
        capture,
    ) {
        Ok(asset) => asset,
        Err(_) => {
            emit_capture_failed(
                &caller,
                &state,
                &payload.surface,
                &payload.capture_request_id,
                "storage_failed",
            );
            return host_failure(request_id, "Failed to stage the browser capture");
        }
    };
    emit_browser_event(
        &caller,
        &state,
        &payload.surface,
        BrowserEvent::CaptureCompleted(CaptureCompletedPayload {
            capture_request_id: payload.capture_request_id,
            asset,
        }),
    );
    success(request_id)
}

#[tauri::command]
pub(crate) async fn browser_discard_capture(
    caller: Webview,
    request_id: String,
    payload: DiscardCaptureInput,
) -> BrowserCommandResponse {
    if let Err(error) = ensure_main_webview_caller(&caller) {
        return failure(request_id, error);
    }
    let state = caller.state::<BrowserHostState>().inner().clone();
    if let Err(code) = exact_surface(&state, &payload.surface) {
        return surface_resolution_failure(request_id, code);
    }
    match state
        .captures
        .discard_capture(&payload.surface, &payload.capture_request_id)
    {
        Ok(_) => success(request_id),
        Err(_) => host_failure(request_id, "Failed to discard the managed browser capture"),
    }
}

#[tauri::command]
pub(crate) async fn browser_take_incognito_capture(
    caller: Webview,
    payload: TakeIncognitoCaptureInput,
) -> Result<TakenIncognitoCapture, String> {
    ensure_main_webview_caller(&caller).map_err(|error| error.message)?;
    let state = caller.state::<BrowserHostState>().inner().clone();
    exact_surface(&state, &payload.surface)
        .map_err(|_| "Managed incognito capture surface is stale".to_string())?;
    state.captures.take_incognito_capture(
        &payload.surface,
        &payload.capture_request_id,
        &payload.asset_id,
    )
}

fn abort_surface(state: &BrowserHostState, identity: &super::surface::SurfaceIdentity) {
    state.inspector.remove_surface(&identity.reference);
    state.bridge.unregister_surface(&identity.reference);
    state.lifecycle.remove(&identity.reference);
    state.permissions.cancel_surface(None, &identity.reference);
    state
        .downloads
        .cancel_pending_for_surface(None, &identity.reference);
    state.captures.release_surface(&identity.reference);
    state
        .profiles
        .release_surface(&std::env::temp_dir(), &identity.reference);
    if let Ok(mut surfaces) = state.surfaces.lock() {
        surfaces.abort_create(identity);
    }
}

#[cfg(windows)]
fn native_actor_for(
    state: &BrowserHostState,
    caller: &Webview,
) -> Result<BrowserUiActorHandle, String> {
    let mut actor = state
        .actor
        .lock()
        .map_err(|_| "Browser UI actor state is unavailable".to_string())?;
    if let Some(actor) = actor.as_ref() {
        return Ok(actor.clone());
    }
    let hwnd = caller
        .window()
        .hwnd()
        .map_err(|error| format!("Failed to resolve Keydex main window handle: {error}"))?;
    let created = BrowserUiActorHandle::start(hwnd.0 as isize)?;
    *actor = Some(created.clone());
    Ok(created)
}

#[cfg(not(windows))]
fn native_actor_for(
    _state: &BrowserHostState,
    _caller: &Webview,
) -> Result<BrowserUiActorHandle, String> {
    Err("Windowed WebView2 BrowserHost requires Windows".to_string())
}

#[cfg(windows)]
fn attach_page_lifecycle_observers(
    surface: &NativeBrowserSurface,
    emitter: tauri::AppHandle,
    state: BrowserHostState,
    reference: BrowserSurfaceRef,
) -> Result<(), String> {
    use webview2_com::{
        DocumentTitleChangedEventHandler, NavigationCompletedEventHandler,
        NavigationStartingEventHandler,
    };
    use windows_061::{core::PWSTR, Win32::System::Com::CoTaskMemFree};

    surface.run(move |surface_handle| unsafe {
        let core = surface_handle.core();

        let title_emitter = emitter.clone();
        let title_state = state.clone();
        let title_surface = reference.clone();
        let mut title_token = 0_i64;
        core.add_DocumentTitleChanged(
            &DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| {
                let Some(sender) = sender else {
                    return Ok(());
                };
                let mut value = PWSTR::null();
                if sender.DocumentTitle(&mut value).is_ok() && !value.is_null() {
                    let title = value.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(value.0.cast()));
                    emit_browser_event(
                        &title_emitter,
                        &title_state,
                        &title_surface,
                        BrowserEvent::PageTitle(PageTitlePayload { title }),
                    );
                }
                Ok(())
            })),
            &mut title_token,
        )
        .map_err(|error| format!("Failed to attach page title observer: {error}"))?;

        let start_emitter = emitter.clone();
        let start_state = state.clone();
        let start_surface = reference.clone();
        let mut start_token = 0_i64;
        core.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut value = PWSTR::null();
                if args.Uri(&mut value).is_err() || value.is_null() {
                    return Ok(());
                }
                let url = value.to_string().unwrap_or_default();
                CoTaskMemFree(Some(value.0.cast()));
                let navigation_id = format!("native-{}", uuid::Uuid::new_v4().simple());
                if !start_state
                    .lifecycle
                    .begin_navigation(&start_surface, navigation_id.clone())
                    || !start_state
                        .bridge
                        .begin_navigation(&start_surface, navigation_id)
                {
                    return Ok(());
                }
                if let Some(selection_request_id) =
                    start_state.inspector.abandon_selection(&start_surface)
                {
                    emit_browser_event(
                        &start_emitter,
                        &start_state,
                        &start_surface,
                        BrowserEvent::SelectionCancelled(SelectionCancelledPayload {
                            selection_request_id,
                            reason: "navigation".to_string(),
                        }),
                    );
                }
                emit_browser_event(
                    &start_emitter,
                    &start_state,
                    &start_surface,
                    BrowserEvent::NavigationStarted(NavigationPayload {
                        url: url.clone(),
                        is_main_frame: true,
                    }),
                );
                emit_browser_event(
                    &start_emitter,
                    &start_state,
                    &start_surface,
                    BrowserEvent::NavigationCommitted(NavigationPayload {
                        url: url.clone(),
                        is_main_frame: true,
                    }),
                );
                emit_browser_event(
                    &start_emitter,
                    &start_state,
                    &start_surface,
                    BrowserEvent::PageSource(PageSourcePayload { url }),
                );
                emit_browser_event(
                    &start_emitter,
                    &start_state,
                    &start_surface,
                    BrowserEvent::PageLoading(PageLoadingPayload { loading: true }),
                );
                Ok(())
            })),
            &mut start_token,
        )
        .map_err(|error| format!("Failed to attach page navigation-start observer: {error}"))?;

        let completed_emitter = emitter;
        let completed_state = state;
        let completed_surface = reference;
        let mut completed_token = 0_i64;
        core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |sender, _| {
                let Some(sender) = sender else {
                    return Ok(());
                };
                let mut value = PWSTR::null();
                let url = if sender.Source(&mut value).is_ok() && !value.is_null() {
                    let url = value
                        .to_string()
                        .unwrap_or_else(|_| "about:blank".to_string());
                    CoTaskMemFree(Some(value.0.cast()));
                    url
                } else {
                    "about:blank".to_string()
                };
                emit_browser_event(
                    &completed_emitter,
                    &completed_state,
                    &completed_surface,
                    BrowserEvent::NavigationCompleted(NavigationPayload {
                        url,
                        is_main_frame: true,
                    }),
                );
                emit_browser_event(
                    &completed_emitter,
                    &completed_state,
                    &completed_surface,
                    BrowserEvent::PageLoading(PageLoadingPayload { loading: false }),
                );
                Ok(())
            })),
            &mut completed_token,
        )
        .map_err(|error| format!("Failed to attach page navigation observer: {error}"))?;
        Ok(())
    })
}

#[cfg(not(windows))]
fn attach_page_lifecycle_observers(
    _surface: &NativeBrowserSurface,
    _emitter: tauri::AppHandle,
    _state: BrowserHostState,
    _reference: BrowserSurfaceRef,
) -> Result<(), String> {
    Err("Windowed WebView2 BrowserHost requires Windows".to_string())
}

fn emit_native_navigation_event(
    emitter: &tauri::AppHandle,
    state: &BrowserHostState,
    surface: &BrowserSurfaceRef,
    event: NativeNavigationEvent,
) {
    match event {
        NativeNavigationEvent::Snapshot(snapshot) => {
            let source = snapshot.source.clone();
            if let Some(url) = source.as_ref() {
                if parse_browser_url(url, true).is_ok() {
                    emit_browser_event(
                        emitter,
                        state,
                        surface,
                        BrowserEvent::PageSource(PageSourcePayload { url: url.clone() }),
                    );
                }
            }
            if let Some(category) = snapshot.error_category {
                emit_navigation_failed(
                    emitter,
                    state,
                    surface,
                    source.as_deref().unwrap_or("about:blank"),
                    &category,
                );
            }
            emit_browser_event(
                emitter,
                state,
                surface,
                BrowserEvent::PageHistory(PageHistoryPayload {
                    can_go_back: snapshot.can_go_back,
                    can_go_forward: snapshot.can_go_forward,
                }),
            );
        }
        NativeNavigationEvent::NewWindowRequested {
            url,
            user_initiated,
        } => {
            if user_initiated && parse_browser_url(&url, false).is_ok() {
                emit_browser_event(
                    emitter,
                    state,
                    surface,
                    BrowserEvent::NewWindowRequested(NewWindowPayload {
                        url,
                        user_gesture: true,
                        disposition: BrowserNewWindowDisposition::Tab,
                    }),
                );
            }
        }
        NativeNavigationEvent::ExternalProtocolRequested {
            url,
            user_initiated,
        } => {
            if user_initiated && is_confirmable_external_protocol(&url) {
                let scheme = url
                    .parse::<Url>()
                    .map(|parsed| parsed.scheme().to_string())
                    .unwrap_or_default();
                emit_browser_event(
                    emitter,
                    state,
                    surface,
                    BrowserEvent::ExternalProtocolRequested(ExternalProtocolPayload {
                        scheme,
                        target: url,
                    }),
                );
            }
        }
        NativeNavigationEvent::CertificateError { url } => {
            emit_navigation_failed(emitter, state, surface, &url, "tls_certificate");
        }
    }
}

fn exact_surface(
    state: &BrowserHostState,
    reference: &BrowserSurfaceRef,
) -> Result<NativeBrowserSurface, BrowserCommandErrorCode> {
    let surfaces = state
        .surfaces
        .lock()
        .map_err(|_| BrowserCommandErrorCode::HostFailure)?;
    match surfaces.resolve_handle(reference) {
        SurfaceHandle::Exact(handle) => Ok(handle),
        SurfaceHandle::Absent => Err(BrowserCommandErrorCode::SurfaceNotFound),
        SurfaceHandle::Stale(_) => Err(BrowserCommandErrorCode::StaleGeneration),
    }
}

fn emit_browser_event<R: tauri::Runtime, E: Emitter<R>>(
    emitter: &E,
    state: &BrowserHostState,
    surface: &BrowserSurfaceRef,
    event: BrowserEvent,
) {
    if let Some(envelope) = state.lifecycle.envelope(surface, event) {
        let _ = emitter.emit_to(MAIN_WEBVIEW_LABEL, BROWSER_EVENT_TOPIC, envelope);
    }
}

fn emit_bridge_result<R: tauri::Runtime, E: Emitter<R>>(
    emitter: &E,
    state: &BrowserHostState,
    surface: &BrowserSurfaceRef,
    result: Result<super::bridge::BrowserBridgeEnvelope, super::bridge::BrowserBridgeError>,
) {
    match result {
        Ok(envelope) => match serde_json::to_value(envelope) {
            Ok(bridge_envelope) => emit_browser_event(
                emitter,
                state,
                surface,
                BrowserEvent::BridgeMessage(BridgeMessagePayload { bridge_envelope }),
            ),
            Err(_) => emit_browser_event(
                emitter,
                state,
                surface,
                BrowserEvent::BridgeError(BridgeErrorPayload {
                    code: "serialization_failed".to_string(),
                }),
            ),
        },
        Err(error) => emit_browser_event(
            emitter,
            state,
            surface,
            BrowserEvent::BridgeError(BridgeErrorPayload {
                code: error.code().to_string(),
            }),
        ),
    }
}

fn emit_navigation_failed<R: tauri::Runtime, E: Emitter<R>>(
    emitter: &E,
    state: &BrowserHostState,
    surface: &BrowserSurfaceRef,
    url: &str,
    category: &str,
) {
    emit_browser_event(
        emitter,
        state,
        surface,
        BrowserEvent::NavigationFailed(NavigationFailedPayload {
            url: url.to_string(),
            is_main_frame: true,
            error_category: category.to_string(),
        }),
    );
    emit_browser_event(
        emitter,
        state,
        surface,
        BrowserEvent::PageLoading(PageLoadingPayload { loading: false }),
    );
}

fn emit_capture_failed<R: tauri::Runtime, E: Emitter<R>>(
    emitter: &E,
    state: &BrowserHostState,
    surface: &BrowserSurfaceRef,
    capture_request_id: &str,
    error_category: &str,
) {
    emit_browser_event(
        emitter,
        state,
        surface,
        BrowserEvent::CaptureFailed(CaptureFailedPayload {
            capture_request_id: capture_request_id.to_string(),
            error_category: error_category.to_string(),
        }),
    );
}

fn composition_webview2_capabilities() -> Vec<String> {
    [
        "permission_requested",
        "process_failed",
        "download_progress",
        "file_chooser_observation",
        "find_in_page",
        "fixed_web_message_bridge",
        "native_region_capture",
        "native_element_inspection",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

pub(crate) fn parse_browser_url(
    value: &str,
    allow_internal_blank: bool,
) -> Result<Url, BrowserCommandError> {
    let url = value.parse::<Url>().map_err(|_| {
        error(
            BrowserCommandErrorCode::InvalidRequest,
            "Browser URL is invalid",
            false,
        )
    })?;
    if !is_allowed_browser_url(&url, allow_internal_blank) {
        return Err(error(
            BrowserCommandErrorCode::PolicyDenied,
            "Browser URL scheme is not allowed",
            false,
        ));
    }
    Ok(url)
}

pub(crate) fn is_allowed_browser_url(url: &Url, allow_internal_blank: bool) -> bool {
    matches!(url.scheme(), "http" | "https")
        || (allow_internal_blank && url.as_str() == "about:blank")
}

fn success(request_id: String) -> BrowserCommandResponse {
    BrowserCommandResponse {
        ok: true,
        request_id,
        error: None,
    }
}

fn invalid_request(request_id: String, message: &str) -> BrowserCommandResponse {
    failure(
        request_id,
        error(BrowserCommandErrorCode::InvalidRequest, message, false),
    )
}

fn stale_generation(request_id: String) -> BrowserCommandResponse {
    failure(
        request_id,
        error(
            BrowserCommandErrorCode::StaleGeneration,
            "Surface generation is stale",
            false,
        ),
    )
}

fn surface_resolution_failure(
    request_id: String,
    code: BrowserCommandErrorCode,
) -> BrowserCommandResponse {
    match code {
        BrowserCommandErrorCode::StaleGeneration => stale_generation(request_id),
        BrowserCommandErrorCode::HostFailure => {
            host_failure(request_id, "BrowserHost surface table is unavailable")
        }
        _ => failure(
            request_id,
            error(
                BrowserCommandErrorCode::SurfaceNotFound,
                "Browser surface was not found",
                false,
            ),
        ),
    }
}

fn host_failure(request_id: String, message: &str) -> BrowserCommandResponse {
    failure(
        request_id,
        error(BrowserCommandErrorCode::HostFailure, message, true),
    )
}

fn bridge_command_failure(
    request_id: String,
    bridge_error: super::bridge::BrowserBridgeError,
) -> BrowserCommandResponse {
    failure(
        request_id,
        error(
            BrowserCommandErrorCode::UnsupportedOperation,
            &format!(
                "Web annotation Bridge is not ready: {}",
                bridge_error.code()
            ),
            matches!(
                bridge_error,
                super::bridge::BrowserBridgeError::StaleFrame
                    | super::bridge::BrowserBridgeError::StaleNavigation
            ),
        ),
    )
}

fn error(code: BrowserCommandErrorCode, message: &str, retryable: bool) -> BrowserCommandError {
    BrowserCommandError {
        code,
        message: message.to_string(),
        retryable,
    }
}

fn failure(request_id: String, error: BrowserCommandError) -> BrowserCommandResponse {
    BrowserCommandResponse {
        ok: false,
        request_id,
        error: Some(error),
    }
}

fn debug_managed_root(_variable: &str, fallback: &Path) -> PathBuf {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os(_variable).map(PathBuf::from) {
        if path.is_absolute() {
            return path;
        }
    }
    fallback.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_policy_allows_only_remote_http_and_internal_blank() {
        assert!(parse_browser_url("https://example.com/docs", false).is_ok());
        assert!(parse_browser_url("http://127.0.0.1:4173/probe", false).is_ok());
        assert!(parse_browser_url("about:blank", true).is_ok());
        for denied in [
            "about:blank",
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///C:/secret.txt",
            "blob:https://example.com/id",
            "keydex://browser",
            "not a url",
        ] {
            assert!(parse_browser_url(denied, false).is_err(), "{denied}");
        }
    }

    #[test]
    fn command_responses_keep_success_and_failure_shapes() {
        assert!(success("request-1".to_string()).validate().is_ok());
        assert!(surface_resolution_failure(
            "request-2".to_string(),
            BrowserCommandErrorCode::SurfaceNotFound,
        )
        .validate()
        .is_ok());
        assert_eq!(composition_webview2_capabilities().len(), 8);
    }

    #[test]
    fn managed_test_roots_refuse_relative_environment_paths() {
        let fallback = PathBuf::from("C:/safe/fallback");
        std::env::set_var("KEYDEX_BROWSER_PROFILE_ROOT", "relative-profile");
        assert_eq!(
            debug_managed_root("KEYDEX_BROWSER_PROFILE_ROOT", &fallback),
            fallback
        );
        std::env::remove_var("KEYDEX_BROWSER_PROFILE_ROOT");
    }
}
