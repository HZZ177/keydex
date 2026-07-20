use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, MutexGuard,
};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{Child, ChildKiller, MasterPty};
use tauri::ipc::Channel;
use uuid::Uuid;

use super::cwd::resolve_initial_cwd;
use super::process::{spawn_terminal, to_pty_size, validate_terminal_size, SpawnedTerminal};
use super::process_tree::ManagedProcessTree;
use super::profiles::{list_shell_profiles, resolve_shell_profile};
use super::protocol::{
    error_codes, TerminalAttachSnapshot, TerminalError, TerminalEvent, TerminalProfileSnapshot,
    TerminalSize, TerminalSnapshot, TerminalStatus, TERMINAL_CONTRACT_VERSION,
    TERMINAL_GLOBAL_LIMIT, TERMINAL_MAX_INPUT_BYTES, TERMINAL_MAX_OUTPUT_CHUNK_BYTES,
    TERMINAL_REPLAY_LIMIT_BYTES, TERMINAL_SESSION_LIMIT,
};
use super::replay::ReplayRing;

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<TerminalManagerInner>,
}

struct TerminalManagerInner {
    registry: Mutex<TerminalRegistry>,
}

#[derive(Default)]
struct TerminalRegistry {
    terminals: HashMap<String, Arc<TerminalEntry>>,
    by_session: HashMap<String, Vec<String>>,
    reservations_by_session: HashMap<String, usize>,
    reservations_total: usize,
}

struct TerminalEntry {
    snapshot: Mutex<TerminalSnapshot>,
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    process_tree: Mutex<Option<ManagedProcessTree>>,
    last_size: Mutex<TerminalSize>,
    stream: Mutex<StreamState>,
    finalized: AtomicBool,
}

struct StreamState {
    replay: ReplayRing,
    subscriber: Option<Channel<TerminalEvent>>,
    subscriber_generation: u64,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(TerminalManagerInner {
                registry: Mutex::new(TerminalRegistry::default()),
            }),
        }
    }
}

impl TerminalManager {
    pub fn list_profiles(&self) -> Vec<TerminalProfileSnapshot> {
        list_shell_profiles()
    }

    pub fn create(
        &self,
        session_id: String,
        requested_cwd: Option<String>,
        profile_id: String,
        size: TerminalSize,
    ) -> Result<TerminalSnapshot, TerminalError> {
        let session_id = session_id.trim().to_string();
        if session_id.is_empty() {
            return Err(TerminalError::new(
                error_codes::SESSION_REQUIRED,
                "请先打开一个会话，再创建终端",
            ));
        }
        validate_terminal_size(size)?;
        let profile = resolve_shell_profile(&profile_id)?;
        let cwd = resolve_initial_cwd(requested_cwd.as_deref())?;
        let ordinal = self.reserve_create(&session_id)?;

        let spawned = match spawn_terminal(&profile, &cwd, size) {
            Ok(spawned) => spawned,
            Err(error) => {
                self.release_reservation(&session_id);
                return Err(error);
            }
        };

        let now = now_millis();
        let terminal_id = Uuid::new_v4().to_string();
        let snapshot = TerminalSnapshot {
            contract_version: TERMINAL_CONTRACT_VERSION,
            terminal_id: terminal_id.clone(),
            session_id: session_id.clone(),
            profile_id: profile.id,
            cwd: cwd.to_string_lossy().into_owned(),
            title: format!("{} {ordinal}", profile.label),
            status: TerminalStatus::Running,
            seq: 0,
            exit_code: None,
            created_at: now,
            updated_at: now,
        };
        let (entry, reader, child) = terminal_entry(snapshot.clone(), size, spawned);
        self.finish_create(&session_id, terminal_id.clone(), entry.clone());
        self.start_reader(terminal_id.clone(), entry.clone(), reader);
        self.start_waiter(terminal_id, entry, child);
        Ok(snapshot)
    }

    pub fn list(&self, session_id: &str) -> Result<Vec<TerminalSnapshot>, TerminalError> {
        let registry = self.registry()?;
        let ids = registry
            .by_session
            .get(session_id)
            .cloned()
            .unwrap_or_default();
        let entries: Vec<_> = ids
            .into_iter()
            .filter_map(|id| registry.terminals.get(&id).cloned())
            .collect();
        drop(registry);
        entries
            .into_iter()
            .map(|entry| lock(&entry.snapshot).map(|snapshot| snapshot.clone()))
            .collect()
    }

