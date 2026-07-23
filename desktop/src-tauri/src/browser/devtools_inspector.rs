use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use serde_json::{json, Value};

#[cfg(windows)]
use std::{cell::RefCell, rc::Rc};

use super::{
    bridge::{validate_live_node_binding, validate_web_annotation_target},
    contract::BrowserSurfaceRef,
    ui_actor::NativeBrowserSurface,
};

const DEVTOOLS_TIMEOUT: Duration = Duration::from_secs(4);
const ELEMENT_TARGET_FUNCTION: &str = include_str!("devtools_element_target.js");
const NATIVE_SELECTION_FUNCTION: &str = r#"function (detail) {
  const view = this && this.ownerDocument && this.ownerDocument.defaultView;
  if (!view || !detail) return { opened: false, reason: 'target_realm_unavailable' };
  const binding = view.KeydexAnnotationBridge?.nodeBindings?.bindSelection?.(
    detail.selectionId,
    this,
  );
  if (!binding) return { opened: false, reason: 'node_binding_unavailable' };
  const nextDetail = { ...detail, binding };
  const api = view.KeydexAnnotationOverlay;
  if (api && typeof api.openNativeEditor === 'function') {
    return {
      opened: api.openNativeEditor(nextDetail) === true,
      reason: 'direct_bridge',
      binding,
    };
  }
  view.dispatchEvent(new view.CustomEvent('keydex:web-annotation-native-selection', {
    detail: Object.freeze(nextDetail),
  }));
  const root = view.document.querySelector('[data-keydex-annotation-overlay-root="true"]');
  return {
    opened: Boolean(root && root.shadowRoot && root.shadowRoot.querySelector('[part="annotation-editor"]')),
    reason: 'event_fallback',
    binding,
  };
}"#;
const NATIVE_HIGHLIGHT_FUNCTION: &str = r#"function (detail) {
  const view = this && this.ownerDocument && this.ownerDocument.defaultView;
  const api = view && view.KeydexAnnotationOverlay;
  if (!api || typeof api.openNativeHighlight !== 'function') {
    return { opened: false, reason: 'page_bridge_unavailable' };
  }
  return {
    opened: api.openNativeHighlight(detail.annotationId) === true,
    reason: 'direct_bridge',
  };
}"#;
const ROOT_SESSION: &str = "";

#[cfg(windows)]
pub(crate) async fn configure_native_auto_dark_mode(
    webview: &NativeBrowserSurface,
    enabled: bool,
) -> Result<(), String> {
    call_devtools_method(
        webview,
        ROOT_SESSION,
        "Emulation.setAutoDarkModeOverride",
        json!({ "enabled": enabled }),
    )
    .await
    .map(|_| ())
}

#[cfg(not(windows))]
pub(crate) async fn configure_native_auto_dark_mode(
    _webview: &NativeBrowserSurface,
    _enabled: bool,
) -> Result<(), String> {
    Err("Chromium auto dark mode is unavailable on this platform".to_string())
}

#[derive(Debug, Clone)]
pub(crate) enum NativeInspectorEvent {
    Selected {
        selection_request_id: String,
        frame_key: String,
        target: Value,
        binding: Value,
    },
    Cancelled {
        selection_request_id: String,
        reason: String,
    },
    Failed {
        selection_request_id: String,
        error_category: String,
        message: String,
    },
}

pub(crate) type NativeInspectorRoute = Arc<dyn Fn(NativeInspectorEvent) + Send + Sync>;

#[derive(Debug, Clone, Copy)]
struct InspectorColor {
    red: u8,
    green: u8,
    blue: u8,
}

