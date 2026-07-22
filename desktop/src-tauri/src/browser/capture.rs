use std::{
    collections::HashMap,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use chrono::{Duration as ChronoDuration, SecondsFormat, Utc};
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use super::{
    contract::{
        BrowserCaptureAssetKind, BrowserCaptureAssetPayload, BrowserLogicalRect,
        BrowserProfileMode, BrowserSurfaceRef, BrowserViewportSize,
    },
    ui_actor::NativeBrowserSurface,
};

const CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_CAPTURE_BYTES: usize = 64 * 1024 * 1024;
const MAX_INCOGNITO_EXPORT_BYTES: usize = 20 * 1024 * 1024;
const STAGED_TTL_HOURS: i64 = 24;
const CAPTURE_FILE: &str = "capture.png";
const ASSET_MANIFEST: &str = ".keydex-browser-capture.json";
const ROOT_MANIFEST: &str = ".keydex-browser-capture-root.json";
const MANIFEST_SCHEMA_VERSION: u8 = 1;

#[derive(Debug)]
pub(crate) struct CroppedCapture {
    pub(crate) png: Vec<u8>,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

#[derive(Debug, Clone)]
struct CaptureRecord {
    surface: BrowserSurfaceRef,
    kind: BrowserCaptureAssetKind,
    directory: PathBuf,
}

#[derive(Debug)]
struct BrowserCaptureInner {
    run_id: String,
    assets: HashMap<String, CaptureRecord>,
    temp_root_ready: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct BrowserCaptureManager {
    inner: Arc<Mutex<BrowserCaptureInner>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TakenIncognitoCapture {
    pub(crate) asset_id: String,
    pub(crate) mime_type: String,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
    pub(crate) data_base64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCaptureRootManifest {
    schema_version: u8,
    kind: String,
    run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManagedCaptureAssetManifest {
    schema_version: u8,
    kind: BrowserCaptureAssetKind,
    asset_id: String,
    capture_request_id: String,
    surface: BrowserSurfaceRef,
    file_name: String,
    mime_type: String,
    width: u32,
    height: u32,
    byte_length: u64,
    sha256: String,
    perceptual_hash: String,
    created_at: String,
    expires_at: String,
}

impl Default for BrowserCaptureManager {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(BrowserCaptureInner {
                run_id: Uuid::new_v4().simple().to_string(),
                assets: HashMap::new(),
                temp_root_ready: false,
            })),
        }
    }
}

impl BrowserCaptureManager {
    pub(crate) fn store_capture(
        &self,
        app_data_dir: &Path,
        temp_dir: &Path,
        surface: &BrowserSurfaceRef,
        profile_mode: BrowserProfileMode,
        capture_request_id: &str,
        capture: CroppedCapture,
    ) -> Result<BrowserCaptureAssetPayload, String> {
        if capture.png.is_empty() || capture.png.len() > MAX_CAPTURE_BYTES {
            return Err("Captured region has an invalid encoded size".to_string());
        }
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Browser capture manager is unavailable".to_string())?;
        let kind = match profile_mode {
            BrowserProfileMode::Persistent => BrowserCaptureAssetKind::Staged,
            BrowserProfileMode::Incognito => BrowserCaptureAssetKind::ManagedTemp,
        };
        let asset_id = format!("web-capture-{}", Uuid::new_v4().simple());
        let directory = match kind {
            BrowserCaptureAssetKind::Staged => app_data_dir
                .join("browser")
                .join("captures")
                .join("staged")
                .join(&asset_id),
            BrowserCaptureAssetKind::ManagedTemp => {
                ensure_managed_temp_root(temp_dir, &mut inner)?;
                managed_temp_run_root(temp_dir, &inner.run_id).join(&asset_id)
            }
        };
        fs::create_dir_all(&directory).map_err(|error| {
            format!("Failed to create managed browser capture directory: {error}")
        })?;

        let created_at = Utc::now();
        let expires_at = (created_at + ChronoDuration::hours(STAGED_TTL_HOURS))
            .to_rfc3339_opts(SecondsFormat::Millis, true);
        let sha256 = format!("{:x}", Sha256::digest(&capture.png));
        let perceptual_hash = difference_hash_png(&capture.png)?;
        let byte_length = capture.png.len() as u64;
        let manifest = ManagedCaptureAssetManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            kind,
            asset_id: asset_id.clone(),
            capture_request_id: capture_request_id.to_string(),
            surface: surface.clone(),
            file_name: CAPTURE_FILE.to_string(),
            mime_type: "image/png".to_string(),
            width: capture.width,
            height: capture.height,
            byte_length,
            sha256: sha256.clone(),
            perceptual_hash: perceptual_hash.clone(),
            created_at: created_at.to_rfc3339_opts(SecondsFormat::Millis, true),
            expires_at: expires_at.clone(),
        };
        let write_result = fs::write(directory.join(CAPTURE_FILE), &capture.png)
            .map_err(|error| format!("Failed to write managed browser capture: {error}"))
            .and_then(|_| {
                serde_json::to_vec(&manifest)
                    .map_err(|error| format!("Failed to encode browser capture manifest: {error}"))
            })
            .and_then(|bytes| {
                fs::write(directory.join(ASSET_MANIFEST), bytes)
                    .map_err(|error| format!("Failed to write browser capture manifest: {error}"))
            });
        if let Err(error) = write_result {
            let _ = remove_managed_asset_directory(&directory, Some(&asset_id));
            return Err(error);
        }

        if let Some(replaced) = inner.assets.insert(
            capture_key(surface, capture_request_id),
            CaptureRecord {
                surface: surface.clone(),
                kind,
                directory,
            },
        ) {
            let _ = remove_managed_asset_directory(&replaced.directory, None);
        }
        Ok(BrowserCaptureAssetPayload {
            asset_id,
            kind,
            mime_type: "image/png".to_string(),
            width: capture.width,
            height: capture.height,
            byte_length,
            sha256,
            perceptual_hash,
            expires_at,
        })
    }

    pub(crate) fn discard_capture(
        &self,
        surface: &BrowserSurfaceRef,
        capture_request_id: &str,
    ) -> Result<bool, String> {
        let record = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Browser capture manager is unavailable".to_string())?;
            inner
                .assets
                .remove(&capture_key(surface, capture_request_id))
        };
        let Some(record) = record else {
            return Ok(false);
        };
        remove_managed_asset_directory(&record.directory, None)?;
        Ok(true)
    }

    pub(crate) fn take_incognito_capture(
        &self,
        surface: &BrowserSurfaceRef,
        capture_request_id: &str,
        expected_asset_id: &str,
    ) -> Result<TakenIncognitoCapture, String> {
        let key = capture_key(surface, capture_request_id);
        let record = {
            let inner = self
                .inner
                .lock()
                .map_err(|_| "Browser capture manager is unavailable".to_string())?;
            inner
                .assets
                .get(&key)
                .cloned()
                .ok_or_else(|| "Managed incognito capture is unavailable".to_string())?
        };
        if record.surface != *surface || record.kind != BrowserCaptureAssetKind::ManagedTemp {
            return Err("Refusing to export a non-incognito browser capture".to_string());
        }
        let manifest: ManagedCaptureAssetManifest = serde_json::from_slice(
            &fs::read(record.directory.join(ASSET_MANIFEST))
                .map_err(|_| "Managed incognito capture manifest is unavailable".to_string())?,
        )
        .map_err(|_| "Managed incognito capture manifest is invalid".to_string())?;
        if manifest.schema_version != MANIFEST_SCHEMA_VERSION
            || manifest.kind != BrowserCaptureAssetKind::ManagedTemp
            || manifest.asset_id != expected_asset_id
            || manifest.capture_request_id != capture_request_id
            || manifest.surface != *surface
            || manifest.file_name != CAPTURE_FILE
            || manifest.mime_type != "image/png"
        {
            return Err("Managed incognito capture identity does not match".to_string());
        }
        let png = fs::read(record.directory.join(CAPTURE_FILE))
            .map_err(|_| "Managed incognito capture file is unavailable".to_string())?;
        if png.is_empty() || png.len() > MAX_INCOGNITO_EXPORT_BYTES {
            return Err(
                "Managed incognito capture exceeds the message attachment limit".to_string(),
            );
        }
        let sha256 = format!("{:x}", Sha256::digest(&png));
        if png.len() as u64 != manifest.byte_length || sha256 != manifest.sha256 {
            return Err("Managed incognito capture integrity check failed".to_string());
        }
        remove_managed_asset_directory(&record.directory, Some(expected_asset_id))?;
        if let Ok(mut inner) = self.inner.lock() {
            inner.assets.remove(&key);
        }
        Ok(TakenIncognitoCapture {
            asset_id: manifest.asset_id,
            mime_type: manifest.mime_type,
            byte_length: manifest.byte_length,
            sha256,
            data_base64: BASE64_STANDARD.encode(png),
        })
    }

    pub(crate) fn release_surface(&self, surface: &BrowserSurfaceRef) {
        let records = self.take_records(|record| {
            record.surface == *surface && record.kind == BrowserCaptureAssetKind::ManagedTemp
        });
        for record in records {
            let _ = remove_managed_asset_directory(&record.directory, None);
        }
    }

    pub(crate) fn shutdown(&self, temp_dir: &Path) {
        let records =
            self.take_records(|record| record.kind == BrowserCaptureAssetKind::ManagedTemp);
        for record in records {
            let _ = remove_managed_asset_directory(&record.directory, None);
        }
        let run_id = self
            .inner
            .lock()
            .ok()
            .map(|inner| inner.run_id.clone())
            .unwrap_or_default();
        if !run_id.is_empty() {
            let _ = remove_managed_temp_run(
                &managed_temp_parent(temp_dir),
                &managed_temp_run_root(temp_dir, &run_id),
            );
        }
    }

    fn take_records(&self, predicate: impl Fn(&CaptureRecord) -> bool) -> Vec<CaptureRecord> {
        let Ok(mut inner) = self.inner.lock() else {
            return Vec::new();
        };
        let keys = inner
            .assets
            .iter()
            .filter_map(|(key, record)| predicate(record).then_some(key.clone()))
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|key| inner.assets.remove(&key))
            .collect()
    }
}

