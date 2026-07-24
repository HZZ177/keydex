use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use chrono::Utc;
use serde::{Deserialize, Serialize};

const APP_IDENTIFIER: &str = "com.keydex.desktop";
const DATA_DIRECTORY_NAME: &str = "data";
const STAGING_DIRECTORY_NAME: &str = "data.migrating";
const LAYOUT_MARKER_NAME: &str = ".storage-layout-v2.json";
const ACL_MARKER_NAME: &str = ".storage-acl-v2";
const LEGACY_ACL_MARKER_NAMES: &[&str] = &[".storage-acl-v1"];
const LAYOUT_VERSION: u32 = 2;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const STORAGE_MIGRATION_MUTEX_NAME: &str = "Local\\KeydexStorageLayoutV2";

const REQUIRED_DIRECTORIES: &[&str] = &[
    "attachments",
    "browser/persistent",
    "file-history",
    "local-files",
    "logs",
    "temp",
    "tool-results",
    "webview/main",
];

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageLayoutMarker {
    version: u32,
    completed_at: String,
    legacy_roaming_data_dir: Option<String>,
    legacy_local_data_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageCategoryUsage {
    id: String,
    label: String,
    bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageStatus {
    install_root: String,
    data_root: String,
    layout_version: u32,
    total_bytes: u64,
    legacy_cleanup_pending: bool,
    categories: Vec<StorageCategoryUsage>,
}

pub(crate) fn install_root() -> Result<PathBuf, String> {
    let executable =
        std::env::current_exe().map_err(|error| format!("无法定位 Keydex 程序文件: {error}"))?;
    executable
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法定位 Keydex 安装目录".to_string())
}

pub(crate) fn data_root() -> Result<PathBuf, String> {
    Ok(install_root()?.join(DATA_DIRECTORY_NAME))
}

pub(crate) fn prepare_install_storage_layout() -> Result<(), String> {
    #[cfg(windows)]
    let _migration_lock = StorageMigrationLock::acquire()?;

    let install_root = install_root()?;
    let data_root = install_root.join(DATA_DIRECTORY_NAME);
    let installed_layout = install_root.join("uninstall.exe").is_file();

    let (legacy_roaming, legacy_local) = if installed_layout {
        (
            std::env::var_os("APPDATA")
                .map(PathBuf::from)
                .map(|root| root.join(APP_IDENTIFIER)),
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .map(|root| root.join(APP_IDENTIFIER)),
        )
    } else {
        (None, None)
    };

    prepare_layout(
        &install_root,
        &data_root,
        legacy_roaming.as_deref(),
        legacy_local.as_deref(),
    )?;

    if installed_layout {
        restrict_data_directory_permissions(&data_root)?;
    }
    Ok(())
}

pub(crate) fn storage_status() -> Result<StorageStatus, String> {
    let install_root = install_root()?;
    let data_root = install_root.join(DATA_DIRECTORY_NAME);
    fs::create_dir_all(&data_root).map_err(|error| format!("无法访问 Keydex 数据目录: {error}"))?;

    let marker = read_marker(&data_root).ok();
    let mut grouped = BTreeMap::<&'static str, u64>::new();
    for entry in
        fs::read_dir(&data_root).map_err(|error| format!("无法统计 Keydex 数据目录: {error}"))?
    {
        let entry = entry.map_err(|error| format!("无法读取 Keydex 数据项: {error}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == LAYOUT_MARKER_NAME
            || name == ACL_MARKER_NAME
            || LEGACY_ACL_MARKER_NAMES.contains(&name.as_str())
        {
            continue;
        }
        let group = storage_group(&name);
        *grouped.entry(group).or_default() += directory_usage(&entry.path())?;
    }

    let categories = [
        ("database", "数据库"),
        ("browser", "浏览器与 WebView"),
        ("attachments", "附件与本地资料"),
        ("history", "文件历史"),
        ("tool-results", "工具结果"),
        ("logs", "日志"),
        ("other", "其他"),
    ]
    .into_iter()
    .map(|(id, label)| StorageCategoryUsage {
        id: id.to_string(),
        label: label.to_string(),
        bytes: grouped.remove(id).unwrap_or_default(),
    })
    .collect::<Vec<_>>();
    let total_bytes = categories.iter().map(|category| category.bytes).sum();
    let legacy_cleanup_pending = marker
        .as_ref()
        .is_some_and(|marker| marker_legacy_paths(marker).iter().any(|path| path.exists()));

    Ok(StorageStatus {
        install_root: install_root.to_string_lossy().to_string(),
        data_root: data_root.to_string_lossy().to_string(),
        layout_version: marker.map_or(LAYOUT_VERSION, |value| value.version),
        total_bytes,
        legacy_cleanup_pending,
        categories,
    })
}

fn prepare_layout(
    install_root: &Path,
    data_root: &Path,
    legacy_roaming: Option<&Path>,
    legacy_local: Option<&Path>,
) -> Result<(), String> {
    fs::create_dir_all(install_root)
        .map_err(|error| format!("无法创建 Keydex 安装目录: {error}"))?;

    if data_root.join(LAYOUT_MARKER_NAME).exists() {
        let marker = read_marker(data_root)?;
        remove_stale_staging_directory(install_root, &install_root.join(STAGING_DIRECTORY_NAME))?;
        create_required_directories(data_root)?;
        cleanup_legacy_paths(&marker, data_root);
        return Ok(());
    }

    let roaming_source = existing_nonempty_directory(legacy_roaming)?;
    let local_source = existing_nonempty_directory(legacy_local)?;
    let has_legacy_data = roaming_source.is_some() || local_source.is_some();

    if data_root.exists() {
        if !directory_is_empty(data_root)? {
            return Err(format!(
                "检测到未标记的非空数据目录。为避免覆盖，请先备份并移走 {}",
                data_root.display()
            ));
        }
        if has_legacy_data {
            fs::remove_dir(data_root).map_err(|error| {
                format!("无法移除空的数据目录 {}: {error}", data_root.display())
            })?;
        } else {
            create_required_directories(data_root)?;
            let marker = marker_for_sources(None, None);
            write_marker(data_root, &marker)?;
            return Ok(());
        }
    }

    if !has_legacy_data {
        fs::create_dir_all(data_root)
            .map_err(|error| format!("无法创建 Keydex 数据目录: {error}"))?;
        create_required_directories(data_root)?;
        write_marker(data_root, &marker_for_sources(None, None))?;
        return Ok(());
    }

    let staging_root = install_root.join(STAGING_DIRECTORY_NAME);
    remove_stale_staging_directory(install_root, &staging_root)?;
    fs::create_dir_all(&staging_root)
        .map_err(|error| format!("无法创建数据迁移暂存目录: {error}"))?;

    let migration_result: Result<(), String> = (|| {
        // Legacy files are opaque migration payloads. Do not open, scan, or
        // rewrite SQLite databases, checkpoints, WebView profiles, or assets.
        if let Some(source) = roaming_source {
            copy_directory_tree(source, &staging_root)?;
        }
        if let Some(source) = local_source {
            copy_directory_tree(source, &staging_root.join("webview").join("main"))?;
        }
        create_required_directories(&staging_root)?;
        write_marker(
            &staging_root,
            &marker_for_sources(roaming_source, local_source),
        )?;
        fs::rename(&staging_root, data_root)
            .map_err(|error| format!("无法启用迁移后的 Keydex 数据目录: {error}"))?;
        Ok(())
    })();

    if let Err(error) = migration_result {
        return Err(format!(
            "Keydex 数据迁移未完成，C 盘原数据保持不变。{error}"
        ));
    }

    if let Ok(marker) = read_marker(data_root) {
        cleanup_legacy_paths(&marker, data_root);
    }
    Ok(())
}

fn existing_nonempty_directory(path: Option<&Path>) -> Result<Option<&Path>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    if !path.is_dir() || directory_is_empty(path)? {
        return Ok(None);
    }
    Ok(Some(path))
}

fn directory_is_empty(path: &Path) -> Result<bool, String> {
    let mut entries =
        fs::read_dir(path).map_err(|error| format!("无法读取目录 {}: {error}", path.display()))?;
    Ok(entries.next().is_none())
}

fn marker_for_sources(
    legacy_roaming: Option<&Path>,
    legacy_local: Option<&Path>,
) -> StorageLayoutMarker {
    StorageLayoutMarker {
        version: LAYOUT_VERSION,
        completed_at: Utc::now().to_rfc3339(),
        legacy_roaming_data_dir: legacy_roaming.map(|path| path.to_string_lossy().to_string()),
        legacy_local_data_dir: legacy_local.map(|path| path.to_string_lossy().to_string()),
    }
}

fn marker_legacy_paths(marker: &StorageLayoutMarker) -> Vec<PathBuf> {
    [
        marker.legacy_roaming_data_dir.as_deref(),
        marker.legacy_local_data_dir.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(PathBuf::from)
    .collect()
}

fn read_marker(data_root: &Path) -> Result<StorageLayoutMarker, String> {
    let path = data_root.join(LAYOUT_MARKER_NAME);
    let bytes = fs::read(&path)
        .map_err(|error| format!("无法读取存储布局标记 {}: {error}", path.display()))?;
    let marker: StorageLayoutMarker = serde_json::from_slice(&bytes)
        .map_err(|error| format!("存储布局标记无效 {}: {error}", path.display()))?;
    if marker.version != LAYOUT_VERSION {
        return Err(format!("不支持的 Keydex 存储布局版本: {}", marker.version));
    }
    Ok(marker)
}

fn write_marker(data_root: &Path, marker: &StorageLayoutMarker) -> Result<(), String> {
    let marker_path = data_root.join(LAYOUT_MARKER_NAME);
    let temporary_path = data_root.join(format!("{LAYOUT_MARKER_NAME}.tmp"));
    let encoded = serde_json::to_vec_pretty(marker)
        .map_err(|error| format!("无法生成存储布局标记: {error}"))?;
    let mut file = fs::File::create(&temporary_path)
        .map_err(|error| format!("无法写入存储布局标记: {error}"))?;
    file.write_all(&encoded)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法同步存储布局标记: {error}"))?;
    drop(file);
    fs::rename(&temporary_path, &marker_path)
        .map_err(|error| format!("无法提交存储布局标记: {error}"))
}

fn create_required_directories(data_root: &Path) -> Result<(), String> {
    for relative in REQUIRED_DIRECTORIES {
        fs::create_dir_all(data_root.join(relative)).map_err(|error| {
            format!(
                "无法创建 Keydex 数据子目录 {}: {error}",
                data_root.join(relative).display()
            )
        })?;
    }
    Ok(())
}

fn remove_stale_staging_directory(install_root: &Path, staging_root: &Path) -> Result<(), String> {
    if staging_root.parent() != Some(install_root)
        || staging_root.file_name().and_then(|value| value.to_str()) != Some(STAGING_DIRECTORY_NAME)
    {
        return Err("拒绝清理无法确认的数据迁移暂存目录".to_string());
    }
    if staging_root.exists() {
        fs::remove_dir_all(staging_root)
            .map_err(|error| format!("无法清理上次迁移暂存目录: {error}"))?;
    }
    Ok(())
}

fn copy_directory_tree(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|error| format!("无法创建迁移目标 {}: {error}", destination.display()))?;
    for entry in fs::read_dir(source)
        .map_err(|error| format!("无法读取迁移源 {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| format!("无法读取迁移源目录项: {error}"))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("无法读取迁移文件信息 {}: {error}", source_path.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "迁移源中包含不受支持的符号链接: {}",
                source_path.display()
            ));
        }
        if metadata.is_dir() {
            copy_directory_tree(&source_path, &destination_path)?;
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        let copied = fs::copy(&source_path, &destination_path).map_err(|error| {
            format!(
                "复制数据文件失败 {} -> {}: {error}",
                source_path.display(),
                destination_path.display()
            )
        })?;
        if copied != metadata.len() {
            return Err(format!("复制后的文件大小不一致: {}", source_path.display()));
        }
    }
    Ok(())
}

fn cleanup_legacy_paths(marker: &StorageLayoutMarker, data_root: &Path) {
    for legacy_path in marker_legacy_paths(marker) {
        if !legacy_path.exists() {
            continue;
        }
        if !safe_legacy_cleanup_target(&legacy_path, data_root) {
            eprintln!(
                "refusing to clean an unsafe legacy Keydex data path: {}",
                legacy_path.display()
            );
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&legacy_path) {
            eprintln!(
                "failed to clean legacy Keydex data directory {}: {error}",
                legacy_path.display()
            );
        }
    }
}

fn safe_legacy_cleanup_target(legacy_path: &Path, data_root: &Path) -> bool {
    let expected_name = legacy_path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(APP_IDENTIFIER));
    if !expected_name {
        return false;
    }
    let Ok(legacy) = legacy_path.canonicalize() else {
        return false;
    };
    let data = data_root
        .canonicalize()
        .unwrap_or_else(|_| data_root.to_path_buf());
    legacy != data && !data.starts_with(&legacy) && !legacy.starts_with(&data)
}

fn storage_group(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "app.db" | "app.db-shm" | "app.db-wal" => "database",
        "browser" | "temp" | "webview" => "browser",
        "attachments" | "local-files" => "attachments",
        "file-history" | "checkpoints" => "history",
        "tool-results" => "tool-results",
        "logs" => "logs",
        _ => "other",
    }
}