impl Default for InspectorColor {
    fn default() -> Self {
        Self {
            red: 216,
            green: 117,
            blue: 117,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionPhase {
    Inspecting,
    Resolving,
    Draft,
    Cancelling,
}

#[derive(Debug, Clone)]
struct ActiveSelection {
    request_id: String,
    phase: SelectionPhase,
    session_id: String,
}

#[derive(Debug, Clone)]
struct InspectorSurface {
    reference: BrowserSurfaceRef,
    accent: InspectorColor,
    sessions: HashSet<String>,
    active: Option<ActiveSelection>,
}

#[derive(Debug, Clone)]
struct InspectClaim {
    request_id: String,
    sessions: Vec<String>,
}

#[derive(Debug, Clone)]
struct SessionActivation {
    request_id: String,
    accent: InspectorColor,
}

#[derive(Debug, Clone)]
struct SelectionSnapshot {
    request_id: String,
    phase: SelectionPhase,
    session_id: String,
    sessions: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct BrowserDevToolsInspector {
    surfaces: Arc<Mutex<HashMap<String, InspectorSurface>>>,
}

impl BrowserDevToolsInspector {
    pub(crate) fn register_surface(&self, surface: BrowserSurfaceRef) {
        if let Ok(mut surfaces) = self.surfaces.lock() {
            let mut sessions = HashSet::new();
            sessions.insert(ROOT_SESSION.to_string());
            surfaces.insert(
                surface_key(&surface),
                InspectorSurface {
                    reference: surface,
                    accent: InspectorColor::default(),
                    sessions,
                    active: None,
                },
            );
        }
    }

    pub(crate) fn configure_accent(&self, surface: &BrowserSurfaceRef, value: &str) {
        let Some(color) = parse_css_hex_color(value) else {
            return;
        };
        if let Ok(mut surfaces) = self.surfaces.lock() {
            if let Some(current) = surfaces.get_mut(&surface_key(surface)) {
                if current.reference == *surface {
                    current.accent = color;
                }
            }
        }
    }

    pub(crate) fn remove_surface(&self, surface: &BrowserSurfaceRef) -> Option<String> {
        let current = self.surfaces.lock().ok()?.remove(&surface_key(surface))?;
        if current.reference != *surface {
            return None;
        }
        current.active.map(|active| active.request_id)
    }

    pub(crate) fn abandon_selection(&self, surface: &BrowserSurfaceRef) -> Option<String> {
        let mut surfaces = self.surfaces.lock().ok()?;
        let current = surfaces.get_mut(&surface_key(surface))?;
        if current.reference != *surface {
            return None;
        }
        current.active.take().map(|active| active.request_id)
    }

    fn begin_selection(
        &self,
        surface: &BrowserSurfaceRef,
        request_id: &str,
    ) -> Result<InspectorColor, String> {
        let mut surfaces = self
            .surfaces
            .lock()
            .map_err(|_| "Native element inspector state is unavailable".to_string())?;
        let current = surfaces
            .get_mut(&surface_key(surface))
            .filter(|current| current.reference == *surface)
            .ok_or_else(|| {
                "Native element inspector is not attached to this surface".to_string()
            })?;
        if current.active.is_some() {
            return Err("Native element inspector already has an active selection".to_string());
        }
        current.active = Some(ActiveSelection {
            request_id: request_id.to_string(),
            phase: SelectionPhase::Inspecting,
            session_id: ROOT_SESSION.to_string(),
        });
        Ok(current.accent)
    }

    fn clear_selection_if_matches(&self, surface: &BrowserSurfaceRef, request_id: &str) -> bool {
        let Ok(mut surfaces) = self.surfaces.lock() else {
            return false;
        };
        let Some(current) = surfaces.get_mut(&surface_key(surface)) else {
            return false;
        };
        if current.reference != *surface
            || current
                .active
                .as_ref()
                .map(|active| active.request_id.as_str())
                != Some(request_id)
        {
            return false;
        }
        current.active = None;
        true
    }

    fn claim_node(&self, surface: &BrowserSurfaceRef, session_id: &str) -> Option<InspectClaim> {
        let mut surfaces = self.surfaces.lock().ok()?;
        let current = surfaces.get_mut(&surface_key(surface))?;
        if current.reference != *surface {
            return None;
        }
        let active = current.active.as_mut()?;
        if active.phase != SelectionPhase::Inspecting {
            return None;
        }
        active.phase = SelectionPhase::Resolving;
        active.session_id = session_id.to_string();
        Some(InspectClaim {
            request_id: active.request_id.clone(),
            sessions: current.sessions.iter().cloned().collect(),
        })
    }

    fn cancel_from_engine(&self, surface: &BrowserSurfaceRef) -> Option<String> {
        let mut surfaces = self.surfaces.lock().ok()?;
        let current = surfaces.get_mut(&surface_key(surface))?;
        if current.reference != *surface
            || current.active.as_ref()?.phase != SelectionPhase::Inspecting
        {
            return None;
        }
        current.active.take().map(|active| active.request_id)
    }

    fn mark_draft_if_matches(
        &self,
        surface: &BrowserSurfaceRef,
        request_id: &str,
        session_id: &str,
    ) -> bool {
        let Ok(mut surfaces) = self.surfaces.lock() else {
            return false;
        };
        let Some(current) = surfaces.get_mut(&surface_key(surface)) else {
            return false;
        };
        let Some(active) = current.active.as_mut() else {
            return false;
        };
        if current.reference != *surface
            || active.request_id != request_id
            || active.phase != SelectionPhase::Resolving
        {
            return false;
        }
        active.phase = SelectionPhase::Draft;
        active.session_id = session_id.to_string();
        true
    }

    fn add_session(
        &self,
        surface: &BrowserSurfaceRef,
        session_id: String,
    ) -> Option<SessionActivation> {
        let mut surfaces = self.surfaces.lock().ok()?;
        let current = surfaces.get_mut(&surface_key(surface))?;
        if current.reference != *surface {
            return None;
        }
        current.sessions.insert(session_id);
        current
            .active
            .as_ref()
            .filter(|active| active.phase == SelectionPhase::Inspecting)
            .map(|active| SessionActivation {
                request_id: active.request_id.clone(),
                accent: current.accent,
            })
    }

    fn record_session(&self, surface: &BrowserSurfaceRef, session_id: String) {
        if let Ok(mut surfaces) = self.surfaces.lock() {
            if let Some(current) = surfaces.get_mut(&surface_key(surface)) {
                if current.reference == *surface {
                    current.sessions.insert(session_id);
                }
            }
        }
    }

    fn is_inspecting_request(&self, surface: &BrowserSurfaceRef, request_id: &str) -> bool {
        let Ok(surfaces) = self.surfaces.lock() else {
            return false;
        };
        let Some(current) = surfaces.get(&surface_key(surface)) else {
            return false;
        };
        current.reference == *surface
            && current.active.as_ref().is_some_and(|active| {
                active.request_id == request_id && active.phase == SelectionPhase::Inspecting
            })
    }

    fn remove_session(&self, surface: &BrowserSurfaceRef, session_id: &str) {
        if let Ok(mut surfaces) = self.surfaces.lock() {
            if let Some(current) = surfaces.get_mut(&surface_key(surface)) {
                if current.reference == *surface {
                    current.sessions.remove(session_id);
                }
            }
        }
    }

    fn selection_snapshot(&self, surface: &BrowserSurfaceRef) -> Option<SelectionSnapshot> {
        let surfaces = self.surfaces.lock().ok()?;
        let current = surfaces.get(&surface_key(surface))?;
        if current.reference != *surface {
            return None;
        }
        let active = current.active.as_ref()?;
        Some(SelectionSnapshot {
            request_id: active.request_id.clone(),
            phase: active.phase,
            session_id: active.session_id.clone(),
            sessions: current.sessions.iter().cloned().collect(),
        })
    }

    fn surface_sessions(&self, surface: &BrowserSurfaceRef) -> Result<Vec<String>, String> {
        let surfaces = self
            .surfaces
            .lock()
            .map_err(|_| "Native element inspector state is unavailable".to_string())?;
        let current = surfaces
            .get(&surface_key(surface))
            .filter(|current| current.reference == *surface)
            .ok_or_else(|| {
                "Native element inspector is not attached to this surface".to_string()
            })?;
        Ok(current.sessions.iter().cloned().collect())
    }

    fn begin_cancel(&self, surface: &BrowserSurfaceRef) -> Option<SelectionSnapshot> {
        let mut surfaces = self.surfaces.lock().ok()?;
        let current = surfaces.get_mut(&surface_key(surface))?;
        if current.reference != *surface {
            return None;
        }
        let active = current.active.as_mut()?;
        let snapshot = SelectionSnapshot {
            request_id: active.request_id.clone(),
            phase: active.phase,
            session_id: active.session_id.clone(),
            sessions: current.sessions.iter().cloned().collect(),
        };
        active.phase = SelectionPhase::Cancelling;
        Some(snapshot)
    }

    fn clear_failed_selection_if_matches(
        &self,
        surface: &BrowserSurfaceRef,
        request_id: &str,
    ) -> bool {
        let Ok(mut surfaces) = self.surfaces.lock() else {
            return false;
        };
        let Some(current) = surfaces.get_mut(&surface_key(surface)) else {
            return false;
        };
        if current.reference != *surface
            || current.active.as_ref().is_none_or(|active| {
                active.request_id != request_id || active.phase == SelectionPhase::Cancelling
            })
        {
            return false;
        }
        current.active = None;
        true
    }
}

#[cfg(windows)]
pub(crate) fn attach_windows_devtools_inspector(
    webview: &NativeBrowserSurface,
    inspector: BrowserDevToolsInspector,
    surface: BrowserSurfaceRef,
    route: NativeInspectorRoute,
) -> Result<(), String> {
    use webview2_com::DevToolsProtocolEventReceivedEventHandler;
    use windows_061::core::HSTRING;

    inspector.register_surface(surface.clone());
    webview.run(move |surface_handle| unsafe {
        let core = surface_handle.core();

        let inspect_receiver = core
            .GetDevToolsProtocolEventReceiver(&HSTRING::from("Overlay.inspectNodeRequested"))
            .map_err(|error| format!("Chromium inspect event is unavailable: {error}"))?;
        let inspect_core = core.clone();
        let inspect_state = inspector.clone();
        let inspect_surface = surface.clone();
        let inspect_route = route.clone();
        let mut inspect_token = 0_i64;
        let _ = inspect_receiver.add_DevToolsProtocolEventReceived(
            &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let parameters = devtools_event_parameters(&args)?;
                let Some(backend_node_id) = parameters.get("backendNodeId").and_then(Value::as_u64)
                else {
                    return Ok(());
                };
                let session_id = devtools_event_session_id(&args).unwrap_or_default();
                inspect_state.record_session(&inspect_surface, session_id.clone());
                let Some(claim) = inspect_state.claim_node(&inspect_surface, &session_id) else {
                    return Ok(());
                };
                deactivate_sessions_on_core(&inspect_core, &claim.sessions);
                resolve_selected_node(
                    inspect_core.clone(),
                    session_id,
                    backend_node_id,
                    inspect_state.clone(),
                    inspect_surface.clone(),
                    claim.request_id,
                    inspect_route.clone(),
                );
                Ok(())
            })),
            &mut inspect_token,
        );

        let cancelled_receiver = core
            .GetDevToolsProtocolEventReceiver(&HSTRING::from("Overlay.inspectModeCanceled"))
            .map_err(|error| format!("Chromium inspect cancel event is unavailable: {error}"))?;
        let cancelled_state = inspector.clone();
        let cancelled_surface = surface.clone();
        let cancelled_route = route.clone();
        let mut cancelled_token = 0_i64;
        let _ = cancelled_receiver.add_DevToolsProtocolEventReceived(
            &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, _| {
                if let Some(selection_request_id) =
                    cancelled_state.cancel_from_engine(&cancelled_surface)
                {
                    cancelled_route(NativeInspectorEvent::Cancelled {
                        selection_request_id,
                        reason: "user".to_string(),
                    });
                }
                Ok(())
            })),
            &mut cancelled_token,
        );

        let attached_receiver = core
            .GetDevToolsProtocolEventReceiver(&HSTRING::from("Target.attachedToTarget"))
            .map_err(|error| format!("Chromium target attach event is unavailable: {error}"))?;
        let attached_core = core.clone();
        let attached_state = inspector.clone();
        let attached_surface = surface.clone();
        let attached_route = route.clone();
        let mut attached_token = 0_i64;
        let _ = attached_receiver.add_DevToolsProtocolEventReceived(
            &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let parameters = devtools_event_parameters(&args)?;
                let Some(session_id) = parameters.get("sessionId").and_then(Value::as_str) else {
                    return Ok(());
                };
                let session_id = session_id.to_string();
                if let Some(activation) =
                    attached_state.add_session(&attached_surface, session_id.clone())
                {
                    activate_session_on_core(
                        attached_core.clone(),
                        session_id,
                        activation,
                        attached_state.clone(),
                        attached_surface.clone(),
                        attached_route.clone(),
                    );
                }
                Ok(())
            })),
            &mut attached_token,
        );

        let detached_receiver = core
            .GetDevToolsProtocolEventReceiver(&HSTRING::from("Target.detachedFromTarget"))
            .map_err(|error| format!("Chromium target detach event is unavailable: {error}"))?;
        let detached_state = inspector;
        let detached_surface = surface;
        let mut detached_token = 0_i64;
        detached_receiver
            .add_DevToolsProtocolEventReceived(
                &DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    let parameters = devtools_event_parameters(&args)?;
                    if let Some(session_id) = parameters.get("sessionId").and_then(Value::as_str) {
                        detached_state.remove_session(&detached_surface, session_id);
                    }
                    Ok(())
                })),
                &mut detached_token,
            )
            .map_err(|error| {
                format!("Failed to attach Chromium target detach observer: {error}")
            })?;
        Ok(())
    })
}

