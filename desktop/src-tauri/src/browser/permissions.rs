use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use chrono::Utc;
use uuid::Uuid;

use super::{
    contract::{
        BrowserEvent, BrowserPermissionDecision, BrowserSurfaceRef, PermissionExpiredPayload,
        PermissionRequestedPayload, RespondPermissionInput,
    },
    ui_actor::NativeBrowserSurface,
};

const PERMISSION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PermissionPolicyDecision {
    Ask,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PermissionRequestRecord {
    request_id: String,
    surface: BrowserSurfaceRef,
    origin: String,
    permission: String,
    expires_at: Instant,
}

#[derive(Debug, Default)]
struct PermissionLedger {
    requests: HashMap<String, PermissionRequestRecord>,
}

impl PermissionLedger {
    fn insert(&mut self, record: PermissionRequestRecord) {
        self.requests.insert(record.request_id.clone(), record);
    }

    fn consume(
        &mut self,
        request_id: &str,
        surface: &BrowserSurfaceRef,
        origin: &str,
        now: Instant,
    ) -> Option<PermissionRequestRecord> {
        let current = self.requests.get(request_id)?;
        if current.surface != *surface || current.origin != origin || current.expires_at <= now {
            return None;
        }
        self.requests.remove(request_id)
    }

    fn expire(&mut self, request_id: &str, now: Instant) -> Option<PermissionRequestRecord> {
        self.requests
            .get(request_id)
            .is_some_and(|request| request.expires_at <= now)
            .then(|| self.requests.remove(request_id))
            .flatten()
    }

    fn cancel_surface(&mut self, surface: &BrowserSurfaceRef) -> Vec<PermissionRequestRecord> {
        let ids = self
            .requests
            .iter()
            .filter(|(_, request)| request.surface == *surface)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        ids.into_iter()
            .filter_map(|id| self.requests.remove(&id))
            .collect()
    }
}

#[cfg(windows)]
#[derive(Clone)]
struct NativePermissionHandle {
    args: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PermissionRequestedEventArgs,
    deferral: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral,
}

#[cfg(windows)]
thread_local! {
    static NATIVE_PERMISSION_HANDLES: RefCell<HashMap<String, NativePermissionHandle>> =
        RefCell::new(HashMap::new());
}

#[derive(Default)]
struct PermissionBrokerInner {
    ledger: PermissionLedger,
}

#[derive(Clone, Default)]
pub(crate) struct PermissionBroker {
    inner: Arc<Mutex<PermissionBrokerInner>>,
}

impl PermissionBroker {
    #[cfg(windows)]
    fn insert(&self, record: PermissionRequestRecord) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.ledger.insert(record);
        }
    }

    #[cfg(windows)]
    pub(crate) fn respond(
        &self,
        webview: &NativeBrowserSurface,
        input: &RespondPermissionInput,
    ) -> Result<(), String> {
        let request_id = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Permission broker is unavailable".to_string())?;
            let record = inner
                .ledger
                .consume(
                    &input.permission_request_id,
                    &input.surface,
                    &input.origin,
                    Instant::now(),
                )
                .ok_or_else(|| {
                    "Permission request is stale, expired, or already consumed".to_string()
                })?;
            record.request_id
        };
        apply_permission_decision(webview, request_id, input.decision.clone())
    }

    #[cfg(not(windows))]
    pub(crate) fn respond(
        &self,
        _webview: &NativeBrowserSurface,
        _input: &RespondPermissionInput,
    ) -> Result<(), String> {
        Err("Website permissions are only available on Windows".to_string())
    }

    pub(crate) fn cancel_surface(
        &self,
        webview: Option<&NativeBrowserSurface>,
        surface: &BrowserSurfaceRef,
    ) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let records = inner.ledger.cancel_surface(surface);
        #[cfg(windows)]
        if let Some(webview) = webview {
            for record in records {
                let _ = apply_permission_decision(
                    webview,
                    record.request_id,
                    BrowserPermissionDecision::Deny,
                );
            }
        }
        #[cfg(not(windows))]
        let _ = (records, webview);
    }
}

