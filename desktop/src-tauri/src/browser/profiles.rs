use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{Webview, Wry};
use uuid::Uuid;

use super::contract::{
    BrowserProfileDataKind, BrowserProfileMode, BrowserSurfaceRef, BrowserTimeRange,
};

const PROFILE_MANIFEST: &str = ".keydex-browser-profile.json";
const CLEANUP_PENDING: &str = ".cleanup-pending";
const PROFILE_SCHEMA_VERSION: u8 = 1;
const CLEAR_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedProfileManifest {
    schema_version: u8,
    kind: String,
    run_id: String,
}

#[derive(Debug, Clone)]
struct ActiveProfileSurface {
    reference: BrowserSurfaceRef,
    mode: BrowserProfileMode,
}

#[derive(Debug)]
struct BrowserProfileInner {
    run_id: String,
    incognito_path: Option<PathBuf>,
    surfaces: HashMap<String, ActiveProfileSurface>,
    cleanup_scanned: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct BrowserProfileManager {
    inner: Arc<Mutex<BrowserProfileInner>>,
}

impl Default for BrowserProfileManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(BrowserProfileInner {
                run_id: Uuid::new_v4().simple().to_string(),
                incognito_path: None,
                surfaces: HashMap::new(),
                cleanup_scanned: false,
            })),
        }
    }
}

impl BrowserProfileManager {
    pub(crate) fn mode_for_surface(
        &self,
        reference: &BrowserSurfaceRef,
    ) -> Option<BrowserProfileMode> {
        self.inner
            .lock()
            .ok()?
            .surfaces
            .get(&reference.panel_id)
            .filter(|active| active.reference == *reference)
            .map(|active| active.mode)
    }

    pub(crate) fn reserve_surface(
        &self,
        app_data_dir: &Path,
        temp_dir: &Path,
        reference: BrowserSurfaceRef,
        mode: BrowserProfileMode,
    ) -> Result<PathBuf, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Browser profile manager is unavailable".to_string())?;
        let persistent = app_data_dir.join("browser").join("persistent");
        let incognito_parent = temp_dir.join("keydex").join("browser-incognito");
        if !inner.cleanup_scanned {
            retry_pending_cleanup(&incognito_parent, None);
            inner.cleanup_scanned = true;
        }
        let path = match mode {
            BrowserProfileMode::Persistent => {
                fs::create_dir_all(&persistent).map_err(|error| {
                    format!("Failed to create persistent browser profile: {error}")
                })?;
                persistent
            }
            BrowserProfileMode::Incognito => {
                if inner.incognito_path.is_none() {
                    let path = incognito_parent.join(format!("run-{}", inner.run_id));
                    create_managed_incognito_profile(&path, &inner.run_id)?;
                    inner.incognito_path = Some(path);
                }
                inner
                    .incognito_path
                    .clone()
                    .expect("incognito path was initialized")
            }
        };
        let replaced = inner.surfaces.insert(
            reference.panel_id.clone(),
            ActiveProfileSurface { reference, mode },
        );
        if replaced.is_some_and(|active| active.mode == BrowserProfileMode::Incognito)
            && !inner
                .surfaces
                .values()
                .any(|active| active.mode == BrowserProfileMode::Incognito)
        {
            if let Some(path) = inner.incognito_path.take() {
                remove_or_mark_cleanup_pending(&path, || {
                    remove_managed_incognito_profile(&incognito_parent, &path)
                });
            }
        }
        Ok(path)
    }

    pub(crate) fn release_surface(&self, temp_dir: &Path, reference: &BrowserSurfaceRef) {
        let Ok(mut inner) = self.inner.lock() else {
            return;
        };
        let matches = inner
            .surfaces
            .get(&reference.panel_id)
            .is_some_and(|active| active.reference == *reference);
        if !matches {
            return;
        }
        inner.surfaces.remove(&reference.panel_id);
        let has_incognito = inner
            .surfaces
            .values()
            .any(|active| active.mode == BrowserProfileMode::Incognito);
        if has_incognito {
            return;
        }
        if let Some(path) = inner.incognito_path.take() {
            let parent = temp_dir.join("keydex").join("browser-incognito");
            remove_or_mark_cleanup_pending(&path, || {
                remove_managed_incognito_profile(&parent, &path)
            });
        }
    }

    #[cfg(test)]
    fn incognito_path(&self) -> Option<PathBuf> {
        self.inner.lock().ok()?.incognito_path.clone()
    }
}

fn remove_or_mark_cleanup_pending<F>(candidate: &Path, remove: F)
where
    F: FnOnce() -> Result<(), String>,
{
    if remove().is_err() {
        let _ = fs::write(candidate.join(CLEANUP_PENDING), b"retry");
    }
}