#[cfg(not(windows))]
pub(crate) fn attach_windows_devtools_inspector(
    _webview: &NativeBrowserSurface,
    inspector: BrowserDevToolsInspector,
    surface: BrowserSurfaceRef,
    _route: NativeInspectorRoute,
) -> Result<(), String> {
    inspector.register_surface(surface);
    Ok(())
}

#[cfg(windows)]
pub(crate) async fn start_native_element_selection(
    webview: &NativeBrowserSurface,
    inspector: &BrowserDevToolsInspector,
    surface: &BrowserSurfaceRef,
    selection_request_id: &str,
) -> Result<(), String> {
    force_deactivate_on_webview(webview, inspector.surface_sessions(surface)?).await;
    inspector.abandon_selection(surface);
    let accent = inspector.begin_selection(surface, selection_request_id)?;
    let result = async {
        call_devtools_method(
            webview,
            ROOT_SESSION,
            "Target.setAutoAttach",
            json!({
                "autoAttach": true,
                "waitForDebuggerOnStart": false,
                "flatten": true,
            }),
        )
        .await?;
        call_devtools_method(webview, ROOT_SESSION, "DOM.enable", json!({})).await?;
        call_devtools_method(webview, ROOT_SESSION, "Overlay.enable", json!({})).await?;
        call_devtools_method(
            webview,
            ROOT_SESSION,
            "Overlay.setInspectMode",
            inspect_mode_parameters(accent),
        )
        .await?;
        Ok(())
    }
    .await;
    if result.is_err() {
        inspector.clear_selection_if_matches(surface, selection_request_id);
    }
    result
}

#[cfg(not(windows))]
pub(crate) async fn start_native_element_selection(
    _webview: &NativeBrowserSurface,
    _inspector: &BrowserDevToolsInspector,
    _surface: &BrowserSurfaceRef,
    _selection_request_id: &str,
) -> Result<(), String> {
    Err("Native Chromium element inspection requires Windows WebView2".to_string())
}

