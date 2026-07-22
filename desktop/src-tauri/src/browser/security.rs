use tauri::{Runtime, Webview};

use super::contract::{BrowserCommandError, BrowserCommandErrorCode};

pub(crate) const TRUSTED_MAIN_WEBVIEW_LABEL: &str = "main";

pub(crate) fn ensure_main_webview_caller<R: Runtime>(
    webview: &Webview<R>,
) -> Result<(), BrowserCommandError> {
    ensure_main_webview_label(webview.label())
}

pub(crate) fn ensure_main_webview_label(label: &str) -> Result<(), BrowserCommandError> {
    if label == TRUSTED_MAIN_WEBVIEW_LABEL {
        return Ok(());
    }
    Err(BrowserCommandError {
        code: BrowserCommandErrorCode::UnauthorizedCaller,
        message: "BrowserHost commands are available only to the trusted main webview".to_string(),
        retryable: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_exact_main_webview_label() {
        assert!(ensure_main_webview_label("main").is_ok());
        for label in ["browser-1", "main-browser", "Main", "", "main/*"] {
            let error = ensure_main_webview_label(label).unwrap_err();
            assert_eq!(error.code, BrowserCommandErrorCode::UnauthorizedCaller);
            assert!(!error.retryable);
        }
    }
}
