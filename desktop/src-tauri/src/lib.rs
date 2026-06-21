use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Manager, State};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<Child>>,
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
fn dev_agent_connection() -> AgentConnection {
    AgentConnection {
        host: "127.0.0.1".to_string(),
        port: 8765,
        base_url: "http://127.0.0.1:8765".to_string(),
        data_dir: "".to_string(),
    }
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
fn wait_for_health(host: String, port: u16, timeout_ms: u64) -> Result<(), String> {
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
    let mut command = Command::new(binary);
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
    if let Err(err) = wait_for_health("127.0.0.1".to_string(), port, 10_000) {
        if let Some(mut child) = state.child.lock().map_err(|err| err.to_string())?.take() {
            kill_child(&mut child);
        }
        return Err(err);
    }
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

pub fn run() {
    tauri::Builder::default()
        .manage(SidecarState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            allocate_port,
            dev_agent_connection,
            start_sidecar,
            stop_sidecar,
            wait_for_health
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<SidecarState>();
                let _ = stop_sidecar(state);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
