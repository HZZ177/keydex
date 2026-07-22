#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2Environment,
};

use super::adapter::{BrowserHostAdapterKind, SELECTED_BROWSER_HOST_ADAPTER};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DirectWebView2CapabilitySet {
    pub(crate) permission_requested: bool,
    pub(crate) process_failed: bool,
    pub(crate) download_progress: bool,
    pub(crate) file_chooser_observation: bool,
    pub(crate) find_in_page: bool,
    pub(crate) fixed_web_message_bridge: bool,
    pub(crate) native_region_capture: bool,
}

pub(crate) const DIRECT_WEBVIEW2_REQUIRED_CAPABILITIES: DirectWebView2CapabilitySet =
    DirectWebView2CapabilitySet {
        permission_requested: true,
        process_failed: true,
        download_progress: true,
        file_chooser_observation: true,
        find_in_page: true,
        fixed_web_message_bridge: true,
        native_region_capture: true,
    };

#[cfg(windows)]
pub(crate) struct DirectWebView2SurfaceHandles {
    pub(crate) environment: ICoreWebView2Environment,
    pub(crate) controller: ICoreWebView2Controller,
    pub(crate) core: ICoreWebView2,
}

#[cfg(windows)]
impl DirectWebView2SurfaceHandles {
    pub(crate) fn from_tauri_composition_shell(
        environment: ICoreWebView2Environment,
        controller: ICoreWebView2Controller,
    ) -> webview2_com::Result<Self> {
        let core = unsafe { controller.CoreWebView2()? };
        Ok(Self {
            environment,
            controller,
            core,
        })
    }
}

pub(crate) fn direct_webview2_adapter_is_selected() -> bool {
    SELECTED_BROWSER_HOST_ADAPTER == BrowserHostAdapterKind::DirectWebView2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_adapter_declares_every_native_gap_from_m0() {
        assert!(direct_webview2_adapter_is_selected());
        assert_eq!(
            DIRECT_WEBVIEW2_REQUIRED_CAPABILITIES,
            DirectWebView2CapabilitySet {
                permission_requested: true,
                process_failed: true,
                download_progress: true,
                file_chooser_observation: true,
                find_in_page: true,
                fixed_web_message_bridge: true,
                native_region_capture: true,
            }
        );
    }
}