#[cfg(windows)]
pub(crate) fn attach_permission_broker(
    webview: &NativeBrowserSurface,
    broker: PermissionBroker,
    surface: BrowserSurfaceRef,
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    use webview2_com::PermissionRequestedEventHandler;

    let timeout_webview = webview.clone();
    webview.run(move |surface_handle| unsafe {
        let core = surface_handle.core();
        let mut token = 0_i64;
        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                let mut user_initiated = windows_061::core::BOOL::default();
                let _ = args.PermissionKind(&mut kind);
                let _ = args.IsUserInitiated(&mut user_initiated);
                let permission = permission_name(kind.0);
                if permission_policy(permission, user_initiated.as_bool())
                    == PermissionPolicyDecision::Deny
                {
                    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY);
                    return Ok(());
                }
                let Some(origin) = read_origin(&args) else {
                    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY);
                    return Ok(());
                };
                let Ok(deferral) = args.GetDeferral() else {
                    let _ = args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY);
                    return Ok(());
                };
                let request_id = format!("permission-{}", Uuid::new_v4().simple());
                let record = PermissionRequestRecord {
                    request_id: request_id.clone(),
                    surface: surface.clone(),
                    origin: origin.clone(),
                    permission: permission.to_string(),
                    expires_at: Instant::now() + PERMISSION_TIMEOUT,
                };
                NATIVE_PERMISSION_HANDLES.with(|handles| {
                    handles.borrow_mut().insert(
                        request_id.clone(),
                        NativePermissionHandle { args, deferral },
                    );
                });
                broker.insert(record);
                emit(BrowserEvent::PermissionRequested(
                    PermissionRequestedPayload {
                        permission_request_id: request_id.clone(),
                        origin,
                        permission: permission.to_string(),
                        deadline: (Utc::now()
                            + chrono::Duration::seconds(PERMISSION_TIMEOUT.as_secs() as i64))
                        .to_rfc3339(),
                    },
                ));
                let timeout_broker = broker.clone();
                let timeout_emit = emit.clone();
                let timeout_webview = timeout_webview.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(PERMISSION_TIMEOUT);
                    let expired = {
                        let Ok(mut inner) = timeout_broker.inner.lock() else {
                            return;
                        };
                        inner.ledger.expire(&request_id, Instant::now()).is_some()
                    };
                    if expired {
                        let _ = apply_permission_decision(
                            &timeout_webview,
                            request_id.clone(),
                            BrowserPermissionDecision::Deny,
                        );
                        timeout_emit(BrowserEvent::PermissionExpired(PermissionExpiredPayload {
                            permission_request_id: request_id,
                        }));
                    }
                });
                Ok(())
            })),
            &mut token,
        )
        .map_err(|error| format!("Failed to attach browser permission broker: {error}"))?;
        Ok(())
    })
}

#[cfg(not(windows))]
pub(crate) fn attach_permission_broker(
    _webview: &NativeBrowserSurface,
    _broker: PermissionBroker,
    _surface: BrowserSurfaceRef,
    _emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn apply_permission_decision(
    webview: &NativeBrowserSurface,
    request_id: String,
    decision: BrowserPermissionDecision,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
    };
    webview
        .run(move |_| unsafe {
            let handle =
                NATIVE_PERMISSION_HANDLES.with(|handles| handles.borrow_mut().remove(&request_id));
            let Some(handle) = handle else {
                return Err("Native website permission request is unavailable".to_string());
            };
            let state = match decision {
                BrowserPermissionDecision::AllowOnce => COREWEBVIEW2_PERMISSION_STATE_ALLOW,
                BrowserPermissionDecision::Deny => COREWEBVIEW2_PERMISSION_STATE_DENY,
            };
            handle
                .args
                .SetState(state)
                .map_err(|error| format!("Failed to set website permission decision: {error}"))?;
            handle.deferral.Complete().map_err(|error| {
                format!("Failed to complete website permission request: {error}")
            })?;
            Ok(())
        })
        .map_err(|error| format!("Failed to resolve website permission: {error}"))
}

