use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use chrono::Utc;

use super::{
    config::BROWSER_HOST_SCHEMA_VERSION,
    contract::{BrowserEvent, BrowserEventEnvelope, BrowserProfileMode, BrowserSurfaceRef},
    ui_actor::NativeBrowserSurface,
};

#[derive(Debug, Clone)]
struct LifecycleCursor {
    surface: BrowserSurfaceRef,
    profile_mode: BrowserProfileMode,
    navigation_id: Option<String>,
    sequence: u64,
    ready: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct BrowserLifecycle {
    cursors: Arc<Mutex<HashMap<String, LifecycleCursor>>>,
}

impl BrowserLifecycle {
    pub(crate) fn reserve(&self, surface: BrowserSurfaceRef, profile_mode: BrowserProfileMode) {
        if let Ok(mut cursors) = self.cursors.lock() {
            cursors.insert(
                surface.panel_id.clone(),
                LifecycleCursor {
                    surface,
                    profile_mode,
                    navigation_id: None,
                    sequence: 0,
                    ready: false,
                },
            );
        }
    }

    pub(crate) fn mark_ready(&self, surface: &BrowserSurfaceRef) -> bool {
        let Ok(mut cursors) = self.cursors.lock() else {
            return false;
        };
        let Some(cursor) = cursors.get_mut(&surface.panel_id) else {
            return false;
        };
        if cursor.surface != *surface {
            return false;
        }
        cursor.ready = true;
        true
    }

    pub(crate) fn profile_mode(&self, surface: &BrowserSurfaceRef) -> Option<BrowserProfileMode> {
        let cursors = self.cursors.lock().ok()?;
        let cursor = cursors.get(&surface.panel_id)?;
        (cursor.surface == *surface).then_some(cursor.profile_mode)
    }

    pub(crate) fn surfaces_for_profile(
        &self,
        profile_mode: BrowserProfileMode,
    ) -> Vec<BrowserSurfaceRef> {
        self.cursors
            .lock()
            .map(|cursors| {
                cursors
                    .values()
                    .filter(|cursor| cursor.ready && cursor.profile_mode == profile_mode)
                    .map(|cursor| cursor.surface.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn begin_navigation(
        &self,
        surface: &BrowserSurfaceRef,
        navigation_id: String,
    ) -> bool {
        let Ok(mut cursors) = self.cursors.lock() else {
            return false;
        };
        let Some(cursor) = cursors.get_mut(&surface.panel_id) else {
            return false;
        };
        if cursor.surface != *surface || !cursor.ready {
            return false;
        }
        cursor.navigation_id = Some(navigation_id);
        true
    }

    pub(crate) fn envelope(
        &self,
        surface: &BrowserSurfaceRef,
        event: BrowserEvent,
    ) -> Option<BrowserEventEnvelope> {
        let mut cursors = self.cursors.lock().ok()?;
        let cursor = cursors.get_mut(&surface.panel_id)?;
        if cursor.surface != *surface || !cursor.ready {
            return None;
        }
        cursor.sequence = cursor.sequence.checked_add(1)?;
        Some(BrowserEventEnvelope {
            schema_version: BROWSER_HOST_SCHEMA_VERSION,
            panel_id: surface.panel_id.clone(),
            surface_id: surface.surface_id.clone(),
            generation: surface.generation,
            sequence: cursor.sequence,
            navigation_id: cursor.navigation_id.clone(),
            occurred_at: Utc::now().to_rfc3339(),
            event,
        })
    }

    pub(crate) fn remove(&self, surface: &BrowserSurfaceRef) -> bool {
        let Ok(mut cursors) = self.cursors.lock() else {
            return false;
        };
        if cursors
            .get(&surface.panel_id)
            .is_some_and(|cursor| cursor.surface == *surface)
        {
            cursors.remove(&surface.panel_id);
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NativeNavigationSnapshot {
    pub(crate) source: Option<String>,
    pub(crate) can_go_back: bool,
    pub(crate) can_go_forward: bool,
    pub(crate) error_category: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NativeNavigationEvent {
    Snapshot(NativeNavigationSnapshot),
    NewWindowRequested {
        url: String,
        source_url: String,
        user_initiated: bool,
    },
    ExternalProtocolRequested {
        url: String,
        user_initiated: bool,
    },
    CertificateError {
        url: String,
    },
}

#[cfg(windows)]
pub(crate) fn attach_windows_navigation_observers(
    webview: &NativeBrowserSurface,
    handler: Arc<dyn Fn(NativeNavigationEvent) + Send + Sync>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_14, ICoreWebView2_18, COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL,
    };
    use webview2_com::{
        HistoryChangedEventHandler, LaunchingExternalUriSchemeEventHandler,
        NavigationCompletedEventHandler, NewWindowRequestedEventHandler,
        ServerCertificateErrorDetectedEventHandler, SourceChangedEventHandler,
    };
    use windows_061::core::Interface;

    webview.run(move |surface| unsafe {
        let core = surface.core();
        let history_handler = handler.clone();
        let mut history_token = 0_i64;
        core.add_HistoryChanged(
            &HistoryChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(sender) = sender {
                    history_handler(NativeNavigationEvent::Snapshot(
                        read_native_navigation_snapshot(&sender, false, None),
                    ));
                }
                Ok(())
            })),
            &mut history_token,
        )
        .map_err(|error| format!("Failed to attach browser history observer: {error}"))?;

        let source_handler = handler.clone();
        let mut source_token = 0_i64;
        core.add_SourceChanged(
            &SourceChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(sender) = sender {
                    source_handler(NativeNavigationEvent::Snapshot(
                        read_native_navigation_snapshot(&sender, true, None),
                    ));
                }
                Ok(())
            })),
            &mut source_token,
        )
        .map_err(|error| format!("Failed to attach browser source observer: {error}"))?;

        let completed_handler = handler.clone();
        let mut completed_token = 0_i64;
        core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
                if let (Some(sender), Some(args)) = (sender, args) {
                    let mut success = windows_061::core::BOOL::default();
                    let _ = args.IsSuccess(&mut success);
                    if !success.as_bool() {
                        let mut status = Default::default();
                        let _ = args.WebErrorStatus(&mut status);
                        if let Some(category) = classify_web_error_status(status.0) {
                            completed_handler(NativeNavigationEvent::Snapshot(
                                read_native_navigation_snapshot(
                                    &sender,
                                    true,
                                    Some(category.to_string()),
                                ),
                            ));
                        }
                    }
                }
                Ok(())
            })),
            &mut completed_token,
        )
        .map_err(|error| format!("Failed to attach browser navigation observer: {error}"))?;

