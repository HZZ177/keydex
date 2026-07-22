use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Mutex,
};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    webview::PageLoadEvent,
    Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State,
};
use url::Url;

mod browser;
#[cfg(windows)]
mod supervisor;
mod terminal;

use browser::host::{
    browser_begin_interactive_resize, browser_cancel_selection, browser_capture_region,
    browser_clear_highlights, browser_clear_profile_data, browser_configure_overlay,
    browser_create_surface, browser_destroy_surface, browser_discard_capture,
    browser_end_interactive_resize, browser_find, browser_go_back, browser_go_forward,
    browser_navigate, browser_navigate_to_annotation_target, browser_reload,
    browser_render_highlights, browser_resolve_annotations, browser_respond_download,
    browser_respond_permission, browser_set_resource_state, browser_set_visibility,
    browser_set_zoom, browser_start_selection, browser_stop, browser_stop_find,
    browser_sync_geometry, browser_take_incognito_capture, reload_main_webview, BrowserHostState,
};
use terminal::manager::TerminalManager;
use terminal::{
    terminal_ack, terminal_attach, terminal_close, terminal_close_all, terminal_close_session,
    terminal_create, terminal_detach, terminal_kill, terminal_list, terminal_list_profiles,
    terminal_rename, terminal_resize, terminal_write,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const WINDOW_CLOSE_REQUESTED_EVENT: &str = "keydex://window-close-requested";
const ASSOCIATED_FILE_OPEN_REQUESTED_EVENT: &str = "keydex://associated-file-open-requested";
const UPDATE_RELAUNCH_ENV: &str = "KEYDEX_UPDATE_RELAUNCH_WITHOUT_FILE_INTENT";
const DEV_AGENT_BASE_URL_ENV: &str = "KEYDEX_DEV_AGENT_BASE_URL";
const TRAY_ID: &str = "keydex-tray";
const TRAY_SHOW_ID: &str = "show_main_window";
const TRAY_EXIT_ID: &str = "exit_app";
const INITIAL_WINDOW_WIDTH_RATIO: f64 = 0.75;
const INITIAL_WINDOW_HEIGHT_RATIO: f64 = 0.85;
// Preserve the previous resizing range while scaling both limits with the startup monitor.
const MIN_WINDOW_WIDTH_TO_INITIAL_RATIO: f64 = 880.0 / 1445.0;
const MIN_WINDOW_HEIGHT_TO_INITIAL_RATIO: f64 = 620.0 / 900.0;
const EXIT_CLEANUP_DEADLINE: Duration = Duration::from_secs(2);
const CHILD_TERMINATION_DEADLINE: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, Copy, PartialEq)]
struct StartupWindowGeometry {
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
    x: i32,
    y: i32,
}

fn calculate_startup_window_geometry(
    work_area_position: PhysicalPosition<i32>,
    work_area_size: PhysicalSize<u32>,
    scale_factor: f64,
) -> Option<StartupWindowGeometry> {
    if !scale_factor.is_finite()
        || scale_factor <= 0.0
        || work_area_size.width == 0
        || work_area_size.height == 0
    {
        return None;
    }

    let work_area_width = f64::from(work_area_size.width) / scale_factor;
    let work_area_height = f64::from(work_area_size.height) / scale_factor;
    let width = work_area_width * INITIAL_WINDOW_WIDTH_RATIO;
    let height = work_area_height * INITIAL_WINDOW_HEIGHT_RATIO;
    let physical_width = (width * scale_factor).round() as i32;
    let physical_height = (height * scale_factor).round() as i32;

    Some(StartupWindowGeometry {
        width,
        height,
        min_width: width * MIN_WINDOW_WIDTH_TO_INITIAL_RATIO,
        min_height: height * MIN_WINDOW_HEIGHT_TO_INITIAL_RATIO,
        x: work_area_position.x + (work_area_size.width as i32 - physical_width) / 2,
        y: work_area_position.y + (work_area_size.height as i32 - physical_height) / 2,
    })
}

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<Child>>,
    closing: AtomicBool,
}

#[derive(Default)]
struct AssociatedFileOpenState {
    pending_paths: Mutex<Vec<String>>,
}

