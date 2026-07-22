use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::{Webview, Wry};

use super::{
    config::{BROWSER_CRASH_LOOP_COUNT, BROWSER_CRASH_LOOP_WINDOW_MS},
    contract::{BrowserEvent, BrowserProcessScope, BrowserSurfaceRef, ProcessFailedPayload},
};

const FAILURE_SINGLEFLIGHT_WINDOW_MS: u64 = 1_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FailureRecord {
    pub(crate) scope: BrowserProcessScope,
    pub(crate) reason_category: String,
    pub(crate) crash_count: u64,
    pub(crate) circuit_open: bool,
}

#[derive(Debug, Default)]
struct FailureState {
    inflight: HashMap<String, u64>,
    browser_crashes: HashMap<String, VecDeque<u64>>,
}

#[derive(Clone, Default)]
pub(crate) struct BrowserFailureCoordinator {
    inner: Arc<Mutex<FailureState>>,
}

impl BrowserFailureCoordinator {
    pub(crate) fn record(
        &self,
        environment_key: &str,
        surface: &BrowserSurfaceRef,
        scope: BrowserProcessScope,
        reason_category: &str,
        now_ms: u64,
    ) -> Option<FailureRecord> {
        let mut inner = self.inner.lock().ok()?;
        inner
            .inflight
            .retain(|_, started| now_ms.saturating_sub(*started) < FAILURE_SINGLEFLIGHT_WINDOW_MS);
        let failure_key = match scope {
            BrowserProcessScope::Browser => format!("environment:{environment_key}"),
            BrowserProcessScope::Renderer => format!(
                "surface:{}:{}:{}",
                surface.panel_id, surface.surface_id, surface.generation
            ),
        };
        if inner.inflight.contains_key(&failure_key) {
            return None;
        }
        inner.inflight.insert(failure_key, now_ms);

        let crash_count = if scope == BrowserProcessScope::Browser {
            let crashes = inner
                .browser_crashes
                .entry(environment_key.to_string())
                .or_default();
            while crashes
                .front()
                .is_some_and(|time| now_ms.saturating_sub(*time) > BROWSER_CRASH_LOOP_WINDOW_MS)
            {
                crashes.pop_front();
            }
            crashes.push_back(now_ms);
            crashes.len() as u64
        } else {
            1
        };
        Some(FailureRecord {
            scope,
            reason_category: reason_category.to_string(),
            crash_count,
            circuit_open: scope == BrowserProcessScope::Browser
                && crash_count >= u64::from(BROWSER_CRASH_LOOP_COUNT),
        })
    }
}

#[cfg(windows)]
pub(crate) fn attach_process_failure_observer(
    webview: &Webview<Wry>,
    coordinator: BrowserFailureCoordinator,
    environment_key: String,
    surface: BrowserSurfaceRef,
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
    use webview2_com::ProcessFailedEventHandler;

    webview.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let mut token = 0_i64;
        let _ = core.add_ProcessFailed(
            &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED;
                if args.ProcessFailedKind(&mut kind).is_err() {
                    return Ok(());
                }
                let (scope, reason) = classify_process_failure(kind);
                let now_ms = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as u64)
                    .unwrap_or_default();
                if let Some(record) =
                    coordinator.record(&environment_key, &surface, scope, reason, now_ms)
                {
                    emit(BrowserEvent::ProcessFailed(ProcessFailedPayload {
                        scope: record.scope,
                        reason_category: record.reason_category,
                        crash_count: record.crash_count,
                    }));
                }
                Ok(())
            })),
            &mut token,
        );
    })
}

#[cfg(not(windows))]
pub(crate) fn attach_process_failure_observer(
    _webview: &Webview<Wry>,
    _coordinator: BrowserFailureCoordinator,
    _environment_key: String,
    _surface: BrowserSurfaceRef,
    _emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> tauri::Result<()> {
    Ok(())
}

#[cfg(windows)]
fn classify_process_failure(
    kind: webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PROCESS_FAILED_KIND,
) -> (BrowserProcessScope, &'static str) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    };
    if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
        (BrowserProcessScope::Browser, "browser_process_exited")
    } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED {
        (BrowserProcessScope::Renderer, "frame_render_process_exited")
    } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
        (BrowserProcessScope::Renderer, "render_process_unresponsive")
    } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
        (BrowserProcessScope::Renderer, "render_process_exited")
    } else {
        (BrowserProcessScope::Renderer, "auxiliary_process_exited")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(generation: u64) -> BrowserSurfaceRef {
        BrowserSurfaceRef {
            panel_id: "panel-1".to_string(),
            surface_id: "surface-1".to_string(),
            generation,
        }
    }

    #[test]
    fn duplicate_related_events_are_singleflight_and_generation_scoped() {
        let coordinator = BrowserFailureCoordinator::default();
        assert!(coordinator
            .record(
                "persistent",
                &surface(1),
                BrowserProcessScope::Renderer,
                "render",
                1_000
            )
            .is_some());
        assert!(coordinator
            .record(
                "persistent",
                &surface(1),
                BrowserProcessScope::Renderer,
                "frame",
                1_200
            )
            .is_none());
        assert!(coordinator
            .record(
                "persistent",
                &surface(2),
                BrowserProcessScope::Renderer,
                "render",
                1_200
            )
            .is_some());
    }

    #[test]
    fn three_browser_crashes_inside_five_minutes_open_the_circuit() {
        let coordinator = BrowserFailureCoordinator::default();
        let first = coordinator
            .record(
                "persistent",
                &surface(1),
                BrowserProcessScope::Browser,
                "browser",
                1_000,
            )
            .unwrap();
        let second = coordinator
            .record(
                "persistent",
                &surface(1),
                BrowserProcessScope::Browser,
                "browser",
                2_100,
            )
            .unwrap();
        let third = coordinator
            .record(
                "persistent",
                &surface(1),
                BrowserProcessScope::Browser,
                "browser",
                3_200,
            )
            .unwrap();
        assert_eq!(
            (first.crash_count, second.crash_count, third.crash_count),
            (1, 2, 3)
        );
        assert!(!first.circuit_open);
        assert!(third.circuit_open);
    }

    #[test]
    fn expired_crashes_leave_the_sliding_window() {
        let coordinator = BrowserFailureCoordinator::default();
        coordinator.record(
            "persistent",
            &surface(1),
            BrowserProcessScope::Browser,
            "browser",
            1_000,
        );
        let next = coordinator
            .record(
                "persistent",
                &surface(1),
                BrowserProcessScope::Browser,
                "browser",
                1_000 + BROWSER_CRASH_LOOP_WINDOW_MS + 1,
            )
            .unwrap();
        assert_eq!(next.crash_count, 1);
    }

    #[cfg(windows)]
    #[test]
    fn classifies_every_webview2_process_scope_without_exposing_native_details() {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        };

        assert_eq!(
            classify_process_failure(COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED),
            (BrowserProcessScope::Browser, "browser_process_exited")
        );
        for (kind, expected) in [
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
                "frame_render_process_exited",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
                "render_process_exited",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
                "render_process_unresponsive",
            ),
            (
                COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
                "auxiliary_process_exited",
            ),
        ] {
            assert_eq!(
                classify_process_failure(kind),
                (BrowserProcessScope::Renderer, expected)
            );
        }
    }
}