#[cfg(windows)]
unsafe fn read_origin(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2PermissionRequestedEventArgs,
) -> Option<String> {
    let mut value = windows_061::core::PWSTR::null();
    if unsafe { args.Uri(&mut value) }.is_err() || value.is_null() {
        return None;
    }
    let raw = unsafe { value.to_string().ok() };
    unsafe { windows_061::Win32::System::Com::CoTaskMemFree(Some(value.0.cast())) };
    let url = raw?.parse::<tauri::Url>().ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{}:{port}", url.scheme(), host),
        None => format!("{}://{host}", url.scheme()),
    })
}

pub(crate) fn permission_name(kind: i32) -> &'static str {
    match kind {
        1 => "microphone",
        2 => "camera",
        3 => "geolocation",
        4 => "notifications",
        5 => "sensors",
        6 => "clipboard_read",
        7 => "automatic_downloads",
        8 => "file_read_write",
        9 => "autoplay",
        10 => "local_fonts",
        11 => "midi",
        12 => "window_management",
        _ => "unknown",
    }
}

pub(crate) fn permission_policy(
    permission: &str,
    user_initiated: bool,
) -> PermissionPolicyDecision {
    if user_initiated && matches!(permission, "camera" | "microphone" | "geolocation") {
        PermissionPolicyDecision::Ask
    } else {
        PermissionPolicyDecision::Deny
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(generation: u64) -> BrowserSurfaceRef {
        BrowserSurfaceRef {
            panel_id: "panel-1".into(),
            surface_id: format!("surface-{generation}"),
            generation,
        }
    }

    #[test]
    fn policy_asks_only_for_user_gesture_camera_microphone_and_location() {
        for permission in ["camera", "microphone", "geolocation"] {
            assert_eq!(
                permission_policy(permission, true),
                PermissionPolicyDecision::Ask
            );
            assert_eq!(
                permission_policy(permission, false),
                PermissionPolicyDecision::Deny
            );
        }
        for permission in [
            "notifications",
            "clipboard_read",
            "midi",
            "sensors",
            "file_read_write",
        ] {
            assert_eq!(
                permission_policy(permission, true),
                PermissionPolicyDecision::Deny
            );
        }
    }

    #[test]
    fn ledger_is_surface_origin_expiry_and_single_consume_safe() {
        let now = Instant::now();
        let mut ledger = PermissionLedger::default();
        ledger.insert(PermissionRequestRecord {
            request_id: "request-1".into(),
            surface: surface(1),
            origin: "https://example.com".into(),
            permission: "camera".into(),
            expires_at: now + Duration::from_secs(30),
        });
        assert!(ledger
            .consume("request-1", &surface(2), "https://example.com", now)
            .is_none());
        assert!(ledger
            .consume("request-1", &surface(1), "https://other.example", now)
            .is_none());
        assert!(ledger
            .consume("request-1", &surface(1), "https://example.com", now)
            .is_some());
        assert!(ledger
            .consume("request-1", &surface(1), "https://example.com", now)
            .is_none());
    }

    #[test]
    fn expired_requests_cannot_be_consumed_and_cancel_is_surface_scoped() {
        let now = Instant::now();
        let mut ledger = PermissionLedger::default();
        for generation in [1, 2] {
            ledger.insert(PermissionRequestRecord {
                request_id: format!("request-{generation}"),
                surface: surface(generation),
                origin: "https://example.com".into(),
                permission: "camera".into(),
                expires_at: now,
            });
        }
        assert!(ledger
            .consume("request-1", &surface(1), "https://example.com", now)
            .is_none());
        assert_eq!(ledger.cancel_surface(&surface(1)).len(), 1);
        assert_eq!(ledger.requests.len(), 1);
    }
}