#[cfg(windows)]
pub(crate) async fn cancel_native_element_selection(
    webview: &NativeBrowserSurface,
    inspector: &BrowserDevToolsInspector,
    surface: &BrowserSurfaceRef,
) -> Result<Option<String>, String> {
    let snapshot = inspector.begin_cancel(surface);
    let mut sessions = inspector.surface_sessions(surface)?;
    if let Some(snapshot) = &snapshot {
        sessions.push(snapshot.session_id.clone());
    }
    force_deactivate_on_webview(webview, sessions).await;
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    if snapshot.phase == SelectionPhase::Draft {
        let expression = format!(
            "window.dispatchEvent(new CustomEvent('keydex:web-annotation-native-cancel',{{detail:{{selectionId:{}}}}}))",
            serde_json::to_string(&snapshot.request_id)
                .expect("validated selection request ID serializes")
        );
        let _ = call_devtools_method(
            webview,
            &snapshot.session_id,
            "Runtime.evaluate",
            json!({ "expression": expression, "silent": true }),
        )
        .await;
    }
    inspector.clear_selection_if_matches(surface, &snapshot.request_id);
    Ok(Some(snapshot.request_id))
}

#[cfg(not(windows))]
pub(crate) async fn cancel_native_element_selection(
    _webview: &NativeBrowserSurface,
    inspector: &BrowserDevToolsInspector,
    surface: &BrowserSurfaceRef,
) -> Result<Option<String>, String> {
    Ok(inspector.abandon_selection(surface))
}

#[cfg(windows)]
fn resolve_selected_node(
    core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    session_id: String,
    backend_node_id: u64,
    inspector: BrowserDevToolsInspector,
    surface: BrowserSurfaceRef,
    selection_request_id: String,
    route: NativeInspectorRoute,
) {
    let object_group = format!("keydex-annotation-{selection_request_id}");
    let resolve_group = object_group.clone();
    let resolve_core = core.clone();
    let resolve_session = session_id.clone();
    let resolve_inspector = inspector.clone();
    let resolve_surface = surface.clone();
    let resolve_request = selection_request_id.clone();
    let resolve_route = route.clone();
    let dispatch = unsafe {
        call_devtools_on_core(
            &core,
            &session_id,
            "DOM.resolveNode",
            json!({
                "backendNodeId": backend_node_id,
                "objectGroup": object_group,
            }),
            Box::new(move |result| match result {
                Ok(value) => {
                    let Some(object_id) = value
                        .get("object")
                        .and_then(|object| object.get("objectId"))
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned)
                    else {
                        finish_with_failure(
                            &resolve_inspector,
                            &resolve_surface,
                            &resolve_request,
                            &resolve_route,
                            "node_resolution_failed",
                            "Chromium did not expose the selected DOM node",
                        );
                        return;
                    };
                    call_target_function(
                        resolve_core,
                        resolve_session,
                        object_id,
                        resolve_group,
                        resolve_inspector,
                        resolve_surface,
                        resolve_request,
                        resolve_route,
                    );
                }
                Err(reason) => finish_with_failure(
                    &resolve_inspector,
                    &resolve_surface,
                    &resolve_request,
                    &resolve_route,
                    "node_resolution_failed",
                    &reason,
                ),
            }),
        )
    };
    if let Err(reason) = dispatch {
        finish_with_failure(
            &inspector,
            &surface,
            &selection_request_id,
            &route,
            "node_resolution_failed",
            &reason,
        );
    }
}

#[cfg(windows)]
fn call_target_function(
    core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    session_id: String,
    object_id: String,
    object_group: String,
    inspector: BrowserDevToolsInspector,
    surface: BrowserSurfaceRef,
    selection_request_id: String,
    route: NativeInspectorRoute,
) {
    let release_core = core.clone();
    let release_session = session_id.clone();
    let release_group = object_group.clone();
    let result_object_id = object_id.clone();
    let result_inspector = inspector.clone();
    let result_surface = surface.clone();
    let result_request = selection_request_id.clone();
    let result_route = route.clone();
    let dispatch = unsafe {
        call_devtools_on_core(
            &core,
            &session_id,
            "Runtime.callFunctionOn",
            json!({
                "functionDeclaration": ELEMENT_TARGET_FUNCTION,
                "objectId": object_id,
                "returnByValue": true,
                "awaitPromise": false,
                "silent": true,
                "objectGroup": object_group,
            }),
            Box::new(move |result| match result {
                Ok(value) => {
                    let Some(target) = value
                        .get("result")
                        .and_then(|result| result.get("value"))
                        .cloned()
                    else {
                        release_object_group_on_core(
                            &release_core,
                            &release_session,
                            &release_group,
                        );
                        finish_with_failure(
                            &result_inspector,
                            &result_surface,
                            &result_request,
                            &result_route,
                            "target_serialization_failed",
                            "Chromium could not serialize the selected element",
                        );
                        return;
                    };
                    if let Some(annotation_id) = native_highlight_annotation_id(&target) {
                        let Some(snapshot) = result_inspector.selection_snapshot(&result_surface)
                        else {
                            release_object_group_on_core(
                                &release_core,
                                &release_session,
                                &release_group,
                            );
                            return;
                        };
                        if snapshot.request_id != result_request
                            || snapshot.phase != SelectionPhase::Resolving
                        {
                            release_object_group_on_core(
                                &release_core,
                                &release_session,
                                &release_group,
                            );
                            return;
                        }
                        let mut sessions = snapshot.sessions;
                        sessions.push(release_session.clone());
                        sessions.sort();
                        sessions.dedup();
                        let barrier_core = release_core.clone();
                        let barrier_session = release_session.clone();
                        let barrier_inspector = result_inspector.clone();
                        let barrier_surface = result_surface.clone();
                        let barrier_request = result_request.clone();
                        let barrier_route = result_route.clone();
                        let marker_object_id = result_object_id.clone();
                        force_deactivate_sessions_on_core_then(
                            release_core,
                            sessions,
                            Box::new(move || {
                                present_native_highlight(
                                    barrier_core,
                                    barrier_session,
                                    marker_object_id,
                                    release_group,
                                    annotation_id,
                                    barrier_inspector,
                                    barrier_surface,
                                    barrier_request,
                                    barrier_route,
                                )
                            }),
                        );
                        return;
                    }
                    if validate_web_annotation_target(&target).is_err() {
                        release_object_group_on_core(
                            &release_core,
                            &release_session,
                            &release_group,
                        );
                        finish_with_failure(
                                &result_inspector,
                                &result_surface,
                                &result_request,
                                &result_route,
                                "invalid_selection",
                                "The selected Chromium node cannot be persisted as an annotation target",
                            );
                        return;
                    }
                    let Some(snapshot) = result_inspector.selection_snapshot(&result_surface)
                    else {
                        release_object_group_on_core(
                            &release_core,
                            &release_session,
                            &release_group,
                        );
                        return;
                    };
                    if snapshot.request_id != result_request
                        || snapshot.phase != SelectionPhase::Resolving
                    {
                        release_object_group_on_core(
                            &release_core,
                            &release_session,
                            &release_group,
                        );
                        return;
                    }
                    let mut sessions = snapshot.sessions;
                    sessions.push(release_session.clone());
                    sessions.sort();
                    sessions.dedup();
                    let barrier_core = release_core.clone();
                    let barrier_session = release_session.clone();
                    let barrier_inspector = result_inspector.clone();
                    let barrier_surface = result_surface.clone();
                    let barrier_request = result_request.clone();
                    let barrier_route = result_route.clone();
                    force_deactivate_sessions_on_core_then(
                        release_core,
                        sessions,
                        Box::new(move || {
                            present_native_selection(
                                barrier_core,
                                barrier_session,
                                result_object_id,
                                release_group,
                                target,
                                barrier_inspector,
                                barrier_surface,
                                barrier_request,
                                barrier_route,
                            )
                        }),
                    );
                }
                Err(reason) => {
                    release_object_group_on_core(&release_core, &release_session, &release_group);
                    finish_with_failure(
                        &result_inspector,
                        &result_surface,
                        &result_request,
                        &result_route,
                        "target_serialization_failed",
                        &reason,
                    );
                }
            }),
        )
    };
    if let Err(reason) = dispatch {
        release_object_group_on_core(&core, &session_id, &object_group);
        finish_with_failure(
            &inspector,
            &surface,
            &selection_request_id,
            &route,
            "target_serialization_failed",
            &reason,
        );
    }
}

