use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use uuid::Uuid;
use zip::ZipArchive;

const MAX_CHUNK_BYTES: usize = 256 * 1024;
const MAX_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_BUNDLE_BYTES: u64 = 768 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 20_000;
const MODEL_SCHEMA: &str = "internalbeyond.live2d.model-bundle.v1";

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelFile {
    model_ref: String,
    relative_path: String,
    name: String,
    textures: usize,
    motion_groups: usize,
    has_physics: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundleManifest {
    schema: String,
    bundle_id: String,
    imported_at: u64,
    models: Vec<ModelFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListItem {
    pub model_ref: String,
    pub name: String,
    pub textures: usize,
    pub motion_groups: usize,
    pub has_physics: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub bundle_id: String,
    pub models: Vec<ModelListItem>,
}

fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    let root = if std::env::var("IB_DEV_MODE").ok().as_deref() == Some("1") {
        super::validated_dev_sandbox_root()?.join("tauri-app-data")
    } else {
        app.path()
            .app_data_dir()
            .map_err(|_| "LIVE2D_APP_DATA_UNAVAILABLE")?
    };
    #[cfg(not(debug_assertions))]
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "LIVE2D_APP_DATA_UNAVAILABLE")?;
    fs::create_dir_all(&root).map_err(|_| "LIVE2D_APP_DATA_UNAVAILABLE")?;
    Ok(root.join("live2d"))
}

fn imports_root(app: &AppHandle) -> Result<PathBuf, String> {
    let path = data_root(app)?.join(".imports");
    fs::create_dir_all(&path).map_err(|_| "LIVE2D_STORAGE_UNAVAILABLE")?;
    Ok(path)
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
        return Err("LIVE2D_PATH_REJECTED".to_string());
    }
    let mut out = PathBuf::new();
    for component in Path::new(&normalized).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            _ => return Err("LIVE2D_PATH_REJECTED".to_string()),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("LIVE2D_PATH_REJECTED".to_string());
    }
    Ok(out)
}

fn normalized_rel(value: &str) -> Result<String, String> {
    let path = safe_relative(value)?;
    let parts = path
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>();
    Ok(parts.join("/"))
}

fn is_model_asset(path: &Path) -> bool {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    name.ends_with(".model3.json")
        || matches!(
            ext.as_str(),
            "json" | "moc3" | "png" | "jpg" | "jpeg" | "webp"
        )
}

fn read_import_state(dir: &Path, id: &str) -> Result<ImportState, String> {
    if !valid_id(id) {
        return Err("LIVE2D_IMPORT_NOT_FOUND".to_string());
    }
    let raw = fs::read(dir.join("state.json")).map_err(|_| "LIVE2D_IMPORT_NOT_FOUND")?;
    let state: ImportState =
        serde_json::from_slice(&raw).map_err(|_| "LIVE2D_IMPORT_STATE_INVALID")?;
    if state.id != id || !matches!(state.mode.as_str(), "folder" | "zip") {
        return Err("LIVE2D_IMPORT_STATE_INVALID".to_string());
    }
    Ok(state)
}

fn store_import_state(dir: &Path, state: &ImportState) -> Result<(), String> {
    let bytes = serde_json::to_vec(state).map_err(|_| "LIVE2D_IMPORT_STATE_INVALID")?;
    fs::write(dir.join("state.json"), bytes).map_err(|_| "LIVE2D_STORAGE_WRITE_FAILED".to_string())
}

fn app_data_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let path = data_root(app)?.join("models");
    fs::create_dir_all(&path).map_err(|_| "LIVE2D_STORAGE_UNAVAILABLE")?;
    Ok(path)
}

