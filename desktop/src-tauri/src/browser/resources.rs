use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use super::{
    contract::{BrowserResourceState, BrowserSurfaceRef},
    ui_actor::NativeBrowserSurface,
};

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
    webview: &NativeBrowserSurface,
    state: BrowserResourceState,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3;
    use webview2_com::TrySuspendCompletedHandler;
    use windows_061::core::Interface;

    webview.run(move |surface| unsafe {
        let Ok(core) = surface.core().cast::<ICoreWebView2_3>() else {
            return Err("WebView2 resource suspension API is unavailable".to_string());
        };
        match state {
            BrowserResourceState::Visible | BrowserResourceState::Warm => {
                core.Resume()
                    .map_err(|error| format!("Failed to resume browser surface: {error}"))?;
            }
            BrowserResourceState::NativeSuspended => {
                let completion = TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
                core.TrySuspend(&completion)
                    .map_err(|error| format!("Failed to suspend browser surface: {error}"))?;
            }
            BrowserResourceState::Discarded => {}
        }
        Ok(())
    })
}

#[cfg(not(windows))]
pub(crate) fn apply_native_resource_state(
    _webview: &NativeBrowserSurface,
    _state: BrowserResourceState,
) -> Result<(), String> {
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