fn create_managed_incognito_profile(path: &Path, run_id: &str) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Failed to create incognito browser profile: {error}"))?;
    let manifest = ManagedProfileManifest {
        schema_version: PROFILE_SCHEMA_VERSION,
        kind: "incognito".to_string(),
        run_id: run_id.to_string(),
    };
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|error| format!("Failed to encode browser profile manifest: {error}"))?;
    fs::write(path.join(PROFILE_MANIFEST), bytes)
        .map_err(|error| format!("Failed to write browser profile manifest: {error}"))
}

fn retry_pending_cleanup(parent: &Path, current: Option<&Path>) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if current.is_some_and(|current| current == path) || !path.join(CLEANUP_PENDING).is_file() {
            continue;
        }
        let _ = remove_managed_incognito_profile(parent, &path);
    }
}

fn remove_managed_incognito_profile(parent: &Path, candidate: &Path) -> Result<(), String> {
    if candidate.parent() != Some(parent)
        || !candidate
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with("run-"))
    {
        return Err("Refusing to remove an unmanaged browser profile path".to_string());
    }
    let manifest_path = candidate.join(PROFILE_MANIFEST);
    let manifest: ManagedProfileManifest = serde_json::from_slice(
        &fs::read(&manifest_path)
            .map_err(|_| "Refusing to remove a profile without a managed manifest".to_string())?,
    )
    .map_err(|_| "Refusing to remove a profile with an invalid manifest".to_string())?;
    if manifest.schema_version != PROFILE_SCHEMA_VERSION || manifest.kind != "incognito" {
        return Err("Refusing to remove a profile with an unsupported manifest".to_string());
    }
    fs::remove_dir_all(candidate)
        .map_err(|error| format!("Failed to remove managed incognito profile: {error}"))
}

#[cfg(windows)]
pub(crate) fn configure_profile_security(webview: &Webview<Wry>) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Profile6, ICoreWebView2_13};
    use windows_061::core::Interface;

    webview.with_webview(move |platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let Ok(profile) = core
            .cast::<ICoreWebView2_13>()
            .and_then(|core| core.Profile())
            .and_then(|profile| profile.cast::<ICoreWebView2Profile6>())
        else {
            return;
        };
        let _ = profile.SetIsPasswordAutosaveEnabled(false);
        let _ = profile.SetIsGeneralAutofillEnabled(false);
    })
}

#[cfg(not(windows))]
pub(crate) fn configure_profile_security(_webview: &Webview<Wry>) -> tauri::Result<()> {
    Ok(())
}

#[cfg(windows)]
pub(crate) async fn clear_profile_data(
    webview: &Webview<Wry>,
    kinds: &[BrowserProfileDataKind],
    time_range: BrowserTimeRange,
) -> Result<(), String> {
    use webview2_com::ClearBrowsingDataCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Profile2, ICoreWebView2_13, COREWEBVIEW2_BROWSING_DATA_KINDS,
        COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_DOM_STORAGE,
        COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE, COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES,
        COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
    };
    use windows_061::core::Interface;

    let data_kinds = kinds
        .iter()
        .fold(COREWEBVIEW2_BROWSING_DATA_KINDS(0), |value, kind| {
            let next = match kind {
                BrowserProfileDataKind::Cookies => COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES,
                BrowserProfileDataKind::Cache => COREWEBVIEW2_BROWSING_DATA_KINDS(
                    COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE.0
                        | COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE.0,
                ),
                BrowserProfileDataKind::Storage => COREWEBVIEW2_BROWSING_DATA_KINDS_ALL_DOM_STORAGE,
            };
            COREWEBVIEW2_BROWSING_DATA_KINDS(value.0 | next.0)
        });
    let (sender, receiver) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    let sender = Arc::new(Mutex::new(Some(sender)));
    webview
        .with_webview(move |platform| unsafe {
            let result = platform
                .controller()
                .CoreWebView2()
                .and_then(|core| core.cast::<ICoreWebView2_13>())
                .and_then(|core| core.Profile())
                .and_then(|profile| profile.cast::<ICoreWebView2Profile2>());
            let Ok(profile) = result else {
                if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                    let _ =
                        sender.send(Err("WebView2 profile data API is unavailable".to_string()));
                }
                return;
            };
            let completion_sender = sender.clone();
            let completion = ClearBrowsingDataCompletedHandler::create(Box::new(move |status| {
                let result = status
                    .map_err(|error| format!("WebView2 failed to clear browsing data: {error}"));
                if let Some(sender) = completion_sender
                    .lock()
                    .ok()
                    .and_then(|mut value| value.take())
                {
                    let _ = sender.send(result);
                }
                Ok(())
            }));
            let dispatch = match time_range {
                BrowserTimeRange::All => profile.ClearBrowsingData(data_kinds, &completion),
                BrowserTimeRange::LastHour | BrowserTimeRange::LastDay => {
                    let now = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_secs_f64();
                    let seconds = match time_range {
                        BrowserTimeRange::LastHour => 60.0 * 60.0,
                        BrowserTimeRange::LastDay => 24.0 * 60.0 * 60.0,
                        BrowserTimeRange::All => unreachable!(),
                    };
                    profile.ClearBrowsingDataInTimeRange(
                        data_kinds,
                        now - seconds,
                        now,
                        &completion,
                    )
                }
            };
            if let Err(error) = dispatch {
                if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                    let _ = sender.send(Err(format!(
                        "Failed to request browsing data clear: {error}"
                    )));
                }
            }
        })
        .map_err(|error| format!("Failed to access WebView2 profile: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(CLEAR_TIMEOUT)
            .map_err(|_| "Timed out while clearing browsing data".to_string())?
    })
    .await
    .map_err(|error| format!("Browsing data clear task failed: {error}"))?
}