    pub fn attach(
        &self,
        terminal_id: &str,
        after_seq: u64,
        on_event: Channel<TerminalEvent>,
    ) -> Result<TerminalAttachSnapshot, TerminalError> {
        let entry = self.entry(terminal_id)?;
        let (truncated, mut replay, cursor) = {
            let mut stream = entry
                .stream
                .lock()
                .map_err(|_| TerminalError::new(error_codes::ATTACH_FAILED, "无法连接终端输出"))?;
            let (truncated, replay) = stream.replay.events_after(terminal_id, after_seq);
            stream.subscriber_generation = stream.subscriber_generation.wrapping_add(1).max(1);
            stream.subscriber = Some(on_event);
            (truncated, replay, stream.replay.latest_seq())
        };
        if truncated {
            let earliest_seq = entry
                .stream
                .lock()
                .map_err(|_| TerminalError::new(error_codes::ATTACH_FAILED, "无法读取终端回放"))?
                .replay
                .earliest_seq();
            replay.insert(
                0,
                TerminalEvent::ReplayTruncated {
                    terminal_id: terminal_id.to_string(),
                    earliest_seq,
                },
            );
        }
        let snapshot = lock(&entry.snapshot)?.clone();
        Ok(TerminalAttachSnapshot {
            snapshot,
            replay,
            cursor,
        })
    }

    pub fn write(&self, terminal_id: &str, data_base64: &str) -> Result<(), TerminalError> {
        let data = decode_terminal_input(data_base64)?;
        let entry = self.entry(terminal_id)?;
        ensure_running(&entry)?;
        let result = {
            let mut writer = lock(&entry.writer)?;
            let writer = writer
                .as_mut()
                .ok_or_else(|| TerminalError::new(error_codes::NOT_RUNNING, "终端输入已经关闭"))?;
            writer.write_all(&data).and_then(|_| writer.flush())
        };
        if let Err(error) = result {
            self.finalize_failed(
                terminal_id,
                &entry,
                error_codes::INTERNAL,
                format!("写入终端失败：{error}"),
            );
            return Err(TerminalError::internal("写入终端失败"));
        }
        Ok(())
    }

    pub fn resize(&self, terminal_id: &str, size: TerminalSize) -> Result<(), TerminalError> {
        validate_terminal_size(size)?;
        let entry = self.entry(terminal_id)?;
        ensure_running(&entry)?;
        {
            let last_size = lock(&entry.last_size)?;
            if *last_size == size {
                return Ok(());
            }
        }
        {
            let master = lock(&entry.master)?;
            master
                .as_ref()
                .ok_or_else(|| TerminalError::new(error_codes::NOT_RUNNING, "终端已经关闭"))?
                .resize(to_pty_size(size))
                .map_err(|error| TerminalError::internal(format!("调整终端尺寸失败：{error}")))?;
        }
        *lock(&entry.last_size)? = size;
        Ok(())
    }

    pub fn kill(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let entry = self.entry(terminal_id)?;
        kill_entry(&entry)
    }

