use std::{
    cell::RefCell,
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, Once},
    time::Duration,
};

use uuid::Uuid;

use super::{
    contract::{
        BrowserDownloadControlAction, BrowserDownloadDecision, BrowserEvent, BrowserSurfaceRef,
        ControlDownloadInput, DownloadCompletedPayload, DownloadFailedPayload,
        DownloadInterruptedPayload, DownloadProgressPayload, DownloadRequestedPayload,
        DownloadResumedPayload, DownloadStartedPayload, RespondDownloadInput,
    },
    ui_actor::NativeBrowserSurface,
};

#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingDownload {
    id: String,
    surface: BrowserSurfaceRef,
    url: String,
    suggested_filename: String,
    total_bytes: Option<u64>,
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
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ManagedTransferCommand {
    Running,
    Paused,
    Cancelled,
}

struct ManagedDownloadControl {
    surface: BrowserSurfaceRef,
    command: Mutex<ManagedTransferCommand>,
    wake: Condvar,
}

struct ManagedDownloadRequest {
    download_id: String,
    url: String,
    cookie_header: Option<String>,
    referrer: Option<String>,
    user_agent: Option<String>,
    target_path: PathBuf,
    total_bytes_hint: Option<u64>,
    emit: Arc<dyn Fn(BrowserEvent) + Send + Sync>,
    control: Arc<ManagedDownloadControl>,
    transfers: Arc<Mutex<HashMap<String, Arc<ManagedDownloadControl>>>>,
}

#[cfg(windows)]
thread_local! {
    static NATIVE_DOWNLOAD_HANDLES: RefCell<HashMap<String, NativeDownloadHandle>> =
        RefCell::new(HashMap::new());
}