pub(crate) fn crop_png_to_css_rect(
    png: &[u8],
    rect: &BrowserLogicalRect,
    viewport: &BrowserViewportSize,
) -> Result<CroppedCapture, String> {
    validate_capture_geometry(rect, viewport)?;
    if png.is_empty() || png.len() > MAX_CAPTURE_BYTES {
        return Err("Browser capture PNG size is invalid".to_string());
    }
    let image = image::load_from_memory_with_format(png, ImageFormat::Png)
        .map_err(|_| "Browser capture PNG could not be decoded".to_string())?;
    let (image_width, image_height) = image.dimensions();
    if image_width == 0 || image_height == 0 {
        return Err("Browser capture PNG has empty dimensions".to_string());
    }
    let scale_x = f64::from(image_width) / viewport.width;
    let scale_y = f64::from(image_height) / viewport.height;
    if !scale_x.is_finite() || !scale_y.is_finite() || scale_x <= 0.0 || scale_y <= 0.0 {
        return Err("Browser capture scale is invalid".to_string());
    }
    let left = (rect.x * scale_x)
        .floor()
        .clamp(0.0, f64::from(image_width)) as u32;
    let top = (rect.y * scale_y)
        .floor()
        .clamp(0.0, f64::from(image_height)) as u32;
    let right = ((rect.x + rect.width) * scale_x)
        .ceil()
        .clamp(0.0, f64::from(image_width)) as u32;
    let bottom = ((rect.y + rect.height) * scale_y)
        .ceil()
        .clamp(0.0, f64::from(image_height)) as u32;
    if right <= left || bottom <= top {
        return Err("Browser capture region is empty after DPI conversion".to_string());
    }
    let cropped = image.crop_imm(left, top, right - left, bottom - top);
    encode_png(cropped)
}