impl AssociatedFileOpenState {
    fn with_paths(paths: Vec<String>) -> Self {
        Self {
            pending_paths: Mutex::new(paths),
        }
    }

    fn push_paths(&self, paths: Vec<String>) {
        if paths.is_empty() {
            return;
        }
        if let Ok(mut pending) = self.pending_paths.lock() {
            for path in paths {
                if !pending.iter().any(|item| item == &path) {
                    pending.push(path);
                }
            }
        }
    }

    fn take_paths(&self) -> Result<Vec<String>, String> {
        let mut pending = self.pending_paths.lock().map_err(|err| err.to_string())?;
        Ok(std::mem::take(&mut *pending))
    }
}

impl Drop for SidecarState {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            if let Some(mut child) = child.take() {
                let _ = kill_child(&mut child);
            }
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
struct AgentConnection {
    host: String,
    port: u16,
    base_url: String,
    data_dir: String,
}

#[tauri::command]
fn resolve_dev_agent_connection() -> Result<Option<AgentConnection>, String> {
    if !cfg!(debug_assertions) {
        return Ok(None);
    }

    let configured = match std::env::var(DEV_AGENT_BASE_URL_ENV) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => {
            return Err(format!("{DEV_AGENT_BASE_URL_ENV} must be valid Unicode"))
        }
    };

    resolve_dev_agent_connection_value(configured.as_deref(), true)
}

fn resolve_dev_agent_connection_value(
    configured: Option<&str>,
    debug_enabled: bool,
) -> Result<Option<AgentConnection>, String> {
    if !debug_enabled {
        return Ok(None);
    }

    let Some(configured) = configured.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let url =
        Url::parse(configured).map_err(|err| format!("invalid {DEV_AGENT_BASE_URL_ENV}: {err}"))?;
    if url.scheme() != "http" {
        return Err(format!("{DEV_AGENT_BASE_URL_ENV} must use http"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(format!(
            "{DEV_AGENT_BASE_URL_ENV} must not include credentials"
        ));
    }
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err(format!(
            "{DEV_AGENT_BASE_URL_ENV} must not include a path, query, or fragment"
        ));
    }

    let host = url
        .host_str()
        .ok_or_else(|| format!("{DEV_AGENT_BASE_URL_ENV} must include a host"))?;
    if host != "127.0.0.1" && host != "localhost" {
        return Err(format!(
            "{DEV_AGENT_BASE_URL_ENV} only allows 127.0.0.1 or localhost"
        ));
    }
    let port = url
        .port()
        .ok_or_else(|| format!("{DEV_AGENT_BASE_URL_ENV} must include an explicit port"))?;

    Ok(Some(AgentConnection {
        host: host.to_string(),
        port,
        base_url: format!("http://{host}:{port}"),
        data_dir: String::new(),
    }))
}

#[derive(Serialize)]
struct LocalTextFileResponse {
    path: String,
    content: String,
    encoding: String,
}

#[tauri::command]
fn allocate_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|err| err.to_string())?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn wait_for_health(host: String, port: u16, timeout_ms: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || wait_for_health_blocking(host, port, timeout_ms))
        .await
        .map_err(|err| err.to_string())?
}

fn wait_for_health_blocking(host: String, port: u16, timeout_ms: u64) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    while Instant::now() < deadline {
        if health_probe(&host, port).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("agent server health wait timed out".to_string())
}

fn health_probe(host: &str, port: u16) -> Result<(), String> {
    let mut stream = TcpStream::connect((host, port)).map_err(|err| err.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|err| err.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_millis(500)))
        .map_err(|err| err.to_string())?;
    let request =
        format!("GET /api/health HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .map_err(|err| err.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|err| err.to_string())?;
    if response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200") {
        Ok(())
    } else {
        Err("agent server health check did not return 200".to_string())
    }
}

fn resolve_sidecar_binary(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|err| err.to_string())?;
    let candidates = [
        resource_dir
            .join("binaries")
            .join("agent-server")
            .join("agent-server.exe"),
        resource_dir.join("agent-server").join("agent-server.exe"),
        resource_dir.join("agent-server.exe"),
        resource_dir
            .join("binaries")
            .join("agent-server-x86_64-pc-windows-msvc.exe"),
    ];
    candidates
        .into_iter()
        .find(|path| path.exists())
        .ok_or_else(|| "agent server sidecar binary was not found".to_string())
}