#[cfg(not(windows))]
pub(crate) async fn clear_profile_data(
    _webview: &Webview<Wry>,
    _kinds: &[BrowserProfileDataKind],
    _time_range: BrowserTimeRange,
) -> Result<(), String> {
    Err("Browser profile data clearing is only available on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surface(panel: &str, generation: u64) -> BrowserSurfaceRef {
        BrowserSurfaceRef {
            panel_id: panel.to_string(),
            surface_id: format!("surface-{panel}-{generation}"),
            generation,
        }
    }

    fn test_root(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("keydex-profile-test-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn persistent_is_stable_and_incognito_is_shared_until_last_surface_closes() {
        let root = test_root("lifecycle");
        let app = root.join("app");
        let temp = root.join("temp");
        let manager = BrowserProfileManager::default();
        let persistent = manager
            .reserve_surface(
                &app,
                &temp,
                surface("normal", 1),
                BrowserProfileMode::Persistent,
            )
            .unwrap();
        assert_eq!(persistent, app.join("browser").join("persistent"));
        let first = surface("incognito-1", 1);
        let second = surface("incognito-2", 1);
        let first_path = manager
            .reserve_surface(&app, &temp, first.clone(), BrowserProfileMode::Incognito)
            .unwrap();
        let second_path = manager
            .reserve_surface(&app, &temp, second.clone(), BrowserProfileMode::Incognito)
            .unwrap();
        assert_eq!(first_path, second_path);
        manager.release_surface(&temp, &first);
        assert!(first_path.exists());
        manager.release_surface(&temp, &second);
        assert!(!first_path.exists());
        assert!(manager.incognito_path().is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn managed_delete_refuses_missing_manifest_wrong_root_and_persistent_data() {
        let root = test_root("safety");
        let parent = root.join("browser-incognito");
        let unmanaged = parent.join("run-unmanaged");
        let persistent = root.join("persistent");
        fs::create_dir_all(&unmanaged).unwrap();
        fs::create_dir_all(&persistent).unwrap();
        assert!(remove_managed_incognito_profile(&parent, &unmanaged).is_err());
        assert!(remove_managed_incognito_profile(&parent, &persistent).is_err());
        assert!(unmanaged.exists());
        assert!(persistent.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn pending_cleanup_retries_only_manifest_marked_direct_children() {
        let root = test_root("retry");
        let parent = root.join("browser-incognito");
        let candidate = parent.join("run-retry");
        create_managed_incognito_profile(&candidate, "retry").unwrap();
        fs::write(candidate.join(CLEANUP_PENDING), b"retry").unwrap();
        let unrelated = parent.join("run-unrelated");
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(unrelated.join(CLEANUP_PENDING), b"retry").unwrap();
        retry_pending_cleanup(&parent, None);
        assert!(!candidate.exists());
        assert!(unrelated.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn locked_incognito_profile_is_marked_and_removed_by_the_next_retry() {
        let root = test_root("locked-retry");
        let parent = root.join("browser-incognito");
        let candidate = parent.join("run-locked");
        create_managed_incognito_profile(&candidate, "locked").unwrap();

        remove_or_mark_cleanup_pending(&candidate, || Err("profile is locked".to_string()));
        assert!(candidate.join(CLEANUP_PENDING).is_file());

        retry_pending_cleanup(&parent, None);
        assert!(!candidate.exists());
        let _ = fs::remove_dir_all(root);
    }
}