    pub fn rename(&self, terminal_id: &str, title: &str) -> Result<TerminalSnapshot, TerminalError> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 80 {
            return Err(TerminalError::new(
                error_codes::TITLE_INVALID,
                "终端名称需要包含 1 到 80 个字符",
            ));
        }
        let entry = self.entry(terminal_id)?;
        let mut snapshot = lock(&entry.snapshot)?;
        snapshot.title = title.to_string();
        snapshot.updated_at = now_millis();
        Ok(snapshot.clone())
    }

    pub fn close(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let entry = match self.entry(terminal_id) {
            Ok(entry) => entry,
            Err(error) if error.code == error_codes::NOT_FOUND => return Ok(()),
            Err(error) => return Err(error),
        };
        let _ = kill_entry(&entry);
        lock(&entry.stream)?.subscriber = None;
        self.remove_entry(terminal_id)?;
        Ok(())
    }

    pub fn close_session(&self, session_id: &str) -> Result<usize, TerminalError> {
        let ids = {
            let registry = self.registry()?;
            registry
                .by_session
                .get(session_id)
                .cloned()
                .unwrap_or_default()
        };
        for terminal_id in &ids {
            let _ = self.close(terminal_id);
        }
        Ok(ids.len())
    }

    pub fn close_all(&self) -> Result<usize, TerminalError> {
        let ids = {
            let registry = self.registry()?;
            registry.terminals.keys().cloned().collect::<Vec<_>>()
        };
        for terminal_id in &ids {
            let _ = self.close(terminal_id);
        }
        Ok(ids.len())
    }

    fn start_reader(
        &self,
        terminal_id: String,
        entry: Arc<TerminalEntry>,
        mut reader: Box<dyn Read + Send>,
    ) {
        let manager = self.clone();
        thread::Builder::new()
            .name(format!("terminal-reader-{terminal_id}"))
            .spawn(move || {
                let mut buffer = vec![0_u8; TERMINAL_MAX_OUTPUT_CHUNK_BYTES];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => manager.publish_output(&terminal_id, &entry, &buffer[..read]),
                        Err(error) => {
                            manager.finalize_failed(
                                &terminal_id,
                                &entry,
                                error_codes::INTERNAL,
                                format!("读取终端输出失败：{error}"),
                            );
                            break;
                        }
                    }
                }
            })
            .expect("terminal reader thread must start");
    }

    fn start_waiter(
        &self,
        terminal_id: String,
        entry: Arc<TerminalEntry>,
        mut child: Box<dyn Child + Send + Sync>,
    ) {
        let manager = self.clone();
        thread::Builder::new()
            .name(format!("terminal-wait-{terminal_id}"))
            .spawn(move || match child.wait() {
                Ok(status) => manager.finalize_exited(
                    &terminal_id,
                    &entry,
                    i32::try_from(status.exit_code()).ok(),
                ),
                Err(error) => manager.finalize_failed(
                    &terminal_id,
                    &entry,
                    error_codes::INTERNAL,
                    format!("等待终端退出失败：{error}"),
                ),
            })
            .expect("terminal wait thread must start");
    }

    fn publish_output(&self, terminal_id: &str, entry: &Arc<TerminalEntry>, bytes: &[u8]) {
        let (event, subscriber) = match lock(&entry.stream) {
            Ok(mut stream) => {
                let seq = stream.replay.append(bytes);
                let event = TerminalEvent::Output {
                    terminal_id: terminal_id.to_string(),
                    seq,
                    data_base64: STANDARD.encode(bytes),
                };
                (
                    event,
                    stream
                        .subscriber
                        .clone()
                        .map(|channel| (stream.subscriber_generation, channel)),
                )
            }
            Err(_) => return,
        };
        if let Ok(mut snapshot) = entry.snapshot.lock() {
            if let TerminalEvent::Output { seq, .. } = &event {
                snapshot.seq = *seq;
                snapshot.updated_at = now_millis();
            }
        }
        if let Some((generation, channel)) = subscriber {
            if channel.send(event).is_err() {
                if let Ok(mut stream) = entry.stream.lock() {
                    if stream.subscriber_generation == generation {
                        stream.subscriber = None;
                    }
                }
            }
        }
    }

    fn finalize_exited(
        &self,
        terminal_id: &str,
        entry: &Arc<TerminalEntry>,
        exit_code: Option<i32>,
    ) {
        if entry.finalized.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut snapshot) = entry.snapshot.lock() {
            snapshot.status = TerminalStatus::Exited;
            snapshot.exit_code = exit_code;
            snapshot.updated_at = now_millis();
        }
        cleanup_process_handles(entry);
        send_terminal_event(
            entry,
            TerminalEvent::Exited {
                terminal_id: terminal_id.to_string(),
                exit_code,
            },
        );
    }

    fn finalize_failed(
        &self,
        terminal_id: &str,
        entry: &Arc<TerminalEntry>,
        code: &str,
        message: String,
    ) {
        if entry.finalized.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut snapshot) = entry.snapshot.lock() {
            snapshot.status = TerminalStatus::Failed;
            snapshot.updated_at = now_millis();
        }
        cleanup_process_handles(entry);
        send_terminal_event(
            entry,
            TerminalEvent::Failed {
                terminal_id: terminal_id.to_string(),
                code: code.to_string(),
                message,
            },
        );
    }

    fn reserve_create(&self, session_id: &str) -> Result<usize, TerminalError> {
        let mut registry = self.registry()?;
        let existing_session = registry
            .by_session
            .get(session_id)
            .map(Vec::len)
            .unwrap_or(0);
        let reserved_session = registry
            .reservations_by_session
            .get(session_id)
            .copied()
            .unwrap_or(0);
        if existing_session + reserved_session >= TERMINAL_SESSION_LIMIT {
            return Err(TerminalError::new(
                error_codes::SESSION_LIMIT_REACHED,
                format!("每个会话最多可打开 {TERMINAL_SESSION_LIMIT} 个终端"),
            ));
        }
        if registry.terminals.len() + registry.reservations_total >= TERMINAL_GLOBAL_LIMIT {
            return Err(TerminalError::new(
                error_codes::GLOBAL_LIMIT_REACHED,
                format!("Keydex 最多可同时打开 {TERMINAL_GLOBAL_LIMIT} 个终端"),
            ));
        }
        *registry
            .reservations_by_session
            .entry(session_id.to_string())
            .or_default() += 1;
        registry.reservations_total += 1;
        Ok(existing_session + reserved_session + 1)
    }

    fn release_reservation(&self, session_id: &str) {
        if let Ok(mut registry) = self.inner.registry.lock() {
            release_registry_reservation(&mut registry, session_id);
        }
    }

    fn finish_create(&self, session_id: &str, terminal_id: String, entry: Arc<TerminalEntry>) {
        let mut registry = self
            .inner
            .registry
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        release_registry_reservation(&mut registry, session_id);
        registry.terminals.insert(terminal_id.clone(), entry);
        registry
            .by_session
            .entry(session_id.to_string())
            .or_default()
            .push(terminal_id);
    }

    fn remove_entry(&self, terminal_id: &str) -> Result<(), TerminalError> {
        let mut registry = self.registry()?;
        let entry = registry
            .terminals
            .remove(terminal_id)
            .ok_or_else(|| TerminalError::new(error_codes::NOT_FOUND, "终端不存在"))?;
        let session_id = lock(&entry.snapshot)?.session_id.clone();
        if let Some(ids) = registry.by_session.get_mut(&session_id) {
            ids.retain(|id| id != terminal_id);
            if ids.is_empty() {
                registry.by_session.remove(&session_id);
            }
        }
        Ok(())
    }

    fn entry(&self, terminal_id: &str) -> Result<Arc<TerminalEntry>, TerminalError> {
        self.registry()?
            .terminals
            .get(terminal_id)
            .cloned()
            .ok_or_else(|| TerminalError::new(error_codes::NOT_FOUND, "终端不存在"))
    }

    fn registry(&self) -> Result<MutexGuard<'_, TerminalRegistry>, TerminalError> {
        lock(&self.inner.registry)
    }
}