fn kill_child(child: &mut Child) -> Result<(), String> {
    if child
        .try_wait()
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Ok(());
    }

    child.kill().map_err(|error| error.to_string())?;
    let deadline = Instant::now() + CHILD_TERMINATION_DEADLINE;
    loop {
        if child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "process {} did not terminate within {} ms",
                child.id(),
                CHILD_TERMINATION_DEADLINE.as_millis()
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[tauri::command]
fn start_sidecar(
    app: tauri::AppHandle,
    state: State<'_, SidecarState>,
    port: u16,
) -> Result<AgentConnection, String> {
    if let Some(mut child) = state.child.lock().map_err(|err| err.to_string())?.take() {
        kill_child(&mut child)?;
    }
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|err| err.to_string())?
        .to_string_lossy()
        .to_string();
    let binary = resolve_sidecar_binary(&app)?;
    let binary_dir = binary.parent().map(PathBuf::from);
    let mut command = Command::new(&binary);
    if let Some(parent) = binary_dir {
        command.current_dir(parent);
    }
    command
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--data-dir")
        .arg(&data_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let child = command.spawn().map_err(|err| err.to_string())?;
    *state.child.lock().map_err(|err| err.to_string())? = Some(child);
    Ok(AgentConnection {
        host: "127.0.0.1".to_string(),
        port,
        base_url: format!("http://127.0.0.1:{port}"),
        data_dir,
    })
}

#[tauri::command]
fn stop_sidecar(state: State<'_, SidecarState>) -> Result<(), String> {
    if let Some(mut child) = state.child.lock().map_err(|err| err.to_string())?.take() {
        kill_child(&mut child)?;
    }
    Ok(())
}

#[tauri::command]
fn hide_main_window(window: tauri::Window) -> Result<(), String> {
    window.hide().map_err(|err| err.to_string())
}

#[tauri::command]
fn request_app_exit(
    app: tauri::AppHandle,
    state: State<'_, SidecarState>,
    terminals: State<'_, TerminalManager>,
    browser: State<'_, BrowserHostState>,
) -> Result<(), String> {
    request_exit(&app, &state, &terminals, &browser)
}

#[tauri::command]
fn open_path_in_file_manager(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let resolved = resolve_existing_filesystem_path(&path)?;
        let mut command = windows_file_manager_command(&resolved);
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        command.spawn().map_err(|err| err.to_string())?;
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        Err("当前平台暂不支持在资源管理器中打开".to_string())
    }
}

#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    let cleaned = path.trim();
    if cleaned.is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    std::fs::write(cleaned, contents).map_err(|err| err.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<LocalTextFileResponse, String> {
    let cleaned = path.trim();
    if cleaned.is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    let requested = PathBuf::from(cleaned);
    if !requested.is_file() {
        return Err("只能预览文件".to_string());
    }
    let resolved = requested.canonicalize().unwrap_or(requested);
    let content = std::fs::read_to_string(&resolved).map_err(|err| err.to_string())?;
    Ok(LocalTextFileResponse {
        path: resolved.to_string_lossy().to_string(),
        content,
        encoding: "utf-8".to_string(),
    })
}

#[tauri::command]
fn copy_file_to_clipboard(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let resolved = resolve_existing_filesystem_path(&path)?;
        let resolved_text = resolved.to_string_lossy().to_string();
        if !resolved.is_file() {
            return Err("只能复制文件".to_string());
        }
        let script = r#"
Add-Type -AssemblyName System.Windows.Forms
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add($args[0])
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
"#;
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script])
            .arg(resolved_text)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let status = command.status().map_err(|err| err.to_string())?;
        if status.success() {
            return Ok(());
        }
        return Err("复制文件到剪贴板失败".to_string());
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        Err("当前平台暂不支持复制文件".to_string())
    }
}

#[tauri::command]
fn take_associated_file_open_paths(
    state: State<'_, AssociatedFileOpenState>,
) -> Result<Vec<String>, String> {
    state.take_paths()
}