#[tauri::command]
pub fn ib_live2d_import_begin(app: AppHandle, mode: String) -> Result<String, String> {
    if !matches!(mode.as_str(), "folder" | "zip") {
        return Err("LIVE2D_IMPORT_MODE_INVALID".to_string());
    }
    let root = imports_root(&app)?;
    let id = Uuid::new_v4().to_string();
    let dir = root.join(&id);
    fs::create_dir_all(dir.join("files")).map_err(|_| "LIVE2D_STORAGE_UNAVAILABLE")?;
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
pub fn ib_live2d_import_chunk(
    app: AppHandle,
    import_id: String,
    relative_path: String,
    offset: u64,
    total_size: u64,
    chunk: Vec<u8>,
) -> Result<(), String> {
    if chunk.is_empty() || chunk.len() > MAX_CHUNK_BYTES || total_size == 0 {
        return Err("LIVE2D_IMPORT_LIMIT_EXCEEDED".to_string());
    }
    let rel = normalized_rel(&relative_path)?;
    let rel_path = safe_relative(&rel)?;
    let root = imports_root(&app)?;
    let dir = root.join(&import_id);
    let mut state = read_import_state(&dir, &import_id)?;
    if state.mode == "zip" && rel != "import.zip" {
        return Err("LIVE2D_ARCHIVE_PATH_INVALID".to_string());
    }
    let file_limit = if state.mode == "zip" {
        MAX_BUNDLE_BYTES
    } else {
        MAX_FILE_BYTES
    };
    if total_size > file_limit {
        return Err("LIVE2D_IMPORT_LIMIT_EXCEEDED".to_string());
    }
    if state.mode == "folder" && !is_model_asset(&rel_path) {
        return Err("LIVE2D_FILE_TYPE_UNSUPPORTED".to_string());
    }
    let file = state.files.get(&rel).cloned();
    if offset == 0 {
        if file.is_some()
            || state.files.len() >= MAX_ARCHIVE_ENTRIES
            || state.total_size.saturating_add(total_size) > MAX_BUNDLE_BYTES
        {
            return Err("LIVE2D_IMPORT_LIMIT_EXCEEDED".to_string());
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
        return Err("LIVE2D_IMPORT_OFFSET_INVALID".to_string());
    }
    let file_meta = state
        .files
        .get_mut(&rel)
        .ok_or_else(|| "LIVE2D_IMPORT_OFFSET_INVALID".to_string())?;
    if file_meta.size != total_size
        || file_meta.received != offset
        || offset.saturating_add(chunk.len() as u64) > total_size
    {
        return Err("LIVE2D_IMPORT_OFFSET_INVALID".to_string());
    }
    let target = dir.join("files").join(&rel_path);
    if !target.starts_with(dir.join("files")) {
        return Err("LIVE2D_PATH_REJECTED".to_string());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|_| "LIVE2D_STORAGE_WRITE_FAILED")?;
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
        .map_err(|_| "LIVE2D_STORAGE_WRITE_FAILED")?;
    if output
        .metadata()
        .map_err(|_| "LIVE2D_STORAGE_WRITE_FAILED")?
        .len()
        != offset
    {
        return Err("LIVE2D_IMPORT_OFFSET_INVALID".to_string());
    }
    output
        .write_all(&chunk)
        .map_err(|_| "LIVE2D_STORAGE_WRITE_FAILED")?;
    file_meta.received += chunk.len() as u64;
    store_import_state(&dir, &state)
}

fn extract_zip(archive_path: &Path, output_root: &Path) -> Result<(), String> {
    let file = File::open(archive_path).map_err(|_| "LIVE2D_ARCHIVE_READ_FAILED")?;
    let mut archive = ZipArchive::new(file).map_err(|_| "LIVE2D_ARCHIVE_INVALID")?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("LIVE2D_IMPORT_LIMIT_EXCEEDED".to_string());
    }
    let mut count = 0usize;
    let mut total = 0u64;
    let mut seen = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "LIVE2D_ARCHIVE_INVALID")?;
        let name = entry.name().to_string();
        let safe_name = normalized_rel(&name)?;
        if entry.is_dir() {
            continue;
        }
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err("LIVE2D_ARCHIVE_LINK_REJECTED".to_string());
            }
        }
        let rel = safe_relative(&safe_name)?;
        if !is_model_asset(&rel) {
            continue;
        }
        count += 1;
        total = total.saturating_add(entry.size());
        if count > MAX_ARCHIVE_ENTRIES || entry.size() > MAX_FILE_BYTES || total > MAX_BUNDLE_BYTES
        {
            return Err("LIVE2D_IMPORT_LIMIT_EXCEEDED".to_string());
        }
        if !seen.insert(safe_name.clone()) {
            return Err("LIVE2D_ARCHIVE_DUPLICATE_PATH".to_string());
        }
        let target = output_root.join(&rel);
        if !target.starts_with(output_root) {
            return Err("LIVE2D_PATH_REJECTED".to_string());
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|_| "LIVE2D_STORAGE_WRITE_FAILED")?;
        }
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|_| "LIVE2D_STORAGE_WRITE_FAILED")?;
        let copied =
            std::io::copy(&mut entry, &mut out).map_err(|_| "LIVE2D_ARCHIVE_READ_FAILED")?;
        if copied != entry.size() {
            return Err("LIVE2D_ARCHIVE_TRUNCATED".to_string());
        }
    }
    if count == 0 {
        return Err("LIVE2D_MODEL_FILES_NOT_FOUND".to_string());
    }
    Ok(())
}