#[derive(Clone, Default)]
pub(crate) struct DownloadManager {
    ledger: Arc<Mutex<DownloadLedger>>,
    transfers: Arc<Mutex<HashMap<String, Arc<ManagedDownloadControl>>>>,
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
        resolve_native_download(webview, pending, target, self.transfers.clone())
    }

    #[cfg(windows)]
    pub(crate) fn control(
        &self,
        _webview: &NativeBrowserSurface,
        input: &ControlDownloadInput,
    ) -> Result<(), String> {
        let surface = input.surface.clone();
        let download_id = input.download_id.clone();
        let control = self
            .transfers
            .lock()
            .map_err(|_| "下载管理器暂不可用".to_string())?
            .get(&download_id)
            .filter(|control| control.surface == surface)
            .cloned()
            .ok_or_else(|| "下载任务已结束或不属于当前网页".to_string())?;
        let mut command = control
            .command
            .lock()
            .map_err(|_| "下载任务状态暂不可用".to_string())?;
        match input.action {
            BrowserDownloadControlAction::Pause if *command == ManagedTransferCommand::Running => {
                *command = ManagedTransferCommand::Paused;
            }
            BrowserDownloadControlAction::Resume if *command == ManagedTransferCommand::Paused => {
                *command = ManagedTransferCommand::Running;
                control.wake.notify_all();
            }
            BrowserDownloadControlAction::Cancel => {
                *command = ManagedTransferCommand::Cancelled;
                control.wake.notify_all();
            }
            BrowserDownloadControlAction::Pause => {
                return Err("该下载任务当前无法暂停".to_string());
            }
            BrowserDownloadControlAction::Resume => {
                return Err("该下载任务当前无法恢复".to_string());
            }
        }
        Ok(())
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
                let pending = PendingDownload {
                    id,
                    surface: surface.clone(),
                    url: String::new(),
                    suggested_filename: "download".to_string(),
                    total_bytes: None,
                };
                let _ = resolve_native_download(webview, pending, None, self.transfers.clone());
            }
            cancel_managed_downloads_for_surface(&self.transfers, surface);
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
        let base_core = surface_handle.core().clone();
        let Ok(core) = base_core.cast::<ICoreWebView2_4>() else {
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
                            emit: emit.clone(),
                        },
                    );
                });
                manager.insert(PendingDownload {
                    id: download_id.clone(),
                    surface: surface.clone(),
                    url: url.clone(),
                    suggested_filename: suggested_filename.clone(),
                    total_bytes: u64::try_from(total).ok(),
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
    pending: PendingDownload,
    target: Option<PathBuf>,
    transfers: Arc<Mutex<HashMap<String, Arc<ManagedDownloadControl>>>>,
) -> Result<(), String> {
    webview
        .run(move |surface_handle| unsafe {
            let download_id = pending.id.clone();
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
                (handle.emit)(BrowserEvent::DownloadFailed(DownloadFailedPayload {
                    download_id,
                    error_category: "cancelled".to_string(),
                }));
                return Ok(());
            };
            let target_path = target.to_string_lossy().to_string();
            let filename = target
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_else(|| "download".to_string());
            let cookie_header =
                read_cookie_header(surface_handle.core(), &pending.url).unwrap_or_default();
            let referrer = read_operation_string(|value| surface_handle.core().Source(value));
            let user_agent = read_browser_user_agent(surface_handle.core());
            handle
                .args
                .SetCancel(true)
                .map_err(|error| format!("Failed to hand download to Keydex: {error}"))?;
            handle
                .deferral
                .Complete()
                .map_err(|error| format!("Failed to release browser download: {error}"))?;

            let control = Arc::new(ManagedDownloadControl {
                surface: handle.surface,
                command: Mutex::new(ManagedTransferCommand::Running),
                wake: Condvar::new(),
            });
            transfers
                .lock()
                .map_err(|_| "Download manager is unavailable".to_string())?
                .insert(download_id.clone(), control.clone());
            (handle.emit)(BrowserEvent::DownloadStarted(DownloadStartedPayload {
                download_id: download_id.clone(),
                file_path: target_path,
                filename,
            }));
            let request = ManagedDownloadRequest {
                download_id: download_id.clone(),
                url: pending.url,
                cookie_header: (!cookie_header.is_empty()).then_some(cookie_header),
                referrer: referrer.filter(|value| !value.is_empty()),
                user_agent,
                target_path: target,
                total_bytes_hint: pending.total_bytes,
                emit: handle.emit,
                control,
                transfers: transfers.clone(),
            };
            if let Err(error) = spawn_managed_download(request) {
                transfers
                    .lock()
                    .ok()
                    .and_then(|mut transfers| transfers.remove(&download_id));
                return Err(error);
            }
            Ok(())
        })
        .map_err(|error| format!("Failed to resolve download request: {error}"))
}

#[cfg(windows)]
fn spawn_managed_download(request: ManagedDownloadRequest) -> Result<(), String> {
    std::thread::Builder::new()
        .name(format!("keydex-download-{}", request.download_id))
        .spawn(move || run_managed_download(request))
        .map(|_| ())
        .map_err(|error| format!("Failed to start managed download: {error}"))
}