#[tauri::command]
async fn relaunch_after_app_update(
    app: tauri::AppHandle,
    terminals: State<'_, TerminalManager>,
) -> Result<(), String> {
    let manager = terminals.inner().clone();
    let cleanup =
        tauri::async_runtime::spawn_blocking(move || close_terminals_with_deadline(manager))
            .await
            .map_err(|error| error.to_string())?;
    if let Err(error) = cleanup {
        eprintln!("failed to close embedded terminals before update relaunch: {error}");
    }
    #[cfg(windows)]
    {
        supervisor::notify_restart_requested()?;
        app.exit(0);
    }
    #[cfg(not(windows))]
    {
        std::env::set_var(UPDATE_RELAUNCH_ENV, "1");
        app.request_restart();
    }
    Ok(())
}

#[cfg(windows)]
fn resolve_existing_filesystem_path(path: &str) -> Result<PathBuf, String> {
    let cleaned = path.trim();
    if cleaned.is_empty() {
        return Err("文件路径不能为空".to_string());
    }
    let path = PathBuf::from(cleaned);
    if !path.exists() {
        return Err("文件不存在".to_string());
    }
    path.canonicalize().map_err(|err| err.to_string())
}

#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
enum WindowsFileManagerTarget {
    OpenDirectory(PathBuf),
    SelectEntry(PathBuf),
}

#[cfg(windows)]
fn windows_file_manager_target(path: &Path) -> WindowsFileManagerTarget {
    let shell_path = windows_shell_compatible_path(path);
    if path.is_dir() {
        WindowsFileManagerTarget::OpenDirectory(shell_path)
    } else {
        WindowsFileManagerTarget::SelectEntry(shell_path)
    }
}

#[cfg(windows)]
fn windows_file_manager_command(path: &Path) -> Command {
    let mut command = Command::new("explorer.exe");
    match windows_file_manager_target(path) {
        WindowsFileManagerTarget::OpenDirectory(directory) => {
            command.arg(directory);
        }
        WindowsFileManagerTarget::SelectEntry(entry) => {
            // Explorer parses `/select,` itself instead of using the standard
            // Windows argv rules. Keep the switch separate so paths containing
            // spaces or commas are quoted as the target path, not with the
            // switch inside the same quoted argument.
            command.arg("/select,").arg(entry);
        }
    }
    command
}

#[cfg(windows)]
fn windows_shell_compatible_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(unc_path) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc_path}"));
    }
    if let Some(local_path) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(local_path);
    }
    path.to_path_buf()
}

fn collect_associated_markdown_paths<I>(args: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter()
        .filter_map(|arg| {
            let cleaned = arg.trim();
            if cleaned.is_empty() {
                return None;
            }
            let path = PathBuf::from(cleaned);
            if !path.is_file() || !is_supported_markdown_path(&path) {
                return None;
            }
            Some(
                path.canonicalize()
                    .unwrap_or(path)
                    .to_string_lossy()
                    .to_string(),
            )
        })
        .collect()
}

fn collect_startup_associated_markdown_paths<I>(args: I, update_relaunch: bool) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    if update_relaunch {
        Vec::new()
    } else {
        collect_associated_markdown_paths(args)
    }
}

fn take_update_relaunch_marker() -> bool {
    let marked = std::env::var_os(UPDATE_RELAUNCH_ENV).is_some();
    if marked {
        std::env::remove_var(UPDATE_RELAUNCH_ENV);
    }
    marked
}