fn collect_files(
    root: &Path,
    current: &Path,
    out: &mut Vec<PathBuf>,
    total: &mut u64,
) -> Result<(), String> {
    let entries = fs::read_dir(current).map_err(|_| "LIVE2D_MODEL_FILES_NOT_FOUND")?;
    for entry in entries {
        let entry = entry.map_err(|_| "LIVE2D_MODEL_FILES_NOT_FOUND")?;
        let ty = entry
            .file_type()
            .map_err(|_| "LIVE2D_MODEL_FILES_NOT_FOUND")?;
        if ty.is_symlink() {
            return Err("LIVE2D_LINK_REJECTED".to_string());
        }
        let path = entry.path();
        if ty.is_dir() {
            collect_files(root, &path, out, total)?;
        } else if ty.is_file() {
            let metadata = entry
                .metadata()
                .map_err(|_| "LIVE2D_MODEL_FILES_NOT_FOUND")?;
            if !is_model_asset(&path) {
                return Err("LIVE2D_FILE_TYPE_UNSUPPORTED".to_string());
            }
            if metadata.len() > MAX_FILE_BYTES {
                return Err("LIVE2D_IMPORT_LIMIT_EXCEEDED".to_string());
            }
            *total = total.saturating_add(metadata.len());
            if *total > MAX_BUNDLE_BYTES {
                return Err("LIVE2D_IMPORT_LIMIT_EXCEEDED".to_string());
            }
            let rel = path
                .strip_prefix(root)
                .map_err(|_| "LIVE2D_PATH_REJECTED")?;
            out.push(rel.to_path_buf());
        }
    }
    Ok(())
}

fn collect_strings(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(value) => out.push(value.clone()),
        serde_json::Value::Array(values) => {
            values.iter().for_each(|value| collect_strings(value, out))
        }
        serde_json::Value::Object(values) => values
            .values()
            .for_each(|value| collect_strings(value, out)),
        _ => {}
    }
}

fn validate_model(root: &Path, bundle_id: &str, model_path: &Path) -> Result<ModelFile, String> {
    let relative_path = model_path
        .strip_prefix(root)
        .map_err(|_| "LIVE2D_PATH_REJECTED")?
        .to_string_lossy()
        .replace('\\', "/");
    let raw = fs::read(model_path).map_err(|_| "LIVE2D_MODEL_JSON_READ_FAILED")?;
    let model: serde_json::Value =
        serde_json::from_slice(&raw).map_err(|_| "LIVE2D_MODEL_JSON_INVALID")?;
    let refs = model
        .get("FileReferences")
        .ok_or_else(|| "LIVE2D_MODEL_REFERENCES_MISSING".to_string())?;
    let moc = refs
        .get("Moc")
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "LIVE2D_MODEL_MOC_MISSING".to_string())?;
    let mut strings = Vec::new();
    collect_strings(refs, &mut strings);
    if strings.is_empty() {
        return Err("LIVE2D_MODEL_REFERENCES_MISSING".to_string());
    }
    let root = root
        .canonicalize()
        .map_err(|_| "LIVE2D_MODEL_JSON_READ_FAILED")?;
    let parent = model_path
        .parent()
        .ok_or_else(|| "LIVE2D_PATH_REJECTED".to_string())?;
    for reference in strings {
        if reference.trim().is_empty() {
            continue;
        }
        let rel = safe_relative(&reference)?;
        if !is_model_asset(&rel) {
            return Err("LIVE2D_REFERENCE_TYPE_UNSUPPORTED".to_string());
        }
        let candidate = parent
            .join(rel)
            .canonicalize()
            .map_err(|_| "LIVE2D_MODEL_RESOURCE_MISSING".to_string())?;
        if !candidate.starts_with(&root) || !candidate.is_file() {
            return Err("LIVE2D_PATH_REJECTED".to_string());
        }
    }
    let moc_path = parent
        .join(safe_relative(moc)?)
        .canonicalize()
        .map_err(|_| "LIVE2D_MODEL_MOC_MISSING")?;
    if !moc_path.starts_with(&root) {
        return Err("LIVE2D_PATH_REJECTED".to_string());
    }
    let textures = refs
        .get("Textures")
        .and_then(|value| value.as_array())
        .map(|value| value.len())
        .unwrap_or(0);
    let motion_groups = refs
        .get("Motions")
        .and_then(|value| value.as_object())
        .map(|value| value.len())
        .unwrap_or(0);
    let has_physics = refs
        .get("Physics")
        .and_then(|value| value.as_str())
        .map(|value| !value.is_empty())
        .unwrap_or(false);
    let name = model_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .trim_end_matches(".model3.json")
        .trim_end_matches(".Model3.json")
        .to_string();
    Ok(ModelFile {
        model_ref: format!("{}::{}", bundle_id, relative_path),
        relative_path,
        name,
        textures,
        motion_groups,
        has_physics,
    })
}