impl Drop for TerminalManagerInner {
    fn drop(&mut self) {
        if let Ok(registry) = self.registry.get_mut() {
            for entry in registry.terminals.values() {
                let _ = kill_entry(entry);
            }
        }
    }
}

fn terminal_entry(
    snapshot: TerminalSnapshot,
    size: TerminalSize,
    spawned: SpawnedTerminal,
) -> (
    Arc<TerminalEntry>,
    Box<dyn Read + Send>,
    Box<dyn Child + Send + Sync>,
) {
    let SpawnedTerminal {
        master,
        writer,
        reader,
        child,
        killer,
        process_tree,
    } = spawned;
    (
        Arc::new(TerminalEntry {
            snapshot: Mutex::new(snapshot),
            master: Mutex::new(Some(master)),
            writer: Mutex::new(Some(writer)),
            killer: Mutex::new(Some(killer)),
            process_tree: Mutex::new(Some(process_tree)),
            last_size: Mutex::new(size),
            stream: Mutex::new(StreamState {
                replay: ReplayRing::new(TERMINAL_REPLAY_LIMIT_BYTES),
                subscriber: None,
                subscriber_generation: 0,
            }),
            finalized: AtomicBool::new(false),
        }),
        reader,
        child,
    )
}

fn ensure_running(entry: &TerminalEntry) -> Result<(), TerminalError> {
    let status = lock(&entry.snapshot)?.status;
    if status.is_running() {
        Ok(())
    } else {
        Err(TerminalError::new(
            error_codes::NOT_RUNNING,
            "终端已经停止运行",
        ))
    }
}

fn kill_entry(entry: &TerminalEntry) -> Result<(), TerminalError> {
    {
        let mut snapshot = lock(&entry.snapshot)?;
        if snapshot.status.is_terminal() {
            return Ok(());
        }
        snapshot.status = TerminalStatus::Closing;
        snapshot.updated_at = now_millis();
    }

    if let Some(process_tree) = lock(&entry.process_tree)?.as_ref() {
        if process_tree.kill().is_ok() {
            return Ok(());
        }
    }
    if let Some(killer) = lock(&entry.killer)?.as_mut() {
        killer
            .kill()
            .map_err(|error| TerminalError::internal(format!("关闭终端失败：{error}")))?;
    }
    Ok(())
}

fn cleanup_process_handles(entry: &TerminalEntry) {
    if let Ok(mut writer) = entry.writer.lock() {
        writer.take();
    }
    if let Ok(mut master) = entry.master.lock() {
        master.take();
    }
    if let Ok(mut killer) = entry.killer.lock() {
        killer.take();
    }
    if let Ok(mut process_tree) = entry.process_tree.lock() {
        process_tree.take();
    }
}

