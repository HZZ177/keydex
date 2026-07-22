use std::{
    cell::RefCell,
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use tauri::{Webview, Wry};
use uuid::Uuid;

use super::contract::{
    BrowserDownloadDecision, BrowserEvent, BrowserSurfaceRef, DownloadCompletedPayload,
    DownloadFailedPayload, DownloadProgressPayload, DownloadRequestedPayload, RespondDownloadInput,
};

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingDownload {
    id: String,
    surface: BrowserSurfaceRef,
    suggested_filename: String,
}

#[derive(Debug, Default)]
struct DownloadLedger {
    pending: HashMap<String, PendingDownload>,
}

impl DownloadLedger {
    fn insert(&mut self, download: PendingDownload) {
        self.pending.insert(download.id.clone(), download);
    }

    fn consume(&mut self, id: &str, surface: &BrowserSurfaceRef) -> Option<PendingDownload> {
        self.pending
            .get(id)
            .is_some_and(|download| download.surface == *surface)
            .then(|| self.pending.remove(id))
            .flatten()
    }

    fn cancel_surface(&mut self, surface: &BrowserSurfaceRef) -> Vec<String> {
        let ids = self
            .pending
            .iter()
            .filter(|(_, download)| download.surface == *surface)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in &ids {
            self.pending.remove(id);
        }
        ids
    }
}

#[cfg(windows)]
#[derive(Clone)]
struct NativeDownloadHandle {
    args: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadStartingEventArgs,
    deferral: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral,
    operation: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation,
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
}

#[cfg(windows)]
thread_local! {
    static NATIVE_DOWNLOAD_HANDLES: RefCell<HashMap<String, NativeDownloadHandle>> =
        RefCell::new(HashMap::new());
}

#[derive(Clone, Default)]
pub(crate) struct DownloadManager {
    ledger: Arc<Mutex<DownloadLedger>>,
}

impl DownloadManager {
    fn insert(&self, download: PendingDownload) {
        if let Ok(mut ledger) = self.ledger.lock() {
            ledger.insert(download);
        }
    }

    #[cfg(windows)]
    pub(crate) fn respond(
        &self,
        webview: &Webview<Wry>,
        downloads_dir: &Path,
        input: &RespondDownloadInput,
    ) -> Result<(), String> {
        if input.target_path.is_some() {
            return Err(
                "Custom download paths are not accepted by the browser surface".to_string(),
            );
        }
        let pending = self
            .ledger
            .lock()
            .map_err(|_| "Download manager is unavailable".to_string())?
            .consume(&input.download_id, &input.surface)
            .ok_or_else(|| "Download request is stale or already consumed".to_string())?;
        let target = match input.decision {
            BrowserDownloadDecision::Accept => {
                fs::create_dir_all(downloads_dir)
                    .map_err(|error| format!("Failed to prepare Downloads directory: {error}"))?;
                Some(unique_download_path(
                    downloads_dir,
                    &pending.suggested_filename,
                ))
            }
            BrowserDownloadDecision::Cancel => None,
        };
        resolve_native_download(webview, pending.id, target)
    }

    #[cfg(not(windows))]
    pub(crate) fn respond(
        &self,
        _webview: &Webview<Wry>,
        _downloads_dir: &Path,
        _input: &RespondDownloadInput,
    ) -> Result<(), String> {
        Err("Downloads are only available on Windows".to_string())
    }

    pub(crate) fn cancel_pending_for_surface(
        &self,
        webview: Option<&Webview<Wry>>,
        surface: &BrowserSurfaceRef,
    ) {
        let ids = self
            .ledger
            .lock()
            .map(|mut ledger| ledger.cancel_surface(surface))
            .unwrap_or_default();
        #[cfg(windows)]
        if let Some(webview) = webview {
            for id in ids {
                let _ = resolve_native_download(webview, id, None);
            }
        }
        #[cfg(not(windows))]
        let _ = (ids, webview);
    }
}

#[cfg(windows)]
pub(crate) fn attach_download_manager(
    webview: &Webview<Wry>,
    manager: DownloadManager,
    surface: BrowserSurfaceRef,
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> tauri::Result<()> {
    use webview2_com::DownloadStartingEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4;
    use windows_061::core::Interface;

    webview.with_webview(move |platform| unsafe {
        let Ok(core) = platform
            .controller()
            .CoreWebView2()
            .and_then(|core| core.cast::<ICoreWebView2_4>())
        else {
            return;
        };
        let mut token = 0_i64;
        let _ = core.add_DownloadStarting(
            &DownloadStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else {
                    return Ok(());
                };
                let Ok(operation) = args.DownloadOperation() else {
                    let _ = args.SetCancel(true);
                    return Ok(());
                };
                let Ok(deferral) = args.GetDeferral() else {
                    let _ = args.SetCancel(true);
                    return Ok(());
                };
                let url = read_operation_string(|value| operation.Uri(value)).unwrap_or_default();
                let suggested = read_operation_string(|value| args.ResultFilePath(value))
                    .and_then(|value| {
                        PathBuf::from(value)
                            .file_name()
                            .map(|name| name.to_string_lossy().to_string())
                    })
                    .unwrap_or_else(|| "download".to_string());
                let suggested_filename = sanitize_download_filename(&suggested);
                let mut total = -1_i64;
                let _ = operation.TotalBytesToReceive(&mut total);
                let download_id = format!("download-{}", Uuid::new_v4().simple());
                let _ = args.SetHandled(true);
                NATIVE_DOWNLOAD_HANDLES.with(|handles| {
                    handles.borrow_mut().insert(
                        download_id.clone(),
                        NativeDownloadHandle {
                            args,
                            deferral,
                            operation,
                            emit: emit.clone(),
                        },
                    );
                });
                manager.insert(PendingDownload {
                    id: download_id.clone(),
                    surface: surface.clone(),
                    suggested_filename: suggested_filename.clone(),
                });
                emit(BrowserEvent::DownloadRequested(DownloadRequestedPayload {
                    download_id,
                    url: sanitize_download_url(&url),
                    suggested_filename,
                    total_bytes: u64::try_from(total).ok(),
                }));
                Ok(())
            })),
            &mut token,
        );
    })
}