fn directory_usage(path: &Path) -> Result<u64, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("无法读取数据项 {}: {error}", path.display())),
    };
    if metadata.file_type().is_symlink() {
        return Ok(0);
    }
    if metadata.is_file() {
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let mut total = 0u64;
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("无法统计目录 {}: {error}", path.display())),
    };
    for entry in entries {
        match entry {
            Ok(entry) => {
                total = total.saturating_add(directory_usage(&entry.path())?);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法读取数据目录项: {error}")),
        }
    }
    Ok(total)
}

#[cfg(windows)]
fn restrict_data_directory_permissions(data_root: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let acl_marker = data_root.join(ACL_MARKER_NAME);
    if acl_marker.is_file() {
        return Ok(());
    }

    let identity_output = Command::new("whoami.exe")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|error| format!("无法读取当前 Windows 用户: {error}"))?;
    if !identity_output.status.success() {
        return Err("无法读取当前 Windows 用户".to_string());
    }
    let identity = String::from_utf8_lossy(&identity_output.stdout)
        .trim()
        .to_string();
    if identity.is_empty() {
        return Err("当前 Windows 用户为空".to_string());
    }

    restrict_data_directory_permissions_with(data_root, &identity, run_icacls)
}

#[cfg(windows)]
fn restrict_data_directory_permissions_with<F>(
    data_root: &Path,
    identity: &str,
    mut run: F,
) -> Result<(), String>
where
    F: FnMut(&Path, &[String]) -> Result<(), String>,
{
    let acl_marker = data_root.join(ACL_MARKER_NAME);
    if acl_marker.is_file() {
        return Ok(());
    }

    // Only place inheritable ACEs on the data root. Applying `(OI)(CI)F`
    // recursively gives regular files inheritance-only ACEs on some Windows
    // versions, leaving the directories accessible but the files unreadable.
    let root_args = vec![
        "/inheritance:r".to_string(),
        "/grant:r".to_string(),
        format!("{identity}:(OI)(CI)F"),
        "*S-1-5-18:(OI)(CI)F".to_string(),
        "*S-1-5-32-544:(OI)(CI)F".to_string(),
        "/Q".to_string(),
    ];
    run(data_root, &root_args)
        .map_err(|error| format!("无法设置 Keydex 数据根目录权限: {error}"))?;

    let descendants = data_root.join("*");
    let reset_args = vec!["/reset".to_string(), "/T".to_string(), "/Q".to_string()];
    run(&descendants, &reset_args)
        .map_err(|error| format!("无法修复 Keydex 已迁移文件权限: {error}"))?;

    for legacy_marker in LEGACY_ACL_MARKER_NAMES {
        let legacy_marker = data_root.join(legacy_marker);
        if legacy_marker.exists() {
            fs::remove_file(&legacy_marker).map_err(|error| {
                format!(
                    "无法移除旧的数据目录权限标记 {}: {error}",
                    legacy_marker.display()
                )
            })?;
        }
    }
    fs::write(&acl_marker, b"acl-v2\n")
        .map_err(|error| format!("无法写入数据目录权限标记: {error}"))
}

