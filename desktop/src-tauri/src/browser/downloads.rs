use std::{
    cell::RefCell,
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use uuid::Uuid;

use super::{
    contract::{
        BrowserDownloadControlAction, BrowserDownloadDecision, BrowserEvent, BrowserSurfaceRef,
        ControlDownloadInput, DownloadCompletedPayload, DownloadFailedPayload,
        DownloadProgressPayload, DownloadRequestedPayload, DownloadStartedPayload,
        RespondDownloadInput,
    },
    ui_actor::NativeBrowserSurface,
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
    navigation_failures: HashMap<String, DownloadNavigationFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DownloadNavigationFailure {
    surface: BrowserSurfaceRef,
    remaining: u32,
}

impl DownloadLedger {
    fn insert(&mut self, download: PendingDownload) {
        let surface = download.surface.clone();
        self.pending.insert(download.id.clone(), download);
        let entry = self
            .navigation_failures
            .entry(surface.panel_id.clone())
            .or_insert_with(|| DownloadNavigationFailure {
                surface: surface.clone(),
                remaining: 0,
            });
        if entry.surface != surface {
            *entry = DownloadNavigationFailure {
                surface,
                remaining: 1,
            };
        } else {
            entry.remaining = entry.remaining.saturating_add(1);
        }
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
        if self
            .navigation_failures
            .get(&surface.panel_id)
            .is_some_and(|failure| failure.surface == *surface)
        {
            self.navigation_failures.remove(&surface.panel_id);
        }
        ids
    }

    fn begin_navigation(&mut self, surface: &BrowserSurfaceRef) {
        if self
            .navigation_failures
            .get(&surface.panel_id)
            .is_some_and(|failure| failure.surface == *surface)
        {
            self.navigation_failures.remove(&surface.panel_id);
        }
    }

    fn consume_navigation_failure(&mut self, surface: &BrowserSurfaceRef) -> bool {
        let Some(failure) = self.navigation_failures.get_mut(&surface.panel_id) else {
            return false;
        };
        if failure.surface != *surface || failure.remaining == 0 {
            return false;
        }
        failure.remaining -= 1;
        if failure.remaining == 0 {
            self.navigation_failures.remove(&surface.panel_id);
        }
        true
    }
}

#[cfg(windows)]
#[derive(Clone)]
struct NativeDownloadHandle {
    surface: BrowserSurfaceRef,
    args: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadStartingEventArgs,
    deferral: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Deferral,
    operation: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation,
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
}

#[cfg(windows)]
#[derive(Clone)]
struct ActiveDownloadHandle {
    surface: BrowserSurfaceRef,
    operation: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation,
}

#[cfg(windows)]
thread_local! {
    static NATIVE_DOWNLOAD_HANDLES: RefCell<HashMap<String, NativeDownloadHandle>> =
        RefCell::new(HashMap::new());
    static ACTIVE_DOWNLOAD_HANDLES: RefCell<HashMap<String, ActiveDownloadHandle>> =
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

    pub(crate) fn begin_navigation(&self, surface: &BrowserSurfaceRef) {
        if let Ok(mut ledger) = self.ledger.lock() {
            ledger.begin_navigation(surface);
        }
    }

    pub(crate) fn consume_navigation_failure(&self, surface: &BrowserSurfaceRef) -> bool {
        self.ledger
            .lock()
            .map(|mut ledger| ledger.consume_navigation_failure(surface))
            .unwrap_or(false)
    }

    #[cfg(windows)]
    pub(crate) fn respond(
        &self,
        webview: &NativeBrowserSurface,
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

    #[cfg(windows)]
    pub(crate) fn control(
        &self,
        webview: &NativeBrowserSurface,
        input: &ControlDownloadInput,
    ) -> Result<(), String> {
        let surface = input.surface.clone();
        let download_id = input.download_id.clone();
        let action = input.action.clone();
        webview.run(move |_| unsafe {
            let handle = ACTIVE_DOWNLOAD_HANDLES.with(|handles| {
                handles
                    .borrow()
                    .get(&download_id)
                    .filter(|handle| handle.surface == surface)
                    .cloned()
            });
            let Some(handle) = handle else {
                return Err("下载任务已结束或不属于当前网页".to_string());
            };
            match action {
                BrowserDownloadControlAction::Pause => handle
                    .operation
                    .Pause()
                    .map_err(|error| format!("暂停下载失败: {error}")),
                BrowserDownloadControlAction::Resume => {
                    let mut can_resume = windows_061::core::BOOL::default();
                    handle
                        .operation
                        .CanResume(&mut can_resume)
                        .map_err(|error| format!("无法确认下载是否可恢复: {error}"))?;
                    if !can_resume.as_bool() {
                        return Err("该下载任务当前无法恢复".to_string());
                    }
                    handle
                        .operation
                        .Resume()
                        .map_err(|error| format!("恢复下载失败: {error}"))
                }
                BrowserDownloadControlAction::Cancel => handle
                    .operation
                    .Cancel()
                    .map_err(|error| format!("取消下载失败: {error}")),
            }
        })
    }

    #[cfg(not(windows))]
    pub(crate) fn respond(
        &self,
        _webview: &NativeBrowserSurface,
        _downloads_dir: &Path,
        _input: &RespondDownloadInput,
    ) -> Result<(), String> {
        Err("Downloads are only available on Windows".to_string())
    }

    #[cfg(not(windows))]
    pub(crate) fn control(
        &self,
        _webview: &NativeBrowserSurface,
        _input: &ControlDownloadInput,
    ) -> Result<(), String> {
        Err("Downloads are only available on Windows".to_string())
    }

    pub(crate) fn cancel_pending_for_surface(
        &self,
        webview: Option<&NativeBrowserSurface>,
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
    webview: &NativeBrowserSurface,
    manager: DownloadManager,
    surface: BrowserSurfaceRef,
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> Result<(), String> {
    use webview2_com::DownloadStartingEventHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_4;
    use windows_061::core::Interface;

    webview.run(move |surface_handle| unsafe {
        let Ok(core) = surface_handle.core().cast::<ICoreWebView2_4>() else {
            return Err("WebView2 download API is unavailable".to_string());
        };
        let mut token = 0_i64;
        core.add_DownloadStarting(
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
                            surface: surface.clone(),
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
        )
        .map_err(|error| format!("Failed to attach browser download manager: {error}"))?;
        Ok(())
    })
}

#[cfg(not(windows))]
pub(crate) fn attach_download_manager(
    _webview: &NativeBrowserSurface,
    _manager: DownloadManager,
    _surface: BrowserSurfaceRef,
    _emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn resolve_native_download(
    webview: &NativeBrowserSurface,
    download_id: String,
    target: Option<PathBuf>,
) -> Result<(), String> {
    webview
        .run(move |_| unsafe {
            let handle =
                NATIVE_DOWNLOAD_HANDLES.with(|handles| handles.borrow_mut().remove(&download_id));
            let Some(handle) = handle else {
                return Err("Native download request is unavailable".to_string());
            };
            let Some(target) = target else {
                handle
                    .args
                    .SetCancel(true)
                    .map_err(|error| format!("Failed to cancel download: {error}"))?;
                handle.deferral.Complete().map_err(|error| {
                    format!("Failed to complete download cancellation: {error}")
                })?;
                return Ok(());
            };
            let target_path = target.to_string_lossy().to_string();
            let filename = target
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "download".to_string());
            let target = windows_061::core::HSTRING::from(target.as_os_str());
            if handle.args.SetResultFilePath(&target).is_err() {
                let _ = handle.args.SetCancel(true);
                let _ = handle.deferral.Complete();
                return Err("Failed to set managed download path".to_string());
            }
            if let Err(error) = attach_download_progress(
                &handle.operation,
                download_id.clone(),
                target_path.clone(),
                handle.emit.clone(),
            ) {
                let _ = handle.args.SetCancel(true);
                let _ = handle.operation.Cancel();
                let _ = handle.deferral.Complete();
                return Err(error);
            }
            ACTIVE_DOWNLOAD_HANDLES.with(|handles| {
                handles.borrow_mut().insert(
                    download_id.clone(),
                    ActiveDownloadHandle {
                        surface: handle.surface,
                        operation: handle.operation.clone(),
                    },
                );
            });
            (handle.emit)(BrowserEvent::DownloadStarted(DownloadStartedPayload {
                download_id: download_id.clone(),
                file_path: target_path,
                filename,
            }));
            if let Err(error) = handle.args.SetCancel(false) {
                ACTIVE_DOWNLOAD_HANDLES.with(|handles| {
                    handles.borrow_mut().remove(&download_id);
                });
                let _ = handle.operation.Cancel();
                let _ = handle.deferral.Complete();
                return Err(format!("Failed to accept download: {error}"));
            }
            if let Err(error) = handle.deferral.Complete() {
                ACTIVE_DOWNLOAD_HANDLES.with(|handles| {
                    handles.borrow_mut().remove(&download_id);
                });
                let _ = handle.operation.Cancel();
                return Err(format!("Failed to complete download request: {error}"));
            }
            Ok(())
        })
        .map_err(|error| format!("Failed to resolve download request: {error}"))
}

#[cfg(windows)]
unsafe fn attach_download_progress(
    operation: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2DownloadOperation,
    download_id: String,
    file_path: String,
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON, COREWEBVIEW2_DOWNLOAD_STATE,
        COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED, COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED,
    };
    use webview2_com::{BytesReceivedChangedEventHandler, StateChangedEventHandler};

    let terminal_emitted = Arc::new(AtomicBool::new(false));
    let progress_id = download_id.clone();
    let progress_emit = emit.clone();
    let progress_file_path = file_path.clone();
    let progress_terminal_emitted = terminal_emitted.clone();
    let mut progress_token = 0_i64;
    operation
        .add_BytesReceivedChanged(
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
                    if total > 0 && received >= total {
                        let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                        let _ = sender.State(&mut state);
                        if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED
                            && !progress_terminal_emitted.swap(true, Ordering::AcqRel)
                        {
                            ACTIVE_DOWNLOAD_HANDLES.with(|handles| {
                                handles.borrow_mut().remove(&progress_id);
                            });
                            progress_emit(BrowserEvent::DownloadCompleted(
                                DownloadCompletedPayload {
                                    download_id: progress_id.clone(),
                                    file_path: progress_file_path.clone(),
                                },
                            ));
                        }
                    }
                }
                Ok(())
            })),
            &mut progress_token,
        )
        .map_err(|error| format!("Failed to observe download progress: {error}"))?;

    let state_terminal_emitted = terminal_emitted;
    let mut state_token = 0_i64;
    operation
        .add_StateChanged(
            &StateChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(sender) = sender {
                    let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                    let _ = sender.State(&mut state);
                    if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED
                        && !state_terminal_emitted.swap(true, Ordering::AcqRel)
                    {
                        ACTIVE_DOWNLOAD_HANDLES.with(|handles| {
                            handles.borrow_mut().remove(&download_id);
                        });
                        emit(BrowserEvent::DownloadCompleted(DownloadCompletedPayload {
                            download_id: download_id.clone(),
                            file_path: file_path.clone(),
                        }));
                    } else if state == COREWEBVIEW2_DOWNLOAD_STATE_INTERRUPTED
                        && !state_terminal_emitted.swap(true, Ordering::AcqRel)
                    {
                        let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON::default();
                        let _ = sender.InterruptReason(&mut reason);
                        let category = download_interrupt_category(reason.0);
                        ACTIVE_DOWNLOAD_HANDLES.with(|handles| {
                            handles.borrow_mut().remove(&download_id);
                        });
                        if category == "cancelled" {
                            let _ = fs::remove_file(&file_path);
                        }
                        emit(BrowserEvent::DownloadFailed(DownloadFailedPayload {
                            download_id: download_id.clone(),
                            error_category: category.to_string(),
                        }));
                    }
                }
                Ok(())
            })),
            &mut state_token,
        )
        .map_err(|error| format!("Failed to observe download state: {error}"))?;
    Ok(())
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
    fn download_navigation_failure_is_consumed_once_and_never_leaks_to_the_next_navigation() {
        let current = surface("current");
        let neighbor = surface("neighbor");
        let mut ledger = DownloadLedger::default();
        ledger.insert(PendingDownload {
            id: "download-current".to_string(),
            surface: current.clone(),
            suggested_filename: "setup.exe".to_string(),
        });

        // Responding to the download may happen before WebView2 reports the
        // terminal navigation event. The navigation guard must outlive the
        // pending prompt entry.
        assert!(ledger.consume("download-current", &current).is_some());
        assert!(ledger.consume_navigation_failure(&current));
        assert!(!ledger.consume_navigation_failure(&current));
        assert!(!ledger.consume_navigation_failure(&neighbor));

        ledger.insert(PendingDownload {
            id: "download-stale".to_string(),
            surface: current.clone(),
            suggested_filename: "report.pdf".to_string(),
        });
        ledger.begin_navigation(&current);
        assert!(!ledger.consume_navigation_failure(&current));
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