#[cfg(not(windows))]
pub(crate) fn attach_download_manager(
    _webview: &Webview<Wry>,
    _manager: DownloadManager,
    _surface: BrowserSurfaceRef,
    _emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> tauri::Result<()> {
    Ok(())
}

#[cfg(windows)]
fn resolve_native_download(
    webview: &Webview<Wry>,
    download_id: String,
    target: Option<PathBuf>,
) -> Result<(), String> {
    webview
        .with_webview(move |_| unsafe {
            let handle =
                NATIVE_DOWNLOAD_HANDLES.with(|handles| handles.borrow_mut().remove(&download_id));
            let Some(handle) = handle else {
                return;
            };
            let Some(target) = target else {
                let _ = handle.args.SetCancel(true);
                let _ = handle.deferral.Complete();
                return;
            };
            let target = windows_061::core::HSTRING::from(target.as_os_str());
            if handle.args.SetResultFilePath(&target).is_err() {
                let _ = handle.args.SetCancel(true);
                let _ = handle.deferral.Complete();
                return;
            }
            attach_download_progress(&handle.operation, download_id.clone(), handle.emit.clone());
            let _ = handle.args.SetCancel(false);
            let _ = handle.deferral.Complete();
        })
        .map_err(|error| format!("Failed to resolve download request: {error}"))
}

#[cfg(windows)]
unsafe fn attach_download_progress(
    operation: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation,
    download_id: String,
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON, COREWEBVIEW2_DOWNLOAD_STATE,
        COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED,
    };
    use webview2_com::{BytesReceivedChangedEventHandler, StateChangedEventHandler};

    let progress_id = download_id.clone();
    let progress_emit = emit.clone();
    let mut progress_token = 0_i64;
    let _ = operation.add_BytesReceivedChanged(
        &BytesReceivedChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(sender) = sender {
                let mut received = 0_i64;
                let mut total = -1_i64;
                let _ = sender.BytesReceived(&mut received);
                let _ = sender.TotalBytesToReceive(&mut total);
                progress_emit(BrowserEvent::DownloadProgress(DownloadProgressPayload {
                    download_id: progress_id.clone(),
                    received_bytes: u64::try_from(received).unwrap_or_default(),
                    total_bytes: u64::try_from(total).ok(),
                }));
            }
            Ok(())
        })),
        &mut progress_token,
    );

    let mut state_token = 0_i64;
    let _ = operation.add_StateChanged(
        &StateChangedEventHandler::create(Box::new(move |sender, _| {
            if let Some(sender) = sender {
                let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                let _ = sender.State(&mut state);
                if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
                    emit(BrowserEvent::DownloadCompleted(DownloadCompletedPayload {
                        download_id: download_id.clone(),
                        staged_asset_id: format!("managed-download-{download_id}"),
                    }));
                } else if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED {
                    let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
                    let _ = sender.InterruptReason(&mut reason);
                    emit(BrowserEvent::DownloadFailed(DownloadFailedPayload {
                        download_id: download_id.clone(),
                        error_category: download_interrupt_category(reason.0).to_string(),
                    }));
                }
            }
            Ok(())
        })),
        &mut state_token,
    );
}

