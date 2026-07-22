use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum BrowserProbeStatus {
    PublicApi,
    NativeDefaultOnly,
    PlatformExtensionRequired,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserProbeCapability {
    pub(crate) id: &'static str,
    pub(crate) status: BrowserProbeStatus,
    pub(crate) mandatory: bool,
    pub(crate) evidence: &'static str,
}

pub(crate) const TAURI_CHILD_WEBVIEW_PROBE: &[BrowserProbeCapability] = &[
    BrowserProbeCapability {
        id: "profile.data_directory",
        status: BrowserProbeStatus::PublicApi,
        mandatory: true,
        evidence: "tauri::webview::WebviewBuilder::data_directory",
    },
    BrowserProbeCapability {
        id: "profile.incognito",
        status: BrowserProbeStatus::PublicApi,
        mandatory: true,
        evidence: "tauri::webview::WebviewBuilder::incognito",
    },
    BrowserProbeCapability {
        id: "popup.request",
        status: BrowserProbeStatus::PublicApi,
        mandatory: true,
        evidence: "tauri::webview::WebviewBuilder::on_new_window",
    },
    BrowserProbeCapability {
        id: "download.start_complete",
        status: BrowserProbeStatus::PublicApi,
        mandatory: true,
        evidence: "tauri::webview::WebviewBuilder::on_download",
    },
    BrowserProbeCapability {
        id: "zoom",
        status: BrowserProbeStatus::PublicApi,
        mandatory: true,
        evidence: "tauri::Webview::set_zoom",
    },
    BrowserProbeCapability {
        id: "file_chooser",
        status: BrowserProbeStatus::NativeDefaultOnly,
        mandatory: true,
        evidence: "WebView2 handles user-gesture file input; Tauri/Wry exposes no chooser callback",
    },
    BrowserProbeCapability {
        id: "permission.request",
        status: BrowserProbeStatus::PlatformExtensionRequired,
        mandatory: true,
        evidence: "Wry only installs an internal clipboard allow hook; no public PermissionRequested handler",
    },
    BrowserProbeCapability {
        id: "find.in_page",
        status: BrowserProbeStatus::PlatformExtensionRequired,
        mandatory: true,
        evidence: "Tauri Webview has no find/stop-find API",
    },
    BrowserProbeCapability {
        id: "process.failure",
        status: BrowserProbeStatus::PlatformExtensionRequired,
        mandatory: true,
        evidence: "Tauri/Wry exposes no WebView2 ProcessFailed callback",
    },
];

pub(crate) fn tauri_child_webview_passes_hard_gate() -> bool {
    TAURI_CHILD_WEBVIEW_PROBE
        .iter()
        .all(|item| !item.mandatory || item.status == BrowserProbeStatus::PublicApi)
}

pub(crate) fn required_platform_extensions() -> Vec<&'static str> {
    TAURI_CHILD_WEBVIEW_PROBE
        .iter()
        .filter(|item| item.mandatory && item.status != BrowserProbeStatus::PublicApi)
        .map(|item| item.id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pure_tauri_child_adapter_fails_the_mandatory_callback_gate() {
        assert!(!tauri_child_webview_passes_hard_gate());
        assert_eq!(
            required_platform_extensions(),
            vec![
                "file_chooser",
                "permission.request",
                "find.in_page",
                "process.failure"
            ]
        );
    }

    #[test]
    fn every_probe_has_stable_evidence_and_no_runtime_polling_claim() {
        assert_eq!(TAURI_CHILD_WEBVIEW_PROBE.len(), 9);
        for capability in TAURI_CHILD_WEBVIEW_PROBE {
            assert!(!capability.id.is_empty());
            assert!(!capability.evidence.is_empty());
            assert!(!capability.evidence.contains("poll"));
        }
    }
}