fn encode_png(image: DynamicImage) -> Result<CroppedCapture, String> {
    let width = image.width();
    let height = image.height();
    let mut cursor = Cursor::new(Vec::new());
    image
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|_| "Browser capture region could not be encoded".to_string())?;
    let png = cursor.into_inner();
    if png.is_empty() || png.len() > MAX_CAPTURE_BYTES {
        return Err("Browser capture region encoded size is invalid".to_string());
    }
    Ok(CroppedCapture { png, width, height })
}

fn difference_hash_png(png: &[u8]) -> Result<String, String> {
    let image = image::load_from_memory_with_format(png, ImageFormat::Png)
        .map_err(|_| "Browser capture PNG could not be hashed".to_string())?;
    let grayscale = image.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let mut bits = 0_u64;
    for y in 0..8 {
        for x in 0..8 {
            bits <<= 1;
            if grayscale.get_pixel(x, y)[0] > grayscale.get_pixel(x + 1, y)[0] {
                bits |= 1;
            }
        }
    }
    Ok(format!("dhash64:{bits:016x}"))
}

fn validate_capture_geometry(
    rect: &BrowserLogicalRect,
    viewport: &BrowserViewportSize,
) -> Result<(), String> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || !viewport.width.is_finite()
        || !viewport.height.is_finite()
        || viewport.width <= 0.0
        || viewport.height <= 0.0
        || rect.x < 0.0
        || rect.y < 0.0
        || rect.width < 8.0
        || rect.height < 8.0
        || rect.width * rect.height < 256.0
        || rect.x + rect.width > viewport.width + 0.01
        || rect.y + rect.height > viewport.height + 0.01
    {
        return Err(
            "Browser capture region is outside the visible viewport or too small".to_string(),
        );
    }
    Ok(())
}