fn scan_models(root: &Path, bundle_id: &str) -> Result<(Vec<ModelFile>, u64), String> {
    let mut files = Vec::new();
    let mut total = 0u64;
    collect_files(root, root, &mut files, &mut total)?;
    let mut models = Vec::new();
    for rel in files.iter().filter(|path| {
        path.to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".model3.json")
    }) {
        models.push(validate_model(root, bundle_id, &root.join(rel))?);
    }
    models.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    if models.is_empty() {
        return Err("LIVE2D_MODEL_JSON_NOT_FOUND".to_string());
    }
    Ok((models, total))
}

fn to_list_item(model: &ModelFile) -> ModelListItem {
    ModelListItem {
        model_ref: model.model_ref.clone(),
        name: model.name.clone(),
        textures: model.textures,
        motion_groups: model.motion_groups,
        has_physics: model.has_physics,
    }
}

#[tauri::command]
pub fn ib_live2d_import_finish(app: AppHandle, import_id: String) -> Result<ImportResult, String> {
    if !valid_id(&import_id) {
        return Err("LIVE2D_IMPORT_NOT_FOUND".to_string());
    }
    let import_root = imports_root(&app)?;
    let source_dir = import_root.join(&import_id);
    let state = read_import_state(&source_dir, &import_id)?;
    if state.files.is_empty() || state.files.values().any(|file| file.size != file.received) {
        return Err("LIVE2D_IMPORT_INCOMPLETE".to_string());
    }
    let content_root = if state.mode == "zip" {
        let archive = source_dir.join("files").join("import.zip");
        let extracted = source_dir.join("extracted");
        fs::create_dir_all(&extracted).map_err(|_| "LIVE2D_STORAGE_UNAVAILABLE")?;
        extract_zip(&archive, &extracted)?;
        extracted
    } else {
        source_dir.join("files")
    };
    let (models, total_bytes) = scan_models(&content_root, &import_id)?;
    if total_bytes == 0 || total_bytes > MAX_BUNDLE_BYTES {
        return Err("LIVE2D_IMPORT_LIMIT_EXCEEDED".to_string());
    }
    let model_root = app_data_models_dir(&app)?.join(&import_id);
    let target_files = model_root.join("files");
    if model_root.exists() {
        return Err("LIVE2D_MODEL_BUNDLE_COLLISION".to_string());
    }
    fs::create_dir_all(&model_root).map_err(|_| "LIVE2D_STORAGE_WRITE_FAILED")?;
    fs::rename(&content_root, &target_files).map_err(|_| "LIVE2D_STORAGE_WRITE_FAILED")?;
    let manifest = BundleManifest {
        schema: MODEL_SCHEMA.to_string(),
        bundle_id: import_id.clone(),
        imported_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        models: models.clone(),
    };
    let bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|_| "LIVE2D_MODEL_MANIFEST_INVALID")?;
    fs::write(model_root.join("bundle.json"), bytes).map_err(|_| "LIVE2D_STORAGE_WRITE_FAILED")?;
    let _ = fs::remove_dir_all(&source_dir);
    Ok(ImportResult {
        bundle_id: import_id,
        models: models.iter().map(to_list_item).collect(),
    })
}

#[tauri::command]
pub fn ib_live2d_import_abort(app: AppHandle, import_id: String) -> Result<(), String> {
    if !valid_id(&import_id) {
        return Ok(());
    }
    let dir = imports_root(&app)?.join(import_id);
    if dir.exists() {
        fs::remove_dir_all(dir).map_err(|_| "LIVE2D_STORAGE_CLEANUP_FAILED")?;
    }
    Ok(())
}