fn is_supported_markdown_path(path: &PathBuf) -> bool {
    let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(ext.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdx")
}

fn request_exit(
    app: &tauri::AppHandle,
    state: &SidecarState,
    terminals: &TerminalManager,
    browser: &BrowserHostState,
) -> Result<(), String> {
    if state.closing.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    #[cfg(windows)]
    if let Err(error) = supervisor::notify_exit_requested() {
        eprintln!("failed to notify the Keydex exit supervisor: {error}");
    }

    let child = match state.child.lock() {
        Ok(mut child) => child.take(),
        Err(error) => {
            eprintln!("failed to take the agent sidecar during exit: {error}");
            None
        }
    };
    let _ = app.remove_tray_by_id(TRAY_ID);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let app = app.clone();
    let terminals = terminals.clone();
    let browser = browser.clone();
    tauri::async_runtime::spawn_blocking(move || {
        run_parallel_exit_cleanup(browser, terminals, child);
        app.exit(0);
    });
    Ok(())
}

type ExitCleanupResult = (&'static str, Result<(), String>);

fn run_parallel_exit_cleanup(
    browser: BrowserHostState,
    terminals: TerminalManager,
    child: Option<Child>,
) {
    let (sender, receiver) = mpsc::channel::<ExitCleanupResult>();
    let mut task_count = 0usize;
    task_count += spawn_exit_cleanup_task("browser-shutdown", sender.clone(), move || {
        browser.shutdown();
        Ok(())
    });
    task_count += spawn_exit_cleanup_task("terminal-shutdown", sender.clone(), move || {
        terminals
            .close_all()
            .map(|_| ())
            .map_err(|error| error.to_string())
    });
    if let Some(mut child) = child {
        task_count += spawn_exit_cleanup_task("sidecar-shutdown", sender.clone(), move || {
            kill_child(&mut child)
        });
    }
    drop(sender);

    let completed = wait_for_exit_cleanup(&receiver, task_count, EXIT_CLEANUP_DEADLINE);
    if completed < task_count {
        eprintln!(
            "exit cleanup reached its {} ms global deadline with {} task(s) still pending",
            EXIT_CLEANUP_DEADLINE.as_millis(),
            task_count - completed
        );
    }
}

fn wait_for_exit_cleanup(
    receiver: &mpsc::Receiver<ExitCleanupResult>,
    task_count: usize,
    timeout: Duration,
) -> usize {
    let deadline = Instant::now() + timeout;
    let mut completed = 0usize;
    while completed < task_count {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        match receiver.recv_timeout(remaining) {
            Ok((_name, Ok(()))) => completed += 1,
            Ok((name, Err(error))) => {
                completed += 1;
                eprintln!("{name} failed during exit: {error}");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => break,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    completed
}

fn spawn_exit_cleanup_task<F>(
    name: &'static str,
    sender: mpsc::Sender<ExitCleanupResult>,
    work: F,
) -> usize
where
    F: FnOnce() -> Result<(), String> + Send + 'static,
{
    match std::thread::Builder::new()
        .name(name.to_string())
        .spawn(move || {
            let result = work();
            let _ = sender.send((name, result));
        }) {
        Ok(_) => 1,
        Err(error) => {
            eprintln!("failed to spawn {name}: {error}");
            0
        }
    }
}

fn close_terminals_with_deadline(terminals: TerminalManager) -> Result<(), String> {
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("update-terminal-shutdown".to_string())
        .spawn(move || {
            let result = terminals
                .close_all()
                .map(|_| ())
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(EXIT_CLEANUP_DEADLINE)
        .map_err(|_| "终端清理超过 2 秒，继续重启更新".to_string())?
}

fn show_main_window(app: &tauri::AppHandle) {
    if app.state::<SidecarState>().closing.load(Ordering::SeqCst) {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(dev)]
fn recover_blank_dev_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let Some(dev_url) = app.config().build.dev_url.as_ref() else {
        return Ok(());
    };

    let current_url = window.url()?;
    eprintln!(
        "[keydex:dev] main window URL before recovery: {current_url}; configured devUrl: {dev_url}"
    );
    if current_url.as_str() == "about:blank" {
        eprintln!("[keydex:dev] main window is about:blank; navigating to {dev_url}");
        window.navigate(dev_url.clone())?;
    }

    Ok(())
}

fn initialize_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let startup_monitor = window
        .cursor_position()
        .ok()
        .and_then(|position| {
            window
                .monitor_from_point(position.x, position.y)
                .ok()
                .flatten()
        })
        .or_else(|| window.current_monitor().ok().flatten())
        .or_else(|| window.primary_monitor().ok().flatten());

    if let Some(monitor) = startup_monitor {
        let work_area = monitor.work_area();
        if let Some(geometry) = calculate_startup_window_geometry(
            work_area.position,
            work_area.size,
            monitor.scale_factor(),
        ) {
            let configure_result: tauri::Result<()> = (|| {
                window.set_min_size(Some(LogicalSize::new(
                    geometry.min_width,
                    geometry.min_height,
                )))?;
                window.set_size(LogicalSize::new(geometry.width, geometry.height))?;
                window.set_position(PhysicalPosition::new(geometry.x, geometry.y))?;
                Ok(())
            })();

            if let Err(error) = configure_result {
                eprintln!("failed to initialize main window geometry: {error}");
                let _ = window.center();
            }
        }
    }

    window.show()?;
    let _ = window.set_focus();
    Ok(())
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, TRAY_SHOW_ID, "显示主界面", true, None::<&str>)?;
    let exit_item = MenuItem::with_id(app, TRAY_EXIT_ID, "退出程序", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &exit_item])?;
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .tooltip("Keydex")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if id == TRAY_SHOW_ID {
                show_main_window(app);
                return;
            }
            if id == TRAY_EXIT_ID {
                let state = app.state::<SidecarState>();
                let terminals = app.state::<TerminalManager>();
                let browser = app.state::<BrowserHostState>();
                let _ = request_exit(app, &state, &terminals, &browser);
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }

    tray.build(app)?;
    Ok(())
}

pub fn run_entrypoint() -> i32 {
    #[cfg(windows)]
    {
        match supervisor::bootstrap() {
            Ok(supervisor::BootstrapOutcome::RunDesktop) => {
                run();
                0
            }
            Ok(supervisor::BootstrapOutcome::SupervisorExited(exit_code)) => exit_code,
            Err(error) => {
                eprintln!("failed to start the Keydex process supervisor: {error}");
                1
            }
        }
    }

    #[cfg(not(windows))]
    {
        run();
        0
    }
}

pub fn run() {
    let startup_associated_paths = collect_startup_associated_markdown_paths(
        std::env::args_os()
            .skip(1)
            .filter_map(|arg| arg.into_string().ok()),
        take_update_relaunch_marker(),
    );

    tauri::Builder::default()
        .manage(SidecarState::default())
        .manage(BrowserHostState::default())
        .manage(TerminalManager::default())
        .manage(AssociatedFileOpenState::with_paths(
            startup_associated_paths,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            show_main_window(app);
            let paths = collect_associated_markdown_paths(args);
            if !paths.is_empty() {
                app.state::<AssociatedFileOpenState>().push_paths(paths);
                let _ = app.emit(ASSOCIATED_FILE_OPEN_REQUESTED_EVENT, ());
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .on_page_load(|webview, page| {
            if webview.label() != "main" || page.event() != PageLoadEvent::Started {
                return;
            }
            let removed = webview
                .state::<BrowserHostState>()
                .reset_renderer_surfaces_in_background();
            if removed > 0 {
                eprintln!(
                    "reclaimed {removed} browser surface(s) before loading a new main renderer"
                );
            }
        })
        .setup(|app| {
            initialize_main_window(app.handle())?;
            #[cfg(dev)]
            recover_blank_dev_window(app.handle())?;
            setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            resolve_dev_agent_connection,
            allocate_port,
            start_sidecar,
            stop_sidecar,
            wait_for_health,
            hide_main_window,
            request_app_exit,
            open_path_in_file_manager,
            read_text_file,
            write_text_file,
            copy_file_to_clipboard,
            take_associated_file_open_paths,
            relaunch_after_app_update,
            reload_main_webview,
            browser_create_surface,
            browser_destroy_surface,
            browser_navigate,
            browser_go_back,
            browser_go_forward,
            browser_reload,
            browser_stop,
            browser_find,
            browser_stop_find,
            browser_start_selection,
            browser_configure_overlay,
            browser_cancel_selection,
            browser_resolve_annotations,
            browser_render_highlights,
            browser_clear_highlights,
            browser_navigate_to_annotation_target,
            browser_capture_region,
            browser_discard_capture,
            browser_take_incognito_capture,
            browser_set_zoom,
            browser_set_resource_state,
            browser_sync_geometry,
            browser_begin_interactive_resize,
            browser_end_interactive_resize,
            browser_set_visibility,
            browser_clear_profile_data,
            browser_respond_permission,
            browser_respond_download,
            terminal_list_profiles,
            terminal_create,
            terminal_list,
            terminal_attach,
            terminal_ack,
            terminal_detach,
            terminal_write,
            terminal_resize,
            terminal_kill,
            terminal_rename,
            terminal_close,
            terminal_close_session,
            terminal_close_all
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<SidecarState>();
                if state.closing.load(Ordering::SeqCst) {
                    return;
                }

                api.prevent_close();
                let _ = window.emit(WINDOW_CLOSE_REQUESTED_EVENT, ());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        calculate_startup_window_geometry, collect_startup_associated_markdown_paths,
        resolve_dev_agent_connection_value, spawn_exit_cleanup_task, wait_for_exit_cleanup,
        AgentConnection,
    };
    #[cfg(windows)]
    use super::{
        windows_file_manager_command, windows_file_manager_target, windows_shell_compatible_path,
        WindowsFileManagerTarget,
    };
    use std::fs;
    #[cfg(windows)]
    use std::path::{Path, PathBuf};
    use std::sync::mpsc;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
    use tauri::{PhysicalPosition, PhysicalSize};

    #[test]
    fn dev_agent_connection_accepts_an_explicit_loopback_http_endpoint() {
        assert_eq!(
            resolve_dev_agent_connection_value(Some(" http://127.0.0.1:8765/ "), true).unwrap(),
            Some(AgentConnection {
                host: "127.0.0.1".to_string(),
                port: 8765,
                base_url: "http://127.0.0.1:8765".to_string(),
                data_dir: String::new(),
            })
        );
        assert_eq!(
            resolve_dev_agent_connection_value(Some("http://localhost:18765"), true)
                .unwrap()
                .unwrap()
                .base_url,
            "http://localhost:18765"
        );
    }

    #[test]
    fn dev_agent_connection_is_disabled_for_release_builds_and_empty_configuration() {
        assert_eq!(
            resolve_dev_agent_connection_value(Some("http://127.0.0.1:8765"), false).unwrap(),
            None
        );
        assert_eq!(
            resolve_dev_agent_connection_value(None, true).unwrap(),
            None
        );
        assert_eq!(
            resolve_dev_agent_connection_value(Some("  "), true).unwrap(),
            None
        );
    }

    #[test]
    fn dev_agent_connection_rejects_non_loopback_or_ambiguous_endpoints() {
        for invalid in [
            "https://127.0.0.1:8765",
            "http://192.168.1.10:8765",
            "http://127.0.0.1",
            "http://127.0.0.1:8765/api",
            "http://127.0.0.1:8765/?token=secret",
            "http://user@127.0.0.1:8765",
        ] {
            assert!(
                resolve_dev_agent_connection_value(Some(invalid), true).is_err(),
                "{invalid} should be rejected"
            );
        }
    }

    #[test]
    fn exit_cleanup_tasks_run_in_parallel_under_one_global_deadline() {
        let (sender, receiver) = mpsc::channel();
        let started = Instant::now();
        let first = spawn_exit_cleanup_task("first-exit-test", sender.clone(), || {
            std::thread::sleep(Duration::from_millis(80));
            Ok(())
        });
        let second = spawn_exit_cleanup_task("second-exit-test", sender.clone(), || {
            std::thread::sleep(Duration::from_millis(80));
            Ok(())
        });
        drop(sender);

        assert_eq!(
            wait_for_exit_cleanup(&receiver, first + second, Duration::from_secs(1)),
            2
        );
        assert!(started.elapsed() < Duration::from_millis(300));
    }

    #[test]
    fn exit_cleanup_stops_waiting_at_the_global_deadline() {
        let (sender, receiver) = mpsc::channel();
        let task_count = spawn_exit_cleanup_task("slow-exit-test", sender.clone(), || {
            std::thread::sleep(Duration::from_millis(250));
            Ok(())
        });
        drop(sender);
        let started = Instant::now();

        assert_eq!(
            wait_for_exit_cleanup(&receiver, task_count, Duration::from_millis(25)),
            0
        );
        assert!(started.elapsed() < Duration::from_millis(150));
    }

    #[test]
    fn startup_window_geometry_scales_from_the_monitor_work_area() {
        let geometry = calculate_startup_window_geometry(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1032),
            1.0,
        )
        .expect("a valid monitor should produce startup geometry");

        assert_eq!(geometry.width, 1440.0);
        assert!((geometry.height - 877.2).abs() < 1e-9);
        assert!((geometry.min_width - 876.955_017_301_038).abs() < 1e-9);
        assert!((geometry.min_height - 604.293_333_333_333_3).abs() < 1e-9);
        assert_eq!((geometry.x, geometry.y), (240, 77));
    }

    #[test]
    fn startup_window_geometry_uses_logical_pixels_on_scaled_secondary_monitors() {
        let geometry = calculate_startup_window_geometry(
            PhysicalPosition::new(-2560, -352),
            PhysicalSize::new(2560, 1368),
            1.5,
        )
        .expect("a scaled monitor should produce startup geometry");

        assert_eq!(geometry.width, 1280.0);
        assert!((geometry.height - 775.2).abs() < 1e-9);
        assert!((geometry.min_width - 779.515_570_934_256).abs() < 1e-9);
        assert!((geometry.min_height - 534.026_666_666_666_6).abs() < 1e-9);
        assert_eq!((geometry.x, geometry.y), (-2240, -250));
    }

    #[test]
    fn startup_window_geometry_rejects_invalid_monitor_metrics() {
        assert!(calculate_startup_window_geometry(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(1920, 1080),
            0.0,
        )
        .is_none());
        assert!(calculate_startup_window_geometry(
            PhysicalPosition::new(0, 0),
            PhysicalSize::new(0, 1080),
            1.0,
        )
        .is_none());
    }

    #[cfg(windows)]
    #[test]
    fn file_manager_opens_directory_itself_and_only_selects_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after the Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("keydex file-manager,{unique}"));
        let file = directory.join("README.md");
        fs::create_dir(&directory).expect("temporary directory should be created");
        fs::write(&file, "# file manager regression").expect("temporary file should be created");

        let resolved_directory = directory
            .canonicalize()
            .expect("temporary directory should be canonicalized");
        let resolved_file = file
            .canonicalize()
            .expect("temporary file should be canonicalized");

        assert_eq!(
            windows_file_manager_target(&resolved_directory),
            WindowsFileManagerTarget::OpenDirectory(windows_shell_compatible_path(
                &resolved_directory
            )),
        );
        assert_eq!(
            windows_file_manager_target(&resolved_file),
            WindowsFileManagerTarget::SelectEntry(windows_shell_compatible_path(&resolved_file)),
        );
        let shell_directory = windows_shell_compatible_path(&resolved_directory);
        let shell_file = windows_shell_compatible_path(&resolved_file);
        assert_eq!(
            windows_file_manager_command(&resolved_directory)
                .get_args()
                .collect::<Vec<_>>(),
            vec![shell_directory.as_os_str()],
        );
        assert_eq!(
            windows_file_manager_command(&resolved_file)
                .get_args()
                .collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new("/select,"), shell_file.as_os_str()],
        );

        fs::remove_file(file).expect("temporary file should be removed");
        fs::remove_dir(directory).expect("temporary directory should be removed");
    }

    #[cfg(windows)]
    #[test]
    fn file_manager_strips_windows_verbatim_prefixes_for_explorer() {
        assert_eq!(
            windows_shell_compatible_path(Path::new(r"\\?\C:\repo\keydex")),
            PathBuf::from(r"C:\repo\keydex"),
        );
        assert_eq!(
            windows_shell_compatible_path(Path::new(r"\\?\UNC\server\share\keydex")),
            PathBuf::from(r"\\server\share\keydex"),
        );
    }

    #[test]
    fn update_relaunch_drops_inherited_file_intent_but_normal_startup_keeps_it() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after the Unix epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("keydex-update-relaunch-{unique}.md"));
        fs::write(&path, "# update relaunch regression")
            .expect("temporary Markdown file should be created");
        let argument = path.to_string_lossy().to_string();

        let normal_paths = collect_startup_associated_markdown_paths([argument.clone()], false);
        let update_paths = collect_startup_associated_markdown_paths([argument], true);

        assert_eq!(normal_paths.len(), 1);
        assert!(update_paths.is_empty());

        fs::remove_file(path).expect("temporary Markdown file should be removed");
    }
}