        let popup_handler = handler.clone();
        let mut popup_token = 0_i64;
        core.add_NewWindowRequested(
            &NewWindowRequestedEventHandler::create(Box::new(move |sender, args| {
                if let (Some(sender), Some(args)) = (sender, args) {
                    let _ = args.SetHandled(true);
                    let mut user_initiated = windows_061::core::BOOL::default();
                    let _ = args.IsUserInitiated(&mut user_initiated);
                    if let (Some(url), Some(source_url)) = (
                        read_allocated_string(|value| args.Uri(value)),
                        read_allocated_string(|value| sender.Source(value)),
                    ) {
                        popup_handler(NativeNavigationEvent::NewWindowRequested {
                            url,
                            source_url,
                            user_initiated: user_initiated.as_bool(),
                        });
                    }
                }
                Ok(())
            })),
            &mut popup_token,
        )
        .map_err(|error| format!("Failed to attach browser popup observer: {error}"))?;

        if let Ok(core14) = core.cast::<ICoreWebView2_14>() {
            let certificate_handler = handler.clone();
            let mut certificate_token = 0_i64;
            let _ = core14.add_ServerCertificateErrorDetected(
                &ServerCertificateErrorDetectedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let _ = args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL);
                        if let Some(url) = read_allocated_string(|value| args.RequestUri(value)) {
                            certificate_handler(NativeNavigationEvent::CertificateError { url });
                        }
                    }
                    Ok(())
                })),
                &mut certificate_token,
            );
        }

        if let Ok(core18) = core.cast::<ICoreWebView2_18>() {
            let external_handler = handler.clone();
            let mut external_token = 0_i64;
            let _ = core18.add_LaunchingExternalUriScheme(
                &LaunchingExternalUriSchemeEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        let _ = args.SetCancel(true);
                        let mut user_initiated = windows_061::core::BOOL::default();
                        let _ = args.IsUserInitiated(&mut user_initiated);
                        if let Some(url) = read_allocated_string(|value| args.Uri(value)) {
                            external_handler(NativeNavigationEvent::ExternalProtocolRequested {
                                url,
                                user_initiated: user_initiated.as_bool(),
                            });
                        }
                    }
                    Ok(())
                })),
                &mut external_token,
            );
        }
        Ok(())
    })
}