fn run_managed_download(request: ManagedDownloadRequest) {
    let partial_path = managed_partial_path(&request.target_path, &request.download_id);
    let client = match build_download_client(request.user_agent.as_deref()) {
        Ok(client) => client,
        Err(_) => {
            finish_managed_download(&request, &partial_path, "client_unavailable");
            return;
        }
    };
    let mut received_bytes = fs::metadata(&partial_path)
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    let mut total_bytes = request.total_bytes_hint;
    let mut paused_event_emitted = false;

    'transfer: loop {
        let command = match wait_until_runnable(&request.control) {
            Ok(command) => command,
            Err(_) => {
                finish_managed_download(&request, &partial_path, "state_unavailable");
                return;
            }
        };
        if command == ManagedTransferCommand::Cancelled {
            finish_managed_download(&request, &partial_path, "cancelled");
            return;
        }
        if paused_event_emitted {
            (request.emit)(BrowserEvent::DownloadResumed(DownloadResumedPayload {
                download_id: request.download_id.clone(),
            }));
        }

        let mut builder = client.get(&request.url);
        if received_bytes > 0 {
            builder = builder.header(reqwest::header::RANGE, format!("bytes={received_bytes}-"));
        }
        if let Some(cookie_header) = &request.cookie_header {
            builder = builder.header(reqwest::header::COOKIE, cookie_header);
        }
        if let Some(referrer) = &request.referrer {
            builder = builder.header(reqwest::header::REFERER, referrer);
        }
        let mut response = match builder.send() {
            Ok(response) if response.status().is_success() => response,
            Ok(response) => {
                finish_managed_download(
                    &request,
                    &partial_path,
                    &format!("http_{}", response.status().as_u16()),
                );
                return;
            }
            Err(_) => {
                if !pause_after_transfer_error(&request, "network") {
                    finish_managed_download(&request, &partial_path, "cancelled");
                    return;
                }
                paused_event_emitted = true;
                continue;
            }
        };

        let resumed = received_bytes > 0;
        if resumed && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
            received_bytes = 0;
        }
        total_bytes = response_total_bytes(&response, received_bytes).or(total_bytes);
        let mut file = match open_partial_file(&partial_path, received_bytes > 0) {
            Ok(file) => file,
            Err(_) => {
                finish_managed_download(&request, &partial_path, "file_unavailable");
                return;
            }
        };
        let mut buffer = vec![0_u8; 128 * 1024];
        loop {
            let command = request
                .control
                .command
                .lock()
                .map(|command| *command)
                .unwrap_or(ManagedTransferCommand::Cancelled);
            if command == ManagedTransferCommand::Cancelled {
                drop(file);
                finish_managed_download(&request, &partial_path, "cancelled");
                return;
            }
            if command == ManagedTransferCommand::Paused {
                (request.emit)(BrowserEvent::DownloadInterrupted(
                    DownloadInterruptedPayload {
                        download_id: request.download_id.clone(),
                        error_category: "paused".to_string(),
                        can_resume: true,
                    },
                ));
                paused_event_emitted = true;
                continue 'transfer;
            }
            match response.read(&mut buffer) {
                Ok(0) => {
                    if total_bytes.is_some_and(|total| received_bytes < total) {
                        if !pause_after_transfer_error(&request, "network") {
                            drop(file);
                            finish_managed_download(&request, &partial_path, "cancelled");
                            return;
                        }
                        paused_event_emitted = true;
                        continue 'transfer;
                    }
                    if file.flush().is_err() || file.sync_all().is_err() {
                        drop(file);
                        finish_managed_download(&request, &partial_path, "file_unavailable");
                        return;
                    }
                    drop(file);
                    if fs::rename(&partial_path, &request.target_path).is_err() {
                        finish_managed_download(&request, &partial_path, "target_conflict");
                        return;
                    }
                    remove_managed_transfer(&request);
                    (request.emit)(BrowserEvent::DownloadCompleted(DownloadCompletedPayload {
                        download_id: request.download_id,
                        file_path: request.target_path.to_string_lossy().to_string(),
                    }));
                    return;
                }
                Ok(read) => {
                    if file.write_all(&buffer[..read]).is_err() {
                        drop(file);
                        finish_managed_download(&request, &partial_path, "file_unavailable");
                        return;
                    }
                    received_bytes = received_bytes.saturating_add(read as u64);
                    (request.emit)(BrowserEvent::DownloadProgress(DownloadProgressPayload {
                        download_id: request.download_id.clone(),
                        received_bytes,
                        total_bytes,
                    }));
                }
                Err(_) => {
                    drop(file);
                    if !pause_after_transfer_error(&request, "network") {
                        finish_managed_download(&request, &partial_path, "cancelled");
                        return;
                    }
                    paused_event_emitted = true;
                    continue 'transfer;
                }
            }
        }
    }
}

fn build_download_client(user_agent: Option<&str>) -> Result<reqwest::blocking::Client, String> {
    install_download_tls_provider()?;
    let mut builder = reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(30));
    if let Some(user_agent) = user_agent.filter(|value| !value.is_empty()) {
        builder = builder.user_agent(user_agent);
    }
    builder
        .build()
        .map_err(|error| format!("Failed to prepare HTTP client: {error}"))
}