#[cfg(windows)]
fn present_native_highlight(
    core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    session_id: String,
    object_id: String,
    object_group: String,
    annotation_id: String,
    inspector: BrowserDevToolsInspector,
    surface: BrowserSurfaceRef,
    selection_request_id: String,
    route: NativeInspectorRoute,
) {
    let is_resolving = inspector
        .selection_snapshot(&surface)
        .is_some_and(|snapshot| {
            snapshot.request_id == selection_request_id
                && snapshot.phase == SelectionPhase::Resolving
        });
    if !is_resolving {
        release_object_group_on_core(&core, &session_id, &object_group);
        return;
    }
    let release_core = core.clone();
    let release_session = session_id.clone();
    let release_group = object_group.clone();
    let callback_inspector = inspector.clone();
    let callback_surface = surface.clone();
    let callback_request = selection_request_id.clone();
    let callback_route = route.clone();
    let dispatch = unsafe {
        call_devtools_on_core(
            &core,
            &session_id,
            "Runtime.callFunctionOn",
            json!({
                "functionDeclaration": NATIVE_HIGHLIGHT_FUNCTION,
                "objectId": object_id,
                "arguments": [{ "value": { "annotationId": annotation_id } }],
                "returnByValue": true,
                "awaitPromise": false,
                "silent": true,
                "objectGroup": object_group,
            }),
            Box::new(move |result| {
                release_object_group_on_core(&release_core, &release_session, &release_group);
                match result {
                    Ok(value) => {
                        let opened = value
                            .get("result")
                            .and_then(|result| result.get("value"))
                            .and_then(|value| value.get("opened"))
                            .and_then(Value::as_bool)
                            == Some(true);
                        if opened {
                            return;
                        }
                        let reason = value
                            .get("result")
                            .and_then(|result| result.get("value"))
                            .and_then(|value| value.get("reason"))
                            .and_then(Value::as_str)
                            .unwrap_or("annotation_highlight_unavailable");
                        finish_with_failure(
                            &callback_inspector,
                            &callback_surface,
                            &callback_request,
                            &callback_route,
                            "annotation_highlight_open_failed",
                            &format!("Existing web annotation did not open: {reason}"),
                        );
                    }
                    Err(reason) => finish_with_failure(
                        &callback_inspector,
                        &callback_surface,
                        &callback_request,
                        &callback_route,
                        "annotation_highlight_open_failed",
                        &reason,
                    ),
                }
            }),
        )
    };
    if let Err(reason) = dispatch {
        release_object_group_on_core(&core, &session_id, &object_group);
        finish_with_failure(
            &inspector,
            &surface,
            &selection_request_id,
            &route,
            "annotation_highlight_open_failed",
            &reason,
        );
    }
}

fn native_highlight_annotation_id(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    if object.len() != 2
        || object.get("keydexOverlayAction").and_then(Value::as_str)
            != Some("open_existing_annotation")
    {
        return None;
    }
    let annotation_id = object.get("annotationId").and_then(Value::as_str)?.trim();
    if annotation_id.is_empty()
        || annotation_id.len() > 128
        || annotation_id.chars().any(char::is_control)
    {
        return None;
    }
    Some(annotation_id.to_string())
}

#[cfg(windows)]
fn present_native_selection(
    core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    session_id: String,
    object_id: String,
    object_group: String,
    target: Value,
    inspector: BrowserDevToolsInspector,
    surface: BrowserSurfaceRef,
    selection_request_id: String,
    route: NativeInspectorRoute,
) {
    let is_resolving = inspector
        .selection_snapshot(&surface)
        .is_some_and(|snapshot| {
            snapshot.request_id == selection_request_id
                && snapshot.phase == SelectionPhase::Resolving
        });
    if !is_resolving {
        release_object_group_on_core(&core, &session_id, &object_group);
        return;
    }
    let detail = json!({
        "requestId": selection_request_id,
        "selectionId": selection_request_id,
        "target": target,
    });
    let release_core = core.clone();
    let release_session = session_id.clone();
    let release_group = object_group.clone();
    let callback_inspector = inspector.clone();
    let callback_surface = surface.clone();
    let callback_request = selection_request_id.clone();
    let callback_session = session_id.clone();
    let callback_route = route.clone();
    let callback_target = target.clone();
    let dispatch = unsafe {
        call_devtools_on_core(
            &core,
            &session_id,
            "Runtime.callFunctionOn",
            json!({
                "functionDeclaration": NATIVE_SELECTION_FUNCTION,
                "objectId": object_id,
                "arguments": [{ "value": detail }],
                "returnByValue": true,
                "awaitPromise": false,
                "silent": true,
                "objectGroup": object_group,
            }),
            Box::new(move |result| {
                release_object_group_on_core(&release_core, &release_session, &release_group);
                match result {
                    Ok(value) => {
                        let opened = value
                            .get("result")
                            .and_then(|result| result.get("value"))
                            .and_then(|value| value.get("opened"))
                            .and_then(Value::as_bool)
                            == Some(true);
                        if !opened {
                            let reason = value
                                .get("result")
                                .and_then(|result| result.get("value"))
                                .and_then(|value| value.get("reason"))
                                .and_then(Value::as_str)
                                .unwrap_or("page_bridge_unavailable");
                            finish_with_failure(
                                &callback_inspector,
                                &callback_surface,
                                &callback_request,
                                &callback_route,
                                "annotation_editor_open_failed",
                                &format!(
                                    "Structured page annotation editor did not open: {reason}"
                                ),
                            );
                            return;
                        }
                        let Some(binding) = value
                            .get("result")
                            .and_then(|result| result.get("value"))
                            .and_then(|value| value.get("binding"))
                            .cloned()
                            .filter(|binding| validate_live_node_binding(binding).is_ok())
                        else {
                            finish_with_failure(
                                &callback_inspector,
                                &callback_surface,
                                &callback_request,
                                &callback_route,
                                "node_binding_failed",
                                "Chromium did not preserve the selected DOM node binding",
                            );
                            return;
                        };
                        if callback_inspector.mark_draft_if_matches(
                            &callback_surface,
                            &callback_request,
                            &callback_session,
                        ) {
                            callback_route(NativeInspectorEvent::Selected {
                                selection_request_id: callback_request,
                                frame_key: if callback_session.is_empty() {
                                    "main".to_string()
                                } else {
                                    format!("devtools:{}", callback_session)
                                },
                                target: callback_target,
                                binding,
                            });
                        }
                    }
                    Err(reason) => finish_with_failure(
                        &callback_inspector,
                        &callback_surface,
                        &callback_request,
                        &callback_route,
                        "annotation_editor_open_failed",
                        &reason,
                    ),
                }
            }),
        )
    };
    if let Err(reason) = dispatch {
        release_object_group_on_core(&core, &session_id, &object_group);
        finish_with_failure(
            &inspector,
            &surface,
            &selection_request_id,
            &route,
            "annotation_editor_open_failed",
            &reason,
        );
    }
}

