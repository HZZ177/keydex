use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserHostAdapterKind {
    DirectWebView2,
}

pub(crate) const SELECTED_BROWSER_HOST_ADAPTER: BrowserHostAdapterKind =
    BrowserHostAdapterKind::DirectWebView2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BrowserHostAdapterDecision {
    pub(crate) selected: BrowserHostAdapterKind,
    pub(crate) tauri_child_spike_selected: bool,
    pub(crate) electron_in_scope: bool,
    pub(crate) preserves_wire_contract: bool,
}

pub(crate) const fn browser_host_adapter_decision() -> BrowserHostAdapterDecision {
    BrowserHostAdapterDecision {
        selected: SELECTED_BROWSER_HOST_ADAPTER,
        tauri_child_spike_selected: false,
        electron_in_scope: false,
        preserves_wire_contract: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::probe::tauri_child_webview_passes_hard_gate;

    #[test]
    fn selects_one_direct_webview2_adapter_after_the_tauri_hard_gate_failure() {
        assert!(!tauri_child_webview_passes_hard_gate());
        assert_eq!(
            SELECTED_BROWSER_HOST_ADAPTER,
            BrowserHostAdapterKind::DirectWebView2
        );
        assert_eq!(
            browser_host_adapter_decision(),
            BrowserHostAdapterDecision {
                selected: BrowserHostAdapterKind::DirectWebView2,
                tauri_child_spike_selected: false,
                electron_in_scope: false,
                preserves_wire_contract: true,
            }
        );
    }
}