fn send_terminal_event(entry: &TerminalEntry, event: TerminalEvent) {
    let subscriber = entry
        .stream
        .lock()
        .ok()
        .and_then(|stream| stream.subscriber.clone());
    if let Some(subscriber) = subscriber {
        let _ = subscriber.send(event);
    }
}

fn release_registry_reservation(registry: &mut TerminalRegistry, session_id: &str) {
    if let Some(reserved) = registry.reservations_by_session.get_mut(session_id) {
        *reserved = reserved.saturating_sub(1);
        if *reserved == 0 {
            registry.reservations_by_session.remove(session_id);
        }
    }
    registry.reservations_total = registry.reservations_total.saturating_sub(1);
}

fn decode_terminal_input(data_base64: &str) -> Result<Vec<u8>, TerminalError> {
    let bytes = STANDARD
        .decode(data_base64)
        .map_err(|_| TerminalError::new(error_codes::INPUT_INVALID, "终端输入编码无效"))?;
    if bytes.len() > TERMINAL_MAX_INPUT_BYTES {
        return Err(TerminalError::new(
            error_codes::INPUT_TOO_LARGE,
            format!("单次终端输入不能超过 {TERMINAL_MAX_INPUT_BYTES} 字节"),
        ));
    }
    Ok(bytes)
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, TerminalError> {
    mutex
        .lock()
        .map_err(|_| TerminalError::internal("终端内部状态不可用"))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn input_decoder_preserves_raw_bytes_and_enforces_limit() {
        assert_eq!(
            decode_terminal_input("AOa1i+ivlQ==").unwrap(),
            vec![0, 230, 181, 139, 232, 175, 149]
        );
        assert_eq!(decode_terminal_input("").unwrap(), Vec::<u8>::new());
        assert_eq!(
            decode_terminal_input("not-base64").unwrap_err().code,
            error_codes::INPUT_INVALID
        );
        let oversized = STANDARD.encode(vec![0_u8; TERMINAL_MAX_INPUT_BYTES + 1]);
        assert_eq!(
            decode_terminal_input(&oversized).unwrap_err().code,
            error_codes::INPUT_TOO_LARGE
        );
    }

    #[test]
    fn registry_reservations_enforce_session_limit_under_concurrency_boundary() {
        let manager = TerminalManager::default();
        for ordinal in 1..=TERMINAL_SESSION_LIMIT {
            assert_eq!(manager.reserve_create("session-a").unwrap(), ordinal);
        }
        assert_eq!(
            manager.reserve_create("session-a").unwrap_err().code,
            error_codes::SESSION_LIMIT_REACHED
        );
        for _ in 0..TERMINAL_SESSION_LIMIT {
            manager.release_reservation("session-a");
        }
        assert_eq!(manager.inner.registry.lock().unwrap().reservations_total, 0);
    }

    #[test]
    fn unknown_terminal_operations_return_stable_not_found_error() {
        let manager = TerminalManager::default();
        assert_eq!(
            manager.kill("missing").unwrap_err().code,
            error_codes::NOT_FOUND
        );
        assert!(manager.close("missing").is_ok());
        assert!(manager.list("missing-session").unwrap().is_empty());
    }

    #[test]
    fn registry_reservations_enforce_global_limit_across_sessions() {
        let manager = TerminalManager::default();
        for session in 0..3 {
            for _ in 0..TERMINAL_SESSION_LIMIT {
                manager
                    .reserve_create(&format!("session-{session}"))
                    .unwrap();
            }
        }
        assert_eq!(
            manager.reserve_create("session-overflow").unwrap_err().code,
            error_codes::GLOBAL_LIMIT_REACHED
        );
        assert_eq!(
            manager.inner.registry.lock().unwrap().reservations_total,
            TERMINAL_GLOBAL_LIMIT
        );
    }

    #[cfg(windows)]
    #[test]
    fn attach_streams_live_output_and_terminal_remains_replayable_after_exit() {
        use tauri::ipc::{Channel, InvokeResponseBody};

        let manager = TerminalManager::default();
        let snapshot = manager
            .create(
                "attach-session".into(),
                std::env::current_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned()),
                "cmd".into(),
                TerminalSize {
                    cols: 80,
                    rows: 24,
                    pixel_width: None,
                    pixel_height: None,
                },
            )
            .unwrap();

        let live_events = Arc::new(Mutex::new(Vec::<TerminalEvent>::new()));
        let live_events_clone = live_events.clone();
        let channel = Channel::new(move |body: InvokeResponseBody| {
            if let Ok(event) = body.deserialize::<TerminalEvent>() {
                live_events_clone.lock().unwrap().push(event);
            }
            Ok(())
        });
        let attached = manager.attach(&snapshot.terminal_id, 0, channel).unwrap();
        assert_eq!(attached.snapshot.terminal_id, snapshot.terminal_id);

        let command = STANDARD.encode(b"\x1b[1;1Recho KEYDEX_ATTACH_LIVE\r\nexit 0\r\n");
        manager.write(&snapshot.terminal_id, &command).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let current = manager.list("attach-session").unwrap().remove(0);
            if current.status.is_terminal() {
                break;
            }
            assert!(Instant::now() < deadline, "attached CMD did not exit");
            thread::sleep(Duration::from_millis(25));
        }
        assert!(live_events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, TerminalEvent::Output { .. })));

        let terminal_events = Arc::new(Mutex::new(Vec::<TerminalEvent>::new()));
        let terminal_events_clone = terminal_events.clone();
        let channel = Channel::new(move |body: InvokeResponseBody| {
            if let Ok(event) = body.deserialize::<TerminalEvent>() {
                terminal_events_clone.lock().unwrap().push(event);
            }
            Ok(())
        });
        let replayed = manager.attach(&snapshot.terminal_id, 0, channel).unwrap();
        assert!(replayed.snapshot.status.is_terminal());
        assert!(replayed.replay.iter().any(|event| {
            matches!(event, TerminalEvent::Output { data_base64, .. } if STANDARD
                .decode(data_base64)
                .map(|bytes| String::from_utf8_lossy(&bytes).contains("KEYDEX_ATTACH_LIVE"))
                .unwrap_or(false))
        }));
        manager.close(&snapshot.terminal_id).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn concurrent_write_resize_kill_and_close_converge_without_deadlock() {
        let manager = TerminalManager::default();
        let snapshot = manager
            .create(
                "race-session".into(),
                std::env::current_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned()),
                "cmd".into(),
                TerminalSize {
                    cols: 80,
                    rows: 24,
                    pixel_width: None,
                    pixel_height: None,
                },
            )
            .unwrap();
        let terminal_id = snapshot.terminal_id;

        let writer_manager = manager.clone();
        let writer_id = terminal_id.clone();
        let writer = thread::spawn(move || {
            let data = STANDARD.encode(b"\x1b[1;1Recho KEYDEX_RACE\r\n");
            for _ in 0..20 {
                let _ = writer_manager.write(&writer_id, &data);
            }
        });
        let resize_manager = manager.clone();
        let resize_id = terminal_id.clone();
        let resizer = thread::spawn(move || {
            for step in 0..40_u16 {
                let _ = resize_manager.resize(
                    &resize_id,
                    TerminalSize {
                        cols: 80 + (step % 10),
                        rows: 24 + (step % 5),
                        pixel_width: None,
                        pixel_height: None,
                    },
                );
            }
        });
        let kill_manager = manager.clone();
        let kill_id = terminal_id.clone();
        let killer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(10));
            let _ = kill_manager.kill(&kill_id);
        });

        writer.join().unwrap();
        resizer.join().unwrap();
        killer.join().unwrap();
        assert_eq!(manager.close_session("race-session").unwrap(), 1);
        assert!(manager.list("race-session").unwrap().is_empty());
        assert!(manager.close(&terminal_id).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn real_cmd_pty_smoke_preserves_output_and_exit_code() {
        let manager = TerminalManager::default();
        let snapshot = manager
            .create(
                "native-smoke-session".into(),
                std::env::current_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned()),
                "cmd".into(),
                TerminalSize {
                    cols: 80,
                    rows: 24,
                    pixel_width: None,
                    pixel_height: None,
                },
            )
            .expect("CMD should start inside a real ConPTY");
        let renamed = manager.rename(&snapshot.terminal_id, "  构建终端  ").unwrap();
        assert_eq!(renamed.title, "构建终端");
        assert_eq!(manager.list("native-smoke-session").unwrap()[0].title, "构建终端");
        assert_eq!(
            manager.rename(&snapshot.terminal_id, " ").unwrap_err().code,
            error_codes::TITLE_INVALID
        );
        let command = STANDARD.encode(b"\x1b[1;1Recho KEYDEX_TERMINAL_SMOKE\r\nexit 7\r\n");
        manager.write(&snapshot.terminal_id, &command).unwrap();

        let deadline = Instant::now() + Duration::from_secs(10);
        let final_snapshot = loop {
            let current = manager
                .list("native-smoke-session")
                .unwrap()
                .into_iter()
                .next()
                .unwrap();
            if current.status.is_terminal() {
                break current;
            }
            if Instant::now() >= deadline {
                let entry = manager.entry(&snapshot.terminal_id).unwrap();
                let (_, events) = entry
                    .stream
                    .lock()
                    .unwrap()
                    .replay
                    .events_after(&snapshot.terminal_id, 0);
                let output = events
                    .into_iter()
                    .filter_map(|event| match event {
                        TerminalEvent::Output { data_base64, .. } => {
                            STANDARD.decode(data_base64).ok()
                        }
                        _ => None,
                    })
                    .flatten()
                    .collect::<Vec<_>>();
                panic!(
                    "CMD did not exit before timeout; output={:?}",
                    String::from_utf8_lossy(&output)
                );
            }
            thread::sleep(Duration::from_millis(25));
        };
        assert_eq!(final_snapshot.exit_code, Some(7));

        let entry = manager.entry(&snapshot.terminal_id).unwrap();
        let (_, events) = entry
            .stream
            .lock()
            .unwrap()
            .replay
            .events_after(&snapshot.terminal_id, 0);
        let output = events
            .into_iter()
            .filter_map(|event| match event {
                TerminalEvent::Output { data_base64, .. } => STANDARD.decode(data_base64).ok(),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();
        assert!(
            String::from_utf8_lossy(&output).contains("KEYDEX_TERMINAL_SMOKE"),
            "PTY replay should contain the command output"
        );
        manager.close(&snapshot.terminal_id).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn real_powershell_and_optional_git_bash_preserve_unicode_and_resize() {
        run_real_profile(
            "powershell",
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Write-Output 'KEYDEX_POWERSHELL_中文'; exit 9\r\n",
            "KEYDEX_POWERSHELL_中文",
            9,
        );

        let manager = TerminalManager::default();
        let git_bash_available = manager
            .list_profiles()
            .into_iter()
            .any(|profile| profile.id == "git-bash" && profile.available);
        if git_bash_available {
            run_real_profile(
                "git-bash",
                "printf 'KEYDEX_GIT_BASH_中文\\n'; exit 11\r\n",
                "KEYDEX_GIT_BASH_中文",
                11,
            );
        } else {
            eprintln!("Git Bash is unavailable; optional real PTY case skipped with environment evidence");
        }
    }

    #[cfg(windows)]
    #[test]
    fn real_python_node_repl_and_git_vim_tui_flow_through_conpty() {
        let repl_output = run_real_profile(
            "powershell",
            "@(\"print('KEYDEX_PYTHON_REPL_中文')\",\"exit()\") | python -q; @(\"console.log('KEYDEX_NODE_REPL_中文')\",\".exit\") | node -i; exit 0\r\n",
            "KEYDEX_NODE_REPL_中文",
            0,
        );
        assert!(repl_output.contains("KEYDEX_PYTHON_REPL_中文"));

        let manager = TerminalManager::default();
        let git_bash_available = manager
            .list_profiles()
            .into_iter()
            .any(|profile| profile.id == "git-bash" && profile.available);
        if git_bash_available {
            run_real_git_vim_tui();
        }
    }

    #[cfg(windows)]
    fn run_real_git_vim_tui() {
        let manager = TerminalManager::default();
        let session_id = "real-git-vim-session";
        let snapshot = manager
            .create(
                session_id.into(),
                std::env::current_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned()),
                "git-bash".into(),
                TerminalSize {
                    cols: 100,
                    rows: 30,
                    pixel_width: None,
                    pixel_height: None,
                },
            )
            .unwrap();
        wait_for_replay(&manager, &snapshot.terminal_id, "\x1b[6n", Duration::from_secs(5));
        manager
            .write(&snapshot.terminal_id, &STANDARD.encode(b"\x1b[1;1R"))
            .unwrap();
        manager
            .write(&snapshot.terminal_id, &STANDARD.encode(b"vim -Nu NONE -n\r\n"))
            .unwrap();
        wait_for_replay(
            &manager,
            &snapshot.terminal_id,
            "\x1b[?1049h",
            Duration::from_secs(10),
        );
        manager
            .write(&snapshot.terminal_id, &STANDARD.encode(b"\x1b:qa!\r"))
            .unwrap();
        wait_for_replay(
            &manager,
            &snapshot.terminal_id,
            "\x1b[?1049l",
            Duration::from_secs(10),
        );
        manager
            .write(
                &snapshot.terminal_id,
                &STANDARD.encode(b"printf 'KEYDEX_VIM_DONE\\n'; exit 0\r\n"),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let final_snapshot = loop {
            let current = manager.list(session_id).unwrap().remove(0);
            if current.status.is_terminal() {
                break current;
            }
            assert!(Instant::now() < deadline, "Git Bash did not exit after Vim closed");
            thread::sleep(Duration::from_millis(25));
        };
        assert_eq!(final_snapshot.exit_code, Some(0));
        assert!(replay_text(&manager, &snapshot.terminal_id).contains("KEYDEX_VIM_DONE"));
        manager.close(&snapshot.terminal_id).unwrap();
    }

    #[cfg(windows)]
    fn wait_for_replay(manager: &TerminalManager, terminal_id: &str, marker: &str, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            let output = replay_text(manager, terminal_id);
            if output.contains(marker) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "terminal output did not contain {marker:?}; output={output:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(windows)]
    fn replay_text(manager: &TerminalManager, terminal_id: &str) -> String {
        let entry = manager.entry(terminal_id).unwrap();
        let (_, events) = lock(&entry.stream)
            .unwrap()
            .replay
            .events_after(terminal_id, 0);
        let output = events
            .into_iter()
            .filter_map(|event| match event {
                TerminalEvent::Output { data_base64, .. } => STANDARD.decode(data_base64).ok(),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();
        String::from_utf8_lossy(&output).into_owned()
    }

    #[cfg(windows)]
    fn run_real_profile(profile: &str, command: &str, marker: &str, exit_code: i32) -> String {
        let manager = TerminalManager::default();
        let session_id = format!("real-{profile}-session");
        let snapshot = manager
            .create(
                session_id.clone(),
                std::env::current_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned()),
                profile.to_string(),
                TerminalSize {
                    cols: 80,
                    rows: 24,
                    pixel_width: None,
                    pixel_height: None,
                },
            )
            .unwrap_or_else(|error| panic!("{profile} should start inside a real ConPTY: {error}"));
        manager
            .resize(
                &snapshot.terminal_id,
                TerminalSize {
                    cols: 110,
                    rows: 35,
                    pixel_width: Some(880),
                    pixel_height: Some(560),
                },
            )
            .unwrap();
        assert_eq!(lock(&manager.entry(&snapshot.terminal_id).unwrap().last_size).unwrap().cols, 110);
        let cursor_query_deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let entry = manager.entry(&snapshot.terminal_id).unwrap();
            let (_, events) = lock(&entry.stream)
                .unwrap()
                .replay
                .events_after(&snapshot.terminal_id, 0);
            let queried = events.into_iter().any(|event| match event {
                TerminalEvent::Output { data_base64, .. } => STANDARD
                    .decode(data_base64)
                    .map(|bytes| bytes.windows(4).any(|window| window == b"\x1b[6n"))
                    .unwrap_or(false),
                _ => false,
            });
            if queried {
                manager
                    .write(&snapshot.terminal_id, &STANDARD.encode(b"\x1b[1;1R"))
                    .unwrap();
                break;
            }
            if Instant::now() >= cursor_query_deadline {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        manager
            .write(&snapshot.terminal_id, &STANDARD.encode(command.as_bytes()))
            .unwrap();

        let deadline = Instant::now() + Duration::from_secs(15);
        let final_snapshot = loop {
            let current = manager.list(&session_id).unwrap().remove(0);
            if current.status.is_terminal() {
                break current;
            }
            if Instant::now() >= deadline {
                let entry = manager.entry(&snapshot.terminal_id).unwrap();
                let (_, events) = lock(&entry.stream)
                    .unwrap()
                    .replay
                    .events_after(&snapshot.terminal_id, 0);
                let output = events
                    .into_iter()
                    .filter_map(|event| match event {
                        TerminalEvent::Output { data_base64, .. } => STANDARD.decode(data_base64).ok(),
                        _ => None,
                    })
                    .flatten()
                    .collect::<Vec<_>>();
                let _ = manager.close(&snapshot.terminal_id);
                panic!(
                    "{profile} did not exit before timeout; output={:?}",
                    String::from_utf8_lossy(&output)
                );
            }
            thread::sleep(Duration::from_millis(25));
        };
        assert_eq!(final_snapshot.exit_code, Some(exit_code));
        let entry = manager.entry(&snapshot.terminal_id).unwrap();
        let (_, events) = lock(&entry.stream)
            .unwrap()
            .replay
            .events_after(&snapshot.terminal_id, 0);
        let output = events
            .into_iter()
            .filter_map(|event| match event {
                TerminalEvent::Output { data_base64, .. } => STANDARD.decode(data_base64).ok(),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();
        let output_text = String::from_utf8_lossy(&output).into_owned();
        assert!(
            output_text.contains(marker),
            "{profile} output should preserve the Unicode marker; output={:?}",
            output_text
        );
        manager.close(&snapshot.terminal_id).unwrap();
        output_text
    }
}