#[cfg(windows)]
fn release_object_group_on_core(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    session_id: &str,
    object_group: &str,
) {
    unsafe {
        let _ = call_devtools_on_core(
            core,
            session_id,
            "Runtime.releaseObjectGroup",
            json!({ "objectGroup": object_group }),
            Box::new(|_| {}),
        );
    }
}

fn finish_with_failure(
    inspector: &BrowserDevToolsInspector,
    surface: &BrowserSurfaceRef,
    selection_request_id: &str,
    route: &NativeInspectorRoute,
    error_category: &str,
    message: &str,
) {
    if inspector.clear_failed_selection_if_matches(surface, selection_request_id) {
        route(NativeInspectorEvent::Failed {
            selection_request_id: selection_request_id.to_string(),
            error_category: error_category.to_string(),
            message: message.chars().take(512).collect(),
        });
    }
}

#[cfg(windows)]
fn activate_session_on_core(
    core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    session_id: String,
    activation: SessionActivation,
    inspector: BrowserDevToolsInspector,
    surface: BrowserSurfaceRef,
    route: NativeInspectorRoute,
) {
    if !inspector.is_inspecting_request(&surface, &activation.request_id) {
        return;
    }
    let dom_core = core.clone();
    let dom_session = session_id.clone();
    let dom_inspector = inspector.clone();
    let dom_surface = surface.clone();
    let dom_route = route.clone();
    let dom_activation = activation.clone();
    let result = unsafe {
        call_devtools_on_core(
            &core,
            &session_id,
            "DOM.enable",
            json!({}),
            Box::new(move |result| {
                if let Err(reason) = result {
                    fail_session_activation(
                        &dom_inspector,
                        &dom_surface,
                        &dom_route,
                        &dom_activation.request_id,
                        &reason,
                    );
                    return;
                }
                if !dom_inspector.is_inspecting_request(&dom_surface, &dom_activation.request_id) {
                    return;
                }
                let overlay_core = dom_core.clone();
                let overlay_session = dom_session.clone();
                let overlay_inspector = dom_inspector.clone();
                let overlay_surface = dom_surface.clone();
                let overlay_route = dom_route.clone();
                let overlay_activation = dom_activation.clone();
                if let Err(reason) = call_devtools_on_core(
                    &dom_core,
                    &dom_session,
                    "Overlay.enable",
                    json!({}),
                    Box::new(move |result| {
                        if let Err(reason) = result {
                            fail_session_activation(
                                &overlay_inspector,
                                &overlay_surface,
                                &overlay_route,
                                &overlay_activation.request_id,
                                &reason,
                            );
                            return;
                        }
                        if !overlay_inspector
                            .is_inspecting_request(&overlay_surface, &overlay_activation.request_id)
                        {
                            return;
                        }
                        let inspect_inspector = overlay_inspector.clone();
                        let inspect_surface = overlay_surface.clone();
                        let inspect_route = overlay_route.clone();
                        let inspect_request = overlay_activation.request_id.clone();
                        if let Err(reason) = call_devtools_on_core(
                            &overlay_core,
                            &overlay_session,
                            "Overlay.setInspectMode",
                            inspect_mode_parameters(overlay_activation.accent),
                            Box::new(move |result| {
                                if let Err(reason) = result {
                                    fail_session_activation(
                                        &inspect_inspector,
                                        &inspect_surface,
                                        &inspect_route,
                                        &inspect_request,
                                        &reason,
                                    );
                                }
                            }),
                        ) {
                            fail_session_activation(
                                &overlay_inspector,
                                &overlay_surface,
                                &overlay_route,
                                &overlay_activation.request_id,
                                &reason,
                            );
                        }
                    }),
                ) {
                    fail_session_activation(
                        &dom_inspector,
                        &dom_surface,
                        &dom_route,
                        &dom_activation.request_id,
                        &reason,
                    );
                }
            }),
        )
    };
    if let Err(reason) = result {
        fail_session_activation(
            &inspector,
            &surface,
            &route,
            &activation.request_id,
            &reason,
        );
    }
}

fn fail_session_activation(
    inspector: &BrowserDevToolsInspector,
    surface: &BrowserSurfaceRef,
    route: &NativeInspectorRoute,
    selection_request_id: &str,
    reason: &str,
) {
    if inspector.is_inspecting_request(surface, selection_request_id) {
        finish_with_failure(
            inspector,
            surface,
            selection_request_id,
            route,
            "subframe_activation_failed",
            reason,
        );
    }
}

#[cfg(windows)]
fn deactivate_sessions_on_core(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    sessions: &[String],
) {
    force_deactivate_sessions_on_core_then(core.clone(), sessions.to_vec(), Box::new(|| {}));
}

#[cfg(windows)]
struct OverlayCleanupStep {
    session_id: String,
    method: &'static str,
    parameters: Value,
}

