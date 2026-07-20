pub mod cwd;
pub mod manager;
pub mod process;
pub mod process_tree;
pub mod profiles;
pub mod protocol;
pub mod replay;

use tauri::{ipc::Channel, State};

use manager::TerminalManager;
use protocol::{
    TerminalAttachSnapshot, TerminalError, TerminalEvent, TerminalProfileSnapshot, TerminalSize,
    TerminalSnapshot,
};

#[tauri::command]
pub fn terminal_list_profiles(state: State<'_, TerminalManager>) -> Vec<TerminalProfileSnapshot> {
    state.list_profiles()
}

#[tauri::command]
pub async fn terminal_create(
    state: State<'_, TerminalManager>,
    session_id: String,
    cwd: Option<String>,
    profile: String,
    cols: u16,
    rows: u16,
) -> Result<TerminalSnapshot, TerminalError> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.create(
            session_id,
            cwd,
            profile,
            TerminalSize {
                cols,
                rows,
                pixel_width: None,
                pixel_height: None,
            },
        )
    })
    .await
    .map_err(|error| TerminalError::internal(error.to_string()))?
}

#[tauri::command]
pub fn terminal_list(
    state: State<'_, TerminalManager>,
    session_id: String,
) -> Result<Vec<TerminalSnapshot>, TerminalError> {
    state.list(&session_id)
}

#[tauri::command]
pub fn terminal_attach(
    state: State<'_, TerminalManager>,
    terminal_id: String,
    after_seq: u64,
    on_event: Channel<TerminalEvent>,
) -> Result<TerminalAttachSnapshot, TerminalError> {
    state.attach(&terminal_id, after_seq, on_event)
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, TerminalManager>,
    terminal_id: String,
    data_base64: String,
) -> Result<(), TerminalError> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.write(&terminal_id, &data_base64))
        .await
        .map_err(|error| TerminalError::internal(error.to_string()))?
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, TerminalManager>,
    terminal_id: String,
    cols: u16,
    rows: u16,
    pixel_width: Option<u16>,
    pixel_height: Option<u16>,
) -> Result<(), TerminalError> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        manager.resize(
            &terminal_id,
            TerminalSize {
                cols,
                rows,
                pixel_width,
                pixel_height,
            },
        )
    })
    .await
    .map_err(|error| TerminalError::internal(error.to_string()))?
}

#[tauri::command]
pub async fn terminal_kill(
    state: State<'_, TerminalManager>,
    terminal_id: String,
) -> Result<(), TerminalError> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.kill(&terminal_id))
        .await
        .map_err(|error| TerminalError::internal(error.to_string()))?
}

#[tauri::command]
pub fn terminal_rename(
    state: State<'_, TerminalManager>,
    terminal_id: String,
    title: String,
) -> Result<TerminalSnapshot, TerminalError> {
    state.rename(&terminal_id, &title)
}

#[tauri::command]
pub async fn terminal_close(
    state: State<'_, TerminalManager>,
    terminal_id: String,
) -> Result<(), TerminalError> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.close(&terminal_id))
        .await
        .map_err(|error| TerminalError::internal(error.to_string()))?
}

#[tauri::command]
pub async fn terminal_close_session(
    state: State<'_, TerminalManager>,
    session_id: String,
) -> Result<usize, TerminalError> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.close_session(&session_id))
        .await
        .map_err(|error| TerminalError::internal(error.to_string()))?
}

#[tauri::command]
pub async fn terminal_close_all(state: State<'_, TerminalManager>) -> Result<usize, TerminalError> {
    let manager = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.close_all())
        .await
        .map_err(|error| TerminalError::internal(error.to_string()))?
}
