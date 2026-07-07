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
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const WINDOW_CLOSE_REQUESTED_EVENT: &str = "keydex://window-close-requested";
const TRAY_ID: &str = "keydex-tray";
const TRAY_SHOW_ID: &str = "show_main_window";
const TRAY_EXIT_ID: &str = "exit_app";

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<Child>>,
    closing: AtomicBool,
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
        command
            .arg(format!("/select,{}", resolved.to_string_lossy()))
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
    tauri::Builder::default()
        .manage(SidecarState::default())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
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
            write_text_file,
            copy_file_to_clipboard
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