#[cfg(windows)]
struct DeactivationBarrier {
    core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    steps: Vec<OverlayCleanupStep>,
    completion: Option<Box<dyn FnOnce()>>,
}

#[cfg(windows)]
fn force_deactivate_sessions_on_core_then(
    core: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    mut sessions: Vec<String>,
    completion: Box<dyn FnOnce()>,
) {
    sessions.sort();
    sessions.dedup();
    let steps = sessions
        .into_iter()
        .flat_map(|session_id| {
            [
                OverlayCleanupStep {
                    session_id: session_id.clone(),
                    method: "Overlay.setInspectMode",
                    parameters: json!({ "mode": "none" }),
                },
                OverlayCleanupStep {
                    session_id: session_id.clone(),
                    method: "Overlay.hideHighlight",
                    parameters: json!({}),
                },
                OverlayCleanupStep {
                    session_id,
                    method: "Overlay.disable",
                    parameters: json!({}),
                },
            ]
        })
        .collect();
    let barrier = Rc::new(RefCell::new(DeactivationBarrier {
        core,
        steps,
        completion: Some(completion),
    }));
    deactivate_next_session(barrier);
}

#[cfg(windows)]
fn deactivate_next_session(barrier: Rc<RefCell<DeactivationBarrier>>) {
    let next = {
        let mut state = barrier.borrow_mut();
        if state.steps.is_empty() {
            let completion = state.completion.take();
            drop(state);
            if let Some(completion) = completion {
                completion();
            }
            return;
        }
        let step = state.steps.remove(0);
        (state.core.clone(), step)
    };

    let callback_barrier = barrier.clone();
    let dispatch = unsafe {
        call_devtools_on_core(
            &next.0,
            &next.1.session_id,
            next.1.method,
            next.1.parameters,
            Box::new(move |_| {
                deactivate_next_session(callback_barrier);
            }),
        )
    };
    if dispatch.is_err() {
        deactivate_next_session(barrier);
    }
}

#[cfg(windows)]
async fn force_deactivate_on_webview(webview: &NativeBrowserSurface, mut sessions: Vec<String>) {
    sessions.sort();
    sessions.dedup();
    for session_id in sessions {
        let _ = call_devtools_method(
            webview,
            &session_id,
            "Overlay.setInspectMode",
            json!({ "mode": "none" }),
        )
        .await;
        let _ =
            call_devtools_method(webview, &session_id, "Overlay.hideHighlight", json!({})).await;
        let _ = call_devtools_method(webview, &session_id, "Overlay.disable", json!({})).await;
    }
}

fn inspect_mode_parameters(accent: InspectorColor) -> Value {
    let color = |alpha| {
        json!({
            "r": accent.red,
            "g": accent.green,
            "b": accent.blue,
            "a": alpha,
        })
    };
    json!({
        "mode": "searchForNode",
        "highlightConfig": {
            // Preserve Chromium's native hit-testing and box-model highlight,
            // but keep Keydex annotation mode visually focused: the DevTools
            // tag/size/style/accessibility tooltip is inspector chrome, not
            // annotation content.
            "showInfo": false,
            "showStyles": false,
            "showAccessibilityInfo": false,
            "contentColor": color(0.12),
            "paddingColor": color(0.18),
            "borderColor": color(0.96),
            "marginColor": color(0.08),
            "shapeColor": color(0.18),
            "shapeMarginColor": color(0.08)
        }
    })
}

#[cfg(windows)]
async fn call_devtools_method(
    webview: &NativeBrowserSurface,
    session_id: &str,
    method: &str,
    parameters: Value,
) -> Result<Value, String> {
    let (sender, receiver) = std::sync::mpsc::sync_channel::<Result<Value, String>>(1);
    let sender = Arc::new(Mutex::new(Some(sender)));
    let method = method.to_string();
    let session_id = session_id.to_string();
    webview
        .run(move |surface_handle| unsafe {
            let core = surface_handle.core();
            let callback_sender = sender.clone();
            if let Err(reason) = call_devtools_on_core(
                core,
                &session_id,
                &method,
                parameters,
                Box::new(move |result| send_devtools_result(&callback_sender, result)),
            ) {
                send_devtools_result(&sender, Err(reason));
            }
            Ok(())
        })
        .map_err(|_| "Browser surface could not schedule a DevTools Protocol call".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(DEVTOOLS_TIMEOUT)
            .map_err(|_| "Timed out while calling the Chromium DevTools Protocol".to_string())?
    })
    .await
    .map_err(|_| "DevTools Protocol wait task failed".to_string())?
}

#[cfg(windows)]
unsafe fn call_devtools_on_core(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    session_id: &str,
    method: &str,
    parameters: Value,
    completion: Box<dyn FnOnce(Result<Value, String>)>,
) -> Result<(), String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_11;
    use windows_061::core::{Interface, HSTRING};

    let method = HSTRING::from(method);
    let parameters = HSTRING::from(parameters.to_string());
    let callback =
        CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, result_json| {
            let result = status
                .map_err(|error| format!("Chromium DevTools Protocol call failed: {error}"))
                .and_then(|_| {
                    serde_json::from_str::<Value>(&result_json)
                        .map_err(|_| "Chromium returned invalid DevTools Protocol JSON".to_string())
                })
                .and_then(|value| {
                    if let Some(error) = value.get("error") {
                        Err(format!(
                            "Chromium DevTools Protocol rejected the call: {error}"
                        ))
                    } else {
                        Ok(value)
                    }
                });
            completion(result);
            Ok(())
        }));
    if session_id.is_empty() {
        core.CallDevToolsProtocolMethod(&method, &parameters, &callback)
            .map_err(|error| format!("WebView2 rejected the DevTools Protocol call: {error}"))
    } else {
        let core11 = core.cast::<ICoreWebView2_11>().map_err(|_| {
            "WebView2 session-scoped DevTools Protocol API is unavailable".to_string()
        })?;
        core11
            .CallDevToolsProtocolMethodForSession(
                &HSTRING::from(session_id),
                &method,
                &parameters,
                &callback,
            )
            .map_err(|error| {
                format!("WebView2 rejected the session DevTools Protocol call: {error}")
            })
    }
}

#[cfg(windows)]
unsafe fn devtools_event_parameters(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DevToolsProtocolEventReceivedEventArgs,
) -> windows_061::core::Result<Value> {
    use windows_061::core::PWSTR;

    let mut raw = PWSTR::null();
    args.ParameterObjectAsJson(&mut raw)?;
    let json = take_windows_string(raw)?;
    Ok(serde_json::from_str(&json).unwrap_or(Value::Null))
}