#[cfg(windows)]
fn run_icacls(target: &Path, args: &[String]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let status = Command::new("icacls.exe")
        .arg(target)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|error| format!("无法启动 icacls: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("icacls 退出码 {:?}", status.code()))
    }
}

#[cfg(not(windows))]
fn restrict_data_directory_permissions(_data_root: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
struct StorageMigrationLock {
    handle: windows::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl StorageMigrationLock {
    fn acquire() -> Result<Self, String> {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_FAILED, WAIT_OBJECT_0};
        use windows::Win32::System::Threading::{CreateMutexW, WaitForSingleObject, INFINITE};

        let name = OsStr::new(STORAGE_MIGRATION_MUTEX_NAME)
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
            .map_err(|error| format!("无法创建数据迁移互斥锁: {error}"))?;
        let wait = unsafe { WaitForSingleObject(handle, INFINITE) };
        if wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED {
            return Ok(Self { handle });
        }
        unsafe {
            let _ = CloseHandle(handle);
        }
        if wait == WAIT_FAILED {
            Err("等待数据迁移互斥锁失败".to_string())
        } else {
            Err(format!("等待数据迁移互斥锁返回未知状态 {}", wait.0))
        }
    }
}

#[cfg(windows)]
impl Drop for StorageMigrationLock {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::ReleaseMutex;

        unsafe {
            let _ = ReleaseMutex(self.handle);
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("keydex-storage-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn fresh_layout_is_created_inside_the_install_root() {
        let install = temp_root("fresh");
        let data = install.join(DATA_DIRECTORY_NAME);

        prepare_layout(&install, &data, None, None).unwrap();

        assert!(data.join(LAYOUT_MARKER_NAME).is_file());
        assert!(data.join("browser").join("persistent").is_dir());
        assert!(data.join("webview").join("main").is_dir());
        fs::remove_dir_all(install).unwrap();
    }

    #[test]
    fn legacy_roaming_and_local_data_are_copied_byte_for_byte_and_cleaned() {
        let root = temp_root("migration");
        let install = root.join("install");
        let data = install.join(DATA_DIRECTORY_NAME);
        let roaming = root.join("roaming").join(APP_IDENTIFIER);
        let local = root.join("local").join(APP_IDENTIFIER);
        fs::create_dir_all(roaming.join("browser").join("persistent")).unwrap();
        fs::create_dir_all(local.join("EBWebView")).unwrap();
        let database_bytes = b"not parsed as sqlite; copied exactly";
        let wal_bytes = b"wal bytes are also opaque";
        fs::write(roaming.join("app.db"), database_bytes).unwrap();
        fs::write(roaming.join("app.db-wal"), wal_bytes).unwrap();
        fs::write(
            roaming.join("browser").join("persistent").join("Cookies"),
            b"browser",
        )
        .unwrap();
        fs::write(local.join("EBWebView").join("Preferences"), b"webview").unwrap();

        prepare_layout(&install, &data, Some(&roaming), Some(&local)).unwrap();

        assert_eq!(fs::read(data.join("app.db")).unwrap(), database_bytes);
        assert_eq!(fs::read(data.join("app.db-wal")).unwrap(), wal_bytes);
        assert_eq!(
            fs::read(
                data.join("webview")
                    .join("main")
                    .join("EBWebView")
                    .join("Preferences")
            )
            .unwrap(),
            b"webview"
        );
        assert!(!roaming.exists());
        assert!(!local.exists());
        assert!(!install.join(STAGING_DIRECTORY_NAME).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_existing_layout_marker_is_not_silently_replaced() {
        let install = temp_root("invalid-marker");
        let data = install.join(DATA_DIRECTORY_NAME);
        fs::create_dir_all(&data).unwrap();
        fs::write(
            data.join(LAYOUT_MARKER_NAME),
            br#"{"version":999,"completedAt":"invalid"}"#,
        )
        .unwrap();

        let error = prepare_layout(&install, &data, None, None).unwrap_err();

        assert!(error.contains("不支持的 Keydex 存储布局版本"));
        assert!(fs::read_to_string(data.join(LAYOUT_MARKER_NAME))
            .unwrap()
            .contains("\"version\":999"));
        fs::remove_dir_all(install).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn existing_acl_v1_layout_is_upgraded_without_touching_file_contents() {
        let install = temp_root("acl-upgrade");
        let data = install.join(DATA_DIRECTORY_NAME);
        let logs = data.join("logs");
        let payload = b"existing migrated file bytes";
        let mut calls = Vec::<(PathBuf, Vec<String>)>::new();
        fs::create_dir_all(&logs).unwrap();
        fs::write(data.join(LEGACY_ACL_MARKER_NAMES[0]), b"acl-v1\n").unwrap();
        fs::write(logs.join("existing.log"), payload).unwrap();

        restrict_data_directory_permissions_with(&data, "test\\user", |target, args| {
            calls.push((target.to_path_buf(), args.to_vec()));
            Ok(())
        })
        .unwrap();

        assert_eq!(fs::read(logs.join("existing.log")).unwrap(), payload);
        assert!(data.join(ACL_MARKER_NAME).is_file());
        assert!(!data.join(LEGACY_ACL_MARKER_NAMES[0]).exists());
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, data);
        assert!(!calls[0].1.iter().any(|arg| arg == "/T"));
        assert_eq!(calls[1].0, data.join("*"));
        assert_eq!(calls[1].1, ["/reset", "/T", "/Q"]);
        fs::remove_dir_all(install).unwrap();
    }

    #[test]
    fn unmarked_nonempty_data_directory_is_not_adopted() {
        let install = temp_root("unmarked-data");
        let data = install.join(DATA_DIRECTORY_NAME);
        fs::create_dir_all(&data).unwrap();
        fs::write(data.join("unrelated.txt"), b"do not overwrite").unwrap();

        let error = prepare_layout(&install, &data, None, None).unwrap_err();

        assert!(error.contains("未标记的非空数据目录"));
        assert_eq!(
            fs::read(data.join("unrelated.txt")).unwrap(),
            b"do not overwrite"
        );
        assert!(!data.join(LAYOUT_MARKER_NAME).exists());
        fs::remove_dir_all(install).unwrap();
    }
}
