use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use tauri::{Webview, Wry};

use super::contract::{BrowserResourceState, BrowserSurfaceRef};

#[derive(Debug, Clone, Copy)]
struct BrowserResourceEntry {
    state: BrowserResourceState,
    visible: bool,
}

#[derive(Clone, Default)]
pub(crate) struct BrowserResourceRegistry {
    states: Arc<Mutex<HashMap<String, BrowserResourceEntry>>>,
}

impl BrowserResourceRegistry {
    pub(crate) fn register_visible(&self, surface: &BrowserSurfaceRef) {
        if let Ok(mut states) = self.states.lock() {
            states.insert(
                surface_key(surface),
                BrowserResourceEntry {
                    state: BrowserResourceState::Visible,
                    visible: true,
                },
            );
        }
    }

    pub(crate) fn transition(
        &self,
        surface: &BrowserSurfaceRef,
        next: BrowserResourceState,
    ) -> Option<BrowserResourceState> {
        let mut states = self.states.lock().ok()?;
        let current = states.get_mut(&surface_key(surface))?;
        let prior = current.state;
        current.state = next;
        Some(prior)
    }

    pub(crate) fn set_visible(&self, surface: &BrowserSurfaceRef, visible: bool) -> bool {
        let Ok(mut states) = self.states.lock() else {
            return false;
        };
        let Some(current) = states.get_mut(&surface_key(surface)) else {
            return false;
        };
        current.visible = visible;
        true
    }

    pub(crate) fn can_capture(&self, surface: &BrowserSurfaceRef) -> bool {
        self.states
            .lock()
            .ok()
            .and_then(|states| states.get(&surface_key(surface)).copied())
            .is_some_and(|entry| entry.visible && entry.state == BrowserResourceState::Visible)
    }

    pub(crate) fn remove(&self, surface: &BrowserSurfaceRef) {
        if let Ok(mut states) = self.states.lock() {
            states.remove(&surface_key(surface));
        }
    }
}

#[cfg(windows)]
pub(crate) fn apply_native_resource_state(
    webview: &Webview<Wry>,
    state: BrowserResourceState,
) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3;
    use webview2_com::TrySuspendCompletedHandler;
    use windows_061::core::Interface;

    webview.with_webview(move |platform| unsafe {
        let Ok(core) = platform
            .controller()
            .CoreWebView2()
            .and_then(|core| core.cast::<ICoreWebView2_3>())
        else {
            return;
        };
        match state {
            BrowserResourceState::Visible | BrowserResourceState::Warm => {
                let _ = core.Resume();
            }
            BrowserResourceState::NativeSuspended => {
                let completion = TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
                let _ = core.TrySuspend(&completion);
            }
            BrowserResourceState::Discarded => {}
        }
    })
}

#[cfg(not(windows))]
pub(crate) fn apply_native_resource_state(
    _webview: &Webview<Wry>,
    _state: BrowserResourceState,
) -> tauri::Result<()> {
    Ok(())
}

fn surface_key(surface: &BrowserSurfaceRef) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}",
        surface.panel_id, surface.surface_id, surface.generation
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(generation: u64) -> BrowserSurfaceRef {
        BrowserSurfaceRef {
            panel_id: "panel".to_string(),
            surface_id: "surface".to_string(),
            generation,
        }
    }

    #[test]
    fn registry_is_generation_safe_and_forgets_destroyed_surfaces() {
        let registry = BrowserResourceRegistry::default();
        registry.register_visible(&surface(1));
        assert!(registry.can_capture(&surface(1)));
        assert_eq!(
            registry.transition(&surface(1), BrowserResourceState::Warm),
            Some(BrowserResourceState::Visible)
        );
        assert!(!registry.can_capture(&surface(1)));
        registry.transition(&surface(1), BrowserResourceState::Visible);
        assert!(registry.set_visible(&surface(1), false));
        assert!(!registry.can_capture(&surface(1)));
        assert!(registry.set_visible(&surface(1), true));
        assert!(registry.can_capture(&surface(1)));
        assert_eq!(
            registry.transition(&surface(2), BrowserResourceState::Warm),
            None
        );
        registry.remove(&surface(1));
        assert_eq!(
            registry.transition(&surface(1), BrowserResourceState::NativeSuspended),
            None
        );
    }
}