#[cfg(windows)]
unsafe fn devtools_event_session_id(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DevToolsProtocolEventReceivedEventArgs,
) -> Option<String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DevToolsProtocolEventReceivedEventArgs2;
    use windows_061::core::{Interface, PWSTR};

    let args2 = args
        .cast::<ICoreWebView2DevToolsProtocolEventReceivedEventArgs2>()
        .ok()?;
    let mut raw = PWSTR::null();
    args2.SessionId(&mut raw).ok()?;
    take_windows_string(raw)
        .ok()
        .filter(|value| !value.is_empty())
}

#[cfg(windows)]
unsafe fn take_windows_string(
    value: windows_061::core::PWSTR,
) -> windows_061::core::Result<String> {
    if value.is_null() {
        return Ok(String::new());
    }
    let result = value.to_string().unwrap_or_default();
    windows_061::Win32::System::Com::CoTaskMemFree(Some(value.0.cast()));
    Ok(result)
}

#[cfg(windows)]
fn send_devtools_result(
    sender: &Arc<Mutex<Option<std::sync::mpsc::SyncSender<Result<Value, String>>>>>,
    result: Result<Value, String>,
) {
    if let Ok(mut sender) = sender.lock() {
        if let Some(sender) = sender.take() {
            let _ = sender.send(result);
        }
    }
}

fn surface_key(surface: &BrowserSurfaceRef) -> String {
    surface.panel_id.clone()
}

fn parse_css_hex_color(value: &str) -> Option<InspectorColor> {
    let value = value.strip_prefix('#')?;
    let (red, green, blue) = match value.len() {
        3 => (
            u8::from_str_radix(&value[0..1].repeat(2), 16).ok()?,
            u8::from_str_radix(&value[1..2].repeat(2), 16).ok()?,
            u8::from_str_radix(&value[2..3].repeat(2), 16).ok()?,
        ),
        6 | 8 => (
            u8::from_str_radix(&value[0..2], 16).ok()?,
            u8::from_str_radix(&value[2..4], 16).ok()?,
            u8::from_str_radix(&value[4..6], 16).ok()?,
        ),
        _ => return None,
    };
    Some(InspectorColor { red, green, blue })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface() -> BrowserSurfaceRef {
        BrowserSurfaceRef {
            panel_id: "panel-1".to_string(),
            surface_id: "surface-1".to_string(),
            generation: 1,
        }
    }

    #[test]
    fn inspector_claims_only_one_node_per_selection() {
        let inspector = BrowserDevToolsInspector::default();
        let surface = surface();
        inspector.register_surface(surface.clone());
        inspector.begin_selection(&surface, "selection-1").unwrap();

        let claim = inspector.claim_node(&surface, ROOT_SESSION).unwrap();
        assert_eq!(claim.request_id, "selection-1");
        assert!(claim.sessions.contains(&ROOT_SESSION.to_string()));
        assert!(inspector.claim_node(&surface, ROOT_SESSION).is_none());
        assert!(inspector.clear_selection_if_matches(&surface, "selection-1"));
    }

    #[test]
    fn accepts_only_the_exact_existing_annotation_overlay_action() {
        assert_eq!(
            native_highlight_annotation_id(&json!({
                "keydexOverlayAction": "open_existing_annotation",
                "annotationId": "annotation-1",
            })),
            Some("annotation-1".to_string())
        );
        assert_eq!(
            native_highlight_annotation_id(&json!({
                "keydexOverlayAction": "open_existing_annotation",
                "annotationId": "annotation-1",
                "selector": "button",
            })),
            None
        );
        assert_eq!(
            native_highlight_annotation_id(&json!({
                "keydexOverlayAction": "open_existing_annotation",
                "annotationId": "\n",
            })),
            None
        );
    }

    #[test]
    fn delayed_frame_activation_cannot_reopen_inspection_after_a_node_is_claimed() {
        let inspector = BrowserDevToolsInspector::default();
        let surface = surface();
        inspector.register_surface(surface.clone());
        inspector.begin_selection(&surface, "selection-1").unwrap();

        let activation = inspector
            .add_session(&surface, "frame-session".to_string())
            .unwrap();
        assert!(inspector.is_inspecting_request(&surface, &activation.request_id));
        let claim = inspector.claim_node(&surface, "frame-session").unwrap();

        assert!(claim.sessions.contains(&"frame-session".to_string()));
        assert!(!inspector.is_inspecting_request(&surface, &activation.request_id));
    }

    #[test]
    fn cancelling_a_draft_keeps_all_sessions_until_deactivation_finishes() {
        let inspector = BrowserDevToolsInspector::default();
        let surface = surface();
        inspector.register_surface(surface.clone());
        inspector.begin_selection(&surface, "selection-1").unwrap();
        inspector.record_session(&surface, "frame-session".to_string());
        inspector.claim_node(&surface, "frame-session").unwrap();
        assert!(inspector.mark_draft_if_matches(&surface, "selection-1", "frame-session"));

        let snapshot = inspector.begin_cancel(&surface).unwrap();
        assert_eq!(snapshot.phase, SelectionPhase::Draft);
        assert_eq!(snapshot.session_id, "frame-session");
        assert!(snapshot.sessions.contains(&ROOT_SESSION.to_string()));
        assert!(snapshot.sessions.contains(&"frame-session".to_string()));
        assert!(!inspector.clear_failed_selection_if_matches(&surface, "selection-1"));
        assert!(inspector.clear_selection_if_matches(&surface, "selection-1"));
    }

    #[test]
    fn stale_surface_cannot_cancel_new_generation() {
        let inspector = BrowserDevToolsInspector::default();
        let first = surface();
        inspector.register_surface(first.clone());
        inspector.begin_selection(&first, "selection-1").unwrap();
        let second = BrowserSurfaceRef {
            generation: 2,
            ..first.clone()
        };
        inspector.register_surface(second.clone());

        assert!(inspector.abandon_selection(&first).is_none());
        assert!(inspector.abandon_selection(&second).is_none());
    }

    #[test]
    fn overlay_accent_accepts_project_hex_tokens() {
        assert_eq!(parse_css_hex_color("#d87575").unwrap().red, 216);
        assert_eq!(parse_css_hex_color("#abc").unwrap().blue, 204);
        assert!(parse_css_hex_color("color-mix(in srgb, red, blue)").is_none());
    }

    #[test]
    fn inspector_highlight_hides_native_element_information_popover() {
        let parameters = inspect_mode_parameters(InspectorColor::default());
        let configuration = &parameters["highlightConfig"];

        assert_eq!(configuration["showInfo"], false);
        assert_eq!(configuration["showStyles"], false);
        assert_eq!(configuration["showAccessibilityInfo"], false);
        assert_eq!(parameters["mode"], "searchForNode");
    }
}