fn ensure_managed_temp_root(
    temp_dir: &Path,
    inner: &mut BrowserCaptureInner,
) -> Result<(), String> {
    if inner.temp_root_ready {
        return Ok(());
    }
    let parent = managed_temp_parent(temp_dir);
    cleanup_stale_managed_temp_runs(&parent, &inner.run_id);
    let root = managed_temp_run_root(temp_dir, &inner.run_id);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Failed to create managed temporary capture root: {error}"))?;
    let manifest = ManagedCaptureRootManifest {
        schema_version: MANIFEST_SCHEMA_VERSION,
        kind: "browser_capture_temp".to_string(),
        run_id: inner.run_id.clone(),
    };
    let bytes = serde_json::to_vec(&manifest)
        .map_err(|error| format!("Failed to encode temporary capture root manifest: {error}"))?;
    fs::write(root.join(ROOT_MANIFEST), bytes)
        .map_err(|error| format!("Failed to write temporary capture root manifest: {error}"))?;
    inner.temp_root_ready = true;
    Ok(())
}

fn cleanup_stale_managed_temp_runs(parent: &Path, current_run_id: &str) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    let current_directory = format!("run-{current_run_id}");
    for entry in entries.flatten() {
        let path = entry.path();
        if path.file_name().and_then(|value| value.to_str()) == Some(current_directory.as_str()) {
            continue;
        }
        let _ = remove_managed_temp_run(parent, &path);
    }
}

fn remove_managed_temp_run(parent: &Path, candidate: &Path) -> Result<(), String> {
    if candidate.parent() != Some(parent)
        || !candidate
            .file_name()
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with("run-"))
    {
        return Err("Refusing to remove an unmanaged browser capture root".to_string());
    }
    let manifest: ManagedCaptureRootManifest = serde_json::from_slice(
        &fs::read(candidate.join(ROOT_MANIFEST))
            .map_err(|_| "Refusing to remove a capture root without a manifest".to_string())?,
    )
    .map_err(|_| "Refusing to remove a capture root with an invalid manifest".to_string())?;
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION || manifest.kind != "browser_capture_temp"
    {
        return Err("Refusing to remove a capture root with an unsupported manifest".to_string());
    }
    fs::remove_dir_all(candidate)
        .map_err(|error| format!("Failed to remove managed browser capture root: {error}"))
}