#[cfg(windows)]
unsafe fn read_operation_string(
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

pub(crate) fn sanitize_download_filename(value: &str) -> String {
    let name = Path::new(value)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("download")
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) || character.is_control()
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    let trimmed = name.trim().trim_end_matches(['.', ' ']);
    let safe = if trimmed.is_empty() {
        "download"
    } else {
        trimmed
    };
    safe.chars().take(180).collect()
}

pub(crate) fn unique_download_path(directory: &Path, suggested: &str) -> PathBuf {
    let filename = sanitize_download_filename(suggested);
    let candidate = directory.join(&filename);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(&filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("download");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..=9_999 {
        let filename = match extension {
            Some(extension) => format!("{stem} ({index}).{extension}"),
            None => format!("{stem} ({index})"),
        };
        let candidate = directory.join(filename);
        if !candidate.exists() {
            return candidate;
        }
    }
    directory.join(format!("download-{}", Uuid::new_v4().simple()))
}

pub(crate) fn is_dangerous_download(filename: &str) -> bool {
    Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "exe" | "msi" | "bat" | "cmd" | "com" | "ps1" | "vbs" | "js" | "scr"
            )
        })
}

pub(crate) fn sanitize_download_url(value: &str) -> String {
    let Ok(mut url) = value.parse::<tauri::Url>() else {
        return String::new();
    };
    let sensitive = [
        "token",
        "code",
        "key",
        "signature",
        "sig",
        "session",
        "access_token",
    ];
    let pairs = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if !pairs.is_empty() {
        url.set_query(None);
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            let redacted = sensitive.iter().any(|item| key.eq_ignore_ascii_case(item))
                || key.to_ascii_lowercase().ends_with("_token");
            query.append_pair(&key, if redacted { "[redacted]" } else { &value });
        }
    }
    url.to_string()
}

pub(crate) fn download_interrupt_category(reason: i32) -> &'static str {
    match reason {
        2 | 8 | 9 => "policy_or_access",
        3 => "no_space",
        5 => "too_large",
        6 | 11 => "security",
        12..=16 => "network",
        20 | 22 => "authentication",
        21 => "tls_certificate",
        26..=28 => "cancelled",
        29 => "process_failed",
        _ => "download_failed",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(panel: &str) -> BrowserSurfaceRef {
        BrowserSurfaceRef {
            panel_id: panel.to_string(),
            surface_id: format!("surface-{panel}"),
            generation: 1,
        }
    }

    #[test]
    fn filename_is_leaf_only_bounded_and_windows_safe() {
        assert_eq!(
            sanitize_download_filename("../bad:name?.txt"),
            "bad_name_.txt"
        );
        assert_eq!(sanitize_download_filename("..."), "download");
        assert!(sanitize_download_filename(&"a".repeat(500)).len() <= 180);
    }

    #[test]
    fn duplicate_names_never_overwrite() {
        let root = std::env::temp_dir().join(format!("keydex-download-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("report.pdf"), b"existing").unwrap();
        assert_eq!(
            unique_download_path(&root, "report.pdf"),
            root.join("report (1).pdf")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dangerous_types_and_interrupts_are_classified() {
        assert!(is_dangerous_download("setup.EXE"));
        assert!(is_dangerous_download("script.ps1"));
        assert!(!is_dangerous_download("report.pdf"));
        assert_eq!(download_interrupt_category(29), "process_failed");
        assert_eq!(download_interrupt_category(21), "tls_certificate");
    }

    #[test]
    fn source_url_secrets_are_redacted() {
        let sanitized = sanitize_download_url("https://example.com/file?token=secret&view=1");
        assert!(!sanitized.contains("secret"));
        assert!(sanitized.contains("view=1"));
    }

    #[test]
    fn process_failure_cancels_only_downloads_owned_by_the_failed_surface() {
        let failed = surface("failed");
        let neighbor = surface("neighbor");
        let mut ledger = DownloadLedger::default();
        for (id, surface) in [
            ("download-failed", failed.clone()),
            ("download-neighbor", neighbor.clone()),
        ] {
            ledger.insert(PendingDownload {
                id: id.to_string(),
                surface,
                suggested_filename: "report.pdf".to_string(),
            });
        }

        assert_eq!(ledger.cancel_surface(&failed), vec!["download-failed"]);
        assert!(ledger.consume("download-failed", &failed).is_none());
        assert!(ledger.consume("download-neighbor", &neighbor).is_some());
    }
}