#[cfg(windows)]
unsafe fn read_native_navigation_snapshot(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    include_source: bool,
    error_category: Option<String>,
) -> NativeNavigationSnapshot {
    use windows_061::core::PWSTR;

    let mut can_go_back = windows_061::core::BOOL::default();
    let mut can_go_forward = windows_061::core::BOOL::default();
    let _ = unsafe { core.CanGoBack(&mut can_go_back) };
    let _ = unsafe { core.CanGoForward(&mut can_go_forward) };
    let source = if include_source {
        let mut value = PWSTR::null();
        if unsafe { core.Source(&mut value) }.is_ok() && !value.is_null() {
            let source = unsafe { value.to_string().ok() };
            unsafe { windows_061::Win32::System::Com::CoTaskMemFree(Some(value.0.cast())) };
            source
        } else {
            None
        }
    } else {
        None
    };
    NativeNavigationSnapshot {
        source,
        can_go_back: can_go_back.as_bool(),
        can_go_forward: can_go_forward.as_bool(),
        error_category,
    }
}

#[cfg(windows)]
unsafe fn read_allocated_string(
    read: impl FnOnce(*mut windows_061::core::PWSTR) -> windows_061::core::Result<()>,
) -> Option<String> {
    let mut value = windows_061::core::PWSTR::null();
    if read(&mut value).is_err() || value.is_null() {
        return None;
    }
    let result = unsafe { value.to_string().ok() };
    unsafe { windows_061::Win32::System::Com::CoTaskMemFree(Some(value.0.cast())) };
    result
}

pub(crate) fn classify_web_error_status(status: i32) -> Option<&'static str> {
    match status {
        1..=5 => Some("tls_certificate"),
        7 => Some("timeout"),
        13 => Some("dns"),
        6 | 9..=12 => Some("network"),
        14 => None,
        15 => Some("redirect"),
        17 | 18 => Some("authentication"),
        _ => Some("navigation"),
    }
}

pub(crate) fn is_confirmable_external_protocol(value: &str) -> bool {
    value
        .parse::<tauri::Url>()
        .ok()
        .is_some_and(|url| matches!(url.scheme(), "mailto" | "tel"))
}

#[cfg(not(windows))]
pub(crate) fn attach_windows_navigation_observers(
    _webview: &NativeBrowserSurface,
    _handler: Arc<dyn Fn(NativeNavigationEvent) + Send + Sync>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::contract::{PageLoadingPayload, ReasonPayload};

    fn surface(generation: u64) -> BrowserSurfaceRef {
        BrowserSurfaceRef {
            panel_id: "panel-1".into(),
            surface_id: format!("surface-{generation}"),
            generation,
        }
    }

    #[test]
    fn sequences_events_and_filters_stale_surfaces() {
        let lifecycle = BrowserLifecycle::default();
        let first = surface(1);
        lifecycle.reserve(first.clone(), BrowserProfileMode::Persistent);
        assert!(lifecycle
            .envelope(
                &first,
                BrowserEvent::SurfaceDestroyed(ReasonPayload {
                    reason: "early".into()
                })
            )
            .is_none());
        assert!(lifecycle.mark_ready(&first));
        assert!(lifecycle.begin_navigation(&first, "navigation-1".into()));
        let one = lifecycle
            .envelope(
                &first,
                BrowserEvent::PageLoading(PageLoadingPayload { loading: true }),
            )
            .unwrap();
        let two = lifecycle
            .envelope(
                &first,
                BrowserEvent::PageLoading(PageLoadingPayload { loading: false }),
            )
            .unwrap();
        assert_eq!((one.sequence, two.sequence), (1, 2));
        assert_eq!(two.navigation_id.as_deref(), Some("navigation-1"));

        let second = surface(2);
        lifecycle.reserve(second.clone(), BrowserProfileMode::Incognito);
        assert!(lifecycle
            .envelope(
                &first,
                BrowserEvent::SurfaceDestroyed(ReasonPayload {
                    reason: "stale".into()
                })
            )
            .is_none());
        assert!(lifecycle.mark_ready(&second));
        assert_eq!(
            lifecycle.profile_mode(&second),
            Some(BrowserProfileMode::Incognito)
        );
        assert!(!lifecycle.remove(&first));
        assert!(lifecycle.remove(&second));
    }

    #[test]
    fn classifies_navigation_failures_and_only_confirms_safe_external_schemes() {
        assert_eq!(classify_web_error_status(13), Some("dns"));
        assert_eq!(classify_web_error_status(7), Some("timeout"));
        assert_eq!(classify_web_error_status(2), Some("tls_certificate"));
        assert_eq!(classify_web_error_status(14), None);
        assert!(is_confirmable_external_protocol("mailto:test@example.com"));
        assert!(is_confirmable_external_protocol("tel:+8613800000000"));
        assert!(!is_confirmable_external_protocol("file:///C:/secret.txt"));
        assert!(!is_confirmable_external_protocol("javascript:alert(1)"));
    }
}