fn remove_managed_asset_directory(
    directory: &Path,
    expected_asset_id: Option<&str>,
) -> Result<(), String> {
    let manifest_path = directory.join(ASSET_MANIFEST);
    if manifest_path.is_file() {
        let manifest: ManagedCaptureAssetManifest =
            serde_json::from_slice(&fs::read(&manifest_path).map_err(|_| {
                "Refusing to remove capture without a readable manifest".to_string()
            })?)
            .map_err(|_| "Refusing to remove capture with an invalid manifest".to_string())?;
        if expected_asset_id.is_some_and(|expected| manifest.asset_id != expected) {
            return Err("Refusing to remove a mismatched browser capture".to_string());
        }
    } else if expected_asset_id.is_some() {
        // A partially-written fresh directory is still scoped by a generated asset ID.
        if directory.file_name().and_then(|value| value.to_str()) != expected_asset_id {
            return Err("Refusing to remove an unexpected browser capture directory".to_string());
        }
    } else {
        return Err("Refusing to remove capture without a managed manifest".to_string());
    }
    fs::remove_dir_all(directory)
        .map_err(|error| format!("Failed to remove managed browser capture: {error}"))
}

fn managed_temp_parent(temp_dir: &Path) -> PathBuf {
    temp_dir.join("keydex").join("browser-capture-temp")
}

fn capture_key(surface: &BrowserSurfaceRef, capture_request_id: &str) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}",
        surface.panel_id, surface.surface_id, surface.generation, capture_request_id
    )
}

fn managed_temp_run_root(temp_dir: &Path, run_id: &str) -> PathBuf {
    managed_temp_parent(temp_dir).join(format!("run-{run_id}"))
}

#[cfg(windows)]
pub(crate) async fn capture_webview_png(webview: &NativeBrowserSurface) -> Result<Vec<u8>, String> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows_061::Win32::{
        Foundation::HGLOBAL, System::Com::StructuredStorage::CreateStreamOnHGlobal,
    };

    let (sender, receiver) = std::sync::mpsc::sync_channel::<Result<Vec<u8>, String>>(1);
    let sender = Arc::new(Mutex::new(Some(sender)));
    webview
        .run(move |surface| unsafe {
            let core = surface.core();
            let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true);
            let Ok(stream) = stream else {
                send_capture_result(
                    &sender,
                    Err("WebView2 capture stream could not be created".to_string()),
                );
                return Ok(());
            };
            let callback_stream = stream.clone();
            let callback_sender = sender.clone();
            let completion = CapturePreviewCompletedHandler::create(Box::new(move |status| {
                let result = status
                    .map_err(|_| "WebView2 failed to capture the visible surface".to_string())
                    .and_then(|_| read_capture_stream(&callback_stream));
                send_capture_result(&callback_sender, result);
                Ok(())
            }));
            if core
                .CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                    &stream,
                    &completion,
                )
                .is_err()
            {
                send_capture_result(
                    &sender,
                    Err("WebView2 rejected the visible surface capture".to_string()),
                );
            }
            Ok(())
        })
        .map_err(|_| "Browser surface could not schedule native capture".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(CAPTURE_TIMEOUT)
            .map_err(|_| "Timed out while capturing the browser surface".to_string())?
    })
    .await
    .map_err(|_| "Browser capture wait task failed".to_string())?
}