fn install_download_tls_provider() -> Result<(), String> {
    static INSTALL_PROVIDER: Once = Once::new();
    INSTALL_PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    rustls::crypto::CryptoProvider::get_default()
        .map(|_| ())
        .ok_or_else(|| "Failed to install the browser download TLS provider".to_string())
}

fn wait_until_runnable(control: &ManagedDownloadControl) -> Result<ManagedTransferCommand, String> {
    let mut command = control
        .command
        .lock()
        .map_err(|_| "Download state is unavailable".to_string())?;
    while *command == ManagedTransferCommand::Paused {
        command = control
            .wake
            .wait(command)
            .map_err(|_| "Download state is unavailable".to_string())?;
    }
    Ok(*command)
}

fn pause_after_transfer_error(request: &ManagedDownloadRequest, category: &str) -> bool {
    let mut command = match request.control.command.lock() {
        Ok(command) => command,
        Err(_) => return false,
    };
    if *command == ManagedTransferCommand::Cancelled {
        return false;
    }
    *command = ManagedTransferCommand::Paused;
    drop(command);
    (request.emit)(BrowserEvent::DownloadInterrupted(
        DownloadInterruptedPayload {
            download_id: request.download_id.clone(),
            error_category: category.to_string(),
            can_resume: true,
        },
    ));
    true
}

fn response_total_bytes(response: &reqwest::blocking::Response, offset: u64) -> Option<u64> {
    response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit_once('/'))
        .and_then(|(_, total)| total.parse::<u64>().ok())
        .or_else(|| response.content_length().map(|length| length + offset))
}

fn open_partial_file(path: &Path, append: bool) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    if append {
        options.append(true);
    } else {
        options.truncate(true);
    }
    options
        .open(path)
        .map_err(|error| format!("Failed to open partial download: {error}"))
}

fn managed_partial_path(target: &Path, download_id: &str) -> PathBuf {
    let filename = target
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".to_string());
    target.with_file_name(format!(".{filename}.{download_id}.part"))
}

fn remove_managed_transfer(request: &ManagedDownloadRequest) {
    if let Ok(mut transfers) = request.transfers.lock() {
        transfers.remove(&request.download_id);
    }
}

fn finish_managed_download(
    request: &ManagedDownloadRequest,
    partial_path: &Path,
    error_category: &str,
) {
    remove_managed_transfer(request);
    if error_category == "cancelled" {
        let _ = fs::remove_file(partial_path);
    }
    (request.emit)(BrowserEvent::DownloadFailed(DownloadFailedPayload {
        download_id: request.download_id.clone(),
        error_category: error_category.to_string(),
    }));
}

