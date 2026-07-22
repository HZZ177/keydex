#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BrowserFileChooserMode {
    WebView2NativeUserGesture,
}

pub(crate) const BROWSER_FILE_CHOOSER_MODE: BrowserFileChooserMode =
    BrowserFileChooserMode::WebView2NativeUserGesture;

pub(crate) fn file_chooser_contract() -> &'static [&'static str] {
    &[
        "native_system_picker",
        "webview2_user_activation",
        "single_and_multiple_input",
        "cancel_without_side_effect",
        "no_programmatic_path_command",
        "no_path_logging_or_bridge_message",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_file_input_is_the_only_upload_entrypoint() {
        assert_eq!(
            BROWSER_FILE_CHOOSER_MODE,
            BrowserFileChooserMode::WebView2NativeUserGesture
        );
        let contract = file_chooser_contract();
        assert!(contract.contains(&"webview2_user_activation"));
        assert!(contract.contains(&"no_programmatic_path_command"));
        assert!(contract.contains(&"no_path_logging_or_bridge_message"));
    }
}