#[tauri::command]
pub fn ib_live2d_models_list(app: AppHandle) -> Result<Vec<ModelListItem>, String> {
    let root = app_data_models_dir(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(root).map_err(|_| "LIVE2D_STORAGE_UNAVAILABLE")? {
        let entry = entry.map_err(|_| "LIVE2D_STORAGE_READ_FAILED")?;
        if !entry
            .file_type()
            .map_err(|_| "LIVE2D_STORAGE_READ_FAILED")?
            .is_dir()
        {
            continue;
        }
        let manifest_path = entry.path().join("bundle.json");
        let raw = match fs::read(manifest_path) {
            Ok(raw) => raw,
            Err(_) => continue,
        };
        let manifest: BundleManifest = match serde_json::from_slice(&raw) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if manifest.schema != MODEL_SCHEMA
            || manifest.bundle_id != entry.file_name().to_string_lossy()
        {
            continue;
        }
        for model in &manifest.models {
            let rel = match safe_relative(&model.relative_path) {
                Ok(rel) => rel,
                Err(_) => continue,
            };
            if entry.path().join("files").join(rel).is_file() {
                out.push(to_list_item(model));
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[tauri::command]
pub fn ib_live2d_model_resolve(app: AppHandle, model_ref: String) -> Result<String, String> {
    let (bundle_id, relative_path) = model_ref
        .split_once("::")
        .ok_or_else(|| "LIVE2D_MODEL_NOT_FOUND".to_string())?;
    if !valid_id(bundle_id) {
        return Err("LIVE2D_MODEL_NOT_FOUND".to_string());
    }
    let relative_path = safe_relative(relative_path)?;
    let bundle_dir = app_data_models_dir(&app)?.join(bundle_id);
    let manifest: BundleManifest = serde_json::from_slice(
        &fs::read(bundle_dir.join("bundle.json")).map_err(|_| "LIVE2D_MODEL_NOT_FOUND")?,
    )
    .map_err(|_| "LIVE2D_MODEL_MANIFEST_INVALID")?;
    let rel_string = relative_path.to_string_lossy().replace('\\', "/");
    if manifest.schema != MODEL_SCHEMA
        || manifest.bundle_id != bundle_id
        || !manifest
            .models
            .iter()
            .any(|model| model.relative_path == rel_string)
    {
        return Err("LIVE2D_MODEL_NOT_FOUND".to_string());
    }
    let root = bundle_dir
        .join("files")
        .canonicalize()
        .map_err(|_| "LIVE2D_MODEL_NOT_FOUND")?;
    let file = root
        .join(&relative_path)
        .canonicalize()
        .map_err(|_| "LIVE2D_MODEL_NOT_FOUND")?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("LIVE2D_MODEL_NOT_FOUND".to_string());
    }
    Ok(file.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ib_live2d_runtime_resolve(app: AppHandle) -> Result<String, String> {
    if let Ok(resource) = app.path().resolve(
        "assets/live2d/runtime/live2dcubismcore.min.js",
        BaseDirectory::Resource,
    ) {
        if resource.is_file() {
            return Ok(resource.to_string_lossy().to_string());
        }
    }
    #[cfg(debug_assertions)]
    if let Ok(source) = std::env::var("IB_LIVE2D_DEV_CORE_PATH") {
        let source = PathBuf::from(source);
        let len = source
            .metadata()
            .map_err(|_| "LIVE2D_CORE_UNAVAILABLE")?
            .len();
        if len < 64 * 1024 || len > 32 * 1024 * 1024 {
            return Err("LIVE2D_CORE_INVALID".to_string());
        }
        let target = data_root(&app)?
            .join("runtime")
            .join("live2dcubismcore.min.js");
        if !target.is_file() || target.metadata().map(|m| m.len()).unwrap_or(0) != len {
            let parent = target
                .parent()
                .ok_or_else(|| "LIVE2D_STORAGE_UNAVAILABLE".to_string())?;
            fs::create_dir_all(parent).map_err(|_| "LIVE2D_STORAGE_UNAVAILABLE")?;
            let temp = target.with_extension("js.tmp");
            fs::copy(&source, &temp).map_err(|_| "LIVE2D_CORE_INSTALL_FAILED")?;
            fs::rename(&temp, &target).map_err(|_| "LIVE2D_CORE_INSTALL_FAILED")?;
        }
        return Ok(target.to_string_lossy().to_string());
    }
    Err("LIVE2D_CORE_UNAVAILABLE".to_string())
}
