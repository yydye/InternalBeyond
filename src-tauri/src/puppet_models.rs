//! User-owned, layered character bundles for IB Puppet.
//!
//! This module deliberately stores only raster assets plus a small declarative
//! skeleton manifest. It has no Cubism dependency and never interprets code.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Write};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;

const MAX_CHUNK_BYTES: usize = 256 * 1024;
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_BUNDLE_BYTES: u64 = 768 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const MAX_PUPPET_BONES: usize = 512;
const MAX_PUPPET_LAYERS: usize = 2_048;
const MAX_PUPPET_ACTIONS: usize = 128;
const MAX_PUPPET_KEYFRAMES: usize = 8_192;
const MAX_PUPPET_MESH_VERTICES: usize = 65_536;
const PUPPET_SCHEMA: &str = "internalbeyond.puppet.v1";
const PUPPET_PROJECT_SCHEMA: &str = "internalbeyond.puppet-project.v1";
const PUPPET_PROJECT_RECORD_SCHEMA: &str = "internalbeyond.puppet-project-record.v1";
const MAX_PUPPET_PROJECT_BYTES: usize = 160 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportFile {
    size: u64,
    received: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportState {
    id: String,
    mode: String,
    total_size: u64,
    files: BTreeMap<String, ImportFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetManifest {
    schema: String,
    name: String,
    canvas: PuppetCanvas,
    bones: Vec<PuppetBone>,
    layers: Vec<PuppetLayer>,
    #[serde(default)]
    motions: PuppetMotions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetCanvas {
    width: u32,
    height: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetBone {
    id: String,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
    #[serde(default)]
    rotation: f32,
    #[serde(default = "unit_scale")]
    scale_x: f32,
    #[serde(default = "unit_scale")]
    scale_y: f32,
}

fn unit_scale() -> f32 {
    1.0
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetLayer {
    id: String,
    src: String,
    bone: String,
    #[serde(default)]
    x: f32,
    #[serde(default)]
    y: f32,
    #[serde(default)]
    rotation: f32,
    #[serde(default = "half_anchor")]
    anchor_x: f32,
    #[serde(default = "half_anchor")]
    anchor_y: f32,
    #[serde(default)]
    z_index: i32,
    #[serde(default = "unit_scale")]
    scale_x: f32,
    #[serde(default = "unit_scale")]
    scale_y: f32,
    #[serde(default = "full_alpha")]
    alpha: f32,
    #[serde(default)]
    mesh: Option<PuppetMesh>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetMesh {
    columns: u16,
    rows: u16,
    #[serde(default)]
    pin_y: f32,
    #[serde(default)]
    sway_x: f32,
    #[serde(default)]
    sway_y: f32,
    #[serde(default = "default_mesh_frequency")]
    frequency: f32,
    #[serde(default)]
    phase: f32,
    #[serde(default = "default_mesh_stiffness")]
    stiffness: f32,
    #[serde(default = "default_mesh_damping")]
    damping: f32,
}

fn full_alpha() -> f32 {
    1.0
}

fn default_mesh_frequency() -> f32 {
    1.0
}
fn default_mesh_stiffness() -> f32 {
    34.0
}
fn default_mesh_damping() -> f32 {
    9.0
}

fn half_anchor() -> f32 {
    0.5
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetMotions {
    breath: Option<PuppetBreath>,
    gaze: Option<PuppetGaze>,
    head_turn: Option<PuppetHeadTurn>,
    blink: Option<PuppetBlink>,
    mouth: Option<PuppetMouth>,
    #[serde(default)]
    actions: Vec<PuppetAction>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetGaze {
    bone_id: String,
    #[serde(default = "default_gaze_period")]
    period_seconds: f32,
    #[serde(default)]
    amplitude_x: f32,
    #[serde(default)]
    amplitude_y: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetHeadTurn {
    bone_id: String,
    #[serde(default = "default_head_turn_period")]
    period_seconds: f32,
    #[serde(default)]
    amplitude_x: f32,
    #[serde(default)]
    amplitude_rotation: f32,
}

fn default_head_turn_period() -> f32 {
    6.0
}

fn default_gaze_period() -> f32 {
    5.0
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetBreath {
    bone_id: String,
    #[serde(default = "default_breath_period")]
    period_seconds: f32,
    #[serde(default)]
    amplitude_y: f32,
    #[serde(default)]
    scale_y: f32,
}

fn default_breath_period() -> f32 {
    4.0
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetBlink {
    open_layer_id: String,
    closed_layer_id: String,
    #[serde(default)]
    pairs: Vec<PuppetBlinkPair>,
    #[serde(default = "default_blink_interval_min")]
    min_interval_seconds: f32,
    #[serde(default = "default_blink_interval_max")]
    max_interval_seconds: f32,
    #[serde(default = "default_blink_duration")]
    duration_seconds: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetBlinkPair {
    #[serde(default)]
    id: String,
    #[serde(default)]
    side: String,
    open_layer_ids: Vec<String>,
    closed_layer_id: String,
}

fn default_blink_interval_min() -> f32 {
    2.8
}
fn default_blink_interval_max() -> f32 {
    5.2
}
fn default_blink_duration() -> f32 {
    0.18
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetMouth {
    closed_layer_id: String,
    open_layer_id: String,
    #[serde(default = "unit_scale")]
    sensitivity: f32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetAction {
    id: String,
    label: String,
    #[serde(default = "default_action_duration")]
    duration_seconds: f32,
    #[serde(default = "default_action_fade")]
    fade_in_seconds: f32,
    #[serde(default = "default_action_fade")]
    fade_out_seconds: f32,
    keyframes: Vec<PuppetKeyframe>,
}

fn default_action_duration() -> f32 {
    1.0
}

fn default_action_fade() -> f32 {
    0.12
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PuppetKeyframe {
    #[serde(default)]
    bone_id: Option<String>,
    #[serde(default)]
    layer_id: Option<String>,
    at: f32,
    #[serde(default)]
    easing: Option<String>,
    #[serde(default)]
    x: Option<f32>,
    #[serde(default)]
    y: Option<f32>,
    #[serde(default)]
    rotation: Option<f32>,
    #[serde(default)]
    scale_x: Option<f32>,
    #[serde(default)]
    scale_y: Option<f32>,
    #[serde(default)]
    alpha: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleRecord {
    schema: String,
    bundle_id: String,
    name: String,
    manifest_path: String,
    layer_count: usize,
    imported_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PuppetBundleItem {
    pub bundle_id: String,
    pub name: String,
    pub layer_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PuppetProjectItem {
    pub project_id: String,
    pub name: String,
    pub updated_at: String,
    pub bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PuppetProjectExport {
    pub file_name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PuppetProjectCompileResult {
    pub bundle: PuppetBundleItem,
    pub bundle_bytes: u64,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PuppetProjectRecord {
    schema: String,
    project_id: String,
    name: String,
    updated_at: String,
    bytes: u64,
}

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    let root = if std::env::var("IB_DEV_MODE").ok().as_deref() == Some("1") {
        super::validated_dev_sandbox_root()?.join("tauri-app-data")
    } else {
        app.path()
            .app_data_dir()
            .map_err(|_| "PUPPET_APP_DATA_UNAVAILABLE")?
    };
    #[cfg(not(debug_assertions))]
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "PUPPET_APP_DATA_UNAVAILABLE")?;
    fs::create_dir_all(&root).map_err(|_| "PUPPET_APP_DATA_UNAVAILABLE")?;
    Ok(root.join("live2d"))
}

fn imports_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = data_root(app)?.join(".puppet-imports");
    fs::create_dir_all(&root).map_err(|_| "PUPPET_STORAGE_UNAVAILABLE")?;
    Ok(root)
}

fn bundles_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = data_root(app)?.join("puppets");
    fs::create_dir_all(&root).map_err(|_| "PUPPET_STORAGE_UNAVAILABLE")?;
    Ok(root)
}

fn projects_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = data_root(app)?.join("puppet-projects");
    fs::create_dir_all(&root).map_err(|_| "PUPPET_STORAGE_UNAVAILABLE")?;
    Ok(root)
}

fn valid_project_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn validated_project(
    value: &str,
    expected_id: Option<&str>,
) -> Result<(Value, String, String), String> {
    if value.len() > MAX_PUPPET_PROJECT_BYTES {
        return Err("PUPPET_PROJECT_LIMIT_EXCEEDED".to_string());
    }
    let project: Value = serde_json::from_str(value).map_err(|_| "PUPPET_PROJECT_INVALID")?;
    if project.get("schema").and_then(Value::as_str) != Some(PUPPET_PROJECT_SCHEMA) {
        return Err("PUPPET_PROJECT_SCHEMA_INVALID".to_string());
    }
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or("PUPPET_PROJECT_ID_INVALID")?;
    if !valid_project_id(project_id) || expected_id.is_some_and(|expected| expected != project_id) {
        return Err("PUPPET_PROJECT_ID_INVALID".to_string());
    }
    if project
        .get("layers")
        .and_then(Value::as_array)
        .map_or(true, |layers| layers.len() > MAX_PUPPET_LAYERS)
    {
        return Err("PUPPET_PROJECT_LAYER_LIMIT_EXCEEDED".to_string());
    }
    let name = project
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("未命名角色")
        .chars()
        .take(80)
        .collect::<String>();
    let updated_at = project
        .get("updatedAt")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .chars()
        .take(64)
        .collect::<String>();
    Ok((project, name, updated_at))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("PUPPET_PROJECT_PATH_INVALID")?;
    fs::create_dir_all(parent).map_err(|_| "PUPPET_STORAGE_UNAVAILABLE")?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("PUPPET_PROJECT_PATH_INVALID")?;
    let temporary = parent.join(format!(".{file_name}.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
        file.write_all(bytes)
            .map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
        file.sync_all().map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
        fs::rename(&temporary, path).map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn add_bundle_files_to_zip(
    writer: &mut ZipWriter<Cursor<Vec<u8>>>,
    root: &Path,
    directory: &Path,
    total_bytes: &mut u64,
) -> Result<(), String> {
    for entry in fs::read_dir(directory).map_err(|_| "PUPPET_STORAGE_READ_FAILED")? {
        let entry = entry.map_err(|_| "PUPPET_STORAGE_READ_FAILED")?;
        let file_type = entry
            .file_type()
            .map_err(|_| "PUPPET_STORAGE_READ_FAILED")?;
        if file_type.is_symlink() {
            return Err("PUPPET_PATH_REJECTED".to_string());
        }
        let path = entry.path();
        if file_type.is_dir() {
            add_bundle_files_to_zip(writer, root, &path, total_bytes)?;
            continue;
        }
        if !file_type.is_file() {
            continue;
        }
        let canonical = path
            .canonicalize()
            .map_err(|_| "PUPPET_STORAGE_READ_FAILED")?;
        if !canonical.starts_with(root) {
            return Err("PUPPET_PATH_REJECTED".to_string());
        }
        let relative = canonical
            .strip_prefix(root)
            .map_err(|_| "PUPPET_PATH_REJECTED")?;
        let name = relative.to_string_lossy().replace('\\', "/");
        let size = fs::metadata(&canonical)
            .map_err(|_| "PUPPET_STORAGE_READ_FAILED")?
            .len();
        *total_bytes = total_bytes.saturating_add(size);
        if size > MAX_FILE_BYTES || *total_bytes > MAX_BUNDLE_BYTES {
            return Err("PUPPET_BUNDLE_LIMIT_EXCEEDED".to_string());
        }
        let mut file = File::open(&canonical).map_err(|_| "PUPPET_STORAGE_READ_FAILED")?;
        let mut bytes = Vec::with_capacity(size as usize);
        file.read_to_end(&mut bytes)
            .map_err(|_| "PUPPET_STORAGE_READ_FAILED")?;
        writer
            .start_file(
                name,
                SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Deflated)
                    .unix_permissions(0o644),
            )
            .map_err(|_| "PUPPET_ARCHIVE_WRITE_FAILED")?;
        writer
            .write_all(&bytes)
            .map_err(|_| "PUPPET_ARCHIVE_WRITE_FAILED")?;
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    Uuid::parse_str(value).is_ok()
}

fn safe_relative(value: &str) -> Result<PathBuf, String> {
    let normalized = value.replace('\\', "/");
    if normalized.is_empty()
        || normalized.starts_with('/')
        || normalized.contains(':')
        || normalized.contains('\0')
    {
        return Err("PUPPET_PATH_REJECTED".to_string());
    }
    let mut out = PathBuf::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err("PUPPET_PATH_REJECTED".to_string()),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("PUPPET_PATH_REJECTED".to_string());
    }
    Ok(out)
}

fn normalized_rel(value: &str) -> Result<String, String> {
    let path = safe_relative(value)?;
    Ok(path
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn is_image(path: &Path) -> bool {
    matches!(
        path.extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "webp"
    )
}

fn is_puppet_asset(path: &Path) -> bool {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .eq_ignore_ascii_case("puppet.json")
        || is_image(path)
}

fn read_import_state(dir: &Path, id: &str) -> Result<ImportState, String> {
    if !valid_id(id) {
        return Err("PUPPET_IMPORT_NOT_FOUND".to_string());
    }
    let raw = fs::read(dir.join("state.json")).map_err(|_| "PUPPET_IMPORT_NOT_FOUND")?;
    let state: ImportState =
        serde_json::from_slice(&raw).map_err(|_| "PUPPET_IMPORT_STATE_INVALID")?;
    if state.id != id || !matches!(state.mode.as_str(), "folder" | "zip") {
        return Err("PUPPET_IMPORT_STATE_INVALID".to_string());
    }
    Ok(state)
}

fn store_import_state(dir: &Path, state: &ImportState) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|_| "PUPPET_IMPORT_STATE_INVALID")?;
    fs::write(dir.join("state.json"), bytes).map_err(|_| "PUPPET_STORAGE_WRITE_FAILED".to_string())
}

#[tauri::command]
pub fn ib_puppet_import_begin(app: AppHandle, mode: String) -> Result<String, String> {
    if !matches!(mode.as_str(), "folder" | "zip") {
        return Err("PUPPET_IMPORT_MODE_INVALID".to_string());
    }
    let root = imports_root(&app)?;
    let id = Uuid::new_v4().to_string();
    let dir = root.join(&id);
    fs::create_dir_all(dir.join("files")).map_err(|_| "PUPPET_STORAGE_UNAVAILABLE")?;
    store_import_state(
        &dir,
        &ImportState {
            id: id.clone(),
            mode,
            total_size: 0,
            files: BTreeMap::new(),
        },
    )?;
    Ok(id)
}

#[tauri::command]
pub fn ib_puppet_import_chunk(
    app: AppHandle,
    import_id: String,
    relative_path: String,
    offset: u64,
    total_size: u64,
    chunk: Vec<u8>,
) -> Result<(), String> {
    if chunk.is_empty() || chunk.len() > MAX_CHUNK_BYTES || total_size == 0 {
        return Err("PUPPET_IMPORT_LIMIT_EXCEEDED".to_string());
    }
    let rel = normalized_rel(&relative_path)?;
    let rel_path = safe_relative(&rel)?;
    let root = imports_root(&app)?;
    let dir = root.join(&import_id);
    let mut state = read_import_state(&dir, &import_id)?;
    if state.mode == "zip" && rel != "import.zip" {
        return Err("PUPPET_ARCHIVE_PATH_INVALID".to_string());
    }
    if state.mode == "folder" && !is_puppet_asset(&rel_path) {
        return Err("PUPPET_FILE_TYPE_UNSUPPORTED".to_string());
    }
    let limit = if state.mode == "zip" {
        MAX_BUNDLE_BYTES
    } else {
        MAX_FILE_BYTES
    };
    if total_size > limit {
        return Err("PUPPET_IMPORT_LIMIT_EXCEEDED".to_string());
    }
    let file = state.files.get(&rel).cloned();
    if offset == 0 {
        if file.is_some()
            || state.files.len() >= MAX_ARCHIVE_ENTRIES
            || state.total_size.saturating_add(total_size) > MAX_BUNDLE_BYTES
        {
            return Err("PUPPET_IMPORT_LIMIT_EXCEEDED".to_string());
        }
        state.files.insert(
            rel.clone(),
            ImportFile {
                size: total_size,
                received: 0,
            },
        );
        state.total_size += total_size;
    } else if file.is_none() {
        return Err("PUPPET_IMPORT_OFFSET_INVALID".to_string());
    }
    let file_meta = state
        .files
        .get_mut(&rel)
        .ok_or_else(|| "PUPPET_IMPORT_OFFSET_INVALID".to_string())?;
    if file_meta.size != total_size
        || file_meta.received != offset
        || offset.saturating_add(chunk.len() as u64) > total_size
    {
        return Err("PUPPET_IMPORT_OFFSET_INVALID".to_string());
    }
    let files_root = dir.join("files");
    let target = files_root.join(&rel_path);
    if !target.starts_with(&files_root) {
        return Err("PUPPET_PATH_REJECTED".to_string());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
    }
    let mut options = OpenOptions::new();
    options.write(true);
    if offset == 0 {
        options.create_new(true);
    } else {
        options.append(true);
    }
    let mut output = options
        .open(&target)
        .map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
    if output
        .metadata()
        .map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?
        .len()
        != offset
    {
        return Err("PUPPET_IMPORT_OFFSET_INVALID".to_string());
    }
    output
        .write_all(&chunk)
        .map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
    file_meta.received += chunk.len() as u64;
    store_import_state(&dir, &state)
}

fn extract_puppet_zip(archive_path: &Path, output_root: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|_| "PUPPET_ARCHIVE_READ_FAILED")?;
    let mut archive = ZipArchive::new(file).map_err(|_| "PUPPET_ARCHIVE_INVALID")?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("PUPPET_IMPORT_LIMIT_EXCEEDED".to_string());
    }
    let mut count = 0usize;
    let mut total = 0u64;
    let mut seen = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "PUPPET_ARCHIVE_INVALID")?;
        let name = entry.name().to_string();
        let safe_name = normalized_rel(&name)?;
        if entry.is_dir() {
            continue;
        }
        if entry
            .unix_mode()
            .map(|mode| mode & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            return Err("PUPPET_ARCHIVE_LINK_REJECTED".to_string());
        }
        let rel = safe_relative(&safe_name)?;
        if !is_puppet_asset(&rel) {
            continue;
        }
        count += 1;
        total = total.saturating_add(entry.size());
        if count > MAX_ARCHIVE_ENTRIES || entry.size() > MAX_FILE_BYTES || total > MAX_BUNDLE_BYTES
        {
            return Err("PUPPET_IMPORT_LIMIT_EXCEEDED".to_string());
        }
        if !seen.insert(safe_name.clone()) {
            return Err("PUPPET_ARCHIVE_DUPLICATE_PATH".to_string());
        }
        let target = output_root.join(&rel);
        if !target.starts_with(output_root) {
            return Err("PUPPET_PATH_REJECTED".to_string());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
        }
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
        let copied =
            std::io::copy(&mut entry, &mut out).map_err(|_| "PUPPET_ARCHIVE_READ_FAILED")?;
        if copied != entry.size() {
            return Err("PUPPET_ARCHIVE_TRUNCATED".to_string());
        }
    }
    if count == 0 {
        return Err("PUPPET_BUNDLE_FILES_NOT_FOUND".to_string());
    }
    Ok(())
}

fn collect_files(root: &Path, current: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    for entry in fs::read_dir(current).map_err(|_| "PUPPET_BUNDLE_FILES_NOT_FOUND")? {
        let entry = entry.map_err(|_| "PUPPET_BUNDLE_FILES_NOT_FOUND")?;
        let kind = entry
            .file_type()
            .map_err(|_| "PUPPET_BUNDLE_FILES_NOT_FOUND")?;
        if kind.is_symlink() {
            return Err("PUPPET_LINK_REJECTED".to_string());
        }
        let path = entry.path();
        if kind.is_dir() {
            collect_files(root, &path, out)?;
        } else if kind.is_file() {
            if !is_puppet_asset(&path) {
                return Err("PUPPET_FILE_TYPE_UNSUPPORTED".to_string());
            }
            if entry
                .metadata()
                .map_err(|_| "PUPPET_BUNDLE_FILES_NOT_FOUND")?
                .len()
                > MAX_FILE_BYTES
            {
                return Err("PUPPET_IMPORT_LIMIT_EXCEEDED".to_string());
            }
            let rel = path
                .strip_prefix(root)
                .map_err(|_| "PUPPET_PATH_REJECTED")?;
            out.push(rel.to_path_buf());
        }
    }
    Ok(())
}

fn valid_key(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 48
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn finite_in(value: f32, min: f32, max: f32) -> bool {
    value.is_finite() && value >= min && value <= max
}

fn validate_manifest(
    content_root: &Path,
    files: &[PathBuf],
) -> Result<(String, String, usize), String> {
    let manifests: Vec<_> = files
        .iter()
        .filter(|path| {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .eq_ignore_ascii_case("puppet.json")
        })
        .collect();
    if manifests.len() != 1 {
        return Err("PUPPET_MANIFEST_NOT_FOUND".to_string());
    }
    let manifest_rel = manifests[0].to_string_lossy().replace('\\', "/");
    let manifest_path = content_root.join(manifests[0]);
    let raw = fs::read(&manifest_path).map_err(|_| "PUPPET_MANIFEST_READ_FAILED")?;
    if raw.len() > 2 * 1024 * 1024 {
        return Err("PUPPET_MANIFEST_TOO_LARGE".to_string());
    }
    let manifest: PuppetManifest =
        serde_json::from_slice(&raw).map_err(|_| "PUPPET_MANIFEST_INVALID")?;
    if manifest.schema != PUPPET_SCHEMA {
        return Err("PUPPET_SCHEMA_UNSUPPORTED".to_string());
    }
    if manifest.name.trim().is_empty() || manifest.name.chars().count() > 80 {
        return Err("PUPPET_NAME_INVALID".to_string());
    }
    if !(256..=4096).contains(&manifest.canvas.width)
        || !(256..=4096).contains(&manifest.canvas.height)
    {
        return Err("PUPPET_CANVAS_INVALID".to_string());
    }
    if manifest.bones.is_empty()
        || manifest.bones.len() > MAX_PUPPET_BONES
        || manifest.layers.is_empty()
        || manifest.layers.len() > MAX_PUPPET_LAYERS
    {
        return Err("PUPPET_COMPONENT_LIMIT_EXCEEDED".to_string());
    }
    let bone_ids: HashSet<_> = manifest.bones.iter().map(|bone| bone.id.as_str()).collect();
    if bone_ids.len() != manifest.bones.len()
        || manifest.bones.iter().any(|bone| !valid_key(&bone.id))
    {
        return Err("PUPPET_BONE_INVALID".to_string());
    }
    for bone in &manifest.bones {
        if !finite_in(bone.x, -8192.0, 8192.0)
            || !finite_in(bone.y, -8192.0, 8192.0)
            || !finite_in(bone.rotation, -12.57, 12.57)
            || !finite_in(bone.scale_x, 0.2, 5.0)
            || !finite_in(bone.scale_y, 0.2, 5.0)
            || bone
                .parent
                .as_deref()
                .is_some_and(|parent| !bone_ids.contains(parent))
        {
            return Err("PUPPET_BONE_INVALID".to_string());
        }
        let mut seen = HashSet::new();
        let mut cursor = Some(bone.id.as_str());
        while let Some(id) = cursor {
            if !seen.insert(id) {
                return Err("PUPPET_BONE_CYCLE".to_string());
            }
            cursor = manifest
                .bones
                .iter()
                .find(|item| item.id == id)
                .and_then(|item| item.parent.as_deref());
        }
    }
    let layer_ids: HashSet<_> = manifest
        .layers
        .iter()
        .map(|layer| layer.id.as_str())
        .collect();
    if layer_ids.len() != manifest.layers.len()
        || manifest.layers.iter().any(|layer| !valid_key(&layer.id))
    {
        return Err("PUPPET_LAYER_INVALID".to_string());
    }
    let root = content_root
        .canonicalize()
        .map_err(|_| "PUPPET_BUNDLE_FILES_NOT_FOUND")?;
    let manifest_parent = manifest_path
        .parent()
        .ok_or_else(|| "PUPPET_PATH_REJECTED".to_string())?;
    let mut total_mesh_vertices = 0usize;
    for layer in &manifest.layers {
        let rel = safe_relative(&layer.src)?;
        if !is_image(&rel)
            || !bone_ids.contains(layer.bone.as_str())
            || !finite_in(layer.x, -8192.0, 8192.0)
            || !finite_in(layer.y, -8192.0, 8192.0)
            || !finite_in(layer.rotation, -12.57, 12.57)
            || !finite_in(layer.anchor_x, 0.0, 1.0)
            || !finite_in(layer.anchor_y, 0.0, 1.0)
            || !(-1000..=1000).contains(&layer.z_index)
            || !finite_in(layer.scale_x, 0.2, 5.0)
            || !finite_in(layer.scale_y, 0.2, 5.0)
            || !finite_in(layer.alpha, 0.0, 1.0)
        {
            return Err("PUPPET_LAYER_INVALID".to_string());
        }
        if let Some(mesh) = &layer.mesh {
            let vertices = usize::from(mesh.columns) * usize::from(mesh.rows);
            if !(2..=32).contains(&mesh.columns)
                || !(2..=32).contains(&mesh.rows)
                || vertices > 1_024
                || !finite_in(mesh.pin_y, 0.0, 1.0)
                || !finite_in(mesh.sway_x, -80.0, 80.0)
                || !finite_in(mesh.sway_y, -80.0, 80.0)
                || !finite_in(mesh.frequency, 0.1, 20.0)
                || !finite_in(mesh.phase, -100.0, 100.0)
                || !finite_in(mesh.stiffness, 2.0, 120.0)
                || !finite_in(mesh.damping, 0.5, 40.0)
            {
                return Err("PUPPET_MESH_INVALID".to_string());
            }
            total_mesh_vertices = total_mesh_vertices.saturating_add(vertices);
            if total_mesh_vertices > MAX_PUPPET_MESH_VERTICES {
                return Err("PUPPET_MESH_LIMIT_EXCEEDED".to_string());
            }
        }
        let asset = manifest_parent
            .join(rel)
            .canonicalize()
            .map_err(|_| "PUPPET_ASSET_MISSING")?;
        if !asset.starts_with(&root) || !asset.is_file() {
            return Err("PUPPET_PATH_REJECTED".to_string());
        }
    }
    if let Some(breath) = &manifest.motions.breath {
        if !bone_ids.contains(breath.bone_id.as_str())
            || !finite_in(breath.period_seconds, 1.0, 30.0)
            || !finite_in(breath.amplitude_y, -80.0, 80.0)
            || !finite_in(breath.scale_y, -0.1, 0.1)
        {
            return Err("PUPPET_MOTION_INVALID".to_string());
        }
    }
    if let Some(gaze) = &manifest.motions.gaze {
        if !bone_ids.contains(gaze.bone_id.as_str())
            || !finite_in(gaze.period_seconds, 1.0, 30.0)
            || !finite_in(gaze.amplitude_x, -32.0, 32.0)
            || !finite_in(gaze.amplitude_y, -24.0, 24.0)
        {
            return Err("PUPPET_GAZE_INVALID".to_string());
        }
    }
    if let Some(turn) = &manifest.motions.head_turn {
        if !bone_ids.contains(turn.bone_id.as_str())
            || !finite_in(turn.period_seconds, 1.5, 30.0)
            || !finite_in(turn.amplitude_x, -12.0, 12.0)
            || !finite_in(turn.amplitude_rotation, -0.35, 0.35)
        {
            return Err("PUPPET_MOTION_INVALID".to_string());
        }
    }
    if let Some(blink) = &manifest.motions.blink {
        if !layer_ids.contains(blink.open_layer_id.as_str())
            || !layer_ids.contains(blink.closed_layer_id.as_str())
            || blink.pairs.len() > 4
            || blink.pairs.iter().any(|pair| {
                pair.id.is_empty()
                    || pair.id.len() > 48
                    || !pair.id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
                    || !matches!(pair.side.as_str(), "" | "L" | "R")
                    || pair.open_layer_ids.is_empty()
                    || pair.open_layer_ids.len() > 8
                    || pair.open_layer_ids.iter().any(|id| !layer_ids.contains(id.as_str()) || id == &pair.closed_layer_id)
                    || !layer_ids.contains(pair.closed_layer_id.as_str())
            })
            || !finite_in(blink.min_interval_seconds, 1.0, 30.0)
            || !finite_in(blink.max_interval_seconds, blink.min_interval_seconds, 60.0)
            || !finite_in(blink.duration_seconds, 0.08, 1.0)
        {
            return Err("PUPPET_MOTION_INVALID".to_string());
        }
    }
    if let Some(mouth) = &manifest.motions.mouth {
        if !layer_ids.contains(mouth.closed_layer_id.as_str())
            || !layer_ids.contains(mouth.open_layer_id.as_str())
            || !finite_in(mouth.sensitivity, 0.2, 3.0)
        {
            return Err("PUPPET_MOTION_INVALID".to_string());
        }
    }
    if manifest.motions.actions.len() > MAX_PUPPET_ACTIONS {
        return Err("PUPPET_ACTION_LIMIT_EXCEEDED".to_string());
    }
    let mut action_ids = HashSet::new();
    let mut total_keyframes = 0usize;
    for action in &manifest.motions.actions {
        if !valid_key(&action.id)
            || !action_ids.insert(action.id.as_str())
            || action.label.trim().is_empty()
            || action.label.chars().count() > 24
            || !finite_in(action.duration_seconds, 0.15, 60.0)
            || !finite_in(action.fade_in_seconds, 0.0, 5.0)
            || !finite_in(action.fade_out_seconds, 0.0, 5.0)
            || action.keyframes.is_empty()
            || action.keyframes.len() > MAX_PUPPET_KEYFRAMES
        {
            return Err("PUPPET_ACTION_INVALID".to_string());
        }
        total_keyframes = total_keyframes.saturating_add(action.keyframes.len());
        if total_keyframes > MAX_PUPPET_KEYFRAMES {
            return Err("PUPPET_ACTION_LIMIT_EXCEEDED".to_string());
        }
        for frame in &action.keyframes {
            let bone_target = frame.bone_id.as_deref();
            let layer_target = frame.layer_id.as_deref();
            let target_valid = match (bone_target, layer_target) {
                (Some(bone), None) => bone_ids.contains(bone),
                (None, Some(layer)) => layer_ids.contains(layer),
                _ => false,
            };
            if !target_valid
                || !finite_in(frame.at, 0.0, action.duration_seconds)
                || frame.easing.as_deref().is_some_and(|value| {
                    !matches!(
                        value,
                        "linear" | "smooth" | "easeIn" | "easeOut" | "easeInOut"
                    )
                })
                || frame
                    .x
                    .is_some_and(|value| !finite_in(value, -8192.0, 8192.0))
                || frame
                    .y
                    .is_some_and(|value| !finite_in(value, -8192.0, 8192.0))
                || frame
                    .rotation
                    .is_some_and(|value| !finite_in(value, -12.57, 12.57))
                || frame
                    .scale_x
                    .is_some_and(|value| !finite_in(value, 0.2, 5.0))
                || frame
                    .scale_y
                    .is_some_and(|value| !finite_in(value, 0.2, 5.0))
                || frame.alpha.is_some_and(|value| !finite_in(value, 0.0, 1.0))
            {
                return Err("PUPPET_ACTION_INVALID".to_string());
            }
        }
    }
    Ok((manifest_rel, manifest.name, manifest.layers.len()))
}

#[tauri::command]
pub fn ib_puppet_import_finish(
    app: AppHandle,
    import_id: String,
) -> Result<PuppetBundleItem, String> {
    if !valid_id(&import_id) {
        return Err("PUPPET_IMPORT_NOT_FOUND".to_string());
    }
    let import_root = imports_root(&app)?;
    let source_dir = import_root.join(&import_id);
    let state = read_import_state(&source_dir, &import_id)?;
    if state.files.is_empty() || state.files.values().any(|file| file.size != file.received) {
        return Err("PUPPET_IMPORT_INCOMPLETE".to_string());
    }
    let content_root = if state.mode == "zip" {
        let extracted = source_dir.join("extracted");
        fs::create_dir_all(&extracted).map_err(|_| "PUPPET_STORAGE_UNAVAILABLE")?;
        extract_puppet_zip(&source_dir.join("files/import.zip"), &extracted)?;
        extracted
    } else {
        source_dir.join("files")
    };
    let mut files = Vec::new();
    collect_files(&content_root, &content_root, &mut files)?;
    let (manifest_path, name, layer_count) = validate_manifest(&content_root, &files)?;
    let model_root = bundles_root(&app)?.join(&import_id);
    let target_files = model_root.join("files");
    if model_root.exists() {
        return Err("PUPPET_BUNDLE_COLLISION".to_string());
    }
    fs::create_dir_all(&model_root).map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
    fs::rename(&content_root, &target_files).map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
    let record = BundleRecord {
        schema: PUPPET_SCHEMA.to_string(),
        bundle_id: import_id.clone(),
        name: name.clone(),
        manifest_path,
        layer_count,
        imported_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    fs::write(
        model_root.join("bundle.json"),
        serde_json::to_vec_pretty(&record).map_err(|_| "PUPPET_MANIFEST_INVALID")?,
    )
    .map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
    let _ = fs::remove_dir_all(&source_dir);
    Ok(PuppetBundleItem {
        bundle_id: import_id,
        name,
        layer_count,
    })
}

#[tauri::command]
pub fn ib_puppet_import_abort(app: AppHandle, import_id: String) -> Result<(), String> {
    if !valid_id(&import_id) {
        return Ok(());
    }
    let dir = imports_root(&app)?.join(import_id);
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|_| "PUPPET_STORAGE_CLEANUP_FAILED")?;
    }
    Ok(())
}

#[tauri::command]
pub fn ib_puppet_bundles_list(app: AppHandle) -> Result<Vec<PuppetBundleItem>, String> {
    let root = bundles_root(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| "PUPPET_STORAGE_UNAVAILABLE")? {
        let entry = entry.map_err(|_| "PUPPET_STORAGE_READ_FAILED")?;
        if !entry
            .file_type()
            .map_err(|_| "PUPPET_STORAGE_READ_FAILED")?
            .is_dir()
        {
            continue;
        }
        let raw = match fs::read(entry.path().join("bundle.json")) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let record: BundleRecord = match serde_json::from_slice(&raw) {
            Ok(record) => record,
            Err(_) => continue,
        };
        if record.schema == PUPPET_SCHEMA
            && record.bundle_id == entry.file_name().to_string_lossy()
            && valid_id(&record.bundle_id)
            && safe_relative(&record.manifest_path).is_ok()
            && entry
                .path()
                .join("files")
                .join(&record.manifest_path)
                .is_file()
        {
            out.push(PuppetBundleItem {
                bundle_id: record.bundle_id,
                name: record.name,
                layer_count: record.layer_count,
            });
        }
    }
    out.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub fn ib_puppet_bundle_resolve(app: AppHandle, bundle_id: String) -> Result<String, String> {
    if !valid_id(&bundle_id) {
        return Err("PUPPET_BUNDLE_NOT_FOUND".to_string());
    }
    let bundle_root = bundles_root(&app)?.join(&bundle_id);
    let record: BundleRecord = serde_json::from_slice(
        &fs::read(bundle_root.join("bundle.json")).map_err(|_| "PUPPET_BUNDLE_NOT_FOUND")?,
    )
    .map_err(|_| "PUPPET_MANIFEST_INVALID")?;
    let relative = safe_relative(&record.manifest_path)?;
    if record.schema != PUPPET_SCHEMA || record.bundle_id != bundle_id {
        return Err("PUPPET_BUNDLE_NOT_FOUND".to_string());
    }
    let root = bundle_root
        .join("files")
        .canonicalize()
        .map_err(|_| "PUPPET_BUNDLE_NOT_FOUND")?;
    let manifest = root
        .join(relative)
        .canonicalize()
        .map_err(|_| "PUPPET_MANIFEST_NOT_FOUND")?;
    if !manifest.starts_with(&root) || !manifest.is_file() {
        return Err("PUPPET_PATH_REJECTED".to_string());
    }
    Ok(manifest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ib_puppet_bundle_export(
    app: AppHandle,
    bundle_id: String,
) -> Result<PuppetProjectExport, String> {
    if !valid_id(&bundle_id) {
        return Err("PUPPET_BUNDLE_NOT_FOUND".to_string());
    }
    let bundle_root = bundles_root(&app)?.join(&bundle_id);
    let record: BundleRecord = serde_json::from_slice(
        &fs::read(bundle_root.join("bundle.json")).map_err(|_| "PUPPET_BUNDLE_NOT_FOUND")?,
    )
    .map_err(|_| "PUPPET_MANIFEST_INVALID")?;
    if record.schema != PUPPET_SCHEMA || record.bundle_id != bundle_id {
        return Err("PUPPET_BUNDLE_NOT_FOUND".to_string());
    }
    let root = bundle_root
        .join("files")
        .canonicalize()
        .map_err(|_| "PUPPET_BUNDLE_NOT_FOUND")?;
    let manifest = root
        .join(safe_relative(&record.manifest_path)?)
        .canonicalize()
        .map_err(|_| "PUPPET_MANIFEST_NOT_FOUND")?;
    if !manifest.starts_with(&root) || !manifest.is_file() {
        return Err("PUPPET_PATH_REJECTED".to_string());
    }
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let mut total_bytes = 0;
    add_bundle_files_to_zip(&mut writer, &root, &root, &mut total_bytes)?;
    let zip = writer
        .finish()
        .map_err(|_| "PUPPET_ARCHIVE_WRITE_FAILED")?
        .into_inner();
    let export_root = projects_root(&app)?.join("exports");
    fs::create_dir_all(&export_root).map_err(|_| "PUPPET_STORAGE_UNAVAILABLE")?;
    let file_name = format!("{bundle_id}.ibpuppet.zip");
    let path = export_root.join(&file_name);
    atomic_write(&path, &zip)?;
    Ok(PuppetProjectExport {
        file_name,
        path: path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn ib_puppet_projects_list(app: AppHandle) -> Result<Vec<PuppetProjectItem>, String> {
    let root = projects_root(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|_| "PUPPET_STORAGE_READ_FAILED")? {
        let entry = entry.map_err(|_| "PUPPET_STORAGE_READ_FAILED")?;
        let Some(file_name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(project_id) = file_name.strip_suffix(".meta.json") else {
            continue;
        };
        if !valid_project_id(project_id) {
            continue;
        }
        let record: PuppetProjectRecord = match fs::read(entry.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(record) => record,
            None => continue,
        };
        if record.schema != PUPPET_PROJECT_RECORD_SCHEMA
            || record.project_id != project_id
            || !root
                .join(format!("{project_id}.ibpuppet-project.json"))
                .is_file()
        {
            continue;
        }
        out.push(PuppetProjectItem {
            project_id: record.project_id,
            name: record.name,
            updated_at: record.updated_at,
            bytes: record.bytes,
        });
    }
    out.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(out)
}

#[tauri::command]
pub fn ib_puppet_project_save(
    app: AppHandle,
    project_json: String,
) -> Result<PuppetProjectItem, String> {
    let (project, name, updated_at) = validated_project(&project_json, None)?;
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or("PUPPET_PROJECT_ID_INVALID")?;
    let root = projects_root(&app)?;
    let bytes = project_json.len() as u64;
    let project_path = root.join(format!("{project_id}.ibpuppet-project.json"));
    let record_path = root.join(format!("{project_id}.meta.json"));
    let record = PuppetProjectRecord {
        schema: PUPPET_PROJECT_RECORD_SCHEMA.to_string(),
        project_id: project_id.to_string(),
        name: name.clone(),
        updated_at: updated_at.clone(),
        bytes,
    };
    let record_bytes = serde_json::to_vec(&record).map_err(|_| "PUPPET_PROJECT_INVALID")?;
    atomic_write(&project_path, project_json.as_bytes())?;
    atomic_write(&record_path, &record_bytes)?;
    Ok(PuppetProjectItem {
        project_id: project_id.to_string(),
        name,
        updated_at,
        bytes,
    })
}

#[tauri::command]
pub fn ib_puppet_project_load(app: AppHandle, project_id: String) -> Result<String, String> {
    if !valid_project_id(&project_id) {
        return Err("PUPPET_PROJECT_NOT_FOUND".to_string());
    }
    let root = projects_root(&app)?;
    let path = root.join(format!("{project_id}.ibpuppet-project.json"));
    let size = fs::metadata(&path)
        .map_err(|_| "PUPPET_PROJECT_NOT_FOUND")?
        .len();
    if size as usize > MAX_PUPPET_PROJECT_BYTES {
        return Err("PUPPET_PROJECT_LIMIT_EXCEEDED".to_string());
    }
    let content = fs::read_to_string(path).map_err(|_| "PUPPET_PROJECT_READ_FAILED")?;
    validated_project(&content, Some(&project_id))?;
    Ok(content)
}

#[tauri::command]
pub fn ib_puppet_project_export(
    app: AppHandle,
    project_json: String,
) -> Result<PuppetProjectExport, String> {
    let (project, name, _) = validated_project(&project_json, None)?;
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or("PUPPET_PROJECT_ID_INVALID")?;
    let slug = name
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .take(5)
        .collect::<Vec<_>>()
        .join("-");
    let stem = if slug.is_empty() {
        "puppet-project"
    } else {
        slug.as_str()
    };
    let file_name = format!("{stem}-{project_id}.ibpuppet-project.json");
    let export_root = projects_root(&app)?.join("exports");
    fs::create_dir_all(&export_root).map_err(|_| "PUPPET_STORAGE_UNAVAILABLE")?;
    let path = export_root.join(&file_name);
    atomic_write(&path, project_json.as_bytes())?;
    Ok(PuppetProjectExport {
        file_name,
        path: path.to_string_lossy().to_string(),
    })
}

fn decode_project_asset(data_url: &str) -> Result<(&'static str, &'static str, Vec<u8>), String> {
    let (header, encoded) = data_url
        .split_once(',')
        .ok_or("PUPPET_PROJECT_ASSET_INVALID")?;
    if !header.ends_with(";base64") {
        return Err("PUPPET_PROJECT_ASSET_INVALID".to_string());
    }
    let (mime, extension) = if header.eq_ignore_ascii_case("data:image/png;base64") {
        ("image/png", "png")
    } else if header.eq_ignore_ascii_case("data:image/jpeg;base64") {
        ("image/jpeg", "jpg")
    } else if header.eq_ignore_ascii_case("data:image/webp;base64") {
        ("image/webp", "webp")
    } else {
        return Err("PUPPET_FILE_TYPE_UNSUPPORTED".to_string());
    };
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "PUPPET_PROJECT_ASSET_INVALID")?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("PUPPET_IMPORT_LIMIT_EXCEEDED".to_string());
    }
    let signature_ok = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => {
            bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP"
        }
        _ => false,
    };
    if !signature_ok {
        return Err("PUPPET_PROJECT_ASSET_INVALID".to_string());
    }
    Ok((mime, extension, bytes))
}

fn compile_runtime_project(
    project: &Value,
) -> Result<(Value, BTreeMap<String, Vec<u8>>), String> {
    if project.get("schema").and_then(Value::as_str) != Some(PUPPET_PROJECT_SCHEMA) {
        return Err("PUPPET_PROJECT_SCHEMA_INVALID".to_string());
    }
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .ok_or("PUPPET_PROJECT_ID_INVALID")?;
    if !valid_project_id(project_id) {
        return Err("PUPPET_PROJECT_ID_INVALID".to_string());
    }
    let canvas = project
        .get("canvas")
        .filter(|value| value.is_object())
        .cloned()
        .ok_or("PUPPET_PROJECT_CANVAS_INVALID")?;
    let bones = project
        .get("bones")
        .and_then(Value::as_array)
        .ok_or("PUPPET_PROJECT_BONES_INVALID")?;
    let layers = project
        .get("layers")
        .and_then(Value::as_array)
        .ok_or("PUPPET_PROJECT_LAYER_LIMIT_EXCEEDED")?;
    if layers.is_empty() || layers.len() > MAX_PUPPET_LAYERS || bones.len() > MAX_PUPPET_BONES {
        return Err("PUPPET_PROJECT_LAYER_LIMIT_EXCEEDED".to_string());
    }
    let assets = project
        .get("assets")
        .and_then(Value::as_object)
        .ok_or("PUPPET_PROJECT_ASSET_INVALID")?;
    let motions = project
        .get("motions")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "actions": [] }));

    let mut animated_layer_ids = HashSet::new();
    let mut require_layer = |value: Option<&Value>| {
        if let Some(id) = value.and_then(Value::as_str).filter(|id| !id.is_empty()) {
            animated_layer_ids.insert(id.to_string());
        }
    };
    if let Some(blink) = motions.get("blink") {
        if let Some(pairs) = blink.get("pairs").and_then(Value::as_array).filter(|pairs| !pairs.is_empty()) {
            for pair in pairs {
                if let Some(open_ids) = pair.get("openLayerIds").and_then(Value::as_array) {
                    for id in open_ids {
                        require_layer(Some(id));
                    }
                } else {
                    require_layer(pair.get("openLayerId"));
                }
                require_layer(pair.get("closedLayerId"));
            }
        } else {
            require_layer(blink.get("openLayerId"));
            require_layer(blink.get("closedLayerId"));
        }
    }
    if let Some(mouth) = motions.get("mouth") {
        require_layer(mouth.get("openLayerId"));
        require_layer(mouth.get("closedLayerId"));
    }
    if let Some(actions) = motions.get("actions").and_then(Value::as_array) {
        for action in actions {
            if let Some(frames) = action.get("keyframes").and_then(Value::as_array) {
                for frame in frames {
                    require_layer(frame.get("layerId"));
                }
            }
        }
    }
    drop(require_layer);

    let mut runtime_layers = Vec::new();
    let mut files = BTreeMap::new();
    for (index, layer) in layers.iter().enumerate() {
        let id = layer
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| valid_project_id(id))
            .ok_or("PUPPET_PROJECT_LAYER_INVALID")?;
        let visible = layer.get("visible").and_then(Value::as_bool) != Some(false);
        if !visible && !animated_layer_ids.contains(id) {
            continue;
        }
        let asset_id = layer
            .get("assetId")
            .and_then(Value::as_str)
            .filter(|id| valid_project_id(id))
            .ok_or("PUPPET_PROJECT_ASSET_INVALID")?;
        let data_url = assets
            .get(asset_id)
            .and_then(Value::as_str)
            .ok_or("PUPPET_PROJECT_ASSET_INVALID")?;
        let (mime, extension, bytes) = decode_project_asset(data_url)?;
        let src = format!("layers/{asset_id}.{extension}");
        if let Some(existing) = files.get(&src) {
            if existing != &bytes {
                return Err("PUPPET_PROJECT_ASSET_COLLISION".to_string());
            }
        } else {
            files.insert(src.clone(), bytes);
        }
        let mut runtime_layer = serde_json::json!({
            "id": id,
            "name": layer.get("name").and_then(Value::as_str).unwrap_or("图层"),
            "src": src,
            "bone": layer.get("bone").and_then(Value::as_str).unwrap_or("root"),
            "x": layer.get("x").and_then(Value::as_f64).unwrap_or(0.0),
            "y": layer.get("y").and_then(Value::as_f64).unwrap_or(0.0),
            "rotation": layer.get("rotation").and_then(Value::as_f64).unwrap_or(0.0),
            "anchorX": layer.get("anchorX").and_then(Value::as_f64).unwrap_or(0.5),
            "anchorY": layer.get("anchorY").and_then(Value::as_f64).unwrap_or(0.5),
            "scaleX": layer.get("scaleX").and_then(Value::as_f64).unwrap_or(1.0),
            "scaleY": layer.get("scaleY").and_then(Value::as_f64).unwrap_or(1.0),
            "alpha": layer.get("alpha").and_then(Value::as_f64).unwrap_or(1.0),
            "zIndex": layer.get("zIndex").and_then(Value::as_i64).unwrap_or(index as i64)
        });
        if let Some(mesh) = layer.get("mesh").filter(|mesh| mesh.is_object()) {
            runtime_layer["mesh"] = mesh.clone();
        }
        runtime_layers.push(runtime_layer);
        let _ = mime;
    }
    if runtime_layers.is_empty() {
        return Err("PUPPET_PROJECT_ALL_LAYERS_HIDDEN".to_string());
    }
    if runtime_layers.len() > MAX_PUPPET_LAYERS {
        return Err("PUPPET_PROJECT_LAYER_LIMIT_EXCEEDED".to_string());
    }
    let mut total_asset_bytes = 0u64;
    for bytes in files.values() {
        total_asset_bytes = total_asset_bytes.saturating_add(bytes.len() as u64);
    }
    if total_asset_bytes > MAX_BUNDLE_BYTES {
        return Err("PUPPET_BUNDLE_LIMIT_EXCEEDED".to_string());
    }

    let mut runtime_motions = motions;
    if let Some(object) = runtime_motions.as_object_mut() {
        let actions = object
            .get("actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|action| {
                action
                    .get("keyframes")
                    .and_then(Value::as_array)
                    .is_some_and(|frames| !frames.is_empty())
            })
            .collect::<Vec<_>>();
        object.insert("actions".to_string(), Value::Array(actions));
    }
    let name = project
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("未命名角色");
    let runtime_bones = bones
        .iter()
        .map(|bone| {
            serde_json::json!({
                "id": bone.get("id").and_then(Value::as_str).unwrap_or("root"),
                "parent": bone.get("parent").cloned().unwrap_or(Value::Null),
                "x": bone.get("x").and_then(Value::as_f64).unwrap_or(0.0),
                "y": bone.get("y").and_then(Value::as_f64).unwrap_or(0.0),
                "rotation": bone.get("rotation").and_then(Value::as_f64).unwrap_or(0.0),
                "scaleX": bone.get("scaleX").and_then(Value::as_f64).unwrap_or(1.0),
                "scaleY": bone.get("scaleY").and_then(Value::as_f64).unwrap_or(1.0)
            })
        })
        .collect::<Vec<_>>();
    let manifest = serde_json::json!({
        "schema": PUPPET_SCHEMA,
        "name": name,
        "canvas": canvas,
        "bones": runtime_bones,
        "layers": runtime_layers,
        "motions": runtime_motions
    });
    Ok((manifest, files))
}

fn runtime_bundle_zip(manifest: &Value, assets: &BTreeMap<String, Vec<u8>>) -> Result<Vec<u8>, String> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    let manifest_bytes = serde_json::to_vec_pretty(manifest).map_err(|_| "PUPPET_MANIFEST_INVALID")?;
    writer
        .start_file("puppet.json", options)
        .map_err(|_| "PUPPET_ARCHIVE_WRITE_FAILED")?;
    writer
        .write_all(&manifest_bytes)
        .map_err(|_| "PUPPET_ARCHIVE_WRITE_FAILED")?;
    for (path, bytes) in assets {
        let relative = normalized_rel(path)?;
        writer
            .start_file(relative, options)
            .map_err(|_| "PUPPET_ARCHIVE_WRITE_FAILED")?;
        writer
            .write_all(bytes)
            .map_err(|_| "PUPPET_ARCHIVE_WRITE_FAILED")?;
    }
    writer
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|_| "PUPPET_ARCHIVE_WRITE_FAILED".to_string())
}

#[tauri::command]
pub fn ib_puppet_project_compile(
    app: AppHandle,
    project_id: String,
) -> Result<PuppetProjectCompileResult, String> {
    let started = std::time::Instant::now();
    if !valid_project_id(&project_id) {
        return Err("PUPPET_PROJECT_NOT_FOUND".to_string());
    }
    let root = projects_root(&app)?;
    let project_path = root.join(format!("{project_id}.ibpuppet-project.json"));
    let project_size = fs::metadata(&project_path)
        .map_err(|_| "PUPPET_PROJECT_NOT_FOUND")?
        .len();
    if project_size as usize > MAX_PUPPET_PROJECT_BYTES {
        return Err("PUPPET_PROJECT_LIMIT_EXCEEDED".to_string());
    }
    let content = fs::read_to_string(project_path).map_err(|_| "PUPPET_PROJECT_READ_FAILED")?;
    let (project, _, _) = validated_project(&content, Some(&project_id))?;
    let (manifest, assets) = compile_runtime_project(&project)?;
    let zip_bytes = runtime_bundle_zip(&manifest, &assets)?;
    if zip_bytes.len() as u64 > MAX_BUNDLE_BYTES {
        return Err("PUPPET_BUNDLE_LIMIT_EXCEEDED".to_string());
    }

    // Reuse the same Rust archive validator/installer as old v1 ZIP imports.
    let import_id = Uuid::new_v4().to_string();
    let import_dir = imports_root(&app)?.join(&import_id);
    fs::create_dir_all(import_dir.join("files")).map_err(|_| "PUPPET_STORAGE_UNAVAILABLE")?;
    let zip_path = import_dir.join("files").join("import.zip");
    fs::write(&zip_path, &zip_bytes).map_err(|_| "PUPPET_STORAGE_WRITE_FAILED")?;
    let mut files = BTreeMap::new();
    files.insert(
        "import.zip".to_string(),
        ImportFile {
            size: zip_bytes.len() as u64,
            received: zip_bytes.len() as u64,
        },
    );
    store_import_state(
        &import_dir,
        &ImportState {
            id: import_id.clone(),
            mode: "zip".to_string(),
            total_size: zip_bytes.len() as u64,
            files,
        },
    )?;
    let bundle = match ib_puppet_import_finish(app.clone(), import_id.clone()) {
        Ok(bundle) => bundle,
        Err(error) => {
            let _ = fs::remove_dir_all(import_dir);
            return Err(error);
        }
    };
    Ok(PuppetProjectCompileResult {
        bundle,
        bundle_bytes: zip_bytes.len() as u64,
        elapsed_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_png_data_url() -> String {
        format!(
            "data:image/png;base64,{}",
            BASE64_STANDARD.encode(b"\x89PNG\r\n\x1a\n")
        )
    }

    #[test]
    fn puppet_paths_reject_escape_and_accept_nested_asset_paths() {
        assert!(safe_relative("../outside.png").is_err());
        assert!(safe_relative("C:/outside.png").is_err());
        assert_eq!(
            normalized_rel("layers\\body.png").unwrap(),
            "layers/body.png"
        );
    }

    #[test]
    fn puppet_manifest_requires_closed_schema_and_existing_raster_assets() {
        let temp = std::env::temp_dir().join(format!("ib-puppet-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&temp).unwrap();
        fs::write(temp.join("body.png"), b"synthetic-png").unwrap();
        fs::write(
            temp.join("puppet.json"),
            r#"{"schema":"internalbeyond.puppet.v1","name":"Test","canvas":{"width":800,"height":1000},"bones":[{"id":"root"}],"layers":[{"id":"body","src":"body.png","bone":"root"}],"motions":{}}"#,
        )
        .unwrap();
        let files = vec![PathBuf::from("puppet.json"), PathBuf::from("body.png")];
        assert_eq!(validate_manifest(&temp, &files).unwrap().2, 1);
        fs::write(
            temp.join("puppet.json"),
            r#"{"schema":"internalbeyond.puppet.v1","name":"Test","canvas":{"width":800,"height":1000},"bones":[{"id":"root"}],"layers":[{"id":"body","src":"../outside.png","bone":"root"}],"motions":{}}"#,
        )
        .unwrap();
        assert_eq!(
            validate_manifest(&temp, &files).unwrap_err(),
            "PUPPET_PATH_REJECTED"
        );
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn rust_project_compile_keeps_hidden_motion_layers_and_legacy_v1_schema() {
        let png = test_png_data_url();
        let project = serde_json::json!({
            "schema": PUPPET_PROJECT_SCHEMA,
            "id": "project-v13-test",
            "name": "Rust compile parity",
            "canvas": {"width": 640, "height": 640},
            "bones": [{"id":"root", "parent":null, "x":0, "y":0, "rotation":0, "scaleX":1, "scaleY":1, "name":"Root"}],
            "assets": {
                "asset-body": png,
                "asset-open": png,
                "asset-closed": png,
                "asset-unused": png
            },
            "layers": [
                {"id":"body", "name":"Body", "assetId":"asset-body", "bone":"root", "visible":true, "x":1, "y":2, "rotation":0, "anchorX":0.5, "anchorY":0.5, "scaleX":1, "scaleY":1, "alpha":1, "zIndex":0},
                {"id":"eye-open", "name":"Eye open", "assetId":"asset-open", "bone":"root", "visible":false, "x":4, "y":5, "rotation":0, "anchorX":0.5, "anchorY":0.5, "scaleX":1, "scaleY":1, "alpha":1, "zIndex":1},
                {"id":"eye-closed", "name":"Eye closed", "assetId":"asset-closed", "bone":"root", "visible":false, "x":4, "y":5, "rotation":0, "anchorX":0.5, "anchorY":0.5, "scaleX":1, "scaleY":1, "alpha":1, "zIndex":2},
                {"id":"unused", "name":"Unused", "assetId":"asset-unused", "bone":"root", "visible":false, "x":0, "y":0, "rotation":0, "anchorX":0.5, "anchorY":0.5, "scaleX":1, "scaleY":1, "alpha":1, "zIndex":3}
            ],
            "motions": {
                "blink": {"openLayerId":"eye-open", "closedLayerId":"eye-closed", "pairs":[{"id":"blink-left", "side":"L", "openLayerIds":["eye-open"], "closedLayerId":"eye-closed"}]},
                "actions": [{"id":"empty", "label":"Empty", "keyframes":[]}, {"id":"look", "label":"Look", "keyframes":[{"boneId":"root", "at":0, "rotation":0}]}]
            }
        });
        let (manifest, files) = compile_runtime_project(&project).unwrap();
        assert_eq!(manifest["schema"], PUPPET_SCHEMA);
        assert_eq!(manifest["layers"].as_array().unwrap().len(), 3);
        assert!(manifest["layers"].as_array().unwrap().iter().any(|layer| layer["id"] == "eye-open"));
        assert!(manifest["layers"].as_array().unwrap().iter().any(|layer| layer["id"] == "eye-closed"));
        assert!(!manifest["layers"].as_array().unwrap().iter().any(|layer| layer["id"] == "unused"));
        assert_eq!(manifest["motions"]["actions"].as_array().unwrap().len(), 1);
        assert_eq!(files.len(), 3);
        let zip = runtime_bundle_zip(&manifest, &files).unwrap();
        let mut archive = ZipArchive::new(Cursor::new(zip.clone())).unwrap();
        assert_eq!(archive.len(), 4);
        assert!(archive.by_name("puppet.json").is_ok());
        assert!(archive.by_name("layers/asset-open.png").is_ok());
        let temp = std::env::temp_dir().join(format!("ib-puppet-roundtrip-{}", Uuid::new_v4()));
        let extracted = temp.join("extracted");
        fs::create_dir_all(&extracted).unwrap();
        let archive_path = temp.join("runtime.zip");
        fs::write(&archive_path, zip).unwrap();
        extract_puppet_zip(&archive_path, &extracted).unwrap();
        let mut extracted_files = Vec::new();
        collect_files(&extracted, &extracted, &mut extracted_files).unwrap();
        let validated = validate_manifest(&extracted, &extracted_files).unwrap();
        assert_eq!(validated.2, 3);
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn project_compile_rejects_non_image_asset_bytes() {
        assert_eq!(
            decode_project_asset("data:image/png;base64,aGVsbG8=").unwrap_err(),
            "PUPPET_PROJECT_ASSET_INVALID"
        );
    }
}