fn cancel_managed_downloads_for_surface(
    transfers: &Arc<Mutex<HashMap<String, Arc<ManagedDownloadControl>>>>,
    surface: &BrowserSurfaceRef,
) {
    let controls = transfers
        .lock()
        .map(|transfers| {
            transfers
                .values()
                .filter(|control| control.surface == *surface)
                .cloned()
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for control in controls {
        if let Ok(mut command) = control.command.lock() {
            *command = ManagedTransferCommand::Cancelled;
            control.wake.notify_all();
        }
    }
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

#[cfg(windows)]
unsafe fn read_cookie_header(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
    url: &str,
) -> Result<String, String> {
    use std::sync::mpsc;

    use webview2_com::{
        GetCookiesCompletedHandler, Microsoft::Web::WebView2::Win32::ICoreWebView2_2,
    };
    use windows_061::core::{Interface, HSTRING, PCWSTR};

    let core = core
        .cast::<ICoreWebView2_2>()
        .map_err(|error| format!("Cookie manager is unavailable: {error}"))?;
    let manager = core
        .CookieManager()
        .map_err(|error| format!("Cookie manager is unavailable: {error}"))?;
    let uri = HSTRING::from(url);
    let (sender, receiver) = mpsc::channel();
    manager
        .GetCookies(
            PCWSTR::from_raw(uri.as_ptr()),
            &GetCookiesCompletedHandler::create(Box::new(move |status, cookies| {
                let result: windows_061::core::Result<Vec<(String, String)>> = (move || {
                    status?;
                    let Some(cookies) = cookies else {
                        return Ok(Vec::<(String, String)>::new());
                    };
                    let mut count = 0_u32;
                    cookies.Count(&mut count)?;
                    let mut result = Vec::with_capacity(count as usize);
                    for index in 0..count {
                        let cookie = cookies.GetValueAtIndex(index)?;
                        let name = read_operation_string(|value| cookie.Name(value));
                        let value = read_operation_string(|output| cookie.Value(output));
                        if let (Some(name), Some(value)) = (name, value) {
                            result.push((name, value));
                        }
                    }
                    Ok(result)
                })();
                sender
                    .send(result)
                    .map_err(|_| windows_061::core::Error::from_win32())
            })),
        )
        .map_err(|error| format!("Failed to request browser cookies: {error}"))?;
    let cookies = webview2_com::wait_with_pump(receiver)
        .map_err(|error| format!("Failed to receive browser cookies: {error}"))?
        .map_err(|error| format!("Failed to read browser cookies: {error}"))?;
    Ok(cookies
        .into_iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; "))
}

#[cfg(windows)]
unsafe fn read_browser_user_agent(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) -> Option<String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings2;
    use windows_061::core::Interface;

    let settings = core
        .Settings()
        .ok()?
        .cast::<ICoreWebView2Settings2>()
        .ok()?;
    read_operation_string(|value| settings.UserAgent(value))
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

#[cfg(test)]
mod tests {
    use std::{
        net::TcpListener,
        sync::atomic::{AtomicBool, Ordering},
    };

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
    fn managed_transfer_commits_only_after_response_eof() {
        let root = std::env::temp_dir().join(format!("keydex-download-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("report.txt");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello")
                .unwrap();
        });
        let completed = Arc::new(AtomicBool::new(false));
        let completed_for_event = completed.clone();
        let emit: Arc<dyn Fn(BrowserEvent) + Send + Sync> = Arc::new(move |event| {
            if matches!(event, BrowserEvent::DownloadCompleted(_)) {
                completed_for_event.store(true, Ordering::Release);
            }
        });
        let control = Arc::new(ManagedDownloadControl {
            surface: surface("current"),
            command: Mutex::new(ManagedTransferCommand::Running),
            wake: Condvar::new(),
        });
        let transfers = Arc::new(Mutex::new(HashMap::from([(
            "download-1".to_string(),
            control.clone(),
        )])));
        run_managed_download(ManagedDownloadRequest {
            download_id: "download-1".to_string(),
            url: format!("http://{address}/report.txt"),
            cookie_header: None,
            referrer: None,
            user_agent: None,
            target_path: target.clone(),
            total_bytes_hint: None,
            emit,
            control,
            transfers: transfers.clone(),
        });
        server.join().unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"hello");
        assert!(completed.load(Ordering::Acquire));
        assert!(transfers.lock().unwrap().is_empty());
        assert!(!managed_partial_path(&target, "download-1").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn dangerous_types_are_classified_before_user_confirmation() {
        assert!(is_dangerous_download("setup.EXE"));
        assert!(is_dangerous_download("script.ps1"));
        assert!(!is_dangerous_download("report.pdf"));
    }

    #[test]
    fn managed_download_uses_a_distinct_partial_path_until_protocol_eof() {
        let target = PathBuf::from(r"C:\Downloads\report.pdf");
        assert_eq!(
            managed_partial_path(&target, "download-1"),
            PathBuf::from(r"C:\Downloads\.report.pdf.download-1.part")
        );
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
            url: "https://example.com/setup.exe".to_string(),
            suggested_filename: "setup.exe".to_string(),
            total_bytes: Some(12),
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
            url: "https://example.com/report.pdf".to_string(),
            suggested_filename: "report.pdf".to_string(),
            total_bytes: None,
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
                url: "https://example.com/report.pdf".to_string(),
                suggested_filename: "report.pdf".to_string(),
                total_bytes: None,
            });
        }

        assert_eq!(ledger.cancel_surface(&failed), vec!["download-failed"]);
        assert!(ledger.consume("download-failed", &failed).is_none());
        assert!(ledger.consume("download-neighbor", &neighbor).is_some());
    }
}