#[cfg(windows)]
unsafe fn read_capture_stream(
    stream: &windows_061::Win32::System::Com::IStream,
) -> Result<Vec<u8>, String> {
    use windows_061::Win32::System::Com::{STREAM_SEEK_END, STREAM_SEEK_SET};

    let mut length = 0_u64;
    stream
        .Seek(0, STREAM_SEEK_END, Some(&mut length))
        .map_err(|_| "Browser capture stream length is unavailable".to_string())?;
    if length == 0 || length > MAX_CAPTURE_BYTES as u64 {
        return Err("Browser capture stream size is invalid".to_string());
    }
    stream
        .Seek(0, STREAM_SEEK_SET, None)
        .map_err(|_| "Browser capture stream could not rewind".to_string())?;
    let mut bytes = vec![0_u8; length as usize];
    let mut read = 0_u32;
    stream
        .Read(
            bytes.as_mut_ptr().cast(),
            bytes.len() as u32,
            Some(&mut read),
        )
        .ok()
        .map_err(|_| "Browser capture stream could not be read".to_string())?;
    if read as usize != bytes.len() {
        return Err("Browser capture stream ended unexpectedly".to_string());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn send_capture_result(
    sender: &Arc<Mutex<Option<std::sync::mpsc::SyncSender<Result<Vec<u8>, String>>>>>,
    result: Result<Vec<u8>, String>,
) {
    if let Some(sender) = sender.lock().ok().and_then(|mut sender| sender.take()) {
        let _ = sender.send(result);
    }
}

#[cfg(not(windows))]
pub(crate) async fn capture_webview_png(
    _webview: &NativeBrowserSurface,
) -> Result<Vec<u8>, String> {
    Err("Browser surface capture is only available on Windows".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn surface(name: &str) -> BrowserSurfaceRef {
        BrowserSurfaceRef {
            panel_id: format!("panel-{name}"),
            surface_id: format!("surface-{name}"),
            generation: 1,
        }
    }

    fn test_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "keydex-capture-test-{name}-{}",
            Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn source_png(width: u32, height: u32) -> Vec<u8> {
        let image = RgbaImage::from_fn(width, height, |x, y| {
            Rgba([(x % 251) as u8, (y % 251) as u8, ((x + y) % 251) as u8, 255])
        });
        let mut cursor = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut cursor, ImageFormat::Png)
            .unwrap();
        cursor.into_inner()
    }

    fn alternate_source_png(width: u32, height: u32) -> Vec<u8> {
        let image = RgbaImage::from_fn(width, height, |x, y| {
            Rgba([
                ((width - x) % 251) as u8,
                ((x * y) % 251) as u8,
                (y % 251) as u8,
                255,
            ])
        });
        let mut cursor = Cursor::new(Vec::new());
        DynamicImage::ImageRgba8(image)
            .write_to(&mut cursor, ImageFormat::Png)
            .unwrap();
        cursor.into_inner()
    }

    #[test]
    fn css_crop_uses_encoded_dimensions_for_100_125_and_150_percent_dpi() {
        let viewport = BrowserViewportSize {
            width: 800.0,
            height: 600.0,
        };
        let rect = BrowserLogicalRect {
            x: 100.0,
            y: 80.0,
            width: 240.0,
            height: 160.0,
        };
        for (scale, expected) in [(1.0, (240, 160)), (1.25, (300, 200)), (1.5, (360, 240))] {
            let source = source_png(
                (viewport.width * scale) as u32,
                (viewport.height * scale) as u32,
            );
            let result = crop_png_to_css_rect(&source, &rect, &viewport).unwrap();
            assert_eq!((result.width, result.height), expected);
            assert_eq!(
                image::load_from_memory_with_format(&result.png, ImageFormat::Png)
                    .unwrap()
                    .dimensions(),
                expected
            );
        }
    }

    #[test]
    fn difference_hash_is_stable_bounded_and_changes_with_visual_content() {
        let source = source_png(120, 80);
        let first = difference_hash_png(&source).unwrap();
        let second = difference_hash_png(&source).unwrap();
        let changed = difference_hash_png(&alternate_source_png(120, 80)).unwrap();

        assert_eq!(first, second);
        assert!(first.starts_with("dhash64:"));
        assert_eq!(first.len(), 24);
        assert_ne!(first, changed);
    }

    #[test]
    fn crop_rejects_tiny_offscreen_and_invalid_png_inputs() {
        let source = source_png(800, 600);
        let viewport = BrowserViewportSize {
            width: 800.0,
            height: 600.0,
        };
        let tiny = BrowserLogicalRect {
            x: 10.0,
            y: 10.0,
            width: 5.0,
            height: 5.0,
        };
        let offscreen = BrowserLogicalRect {
            x: 700.0,
            y: 500.0,
            width: 200.0,
            height: 120.0,
        };
        assert!(crop_png_to_css_rect(&source, &tiny, &viewport).is_err());
        assert!(crop_png_to_css_rect(&source, &offscreen, &viewport).is_err());
        assert!(crop_png_to_css_rect(
            b"not-png",
            &BrowserLogicalRect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 100.0,
            },
            &viewport
        )
        .is_err());
    }

    #[test]
    fn persistent_staged_and_incognito_temp_assets_are_separated_and_discardable() {
        let root = test_root("storage");
        let app = root.join("app");
        let temp = root.join("temp");
        let manager = BrowserCaptureManager::default();
        let normal_surface = surface("normal");
        let incognito_surface = surface("incognito");

        let staged = manager
            .store_capture(
                &app,
                &temp,
                &normal_surface,
                BrowserProfileMode::Persistent,
                "capture-normal",
                CroppedCapture {
                    png: source_png(120, 80),
                    width: 120,
                    height: 80,
                },
            )
            .unwrap();
        let managed_temp = manager
            .store_capture(
                &app,
                &temp,
                &incognito_surface,
                BrowserProfileMode::Incognito,
                "capture-incognito",
                CroppedCapture {
                    png: source_png(100, 60),
                    width: 100,
                    height: 60,
                },
            )
            .unwrap();

        assert_eq!(staged.kind, BrowserCaptureAssetKind::Staged);
        assert_eq!(managed_temp.kind, BrowserCaptureAssetKind::ManagedTemp);
        assert!(staged.perceptual_hash.starts_with("dhash64:"));
        assert_eq!(staged.perceptual_hash.len(), 24);
        assert!(app
            .join("browser/captures/staged")
            .join(&staged.asset_id)
            .is_dir());
        assert!(managed_temp_parent(&temp).is_dir());
        assert!(manager
            .discard_capture(&normal_surface, "capture-incognito")
            .is_ok_and(|removed| !removed));
        assert!(manager
            .discard_capture(&incognito_surface, "capture-incognito")
            .is_ok_and(|removed| removed));
        assert!(app
            .join("browser/captures/staged")
            .join(&staged.asset_id)
            .is_dir());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn incognito_capture_is_taken_once_with_manifest_and_integrity_checks() {
        let root = test_root("take-incognito");
        let app = root.join("app");
        let temp = root.join("temp");
        let manager = BrowserCaptureManager::default();
        let reference = surface("incognito");
        let png = source_png(100, 60);
        let asset = manager
            .store_capture(
                &app,
                &temp,
                &reference,
                BrowserProfileMode::Incognito,
                "capture-take",
                CroppedCapture {
                    png: png.clone(),
                    width: 100,
                    height: 60,
                },
            )
            .unwrap();

        assert!(manager
            .take_incognito_capture(&reference, "capture-take", "wrong-asset")
            .is_err());
        let taken = manager
            .take_incognito_capture(&reference, "capture-take", &asset.asset_id)
            .unwrap();

        assert_eq!(taken.asset_id, asset.asset_id);
        assert_eq!(taken.mime_type, "image/png");
        assert_eq!(taken.byte_length, png.len() as u64);
        assert_eq!(BASE64_STANDARD.decode(taken.data_base64).unwrap(), png);
        assert!(manager
            .take_incognito_capture(&reference, "capture-take", &asset.asset_id)
            .is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn surface_release_and_shutdown_remove_only_manifest_managed_incognito_assets() {
        let root = test_root("cleanup");
        let app = root.join("app");
        let temp = root.join("temp");
        let manager = BrowserCaptureManager::default();
        let reference = surface("incognito");
        manager
            .store_capture(
                &app,
                &temp,
                &reference,
                BrowserProfileMode::Incognito,
                "capture-temp",
                CroppedCapture {
                    png: source_png(80, 80),
                    width: 80,
                    height: 80,
                },
            )
            .unwrap();
        manager.release_surface(&reference);
        assert!(manager
            .discard_capture(&reference, "capture-temp")
            .is_ok_and(|removed| !removed));
        manager.shutdown(&temp);

        let unmanaged = managed_temp_parent(&temp).join("run-unmanaged");
        fs::create_dir_all(&unmanaged).unwrap();
        assert!(remove_managed_temp_run(&managed_temp_parent(&temp), &unmanaged).is_err());
        assert!(unmanaged.exists());
        let _ = fs::remove_dir_all(root);
    }
}
