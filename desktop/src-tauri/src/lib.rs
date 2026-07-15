use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, State,
};

#[cfg(windows)]
use std::ffi::OsString;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use std::path::Path;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const WINDOW_CLOSE_REQUESTED_EVENT: &str = "keydex://window-close-requested";
const ASSOCIATED_FILE_OPEN_REQUESTED_EVENT: &str = "keydex://associated-file-open-requested";
const UPDATE_RELAUNCH_ENV: &str = "KEYDEX_UPDATE_RELAUNCH_WITHOUT_FILE_INTENT";
const TRAY_ID: &str = "keydex-tray";
const TRAY_SHOW_ID: &str = "show_main_window";
const TRAY_EXIT_ID: &str = "exit_app";

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
                kill_child(&mut child);
            }
        }
    }
}

#[derive(Serialize)]
struct AgentConnection {
    host: String,
    port: u16,
    base_url: String,
    data_dir: String,
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

fn kill_child(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let mut command = Command::new("taskkill");
        command
            .args(["/PID", &pid, "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        if command
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
        {
            let _ = child.wait();
            return;
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
fn start_sidecar(
    app: tauri::AppHandle,
    state: State<'_, SidecarState>,
    port: u16,
) -> Result<AgentConnection, String> {
    if let Some(mut child) = state.child.lock().map_err(|err| err.to_string())?.take() {
        kill_child(&mut child);
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
        kill_child(&mut child);
    }
    Ok(())
}

#[tauri::command]
fn hide_main_window(window: tauri::Window) -> Result<(), String> {
    window.hide().map_err(|err| err.to_string())
}

#[tauri::command]
fn request_app_exit(app: tauri::AppHandle, state: State<'_, SidecarState>) -> Result<(), String> {
    request_exit(&app, &state)
}

#[tauri::command]
fn open_path_in_file_manager(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let resolved = resolve_existing_filesystem_path(&path)?;
        let mut command = Command::new("explorer.exe");
        match windows_file_manager_target(&resolved) {
            WindowsFileManagerTarget::OpenDirectory(directory) => {
                command.arg(directory);
            }
            WindowsFileManagerTarget::SelectEntry(entry) => {
                let mut argument = OsString::from("/select,");
                argument.push(entry);
                command.arg(argument);
            }
        }
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
        return Err("鏂囦欢璺緞涓嶈兘涓虹┖".to_string());
    }
    let requested = PathBuf::from(cleaned);
    if !requested.is_file() {
        return Err("鍙兘棰勮鏂囦欢".to_string());
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
fn relaunch_after_app_update(app: tauri::AppHandle) {
    std::env::set_var(UPDATE_RELAUNCH_ENV, "1");
    app.request_restart();
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

fn request_exit(app: &tauri::AppHandle, state: &SidecarState) -> Result<(), String> {
    if state.closing.swap(true, Ordering::SeqCst) {
        return Ok(());
    }

    let child = state.child.lock().map_err(|err| err.to_string())?.take();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(mut child) = child {
            kill_child(&mut child);
        }
        app.exit(0);
    });
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
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
                let _ = request_exit(app, &state);
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

pub fn run() {
    let startup_associated_paths = collect_startup_associated_markdown_paths(
        std::env::args_os()
            .skip(1)
            .filter_map(|arg| arg.into_string().ok()),
        take_update_relaunch_marker(),
    );

    tauri::Builder::default()
        .manage(SidecarState::default())
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
        .setup(|app| {
            setup_tray(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
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
            relaunch_after_app_update
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
    use super::collect_startup_associated_markdown_paths;
    #[cfg(windows)]
    use super::{
        windows_file_manager_target, windows_shell_compatible_path, WindowsFileManagerTarget,
    };
    use std::fs;
    #[cfg(windows)]
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(windows)]
    #[test]
    fn file_manager_opens_directory_itself_and_only_selects_files() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time should be after the Unix epoch")
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("keydex-file-manager-{unique}"));
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
